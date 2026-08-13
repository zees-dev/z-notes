# 0008 — Multi-vault: several vaults, each with its own sync

## Problem Statement

The server binds exactly one vault. `server/index.ts` resolves `ZNOTES_VAULT`
(default `./vault`), builds ONE of everything around it — `Vault`, `Index`
(sqlite at `<vault>/.znotes/index.db`), `Settings` (`<vault>/.znotes/settings.toml`),
`Reconciler` (one recursive `fs.watch`), `Trash`, `GitSync`, `DocStore` — and
every route addresses docs by a vault-relative path. ADR 0017 made that one
vault bring-your-own and attachable to a remote (`POST /api/sync/remote`), but
there is still only one of it: a user with two repos of notes (or a notes repo
plus a project repo with markdown in it) cannot see both in one z-notes.

The sidebar reflects the same assumption: a flat "Vault" section label over
depth-indented rows. Two smaller UI defects ride along:

1. **Sibling misalignment** — folder rows indent at `8 + depth*12` px and file
   rows at `14 + depth*12` px (`app/tree.js` `node()`), so a folder and a file
   that are siblings sit at different indents.
2. **No structure lines** — nesting is conveyed by padding alone; there is no
   branch guide connecting children to their parent.

Goal: the server hosts **multiple vaults**, each an independent directory with
its own git repository, its own sync config and cadence, its own trash and its
own index. The sidebar shows every vault as a top-level, collapsible,
expanded-by-default entry named after its repo, whose children are the repo
root's contents, drawn as a proper tree (uniform sibling indentation, subtle
branch guides). With nothing connected, the app looks exactly as it does today
except the single top-level entry reads `vault (unsynced)`.

## Solution

**One primary vault, N secondary vaults, one address grammar.**

- The existing `ZNOTES_VAULT` vault becomes the **primary vault**, id `vault`.
  Its doc paths, routes, settings, keyring, AI relay, terminal and tests stay
  byte-for-byte what they are today — zero churn for a single-vault install.
- **Secondary vaults** live as subdirectories of a new vaults home,
  `ZNOTES_VAULTS_DIR` (default `./vaults`, gitignored in the app repo). Each
  is a full, independent stack: `Vault + Index + Settings + Reconciler +
  Trash + GitSync + DocStore`. The registry that owns them is a new
  `server/vaults.ts`; the route table in `index.ts` stays the only router.
- **Addressing**: a doc in a secondary vault is addressed as
  `@<id>/<vault-relative path>` through every existing doc-path surface —
  `/api/docs/*`, `/api/search` results, `/api/trash` entries, SSE
  `doc-changed` frames, `/d/…` URLs, and the client's own state. The router
  strips the `@<id>/` prefix and delegates to that vault's stack; inside a
  stack everything remains vault-relative (markdown content, `[[links]]`,
  git pathspecs never carry the prefix, so vault repos stay portable).
  To keep the grammar unambiguous, a path segment starting with `@` becomes
  invalid vault content (same rule as dot-prefixed segments).
- **Management API**: `GET/POST /api/vaults`, `DELETE /api/vaults/{id}`,
  `GET /api/vaults/{id}`, `PUT /api/vaults/{id}/settings`,
  `POST /api/vaults/{id}/sync`. Adding a vault is the existing **attach**
  operation (ADR 0017) run against a freshly created directory; every
  guarantee attach makes (non-destructive, atomic, credential rules) is
  inherited, and a failed add leaves no directory behind.
- **UI**: the tree renders one top-level vault row per vault — chevron, icon,
  repo-derived label, per-vault sync dot — expanded by default; children are
  that vault's tree. Sibling rows share one indent formula; each `.children`
  box draws a 1-px branch guide. Settings → Sync gains an "Add vault" row and
  a per-vault block (remote, branch, auto-sync, token, Sync now, Disconnect).
