# 0013 — Pinch to zoom is a ladder of text sizes

## Problem Statement

On a phone, pinching the document either does nothing (installed app, or a
browser honouring the viewport meta) or zooms the whole layout the browser's
way — chrome, sidebar and all — leaving the shell scrolled sideways. What a
reader actually wants from a pinch in a notes app is bigger or smaller
**text**, in the document, at sizes that stay legible and predictable, and
that stick.

## Solution

- A pinch over the document pane steps the document's text size up or down
  through a fixed ladder; nothing free-flowing. The ladder, as a multiplier of
  the theme's body size:

  `ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]` (default index 1 = 100 %).

- The multiplier is published as one custom property, `--doc-zoom`, on
  `<html>`, and the document container reads it:
  `.doc { font-size: calc(var(--d-font) * var(--doc-zoom, 1)); }`. Everything in
  the document that inherits or is `em`-sized (Preview paragraphs, headings,
  lists, the Raw editor — spec 0014 makes `.raw` inherit its size) scales
  together. Code blocks and inline code, whose sizes are px tokens, are
  multiplied the same way (`--d-code-fs`). Chrome (topbar, statusbar, sidebar,
  chat, `.doc-meta`) does not move.
- The step is remembered per browser in `localStorage` (`znotes.zoom`, the
  multiplier as a string, e.g. `"1.3"`), applied pre-paint by the same inline
  script in app/index.html that applies the cached theme and density, so a
  reload does not flash the unzoomed size.
- The browser's own pinch-zoom is switched off so the two cannot fight: the
  viewport meta gains `maximum-scale=1, user-scalable=no`; `html` and `.scroll`
  get `touch-action: pan-x pan-y`; Safari's proprietary `gesturestart` /
  `gesturechange` are `preventDefault`ed on `document`. (Accessibility note for
  the ADR: the app replaces the gesture with an equivalent one — text scales up
  to 200 % — rather than merely removing it.)
- Each step shows the existing toast: `Text size 130%`.
- The step is also reachable without a gesture: a WebMCP tool `set_text_zoom`
  (ADR 0031 — every UI operation is a tool), and an exported `setZoom(factor)`
  the tool wraps.

## User Stories

1. As a phone user, I want to pinch out over my note and see the text get
   larger in a clear step, so that I can read comfortably without the layout
   zooming.
2. As a phone user, I want to pinch in to step back down, to the smallest
   rung, so that I can fit more on screen.
3. As a phone user, I want the size I chose to be there when I reopen the app,
   without a flash of the old size, so that I set it once.
4. As a phone user, I want a long pinch to take several steps and a small one
   to take none, so that the gesture feels deliberate — a step happens when the
   finger distance grows by 25 % or shrinks by 20 % since the last step.
