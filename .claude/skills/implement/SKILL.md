---
name: implement
description: Implement a spec from docs/specs/open/ end to end — TDD at the spec's agreed seams, gates green, spec archived to done/, durable decisions promoted to an ADR. Takes the spec path as argument.
disable-model-invocation: true
---

# /implement — execute one spec

Input: a path under `docs/specs/open/` (if none given, list that directory and
ask which). Your context assembles by progressive disclosure: `AGENTS.md` →
the spec → the docs the spec links → code through the module surfaces named in
`docs/architecture.md`. Do not go spelunking beyond what the spec and its
pointers reach — the spec's Out of Scope section is binding.

## Process

1. **Read the spec fully.** If it contradicts current code in a way that
   changes the plan (a signature moved, a route renamed), note the delta and
   proceed by the spec's *intent*; flag the drift in your final report.
2. **Tests first, at the seams the spec agreed.** Write the failing tests
   named in Testing Decisions, imitating the prior-art files it cites
   (`tests/helpers.ts` for HTTP-seam tests, `tests/browser.ts` for browser
   suites, direct imports only for pure modules).
3. **Implement** to green. Iterate with single-file runs
   (`bun test tests/<file>.test.ts`); keep `bun run lint:docs` green if you
   touch docs or add a server module (new modules must be added to the layer
   table in `scripts/lint-docs.ts` AND `docs/architecture.md`).
4. **Full check once at the end:** `bun run gates`, plus the full `bun test`
   if the change is cross-cutting.
5. **Review your own diff** (run the repo's code-review skill if available)
   and apply what it finds.
6. **Archive + promote:** `git mv` the spec to `docs/specs/done/`. If the
   spec encoded a durable decision — a schema, an API-contract addition, an
   architectural choice, a new dependency — write it up as a one-page ADR in
   `docs/decisions/NNNN-slug.md` (next free number) in the same change. This
   promotion is what keeps specs from becoming a shadow doc system. Update
   `docs/architecture.md` / `docs/glossary.md` if the change moved a seam or
   coined a term.
7. **Commit to the current branch** — one commit, message explaining the why,
   referencing the spec number.

## Rules

- Behavior outside the spec is frozen: `docs/specs/done/0002-http-api-v0.md` shapes are
  byte-contracts, and the source-text tests listed in `docs/style.md`
  (gotchas) will fail on incidental reformatting — read them before touching
  `server/ai*.ts`, crypto imports, or theme CSS.
- If the spec turns out unimplementable as written, stop and report the
  specific conflict rather than improvising a different design.
