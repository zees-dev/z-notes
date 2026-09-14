# 0020 — BlockNote is the doc editor; Markdown files stay the source of truth

## Problem Statement

The user tested a BlockNote prototype (Notion-style block editing: slash menu,
floating formatting toolbar, drag handles, nested bullet/numbered/task lists,
tables, inline Mermaid diagrams, a phone toolbar docked on the soft keyboard
with Bullet / Numbered / Checklist / Outdent / Indent and a ⋯ position
calibration) and approved a production cutover: "the UI should still appear
mostly the same but we can completely switch out the markdown editing
functionality so that this is primarily used. I expect large cutover and many
code reductions."

That cutover was implemented and validated on an OLD base of this repo (the
tree preserved on the local branch `blocknote-legacy`, checked out at
`/home/pi/projects/z-notes-legacy`, spec `docs/specs/done/0007-blocknote-editor.md`
THERE). Meanwhile `main` moved 101 commits to release 0.16.0: multi-vault
(ADR 0018), drop-to-upload (0030), WebMCP tools (0031), the one undo timeline
(0014), Raw as a line editor (0032), the pinch ladder (0033), the soft-keyboard
bar (0034), the root URL resume (0035), Esc/Enter round trip (0036), preview
folds (0023), quotes (spec 0019), line breaks (0015), external links + copy
button (0016), regex search, bidirectional sync, and more.

The user decided: **port the BlockNote cutover onto current production,
preserving its newer features.** Everything production does today that is not
the hand-written Preview renderer / click-to-edit machinery must keep working.
Then clean-code, an independent adversarial review, commit, push, redeploy.

## Solution

Replace the rendered **Preview** surface with an editable **BlockNote** React
island ("Edit"). Keep production's **Raw** line editor (`app/rawedit.js`,
ADR 0032) as the explicit **Source** surface, with everything it carries today:
Tab/⇧Tab list nesting, list/quote continuation, whole-line clipboard, the app
undo timeline, the soft-keyboard bar (ADR 0034), ⌘⇧E encrypt-selection, word
wrap, the mode-switch line anchoring (ADR 0027). Keep the whole surrounding
shell: tree, multi-vault, uploads, settings, chat/AI, terminal, trash, sync,
history, WebMCP, zoom, routing, secrets.

