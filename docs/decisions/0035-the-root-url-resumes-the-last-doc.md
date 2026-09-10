# 0035 — The root URL resumes the doc you left on

## Status

Accepted, 2026-09-10. Implements
[spec 0018](../specs/done/0018-the-root-url-resumes-the-last-doc.md).
Builds on [ADR 0007](0007-installable-web-app.md) (the app is installable,
and its start URL is `/`) and the routing rules in
[spec 0002](../specs/done/0002-http-api-v0.md).

## Context

Every URL in this app is a place except one. `/d/<path>` names a doc and
reloads onto it; `/settings` names the settings page and deep-links to a
section. The bare root named nothing, so boot fell straight to "the first
non-empty doc in the first vault that has one" — alphabetical, and almost never
what the person opening the app was reading.

That is the entry point that matters most: `manifest.json` starts the installed
app at `/`, and so does a bookmark, the home-screen icon and a plain
`znotes.lan` typed into a browser. Opening the app every morning on the same
first file, then navigating back to the note you were in the middle of, is a
chore the app already had the information to avoid — and `editor.homeDoc`, the
one "default page" the product has, was not honoured there either.

## Decision

**`/` means "where you were", resolved against the tree at boot.**
`shell.js bootDoc(wanted)` returns the first rung that exists in
`state.docPaths`:

1. `wanted` — the doc a `/d/<path>` URL named. A link is a request for THAT
   doc and outranks the rest; an unhonoured one still costs the same "No such
   doc" toast it always did.
2. `znotes.last-doc` — the last doc this browser opened.
3. `editor.homeDoc` (via `homeTarget()`), the configured home doc.
4. The first doc: `findDocAcross((n) => !n.empty) || findDocAcross(() => true)`
   — today's rule, now written once as `firstDoc()` and shared with the home
   button's fallback.

- **The store is written by `openDoc`**, beside `state.active` and for every
  open — boot, a tree click, a `[[link]]`, a ⌘K pick, and the programmatic
  re-homes that carry `replace`. What is on screen is what to resume, so there
  is no second rule about which opens count.
- **It is a cache of a place, not a setting**: per browser, never synced, never
  in `settings.toml`. An entry naming a doc the tree no longer has is skipped
  by the ladder and overwritten by the next open — nothing prunes it on delete
  or rename, because absence is already handled.
- **Storage failure is not an error.** Both accessors are wrapped; a browser in
  private mode or with site data disabled degrades to rungs 3 and 4, which is
  exactly today's behaviour.
- A qualified path resumes like any other, so a doc in a secondary vault
  (`@id/...`, ADR 0018) comes back too.

## Consequences

- `/` no longer survives a page load: boot replaces it with the resolved doc's
  `/d/` URL, as it always did. Nothing routes back to the bare root.
- **The e2e harness has to forget.** A puppeteer profile is shared by every
  page a suite opens, so without a reset the second test of every suite would
  boot on whatever the first one happened to leave on screen.
  `tests/browser.ts` therefore clears `znotes.last-doc` on every document a
  `newAppPage` loads, before any app code runs; `forgetLastDoc(page)` does the
  same for the suites that build their pages by hand. `newAppPage(browser,
  { resume: true })` opts back in, and is what the resume tests use.
- A vault whose `editor.homeDoc` names a real doc now decides where a fresh
  browser lands, not just where the home button goes. The shipped default
  (`index.md`) does not exist in most vaults, so it changes nothing until
  someone creates one.
- Deliberately not remembered: the mode (Raw/Preview), the scroll position, and
  the settings page as a destination. `/` resumes a document, not a session.
