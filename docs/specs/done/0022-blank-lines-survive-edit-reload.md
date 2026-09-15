# 0022 — Blank lines survive Edit save and reload

## Problem Statement

Blank paragraphs inserted between sections in Edit disappear on reload. A
real-browser probe confirmed that saving succeeds and writes the whitespace:
`# Second\n\n\n\nOther text\n` reloads without its empty paragraph.
`SourceSession` imports only MDAST nodes, and MDAST omits separator whitespace.

## Solution

Represent extra blank space between top-level source groups as ordinary empty
paragraphs in Edit. Serialize and reload those paragraphs consistently using
plain Markdown whitespace. Normal Markdown block separation is not an extra
paragraph. Existing source bytes remain canonical.

## User Stories

1. As a writer, I want blank paragraphs between sections to remain after saving
   and reopening a doc, so that the spacing I added stays visible.
2. As a writer, I want to type into, remove, and undo changes to a reloaded
   blank paragraph, so that it behaves like other editor content.
3. As a vault owner, I want unrelated source, newline styles, and protected
   blocks preserved, so that keeping spacing does not rewrite my doc.

## Implementation Decisions

The owner is `SourceSession` in `app/markdown-source.ts`:
`constructor(markdown: string)` imports `blocks`; `serialize(blocks)` and the
private `render(blocks, normalizeLeading)` emit Markdown and source ranges.
The island (`app/block-editor.tsx`) passes native empty paragraph blocks through
this adapter. `editor.js` saves its returned Markdown unchanged.

Keep [ADR 0037](../../adr/0037-blocknote-edits-docs-markdown-stays-the-file.md)'s
byte-preserving groups, protected source/secret boundaries and native editor
behavior. Update its adapter description and [architecture](../../architecture.md)
to record the blank-paragraph mapping. No custom spacing block or stored marker.

[ADR 0015](../../adr/0015-a-newline-is-a-line-break.md) described spacing in the
retired Preview renderer. Make the Edit mapping explicit in ADR 0037 rather than
reintroducing renderer-only spacers: a blank paragraph inserted with Enter must
reload as the same editable paragraph, while Markdown block delimiters retain
their syntax role.

Use the existing serializer's convention: a newly inserted empty paragraph
between two blocks contributes two newline characters, so `\n\n\n\n`
represents one empty paragraph and six newlines represent two. A source-authored
odd gap also represents its extra space: three/four newlines map to one empty
paragraph, five/six to two. Gaps with fewer than three newlines add no paragraph.
Count CRLF as one line ending. Preserve the original gap's exact bytes while
its imported blank paragraphs remain empty, including edits to neighboring prose.

Prefer zero-width source groups for imported empty paragraphs, positioned in
the existing whitespace gaps. This gives them stable ids, snapshots and ranges
through the same machinery as ordinary paragraphs. Their retained source is
empty; the separators hold the whitespace exactly once. Removing a blank must
not let original source adjacency resurrect its gap. Typing into it must produce
an ordinary Markdown paragraph separated safely from both neighbors. Do not
split whitespace owned inside a MDAST node, list, code fence or protected block.
Place synthetic groups after the second, fourth, sixth… line ending, stopping
before the final line ending. Retain an original short separator bordering an
unchanged synthetic blank instead of expanding it merely because nearby prose
changed. Once that blank contains prose, the normal safe two-ending separation
applies; preserve following indentation when expanding a separator.
If neighboring prose is cleared into a new empty paragraph, its spacing must
still encode that additional paragraph. Retained short separators must not
compress a run of three empty paragraphs into the saved form of two.

Skip a gap flanked by same-family list items (ordered/ordered or
bullet-or-checklist/bullet-or-checklist). Markdown can merge those lists after
an item edit normalizes their markers; representing empty paragraphs there
requires a separate list serialization decision. List-to-prose, prose-to-list
and heading boundaries are covered.

## Testing Decisions

The user approved two focused seams, with no broad matrix:

- One compact test in `tests/markdown-source.test.ts` for import/export/reimport
  consistency, unchanged source bytes, and editing/removing blank paragraphs.
  Include clearing the middle prose in `A\n\n\nB\n\n\nC`: all three resulting
  empty paragraphs must survive reimport. Fold this into the existing regression.
- One real-browser test in `tests/block-editor-e2e.test.ts` using its existing
  `boot`, `save`, `source`, `blocks` and `settled` helpers: insert spacing with
  Enter, save, inspect disk bytes, reload, and edit the restored blank paragraph.
  Verify repeated reload does not grow or remove the spacing.
- Adjust existing positional assertions only if newly represented blank
  paragraphs legitimately change their indices; preserve their original claims.
  `tests/linebreaks-e2e.test.ts` has one paragraph-count assertion for its gap
  fixture that now includes reconstructed blank paragraphs.
- Run the adapter and BlockNote browser suites, then `bun run gates` and
  `bun run lint:docs`. Run the full suite once if the group/range mapping changes,
  since source-line anchors and secret ranges share it. Keep the existing
  byte-round-trip and protected EOF tests.

## Out of Scope

New dependencies, server/API changes, CSS-only spacers, HTML comments, `<br>`
markers, storing editor JSON, new settings, changing list looseness or whitespace
inside protected/code blocks, changing the existing leading/trailing whitespace
or empty-doc behavior, commits, pushes and deployment. The reported failure is
spacing between top-level source groups; same-family list boundaries are excluded
as described above.

## Further Notes

The prior renderer preserved extra source blank-line spacing; the current
adapter preserves those bytes but does not recreate editable blank paragraphs.
Implement through an independent agent; review with a fresh independent agent.
The coordinator owns this spec and final verification.

Baseline checks: 38 adapter tests and 20 BlockNote browser tests passed before
the fix. The temporary live probe reproduced the missing paragraph despite a
successful PUT and persisted blank-line bytes.
The pre-change full suite had 1038 passes and 19 failures, mostly in
`editor-refresh-e2e.test.ts`, plus sidebar rename, SSE watchdog and a secret-move
test. CSS-only fallback and sidebar rename failures reproduced alone. Compare
final failures against that baseline; do not expand this fix into those areas.

A separate `bun run dev` probe of the fix saved one native empty paragraph
between two sections and verified identical block content through two reloads.
After implementation, the full suite had 1041 passes and 18 failures: every
failure also occurred in the pre-change run; the SSE-watchdog case passed this
time. Focused checks passed: 39 adapter tests, 28 BlockNote/linebreak browser
tests, and 180 acceptance-gate tests. Docs lint and whitespace checks passed.

Independent review found that clearing the middle paragraph of two odd gaps
wrote six newlines for three empty paragraphs, reloading as two. The fix limits
the short-separator exception for newly cleared prose; the existing adapter
regression covers it. Re-review confirmed all three blanks survive two reimports
and undo restores the original bytes, with no remaining findings.

Completed 2026-09-16. After the review fix, 39 adapter tests, 28
BlockNote/linebreak browser tests and 180 acceptance-gate tests passed. The full
suite comparison above predates this final narrow correction; the affected
focused suites and gates were rerun. No commit, push or deployment performed.
