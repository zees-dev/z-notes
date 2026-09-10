# 0014 — Raw is a line editor: headings keep their size, links keep their colour

## Problem Statement

Switching from Preview to Raw changes the size of every line: Preview body
copy is the theme's `--d-font` (13.4px comfy) in the document font, an `h1` is
`--h1-size` (1.95em); Raw is one `<textarea>` at `--d-raw-fs` (12.1px), mono,
and on a phone 16px (the §12 iOS zoom floor). A heading that was 26px becomes
12px or 16px, a paragraph moves by a pixel and a family, and the document
visibly lurches on every click-to-edit and every ⌘E. ADR 0027 keeps the
*line* under the reader, but it cannot keep the *size*.

Links are the same story one level down: Preview colours `[text](url)`,
`<url>`, bare URLs and `[[wikilinks]]`; Raw shows them as plain text.

A `<textarea>` has exactly one font size. Per-line typography — a heading
line at the heading size, a body line at the body size — is not expressible
in it at all, and neither is colouring a range. The textarea has to go.

What makes that affordable now: the app already owns ⌘Z in Raw (ADR 0014 —
the timeline records `{before, after}` text runs and puts the buffer back with
`ta.value = target`), so the textarea's native undo stack, the one thing a
textarea gives that a contenteditable does not, is no longer load-bearing.

## Solution

Replace the Raw `<textarea>` with a **line editor**: one
`contenteditable` root, one block element per source line, styled by what
the line is, with links coloured through the CSS Custom Highlight API so no
inline DOM ever changes under the caret. It keeps the textarea's *surface* —
`value`, `selectionStart`, `selectionEnd`, `setSelectionRange`, `focus`,
`placeholder`, `wrap`, the `input` / `keydown` / `paste` / `copy` / `cut` /
`select` events — so `editor.js`'s editing logic (Tab, list continuation,
whole-line clipboard, secrets' ⌘⇧E, the mode-switch anchoring) keeps calling
what it calls today.

