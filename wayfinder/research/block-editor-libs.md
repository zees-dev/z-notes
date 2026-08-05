---
label: wayfinder:research
ticket: 07
title: Block-editor foundations with lossless markdown round-trip
date: 2026-07-31
---

# Block-editor foundations with lossless markdown round-trip

Research for [ticket 07](../tickets/07-research-block-editor-libs.md). All version numbers, bundle
measurements and round-trip outputs below were produced on **2026-07-31** against the then-current
npm releases, using **bun 1.3.14** (`bun add`, `bun build --minify --target=browser`, `bun audit`).
Nothing here is quoted from memory; every size and every mangled-markdown sample is a measurement.

---

## 0. The finding that reframes the question

**No AST-based editor — none of them, at any price — is byte-stable on markdown. Not one.** The
round-trip contract from [ticket 01](../tickets/01-editor-paradigm.md) cannot be satisfied by picking
a library. It can only be satisfied by an architecture: **keep the original source text of every
block and re-serialize only the blocks the user actually touched.**

I verified the negative empirically. A single 45-line sample file of realistic dev notes (YAML
frontmatter, setext heading, `__strong__`, 4-space nested list, `1)` ordered list, task list,
indented code block, GFM table, `***` rule, two-space hard breaks, `[[doc-link]]`, a ```` ```secret ````
fence, raw HTML) was pushed through each serializer:

| Engine | Byte-identical? | What it destroyed |
|---|---|---|
| `prosemirror-markdown` 1.13.5 (defaults) | no | frontmatter → h2, setext → ATX, `__x__` → `**x**`, `1)` → `1.`, **task lists escaped to `\[ \]`**, **entire GFM table flattened into one paragraph**, blockquote lines joined, indented code → fenced, `***` → `---`, `[[doc-link]]` → `\[\[doc-link\]\]`, `  ` hard break → `\` |
| `@tiptap/markdown` 3.29.2 + StarterKit | no | frontmatter → h2 + paragraph, setext → ATX, `__x__` → `**x**`, `1)` → `1.`, **task checkboxes silently dropped** (`- [ ] x` → `- x`), **table dropped entirely**, `***` → `---`, `[[…]]` escaped, `<b>raw html</b>` → `**raw html**` |
| `@tiptap/markdown` 3.29.2 + TableKit + TaskList | no | frontmatter still broken; setext → ATX; `__x__` → `**x**`; `1)` → `1.`; table reformatted + spurious blank line; `[[…]]` escaped. (Tasks and tables now survive.) |
| `remark-parse`/`remark-stringify` 11 + gfm + frontmatter (Milkdown's engine) | no | setext → ATX, `__x__` → `**x**`, `1)` → `1.`, indented code → fenced, table columns re-padded, `  ` hard break → `\`, `[[doc-link]]` → `\[\[doc-link]]`. **Frontmatter and GFM tables preserved.** |
| `@blocknote/core` 0.52.1 | no — and vendor says so | see §4 — the API is literally named `blocksToMarkdownLossy` |
| CodeMirror 6 (decorations) | **yes, trivially** | nothing — the document *is* the markdown text |

remark is the best of the AST group by a wide margin and it is **idempotent after the first pass**
(second serialization equals the first, verified). But idempotent ≠ byte-stable, and "normalize once
on open" is exactly what ticket 01 forbids ("no normalize-on-save").

### The architecture that does satisfy the contract

`mdast` nodes from `remark-parse` carry exact `position.start.offset` / `position.end.offset`.
Slicing the original source at those offsets and re-concatenating the slices plus the inter-block
gaps reproduces the file **byte-for-byte**. Verified three ways on the sample corpus:

```
BLOCK COUNT: 15
REASSEMBLED BYTE-IDENTICAL: true
block types: yaml, heading, paragraph, list, list, list, blockquote, code, code, table,
             thematicBreak, paragraph, paragraph, code, paragraph