Markdown files remain canonical. A small source adapter
(`app/markdown-source.ts`, MDAST-based, ported verbatim from the legacy
branch where it has 32 passing tests) parses the doc into top-level source
groups; untouched groups and separators keep their exact bytes, only edited
groups pass through the standard serializer, unsupported syntax and
frontmatter are opaque protected blocks with an "Edit source" door, and
` ```age ` fences stay ciphertext-only blocks whose reveal/edit/lock controls
are the existing `secrets.js` DOM injected into non-editable node views.

The island is bundled by the server at boot with `Bun.build` (the same
mechanism as the age bundle) and served from `/vendor/editor.js` /
`/vendor/editor.css` — no separate build command, no CDN. The hand-written
Preview renderer (`app/markdown.js`), the click-to-edit zones, the
Enter-resumes-Raw door, preview folds and the committed mermaid bundle
(`app/mermaid.js`, `app/vendor/mermaid.js`, its generator) are deleted:
BlockNote and its diagram block supersede them.

## User Stories

1. As the vault owner, I want to edit formatted docs directly (bold, lists,
   headings, tables, diagrams) so that writing no longer requires typing
   Markdown syntax — and I want ⌘E / the mode chip to still give me the exact
   source in Source mode.
2. As a phone user, I want one-tap Bullet / Numbered / Checklist / Outdent /
   Indent controls docked on the keyboard in Edit, a ⋯ menu with ↑/↓/Reset that
   calibrates the dock's position (remembered per browser), the dock hidden
   until the doc has focus — exactly the behaviour I approved on my Android;
   and in Source I want the existing keyboard bar (Outdent, Indent, Undo, Redo,
   Done) as today.
3. As a writer, I want the slash menu, the floating formatting toolbar, block
   drag handles that target the block under them (compact themes included),
   tables and inline Mermaid diagrams.
4. As an owner of existing files, I want untouched bytes and unrelated source
   groups preserved — frontmatter, ciphertext, nested/unsupported syntax,
   CRLF, BOM, final newline — so that editing a paragraph never rewrites the
   rest of the file. The round-trip gate corpus must survive Edit → Source →
   Edit byte for byte.
5. As a reader of prose with soft line breaks, I want one `\n` to remain one
   visual line break in Edit (ADR 0015) and to round-trip unchanged.
6. As a source editor, I want Source to be the line editor production has
   today (heading sizes, link colour, Tab, ⌘Z timeline, keybar), and I want
   protected blocks in Edit to carry an "Edit source" button that lands me on
   their line in Source.
7. As a secret user, I want reveal / edit / copy / lock / re-encrypt to work
   inside Edit while plaintext never enters the editor's model, history,
   clipboard serialisation, any request body, the index or the AI context; and
   an edit must follow the correct block even when identical ciphertext appears
   twice and blocks are dragged around.
8. As an AI / WebMCP user, I want accepted and reverted proposals, `write_doc`,
   `edit_doc`, `append_to_doc` and external disk changes to appear in the
   open editor, while unsaved work still gets conflict / orphan protection and
   a stale refresh can never overwrite typing.
9. As a user leaving a dirty doc (tree click, ⌘K, link, Back, Settings), I want
   the existing exit guard in BOTH modes, honouring `editor.confirmBeforeExit`
   (ADR 0022): ask by default, save-first when off. Discard restores the
   on-disk baseline in the editor.
10. As a user whose doc is renamed or deleted from another device while I am
    typing, I want the buffer to follow the move (autosave included, pending
    secret encryption included) or to become an orphan with Recreate / Discard,
    as today.
11. As a self-hoster, I want pinned open-source editor assets served by this
    process; if the bundle or its stylesheet fails to load I want a visible
    notice and a usable Source editor, with the API and age bundle unaffected.
12. As a theme user, I want Edit to inherit the current theme's tokens, density
    and the pinch ladder (`--doc-zoom`, ADR 0033), with the document container
    rect-identical across modes at every breakpoint (the parity gate).
13. As an operator, I want a fence to stay untrusted input (ADR 0010): a
    diagram cannot downgrade `securityLevel`, re-enable html labels, run
    `click call`, or inject `javascript:` hrefs, and a broken diagram shows its
    error as text and keeps its source.
14. As an agent, I want every WebMCP tool to keep its name and shape
    (ADR 0031): `open_doc`/`set_mode` still take `raw` | `preview`, `indent_lines`
    still acts on the Source selection, `undo`/`redo` still step the app
    timeline.

## Implementation Decisions

### Ground rules

- Work in `/home/pi/projects/z-notes` on `main` (= `origin/main` 1feeda0,
  release 0.16.0). The legacy cutover is at `/home/pi/projects/z-notes-legacy`
  (branch `blocknote-legacy`, commit c07f693): read it, port from it, never
  edit it. `git diff 2dcff46 blocknote-legacy -- <file>` shows what the legacy
  cutover changed in a file; that diff is the port's blueprint.
- Coordinator-assigned file ownership (below) is exclusive; do not touch files
  outside your list. Do not commit, push, deploy, or touch the running preview
  server on :4700.
- Browser tests need `ZNOTES_CHROMIUM=/nix/store/c0s8bbj4s9ijzrqy9m21zkbmx29shzg8-chromium-143.0.7499.192/bin/chromium`
  in the environment. Run one file at a time while iterating.
- Vocabulary: **Edit** and **Source** are the user-facing names (chip text,
  titles, toasts, notices). Persisted mode ids stay `preview` and `raw`
  (settings, history entries, `data-mode`, the WebMCP enum, CSS hooks
  `raw-mode` / `raw-focus`, `#rawArea`, `guardRawExit`, …). Do not rename
  identifiers.

