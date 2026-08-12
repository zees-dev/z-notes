# 0007 — z-notes is installable, and its icons are generated into the repo

## Status

Accepted, 2026-08-08.

## Context

The app is a single-user notes vault used mostly from a phone, over a
private HTTPS hostname. Added to a home screen it launched as a browser tab:
a URL bar over a 44px topbar, a white flash where a launch screen should be,
and a tile made from a screenshot of whatever page Safari had last rendered.
The responsive work (base.css §11–§13) had already made the layout right for a
phone; what was missing was everything OUTSIDE the viewport.

The repo has a hard rule of **no frontend build step** and zero external
requests, and the mark already exists as an inline SVG data: URI in
`app/index.html`. But neither platform will take that SVG where it matters:
iOS reads `apple-touch-icon` and accepts PNG only, and the splash both
platforms generate is built from a raster icon plus a background colour.

## Decision

Ship a **web app manifest** and **committed PNG icons**.

- `app/manifest.json`: `display: standalone`, `scope`/`start_url` `/`,
  `background_color` and `theme_color` both the mark's near-black (`#121412`),
  and 192/512 icons plus a `maskable` 512. Chrome and (since 15.4) Safari build
  the launch screen out of exactly those fields.
- `app/icons/*.png` are **generated and committed** by
  `scripts/make-icons.ts` — a generator run by hand when the mark changes, not
  a build step anything depends on. It draws the mark from primitives (there is
  no font to rasterize, so the `z` is three strokes and a block cursor) and
  writes the PNG itself; the repo gains no dependency.
- `index.html` carries the manifest link, `apple-touch-icon`, and the older
  `apple-mobile-web-app-*` spelling of the same facts.
  `status-bar-style` is `default`, not `black-translucent`: the translucent bar
  buys an immersive look by putting the topbar under the notch.
- The in-app boot splash carries the mark, so the frame after the OS launch
  screen is the same picture rather than an empty page.
- base.css §14 pays the **bottom** safe-area inset (`env(safe-area-inset-bottom)`)
  on the statusbar, the composer and the sidebar drawer — the home indicator
  sits inside the web view whatever the status bar style is. There is
  deliberately no top inset.

## Consequences

- Installed, the app opens chrome-free with a real launch screen; in a tab
  nothing changes (every `env()` resolves to `0px`, and the manifest is inert).
- A change to the mark now touches three places — the favicon data: URI, the
  sidebar/boot mark, and `scripts/make-icons.ts` — and the icons must be
  regenerated and committed. There is no check that enforces it.
- Still no service worker and still no offline story. `display: standalone`
  without one means a launch with no network shows the browser's own error
  page. That is the honest state of the app today: the vault lives on a server.
