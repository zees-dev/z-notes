# Architecture

The module map, each module's interface, the layering rules, and where state
lives. `AGENTS.md` points here; this file points at code. When this file and the
code disagree, the code is right — fix this file in the same change.

## Runtime topology

One Bun process (`server/index.ts`). It serves `app/` as plain files, the JSON
API under `/api/*`, the SSE bus at `/events`, and two in-memory `Bun.build`
bundles: `age-encryption` at `/vendor/age.<hash>.js` (entry:
`server/age-entry.js`) and the editor island at `/vendor/editor/*` (entry:
`app/block-editor.tsx`, aliased as `/vendor/editor.js` + `.css`; ADR 0037). State lives in the vault directory (`$ZNOTES_VAULT`):
visible, extension-bearing UTF-8 files (source of truth; ADR 0019),
`.znotes/settings.toml` (committed),
`.znotes/index.db` (sqlite cache + credentials, never committed),
`.znotes/identity.age` + `vault.pub` (committed keyring). Production is one k3s
replica behind a private-CA TLS ingress (`deploy/`); the replica count is a
correctness constraint, not a cost choice — see `deploy/k3s/20-deployment.yaml`.

There may be more than one vault (ADR 0018). `$ZNOTES_VAULT` is the **primary**
vault — the one described above, addressed by bare doc paths, and the only home
of app-level state (settings, keyring, AI relay, terminal). Every direct
subdirectory of `$ZNOTES_VAULTS_DIR` is a **secondary** vault: the same layout
on disk, its own full stack in the process, and doc paths prefixed `@<id>/`
everywhere they cross the wire. The filesystem is the registry; there is no
list to migrate.

The vault is **not** part of this repo (ADR 0017) — five env vars place it and,
optionally, seed it: `ZNOTES_VAULTS_DIR` (the vaults home, default `./vaults`,
gitignored, scanned at boot), `ZNOTES_VAULT` (the primary, default
`$ZNOTES_VAULTS_DIR/vault`, created at boot if missing — so one directory holds
every vault, one subdirectory each, and a deployment mounts exactly that one
directory. An install that wants the primary somewhere else sets it explicitly,
and the boot scan skips whichever subdirectory is the primary, by real path. The home may not sit INSIDE the primary, and the primary may not sit
deeper than a direct child of the home: either would double-index, and costs
the secondaries rather than the app), `ZNOTES_PORT` (default 4700), and the two first-boot
bootstraps — `ZNOTES_VAULT_REPO` attaches the vault to that remote when it is
not already its own repo (a vault that is one is left alone; a failure is logged
and boot continues into an offline vault), and `ZNOTES_GIT_TOKEN` is absorbed
into the sqlite credential store as `git.token` only when none is stored, so a
stale env var can never clobber a rotated one. Both bootstraps are
primary-only: a secondary vault is added through `POST /api/vaults`, and the
vaults home is what makes it survive the restart. Platform behavior the design leans on
(fs.watch semantics, `bun --hot`, sqlite/FTS5, Bun.build) is documented in
[the platform research](specs/done/0005-bun-platform-foundation.md) — reference, not contract.

## Server modules and layers

Forward-only imports, lower layer number = deeper. A module may import only
strictly lower layers. `scripts/lint-docs.ts` enforces exactly this table — a
new module must be added there (and here) to compile through CI.

| Layer | Module | Owns | Interface (import surface) |
|---|---|---|---|
| 0 | `vault.ts` | pure text/link/path facts + the `Vault` class (all disk I/O, bound to one root) + keyring | pure fns, `Vault`, armor constants |
| 0 | `db.ts` | sqlite `Index` + corruption recovery + fuzzy search | `Index`, `fuzzy`, per-consumer slices `WatchIndex` / `AiIndex` / `TerminalIndex` |
| 0 | `http.ts` | JSON response shapes, body reading, the 8 MiB cap | `json`, `fail`, `readJsonBody`, sentinels |
| 0 | `sse.ts` | the entire SSE wire format (encode, split, parse, response envelope) | `sseResponse`, `sseFrame`, `sseBlocks`, `parseSseFrame`, `SSE_HEADERS` |
| 1 | `settings.ts` | settings.toml load/heal/save, ALL credentials (incl. terminal password crypto), PUT/GET fan-out behind `wire()` | `Settings`, `SettingsError`, `DEFAULTS`/`META` tables |
| 1 | `watch.ts` | fs.watch doorbell → debounced full reconcile; the reconcile lock | `Reconciler` |
| 1 | `ai-edits.ts` | the pure edit engine: anchors, `propose_edits` parse/validate/apply, diffs | `parseEdits`, `applyEditToText`, `buildDiff`, `findAnchor` |
| 2 | `trash.ts` | retained-delete storage + retention policy | `Trash`, `TrashError`, `isTrashId`, `trashGitPaths` |
| 2 | `ai-endpoint.ts` | capability probe, degradation ladder, endpoint status/announce | `AiEndpoint` |
| 3 | `git.ts` | add→commit→fetch→ff-only→push sync + the upstream poll (ADR 0026), GIT_ASKPASS auth, tracked-set discipline, attach (the one place `git init` may run — ADR 0017) | `GitSync`, `gitMessage`, `sanitizeRemote`, `validRemoteUrl` |
| 3 | `terminal.ts` | password-gated command runner, sessions, AI-command approval | `Terminal`, `TerminalError`, `bearerOf` |
| 4 | `ai.ts` | turn orchestration, context assembly + leak guard, the two wire dialects, proposal stack | `AI` (single export) |
| 4 | `docs.ts` | every doc/folder/trash transaction: create, CAS-write, move + backlink rewrite + rollback, delete/restore/purge/sweep, commit | `DocStore`, `isDocPath` |
| 5 | `vaults.ts` | the vault registry: one stack per vault, the boot scan of the vaults home, add/remove, `@id/` qualification (ADR 0018) | `VaultRegistry`, `VaultStack`, `validVaultId`, `qualify` |
| 6 | `index.ts` | composition root: wiring, route table, `/events` bus, vendor bundle, static serving, boot/shutdown | none (entrypoint) |

