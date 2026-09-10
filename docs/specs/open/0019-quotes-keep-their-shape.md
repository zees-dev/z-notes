# 0019 — Quotes keep their shape: nesting, indentation, and Enter continues them

## Problem Statement

Preview turns a run of `> ` lines into one `<blockquote>` with the markers
stripped (app/markdown.js, the `RE_QUOTE` branch), and that is where it
stops. Three things a person types into a quote are lost or mangled:

- **Indentation inside the quote.** `>     four spaces of code` renders with
  the spaces collapsed — the document has no `white-space` rule, so a quoted
  snippet, a quoted list or any deliberate alignment flattens to one space.
- **Nesting.** `> > deeper` strips one marker and prints the second as the
  literal text "> deeper" inside the quote.
- **Indented quotes.** `    > aside` (a quote indented under a list item or
  simply indented) renders flush left; the source's structure is gone.

And in Raw, Enter on a `> ` line does not carry the marker onto the next
line, though Enter on a list line carries its bullet (`continueMarkdownLine`
in app/editor.js) — so a multi-line quote is typed one `> ` at a time.

## Solution

- A quote's lines keep their whitespace: the blockquote's line spans render
  with `white-space: pre-wrap`, so leading spaces and tabs after the marker
  are what the reader sees, and long lines still wrap.
- `> > x` nests: each additional marker (with its optional space) opens a
  nested `<blockquote>`; a run of lines at the same depth is one block, a
  depth change opens or closes blocks. Depth is counted per line.
- The indentation BEFORE the first marker is structural, the way a list
  item's is: the blockquote is inset by the source indent (tabs count to the
  next multiple of four, as `listInfo` counts them), so an indented quote
  reads as indented.
- In Raw, Enter on a `> ` line carries `> ` (the same marker depth and the
  leading indent) onto the next line; Enter on a line that is ONLY markers
  ends the quote, the way an empty list item ends the list. ⇧Enter or a
  literal newline is the browser's as before.
- Every rendered line keeps its own `[data-line]` (ADR 0015) so click-to-edit
  lands inside a quote exactly as it does today.

## User Stories

1. As a writer, I want `> quoted` to show as a quote block without the `>`,
   over as many consecutive lines as I write, so that quoting is one prefix.
2. As a writer, I want spaces and tabs after `> ` kept, so that a quoted
   snippet or an aligned list inside a quote keeps its shape.
3. As a writer, I want `> > deeper` to render as a quote inside a quote.
4. As a writer, I want a quote I indented (under a list item, or just
   indented) to render indented, so that the structure I typed is visible.
5. As a writer in Raw, I want Enter on a quote line to start the next line
   with `> ` at the same depth, and Enter on an empty `> ` to end the quote.
6. As a reader, I want a quote's inline markdown (bold, links, code) to
   render as it does everywhere else.
7. As a reader, I want folding, click-to-edit line mapping and blank-line
   spacing inside quotes to work exactly as before.

## Implementation Decisions

- **app/markdown.js** — replace the quote branch (markdown.js:~261–271):
  ```js
  /** `> > text` → { indent, depth, text }: indent counts the columns before the
      first marker (tabs to the next multiple of 4, as listInfo does), depth the
      number of `>` markers each followed by at most one space. */
  function quoteInfo(line) {
    const m = /^([ \t]*)((?:>[ ]?)+)(.*)$/.exec(line);   // note: `>` then optional ONE space, repeated
    if (!m) return null;
    let indent = 0;
    for (const c of m[1]) indent = c === "\t" ? indent + (4 - (indent % 4)) : indent + 1;
    const depth = (m[2].match(/>/g) || []).length;
    return { indent, depth, text: m[3] };
  }
  ```
  Keep `RE_QUOTE` as the block-start test (unchanged). The branch collects
  the run of `RE_QUOTE` lines, then builds nested blockquotes with a stack
  keyed by depth: for each line `{indent, depth, text}`, close blocks while
  the stack is deeper than `depth`, open blocks while it is shallower; each
  block is `el("blockquote")` and its lines are appended as `.pline` spans
  joined by `<br>` exactly as `lineSpans` emits them (extend or reuse
  `lineSpans` so a block accumulates its lines and their `data-line`
  numbers). The OUTERMOST block gets `style.marginLeft = indent * <the list
  indent unit> + "px"` from the FIRST line's indent, where the unit is
  whatever the list renderer already uses for one level (find it — it is
  named in base.css/markdown.js near `.cline`; if lists express indent in
  `ch`/`em`, use the same unit). Inner lines' own indent is whitespace inside
  the quote, preserved by CSS below, so nothing is stripped after the
  markers except the one optional space each marker allows.
  `put(outer, start)` as today; blank `>` lines are empty spans (a quote can
  hold a blank line without leaving the block).
