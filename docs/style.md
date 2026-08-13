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

- Vocabulary comes from `docs/glossary.md` — a `doc`, a `proposal`, a `rev`,
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
  the frontend must run unbuilt, and `tests/secrets.test.ts` structurally
  depends on the server's import graph staying crypto-free.
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

## Gotchas (read before sweeping the repo)

- **`tests/api.test.ts` contains NUL bytes.** `grep`/`rg` silently skip it as
  binary. Any repo-wide sweep must use `grep -a` or a python/bun script, or
  you will "prove" a symbol is unused while that file imports it.
- **Three tests assert on source text**, not behavior: `secrets.test.ts`
  (no `age-encryption` import in `server/`), `fileops.test.ts` (no
  rename/delete identifiers in the `ai*.ts` modules; the `OPS` set literal in
  `ai-edits.ts`), `themes-tokens.test.ts` (CSS token discipline). Reformatting
  those regions can fail CI without a behavior change — read the test first.
- **`bun --hot` keeps `globalThis`** across reloads; module-level state that
  must survive dev reloads relies on this. Don't move it into closures
  casually.
- **Comment citations are load-bearing**: code cites `docs/*.md §sections` and
  research docs. If you rename or move a doc, sweep the citations in the same
  change (`bun run lint:docs` catches broken relative links in docs, not in
  code comments).
