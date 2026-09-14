# 0037 — BlockNote edits docs; the Markdown file stays the source of truth

## Status

Accepted by the user, 2026-09-13 (tested on a prototype and on the local
network), ported onto release 0.16.0 on 2026-09-14. Implements
[spec 0020](../specs/done/0020-blocknote-editor.md).

Supersedes: the rendered-Preview half of spec 0001 §4 and its prohibition on
an AST bridge; [ADR 0021](0021-preview-has-one-tested-markdown-dialect.md)
(the Preview dialect — the source adapter's supported set is the dialect
now); [ADR 0023](0023-preview-sections-fold.md) (folds have no equivalent in
the block editor and are gone); [ADR 0036](0036-esc-and-enter-are-a-round-trip.md)
(Enter is typing in Edit; Esc still leaves Source); spec 0019's Preview half; the committed-bundle half of
[ADR 0010](0010-mermaid-is-a-committed-bundle.md) (the fence-is-untrusted-
input half stands, enforced through the diagram block); and AGENTS.md's
"zero runtime deps beyond age-encryption; no frontend build step" rule.

Amends: [ADR 0014](0014-file-operations-undo-but-they-ask.md) (undo inside
Edit is BlockNote's own; the app timeline keeps Source runs and file
operations); [ADR 0027](0027-a-mode-switch-keeps-the-line-you-were-on.md)
(the Edit side is measured through the island's block ranges);
[ADR 0032](0032-raw-is-a-line-editor.md) (the line editor is the **Source**
surface, unchanged); [ADR 0034](0034-the-soft-keyboard-carries-an-editing-bar.md)
(the keybar is Source's; Edit docks its own list/indent toolbar on the
keyboard); [ADR 0022](0022-asking-before-leaving-edits-is-a-preference.md)
(the guard now covers both surfaces).

## Context

The user wants Notion-style editing — bullets that look like bullets while
typing, one-tap lists and indentation on a phone, a slash menu, drag handles,
tables, inline diagrams — without hand-writing an editor. The hand-written
Preview renderer had grown folds, quotes, line breaks, link buttons and
click-to-edit, each a spec of its own, and the user's verdict was "I'm having
to implement all of these by hand from scratch again."

BlockNote (MPL-2.0) supplies that surface, but its native Markdown conversion
is lossy: frontmatter becomes prose and list/whitespace forms change. A vault
is ordinary Markdown files and stays one; the server never sees plaintext.

## Decision

- **BlockNote is the doc editor ("Edit").** `@blocknote/core`, `react`,
  `mantine`, `diagram-block` 0.54.2, React 19.3, Mantine 9.6 and the MDAST
  libraries are exactly pinned runtime dependencies — the one approved
  editor exception to the dependency rule. No XL or commercial package.
  `@tiptap/core`, `prosemirror-state` and `prosemirror-view` (BlockNote's own
  editor core) are declared at the versions BlockNote resolves, because the
  island registers one ProseMirror widget plugin of its own: the copy button
  after every external link, which the old Preview had (spec 0016).
- **The island is React; the shell is not.** `app/block-editor.tsx` imports
  npm packages and `app/markdown-source.ts` only. Doc state, navigation,
  secrets and the clipboard reach it through callbacks; it never imports a
  shell module. The server bundles it at boot with `Bun.build`, the same
  way it bundles age, and serves it at `/vendor/editor.js` /
  `/vendor/editor.css` (content-addressed behind no-cache aliases). There is
  no separate build command and no CDN; a failed bundle answers 503 for the
  editor paths and nothing else.
- **Source is the line editor.** ⌘E and the statusbar chip switch between
  Edit and Source; Source keeps ADR 0032's editor, the text-run timeline,
  Tab/⇧Tab, the keybar and encrypt-selection. Persisted ids stay `preview`
  and `raw`; the WebMCP enum is unchanged.
- **A source adapter keeps the bytes.** `SourceSession` parses the doc into
  top-level MDAST groups with positions. An untouched doc serialises to its
  exact original string; untouched groups and the separators between them
  keep their bytes; only edited groups pass through `mdast-util-to-markdown`
  with literal punctuation escaped. Moving or deleting a block moves or
  deletes its source; nothing deleted is ever resurrected. Frontmatter,
  nested secrets and unsupported syntax are opaque protected blocks with an
  "Edit source" door; a transaction the adapter cannot serialise (colours,
  alignment, merged cells, nesting a protected block, moving metadata) is
  rejected before it happens rather than silently dropped on save.
- **Secrets stay outside the model.** An ` ```age ` fence is a ciphertext
  block; the existing `secrets.js` DOM is injected into a non-editable node
  view and owns every decrypted byte. Blocks have stable ids, so
  re-encryption follows the right block through reorders of identical
  ciphertext; ciphertext swaps are kept out of the editor's undo history.
  Plaintext never enters editor serialisation, the clipboard HTML, a request,
  the index or the AI context.
- **Fences are still untrusted input.** The island initialises mermaid once
  with the keys production locked before (`securityLevel: strict`, no html
  labels, no directive override of purify/theme CSS); gate 6 asserts it
  against the diagram block.
- **Undo inside Edit is the editor's.** Visual edits are not text runs on
  the app timeline; Source runs and file operations still are, and applying
  one re-renders the open editor.
- **Themes keep their tokens.** Structure and the BlockNote overrides live in
  base.css, mapped from the existing token contract (ADR 0003); Edit
  inherits the pinch ladder through `.doc`'s font size.

## Consequences

- Gone: `app/markdown.js`, `app/mermaid.js`, the committed
  `app/vendor/mermaid.js` and its generator, click-to-edit and its setting's
  UI, Enter-resumes-Raw, preview folds, the Preview
  dialect map. Kept: everything about Source, the shell, vaults, uploads,
  history, WebMCP, zoom, routing, sync, AI, terminal, trash.
- The handwritten adapter is a storage boundary, not editing behaviour;
  supported Markdown is what it can serialise, and anything else is
  protected rather than lost.
- The image carries the editor's node_modules and boot spends about half a
  second bundling (peak RSS ~360 MB during the build, ~85 MB after); the dev
  loop rebuilds the island on server restart.
- Measured regressions accepted with the cutover: a diagram renders with
  mermaid's default theme in both colour schemes (it takes the app font, not
  the app colours); fenced `js`/`ts` code is no longer token-highlighted (the
  default BlockNote code block ships no highlighter); the Bullet / Numbered /
  Checklist / Outdent / Indent row is shown above the doc on the desktop too,
  not only on a phone; a 6 MiB doc takes ~10 s to open in Edit because the
  adapter parses the whole source (Source opens as before); a locked secret's
  ciphertext sits in the block's `data-ciphertext` attribute (never in text or
  the accessibility tree); a group inserted into a CRLF doc is written with LF
  inside itself, while untouched groups and separators keep their CRLF.
- Browser tests cannot prove physical keyboards or iOS WebKit; the user
  validated the phone toolbar on Android.
