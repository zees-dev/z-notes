---
label: wayfinder:research
ticket: 08-research-bun-capabilities
title: Bun-native capabilities for the single-file backend
created: 2026-07-31
---

# Bun-native capabilities for the z-notes backend

**Bottom line:** Bun 1.3.14 covers essentially the whole backend surface z-notes needs — routing, static
serving, SSE, WebSocket, FTS5 search, git shell-out, frontend bundling, and a single-file executable —
with **no runtime dependencies**. There is exactly one capability that does *not* work the way you would
naively assume, and it happens to sit on the app's core requirement ("files also edited outside the app"):
**`fs.watch` on macOS reports neither reliable event types nor reliable filenames.** The architecture below
treats the watcher as a dumb "something moved" doorbell and re-derives truth from disk. Everything else is
a straightforward yes.

## Verification method

Every claim marked **[verified]** was executed locally on the target machine, not recalled from docs.

| | |
|---|---|
| Bun | `1.3.14` (revision `0d9b296a`) — the current stable, released 2026-05-13 |
| Platform | macOS 26.5.2, Darwin 25.5.0, arm64 (M-series) |
| SQLite seen by `bun:sqlite` | **3.51.0** (Apple system SQLite — see the caveat below) |

Bun 1.3.14 is the latest stable release as of 2026-07-31, so no upgrade is pending
([releases](https://github.com/oven-sh/bun/releases), [1.3.14 notes](https://bun.com/blog/bun-v1.3.14)).

---

## 1. `Bun.serve` — routing, static, SSE, WebSocket

All of the following ran in a single process against one `Bun.serve` call. **[verified]**

### Routing

The `routes` object is declarative and handles every shape z-notes needs
([docs](https://bun.com/docs/api/http)):

```ts
Bun.serve({
  routes: {
    "/api/notes/:id": {                            // per-method + typed params
      GET:  (req) => Response.json({ id: req.params.id }),
      PUT:  async (req) => Response.json({ saved: req.params.id, body: await req.text() }),
    },
    "/api/health": new Response("ok"),             // static Response — zero per-request work
    "/favicon.ico": Bun.file("./favicon.ico"),     // static file route
    "/blog/old": Response.redirect("/blog/new"),
    "/*": () => new Response("not found", { status: 404 }),  // catch-all
  },
});
```

Verified working: path params, per-method dispatch, precomputed static `Response`, wildcard fallback,
404 routing. `server.reload({ routes })` swaps handlers **in place on a live server** — verified by
changing `/api/health` from `ok` to `reloaded` without dropping the listener. **[verified]**

Useful server-object surface: `server.url`, `server.port`, `server.pendingRequests`,
`server.pendingWebSockets`, `server.subscriberCount(topic)`, `server.requestIP(req)`,
`server.timeout(req, seconds)`, `server.stop(force?)`, `server.ref()/unref()`.

### Static file serving

`new Response(Bun.file(path))` is the primitive. **[verified]** results:

- Content-Type is inferred correctly — a `.md` file served as `text/markdown`.
- `Content-Length` set correctly.
- **`Range` requests work automatically** → `Range: bytes=0-9` returned `206` with exactly 10 bytes.
- ⚠️ **No `ETag`, no `Last-Modified`, no `Accept-Ranges` header is emitted.** Conditional-GET/304
  caching is *not* free; you must add `ETag` (e.g. `Bun.hash` of contents, or `mtimeMs`-`size`) and
  handle `If-None-Match` yourself if you want browser caching of vault assets.

### SSE — works, but one sharp edge that will bite

SSE is just a `ReadableStream` response. **[verified]** — including that the stream's `cancel()` callback
fires on client disconnect, which is how you reap dead subscribers:

```ts
"/events": () => new Response(
  new ReadableStream({
    start(c) { subs.add(c); c.enqueue("retry: 1000\n\n"); },
    cancel()  { subs.delete(c); },        // fires on disconnect — verified
  }),
  { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
);
```

> ### ⚠️ Sharp edge: the default `idleTimeout` silently kills SSE streams
>
> `Bun.serve`'s `idleTimeout` defaults to **10 seconds** and applies to streaming responses. A silent SSE
> stream is torn down mid-flight. **[verified]** — with defaults the server logged
> `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.` and the client's
> socket died at ~12 s. With `idleTimeout: 0` the same stream was still open after 12 s.
>
> **Fix:** set `idleTimeout: 0` on the server **and** send a `: ping\n\n` comment heartbeat every ~15–30 s
> anyway (proxies and laptop sleep/wake will still cut idle connections; the heartbeat plus the client's
> native `EventSource` auto-reconnect is what actually makes it durable).

### WebSocket

Full support including native pub/sub. **[verified]**: `server.upgrade(req, { data })` from inside a
route, typed `ws.data`, `open`/`message`/`close` handlers, `ws.subscribe(topic)`,
`server.publish(topic, msg)`, `server.subscriberCount(topic)`.

**SSE vs WebSocket for z-notes:** vault→client change notification is strictly one-way, low-frequency, and
benefits enormously from `EventSource`'s built-in reconnect-with-backoff. **Use SSE.** Keep WebSocket in
reserve for a later bidirectional need (collaborative cursors, AI token streaming — though AI streaming is
also fine over SSE/`fetch` streaming). This also keeps future mobile/desktop clients trivial: SSE is a
plain HTTP GET.

---

## 2. `bun:sqlite` — FTS5, WAL, prepared statements

### FTS5 is available and complete **[verified]**

Enumerated `pragma_compile_options()` directly. Present: `ENABLE_FTS5`, `ENABLE_FTS4`, `ENABLE_FTS3`,
`ENABLE_RTREE`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_SNAPSHOT`,
`ENABLE_NORMALIZE`, `ENABLE_DBSTAT_VTAB`.

Individually exercised and working: FTS5 virtual tables, `MATCH` queries, `bm25()` ranking,
`snippet()` highlighting, **`unicode61`** tokenizer with `remove_diacritics 2`, **`porter`** stemming,
**`trigram`** tokenizer (substring/code-identifier search), **external-content tables**
(`content='src', content_rowid='id'`), and `fts5vocab`.

```
FTS5: OK [ { path: "a.md", s: "hello encrypted [secret] world", r: -0.000001 }, ... ]
trigram: OK    porter: OK    external-content: OK    fts5vocab: OK    json1: OK
```

That covers the search ticket's needs completely: `unicode61` for prose, `trigram` as a secondary index if
you want substring matching over code blocks and secret-block *labels*.

> ### ⚠️ Sharp edge: on macOS, `bun:sqlite` binds Apple's system SQLite
>
> Bun links the **system** `libsqlite3` on macOS and statically links its own build on Linux/Windows
> ([docs](https://bun.com/docs/api/sqlite)). Concrete proof: the Bun 1.3.14 release notes say
> *"Updated SQLite to 3.53.0"*, but this machine reports **3.51.0** — because it is Apple's copy, not
> Bun's. Compile options confirm it (`CODEC=see-cccrypt`, `CCCRYPT256`, `BUG_COMPATIBLE_20160819`).
>
> Three consequences:
> 1. **Extensions cannot be loaded.** `OMIT_LOAD_EXTENSION` is set; `db.loadExtension()` throws
>    `This build of sqlite3 does not support dynamic extension loading` **[verified]**. So no
>    `sqlite-vec`/`sqlite-vss` for AI embedding search without first
>    `Database.setCustomSQLite("/opt/homebrew/.../libsqlite3.dylib")` **before** opening any DB.
>    **Design implication: do not put vector search on the critical path.** If semantic search is wanted
>    later, store embeddings as `BLOB` and brute-force cosine in JS (fine for a single user's notes), or
>    accept the Homebrew SQLite dependency.
> 2. **SQLite version varies by platform**, so avoid depending on very new SQLite syntax if the backend
>    might ever run on Linux. 3.51 is modern enough for everything here.
> 3. macOS system SQLite has **persistent WAL** on by default — the `-wal`/`-shm` sidecars survive close.
>    Since the DB is a rebuildable index (see below) this is harmless, but if you want a clean single file:
>    `db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0)` then `PRAGMA wal_checkpoint(TRUNCATE)`.

### WAL and pragmas **[verified]**

```ts
db.query("PRAGMA journal_mode = WAL").get();   // -> { journal_mode: "wal" }
db.run("PRAGMA synchronous = NORMAL");         // -> confirmed synchronous = 1
db.run("PRAGMA busy_timeout = 5000");
```

WAL gives real concurrency: a second **read-only** connection opened while the writer held the DB read
the committed rows correctly **[verified]**. That matters because the indexer writes while HTTP handlers
read.

⚠️ Minor gotcha: multi-statement pragma strings via `.get()` don't return what you expect
(`PRAGMA foreign_keys=ON; PRAGMA foreign_keys` returned `null`). Issue pragmas **one per call**.

### Prepared statements **[verified]**

- `db.query(sql)` — **caches** the compiled statement by SQL string. `db.prepare(sql)` — uncached.
  Use `query()` for hot paths, `prepare()` when you hold a long-lived handle.
- `.get()` / `.all()` / `.run()` / `.values()` / `.iterate()` (lazy generator, verified) / `.finalize()`.
- `.as(Class)` maps rows onto a class **without invoking the constructor** — getters work. Verified: a
  `Note` class with a `get slug()` derived from `path` returned correctly.
- `strict: true` drops the `$`/`:`/`@` sigil requirement on bound params and throws on missing params —
  worth enabling.
- `INSERT ... ON CONFLICT DO UPDATE ... RETURNING id` works via `.get()` **[verified]** — exactly the
  upsert shape the file indexer needs.
- `db.transaction(fn)` with `.deferred()` / `.immediate()` / `.exclusive()` variants; nested calls become
  savepoints. Verified a batch upsert inside one transaction.
- `db.serialize()` → `Uint8Array` and `Database.deserialize()` for snapshots.
- `safeIntegers: true` returns `bigint` if you ever need 64-bit ids.

**Recommendation: treat the SQLite file as a disposable cache, not a source of truth.** Markdown files on
disk are the source of truth (that is the whole point of the round-trip contract and git sync). Store a
`schema_version` row and rebuild the index from scratch on mismatch. Never commit the `.db` to git; add
`*.db*` to `.gitignore`.

---

## 3. File watching — **the one genuinely hard part**

This is where the naive implementation is wrong. Findings below are all **[verified]** on macOS 26.5.

### What works

- `fs.watch(dir, { recursive: true })` **works**, and **does pick up directories created after the watch
  started**, plus files inside them. Verified: created `vault/newdir/` then `vault/newdir/c.md` after the
  watcher was live — both fired.
- Bun 1.3.14 uses **FSEvents exclusively** on macOS (previously a dual kqueue+FSEvents design), halving
  watcher threads ([1.3.14 notes](https://bun.com/blog/bun-v1.3.14)).
- Deeply nested paths are reported relative to the watch root (`sub/deep/b.md`).

### ⚠️ Failure 1: `eventType` is **always** `"rename"` — it carries zero information

Across every operation type — create, in-place modify, **append**, truncating rewrite, rename, delete —
the callback's first argument was `"rename"`. Never once `"change"`.

```
create x.md         -> rename x.md
modify x.md         -> rename x.md
append to log.md    -> rename log.md      <- pure content change, inode unchanged
rewrite via writer  -> rename log.md
rename x.md->y.md   -> rename x.md
delete y.md         -> rename y.md

distinct eventTypes observed: [ "rename" ]
```

This is a known and long-standing platform/implementation reality: Node has the same complaint on macOS
([nodejs/node#7420](https://github.com/nodejs/node/issues/7420)), and Bun specifically reports `"rename"`
where Node reports `"change"` ([oven-sh/bun#23992](https://github.com/oven-sh/bun/issues/23992)).

**Consequence: never branch on `eventType`.**

### ⚠️ Failure 2: the *destination* of an intra-vault rename is never reported

This is the dangerous one, because **it is exactly what an atomic save looks like**, and atomic save is
what vim (`backupcopy=no`), VS Code, and most editors do by default.

Controlled experiment, 1.5 s between every step so nothing could be blamed on coalescing:

| Operation | Event fired | Correct? |
|---|---|---|
| write `out/fresh1.md` (outside vault) → rename into `v3/fresh1.md` | `rename fresh1.md` | ✅ dest reported |
| create `v3/copied.md` directly | `rename copied.md` | ✅ |
| rename `v3/copied.md` → `v3/neverseen.md` | `rename copied.md` | ❌ **`neverseen.md` never reported** |
| write `v3/.x.tmp` → rename onto `v3/x.md` | `rename .x.tmp` | ❌ **`x.md` never reported** |

So when an editor saves atomically using a temp file *inside* the vault, **the only event you receive
names a temp file that no longer exists, and the file that actually changed is never mentioned.** A
watcher that trusts the reported filename would silently serve stale content for the user's real notes —
the precise failure the app exists to avoid. (Note the first row: when the temp file lives *outside* the
watched tree the destination *is* reported. You cannot rely on which pattern a given editor uses.)

### ⚠️ Failure 3: events are coalesced

In a rapid-fire sequence, 9 filesystem operations produced 8 events, with the rename pair collapsed.
Assume **event count ≠ operation count** and that events may be dropped under load.

### The mitigation (validated end-to-end)

Treat `fs.watch` purely as **"something in the vault moved — go look."** Ignore `eventType`, ignore
`filename`, debounce, then reconcile against disk using `Bun.Glob` + `stat` + a content hash.

Building blocks, all **[verified]**:

- `new Bun.Glob("**/*.md").scan({ cwd, onlyFiles: true, dot: false })` → async iterator of relative paths.
- `await Bun.file(p).stat()` → `{ size, mtimeMs (sub-ms precision), mtime }`; also `file.lastModified`.
- `Bun.hash(text)` — fast non-cryptographic hash, ideal for "did content actually change".
- `new Bun.CryptoHasher("sha256")` if you want a stable content-address.

I built the full pipeline and ran it. **[verified]** — note step 2, the atomic-save case that defeats
filename-based watching, is handled correctly, and step 3 shows no-op suppression:

```
1) external create             -> [reconcile:fsevent] +["proj/design.md"] ~[] -[]
                                  [client SSE] event: vault | data: {"added":["proj/design.md"],...}
2) ATOMIC save (tmp + rename)  -> [reconcile:fsevent] +[] ~["proj/design.md"] -[]     <- correct file
                                  [client SSE] event: vault | data: {"changed":["proj/design.md"],...}
3) rewrite w/ IDENTICAL bytes  -> [reconcile:fsevent] no-op (suppressed)              <- no SSE sent
4) delete                      -> [reconcile:fsevent] +[] ~[] -["proj/design.md"]
6) FTS5 search "sqlite"        -> [{ path: "keep.md", s: "searchable bun «sqlite» content" }]
```

Debounce of **120 ms** was sufficient and imperceptible. Content-hash comparison suppressed the
identical-bytes rewrite, which matters a lot: **it stops the app's own writes from echoing back** as
external-change events and fighting the open editor.

**Scale note:** reconciling re-reads every `.md` file. For a personal vault (hundreds to low thousands of
notes) this is milliseconds. If it ever gets slow, gate the `read`+`hash` behind a cheap
`(size, mtimeMs)` comparison from the `files` table and only hash when those differ. Also note macOS has
an internal limit near **4096 watched paths**; a single recursive FSEvents watch on the vault root stays
well clear of it — do **not** create one watcher per directory.

---

## 4. `Bun.$` shell and `Bun.spawn` for git

### Quoting is safe by default **[verified]**

Interpolated values are escaped as single literal arguments — command injection through note filenames is
not possible:

```ts
const nasty = `weird; rm -rf /tmp/pwn && echo "pwned" $(whoami) 'quoted' \\backslash`;
await $`echo ${nasty}`;   // -> emitted verbatim; nothing executed, no substitution
```

A realistic vault filename round-tripped intact: `my notes/2026-07 "q" & stuff.md`.
`$.escape(str)` exposes the escaper; `${{ raw: "..." }}` is the deliberate opt-out
([docs](https://bun.com/docs/runtime/shell)). Arrays interpolate as space-separated escaped args.

### Exit codes and stderr **[verified]**

```ts
const r = await $`git rev-parse --abbrev-ref HEAD`.cwd(repo).nothrow().quiet();
r.exitCode   // 128
r.stdout.toString()  // "HEAD\n"
r.stderr.toString()  // "fatal: ambiguous argument 'HEAD': unknown revision..."
```

Non-zero exit **throws `ShellError`** by default (with `.exitCode`, `.stdout`, `.stderr`); `.nothrow()`
opts out. `.quiet()` suppresses passthrough. Also verified: `.cwd()`, `.env()`, `.text()`, `.lines()`,
`.json()`.

### ⚠️ Sharp edge: `Bun.$` builtins shadow real binaries

Bun Shell natively implements `cd, ls, rm, echo, pwd, cat, touch, mkdir, which, mv, exit, true, false,
yes, seq, dirname, basename, bun`. These take precedence over `/bin/*`. `mv` notably **lacks cross-device
support**. This is fine for `git` (never shadowed) but means shell one-liners can behave subtly unlike
`zsh`.

### Recommendation: use `Bun.spawn` for git, not `Bun.$`

Git sync involves a credential token, and `Bun.spawn` takes an **argv array with no shell parsing at
all** — strictly stronger than escaping. **[verified]**:

```ts
const p = Bun.spawn(["git", "pull", "--rebase", "origin", "main"], {
  cwd: vaultPath,
  stdout: "pipe", stderr: "pipe",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" },
  timeout: 30_000,
});
const [out, err, code] = await Promise.all([
  new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
]);
```

Verified behaviours: exact `exitCode` propagation (7), separate stdout/stderr capture, `env` overrides,
`stdin: "pipe"` with `p.stdin.write()` + `.end()` (for commit messages / credential helpers), and
`timeout` → process killed with `signalCode: "SIGTERM"`, `killed: true`.

**Credential handling:** verified that a secret placed in `env` is **not visible in argv**
(`argv= | env=tok_abc`). Pass the token via a `GIT_ASKPASS` helper or `credential.helper`, never inside
the remote URL — a URL-embedded token lands in `.git/config`, in `ps` output, and in error messages that
this app may well render into the UI. `GIT_TERMINAL_PROMPT=0` is essential or a credential prompt will
hang the server forever. Always set `timeout`.

---

## 5. `bun build` — frontend bundling, dev, single executable

### HTML entrypoints **[verified]**

```
bun build ./src/index.html --outdir=dist --minify --sourcemap=linked
  index-h61s0qpt.js      464 bytes  (entry point)
  index.html             238 bytes  (entry point)
  index-ex1qd9cq.css      79 bytes  (asset)
```

Bun crawls `<script>`/`<link>` from the HTML, transpiles TS, bundles CSS, content-hashes assets, and
**rewrites the tags in the emitted HTML**. No config file, no plugin ([docs](https://bun.com/docs/bundler/html)).

**Code splitting requires `--splitting`** — it is not implied. Without it a `import()` call is inlined
into the entry. With it **[verified]**: a shared chunk plus a lazily-loaded `heavy-*.js` chunk. Relevant
for lazily loading a heavy editor library or the AI panel.

### Zero-build dev — yes, genuinely **[verified]**

Importing an HTML file into a route makes the dev server bundle on demand:

```ts
import index from "./src/index.html";
Bun.serve({
  development: { hmr: true, console: true },
  routes: { "/": index, "/app/*": index, "/api/ping": new Response("pong") },
});
```

Verified: HTML served at 200 with `text/html`, assets served from `/_bun/asset/*` and `/_bun/client/*`,
the **HMR runtime injected** into the client bundle (49 KB, contains `import.meta.hot` wiring), SPA
fallback (`/app/deep/link` → 200 serving the shell), and API routes coexisting on the same server.
Log line: `Bundled page in 1ms`. So **dev needs no build step and no second process** — one command.

Set `development: false` in production; leaving HMR on ships a dev runtime.

### Backend hot reload **[verified]**

`bun --hot server.ts` re-evaluates the module in the **same process** and **preserves `globalThis`**:

```
[eval] ... [state] globalThis.counter = 1     resp1: VERSION_1
[eval] ... [state] globalThis.counter = 2     resp2: VERSION_2
[eval] ... [state] globalThis.counter = 3     resp3: VERSION_3
```

So the SQLite handle, the SSE subscriber set, and the watcher can be parked on `globalThis` and survive
edits. Combined with front-end HMR, `bun --hot server.ts` is the entire dev loop.

### Single-file executable **[verified]**

```
bun build --compile --minify --sourcemap ./server.ts --outfile znotes
  [2ms] minify   [0ms] bundle 8 modules   [71ms] compile
  -> 63 MB binary
```

I then **deleted the source tree**, copied the binary elsewhere, and ran it from an unrelated cwd:

```
[compiled] html: <!doctype html>...<link rel="stylesheet" href="/chunk-sdf619xb.css">...
[compiled] ping: pong
[compiled] embedded file: "logo-bytes-here\n"
[compiled] fts5 works: true
[compiled] Bun.embeddedFiles: [ chunk-*.js, chunk-*.css, index-*.html, logo-*.txt ]
[compiled] import.meta.dir: /$bunfs/root
```

So the compiled binary embeds the **bundled frontend** (HTML import survives `--compile`), arbitrary
assets via `import x from "./f.txt" with { type: "file" }`, and `bun:sqlite` with FTS5 intact.

Caveats ([docs](https://bun.com/docs/bundler/executables)): ~63 MB binaries; `import.meta.dir` is
`/$bunfs/root`, so **never use it to locate the user's vault or DB** — resolve those from an explicit
config path, `$HOME`, or `process.cwd()`; macOS Gatekeeper wants `codesign`; `--bytecode` gives ~2x faster
startup; `--target=bun-{os}-{arch}` cross-compiles.

**For a single-user local app, `--compile` is optional polish.** `bun run server.ts` against a `dist/`
folder is simpler to iterate on. Keep `--compile` as a v1.1 packaging step.

---

## Recommendation

### Backend shape

Not literally one file, but **one process, one entrypoint, and a handful of small modules**. A true
single file would fuse the markdown round-trip parser, the indexer, and git sync into something
untestable; the map's "backend ideally a single bun file" intent — no framework, no service mesh, one
`bun run` — is fully preserved.

```
server.ts          # entry: Bun.serve, route table, wiring, graceful shutdown
lib/vault.ts       # Bun.Glob scan, atomic read/write, path containment
lib/watcher.ts     # fs.watch -> debounce -> reconcile -> emit ChangeSet
lib/index.ts       # bun:sqlite schema, FTS5 upserts, search queries
lib/git.ts         # Bun.spawn wrappers: status/commit/pull --rebase/push
lib/ai.ts          # OpenAI-compatible proxy, streams through to client
src/index.html     # frontend entry (HTML import in dev, bun build in prod)
```

### Concrete parameters

| Parameter | Value | Why |
|---|---|---|
| `Bun.serve` `idleTimeout` | **`0`** | default 10 s kills SSE — **verified** |
| SSE heartbeat | `: ping\n\n` every **20 s** | survives proxies/sleep; client `EventSource` auto-reconnects |
| SSE `retry:` | `1000` ms | first bytes of the stream |
| Watch | `fs.watch(vault, { recursive: true })`, **one** watcher on the root | avoids the ~4096-path macOS limit |
| Watch debounce | **120 ms** trailing | verified sufficient, imperceptible |
| Watch event handling | **ignore `eventType` and `filename` entirely** | both are unreliable — verified |
| Reconcile | `Bun.Glob("**/*.md")` + `stat` + `Bun.hash(text)` vs stored hash | catches atomic saves; suppresses no-ops |
| SQLite | `strict: true`, `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` | one pragma per call |
| FTS5 | `fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')` + `bm25()` + `snippet()` | verified |
| DB status | **disposable cache**, gitignored (`*.db*`), rebuilt on `schema_version` mismatch | markdown is source of truth |
| Git | `Bun.spawn(argv)`, `GIT_TERMINAL_PROMPT=0`, token via `GIT_ASKPASS`/credential helper (never in URL or argv), `timeout: 30_000` | verified no argv leak |
| Dev | `bun --hot server.ts` with `import index from "./src/index.html"` + `development: { hmr: true }` | one command, no build step — verified |
| Prod | `bun build ./src/index.html --outdir=dist --minify --splitting --sourcemap=linked`; `development: false` | `--splitting` is **not** implicit |
| Static serving | `new Response(Bun.file(p))`; **add your own `ETag`/`If-None-Match`** | Bun emits none — verified |
| Packaging | defer `--compile` to v1.1 | works fully, but 63 MB and `/$bunfs/root` complicates vault paths |

