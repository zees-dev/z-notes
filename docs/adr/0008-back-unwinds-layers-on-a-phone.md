# 0008 — On a phone, Back unwinds layers before it leaves the place

## Status

Accepted, 2026-08-08. Supersedes the sheet-height sentence of
[spec 0001](../specs/done/0001-z-notes-v1.md) §11 (440px), which is an archive
of how it shipped.

## Context

The app's history model was built around PLACES: one entry per open doc, one
per settings page, and one marker per open veil so Back dismisses a modal
instead of navigating (`routeVeil`). Everything else that can lie over the
document — the assistant panel, and Raw mode — had no relationship with Back at
all, so on a phone the button that means "go back one step" skipped every step
the user could actually see and left the note, or the app.

The same phone had no way to put the assistant away except a 15px × 15px close
button in the sheet's head: there is deliberately no scrim (the document above
the sheet must stay readable and scrollable, which is the point of asking a
question about it), and a scrim is the usual thing that carries a click-away.

## Decision

**Back unwinds what is on top of the document, in one order, written down once
in `shell.js onPop`:**

1. an open veil — `dismissTop()`, unchanged;
2. an unsaved settings draft — ask (ADR-adjacent: `guardSettingsExit`);
3. the assistant, while it is an overlay (below `W_TRIPANE`);
4. Raw mode, below `W_SHEET` — Back leaves Raw for Preview one press before it
   leaves the note;
5. an unsaved Raw buffer at every other width — the SPEC §4 exit guard;
6. the place itself.

Mechanically, 2–5 are **intercepted, not routed**: a popstate has already
happened, so it is undone with a traversal in the OPPOSITE direction and spent
once we are standing where the user was (`holdPop`). Mode and panel state stay
out of the URL and mint no entry — with one exception, `markerForLayer`, which
pushes a single veil-shaped marker when a layer opens with **nothing
underneath**, because an interception needs a popstate to intercept and the
bottom of the stack produces none.

**A reserved press is given back when the layer closes some other way**
(`retireLayerMarker`). The marker exists only so a Back has something to be
caught at; close the sheet with its own ✕ and the user is left standing on an
entry with no job, so the next Back appears to do nothing. An entry cannot be
removed, so it is spent instead — `history.back()` under it, where the doc
branch recognises the entry below a marker and stops. Every door out of a layer
calls this, not just Back. Two stack movements have to be tracked for it to stay
honest: a push TRUNCATES, so a marker stacked over a reserved one inherits the
reservation, and `onPop`'s dismissal branch re-arms via `markerForLayer` because
walking a modal down lands on the entry the sheet was standing over.

**The settings draft guard (2) runs in BOTH directions**, alone among the
layers. The others are gestures — nobody dismisses a sheet by pressing Forward —
but a draft is work, and Forward off the page discards it exactly as Back does.
Two consequences follow from the dialog being a veil, and veils pushing markers
that truncate: a `[data-num]` field the caret still sits in must be committed
BEFORE the dirty test (`change` has not fired, so the draft reads clean and the
press walks off with the edit), and the forward destination must be captured as
a PLACE and re-navigated, because the act of asking destroys the entry being
asked about. Cancel therefore keeps the page but not the forward stack.

**The assistant is dismissed by reaching past it.** A capture-phase
`pointerdown` outside the panel (and outside the floating layers and its own
toggle) closes it, below `W_TRIPANE` only, without swallowing the click — the
tap still lands on the line or the tree row it was aimed at. Recorded with
`persist: false`: reaching past a layer is not a statement about whether the
user wants the assistant.

**The sheet is 78dvh**, up from 56dvh capped at 440px, so the history and the
composer both fit; and the composer is capped at **two lines until it is
focused**, so an unfocused draft cannot eat the history behind it.

## Consequences

- Back on a phone now takes up to three presses to leave a note that is being
  edited with the assistant open. That is the point: each press undoes a thing
  the user can see.
- Two Back layers are width-gated, so the desktop keeps its existing behaviour
  exactly — the routing gates all run at 1440px and were untouched by this.
- Cancelling the Forward guard keeps the page and loses the forward stack. That
  is inherent to asking with a veil, not a defect to be fixed later, and
  `settings-save-e2e.test.ts` measures it so nobody rediscovers it as a bug.
- `mobile-e2e.test.ts` covers the tap-away, the sidebar tap, Back-dismisses-the
  sheet and Back-leaves-Raw; the sheet-height assertion moved from `440px` to
  `78dvh`. Three further tests read `history.state.z` around each close — the
  reservation is only observable as WHICH ENTRY the next Back starts from, since
  `history.length` never falls.
