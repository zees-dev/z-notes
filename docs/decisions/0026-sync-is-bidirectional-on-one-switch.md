# 0026 — Sync is bidirectional on one switch

## Status

Accepted, 2026-08-21. Amends [spec 0001](../specs/done/0001-z-notes-v1.md) §7,
which defined sync as a write-side pipeline only, and makes an additive
behavior change to [spec 0002](../specs/done/0002-http-api-v0.md)'s
`GET /api/sync/status`: no field changes shape, but `behind` becomes truthful.

## Context

Auto-sync was half a promise. `git.autoSync` armed a debounce that staged,
committed and pushed local changes — but nothing in the server ever asked the
remote whether it had moved. The only `pull --rebase` ran as the retry after a
rejected push, so a note written on another device arrived only when a local
edit happened to collide with it, `behind` was stale by construction, and the
Settings card's own copy ("pull on focus") described behavior that did not
exist. A notes vault synced through git is a multi-device story or it is
nothing.

## Decision

**One switch, both directions.** While `git.autoSync` is on, every `GitSync`
polls its upstream (`ls-remote --heads`, no object transfer) on the
`git.autoSyncSeconds` cadence, and a moved remote triggers the pipeline. The
pipeline itself — every trigger, manual included — now fetches before it
pushes and takes what origin has via `merge --ff-only` when the vault is
strictly behind. No new settings key, route, field or SSE event.

- **The pull runs inside the one pipeline pass**, after commit and before
  push, so the write guards, the canaries, single-flight and the writer lock
  cover it identically. Divergence (ahead AND behind) is deliberately left to
  the push's existing rejection path: the rebase retry is the one shape that
  keeps history linear, and it already refuses while the tree carries changes
  the pipeline did not just commit.
- **`--ff-only` is the only merge this app performs.** It cannot write a
  conflict marker or invent a merge commit, and git refuses it rather than
  overwrite a working-tree file — the worst case is a named refusal, never a
  lost edit. The non-destruction rule of 0001 §7 stands unamended.
- **A poll tick that cannot reach the remote skips silently.** Offline is not
  an error, and a background loop must never latch the statusbar red from a
  train. An error that IS raised now stands while the vault is ahead **or**
  behind — a refused fast-forward stages nothing, so `ahead` alone would let
  it self-clear.
- **Pulled files reach clients through the machinery that already existed**:
  the reconciler's doorbell turns them into `doc-changed` (`external`) frames;
  the vault row's dot and statusbar chip follow `sync-status`.
- **Sync is a verb everywhere a vault is.** The left-nav vault row's context
  menu gains "Sync" — `POST /api/vaults/{id}/sync`, the primary resolved
  through the registry like any other id — and the Settings cards pair the
  auto-sync switch with "Sync now" in one action row.

## Consequences

- Every sync with an origin costs one extra `fetch`; every poll tick costs at
  most two read-only git spawns per vault with a remote. A vault with nothing
  attached costs nothing, forever (the tick reads the cached snapshot only).
- A pull rings the reconciler, which re-arms the commit debounce → one no-op
  auto pass per pull. Accepted, not accidental: suppressing it would thread a
  flag through the doorbell for the price of a few read-only spawns.
- An upstream branch that does not exist yet is not a fetch failure — an empty
  remote is seeded by the push's `--set-upstream`, exactly as attach promises.
- `git.autoSync: false` now means fully manual in both directions; "Sync now"
  still pulls, commits and pushes.
