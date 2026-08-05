# =============================================================================
# z-notes — production image (SPEC §10)
#
# Build context is the REPO ROOT, not deploy/:
#     docker build -f deploy/Dockerfile -t z-notes:0.1.0 .
#
# Two stages so the final image carries the runtime and nothing else: the
# dependency install (and bun's ~/.bun/install/cache) stays in `deps` and is
# never a layer in the image that ships.
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


# --- stage 2: runtime -------------------------------------------------------
FROM oven/bun:1.3.14-slim AS runtime

# git is a hard runtime dependency: SPEC §7 sync shells out to `git` via
# Bun.spawn. ca-certificates is what lets that git push to GitHub over HTTPS.
# Nothing else is installed — in particular no curl/wget, because the k8s
# probes are httpGet (the kubelet makes the request, not the container) and
# the plain-docker HEALTHCHECK below uses the bun that is already here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node_modules first: it changes only when bun.lock does, so the source COPY
# below can invalidate on every commit without re-installing anything.
COPY --from=deps --chown=bun:bun /src/node_modules ./node_modules

# Explicit file list, not `COPY . .` — tests/, prototypes/, wayfinder/, vault/
# and .git must not be in the image. bun.lock is NOT optional at runtime:
# server.ts hashes it into the /vendor/age.<hash>.js cache key.
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun server.ts vault.ts watch.ts db.ts settings.ts git.ts ai.ts ./
COPY --chown=bun:bun app ./app
COPY --chown=bun:bun vendor ./vendor

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
