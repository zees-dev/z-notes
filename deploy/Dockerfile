# =============================================================================
# z-notes — production image (SPEC §10)
#
# Build context is the REPO ROOT, not deploy/:
#     docker build -f deploy/Dockerfile -t z-notes:0.1.0 .
#
# Three stages so the final image carries the runtime and nothing else: the
# dependency install (and bun's ~/.bun/install/cache) stays in `deps`, the
# import-graph verification stays in `src`, and neither is a layer in the
# image that ships.
#
# NO FRONTEND BUILD STEP — deliberately.
#   `server.ts` serves the frontend as plain files out of `APP_DIR = <repo>/app`
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
# NOT `bun build --compile`: the compiled binary reports import.meta.dir as
#   /$bunfs/root (research §5), and server.ts derives APP_DIR, VENDOR_ENTRY and
#   LOCKFILE from import.meta.dir. The vault and DB are already immune (they come
#   from $ZNOTES_VAULT), but the app/vendor paths are not. Plain `bun server.ts`
#   keeps import.meta.dir honest.
# =============================================================================

# --- stage 1: production dependencies only ----------------------------------
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /src
COPY package.json bun.lock ./
# --production drops puppeteer-core (dev-only, headless parity tests);
# --frozen-lockfile makes an out-of-date bun.lock a build failure, not a silent
# version drift; --ignore-scripts means no dependency runs code at build time.
RUN bun install --frozen-lockfile --production --ignore-scripts


# --- stage 2: sources, with the import graph proven at build time ------------
# This stage exists because the previous revision of this file shipped a
# hand-maintained COPY list that silently went stale: sse.ts, terminal.ts and
# trash.ts were added to the repo and the list was not updated, which would
# have produced an image that dies at boot with "Cannot find module". Two
# defences now:
#
#   1. `COPY *.ts` — every backend module lives flat at the repo root, so the
#      glob IS the module set and cannot drift. (.dockerignore plus the repo's
#      own hygiene keep stray .ts files out of the root; tests/, prototypes/
#      and wayfinder/ are directories and don't match.)
#   2. `bun build --target=bun server.ts` — resolves the ENTIRE static import
#      graph from the real entrypoint. A missing module (say, a future
#      lib/foo.ts that the glob doesn't cover) fails the BUILD, not the deploy.
#      The bundle it emits is thrown away; only the resolution matters.
#
# node_modules is borrowed from `deps` for the graph check, then removed, so
# the `COPY --from=src /src/ ./` in the runtime stage carries sources only.
FROM oven/bun:1.3.14-slim AS src
WORKDIR /src
COPY package.json bun.lock ./
COPY *.ts ./
COPY app ./app
COPY vendor ./vendor
COPY --from=deps /src/node_modules ./node_modules
RUN bun build --target=bun --outdir=/tmp/graph server.ts > /dev/null \
 && rm -rf /tmp/graph node_modules


# --- stage 3: runtime -------------------------------------------------------
FROM oven/bun:1.3.14-slim AS runtime

# Three packages, each earning its place:
#   git             — hard runtime dependency: SPEC §7 sync shells out to `git`
#                     via Bun.spawn.
#   ca-certificates — what lets that git push to GitHub over HTTPS.
#   procps          — `ps`, which terminal.ts's killTree() walks to signal a
#                     cancelled command's whole process subtree (Bun.spawn has
#                     no detached/setsid). Without it cancel degrades to
#                     signalling the shell only, and a `sleep 300` child keeps
#                     the output stream open after the user pressed Ctrl+C.
# Nothing else is installed — in particular no curl/wget, because the k8s
# probes are httpGet (the kubelet makes the request, not the container) and
# the plain-docker HEALTHCHECK below uses the bun that is already here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node_modules first: its layer is content-addressed, so it re-ships only when
# bun.lock actually changes even though source edits rebuild the stages above.
COPY --from=deps --chown=bun:bun /src/node_modules ./node_modules

# Everything else comes from the verified `src` stage in one copy: package.json,
# bun.lock, the ten backend modules, app/, vendor/. bun.lock is NOT optional at
# runtime: server.ts hashes it into the /vendor/age.<hash>.js cache key.
COPY --from=src --chown=bun:bun /src/ ./

# The vault is a MOUNT POINT, never baked in. It is created empty and owned by
# the runtime user so a plain `docker run -v` also works; in k8s the PVC covers
# it. Everything stateful lives under here: notes, .znotes/settings.toml,
# .znotes/vault.pub, .znotes/identity.age, .znotes/index.db{,-wal,-shm}.
RUN mkdir -p /vault && chown bun:bun /vault
VOLUME ["/vault"]

# uid/gid 1000, shipped by the oven/bun base image. Nothing in /app is writable
# by it, which is correct: the process only ever writes under $ZNOTES_VAULT.
USER bun

ENV ZNOTES_VAULT=/vault \
    ZNOTES_PORT=4700 \
    NODE_ENV=production \
    GIT_TERMINAL_PROMPT=0

EXPOSE 4700

# For the plain-docker path. k8s ignores this and uses the probes in the
# Deployment instead. Port is the literal default; override the whole
# HEALTHCHECK if you move ZNOTES_PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4700/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `bun server.ts` — NOT `bun --hot` and NOT `bun run dev`. Bun.serve is already
# pinned to development:false in server.ts, so no dev runtime or HMR client can
# reach the browser. Exec form: bun is PID 1 and receives SIGTERM directly,
# which is what server.ts's shutdown() handler is waiting for.
CMD ["bun", "server.ts"]
