# Architecture

The module map, each module's interface, the layering rules, and where state
lives. `AGENTS.md` points here; this file points at code. When this file and the
code disagree, the code is right — fix this file in the same change.

## Runtime topology

One Bun process (`server/index.ts`). It serves `app/` as plain files, the JSON
API under `/api/*`, the SSE bus at `/events`, and an in-memory `Bun.build`
bundle of `age-encryption` at `/vendor/age.<hash>.js` (entry:
`server/age-entry.js`). State lives in the vault directory (`$ZNOTES_VAULT`):
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

No build step; ES modules served as-is. Two tiers, enforced by lint:

- **Leaves** — `state.js` (the one shared-state object), `ui.js` (DOM helpers,
  icons), `api.js` (the only file that opens a socket), `dialogs.js` (all
  modals; feature callbacks injected via `wireDialogs()` from `app.js`),
  `armor.js`, `entropy.js`, `crypto-worker.js` (the plaintext jail). Leaves
  import only leaves.
- **Features** — `tree, editor, markdown, secrets, chat, terminal, trash,
  settings, shell`, composed by `app.js` (`start()`). These are mutually
  entangled (14 mutual import pairs, a legacy of the single-file split); new
  cross-feature needs should go through `state.js`, an injected callback, or a
  DOM event rather than adding pairs. No `export let` anywhere in `app/`.
  `mermaid.js` is the newest and is deliberately the cleanest: `markdown.js`
  imports it, it imports `ui.js` and nothing else, and it owns its own theme
  observer rather than making `settings.js` learn about diagrams (ADR 0010).
- **Static, not modules** — `index.html`, `themes/*.css`, `manifest.json`,
  `icons/*.png` and `vendor/mermaid.js`. All are written by GENERATORS run by
  hand and committed, never by a build step: `scripts/make-icons.ts` draws the
  icons when the mark changes (ADR 0007), `scripts/build-mermaid.ts` bundles
  mermaid when its pinned version changes (ADR 0010). Nothing at runtime
  builds either. `/vendor/` is the one URL prefix with two answers behind it:
  `age.<hash>.js` is built in memory at boot and has no file, everything else
  is an ordinary file under `app/vendor/`.

Two guards on leaving a surface with unsaved work, and they are twins — same
shape, same `proceed` callback re-issuing the caller's own action with a force
flag, and the browser Back button reaches both through `onPop`'s `holdPop`
(a popstate is an announcement, so it is undone with `history.forward()` and
re-issued if the user says leave):

| Surface | Gate | Raised by |
|---|---|---|
| a Raw buffer that differs from disk | `guardRawExit` (editor.js) | ⌘E, the mode chip, a click on the pane, Esc, `openDoc`, `openSettings`, Back |
| the settings page's unsaved draft | `guardSettingsExit` (settings.js) | the header Back button, `openDoc`, Back |

The Raw gate's presentation is policy (ADR 0022):
`editor.confirmBeforeExit=true` mounts its staged-diff question, while `false`
keeps the same gate and pending destination but saves first and proceeds only
after the write lands. The Settings-draft guard is separate and unaffected.

Below them, Back also unwinds the layers that cover the document — the veils
(`dismissTop`), then the assistant while it is an overlay, then Raw→Preview on
a phone. `shell.js onPop` is the one place that order is written down.

## Tests as the enforcement layer

The suite is black-box first: `tests/helpers.ts` boots the real server per
test, `tests/browser.ts` drives real Chromium. `markdown-e2e.test.ts` is the
one broad Preview-dialect map (ADR 0021). Three tests enforce structure
as source-text assertions (see `docs/style.md` gotchas): the no-crypto-import
rule, the AI-has-no-delete rule, and the `OPS` operation set. Direct unit
tests exist only where a seam is pure (`links.test.ts`, `armor`, `entropy`,
`gitunit`, `index-recovery`).
