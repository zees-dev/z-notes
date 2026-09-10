# 0034 — The soft keyboard carries an editing bar

## Status

Accepted, 2026-09-10. Implements
[spec 0015](../specs/done/0015-soft-keyboard-bar.md). A phone-first choice in
the line of [ADR 0007](0007-installable-web-app.md) and
[ADR 0008](0008-back-unwinds-layers-on-a-phone.md); it spends
[ADR 0014](0014-file-operations-undo-but-they-ask.md)'s one timeline and
[ADR 0012](0012-save-state-is-a-statusbar-pip.md)'s statusbar mode chip through
new doors, and reaches an agent through
[ADR 0031](0031-the-agent-gets-the-same-doors.md).

## Context

On a phone this editor is missing four verbs, and they are not small ones.

There is no **Tab**, so a list item cannot be nested — which is the commonest
structural edit there is in a notes app, and the one thing markdown asks you to
do with whitespace rather than with a character you can type. There is no
**⇧Tab** to unnest it again. There is no **⌘Z**, so a mis-tap is repaired by
hand or not at all. And the statusbar chip that leaves Raw — the only way out
of Raw on a phone, since ⌘E does not exist there either
([ADR 0012](0012-save-state-is-a-statusbar-pip.md)) — is at the bottom of the
shell, which is exactly where the keyboard is.

Nothing about that is fixable inside the document. The space above a soft
keyboard is the only screen a thumb reliably reaches while typing, and it is
the space every platform's own editors put an accessory row in.

## Decision

**While a soft keyboard is covering a focused Raw editor, a bar stands on the
keyboard's top edge carrying Outdent, Indent, Undo, Redo and Done.**
`app/keybar.js` owns it; the markup is static in `app/index.html` and the rules
are base.css §8a.

- **It exists only where a soft keyboard does, and that is MEASURED.** Two
  facts, both published rather than guessed: `kb-up` on `#app` is
  `wireVisualViewport` reporting that the visual viewport is really covered,
  and `raw-focus` is `keybar.js` reporting that the caret is in `#rawArea`. The
  stylesheet draws the bar when both hold. There is no `pointer:` query and no
  width query, so base.css §11's "one axis, viewport width" rule is untouched —
  the question this bar asks is about the KEYBOARD, not about the device, and a
  tablet with a hardware keyboard is on the wrong side of that question at
  every width.
- **A tap never moves the focus.** This is the whole trick and everything else
  is arithmetic: the moment the editor blurs, the keyboard drops, the bar goes
  with it, and the selection the button was about to act on is gone. The bar
  swallows `pointerdown` and `mousedown` — both, because a browser that
  synthesises the compatibility event will otherwise take the focus through the
  one that was left alone — and no button is ever focused (`tabindex="-1"`,
  never focused programmatically). A DISABLED button dispatches no pointer
  event of its own, so `pointer-events: none` lets that tap fall through to the
  bar, which is the element doing the holding.
- **No action lives in the bar.** Indent and Outdent call `indentSelection`,
  the function Tab itself calls, lifted out of the key handler for this;
  Undo/Redo flush the open text run and step the app's one timeline, the same
  two lines ⌘Z runs; Done is the door Esc leaves through,
  `setMode("preview", { silent: true })` — guard and all, so a dirty buffer
  still gets its question. A button that reimplemented a chord would be a
  second answer to a settled question, and the two would drift.
- **The bar publishes its own height as `--keybar`**, and `revealRawCaret`
  subtracts it alongside `--kb`. The line being typed is never underneath the
  bar it is being typed with. The value is `offsetHeight`, which is 0 exactly
  when the stylesheet is hiding the bar, so one read answers both "is it up"
  and "how tall".
- **Undo and Redo go dead when there is no step**, and "no step" counts the run
  still open under the caret. `pendingHistory` alone would grey Undo out for
  the length of the idle window on a doc being typed into for the first time —
  a control dimmed at exactly the moment it is wanted. The chords never had to
  ask, because they flush first and then look; `canStepHistory` is that answer
  without the flush.
- **The agent gets the same door**: `indent_lines` in the WebMCP catalogue,
  wrapping `indentSelection`, refusing with `not-raw` in
  [ADR 0002](0002-http-api-v0-error-shape.md)'s error shape when the raw editor
  is not open.

## Consequences

- A phone can nest a list, unnest it, take back a mis-tap and leave Raw without
  a hardware keyboard. Those were the four things it could not do.
- The bar is 44px tall and its buttons take its whole height: it is reachable
  only by thumb, so base.css §13's touch-target floor is not a nicety here, it
  is the entire audience.
- One more thing reads `--kb`, and one more thing writes a class onto `#app`.
  `wireVisualViewport` remains the single place in the app that can say a soft
  keyboard is up; adding a second measurement of the same fact is how the two
  would come to disagree.
- Deliberately not built: bold/italic/link/heading insertion buttons (the bar
  is the missing KEYS, not a formatting toolbar), a bar anywhere a hardware
  keyboard is, a second way to change the tab size, and anything for the chat
  composer's keyboard — that surface has no Tab semantics to give back.
- `tests/keybar-e2e.test.ts` drives it at the phone viewport with the keyboard
  stood in for by the two published facts, since headless has no keyboard: the
  bar's presence and absence, its bottom edge against the keyboard's top, the
  height it publishes, each of the four verbs, that the caret survives every
  tap, and the tool with its refusal.
