# 0015 — The soft keyboard gets an editing bar

## Problem Statement

On a phone the Raw editor has no Tab key. Indenting a list item, the most
common structural edit in a notes app, is impossible without a hardware
keyboard; outdenting likewise. ⌘Z and ⌘E do not exist either, and the
statusbar chip that leaves Raw is under the keyboard.

## Solution

A slim bar pinned to the top edge of the soft keyboard while the Raw editor
is focused — visible only when a soft keyboard is actually covering the
viewport (`--kb > 0`, the length shell.js already publishes), so a tablet
with a hardware keyboard, and the desktop, never see it.

Buttons, left to right: **Outdent** (⇤), **Indent** (⇥), a gap, **Undo**,
**Redo**, and at the far right **Done** (leaves Raw for Preview, dismissing
the keyboard). Indent/Outdent do exactly what Tab / ⇧Tab do in Raw (list
lines move a level, other lines gain/lose the configured spaces); Undo/Redo
step the app timeline (ADR 0014); Done is Esc (`setMode("preview", {silent:
true})`).

Tapping a button never takes focus from the editor (so the keyboard stays
up and the selection is intact).

## User Stories

1. As a phone user editing a list, I want an Indent button above the keyboard
   that nests the current item, and an Outdent button that unnests it, so that
   I can structure a note with my thumbs.
2. As a phone user, I want those two to act on every line of a multi-line
   selection, exactly as Tab does, so that the button and the key agree.
3. As a phone user, I want Undo and Redo above the keyboard, so that a
   mis-tap is one tap to fix.
4. As a phone user, I want Done to take me back to Preview and put the
   keyboard away, so that I do not have to find the statusbar under it.
5. As a phone user, I want the bar to sit exactly on the keyboard's top edge,
   and the caret to stay above the bar, so that the line I am typing is never
   under either.
6. As a tablet user with a hardware keyboard, and as a desktop user, I want no
   bar, so that nothing new appears where Tab already works.
7. As an agent, I want `indent_lines` in the catalogue (ADR 0031), so that I
   can do what the button does.

## Implementation Decisions

- **editor.js** — split `editRawTab(e, ta)` into a pure action and its key
  wrapper:

  ```js
  /** Move the selected lines one level (outdent=false → in, true → out); the Tab logic, callable without a key. */
  export function indentSelection(outdent) { const ta = $("#rawArea"); if (!ta || state.mode !== "raw" || overlayOpen()) return false; …existing body from `const size = …` onward, with `e.shiftKey` → `outdent`…; return true; }
  function editRawTab(e, ta) { if (e.key !== "Tab" || …) return false; e.preventDefault(); e.stopPropagation(); indentSelection(e.shiftKey); return true; }
  ```

  Also export a `leaveRaw()` if none exists that `setMode("preview", { silent: true })`
  wraps — or call `setMode` directly from the bar; `setMode` is already
  exported.
- **`revealRawCaret`** subtracts the bar: read
  `--keybar` off `documentElement` the way it reads `--kb`, and lower
  `visibleBottom` by it.
- **New feature module `app/keybar.js`** importing `./state.js`, `./ui.js`,
  `./history.js` (`pendingHistory`, `stepHistory`) and `./editor.js`
  (`indentSelection`, `flushTextRun`, `setMode`). Export `initKeybar()`:
  - builds nothing — the markup lives in `app/index.html` (right after the
    `<footer class="statusbar">`, still inside `.app`):
    ```html
    <div class="keybar" id="keybar" role="toolbar" aria-label="Editing" hidden>
      <button type="button" tabindex="-1" data-kb="outdent" title="Outdent (⇧Tab)">⇤</button>
      <button type="button" tabindex="-1" data-kb="indent" title="Indent (Tab)">⇥</button>
      <span class="gap"></span>
      <button type="button" tabindex="-1" data-kb="undo" title="Undo">…I.undo…</button>
      <button type="button" tabindex="-1" data-kb="redo" title="Redo">…mirrored undo…</button>
      <span class="spring"></span>
      <button type="button" tabindex="-1" data-kb="done" class="done" title="Done">Done</button>
    </div>
    ```
  - wires one delegated `pointerdown` on `#keybar` that `preventDefault()`s
    (keeps focus in the editor — this is the whole trick; also add
    `mousedown` preventDefault for browsers that route touch through
    compatibility mouse events), and one delegated `click` that dispatches on
    `data-kb`: `indent` → `indentSelection(false)`, `outdent` →
    `indentSelection(true)`, `undo`/`redo` → `flushTextRun(); if (pendingHistory(redo)) stepHistory(redo)`,
    `done` → `document.activeElement?.blur(); setMode("preview", { silent: true })`.
  - visibility: the bar is shown iff `document.activeElement?.id === "rawArea"`
    AND the root's `--kb` is > 0. Track focus with `focusin`/`focusout` on
    `document` (focusout removal deferred by one `setTimeout(…, 120)` and
    cancelled by a focusin back on the editor) and keyboard height by
    listening for the same `visualViewport` events shell.js does — simplest:
    have `wireVisualViewport`'s `publish` also set `app.classList.toggle("kb-up", overlap > 0)`,
    and keybar toggle `app.classList.toggle("raw-focus", …)`; CSS shows the
    bar under `.app.kb-up.raw-focus .keybar`. `hidden` on the element is
    dropped at init (CSS owns visibility). When shown, set
    `--keybar: <offsetHeight>px` on `documentElement`; when hidden, `0px`.
    Also disable Undo/Redo (`disabled` attribute) when `pendingHistory` is
    null, refreshed on every `input` on `#rawArea` and after each step.