### Dependencies (exactly pinned, approved by the user for this cutover)

`@blocknote/core`, `@blocknote/react`, `@blocknote/mantine`,
`@blocknote/diagram-block` at `0.54.2` (MPL-2.0); `react`, `react-dom`
`19.3.0`; `@mantine/core`, `@mantine/hooks` `9.6.1`; `mdast-util-from-markdown`
`2.0.3`, `mdast-util-to-markdown` `2.1.2`, `mdast-util-gfm` `3.1.0`,
`micromark-extension-gfm` `3.0.0`, `mdast-util-frontmatter` `2.0.1`,
`micromark-extension-frontmatter` `2.0.0`. All are `dependencies` (the server
bundles them at boot). Remove the `mermaid` devDependency: the diagram block
depends on mermaid itself (pinned by `bun.lock`), and the committed bundle is
deleted. No XL / commercial BlockNote package. `bun install`, commit the
lockfile.

### The island — `app/block-editor.tsx` (port of the legacy file)

- Exports `mountEditor(host, options): EditorController`. Options:
  `markdown`, `onChange(markdown)`, `onSource(line)` (1-based),
  `renderSecret({id, ciphertext, line, indent})` → HTMLElement,
  `copyText(text)`, `resolveWikiLink(target)` → path | undefined,
  `onWikiLink(target)`. Controller: `destroy()`, `getMarkdown()`,
  `setMarkdown(md)`, `focus()`, `revealLine(line, anchor?)`, `anchorLine()`,
  `getSecrets()`, `replaceSecret(id, ciphertext)`.
- The island imports only npm packages and `./markdown-source`. Never
  `state.js`, `secrets.js` or any other shell module (lint enforces leaves;
  the island is a leaf of the shell by construction).
- Schema: paragraph, heading, bulletListItem, numberedListItem,
  checkListItem, quote, codeBlock (with the legacy Copy button), table,
  `source` (protected Markdown, non-editable, label Metadata/Source, "Edit
  source" button), `secret` (ciphertext prop, renders the injected secret
  DOM), `diagram` (`createReactDiagramBlockSpec()`), inline `wikiLink` atom.
  Styles bold / italic / strike / code only. `onBeforeChange` rejects
  transactions the adapter cannot serialise (colours, alignment, merged
  cells, nesting protected blocks, moving metadata, EOF-dependent groups
  before prose) — port the legacy guard as is.
- Slash menu: default React items plus `getDiagramSlashMenuItems`. Side menu
  with `floatingUIOptions: { useFloatingOptions: { middleware: [] } }` so
  the handle sits beside compact blocks (the legacy drag fix). Blocks keep a
  30px minimum height (CSS, below).
- Phone toolbar (`Toolbar` component): Bullet, Numbered, Checklist, Outdent,
  Indent, the ⋯ button, the Position ↑/↓/Reset options, `znotes.toolbarOffset`
  in `localStorage` clamped to ±160px in 8px steps, Escape ordering
  (native menus and the palette first), pointer-down preventDefault so focus
  stays in the editor. Port verbatim; the user validated it on device.
- **Mermaid hardening (ADR 0010 stays in force).** The diagram block calls
  `mermaid.initialize` once, lazily, with `htmlLabels:false`,
  `startOnLoad:false`, `suppressErrorRendering:true` and mermaid's default
  `securityLevel:"strict"`. To keep production's lock, the island imports
  `mermaid` (the same bundled instance) and `initializeMermaid` from
  `@blocknote/diagram-block`, calls `initializeMermaid()` at module load and
  then `mermaid.initialize({...})` once more with the keys `app/mermaid.js`
  locks today (read its `secure` list and its config: `securityLevel:
  "strict"`, `htmlLabels:false` on every diagram family, `dompurifyConfig` /
  `themeCSS` not settable from a fence, `startOnLoad:false`,
  `suppressErrorRendering:true`). Verify by measurement in the migrated
  gate 6 (below): the four attack fences are inert in Edit.
