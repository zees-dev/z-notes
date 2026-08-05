---
id: 7
title: Research — block-editor foundations with lossless markdown round-trip
label: wayfinder:research
status: closed
assignee: research-subagent (fired 2026-07-31)
blocked-by: []
---

## Question

Which editor foundation should power the Notion-style block editor, given the constraints: **lossless markdown round-trip** (byte-stable for externally-written files), bun-only toolchain (`bun install`/`bun build`, no npm/node), safe/secure well-maintained dependencies, framework-agnostic or framework-light frontend, and support for slash commands, drag handles, task checkboxes, tables, code blocks, and custom node types (`[[doc-links]]`, ```secret blocks)?

Survey at minimum: ProseMirror (raw), TipTap, Milkdown, Lexical, BlockNote, CodeMirror 6 (decoration-based live markdown as a fallback paradigm), and hand-rolled contenteditable. For each: markdown round-trip fidelity story, dependency surface/security posture, bundle size, extensibility for custom blocks, maintenance health, license. End with a ranked recommendation and the key risk of the top pick.

Findings file: `wayfinder/research/block-editor-libs.md`

## Resolution

**TipTap 3 (MIT, v3.29.2) as the editor shell, paired with a bespoke remark/mdast markdown bridge that retains each block's original source text** — full analysis in [../research/block-editor-libs.md](../research/block-editor-libs.md). Empirical testing on 2026-07-31 showed that *no* AST-based editor is byte-stable: `prosemirror-markdown`, `@tiptap/markdown`, `remark-stringify` and BlockNote all mangled frontmatter, setext headings, `__strong__`, `1)` lists, task checkboxes, tables and `[[doc-links]]` on a realistic sample — so the lossless contract is an architecture, not a library choice. The winning architecture slices the source at `mdast` `position.offset` boundaries (verified byte-identical, including at `listItem` granularity and for unknown constructs like raw HTML, footnote and link definitions), stores each slice on its ProseMirror node, tracks dirt via `tr.steps`, and re-serializes only touched blocks. TipTap wins the shell role because every required affordance — drag handle, `@tiptap/suggestion` slash menu, tables, task lists, custom node views — is now first-party MIT after the June 2025 Pro open-sourcing, its core is framework-agnostic with zero runtime deps, and the measured stack is 131 packages / 224 kB gzip with a clean `bun audit`. Milkdown 7 ranks a close second (mdast-native, but 154 transitive packages and a single-maintainer bus factor), BlockNote is rejected outright since its own docs declare markdown lossy and JSON the source of truth, and CodeMirror 6 is retained only as a lazily-loaded "source mode" escape hatch. **Key risk:** the contract rests on ~400 lines of custom glue rather than on TipTap, and the dirt-tracking step is the fragile point — a missed dirty block silently writes stale markdown and destroys an edit, so the golden-corpus `bun test` round-trip suite specified in the findings must be treated as a release gate.
