# 0002 — HTTP/SSE API v0 — the normative contract

> Founding document, retrofitted into the spec template when the repo adopted
> the agent-first shape (ADR 0001 era). Archived here as a completed spec:
> staleness is harmless, durable decisions live in `docs/decisions/`.

## Problem Statement

The frontend, tests and any future client need one exact, versioned description of every route, body, error shape and SSE event — precise enough that the backend can be replaced without the frontend noticing.

## Solution

A v0 contract: JSON bodies, opaque doc revs with 409 CAS conflicts, stable error slugs in `{error, message, ...extra}` bodies, and an SSE bus. The full contract is under Implementation Decisions; ADR [0002](../../decisions/0002-http-api-v0-error-shape.md) records its durable rules.

## User Stories

1. As the frontend, I want every route's request/response shape fixed, so that `api.js` is the only file that knows HTTP.
2. As the test suite, I want error slugs and key order stable, so that black-box assertions can compare serialized bytes.
3. As a future client (phone, CLI), I want the contract self-sufficient, so that I can implement against this document alone.

## Implementation Decisions

The contract, verbatim (headings demoted one level):

The frontend in `app/` talks to **nothing but this contract**. `api.js` is the
only file that opens a socket; the rest of the frontend has no `fetch`. Anything that
serves these routes can sit behind it — the bun backend is the implementation, and the
frontend does not change if the implementation does.

### Conventions

- **Base.** Every path below is relative to an API root — `/` in production
  (so `GET /api/docs`); `api.js` resolves paths against `new URL('./', import.meta.url)`,
  so the contract survives being served from a sub-path.
- **Encoding.** Requests and responses are `application/json; charset=utf-8` unless stated.
  Markdown travels as a JSON string field, never as a raw body.
- **Doc paths** are vault-relative POSIX paths without a leading slash
  (`architecture/z-notes-design.md`). Each segment is percent-encoded in the URL; `/`
  separators are not. Path traversal (`..`, absolute, escaping the vault) is `400`.
- **Vaults and the `@` prefix** (ADR 0018). The server hosts one **primary vault** (id
  `vault`) and any number of **secondary vaults**. A primary-vault doc path is the bare
  path above and always has been. A secondary-vault doc path is `@<id>/<rel>`, where
  `<id>` matches `^[a-z0-9][a-z0-9-]{0,39}$` and `<rel>` is an ordinary vault-relative
  path — `@work-notes/inbox.md`. Every doc surface speaks this one grammar: `/api/docs/*`,
  `GET /api/search` hits, `GET /api/trash` entries, `doc-changed` frames and `/d/{path}`
  URLs. An unknown id is `404 {"error":"not-found"}`; a move whose two ends resolve to
  different vaults is `400 {"error":"bad-path"}`.
- **`@` is a reserved segment.** A path segment starting with `@` is refused by the same
  guard that refuses `..` and dot-prefixed segments, and the vault scan skips such
  directories on disk. Consequence, stated so no client has to discover it: **a vault can
  never contain a doc whose path collides with the vault grammar** — `@x/a.md` is not a
  creatable primary-vault path, only an address into vault `x`. Inside a vault nothing
  carries the prefix: markdown, `[[links]]` and the git repository are vault-relative, so
  a vault repo is portable and a link never resolves across vaults.
- **Revisions.** Every doc carries an opaque `rev` string. Writes may pass the `rev` they
  read; a mismatch is `409` (`{"error":"rev-conflict"}`) and the client must re-read.
  Omitting `rev` is a forced overwrite.
- **Errors** are `{"error": "<slug>", "message": "<human text>", ...detail}` with a non-2xx
  status. Slugs are stable; messages are not.
- **Body size.** A JSON request body larger than 8 MiB is refused with
  `413 {"error":"too-large","limit":8388608}` on every write route. A note is text a human
  typed; the index stores each document twice (row + FTS shadow) inside the vault, so an
  unbounded body is a disk and memory cost with no legitimate caller.

### Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created (`POST /api/docs`) |
| 204 | No content (`DELETE /api/docs/{path}`) |
| 400 | Malformed request — bad JSON (`bad-json`), a body that is not the expected shape (`bad-body`), bad path, missing field |
| 404 | No such doc / session / proposal |
| 409 | Conflict — `rev-conflict`, `exists`, `not-stack-top`, `already-applied` |
| 413 | Too large — request body over 8 MiB, or an `identity` over 64 KiB |
| 422 | Semantically invalid — e.g. an edit whose anchor no longer matches the file |
| 500 | Server fault |

---

### Docs