### Endpoints vs static

```
GET  /                    -> HTML shell (import in dev, dist/index.html in prod)
GET  /assets/*            -> hashed bundle output, immutable cache
GET  /events              -> SSE: vault changes, git status, index progress
GET  /api/notes           -> tree/list from the SQLite index
GET  /api/notes/*         -> raw markdown bytes (round-trip contract: bytes in == bytes out)
PUT  /api/notes/*         -> atomic write (tmp + rename), then reconcile
GET  /api/search?q=       -> FTS5 bm25 + snippet
POST /api/git/{sync,commit} -> Bun.spawn git; progress over SSE
POST /api/ai/chat         -> streaming proxy to the OpenAI-compatible endpoint
```

### Watch → SSE pipeline (the validated design)

```
fs.watch(vault, {recursive:true})     // "something moved" doorbell; args discarded
      └─ debounce 120ms
           └─ reconcile(): Glob scan -> stat -> hash -> diff vs SQLite
                ├─ unchanged hash  -> drop (suppresses the app's own writes echoing back)
                └─ real delta      -> upsert files + FTS5, then
                     broadcast SSE `event: vault` {added,changed,removed}
                          └─ client refetches only the affected paths
```

Server writes go through the same reconcile path, so there is exactly one code path that mutates the
index, and self-inflicted events are suppressed by hash rather than by fragile echo-cancellation flags.

