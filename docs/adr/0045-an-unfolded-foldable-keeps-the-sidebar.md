# 0045 — An unfolded foldable keeps the sidebar

## Status

Accepted, 2026-11-08. Amends base.css §11 and shell.js's THE ONE RESPONSIVE
AXIS: height now enters one band, and only there.

## Context

Below 1024px the sidebar is a drawer. An unfolded foldable (Galaxy Z Fold,
Oppo Find N5, Pixel Fold) has a near-square inner screen of roughly 670–950
CSS px a side, so it got the phone's or the tablet's drawer, and moving
between docs took the menu every time. Its cover screen (about 340–430 wide)
is a phone. Android's window size classes draw the same line: 600dp starts
the medium width class (1 CSS px = 1 dp in Chrome), and under 480dp is a
compact height, which a landscape phone is and an unfolded foldable is not.

## Decision

- **The fold band is 600–1023 wide and at least 480 tall.** There, with
  `layout.foldableSidebar` on, the sidebar is a grid column beside the doc,
  `⌘B`/the toggle collapses it, and opening a doc leaves it open.
  `applyFoldableSidebar` in `app/shell.js` sets `fold-dock` on `#app` at load,
  on every resize (folding and unfolding) and when the setting is saved;
  `isDrawer()` reads it.
- **`layout.foldableSidebar`** (settings.toml, default `true`; Settings ›
  Appearance › Foldable sidebar). Off is the drawer, exactly as before.
- **The column gives way:** at most 36% of the width, so a 673px Fold keeps a
  ~430px doc.
- **Still no pointer query.** A tablet in portrait is in the band too and
  gets the column; that is the same layout problem.

## Consequences

- Below 768 the chat is still the bottom sheet, beside a docked sidebar.
- The doc measure in the band can fall under §11's 520px floor; the setting
  is the user's choice of navigation over measure.
- The device widths are from Android's published classes and device specs,
  not measured on the user's phone.
