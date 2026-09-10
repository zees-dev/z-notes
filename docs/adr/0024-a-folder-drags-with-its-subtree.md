# 0024 — A folder drags with its subtree

## Status

Accepted, 2026-08-20. Amends [ADR 0020](0020-a-move-is-on-the-undo-timeline.md),
which made a doc row the only drag source.

## Context

ADR 0020 shipped the whole move transaction — dirty-buffer save, cross-vault
refusal, backlink rewrites, active-path rehoming, one history entry — and the
server's `PATCH /api/docs/{path}` has always moved a folder recursively in a
single `rename(2)`. Only the sidebar disagreed: `wireDragSource` was called on
doc rows alone and the drop handler wrote `type: "file"` by hand, so the one
gesture every file manager has trained into the hand did nothing to a folder,
and the keyboard route (inline rename, which can express any destination path)
was the only way to move one.

Two things a folder source needs that a doc source never did. A folder cannot
go inside itself — the server refuses that with a 400, and this repo's
convention is to mirror a server rule client-side, never to substitute for it.
And a folder's destination is often a folder that is closed: with no way to
open one mid-drag, half the tree is unreachable while the pointer is down.

## Decision

**A folder row is a drag source, and it carries everything under it.**

- The drag state names its own kind, and the drop passes that kind through the
  one client move transaction (`moveEntry`) — which already derived "folder"
  from the node it was handed, so history's `{kind:"move", from, to, type}`,
  its "Move folder" chrome and the server's recursive rename all come for free.
- A vault row stays a destination only. It is a repository, not an entry that
  can be somewhere else, exactly as ADR 0020 left it.
- **The destination-inside-the-source refusal is a client mirror.** The plan
  blocks when the destination parent IS the source or lies under it — which
  also covers dropping a folder on its own row and on its own docs — paints
  `.drop-blocked`, and says "A folder cannot be moved inside itself" on the
  drop. Like the cross-vault refusal it keeps `dropEffect = "move"` so the
  `drop` event still fires and can explain itself; no PATCH is sent either way,
  and the server refuses it a second time.
- **A dwell over a closed destination opens it, in place.** ~600 ms of hover
  over an eligible collapsed folder or vault toggles the two classes its click
  handler toggles and writes `state.folderOpen` / `state.vaultOpen` so the
  expansion survives the next rebuild. One pending timer for the whole tree,
  cleared on dragleave, drop, dragend — and by a rebuild, whose new rows the
  timer's captured elements no longer are.
- **Never `renderTree()` mid-drag.** A rebuild replaces the element the pointer
  is over and Chromium cancels the drag outright — the same discipline that
  makes a `sync-status` frame repaint one dot instead of the tree.

## Consequences

- Pointer and keyboard still reach the same transaction, so ADR 0020's
  guarantees hold for folders unchanged: one commit, backlinks rewritten in
  both directions, one undoable entry that asks before it acts.
- Drag styling still spends no new theme token — `.drag-source`,
  `.drop-target` and `.drop-blocked` are `.row` rules, and a folder row is a
  `.row`.
- The dwell expands a folder the user only hovered. That is a view state, it
  is one click to close again, and it is the price of reaching a closed
  destination without dropping somewhere else first.
- Sibling reordering is still not a gesture (tree order is read from disk), and
  multi-select drag is still out — it would mean more than one commit per
  operation, which is an ADR-sized question of its own.
- `tests/ux-e2e.test.ts` performs a native folder drag into a collapsed
  destination opened by dwell, asserts the moved subtree's bytes on disk and
  undo/redo through the confirmation chrome, and proves the descendant refusal
  paints blocked, sends no PATCH and leaves the timeline empty.
