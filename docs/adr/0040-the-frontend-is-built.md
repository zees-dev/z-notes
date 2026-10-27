# 0040 — The frontend is built

## Status

Accepted, 2026-10-28. Implements
[spec 0024](../specs/done/0024-built-installable-offline-app.md).

Supersedes: the "no frontend build step" decisions in
[ADR 0007](0007-installable-web-app.md) (its Context),
[ADR 0010](0010-mermaid-is-a-committed-bundle.md) (the "a generator, not a build
step" framing) and
[ADR 0037](0037-blocknote-edits-docs-markdown-stays-the-file.md) (the island is
bundled by the server at boot and served from `/vendor`).

Amends: [ADR 0038](0038-assets-are-compressed-and-cached-for-a-month.md) —
hashed assets live under `/assets/`, the shell is spliced at a marker, the
`/vendor` aliases and the 503 are gone, and per-file `app/*.js` serving is gone.

## Context

Measured on 2026-10-27 in headless Chromium (Pixel 5 emulation, CPU throttled
4×, Fast 3G): a cold boot is about nine requests in a row — HTML, render-blocking
CSS, `app.js`, its 17 modules, `armor.js`, settings, tree and session, the doc,
17 statically imported mermaid chunks — and every vanilla module is `no-cache` +
ETag, so a warm load pays the whole chain in 304s. The load is a chain of round
trips, not bytes or CPU. Serving the app as loose files is what makes the chain
long, and it leaves nothing for a service worker to precache as one release.

The server also bundled the island and age at boot and compressed at boot, which
is why the image shipped `node_modules` and why the Pi paid for it on every
restart.

## Decision

- **One build, at image build.** `scripts/build.ts` (`bun run build`) runs one
  `Bun.build` over the boot entry, the BlockNote island and the crypto worker:
  splitting, minification, content-hashed names under `/assets/`; a second,
  stable-named build for `/sw.js`; brotli q11 and gzip beside every textual
  output; a `build.json` manifest. It writes `dist/` and exits non-zero on any
  build error, so a frontend that fails to build fails the image build.
- **The server loads `dist/` at boot** (`ZNOTES_DIST`; `server/frontend.ts`) and
  bundles nothing and compresses only the finished shell, which depends on the
  runtime options (`ZNOTES_SW`, `ZNOTES_ORIGIN`). The runtime image has `server/`, `dist/` and
  `package.json` — no `node_modules`, no `app/`.
- **The same build runs in memory without `ZNOTES_DIST`** (dev, tests), at
  brotli q9, and `ZNOTES_DEV=1` rebuilds on an `app/` edit. One serving path
  either way: `serveFrontend` answers only exact keys of the build's asset map,
  so there is no file-system walk and no path traversal.
- **The shell is spliced at a marker.** `app/index.html` carries
  `<!-- znotes:head -->`; the build replaces it with the build id, the
  service-worker and origin metas, the island's stylesheet, `modulepreload` for
  the island entry and the boot closure, and `#znotes-assets` naming the island
  and worker URLs. The island's own chunks are not preloaded: doing so delayed
  first paint.
- **A failed in-memory build does not stop the server.** The API and `/healthz`
  keep serving and the shell shows the build error in the boot screen.
- **Mermaid loads on first use.** A build plugin resolves every `mermaid`
  import but `app/mermaid-lazy.ts`'s to that file, which defers the library until
  a diagram needs it. A fence is still untrusted input (ADR 0010).
- **Boot starts what it needs together:** settings, tree and the island at once;
  the AI session, proposals and sync status start unawaited and cannot fail boot.

## Consequences

- Retired: the `/vendor/*` routes and aliases, `server/age-entry.js`, the
  `serveStatic` file walk, the 503 for a failed bundle, and bundling and
  compression at boot.
- `import.meta.url` in the app now names a hashed chunk: `API_ROOT` comes from
  `document.baseURI`, and `new Worker` URLs come from `#znotes-assets` — Bun does
  not rewrite `new Worker(new URL(…))`.
- `server/search-match.ts` is bundled into the browser as well (ADR 0041), so it
  is pure and imports nothing.
- Bundler output can differ between Bun 1.4.0 and 1.4.4; the image pins 1.4.4 and
  is the release build.
- Runtime dependencies become build inputs; any further dependency is still an
  ADR.
