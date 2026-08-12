# 0007 — Bring-your-own vault: decouple the vault from the app repo

## Problem Statement

The app is designed as "a view over a directory of markdown files", and in
production it already is one: the k3s deployment mounts a PVC at `/vault`
(`ZNOTES_VAULT=/vault`), `server/git.ts` treats the vault as **its own git
repository** (verified via `git rev-parse --show-toplevel`), and nothing in the
image contains notes. But the source repo still couples the two:

1. **The development vault is committed to the app repo.** `git ls-files vault`
   lists 13 files — real notes, `vault/.znotes/settings.toml`,
   `vault/.znotes/vault.pub`, and `vault/.znotes/identity.age` (the
   passphrase-wrapped vault key). The app cannot be open-sourced while the
   repo's tree and history carry the author's vault.
2. **Nothing can ever provision a vault repo.** `git.ts` deliberately never
   runs `git init` — an un-initialised vault is a fully working offline vault —
   but the flip side is that "bring your vault repo" requires manual git
   surgery on the server's filesystem: `git init`, `remote add`, fetch,
   checkout, all by hand (this is how the production PVC was seeded). A fresh
   deployment cannot self-seed from an existing vault repo, and a user cannot
   connect a repo from the UI.

The goal: the app repo contains only the app; the vault is any external
directory the user brings — unsynced scratch, an existing folder of markdown,
or a git repo (a notes repo, or even an arbitrary project containing `.md`
files) — attachable to a remote at boot **or** at runtime, after which the
existing sync pipeline keeps it in realtime sync. Doc sync only; the app's own
code never rides in the vault repo.

## Solution

Five moves, one branch:

1. **Untrack `vault/` from the app repo.** `git rm -r --cached vault` (bytes
   stay on disk), add `/vault/` to `.gitignore`. `./vault` remains the
   `ZNOTES_VAULT` default — a gitignored local scratch vault that works fully
   offline, exactly the "temporarily there, unsynced" mode.
2. **A missing vault directory is created at boot.** `mkdir -p` on
   `$ZNOTES_VAULT` before anything else touches it, so a fresh clone +
   `bun run dev` (or an empty PVC) boots into a working empty vault. (Today
   this happens implicitly via `db.ts`'s `mkdirSync(dirname(dbPath))`; make it
   explicit in `server/index.ts` and pin it with a test.)
3. **A new explicit attach operation** — `POST /api/sync/remote` — connects the
   vault directory to a remote repository: initialises a repo if the vault
   isn't one, sets `origin`, fetches, checks out the remote's default branch,
   and hands over to the existing pipeline. Non-destructive and atomic: it
   never overwrites or deletes a local file, and on any failure it rolls back
   everything it created. The pipeline itself still **never** runs
   `git init` — only this user-initiated operation may.
4. **Boot provisioning via env** for headless/container first boot:
   `ZNOTES_VAULT_REPO` runs the same attach when the vault is not already its
   own repo; `ZNOTES_GIT_TOKEN` is absorbed into the sqlite credential store
   (first-run only, same policy as `terminal.password` in settings.toml). A
   fresh PVC + two env vars = a self-seeding deployment.
5. **Settings UI**: a "Repository" row in the Sync section of Settings — URL
   field + Connect button — driving the new endpoint, with errors surfaced in
   place.

Unchanged, and stated as invariants: the secrets machinery (keyring in
`<vault>/.znotes/`, committed with the vault; the server never sees a
passphrase; nothing in `server/` imports `age-encryption`); the tracked set
(only `*.md` + `.znotes` meta + trash — a project repo used as a vault keeps
its code files entirely unmanaged); the credential rule (token only in sqlite,
only via askpass env, never in argv/URLs/config/logs); the single-replica
deployment; the error body shape `{error, message, ...extra}`.

## User Stories

1. As an open-source user, I want to clone the app repo and `bun run dev` into
   a working, empty, unsynced vault, so that the app is usable with zero setup
   and no author data in sight.
