# 0023 — Edit is the only doc surface

## Problem Statement

A doc has two surfaces. **Edit** is the BlockNote island (`app/block-editor.tsx` over
`app/markdown-source.ts`, ADR 0037). **Source** is ADR 0032's contenteditable line editor
(`app/rawedit.js`), with its soft-keyboard bar (`app/keybar.js`), statusbar mode chip, Wrap
toggle, ⌘E/⌥Z chords, whole-line clipboard, list continuation, mode anchoring and a long tail
of `state.mode === "raw"` branches across the shell. The user considers Source a legacy view.
It must go entirely, and the code that carried it must go with it.

**The user's primary goal is net code reduction**: fewer lines and fewer files. Consolidate
what remains rather than just deleting branches around it, and keep every other behaviour of
today's app.

Four things work only through Source today, and each gets the smallest possible replacement
(decided with the user):

1. Creating a new secret (`encryptSelection`, secrets.js:980, refuses outside raw).
2. Editing a protected block: frontmatter, or Markdown the adapter cannot import (HTML,
   footnotes, table alignment, hard breaks, nested age fences, …). Its "Edit source" button
   switches to Source.
3. The fallback when the editor bundle or stylesheet fails to load (editor.js:968-983).
4. The recovery advice when an edit cannot be serialised ("…or edit the block in Source").

## Solution

- Delete Source: `app/rawedit.js`, `app/keybar.js`, the mode chip, Wrap, ⌘E, ⌥Z, and every
  raw branch in the shell, the settings, the WebMCP tools, the CSS and the tests.
  `state.mode` stops existing.
- **New secret.** A single path, `newSecret()` in `app/secrets.js`, runs the existing vault
  checks, then asks for the plaintext in the existing confirm dialog (extended with a text
  field), encrypts, and inserts a `secret` block at the cursor. The slash-menu item "Secret",
  the topbar lock button (`#encBtn`) and ⌘⇧E all call it.
- **Protected blocks edit in place.** The block's button reads "Edit". It swaps that block's
  `<pre>` for a textarea holding exactly that block's Markdown, with Done and Cancel. Done
  replaces the block's source range in the doc and reloads the island from the result. The
  edit is one text entry on the app timeline, so ⌘Z undoes it.
- **Editor load failure** shows "The editor could not load." with a Reload button. Nothing in
  the pane is editable.
- **Serialisation failure** toast: "This edit cannot be written as Markdown — <message>. Undo
  it to keep editing."

## User Stories

1. As a user, I want a doc to open in the Notion-like editor only, so I never see a raw-text view.
2. As a user, I want no mode chip, no Wrap chip and no ⌘E/⌥Z, so the statusbar and shortcuts list only what exists.
3. As a user, I want "/secret" (and the lock button, and ⌘⇧E) to ask for the text, encrypt it and insert a secret block where I am, so I can still create secrets.
4. As a user whose vault is disabled, orphaned, not yet created or needing repair, I want the same messages and flows `encryptSelection` gives today, so the new door does not bypass any vault check.
5. As a user, I want the plaintext I typed for a new secret gone from the page once the dialog closes (OK, Cancel, Esc, veil click, Back), and never present in the file, `doc.markdown`, the editor model, a request or the clipboard.
6. As a user, I want to cancel the new-secret dialog and have nothing change.
7. As a user, I want to edit frontmatter or any protected block in place, see only that block's Markdown, and press Done (or ⌘Enter) to apply it or Cancel (or Esc) to leave the file untouched.
8. As a user, I want every byte outside the edited block unchanged by a protected-block edit.
9. As a user, I want ⌘Z after a protected-block edit to restore the previous bytes.
10. As a user, I want a protected-block edit that turns the block into ordinary Markdown to come back as ordinary editable blocks.
11. As a user, I want a protected block that contains a secret I have revealed and changed to lose neither the change nor the secrecy when I edit the block's source. Plaintext is never shown in or written from the textarea.
12. As a user, I want a clear error and a Reload button when the editor cannot load, not a blank or half-working pane.
13. As a user, I want an edit that cannot be written as Markdown to tell me to undo it, as it does today minus the Source advice.
14. As a user, I want a newly created doc to open in Edit with the caret in it, ready to type, as it opened ready to type in Source before.
15. As a user on a phone, I want Esc and Back to behave exactly as today for every layer that still exists (drawer, chat, dialogs, settings), and I want Edit's own phone toolbar unchanged.
16. As an agent (WebMCP), I want `set_mode` and `indent_lines` gone, and `open_doc`/`get_app_state` without `mode`, so the catalogue lists only doors that exist. Every other tool keeps working, including undo/redo of `write_doc`.
17. As a user, I want the exit guard (confirm-before-leaving-unsaved-edits) to keep working for Edit.
18. As a user, I want the tab-width setting to keep applying to code blocks in Edit, described as that.

