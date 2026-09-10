# 0030 — A dropped file is a doc, not an upload

## Status

Accepted, 2026-09-02. Implements [spec 0010](../specs/done/0010-drop-to-upload.md).
Builds on [ADR 0019](0019-an-explicit-file-extension-is-literal.md) and
[ADR 0014](0014-file-operations-undo-but-they-ask.md).

## Context

Until now a file reached a vault from outside the app through git or the
filesystem. The sidebar's drag-and-drop model was already complete: a doc row
means its parent folder, a folder row means itself, a vault row means that
vault's root, and a 600 ms dwell opens a closed folder under the pointer. It
understood only drags the app had started, so a file from Finder was ignored,
and a drop that missed the tree navigated the browser to the raw file, taking
the unsaved buffer with it.

An upload route is the obvious shape and the wrong one. `POST /api/docs`
already mints a doc from `{ path, type, markdown }`, refuses duplicates with
`409 exists` and unsafe names with `400 bad-path`, and ADR 0019 already calls
any visible, extension-bearing, UTF-8 file a doc. A second creation route would
carry its own idea of what a doc is, to be kept in step with the first.

## Decision

**There is no upload route. A file dropped on a tree row is `POST /api/docs`
carrying that file's text, and which extensions may be dropped is a setting.**

- The destination rule and the hover mechanics are the move gesture's own: the
  same `drop-target` paint, `dwell` and `dragleave`. Both drops share one
  extracted `dropFolder(target, kind)`; nothing about a move changed.
- Every refusal the client can make, it makes before sending: an extension
  outside `settings.upload.extensions`, a file over the server's 8 MiB body
  cap, bytes that are not valid UTF-8, a directory. Each names the file and the
  reason, and one refused file never stops the next in the same drop.
- The rest are the server's, unchanged, and read out verbatim: a duplicate name
  (`409 exists`), or a name carrying `]`, a line break, a hidden or `@` segment
  (`400 bad-path`).
- `settings.upload.extensions` is a comma-separated string, healed on read and
  on `PUT` by one exported `normalizeExtensions` to lowercase, dot-less,
  de-duplicated tokens. It is a **client** filter: the server does not gate
  `POST /api/docs` by it, because the sidebar's inline create legitimately
  makes `report.txt` and ADR 0019 rules on what a doc is.
- An upload lands on the undo timeline as an ordinary create, so ⌘Z asks before
  deleting it exactly as after an inline one.
- A drop the tree has not claimed is swallowed at the window, with the no-drop
  cursor, because the app is not a file viewer. The swallow is skipped once
  something has called `preventDefault()`, so a tree row that accepted the drag
  keeps it, and an internal move carries no `"Files"` at all.

## Consequences

- Adding a droppable file type takes a settings edit and no code change. One
  normalisation keeps the list and the stored value identical.
- Binary files, images and non-UTF-8 text stay out of the vault by the rule
  that keeps them from being docs at all. Relaxing that means amending
  ADR 0019 first.
- There is deliberately no rename-on-conflict (`note (2).md`), no progress UI,
  no drop overlay beyond the row class the move already had, and no upload
  button. The server's `409` answers a name that is taken.
