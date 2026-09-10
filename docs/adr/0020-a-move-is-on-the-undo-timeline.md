# 0020 — A move is on the undo timeline

## Status

Accepted, 2026-08-16. Amends [ADR 0014](0014-file-operations-undo-but-they-ask.md),
whose first version deliberately excluded renames and moves from history.

## Context

The sidebar could move a doc only by editing its full path. There was no
pointer gesture, and the app-owned history could undo text, create and delete
but not a move. Adding drag/drop through a second network path would split the
hard parts already solved by inline rename: saving a dirty active buffer,
navigation ownership while the request is in flight, backlink rewrites,
cross-vault refusal, SSE races, tree reload and active-path rehoming.

The tree is derived and sorted from disk; it has no row-order state. Dragging
therefore cannot mean rearranging siblings.

## Decision

**A drag is a filesystem move, and every successful user move is undoable.**

- A doc row is a drag source. A folder or vault row is a destination; dropping
  on a doc means its parent folder. The destination is that folder plus the
  source's exact basename. Same-parent drops are no-ops, and there is no
  before/after reordering.
- Drag/drop is within one vault only. Cross-vault targets show a refusal and
  send no PATCH; the server remains authoritative and refuses one too.
- Inline rename and drag/drop share one client move transaction and the same
  `PATCH /api/docs/{path}` operation. The inline path stays the keyboard route
  and can express rename and a destination that does not yet exist.
- A successful user move or rename records
  `{kind:"move", from, to, type}` after the server transaction lands. Undo
  PATCHes `to → from`; redo PATCHes `from → to`, through the same transaction
  with recording disabled. A failed, blocked or cancelled application leaves
  the history entry on its stack.
- Move undo/redo uses ADR 0014's confirmation chrome. Backlink rewrites run in
  both directions as ordinary semantic moves; history never restores stale
  pre-rewrite bytes behind the server's planner.

## Consequences

- Pointer and keyboard paths have identical save, navigation, link-rewrite,
  error and SSE behavior instead of two implementations that can drift.
- ADR 0014's one ordered timeline now interleaves text, create, delete and
  move entries. Recording a move flushes the current text run first, so the
  user's chronology remains exact.
- Drag styling uses existing theme tokens. No theme contract grows merely to
  represent transient valid/blocked drop state.
- Real-browser coverage performs a native mouse drag, asserts disk bytes and
  active navigation, then confirms undo and redo. Multi-vault coverage proves
  a refused drag sends no move request and records no history.
