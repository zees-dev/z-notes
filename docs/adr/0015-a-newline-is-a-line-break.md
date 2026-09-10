# 0015 — A newline is a line break, and a blank line is a blank line

## Status

Accepted, 2026-08-12. **Amends the "Preview rendering" paragraph of
[the product spec](../specs/done/0001-z-notes-v1.md) §4** on two points: the
soft-break rule it inherited from CommonMark without ever writing down, and the
"blank-line multiplicity" sentence, which said each blank line *beyond the
first* adds a body line-height. Every blank line does now.

## Context

Preview claimed to be a view over the file, and on the one thing an author
looks at most — where the lines are — it was not. Two adjacent source lines
came out as one rendered line, joined with a space, because that is what
CommonMark says a newline inside a paragraph means: prose is reflowed, and
where the author wrapped it is presentation the renderer is free to discard.

That rule was written for documents typed to be published. This is a notes
app: the file is the artifact, Raw is the byte-faithful view of it, and Preview
sits one keystroke away over the *same* text. Lines here are structure —
a list of names, an address, a stanza, the three things to do today — and an
author who put them on separate lines meant them to be on separate lines. The
workaround was to type a blank line between every pair, which made the file
worse to read in Raw to make it right in Preview, and cost twice the newlines.

The blank line did not pay for itself either. One blank separated two blocks by
`--d-blk-gap` — **4px**, against a body line box of ~19px — so a blank line
in the source rendered as a hairline, and only the *second* blank bought a real
empty line. That is the same discrepancy one level up: the author types a
line's worth of space and gets a fifth of one.

## Decision

**Preview's line structure is the source's line structure.**

- **One newline is one line break.** The lines of a paragraph — and of a
  blockquote — are joined with `<br>`, not with a space. Nothing is reflowed;
  a line still wraps when it is wider than the column, as it always did.
- **One blank line is one blank line.** `.bgap` is emitted for *every* skipped
  blank line rather than for every one after the first, at one body line-height
  each (`--d-font × --d-lh`, so it still scales with density).
- **Leading blanks are the exception.** Blank lines above the first block emit
  nothing: there is no line above them for them to separate, and a file that
  opens with a stray newline should not open with a void. Trailing blanks are
  unchanged and still render nothing — the file's terminating newline is one of
  them, so honouring them would put an empty line under every document in the
  vault.

The `--d-blk-gap` between blocks stays. Raw is monospace with one line height
and Preview has three heading sizes; the mirror being claimed here is of the
line *structure*, not of pixels, and the 4px is what keeps a heading from
sitting on the paragraph under it.

### Every rendered line carries its own `[data-line]`

A paragraph used to be one line often enough that the block's own source line
was a fair answer for click-to-edit. Under this rule it is routinely five or
ten, and clicking the fifth would have dropped the caret on the first — the
promise in `editor.js` is *click a rendered line → edit that line*.

So each line inside a `<p>` or `<blockquote>` is a `<span class="pline"
data-line="N">`. `previewClickToEdit` already reads `closest("[data-line]")`
and `revealLine` already scans `#doc [data-line]`, so both got line-accurate
for free — a jump-to-line now flashes the line rather than the paragraph.
`.pline` has no styling and is not meant to: it exists to carry the number.

### `inline()` runs per line

The alternative was to join the raw lines with `\n`, call `inline` once, and
swap the newlines for `<br>` afterwards. It renders the same for prose and is
worse in two ways that matter here: `inline` emits `[[link]]` pills whose
`data-link` and `title` attributes carry the link text, so a `[[name]]` broken
across a newline would have put a `<br>` **inside an attribute** — a fence with
a newline in it is untrusted input, and this renderer does not get to be the
place that learns that the hard way (ADR 0010). And the emphasis pass already
excludes `\n` by construction, so a newline would have arrived in a function
whose regexes were written on the assumption it never could.

Per-line rendering makes every inline construct line-local: `**bold**` opened
on one line no longer closes on the next. That is the honest reading once the
break between them is a real one — they are no longer one line of prose.

## Consequences

- **Existing documents get taller.** Anything written against the old rule —
  a paragraph hard-wrapped at some column, or the blank-line-between-everything
  workaround this removes — now renders with the breaks it actually contains.
  No file changes; nothing is rewritten on disk. The rule is a rendering rule
  and the only way to alter a document's shape is still to edit the document.
- **A paragraph's `textContent` no longer has spaces at the line joins**, since
  `<br>` contributes none. Nothing in the app reads it — the AI relay is sent
  the *source*, never the DOM — but a future reader of the preview must take
  the breaks from the element structure, not from the text.
- Blockquote lines that were empty (`>` alone) used to vanish into the join and
  now render as the blank lines they are.
- Measured in `tests/linebreaks-e2e.test.ts` against a real Chromium: the line
  count and the per-line rects of a paragraph, a quote, blank-line multiplicity
  1–3 against the body line box, the leading/trailing exceptions, the
  click-to-edit caret landing on the clicked line, and that the source on disk
  is untouched by all of it.