- **Deliberately per-vault**: git sync (branch, autoSync, autoSyncSeconds,
  token — each vault's own `settings.toml` + own sqlite credentials), trash
  and retention, the search index, the fs watcher.
  **Deliberately primary-only in v1**: app-level settings (theme, editor, AI,
  terminal, secrets policy), the AI relay, the terminal, the keyring/secrets
  (`/api/vault/*`), `editor.homeDoc`, `ZNOTES_VAULT_REPO` boot provisioning.

## User Stories

1. As a user with no repo connected, I boot the app and see one expanded
   top-level entry `vault (unsynced)` over exactly the tree I have today;
   everything else behaves unchanged.
2. As a user, I attach my primary vault to `github.com/z/notes.git` and the
   top-level entry now reads `notes`.
3. As a user, I enter a second repo URL in Settings → Sync → Add vault and a
   new expanded top-level entry appears, named after the repo, its children
   the repo root's files; its docs open, edit, save, search, rename and trash
   like any others.
4. As a user, I give each vault its own sync cadence (or turn auto-sync off
   for one) and each vault commits/pushes to its own origin on its own
   schedule, never to another vault's.
5. As a user with the same slug in two vaults, `[[slug]]` written in a doc
   resolves within that doc's vault only — vault contents stay portable and
   links never silently jump repos.
6. As a user, I delete a doc in a secondary vault and can restore it from the
   one trash drawer; the entry says which vault it came from.
7. As a user, I disconnect a secondary vault and its entry leaves the tree;
   the directory (and its repo) stays on disk untouched.
8. As a user whose add-vault failed (bad URL, unreachable remote, wrong
   token), nothing is left behind — no directory, no registry entry — and the
   error names the problem in place.
9. As a user, I see at a glance which vault is synced, syncing or in error:
   each vault row carries a status dot whose tooltip is the sync message.
10. As a keyboard/pointer user, sibling files and folders align to one indent,
    children indent one step inward, and a subtle guide line connects each
    child run to its parent.
11. As a self-hoster, I restart the pod and every vault under the vaults home
    comes back — the registry is the filesystem, nothing else to migrate.
12. As the operator, tokens still live only in sqlite (per vault), reach git
    only through the askpass env, and appear in no argv, config, log, URL or
    response.

## Implementation Decisions

### 0. What exists today (map for the implementing agent)

- `server/index.ts` — composition root + declarative route table. Boot order:
  `mkdirSync(VAULT)` → `new Index` → `new Settings` + `load()` → `Reconciler`
  → `Trash` → `GitSync` → `DocStore` → `settings.wire(fanout)` →
  `ZNOTES_VAULT_REPO` attach → `recon.reconcile()` → `recon.start()` →
  `buildVendor()` → trash sweep → `gitSync.start()` → `ai.probeAtBoot()` →
  `Bun.serve`. SSE: `broadcast()`, `vaultEpoch` persisted in the primary
  index (`meta` key `vaultEpoch`), bumped per announced change.
- `server/vault.ts` — pure path/derivation functions + `class Vault(root)`.
  `safePath()` refuses `..`, `\`, empty and dot-prefixed segments.
  `buildTree(files, folderOpen, folderPaths)` is pure. `vaultName()` derives a
  display name (a dir literally called `vault` borrows its parent's name);
  `realRoot` is `~`-abbreviated.
- `server/db.ts` — `class Index(file)`; disposable cache + credential store
  (`git.token`, `ai.apiKey`, terminal hash) + `folders` disclosure + `meta` KV.
- `server/settings.ts` — `class Settings(vault, index)`;
  `<vault>/.znotes/settings.toml`, committed, healed, credentials absorbed to
  sqlite. `wire(SettingsFanout)` late-binds collaborators. `git.branch/
  autoSync/autoSyncSeconds` validated here; `validBranchName` exported.
- `server/watch.ts` — `class Reconciler(vault, index, emit)`; one recursive
  `fs.watch`, debounced scan→stat→hash→sqlite diff; `lock()` serialises every
  mutation; emits `DocChange` (path, rev, reason, removed/from/to/trashId).
- `server/git.ts` — `class GitSync(deps)`; per-vault pipeline (stage tracked
  set → commit → push → rebase-retry), `commitPaths()` targeted commits,
  `attachRemote()` (ADR 0017, the one `git init`), `sanitizeRemote`,
  `validRemoteUrl`, `SyncStatus {state, branch, remote, lastSyncAt, ahead,
  behind, message}` pushed as `sync-status` SSE.
- `server/trash.ts` — `class Trash({vault, settings, log})`; entries under
  `<vault>/.znotes/trash/<id>/`; `isTrashId` gate; committed with the vault.
- `server/docs.ts` — `class DocStore(deps)`; every doc/folder/trash mutation;
  `treeResponse()` returns `{vault: {name, root, docCount}, tree}`.
- `app/api.js` — the only network module; `encPath` percent-encodes segments.
- `app/state.js` — `state.tree`, `state.docs` (path→doc), `state.docPaths`
  (Set), `state.slugs` (Map slug→[paths]), `state.folderOpen`, `state.sync`.
- `app/tree.js` — `loadTree()` (fetch + index + `renderTree()`; also paints
  `#vaultName`/`#vaultSub`), `renderTree()` (folder rows `8+depth*12`, file
  rows `14+depth*12`, one `sec-label` "Vault"), inline create/rename
  (`inlineRow`, `10+depth*12`), delete + neighbour walk, context menu.
- `app/ui.js` — `lookupLink(target)` resolves `[[links]]` against the global
  `state.slugs`/`state.docPaths`; `normTarget`.
- `app/shell.js` — `paintSync` drives the statusbar chip from `sync-status`
  frames + route responses; SSE wiring; `revealInTree`; home button.
