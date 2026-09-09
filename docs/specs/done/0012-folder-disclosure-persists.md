# 0012 — Folder disclosure persists per browser

## Problem Statement

Which folders (and vault rows) are open or closed in the sidebar tree is held in
`state.folderOpen` / `state.vaultOpen` (app/state.js) for the life of the tab.
The server's `folders` table seeds `open` for a folder but the client never
writes a close back, so every reload — and every restart of the app or the
browser — reopens every folder. A person who keeps three of forty folders open
re-closes the other thirty-seven every morning.

The fold store for Preview sections (ADR 0023, `markdown.js` `FOLD_STORE`)
already solves the same problem one pane over: a view choice the server has no
opinion about, remembered in `localStorage`. Folder disclosure gets the same
treatment.

## Solution

Remember disclosure in the browser, write-through, and consult it whenever the
tree is (re)indexed:

- One `localStorage` key, `znotes.tree-open`, holding
  `{ "folders": { "<qualified folder path>": true|false }, "vaults": { "<vault id>": true|false } }`.
- Precedence when a folder is first seen in a session (`indexTree`,
  app/tree.js:44): stored value → server `n.open` → `true`. Vault rows: stored
  value → `true` (they have no server opinion today).
- Every site that changes disclosure writes through: the row click
  (tree.js:508–509 and :577–578 for vault rows), the drag-dwell auto-open
  (tree.js:206–207), and `revealFolder` (tree.js:731–741).
- Keys that name a folder or vault no longer in the tree are pruned after each
  successful `loadTree()`, so a renamed or deleted folder ages out rather than
  accumulating. (A renamed folder loses its state; that is the honest reading,
  same as a renamed doc's folds.)
- Unreadable storage (private mode, a shape a later version wrote) means "no
  memory": every folder renders as the server says. Never throw.

## User Stories

1. As a user, I want a folder I collapsed to still be collapsed after I reload,
   restart the server, or reopen the browser, so that my tree stays the shape I
   left it.
2. As a user, I want a folder I expanded (by click, by dragging a doc over it,
   or by the app revealing the doc I opened) to stay expanded on reload, for the
   same reason.
3. As a user, I want the same for a secondary vault's row (`@id`), so that a
   vault I keep folded stays folded.
4. As a user, I want a folder I rename or delete not to leave a ghost entry
   behind, so that storage stays small and predictable.
5. As a user in private mode or with storage disabled, I want the tree to work
   exactly as it does today (server-seeded, open by default), so that a missing
   cache never breaks the sidebar.
6. As a user with two tabs open, I want the last tab that toggled a folder to
   win on the next reload, so that behaviour is at least predictable (no
   cross-tab live sync is expected).

## Implementation Decisions

- **Module**: app/tree.js owns the store (it is the only writer of
  `folderOpen`/`vaultOpen`). Add, near the top of the file, alongside the row
  geometry helpers:

  ```js
  const OPEN_STORE = "znotes.tree-open";
  let openStore = null; // { folders: {}, vaults: {} } — loaded once, lazily
  function loadOpenStore() { /* JSON.parse(localStorage.getItem(OPEN_STORE)) with try/catch; shape-check both maps are plain objects */ }
  function persistOpenStore() { /* try { localStorage.setItem(...) } catch (_) {} */ }
  function setFolderOpen(path, open) { state.folderOpen.set(path, open); openStore.folders[path] = open; persistOpenStore(); }
  function setVaultOpen(id, open)   { state.vaultOpen.set(id, open);   openStore.vaults[id] = open;   persistOpenStore(); }
  ```

  Replace the five direct `state.folderOpen.set` / `state.vaultOpen.set` calls
  at the change sites listed in Solution with these helpers. Leave the seeding
  site (`indexTree`, tree.js:44) as a read: it becomes
  `if (!state.folderOpen.has(n.path)) state.folderOpen.set(n.path, stored(n.path) ?? !!n.open)`
  where `stored()` reads `openStore.folders`. Seed vault rows the same way
  wherever `state.vaultOpen` is first consulted (tree.js:553 — do NOT write
  the default back into the store; only user actions write).
- **Prune** at the end of `loadTree()` (after `indexTree` has run): drop store
  keys not present in the freshly indexed tree / `state.vaults`; persist only if
  something was dropped.
- Write-through is synchronous and unbounded — a vault has tens of folders,
  not tens of thousands. No cap, no debounce.
- `docs/architecture.md`'s "where state lives" paragraph for the frontend gets
  one sentence: folder and vault-row disclosure is a client-only view choice
  mirrored to `localStorage` (`znotes.tree-open`), the twin of `znotes.folds`.
- Update the `folderOpen` / `vaultOpen` comments in app/state.js to say they
  are mirrored to localStorage by tree.js.
- No WebMCP change (there is no folder-toggle tool today; adding one is out of
  scope).

## Testing Decisions

- Seam: the browser, via `tests/browser.ts`. Prior art: `tests/fold-e2e.test.ts`
  (the fold store's persistence tests — imitate its reload-and-assert shape).
- New file `tests/tree-open-e2e.test.ts` (or a new `describe` in
  `tests/fileops-e2e.test.ts` if that file already boots a tree with folders —
  prefer the new file). Cases:
  1. click a folder row closed → reload → the row renders without `.open` and
     its `.children` has `.closed`; the localStorage blob holds `false` for it.
  2. click it open again → reload → open; the blob holds `true`.
  3. a folder never touched renders as the server says (open) and has no entry.
  4. delete/rename the folder through the API, reload → the stale key is gone
     from the blob.
  5. with `localStorage.setItem("znotes.tree-open", "not json")` before load,
     the tree boots with every folder open and no page error.
- Bare-minimal: five short tests, one page, no gold-plating.

## Out of Scope

- Syncing disclosure to the server or across browsers/devices.
- A WebMCP tool for toggling folders.
- Live cross-tab sync (`storage` events).
- Remembering scroll position of the sidebar.
- Any change to the server's `folders` table or `GET /api/docs` shape.

## Further Notes

No ADR: this is the ADR 0023 pattern (a view choice mirrored per browser)
applied to a second surface; the spec archive is the record. Do not touch
app/markdown.js's fold store — the two stores stay separate keys with separate
shapes.
