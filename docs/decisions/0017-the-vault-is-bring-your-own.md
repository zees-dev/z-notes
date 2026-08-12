# 0017 — The vault is bring-your-own

## Status

Accepted, 2026-08-12. Decided with
[spec 0007](../specs/done/0007-bring-your-own-vault.md), which carries the
implementation plan. **Amends the operational stance in
[the product spec](../specs/done/0001-z-notes-v1.md) §7's sync design** ("we
never `git init`"): the *pipeline* still never creates a repository — but one
explicit, user-initiated operation now may. Extends
[ADR 0005](0005-images-deploy-via-ghcr.md)'s separation (the image carries no
vault) to the source repo itself.

## Context

The app was always described as "a view over a directory of markdown files",
and the deployment already honours that: the image bakes in no notes, the k3s
PVC mounts at `$ZNOTES_VAULT`, and `server/git.ts` verifies
`git rev-parse --show-toplevel` against the vault root so the vault is only
ever synced as **its own repository**, never as part of an enclosing checkout.

But the source repo did not honour it. The development vault at `./vault` was
committed — real notes, `.znotes/settings.toml`, `.znotes/vault.pub`, and the
passphrase-wrapped `.znotes/identity.age` — so the repo's tree and history
carried one person's data, and the app could not be open-sourced. And because
nothing in the app could ever *create* a vault repository, "bring your own
vault repo" meant manual git surgery on the server's filesystem: the
production PVC was seeded by hand.

## Decision

**The app repo carries the app; the vault is external, and any directory
qualifies.**

- `vault/**` is untracked and `/vault/` is gitignored. The default
  `ZNOTES_VAULT=./vault` remains: a gitignored local scratch vault, fully
  functional offline. No vault content — notes, settings, keyring — may ever
  be committed to the app repo again.
- The vault may be **any** repository: a dedicated notes repo, or an arbitrary
  project that happens to contain markdown. The app's footprint inside it is
  exactly the tracked set (`*.md`, the committed `.znotes` meta, the trash)
  plus z-notes-managed rules in `.git/info/exclude` (per-clone, never staged).
  Everything else in the repo is never staged, modified or deleted. Sync is
  **doc sync**: app code never rides in the vault repo, and the vault never
  rides in the app repo.
- **The pipeline never creates repositories.** An un-initialised vault is a
  working offline vault, exactly as before. The one thing that may run
  `git init` is the explicit **attach** operation (`POST /api/sync/remote`,
  or `ZNOTES_VAULT_REPO` on first boot) — user-initiated, non-destructive and
  atomic: it refuses (naming paths) rather than overwrite a local file, and
  on any failure rolls back everything it created, leaving the vault
  byte-identical. One narrow exemption from the refusal: the `settings.toml`
  the server itself manufactures at boot. When it is the sole colliding path,
  attach parks the local copy under `.znotes/tmp/` and adopts the remote's —
  every vault has a boot-written `settings.toml`, so without the carve-out no
  populated remote could ever be attached. The keyring is never exempt: a
  local `identity.age` losing to a remote one is a lost key.
- **The secrets contract is unchanged and travels with the vault.** The
  keyring lives in `<vault>/.znotes/` and moves with the vault repo through
  attach, pull and push; the crypto *code* stays in the app repo; the server
  still never sees a passphrase and `server/` still never imports
  `age-encryption`. Extending [ADR 0006](0006-passphrase-strength-is-advice.md):
  a committed keyring means a vault repo's secrecy rests on the passphrase's
  strength and the repo's visibility — both the user's choice, neither enforced
  nor warned about by the app beyond the existing entropy advice at passphrase
  creation.
- The credential rule is unchanged and applies to attach verbatim: the token
  lives only in sqlite, reaches git only through the askpass environment, and
  a URL carrying userinfo is refused so a credential can never land in
  `.git/config`.

## Consequences

- The app can be open-sourced: from this change forward the tree is clean.
  **History is not** — every previously committed note and the wrapped
  identity remain in past commits, so publication requires a fresh repo or a
  history rewrite (and passphrase rotation if in doubt). That is a human step,
  deliberately outside the implementation.
- A fresh deployment self-seeds: empty PVC + `ZNOTES_VAULT_REPO`
  (+ `ZNOTES_GIT_TOKEN`, absorbed into sqlite first-run-only) clones nothing
  into place — attach is init + fetch + checkout, which is what lets a
  non-empty vault and the live credential store survive it.
- A brought project repo will visibly gain a committed `.znotes/` directory
  and `sync: <ISO> · n file(s)` commits for markdown changes. That is the
  contract, not a bug to soften.
- `tests/gitsync.test.ts`'s founding comment ("the server never runs
  `git init`") narrows to the pipeline; the attach tests own the exception.
- The development loop changes shape: `./vault` is scratch, and a contributor
  brings (or attaches) their own vault to work against real sync.
