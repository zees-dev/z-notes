# 0012 — Save state is a statusbar pip and a topbar mark that leaves

## Status

Accepted, 2026-08-10. Amends the topbar inventory in
[the product spec](../specs/done/0001-z-notes-v1.md) §"Saving" and its
settings-page paragraph, both of which describe a Save **button** and a save
**indicator** living in the topbar. The spec's own sentence — "statusbar shows
saved/dirty state" — is what this change finally makes literally true.

Follows [0009](0009-the-sidebar-drawer-is-a-back-layer.md) in the same
direction the mode control went (ADR-less at the time, recorded in
`0001` §"Two modes"): a fact about the document belongs in the bar this app
uses to say facts, not in the bar it uses to hold controls.

## Context

The topbar carried three things for one idea:

- a `.saved` pill — a dot, a word ("Saved" / "Unsaved changes") and a coloured
  fill, ~110px wide;
- a primary `Save ⌘S` button beside it, ~90px, the app's most prominent button
  treatment sitting permanently next to the pill that says whether pressing it
  would do anything;
- an `.only-mobile` icon button under 768px, where there is no `⌘S`.

Autosave is the actual mechanism: a debounce (10s by default) writes the buffer
without being asked, and `⌘S`, the exit guard, navigation and the AI relay all
force a write on their own. The button is therefore a *reassurance* affordance,
not the way documents get saved — and it was styled as the loudest control on
screen, in the one bar that also holds the crumbs, the vault lock and the
assistant.

The pill said the same thing a second time. Two of the app's most valuable
200px of chrome, spent on a fact the eye only needs to glance at.

## Decision

**Desktop (≥768px) has no Save button.** The topbar keeps only the
`.only-mobile` icon, for the width where there is no `⌘S` to fall back on.

**The pill is gone.** Its state is `#saveInd` in the statusbar: one 6px pip —
muted when the buffer matches the file, `--warn` while there are unwritten
keystrokes, a `--ok` blink when a write lands.

**The topbar keeps a mark that is up only while it has news.** `#tbSave` leads
the right-hand cluster, immediately left of the lock: a 7px amber dot when the
buffer diverges from the file, a green tick with one pop when the write lands,
then it fades and is gone. A clean document wears nothing at all — which is the
difference from the pill, and the whole point. The pill was permanent chrome
that spent ~110px saying "Saved" for the 99% of the time when nothing had
happened; this speaks only when something did.

It sits with the lock and the assistant because those three are the three
things that can be true of the document in front of you — it has unwritten
changes, it can take an encrypted block, the assistant is listening — and the
one that speaks least often reads first.

**While the buffer is dirty the dot breathes**: a 1.9s cycle that never falls
below .45 opacity or 86% scale. It is the only thing on that bar that moves
while nothing is happening, so it is deliberately slow and shallow — alive on a
glance, but quiet enough that peripheral vision stops reporting it. The dot says
"there is work here", not "deal with me now". The animation is on the pip alone
(the container's opacity is the mark's own appearing and disappearing, and
animating both would fight over one property), it stops the moment the tick
takes over, and `prefers-reduced-motion` turns it off with the pop.

The two are one state machine, not two: `setSaveIndicator` and `flashSave`
paint both, off one `SAVE_FLASH_MS`, so the tick and the pip's blink are the
same beat seen in two places rather than two timings that can drift apart. The
mark's own timer is separate from the pip's (`markT`, not `flashT`) — they end
at the same moment but do different things, and sharing a handle let whichever
ran second cancel the first's cleanup. The pip is the persistent answer and the
click target; the mark is the notice.

Both glyphs live stacked in ONE fixed 13px grid cell, always in the layout,
appearing by `opacity`/`transform`. A mark that took its space when it appeared
would shove the whole right-hand cluster left on every keystroke that dirties a
clean buffer — measured across clean → dirty → saved → gone at 1440px,
`#encBtn` stays at x=1032 and `#chatBtn` at x=1062 throughout.

**The pip is the manual save.** It is a `<button data-act="save">`, so the
thing you look at to ask "is this saved?" is the thing you click to make it so.
`⌘S` is unchanged. Its hit area is the bar's full height, taken by
`align-self: stretch` rather than by §13's inset-negative `::after`: this bar
is `overflow: hidden` and 19–25px tall across theme and density, so a
fixed-inset pseudo-element is a size that must be re-derived for each of those
— and the first attempt (24px of target in a 20px Modern/compact bar) clipped
it, which `theming-e2e` reads as a vertical clip. `stretch` is the same target
expressed as a relationship, and cannot out-grow the box it is in.

It shares `#stSync`'s divider rather than taking one of its own: disk, then
remote, then the live connection — one cluster of three states at the end of
the bar, reading left to right, and 12px rather than 30px on the narrowest
statusbar this app supports.

The word itself stays in the DOM as clipped text (`.sb-vh`) with `aria-live`,
and in the `title`. `#saveTxt`'s textContent remains the contract — six e2e
files wait on it — and it is now written only on a real transition, because an
aria-live region re-announces re-assigned text and `markDirty` runs on every
keystroke.

## Consequences

- The topbar is crumbs · vault · assistant, plus the phone's Save and a 13px
  mark that is blank most of the time. Measured at 1440px it lost ~200px of
  permanent controls.
- `#tbSave` is hidden on `/settings` with the other document controls. That
  rule is load-bearing, not a belt: the Raw exit guard means you cannot walk to
  Settings from a dirty Raw buffer without resolving it first, but a document
  dirtied in PREVIEW has no such guard, and its mark would otherwise sit beside
  a page with no document.
- `tests/e2e.test.ts`'s "typing in Raw then ⌘S" gate now measures the mark at
  all three moments it passes through — clean, dirty, and a write that landed —
  as paint (class plus computed opacity), because the element is always in the
  DOM and its presence there proves nothing.
- Statusbar overflow stays 0px with `#stConn` inside the bar at 360 / 390 /
  430 / 600 / 768 / 820 / 1024 / 1280 / 1440px, the widths
  `tests/e2e.test.ts`'s measure-floor gate gets it at.
- `#saveInd` is hidden on `/settings` with the other document controls — it is
  now a control as much as a state, so it follows both rules.
- Four e2e clicks moved from `[data-act='save']:not([hidden])` (which resolved
  to the desktop button) to `.statusbar #saveInd`. The mobile suites still
  click `.topbar .only-mobile[data-act="save"]`; nothing that reads `#saveTxt`
  or `#saveInd.dirty` changed.
- **The toast moved up.** `.toast` was offset from the VIEWPORT (`bottom:
  22px`) while the bar it now shares an edge with is 19–25px tall: the resting
  toast cleared it by 1px in Minimal and sat inside it in the taller
  combinations, and its 16px entrance travel put it over the bar for ~0.28s
  every time. `.sticky` takes pointer events — it is dismissed by clicking —
  so the notice reading "your unsaved text is still here" was landing on the
  button that would have written it and swallowing the click (measured at
  1440px: toast x 449–991, pip x 973; `lifecycle-e2e`'s Discard case caught
  it). The offset is measured from the bar now, and the entrance travel (10px)
  stays inside the gap (14px), so the toast never enters the statusbar's box at
  any point of its animation — verified across 18 combinations of width, theme
  and density, worst case 4px of clearance.
- What is deliberately NOT done: a check mark for the saved state. `#stSync`
  wears one immediately to its right, and two checks 9px apart would be two
  different questions answered by the same glyph.