2. As an open-source user, I want to point `ZNOTES_VAULT` at any directory of
   markdown I already have, so that my existing notes work offline with no git
   involvement at all.
3. As a user with a vault repo on GitHub, I want to enter its URL (and a token
   in the existing token field) in Settings and press Connect, so that my repo
   is checked out into the vault and stays in realtime sync from then on.
4. As a user connecting to an **empty** remote repo, I want my current local
   docs committed and pushed as the first commit, so that connecting is how a
   vault becomes backed up.
5. As a user connecting to a **populated** remote while my local vault also has
   files, I want non-conflicting local files preserved (then committed and
   pushed by the next sync) and the operation **refused with the exact
   conflicting paths** when a remote file would overwrite a local one, so that
   attach can never destroy a byte of my data.
6. As a user whose attach failed (bad URL, unreachable host, wrong token,
   checkout conflict), I want the vault left exactly as it was — no half-made
   `.git`, no changed origin — and a message naming the problem, so that I can
   fix it and retry.
7. As a self-hoster, I want to deploy the container with a fresh PVC and
   `ZNOTES_VAULT_REPO` (+ `ZNOTES_GIT_TOKEN`), so that the pod clones my vault
   repo on first boot and serves my notes with no manual seeding — and boots
   normally (offline vault, error visible in the sync status) if the remote is
   unreachable, rather than crash-looping.
8. As a self-hoster restarting that pod, I want boot provisioning to be
   idempotent — a vault that is already its own repo is left alone — so that
   env vars are a bootstrap, not an enforcer.
9. As a user who brings a **project repo** (code + some markdown) as the vault,
   I want the app to index and sync only the `.md` files and its own `.znotes`
   meta, and never stage, modify, or delete my other files, so that using it on
   a working repo is safe. (The app will create and commit `.znotes/` inside
   that repo — settings, keyring, trash — which is the documented contract.)
10. As a user with secrets in my vault, I want `.znotes/identity.age` and
    `.znotes/vault.pub` to travel with the vault repo through attach, pull, and
    push, so that unlocking works on every device with the same passphrase and
    the server still never sees plaintext.
11. As a user, I want the attach URL rejected when it carries userinfo
    (`https://user:pw@…`) and the token to appear in no argv, no `.git/config`,
    no log, and no response, so that connecting a repo cannot leak a
    credential.
12. As a user mid-merge (or with a conflicted index / detached HEAD) in my
    vault, I want attach refused with the same "finish or abort it in the vault
    repo" message the sync pipeline gives, so that the app never writes into a
    repo in a state it does not understand.
13. As a user whose vault repo already exists but has no `origin` (or the wrong
    one), I want attach to simply set/replace `origin` — validating it with a
    fetch, restoring the old value on failure — and adopt the currently
    checked-out branch as `git.branch`, so that connecting an existing local
    repo is one call.
14. As the repo owner, I want the app repo to stop tracking `vault/**` while my
    local files stay on disk, so that from this change forward no note, key, or
    vault setting can enter the app repo's history.

## Implementation Decisions

### 1. Repo hygiene (this source repo, same branch)

- `git rm -r --cached vault` — untrack, keep working files.
- `.gitignore`: add `/vault/` (root-anchored; the existing
  `.znotes/index.db*` / `.znotes/trash/` rules stay for any nested vault).
- `AGENTS.md`: layout section gains one line — the vault is external
  (`ZNOTES_VAULT`, default `./vault`, gitignored); update the hard-rules bullet
  list only if a line must change; keep ≤ 100 lines (`bun run lint:docs`
  enforces).
- Do **not** rewrite history in this change (see Further Notes).

### 2. Vault directory creation (`server/index.ts`)

After `const VAULT = resolve(process.env.ZNOTES_VAULT || "./vault")` (line 26),
`mkdirSync(VAULT, { recursive: true })` before `new Index(vault.dbPath)`. Boot
on a nonexistent path must yield a working empty vault.

