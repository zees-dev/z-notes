# Glossary

The domain vocabulary. Use these words — in code, tests, commits, specs. Each
entry lists banned synonyms where drift has happened or is likely.

## The vault and docs

- **vault** — the directory of markdown files that IS the user's data
  (`$ZNOTES_VAULT`). Also the class binding disk I/O to that root
  (`server/vault.ts` `Vault`). *Not* "workspace", "notebook".
- **doc** — a `.md` file in the vault. The unit the API addresses
  (`/api/docs/{path}`). *Banned:* "note", "page", "document" (in code).
- **folder** — a directory in the vault as the tree shows it. *Banned:*
  "directory" in UI-facing strings.
- **tree** — the sidebar's folder/doc hierarchy (`GET /api/docs`).
- **rev** — the opaque content-derived revision of a doc
  (`revOf`, sha256 prefix). Writes may CAS on it; mismatch → `rev-conflict`.
  *Banned:* "version", "etag" (etag exists only for static files).
- **reconcile** — the pass that re-derives sqlite truth from disk
  (`Reconciler`). The fs watcher is only a doorbell; reconcile is the truth.
- **wiki-link / `[[target]]`** — an in-doc link. A **bare slug** resolves only
  while unique; a **path-qualified** spelling (`[[a/b]]`) always names one doc.
  Rewrites on rename are *forced, never cosmetic* (see `tests/links.test.ts`).

## Secrets (SPEC §6)

- **secret block / age fence** — a fenced ` ```age ` block whose body is age
  armor. The server stores/serves it verbatim and never decrypts.
- **armor** — the `-----BEGIN AGE ENCRYPTED FILE-----` ASCII form.
- **redaction** — replacing fence bodies before anything indexed/AI-bound
  (`redact` for FTS, `redactForAi` + placeholder for context).
- **keyring** — `.znotes/identity.age` (passphrase-wrapped identity) +
  `.znotes/vault.pub` (recipient). Committed; the passphrase never leaves the
  browser.
- **secure-context degradation** — over plain HTTP, secrets stay locked and a
  badge explains why; nothing else breaks.

## Sync (SPEC §7)

- **sync** — add → commit → push of the tracked set, debounced; manual via
  `POST /api/sync/now`. Auth is a token fed through GIT_ASKPASS, stored as the
  `git.token` credential.
- **tracked set** — docs + committed `.znotes` meta (`TRACKED_META` in
  `git.ts`); the sqlite index is never committed.
- **attach** — connecting the vault directory to a remote repo
  (`POST /api/sync/remote`, or `ZNOTES_VAULT_REPO` at boot): init if needed,
  set `origin`, fetch, checkout. *Banned:* "clone" (the app never
  clones-into-place — that would refuse a non-empty vault), "link".

## AI relay (SPEC §8)

- **turn** — one user message through the relay: context assembly → upstream
  stream → validated edits → a proposal.
- **proposal** — a validated, diff-carrying edit set offered to the user.
  Lives on the **change stack**, reverted strictly **LIFO** (server-enforced).
  *Banned:* "suggestion", "patch" (as nouns for this).
- **accept / revert / reject** — the only proposal verbs.
- **anchor** — the context line an edit attaches to; matching widens through
  normalization passes (`findAnchor`), never fuzzier than the passes allow.
- **leak guard / canary** — the scrub + refusal layer that keeps armor and
  credentials out of upstream payloads (`ARMOR_CANARY`).
- **degradation ladder / rung** — the ordered fallbacks when the endpoint
  rejects a capability (`ai-endpoint.ts` `LADDER`); **effort** may be walked
  down behind the configured value.
- **probe** — the capability check against the endpoint (boot, settings-save,
  or on demand).

## Terminal (SPEC §13)

- **unlock / session / bearer** — password unlock mints a bearer token; the
  token, not the password, authorizes commands.
- **approval** — a human gate on each AI-originated `run_command`; records are
  **commands** with states (`queued/running/done/rejected`).

## Trash

- **trash entry** — a retained delete, addressed by opaque **trash id**
  (never by former path). **retention** — days before the sweep purges;
  **sweep** — the retention pass (boot, hourly, on-demand, post-delete).

## Infrastructure

- **route table** — the declarative dispatch in `index.ts`; a route entry is a
  one-line delegation to a module.
- **broadcast / `/events`** — the app-wide SSE bus (`doc-changed`,
  `sync-status`, `settings-changed`, `trash-changed`, heartbeat).
- **gates** — the five acceptance suites (`bun run gates`).
- **seam** — a boundary tests go through; prefer the highest existing seam.