## Implementation Decisions

### Budget and consolidation rule

- Measure before and after with `git ls-files app server tests | xargs wc -l | tail -1` and the
  tracked file count. The change must be a large net deletion. New code is limited to the
  three replacements above, and each should be tens of lines, not hundreds.
- Inside every file you touch, collapse what the removal leaves trivial:
  - a wrapper whose whole body became one call (`syncRaw()` → `flushTextRun()` at its callers, or deleted if unnecessary);
  - a helper with one caller left;
  - a parameter no caller passes any more (`opts.caret`);
  - a comment that narrates Source.
- Rename survivors whose name says Raw: `guardRawExit` → `guardExit`, `rawExitDiff` → `exitDiff`.
- Do not refactor modules the removal does not touch.

### Delete outright

- `app/rawedit.js`, `app/keybar.js`.
- `tests/rawedit.test.ts`, `tests/rawedit-e2e.test.ts`, `tests/keybar-e2e.test.ts`,
  `tests/mobile-editing-e2e.test.ts`. Of the last, 8 of 11 cases are Source. Move the other 3
  into the neighbouring mobile suite only if nothing there already covers them. Prefer
  deleting a duplicate over moving it.

### app/editor.js (the bulk)

- **Delete:**
  - the SOURCE MODE section;
  - `revealRawCaret`, `keepRawCaretVisible`;
  - the word-wrap functions (`znotes.wrap`);
  - list/quote continuation;
  - `indentSelection`, `editRawTab`, `moveListGutterCaret`;
  - the ADR 0013 whole-line clipboard;
  - `renderRaw`, `syncRaw`, `syncRawFromModel`, `lineOffset`, `focusRaw`, `scrollRawTo`;
  - `visualAnchor`/`rawAnchor`, `setMode`, `syncModeUI`, `canStepHistory`;
  - the raw branch of `applyTextHistory`;
  - the `raw-mode` class.
- **Keep:**
  - `autoGrow`: the composer and `.secret-edit` use it. Delete only its `#rawArea` callers.
  - The exit guard, reading `doc.markdown` only.
  - The text-run API (`markTextBaseline`, `noteTextEdit`, `flushTextRun`, `applyTextHistory`): agent writes (`replaceDocText`) and protected-block edits still create text entries.
  - `host.style.tabSize`.
- **`renderDoc`** always calls `renderVisual`.
- **`renderVisual` options:**
  - Remove `onSource`.
  - Add `onNewSecret: () => newSecret()`.
  - Add `onSourceEdit(markdown)`. It does what `replaceDocText` does for the active doc, without the save or the rev check: set `doc.markdown`, `noteTextEdit(path)` + `flushTextRun()`, `markDirty()`, `updateMeta()`, re-render keeping the anchor (`visual.anchorLine()` before, `pendingReveal` after).
  - Before replacing, flush pending secret edits for the doc, exactly as the save path does (`flushSecretEdits(doc)`, editor.js ~1680), so a revealed-and-edited secret inside the block is re-encrypted rather than lost (story 11).
  - Share the body with `replaceDocText` rather than duplicating it.
- **`onError` toast** text is as in the Solution.
- **Load failure (the catch in `renderVisual`):** `destroyEditor(); surface.remove();` then
  append `<div class="note bad">The editor could not load. <button class="btn" data-act="reload">Reload</button></div>`.
  The `reload` action is `location.reload()`, registered in app.js's action table. No editable
  surface is rendered.
- **Add `insertVisualSecret(armor)`**, beside `replaceVisualSecret`, returning
  `visual?.insertSecret(armor) ?? false`.
- **New docs open focused.** `mintEntry` (tree.js:1063-1066) drops
  `setMode("raw", { silent: true, caret: 0 })`. Instead, `openDoc(path, { focus: true })` (or
  an equivalent option on the existing path) sets a `pendingFocus` that `renderVisual`
  honours after mount, next to `pendingReveal`: call `visual.focus()`. Pick whichever is
  fewer lines.

