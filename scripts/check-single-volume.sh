#!/usr/bin/env bash
# =============================================================================
# check-single-volume.sh — prove the image's volume contract.
#
#     scripts/check-single-volume.sh                          # builds first
#     scripts/check-single-volume.sh ghcr.io/zees-dev/z-notes:0.7.0   # or don't
#
# Run from anywhere: the build context is derived from this file's location.
#
# WHAT THIS PROVES, in one sentence: a single volume mounted at /vaults, with no
# configuration whatsoever, gives you a working default vault AND is the only
# storage a second, third, N-th vault ever needs.
#
# Concretely, in order: the image creates its own primary vault inside that one
# volume (`vault`, unsynced, nobody set ZNOTES_VAULT); a doc written through the
# API lands in it; a vault added at runtime clones into a SIBLING directory in
# the same volume; its docs are addressable as `@<id>/<path>`; the whole picture
# survives a container replacement against that same volume; and the volume's
# top level is exactly one directory per vault and nothing else.
#
# WHY IT EXISTS — and why it is not a `bun test` file.
#   `bun test` runs the server from source against mkdtemp directories. It is
#   thorough about the vault registry and says nothing at all about the IMAGE:
#   whether /vaults exists and is owned by uid 1000, whether the VOLUME
#   declaration names the home rather than one vault inside it, whether
#   ZNOTES_VAULTS_DIR is set and ZNOTES_VAULT is deliberately NOT, whether git
#   inside the container will touch a repository sitting on a mounted
#   filesystem. Every one of those is a Dockerfile line, and a Dockerfile line
#   that regresses fails in production and nowhere else — the deployment's
#   symptom is an empty vault next to a full PVC, which looks exactly like data
#   loss. So this is a hand-run proof, invoked from the deploy runbook when the
#   image or the volume layout changes, and it deliberately costs a docker build
#   rather than being cheap enough to run on every commit.
#
#   It is NOT in CI for the same reason: CI has no docker daemon and the browser
#   suites already own the application's behaviour. This owns the packaging.
#
# The one thing it does not prove is the k8s half — a PVC is not a docker volume
# and only the cluster can answer that. `deploy/README.md` carries that runbook.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-z-notes:volcheck}"
RUN_ID="$$"
VOL="z-notes-volcheck-${RUN_ID}"
CTR="z-notes-volcheck-${RUN_ID}"
WORK="$(mktemp -d)"
BODY="$WORK/body.json"
BASE=""

