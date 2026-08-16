# 0021 — Preview has one tested Markdown dialect

## Status

Accepted, 2026-08-16. Amends the Preview construct list in
[the product spec](../specs/done/0001-z-notes-v1.md) §4 and extends
[ADR 0016](0016-an-external-link-is-a-link.md)'s inline-rendering discipline.

## Context

Preview is a deliberately small, dependency-free renderer rather than a
CommonMark/GFM package. Its supported constructs had accumulated across the
product spec and ADRs, with separate tests for some of them but no single
parity check. `~~strikethrough~~` was missing, and inline markup inside table
cells skipped the ordinary inline pipeline. A request that "all Markdown"
work cannot honestly turn a bespoke renderer into every Markdown dialect by
implication; it needs one explicit supported set and one broad regression.

## Decision

**The documented Preview constructs are one dialect, exercised together by one
real-browser regression.**

- The set is headings h1–h3, source-faithful paragraphs and blank lines,
  unordered/ordered/task lists, blockquotes, dividers, fenced code, Mermaid,
  tables, wiki-links, safe external links, inline code, bold, emphasis and
  `~~strikethrough~~`.
- Inline rendering is shared by prose, list text, blockquotes, headings, chat
  bubbles and table cells. Strike composes with bold/emphasis and rendered link
  labels, but markup inside inline code remains literal. Combined strong +
  emphasis accepts the canonical `***text***` form and the common equivalent
  star/underscore nestings (`**_text_**`, `__*text*__`, `___text___`,
  `*__text__*`, `_**text**_`).
- Every pass preserves already-emitted code, anchors and tags, and external
  links retain their http(s)/mailto scheme gate. Rendering never changes the
  source bytes on disk.
- `tests/markdown-e2e.test.ts` is the single broad parity seam: one source
  corpus renders the complete set, exercises interactions and hostile input,
  verifies computed strike styling, and re-reads the file byte-for-byte.
  Focused Mermaid, link, line-break and code-fence suites remain the deeper
  security/behavior checks.

## Consequences

- "All Markdown" in this product means all constructs in this decision, not
  complete CommonMark or GFM conformance. Images, h4–h6 and other unlisted
  syntax remain literal unless a later decision adds them.
- A construct cannot silently work in paragraphs but fail in tables: the
  broad corpus is the acceptance map, while feature-specific tests retain
  precise diagnostics.
- No runtime dependency or frontend build step is introduced.
