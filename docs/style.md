# Style

Only what a linter cannot enforce. Examples over rules; the codebase itself is
the reference — when unsure, imitate the nearest neighbor.

## Comments

Every module opens with a banner stating what it **owns** and why the seam is
where it is:

```ts
/* ============================================================
   sse.ts — the one POST-SSE response envelope.
   ...why four hand-rolled copies became this module...
   ============================================================ */
```

Inline comments state constraints the code cannot show — never what the next
line does, never the change history. The house register is "why, with the
scar": many comments cite the bug that forced the shape
(`// a gap that never closes must not hold the UI hostage`). Keep that.

## Naming and errors

- Vocabulary comes from `CONTEXT.md` — a `doc`, a `proposal`, a `rev`,
  never synonyms.
- API error bodies are `fail(status, slug, {message, ...})` →
  `{error, message, ...extra}`. Slugs are stable contract (`rev-conflict`,
  `bad-path`); messages are prose and may change. Key order matters: tests
  compare serialized bytes.
- Booleans read as facts (`hasSecrets`, `empty`), functions as verbs, classes
  own nouns (`Vault`, `Trash`, `DocStore`).

## Design defaults

- Pure logic goes module-level and importable; anything threading a resource
  (a path, a connection) gets bound once in a class (`Vault` is the model).
- One owner per concern. Credentials → `Settings`; SSE wire → `sse.ts`; doc
  transactions → `DocStore`. If two files handle one concept, that's a bug of
  shape even when behavior is right.
- Locks live in the module that owns the invariant (`recon.lock` inside
  `DocStore`/`Reconciler`), never in the router.
- No new dependencies without an ADR. The zero-dep bias is load-bearing:
  every dependency is bytes in the build every device precaches (ADR 0040), and
  `tests/secrets.test.ts` structurally depends on the server's import graph
  staying crypto-free.
- UI action buttons sit RIGHT-ALIGNED in their row (`justify-content:
  flex-end`) unless a stronger convention says otherwise (a dialog's own
  footer order, an input+button pair where the button hugs its input). The
  app is installable and phone-first on small screens (ADR 0007/0008), and
  the right edge is where a thumb reaches; a new button earns a left seat
  only with a reason written next to it.
- A REQUIRED field is marked with an asterisk on its label (`.lab .req`),
  and only a field the operation cannot proceed without earns one — a field
  with a working default is optional and stays unmarked, so the mark keeps
  meaning something.

## Tests

- Default to black-box through HTTP or the browser; reach for a direct import
  only when the seam is pure. Name browser suites `*-e2e.test.ts`.
- Shared plumbing goes in `tests/helpers.ts` / `tests/browser.ts` — never
  copy a spawn helper into a test file (five copies of `git()` once lived
  that way).
- While iterating run single files; run `bun run gates` before every commit;
  run the full suite for cross-cutting changes. A full-suite run on a machine
  that sleeps mid-run produces mass browser timeouts — rerun, don't debug.
- **Never assert a fact about the MACHINE and call it a fact about the app.**
  A headless browser's answer to `(hover: hover)` differs between a Mac and a
  Linux CI runner, so a `@media (hover: hover)` rule was measured under one
  answer locally and the other in CI — green here, red there, forever.
  `launchTestBrowser` now pins the pointer profile for every suite; anything
  else environmental (locale, timezone, device pixel ratio, colour scheme) gets
  pinned the same way rather than assumed. Note CDP's
  `Emulation.setEmulatedMedia` does **not** cover `hover`.
- **Do not sample a surface that expires.** A toast lives 1.9s and the next one
  overwrites it, so waiting on `#toastTxt` is a race that a slower machine
  loses on work that in fact succeeded. Record what the page showed (a
  `MutationObserver` log) and assert against the record.

## Gotchas (read before sweeping the repo)

- **`tests/api.test.ts` contains NUL bytes.** `grep`/`rg` silently skip it as
  binary. Any repo-wide sweep must use `grep -a` or a python/bun script, or
  you will "prove" a symbol is unused while that file imports it.
- **CI pins a Bun version (`BUN_VERSION` in the workflow) and your machine
  probably runs a newer one.** They disagree on more than speed: Bun 1.4's TOML
  parser rejects a redefined table where 1.3 accepted it, which flipped a
  terminal-password test from green to red with no code change — and, worse,
  meant that on 1.3 it had been passing while exercising nothing, because the
  unparseable file it built was discarded for defaults. A fixture that feeds a
  PARSER should assert that its own input parses.
- **Four tests assert on source text**, not behavior: `secrets.test.ts`
  (no `age-encryption` import in `server/`), `fileops.test.ts` (no
  rename/delete identifiers in the `ai*.ts` modules; the `OPS` set literal in
  `ai-edits.ts`), `themes-tokens.test.ts` (CSS token discipline) and
  `webmcp.test.ts` (no decrypt/reveal/passphrase identifier in `app/webmcp.js`,
  and every tool name legal and declared once). Reformatting those regions can
  fail CI without a behavior change — read the test first.
- **`bun --hot` keeps `globalThis`** across reloads; module-level state that
  must survive dev reloads relies on this. Don't move it into closures
  casually.
- **The frontend is a build, and the build is cached.** Everything in `app/` is
  bundled (ADR 0040). `bun run dev` sets `ZNOTES_DEV=1`, which rebuilds in memory
  on an `app/` edit and swaps the build; reload the page. A failed rebuild shows
  its error in the boot screen while the API keeps serving. The image build
  (`bun scripts/build.ts`) is what production runs, and bundler output can differ
  between Bun versions. BlockNote's look is overridden in base.css through
  its `--bn-colors-*` properties mapped from the theme tokens; theme files stay
  layout-free (ADR 0003), so a BlockNote override belongs in base.css.
- **`server/search-match.ts` is bundled into the browser.** `app/api.js` imports
  it as `../server/search-match.ts` for offline search (ADR 0041), so it may import
  nothing and use no Bun or node API — a `Bun.` or `node:` there builds fine on
  the server and breaks the browser bundle (or worse, the offline path only).
  `vault.ts` and `db.ts` import their pure rules back from it.
- **`app/index.html` carries one marker, `<!-- znotes:head -->`.** The build
  replaces it with the build id, service-worker and origin metas, the island's
  stylesheet, the `modulepreload` links and the boot script. Delete or rename it
  and the build appends one before `</head>` and fails: the boot screen says
  "The app failed to build" and names the missing marker.
  Never write those tags into the template by hand — they name hashed files.
- **`new Worker` URLs come from `#znotes-assets`.** Bun does not rewrite
  `new Worker(new URL("./x.js", import.meta.url))` (checked on 1.4.0 and 1.4.4),
  and `import.meta.url` names a hashed chunk anyway. The island and crypto-worker
  URLs are read from the shell's `#znotes-assets` JSON; a new worker is a new
  build entry plus a new key there. The same goes for `API_ROOT`:
  `new URL("./", document.baseURI)`, never `import.meta.url`.
- **Comment citations are load-bearing**: code cites `docs/*.md §sections` and
  research docs. If you rename or move a doc, sweep the citations in the same
  change (`bun run lint:docs` catches broken relative links in docs, not in
  code comments).
