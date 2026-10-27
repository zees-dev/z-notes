# 0024 — The app is built, installs, and works offline

## Problem Statement

z-notes feels slow to open, does not work without a network, and greets every device with a
certificate warning. The user could not read their notes on a plane. They want the quickest
route to a fast, installable app on macOS, Android and the web that reads and edits notes
offline and catches up when the network returns, **keeping the Bun backend as it is**.

Measured on 2026-10-27 with headless Chromium (Pixel 5 emulation, CPU throttled 4×, the e2e
harness's server, HTTP/2). The real phone and Safari were **not** measured.

1. **The load is a chain of serial round trips, not CPU or bytes.** A cold boot is about 9
   hops in a row: HTML → render-blocking CSS → `app.js` (imported only after `boot()` awaits
   `navigator.serviceWorker.getRegistrations()`) → its 17 modules → `armor.js` →
   `GET /api/settings` → tree + session + sync + proposals → the doc → 17 statically-imported
   mermaid chunks → mount. Every vanilla module is `no-cache` + ETag, so a warm load still
   pays the chain in 304s: **6.2 s to editable on Fast 3G with 26 KB transferred.** Moving
   from 4× to 6× CPU throttling changes that by under 190 ms.
2. **The untrusted certificate (`K3s Local CA`) breaks offline at the root.** Chrome refuses to
   register a service worker on an origin with a certificate error, even after "Proceed"
   (measured). It also writes nothing to its HTTP disk cache, so every reopen re-downloads
   843 KB (9.5 s against 6.4 s on Fast 3G). It refuses to install the app
   (`NOT_FROM_SECURE_ORIGIN`). The warning returns because Chrome keeps a click-through for
   exactly one week (`kCertErrorBypassExpirationInSeconds = 604800`), keyed by the chain's
   fingerprint, and cert-manager rotates the key at day 60.
3. **Nothing works offline.** `app/index.html` unregisters every service worker at boot, and
   with no network `start()` throws: "The app failed to start — Cannot reach the z-notes
   backend."
4. Production `GET /api/docs` is served uncompressed (27.6 KB, no `content-encoding`).

A prototype of four changes (lazy mermaid, flat modulepreload, parallel boot fetches with an
early island import, an app-shell service worker) took reopen-to-editable from **6446 to
1110 ms** on Fast 3G and from **1660 to 412 ms** on LAN, and first paint on reopen to 144 ms.
The six gates passed (178/178). Answering boot's API reads locally made a fully offline reopen
editable in **391 ms**. The prototype lives, uncommitted, in the worktree
`.claude/worktrees/wf_71305947-a22-2` (`git diff` there; `perf/` holds `measure.ts` and every
result file).

The user chose, on 2026-10-28:
- A canonical HTTPS origin, `https://znotes.tailb95e62.ts.net`, via the Tailscale operator.
- Offline read, edit and create; rename, move and delete stay online-only.
- The existing conflict banner on reconnect, with no auto-merge.
- **A build-time `Bun.build` into a hashed `dist/`, in scope now.**
- Chrome-installed app on the Mac as the primary surface.
- Precaching every editor chunk, so diagrams render offline.
- No native shell and no framework change.

## Solution

One change, landed in the order under "Work order" so every step is green on its own:

1. **Build step.** `scripts/build.ts` runs one `Bun.build` over the whole frontend: the shell's
   boot entry, the BlockNote island and the crypto worker. It uses splitting, minification
   and content-hashed names under `/assets/`, plus a second, stable-named build for `/sw.js`.
   It precompresses every textual output (brotli q11 + gzip) and writes `dist/` with a
   `build.json` manifest. The image runs it, and the server **loads** `dist/` at boot instead
   of bundling and compressing. With no `dist/` (dev, tests), the server runs the same build
   in memory. Either way there is one serving path.
2. **Shorter boot chain.** A bundled shell is one request, not about 20. `<head>` names every
   static chunk with `modulepreload`. Mermaid loads on first use. Settings, the tree and the
   island start together, and nothing on the editing path waits for the AI session,
   proposals or sync status.
3. **App-shell service worker.** `/sw.js` is generated per build, precaches the whole release,
   serves the shell and assets cache-first, and never touches `/api`, `/events` or
   `/healthz`. It updates only when the user accepts a "Reload" prompt. `ZNOTES_SW=off` turns
   it into a worker that removes itself.
4. **Replica and outbox.** `app/replica.js` keeps an IndexedDB copy of every vault's tree and
   docs, plus settings and keyring, filled in the background through a new batch read. Every
   save is written to an **outbox** before its `PUT`, durably. A save the server never
   acknowledged stays there, survives the app being killed, and is **replayed** when the
   network returns. A replay that meets someone else's change raises the **existing**
   conflict banner. The server makes `PUT` idempotent on identical bytes, so a lost reply
   costs nothing. Offline, the app reads, edits, creates docs, searches and reveals secrets.
   Everything else fails with one clear message.
5. **Canonical origin.** The Tailscale Ingress serves the app on
   `https://znotes.tailb95e62.ts.net` with a Let's Encrypt certificate. The app enables its
   service worker and replica **only** on that origin (`ZNOTES_ORIGIN`). `znotes.k3s.lan`
   stays as a LAN break-glass, and its plain-HTTP router redirects to the new name.

```
 device (one origin) ───────────────────────────────┐      Tailscale Ingress (LE cert)
  page: shell bundle + island + crypto worker        │            │
   api.js ── replica.js (IndexedDB: docs, tree,      │            ▼
             outbox, meta)                           │   Bun server (unchanged core)
  sw.js: cache znotes-<BUILD>, cache-first assets ───┼─► + loads dist/, + /sw.js
         /api, /events, /healthz: never intercepted  │   + rev/epoch in GET /api/docs
                                                     │   + POST /api/replica
                                                     │   + PUT idempotent on bytes
                                                     │   + compressed JSON
```

## User Stories

1. As a user, I want z-notes at an HTTPS address every device trusts with nothing installed, so I never see a certificate warning again.
2. As a user, I want to install z-notes from Chrome on my phone and Mac and get its own icon and window.
3. As a user reopening the app, I want my last doc editable in about half a second on my LAN, because the shell, code and doc come from the device.
4. As a user on a slow network, I want the first visit to start downloading everything it needs at once, not one file after another.
5. As a user, I want a doc with no diagram to open without downloading the diagram library, and a doc with one to render it.
6. As a user, I want editing to be ready even when the AI session, proposals or sync status are slow or failing.
7. As a user on a plane, I want to open the installed app, see my whole tree across every vault, open any doc and edit it.
8. As a user offline, I want to create a new doc and have it in my tree.
9. As a user offline, I want my edits saved on this device, and the save indicator to say "Saved on this device", not "Saved".
10. As a user offline, I want my edits to survive the app being killed, the phone restarting, or the tab closing.
11. As a user coming back online, I want every offline edit written to the Pi, byte for byte, without doing anything.
12. As a user whose doc changed elsewhere while I was offline, I want the conflict banner I already know, with both versions kept, never a silent overwrite.
13. As a user whose doc was deleted elsewhere while I was offline, I want the dialog I already know for a buffer whose file is gone.
14. As a user whose offline-created doc's path was taken elsewhere meanwhile, I want the conflict banner, not a lost doc.
15. As a user, I want a save whose reply was lost in transit to finish cleanly on retry, not to raise a false conflict.
16. As a user, I want a save that cannot be stored because the device is full to say so and keep the text unsaved, never claim it was saved.
17. As a user offline, I want search to find docs by path and by line, with secret contents never matching.
18. As a user offline, I want to reveal and create secrets with my passphrase, because the keyring is on the device.
19. As a user offline, I want rename, move, delete, trash, settings changes, AI, the terminal and git sync to say "You're offline — this needs the server." and change nothing.
20. As a user, I want a new release to wait until I accept a "Reload" prompt, so an open, unsaved doc is never reloaded under me.
21. As a user accepting that prompt with unsaved text, I want it saved, at least to the device, before the reload.
22. As a user, I want a broken release to be recoverable from the server alone (`ZNOTES_SW=off`), without wiping my unsent edits.
23. As a user who opens the old `znotes.k3s.lan` address, I want the app to work online and tell me where to open it for offline use, without filling a second device copy.
24. As a user typing `http://znotes.k3s.lan`, I want to land on the new address.
25. As a user with a deep link (`/d/<path>`, `/settings/<section>`) opened offline, I want it to open what it names.
26. As a user, I want every other behaviour of today's app unchanged online: tree, Edit, secrets, AI, terminal, git sync, trash, WebMCP tools, themes, routing, Back and Esc.
27. As the developer, I want `bun run dev` to pick up a frontend edit on reload, as it does today.
28. As the developer, I want a frontend that fails to build to fail the image build, and in dev to show the build error in the boot screen while the API keeps serving.
29. As the operator, I want the Pi to boot faster: no bundling and no compression at boot, and no `node_modules` in the runtime image.
30. As an agent driving WebMCP, I want every tool to behave as today online and to fail with the offline message, not hang, when offline.

## Implementation Decisions

### Vocabulary (add to `CONTEXT.md`)

- **build** — one run of `scripts/build.ts` (or its in-memory twin). Its **build id** names the
  release; every hashed asset belongs to exactly one build.
- **app shell** — `index.html` as served, with the build's tags spliced in.
- **canonical origin** — the one origin where the service worker and replica run
  (`ZNOTES_ORIGIN`, default: whatever origin served the page).
- **replica** — this device's IndexedDB copy of trees, docs, settings and keyring. *Banned:*
  "cache" for the replica (the cache is the service worker's), and "sync" (sync is git).
- **outbox** — the replica's per-doc store of saves not yet acknowledged by the server.
- **replay** — sending outbox entries to the server after the network returns. *Banned:*
  "sync" for this.
- **offline** — the last request failed for lack of a network. Not `navigator.onLine`.

### Work order (each step lands with gates green; `bun run lint:docs` clean)

1. Build step and serving (§1, §2). Retire `/vendor/*` and the per-file `app/*.js` serving.
2. Boot path (§3).
3. Server API additions (§5).
4. Service worker (§4).
5. Replica, outbox, replay and offline behaviour (§6).
6. Canonical origin, deploy manifests, Dockerfile, Bun 1.4.4 (§7).
7. Docs and ADRs (§8), and the measurements in Testing Decisions.

### §1 Build: `server/frontend.ts` and `scripts/build.ts`

**`server/frontend.ts`** is a new server module and owns everything about frontend assets.
Add it to `LAYERS` in `scripts/lint-docs.ts` at layer **1** (it imports `./http` for `fail`),
and add a row to `docs/architecture.md`'s module table. **Move** these into it from
`server/index.ts`, unchanged except where stated: `IMMUTABLE_CACHE`, `REVALIDATE_CACHE`,
`TEXTUAL`, `COMPRESS_MIN`, `BROTLI_OPTS`, `Coding`, `Representation`, `represent`,
`negotiate` and `assetResponse`. **Delete** `buildVendor`, `serveVendor`, `buildEditor`,
`serveEditor`, `withHashedEditor`, `EDITOR_LINK`, `editorAssets`, `editorAliases`,
`editorBuildId`, `editorError`, `vendor`, `vendorError`, `VENDOR_ENTRY` and the
`/vendor/*` branches of `fetch`. **Delete** `server/age-entry.js`.

Exports:

```ts
export interface FrontendBuild {
  id: string;                               // build id: Bun.hash over sorted "url\0etag" of every output, hex
  assets: Map<string, Representation>;      // url → representation, for /assets/*, /sw.js and the static files
  shell: Representation;                    // the finished app shell (see §2)
  precache: string[];                       // every URL the service worker installs, "/" first
  error: string;                            // "" or why the in-memory build failed (dev/tests only)
}
export async function buildFrontend(opts: { appDir: string; sw: boolean; origin: string | null; quality: 9 | 11 }): Promise<FrontendBuild>;
export async function loadFrontend(distDir: string, opts: { sw: boolean; origin: string | null }): Promise<FrontendBuild>;
export function serveFrontend(build: FrontendBuild, pathname: string, req: Request): Response | null; // null = not a frontend path
```

**The main build** is one `Bun.build` call:

```ts
await Bun.build({
  entrypoints: [`${appDir}/boot.js`, `${appDir}/block-editor.tsx`, `${appDir}/crypto-worker.js`],
  target: "browser", format: "esm", splitting: true, minify: true, sourcemap: "none",
  publicPath: "/assets/",
  naming: { entry: "[name].[hash].[ext]", chunk: "chunk.[hash].[ext]", asset: "[name].[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  metafile: true,
  plugins: [lazyMermaid],   // from the prototype: every `mermaid` import except app/mermaid-lazy.ts's resolves to app/mermaid-lazy.ts
});
```

- From the outputs, find the boot entry JS, the island entry JS and its CSS, and the worker
  entry JS. Use the metafile (or the outputs' `kind` and `path`, whichever Bun 1.4 exposes
  reliably; verify) to compute the **boot closure**: boot's entry plus every chunk it reaches
  by static import. That list feeds the `modulepreload` tags (§2). The island's closure is
  **not** preloaded: preloading every island chunk in `<head>` delayed first paint in the
  prototype (P2).
- **The service-worker build** is a second `Bun.build` of `app/sw.js` with `minify: true`,
  `naming: "sw.js"`, and `define: { __ZNOTES_BUILD__: JSON.stringify(id),
  __ZNOTES_PRECACHE__: JSON.stringify(precache) }`. It is served at `/sw.js`.
- **Static files** are copied as-is: `index.html` (the template), `manifest.json`,
  `themes/*.css` and `icons/*.png`. They keep stable URLs, and their ETag becomes a
  **content hash** (`"<Bun.hash(bytes) hex>"`), not size-mtime, so two pods agree.
- **Precache** is `"/"`, every main-build output URL (all chunks, including the lazy mermaid
  and island chunks, fonts included), `/manifest.json`, `/themes/{base,minimal,modern,terminal}.css`
  and `/icons/icon-{180,192,512}.png` (enumerate the directory, don't hard-code it).
- In-memory mode compresses at q9 at boot, as today. `scripts/build.ts` compresses at q11.
- When `sw` is false, `/sw.js` is the **kill worker** (§4) instead of the built one.
- An in-memory build that fails does **not** stop the server. `error` is set, `assets` holds
  only the static files, and the shell's splice is a single inline
  `<script>document.getElementById("bootMsg").textContent = "The app failed to build — " + <JSON detail>;</script>`.
  The API and `/healthz` are unaffected. This replaces ADR 0038's "a failed bundle answers 503".

**`scripts/build.ts`** (`"build": "bun scripts/build.ts"` in `package.json`) calls
`buildFrontend({ quality: 11, sw: true, origin: null })` and writes `dist/`:

```
dist/build.json        { "id", "precache": [...], "files": { "<url>": { "type", "etag", "file", "br"?, "gz"? } }, "boot": [...closure], "island": { "js", "css" }, "worker" }
dist/assets/<name>.<hash>.<ext>   (+ .br, .gz when they shrink it)
dist/sw.js (+ .br, .gz)           (built with the real build id; sw/origin are re-applied at load, see below)
dist/static/index.html, manifest.json, themes/*.css, icons/*.png (+ .br, .gz for textual)
```

`dist/` is wiped first, and the script exits non-zero on any build error. `dist/` is already
in `.gitignore`. `loadFrontend` reads `build.json` and the files into `Representation`s with
**no** compression at boot. It builds the shell from the template and the runtime options.
With `sw: false` it substitutes the kill worker for `/sw.js`. So one image serves either mode.

**Server boot** (`server/index.ts`, replacing `await Promise.all([buildVendor(), buildEditor()])`):

```ts
const DIST = process.env.ZNOTES_DIST ? resolve(process.env.ZNOTES_DIST) : null;
const SW = (process.env.ZNOTES_SW ?? (process.env.ZNOTES_DEV === "1" ? "off" : "on")) !== "off";
const ORIGIN = (process.env.ZNOTES_ORIGIN || "").trim() || null;
let frontend = DIST ? await loadFrontend(DIST, { sw: SW, origin: ORIGIN })
                    : await buildFrontend({ appDir: APP_DIR, sw: SW, origin: ORIGIN, quality: 9 });
```

If `ZNOTES_DIST` is set and unreadable, boot fails loudly: an image without its frontend is
a broken image. With `ZNOTES_DEV=1`, `fs.watch(APP_DIR, { recursive: true })` debounced at
150 ms rebuilds in memory and swaps `frontend` atomically. Log one line per rebuild.
`package.json`: `"dev": "ZNOTES_DEV=1 bun --hot server/index.ts"`.

### §2 Serving: URL space, cache policy, the shell

`fetch` in `server/index.ts` after `/healthz`, `/events` and `/api`: methods other than
GET/HEAD → 405 as today. Then `serveFrontend(frontend, url.pathname, req)`, and `null` → 404
`not-found`. `serveFrontend` answers:

| Path | Response |
|---|---|
| `/`, `/d`, `/d/*`, `/settings`, `/settings/*` | the shell, `no-cache`, ETag = content hash of the finished shell bytes, plus today's `origin-agent-cluster: ?1` and `permissions-policy: tools=(self)` on the shell only (also on 304 and HEAD) |
| `/assets/<hashed>` | the asset, `IMMUTABLE_CACHE` (one month, as ADR 0038). An unknown name is a 404 and is never replaced by another asset |
| `/sw.js` | `content-type: text/javascript; charset=utf-8`, `cache-control: no-cache`, ETag |
| `/manifest.json`, `/themes/*.css`, `/icons/*` | the static file, `no-cache` + content-hash ETag |
| anything else (including `/app.js`, `/tree.js`, `/vendor/*`) | `null` → 404 |

Content-coding negotiation, per-coding ETags and `vary: accept-encoding` are `assetResponse`,
unchanged. Path traversal can no longer happen: only exact keys of `assets` are served.
Drop `serveStatic`'s file-system walk.

**The shell.** `app/index.html` loses its inline `<script type="module">` boot block (moved
to `app/boot.js`) and its `<link id="editor-css">`. Where that link stood, before
`themes/base.css` so the app's rules win, it gets one marker line: `<!-- znotes:head -->`.
The finished shell replaces the marker with, in order:

```html
<meta name="znotes-build" content="<id>">
<meta name="znotes-sw" content="on|off">
<meta name="znotes-origin" content="<ZNOTES_ORIGIN>">              <!-- only when set -->
<link rel="stylesheet" id="editor-css" href="/assets/block-editor.<h>.css" onload="this.dataset.loaded='true'" onerror="this.dataset.failed='true'">
<link rel="modulepreload" href="/assets/block-editor.<h>.js">       <!-- the island entry only, as ADR 0038 -->
<link rel="modulepreload" href="/assets/…">                          <!-- one per boot-closure chunk -->
<script type="application/json" id="znotes-assets">{"island":"/assets/block-editor.<h>.js","worker":"/assets/crypto-worker.<h>.js"}</script>
<script type="module" src="/assets/boot.<h>.js"></script>
```

`app/editor.js` `renderVisual` imports `JSON.parse($("#znotes-assets").textContent).island`
instead of `css.dataset.js || "/vendor/editor.js"`. `app/secrets.js` builds the worker
from `.worker` instead of `new URL("./crypto-worker.js", import.meta.url)`. Bun does not
rewrite `new Worker(new URL(…))` (verified 1.4.0 and 1.4.4). Keep the
`data-loaded`/`data-failed` handshake that `renderVisual` waits on, and keep ADR 0039's
"The editor could not load." + Reload note for a failed import.

**API compression.** In `api()` (`server/index.ts`), after the handler returns: if the
response's `content-type` starts with `application/json`, the body is ≥ `COMPRESS_MIN`, it
has no `content-encoding`, and the client accepts br or gzip, re-encode it. Use brotli
**quality 4**, else gzip level 6, and set `content-encoding` and `vary: accept-encoding`.
Streaming routes (`/api/ai/messages`, `/api/terminal/exec`,
`/api/terminal/commands/{id}/run`) and `/events` are never touched; only `json()`-built
responses qualify. Error bodies keep their exact JSON bytes, only content-coded.

### §3 Boot path

- **`app/boot.js`** (new; the feature module the old inline script was) holds `fatal` and
  `boot()`. It statically imports `{ start } from "./app.js"`, so the bundle is one graph.
  It sets `bootMsg` to "loading vault…", awaits `start()`, and swaps `#boot` for `#app`, as
  today. It no longer unregisters service workers. **After** `start()` resolves, and only if
  `meta[name=znotes-sw]` is `on` and the page is on the canonical origin (§7), it calls
  `navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })` and wires the
  update prompt (§4).
- **`app/api.js`**: `export const API_ROOT = new URL("./", document.baseURI);`. The shell's
  `<base href="/">` makes that the origin root; `import.meta.url` now names a hashed chunk.
  Update the comment and spec 0002's "Base" convention.
- **`app/mermaid-lazy.ts`**: copy the prototype file verbatim from the worktree. The diagram
  block calls only `initialize` (sync, queued and replayed in order on load), `parse` and
  `render`. That was verified against `@blocknote/diagram-block` 0.54.2's dist; re-check it
  on any BlockNote bump (say so in the file). Gate 6 (`tests/mermaid-e2e.test.ts`) must stay
  green: it is the proof the hardened config still reaches mermaid.
- **`start()` in `app/app.js`**: the prototype's shape, extended.
  - Before the first await, call `warmEditor()` (prototype export in `editor.js`: kick off
    the island `import()`).
  - If the URL names a doc, call `ensureLoaded(urlDoc())` (with the prototype's in-flight
    de-dup map in `editor.js`).
  - Then await `Promise.all([api.getSettings(), loadTree()])`.
  - `loadSession()`, `api.getSyncStatus().then(paintSync)` and `loadProposals()` are
    **started and not awaited**. Each catches its own failure; the chips paint when they
    answer. A failure of any of the three must not fail boot.
  - The rest of `start()` keeps its order and comments.
- `editor.js` keeps one `editorBundle` promise, and `warmEditor` and `renderVisual` share it,
  including the existing reset on a failed import.

### §4 Service worker: `app/sw.js`

Plain JS, no imports, built with the two `define`s. It is about 120 lines.

```js
const BUILD = __ZNOTES_BUILD__, PRECACHE = __ZNOTES_PRECACHE__, CACHE = "znotes-" + BUILD;
```

- **install**: open `CACHE` and fetch every `PRECACHE` URL with `{ cache: "no-cache" }`. The
  install **throws** (so the browser retries on its next update check) if any fetch is not
  OK, or if the fetched `/` does not contain `<meta name="znotes-build" content="${BUILD}">`
  (a deploy landed mid-install). Store each response under its URL; `"/"` is stored as the
  shell. Never call `skipWaiting()` here.
- **activate**: delete every cache whose name starts with `znotes-` and is not `CACHE`, then
  `clients.claim()`.
- **fetch**: same-origin GET only; everything else falls through to the network.
  - `request.mode === "navigate"`, path not under `/api`, `/events`, `/healthz`, `/assets`,
    `/sw.js`: respond with the cached shell, else the network.
  - `/assets/*`, `/manifest.json`, `/themes/*`, `/icons/*`: the cache, else the network
    (don't store at runtime).
  - Everything else, notably `/api/*`, `/events`, `/healthz`, `/sw.js`: do **not** call
    `respondWith`.
- **message** `{ type: "skip-waiting" }` → `self.skipWaiting()`.
- **The kill worker** (served when `sw` is off): install calls `skipWaiting()`. Activate
  deletes every `znotes-` cache, calls `self.registration.unregister()`, then calls
  `client.navigate(client.url)` for every window client. It never touches IndexedDB, and
  `Clear-Site-Data` is never sent: either would wipe the outbox.
- **The update prompt** (`app/boot.js`): when a new worker reaches `installed` while a
  controller exists, show a sticky toast "A new version is ready" with a Reload action.
  Reload first awaits `flushBuffer()`, so a dirty buffer is saved or at least enqueued (§6).
  It then posts `skip-waiting` to `registration.waiting`. On `controllerchange` it calls
  `location.reload()`. The prompt never fires on its own, so an open page keeps loading its
  own build's lazy chunks from its cache.
- Cached shell responses must keep the shell's `origin-agent-cluster` and
  `permissions-policy` headers, or WebMCP registration breaks. That they survive Cache
  Storage is **inferred, not verified**: `tests/offline-e2e.test.ts` asserts WebMCP tools
  register on a service-worker-served load.

### §5 Server API additions (amend spec 0002 in the same change)

1. **`GET /api/docs`**: every file node in `tree` and in each `vaults[].tree` gains `rev` as
   its **last** key. The value is the index row's `rev`; `FileRowMeta` already selects it, so
   add it in `DocStore.metaOf`. The body gains `epoch` (number) as its **last** key: the
   vault epoch, **read before** the trees are built, so a change during the build bumps past
   it. Route: `GET: async () => { const epoch = vaultEpoch; return json({ ...(await registry.treeBody()), epoch }); }`.
   The tree `rev` may lag disk (the reconcile pass is debounced). That is fine: it only
   decides which docs to re-read, and the read itself is disk-derived.
2. **`POST /api/replica`** (route pattern `"replica"`, POST only, else 405 as the table
   does). Body `{ "paths": string[] }` holds qualified doc paths, 1–500 of them. Anything else
   is `400 {"error":"bad-body"}`. The answer is `200 { "docs": [docBody…], "missing": [path…] }`.
   Each path resolves with `registry.resolveDocPath`. Each doc is
   `stack.docs.docBody(canonicalDocPath(rel))`, the same disk-derived body as
   `GET /api/docs/{path}`, with `path` qualified for a secondary vault. An unresolvable,
   unknown-vault or absent path goes to `missing`, never an error. Bodies are read
   sequentially (one disk read at a time; this is a Pi). Same-origin guard as every write
   route (`crossSiteWrite` already covers POST).
3. **`PUT /api/docs/{path}` is idempotent on bytes.** In `DocStore.putDoc`, compare
   `markdown === current.markdown` **before** the rev check. Identical bytes answer `200`
   with the current `rev`, whatever `rev` the client sent: no write and no `doc-changed`, as
   today. A replay whose first reply was lost therefore succeeds. Document it in 0002's PUT
   section.
4. JSON responses are content-coded (§2). Add a line to 0002's "Asset caching and
   compression" section, which becomes "Caching and compression".

### §6 Replica, outbox, replay, offline behaviour

**`app/replica.js`** is a new **leaf**: add `"replica"` to `LEAVES` in
`scripts/lint-docs.ts`. It imports nothing and owns IndexedDB database `znotes`, version 1.

| Store | Key | Value |
|---|---|---|
| `docs` | qualified path | `{ path, markdown, rev, mtime, bytes, hasSecrets }` |
| `outbox` | qualified path | `{ path, markdown, baseRev, create: boolean, blocked: null \| "rev-conflict" \| "exists" \| "not-found", at }` |
| `meta` | string | `tree` (the last `GET /api/docs` body), `settings` (the last `GET /api/settings` body), `keyring:<vault id>` (`{ recipient, identity }`), `epoch`, `complete` (boolean) |

Export small async functions only: `getDoc`, `putDocs(docs)`, `deleteDocs(paths)`,
`allDocs()`, `getMeta(k)`, `setMeta(k, v)`, `enqueue(entry)`, `outboxEntries()`,
`outboxEntry(path)`, `dequeue(path, markdown)` (deletes only if the stored `markdown` still
equals it), `block(path, reason)`, `clearOutboxEntry(path)` and `persist()`. Every
**outbox** write uses `db.transaction("outbox", "readwrite", { durability: "strict" })` and
resolves on `complete`. A `QuotaExceededError` rejects with `code: "quota"`. When IndexedDB
is unavailable, or the page is not on the canonical origin (§7), every function is a no-op
returning empty or null, and the app behaves exactly as today.

**`app/api.js`** remains the only file that touches the network. It imports `replica.js`
(leaf→leaf) and adds:

- `export const offline = { now: false, onChange: null }`. `request()` sets `now = true` on a
  status-0 failure and `false` on any response, calling `onChange` on a flip. The status-0
  `ApiError` message becomes **"You're offline — this needs the server."** That is the
  message every online-only action shows offline, through each caller's existing error path,
  with no per-feature code.
- **Write-through reads.** `getTree`, `getDoc`, `getSettings`, `getVaultRecipient` and
  `getVaultIdentity` store their successful answers in the replica (tree with `epoch`).
  - On a status-0 failure, each answers from the replica when it holds the value, else
    rethrows.
  - `getTree` offline returns the stored tree, with every outbox `create` entry not already
    in it inserted as a file node, so a doc created offline appears.
  - `getDoc` offline returns the replica doc.
- **Outbox overlay** in `getDoc`, online or not: if an outbox entry exists for the path,
  answer `{ ...doc, markdown: entry.markdown, rev: entry.baseRev, pending: true }`. For a
  `create` entry with no server doc, answer a synthetic doc with `rev: null`.
  `editor.js`'s `ensureLoaded` treats `pending` as a dirty buffer: baseline = the server or
  replica markdown, buffer = the outbox bytes. The ordinary autosave then sends it, and the
  ordinary 409/404 paths take over.
- **`putDoc(path, markdown, rev, opts)`**:
  - `await replica.enqueue({ path, markdown, baseRev: rev, create: false })` **before** the
    request (write-ahead).
  - On `200`, `dequeue(path, markdown)`, store the doc in `docs` with the new rev, and return
    as today.
  - On status 0, return `{ path, rev, queued: true }`.
  - On `409`/`404`, rethrow as today; the entry stays.
  - A quota failure on the enqueue throws `ApiError(0, { error: "quota", message: "Not saved — this device is out of storage." })`
    without sending.
  - The `keepalive` pagehide flush keeps its byte-budget rule. Its enqueue may not complete
    while the page unloads; the autosave cadence bounds that loss, as online today.
- **`createEntry({ path, type, markdown })`** for `type: "doc"`: enqueue
  `{ create: true, baseRev: null }` first, then POST. On `201`, dequeue and store. On status
  0, return the shape the callers read (`{ path, type: "doc", rev: null, queued: true }`;
  check `tree.js` `mintEntry`/`createFromLink` and `dialogs.js` for exactly which fields they
  use). Folder creation offline fails with the offline message.
- **`search(q, opts)`** on status 0 runs the local search (below) and answers the same shape
  plus `offline: true`.
- **`refreshReplica()`**, called by the shell when online after boot, on `hello`, and after a
  replay:
  1. Diff the stored tree's `rev`s against `docs`.
  2. Fetch changed and absent docs with `POST /api/replica` in batches of at most 200 paths
     or about 4 MiB by the tree's `bytes`.
  3. `deleteDocs` for paths no longer in any tree, unless the outbox holds them.
  4. Set `epoch` and `complete = true`, then call `persist()` (`navigator.storage.persist()`)
     once.
  Run it in `requestIdleCallback` slices, never on the boot critical path. When `hello.epoch`
  equals the stored `epoch` and `complete` is true, it does nothing.
- **`replayOutbox()`**: for each **non-blocked** entry, sequentially, one at a time:
  - If its doc is loaded in `state.docs`, **skip it**: the editor's own autosave owns that
    buffer (see below).
  - Else `create` → POST `/api/docs`; edit → PUT with `baseRev`.
  - `200`/`201` → dequeue and store.
  - `409 rev-conflict` → `block(path, "rev-conflict")`; `409 exists` → `"exists"`;
    `404` → `"not-found"`.
  - Status 0 → stop.
  Return `{ sent, blocked: [paths] }`.

**Wiring in the shell** (`app/shell.js`, `app/editor.js`, `app/app.js`; leaves stay leaves):

- **Replay triggers**: `onHello`, `healAfterGap()`, and the window `online` event each run
  `flushBuffer()`, then `replayOutbox()`, then `refreshReplica()`. Run `resyncAfterGap()`
  last, as today; it compares revs and must now also treat `pending` docs as dirty.
- **The open buffer**: a doc in `state.docs` with an outbox entry is a dirty buffer, and
  `saveDoc` is its only writer. `doSaveDoc` needs these changes:
  - `r.queued` → `setBaseline` is **not** called and the doc stays dirty. The pip reads
    **"Saved on this device"** (a new `saveState` text, styled distinctly from "Saved").
    No toast.
  - `doc.rev` stays the base rev until a real `200`.
  - The "Saved to disk" toast keeps its meaning (server-acknowledged only).
  - On the existing `rev-conflict` branch nothing changes: `conflictDialog(path, disk, mine)`
    is the banner.
  - `quota` → toast the message; stay dirty.
- **Blocked entries** surface as one sticky toast: "<n> offline edit(s) need you". Its action
  opens the first blocked path; open each in turn. Opening one loads it as a `pending` dirty
  buffer, whose autosave meets the same 409/404 and so the existing `conflictDialog` /
  `orphanDialog`.
  - A blocked `create` (`exists`) opens `conflictDialog(path, serverMarkdown, entry.markdown)`
    directly.
- **Conflict actions** in `app/dialogs.js` (`conflictKeepMine`, `conflictTakeDisk`,
  `conflictDiscardOrphan`, `conflictRecreate`): every action that leaves the buffer clean or
  discards it calls `replica.clearOutboxEntry(path)` through `api.js`. A successful
  keep-mine PUT already dequeues.
- **Offline mode**: `api.offline.onChange` sets `state.offline` and repaints the connection
  dot with an "Offline" title. No feature is pre-emptively disabled. Each online-only action
  fails through its own existing error path with the offline message, and changes nothing
  locally. Check rename, move and delete in `tree.js` for any optimistic local mutation
  before the request; if one exists, it must revert on failure. Today's behaviour should
  already be server-first; verify.
- **Settings page offline**: reads from the replica; Save fails with the offline message and
  keeps the draft.

**Local search** (offline only; online search is unchanged and server-side):

- Create **`server/search-match.ts`**, a pure module with **no imports** (layer 0 in
  `LAYERS`). The frontend bundle imports it as `../server/search-match.ts`, so it must never
  use Bun or node APIs; say so in its header.
- **Move** into it, unchanged:
  - from `server/db.ts`: `fuzzy`, `fuzzyOn` (now exported), `parseSearch`, `SLASHED`,
    `FLAGS_OK`, `SearchMode` and `SearchQuery`;
  - from `server/vault.ts`: `redact`, `isAgeOpen`, `closesFence` and the fence regexes they
    need. `vault.ts` and `db.ts` import them back.
- **Extract** the per-document matching step out of `Index.search` (path hit plus the top 2
  line hits, both modes, trimmed lines, the same scoring) into an exported pure
  `matchDoc(path, trimmedLines, lowLines, sq)`. `Index.search` keeps its line cache, its
  whole-document reject, its deadline and its FTS path, and calls `matchDoc`.
- `tests/helpers.ts`'s `refFuzzy` re-export follows the move.
- `api.js` local search: over `replica.allDocs()`, call `redact` (never armor), trim, call
  `matchDoc`, sort as `Index.search` does (score desc, then path, then line) and clamp to
  `limit`. An empty `q` lists docs path-ordered.

**Secrets offline**: `initSecrets` already reads recipient and identity through `api.js`, so
write-through covers it. The identity is the **passphrase-wrapped** keyring, the same bytes
committed to the vault's git repo; storing it on the device adds no exposure. Plaintext and
passphrases stay out of the replica, out of the outbox and out of every request, as today.
The outbox holds only `doc.markdown`, which holds armor only (`doSaveDoc`'s leak gate runs
before `putDoc`).

### §7 Canonical origin, deploy, Dockerfile, Bun

- **`ZNOTES_ORIGIN`** (env, e.g. `https://znotes.tailb95e62.ts.net`; unset = any origin is
  canonical). The shell carries it in `meta[name=znotes-origin]`. On any other origin,
  `boot.js` registers no service worker and `replica.js` is inert. The page shows a
  one-time-per-session sticky toast: "z-notes lives at <origin> — open it there to use it
  offline." with a link. Online behaviour is otherwise identical.
- **Manifests** (edit only; applying them is a running-service change that needs the user's
  explicit go-ahead):
  - Rename `deploy/k3s/alt-tailscale-ingress.yaml` → `deploy/k3s/60-tailscale-ingress.yaml`
    (unchanged body: `ingressClassName: tailscale`, `tls.hosts: [znotes]`, default backend
    `znotes:http`) and add it to `kustomization.yaml` `resources`.
  - In `50-ingress.yaml`, the `znotes-http` router's middleware becomes a `redirectRegex`
    from `^http://znotes\.k3s\.lan/(.*)` to `https://znotes.tailb95e62.ts.net/${1}`
    (permanent), replacing `redirect-https`. The HTTPS `znotes.k3s.lan` router stays as the
    break-glass.
  - `20-deployment.yaml` sets `ZNOTES_ORIGIN=https://znotes.tailb95e62.ts.net` and
    `ZNOTES_DIST=/app/dist`.
  - `deploy/README.md` documents the new canonical address and its prerequisites: the
    Tailscale app connected on each device; on Android, Private DNS must not be a strict
    hostname. It also documents the break-glass and the kill switch (`ZNOTES_SW=off`, then
    redeploy).
- **Dockerfile** (`deploy/Dockerfile`):
  - All `FROM oven/bun:1.4.0-slim` become `1.4.4-slim`.
  - The `src` stage copies `scripts/` too and runs `bun scripts/build.ts` (→ `/src/dist`)
    **before** the existing module-graph check deletes `node_modules`.
  - The runtime stage copies `server/`, `dist/` and `package.json` and **no `node_modules`
    and no `app/`**. The server imports nothing from npm at runtime; verify with the graph
    check, and `tests/secrets.test.ts`'s scan still holds.
  - Set `ENV ZNOTES_DIST=/app/dist`.
  - Measure and report the image size before and after.
- Local development keeps whatever Bun the developer has (≥ 1.4.0). Bundler output may
  differ between 1.4.0 and 1.4.4; the image is the release build.

### §8 Docs and decisions (same change; `bun run lint:docs` enforces shape)

- **New ADR 0040, "The frontend is built"**: one build-time `Bun.build` into a hashed `dist/`,
  loaded at boot; the in-memory twin for dev and tests. It **supersedes** the "no frontend
  build step" decisions in ADR 0007 (context), ADR 0010 (the "generator, not a build step"
  framing) and ADR 0037 (bundled at boot, served from `/vendor`). It **amends** ADR 0038:
  hashed assets live under `/assets/`, the shell is spliced at a marker, the aliases and the
  503 are gone, and per-file `app/*.js` serving is gone. Add an "Amended by 0040" or
  "Superseded by 0040" line to each.
- **New ADR 0041, "The app works offline"**: the service worker (release precache,
  prompt-only update, kill switch), the replica, the write-ahead outbox, replay into the
  existing conflict banner, PUT idempotent on bytes, and the offline scope. It amends
  ADR 0012 (the save pip's third state, "Saved on this device").
- **New ADR 0042, "One canonical origin"**: the ts.net Ingress, `ZNOTES_ORIGIN`, the
  break-glass, and why (service-worker registration, install and the HTTP cache all require a
  trusted certificate; per-origin storage).
- **`docs/specs/done/0002-http-api-v0.md`**:
  - the Base convention;
  - `GET /api/docs` `rev` and `epoch`;
  - `POST /api/replica`;
  - PUT idempotency;
  - the asset section rewritten for `/assets/*`, `/sw.js` and the static files;
  - `/vendor/age.js` deleted;
  - JSON compression.
- **`AGENTS.md`** (≤ 100 lines):
  - the `app/` bullet: "bundled by `scripts/build.ts` into `dist/`; the server loads it, or
    builds in memory without `ZNOTES_DIST`";
  - the "Runtime deps" rule (no longer "bundled by the server at boot");
  - `bun run build` in Commands;
  - the gate count if `offline-e2e` joins the gates.
- **`docs/architecture.md`**: module map (`frontend`, `search-match`, `boot`, `replica`,
  `sw`, `mermaid-lazy`), where state lives (replica, outbox), and the boot sequence.
- **`docs/style.md`**:
  - the sharp edge that `server/search-match.ts` is bundled into the browser;
  - the shell marker;
  - `new Worker` URLs come from `#znotes-assets`.
- **`CONTEXT.md`**: the vocabulary above.

## Testing Decisions

Seams already in the repository, highest first: the real server over HTTP (`tests/helpers.ts`
`startServer`) and the real app in Chromium (`tests/browser.ts`). No new seam. A good test
here asserts what a user or client observes (bytes on disk, response headers, what the page
shows) and never internals.

**Harness changes (`tests/helpers.ts`, `tests/browser.ts`)**

- `startServer` gains `port?: number`, so an offline test can stop the server and start it
  again on the same origin and vault (`keepVault: true`, `vault`). It defaults `ZNOTES_SW` to
  `off` unless `opts.env` sets it: the existing suites keep their network behaviour.
- `forgetBrowserState` also runs `indexedDB.deleteDatabase("znotes")` on each new document,
  so the existing suites boot without a replica, as today. Offline suites pass `resume: true`
  (prior art: the `resume` option exists for exactly this).

**`tests/assets.test.ts`** replaces `tests/editor-assets.test.ts` (imitate it):

- The shell names the boot entry, the island pair and one `modulepreload` per boot-closure
  chunk.
- `#znotes-assets` names URLs that answer 200.
- Hashed assets carry the month-long `immutable` policy, and an unknown hash is a 404.
- Codings are negotiated with per-coding ETags and 304s (keep today's cases).
- Static files revalidate with content-hash ETags.
- `/sw.js` is `no-cache` JavaScript whose body contains the shell's build id; with
  `ZNOTES_SW=off` it is the kill worker.
- `/app.js`, `/vendor/editor.js` and `/vendor/age.js` are 404.
- Changing a dependency's bytes changes asset URLs and the shell ETag (keep the
  throwaway-root pattern).
- A broken in-memory build keeps `/api` and `/healthz` serving and puts the error in the
  shell.
- **dist mode**: run `scripts/build.ts` into a temp dir, start with `ZNOTES_DIST`, and assert
  the same URLs are served with the precompressed brotli bytes (decompress and compare to
  identity).
- The crypto worker's chunk graph contains `age-encryption.org/v1`; this replaces the
  `/vendor/age.js` case in `tests/secrets.test.ts`.

**`tests/replica-api.test.ts`** (new; imitate `tests/multivault.test.ts` for secondary-vault
cases):

- `GET /api/docs` file nodes carry `rev` equal to the doc's GET rev, last key.
- `epoch` is present and increases after a PUT.
- `POST /api/replica` returns disk-derived bodies for primary and `@id/` paths and puts
  unknown ones in `missing`; 0 or 501 paths → 400; GET → 405.
- PUT with a stale rev and **identical** bytes → 200 with the current rev and no
  `doc-changed` (use `srv.sse()`); stale rev with **different** bytes → 409 as before.
- `/api/docs` with `accept-encoding: br` is brotli-coded and decodes to the identity JSON;
  `/events` is never coded.

**`tests/offline-e2e.test.ts`** (new; imitate `tests/editor-refresh-e2e.test.ts` and
`tests/sse-watchdog-e2e.test.ts`; added to `bun run gates`, because it guards against data
loss). The server runs with `ZNOTES_SW=on`; "offline" means **the server is stopped**, which
is a real connection refusal.

1. Load online, and wait for the replica to be complete (expose nothing new: poll
   IndexedDB `meta.complete` via `page.evaluate`). Stop the server and reload: the tree
   renders, a deep link `/d/<path>` opens its doc, Edit is editable, and WebMCP tools are
   registered.
2. Offline: edit, see "Saved on this device", close the page, open a new page offline (same
   browser), and the edit is there. Restart the server on the same port: the file on disk
   equals the edited bytes **exactly**, and the pip reads "Saved".
3. Offline edit, then the file is changed on disk while the server is down, then restart:
   the conflict dialog shows both texts, and neither is lost.
4. Offline create `new.md`; it shows in the tree; restart; it exists on disk with its bytes.
5. Lost reply: intercept the PUT's **response** (CDP `Fetch.requestPaused` at the Response
   stage, then fail it). The server has written; the retry ends in 200, with no conflict
   dialog.
6. Offline rename/delete/AI send each show the offline message and change nothing on disk
   after the restart.
7. Offline search finds a doc by a body line and never matches inside a secret's armor.
8. Update prompt: change the build (restart with a touched app file in the in-memory mode, or
   a second `ZNOTES_DIST`). The page shows "A new version is ready" and does not reload until
   Reload is clicked. With a dirty buffer, the text reaches disk before the reload.
9. Kill switch: restart with `ZNOTES_SW=off`; after one navigation, no registration remains,
   and the outbox store is intact.
10. Non-canonical origin: `ZNOTES_ORIGIN` set to another origin → no registration, no
    `znotes` database, and the notice is shown.

**Boot critical path** (in `tests/offline-e2e.test.ts` or `tests/lifecycle-e2e.test.ts`):
delay `/api/ai/sessions/current`, `/api/ai/proposals` and `/api/sync/status` by 10 s with
request interception. The doc is editable well before the delay ends, and each chip paints
once its answer arrives.

Unchanged suites must stay green: `bun run gates` (including gate 6, mermaid hardening), the
full `bun test`, and `bun run lint:docs`. The prototype changed six tests' behaviour (P6:
`block-editor-e2e` "CSS-only editor load failure…" and "a failed editor bundle says so…";
P3: `secrets-ui` "? overlay … Menu key", cause unknown, and `editor-assets` "a failed build
preserves the shell…"). Investigate each and fix the cause, not the test, except where this
spec changes the documented behaviour (the 503 is gone).

**Measurement (required, reported in the PR/commit message, not asserted in the suite)**: copy
the prototype's `perf/measure.ts` from the worktree into `.scratch/` (gitignored) and run
baseline vs. this change at CPU 4×, LAN and Fast 3G. Report cold, warm and relaunch
time-to-editable and offline relaunch time. Targets, from the prototype: relaunch editable
≤ 0.5 s LAN and ≤ 1.5 s Fast 3G, offline relaunch editable ≤ 1 s. Also report the image
size and Pi-free boot time (`/healthz` ready) before and after, plus the `dist/` brotli
total.

## Out of Scope

- Offline rename, move, delete, folder create, trash, settings writes, AI, the terminal, git
  sync, vault add/disconnect. They fail with the offline message.
- Auto-merging concurrent edits; any CRDT; a server change log, `Last-Event-ID` backlog,
  per-doc ETags or idempotency keys (epoch + revs + byte-idempotent PUT suffice).
- Background Sync and Periodic Background Sync (Chromium-only; replay runs from the page).
- Push notifications, share targets, file/protocol handlers, badging.
- Capacitor, Tauri or any native shell; Safari Add to Dock work beyond "it loads"; Safari or
  WebKit-specific fixes.
- Changing the editor framework (React, Mantine, BlockNote versions), BlockNote 0.55+/0.56
  upgrades, Preact, and BlockNote's own mobile toolbar.
- Bun fullstack HTML imports (`routes` with HTML): measured unfit (no compression, an unsplit
  5.5 MB entry at runtime, theme switching breaks, cwd-relative assets).
- `bun build --compile`, HTTP/2 or HTTP/3 in `Bun.serve`, zstd.
- Keeping the previous build's assets for skewed clients; a service-worker runtime cache of
  API responses (the replica replaces it).
- The 200 KB-doc mount cost (a 1.4–1.6 s long task at 4× CPU): a separate problem.
- A public domain, DNS-01, Tailscale Funnel, or installing the K3s CA on devices.
- Upgrading the Tailscale operator (1.98.9) or applying any manifest: that is the user's
  separate authorization.
- Committing the prototype worktree; it is evidence, not code to merge.

## Further Notes

- **Prerequisites already verified on 2026-10-27**: the tailnet has HTTPS certificates and
  MagicDNS on. The operator v1.98.9 runs with ProxyClass `no-pi3b` as default. The ACL has
  `tag:k8s` owned by `tag:k8s-operator`. The phone (`oppo-find-n5`) and the Mac are tailnet
  members. The LAN path to the proxy goes direct (about 4 ms) after a brief DERP hop through
  Sydney (56–100 ms).
- **Prototype sources** (worktree `.claude/worktrees/wf_71305947-a22-2`):
  - `app/mermaid-lazy.ts`;
  - the lazy-mermaid plugin in `server/index.ts` `buildEditor`;
  - `warmEditor` and the `ensureLoaded` de-dup in `app/editor.js`;
  - the parallel boot in `app/app.js`;
  - `app/sw.js` (P6; a starting point only, it predates §4's rules);
  - `perf/` with every measurement.
- **Unverified, verify while implementing**:
  - that cached shell headers survive Cache Storage (§4);
  - SSE and brotli passthrough through the Tailscale proxy;
  - whether the Oppo has Google Play services (WebAPK minting needs them; a plain
    installed-PWA shortcut works without);
  - how Bun 1.4.4's metafile shape exposes static-import closure;
  - why the P3 prototype failed `secrets-ui`'s Menu-key test.
- **Risk: Safari tabs** lose IndexedDB after 7 days without a visit (ITP); the Dock app has
  separate storage. Chrome is the primary install surface; persist() is requested once.
- **Risk: the Tailscale app must be connected** for the canonical name to resolve (single VPN
  slot on Android). An installed app still opens offline from its cache, and
  `znotes.k3s.lan` remains reachable on the LAN.
- **Order matters for the origin.** Ship and switch to the canonical origin **before** any
  device holds an outbox. Today the old origin holds only view preferences in localStorage, so
  moving costs nothing; later it would strand unsent edits on the old origin.
- Research record: the two research rounds (a 20-agent workflow with adversarial verification
  and an independent GPT-6.1-Sol report) are summarised in this spec; the raw reports are not
  in the repo.