- **CSS (base.css, new §-block after the statusbar rules)**:
  ```css
  .keybar { display: none; position: fixed; left: 0; right: 0; bottom: var(--kb, 0px); z-index: 85; height: 40px; padding: 0 6px; align-items: center; gap: 4px; background: var(--panel); border-top: var(--bd); }
  .app.kb-up.raw-focus .keybar { display: flex; }
  .keybar button { height: 30px; min-width: 40px; padding: 0 10px; border-radius: var(--r-sm); background: var(--btn-bg, var(--panel-2)); color: var(--text); font: inherit; font-size: 15px; }
  .keybar button:disabled { opacity: .4; }
  .keybar .gap { width: 8px; } .keybar .spring { flex: 1; } .keybar .done { font-weight: var(--w-semi); color: var(--accent); }
  ```
  Use the theme's existing button tokens rather than inventing new ones
  (check `.btn`, `.sb-i` for what the statusbar buttons use). Phone `.doc`
  bottom padding already includes `var(--kb)` plus 34vh, so no change there.
- **app.js**: `initKeybar()` in `start()` after `initZoom()` (spec 0013) if
  present, before `registerWebMcpTools()`.
- **webmcp.js**: tool `indent_lines` with input `{ outdent?: boolean }` →
  `indentSelection(!!outdent)`; returns `{ ok: true }` or
  `{ error: "not-raw", message: "Switch to Raw first" }` when it returns
  false. Keep `tests/webmcp.test.ts` green.
- ADR: `docs/adr/00NN-the-soft-keyboard-carries-an-editing-bar.md` —
  short: the bar exists only where a soft keyboard does (`--kb`, measured,
  not a pointer query — consistent with base.css §11's "one axis" rule since
  the condition is the keyboard, not the device), focus never leaves the
  editor, the actions are the key chords' own functions.

## Testing Decisions

- Seam: the browser at the phone viewport — prior art
  `tests/mobile-editing-e2e.test.ts` (the `PHONE` viewport, `ensureMode`).
  Headless has no keyboard, so the test sets the condition the app reads:
  `document.documentElement.style.setProperty("--kb", "300px")` AND
  `document.getElementById("app").classList.add("kb-up")` (the class is what
  CSS reads; the property is what `revealRawCaret` reads).
- New `describe` in `tests/mobile-editing-e2e.test.ts` (or a new file
  `tests/keybar-e2e.test.ts` if that file is already long — it is; prefer the
  new file), cases:
  1. focus the editor with `kb-up` set → `#keybar` is displayed
     (`getComputedStyle(...).display === "flex"`); at the desktop viewport
     without `kb-up` it is `none`.
  2. seed `- alpha\n- bravo\n`, caret in line 1, tap Indent (use
     `page.click` — it dispatches pointer events) → value `  - alpha\n- bravo\n`;
     `document.activeElement.id` is still `rawArea`; tap Outdent → restored.
  3. tap Undo → value back; tap Redo → indented again.
  4. tap Done → `#doc` loses `raw-mode`, mode chip says Preview.
  5. `document.modelContext` `indent_lines({outdent:false})` in Raw indents;
     in Preview it returns the error shape.
- Five tests, one page.

## Out of Scope

- Bold/italic/link/heading insertion buttons.
- A bar on the desktop or a hardware-keyboard tablet.
- Changing what Tab does.
- Replacing the statusbar's mode chip.
- The chat composer's keyboard.

## Further Notes

Spec 0014 replaces the Raw textarea with a contenteditable line editor that
keeps the same surface (`#rawArea`, `value`, selection, `focus`). Everything
here goes through `indentSelection`, so it does not care which shipped first —
but run the mobile-editing suite after both are in.