### app/block-editor.tsx

- **Interface changes:**

  ```ts
  export interface EditorOptions {
    markdown: string;
    onChange(markdown: string): void;
    /** A protected block's Markdown was replaced in place; the argument is the whole doc. */
    onSourceEdit(markdown: string): void;
    /** The user asked for a new secret (slash menu). The app encrypts and calls insertSecret. */
    onNewSecret(): void;
    renderSecret(secret: SecretIdentity): HTMLElement;
    copyText?(text: string): void | Promise<void>;
    resolveWikiLink?(target: string): string | undefined;
    onWikiLink?(target: string): void;
    onError?(message: string): void;
  }
  // EditorController gains:
  /** Insert a ```age block holding `ciphertext` after the cursor's block (replacing it if it is an empty paragraph). */
  insertSecret(ciphertext: string): boolean;
  ```

- **`insertSecret`** inserts `{ type: 'secret', props: { ciphertext } }` via
  `editor.insertBlocks`/`replaceBlocks` at `editor.getTextCursorPosition().block`. A new secret
  block has no `secretSource`, so `exportNodes` prints it as a plain `` ```age `` fence.
  `onBeforeChange` already allows a new id.
- **Slash menu:** add one item, `{ title: 'Secret', aliases: ['secret', 'encrypt', 'age'], group: 'Other', onItemClick: () => options.onNewSecret() }`,
  to the `getItems` list. Match BlockNote's `DefaultReactSuggestionItem` shape and give it an
  icon only if the type requires one.
- **In-place protected edit.** In the `source` block render, the button becomes "Edit". Local
  React state `editing` swaps the parts for:
  - `<textarea className="z-source-edit" spellCheck={false} autoComplete="off" data-gramm="false">`,
    prefilled with `block.props.source`;
  - **Done** and **Cancel** buttons. Esc = Cancel, ⌘/Ctrl+Enter = Done.
    `stopPropagation` keeps these keys out of ProseMirror and the shell.

  Done:
  1. `const range = session.range(block.id, blocks())`.
  2. `next = markdown.slice(0, range.start) + text + markdown.slice(range.end)`.
  3. If `next !== markdown`, call `options.onSourceEdit(next)`, which re-renders the island.
  4. Otherwise just leave editing.

  The textarea is inside the `contentEditable={false}` node view, so its keystrokes never
  become editor transactions. `autoGrow`-like sizing is CSS: `field-sizing: content` with a
  `min-height`.
- **Remove `onSource`, `lineFor`, and the `range` usage `lineFor` needed**, if nothing else
  uses them.

### app/markdown-source.ts

Behaviour is unchanged. Only the user-facing error strings that say "Source" are reworded to
say the thing cannot be edited visually. Examples:
- `'Hard breaks require Source'` → `'Hard breaks are edited as protected Markdown'`;
- `default: throw new Error(\`${b.type} blocks cannot be written as Markdown\`)`;
- `'This block must remain last'`.

Keep them short. `tests/markdown-source.test.ts` asserts on `'Source'` at :108, :149 and :236;
update those assertions to the new substrings.

### app/secrets.js

- **Replace `encryptSelection` with `newSecret()`.**
  - Keep its vault-state preamble verbatim: disabled, none → `askCreate`, orphan, repair →
    `ensureUnlocked`, and `recipientDrifted`.
  - Then: require an active doc and a mounted editor.
  - Call `confirmDialog({ title: "New secret", path: doc.path, field: "Text to encrypt", ok: "Encrypt", danger: false, note: "", onOk: async (plain) => … })`.
  - On OK with non-blank text: `secretsCall("encrypt", { plaintext })`, then
    `insertVisualSecret(indentArmor(r.armor, ""))`, `markDirty()`, `updateMeta()` if not
    already fired by `onChange`, and the same verified/unverified toast as today.
- **Delete:** `syncModeUI`/`syncRawFromModel` imports and calls, the `repaintSecretsUI`
  preview guard (now always true), and the `#rawArea` `autoGrow`.

### app/dialogs.js + app/index.html (confirm dialog)

- `confirmDialog(opts)` gains `opts.field` (a placeholder string). When set, a
  `<textarea id="cfField" class="…" spellcheck="false" autocomplete="off" data-gramm="false">`
  in `#cfModal .modal-body` is shown, emptied and focused. `onOk` receives its value.
