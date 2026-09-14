# 0038 — Assets are compressed, and a content-addressed URL is cached for a month

## Status

Accepted, 2026-09-15. Amends the asset half of
[ADR 0037](0037-blocknote-edits-docs-markdown-stays-the-file.md) (the island is
still bundled at boot and served from `/vendor`, but the shell names the hashed
pair instead of going through the alias) and the caching paragraphs of
[spec 0002](../specs/done/0002-http-api-v0.md), which is where the contract
lives.

## Context

Measured on the deployed Pi, phone-sized headless Chromium, three loads: the app
shell appeared at 4–6 s and the editor mounted at 10.5–14 s. Three costs, all of
them the server's:

- **Nothing was compressed.** The island's entry is 1.33 MB and its stylesheet
  368 KB, served identity, over an uplink that manages roughly 250 KB/s. That
  alone is five seconds.
- **The hot path went through a redirect.** The shell asked for
  `/vendor/editor.css`, got a `no-cache` 302 into the hashed file, and the entry
  was only discovered later still, by `import("/vendor/editor.js")` inside
  `renderVisual` — after the tree had loaded. Chromium reuses a hashed asset it
  reached directly; it would not reliably reuse one it reached through the
  no-cache alias, so on the live site both re-transferred in full on warm loads.
- **The download did not overlap the boot.** The 1.3 MB started after the shell
  had finished fetching everything else.

The `immutable` year the assets carried was also longer than anyone can undo. A
month is what the user asked for, and it is the same guarantee: the URL is the
hash.

## Decision

- **The shell names the hashed pair.** `serveStatic` rewrites the one
  `<link id="editor-css">` tag in `index.html` on the way out: `href` becomes the
  hashed stylesheet, `data-js` carries the hashed entry, and a
  `<link rel="modulepreload">` for that entry follows it. `editor.js` imports
  `css.dataset.js`. So both assets are one direct, cacheable request, and the
  entry starts in `<head>` rather than after the tree. The rewritten bytes are
  memoised per build and the shell's `ETag` carries the entry's hash, so a new
  bundle invalidates the HTML that names it.
- **The aliases stay.** `/vendor/editor.js|css` and `/vendor/age.js` are still
  `no-cache` 302s to the current hashed asset. They are the direct-hit path and
  the fallback the unrewritten shell falls back to when the bundle failed to
  build — which still answers 503 and degrades to Source.
- **Every textual asset is content-coded, once.** Brotli (quality 9) and gzip
  are built at boot for the two `Bun.build` bundles and on first request for the
  files under `app/`, then held in memory; `Accept-Encoding` picks brotli, then
  gzip, then identity, and the response says `vary: accept-encoding`.
  Compressing per request would hand that cost to every load, which on this
  hardware is the thing being fixed. Fonts and images are skipped: they arrive
  compressed and a second pass only costs boot time.
- **A coding is a representation, so it gets its own `ETag`** — the identity tag
  with `-br` or `-gz` inside the quotes (RFC 9110 §8.8.1). One tag shared across
  codings would let a revalidation answer 304 to a client holding the other
  coding's bytes.
- **Two cache policies, decided by the URL.** Content-addressed assets
  (`/vendor/editor/*`, `/vendor/age.<hash>.js`) get
  `public, max-age=2592000, immutable`. Everything that is **not**
  content-addressed — `index.html`, `/app.js`, `/tree.js`, `themes/*.css`,
  `manifest.json`, the icons — keeps `no-cache` + `ETag`. A month on those would
  hide a release from an already-warm browser until it expired; a revalidation
  that answers 304 costs a few hundred bytes, and the browser was measured
  taking that 304.

## Consequences

- Measured on this machine (headless Chromium at 390×844, CDP-throttled to
  250 KB/s, cold then two warm loads): the shell went from 5.8 s to 2.4 s and the
  editor from 14.9 s to 4.3 s; a cold load transfers 862 KB instead of 3.28 MB.
  On a warm load the entry and the stylesheet never reach the network
  (`transferSize` 0) and every shell file is a 304 on the wire.
- Boot pays the compression: roughly 0.6 s of brotli over the editor bundle on
  this hardware, on top of ADR 0037's half-second build. The port opens after it,
  so readiness is unaffected — a pod simply takes that much longer to be ready.
- The served `index.html` is no longer byte-identical to the file on disk. Tests
  that compare the shell to `app/index.html` have to compare against the served
  bytes, and the one rewrite is a regex over a tag with a known `id`: an edit
  that renames that id silently disables the fast path, which
  `tests/editor-assets.test.ts` asserts against.
- `deploy/README.md` already warns against attaching a Traefik `compress`
  middleware because of SSE. That warning now also avoids double-compressing
  what this process already compressed.
- Not done here: `Accept-Encoding: zstd`, precompressed font subsetting, and
  splitting the island so that a Source-only session does not preload the
  editor. The preload is unconditional on purpose — Edit is the default mode.
