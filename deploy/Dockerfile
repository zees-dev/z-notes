# =============================================================================
# z-notes — production image
#
# Build context is the REPO ROOT, not deploy/:
#     docker build -f deploy/Dockerfile -t z-notes:0.1.0 .
#
# The image is pushed to ghcr.io/zees-dev/z-notes (ADR 0005); the source label
# below links the package to this repo on GitHub's side.
#
# Three stages so the final image carries the runtime and nothing else: the
# dependency install (and bun's ~/.bun/install/cache) stays in `deps`, the
# import-graph verification stays in `src`, and neither is a layer in the
# image that ships.
#
# NO FRONTEND BUILD STEP — deliberately.
#   `server/index.ts` serves the frontend as plain files out of `APP_DIR = <repo>/app`
#   (see serveStatic()); app/index.html links ./themes/*.css and inlines its own
#   ES module. Running `bun build ./app/index.html --outdir=dist` would emit a
#   *different* tree (content-hashed asset names, rewritten tags) at a path the
#   server does not look at, so it would either do nothing or break serving.
#   The one thing that genuinely needs bundling — the `age-encryption` browser
#   module — is bundled by the server itself at boot (buildVendor(), held in
#   memory, served from /vendor/age.<hash>.js) and therefore needs node_modules
#   present at runtime, which is why we install deps rather than tree-shake them
#   away. If prod serving ever moves to a dist/ tree, add the build here AND
#   point APP_DIR at it in the same change.
#
#   MERMAID IS NOT THAT, deliberately (ADR 0010). It is a devDependency and
#   `app/vendor/mermaid.js` is a COMMITTED artifact, so it arrives via
#   `COPY app ./app` like any other static file and `--production` leaves its
#   181 MB of node_modules behind. Bundling it at boot the way age is bundled
#   would have required it at runtime and grown this image by that much, for a
#   library only ever executed in a browser. Do not "tidy" it into buildVendor().
#
# NOT `bun build --compile`: the compiled binary reports import.meta.dir as
#   /$bunfs/root (research §5), and server/index.ts derives APP_DIR, VENDOR_ENTRY
#   and LOCKFILE from import.meta.dir. The vaults and their DBs are already
#   immune (they come from $ZNOTES_VAULTS_DIR), but the app paths are not. Plain
#   `bun server/index.ts` keeps import.meta.dir honest.
# =============================================================================

# --- stage 1: production dependencies only ----------------------------------
FROM oven/bun:1.4.0-slim AS deps
WORKDIR /src
COPY package.json bun.lock ./
# --production drops puppeteer-core (dev-only, headless parity tests);
# --frozen-lockfile makes an out-of-date bun.lock a build failure, not a silent
# version drift; --ignore-scripts means no dependency runs code at build time.
RUN bun install --frozen-lockfile --production --ignore-scripts


# --- stage 2: sources, with the import graph proven at build time ------------
# This stage exists because an early revision of this file shipped a
# hand-maintained COPY list that silently went stale: sse.ts, terminal.ts and
# trash.ts were added to the repo and the list was not updated, which would
# have produced an image that dies at boot with "Cannot find module". Two
# defences now:
#
#   1. The backend is ONE directory — `COPY server ./server` cannot drift the
#      way a file list can.
#   2. `bun build --target=bun server/index.ts` — resolves the ENTIRE static
#      import graph from the real entrypoint. A module that somehow escapes the
#      directory copy fails the BUILD, not the deploy. The bundle it emits is
#      thrown away; only the resolution matters.
#
# node_modules is borrowed from `deps` for the graph check, then removed, so
# the `COPY --from=src /src/ ./` in the runtime stage carries sources only.
FROM oven/bun:1.4.0-slim AS src
WORKDIR /src
COPY package.json bun.lock ./
COPY server ./server
COPY app ./app
COPY --from=deps /src/node_modules ./node_modules
RUN bun build --target=bun --outdir=/tmp/graph server/index.ts > /dev/null \
 && rm -rf /tmp/graph node_modules