5. As a phone user, I want the Raw editor to be zoomed exactly as Preview is,
   so that switching modes does not change the text size (spec 0014's parity).
6. As a user, I want the browser never to zoom the layout on its own — not on
   a pinch, not on focusing the editor — so that the shell stays where it is.
7. As a desktop user, I want nothing to change: no gesture, and browser zoom
   (⌘+/⌘−) untouched.
8. As an agent, I want `set_text_zoom` to accept a percent from the ladder and
   to answer the API's error shape for any other value, so that I can drive the
   same choice a hand makes.

## Implementation Decisions

- **New feature module `app/zoom.js`** (imports only `./state.js` and
  `./ui.js`, so it stays out of the mutual-import tangle):

  ```js
  export const ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const ZOOM_STORE = "znotes.zoom";
  export function zoomFactor() // current multiplier (number)
  export function setZoom(factor) // snaps to the nearest rung, sets --doc-zoom on documentElement, persists, toasts "Text size N%"; returns the applied factor
  export function stepZoom(dir) // dir = +1 | -1; no-op (and no toast) at either end of the ladder
  export function initZoom() // reads the store (nearest rung; default 1), applies without a toast, wires the gesture on #scroll and the Safari gesture* preventDefaults
  ```

  Gesture wiring (in `initZoom`), on `#scroll`:
  - `touchstart` (passive): with exactly two touches, record the distance `d0`.
  - `touchmove` (`{ passive: false }`): with two touches, `preventDefault()`
    (this is what stops the two-finger scroll/zoom), compute `d / d0`; if
    `>= 1.25` → `stepZoom(+1)` and `d0 = d`; if `<= 0.8` → `stepZoom(-1)` and
    `d0 = d`.
  - `touchend` / `touchcancel`: clear `d0` when fewer than two touches remain.
  - `document.addEventListener("gesturestart" | "gesturechange", e => e.preventDefault())`
    guarded so a browser without those events is a no-op.
- **CSS (app/themes/base.css)**, in §7 EDITOR next to `.doc`:
  `.doc { font-size: calc(var(--d-font) * var(--doc-zoom, 1)); }` and, for the
  px-sized code tokens inside the document, wrap the existing `font-size:
  var(--d-code-fs)` uses within `.doc` in the same `calc`. In §3 RESET add
  `touch-action: pan-x pan-y;` to the `html` rule and to `.scroll`. Do NOT
  touch `.raw` — spec 0014 owns its rules and makes it `font-size: inherit`.
  (Theme sheets: nothing to change — `--doc-zoom` is read in base only.)
- **index.html**: the viewport meta becomes
  `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`
  (update the comment beside it: the app owns pinch now, spec 0013). The
  pre-paint script that reads `znotes.density` also reads `znotes.zoom` and,
  when it parses as a finite number in `[0.85, 2]`, sets
  `document.documentElement.style.setProperty("--doc-zoom", value)`.
- **app.js**: `initZoom()` is called in `start()` after the settings/theme
  appliers and before `registerWebMcpTools()`.
- **webmcp.js**: add `set_text_zoom` to the catalogue — input
  `{ percent: integer }` (one of 85, 100, 115, 130, 150, 175, 200); wraps
  `setZoom(percent / 100)`; any other value returns
  `{ error: "invalid-arg", message: "percent must be one of 85, 100, 115, 130, 150, 175, 200" }`
  (ADR 0002 shape; follow the file's existing invalid-argument helper). Expose
  the current zoom in `get_app_state` as `textZoom: 130` (percent). Keep the
  catalogue's own test (`tests/webmcp.test.ts`) green — name legal, declared
  once.
- `--kb` (shell.js `wireVisualViewport`) is untouched: with native zoom off,
  `visualViewport` reports only the keyboard.
- The persisted value is a multiplier, never an index, so a later change to
  the ladder still reads an old store (nearest rung).

## Testing Decisions

- Seam: the browser (`tests/browser.ts`) with a touch viewport
  (`page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true })`)
  and CDP `Input.dispatchTouchEvent` with two `touchPoints` — prior art for
  touch dispatch is `tests/mobile-e2e.test.ts` (around line 650). New file
  `tests/zoom-e2e.test.ts`:
  1. two fingers moving apart over `#scroll` by ≥ 25 % → `--doc-zoom` on
     `<html>` is `1.15` and `#doc`'s computed `font-size` equals the body's
     `--d-font` × 1.15 (±0.1px); a second widening reaches `1.3`.
  2. two fingers moving together by ≥ 20 % steps down; at `0.85` a further
     pinch stays at `0.85`.
  3. reload → `--doc-zoom` is present on `<html>` before app boot (read it in
     a `beforeLoad`-free page immediately after `domcontentloaded`) and the
     document is rendered at that size.
  4. `document.querySelector('meta[name=viewport]').content` contains
     `maximum-scale=1`; `getComputedStyle(document.documentElement).touchAction`
     is `pan-x pan-y`.
  5. via `document.modelContext` (see `tests/webmcp-e2e.test.ts` for how the
     catalogue is called headless): `set_text_zoom({percent: 150})` applies;
     `{percent: 140}` returns the error shape.
  6. Raw parity at zoom: in Raw (`ensureMode("raw")`) the computed font-size of
     `#rawArea` equals that of a Preview `.md p` at the same zoom — this test
     depends on spec 0014 having landed; write it so it is skipped with a
     `console.log` when `#rawArea` is still a `TEXTAREA`.
- Keep it to those six.

## Out of Scope

- Keyboard shortcuts for zoom on desktop (browser zoom already does it).
- Zooming the chrome, the sidebar or the chat.
- A settings-page control for zoom (the gesture and the tool are the UI).
- Per-document zoom.
- Mermaid diagram scaling.
- Changing the ladder from settings.
- `--kb` arithmetic changes.

## Further Notes

Promote to an ADR (`docs/decisions/0033-text-size-is-a-pinch-ladder.md`, next
free number at the time of writing — check): the decision is "the app owns
pinch, and it steps text, not layout"; note the accessibility trade
(user-scalable=no is acceptable only because the replacement reaches 200 %).
Amend the base.css §11 comment's "ONE AXIS" claim if you add a `pointer:`
media query — you should not need one: the gesture is JS, the CSS is
unconditional.

Spec 0014 (Raw as a line editor) lands in parallel and owns everything under
`.raw` and the §12 iOS floor; this spec must not edit those rules. If the
viewport meta has already changed when you get there, leave it.