- `app/settings.js` — Settings page; Sync section already has the Repository
  row (`paintGitRemote`) + Connect button driving `POST /api/sync/remote`.
- Styles: `app/themes/base.css` holds component CSS (`.row`, `.children`,
  `.rowwrap`…), themes override tokens only (ADR 0003). `--line` is the
  hairline token.
- Layering (enforced by `scripts/lint-docs.ts`, "the law" array, mirrored in
  `docs/architecture.md`): `vault db http sse` → `settings watch ai-edits` →
  `trash ai-endpoint` → `git terminal` → `ai docs` → `index`.
- Contract: `docs/specs/done/0002-http-api-v0.md`; error bodies
  `{error, message, ...extra}`, key order included.

### 1. Address grammar: `@<id>/` (server/vault.ts, server/index.ts)

- **Vault id**: `^[a-z0-9][a-z0-9-]{0,39}$`. The primary vault's id is the
  reserved literal `vault`. Export `validVaultId(s)` from `server/vaults.ts`.
- **Qualified path**: `@<id>/<rel>` where `<rel>` is an ordinary vault-relative
  path. Primary-vault paths are NEVER qualified — they stay exactly today's
  bare paths, which is what keeps the whole existing contract, client and test
  suite valid unchanged.
- **Reserved segment**: `safePath()` gains one rule beside the dot-prefix one:
  a segment starting with `@` is refused. `scanDocs()`/`scanFolders()`/
  `scanTree()` skip `@`-prefixed segments the same way they skip dot-prefixed
  ones, so a stray `@x/` directory on disk is invisible rather than
  ambiguous. (Consequence: no vault can contain a doc whose path collides
  with the vault grammar; document in 0002.)
- **Router resolution** (in `index.ts`, before `safePath`): if the first
  segment of an incoming doc path matches `/^@([a-z0-9-]+)$/`, look the id up
  in the registry — unknown id → `404 {error:"not-found", message:"No vault
  @<id>."}` — and hand the remainder to that vault's stack; otherwise the
  whole path is a primary-vault path, validated by `safePath` as today.
  `decodeDocPath` decodes percent-encoding before the split, as it already
  does. A cross-vault `PATCH` (path and `to` resolving to different stacks)
  is `400 {error:"bad-path", message:"A move cannot cross vaults."}`.
- **Qualification helpers** live in `server/vaults.ts`: `qualify(id, rel)`
  (identity for the primary) and `prefixTree(nodes, prefix)` (deep-copies a
  `buildTree` result rewriting `path`). Nothing below the registry ever sees
  a prefix.

### 2. The registry (`server/vaults.ts`, new module)

```ts
interface VaultStack {
  id: string;                    // "vault" for the primary
  vault: Vault; index: Index; settings: Settings;
  recon: Reconciler; trash: Trash; git: GitSync; docs: DocStore;
}
export class VaultRegistry {
  readonly primary: VaultStack;
  stacks(): VaultStack[];                       // primary first, then by id
  get(id: string): VaultStack | null;
  resolveDocPath(p: string): { stack: VaultStack; rel: string } | null;
  addVault(url: string, name?: string, token?: string): Promise<AddResult>;
  removeVault(id: string): Promise<boolean>;    // false: unknown; throws on "vault"
  labelOf(stack: VaultStack): string;           // display-name rule, below
}
```

- `index.ts` constructs the primary stack exactly as today and hands it to
  `new VaultRegistry({ primary, vaultsDir, broadcast, bumpEpoch, log })`. The
  registry constructs secondary stacks with the SAME wiring shape the primary
  gets, except: the `SettingsFanout` for a secondary wires `applyGit`/
  `scheduleSync` to its own `GitSync`, `retentionDays`/`sweepTrash`/
  `announceTrash` to its own docs/trash, and the AI hooks
  (`aiSettingsSaved`, `aiEffortChanged`, `aiAnnounce`) to no-ops — there is
  one AI relay and it belongs to the primary. `broadcast` is the shared bus.
- **Boot scan**: if `ZNOTES_VAULTS_DIR` exists, every direct subdirectory
  whose name passes `validVaultId` (and is not `vault`) becomes a stack;
  invalid names are skipped with a stderr line. Per-stack boot mirrors the
  primary's order: `settings.load()` → `recon.reconcile()` → `recon.start()`
  → `git.start()` → boot trash sweep. Serial is fine. The registry refuses to
  operate (log + no secondary vaults) if the vaults dir is inside the primary
  vault or the primary vault is inside the vaults dir — nested scans would
  double-index.
- **SSE wiring per stack**: each Reconciler's emit callback does what the
  primary's does today — `bumpEpoch()` (the ONE `vaultEpoch` counter, stored
  in the primary index; the client's gap-resync logic keys on it and needs no
  change), then `broadcast("doc-changed", change)` with `path`/`from`/`to`
  qualified via `qualify(id, …)`, then `stack.git.schedule()`. Each GitSync's
  `onStatus` broadcasts `sync-status` with an added `vault: <id>` field — the
  primary's frames also gain `vault: "vault"` (additive; the client field was
  never pinned).
