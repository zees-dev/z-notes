# 0044 — Nothing is protected Markdown

## Status

Accepted, 2026-11-08. Amends [ADR 0037](0037-blocknote-edits-docs-markdown-stays-the-file.md)
(frontmatter, nested secrets and unsupported syntax are no longer opaque
protected blocks) and [ADR 0039](0039-edit-is-the-only-doc-surface.md) (a
protected block's in-place "Edit" textarea is gone with the block).

## Context

Any Markdown group the adapter could not import became a "Protected Markdown"
panel showing its raw source with an Edit button. Edit produced some of those
itself: an emptied bullet saves as a bare `-`, which the importer refused, so
after the next save the whole list turned into raw source. The user's own
vaults held 104 such panels: hard line breaks (35), inline HTML (32), `---`
rules (21), titled links (9), images, multi-paragraph quotes and list items,
and three emptied bullets. Raw Markdown in the editor is the failure the
editor exists to prevent.

## Decision

- **Every node imports.** `importNode` in `app/markdown-source.ts` cannot
  throw. An empty list item is an empty item; a hard break is a line break in
  the text; `---` is BlockNote's divider; a titled link is a link; a quote or
  list item holding other blocks nests them (Markdown nests only under those
  two); an ordered task is a task; an aligned table is a table; a fence's
  meta string is dropped. Each of those is written back only if its group is
  edited — an untouched group keeps its bytes exactly, as before.
- **A verbatim span** carries what the editor has no form for: inline or
  block HTML, an image, a reference link, a footnote, a link whose scheme
  the editor may not make actionable, an ambiguous escaped wiki-link. It is
  an inline atom showing its source as text, never rendered markup, and it
  is written back byte for byte however its paragraph is edited. Inside a
  quote or list item it holds its lines without the container's prefix,
  which the container writes again.
- **Frontmatter is a code block** (`yaml` or `toml`) that is written back as
  the frontmatter it was and must stay first.
- **A nested secret is a secret block** inside its list item or quote.
  Replacing its armor reprints that container; a top-level secret keeps its
  fence bytes as before.
- **What runs to the end of the file stays last.** An unclosed secret fence or
  HTML comment would swallow anything printed after it, so the island refuses
  that move, and the adapter refuses to write it.
- Gone: the `source` block, its Edit/Done/Cancel draft, `onSourceEdit`,
  `onDraft`, `hasDraft`, `commitDrafts`, `sourceParts` and the exit guard's
  "A protected block being edited" row.

## Consequences

- Editing a group that held a hard break, a link title, a fence meta, table
  alignment or an ordered task writes the standard form: a soft line break,
  no title, no meta, no alignment, a bullet task, and a wiki-link without the
  emphasis around it.
- A nested secret whose container used a non-standard indent is reprinted
  with the standard one when it is re-encrypted.
- HTML and images show as their source, in the doc's muted monospace, not
  rendered: a synced vault is untrusted input ([ADR 0010](0010-mermaid-is-a-committed-bundle.md)).
