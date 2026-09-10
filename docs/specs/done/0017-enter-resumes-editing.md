# 0017 — Esc and Enter are a round trip: Enter in Preview resumes editing at the caret

## Problem Statement

Esc leaves Raw for Preview (shell.js `dismissTop`, the editor's own Esc). There
is no key that goes the other way to the place you were: ⌘E and the mode chip
re-enter Raw at the line at the TOP of the pane (ADR 0027), and click-to-edit
needs a pointer and a guess at which line. Someone who steps out to read the
rendered note and wants to carry on typing has to find their sentence again.

## Solution

**Enter in Preview re-enters Raw at the caret you left with.** The editor
remembers, per doc, the caret offset at the moment Raw was left through any
door (Esc, ⌘E, the chip, a click on the pane, Back on a phone). Enter, pressed
while Preview is showing and focus is on nothing more specific than the
document, switches to Raw with that caret restored and the caret's line held
where it currently sits on screen (ADR 0027's rule, applied to the caret line
rather than the top line). A doc never edited resumes at offset 0.

Enter keeps every meaning it already has: with a modal open it presses the
primary action; on a focused tree row it opens the row; on a `[[link]]` pill
it follows the link; in any field it is that field's Enter. Only the
"nothing focused, document showing" case is claimed.

## User Stories

1. As a writer, I want Esc to show me the rendered note and Enter to put me
   back exactly where my caret was, so that reading and writing is one
   keystroke apart in each direction.
2. As a writer, I want the line I resume on to stay where it was on screen,
   so that Enter does not scroll the document.
3. As a writer who scrolled Preview elsewhere before pressing Enter, I want
   Raw to open at my caret anyway (scrolled into view), so that Enter always
   means "continue editing".
4. As a writer, I want the remembered caret to survive switching to another
   doc and back, so that each doc resumes at its own place.
5. As a writer whose doc changed underneath (an SSE reload, an accepted
   proposal, an undo), I want the caret clamped to the new length rather than
   an error.
6. As a user with a modal open, focus in the tree, the palette, a settings
   field, the chat composer or the terminal line, I want Enter to do what it
   did yesterday.
7. As a phone user, I want nothing to change (there is no Enter without a
   keyboard; click-to-edit and the keyboard bar remain the doors).
8. As an agent, I want `set_mode` unchanged.

## Implementation Decisions

- **editor.js** —
  - a module-level `const rawCaret = new Map();` (qualified path → offset).
    In `setMode`, on the `preview` branch BEFORE `renderDoc` replaces the
    editor (i.e. next to where `carry = rawAnchor()` is read at
    editor.js:~1164), write `rawCaret.set(state.active, ta.selectionStart)`
    when `#rawArea` exists. Nothing clears the map; a stale entry is clamped
    on use. (Bounded by the number of docs opened in a session; offsets are
    numbers.)
  - `export function resumeRaw()`:
    ```js
    const doc = activeDoc();
    if (!doc || state.view !== "doc" || state.mode !== "preview") return false;
    const md = String(doc.markdown || "");
    const caret = Math.max(0, Math.min(rawCaret.get(doc.path) ?? 0, md.length));
    const line = md.slice(0, caret).split("\n").length - 1;
    const sc = $("#scroll");
    const b = blockForLine(line);
    let anchor;
    if (b && b.offsetParent && sc) {
      const r = b.getBoundingClientRect(), s = sc.getBoundingClientRect();
      if (r.bottom > s.top && r.top < s.bottom) anchor = r.top - s.top;
    }
    setMode("raw", { caret, line, anchor, silent: true });
    return true;
    ```
    `line` is always passed so `setMode` does not replace the caret with the
    top-of-pane line (see the `at = opts.line != null || … ? opts : …` branch);
    an undefined `anchor` makes `scrollRawTo` use its 120px default, which is
    story 3.
- **app.js** document keydown — in the existing `Enter` block (app.js:~601),
  after the modal-primary check has NOT matched: if `state.view === "doc" &&
  state.mode === "preview" && !overlayOpen() && !e.metaKey && !e.ctrlKey &&
  !e.altKey && !e.shiftKey` and the target is not inside
  `button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), #sidebar, .chat, .topbar, .statusbar, .modal, .veil, .pop`
  → `if (resumeRaw()) e.preventDefault()`. Import `resumeRaw` from
  `./editor.js`. Keep the block's existing order: modal primary first.
- **webmcp.js**: no new tool (`set_mode` covers it). The `set_mode` tool
  already accepts a caret? If it does not, leave it.
- **Docs**: ADR `docs/adr/00NN-esc-and-enter-are-a-round-trip.md`
  (next free number): the decision, the "nothing focused" scope, the caret
  memory per doc, the caret-line anchoring as a refinement of ADR 0027.
  One sentence in AGENTS.md's digest; `docs/architecture.md`'s guard/Back
  table is untouched (Enter is not a guard).

## Testing Decisions

- Seam: the browser. Prior art: `tests/ux-e2e.test.ts` (the mode-switch and
  ADR 0027 anchoring tests — reuse its `seed`/`read` helpers or their shape)
  and `tests/edit-exit-e2e.test.ts` (Esc leaving Raw).
- New file `tests/resume-e2e.test.ts`, one page:
  1. Raw, caret at a mid-document offset N on a line that is on screen, note
     that line's `[data-line]` top after Esc; press Enter → `#doc.raw-mode`,
     `document.activeElement.id === "rawArea"`, `selectionStart === N`, and
     `rawArea.boxAt(N).top` is within 2px of the Preview block's top.
  2. Esc, scroll Preview to the bottom so the caret line is off screen, Enter
     → `selectionStart === N` and the caret box is inside the pane.
  3. open another doc, Raw, caret at M, Esc; open the first doc, Enter →
     caret N; back to the second, Enter → caret M.
  4. focus a tree row (`.row.file` button) in Preview and press Enter → the
     row's doc opens (existing behaviour) and the mode stays Preview.
  5. a doc never edited: Enter → Raw at offset 0.
  6. with the exit guard's modal open (ADR 0022: dirty Raw, then a tree
     click), Enter presses the modal's primary (existing) — assert the mode
     did not silently flip.
- Six short tests.

## Out of Scope

- Restoring a non-collapsed selection (the caret is enough).
- A phone gesture equivalent (click-to-edit exists).
- Changing what ⌘E or the chip anchor to.
- Any change to the statusbar chip's title/tooltip text.
- Persisting the caret across reloads.

## Further Notes

`blockForLine` is module-private in editor.js today; `resumeRaw` lives in the
same file, so no export is needed. The Raw surface is the line editor of ADR
0032; `boxAt`, `selectionStart` and `setSelectionRange` are its surface.