```

```
leaf units: 18   types: yaml,heading,paragraph,listItem,blockquote,code,table,thematicBreak
LIST-ITEM GRANULAR REASSEMBLY IDENTICAL: true      # recursing into lists still byte-exact
```

```
odd-construct top-level types: paragraph, definition, paragraph, footnoteDefinition, html, paragraph
ODD CONSTRUCTS SLICE-REASSEMBLY IDENTICAL: true    # link defs, footnotes, raw HTML blocks, $$math$$
```

`marked` 18.0.7 (the parser under `@tiptap/markdown`) offers the same property via `token.raw`:

```
marked top-level tokens: 30
RAW REASSEMBLY BYTE-IDENTICAL: true
```

…but marked mis-parses YAML frontmatter as `hr` + `heading` with no frontmatter extension in core,
whereas `remark-frontmatter` models it as a first-class `yaml` node. For a notes app with
tags-in-frontmatter, that difference matters.

So the library question collapses to: **which editor shell gives the best block UX and the cleanest
hooks for bolting a source-retaining markdown bridge onto it?**

---

## 1. Scorecard

Sizes are what `bun build --minify --target=browser` actually emitted for a realistic feature set,
plus `gzip -9`. "Pkgs" is the transitive count `bun add` installed into a clean directory.

| Candidate | Version (2026-07-31) | License | Min / gzip | Pkgs | Round-trip story | Block UX out of the box |
|---|---|---|---|---|---|---|
| **TipTap 3** (core+pm+starter-kit+markdown+table+drag-handle+suggestion) | 3.29.2 (2026-07-28) | MIT | 644 kB / **199 kB** | 57 | marked-based, CommonMark-normalizing; extension hooks expose `token.raw` | **best** — first-party MIT drag handle, suggestion/slash, tables, task lists, node views |
| **ProseMirror raw** (view+state+model+tables+keymap+history+…) | view 1.42.2, model 1.25.11 | MIT | **232 kB / 70 kB** | ~15 | `prosemirror-markdown` is worst-in-class; you'd write your own anyway | none — you build everything |
| **Milkdown 7** (`@milkdown/kit` core+commonmark+gfm+block+slash+listener) | 7.21.3 (2026-07-12) | MIT | 502 kB / 149 kB | **154** | **best of the AST group** — mdast *is* the document model, `$remark`/`parseMarkdown`/`toMarkdown` per node | good — `plugin-block` (drag handle), `plugin-slash`, gfm preset |
| **Lexical** (core+markdown+rich-text+list+table+link+code) | 0.49.0 (2026-07-30) | MIT | **332 kB / 105 kB** | **20** | weakest — regex `Transformer[]`, no positions, custom nodes need hand-written transformers | none first-party |
| **BlockNote** (`@blocknote/core`) | 0.52.1 (2026-07-20) | MPL-2.0 core, `xl-*` = GPL-3.0 OR PROPRIETARY | 571 kB / 171 kB (+React UI) | 37 | **vendor-declared lossy**; JSON is the recommended source of truth | excellent — but React-only UI |
| **CodeMirror 6** (`codemirror` meta + `lang-markdown`) | view 6.43.7, lang-markdown 6.5.1 | MIT | 616 kB / 204 kB (lean: 511 kB / 172 kB) | 23 | **perfect, free** — decorations are view-only | none — it is a text editor, not a block editor |
| Hand-rolled contenteditable | — | — | ~0 | 0 | perfect (you own the buffer) | none — and you own IME, selection, undo, a11y forever |

`bun audit` reported **"No vulnerabilities found"** for every one of the six install trees.

---

## 2. TipTap 3 — the shell candidate

**Health.** `@tiptap/core` 3.29.2 published 2026-07-28; repo pushed 2026-07-30; 37.8k stars; 843 open
issues (large but the repo is huge). 90-day commit distribution is spread across `bdbch`,
`alexvcasillas`, `arnaugomez` and community PRs — a company (ueberdosis) behind it, not one person.

**License.** MIT across the board, and materially better than it was: in June 2025 ueberdosis
**open-sourced ten formerly-Pro extensions under MIT**, including the drag handle
([release note](https://tiptap.dev/blog/release-notes/were-open-sourcing-more-of-tiptap),
[HN](https://news.ycombinator.com/item?id=44202103)). npm confirms `@tiptap/extension-drag-handle@3.29.2`
is `MIT` with a single dependency (`@floating-ui/dom`). The paid tier is now Cloud/collab/AI —
irrelevant here. Every extension the ticket asks for is free:

| Need | Package | License |
|---|---|---|
| slash commands | `@tiptap/suggestion` (0 deps) | MIT |
| drag handles | `@tiptap/extension-drag-handle` | MIT |
| task checkboxes | `@tiptap/extension-list` (`TaskList`/`TaskItem`) | MIT |
| tables | `@tiptap/extension-table` (`TableKit`) | MIT |
| code blocks | `@tiptap/extension-code-block` (StarterKit) | MIT |
| custom nodes | `Node.create()` + `addNodeView()` | MIT |

**Framework posture.** `@tiptap/core` is framework-agnostic vanilla JS with **zero** runtime
dependencies; React/Vue/Svelte adapters are separate opt-in packages. Satisfies "framework-agnostic
or framework-light" without qualification.

**Markdown.** `@tiptap/markdown` is new — bidirectional markdown shipped
[2025-10-15](https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap),
built on `marked` ^17 (now 18.0.7 in 3.29.2). The extension API is the right shape —
`markdownTokenName`, `parseMarkdown(token, helpers)`, `renderMarkdown(node, helpers, context)`,
custom tokenizers that expose `raw`
([docs](https://tiptap.dev/docs/editor/markdown/guides/integrate-markdown-in-your-extension),
[custom serializing](https://tiptap.dev/docs/editor/markdown/advanced-usage/custom-serializing)) —
but the default behaviour, measured above, mangles frontmatter, drops tables and task checkboxes
when the matching extensions aren't loaded, and escapes `[[…]]`. Tiptap's own docs concede the
limit: *"Markdown coverage follows CommonMark. If you use highly custom extensions, you may need to
define parsing and serialization rules manually."*

Bottom line: **take TipTap's editor, don't take TipTap's markdown.**

---

## 3. Milkdown 7 — the closest philosophical match

Milkdown is ProseMirror + remark with mdast as the *native* document representation, and it is the
only candidate whose design already assumes markdown is the source of truth. `@milkdown/kit` 7.21.3
(2026-07-12), MIT, 11.8k stars, only **32 open issues** — an unusually tidy tracker — repo pushed
2026-07-31. Ships `plugin-block` (drag handle), `plugin-slash`, `preset-gfm`, plus recent
`plugin-diff` and `plugin-streaming` (the latter is aimed squarely at LLM token streaming, which is
a real bonus given [ticket 02](../tickets/02-ai-backend.md)).

Custom nodes are declared with paired remark + schema plugins — the pattern is exactly what
`[[doc-links]]` and ```` ```secret ```` need
([marker plugin example](https://milkdown.dev/docs/plugin/example-marker-plugin)):

```ts
const remarkWikiLink = () => (tree) => visit(tree, 'text', (node, i, parent) => { /* … */ })
export const wikiLink = $remark('wikiLink', () => remarkWikiLink)
export const wikiSchema = $nodeSchema('wikiLink', () => ({
  parseMarkdown: { match: n => n.type === 'wikiLink', runner: /* … */ },
  toMarkdown:    { match: n => n.type.name === 'wikiLink', runner: /* … */ },
}))
```

Two counts against it:

1. **Dependency surface: 154 packages** for `@milkdown/kit` alone (163 dirs on disk) — mostly the
   `micromark-*` / `mdast-util-*` micro-package constellation, which is high-quality and
   heavily-fuzzed but is 60+ separately-publishable npm identities in the supply chain, plus
   `lodash-es`, `dompurify`, `magic-string`, `estree-walker`.
2. **Bus factor.** 90-day commits: `Saul-Mirone` 18, renovate 8, everyone else ≤2. One maintainer.
   For a private single-user app that's survivable; it is still the sharpest maintenance risk in the
   shortlist.

Note that adopting Milkdown does **not** get you byte-stability for free — its `toMarkdown` runners
feed `remark-stringify`, which produced the normalized (not identical) output measured in §0. You
would still build the source-retention layer; you'd just build it against mdast directly instead of
adapting marked tokens.

---

## 4. BlockNote — disqualified by its own documentation

BlockNote is the best Notion clone in the list, and it is the wrong tool here. Its docs
([supported formats](https://www.blocknotejs.org/docs/foundations/supported-formats)) classify
BlockNote JSON and `blocksFullHTML` as **lossless** and markdown as **lossy**, and state plainly:
*"It's recommended to use BlockNote JSON (`editor.document`) for storing your documents, as it's the
most durable format & guaranteed to be lossless."* The export API is named `blocksToMarkdownLossy()`.
"Children of blocks which aren't list items are un-nested and certain styles are removed."

That is a direct contradiction of ticket 01. Secondary strikes: the UI layer is React-only
(`@blocknote/react`, `@blocknote/mantine`, `@blocknote/ariakit`, `@blocknote/shadcn` — no vanilla
build); core is **MPL-2.0** (file-level copyleft — fine for a private app, a consideration if code is
ever vendored/modified and redistributed); and the `xl-*` packages
(`xl-multi-column`, `xl-ai`, `xl-docx-exporter`) are **`GPL-3.0 OR PROPRIETARY`** dual-licensed —
usable privately under GPL, but a licensing tripwire.

**Reject.**

---

## 5. Lexical — smallest and most modern, weakest markdown

Genuinely attractive numbers: **332 kB min / 105 kB gzip** and only **20** transitive packages, the
leanest real editor measured. MIT, Meta-backed, 23.7k stars, released 0.49.0 on 2026-07-30 with a
monthly cadence and a healthy contributor spread.

Against it:

- **Still 0.x after four years.** No 1.0; the changelog carries `Breaking Change`-prefixed entries in
  recent minors (e.g. v0.45.0 changed selection/reconcile semantics). For a project whose whole
  point is stability of on-disk bytes, an editor that reserves the right to break its API every
  month is friction.
- **Markdown is regex transformers, not a parser.** `@lexical/markdown` is an array of
  `ElementTransformer` / `TextFormatTransformer` / `TextMatchTransformer` objects with no source
  positions and no CommonMark conformance guarantee. There is no table transformer in the default
  `TRANSFORMERS`; tables need `@lexical/table` plus a hand-written transformer. Recent fixes in the
  changelog are literally about round-trip escape bugs ("ordered-list patterns are escaped inside
  bullet/check list item exports to fix double-escape on round-trip") — the class of bug is live.
  Lexical's own docs: converting custom nodes to and from markdown "requires creating custom
  transformers, which is not an easy task."
- **No first-party drag handle or slash menu.** Both are hand-rolled or community plugins.

Sound engine, wrong markdown story, and it would cost more custom code than TipTap for less block UX.

---

## 6. CodeMirror 6 — the paradigm that wins the contract and loses the brief

CM6 is the only candidate that is byte-stable *by construction*: `EditorState.doc` is the markdown
text, and `Decoration.replace` / widget decorations render headings, tables and checkboxes as a
view-only overlay. Save, copy, git diff — all byte-identical to what was loaded, always. This is how
SilverBullet (MIT, 5.7k stars, pushed 2026-07-30) and Obsidian's live preview work.

But:

- It is **not a block editor.** Drag-to-reorder blocks, block handles and true block-level DnD are
  foreign to a linear text buffer; you would be reimplementing the block model on top of a text
  model. Slash commands are easy (`@codemirror/autocomplete`); drag handles are not.
- It is **not small.** `codemirror` + `@codemirror/lang-markdown` measured **616 kB min / 204 kB
  gzip** — *heavier than the entire TipTap set* — because `lang-markdown` pulls `lang-html`, which
  pulls the JS and CSS Lezer parsers for embedded code. A hand-picked setup
  (`view`+`state`+`commands`+`language`+`lang-markdown`) is still 511 kB / 172 kB; core without
  markdown is 271 kB / 86 kB.
- **Supply-chain note:** CodeMirror, Lezer *and ProseMirror* migrated off GitHub to Marijn
  Haverbeke's self-hosted Forgejo at `code.haverbeke.berlin` in ~April 2026 and the GitHub repos are
  now **archived**
  ([ProseMirror announcement](https://discuss.prosemirror.net/t/prosemirrors-migration-to-forgejo/8974),
  [CodeMirror announcement](https://discuss.codemirror.net/t/codemirrors-migration-to-forgejo/9706)).
  npm `repository` fields already point at `code.haverbeke.berlin`. The packages are **actively
  maintained** (`@codemirror/view` 6.43.7 published 2026-07-27, `prosemirror-model` 1.25.11 on
  2026-07-11), but GitHub-native security tooling, Dependabot advisory linkage and issue archaeology
  now have a gap. Both TipTap and Milkdown inherit this, since both sit on ProseMirror. Worth
  recording as a standing risk rather than a blocker.

**Verdict: not the primary editor, but keep it.** Ship CM6 as a lazily-loaded **"source mode"
toggle** — a raw-markdown view of the current file. It costs one dynamic `import()`, it is the
ultimate escape hatch when the block editor can't represent something, and it is a live proof of the
byte-stability contract the user can eyeball at any time.

---

## 7. Hand-rolled contenteditable — reject

`contenteditable` is a decade of edge cases: IME composition on CJK input, Safari selection
divergence, undo-stack ownership, paste sanitization, screen-reader semantics, `beforeinput`
coverage. ProseMirror exists because this is genuinely hard. Rejected without further analysis; the
only defensible "hand-rolled" position is CM6, which is §6.

---

## Recommendation

### Ranked

1. **TipTap 3 (MIT) as the editor shell + a bespoke remark/mdast markdown bridge with per-block
   source retention.** ← recommended
2. **Milkdown 7** — close second; better markdown philosophy, worse bus factor and 3× the dependency
   count. Pick this if the mdast-native plugin ergonomics matter more than ecosystem depth.
3. **ProseMirror raw + remark** — smallest bundle (232 kB + 156 kB min ≈ 388 kB / 116 kB gzip) and total
   control; costs weeks rebuilding drag handles, slash menus and table UI that TipTap gives free.
4. **CodeMirror 6** — adopt as the secondary *source mode*, not as the primary editor.
5. **Lexical** — leanest, but 0.x churn + weakest markdown + no block UX.
6. **BlockNote** — reject; markdown is lossy by vendor design and JSON is its source of truth.
7. **Hand-rolled contenteditable** — reject.

### Concrete parameters

**Dependencies** (all MIT, all installed and audited clean under bun 1.3.14):

```
@tiptap/core@3.29.2              @tiptap/pm@3.29.2
@tiptap/starter-kit@3.29.2       @tiptap/extension-table@3.29.2
@tiptap/extension-list@3.29.2    @tiptap/extension-drag-handle@3.29.2
@tiptap/suggestion@3.29.2
unified@11  remark-parse@11  remark-stringify@11  remark-gfm@4  remark-frontmatter@5
```

Deliberately **excluded**: `@tiptap/markdown` (and its `marked` dependency) — replaced by the remark
bridge. Deliberately **excluded**: any React/Vue adapter.

Measured for this exact set: `bun add` → **131 packages**, `bun audit` → **no vulnerabilities**,
`bun build --minify --target=browser` → **738 kB minified / 224 kB gzipped**. (Trimming StarterKit to
only the nodes the schema actually uses will cut this; for a local-first single-user app served by
bun it is already acceptable.) Lazily-import CM6 source mode on demand (+172 kB gzip, never on the
critical path).

**The source-retention algorithm** (this is the load-bearing part of the recommendation):

1. **Parse** the file with `unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])`.
   Retain the original `src` string for the lifetime of the open document.
2. **Slice into units.** Walk `tree.children`; recurse into `list` down to `listItem` so that ticking
   one checkbox does not dirty a 200-item list. For each unit record
   `{ raw: src.slice(start.offset, end.offset), gapBefore: src.slice(prevEnd, start.offset) }`.
   Both proven byte-exact above, including at `listItem` granularity.
3. **Build the PM doc** with every top-level node carrying attrs `{ mdRaw, mdGap, mdDirty: false }`.
4. **Track dirt** with a ProseMirror plugin: in `appendTransaction`, walk `tr.steps` →
   `StepMap.forEach` → map each changed range up to its owning top-level node and set
   `mdDirty: true`. Dirt is sticky and survives undo.
5. **Serialize on save:** `units.map(u => u.mdGap + (u.mdDirty ? stringify(u.node) : u.mdRaw)).join('') + tail`.
   Untouched file in → **byte-identical file out**. Only touched units get re-rendered.
6. **`rawBlock` escape node.** Any mdast node the PM schema cannot faithfully represent — `html`,
   `definition`, `footnoteDefinition`, `$$math$$`, MDX, anything future — becomes a `rawBlock` PM
   node rendered as a read-only monospace card, `mdDirty` permanently false, emitted verbatim.
   Verified: these constructs slice and reassemble byte-exactly. This is what prevents the app from
   ever corrupting a file it does not understand.
7. **`[[doc-links]]`** — a ~15-line remark micro-plugin over `text` nodes producing a `wikiLink`
   mdast node, paired with a PM inline node holding `raw`, plus a `remark-stringify` handler that
   emits it verbatim. Non-negotiable: *every* default serializer tested escapes it to `\[\[…\]\]`.
8. **```` ```secret ```` blocks** — a `code` node with `lang: 'secret'` and a custom node view
   (locked card / passphrase unlock, per [ticket 03](../tickets/03-secrets-model.md)). Fenced code
   preserves its body exactly, so the ciphertext is never reflowed or escaped.
9. **`remark-stringify` options for dirty units** — pin these so re-serialization matches house style
   and is idempotent (idempotency after one pass is verified):
   `{ bullet: '-', listItemIndent: 'one', emphasis: '*', strong: '*', fence: '`', fences: true, rule: '-', setext: false, incrementListMarker: true, resourceLink: false, tightDefinitions: true }`
   plus custom `handlers` for `wikiLink` and `rawBlock`.
10. **Test gate.** A `bun test` golden corpus of ~30 real note files asserting two invariants:
    (a) parse → serialize with zero edits is `===` the input, for every file;
    (b) parse → mutate one block → serialize → re-parse → re-serialize is stable (idempotent).
    Add every regression as a corpus file. This suite is the contract; treat a red run as a release
    blocker.

### Key risk of the top pick

**The lossless contract rests on ~400 lines of bespoke glue, not on TipTap.** TipTap contributes zero
round-trip fidelity — its own serializer, as measured, mangles frontmatter, drops task checkboxes and
escapes `[[…]]`. The dirt-tracking step (4) is the fragile part: it maps ProseMirror step ranges to
block ownership, and every way it can be wrong is a way to silently rewrite the user's file. A false
negative (missed dirt) writes stale markdown and destroys an edit; a false positive is benign but
erodes byte-stability, and near-total false-positive rates would quietly degrade the app into the
normalize-on-save behaviour ticket 01 rejected. Compounding it: the contract only holds for
*untouched* blocks, so a user who types one character into a paragraph that used `__strong__` gets
`**strong**` back — correct per the contract, surprising in a git diff. Mitigations: the §10 test
suite, `listItem`-level granularity to keep dirty regions small, the `rawBlock` node so unknown
syntax is structurally unreachable by the serializer, and CM6 source mode as a user-visible check.
Secondary risk: TipTap, Milkdown and CM6 all sit on ProseMirror/Lezer, which now live on
`code.haverbeke.berlin` with archived GitHub mirrors — still actively released to npm, but outside
GitHub's advisory and Dependabot ecosystem.

---

## Sources

- [Tiptap — bidirectional Markdown support release note (2025-10-15)](https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap)
- [Tiptap — integrating Markdown in your extension](https://tiptap.dev/docs/editor/markdown/guides/integrate-markdown-in-your-extension)
- [Tiptap — custom Markdown serializing](https://tiptap.dev/docs/editor/markdown/advanced-usage/custom-serializing)
- [Tiptap — "We're open-sourcing more of Tiptap"](https://tiptap.dev/blog/release-notes/were-open-sourcing-more-of-tiptap) · [HN discussion](https://news.ycombinator.com/item?id=44202103)
- [ueberdosis/tiptap](https://github.com/ueberdosis/tiptap) — 37.8k★, pushed 2026-07-30, MIT
- [BlockNote — format interoperability (lossy vs lossless)](https://www.blocknotejs.org/docs/foundations/supported-formats)
- [BlockNote — Markdown export](https://www.blocknotejs.org/docs/features/export/markdown)
- [Milkdown — marker plugin example (custom node via `$remark` + `parseMarkdown`/`toMarkdown`)](https://milkdown.dev/docs/plugin/example-marker-plugin)
- [Milkdown/milkdown](https://github.com/Milkdown/milkdown) — 11.8k★, 32 open issues, MIT
- [@lexical/markdown docs](https://lexical.dev/docs/packages/lexical-markdown) · [facebook/lexical releases](https://github.com/facebook/lexical/releases)
- [ProseMirror's migration to Forgejo](https://discuss.prosemirror.net/t/prosemirrors-migration-to-forgejo/8974)
- [CodeMirror's migration to Forgejo](https://discuss.codemirror.net/t/codemirrors-migration-to-forgejo/9706)
- [ProseMirror/prosemirror-markdown](https://github.com/ProseMirror/prosemirror-markdown)
- [silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet) — CM6 decoration-based live preview, MIT
- npm registry metadata for all packages, queried 2026-07-31; bundle and round-trip measurements produced locally with bun 1.3.14