- Undo inside Edit is BlockNote's own (ProseMirror history). Visual edits are
  NOT recorded on the app timeline (`noteTextEdit` is not called from
  `onChange`); Raw runs and file operations stay on it. `applyTextHistory`
  for a Raw entry while Edit is showing re-renders the doc (already the
  `else renderDoc()` branch). Say so in the ADR.

### The adapter — `app/markdown-source.ts` (port verbatim)

`SourceSession(markdown)` with `blocks`, `markdown`, `serialize(blocks)`,
`range/ranges`, `secrets`, `sourceParts`, `replaceSecret`, `requiresEnd`,
`requiresEndBlock`. Soft breaks: MDAST yields text containing `\n`; keep it
as text (never a hard `break`), so an untouched paragraph round-trips and an
edited one keeps its newline. Verify a soft newline shows as two visual lines
in Edit; if BlockNote's inline content does not honour `\n`, add
`white-space: pre-wrap` to `.doc .bn-inline-content` in base.css (CSS owner
below) rather than changing the adapter.

### Server — `server/index.ts`, `deploy/Dockerfile`, `deploy/README.md`, `scripts/lint-docs.ts`, `package.json`

- Port `buildEditor()` / `serveEditor()` from the legacy diff: `Bun.build`
  of `app/block-editor.tsx`, `target:"browser"`, `format:"esm"`, `minify`,
  `splitting`, `publicPath:"/vendor/editor/"`, hashed entry/chunk/asset
  names, `define process.env.NODE_ENV = "production"`; assets held in memory
  with ETags; `/vendor/editor.js` and `/vendor/editor.css` are `302`
  `no-cache` aliases to the hashed files, which are `immutable`; `HEAD` and
  `If-None-Match` → `304`; a failed build leaves the API and `/vendor/age*`
  intact and answers `503 vendor-unavailable` `{error, message, detail}` for
  the editor paths. Boot: `await Promise.all([buildVendor(), buildEditor()])`
  before `Bun.serve`. Route: `/vendor/editor.js|css` and `/vendor/editor/*` →
  `serveEditor`; `/vendor/age*` → `serveVendor` (unchanged); anything else
  under `/vendor/` keeps falling through to `serveStatic` as today.
- Dockerfile: the `NO FRONTEND BUILD STEP` and `MERMAID IS NOT THAT` comments
  must describe the new truth (the island is bundled at boot like age, so its
  dependencies are runtime dependencies; the committed mermaid bundle is
  gone). No new stage; `--production` install now carries the editor
  packages. `deploy/README.md` §1's "There is no frontend build step" paragraph
  likewise.
- `scripts/lint-docs.ts` §6: scan `app/*.{js,ts,tsx}`, accept `./x`, `./x.js`,
  `./x.ts` import spellings, add `markdown-source` to `LEAVES` (port the
  legacy 4-line diff). Delete `scripts/build-mermaid.ts`,
  `scripts/mermaid-entry.js`, `app/vendor/mermaid.js`, `tests/mermaid.test.ts`.

### App integration — `app/editor.js`, `app/app.js`, `app/webmcp.js`, `app/index.html`, `app/themes/base.css`, `app/ui.js`; delete `app/markdown.js`, `app/mermaid.js`

Port the legacy `editor.js` diff onto production's `editor.js`, keeping every
production feature that is about Raw or the shell. Concretely:

