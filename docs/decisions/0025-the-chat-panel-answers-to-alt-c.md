# 0025 — The chat panel answers to ⌥C, not ⌘C

## Status

Accepted, 2026-08-20. Amends [spec 0001](../specs/done/0001-z-notes-v1.md),
which listed `⌘J` **or** `⌘C` as the chat panel's chords.

## Context

⌘C is copy. The app took it anyway, behind a guard that let it through only
when the copy it shadowed was provably a no-op: nothing selected anywhere on
the page, and focus outside every text surface. The guard worked — the
coverage for it dispatched real editing commands over CDP and read the system
clipboard back, in every state — but it bought a second-class chord at the
price of a rule the user has to hold in their head, and one that no other
chord in this app needs. A shortcut that works in some states and silently
does nothing in the rest reads as broken long before it reads as careful.

The panel already had an unconditional chord in ⌘J. What the second one was
for was reach, and reach is exactly what the guard took away.

## Decision

**⌥C toggles the chat panel, unconditionally, and the app stops binding ⌘C.**

- No selection test and no focus test stand between ⌥C and the toggle. ⌥ is
  not a clipboard modifier, so there is nothing to defer to and nothing to
  explain — it behaves like ⌘J, which is the point. Including where ⌘J stops:
  the composer and the terminal line take `stopPropagation` on every keydown,
  so no document chord climbs out of them. That is those fields' rule, not this
  chord's, and ⌥C inherits it exactly as ⌘J does.
- The chord matches on `e.code === "KeyC"` first. macOS resolves ⌥C to `ç`, so
  `e.key` carries the dead-key output rather than the letter; the same
  `e.code`-first shape ⌥Z and ⌥N already use.
- Swallowing the keydown costs the `ç` composition app-wide, which is the
  trade [ADR 0013](0013-a-collapsed-caret-makes-x-and-c-take-the-line.md)'s
  neighbour ⌥N already takes for `ñ`: a chord that dies wherever a note is
  actually being written is not a chord.
- **⌘C is the browser's again, in every state.** The `hasSelection()` helper
  existed only for the retired guard and goes with it.

## Consequences

- Nothing in the app now competes with copy at the document level, so the
  question "will ⌘C copy here?" has one answer everywhere.
  [ADR 0013](0013-a-collapsed-caret-makes-x-and-c-take-the-line.md) is
  untouched and slightly strengthened: the whole-line ⌘X/⌘C over a collapsed
  caret lives in `editor.js`, on the raw textarea, and was never this binding.
- The ⌘C coverage in `tests/ux-e2e.test.ts` survives the move rather than being
  deleted with it. Its claim — copy still copies, measured against the real
  clipboard — is the claim either way, and the state that used to hand the
  chord to the app is now the one that pins that it does not.
- ⌥C is measured in both states the old guard refused: with a live selection,
  and from a focused field. The composer is measured too, for the opposite
  reason — it keeps the chord, leaves no `ç` behind, and the same test presses
  ⌘J there to prove that is the field's rule and not a hole in this one.
- The shortcuts overlay drops the "only with no selection and no field
  focused" qualifier, because there is no longer a condition to qualify.
