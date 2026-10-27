# 0043 — The installed app keeps the system bars

## Status

Accepted, 2026-10-28. Amends [ADR 0007](0007-installable-web-app.md): the
manifest is `display: standalone` again, with no `display_override`.

## Context

The manifest asked for `fullscreen` first, which Android honours: the installed
app hid the status bar and the system navigation bar, so Back, Home and the app
switcher were a swipe away rather than on screen. A manifest's display mode is
fixed per install and changes only when Chrome refreshes the installed app, so it
cannot be a setting. The Fullscreen API can, but only a user gesture may start
it, and leaving full screen (Back, a swipe) is the browser's, not the app's.

## Decision

- **`app/manifest.json` asks for `standalone`.** An installed app keeps the
  system bars by default.
- **`installed.navigationBar`** (settings.toml, default `true`; Settings ›
  Appearance) off hides them: `applyNavigationBar` in `app/shell.js` calls
  `requestFullscreen({ navigationUI: "hide" })` on the next tap, and again on the
  first tap after Back or a swipe has left full screen. Turning it on exits full
  screen.
- **Only an installed app on a touch screen reads it**, decided once at load
  (`display-mode: standalone` or `fullscreen`, `pointer: coarse`, and the API
  present). A browser tab and an installed desktop window ignore it: there, full
  screen takes over the whole display.

## Consequences

- With the setting off, Android's Back leaves full screen before it reaches the
  app's own Back handling ([ADR 0008](0008-back-unwinds-layers-on-a-phone.md)),
  so one press shows the bars and the next unwinds a layer.
- iPhone has no element Fullscreen API, so the setting does nothing there; the
  bars were never hidden on iOS. iPadOS has it, so an installed iPad app with
  the setting off goes full screen too.
- An app installed before this change keeps full screen until Chrome refreshes
  its manifest (on a later launch) or it is reinstalled.
- The e2e test stubs the installed-app check, which headless Chromium cannot
  emulate (`display-mode` is not an emulated media feature), and measures the
  real Fullscreen API.