- `closeConfirm` and `confirmOk` **always** clear `#cfField.value` and hide it: story 5.
  `Enter` in the field is a newline; ⌘/Ctrl+Enter confirms, if the existing default-button
  wiring does not already do this.
- This is the only new markup.

### app/app.js, shell.js, tree.js, settings.js, chat.js, webmcp.js, state.js, ui.js, history.js

- **app.js:**
  - Remove the `toggle-mode` and `toggle-wrap` actions.
  - `encrypt-selection` → `new-secret` (calls `newSecret`).
  - Remove the ⌘E and ⌥Z handlers and `"e"` from `appChord`, so ⌘E becomes BlockNote's
    inline-code shortcut. Remove `KeyZ` from the alt-chord list.
  - ⌘⇧E calls `newSecret`.
  - Remove `initWordWrap`, `initKeybar`, `refreshKeybar`, `syncModeUI`, `keepRawCaretVisible`
    and the `#rawArea` checks in the ⌘Z `typing()` test and the resize `autoGrow`.
  - Add the `reload` action.
- **shell.js:**
  - Remove Esc-leaves-Source in `dismissTop`, the raw clause in `layered()`, phone
    Back-leaves-Source, the `kb-up` class (only the keybar read it), the `syncRaw` import and
    its `flushBuffer` call (use `flushTextRun` if a run can be open).
  - Keep `--kb` and `--visual-bottom`: Edit's phone toolbar docks on them.
- **tree.js:** as above; `guardRawExit` → `guardExit`.
- **settings.js:**
  - Remove the `#rawArea` autoGrow calls and `syncRaw`.
  - The tabSize live-apply keeps its `#doc` half.
  - Label: "Tab width in code blocks".
- **chat.js:** `syncRaw` → `flushTextRun`, or removed if `applyProposal` needs nothing.
- **webmcp.js:**
  - Remove `set_mode` and `indent_lines`, the `mode` property and `bad-mode` error of
    `open_doc`, and `mode` in `get_app_state`.
  - Replace `syncRaw()` in `docText` with `flushTextRun()`.
  - Remove the unreachable line after `get_app_state`'s return (webmcp.js:262).
- **state.js:** remove `mode` and `wordWrap`.
- **ui.js:** un-export `trimUrlTail` (still used internally).
- **history.js:** header comment only.

### CSS, markup, server

- **app/index.html:**
  - Remove `#stMode`, `#stWrap`, `.sb-mode-div`, `#keybar`, and the shortcut-overlay rows for
    ⌘E, ⌥Z, the Source clipboard chords and Tab-in-Source. The footer no longer mentions Source.
  - Keep `#encBtn`, visible whenever a doc is open and secrets are not disabled. Its title is
    "New secret (⌘⇧E)" and it calls `new-secret`.
  - The settings copy at :417 and :432 is reworded or removed.
- **app/themes/base.css:**
  - Remove `.raw*`, `::highlight(raw-link)`, the `--font-raw` token (no theme sets it; check
    `tests/themes-tokens.test.ts`), the `#stMode`/`#stWrap`/`.sb-mode-div` rules including the
    route-settings hides and mobile rules, §8a keybar, and the `.raw-mode` comment.
  - Style `.z-source-edit` minimally, reusing existing tokens.
  - Keep `--d-raw-fs`/`--d-raw-lh`; the terminal scrollback uses them.
- **server/index.ts:**
  - The 503 message at :553 becomes "The editor bundle is unavailable; reload once the server
    has rebuilt it."
  - The comments at :499 and :624 lose their Source wording.
  - `tests/editor-assets.test.ts:204` asserts the new text.
- **server/settings.ts:1306:** the `editor.tabSize` description becomes "Tab width in code
  blocks". The key and its range are unchanged.

### Docs (same change)

- **New `docs/adr/0039-edit-is-the-only-doc-surface.md`**, one page:
  - **Supersedes:** 0013, 0027, 0032, 0034, 0036.
  - **Amends:**
    - 0037: its Source bullet, the "Edit source" door, the bundle fallback; the persisted
      `preview`/`raw` ids are gone;
    - 0014: the app timeline holds file operations, agent writes and protected-block edits;
    - 0022: the guard is Edit's;
    - 0012: no mode chip;
    - 0008: Back has no Source layer;
    - 0031: `set_mode`/`indent_lines` removed;
    - 0033: the "Raw and Preview at one size" consequence is moot.
  - Record the three replacements and "net deletion" as the reason.
