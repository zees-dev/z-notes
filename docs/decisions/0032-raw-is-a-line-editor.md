# 0032 — Raw is a line editor

## Status

Accepted, 2026-09-10. Implements
[spec 0014](../specs/done/0014-raw-is-a-line-editor.md). Amends
[ADR 0013](0013-a-collapsed-caret-makes-x-and-c-take-the-line.md) — the
editing command is the editor's own write primitive now, not
`document.execCommand` — and
[ADR 0027](0027-a-mode-switch-keeps-the-line-you-were-on.md) — position is
still measured, but on the real DOM rather than on a mirror of it. Rests on
[ADR 0014](0014-file-operations-undo-but-they-ask.md), which is what made the
browser's own undo stack dispensable.

## Context

Switching from Preview to Raw changed the size of every line. Preview body copy
is `--d-font` (13.4px comfy) in the document family, an `h1` is `--h1-size`
(1.95em ≈ 26px); Raw was one `<textarea>` at `--d-raw-fs` (12.1px), mono, and
16px on a phone because of the §12 iOS zoom floor. A heading that was 26px
became 12px, a paragraph moved by a pixel and a family, and the document
visibly lurched on every click-to-edit and every ⌘E. ADR 0027 keeps the *line*
under the reader; it cannot keep the *size*.

Links were the same story one level down: Preview colours `[text](url)`,
`<url>`, bare URLs and `[[wikilinks]]`; Raw showed them as plain text, so the
one mode where you edit a link is the one mode that would not show you where
it was.

A `<textarea>` has exactly one font size. Per-line typography — a heading line
at the heading size, a body line at the body size — is not expressible in it at
all, and neither is colouring a range. The one thing a textarea gave that a
`contenteditable` does not is the browser's native undo stack, and ADR 0014
took ⌘Z away from the browser two releases ago: the app owns one timeline
across documents, because a per-element stack dies at every doc switch and can
never reach an edit in another file. There was nothing left to lose.

## Decision

**Raw is a `contenteditable` line editor: one block element per source line,
sized by what that line is, with links painted through the CSS Custom Highlight
API.** `app/rawedit.js` owns it; `app/editor.js` keeps its vocabulary.

- **A Raw line is the size and leading of the Preview block it would render
  as.** Body lines inherit the document size — the same `--d-font` `.md p`
  gets — and `#`/`##`/`###` lines take `--h1-size`/`--h2-size`/`--h3-size` with
  the weights, tracking and line-heights `.md h1/h2/h3` use. Lines inside a
  fenced block are never headings, because Preview does not make them one. The
  family stays mono; `--font-raw` is the one knob a theme needs to opt out.
- **The seam is the textarea's own surface.** The element answers to `value`,
  `selectionStart`/`selectionEnd`, `setSelectionRange`, `placeholder`, `wrap`
  and `focus`, and fires `input`, `select`, `copy`, `cut` and `paste`. Tab,
  list continuation, the whole-line clipboard, ⌘⇧E, the mode-switch anchoring
  and every test that reads `.value` therefore did not have to change. It adds
  exactly two verbs of its own: `replaceRange` and `boxAt`.
- **There are exactly two write paths and no third.** `replaceRange` — the
  model first, then only the line nodes the edit spans, so every other line
  keeps its identity and the browser's caret, IME state and scroll anchoring do
  not move. And `reconcile` — what the browser did without a cancelable
  `beforeinput`: an IME composition, or an edit performed behind the app's
  back. It reads the DOM, believes it, and normalises the shape back when the
  user is not mid-composition. A quirk neither covers is a bug in the
  reconcile's normalisation, never a special case in `editor.js`.
- **A link is a highlight, never a node.** `::highlight(raw-link)` over ranges
  computed from the text. A `<span>` around a URL would be an element appearing
  and disappearing under the caret while somebody types into it, which is how
  an editor loses an IME composition. A browser without `CSS.highlights` shows
  plain text, and one that rejects `contenteditable="plaintext-only"` falls
  back to `true` — the editor intercepts input itself, so the buffer is plain
  text either way.
- **`.raw` leaves the §12 iOS zoom floor.** It is not a form field any more,
  and Safari zooms on focus into fields. The floor was also the largest
  Preview→Raw size jump in the app: 16px mono against 13.4px Preview.
- **ADR 0027's measurement moves to the real DOM.** `boxAt(offset)` builds a
  `Range` in the live editor instead of mirroring the textarea's single
  typography — which could never have said that a heading line is taller than a
  body line. "Measured, never multiplied" is unchanged; what it measures is.
- **ADR 0013's whole-line ⌘X/⌘C/⌘V is unchanged in behaviour**, but its edits
  go through `replaceRange`. `execCommand` was only ever there to reach the
  textarea's undo stack.

## Consequences

- Preview ↔ Raw no longer resizes the document; ⌘E and click-to-edit are
  visually still, which is what ADR 0027 was reaching for.
- Links are visible while you edit them, and a URL inside backticks or a fence
  stays plain — the same exclusions the renderer makes.
- The Raw buffer is exact by construction: `value` is `lines.join("\n")`, so a
  trailing newline, tabs and runs of spaces survive a round trip, and `copy`
  and `cut` serialise from the model rather than from the browser's idea of a
  block-per-line DOM.
- `--d-raw-fs` / `--d-raw-lh` survive with one reader left, the terminal
  scrollback.
- The cost is a real editor's worth of code in one module, and an input surface
  the app now owns end to end. Composition and dictation paths cannot be
  exercised headless; they are reasoned about in `rawedit.js` and rest on the
  one rule that no node moves while `isComposing` is true.