- **Sweeps**: the existing boot sweep + `TRASH_SWEEP_MS` interval in
  `index.ts` loop over `registry.stacks()`.
- **Shutdown**: `shutdown()` loops stacks — `recon.stop()`, `git.stop()`,
  `index.close()`.
- **Layering**: `vaults.ts` imports vault/db/settings/watch/trash/git/docs, so
  the law becomes `vault db http sse` → `settings watch ai-edits` →
  `trash ai-endpoint` → `git terminal` → `ai docs` → `vaults` → `index`.
  Update BOTH `scripts/lint-docs.ts` and `docs/architecture.md`.

### 3. Adding a vault (`registry.addVault`)

1. Validate `url` with the existing `validRemoteUrl` → `400 bad-url` verbatim.
2. Derive the display name: `name` if given (trimmed, ≤ 64 chars), else the
   last path segment of `sanitizeRemote(url)` (e.g. `github.com/z/work-notes`
   → `work-notes`). Slugify to an id: lowercase, `[^a-z0-9]+`→`-`, trim `-`,
   clamp to 40; must pass `validVaultId` else `400 bad-name`. `vault` is
   reserved → `400 bad-name`.
3. Refusals before touching disk: id already registered → `409 {error:
   "exists", message:"A vault @<id> is already connected."}`; some stack's
   sanitized origin already equals `sanitizeRemote(url)` → `409 exists`
   naming that vault.
4. `mkdir -p` the vaults dir; the vault dir `<vaultsDir>/<id>` must NOT
   pre-exist (it would have been a boot-scanned vault) → `409 exists`.
   Create it. **From here every failure removes `<vaultsDir>/<id>`
   recursively** — safe because this call created it empty seconds ago.
5. Build the stack (constructing `Index`/`Settings.load()` mints
   `.znotes/`). Credential: if `token` was passed, `setCredential("git.token",
   token)` in the NEW vault's index; else, if the primary has a `git.token`,
   COPY it into the new vault's store (one account, N repos, is the common
   case; the copy is deliberate and documented — pass `token: ""` explicitly
   to attach anonymously).
6. `stack.git.attachRemote(url)` — the existing operation, verbatim, in the
   new directory (an empty dir is attach case B: init, fetch, checkout).
   Failure → tear down the stack (stop/close) → remove the dir → relay the
   attach status/body verbatim (`bad-url`/`vault-busy`/`checkout-conflict`
   cannot practically occur in a fresh empty dir but are relayed if they do;
   `attach-failed` 502 is the ordinary failure).
7. `stack.settings.putRoute({git: {branch}})` (adopts the checkout's
   settings.toml exactly as the primary attach route does), register the
   stack, `recon.reconcile()` → `recon.start()` → `git.trigger("manual")`
   → `git.start()`-equivalent status refresh → `broadcast("vaults-changed",
   <the GET /api/vaults body>)` → return the vault descriptor.

### 4. Removing a vault (`registry.removeVault`)

`DELETE /api/vaults/{id}`: primary → `400 {error:"primary-vault",
message:"The primary vault cannot be disconnected."}`. Unknown → 404. Else:
stop the stack (`recon.stop`, `git.stop`, `index.close`), drop it from the
registry, broadcast `vaults-changed`, answer 204. **The directory stays on
disk untouched** — disconnecting is a registry operation, deletion is a human
one (document in 0002 and the Settings UI copy: "the folder stays at
<path>"). A re-add of the same URL later refuses on the surviving directory
(§3.4); removing it by hand is the documented path.

### 5. Display name (`labelOf`)

Using the stack's cached `git.snapshot()` (cheap, no spawn — refreshed by
boot `start()`, every pipeline run and status polls):

- `remote` non-null → the last path segment of the sanitized remote
  (`github.com/z/notes` → `notes`).
- else, repo but no origin → the vault directory's basename.
- else (not a repo) → `<basename> (unsynced)` — for the default
  `ZNOTES_VAULT=./vault` this is exactly **`vault (unsynced)`**. Use the raw
  basename here, NOT `vaultName()`'s parent-borrowing rule (that rule stays
  for the legacy `vault.name` field only).

### 6. HTTP surface (route table in `index.ts`; amend 0002 in the same change)

**Amended — `GET /api/docs`.** Keeps `vault` and `tree` byte-compatible
(primary only, unqualified), and adds:

