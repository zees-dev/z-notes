---
id: 1
title: Editor paradigm
label: wayfinder:grilling
status: closed
assignee: z
blocked-by: []
---

## Question

What editing paradigm should the markdown editor use — raw markdown with preview, SilverBullet-style live rendering, or Notion-style blocks — and what fidelity contract binds it to the on-disk markdown files?

## Resolution

**Amended 2026-07-31 (evening), after hands-on prototype testing:** the original choice — Notion-style block editor — was judged **too complex** by the user. New paradigm: **simple markdown with two modes — Raw (edit the plain markdown source) and Preview (rendered)** — toggled in the UI. The **lossless round-trip** contract stands and is now satisfied by construction: the editor edits the source text itself. App-specific syntax remains only `[[doc-links]]` and fenced `age` secret blocks.

Downstream effect: the block-editor research's TipTap + mdast-bridge recommendation is superseded; its own fallback — **CodeMirror 6 as the raw editing surface** (byte-stable by construction), or even a plain textarea — becomes the operative path, and the ~400-line custom bridge with its dirt-tracking risk disappears entirely.

<details><summary>Original resolution (superseded)</summary>

**Notion-style block editor** (drag handles, slash commands) with a **lossless round-trip** contract: the editor only supports constructs that map 1:1 to standard markdown (headings, lists, tasks, code, quotes, tables, links). Opening and saving a file written externally leaves it byte-identical unless actually edited. The only app-specific syntax is `[[doc-links]]` and ```` ```secret ```` blocks. No normalize-on-save, no app-flavored directives.

Decided with z during charting, 2026-07-31.
</details>
