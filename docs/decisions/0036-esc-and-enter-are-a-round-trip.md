# 0036 — Esc and Enter are a round trip

## Status

Accepted, 2026-09-10. Implements
[spec 0017](../specs/done/0017-enter-resumes-editing.md). Refines
[ADR 0027](0027-a-mode-switch-keeps-the-line-you-were-on.md) — the same
"keep the line where it sits" rule, aimed at the caret's line rather than the
pane's top one — and rides on
[ADR 0032](0032-raw-is-a-line-editor.md)'s surface (`boxAt`,
`selectionStart`, `setSelectionRange`).

## Context

Esc has always left Raw for Preview. Nothing went the other way to the place
you were: ⌘E and the statusbar mode chip re-enter Raw at the line at the TOP of
the pane, and click-to-edit needs a pointer and a guess at which line the
sentence was on. Stepping out to read the rendered note and carrying on typing
therefore cost a hunt for your own caret — the one thing the app knew and threw
away on the way out.

Enter was free in exactly one situation, and only that one: the document
showing, with nothing more specific focused. Everywhere else it is already
spoken for — a modal's primary action, a tree row's rename, a field's own
Enter, a newline in Raw.

## Decision

**Enter, pressed with nothing focused while Preview is showing, re-enters Raw
at the caret you left with — and holds that caret's line where it already sits
on screen.**

- **The caret is remembered on the way OUT, per doc.** `setMode` is the one
  door out of Raw (Esc, ⌘E, the chip, a click on the pane, Back on a phone), so
  it reads `#rawArea.selectionStart` there, before `renderDoc` replaces the
  editor. A `Map` in editor.js, keyed by qualified path, holding one number per
  doc opened this session.
- **A stale offset is clamped, not tracked.** An SSE reload, an accepted
  proposal and an undo all change the text under a remembered caret; resuming
  clamps to the document's length rather than validating or invalidating
  entries. Nothing clears the map, and nothing persists it — a reload starts
  the reading fresh.
- **The caret's line is the anchor.** ADR 0027 keeps the line the reader is
  looking at; "carry on typing" is about the line the CARET is on, so that is
  the one held in place. A caret line that is scrolled away — or folded
  (ADR 0023) — has no box to aim at, and Enter then scrolls it into view rather
  than refusing: Enter always means "continue editing".
- **Only the unclaimed press is taken.** Modifiers are excluded outright, and
  so is any target inside a control, a link, a field, the shell's own regions
  or a floating layer. A doc nobody has edited this session resumes at offset 0.
- **No new agent verb.** The tool table
  ([ADR 0031](0031-the-agent-gets-the-same-doors.md)) is unchanged: `set_mode`
  switches the pane, and an agent has no lost place to find.

## Consequences

- Reading and writing are one keystroke apart in each direction, and neither
  direction moves the document: Esc → Enter returns the same words to the same
  pixels (held by `tests/resume-e2e.test.ts`, measured with `boxAt` against the
  rendered block's own rect).
- Each doc resumes at its own caret across a switch and back.
- Enter over the exit guard ([ADR 0022](0022-asking-before-leaving-edits-is-a-preference.md))
  is unchanged: the mode gate cannot fire while a veil is up, and the modal's
  primary is checked first regardless.
- A phone is untouched. There is no Enter without a keyboard; click-to-edit and
  the keybar (ADR 0034) remain the doors.
