# 0018 — Vaults are a prefix

## Status

Accepted, 2026-08-13. Decided with spec 0008 (`docs/specs/done/0008-multi-vault.md`),
which carries the implementation plan. Extends
[ADR 0017](0017-the-vault-is-bring-your-own.md) — the vault became external and
attachable there; here it becomes plural — and narrows the doc-path grammar of
[ADR 0002](0002-http-api-v0-error-shape.md) by one reserved character.

## Context

The server bound exactly one vault. `ZNOTES_VAULT` resolved to a directory and
one of everything was built around it — `Vault`, `Index`, `Settings`,
`Reconciler`, `Trash`, `GitSync`, `DocStore` — and every route addressed docs
by a path relative to that one root. A user with two repositories of notes, or
a notes repo plus a project that happens to contain markdown, could see one of
them at a time and no more.

The two obvious shapes were both worse than they look. A **route namespace**
(`/api/vaults/{id}/docs/…`) duplicates the route table, the client's network
funnel, the SSE payloads and every `/d/` URL, and it invalidates every path a
user has bookmarked. A **registry file** listing arbitrary directories is a
second source of truth that a restore, a clone or a `rm -rf` silently
contradicts, and it makes "which vaults exist" a question the filesystem can
no longer answer.

## Decision

**One primary vault addressed exactly as it is today; every other vault is an
`@id/` prefix on those same paths.**

- The `ZNOTES_VAULT` vault is the **primary vault**, id `vault`. Its doc paths
  stay bare, its routes stay what they are, and all app-level state lives
  there and nowhere else: theme/editor/secrets/AI/terminal settings, the
  keyring, the AI relay, the terminal, `editor.homeDoc`, and the
  `ZNOTES_VAULT_REPO` boot provisioning. A single-vault install cannot tell
  that this decision happened.
- A **secondary vault** is a direct subdirectory of `ZNOTES_VAULTS_DIR` and a
  full independent stack — its own `Vault + Index + Settings + Reconciler +
  Trash + GitSync + DocStore`. Per-vault: the remote, branch, sync cadence and
  token, the trash and its retention, the search index, the fs watcher.
  Everything app-level above is not.
- **One home holds them all.** `ZNOTES_VAULT` defaults to
  `$ZNOTES_VAULTS_DIR/vault`, so an install is one directory with one
  subdirectory per repository rather than two directories meaning different
  things. The primary is special in what it *owns*, not in where it *sits*: the
  boot scan skips it by real path wherever it is, which is also what lets a
  deployment keep it on its own mount. The two overlaps that would double-index
  are still refused — the home inside the primary, or the primary deeper than a
  direct child of the home — and cost the secondaries, never the app.
- **A doc in a secondary vault is `@<id>/<vault-relative path>`**, through
  every doc surface there is — `/api/docs/*`, search hits, trash entries, SSE
  `doc-changed` frames, `/d/…` URLs, client state. The router strips the
  prefix and delegates to that vault's stack; below the registry nothing has
  ever heard of a prefix.
- **Vault content never carries the prefix.** Markdown, `[[links]]` and git
  pathspecs are vault-relative, so a vault repo stays portable — the same repo
  is somebody else's *primary* vault — and a `[[slug]]` resolves inside its
  own vault only. Cross-vault moves are refused for the same reason: a move is
  a `rename(2)` plus a link rewrite, and neither crosses a repository.
- **`@` is a reserved path segment.** `safePath` refuses a segment beginning
  with `@` and the scanners skip such directories, exactly as both already do
  for a dot-prefix. No vault can hold a doc whose path collides with the
  grammar, so disk and grammar can never disagree.
- **The registry is the filesystem.** Every direct subdirectory of the vaults
  home whose name is a valid id is a vault; there is no registry file and no
  table to migrate. Adding one is the ADR 0017 **attach** operation run
  against a freshly created directory, so every guarantee attach makes —
  non-destructive, atomic, the token only ever in sqlite and askpass — is
  inherited verbatim, and a failed add leaves no directory behind.
- **Disconnect never deletes.** Removing a vault stops its stack and drops it
  from the registry; the directory and its git repository stay on disk,
  untouched. Deleting notes is a human act, and the UI names the surviving
  path rather than performing it.

## Consequences

- One reserved character is the entire cost to the existing contract. Every
  bookmarked URL, every test and every client funnel keeps working unchanged;
  `GET /api/docs` grows an additive `vaults[]`, `sync-status` an additive
  `vault`, and the primary's frames say `"vault": "vault"`.
- Vaults cost linearly: one recursive `fs.watch`, one sqlite connection and
  one git working tree each. A handful is fine (macOS caps watched paths per
  watcher, not per process), and the one-replica invariant is untouched —
  more vaults, still one process.
- `vaultEpoch` stays a single global counter in the primary index. The
  client's gap-resync compares one number from `hello`, and a reconnect
  re-reads the whole tree anyway; per-vault epochs would complicate the
  protocol for no recovery it does not already have.
- The v1 boundaries are behaviour, not omissions. A doc in a secondary vault
  reaches the AI relay without doc context, the terminal stays rooted at the
  primary, and the browser encrypts new secret blocks to the primary recipient
  wherever the doc lives — so blocks created in-app always unlock, and a
  secondary vault carrying its *own* committed keyring answers with the
  ordinary wrong-key failure.
- A disconnected vault's surviving directory refuses a re-add of the same
  remote, because a directory under the vaults home is by definition a vault
  the next boot would scan. Removing it by hand is the documented path.
- A secondary vault's `settings.toml` is still loaded, healed and committed by
  its own `Settings`, but the app reads only its `git` and `trash` sections.
  The rest rides along untouched, for whatever install uses that repo as its
  primary.
