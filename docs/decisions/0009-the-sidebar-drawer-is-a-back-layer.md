# 0009 — The sidebar drawer is a Back layer

## Status

Accepted, 2026-08-09. Extends the layer order in
[ADR 0008](0008-back-unwinds-layers-on-a-phone.md).

## Context

ADR 0008 made Back unwind the assistant and Raw mode before navigating away,
but omitted the sidebar below the 1024px drawer breakpoint. The drawer is more
modal than either: it lies over the doc and owns the scrim. Pressing Back while
it was open therefore left the current doc—or, from a fresh mobile launch,
could leave the app—while the visible layer remained open.

Closing a layer by its own control also has to return any Back press it reserved.
Without that half, fixing Back creates a dead next press after the close button,
the scrim, a tree choice, or a resize closes the drawer.

## Decision

Below `W_DOCK`, an open sidebar joins the single layer order immediately after
an open veil or guarded settings draft and before the assistant and Raw mode.
Back closes the drawer and keeps the current place.

`openNav()` reserves a layer marker when needed, exactly as the assistant does.
Every close funnels through `closeNav()`, which retires an unspent marker. The
drawer is included in `layered()` so a marker is retained while another visible
layer still needs it. Picking a doc may recycle that marker into the destination
doc entry; resizing into the desktop band closes through the same funnel.

## Consequences

- Back dismisses the left drawer before the right assistant, Raw mode, or the
  current doc can consume the press.
- Desktop sidebar columns do not participate; Back remains ordinary navigation.
- Closing the drawer without Back leaves no dead history entry.
- `mobile-e2e.test.ts` covers both Back dismissal and marker retirement.
