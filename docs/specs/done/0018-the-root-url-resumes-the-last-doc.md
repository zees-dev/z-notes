# 0018 — The root URL resumes the doc you left on

## Problem Statement

Booting at `/` opens the first doc in the tree (app.js `start()`,
`findDocAcross((n) => !n.empty)`), whatever you were reading when you closed
the tab. A person who opens the installed app each morning lands on the same
first file and navigates back to their working note by hand. Reloading a
`/d/<path>` URL already keeps the doc (ADR 0007's routing); the bare root is
the one entry point that forgets.

The vault button's target, `editor.homeDoc`, is the one "default page" the
app has, and the root URL does not honour it either.

## Solution

At the root URL, the boot opens, in order, the first that exists in the tree:

1. the **last doc opened in this browser** (`localStorage` `znotes.last-doc`,
   a qualified path, written on every successful `openDoc`);
2. the configured **home doc** (`editor.homeDoc`, via `homeTarget()`);
3. the first non-empty doc, then the first doc (today's rule).

A `/d/<path>` URL is untouched: it opens that doc (or, when it does not
exist, toasts and falls through the same ladder). `/settings` deep links keep
opening a doc behind the page — the same ladder decides which.

## User Stories

1. As a user, I want reopening the app at `/` to show the doc I was last
   reading, so that I continue where I left off.
2. As a user, I want a reload of `/` to behave the same as reopening.
3. As a user who pasted a `/d/<path>` link, I want that doc, not my last one.
4. As a user whose last doc was deleted or renamed, I want the root to fall
   back to the home doc (or the first doc) without an error.
5. As a user with a home doc configured and no history in this browser, I
   want `/` to open the home doc.
6. As a user in private mode or with storage disabled, I want today's
   behaviour (first doc).
7. As a user of two vaults, I want a last doc in a secondary vault
   (`@id/...`) to resume too.

## Implementation Decisions

- **editor.js `openDoc`** — after `state.active = path;` (editor.js:~990) and
  before `routeDoc`, remember: `rememberLastDoc(path)` — a tiny helper in
  shell.js beside the routing code (it is address-shaped state):
  ```js
  const LAST_DOC = "znotes.last-doc";
  export function rememberLastDoc(path) { try { localStorage.setItem(LAST_DOC, path); } catch (_) {} }
  export function lastDoc() { try { return localStorage.getItem(LAST_DOC) || ""; } catch (_) { return ""; } }
  ```
  Every open writes, including boot and `replace` re-homes — what is on
  screen is what to resume.
- **shell.js** — `export function bootDoc(wanted)`: the ladder above, using
  `state.docPaths.has()` for existence, `lastDoc()`, `homeTarget()`,
  `findDocAcross`. Returns the path or `""`.
- **app.js `start()`** — replace the `first = (wanted && …) || findDocAcross…`
  expression with `const first = bootDoc(wanted);`. Keep the "No such doc"
  toast for a `wanted` that was not honoured.
- **tests/browser.ts `newAppPage`** — a browser profile is shared by every
  page a suite opens, so without a reset the second test of every existing
  suite would boot on whatever the first test opened. Add
  `resume?: boolean` to `NewPageOptions`; unless `opts.resume`, register an
  `evaluateOnNewDocument` that does
  `try { localStorage.removeItem("znotes.last-doc") } catch {}` BEFORE the
  user's `beforeLoad`. Suites that call `browser.newPage()` directly and boot
  at `/` (tests/e2e.test.ts, fileops-e2e, secrets-e2e, lifecycle-e2e,
  leak, routing, sse-watchdog-e2e, secrets-ui, trash-e2e, crypto-worker —
  check each) must get the same reset where they assert which doc opened;
  the cleanest is to route them through `newAppPage`, but a one-line
  `evaluateOnNewDocument` beside their `newPage()` is acceptable. Run every
  e2e suite once at the end; a suite that starts asserting the wrong doc is
  a missed reset, not a product bug.
- **Docs**: ADR `docs/adr/00NN-the-root-url-resumes-the-last-doc.md`
  (next free number): `/` means "where you were", the ladder, the reset the
  harness performs and why. Update the routing comment in shell.js (§ "the
  URL shape", ~line 697) and the boot comment in app.js. AGENTS.md digest:
  one sentence. `docs/architecture.md`'s "where the frontend's state lives"
  paragraph: `znotes.last-doc` joins the per-browser list.

## Testing Decisions

- Seam: the browser. Prior art: `tests/routing.test.ts` ("routing — deep
  links and reloads": "a hard reload keeps the doc…", "booting at / lands on
  a doc…").
- Add a `describe("routing — the root resumes")` to `tests/routing.test.ts`
  using `newAppPage(browser, { resume: true })`:
  1. open doc B (not the first doc) via the tree; `goto(base + "/")` → the
     pane and the URL show B.
  2. `goto(base + "/d/" + enc(A))` → A; then `goto("/")` → A (the last open
     wins).
  3. delete B through the API while the stored last doc is B → `goto("/")`
     lands on the home doc when one is set (PUT settings `editor.homeDoc`)
     and on the first doc otherwise; no page error.
  4. with the store cleared (`localStorage.removeItem`) and `editor.homeDoc`
     set to C → `goto("/")` lands on C.
  5. a page WITHOUT `resume` (the default harness) boots at `/` on the first
     doc even after B was opened in another page — the reset works.
- Five tests.

## Out of Scope

- Remembering the mode (Raw/Preview) or the scroll position.
- Server-side or cross-device sync of the last doc.
- Changing the vault button (`goHome`) or the settings page.
- Remembering the settings page as a destination.

## Further Notes

`znotes.last-doc` is a cache of a place, not a setting: an entry that names a
doc the tree no longer has is simply skipped and overwritten by the next
open. Do not prune it on delete; the ladder handles absence.