### 3. The attach operation (`server/git.ts`, class `GitSync`)

New public method, serialized under the existing writer lock exactly like
`commitPaths`:

```ts
async attachRemote(url: string): Promise<
  | { ok: true; branch: string; created: "repo" | "origin" | "none" }
  | { ok: false; status: number; body: { error: string; message: string; paths?: string[] } }
>
```

**URL validation** (a small exported pure function, e.g.
`validRemoteUrl(url: string): string | null` returning a normalized URL or
null): non-empty string ≤ 2048 chars; no whitespace, control chars, or `\0`;
must not start with `-` (argv option injection); allowed shapes are
`https://…`, `http://…`, `file://…`, or an absolute path starting with `/`
(the last two exist for local remotes and the test fixtures). A URL whose
parsed form carries a username or password is rejected — credentials never
enter `.git/config` (same rule as `sanitizeRemote`). Everything else
(`ssh://`, scp-style `git@host:path`, `git://`) → rejected; the escape hatch
is ordinary git config in the vault, which the pipeline already honours.
Invalid → `{status: 400, body: {error: "bad-url", …}}`.

**Case A — the vault is already its own repo** (`observe()` says `repo`):

1. `blockedReason(obs)` non-null → `409 {error: "vault-busy", message: <the
   blockedReason text>}`.
2. Remember the current origin URL. `git remote add origin <url>` (or
   `set-url` if origin exists).
3. Validate with `git fetch origin` (through `transportOpts()`, token passed
   the existing way — env-only askpass). On failure: restore the previous
   origin (or `git remote remove origin` if there was none), return
   `502 {error: "attach-failed", message: gitMessage(...) → cleanMessage(...)}`.
4. Adopt the checked-out branch (when not detached/unborn) as the configured
   branch — returned to the caller as `branch`; the route persists it (below).
   Never checkout, never touch the working tree.

**Case B — the vault is not a repo** (including the nested-inside-another-
checkout case `detectRepo` already reports as "not a git repository"):