- `renderDoc`: `destroyEditor()` first, then `host.innerHTML = ""`; Raw →
  `renderRaw` (production's, unchanged); otherwise `renderVisual(doc, host)`
  (legacy: lazy `import("/vendor/editor.js")`, wait for `#editor-css`
  (`load`/`error` + `dataset.loaded/failed`), mount generation guard, the
  `renderSecret` bridge with `bindSecretIds`, `onSource(line)` →
  `setMode("raw", {caret, line})`, `resolveWikiLink` via `lookupLink`,
  `onWikiLink` by clicking a transient `a.wl[data-link]` so the existing
  link handler (and multi-vault resolution) runs; on failure fall back to
  Source with the `note bad` notice). Drop the `.empty-doc` placeholder (an
  empty doc is an empty editor). Keep `host.style.tabSize`, crumbs,
  `#stPath`, meta row, fade-in.
- Delete `previewClickToEdit`, `paneClickToPreview`, `trackScrollPointerDown`,
  `blockForLine`, `previewAnchor`, `alignPreview`, `rememberRawCaret`,
  `resumeRaw`, the `rawCaret` map, `ensureLineVisible`/`renderPreview`
  imports, and app.js's three click-zone listeners, its Enter-resume handler
  and `RESUME_BLOCKED`.
- ADR 0027 on the Edit side: `setMode` computes `carry` from
  `visual.anchorLine()` when leaving Edit (`{line, anchor}` of the first
  block whose rect bottom is below the pane top: line from the session's
  ranges, anchor = rect.top − pane top) and, when entering Edit, calls
  `visual.revealLine(carry.line, carry.anchor)` once mounted (the island
  mounts asynchronously: keep `pendingLine`/pending anchor and apply after
  mount). `revealLine(lineNo)` for `openDoc({line})` and search hits: Raw as
  today; Edit → `visual.revealLine(lineNo + 1)` or pending.
- `rawExitDiff()`: no longer gated on `state.mode === "raw"`; compares the
  Source buffer (`ta.value` when it differs from `ta.zSourceValue`, the
  legacy CRLF guard) or `doc.markdown` against `doc.diskText`; a dirty
  revealed secret with no text change yields the single "Edited secret block
  (plaintext hidden)" row. `guardRawExit(proceed, onCancel)` and the
  `editor.confirmBeforeExit` save-first branch are production's — keep them.
  `closeExitGuard` refocuses `visual` when not in Raw. `exitGuardDiscard`
  clears that path's reveals, calls `visual.setMarkdown(doc.markdown)`,
  `repaintSecretsUI()`, `syncRawFromModel`, and re-seeds the text baseline
  (`markTextBaseline`). `exitGuardSave` re-raises the guard if the doc is
  still dirty after the write (legacy).
- `syncRaw()` only adopts `ta.value` when it differs from `ta.zSourceValue`
  (set in `renderRaw`, the `input` listener and `syncRawFromModel`), then
  `flushTextRun()` as today.
- `openDoc`: `state.dirty = doc.markdown !== doc.diskText` and the indicator
  follows (legacy), everything else production's (`rememberLastDoc`, settings
  exit, `revealInTree`, drawer close, `line`).
- `syncModeUI`: chip text `Edit` / `Source`; titles "Visual editing — click (or
  ⌘E) for Source" / "Markdown source — click (or ⌘E) for Edit"; `#encBtn`
  hidden unless Raw; `syncWrapUI()` stays. Mode toast: "Markdown source" /
  "Visual editing".
- `markDirty` captures `state.active` into the timer (legacy), so a move
  retargets the pending autosave. `saveDoc`/`doSaveDoc` keyed by the doc
  OBJECT (legacy `saveInflight` by identity; `doSaveDoc(doc, opts)`;
  re-dispatch when `doc.path !== path` after the secret flush or a failed
  PUT; after a successful PUT `state.dirty` is recomputed from
  `doc.markdown !== sent || dirty reveal`). `replaceDocText` unchanged except
  it already re-renders Edit through `renderDoc()`.
- Export `destroyEditor()`, `replaceVisualSecret(path, id, ciphertext)` (used
  by secrets.js), keep every export production has that survives.
