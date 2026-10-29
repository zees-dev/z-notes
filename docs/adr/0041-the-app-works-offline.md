# 0041 — The app works offline

## Status

Accepted, 2026-10-28. Implements
[spec 0024](../specs/done/0024-built-installable-offline-app.md). Builds on
[ADR 0040](0040-the-frontend-is-built.md) and
[ADR 0042](0042-one-canonical-origin.md).

Amends: [ADR 0012](0012-save-state-is-a-statusbar-pip.md) — the save pip has a
third state, "Saved on this device". Supersedes the last Consequence of
[ADR 0007](0007-installable-web-app.md) (no service worker, no offline story).

## Context

The user could not read their notes on a plane. `app/index.html` unregistered
every service worker at boot, and with no network `start()` threw "Cannot reach
the z-notes backend." The files on the server stay the source of truth; what is
missing is a copy on the device and a way to send edits back.

## Decision

- **The service worker caches the release, not the data.** `/sw.js` is generated
  per build and precaches every URL of that build into `znotes-<build id>`, shell
  first. The shell and `/assets/*`, `/manifest.json`, `/themes/*` and `/icons/*`
  are served cache-first. It never intercepts `/api`, `/events`, `/healthz` or
  `/sw.js`. An install that finds a different build id in `/` throws, to retry.
- **A new release waits for the user.** The worker never calls `skipWaiting()`
  itself. The page shows "A new version is ready"; Reload (a tap anywhere on that
  notice) first flushes the dirty buffer, then activates the worker and reloads.
  An open page keeps loading its own build's lazy chunks.
- **Kill switch.** `ZNOTES_SW=off` makes `/sw.js` a worker that deletes the
  `znotes-` caches, unregisters itself and navigates its windows. It never
  touches IndexedDB, and `Clear-Site-Data` is never sent: either would wipe the
  outbox.
- **The replica is the device's copy of data.** `app/replica.js` (a leaf, IndexedDB
  `znotes`) holds every vault's tree and docs, settings and keyring. `app/api.js`
  stays the only file that touches the network: successful reads write through,
  and on a connection failure a read answers from the replica. A background
  refresh, driven by each doc's `rev` and the vault `epoch`, keeps it complete.
- **Saves are written ahead.** Every save lands in the per-doc **outbox**, durably,
  before its `PUT`, and leaves it only on the server's `200`. A save the server
  never acknowledged survives a killed app and is **replayed** when the network
  returns. A doc open in the editor is replayed by the editor's own autosave.
- **A replay that meets someone else's change raises the existing conflict
  banner** (409), the orphan dialog (404), or, for an offline-created doc whose
  path was taken, the conflict banner. Nothing is auto-merged and nothing is
  overwritten silently. Entries that cannot replay are blocked and surface as one
  sticky "offline edit(s) need you" toast.
- **`PUT /api/docs/{path}` is idempotent on bytes.** Identical bytes answer 200 with
  the current rev whatever rev the client sent, so a replay whose first reply was
  lost succeeds instead of raising a false conflict.
- **Scope.** Offline: read, edit, create docs, search (`server/search-match.ts`,
  shared with the server) and reveal or create secrets. Everything else — rename,
  move, delete, folders, trash, settings writes, AI, terminal, git sync — fails
  through its own error path with "You're offline — this needs the server." and
  changes nothing. **Offline** means the last request failed for lack of a
  network, not `navigator.onLine`.
- **Secrets stay as they are.** The replica holds the passphrase-wrapped keyring
  (the bytes already committed to the vault's git repo) and armor only; plaintext
  and passphrases are in no replica, outbox or request.

## Consequences

- The pip reads "Saved on this device" for a queued save; "Saved" and the "Saved
  to disk" toast mean server-acknowledged, as before. A save counts as queued only
  when its outbox write committed; with no replica, a failed save is unsaved, as
  before.
- The exit guard treats bytes held in the outbox as safe: leaving a buffer that
  equals its queued bytes does not ask, so offline editing can move between docs.
  A save the server refused (not one it never received) still keeps the buffer.
- Replay skips only the doc the editor owns (open, or with a save in flight); a
  buffer the user navigated away from is replayed like any other entry.
- IndexedDB is no longer empty: secrets' "never IndexedDB" rule (spec 0004) holds
  for passphrases and plaintext, and `tests/secrets-e2e.test.ts` scans the replica
  for them.
- A quota failure on the outbox write says so and leaves the buffer unsaved.
- Safari tabs lose IndexedDB after seven days without a visit; Chrome's installed
  app is the primary surface, and `navigator.storage.persist()` is asked once.
- Known limits, accepted: the outbox holds one entry per doc per device, so two
  tabs editing the same doc offline keep only the later save; accepting an update
  in one tab drops the old release's cache under any other open tab, whose
  not-yet-loaded chunks then fail until it reloads; the kill worker navigates
  every window, so a buffer that no save path can hold (an orphan) is lost; and a
  change to `ZNOTES_ORIGIN` or `ZNOTES_SW` alone reaches installed devices with
  the next release, not before (the build id covers the build, not the options).
- Not done: auto-merge, CRDTs, a server change log, Background Sync (replay runs
  from the page), and keeping the previous build for skewed clients.
- The cached shell must keep its `origin-agent-cluster` and `permissions-policy`
  headers for WebMCP; `tests/offline-e2e.test.ts` asserts the tools register on a
  service-worker-served load.
