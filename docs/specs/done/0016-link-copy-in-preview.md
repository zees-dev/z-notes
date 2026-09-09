# 0016 — A link in Preview carries a copy button

## Problem Statement

Copying a link's URL out of a rendered note is a right-click on the desktop
and a long-press menu on a phone — both slow, both easy to get wrong (the
long-press opens the link half the time). The URL is the thing most often
wanted from a link; there is no one-tap way to take it.

## Solution

Every external anchor Preview renders (`a.xl` — the ADR 0016 `http(s)` /
`mailto` links, all three spellings) is followed inline by a minimal copy
button: the existing `I.copy` icon, muted until hover, that puts the anchor's
`href` on the clipboard through `copyText` (the app's one clipboard writer)
and shows its toast. Preview only — the button is added as a DOM pass after
render in `markdown.js`, so chat bubbles, which also use `inline()`, stay as
they are.

## User Stories

1. As a reader, I want a small copy icon right after each link, so that one
   click copies the URL.
2. As a reader, I want the icon quiet (low opacity) until I hover or focus
   it, so that a link-heavy note is not cluttered.
3. As a phone user, I want a tap on the icon to copy and confirm with the
   usual toast — and never open the link or switch to Raw.
4. As a reader, I want the icon to copy the real target (`href`), not the
   label, so that `[text](url)` copies `url`.
5. As a reader of a `mailto:` link, I want the address copied without the
   `mailto:` scheme, so that the clipboard holds what I would type.
6. As a keyboard user, I want the button focusable and activatable with
   Enter/Space, with an `aria-label`.
7. As a chat user, I want assistant messages unchanged.

## Implementation Decisions

- **markdown.js** — in `renderPreview(doc, host)` (app/markdown.js:148),
  after the document has been built into `host`, one pass:
  ```js
  host.querySelectorAll("a.xl").forEach((a) => a.insertAdjacentElement("afterend", copyLinkButton(a)));
  ```
  with
  ```js
  function copyLinkButton(a) {
    const b = el("button", "lcp", I.copy);
    b.type = "button";
    b.setAttribute("aria-label", "Copy link");
    b.title = "Copy link";
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); copyText(a.href.replace(/^mailto:/i, "")); });
    return b;
  }
  ```
  `copyText` (ui.js) toasts "Copied to clipboard" by default — keep it.
  `stopPropagation` keeps `#scroll`'s click-outside and `previewClickToEdit`
  out of it (the latter already ignores `button`, but the pane's click-away
  handlers are bound higher). Because the button is inserted *after* the
  anchor inside the same `[data-line]` span, line mapping (ADR 0015) and
  click-to-edit line detection are unaffected.
- **CSS (base.css, beside `a.xl` in the rendered-markdown block)**:
  ```css
  .lcp { display: inline-flex; align-items: center; vertical-align: -.1em; margin-left: .2em; padding: .1em; border: 0; border-radius: var(--r-sm); background: none; color: var(--muted-2); opacity: .55; cursor: pointer; line-height: 1; }
  .lcp svg { width: .85em; height: .85em; }
  .lcp:hover, .lcp:focus-visible { opacity: 1; color: var(--accent); background: var(--accent-soft); }
  ```
  On a phone (`@media (max-width: 767px)`), give it a 24px tap target via
  `padding: .25em` — do it inside the existing phone band in §11.
- The button is not inserted in `.msg .bubble` (chat) because the pass lives
  in `renderPreview`, not in `inline()`. Wikilink pills (`.wl`) get no button
  — they already carry an icon and open in-app.
- No WebMCP tool (the clipboard is not an app operation the catalogue models;
  `read_doc` returns the source).

## Testing Decisions

- Seam: the browser. Prior art: `tests/extlinks-e2e.test.ts` (renders every
  external-link spelling and asserts on `a.xl`). Add a `describe` there:
  1. every `a.xl` in the fixture is immediately followed by `button.lcp`
     (`a.nextElementSibling.matches("button.lcp")`), and no `.lcp` exists
     outside `#doc`.
  2. clicking the button after `[text](https://example.com/x)` puts
     `https://example.com/x` on the clipboard (read it back the way
     `tests/ux-e2e.test.ts` does with `navigator.clipboard.readText()` — that
     suite already runs with clipboard permission; copy its setup if this one
     lacks it) and does not switch the mode (`#doc` has no `raw-mode`).
  3. the `mailto:` fixture copies the bare address.
- Three tests.

## Out of Scope

- Copy buttons on wikilinks or in chat bubbles.
- Copying the markdown spelling (`[text](url)`) rather than the URL.
- Share sheets, QR codes, link previews.
- Any change to `inline()` or to the external-link grammar (ADR 0016).

## Further Notes

No ADR — a rendering affordance, not a decision with consequences beyond this
spec. Keep `I.copy` as is; do not add an icon.
