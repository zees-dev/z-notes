# 0033 — The app owns the pinch, and it steps text

## Status

Accepted, 2026-09-10. Implements
[spec 0013](../specs/done/0013-pinch-to-zoom-steps.md). Adds a fourth axis to
the pre-paint resolver [ADR 0003](0003-themes-are-css-token-contracts.md)'s
themes are read by, is a phone-first choice in the line of
[ADR 0007](0007-installable-web-app.md), and reaches an agent through
[ADR 0031](0031-the-agent-gets-the-same-doors.md).

## Context

A pinch over a document in this app did one of three things, none of them what
a reader meant by it. Installed to a home screen it did nothing at all.
Elsewhere, the browser scaled the LAYOUT — topbar, sidebar, statusbar and
document together — leaving a shell wider than the screen and scrolled
sideways, with the controls a thumb needs half off the edge. The one thing
nobody could ask for was the obvious one: bigger text, in the note, at a size
that stays.

The browser's zoom is the wrong instrument here because this app is not a page.
It is a fixed shell around one scrolling column, and scaling the shell is
scaling the furniture to read the book. Desktop browser zoom (⌘+/⌘−) is a
different case and stays exactly as it was — there is no gesture there to
compete with, and the whole window scaling is what a desktop user asked for.

## Decision

**A pinch over the document pane steps the document's TEXT up or down a fixed
ladder. The browser's own pinch-zoom is switched off so the two cannot fight.**

- The ladder is `[0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]`, as a multiplier of the
  theme's body size, default 100 %. A ladder rather than a free-flowing scale:
  every rung is a size the themes were checked at, the step is visible on a 4"
  screen, and the value is short enough to say in a toast. A continuous factor
  lands on 1.0736 and stays there.
- **One published number.** `--doc-zoom` on `<html>`, read in exactly one
  place — base.css §7's `.doc`, whose `font-size` is `calc(var(--d-font) *
  var(--doc-zoom, 1))`. Everything in the document that inherits or is
  `em`-sized rides along; the two px-sized code tokens inside `.doc` are
  multiplied by the same `calc` by hand. The chrome — topbar, statusbar,
  sidebar, chat, `.doc-meta` — sets its own sizes and so does not move, which
  is the entire difference from what the browser does.
- **A step is a distance, not a delta.** The finger separation has to grow by
  25 % or shrink by 20 % since the rung it last bought, so a long slow pinch
  takes several rungs and a twitch takes none. Asymmetric because spreading has
  the screen to move in and pinching only the gap the fingers already opened.
- **The rung is per browser, and it is the MULTIPLIER, never an index.**
  `localStorage` `znotes.zoom`, applied pre-paint by the same inline script in
  `app/index.html` that resolves the theme, so a reload does not flash the old
  size. Storing an index would mean a later change to the ladder silently
  reinterpreting an old store; a multiplier is read to the nearest rung and is
  still approximately right.
- **The browser's version is switched off in both dialects it speaks.** The
  viewport meta gains `maximum-scale=1, user-scalable=no`; `html` and `.scroll`
  get `touch-action: pan-x pan-y`; Safari's proprietary `gesturestart` /
  `gesturechange` are `preventDefault`ed. One alone is not enough — a browser
  that honours the meta and one that honours `touch-action` are different
  browsers.
- **The gesture is not the only door.** `setZoom(factor)` is exported, and
  `set_text_zoom` in the WebMCP catalogue wraps it (ADR 0031), taking a percent
  off the ladder and answering ADR 0002's error shape for anything else.
  `get_app_state` reports `textZoom` as a percent.

## Consequences

- **`user-scalable=no` is an accessibility cost, and it is paid for.** Turning
  off a user's ability to magnify text is normally indefensible. It is
  acceptable here only because the app REPLACES the gesture with an equivalent
  one that reaches 200 % — the same ceiling WCAG asks for — over the content
  that has words in it. If the ladder is ever shortened below 200 %, this
  decision has to be revisited rather than trimmed.
- Chrome may hand a `touchmove` to the compositor before the handler sees it
  and mark it non-cancelable, logging an intervention. A symmetric pinch nets
  no pan, so the document does not move; `touch-action` is what actually
  removes the browser's zoom, and the `preventDefault` is the belt.
- `--kb` (`wireVisualViewport`) is unaffected and needs no arithmetic change:
  with native zoom off, `visualViewport` reports the soft keyboard alone.
- Deliberately not built: a settings control for zoom (the gesture and the tool
  are the UI), per-document zoom (the size is a property of the reader, not of
  the file), desktop keyboard shortcuts, and chrome that scales with the text.
- `tests/zoom-e2e.test.ts` measures it in a real Chromium over CDP touch: the
  rung after a spread and after a pinch, the floor, the pre-paint value on
  `<html>` before boot, the viewport meta and computed `touch-action`, the tool
  and its refusal. Its sixth case — Raw and Preview at one size — is skipped
  until spec 0014 (Raw is a line editor) makes `#rawArea` inherit its size.