- `app/app.js` keydown: the legacy ownership rule — when the event target is
  inside `.bn-container` / `.bn-portal` and the chord is not an app chord
  (⌘S ⌘E ⌘J ⌘K ⌘P ⌘, ⌘/ ⌘N ⌘⇧L) and no veil is open, return; also return on
  `defaultPrevented` non-app chords. ⌘Z/⌘⇧Z inside the island are therefore
  BlockNote's. Everything else in `wire()` stays (keybar, zoom, history,
  WebMCP registration last).
- `app/webmcp.js`: keep every tool and enum. Descriptions: `preview` is "the
  visual editor (Edit)", `raw` is "the Markdown source (Source)". `indent_lines`
  keeps requiring Raw (message: "Switch to Source first."). No new tools.
- The setting `editor.clickToEdit` is retired end to end: its UI switch, its
  entry in `server/settings.ts` (`DEFAULTS`, the boolean list, the description
  table) and its mentions in `docs/specs/done/0002-http-api-v0.md`; the loader
  already prunes unknown keys, so an existing `settings.toml` still loads.
  `tests/settings.test.ts`'s parity test then holds without a dead control.
- `app/index.html`: `<link rel="stylesheet" id="editor-css"
  href="/vendor/editor.css" onload=… onerror=…>` BEFORE `base.css`; chip
  markup `Edit` with the new title; drop the "Click preview to edit" settings
  field; shortcut sheet rows and the footer note say Edit / Source; the keybar
  markup stays.
- `app/themes/base.css`: delete the `.md*`, `.task/.cb/.tx`, `.tblwrap*`,
  `.code*`/`.tk-*`, `.divider`, `.bgap`, `.empty-doc`, fold chevron, quote,
  `[data-line]`/`.flash-line`, `.xl`+copy-button and `.render-error` rules
  that only the deleted renderer used (grep before deleting: `code.ic` and
  `.wl` are shared with chat and stay). Add the legacy island rules: theme
  tokens mapped onto `.bn-root.bn-mantine --bn-colors-*`, `.doc .bn-editor
  { padding:0; background:transparent; font:inherit; line-height:var(--d-lh) }`
  — `font-size: inherit` (NOT `var(--d-font)`) so `.doc`'s `--doc-zoom` applies
  (ADR 0033); `.doc .bn-block-content { min-height:30px }`; heading and code
  token rules; `.z-source-block`, `.z-secret-host`, `.z-code-copy`,
  `.z-block-toolbar` desktop and `@media (max-width:767px)` docked rules using
  `--visual-bottom` / `--kb`, the 16px phone floor, the toolbar-hidden-until-
  focus rule, `.app:not(.chat-open) .chat { visibility:hidden }` on phones.
  Theme files stay layout-free (ADR 0003); `tests/themes-tokens.test.ts` is
  a source-text test — read it first.