### Key risk

**File-watch fidelity is the only real risk, and it is a correctness risk, not a performance one.**
`fs.watch` on macOS gives an event type that is always `"rename"` and a filename that, for intra-vault
atomic saves, names a temp file that no longer exists while never naming the file that actually changed.
Any implementation that trusts those arguments will silently show stale content for externally-edited
notes. The debounce-and-reconcile design above is immune by construction — it re-derives state from disk
and never reads the event payload — at the cost of an O(vault) rescan per change burst, which is
milliseconds at personal-vault scale and is bounded further by gating hashing behind `(size, mtimeMs)`.
The secondary risk is the SSE `idleTimeout` default, which fails closed and silently; it is a one-line fix
(`idleTimeout: 0` plus a heartbeat) but will look like a mysterious "live updates stop after ten seconds"
bug if missed.

---

## Sources

- [Bun `Bun.serve` / HTTP docs](https://bun.com/docs/api/http)
- [Bun `bun:sqlite` docs](https://bun.com/docs/api/sqlite)
- [Bun Shell (`Bun.$`) docs](https://bun.com/docs/runtime/shell)
- [Bun bundler — HTML entrypoints](https://bun.com/docs/bundler/html)
- [Bun bundler — single-file executables](https://bun.com/docs/bundler/executables)
- [Bun guide — watch a directory for changes](https://bun.com/docs/guides/read-file/watch)
- [Bun v1.3.14 release notes](https://bun.com/blog/bun-v1.3.14)
- [oven-sh/bun releases](https://github.com/oven-sh/bun/releases)
- [oven-sh/bun#23992 — fs.watch reports `rename` where Node reports `change`](https://github.com/oven-sh/bun/issues/23992)
- [nodejs/node#7420 — fs.watch `event` always `"rename"` on macOS](https://github.com/nodejs/node/issues/7420)
- Local empirical verification: Bun 1.3.14 (rev `0d9b296a`), macOS 26.5.2 arm64, 2026-07-31