- **app/themes/base.css** — in the rendered-markdown block next to
  `.md blockquote`: `.md blockquote .pline { white-space: pre-wrap; }` and
  nested spacing `.md blockquote blockquote { margin-top: 2px; }` (keep the
  existing border/colour rules; nested quotes inherit them and stack their
  borders). Check every theme sheet for `blockquote` overrides and make sure
  nesting looks intentional (a second border, slightly deeper inset).
- **app/editor.js `continueMarkdownLine` / `listContext`** (editor.js:~422–
  440): before the list regex, recognise a quote line with the same
  `quoteInfo` shape (restate the regex with a comment naming
  markdown.js's — the two files do not import each other for this, matching
  how `RE_LIST` is restated as `RAW_LIST`): prefix = leading whitespace +
  the markers exactly as typed (`> > `); `emptyItem` when `text` is empty →
  Enter removes the markers and ends the quote, as an empty list item does.
- **app/rawedit.js**: nothing — the line editor classifies headings and
  fences only (spec 0014); a `q` line kind is Out of Scope.
- **Docs**: ADR 0021 (the tested dialect) is amended by a short paragraph in
  a new ADR? No — this is dialect detail, not a new decision: add the three
  rules (whitespace kept, nesting, structural indent) to ADR 0021's list via
  a one-line "amended by spec 0019" note and describe them in
  `docs/specs/done/0001-z-notes-v1.md`'s Preview-rendering bullet the way
  list indentation is described there. AGENTS.md digest: no new ADR number.

## Testing Decisions

- Seam: the browser. Prior art: `tests/markdown-e2e.test.ts` (the one broad
  dialect map, ADR 0021 — extend its fixture and its `quoteAndRule`
  assertions rather than adding a file) and `tests/linebreaks-e2e.test.ts`
  for `[data-line]` continuity; `tests/ux-e2e.test.ts` /
  `tests/mobile-editing-e2e.test.ts` for Enter continuation (imitate the
  list-continuation test).
- Cases:
  1. `> a\n>   b (two extra spaces)\n> \tc` → three `.pline`s inside one
     blockquote; the second's `textContent` starts with two spaces and the
     third with a tab; computed `white-space` of a quote `.pline` is
     `pre-wrap`; `data-line` numbers are consecutive.
  2. `> outer\n> > inner\n> outer again` → `blockquote > blockquote` exists,
     the inner holds `inner`, the outer holds `outer` and `outer again`, and
     no `.pline` text contains `>`.
  3. `- item\n    > aside` → the blockquote's `marginLeft` is greater than a
     top-level quote's (the list branch may or may not swallow the line —
     assert only on the inset of the rendered blockquote, wherever it lands).
  4. the existing `quoteAndRule` expectations still hold (`quote bold`,
     `second strike`, border present).
  5. Raw: seed `> alpha`, caret at end, Enter → value `> alpha\n> `; Enter
     again on the empty `> ` → `> alpha\n\n`... (match the list rule
     exactly: the empty marker line becomes empty); a nested `> > x` carries
     `> > `.
  6. click-to-edit on the inner quote's line lands on that source line
     (existing mechanism; one assertion).

## Out of Scope

- Lazy continuation (a non-`>` line continuing a quote) — the marker is the
  block.
- Styling `>` lines in the Raw line editor.
- Quotes containing block constructs (headings, fences, tables) — the lines
  render as inline text inside the quote, as today.
- Any change to lists, tables or fences.
- A quote button on the keyboard bar.

## Further Notes

The `RE_QUOTE = /^\s*>/` block-start test already lets an indented `>` line
start a quote; the change is what happens inside the block, not where a
block begins. Keep `isBlockStart` untouched so paragraphs still end where
they end today.
