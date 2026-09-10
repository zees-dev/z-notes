---
name: clean-code
description: Simplify code that already works. Run it after a feature or major change, whenever the user asks to clean, simplify, tidy, shorten, unslop or de-bloat code, and as the mandatory final cleanup before every commit in this repo. Same behaviour in, fewer lines out, nothing committed.
---

# Clean code

A pass over code that already works. Behaviour stays. Lines go. A change is a
reduction or a clearer approach, never a new capability and never a lost one.
This is every agent's mandatory pre-commit pass; the caller commits afterward.

## Scope

- The files the feature or change touched, and the callers they route
  through. Not the whole app.
- Read every file in scope end to end and trace the flow before editing. A
  smaller diff in the wrong place is a second bug.
- Never touch `package.json`, `bun.lock`, `deploy/`, `docs/specs/done/` or
  `docs/adr/`. A dependency change is not a cleanup; a decision change
  is a spec.

## The ladder

For every function, branch and helper in scope, stop at the first rung that
holds:

1. Does it need to exist? Dead code, a speculative branch, a setting for a
   value that never changes, an interface with one implementation, a wrapper
   with one caller: delete it and say so.
2. Does this codebase already do it? Reuse the helper, type or pattern a few
   files over. Reimplementing what exists nearby is the commonest bloat.
3. Does Bun or a node builtin do it? `Bun.file`, `Bun.$`, `Bun.Glob`,
   `node:path`, `node:fs`. In `app/`, the platform: the DOM, `URL`, `Intl`.
4. Does an installed dependency do it? Use it. Never add one (ADR-sized).
5. Can it be one line? One line.
6. Otherwise, the minimum code that works, in the shared function every
   caller routes through.

Rules that hold on every rung:

- Deletion over addition. Boring over clever.
- A guard belongs where all callers pass, not in each caller.
- Keep validation at trust boundaries, error handling that prevents data
  loss, the gates, and every constraint a comment names. Those are not bloat.
- The source-text tests in `docs/style.md` (gotchas) fail on incidental
  reformatting of `server/ai*.ts`, crypto imports and theme CSS. Read them
  before touching those files.
- Layering is forward-only (`bun run lint:docs`); a helper moves down a
  layer only if every importer sits above it.
- A simplification with a real ceiling gets one comment naming the ceiling
  and the upgrade path.

## The words in the code

Comments, doc headers, tool descriptions, prompt snippets, dialog strings,
error messages. The same pass applies:

- A comment states a constraint, not narration. Delete one that restates the
  line below it.
- Plain words. "use" not "utilize", "is" not "serves as", "because" not "due
  to the fact that". Cut "crucial", "robust", "seamless", "leverage",
  "ensure", "enhance".
- No em dashes, no filler, no hedging, no "not just X but Y". One idea per
  sentence. Active voice, naming the actor.
- Use the glossary's words (`CONTEXT.md`), never its banned synonyms.
- Error bodies stay `{error, message, ...extra}` in that key order (ADR 0002).

## Procedure

1. Trace, then edit. Smallest diff that holds behaviour, fewest files.
2. Run the checks, no more than the job needs:

   ```sh
   bun test tests/<touched>.test.ts   # while iterating
   bun run gates && bun run lint:docs # once at the end
   ```

   A test that breaks because the code it asserted is gone, or now asserts
   the same thing twice, is updated or removed with that code. A test that
   breaks because behaviour changed means the edit is wrong: revert that
   edit, not the test.
3. Return the clean, checked tree without committing; the caller commits afterward.
4. Report the added and removed line counts from `git diff --shortstat`,
   and the one or two changes worth knowing about. A reduction is the
   expected outcome. If a file grew, say which and why.