- `app/ui.js`: delete `hl()` if nothing imports it after markdown.js goes;
  `inline()` stays for chat. `app/tree.js`'s `import { cells } from
  "./markdown.js"` is dead — remove it (tree.js is owned by the shell task).

### Shell and secrets — `app/shell.js`, `app/secrets.js`, `app/tree.js`

- `shell.js` `connect()` `onDocChanged`: port the legacy `moved` / `removed` /
  refresh logic onto production's (which additionally calls
  `rememberLastDoc(d.to)` on a move — keep it): a move of the viewed doc
  retargets the SAME doc object (`Object.assign(cached, {path, name})`) after
  `destroyEditor()` and `retargetSecrets(from, to)`, routes, re-renders,
  re-arms `markDirty` if dirty, then reloads the tree and `refreshDoc`s;
  removal of a CLEAN active doc re-renders (empties) the pane; every other
  change goes through the new `refreshDoc(path, notify, ours)` with its
  "protected buffer" predicate (saving, dirty, navigating away, buffer ≠
  baseline, dirty reveal) checked before AND after the fetch, newest-request-
  wins, and a scroll-preserving re-render. `resyncAfterGap` uses it too.
- `wireVisualViewport(onChange)`: production's signature (it calls
  `refreshKeybar`) plus the legacy additions: publish `--visual-bottom`
  (`vv.height + vv.offsetTop`) beside `--kb`, listen to `vv.scroll` and
  `window.resize` as well.
- `dismissTop` / `onPop`: production's, with the Raw layer comments trimmed
  to what is true (Source owns Escape; phone Back spends the Source layer;
  Back holds on `rawExitDiff()` in either mode).
- `secrets.js`: port `bindSecretIds`, `releaseSecretIds`, `retargetSecrets`,
  the `flushingSecrets` set and the string-ordinal branches of
  `flushSecretEdits` / `replaceArmorInDoc` (which call
  `replaceVisualSecret`); `onVaultLocked` saves by `doc.path`. Wording:
  "Source mode (⌘E)" in the mask title. Everything multi-vault production
  added to this file stays.
- `tree.js` `indexTree`: keep the existing doc object
  (`Object.assign(prev || {...}, n)`) so editor callbacks and in-flight saves
  retain their owner; drop the dead `cells` import.

### Docs (coordinator owns; listed so implementers know the words)

New ADR `docs/adr/0037-blocknote-edits-docs-markdown-stays-the-file.md`
supersedes the Preview half of spec 0001 §4, ADR 0021 (the Preview dialect —
the adapter's supported set replaces it), ADR 0023 (folds: no equivalent;
removed), ADR 0036 (Enter → Raw; Enter is typing now), spec 0016's copy
button, spec 0019's Preview half, ADR 0010's committed-bundle half (the
fence-is-untrusted-input half stays, enforced through the diagram block),
and amends ADR 0014 (visual undo is BlockNote's), ADR 0027 (the Edit side is
measured through the island), ADR 0032 (Raw is now the Source surface),
ADR 0034 (the keybar is Source's; Edit has the docked toolbar), AGENTS.md's
"zero runtime deps / no frontend build step" rule. `CONTEXT.md` gains
Edit/Source, loses fold. `docs/architecture.md`, `AGENTS.md`, `docs/style.md`,
`docs/adr/README.md` follow.

## Testing Decisions

Seams: the real server via `tests/helpers.ts`, real Chromium via
`tests/browser.ts`, and direct import for the pure adapter. Prior art: the
legacy branch's tests (`tests/block-editor-e2e.test.ts`,
`tests/editor-refresh-e2e.test.ts`, `tests/mobile-keyboard-e2e.test.ts`,
`tests/markdown-source.test.ts` + `tests/markdown-corpus.ts`,
`tests/editor-assets.test.ts`) — port them, adapting to production's harness
(`newPage` options, `clearBrowserMemory`, multi-vault paths, the
`znotes.last-doc` store) — and production's `tests/e2e.test.ts`,
`tests/mermaid-e2e.test.ts`, `tests/secrets-ui.test.ts`.

- `tests/browser.ts`: add `--disable-features=BackForwardCache` to the launch
  args (cached pages keep SSE sockets and exhaust Chromium's six connections
  on repeated reloads — measured on the unchanged app). `tests/helpers.ts`:
  pass `NOSYSBASHLOGOUT: "1"` to spawned servers (NixOS login-shell noise).
- Gates (`bun run gates`): keep all six files. Gate 5 (`e2e.test.ts`): the
  ⌘E test asserts `data-mode` and the exact source in Source; the container
  parity test must pass with the island mounted (wait for `.bn-editor`).
  Gate 6 (`mermaid-e2e.test.ts`): migrate to the diagram block — a flowchart
  draws with real SVG text, a second diagram type draws, a broken diagram
  shows its error text and keeps the source, an empty fence is an ordinary
  code block, the diagram uses the app font, and the four hardening cases
  (`%%{init}%%`, YAML frontmatter, `click call` / `click href javascript:`,
  `dompurifyConfig`/`themeCSS`) stay inert with no uncaught error. Delete the
  "click-to-edit block on the fence's own line" case.
- Migration rule for every other suite: an assertion about a deleted surface
  (`[data-line]`, click-to-edit, Enter-resume, folds, `.md` DOM, the copy
  button after links, the committed mermaid bundle) is deleted; every
  assertion about bytes on disk, secrets, saves, conflicts, navigation, theme
  tokens, container parity, keyboard ownership and mobile layout is kept and
  re-expressed against Edit (`.bn-editor`, `.bn-block-content`) or Source.
  `fold-e2e.test.ts`, `markdown-e2e.test.ts`, `mermaid.test.ts` are deleted;
  `resume-e2e.test.ts` keeps its root-URL half and loses its Enter half;
  `linebreaks-e2e.test.ts` keeps "a newline is a visual line break and
  round-trips" against Edit; `extlinks-e2e.test.ts` keeps "http(s)/mailto
  render as anchors, `javascript:` stays text" against Edit;
  `codeblock-e2e.test.ts` targets the island's Copy button; `keybar-e2e`,
  `rawedit*`, `mobile-editing-e2e` are Source-only and should need little.
  Never weaken a data-safety assertion to make a test pass; report instead.
- `tests/leak.test.ts` copies `app/markdown.js`'s fence regex verbatim; the
  copies stay (the server contract is unchanged) — fix the comments.
- Full check at the end: `bun run lint:docs`, `bun run gates`, full `bun test`.

## Out of Scope

Replacing the shell UI; BlockNote JSON as storage; collaboration, comments,
AI or export services from BlockNote; changing the HTTP/SSE contract (0002)
or any WebMCP tool name/shape; renaming `raw`/`preview` identifiers; a
Preview-style read-only mode; folds inside BlockNote; per-doc zoom;
iOS WebKit and physical-keyboard validation (report as unverified);
committing, pushing, deploying (the coordinator does these after review).

## Further Notes

Legacy validation on the old base: 166 acceptance tests, 15 editor E2E, 32
adapter tests, full suite 833 pass with 5 timing failures fixed and rerun.
The legacy spec (`/home/pi/projects/z-notes-legacy/docs/specs/done/0007-blocknote-editor.md`)
and ADR (`…/docs/decisions/0009-blocknote-markdown-editor.md`) carry the
reasoning; the prototype at `/home/pi/projects/z-notes-blocknote-prototype`
is reference only. The diagram block's `initializeMermaid` sets
`htmlLabels:false` on flowchart/class/state/er and relies on mermaid's
default `securityLevel:"strict"`; `app/mermaid.js` (being deleted) is the
authority on which keys production locks — read it before writing the
hardening init.

Completed 2026-09-14 on release 0.16.0 (1feeda0), Bun 1.4.0, Chromium 143 on a
Raspberry Pi (Linux arm64). Implementation ran as four parallel Opus 5 slices
(island + adapter, server bundle + deploy notes, editor/app/CSS, shell/secrets/
tree), then a test-port slice, an app fixer and three test-migration slices;
two independent Fable 5.1 reviews plus a narrow re-check found and had fixed:
BOM byte offsets, unsafe link schemes dropped from edited paragraphs, a
paragraph nested under a list item, list runs merging and loose lists going
tight (twice), Escape swallowed inside Edit, a refused edit with no fail-safe
and no exit-guard row, item-level looseness. Clean-code pass applied.

Checks on the final tree: `bun run gates` 180 pass / 0 fail; `bun run
lint:docs` ok; adapter 38 pass; editor E2E 18, refresh 17, mobile keyboard 8,
editor assets 4; the full suite result is in the commit message. Measured and
accepted regressions are listed in ADR 0037 (diagram theme, code highlighting,
the desktop list row, large-doc open time, ciphertext in a block attribute).
Not verified: physical keyboards and iOS WebKit.