# --- stage 3: runtime -------------------------------------------------------
FROM oven/bun:1.4.0-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/zees-dev/z-notes"

# Two packages, each earning its place:
#   git             — hard runtime dependency: git sync shells out to `git`
#                     via Bun.spawn.
#   ca-certificates — what lets that git push to GitHub over HTTPS.
# Nothing else is installed — in particular no curl/wget, because the k8s
# probes are httpGet (the kubelet makes the request, not the container) and
# the plain-docker HEALTHCHECK below uses the bun that is already here; and no
# procps, because terminal.ts spawns the shell `detached: true` and cancels it
# by process group, rather than walking a `ps` table to find its children.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node_modules first: its layer is content-addressed, so it re-ships only when
# bun.lock actually changes even though source edits rebuild the stages above.
COPY --from=deps --chown=bun:bun /src/node_modules ./node_modules

# Everything else comes from the verified `src` stage in one copy: package.json,
# bun.lock, server/, app/. bun.lock is NOT optional at runtime: the server
# hashes it into the /vendor/age.<hash>.js cache key.
COPY --from=src --chown=bun:bun /src/ ./

# The VAULTS HOME is a MOUNT POINT, never baked in. One volume holds every
# vault, one top-level directory each — the primary at /vaults/vault and any
# secondary beside it (ADR 0018) — so N vaults are still one mount, one PVC and
# one backup. Each of those directories is a self-contained world: its notes,
# its .znotes/settings.toml, its .znotes/vault.pub, its .znotes/identity.age,
# its .znotes/index.db{,-wal,-shm}, and its own .git. Nothing about which vaults
# exist is baked into this image — the filesystem under here IS the registry, so
# adding a vault is creating a directory, not editing a Dockerfile.
#
# Created empty and owned by the runtime user so a plain `docker run -v` also
# works; in k8s the PVC covers it.
#
# BREAKING for anyone who ran `docker run -v "$HOME/notes:/vault"`: that path is
# no longer special and the container will boot into an empty vault at
# /vaults/vault. Mount the PARENT instead and put the old vault inside it as a
# directory named `vault`:
#     mkdir -p "$HOME/vaults" && mv "$HOME/notes" "$HOME/vaults/vault"
#     docker run -v "$HOME/vaults:/vaults" ...
# Mounting a single vault straight at /vaults/vault also works and keeps one
# directory on the host, but then the home has no room for a second vault.
RUN mkdir -p /vaults && chown bun:bun /vaults
VOLUME ["/vaults"]

# uid/gid 1000, shipped by the oven/bun base image. Nothing in /app is writable
# by it, which is correct: the process only ever writes under the vaults home.
USER bun

# ONE KNOB, not a pair that can disagree. ZNOTES_VAULTS_DIR is the home; the
# server derives the primary as <home>/vault by itself. Pinning ZNOTES_VAULT
# here as well would nail the primary to a literal path and stop it following
# the home, so anyone who remounted the volume elsewhere would get a primary
# outside their own vaults directory — an empty vault sitting next to their
# notes, and a boot scan that indexes the real one as a *secondary*. Setting
# only the home makes that shape unrepresentable. ZNOTES_VAULT still exists and
# is still honoured; it is an override for the deliberate case (a primary on its
# own mount), not something this image should decide on the operator's behalf.
ENV ZNOTES_VAULTS_DIR=/vaults \
    ZNOTES_PORT=4700 \
    NODE_ENV=production \
    GIT_TERMINAL_PROMPT=0

EXPOSE 4700

# For the plain-docker path. k8s ignores this and uses the probes in the
# Deployment instead. Port is the literal default; override the whole
# HEALTHCHECK if you move ZNOTES_PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4700/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `bun server/index.ts` — NOT `bun --hot` and NOT `bun run dev`. Bun.serve is
# already pinned to development:false, so no dev runtime or HMR client can
# reach the browser. Exec form: bun is PID 1 and receives SIGTERM directly,
# which is what the server's shutdown() handler is waiting for.
CMD ["bun", "server/index.ts"]