# The bare repo that becomes the second vault lives INSIDE the container, under
# /tmp — not in the volume. That is the point of step 9: if the seed repo sat in
# the volume it would show up as a top-level entry that is not a vault, and the
# layout assertion could no longer say "one directory per vault, nothing else".
SEED_DIR=/tmp/z-notes-volcheck
SEED_REPO="$SEED_DIR/notebook.git"
SEED_URL="file://$SEED_REPO"
SEED_DOC="remote-note.md"
SECOND_ID="notebook"
PRIMARY_DOC="volume-check.md"
PRIMARY_TEXT="# written through the API into the default vault"

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    PASS  %s\n' "$*"; }
die()  { printf '    FAIL  %s\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  # Best-effort and silent: a failure here must not mask the failure above it.
  docker rm -f "$CTR" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -rf "$WORK" || true
  # The image is left behind deliberately: it is the expensive half, and the
  # usual reason to run this script twice is to re-check the same image.
  if [ "$code" -eq 0 ]; then
    printf '\n==> ALL CHECKS PASSED — one volume at /vaults carries every vault.\n'
  else
    printf '\n==> FAILED (exit %s). Image %s left in place for inspection.\n' "$code" "$IMAGE" >&2
  fi
  exit "$code"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH."; }
need docker
need curl
# python3 rather than jq: jq is not on a stock macOS or a stock CI runner, and a
# JSON assertion written in grep is a JSON assertion that passes on the wrong
# document sooner or later.
need python3

# `api METHOD PATH [JSON]` → prints the HTTP status, leaves the body in $BODY.
# curl sends neither Sec-Fetch-Site nor Origin, so the server's cross-site write
# guard treats it as the non-browser client it is and lets the POSTs through.
api() {
  local method="$1" path="$2" payload="${3:-}"
  if [ -n "$payload" ]; then
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' -d "$payload" "$BASE$path"
  else
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path"
  fi
}

# `expect_status <want> <status> <what>`
expect_status() {
  [ "$2" = "$1" ] || { printf '    body: %s\n' "$(cat "$BODY" 2>/dev/null)" >&2; die "$3 (HTTP $2, wanted $1)"; }
}

# `check <description> <python expression over the parsed body, bound to d>`
check() {
  if python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("    not JSON:", e, file=sys.stderr); sys.exit(2)
sys.exit(0 if eval(sys.argv[2]) else 1)
' "$BODY" "$2"; then
    ok "$1"
  else
    printf '    body: %s\n' "$(cat "$BODY" 2>/dev/null)" >&2
    die "$1"
  fi
}

# Start (or restart) the container against $VOL and wait until it answers.
# ONE mount, no ZNOTES_VAULT, no ZNOTES_VAULTS_DIR: everything the container
# needs to find its vaults must already be baked into the image, or this script
# is proving the wrong thing.
boot() {
  docker run -d --name "$CTR" \
    -v "$VOL":/vaults \
    -p 127.0.0.1::4700 \
    "$IMAGE" >/dev/null
  local hostport
  hostport="$(docker port "$CTR" 4700/tcp | head -1)"
  [ -n "$hostport" ] || die "the container published no port for 4700/tcp."
  BASE="http://$hostport"
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "$BASE/healthz" 2>/dev/null; then
      ok "healthy at $BASE (after ${i}s)"
      return 0
    fi
    # A container that died is never going to become healthy; say so now, with
    # its logs, rather than after a minute of polling a closed port.
    if [ -z "$(docker ps -q -f name="^${CTR}$")" ]; then
      docker logs "$CTR" 2>&1 | tail -30 >&2
      die "the container exited before it became healthy."
    fi
    sleep 1
  done
  docker logs "$CTR" 2>&1 | tail -30 >&2
  die "/healthz did not answer within 60s."
}

# One shell inside the volume, run as the image's own user with the image's own
# tools. Deliberately NOT alpine/busybox: pulling a second image makes this
# script need a network, and the filesystem we are inspecting is the one this
# image writes — so let it be the one that reads it back.
in_volume() {
  docker run --rm -v "$VOL":/v --entrypoint sh "$IMAGE" -c "$1"
}


# --- 1. the image under test -------------------------------------------------
step "1/9  image"
if [ $# -ge 1 ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no such image: $IMAGE"
  ok "using the image given on the command line: $IMAGE"
else
  # Build context is the repo root, not deploy/ — same invocation the Dockerfile
  # header documents and the release runbook uses.
  docker build -f "$REPO_ROOT/deploy/Dockerfile" -t "$IMAGE" "$REPO_ROOT" >/dev/null \
    || die "docker build failed."
  ok "built $IMAGE from $REPO_ROOT/deploy/Dockerfile"
fi

# --- 2. one volume, one container --------------------------------------------
step "2/9  one volume mounted at /vaults, nothing else"
docker volume create "$VOL" >/dev/null || die "could not create the volume."
ok "created volume $VOL (empty)"
boot

# --- 3/4. the default vault created itself, inside that volume ---------------
step "3/9  the default vault exists with no configuration at all"
status="$(api GET /api/vaults)"
expect_status 200 "$status" "GET /api/vaults"
check "exactly one vault" 'len(d["vaults"]) == 1'
check "its id is 'vault' (the primary)" 'd["vaults"][0]["id"] == "vault"'
check "its root is /vaults/vault — inside the single volume" 'd["vaults"][0]["root"] == "/vaults/vault"'
check "it is unsynced: no remote, not a repo" 'd["vaults"][0]["remote"] is None and d["vaults"][0]["repo"] is False'

# --- 5. a doc round-trips through the primary --------------------------------
step "4/9  a doc written through the API lands in the primary"
status="$(api POST /api/docs "$(python3 -c '
import json, sys
print(json.dumps({"path": sys.argv[1], "markdown": sys.argv[2]}))' "$PRIMARY_DOC" "$PRIMARY_TEXT")")"
expect_status 201 "$status" "POST /api/docs"
status="$(api GET "/api/docs/$PRIMARY_DOC")"
expect_status 200 "$status" "GET /api/docs/$PRIMARY_DOC"
check "reads back byte-identical" "d[\"markdown\"] == \"\"\"$PRIMARY_TEXT\"\"\""

# --- 6. a second vault, cloned into the same volume --------------------------
step "5/9  a second vault clones into a sibling directory in the SAME volume"
docker exec "$CTR" sh -c "
  set -e
  rm -rf '$SEED_DIR'
  mkdir -p '$SEED_REPO' '$SEED_DIR/work'
  git init --bare -q -b main '$SEED_REPO'
  git init -q -b main '$SEED_DIR/work'
  printf '# a note that came from the remote\n' > '$SEED_DIR/work/$SEED_DOC'
  git -C '$SEED_DIR/work' add .
  git -C '$SEED_DIR/work' -c user.name=volcheck -c user.email=volcheck@z-notes.invalid \
      -c commit.gpgsign=false commit -q -m 'seed'
  git -C '$SEED_DIR/work' push -q '$SEED_REPO' main:main
" || die "could not seed the bare repo inside the container."
ok "seeded a bare repo at $SEED_REPO (inside the container, NOT in the volume)"

status="$(api POST /api/vaults "$(python3 -c '
import json, sys
print(json.dumps({"url": sys.argv[1], "name": sys.argv[2]}))' "$SEED_URL" "$SECOND_ID")")"
expect_status 201 "$status" "POST /api/vaults"
check "the new vault is @$SECOND_ID" "d[\"vault\"][\"id\"] == \"$SECOND_ID\""
check "its root is /vaults/$SECOND_ID — a sibling of the primary" "d[\"vault\"][\"root\"] == \"/vaults/$SECOND_ID\""
check "it is a repo with a remote" 'd["vault"]["repo"] is True and d["vault"]["remote"]'

# --- 7. the prefix addresses it ----------------------------------------------
step "6/9  the secondary's doc is addressable as @$SECOND_ID/$SEED_DOC"
status="$(api GET "/api/docs/%40$SECOND_ID/$SEED_DOC")"
expect_status 200 "$status" "GET /api/docs/%40$SECOND_ID/$SEED_DOC"
check "the path comes back qualified" "d[\"path\"] == \"@$SECOND_ID/$SEED_DOC\""
check "the markdown is what the remote carried" '"came from the remote" in d["markdown"]'

# --- 8. replace the container, keep the volume -------------------------------
step "7/9  replace the container against the SAME volume"
# SIGTERM first, the way the kubelet does it: the server's shutdown() handler
# closes sqlite and stops the watchers, which is the path a restart actually
# takes in production.
docker stop -t 15 "$CTR" >/dev/null || die "could not stop the container."
docker rm "$CTR" >/dev/null || die "could not remove the container."
ok "container gone; volume $VOL untouched"
boot

status="$(api GET /api/vaults)"
expect_status 200 "$status" "GET /api/vaults after restart"
check "both vaults came back" 'sorted(v["id"] for v in d["vaults"]) == ["'"$SECOND_ID"'", "vault"]'
check "roots are still both under /vaults" 'all(v["root"].startswith("/vaults/") for v in d["vaults"])'
status="$(api GET "/api/docs/$PRIMARY_DOC")"
expect_status 200 "$status" "GET /api/docs/$PRIMARY_DOC after restart"
check "the primary's doc survived" "d[\"markdown\"] == \"\"\"$PRIMARY_TEXT\"\"\""
status="$(api GET "/api/docs/%40$SECOND_ID/$SEED_DOC")"
expect_status 200 "$status" "GET @$SECOND_ID/$SEED_DOC after restart"
check "the secondary's doc survived — the filesystem IS the registry" '"came from the remote" in d["markdown"]'

# --- 9. the layout on the volume itself --------------------------------------
step "8/9  the volume's top level is one directory per vault, nothing else"
layout="$(in_volume 'ls -A /v | sort')" || die "could not read the volume."
printf '    /v contains: %s\n' "$(printf '%s' "$layout" | tr '\n' ' ')"
expected="$(printf '%s\n' "$SECOND_ID" vault | sort)"
[ "$layout" = "$expected" ] || die "unexpected top-level entries (wanted exactly: $(printf '%s' "$expected" | tr '\n' ' '))"
ok "exactly two entries: $SECOND_ID, vault"
in_volume 'for e in /v/* /v/.[!.]*; do [ -e "$e" ] || continue; [ -d "$e" ] || exit 1; done' \
  || die "something at the top level of the volume is not a directory."
ok "every top-level entry is a directory"
in_volume 'test -d /v/vault/.znotes && test -d /v/'"$SECOND_ID"'/.git' \
  || die "the vaults are not self-contained (missing /v/vault/.znotes or /v/$SECOND_ID/.git)."
ok "each directory carries its own state: vault/.znotes, $SECOND_ID/.git"

step "9/9  done"
ok "one PVC-shaped volume, one directory per vault, the default vault free"