Typography rule: **a Raw line is the size and leading of the Preview block it
would render as.** Body lines inherit the document size (`.doc`, so spec
0013's zoom multiplies both modes identically); `#`, `##`, `###` lines take
`--h1-size`/`--h2-size`/`--h3-size` with the same weights, tracking and
line-heights `.md h1/h2/h3` use; the family stays the theme's mono
(`--font-raw`, defaulting to `var(--mono)`, so a theme may opt into the
document font). Lines inside a fenced code block are never headings. The
§12 iOS floor no longer lists `.raw` — the viewport meta's `maximum-scale=1`
(spec 0013) is what stops Safari's focus zoom now, and a 16px Raw against a
13.4px Preview was the biggest size jump of all.

Link rule: **every spelling Preview turns into an anchor or a pill is
highlighted in Raw** — `[[name]]`, `[text](http(s)/mailto url)`, `<http(s)
url>`, bare `http(s)://…` (trailing punctuation trimmed by the same rule) —
never inside an inline code span or a fenced block, in the accent colour with
an underline. The highlight is `::highlight(raw-link)`; a browser without
`CSS.highlights` simply shows plain text.

## User Stories

1. As a writer, I want a heading to be the same size in Raw as in Preview, so
   that clicking a heading to edit it does not lurch.
2. As a writer, I want body text to be the same size and leading in both
   modes, so that ⌘E round-trips without the page moving.
3. As a writer, I want `# ` typed at the start of a line to grow that line as I
   type, and deleting the `#` to shrink it back, so that the source pane tells
   me what I am writing.
4. As a writer, I want a `# comment` inside a code fence to stay body-sized.
5. As a writer, I want links coloured in Raw the way they are in Preview, so
   that I can see them while editing — and a URL inside backticks to stay
   plain, as Preview keeps it plain.
6. As a phone user, I want typing with the soft keyboard — autocorrect,
   predictive text, dictation, Enter, Backspace across lines — to edit the
   note exactly as before, so that the new editor is invisible to my thumbs.
7. As a user, I want Tab / ⇧Tab, Enter continuing a list, ⌘X/⌘C/⌘V of a whole
   line (ADR 0013), ⌘Z/⌘⇧Z (ADR 0014), ⌘⇧E encrypt-selection, click-to-edit
   landing on the clicked line and ⌘E keeping my place (ADR 0027), the caret
   staying above the keyboard, word-wrap toggle (⌥Z), and the empty-note
   placeholder to all behave exactly as they do today.
8. As a user pasting from a web page, I want plain text only — never HTML —
   so that the file stays markdown.
9. As a user, I want a save to write exactly the bytes I see (newlines,
   trailing newline, tabs, multiple spaces), so that Raw is still the file.
10. As a user of an older Firefox, I want the editor to still edit (no
    `plaintext-only`, no highlights), so that the feature degrades, not breaks.
11. As an agent, I want `write_doc` / `edit_doc` / `read_doc` and the
    catalogue unchanged, so that the tool surface does not move.

## Implementation Decisions

### New module `app/rawedit.js`

A feature module importing only `./ui.js` (for `$`, `el`, `trimUrlTail`) and
nothing that imports it back. Export:

```js
/** Build the Raw surface. Returns the root element, augmented with a
    textarea-shaped surface so editor.js keeps its vocabulary. */
export function createRawEditor() → HTMLDivElement
/** Pure: [{start, end}] link ranges over `text` (offsets into text). */
export function linkRanges(text) → Array<{start:number,end:number}>
/** Pure: per-line kinds — "h1"|"h2"|"h3"|"code"|"" — mirroring markdown.js RE_HEAD / RE_FENCE. */
export function classifyLines(text) → string[]
```

Root: `<div id="rawArea" class="raw" contenteditable="plaintext-only" role="textbox" aria-multiline="true">`.
After setting `plaintext-only`, if `!root.isContentEditable` (an old
Firefox rejects the value), set `contenteditable="true"` — the editor
intercepts input itself, so plain text is guaranteed either way. Carry the
same six attributes `renderRaw` sets today (spellcheck, autocomplete,
autocorrect, autocapitalize, data-gramm, data-enable-grammarly) — `renderRaw`
keeps setting them; they work on a contenteditable.

DOM shape — **one `<div class="ln">` per source line**, containing exactly one
text node, or a single `<br>` when the line is empty. `value.split("\n")`
gives the lines; a trailing newline therefore ends in an empty last line, and
`value` serialises as `lines.join("\n")` — byte-exact. Line classes are the
`classifyLines` kinds: `ln h1`, `ln h2`, `ln h3`, `ln code`, `ln`.

Surface (define with `Object.defineProperties` on the instance, or a small
class whose prototype is the element's — instance properties are fine):

- `value` get/set. Set rebuilds every line, keeps `#scroll`'s scrollTop,
  collapses the selection to the end (textarea semantics; callers set it
  after), re-classifies, re-highlights, toggles `is-empty`.
- `selectionStart`, `selectionEnd` get/set; `selectionDirection` get;
  `setSelectionRange(a, b, dir?)`. Getters map the live `getSelection()` to
  offsets when its anchor and focus are inside the root; otherwise return the
  last selection seen inside the root (cache it on `selectionchange`) — a
  textarea remembers its selection while unfocused and `secrets.js` /
  `applyTextHistory` rely on that. Setters build a `Range` from offsets and
  `setBaseAndExtent`; clamp to `[0, value.length]`.
- `replaceRange(start, end, text)` — the one write primitive: model edit,
  re-render only the lines touched (the line containing `start` through the
  line containing `end`, replaced by the new lines; every other `.ln` node is
  left alone so the browser's caret, IME and scroll anchoring stay put),
  selection placed at `start + text.length` (collapsed), re-classify (cheap:
  fence state can flip below the edit — reclassify all lines, but only touch a
  `className` that changed), re-highlight, then dispatch
  `new InputEvent("input", { bubbles: true, inputType, data })` with a private
  marker (`ev.rawOwn = true`, or a module-level flag) so the internal listener
  skips reconcile.
- `boxAt(offset)` → `{ top, bottom }` in viewport coordinates: a collapsed
  `Range` at the offset's (textNode, col); use `getClientRects()[0]`; if empty
  (end of a soft-wrapped row, or an empty line) fall back to a one-character
  range just before the offset, then to the `.ln` element's rect. This replaces
  `rawBoxAt`'s mirror (ADR 0027's "measured, never multiplied" now measures
  the real DOM).
- `placeholder` get/set → `data-placeholder` attribute; CSS draws it while
  the root carries `is-empty`.
- `wrap` get/set (`"soft"` | `"off"`) → toggles the `no-wrap` class (the
  existing `applyWordWrap` sets both `ta.wrap` and the class; keep both
  working).
- `focus(opts)` is the element's own.

Input handling, inside `createRawEditor`:

- `beforeinput` — when `e.isComposing` or `inputType` is
  `insertCompositionText` / `deleteCompositionText`, return (the browser owns
  composition). Otherwise `preventDefault()` and perform the edit through
  `replaceRange`:
  - `insertText` (data), `insertParagraph` / `insertLineBreak` (`"\n"`),
    `insertFromPaste` / `insertFromDrop` (`dataTransfer.getData("text/plain")`),
    `insertReplacementText` (data or the dataTransfer's text/plain),
    `insertTranspose` (data) — inserted over the current selection, or over
    `getTargetRanges()[0]` mapped to offsets when the browser supplies one
    (drop lands where the pointer is, not at the caret).
  - `deleteContentBackward` / `deleteContentForward` /
    `deleteWordBackward` / `deleteWordForward` / `deleteSoftLineBackward` /
    `deleteSoftLineForward` / `deleteHardLineBackward` /
    `deleteHardLineForward` / `deleteByCut` / `deleteByDrag` /
    `deleteContent` — delete `getTargetRanges()[0]` mapped to offsets; if the
    browser supplies none and the selection is collapsed, delete one code
    point backward/forward (surrogate pairs whole).
  - `historyUndo` / `historyRedo` — `preventDefault()`; call the injected
    `onHistory(redo)` if the host wired one (see editor.js below) so an iOS
    keyboard's undo key and shake-to-undo reach the app timeline.
  - `format*` and anything else — `preventDefault()`, ignore.
- `input` (native, trusted, not ours) — the composition path and any edit a
  browser made without a cancelable `beforeinput`: **reconcile from the DOM**.
  Walk the root's children; a `.ln` contributes its text (a lone `<br>` is
  `""`); anything else the browser inserted (a bare text node, a nested div,
  a `<br>` inside text) contributes its `textContent` split on `"\n"`. The
  join is the new `value`. If the walk found anything non-canonical and
  `!e.isComposing`, capture the selection as offsets first, re-render the
  affected lines from the model, and restore the selection. Then re-classify
  and re-highlight. During composition only the model, classes and highlights
  move — never nodes. On `compositionend`, run the same reconcile with
  normalisation allowed.
- `copy` / `cut` with a non-collapsed selection inside the root —
  `clipboardData.setData("text/plain", value.slice(a, b))`, `preventDefault()`;
  for `cut`, also `replaceRange(a, b, "")`. (This is exact across line
  elements and trailing empty lines; the browser's own serialisation is not.)
  Do NOT stop propagation — `renderRaw`'s `copy`/`cut` listeners that reset
  `lineClip` must still run.
- `selectionchange` on `document` — when the selection is inside the root,
  cache it and dispatch `new Event("select", { bubbles: true })` on the root
  (a textarea fires `select`; `renderRaw` listens for it).
- Highlights — `if (window.Highlight && CSS.highlights)`: after every model
  change, build `Range`s for `linkRanges(value)` and
  `CSS.highlights.set("raw-link", new Highlight(...ranges))` (one Highlight
  for the editor; replace, do not accumulate; delete it when the editor is
  removed — `renderDoc` rebuilds `#doc`, so clear on `value` set and on a
  `disconnect()` the host calls, or simply re-set on every render since the
  name is fixed). Coalesce into one `requestAnimationFrame` per burst of
  edits.
- `linkRanges(text)` — the same order and exclusions as `ui.js inline()`:
  skip inline code spans (`` `…` `` on one line) and fenced lines
  (`classifyLines` says `code`); then, non-overlapping and left to right:
  `[[name]]` (whole spelling); `[text](url)` with `url` matching
  `^(https?:\/\/|mailto:)` and not preceded by `!` (whole spelling);
  `<https?://…>` (whole spelling); bare `https?://[^\s<]+` trimmed by
  `trimUrlTail` — export that function from `ui.js` (it is private today;
  on unescaped text its entity branch simply never matches). Reuse the regex
  sources from `inline()` where they are not entangled with the emitted-HTML
  alternation; do not copy `inline()`'s HTML-aware passes.
- `classifyLines(text)` — iterate lines; `RE_FENCE = /^\s*```/` toggles a
  fence state (a line that toggles it is `code` too); outside a fence
  `RE_HEAD = /^(#{1,3})\s+(.+)$/` gives `h1`..`h3` by the hash count;
  everything else `""`. (Preview renders only `#`–`###` as headings —
  `####` is a paragraph there and stays body-sized here.) Import nothing from
  markdown.js; restate the two regexes with a comment naming their source.

### editor.js

- `renderRaw`: `const ta = createRawEditor();` in place of
  `el("textarea", "raw")`; everything else in that function stays — the
  attribute sets, `ta.value = doc.markdown`, the `aria-label`, the
  placeholder, `tabSize`, the listeners. Wire history:
  `ta.onHistory = (redo) => { flushTextRun(); if (pendingHistory(redo)) stepHistory(redo); }`
  (import `pendingHistory`, `stepHistory` from `./history.js` — a leaf).
- `applyRawEdit(ta, start, end, text)` → `ta.replaceRange(start, end, text)`.
  Delete the `execCommand` / `setRangeText` body and its comment; replace the
  comment with why the native stack no longer matters (ADR 0014 owns ⌘Z) and
  that the adapter's `input` event is what keeps `renderRaw`'s listener
  running. `emitRawInput` is no longer needed if nothing else calls it.
- `autoGrow(ta)`: first line `if (!(ta instanceof HTMLTextAreaElement)) return;`
  — a block grows by itself; the composer and `.secret-edit` textareas keep
  using it.
- `rawBoxAt(ta, offset)` → `ta.boxAt(offset)`; delete the mirror. Update the
  comment (and ADR 0027's "Position is measured" bullet gets a one-line
  amendment in the new ADR: measured on the real DOM now).
- `applyWordWrap`, `syncRawFromModel`, `applyTextHistory`, `focusRaw`,
  `scrollRawTo`, `rawAnchor`, `revealRawCaret`, `editRawTab`,
  `continueMarkdownLine`, `editRawLineClipboard`, `pasteRawLine`,
  `moveListGutterCaret`: unchanged in logic; verify each only uses the
  surface above. `pasteRawLine` keeps `preventDefault()`ing the `paste`
  event for the line case — a prevented `paste` never reaches `beforeinput`.
- `previewClickToEdit` / `paneClickToPreview`: the `closest("… textarea …")`
  lists gain nothing — `.raw` is already excluded by `t.closest(".raw")`.

### Everything else that touched the textarea

- `secrets.js:886–904` (⌘⇧E): reads `selectionStart/End`, `value`, writes
  `value` and `selectionStart = selectionEnd = …`, calls `autoGrow`. Works
  through the surface; leave it, but confirm.
- `settings.js:70, 1116, 1471`, `app.js:772`, `shell.js:661`: `autoGrow` calls
  and focus checks — all no-ops or unchanged through the surface.
- `app.js typing()` already accepts `isContentEditable`; the ⌘Z chord already
  keys on `activeElement.id === "rawArea"`.
- `webmcp.js`: nothing reads the element directly — verify with a grep.

### CSS (app/themes/base.css §7 EDITOR — the `.raw` block)

```css
.raw {
  display: block; width: 100%; min-height: 0; position: relative;
  border: 0; border-radius: 0; background: transparent; box-shadow: none;
  padding: 0; margin: 0; outline: none; overflow: visible;
  font-family: var(--font-raw, var(--mono)); font-size: inherit; line-height: var(--d-lh);
  color: var(--text-2); tab-size: 2; caret-color: var(--accent);
  white-space: pre-wrap; overflow-wrap: break-word; -webkit-user-modify: read-write-plaintext-only;
}
.raw .ln { min-height: 1lh; }            /* an empty line keeps its row (the <br> does this too; belt and braces) */
.raw .ln.h1 { font-size: var(--h1-size); line-height: 1.2;  font-weight: var(--h1-weight); letter-spacing: var(--h1-tracking); color: var(--text); font-family: var(--font-heading-raw, var(--font-raw, var(--mono))); }
.raw .ln.h2 { font-size: var(--h2-size); line-height: 1.32; font-weight: var(--h2-weight); letter-spacing: var(--h2-tracking); color: var(--text); … }
.raw .ln.h3 { font-size: var(--h3-size); line-height: 1.4;  font-weight: var(--h3-weight); letter-spacing: var(--h3-tracking); color: var(--text); … }
.raw.no-wrap { white-space: pre; overflow-x: auto; }
.raw.is-empty::before { content: attr(data-placeholder); position: absolute; left: 0; top: 0; color: var(--muted-2); pointer-events: none; }
.raw:focus, .raw:focus-visible { background: transparent; border: 0; box-shadow: none; outline: none; }
::highlight(raw-link) { color: var(--accent); text-decoration: underline; text-decoration-color: var(--accent); }
```

`--font-raw` is declared in base's `:root` token block (§1) as
`var(--mono)` with a one-line comment; themes need not restate it
(`tests/themes-tokens.test.ts` checks density floors and dark aliases, not
this). `--d-raw-fs` / `--d-raw-lh` become unused in base — remove their
declarations from base.css AND the three theme sheets, and their mention in
the §12 comment; grep for any other reader first.

§12 (the iOS zoom floor): remove `.raw` from the selector list and add to the
comment that the Raw surface is a contenteditable at the document size, kept
out of Safari's focus zoom by the viewport meta (spec 0013) rather than by a
16px floor — the floor was the largest Preview→Raw size jump on a phone.

Container parity (`tests/e2e.test.ts` "⌘E and container parity",
`theming-e2e` "Preview/Raw parity") measures `#doc`'s box, not the editor's;
`.raw` contributes no margin, border or padding, so it holds.

### Docs

- New ADR `docs/adr/0032-raw-is-a-line-editor.md` (check the next free
  number): the decision, why the textarea could not do it, why the app-owned
  timeline (ADR 0014) is what made native undo dispensable, the
  textarea-shaped surface as the seam, Highlight API for links (no DOM under
  the caret), the typography rule, the §12 change. Mark it as amending ADR
  0013 (the editing command is the adapter's, not `execCommand`) and ADR 0027
  (measured on the real DOM).
- `docs/architecture.md` frontend section: add `rawedit` to the feature list
  with one sentence; `CONTEXT.md`: "Raw" entry, if present, notes it is
  a line editor, not a textarea. `AGENTS.md`'s decision digest gets the 0032
  sentence.
- Move this spec to `docs/specs/done/`.

## Testing Decisions

Seam: the browser (`tests/browser.ts`). Prior art: `tests/ux-e2e.test.ts`
(the Raw editing suite — seed/read/chord helpers and the CDP undo command) and
`tests/mobile-editing-e2e.test.ts` (phone editing). Pure seam: a direct import
of `app/rawedit.js`'s `linkRanges` / `classifyLines` — prior art
`tests/markdown-inline.test.ts` (how it imports a browser module under bun).

1. **Migrate every existing test** that assumed a textarea, rather than
   loosening it: `tests/e2e.test.ts` iOS-floor test (`named[".raw"]` selector
   `textarea.raw` → drop `.raw` from `named` and from the sweep's
   expectations; add one assertion that `#rawArea` is `contenteditable`);
   `tests/secrets-e2e.test.ts` ~line 255 (`isTa` branch → read `.value` through
   the surface; `tag` becomes `div`); any `as HTMLTextAreaElement` casts are
   fine to leave where only `.value` / selection are used. Run each of the 19
   files that mention `rawArea` (list them with `grep -l rawArea tests/`) and
   fix what the swap broke — that is the acceptance bar.
2. New `tests/rawedit-e2e.test.ts` — bare minimum, one page:
   - open a doc `# Title\n\nbody [x](https://example.com) and [[other]]\n\n```\n# not a heading\n```\n`
     in Raw; assert `#rawArea .ln.h1` computed font-size equals Preview's
     `#doc h1` computed font-size (switch modes and compare), and a body `.ln`
     equals `.md p`; the fenced `# not a heading` line has no `h*` class.
   - `CSS.highlights.get("raw-link")` has exactly two ranges (the md link and
     the wikilink) and their `toString()`s are the spellings.
   - type `# ` at the start of the body line → that `.ln` gains `h1`;
     Backspace twice → it loses it. Text is byte-exact after each step.
   - paste HTML (`clipboardData` via `page.evaluate` dispatching a `paste`
     with both `text/html` and `text/plain`) → only the plain text lands.
   - Enter in the middle of a line splits it into two `.ln`s; Backspace at a
     line start joins; the value matches; ⌘S writes the exact bytes (read the
     vault file as `ux-e2e` does).
   - `value` set with a trailing newline round-trips (`ta.value === set`).
3. Pure: `tests/rawedit.test.ts` — a table of `linkRanges` cases (each
   spelling, inside backticks, inside a fence, `javascript:` not a link,
   trailing `).` trimmed) and `classifyLines` cases (h1–h3, `####` plain,
   fence toggling, indented fence).
4. `bun run gates` green; then the full `bun test` once at the end — this is
   cross-cutting.

## Out of Scope

- Syntax colouring beyond headings and links (bold, lists, code fences).
- Live preview / WYSIWYG, or hiding markdown markers.
- Firefox < 136 polish (it edits; it just has no `plaintext-only` and no
  highlights).
- Restoring the browser's native undo stack in Raw.
- The soft-keyboard toolbar (spec 0015) and pinch zoom (spec 0013), which land
  beside this and only require `.raw { font-size: inherit }` from it.
- The secrets reveal editor (`.secret-edit`) — it stays a textarea.
- Changing the Raw family away from mono in any shipped theme.

## Further Notes

The edit path must never leave the model and the DOM disagreeing: every
mutation goes through `replaceRange` or the reconcile; there is no third
path. If a browser quirk surfaces that neither covers (a nested `<div>` from
a paste the browser handled itself, say), the reconcile's normalisation is
the fix, not a special case in `editor.js`.

Do not import `markdown.js` or `editor.js` from `rawedit.js`; the module is a
leaf of the editor, not a peer.

Test Chromium in this repo (145) has `CSS.highlights`; assert on it directly.