Every route in this section takes a doc path under the grammar in
[Conventions](#conventions), qualified or not. A qualified path is resolved to its vault
and then behaves identically inside it — CAS, implicit parents, the one-commit move with
its backlink rewrites, canonical spelling. The reply re-qualifies whatever it echoes
(`path`, `from`, `updated[]`, `moved[]`), so a client that reads paths out of responses
never has to know which vault it is in.

#### `GET /api/docs`

The vault tree. Folders carry children; files carry metadata only, never content.

```json
{
  "vault": { "name": "z-notes", "root": "~/vault", "docCount": 7 },
  "tree": [
    { "type": "file", "path": "inbox.md", "name": "inbox.md", "title": "inbox.md",
      "slug": "inbox", "bytes": 0, "mtime": "2026-08-01T00:12:04.000Z", "empty": true },
    { "type": "folder", "path": "architecture", "name": "architecture", "open": true,
      "children": [
        { "type": "file", "path": "architecture/z-notes-design.md", "name": "z-notes-design.md",
          "title": "z-notes design", "slug": "z-notes-design", "bytes": 812,
          "mtime": "2026-08-01T00:12:04.000Z", "empty": false, "hasSecrets": false }
      ] }
  ]
}
```

`slug` is what `[[wiki-links]]` resolve against. `open` is the server's remembered
disclosure state — advisory; the client may override it locally.

*Additive:* `vaults` lists every vault, primary first then by id. `vault` and `tree` are
unchanged and describe the **primary vault only**, so a single-vault client needs no edit.

```json
{
  "vault": { "name": "z-notes", "root": "~/vault", "docCount": 7 },
  "tree":  [ "…primary tree, exactly as above…" ],
  "vaults": [
    { "id": "vault", "label": "vault (unsynced)", "root": "~/vault", "docCount": 7,
      "remote": null, "repo": false, "prefix": "",
      "sync": { "state": "offline", "…": "the GET /api/sync/status object" },
      "tree": [ "…the same nodes as \"tree\"…" ] },
    { "id": "work-notes", "label": "work-notes", "root": "~/vaults/work-notes",
      "docCount": 3, "remote": "github.com/z/work-notes", "repo": true,
      "prefix": "@work-notes/",
      "sync": { "state": "synced", "…": "…" },
      "tree": [ { "type": "file", "path": "@work-notes/inbox.md", "…": "…" } ] }
  ]
}
```

A secondary vault's `tree` carries **qualified** paths throughout, so a client uses them
verbatim wherever it uses a doc path. `prefix` is `""` for the primary and `@<id>/`
otherwise — prepend it rather than rebuilding the grammar. `label` is the display name:
the last segment of the sanitized remote when there is one, else the directory's basename,
else `<basename> (unsynced)` when the directory is not a git repository at all. `sync` is
the vault's last known sync status — a snapshot, never a git spawn per tree request.

#### `GET /api/docs/{path}`

```json
{
  "path": "architecture/z-notes-design.md",
  "name": "z-notes-design.md",
  "title": "z-notes design",
  "slug": "z-notes-design",
  "markdown": "# z-notes design\n\n…",
  "rev": "r7",
  "bytes": 812,
  "mtime": "2026-08-01T00:12:04.000Z",
  "hasSecrets": false
}
```

`404 {"error":"not-found"}` for an unknown path.

#### `PUT /api/docs/{path}`

```json
{ "markdown": "# z-notes design\n…", "rev": "r7" }
```

→ `200 { "path": "...", "rev": "r8", "bytes": 830, "mtime": "..." }`

`409 {"error":"rev-conflict","rev":"r9"}` when `rev` is stale. Emits `doc-changed` on
`/events` to every client (including the writer — compare `rev` to your own to ignore your
echo). Also nudges sync into `syncing` and back to `synced`.

#### `POST /api/docs`

Create a doc or a folder.

```json
{ "path": "projects/new-note.md", "type": "doc", "markdown": "" }
```

`type` is `"doc"` or `"folder"`. → `201` with the same body shape as `GET /api/docs/{path}`
(folders return `{"type":"folder","path":…,"name":…}`). Emits `doc-changed` with `"reason":"created"`.

**Parent folders are created implicitly, for both types** — `POST {"path":"a/b/c.md"}` makes
`a` and `a/b` on the way, `POST {"path":"a/b/c","type":"folder"}` makes `a` and `a/b`. If the
create then fails, those implicit folders are removed again with `rmdir` semantics: a folder
that has anything at all in it is kept, so a concurrent create inside one is never destroyed
and nothing that predates the request can be removed by it. The vault is never left holding a
tree of empty directories nobody asked for.

Refusals — nothing is written by any of them:

| | |
|---|---|
| `409 {"error":"exists"}` | the target doc or folder is already there. **`.md` is never overwritten by a create**; use `PUT /api/docs/{path}` to write an existing doc. |
| `409 {"error":"exists"}` | an intermediate segment is an existing **file** (`readme.md/x.md`) — message names the blocker: `readme.md is a doc, not a folder.` |
| `400 {"error":"bad-path"}` | the path escapes the vault, touches `.znotes/`, or carries an empty / `.` / `..` / dot-prefixed segment (`safePath`). |
| `400 {"error":"bad-path"}` | the name carries `]` or a line break. The same guard `PATCH` applies to its destinations: such a name cannot survive the `[[link]]` a later rename would splice it into, so it must not be creatable either. |

A doc path gets `.md` appended if it lacks it, so `{"path":"a/b/c"}` with `type:"doc"` creates
`a/b/c.md` and the reply names the `.md` path.

#### `PATCH /api/docs/{path}` — rename / move *(SPEC §3 delta 2)*

```json
{ "to": "archive/2026/z-notes-design.md" }
```

Renames **or** moves — they are the same operation and the server tells them apart from
the path alone. `{path}` may be a doc **or a folder**; a folder takes its whole subtree
(including non-`.md` files) with it. The move is one `rename(2)`, so bytes are never
rewritten and the round-trip stays lossless.

**Every `[[link]]` that resolved to a moved doc is rewritten across the whole vault, and
the move plus all the rewrites are ONE git commit** (`move: <from> → <to>`).

→ `200`

```json
{ "type": "file", "path": "archive/2026/z-notes-design.md",
  "from": "architecture/z-notes-design.md",
  "rev": "9c1d…", "bytes": 812, "mtime": "2026-08-01T00:12:04.000Z",
  "backlinksUpdated": 3,
  "updated": ["inbox.md", "projects/homelab.md", "reading.md"] }
```

`backlinksUpdated` counts rewritten **link occurrences**; `updated` lists the docs that were
rewritten (never including the moved doc's own path unless its own text changed). A folder
move answers `"type":"folder"` with `rev`/`bytes`/`mtime` `null` plus
`"moved":[{"from":…,"to":…}]` — one entry per `.md` in the subtree.

| Status | When |
|---|---|
| `400 bad-path` | `to` traverses out of the vault, names a `.` segment (`.znotes/`), is not `.md` for a doc, or moves a folder inside itself |
| `400 bad-path` | `{path}` and `to` resolve to different vaults — `A move cannot cross vaults.` (ADR 0018) |
| `404 not-found` | nothing at `{path}`, or it is a file that is not a `.md` doc |
| `409 exists` | `to` is taken, or a path segment of `to` is a doc rather than a folder |
| `500 move-failed` | the write phase failed; **every file already touched was rolled back** and the vault is exactly as it was |

**Link semantics the rewrite obeys** (SPEC §5). `[[slug]]` resolves by unique filename slug
vault-wide; `[[path/slug]]` is the disambiguating form; a slug carried by two docs resolves
to *neither*. For each link occurrence the server asks what it resolved to **before** and
whether that spelling still resolves to the same doc **after**:

- a link that was already broken or ambiguous is **never** touched — a move does not repair
  links it did not break;
- a link that still resolves to the same doc is left **byte-identical**, so an unrelated
  rename never reformats path-qualified links elsewhere in the vault;
- otherwise it is rewritten to the *shortest* spelling that resolves to the destination.

That last rule is symmetric, which is what makes collisions work in both directions:
renaming `a/bar.md` → `a/foo.md` while `c/foo.md` exists rewrites `[[bar]]` → `[[a/foo]]`
**and** every `[[foo]]` that meant `c/foo.md` → `[[c/foo]]` (bare `foo` is now ambiguous),
including in docs that had nothing to do with the rename; the inverse rename turns
`[[a/foo]]` back into `[[baz]]` while leaving `[[c/foo]]` alone.

Links inside ` ```age ` fences, inside ordinary code fences and inside inline code are
**never** rewritten — a note that documents its own link syntax survives any rename byte for
byte, and ciphertext is never edited.

Emits the `doc-changed` pair described under [Events](#events) for every moved path, plus
`"reason":"write"` for every doc whose links were rewritten.

#### `DELETE /api/docs/{path}`

→ `204`, no body. Moves a doc, or a folder and everything under it, to a
self-describing entry below `.znotes/trash/<id>/`. The departure and retained copy land in
one git commit (`delete: <path>`); the bytes are moved with `rename(2)`, not decoded or
rewritten.

**Human-only, structurally.** SPEC §8 gives the assistant no delete and no rename:
`propose_edits` accepts exactly `replace | insert_after | create | rewrite`, and nothing in
the AI relay can reach this route. The UI additionally requires an explicit confirmation.

Backlinks to a deleted doc are **not** rewritten: they become broken links, which the
preview flags with a create-doc affordance. Rewriting them would erase the only record that
something used to be there. Restoring the entry makes those links resolve again.

`404 not-found` when there is nothing at `{path}` (or it is a non-`.md` file);
`500 delete-failed` if the removal itself fails. Emits `doc-changed` with
`"reason":"deleted"` and `"removed":true` for every doc that left the vault.

---

### Trash

The trash is outside the document namespace. Its payload lives under `.znotes/trash/`,
which the vault scan, search, backlink graph and AI context all exclude. Each entry has an
opaque id, a `meta.json` record, and a `files/` subtree mirroring its original vault path.

Every vault has its own trash, under its own `.znotes/trash/`, and the routes below present
them as one. A `{id}` may be bare (the primary's) or qualified `@<vault>/<id>` (a
secondary's); the id is validated against its vault's trash after the prefix is resolved,
so a malformed id is still `400 bad-id` and never a path (an unknown vault prefix is
`404 not-found`).

#### `GET /api/trash`

```json
{
  "retentionDays": 7,
  "entries": [
    {
      "id": "m7k2x9-4f1a8b3c",
      "path": "projects/homelab.md",
      "name": "homelab.md",
      "kind": "doc",
      "deletedAt": "2026-08-05T01:02:03.000Z",
      "bytes": 812,
      "docCount": 1,
      "fileCount": 1,
      "purgeAt": "2026-08-12T01:02:03.000Z",
      "expired": false,
      "complete": true,
      "restorable": true,
      "blockedBy": null,
      "vault": "vault"
    }
  ]
}
```

Newest deletion first. `retentionDays` is the live value of
`settings.trash.retentionDays`; `purgeAt` is derived from it on every read. A path occupied
since the deletion reports `restorable:false` and names that path in `blockedBy`.

*Additive:* the view is **aggregated across every vault** — one trash drawer, not one per
vault. Each entry names its vault in `vault`, and an entry from a secondary vault carries a
qualified `id` **and** `path` (`"id": "@work-notes/m7k2x9-4f1a8b3c"`,
`"path": "@work-notes/projects/homelab.md"`), so the id in the list is the id the
`trash/{id}` routes below take. Sorting is newest-first across all vaults. Retention is
per-vault; the top-level `retentionDays` is the primary's, and each entry's own `purgeAt`
already carries the truth for that entry.

`GET /api/trash/{id}` returns one entry in the same shape or `404 not-found`.

#### `POST /api/trash/{id}/restore`

Restores the exact payload to its original path, creating missing ancestor folders. It
never overwrites: `409 restore-blocked` names the path occupying the destination (or an
ancestor that is now a file), and the trash remains untouched. A folder restore brings its
markdown and non-markdown payload back together. → `200` with the restored `path`, `kind`,
doc paths, and doc metadata when the entry itself is a doc. Emits `doc-changed` with
`"reason":"restored"` for every restored doc, then `trash-changed`.

#### `DELETE /api/trash/{id}`

Permanently removes one retained entry. → `204`, no body. There is no restore or undo after
this route. Emits `trash-changed`.

#### `POST /api/trash/purge`

With no body (or `{}`), applies the retention policy now. With `{"all":true}`, permanently
empties the trash including entries whose window has not expired. →
`200 {"purged":["<id>",…],"retentionDays":7,"all":false|true}`. Both forms fan out to every
vault, and `purged` carries qualified ids for entries that came from a secondary one.

The same retention sweep runs at boot, after every delete, immediately after a retention
change, and hourly while the server is alive. `trash.retentionDays` defaults to 7 and is
bounded to 1–365 days; zero never means “delete immediately”.

---

### Secrets

Decryption is client-side (SPEC §3 delta 1): no passphrase ever reaches the server. Every
`/api/secrets/*` request answers `404 {"error":"secrets-client-side"}` — a stable slug
clients branch on. The client uses the vault keyring routes below plus a crypto Web Worker.

#### The vault keyring

Three routes. They move **ciphertext and a public key,
nothing else**: the identity arrives already encrypted under the user's passphrase (age
scrypt recipient, logN=18, done in the browser), and the server never decrypts, never
derives a key and never sees a passphrase or a plaintext. Validation is shape-only.

The two files these routes own — `.znotes/identity.age` and `.znotes/vault.pub` — are part
of the committed set (SPEC §7); a successful `PUT` schedules a sync so the new keyring is
committed like any other change.

##### `GET /api/vault/identity`

→ `200 text/plain; charset=utf-8` — the ASCII-armored contents of `.znotes/identity.age`,
verbatim, ending in a newline. This is the **only** non-JSON success body in the contract:
the client hands the armor straight to its crypto worker, and a JSON wrapper would just be
one more place to re-encode it. Errors are JSON as usual.

→ `404 {"error":"no-identity"}` when the vault has no identity yet. A client must read this
route **and** `GET /api/vault/recipient` before deciding what that means, because neither
answer implies the other: a 404 here with a 404 there is an empty vault and the client
offers to create one; a 404 here with a `200` there is a keyring missing its private half,
which `PUT` will refuse with `409 exists` — so "offer to create one" would be a dead end
(SPEC §6). It is never a failure of the route.

##### `GET /api/vault/recipient`

```json
{ "recipient": "age1hrn8rnnreh22tzvz7m9x42crd2vxjfxe6aqustzncaprt5sq650std0rv0" }
```

The `age1…` X25519 public key from `.znotes/vault.pub`. Public by construction — this is
what lets a client encrypt a **new** secret block while the vault is still locked.
`404 {"error":"no-identity"}` if absent.

##### `PUT /api/vault/identity`

```json
{ "identity": "-----BEGIN AGE ENCRYPTED FILE-----\n…", "recipient": "age1…", "replace": false }
```

Writes both files (each rename atomic; the identity lands first). → `201 {"recipient":…,
"replaced":false}` on first creation, `200 …"replaced":true` when replacing.

| Status | When |
|---|---|
| `400 bad-identity` | `identity` is not age ASCII armor (header, footer, base64 body) |
| `400 bad-recipient` | `recipient` is not an `age1…` bech32 key |
| `409 exists` | a keyring is already present and `replace` is not exactly `true`; the body echoes the current `recipient` |
| `413 too-large` | `identity` exceeds 64 KiB — a wrapped X25519 identity is ~500 bytes |

There is deliberately **no** endpoint that accepts a passphrase, a plaintext, or an
unwrapped identity. That absence is the leak rule (SPEC §11): the server has no vocabulary
for the things it must never see.

**Changing the vault passphrase uses this route and nothing else** (SPEC §6, research §5.3).
The client unwraps `identity.age` in the crypto worker with the current passphrase, re-wraps
the *same* identity under the new one (fresh scrypt salt, logN=18), and `PUT`s the result with
`replace: true` and the **unchanged** `recipient`. From the server's side it is an ordinary
replace of one opaque string by another: the passphrase never appears in a request, and
`recipient` is identical before and after — which is the wire-level tell that the vault key
was *not* rotated and no block needs re-encrypting.

#### `GET /vendor/age.js` *(asset, not an API route)*

The `age-encryption` (typage) browser bundle, built in memory at server start from
`vendor/age-entry.js` and served to the crypto worker. `/vendor/age.js` is a `302` with
`cache-control: no-cache` to `/vendor/age.<hash>.js`, which carries an `ETag` and
`cache-control: public, max-age=31536000, immutable`; the hash covers the lockfile and the
entry source, so a dependency bump changes the URL. `503 {"error":"vendor-unavailable"}` if
the bundle failed to build — the client then disables secrets features and says why.

---

### Search

#### `GET /api/search?q=&limit=`

Fuzzy (subsequence) match over doc paths **and** content lines. Scoring, snippet windowing
and the match indices are the server's job so every client highlights identically.

```json
{
  "query": "sse",
  "results": [
    { "kind": "doc",  "path": "architecture/event-pipeline.md", "name": "event-pipeline.md",
      "text": "architecture/event-pipeline.md", "matches": [13, 14, 15], "score": 41.2 },
    { "kind": "line", "path": "architecture/event-pipeline.md", "name": "event-pipeline.md",
      "line": 7, "text": "- [ ] Push change to open editors via SSE",
      "matches": [37, 38, 39], "score": 33.9 }
  ]
}
```

`line` is 0-based. `matches` are character offsets into `text`. `limit` defaults to 24.
An empty `q` returns every doc as `kind:"doc"`, unscored, path-ordered.

*Additive:* the query **fans out across every vault**. Each vault searches its own index,
hits from a secondary vault carry a qualified `path` (`"@work-notes/inbox.md"`), and the
merged list is re-sorted by `score` descending then `path` before `limit` is applied — so
`limit` bounds the whole answer, not each vault's share. The same slug in two vaults is two
results, distinguishable only by their prefix.

---

### Settings

#### `GET /api/settings`

```json
{
  "settings": {
    "theme": "minimal",
    "density": "comfy",
    "colorScheme": "system",
    "editor": { "autosaveSeconds": 10, "tabSize": 2, "clickToEdit": true, "homeDoc": "index.md" },
    "trash": { "retentionDays": 7 },
    "git": { "branch": "main", "autoSync": true, "autoSyncSeconds": 60,
             "tokenMasked": "ghp_9f3kx2Qm7Lp0" },
    "secrets": { "idleLockMinutes": 15, "hiddenLockMinutes": 5,
                 "sessionHours": 8, "clipboardClearSeconds": 30 },
    "ai": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "gpt-5",
            "effort": "high", "maxOutputTokens": 32000, "contextBudgetTokens": 200000,
            "apiKeyMasked": "sk-proj-7hQ2vN8xR1" },
    "terminal": { "enabled": true, "idleLockMinutes": 10, "shell": "", "startupCwd": "",
                  "allowAiAutoRun": false, "passwordSet": true }
  },
  "meta": {
    "themes": [ { "id": "modern", "label": "Modern" },
                { "id": "minimal", "label": "Minimal" },
                { "id": "terminal", "label": "Terminal" } ],
    "densities": [ { "id": "compact", "label": "Compact" }, { "id": "comfy", "label": "Comfy" } ],
    "efforts": [ "low", "medium", "high" ],
    "colorSchemes": [ "system", "dark", "light" ],
    "contextWindow": 256000,
    "homeDocDefault": "index.md",
    "numbers": {
      "editor.autosaveSeconds":        { "min": 1, "max": 3600, "step": 1, "unit": "seconds" },
      "editor.tabSize":                { "min": 1, "max": 8, "step": 1, "unit": "spaces" },
      "trash.retentionDays":           { "min": 1, "max": 365, "step": 1, "unit": "days" },
      "git.autoSyncSeconds":           { "min": 1, "max": 3600, "step": 1, "unit": "seconds" },
      "secrets.idleLockMinutes":       { "min": 1, "max": 480, "step": 1, "unit": "minutes" },
      "secrets.hiddenLockMinutes":     { "min": 1, "max": 480, "step": 1, "unit": "minutes" },
      "secrets.sessionHours":          { "min": 1, "max": 72, "step": 1, "unit": "hours" },
      "secrets.clipboardClearSeconds": { "min": 5, "max": 600, "step": 5, "unit": "seconds" },
      "ai.maxOutputTokens":            { "min": 1000, "max": 200000, "step": 1000, "unit": "tokens" },
      "ai.contextBudgetTokens":        { "min": 1000, "max": 2000000, "step": 1000, "unit": "tokens" },
      "terminal.idleLockMinutes":      { "min": 1, "max": 480, "step": 1, "unit": "minutes" }
    }
  }
}
```

`meta` is server-declared capability, not user state: the theme list drives the settings
control, so shipping a new theme is a backend + CSS change, not a frontend change. Every
segmented control in Settings is built from one of these lists (`themes`, `densities`,
`colorSchemes`, `efforts`) — the client hard-codes none of them. Secrets are returned
pre-masked; the raw token/key never leaves the server.

*Real backend, additive:* `meta.numbers` extends that same rule to every numeric setting.
It is keyed by the setting's dotted path and carries `{min, max, step, unit}`; the client
renders the field, its unit label and its bounds hint from this, clamps and snaps to
`step` before sending, and hard-codes no bound of its own. The server applies the
identical clamp/snap on `PUT` and when reading `settings.toml`, so the value in the file,
the value in the control and the value in use are always the same value. Adding a numeric
setting is therefore a backend change only.

`settings.trash.retentionDays` is the recoverable-delete window. The server applies a
changed value live: shortening it schedules an immediate sweep, and subsequent list
responses derive each entry's new `purgeAt` from it. The scheduled sweep uses the same
value; a restart is not required.

*Real backend, additive (SPEC §13):* `settings.terminal` configures the command runner.
`shell` and `startupCwd` are absolute paths or `""` (meaning `$SHELL`, else `/bin/sh`; and
the vault root) — this file is committed, so it must not force one machine's paths onto
another. `allowAiAutoRun` lets the assistant run commands without your per-command approval
and is `false` by default. **`passwordSet` is read-only output**: the terminal password is
not a setting, it lives as a scrypt hash in sqlite, and this boolean is all that is ever
served about it. A `terminal.password` sent on `PUT` (or hand-written into `settings.toml`)
is absorbed and stripped like `git.token` — but only when no password exists yet; see
`POST /api/terminal/password`.

*Real backend, additive:* `settings.editor.homeDoc` is the doc the client's vault/home
button opens — a **vault-relative** path, the same shape `/api/docs/{path}` takes. An
empty string is legal and means "no home doc": the client falls back to the first doc in
the tree. A value with no `.md` suffix names the same doc as one with it. The server
stores the string and nothing more; it does not check that the doc exists, because a home
doc named before it is written is a legitimate state and the client offers to create it.
`meta.homeDocDefault` publishes the shipped default (`"index.md"`) so the client renders
the field's placeholder from the server rather than hard-coding it — the rule `meta.themes`
and `meta.numbers` already establish.

*Real backend, additive:* `settings.colorScheme` is likewise browser-side policy — the
server stores and publishes the three-way choice and never resolves it. `"system"` is not
a look, it is a subscription: only the client can see the OS preference, so the client
resolves `system → dark|light` at boot and re-resolves on every `matchMedia` change,
without a reload and without touching this endpoint. `PUT` therefore carries `"system"`,
never the resolved value, and `GET` returns what the user chose rather than what they are
currently seeing. Pair it with `theme`: the two are orthogonal axes over the same
stylesheet contract, and every theme in `meta.themes` supports both schemes.

`settings.secrets` is browser-side auto-lock policy for encrypted blocks — the server
publishes it and never enforces it. The crypto worker adopts a change on its next tick,
mid-session, with no reload and no re-unlock.

`settings.ai.maxOutputTokens` / `contextBudgetTokens` are the caps the relay applies to
the next turn; they are also echoed in `meta.ai` (below) as the values actually in force.

**The UI batches; the endpoint does not change.** `PUT` takes a partial object and
deep-merges one level, which is exactly what the Settings page needs now that it BUFFERS:
a control writes a local draft and the **Save** button sends **one** `PUT` carrying only
the keys that actually moved. Nothing about the contract here is new — but two properties
of it are now load-bearing rather than incidental. First, a patch must be honoured as a
*patch*: the client never re-sends a value the user did not touch, so two clients editing
different sections cannot clobber each other and a typed error (`bad-model`, say) can only
ever be raised by a value someone actually typed. Second, the response is the client's new
**baseline** — it is what the fields are repainted from — so the clamping, snapping and
trimming the server does on the way in must be reflected in what it returns. The two
credential fields are the deliberate exception on the client side: `git.tokenMasked` and
`ai.apiKeyMasked` are write-only (the server serves a mask, so there is nothing to diff a
draft against) and are still `PUT` on their own, immediately.

*Real backend, additive:* a successful `PUT` **broadcasts** `settings-changed` carrying the
same `{settings, meta}` body this route returns (see [Events](#events)), and **schedules a
git sync**. Settings are vault state and were previously the one kind that never travelled:
`GET /api/settings` is read at boot and after a terminal-password write, so a second client
left open went on painting *and enforcing* the old theme, home doc, autosave interval and
auto-lock policy for as long as it stayed open, with nothing saying it was stale. The sync
half is the same omission on disk — `settings.toml` is a **committed** file, so a save that
does not schedule leaves the repo dirty until some unrelated edit sweeps it up.

The event does **not** bump `epoch`. The epoch is a *vault* revision (docs), and a client
that reconnects re-reads settings in the same once-per-connection block it re-reads
`ai.status` in, rather than through the epoch gap-check.

**Startup vs runtime.** Everything under `settings` is settable two ways: at runtime
through `PUT /api/settings` (what the Settings UI uses), and at startup by hand-writing
`<vault>/.znotes/settings.toml` before the server boots. The file is the initial-setup
surface and is rewritten — with regenerated documentation comments — on every save. A
value in the file that is out of range, of the wrong type, or not a known enum is
**healed** to the bound or the default and reported on stderr, never fatal: a bad line
synced from another machine must not stop the app booting. `PUT` is stricter, because
there is a caller to tell (see the error codes below).

**First-run credentials.** `settings.toml` is committed, so credentials are never written
into it — but they may be read out of it once. Put `ai.apiKey` (or `git.token`) in the
file, start the server, and it is absorbed into `.znotes/index.db`, stripped from the file
on the next write, and from then on only ever served masked. That is how a fresh install
is pointed at an endpoint without touching the UI. The absorption also runs immediately
before `git` stages the file, so a credential pasted in mid-session is never committed.

*Real backend, additive (phase 4):* `meta.ai` carries capability that is **discovered**
rather than compiled in.

```json
"ai": {
  "probe": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "gpt-5",
             "configured": true, "modelListed": true,
             "responses": true, "toolsWithReasoning": true,
             "error": null, "probedAt": "2026-08-01T00:09:00.000Z" },
  "degraded": [ { "id": "reasoning.summary", "message": "reasoning summaries are off …" } ],
  "contextBudgetTokens": 200000, "maxOutputTokens": 32000,
  "ops": ["replace", "insert_after", "create", "rewrite"],
  "status": { "state": "ok", "model": "gpt-5", "effort": "high",
              "message": "gpt-5 · high — http://127.0.0.1:8080/v1 answered /responses with tools and reasoning.",
              "checkedAt": "2026-08-01T00:09:00.000Z", "source": "probe",
              "configured": true, "downgrades": [] }
}
```

`probe` is refreshed **at boot** and whenever `PUT /api/settings` changes `ai.baseUrl`,
`ai.model` or the key: the server asks the endpoint whether it speaks `/responses`, and
whether it accepts function tools together with a reasoning effort. It runs in the
background — neither boot nor the `PUT` waits on a third-party endpoint — so the result
appears on a later `GET`, or arrives as an `ai-status` event. The boot probe is what makes
the file-only setup path (`ai.apiKey` in `settings.toml`, absorbed at load) verifiable
without touching the UI.

`degraded` is the ladder of request parameters the relay has **permanently** given up after
a `400 Unrecognized request argument` (summaries → `store` → `parallel_tool_calls` →
`max_output_tokens` → effort → reasoning → a `/chat/completions` fallback). It is empty in
the healthy case, is reset when the endpoint configuration changes, and is surfaced in the
UI: an app whose premise is a pluggable endpoint must never degrade silently.

*Real backend, additive:* `meta.ai.status` is the **one derived verdict** both the Settings
panel and the statusbar render, so the two can never disagree. It is derived on the server
from real signals only — never from configuration alone:

| field | meaning |
|---|---|
| `state` | `ok` · `degraded` · `unreachable` · `unconfigured` · `unknown` |
| `model` | the configured model, verbatim |
| `effort` | the effort **actually in use**, i.e. after any effort rung |
| `message` | one sentence, safe to show verbatim (already secret-scrubbed) |
| `checkedAt` | ISO time of the signal this verdict came from, or `null` |
| `source` | `probe` · `call` · `config` — which signal decided it |
| `configured` | a base URL **and** a key are present |
| `downgrades` | same shape as `degraded`; named differently so the two never collide |

Two signals feed it and the **fresher one wins**: the capability probe, and the outcome of
the last real relay turn (`POST /api/ai/messages`). A probe that succeeded ten minutes ago
does not keep claiming `ok` after the endpoint died under a live turn, and a turn that just
worked outranks a stale failure. A probe recorded against a *different* base URL or model
is not evidence about the one configured now and is ignored; changing the endpoint clears
the recorded turn outcome for the same reason. With no signal at all the state is
`unknown` — never `ok`.

#### `PUT /api/settings`

A **partial** settings object (deep-merged one level into `settings`).

```json
{ "theme": "terminal", "editor": { "autosaveSeconds": 20 } }
```

→ `200` with the same shape as `GET`. `400 {"error":"unknown-theme"}` for a theme not in
`meta.themes`.

The patch is checked for SHAPE first, then every value is validated, and the whole `PUT`
is refused if any check fails. This table is the complete list for this route:

| code | when |
| --- | --- |
| `bad-json` | the request body is not parseable JSON |
| `bad-body` | the patch parses but is not an object |
| `bad-editor` / `bad-git` / `bad-ai` / `bad-terminal` | `editor` / `git` / `ai` / `terminal` is present but is not an object |
| `bad-home-doc` | `editor.homeDoc` is not a string, or is not a vault-relative path (absolute, `..`, `\`, a URL scheme, or a control character) |
| `unknown-theme` / `unknown-density` / `unknown-color-scheme` | not in the matching `meta` list |
| `bad-number` | a `meta.numbers` path that is not a positive number (message names the path and its unit) |
| `bad-auto-sync-seconds` | the same, for `git.autoSyncSeconds` |
| `bad-boolean` / `bad-auto-sync` | `editor.clickToEdit`, `git.autoSync`, `terminal.enabled`, `terminal.allowAiAutoRun` given a non-boolean |
| `bad-shell` / `bad-startupcwd` | `terminal.shell` / `terminal.startupCwd` is not a string, or is a relative path (`""` is legal and means the default) |
| `bad-branch` | `git.branch` empty, leading `-`, or not a legal ref name |
| `bad-base-url` | `ai.baseUrl` unparseable or not `http:`/`https:` |
| `bad-model` / `bad-effort` | `ai.model` / `ai.effort` given a non-string or a blank one |

A numeric value that is positive but outside its `meta.numbers` range is **not** an error:
it is clamped to the bound and snapped to `step`, and the response carries what was
stored. `ai.model` and `ai.effort` are checked for TYPE only, never against a list:
`meta.efforts` is what the UI offers, not what the field accepts, the relay's degradation
ladder works over a wider scale (`none…max`) that a capable endpoint may well take, and
the model id is whatever the configured endpoint calls it.

Everything applies live. No setting requires a restart: the autosave debounce and the
auto-lock policy are re-read by the browser, the sync debounce by the sync scheduler,
`editor.homeDoc` by the home button (it re-labels itself from the response, no reload),
and the AI model/effort/budgets by the relay on the next turn.

---

### Sync

#### `GET /api/sync/status`

```json
{ "state": "synced", "branch": "main", "remote": "origin/main",
  "lastSyncAt": "2026-08-01T00:10:04.000Z", "ahead": 0, "behind": 0,
  "message": "synced 2 min ago · origin/main" }
```

`state` ∈ `synced | syncing | offline | error`. Pushed unsolicited on `/events` as
`sync-status` whenever it changes.

`remote` is the origin URL reduced to host + path (`github.com/z/vault`) — no scheme and,
deliberately, no credentials: the GitHub token lives only in the server's sqlite and appears
in no response, no log and no remote URL. `null` means the vault repo has no `origin`, in
which case sync still commits locally and `message` says `local only`. `offline` means the
vault directory is not a git repository at all (`message: "not a git repository"`); the
server is otherwise fully functional. `ahead`/`behind` are `0` until an upstream exists.

#### `POST /api/sync/now`

Manual **Sync now**. Runs the same pipeline as the debounced auto-sync — stage the tracked
set (`*.md`, `.znotes/settings.toml`, `.znotes/vault.pub`, `.znotes/identity.age`; never
`.znotes/index.db`) → commit with a generated message → push to `git.branch` when an
`origin` exists → on a rejected push, `pull --rebase` and push again — but starts it
immediately instead of waiting out `git.autoSyncSeconds`.

Empty body. → `200` with exactly the `GET /api/sync/status` object, as of the moment the
run finished.

```json
{ "state": "synced", "branch": "main", "remote": "github.com/z/vault",
  "lastSyncAt": "2026-08-01T00:10:04.000Z", "ahead": 0, "behind": 0,
  "message": "synced just now · github.com/z/vault" }
```

Syncs are single-flight: a call that arrives while a sync is running joins it and queues
exactly one rerun, so the response always reflects a run that started at or after the
request. Nothing here is destructive — a `pull --rebase` that hits a real conflict is
aborted (working tree restored, both sides intact) and the call returns
`state: "error"` with the conflicted paths in `message`. Editing and saving keep working in
that state; resolve in the vault repo and call this again.

#### `POST /api/sync/remote`

```json
{ "url": "https://github.com/z/vault.git" }
```

**Attach** the vault directory to a remote repository (ADR 0017). Initialises a repo if the
vault is not one, sets `origin`, fetches, checks out the remote's default branch — adopting
it as `git.branch` — and hands over to the ordinary pipeline. A vault that is already its
own repo is attached without any checkout: `origin` is set (validated with a fetch, restored
on failure) and the **locally checked-out** branch is the one adopted, which may differ from
the remote's default. This is the one operation in the product that may run `git init`; the
sync pipeline still never does. Also runs at boot from `ZNOTES_VAULT_REPO` when the vault is
not already its own repo.

→ `200` with exactly the `GET /api/sync/status` object, as `POST /api/sync/now` answers it:
attach ends with a manual sync, so the response already reflects the first push (an empty
remote gets the local docs as its first commit).

**Non-destructive and atomic.** It never overwrites or deletes a local file — a remote file
that would land on a differing local one is a refusal, naming the paths — and on any failure
it rolls back everything it created (the `.git` it just made, or the previous `origin` URL),
leaving the vault byte-identical to before the call. Local files the remote does not carry
simply stay, untracked, for the triggered sync to commit. One file is exempt from the
refusal: `.znotes/settings.toml`, which the server itself manufactures at boot — when it is
the only path in the way, attach parks the local copy at `.znotes/tmp/settings.toml.pre-attach`
and adopts the remote's (without this no populated vault repo could ever be attached). The
keyring is never exempt: a local `identity.age` losing to a remote one would lose the vault key.

| Status | When |
|---|---|
| `400 bad-url` | `url` is empty, over 2048 chars, carries whitespace/control characters or `\`, starts with `-`, carries userinfo (`https://user:pw@…`), or is not `https://`, `http://`, `file://` or an absolute path — `ssh://` and scp-style remotes are configured with ordinary git in the vault instead |
| `409 vault-busy` | the vault repo is mid-merge, mid-rebase, has a conflicted index or a detached HEAD — the same refusal the sync pipeline gives; finish or abort it in the vault repo |
| `409 checkout-conflict` | checking out the remote branch would overwrite local files; body is `{error, message, paths}` — `paths` lists them and `message` names them too |
| `502 attach-failed` | the remote is unreachable, refused the credential, or answered with an unusable default branch |

The token rule is unchanged and applies verbatim: it reaches git only through the askpass
environment, so it appears in no argv, no `.git/config`, no log and no response body.

---

### Vaults

Which vaults exist, and each one's own git configuration (ADR 0018). The `/api/sync/*`
routes above stay **primary-bound** and unchanged — this section is how a *secondary* vault
is added, configured, synced and disconnected. Every vault, primary included, is addressable
here, so `{id}` = `vault` is always valid.

The **vault descriptor** is the `vaults[]` element of `GET /api/docs` minus `tree`, plus
that vault's git settings:

```json
{
  "id": "work-notes",
  "label": "work-notes",
  "root": "~/vaults/work-notes",
  "docCount": 3,
  "remote": "github.com/z/work-notes",
  "repo": true,
  "prefix": "@work-notes/",
  "sync": { "state": "synced", "…": "the GET /api/sync/status object" },
  "git": { "branch": "main", "autoSync": true, "autoSyncSeconds": 60,
           "tokenMasked": "ghp_9f3kx2Qm7Lp0" }
}
```

`tokenMasked` follows the credential rule everywhere else in this contract: the token lives
only in that vault's sqlite, reaches git only through the askpass environment, and is never
returned whole.

#### `GET /api/vaults`

→ `200 {"vaults":[ <descriptor>, … ]}` — primary first, then by id. This exact body is what
the `vaults-changed` SSE event carries.

#### `POST /api/vaults`

```json
{ "url": "https://github.com/z/work-notes.git", "name": "Work notes", "token": "ghp_…" }
```

Adds a vault: creates a directory under the vaults home and runs the ordinary **attach**
(`POST /api/sync/remote`, ADR 0017) inside it, so every guarantee attach makes is inherited.
`name` is optional and defaults to the last path segment of the sanitized remote; it is
slugified into the vault **id** (lowercase, non-alphanumerics to `-`, clamped to 40 chars).
`token` is optional: omitted, the primary's `git.token` is **copied** into the new vault's
credential store (one account, many repos, is the ordinary case); pass `token: ""` to attach
anonymously. → `201 {"vault": <descriptor>}`.

**A failed add leaves nothing behind** — no directory, no registry entry, no credential.

| Status | When |
|---|---|
| `400 bad-url` | `url` fails the same check `POST /api/sync/remote` applies, verbatim |
| `400 bad-name` | the derived id is empty, out of `^[a-z0-9][a-z0-9-]{0,39}$`, or the reserved literal `vault` |
| `409 exists` | a vault with that id is already connected, a connected vault already has that remote, or a directory of that name already sits in the vaults home |
| `409 vaults-nested` | the vaults home and the primary vault contain one another — secondary vaults are disabled until they are separated |
| `502 attach-failed` | the remote is unreachable, refused the credential, or answered with an unusable default branch |

`409 vault-busy` and `409 checkout-conflict` are relayed verbatim if attach ever raises them
— a directory this call created seconds ago cannot practically be in either state, but the
refusal is passed through rather than reinterpreted.

#### `GET /api/vaults/{id}`

→ `200 {"vault": <descriptor>}`, or `404 {"error":"not-found"}` for an unknown id.

#### `DELETE /api/vaults/{id}`

**Disconnect.** Stops that vault's watcher, sync and index and drops it from the registry.
→ `204`, no body. Emits `vaults-changed`.

**The directory is not deleted.** Its notes and its git repository stay on disk exactly as
they were; disconnecting is a registry operation and deleting is a human one. A later add of
the same remote therefore refuses with `409 exists` on the surviving directory — remove it
by hand first.

| Status | When |
|---|---|
| `400 primary-vault` | `{id}` is `vault` — `The primary vault cannot be disconnected.` |
| `404 not-found` | no vault with that id |

#### `PUT /api/vaults/{id}/settings`

```json
{ "git": { "branch": "main", "autoSync": true, "autoSyncSeconds": 60, "token": "ghp_…" } }
```

Per-vault git settings, every field optional. Validation, healing, credential absorption,
persistence to that vault's `settings.toml` and live application to its sync loop are
exactly what `PUT /api/settings` does for the primary — this route is the same operation
aimed at one vault. → `200 {"vault": <descriptor>}`.

Only `git` is settable here: any other key is
`400 {"error":"bad-body","message":"Only the git section is settable per vault."}`.
App-level settings (theme, editor, secrets, ai, terminal, trash retention) are the primary's
and live at `PUT /api/settings` only. `404 not-found` for an unknown id.

#### `POST /api/vaults/{id}/sync`

Manual **Sync now** for one vault. Empty body. → `200` with that vault's
`GET /api/sync/status` object plus a `vault` field naming the id. Same pipeline, same
single-flight behaviour, same non-destructive rebase handling as `POST /api/sync/now`.
`404 not-found` for an unknown id.

#### `POST /api/vaults/{id}/remote`

```json
{ "url": "https://github.com/z/work-notes.git" }
```

Point a vault at a (new) remote — the ordinary **attach** run against that vault's stack,
with every attach guarantee intact: non-destructive, atomic, credentials only through the
askpass env. The checkout's branch is adopted into that vault's `git.branch`, the pulled
docs are indexed before the reply, and a `vaults-changed` frame announces the new label.
→ `200` with that vault's sync-status object plus a `vault` field. For `{id}` = `vault`
this is `POST /api/sync/remote`'s twin. Refusals: the attach family (`400 bad-url`,
`409 vault-busy`, `409 checkout-conflict`, `502 attach-failed`) relayed verbatim,
`409 exists` when another vault already holds the remote, `404 not-found` for an
unknown id.

#### `DELETE /api/vaults/{id}/remote`

Disconnect a vault from its remote: `git remote remove origin` and nothing else. The
notes, the repository and its whole history stay on disk — only the address the pipeline
pushes to is forgotten, so the vault carries on local-only and re-attaching is one POST.
Idempotent: a vault that is not a repository, or has no origin, answers `200` unchanged.
→ `200` with that vault's sync-status object plus a `vault` field, and a `vaults-changed`
frame (the label falls back to the directory's name). `502 detach-failed` if git refuses,
`404 not-found` for an unknown id.

This is what **disconnect** means for the primary vault, which can never leave the app.
A secondary vault's `DELETE /api/vaults/{id}` unregisters the vault itself instead; the
two are different acts and both leave every byte on disk.

---

### AI

Wire protocol to the model is the backend's business (ticket 10: `POST {baseUrl}/v1/responses`
with `reasoning.effort`, relayed server-side so the key never reaches the browser, edits
proposed through one strict `propose_edits` function tool returning anchored search/replace
spans). None of that is visible here: the frontend sees sessions, messages and proposals.

#### Session object

```json
{
  "id": "sess_4f1c9a",
  "startedAt": "2026-08-01T00:09:12.000Z",
  "model": "gpt-5",
  "effort": "high",
  "contextWindow": 256000,
  "contextDocPath": "architecture/z-notes-design.md",
  "messageCount": 12,
  "tokensEstimated": 3184,
  "messages": [
    { "id": "m1", "role": "user", "content": "summarize open tasks across my vault",
      "at": "2026-08-01T00:09:20.000Z" },
    { "id": "m2", "role": "assistant", "content": "You have **6 open tasks**: …",
      "at": "…", "proposalId": null },
    { "id": "m9", "role": "assistant", "content": "Proposed edit — …", "proposalId": "prop_1" },
    { "id": "m0", "role": "system", "kind": "divider", "content": "context cleared" }
  ]
}
```

`content` is inline markdown (`**bold**`, `` `code` ``, `[[wiki-link]]`) — the client renders
it with the same inline renderer it uses for docs, so no HTML crosses the boundary.
`tokensEstimated` is the server's estimate for the thread **plus** whatever context it would
attach; the client displays it and never computes its own. (Real backend: a character
estimate, ~3.9 chars/token, measured against this repo's own corpora to hold aggregate error
inside ±2%. It was an exact `o200k_base` BPE count until ADR 0011 — the exactness cost ~123 MB
of resident memory and no consumer of the number was ever anything but advisory.) A session
also carries `degraded` — the same array as
`meta.ai.degraded` — whenever the relay has had to downgrade the request shape.

#### `GET /api/ai/sessions/current`

→ `200` session object. Always exists (created lazily).

#### `GET /api/ai/status` · `POST /api/ai/status`

```json
{ "status": { "state": "ok", "model": "gpt-5", "effort": "high", "…": "…" },
  "ai": { "probe": { "…": "…" }, "degraded": [], "status": { "…": "…" }, "…": "…" } }
```

`status` is `meta.ai.status` (above); `ai` is the whole `meta.ai` block, so one call is
enough to repaint both the statusbar and the Settings › AI panel.

**`GET` costs nothing** — it reads the signals the server has already recorded and makes no
network request. Clients use it once per `/events` connection, because the stream keeps no
backlog and an `ai-status` pushed before the client existed (the boot probe lands in the
first second) is otherwise simply gone.

**`POST` re-runs the capability probe now** against the configured endpoint and answers with
the fresh verdict. Unlike the boot and settings-save probes it *is* awaited: it exists for
the "check it now" affordance on the statusbar, which is a question the user is waiting for
an answer to. Body is ignored. → `200`, or `405` for any other method.

#### `POST /api/ai/sessions`

Body: `{}` or `{ "keepStack": true }`. Starts a fresh session; the thread is cleared and a
`{"role":"system","kind":"divider"}` message opens the new one. → `201` session object.
**The change stack is not touched** — clearing context drops the thread, not the doc history.

#### `POST /api/ai/messages`

```json
{ "content": "yes, add it", "docPath": "architecture/z-notes-design.md" }
```

`docPath` is the doc currently open, so the server can assemble context; optional.

→ `200`

```json
{
  "session": { "...": "session object, messages omitted" },
  "messages": [ { "id": "m13", "role": "user", "...": "" },
                { "id": "m14", "role": "assistant", "proposalId": "prop_3", "...": "" } ],
  "proposal": { "...": "proposal object, or null" }
}
```

##### Streaming *(SPEC §3 delta 4)*

The backend **streams** this route instead of returning the blob above. The response is
`200 text/event-stream; charset=utf-8` (`cache-control: no-store`, `x-accel-buffering: no`,
no gzip). Errors raised *before* the stream opens are still ordinary JSON — `400
{"error":"empty-message"}` is the only one.

`EventSource` cannot be used: it is GET-only and cannot carry a body. Clients POST with
`fetch` and parse the frames themselves (`app/api.js` → `sendMessageStream`).

The events are **normalized app events**, not upstream protocol frames — the client never
learns which wire protocol served the turn, nor whether it was degraded on the way:

| `event:` | `data:` | Meaning |
|---|---|---|
| `text` | `{"delta":"…"}` | assistant prose, in order |
| `reasoning` | `{"delta":"…"}` | reasoning-summary text — a "thinking" affordance only, never content |
| `tool_args` | `{"delta":"…"}` | raw tool-call JSON as it arrives; for a "drafting edits…" shimmer. **Never parse it** — it is a partial string by definition |
| `proposal` | *proposal object* | a **validated** proposal (see below). Arrives only after the server checked it against on-disk bytes |
| `command` | *command record* | the assistant asked to run a shell command (SPEC §13). `state:"pending"` = queued for the user's approval and **not run**; `state:"done"` = auto-run and finished. See § Terminal |
| `usage` | `{"input":1234,"output":56,"reasoning":20,"cached":900}` | token counts, when the endpoint reports them |
| `error` | `{"message":"…","code":"…"}` | something went wrong; a `done` still follows |
| `done` | *see below* | terminal event, exactly once |

```
event: reasoning
data: {"delta":"Looking at the doc… "}

event: text
data: {"delta":"Here is a small edit."}

event: proposal
data: {"id":"prop_1","target":"architecture/design.md","state":"pending", …}

event: usage
data: {"input":1234,"output":56,"reasoning":20,"cached":900}

event: done
data: {"session":{…},"messages":[{…user…},{…assistant…}],"proposal":{…}|null}
```

**`done` carries exactly the JSON body the non-streaming contract returned** — same
`session` / `messages` / `proposal` shape — so a client has one completion path, and the
deltas are pure presentation. A turn that used the terminal adds `"commands": [ …records… ]`,
whose `messageId` is now filled in; the key is **absent** when the turn asked for none, so
the shape is unchanged for every turn that never touched the terminal. A turn that ends in failure still emits `done` (with the
error text as the assistant message and `proposal: null`); the stream never hangs.

Not every reply proposes an edit. A plain answer carries `proposal: null` and the UI shows
no diff card — the model is never forced into a tool call.

**Two tools, and the second one is gated** *(SPEC §13)*. Alongside `propose_edits` the
server declares `run_command` — but **only** when the terminal is enabled and has a password,
so a vault without one never tells the model the capability exists, and the system prompt
gains its "The terminal" section on the same condition.

```json
{ "type": "function", "name": "run_command", "strict": true,
  "parameters": { "type": "object", "additionalProperties": false,
    "required": ["command", "why"],
    "properties": {
      "command": { "type": "string" },
      "why":     { "type": "string" } } } }
```

The gate, in order:

1. **Locked ⇒ nothing runs.** The tool result is
   `{"status":"refused","reason":"terminal-locked"}` and the model is told to ask the user to
   unlock — a truthful answer rather than a silent no-op.
2. **Unlocked, `terminal.allowAiAutoRun` off (the default) ⇒ nothing runs yet.** A record is
   created in `pending`, emitted as a `command` event, and the turn **ends**
   (`{"status":"awaiting-approval","commandId":…}`). The user sees a Run/Reject card with the
   exact command on it and presses Run
   (`POST /api/terminal/commands/{id}/run`); the output reaches the model on the **next**
   turn, as a context block explicitly labelled program output rather than instruction.
3. **Unlocked and auto-run on ⇒ it runs in-turn**, and the tool result carries
   `{"status":"ran","exitCode":…,"cwd":…,"output":…}` — unless something is **already
   running**, in which case it is `{"status":"refused","reason":"busy"}` and nothing is
   started. The user's own command is never displaced by the model's.

At most 4 `run_command` calls per turn; the fifth is refused and ends the turn.

*Why the approval gate exists:* everything in a model's context is attacker-influenceable — a
note can be pasted from anywhere and a fetched document can carry injected instructions — so a
tool that executed the moment the model asked would turn any hostile sentence in the vault
into code execution, with no point at which the user could have noticed. The gate keeps the
capability and removes the silent path.

**Cancellation.** Closing the response body (abort the `fetch`) cancels the turn: the server
cancels its stream, which aborts the upstream request, so nothing keeps generating for a
chat nobody is reading. Whatever prose already streamed is kept in the thread.

**Ordering.** Upstream events are re-ordered by their sequence number where one is supplied,
and only a completed tool-argument payload is ever parsed — the `tool_args` deltas are
shimmer, never ground truth.

**What the server sends upstream is assembled here, from disk.** The client never ships
buffer state to this route: context is `instructions → vault manifest → depth-1 linked docs
→ FTS hits (vault-wide questions only) → the current doc in full → history → the user turn`,
read from on-disk bytes, with every ` ```age ` fence replaced by
`⟪secret: encrypted, not visible to the assistant⟫` first. Unsaved editor buffers are
therefore invisible to the assistant — flush before asking. A payload that still contains
age armor is **refused, not stripped**: the turn fails with an `error` event naming the leak
canary and no request is made.

#### Proposal object

```json
{
  "id": "prop_1",
  "target": "architecture/z-notes-design.md",
  "label": "Open tasks rollup",
  "summary": "1 file · 4 lines",
  "state": "pending",
  "stats": { "added": 4, "removed": 0 },
  "stackIndex": null,
  "revertable": false,
  "diff": [ { "marker": " ", "text": "- [ ] Write build-ready spec" },
            { "marker": "+", "text": "## Open tasks rollup" } ],
  "edits": [ { "op": "insert_after", "anchor": "- [ ] Write build-ready spec",
               "text": "\n## Open tasks rollup\n…" } ]
}
```

`state` ∈ `pending | applied | rejected`. `stackIndex` is the 1-based position in the change
stack when applied (`null` otherwise). `revertable` is true only for the **top** of the
stack. `edits` is informational for the UI; only the server applies them (it validates each
anchor against current bytes — a stale anchor is `422 {"error":"anchor-miss"}`).

*Real backend, additive (phase 4):* `edits[]` entries carry `{op, path, anchor, text, note}`
with `op ∈ replace | insert_after | create | rewrite` — there is no delete or rename. Two
extra fields appear once a proposal is applied: `commit` (the sha of the one commit that
proposal produced, or `null`) and `commitNote` (why no commit was made — e.g. the vault is
not a git repository, which is not an error: the edit still applied).

A proposal only ever reaches the client **after** the server validated every edit against
on-disk bytes: the path is confined to the vault, each `find` anchor matches exactly once
(exact → line-endings-normalized → per-line-trailing-whitespace-normalized; leading
indentation is never normalized), and no edit span intersects an encrypted block. Failures
are fed back to the model as the tool result for at most two retries inside the same turn —
the UI is never offered an Accept button for an edit that cannot apply.

#### `GET /api/ai/proposals`

```json
{ "proposals": [ "…proposal objects…" ],
  "stack": [ { "id": "prop_1", "label": "Open tasks rollup", "index": 1, "revertable": false },
             { "id": "prop_2", "label": "Track round 2 shipping", "index": 2, "revertable": true } ] }
```

`stack` is oldest → newest.

#### `POST /api/ai/proposals/{id}/accept`

Body: `{}`. Applies the edits, snapshots the pre-image, pushes onto the change stack.

→ `200`

```json
{ "proposal": { "...": "state:applied, stackIndex:2, revertable:true" },
  "stack": [ "…" ],
  "doc": { "path": "architecture/z-notes-design.md", "rev": "r9",
           "markdown": "…full new text…", "bytes": 980, "mtime": "…" } }
```

`409 {"error":"already-applied"}`. `422 {"error":"anchor-miss","anchor":"…"}` if the doc
drifted under the proposal. Emits `doc-changed`.

*Real backend (phase 4):* accept re-validates every anchor against the file's **current**
bytes, not the ones the proposal was built from, so an edit made in vim in the meantime
raises `422 anchor-miss` instead of silently applying somewhere wrong. On success it writes
via the ordinary atomic doc-write path (`doc-changed` with `"reason":"proposal-accepted"`),
stores the pre- and post-images in sqlite, pushes the change stack, and makes **one git
commit for exactly that proposal**:

```
ai: <label>

Z-Notes-Proposal: prop_3
Z-Notes-Model: gpt-5@high
```

so `git revert <sha>` is a clean single-proposal inverse. Every guard the sync pipeline has
applies (a vault mid-merge, a tracked `index.db`, a credential in `settings.toml` all stop
the commit); a vault that is not a git repository still applies the edit and records the
reason in `commitNote`.

#### `POST /api/ai/proposals/{id}/revert`

**LIFO is enforced by the server, not the UI.** Reverting anything but the top of the stack is

```
409 { "error": "not-stack-top", "requires": "prop_2", "requiresIndex": 2,
      "message": "revert #2 first" }
```

On success the pre-image is restored byte-for-byte, the entry is popped, the proposal returns
to `pending` (it can be accepted again) and the response is the same shape as `accept`.
Emits `doc-changed` (`"reason":"proposal-reverted"`).

*Real backend (phase 4):* before restoring anything the server re-reads the file and
requires it to still equal the post-image it wrote. If it drifted — an edit in vim, a `git
pull` — the revert is refused rather than clobbering that work:

```
409 { "error": "drifted", "path": "architecture/design.md",
      "message": "… changed after this proposal was applied — revert would destroy those edits." }
```

Reverting a proposal whose `op` was `create` removes the document it created (that path then
reports `removed: true` on `doc-changed`).

#### `POST /api/ai/proposals/{id}/reject`

Marks a **pending** proposal `rejected` (a dismissal, not an edit). `409 {"error":"applied"}`
if it is on the stack — revert first. → `200 { "proposal": … }`.

---

### Terminal *(SPEC §13)*

A password-locked **streaming command runner** on the machine the vault lives on. It is not a
terminal emulator and does not pretend to be one: bun has no PTY, so full-screen and
interactive-editor programs (`vim`, `htop`, `less`, `git rebase -i`, `git commit` with no
`-m`) cannot work. One command runs at a time, its stdout and stderr stream separately, its
stdin is writable, and the **working directory persists between commands**.

The pager and the editor a tool *invokes* are neutralised (`TERM=dumb`, `PAGER`/`GIT_PAGER`,
`GIT_EDITOR`), but a TUI the user invokes **directly** simply blocks on stdin: it has to be
cancelled. A run that has printed nothing for ten seconds says so as an `event: notice`,
rather than looking like progress until the 30-minute wall clock.

**Auth.** Every route below except `GET /api/terminal/status` requires
`Authorization: Bearer <token>` from `POST /api/terminal/unlock`. Without one, or after the
idle timeout, they answer `401 terminal-locked`. With the terminal switched off,
`403 terminal-disabled`; with no password set, `403 terminal-unconfigured` — the terminal is
never open by default. All mutating routes are inside the same cross-site guard as the rest
of `/api/*` (`403 cross-site`).

**The password never appears in any response, log line or SSE payload.** Only a scrypt hash
lives server-side (sqlite `credentials`); `GET /api/settings` reports its existence as
`terminal.passwordSet: true|false` and nothing more.

#### `GET /api/terminal/status`

The only unauthenticated route. Capability, never content. Sending a bearer additionally
reports whether *that* token is live.

```
200 {
  "enabled": true, "configured": true, "unlocked": true, "ready": true,
  "cwd": "/Users/z/vault/projects", "vaultRoot": "/Users/z/vault",
  "shell": "/bin/zsh", "idleLockMinutes": 10, "allowAiAutoRun": false,
  "running": null, "expiresInMs": 543210, "retryAfterMs": 0,
  "ptyNote": "No TTY: this runs one command at a time and streams its output. …"
}
```

`ready` is `enabled && configured && unlocked` — the single fact the UI gates on. `running`
is the id of the command running **right now**, whoever started it (another tab, or the
assistant): it is what a client drives its Stop affordance from, because a command this tab
did not start is still a command this tab must be able to cancel. `retryAfterMs` is the
*calling address's* own unlock backoff, never anyone else's.

#### `POST /api/terminal/unlock`

```
{ "password": "…" }
→ 200 { "token": "…", "expiresAt": "…", "idleLockMinutes": 10, "status": { … } }
```

Wrong password is `401 bad-password` with `retryAfterMs`. **The answer is identical, with the
same work behind it, whether or not a password is set** — this endpoint is deliberately not an
oracle for that, in its wording *or its timing*: the decoy derivation an unconfigured vault
verifies against is built off the request path, so the first attempt after boot costs one
derivation either way. Three free attempts, then exponential backoff to 60 s
(`429 too-many-attempts`, `retryAfterMs`).

The backoff is counted **per calling address**, not per process. It is there to make guessing
slower, and a single global counter made it something else: one peer failing in a loop held
every other caller — the owner included — permanently at `429`, because the counter only ever
reset on a successful unlock and a blocked caller cannot succeed.

The token is a bearer, not a cookie: a cookie is ambient authority the browser attaches to
every same-origin request. It is never persisted, so a reload re-locks.

#### `POST /api/terminal/lock`

Drops the caller's session. → `200 { …status… }`. Idempotent.

#### `POST /api/terminal/password`

```
{ "password": "<new, or \"\" to clear>", "current": "<required if one is set>" }
→ 200 { "configured": true, "status": { … } }
```

Setting the **first** password needs no proof. **Changing** one requires `current` (or a live
bearer), rate-limited on the same counter — otherwise the lock could be replaced by anyone at
the keyboard. Clearing it disables the terminal and ends every session. `400 weak-password`
under 8 characters. Nothing about the password comes back.

*(A fresh install can instead put `password = "…"` in `[terminal]` of `.znotes/settings.toml`:
it is hashed into sqlite and stripped from the file on the next write, so it is never
committed. It is **ignored and stripped** if a password already exists, so a settings.toml
synced from another machine cannot take the terminal.)*

#### `POST /api/terminal/exec` — `text/event-stream`

```
{ "command": "git status --short" }
```

Streams. `409 busy` if something is already running (the body carries `running`, the id of
what already is); `400 empty-command`; `413 too-long` past 8000 characters. **One command at a
time is enforced at the point of execution**, so every path — this route, an approved command,
and the assistant's auto-run — is refused equally.

```
event: start
data: {"id":"cmd_ms…","command":"git status --short","cwd":"/Users/z/vault",
       "at":"2026-08-02T02:14:53.951Z","source":"user"}

event: stdout
data: {"chunk":"## main\n"}

event: stderr
data: {"chunk":"fatal: not a git repository\n"}

event: notice
data: {"message":"Output passed 2 MiB — the rest is not shown."}

event: exit
data: {"id":"cmd_ms…","code":128,"signal":null,"cwd":"/Users/z/vault","ms":78,
       "truncated":false}
```

`exit.cwd` is the directory the **next** command will start in. `signal` is set instead of a
meaningful `code` when the command was killed. An error that happens after the stream opened
arrives as `event: error` with `{error, message}`; one that happens before is ordinary JSON.

Closing the response cancels the command — a browser that navigates away does not leave a
build running.

#### `POST /api/terminal/stdin`

```
{ "data": "y\n", "eof": false, "id": "cmd_ms…" }   → 200 { "ok": true, "id": "cmd_ms…" }
```

Writes to the running command's stdin — how a `y/N` prompt or a commit message is answered
without a TTY. `eof: true` closes it (Ctrl+D). `409 not-running` if nothing is.

`id` names the command the caller believes it is typing into, and a mismatch is
`409 wrong-command` (with `running`) rather than a silent redirect: what the user is answering
is the prompt in front of *them*, so a client whose idea of the running command is stale must
not be able to feed a passphrase to a different process. It is optional only for a caller with
no id to offer; the app always sends one.

#### `POST /api/terminal/cancel`

```
{ "id": "cmd_ms…" }   → 200 { "cancelled": true, "id": "cmd_ms…" }
```

SIGTERM to the whole process subtree (not just the shell — its children hold the pipes), then
SIGKILL after a grace. `id` is optional; omitted, it cancels whatever is running, which is how
Ctrl+C in a tab that did not start the command still reaches it. `{"cancelled": false}` when
nothing was.

Closing a streamed response cancels **that** command and only that one — a teardown that
arrives after the command it belonged to has finished never reaches past it.

#### `GET /api/terminal/commands?limit=`

The **assistant's** command records, oldest first. Only AI-originated commands are recorded —
what the user types into their own shell is theirs and is never stored or replayed into a
model context.

```
200 { "commands": [ {
  "id": "run_ms…", "source": "ai", "command": "git status --short",
  "why": "to see what is uncommitted", "state": "done",
  "cwd": "/Users/z/vault", "exitCode": 0, "output": "## main\n",
  "truncated": false, "sessionId": "sess_1", "messageId": "m_12",
  "createdAt": "…", "finishedAt": "…"
} ] }
```

`state` ∈ `pending | running | done | rejected | failed`. `output` is the truncated
transcript (first 4000 + last 4000 characters, elided in the middle). Bearer-gated, because
`output` is command output.

A transcript containing **age armor** is not stored: `output` becomes
`⟪output withheld: this command printed an age-encrypted block⟫`. `cat` of a note with a
secret block is exactly what the terminal is for, and this record is both durable (sqlite,
which SPEC §11 says armor never reaches) and replayed into every later model context (which
the relay's canary refuses outright). The user still saw the real bytes stream past in their
own scrollback.

#### `POST /api/terminal/commands/{id}/run` — `text/event-stream`

The **Run** button on an assistant command card. Streams exactly like `exec`, so approved
output lands in the same scrollback as anything the user typed. `409 already-run`,
`409 rejected`, `409 busy`, `404 not-found`.

#### `POST /api/terminal/commands/{id}/reject`

```
→ 200 { "command": { …record, "state": "rejected"… } }
```

`409 not-pending` if it already ran.

---

### Events

#### `GET /events` — `text/event-stream`

One long-lived stream per client. `Cache-Control: no-store`, `idleTimeout: 0` on the real
server (Bun kills SSE at 10 s otherwise — ticket 8), heartbeat every 20 s so proxies and the
browser both keep it warm. `EventSource` reconnects on its own; the server honours
`Last-Event-ID` when it can and otherwise the client re-reads what it cares about.

```
event: hello
data: {"clientId":"c3","serverTime":"2026-08-01T00:12:04.000Z","epoch":41}

event: doc-changed
data: {"path":"architecture/z-notes-design.md","rev":"r9","reason":"write",
       "bytes":980,"mtime":"2026-08-01T00:12:31.000Z"}

event: doc-changed
data: {"path":"projects/homelab.md","rev":"r4","reason":"external","removed":true,
       "bytes":0,"mtime":"2026-08-01T00:13:02.000Z"}

event: doc-changed
data: {"path":"@work-notes/inbox.md","rev":"r2","reason":"write",
       "bytes":41,"mtime":"2026-08-01T00:13:44.000Z"}

event: sync-status
data: {"state":"syncing","branch":"main","remote":"origin/main","message":"syncing…",
       "vault":"vault"}

event: vaults-changed
data: {"vaults":[ … ]}

event: ai-status
data: {"state":"unreachable","model":"gpt-5","effort":"high",
       "message":"The last request to http://127.0.0.1:9/v1 failed (ai-unreachable).",
       "checkedAt":"2026-08-01T00:12:22.000Z","source":"call",
       "configured":true,"downgrades":[]}

event: terminal-command
data: {"id":"run_ms…","state":"pending","source":"ai",
       "at":"2026-08-02T02:30:19.909Z"}

event: settings-changed
data: {"settings":{"theme":"minimal","density":"comfy", … ,
                   "git":{"branch":"main","tokenMasked":"ghp_…4f2a"}},
       "meta":{ … }}

event: trash-changed
data: {"retentionDays":7,"entries":[ … ]}

event: heartbeat
data: {"t":"2026-08-01T00:12:24.000Z"}
```

`terminal-command` is a **notification, never content** — an id and a state, nothing else.
`/events` is the app-wide stream and is not behind the terminal password, so the command
string and its output are fetched over the bearer-gated `GET /api/terminal/commands` by
clients that are actually unlocked. A locked client learns nothing from it.

`trash-changed` carries exactly the body `GET /api/trash` serves — the aggregate across
every vault, whichever vault changed. It is emitted after a delete, restore, permanent
deletion or sweep, so clients repaint the disclosure from the server list rather than
maintaining a second local trash index.

*Additive (ADR 0018):* `vaults-changed` carries exactly the body `GET /api/vaults` serves.
It is emitted when a vault is added or disconnected, when per-vault settings change, and
when a vault's `label` would move (attaching the primary to a remote renames its row).
Clients re-read the tree and repaint any vault UI from the frame rather than tracking the
registry themselves.

*Additive:* `doc-changed` paths obey the doc-path grammar in
[Conventions](#conventions) — bare for the primary vault, `@<id>/`-qualified for a
secondary, in `path`, `from` and `to` alike. `sync-status` gains a `vault` field naming the
vault the status belongs to; the primary's frames say `"vault":"vault"`. Both are additive:
a client that ignores the prefix and the field sees exactly today's stream for a
single-vault install. `hello` and `epoch` are unchanged — there is one `vaultEpoch` for the
whole server, bumped by a change in **any** vault, and a reconnecting client re-reads the
tree, which now describes every vault.

`reason` ∈ `write | created | proposal-accepted | proposal-reverted | external | moved |
deleted` — `external` is the fs-watch reconcile telling open editors the file
moved under them. Clients that just wrote compare `rev` with their own and ignore the echo.
(`moved` and `deleted` are additive, phase 5; a client that does not know them still
converges, because both carry `removed: true` on the path that went away.)

`removed: true` (present only when set) means the doc left the vault — `rev` is the last
one the server saw and the path is now `404`. Clients re-read the tree instead of the doc.

**`moved` comes in pairs.** `PATCH /api/docs/{path}` emits, for every doc it moved, the old
path with `removed:true` **and** `to`, then the new path with `from`:

```
event: doc-changed
data: {"path":"architecture/design.md","rev":"r9","reason":"moved","removed":true,
       "to":"archive/design.md","bytes":0,"mtime":"2026-08-01T00:13:02.000Z"}

event: doc-changed
data: {"path":"archive/design.md","rev":"r9","reason":"moved","from":"architecture/design.md",
       "bytes":812,"mtime":"2026-08-01T00:13:02.000Z"}
```

`from` / `to` are present only on `moved`. They are what lets a *second* client follow the
doc it has open across the move without a manual refresh: the removed half names the
destination, so the client retargets its buffer instead of reporting the doc deleted. Docs
whose `[[links]]` were rewritten by the same move arrive as ordinary `"reason":"write"`
events. A folder move emits one pair per `.md` in the subtree.

`deleted` is the human-initiated `DELETE` (always with `removed:true`), as distinct from
`external`, which is the same disappearance noticed by the watcher after someone `rm`'d the
file outside the app.

*Additive:* `ai-status` carries `meta.ai.status` verbatim and is emitted **only when the
verdict actually changes** — a finished probe, a relay turn whose outcome differs from the
last one, a degradation rung being taken, or a `PUT /api/settings` that moves any field of
the derived status. A healthy endpoint therefore produces one event at boot and then
silence; nothing polls, and a client that never sees an `ai-status` is looking at a status
that has not moved. Pair it with `GET /api/ai/status` on connect to cover the gap the
backlog-free stream leaves.

Note that the settings trigger is deliberately **wider** than the capability probe's. The
probe re-runs only when `ai.baseUrl` / `ai.model` / `ai.apiKey` change, because only those
can change what the endpoint is *capable* of — putting a network round-trip behind a theme
switch would be absurd. But the status also reports the model and the **effort actually in
use**, and `ai.effort` is settable without touching any of those three. Every successful
`PUT /api/settings` therefore re-derives and announces; the "only when it changed" rule
above is what keeps that from becoming chatter, since it is keyed on the whole verdict. A
settings save that moves nothing observable emits nothing. Without this, changing the
reasoning effort updated Settings › AI while the statusbar item went on reporting the old
one for the rest of the session — two surfaces that are documented as the same signal,
disagreeing.

*Additive:* `settings-changed` is emitted on every successful `PUT /api/settings` and
carries **exactly the body that route returns** — `git.tokenMasked`, `ai.apiKeyMasked` and
`terminal.passwordSet` in place of the three credentials, which live only in sqlite. No
secret is representable in this frame, which is what makes it safe on a stream that is not
behind the terminal password. Clients apply only the paths whose stored value actually
**moved**: re-applying an unchanged appearance axis would stamp the stored value over a
`?theme=` / `?scheme=` URL override, which is a this-page-load-only look and deliberately
not a setting. A client with an unsaved Settings draft repaints but does not apply — the
draft is that user's own pending answer to the same question.

`heartbeat` is a **liveness contract, not decoration.** A TCP connection can stop
delivering without ever closing (a Wi-Fi→cellular NAT rebind is the ordinary way), and
`EventSource.readyState` stays `1` indefinitely when that happens — measured at 75s with
`onerror` never firing. Because the server heartbeats every 20s, a client can bound the
silence: nothing for more than ~2.5 heartbeat intervals means the stream is dead whatever
the socket says, and the client reconnects rather than reporting a health it cannot
observe. Recovery then runs through the ordinary `hello` → `epoch` gap-check. A client must
**not** gate that reconnect on a liveness probe — a `fetch` issued inside the same black
hole hangs for its full connect timeout and makes recovery strictly slower.

`epoch` on `hello` is a monotonic vault revision, bumped on every `doc-changed` and
persisted across restarts. The stream keeps no backlog, so a reconnecting client compares
it with the epoch it last saw: unchanged ⇒ nothing was missed, different ⇒ re-read the tree
and whatever doc is open. Settings do not move it — see `settings-changed` above.

---

### App shell

#### `GET /d/{path}` — the doc URL

Not an API route: the SPA shell. The frontend gives every open doc its own URL so a doc can
be linked, refreshed into, and walked back to with the browser's Back button, and `/d/` is
the prefix that reserves a routing space no vault path can ever collide with — `/api/*`,
`/events`, `/vendor/*`, `/healthz` and every file under `app/` (`/app.js`, `/api.js`,
`/themes/*`) live on other first segments.

`{path}` is a **doc path** under the same rule as `/api/docs/{path}`: vault-relative POSIX,
no leading slash, each segment percent-encoded, `/` separators left alone —
`/d/architecture/z-notes-design.md`. A secondary vault's doc is its qualified path, so the
`@` arrives percent-encoded (`/d/%40work-notes/inbox.md`) and decodes before the vault
prefix is read; the unencoded spelling works too.

The response is `index.html` byte-for-byte, with the same `ETag` and `cache-control:
no-cache` the shell gets at `/`; nothing about asset caching or the vendor bundle changes.
The server does **not** check that the doc exists — the client already has the tree and can
say "no such doc" without a round trip, and a 404 shell would be a broken page rather than
an app that can say so. `GET` and `HEAD` only; anything else is `405`.

Because the shell is served from more than one depth, `index.html` carries `<base href="/">`
— that is what keeps `./app.js`, `./themes/*.css` and, through `import.meta.url`, the API
root in `api.js` and the crypto worker's URL resolving against the app root instead of
against whatever doc URL is in the address bar.

#### `GET /settings`, `GET /settings/{section}` — the settings page

The frontend's other routing space, and the same kind of thing as `/d/{path}`: Settings is a
**page** in the editor pane, not a modal, so it has a real address that can be deep-linked,
reloaded and walked back out of. `{section}` is one of `appearance`, `editing`, `trash`,
`git`, `secrets`, `ai`, `terminal` — the page opens scrolled to that group, which is what makes
"open Settings at the AI section" (the statusbar AI chip) a link and not a gesture. An
unrecognised section is not an error: the client degrades it to the top of the page.

Same response as `/d/{path}`: `index.html` byte-for-byte, same `ETag`, `GET`/`HEAD` only.

This is **not** `/api/settings` and never shadows it — the API lives under `/api/*`, which is
matched first, so the read/write surface documented above is untouched by this route.

## Testing Decisions

The whole `tests/` suite is the contract's enforcement: `tests/helpers.ts` (HTTP seam), `tests/api.test.ts`, `tests/routing.test.ts`, and the browser suites. Any contract change starts as a new spec, never an edit here.

## Out of Scope

Auth (the network is the perimeter — SPEC §10), API versioning machinery (v0 is the only version), pagination.

## Further Notes

Originally authored against a service-worker mock before the backend existed; the mock is long deleted and this text describes the real server.