Dependency-injection convention: modules take **narrow structural deps**
(`Pick<Settings, …>`, the `db.ts` slices, callback fields) — never a concrete
class they don't fully use. `GitSyncDeps` is the original model.

## Frontend modules

ES modules served as-is, plus one React island the server bundles at boot
(ADR 0037). Two tiers, enforced by lint:

- **Leaves** — `state.js` (the one shared-state object), `ui.js` (DOM helpers,
  icons), `api.js` (the only file that opens a socket), `dialogs.js` (all
  modals; feature callbacks injected via `wireDialogs()` from `app.js`),
  `armor.js`, `entropy.js`, `crypto-worker.js` (the plaintext jail),
  `markdown-source.ts` (the source adapter). Leaves import only leaves.
- **The island** — `block-editor.tsx`: the BlockNote editor (Edit), React,
  TypeScript, bundled by `server/index.ts` at boot and loaded lazily by
  `editor.js` from `/vendor/editor.js`. It imports npm packages and
  `markdown-source.ts` only; `mountEditor(host, options)` takes callbacks
  (`onChange`, `onSource`, `renderSecret`, `resolveWikiLink`, `onWikiLink`,
  `copyText`) and returns a controller (`setMarkdown`, `revealLine`,
  `anchorLine`, `getSecrets`, `replaceSecret`, `destroy`). The adapter
  (`SourceSession`) owns format conversion: top-level MDAST groups with byte
  ranges, untouched groups verbatim, edited groups through the standard
  serialiser, protected blocks for what it cannot edit, ciphertext blocks for
  age fences. Editing behaviour is BlockNote's; the shell never sees a block.
- **Features** — `tree, editor, rawedit, secrets, chat, terminal,
  trash, settings, shell, webmcp, zoom, keybar`, composed by `app.js`
  (`start()`). These are mutually entangled (14 mutual import pairs, a legacy
  of the single-file split); new cross-feature needs should go through
  `state.js`, an injected callback, or a DOM event rather than adding pairs.
  No `export let` anywhere in `app/`.
  `editor.js` owns the doc lifecycle for BOTH surfaces: `renderDoc` mounts
  the island (Edit) or `rawedit.js` (Source) into `#doc`, holds the disk
  baseline, the exit guard, autosave and the CAS save keyed by the doc object
  (so a move mid-save follows the doc). `rawedit.js` is a
  leaf of a FEATURE rather than a peer of one: `ui.js` in, `editor.js` its only
  importer. It builds the Source surface, a `contenteditable` with one block per
  source line so a heading is drawn at the heading's size and a link in the
  link's colour (ADR 0032), behind the textarea's own vocabulary (`value`,
  `selectionStart`, `setSelectionRange`, `input`/`select`/`copy`/`cut`) plus
  two verbs of its own: `replaceRange`, the write primitive every edit goes
  through, and `boxAt`, where ADR 0027's measurement happens. `keybar.js` is
  the newest and shallow on purpose: `ui.js`, `history.js` and `editor.js` in,
  `app.js` its only importer, no logic of its own. It owns the bar on the soft
  keyboard's top edge (ADR 0034), where a phone gets the Outdent, Indent, Undo,
  Redo and Done its keyboard has not got; the markup is static in `index.html`
  and every button calls the function its missing chord calls. What it owns is
  the CONDITION `raw-focus` on `#app`, which with `wireVisualViewport`'s
  `kb-up` is what base.css §8a draws the bar on, and `--keybar`, the bar's
  measured height, which `revealRawCaret` subtracts alongside `--kb`. Edit has
  its own phone toolbar inside the island (Bullet, Numbered, Checklist,
  Outdent, Indent, and a ⋯ position calibration), docked on
  `--visual-bottom`, the visible viewport's bottom edge that
  `wireVisualViewport` publishes beside `--kb`.
