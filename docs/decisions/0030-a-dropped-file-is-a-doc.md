# 0030 — A dropped file is a doc, not an upload

## Status

Accepted, 2026-09-02. Implements [spec 0010](../specs/done/0010-drop-to-upload.md).
Builds on [ADR 0019](0019-an-explicit-file-extension-is-literal.md) (what a doc
is) and [ADR 0014](0014-file-operations-undo-but-they-ask.md) (file operations
are on the undo timeline).

## Context

Until now the only way a file reached a vault from outside the app was git or
the filesystem. The sidebar already had a complete drag-and-drop model — a doc
row means its parent folder, a folder row means itself, a vault row means that
vault's root, and a 600 ms dwell opens a closed folder under the pointer — but
it only understood drags the app itself had started. A file dragged in from
Finder was ignored, and a drop that missed the tree made the browser navigate
away from the app to the raw file, taking the unsaved buffer with it.

The obvious shape for this is an upload route. It is the wrong one. `POST
/api/docs` already mints a doc from `{ path, type, markdown }`, refuses
duplicates with `409 exists` and unsafe names with `400 bad-path`, and ADR 0019
already says any visible, extension-bearing, UTF-8 file is a doc. An upload
route would be a second way to create a doc, with its own idea of what a doc is,
that would then have to be kept in step with the first.

## Decision

**There is no upload route. A file dropped on a tree row is `POST /api/docs`
carrying that file's text, and which extensions may be dropped is a setting.**

- The destination rule and the hover mechanics are the move gesture's own —
  the same `drop-target` paint, the same `dwell`, the same `dragleave`. One
  extracted `dropFolder(target, kind)` is what both drops share; nothing about
  a move changed.
- Every refusal the client can make, it makes before sending: an extension
  outside `settings.upload.extensions`, a file over the server's 8 MiB body
  cap, bytes that are not valid UTF-8, a directory. Each names the file and
  the reason, and one refused file never stops the next in the same drop.
- Every refusal it cannot make is the server's, unchanged, and its message is
  read out verbatim — a duplicate name (`409 exists`), a name carrying `]`, a
  line break, a hidden or `@` segment (`400 bad-path`).
- `settings.upload.extensions` is a comma-separated string, healed on read and
  on `PUT` by one exported `normalizeExtensions` — lowercase, dot-less,
  de-duplicated. It is a **client** filter: the server does not gate `POST
  /api/docs` by it, because the sidebar's own inline create legitimately makes
  `report.txt` and ADR 0019 is what rules on what a doc is.
- An upload lands on the undo timeline as an ordinary create, so ⌘Z asks before
  deleting it exactly as it does after an inline one.
- A drop the tree has not claimed is swallowed at the window, with the no-drop
  cursor. The app is not a file viewer.

## Consequences

- Adding a droppable file type is a settings edit, not a code change, and it
  cannot desynchronise from what the server will store: one normalisation, and
  the response carries what was stored.
- Binary files, images and non-UTF-8 text stay out of the vault by the same
  rule that keeps them from being docs at all. Nothing here is a place to relax
  that later without amending ADR 0019 first.
- There is deliberately no rename-on-conflict (`note (2).md`), no progress UI,
  no drop overlay beyond the row class the move already had, and no upload
  button. The server's `409` is the answer to a name that is taken.
- The window-level swallow is skipped once something has called
  `preventDefault()`, so a tree row that accepted the drag keeps it. An
  internal move carries no `"Files"` and reaches neither branch.
