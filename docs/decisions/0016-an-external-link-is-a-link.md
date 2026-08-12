# 0016 — An external link is a link

## Status

Accepted, 2026-08-12. **Amends [the product spec](../specs/done/0001-z-notes-v1.md)
§4's inline constructs**: Preview's inline renderer speaks external URLs now,
not only `[[wikilinks]]`. The click-zone rule is unchanged in spirit — a link
acts instead of editing — and merely gains a second kind of link.

## Context

`inline()` rendered `` `code` ``, `**bold**`, `*em*` and the `[[wikilink]]`
pill, and nothing else. A URL — pasted bare, written as `[text](url)`, or
wrapped in `<angle brackets>` — came out as plain body text: not underlined,
not clickable, indistinguishable from prose. For a notes app that is a wrong
answer twice over. Notes are full of URLs, and a reader cannot follow one
without a trip through Raw and a copy-paste; and the two link kinds carry
different promises — a pill navigates *inside* the vault, an external URL
*leaves* it — but only one of them was even visible as a link.

The reason it was never just "add a URL regex" is that `inline()`'s output is
`innerHTML`, and a doc is allowed to contain any byte at all (ADR 0010's rule,
one construct earlier). A link is an `href`, and an `href` is the one place
escaping does not finish the job: `esc()` keeps quotes from breaking out of
the attribute, but `javascript:alert(1)` survives escaping byte-for-byte.

## Decision

**Preview renders external links as real anchors — three spellings, one
scheme gate.**

- `[text](url)`, `<url>` and the bare URL all become
  `<a class="xl" href target="_blank" rel="noopener noreferrer">`. New tab,
  because the vault is an app with state (an unsaved buffer, an undo
  timeline) and a same-tab navigation would throw it away for a hyperlink.
- **The scheme is the gate.** `http://`, `https://` and (for the written
  forms) `mailto:` become anchors; anything else — `javascript:` above all —
  stays the literal text the author typed. Never a disabled link, never a
  stripped one: the renderer does not rewrite what it refuses.
- **The boundary is the URL's, not the sentence's.** A bare URL sheds
  trailing punctuation (escaped entities first — the text is escaped, so a
  quote arrives five characters wide) and keeps a close-paren only when it
  also carries the open, so a Wikipedia `_(disambiguation)` survives and a
  parenthetical sentence does not annex the URL's `)`.
- **Everything already emitted is skipped.** Each pass carries the code spans
  and the anchors already in the string in its alternation — a URL inside
  backticks stays code, a pill is not re-linked, and the href one pass wrote
  is not autolinked by the next. `![image](url)` syntax, which this renderer
  does not speak, stays whole rather than half-rendering as `!` + a link.
- **`.xl` is underlined; the pill is not.** The two costumes are the two
  promises: a `.wl` pill is a doc in this vault, an underlined `.xl` leaves
  it. External links are excluded from click-to-edit the same way pills are
  (the `a` in `previewClickToEdit`'s exclusion list already covered them).

## Consequences

- Chat bubbles get the same rendering for free — assistant messages go
  through `inline()` too, so a URL in an AI answer is now followable.
- The renderer's threat model has a second entry: ADR 0010 made the fence
  untrusted input, this makes the *scheme* untrusted input. Any future inline
  construct that emits an attribute inherits both.
- `[[wikilink]]` resolution, rewrite-on-rename and the broken-link flag are
  untouched — the server's link planner never knew about external URLs and
  still does not.
- Measured in `tests/extlinks-e2e.test.ts` against a real Chromium: the three
  spellings render with the right hrefs and a computed underline, the
  `javascript:` spelling and the code-span URL stay text, the punctuation
  boundary, the click that must not open Raw, and that the file on disk is
  byte-identical after all of it.