```json
{
  "vault": { "name": "z-notes", "root": "~/vault", "docCount": 7 },
  "tree":  [ …primary tree, exactly as today… ],
  "vaults": [
    { "id": "vault", "label": "vault (unsynced)", "root": "~/vault",
      "docCount": 7, "remote": null, "repo": false, "prefix": "",
      "sync": { …snapshot of the sync-status object… },
      "tree": [ …same nodes as "tree"… ] },
    { "id": "work-notes", "label": "work-notes", "root": "~/vaults/work-notes",
      "docCount": 3, "remote": "github.com/z/work-notes", "repo": true,
      "prefix": "@work-notes/",
      "sync": { … },
      "tree": [ { "type": "file", "path": "@work-notes/inbox.md", … } ] }
  ]
}
```

Secondary trees carry qualified `path`s throughout (`prefixTree`), so the
client uses them verbatim. `sync` is `git.snapshot()` — no git spawn per tree
request.

**Amended — doc routes.** `GET/PUT/POST/PATCH/DELETE /api/docs[...]` accept
qualified paths per §1. `POST /api/docs` with `path: "@id/…"` creates in that
vault (the reply's `path` is qualified). Every per-vault behaviour (CAS,
link rewrites, one-commit file ops, canonical spelling) is untouched — it
runs inside the stack on the bare rel path; responses re-qualify `path`,
`from`, `updated[]`, `moved[]`.

**Amended — `GET /api/search`.** Fan out `index.search(q, limit)` across all
stacks, qualify hit paths, merge, re-sort by `score` desc then path, slice to
`limit`.

**Amended — trash.** `GET /api/trash` aggregates all stacks: each entry gains
`"vault": "<id>"`, and for secondary vaults `id` and `path` are qualified
(`"@work-notes/t_x1"`, `"@work-notes/inbox.md"`). Sorted newest-first across
vaults. `retentionDays` in the aggregate view is the primary's; each entry's
own `purgeAt` already carries the truth per entry. The `trash/{id}` routes'
pre-gate learns the qualified form: strip a leading `@<id>/`, resolve the
stack, then apply the existing `isTrashId`. `POST /api/trash/purge` (both
forms) fans out to every stack; `purged` in the reply carries qualified ids.
`trash-changed` SSE broadcasts the aggregate body (one frame per change, as
today, whichever vault changed).

**New — vault management** (all under the existing `crossSiteWrite` guard):

- `GET /api/vaults` → `{ "vaults": [ <descriptor without tree> ] }` where the
  descriptor is the `vaults[]` element above minus `tree`, plus
  `"git": { "branch", "autoSync", "autoSyncSeconds", "tokenMasked" }` from
  that vault's settings/credentials.
- `POST /api/vaults` `{url, name?, token?}` → `201 { "vault": <descriptor> }`
  or the errors of §3 (`400 bad-url`/`bad-name`, `409 exists`,
  `502 attach-failed`, plus relayed attach refusals).
- `GET /api/vaults/{id}` → `200 { "vault": <descriptor> }` | 404.
- `PUT /api/vaults/{id}/settings` body
  `{ "git": { "branch"?, "autoSync"?, "autoSyncSeconds"?, "token"? } }` —
  delegates to that stack's `settings.putRoute({git: …})` (validation, heal,
  credential absorb, persist, live-apply all inherited; the fanout wired in
  §2 applies it to the right GitSync). Response
  `200 { "vault": <descriptor> }`. Refuse non-`git` keys with
  `400 {error:"bad-body", message:"Only the git section is settable per
  vault."}` — app-level settings live in the primary's `/api/settings` only.
  Works for `{id}` = `vault` too (equivalent to the git slice of
  `PUT /api/settings`).
- `POST /api/vaults/{id}/sync` → that stack's `git.trigger("manual")` →
  `200` sync-status object with `vault` field. (`POST /api/sync/now`,
  `GET /api/sync/status`, `POST /api/sync/remote` stay primary-bound,
  unchanged.)

**New SSE event** `vaults-changed`: payload = the `GET /api/vaults` body.
Emitted on add, remove, per-vault settings change, and when a vault's label
would change (attach of the primary). Clients respond by `loadTree()` +
repainting the Settings Sync section.

**Amended SSE**: `doc-changed` paths qualified for secondary vaults;
`sync-status` gains `vault`. `hello`/epoch semantics unchanged (§2).

### 7. Frontend — state and addressing (`app/state.js`, `app/ui.js`)

- `state.vaults = []` (the `vaults[]` descriptors), `state.vaultOpen = new
  Map()` (id → bool, default true — client-only disclosure for vault rows;
  server `folders` stays per-vault and untouched).
- Helpers in `ui.js`: `vaultOf(path)` → `"vault"` or the id from a leading
  `@id/`; `relOf(path)`; `vaultPrefix(id)` → `""` or `"@id/"`.
- `state.slugs` becomes `Map(vaultId → Map(slug → [qualified paths]))`;
  `state.docPaths` stays one Set of qualified paths. `loadTree()` builds both
  from `r.vaults[*].tree`.
