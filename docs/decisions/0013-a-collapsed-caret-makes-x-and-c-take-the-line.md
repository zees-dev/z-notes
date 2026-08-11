# 0013 — With nothing selected, ⌘X and ⌘C take the line

## Status

Accepted, 2026-08-10. Extends the Raw editing surface described in
[the product spec](../specs/done/0001-z-notes-v1.md) §"Two modes", alongside
the Tab/Shift-Tab and list-continuation behaviours already in `editor.js`.

## Context

Raw is a source pane, and the source-pane convention for a collapsed caret is
older than the web: `dd` in Vim, ⌘X in VS Code, Ctrl+Y in JetBrains — with
nothing selected, the line is the unit. Moving a bullet, lifting a heading and
deleting a stale task are the three most common structural edits in a markdown
file, and each of them was a select-to-end-of-line-plus-newline drag first.

This app had nothing on that gesture: ⌘X and ⌘C over a collapsed caret in
`#rawArea` reached the browser, which had nothing selected to act on, and
nothing happened. (They never reached the chat toggle either — `typing()` in
app.js already keeps ⌘C off every text surface.)

## Decision

In `#rawArea`, with **nothing selected**:

- **⌘X** puts the line — *including its newline* — on the clipboard and removes
  it. The caret lands at **column 0 of the line that moves up** into that row.

  Not the column it held, which is what a code editor does and what this did
  first. In a markdown outline it is the wrong answer nearly every time: the
  lines being cut are list items, the caret is usually inside the text — or at
  the end of it, since clicking a list gutter parks it there — and keeping the
  column drops you into the middle of the next bullet, `- [ ] brav|o`. Column 0
  is where the next thing you do to a line starts, and it is the same answer
  for every line whatever you cut.
- **⌘C** puts the same text on the clipboard and touches neither the document
  nor the caret.
- **⌘V** of text this pane last put there *as a line* inserts it as a whole line
  above the caret's line, the caret riding down with its own text. Any other
  clipboard content is an ordinary paste.

The **last line of a file has no newline of its own, so it takes the one before
it** — otherwise cutting it leaves the blank line it used to follow. The
clipboard always receives a *terminated* line even in that case: that is what
makes the round trip work, since the paste inserts the text verbatim at a line
start and an unterminated line would fuse with whatever it landed on.

**A selection is never touched.** With one, ⌘X/⌘C are the browser's, unchanged
— as is anything pressed while a modal is up, which is why both checks come
before the `preventDefault`.

### Why keydown, and not the `cut` / `copy` events

The clipboard events would have given us the native clipboard for free. They do
not fire at all when the selection is collapsed — a browser with nothing
selected has nothing to cut — which is the entire case this exists for.
Measured in this repo's headless Chromium: ⌘X over a caret produces no `cut`
event, and expanding the selection inside a handler that never runs cannot
help.

So the gesture is recognised as a chord, the document edit is ours, and the
clipboard write goes through `copyText`, which is the app's one clipboard
writer.

### Every edit this pane makes goes through the browser's editing command

`setRangeText` was the obvious tool for the edit and it is the wrong one:
measured, a `setRangeText` edit is **invisible to ⌘Z** — worse than ignored, it
left the undo stack pointing at the entry before it, so the first ⌘Z after a
whole-line cut silently did nothing and the line was gone for good. That was
already true of `editRawTab` and `continueMarkdownLine`, which shipped this way
long before the cut did; the cut is what made it intolerable, because a cut
line is the one edit whose whole point is that it is destructive.

So `applyRawEdit` performs every structural edit in this file through
`document.execCommand` — `insertText` for replacement and insertion, `delete`
for removal (only ever with a non-empty range; with a collapsed one it would
eat the character behind the caret). Deprecated, universally implemented, and
what every editor built on a textarea uses for exactly this reason. Measured in
the same browser, same edit: **⌘Z restores it and ⌘⇧Z redoes it**. There is a
`setRangeText` fallback for a browser that refuses the command — the edit still
lands, only its undo does not.

**Superseded in part by [0014](0014-file-operations-undo-but-they-ask.md).**
This ADR's conclusion was that no app code should bind ⌘Z, because with the
whole history on the native stack the browser's own undo is correct. That holds
for ONE textarea and fails for a vault: `renderDoc` builds a new textarea per
doc, so the native history dies at every doc switch and can never reach an edit
in another file. 0014 moves the history into the app. `applyRawEdit` is
unchanged and still earns its place — it is how a structural edit mutates a
textarea, and it is what fires the `input` event the timeline learns from.

The command also fires the native `input` event, so the listener in
`renderRaw` runs (dirty, `autoGrow`, meta) without anyone dispatching one by
hand — and an **undo fires it too, as `historyUndo`**. That is what keeps
`doc.markdown` in step with a buffer the browser rewound behind the app's back;
without it, ⌘S after a ⌘Z would write the text the user had just rewound away
from.

`copyText` grew a `quiet` option rather than a second implementation. A
whole-line ⌘X is an EDIT, taken twenty times a minute, and its "Copied to
clipboard" toast would narrate the editing rather than confirm anything. The
copy *buttons* keep the toast: there the clipboard is the entire outcome and
nothing else on screen changes to show it happened.

## Consequences

- The line paste rests on a "did this come from a line copy?" test — the
  clipboard text compared against what this pane last wrote — and inherits the
  same false positive the convention has always had in every editor that
  implements it: text copied elsewhere that is byte-identical pastes as a line.
  A native `copy`/`cut` (which only happens with a selection) clears the flag.
- **Not a new clipboard exposure.** `#rawArea` is where secrets are typed
  before they become ciphertext (SPEC §6), but a line copy is user-initiated
  and identical in kind to the selection copy that has always been available
  there. The timed clipboard clear belongs to the *reveal* path in
  `secrets.js`, which is a different surface acting on already-decrypted
  plaintext; it is deliberately not extended here.
- **⌘Z and ⌘⇧Z now work for the older edits too** — Tab/Shift-Tab and the list
  continuation moved onto the stack with the cut, since they share
  `applyRawEdit`. That is asserted directly, so a regression that reaches for
  `setRangeText` again cannot take undo away from all three quietly.
- Undo/redo are measured the way `ux-e2e` already measures ⌘C: dispatched over
  CDP with `commands: ["undo"] / ["redo"]`, because Chrome resolves the chord
  to an editing COMMAND and puppeteer's plain key event carries none — ⌘Z
  through `page.keyboard` is a no-op whatever the page does, so every assertion
  built on it would pass vacuously.
- Ten cases are measured in `ux-e2e.test.ts`, the clipboard ones against the
  **real system clipboard** (same grant and same realness probe as the ⌘C block
  it sits beside): a middle line, the last line, the only line, ⌘C's
  non-mutation, a live selection passing through untouched, the ⌘V round trip,
  a foreign paste staying the browser's, ⌘Z/⌘⇧Z over a cut, ⌘Z over Tab and
  over the list continuation, and — the one that would hurt most — ⌘S after a
  ⌘Z writing what is on screen rather than what the cache remembered.
