# 0021 — Undo and Redo on the mobile Edit toolbar

## Problem Statement

The phone's Edit toolbar offers lists and indentation but lacks Undo and Redo.
Accidental text or block deletion therefore requires a hardware keyboard to
recover using the editor's history. Source already has these controls.

## Solution

Add accessible Undo and Redo buttons to the existing mobile Edit toolbar. Use
the same BlockNote history as Ctrl+Z / Ctrl+Shift+Z (Cmd on macOS). Disable
each button exactly when that editor history has no step in its direction.

## User Stories

1. As a phone user, I want to undo an edit or accidental deletion with one tap
   and redo it with another, so that I can recover without a hardware keyboard.
2. As a writer, I want Undo disabled when there is nothing to undo and Redo
   disabled when there is nothing to redo, including on initial load and after
   typing a new edit following undo, so that availability reflects history.
3. As a phone user, I want toolbar taps to preserve editor focus and the caret,
   so that the keyboard stays up and I can continue typing.
4. As a narrow-phone user, I want both controls and the existing formatting
   and calibration actions reachable, so that the toolbar remains usable.
5. As a keyboard user, I want keyboard undo/redo and toolbar undo/redo to share
   state immediately, so that switching input methods does not create separate
   histories.

## Implementation Decisions

- The owner is `app/block-editor.tsx`, the React island described in
  [architecture](../../architecture.md) and
  [ADR 0037](../../adr/0037-blocknote-edits-docs-markdown-stays-the-file.md).
  Its current `Toolbar({ children }: { children: ReactNode })` renders
  `.z-block-toolbar`, with `.z-toolbar-actions` and a fixed ⋯ options button.
- Reuse the pinned BlockNote API: `editor.undo()`, `editor.redo()`, and the
  existing `HistoryExtension` commands queried with `editor.canExec(...)`.
  `EditorController.canUndo(): boolean` and `canRedo(): boolean` already use
  those queries. Observe all editor transactions for live React disabled states,
  including history steps that leave the visible doc unchanged. Reuse
  `useEditorState` from `@blocknote/react` for transaction tracking and cleanup.
  Do not duplicate a history stack, synthesize keyboard events, or route these
  buttons through Source's app timeline. Edit's document history is the boundary,
  per ADR 0037.
- Preserve the toolbar's pointer-default prevention and editor focus. Use
  native disabled buttons with accessible names `Undo` and `Redo`, and a
  toolbar label broad enough to cover formatting and history.
- Reuse `app/themes/base.css` toolbar rules, including disabled opacity and
  the horizontally scrollable actions at phone widths. Keep both history
  controls discoverable and all existing actions reachable at 320–390px;
  change layout only as needed. Desktop visibility and docking/calibration
  behavior remain as documented.
- Update architecture's toolbar inventory and ADR 0037's toolbar description
  in the same change. This amends the action inventory, not history ownership.

## Testing Decisions

The user approved the existing real-server/Chromium browser seam. Extend
`tests/mobile-keyboard-e2e.test.ts`, using its `phone`, `viewport`, `hittable`
helpers and the shared `tests/browser.ts` / `tests/helpers.ts` harness.

- Assert initial disabled states, edit → Undo enabled, tap undo → original
  content with Redo enabled, tap redo → edited content with Redo disabled.
- Cover deletion recovery, keyboard/button history parity, and a new edit
  clearing the redo branch. Measure editor focus and continued typing after
  taps; verify disabled buttons do not change content.
- Cover typing then immediately deleting a character in one history group:
  undo and redo must refresh availability even though the text is unchanged,
  whether initiated by taps or keyboard shortcuts.
- Extend existing narrow-screen reachability assertions to both new buttons.
- Run the focused mobile suite, the existing BlockNote editor and Source
  keybar suites, `bun run gates`, and `bun run lint:docs`.

## Out of Scope

New dependencies, changes to Source, a shared/global undo timeline, file
operation undo, persistence of history across editor remounts, new settings,
new WebMCP tools, source-adapter changes, server/API changes, deployment,
commits and pushes. Restoring the user's deleted AVP VR section is a separate
data-recovery task and must never become a fixture containing private data.

## Further Notes

The user authorized independent child-agent sessions using the current model
through this harness. One implementation agent owns the application and test
edits; the coordinator owns this spec and consolidation. A fresh independent
agent reviews the final diff. Archive this spec to `done/` after verification.

Implemented 2026-09-15. Independent review identified history-only transactions
as an additional acceptance case; the all-transactions subscription and a
regression test resolved it. Re-review found no remaining issues.

The focused mobile, BlockNote and Source keybar suites passed (36 tests); all
six acceptance gates passed (180 tests). A separate `bun run dev` probe confirmed
both controls are visible, hittable and disabled on a fresh doc at 390px.
`bun run lint:docs` and `git diff --check` passed.