1. `git init` in the vault (`--initial-branch=<git.branch setting>`; the
   Dockerfile's Debian git and any git ≥ 2.28 support it). From here, **every
   failure rolls back by deleting the `<vault>/.git` this call just created**
   — nothing else; the vault's files and `.znotes/` are never touched.
2. `git remote add origin <url>`, then `ensureExcludes()` (the
   `.git/info/exclude` rules must exist before anything can be staged).
3. `git fetch origin` (token via askpass env). Failure → rollback → `502
   attach-failed`.
4. Resolve the remote's default branch via `git ls-remote --symref origin
   HEAD` (parse `ref: refs/heads/<name>\tHEAD`). Hold the result to the same
   rules as `validateGit` holds `git.branch`; an unusable name → rollback →
   `502 attach-failed`.
   - **Remote is empty** (no refs): keep the local unborn branch. The first
     sync (triggered by the route, below) stages, commits, and pushes with
     `--set-upstream` — all existing pipeline behavior.
   - **Remote branch exists**: `git checkout -b <name> origin/<name>` (unborn
     HEAD; creates the local branch tracking origin — `branch.autoSetupMerge`
     default). If git refuses because untracked working-tree files would be
     overwritten: parse the indented path list from stderr (best-effort),
     rollback, return `409 {error: "checkout-conflict", message: "…names the
     paths…", paths: [...]}` — key order `error, message, paths` per the ADR
     0002 error-shape rule. Non-conflicting local files simply remain as
     untracked files for the next sync to stage.
5. Return `{ok: true, branch, created: "repo"}`.

The header comments in `git.ts` ("We never `git init`") and
`tests/gitsync.test.ts` change to say: the **pipeline** never inits — attach,
a user-initiated operation, is the one place that may.

### 4. Route + fanout (`server/index.ts`)

Route table entry `POST /api/sync/remote`, body `{url: string}` (parsed with
the existing `readJsonBody`; the global `crossSiteWrite` guard already covers
it). Handler sequence on `attachRemote` success:

1. `await settings.putRoute({ git: { branch } })` — persists the adopted
   branch and reuses the full existing fanout (`applyGit`, `settings-changed`
   broadcast, `scheduleSync`). Note `putRoute` begins with `reloadIfChanged()`,
   which is exactly what adopts a `settings.toml` that just arrived in the
   checkout.
2. `await recon.reconcile()` — the pulled docs are indexed and announced
   (`doc-changed` SSE) before the response, so the tree is immediately
   queryable.
3. `await gitSync.trigger("manual")` — pushes local-only files / the first
   commit, and yields the response body: exactly the `GET /api/sync/status`
   object, mirroring `POST /api/sync/now`.

On `{ok: false}` → respond with `status`/`body` as returned.

### 5. Boot provisioning (`server/index.ts` + `server/settings.ts`)

- **`ZNOTES_GIT_TOKEN`**: absorbed during `Settings.load()` — a new private
  step, first-run only: if the env var is a non-empty string **and** no
  `git.token` credential is stored, `this.index.setCredential("git.token",
  value)` and log one line (never the value). If one is already stored, the
  env var is ignored (rotation happens in the UI; a stale env var must not
  clobber it). Settings remains the sole owner of the credentials table.
- **`ZNOTES_VAULT_REPO`**: after `settings.load()` and `GitSync` construction
  but **before** the boot `recon.reconcile()` and `Bun.serve`: if the env var
  is set and the vault is not already its own repo, run the same sequence as
  the route (attach → `putRoute({git:{branch}})` → fall through to the
  ordinary boot reconcile; the boot `gitSync.start()` observation then reports
  truthfully). Any failure is logged to stderr and boot **continues** — an
  unreachable remote yields a working offline vault whose sync status carries
  the error, never a crash loop. If the vault is already a repo, skip
  entirely (log a note if its origin differs from the env var).

### 6. Frontend (`app/index.html`, `app/settings.js`, `app/api.js`)

In the Settings Sync section, above the existing token field: a "Repository"
row — read-only display of the current `remote` (from the same sync-status the
statusbar chip consumes; "local only" when null), a URL input
(`#gitRemoteUrl`, placeholder `https://github.com/you/vault.git`), and a
Connect button. The button calls a new `api.js` helper (`POST
/api/sync/remote`), disables while in flight, and on success repaints from the
returned status (the `sync-status` SSE frame will also arrive). Errors
(`bad-url`, `vault-busy`, `checkout-conflict`, `attach-failed`) surface their
`message` in the settings error affordance the credential fields already use
(`app/settings.js` ERROR_TARGETS pattern); `checkout-conflict`'s message
already names the paths. No new settings keys; the button is an action, like
"Sync now".

### 7. Documentation (same change)

- **`docs/specs/done/0002-http-api-v0.md`** (the living contract): append a
  `#### POST /api/sync/remote` subsection to § Sync — request `{url}`,
  response = the sync-status object, the four error codes with statuses, and
  the non-destructive/atomic guarantee. Note under `GET /api/sync/status` is
  already correct (`remote: null` ⇒ "local only").
- **ADR `docs/decisions/0017-the-vault-is-bring-your-own.md` already exists**
  (committed with this spec) and is the durable record of these decisions —
  do not write a second one. It links to this spec at its `open/` path, so
  moving this spec to `done/` requires updating that link in the same change
  (`bun run lint:docs` fails on the stale link otherwise). Add the 0017 line
  to the ADR list in `AGENTS.md`'s docs-taxonomy paragraph. Security
  model, extending ADR 0006: the committed keyring means a vault repo's
  secrecy rests on the passphrase's strength and the repo's visibility — both
  the user's choice, neither enforced or warned about by the app beyond the
  existing entropy advice at passphrase creation.
- **`docs/glossary.md`** § Sync: add **attach** — connecting the vault
  directory to a remote repo (`POST /api/sync/remote` or `ZNOTES_VAULT_REPO`);
  *banned:* "clone" (the app never clones-into-place), "link".
- **`docs/architecture.md`**: git.ts row mentions attach; document the two new
  env vars wherever `ZNOTES_VAULT`/`ZNOTES_PORT` are listed.
- **`deploy/README.md`**: the fresh-PVC self-seeding recipe (two env vars);
  note the token env can be dropped after first boot.
- **`AGENTS.md`**: as in §1.

### 8. Invariants that must visibly survive (state them in code comments only
where a comment already exists)

- Token: only ever in the spawned child's env (`GIT_ASKPASS`); `attachRemote`
  passes it exclusively through the existing `git(args, {token})` path.
- `server/` still never imports `age-encryption` (`tests/secrets.test.ts`
  enforces); the AI relay still has no rename/delete route
  (`tests/fileops.test.ts` greps).
- The sqlite index is never committed: `ensureExcludes` runs before any
  attach-initiated staging, and `guardIndexDb` still gates every commit.
- Layering: attach lives in `git.ts` (layer 3); no new server module; route is
  a one-line delegation in `index.ts` (layer 5). `bun run lint:docs` stays
  green.

## Testing Decisions

One seam, already established: **black-box HTTP against a spawned server with
local bare-repo fixtures** — extend `tests/gitsync.test.ts` and imitate its
own conventions (`startServer` from `tests/helpers.ts`, `makeVault`, bare
"origin" repos in temp dirs reached over file paths, `git.autoSyncSeconds: 2`,
`waitUntil` on status). No network, no real credentials. `startServer` already
accepts `env` and `vault` overrides — boot-provisioning tests need nothing
new. Browser tests: none (the Connect button is a thin `fetch` over the same
endpoint; bare-minimal per the repo's standards).

Tests to write (names indicative):

1. **attach: non-repo vault → empty bare origin**: 200; response is a
   sync-status object; `git remote get-url origin` in the vault equals the
   URL; the bare repo gains ≥ 1 commit containing the seeded docs;
   `GET /api/settings` shows the adopted branch.
2. **attach: non-repo vault → populated origin** (fixture repo with docs +
   a committed `.znotes/settings.toml`, pushed to bare): 200; `GET /api/docs`
   lists the remote docs; a setting from the pulled `settings.toml` (e.g.
   `theme`) is served; a non-conflicting pre-existing local doc survives and
   reaches the bare repo via the triggered sync.
3. **attach: checkout conflict**: local `foo.md` (different bytes) vs remote
   `foo.md` → 409 `checkout-conflict`, `paths` includes `foo.md`, message
   names it; `<vault>/.git` does not exist afterward; local `foo.md` bytes
   byte-identical to before.
4. **attach: existing repo, origin replacement + rollback**: vault already a
   repo with origin A; attach to unreachable URL → 502 `attach-failed`,
   origin still A; attach to reachable bare B → 200, origin is B, working
   tree untouched.
5. **attach: refusals** — `bad-url` for userinfo-bearing URL, scp-style
   string, `-`-prefixed string (400 each); `vault-busy` (409) for a mid-merge
   fixture (reuse the existing conflicted-repo fixture pattern).
6. **credential hygiene**: with a `git.token` stored, attach over a `file://`
   remote; assert the token appears nowhere in `<vault>/.git/config` and in no
   response body (prior art: the token-leak assertions already in
   `tests/gitsync.test.ts`).
7. **boot provisioning**: `startServer({vault: emptyDir, env:
   {ZNOTES_VAULT_REPO: <bare path>}})` → first `GET /api/docs` lists the
   remote docs; restart the server on the same vault with the same env →
   boots clean, no duplicate work, status `synced`. Unreachable
   `ZNOTES_VAULT_REPO` → server still reaches its ready line and serves an
   offline/error status.
8. **env token absorb**: `ZNOTES_GIT_TOKEN` set + nothing stored →
   `GET /api/settings` shows a non-empty `git.tokenMasked`; set + something
   already stored → stored one wins (masked value unchanged).
9. **boot on missing vault dir**: `startServer` with a nonexistent
   `ZNOTES_VAULT` path → ready line, empty tree, PUT/GET of a doc works.

Update the `tests/gitsync.test.ts` header comment ("The server never runs
`git init`") to the amended rule; every existing test in that file must pass
unchanged — the auto-sync pipeline's behavior is untouched.

## Out of Scope

- **SSH remotes** (`ssh://`, scp-style, deploy keys) — rejected by validation;
  users configure those with ordinary git in the vault and the pipeline
  honours them, exactly as today.
- **A detach/disconnect API** — `git remote remove origin` in the vault is the
  documented path (settings.toml's git section doc already says the remote is
  ordinary git config).
- **History rewrite of the app repo** — untracking stops the bleeding; purging
  `vault/**` from past commits (or starting a fresh public repo) is a separate,
  human decision. See Further Notes.
- **Welcome/demo vault content, first-run wizards, onboarding UI.**
- **Multi-vault, vault switching at runtime, multi-tenancy** — one process,
  one `ZNOTES_VAULT`, unchanged.
- **Changing the tracked set** — non-markdown files in a brought repo stay
  unmanaged; no attempt to sync attachments/binaries.
- **Auth on the new endpoint beyond the existing perimeter** — SPEC §10's
  cluster/tailnet perimeter plus the existing `crossSiteWrite` guard; no
  password gate (the terminal's gate is not a precedent here).
- **Cloning-into-place semantics** (`git clone` into the vault dir) — the
  init+fetch+checkout shape is deliberate: it works with a non-empty vault and
  keeps `.znotes/index.db` (credentials) alive through attach.
- **Re-attaching when `ZNOTES_VAULT_REPO` changes** on an already-attached
  vault — env provisioning is first-boot bootstrap only.
- **Open-sourcing chores** (LICENSE, public README, CI publishing) — separate
  change.

## Further Notes

- **History still contains the vault.** After this change the app repo's
  *history* still carries every previously committed note and
  `vault/.znotes/identity.age`. The notes are reason enough to start a fresh
  public repo or rewrite history before publication. The identity is
  passphrase-wrapped (scrypt logN=18); per the security model above, whether
  an exposed wrapped identity is a problem is a function of the passphrase's
  strength, and judging that is the owner's call. Human steps, deliberately
  not part of the implementation.
- **Pre-open-source generalisation worth a follow-up spec**: `DEFAULTS.ai` in
  `server/settings.ts` points at the author's own AI-proxy endpoint — harmless
  (it's just a default) but worth neutralising before publication. (Done: it
  now defaults to `https://api.openai.com/v1`.)
- **Why attach adopts the remote's default branch** rather than forcing
  `git.branch`: the pipeline refuses to push when the checked-out branch and
  `git.branch` disagree ("committed locally, not pushed"). Adopting at attach
  time is what keeps a brought `master`-headed repo from landing in that
  refusal on its first sync.
- **A brought project repo gets a `.znotes/` directory committed into it**
  (settings.toml, keyring, trash) and z-notes-managed rules appended to its
  `.git/info/exclude` (per-clone, invisible to the repo). Sync commits
  (`sync: <ISO> · n file(s)`) will appear in its history for `.md` changes.
  That is the contract, stated in ADR 0017 — not a bug to soften.
- **Ordering trap for the implementer**: boot provisioning must run before the
  boot `recon.reconcile()` (server/index.ts:774) so the first index pass sees
  the checked-out docs, and `Settings.load()`'s env-token absorb must run
  before any attach fetch needs the token.
- **The k3s deployment needs no manifest change** — the env vars are optional;
  add them (and the `GIT_CONFIG_*` note applies unchanged) only when seeding a
  fresh PVC. Single replica remains a correctness constraint.