- `lookupLink(target, vaultId)` — every caller passes the vault of the doc
  being rendered (`vaultOf(state.active)` in the editor/preview path;
  assistant chat uses the active doc's vault, else `"vault"`). Path-qualified
  targets check `vaultPrefix(vaultId) + t + ".md"` in `docPaths`; bare slugs
  hit that vault's slug map. Resolution NEVER crosses vaults. Returned
  `path`s are qualified, so `openDoc`, hrefs and `/d/` URLs work verbatim
  (`encPath` percent-encodes `@` as `%40`; `decodeDocPath` already decodes —
  cosmetic only).
- `createFromLink(name)`: the implied path inherits the active doc's vault
  prefix (both the bare-slug and folder-qualified forms).

### 8. Frontend — the tree (`app/tree.js`, `app/themes/base.css`)

**Vault rows.** `renderTree()` drops the `sec-label "Vault"` and iterates
`state.vaults`: for each, a `.rowwrap > button.row.vault` at depth 0 —
`<span class="ico chev">` + a repo icon (add `I.vault` to `ui.js` icons; a
simple box/branch glyph consistent with the set) + `esc(v.label)` + a
`<span class="dot sync-<state>">` when `v.repo` (title = `v.sync.message`;
class from `v.sync.state`: ok/warn/busy → reuse the statusbar chip colour
tokens). `dataset.path = v.prefix ? "@"+v.id : ""`, `dataset.kind = "vault"`.
Click toggles `state.vaultOpen`; expanded by default; keydown: no rename/
delete on vault rows (Enter toggles). Its `.children` box registers in
`slots` under the vault's root key (`""` for primary, `"@id"` for others) at
depth 1, and the vault's `tree` nodes render into it via the existing
`node()`.

**Create/rename context.** "Vault root" generalises to "root of the
containing vault": `ctxTarget` on a vault row yields `{kind:"vault", path:
"", parent: <vault root key>}`; right-click empty space keeps the primary
root. `createParent()` unchanged (a picked doc/folder's `dirname` already
carries the prefix). `parseCreate(input, mode, parent)`: split the parent's
vault prefix off first; the leading-`/` from-root rule anchors at the
CONTAINING vault's root; validation runs on the rel path; the returned plan
path is re-qualified. `treeHas(path, "folder")` treats each vault root key as
an existing folder. `commitRename`: the input shows the qualified path for
secondary docs; the client refuses a commit whose `vaultOf(to)` differs from
`vaultOf(from)` with a toast ("A move cannot cross vaults") before the round
trip (the server refuses too, §1).

**Neighbour walk / first doc.** `treeLocate`/`firstDocIn`/`lastDocIn`/
`findDoc`/`openFirstDoc` walk `state.vaults[*].tree` in order (vault nodes
are just one more `children` level; a vault with no docs is skipped).

**Indentation — one formula.** Rows (folder AND file) get
`paddingLeft = 8 + depth*14` px; file rows and the vault-row-less depths gain
a leading `<span class="ico chev spacer"></span>` (same box as the chevron,
empty) so labels align with folder labels at the same depth. Drop the
`.row.file { padding-left: 14px }` special-case in base.css. `inlineRow` and
its error line use the same formula (`8 + depth*14`, icon column included).
Vault children start at depth 1.

**Branch guides.** `renderTree` sets an inline custom property on every
`.children` box: `--guide-x: <parentPad + 7>px` (the parent row's chevron
centre). In `base.css`:

```css
.tree .children { position: relative; }
.tree .children::before {
  content: ""; position: absolute; top: 2px; bottom: 2px;
  left: var(--guide-x); width: 1px;
  background: var(--line); opacity: .55; pointer-events: none;
}
.tree .children.closed::before { content: none; }
```

Nested `.children` each draw their own line, which is the whole ancestor
guide set. Tokens only — no per-theme CSS (ADR 0003); if `--line` reads too
strong in a theme, introduce `--tree-guide` in base.css defaulting to
`var(--line)` and let themes override the token.

**Header.** `#vaultName`/`#vaultSub` keep painting from the legacy `r.vault`
(primary) — unchanged; when `r.vaults.length > 1`, `#vaultSub` appends
`" · N vaults"`.

### 9. Frontend — shell, settings (`app/shell.js`, `app/settings.js`, `app/api.js`)

- `api.js`: `getVaults()`, `addVault({url, name, token})`, `removeVault(id)`,
  `putVaultSettings(id, git)`, `syncVault(id)`.
- SSE: subscribe `vaults-changed` → update `state.vaults`, `loadTree()`,
  repaint Settings Sync if open. `sync-status` frames: `vault === "vault"` →
  `paintSync` (statusbar chip stays primary-bound); every frame also updates
  the matching `state.vaults[i].sync` and repaints that vault row's dot in
  place (no full re-render).