- **Static, not modules** — `index.html`, `themes/*.css`, `manifest.json`
  and `icons/*.png`. The icons are GENERATOR output run by hand and committed
  (`scripts/make-icons.ts`, ADR 0007), never a build step. `/vendor/` is the
  one URL prefix answered from memory: `age.<hash>.js` and `editor/*` are
  built at boot and have no file; anything else under it would be an ordinary
  file in `app/vendor/` (there is none today).

**Where the frontend's state lives.** `state.js` holds all of it. Two entries
are VIEW choices the server has no opinion about, so each is mirrored per
browser in `localStorage` by its one writer:
`state.folderOpen`/`state.vaultOpen` → `znotes.tree-open` (folder and vault-row
disclosure, tree.js, [spec 0012](specs/done/0012-folder-disclosure-persists.md))
writes through on a user action only: seeding reads, and so does a reveal (`revealFolder`
opens a doc's ancestors in `state` alone, because opening a doc is not a choice
about the folder), prunes to the tree that just loaded, and treats an
unreadable store as no memory rather than an error. The island keeps one
value of its own, `znotes.toolbarOffset` — the phone toolbar's calibrated
offset in px, written by its ⋯ controls, clamped on read, and never synced.

**The look, resolved before the first paint.** Four axes are cached in
`localStorage` and applied by the inline script at the top of `app/index.html`,
so a reload never flashes the wrong one. `znotes.scheme`, `znotes.theme` and
`znotes.density` are caches of a SETTING the server owns (`start()` re-applies
the real value within a tick). `znotes.zoom` is owned by the browser alone: the
pinch ladder's rung (ADR 0033), published as `--doc-zoom` on `<html>` and read
only by base.css, for `.doc`'s font-size and the px-sized code tokens inside
the document (`.code pre`, `.mmd-err`). `zoom.js` owns the gesture, the ladder
and that property; nothing else may write it.

**Where `/` goes.** The bare root is a request for the default PLACE, not a
place: `shell.js bootDoc()` resolves it at boot against the tree that just
loaded, taking the doc a `/d/` URL named, else the last doc this browser opened
(`znotes.last-doc`, written by `openDoc` beside `state.active` on every open),
else `editor.homeDoc`, else the first doc; `openDoc` then replaces the address
with that doc's `/d/` URL (ADR 0035). The store is per browser and never
synced. An entry the tree no longer has is skipped by that walk rather than
pruned on delete, and a store that cannot be read degrades to its last two
steps. The e2e harness clears it before every boot (`tests/browser.ts`), so
suites measure the first doc unless they ask to `resume`.

**Agents.** `webmcp.js` is the agent's `app.js` (ADR 0031). One table registers
every operation the human UI offers as a WebMCP tool, each wrapping the feature
function the click or the chord calls, so the open buffer, the undo timeline,
the tree and the address bar follow a tool call as they follow a gesture.
`app.js` calls `registerWebMcpTools()` last in `start()`, and nothing else
imports the module. Registration goes to `document.modelContext` when it
exists, else `navigator.modelContext` when it can `registerTool`, and never
replaces either. When `document.modelContext` is absent the module defines it
over the same table, which is how the e2e suite and any DevTools-driven agent
read the catalogue on a Chromium that has never heard of WebMCP. A tool never
throws. A failure is `{error, message, ...extra}` in the API's shape (ADR 0002),
because the spec has no settled way to carry a rejection back to the caller. No
tool decrypts, reveals or takes a passphrase.

Two guards on leaving a surface with unsaved work, and they are twins — same
shape, same `proceed` callback re-issuing the caller's own action with a force
flag, and the browser Back button reaches both through `onPop`'s `holdPop`
(a popstate is an announcement, so it is undone with `history.forward()` and
re-issued if the user says leave):

| Surface | Gate | Raised by |
|---|---|---|
| a doc buffer (Edit or Source) that differs from disk, or a dirty revealed secret | `guardRawExit` (editor.js) | ⌘E, the mode chip, Esc, `openDoc`, `openSettings`, Back |
| the settings page's unsaved draft | `guardSettingsExit` (settings.js) | the header Back button, `openDoc`, Back |

The Raw gate's presentation is policy (ADR 0022):
`editor.confirmBeforeExit=true` mounts its staged-diff question, while `false`
keeps the same gate and pending destination but saves first and proceeds only
after the write lands. The Settings-draft guard is separate and unaffected.

Below them, Back also unwinds the layers that cover the document — the veils
(`dismissTop`), then the assistant while it is an overlay, then Source→Edit on
a phone. `shell.js onPop` is the one place that order is written down.

## Tests as the enforcement layer

The suite is black-box first: `tests/helpers.ts` boots the real server per
test, `tests/browser.ts` drives real Chromium. The adapter's byte contract
is held twice: `markdown-source.test.ts` on the pure module and the round-trip
corpus driven through the real editor in `block-editor-e2e.test.ts`. Four tests enforce structure
as source-text assertions (see `docs/style.md` gotchas): the no-crypto-import
rule, the AI-has-no-delete rule, the `OPS` operation set, and the tool
catalogue's own no-secrets rule (ADR 0031). Direct unit
tests exist only where a seam is pure (`links.test.ts`, `armor`, `entropy`,
`gitunit`, `index-recovery`).
