# 0023 — Preview's sections fold

## Status

Accepted, 2026-08-19. Amends the click-zones sentence of
[the product spec](../specs/done/0001-z-notes-v1.md) §4 (the fold chevron is a
new exception to click-to-edit) and extends
[ADR 0015](0015-a-newline-is-a-line-break.md)'s "Preview is a view over the
file" with a second, reversible view state.

## Context

Preview renders a document as one flat, read-focused column. A note with real
heading structure — or a list three levels deep — has no way to be read as an
outline: the only way to skim it was to scroll past everything, and the only way
to hide a section was to delete it. Every other pane in the app already
discloses (the tree's folders, the vault rows, mermaid's Source toggle); the
document itself did not.

The obvious implementations are the wrong ones. Wrapping each section in a
`<section>` would rewrite the block structure `renderPreview` emits — which is
load-bearing in the `.md > …` selectors, in the per-line geometry
`tests/linebreaks-e2e.test.ts` measures, and in its children snapshot. Keying a
fold by line number would lose it on the next edit above it. Writing a marker
into the source would make a view choice cost bytes, which ADR 0015 spends a
page refusing to do.

## Decision

**Folding is a reversible VIEW affordance over the rendered DOM, and the file
never learns about it.**

- Two surfaces: an `h1`–`h3` (the whole dialect of
  [ADR 0021](0021-preview-has-one-tested-markdown-dialect.md)), and any list
  item that has a sub-list. Folding a heading hides every following sibling up
  to the next heading of the same or higher rank, blank-line spacers included;
  folding an item hides its sub-list. Folds nest, and each one is applied on its
  own pass, so unfolding an outer heading leaves an inner one still folded.
- **Only where there is something to hide.** A heading whose range is empty —
  or holds nothing but blank lines, since a `.bgap` is a line box and not
  content — gets no chevron at all, exactly as a list item without a sub-list
  gets none. A control whose two states render identically is not a control,
  and on a phone it is a tap target that spends a press to do nothing. The
  heading still claims its ordinal on the way past, though: skipping the number
  as well would renumber every later fold key and reopen a saved fold on the
  wrong section.
- It is a POST-PASS over the finished `.md`. No node moves, no wrapper is
  introduced, and a fold only ever adds a class. Mermaid's `show-src` is the
  precedent: what is on screen changes, what the file says does not.
- **Fold keys are content plus ordinal** — `h<level>:<text>:<n>` and
  `li:<text>:<n>`, where `n` counts identical keys earlier in the document. This
  is the trick `fenceOrd` already uses to tell two identical armor blocks apart.
  A key survives a re-render, a save, an SSE refresh and an unrelated edit
  anywhere else in the file; editing the heading's own text drops its fold and
  the section renders open.
- **The chevron is a new exception to click-to-edit.** It is a `<button>`,
  which `previewClickToEdit` already skips, so clicking it folds while clicking
  the heading's text still opens Raw at that line.
- **That button is an empty overlay of its own block**, drawing itself entirely
  in pseudo-elements out in the gutter, and passing every pointer that is not
  in the gutter straight through. An icon child would have been a box of its
  own inside a heading, and the document's first text box is found by
  descending `firstElementChild` — see the consequences.
- It lives in the LEFT gutter, against the right-alignment default in
  `docs/style.md`: disclosure reads from the outline's spine. It is
  hover-revealed while expanded and **always visible while collapsed** — the
  only clue that content is hidden — and always visible where the pointer
  cannot hover at all.
- **State is per document path, in localStorage** (`znotes.folds`), capped to
  the 50 most recently touched documents. A renamed document is not chased; its
  entry ages out and the doc renders open.
- A jump-to-line unfolds first. `revealLine` calls `ensureLineVisible`, which
  loops until nothing is covering the target — the analogue of `revealFolder`
  force-opening the folders above a tree row.

## Consequences

- Folding writes nothing, marks nothing dirty and leaves no entry on the
  [ADR 0014](0014-file-operations-undo-but-they-ask.md) timeline. Raw always
  shows the whole file; the Esc stack is untouched.
- **A block's rendered shape is unchanged.** The Preview/Raw origin parity in
  `tests/e2e.test.ts` and `theming-e2e` finds the document's first text box by
  descending `firstElementChild` from `.md`, so anything with a box of its own
  added inside the first heading — an icon, a text wrapper — silently becomes
  the thing they measure. The empty overlay has its owner's exact rectangle, no
  text, and no children, so both walks land where they always landed.
- Preview and Raw can disagree about how much of a document is on screen. That
  is the point, and the mode chip already says which view is up.
- Known a11y cost of the overlay: the button lives inside the heading, so a
  screen reader's heading navigation reads its label into the heading's
  accessible name ("Notes, Collapse section"). Every flat-DOM alternative
  traded worse — an icon child breaks the first-text-box walks, a sibling
  breaks the children snapshot — so the label is kept short and stable
  instead.
- `tests/fold-e2e.test.ts` measures the rules in a real Chromium: which blocks
  get a chevron, the hidden range and its boundary, nesting, ordinal keys on
  duplicated headings and items, the collapsed chevron's computed opacity,
  survival across a mode switch and a reload, a ⌘K line hit unfolding ONLY
  what covers it and landing the scroll on it, and that the file is
  byte-identical after all of it.