- Settings → Sync: keep the primary's existing controls; below them, one
  block per secondary vault — label, remote, branch input, auto-sync toggle,
  interval, token field (masked, same absorb semantics as the primary's),
  "Sync now", "Disconnect…" (confirm dialog; body names the on-disk path that
  stays) — bound to the `/api/vaults/{id}` routes; errors surface in place
  via the existing ERROR_TARGETS pattern. Then the **Add vault** row: URL
  input, optional name, optional token, Connect button (disabled in flight);
  attach-family errors surface in place.
- If the active doc's vault is removed (`vaults-changed` no longer lists it):
  clear the buffer and open the first doc of the first vault (reuse the
  delete-under-you path).
- AI chat: `shell/chat` pass `docPath` to `POST /api/ai/messages` only when
  `vaultOf(state.active) === "vault"`; otherwise omit it (v1 boundary, §11).

### 10. Env, hygiene

- `ZNOTES_VAULTS_DIR` (default `./vaults`), documented beside `ZNOTES_VAULT`
  in `server/index.ts`'s header, `docs/architecture.md` and
  `deploy/README.md`. Add `/vaults/` to the app repo's `.gitignore`. The k3s
  manifests need no change (single replica invariant unchanged; a second PVC
  path is the operator's choice).
- `ZNOTES_VAULT_REPO`/`ZNOTES_GIT_TOKEN` stay primary-only boot provisioning.

### 11. Boundaries stated as behaviour (v1)

- **AI relay**: primary vault only — context assembly, FTS, `propose_edits`,
  proposals/undo stack all operate on the primary stack, unchanged. A doc in
  a secondary vault simply arrives without doc context (§9). The relay's
  no-rename/no-delete guarantee is untouched.
- **Terminal**: unchanged; `startupCwd` default remains the primary root.
- **Secrets**: `/api/vault/identity|recipient` stay bound to the primary
  keyring. Age fences in secondary docs are redacted/indexed safely by their
  own stack (the fence grammar is per-stack code, nothing to do); the browser
  encrypts new blocks to the primary recipient and decrypts with the primary
  identity wherever the doc lives — consistent, and blocks created in-app
  always unlock. A secondary vault carrying its OWN committed keyring is not
  unlockable in-app in v1 (the ordinary wrong-key failure path answers).
- **App-level settings** (theme, density, editor, secrets policy, ai,
  terminal): the primary's `settings.toml` via `/api/settings`, unchanged. A
  secondary vault's `settings.toml` is loaded by its own `Settings` (heals,
  absorbs credentials, serialises comments — all existing behaviour) but the
  app consumes only its `git` and `trash` sections; the rest rides along
  untouched for whatever other install uses that repo as ITS primary.

### 12. Documentation (same change, `bun run lint:docs` green)

- **`docs/specs/done/0002-http-api-v0.md`**: amend `GET /api/docs`, doc-path
  conventions (the `@<id>/` grammar + reserved `@` segment), search, trash;
  add a `### Vaults` section with the five routes and error codes; amend the
  Events section (`vaults-changed`, `sync-status.vault`, qualified
  `doc-changed` paths).
- **New ADR `docs/decisions/0018-vaults-are-a-prefix.md`** (promoted by
  `/implement`): the durable rules — one primary vault with today's bare
  paths and all app-level state; secondary vaults are `@id/`-prefixed,
  filesystem-registered, per-vault stacks; `@` is a reserved path segment;
  content never carries the prefix; disconnect never deletes.
- **`docs/architecture.md`**: `vaults.ts` row, updated layering line, env
  vars. **`scripts/lint-docs.ts`**: layer law gains `vaults` between
  `ai docs` and `index`.
- **`docs/glossary.md`**: **primary vault**, **secondary vault**, **vault
  id**, **add / disconnect** (a vault; *banned:* "detach" for vaults —
  "attach" stays the remote-connection verb, "mount", "workspace").
- **`AGENTS.md`**: layout line for `vaults.ts` + the vaults home; keep ≤ 100
  lines.

## Testing Decisions

Black-box, imitating `tests/gitsync.test.ts` conventions (`startServer`,
`makeVault`, bare `file://` fixtures, `git.autoSyncSeconds: 2`, `waitUntil`).
New file `tests/multivault.test.ts`; bare-minimal browser additions only.

1. **Unsynced default label**: fresh server → `GET /api/docs` `vaults[0]` has
   `id:"vault"`, `label:"vault (unsynced)"`, `prefix:""`, `tree` mirroring the
   legacy `tree` key byte-for-byte.
2. **Add vault**: `POST /api/vaults` with a populated bare fixture → 201;
   `vaults[1].label` = repo name; its `tree` paths `@`-qualified; the docs
   GET/PUT round-trip through `@id/...`; `PUT` schedules a commit that lands
   in the SECOND bare repo and never in the first (and a primary-doc PUT
   never lands in the second) — the isolation assertion is the heart of the
   suite.
3. **Per-vault settings**: `PUT /api/vaults/{id}/settings {git:{autoSync:
   false}}` → that vault stops auto-committing while the primary still does;
   settings echo shows the change; non-git keys → 400.
4. **Grammar**: `@unknown/x.md` → 404; `POST /api/docs {path:"@zzz/new.md"}`
   unknown vault → 404; creating `@x/a.md` as a literal primary folder →
   400 `bad-path`; `PATCH` cross-vault → 400 `bad-path`.
5. **Search**: same slug in both vaults → results carry both, qualified,
   limit respected.
6. **Trash**: delete `@id/doc.md` → aggregate `GET /api/trash` entry with
   `vault`, qualified `id`/`path`; restore through the qualified id lands the
   doc back; `purge {all:true}` empties both vaults.
7. **Disconnect**: `DELETE /api/vaults/{id}` → 204; gone from `/api/vaults`;
   directory still on disk with `.git` intact; `DELETE /api/vaults/vault` →
   400 `primary-vault`.
8. **Add-vault rollback**: unreachable URL → 502 `attach-failed`; the vaults
   dir contains no leftover directory; duplicate remote / duplicate id → 409
   `exists`.
9. **Boot scan**: restart the server on the same vaults dir → the vault is
   back, docs indexed, label right. A junk-named subdir is skipped with a
   stderr note and no crash.
10. **Credential hygiene**: add with an explicit token over `file://` — token
    in no response body and not in `<dir>/.git/config` (reuse gitsync's leak
    assertions); primary-token copy happens when body omits `token`.
11. **SSE**: `sync-status` frames carry `vault`; a secondary edit emits
    `doc-changed` with the qualified path; add/remove emit `vaults-changed`.
12. **Browser (one test)**: two-vault fixture → two vault rows, both
    expanded; a sibling file and folder inside one vault have equal
    `paddingLeft`; a `.children` box exposes the guide `::before` (assert
    `--guide-x` inline property present); collapsing a vault row hides its
    children.

Existing suites must pass unchanged — the primary vault's contract is
untouched by construction. `bun run gates` before every commit.

## Out of Scope

- **Per-vault keyrings / secrets unlock** — v1 uses the primary keyring
  everywhere (§11); a follow-up spec owns multi-identity UX.
- **AI relay across vaults** — context, FTS and proposals stay primary-only;
  a secondary doc chats without doc context.
- **Cross-vault moves/links** — refused / never resolved by design, not a
  missing feature.
- **Boot provisioning of secondary vaults via env** — `ZNOTES_VAULT_REPO`
  stays primary-only; secondary vaults are added through the API/UI (the
  filesystem registry makes them survive restarts, which covers the
  self-seeding story after first add).
- **Deleting a disconnected vault's directory** — human step, named in the UI.
- **Renaming a vault / changing its remote in place** — disconnect + re-add,
  or ordinary git in the vault (the pipeline honours it), as with the primary.
- **Per-vault app settings** (theme etc.) and per-vault terminal/homeDoc.
- **Multi-tenancy/auth** — the perimeter is unchanged; one user, one process,
  one replica.
- **Drag-and-drop between vaults** — no drag-and-drop exists at all (ADR-level
  choice in tree.js); unchanged.

## Further Notes

- **Why a prefix, not a route namespace**: `@id/` rides through every
  existing doc surface (routes, SSE, search, trash, `/d/` URLs, client state)
  without duplicating the route table or the client funnels, and the primary
  vault's paths — every URL a user has bookmarked, every test — stay valid.
  The cost is one reserved segment character, enforced at `safePath` and the
  scanners so disk and grammar can never disagree.
- **Why the registry is the filesystem**: a registry file or sqlite table
  would be a second source of truth that a git clone/restore of the vaults
  dir silently misses. Directories under `ZNOTES_VAULTS_DIR` are
  self-describing (each carries `.znotes/`), survive restarts and are
  trivially inspectable.
- **Watcher budget**: one recursive `fs.watch` per vault. macOS caps watched
  paths near 4096 per watcher, not per process — a handful of vaults is fine.
- **`vaultEpoch` stays global** (primary index): the client's gap-resync
  compares one number from `hello`; per-vault epochs would complicate the
  protocol for no recovery benefit — a reconnect reloads the whole tree
  anyway.
- **Sweep gotcha for the implementer**: `tests/api.test.ts` contains NUL
  bytes; `grep`/`rg` silently skip it — use `grep -a` (or python) when
  sweeping tests for pinned shapes.
- **Fixture hygiene**: bare fixtures for two remotes must be distinct temp
  dirs; assert commit counts per remote to prove isolation rather than
  greping logs.
- **UI copy**: the tree's vault rows use `label`; the Settings blocks show
  `root` so the "directory stays on disk" promise is concrete.