- Add a `Superseded by [0039](…)` line under Status in 0013, 0027, 0032, 0034 and 0036. Add an
  "Amended by 0039" line to the amended ones. Do not rewrite their bodies; ADRs are
  append-only.
- **`docs/adr/README.md`:** append one sentence for 0039. Earlier sentences stay.
- **`docs/architecture.md`:** remove rawedit/keybar and the Source guard rows; update the
  `EditorOptions` list.
- **`CONTEXT.md`:** remove the Source term. "Edit" is the doc editor; list "Source/Raw view" as
  retired terms. Describe the protected block's in-place edit.
- **`README.md:15`:** "Editor + preview" → the Edit editor.
- `docs/specs/done/*` are history and stay untouched.
- On completion, move this spec to `done/`.

## Testing Decisions

- **Seams:** the real-browser harness `tests/browser.ts` plus the real server
  (`tests/helpers.ts`), and the pure module `tests/markdown-source.test.ts`. No new seam and no
  new test file.
- **Remove, don't port**, every case whose subject is Source behaviour:
  - the mode chip, ⌘E parity and anchoring;
  - Wrap, Tab/list continuation, whole-line clipboard;
  - the keybar;
  - the Raw 16px floor;
  - text-run typing in Raw;
  - "Esc leaves Source", "Back leaves Source";
  - `set_mode raw`.
- **Where Source was only the vehicle** (lifecycle, exit guard, secrets reveal, SSE refresh,
  AI proposal, routing, theming, zoom, codeblock, fileops, integration, resume,
  settings-page), rewrite the step to type through the Edit island (`.bn-editor` +
  `page.keyboard`), or to write via the API, and keep the assertion about the real subject.
- If a case then duplicates another, delete it.
- Remove the `docMode`/`ensureMode` helpers from `tests/browser.ts` and any local
  `enterRaw`/`toRaw`/`ensureRaw`/`source()` helpers.
- **New cases, minimal, in existing files:**
  1. `tests/secrets-ui.test.ts` (imitate its vault-setup cases):
     - "/secret" in Edit opens the dialog;
     - typing text and pressing Encrypt leaves exactly one `` ```age `` fence in the saved file;
     - the plaintext appears nowhere in the file, in `doc.markdown`, or in `document.body.innerText` after the dialog closes;
     - `#cfField.value === ""` after both OK and Cancel;
     - Cancel changes no byte.
  2. `tests/block-editor-e2e.test.ts` (imitate its existing protected-block/metadata cases):
     - frontmatter "Edit" → change a value → Done → saved bytes equal the original with only
       that range replaced;
     - ⌘Z restores the original bytes;
     - Cancel/Esc leaves them untouched.
  3. The existing bundle-failure case in `block-editor-e2e`/`editor-refresh-e2e`: the note says
     "could not load", a Reload button exists, and `#doc [contenteditable="true"]` is absent.
  4. `tests/webmcp-e2e.test.ts`: the expected tool list without `set_mode`/`indent_lines`.
- A good test here asserts bytes on disk or DOM facts, never pixels by eye.
- **Required checks:**
  - `bun run gates`: `tests/e2e.test.ts` is a gate; its Source cases are removed or rewritten
    per the rules above.
  - `bun run lint:docs`.
  - The full `bun test`.

## Out of Scope

- Any new editing feature in Edit beyond the three replacements. Specifically:
  - encrypting a selection of existing blocks;
  - a whole-doc Markdown view, read-only or otherwise;
  - word wrap;
  - whole-line clipboard;
  - a Tab-width UI.
- Changing `markdown-source.ts` behaviour: what imports as protected, byte preservation,
  separators.
- Changing the HTTP API, SSE, the AI relay, the terminal, vaults, sync or trash.
- Renaming the `--d-raw-fs`/`--d-raw-lh` tokens (theme contract).
- Refactoring modules the removal does not touch.
- Rewriting historical ADR bodies or specs in `done/`.
- Commit, push, deploy, release.

## Further Notes

- Old browsers keep a stray `znotes.wrap` localStorage key; it is harmless and not migrated.
- ⌘E now reaches BlockNote (inline code). This is intended.
- Large docs were never routed to Source, and AI proposal accept/revert is server-side; neither
  loses anything.
- Record the before/after line and file counts in the ADR's Consequences.
