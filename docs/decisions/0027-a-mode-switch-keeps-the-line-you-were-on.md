# 0027 — A mode switch keeps the line you were on

## Status

Accepted, 2026-08-21. Refines [spec 0001](../specs/done/0001-z-notes-v1.md)'s
click-to-edit and ⌘E, and builds on
[ADR 0015](0015-a-newline-is-a-line-break.md) — the reason there is
a shared coordinate to keep at all.

## Context

Clicking a line in Preview jumped the document and left the caret somewhere
else, and the deeper into a note you clicked, the further it went. Measured in
a real browser on a long wrapping note: 73px off near the top of the document,
413px deep in, and ~368px at every depth on a phone — half a screen.

The intent was already there. The click passed the clicked line and the screen
offset it was sitting at; the receiving code then located that line by
multiplying it by the textarea's line height. That is the truth only while no
line wraps. Raw soft-wraps by default, so every wrapped row above the target
counted as zero, and the error accumulated with the document — worst in exactly
the long notes where losing your place costs the most.

Preview and Raw are two renderings of one document at two different heights, so
the scroll offset means nothing across the switch either: keeping it, which is
what ⌘E and the mode chip did, moves the words for the same reason.

## Decision

**A mode switch preserves the source line under the reader, and where on screen
it sits — never a pixel offset, and never a line height multiplied by a line
number.**

- **Position is measured, not computed.** The textarea's insertion point has no
  box of its own, so it is located by mirroring the bytes before it in the
  textarea's real typography and reading the marker's rect — wrapped rows then
  count exactly as they do on screen. The mirror already existed for keeping the
  caret above the soft keyboard; locating a line is the same question.
- **The source line is the coordinate both modes share** (ADR 0015 gives every
  rendered line its own `[data-line]`). A click carries its own line; ⌘E, the
  chip and Esc read the line at the top of Preview, or in Raw the caret's line,
  and put it back at the same offset.
- **An anchor nobody can see is not an anchor.** Leaving Raw with the caret off
  screen keeps the current offset rather than scrolling to a line the reader is
  not looking at, and a line inside a folded section (ADR 0023) is left alone —
  a fold is not a mode switch's to open.
- **A phone that declines the focus still owes the reader the line.** Raw does
  not steal focus on a phone, because that throws a keyboard over half the
  screen; the scroll happens regardless.

## Consequences

- Click-to-edit lands on the clicked line with zero pixels of movement, at any
  depth, on desktop and phone alike — measured, and held by an e2e test that
  fails by ~400px against the old arithmetic.
- ⌘E round-trips are stable: Preview → Raw → Preview returns the same words to
  the same place.
- Locating a line costs one mirrored layout per switch, on a surface that is
  already re-rendering the whole document.
