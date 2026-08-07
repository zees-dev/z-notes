---
name: spec
description: Synthesize the current shaping conversation into a self-sufficient implementation spec at docs/specs/open/NNNN-slug.md. Run at the END of a discussion; do not use to start one.
disable-model-invocation: true
---

# /spec — turn this conversation into an implementable spec

You are closing a shaping session. The conversation above contains the intent;
your job is to synthesize it — **not** to interview. Ask questions only where
the conversation is genuinely contradictory or silent on something the
implementation cannot proceed without.

## Process

1. **Synthesize** the conversation into a problem statement and the decisions
   already made. Anything the user rejected goes to Out of Scope.
2. **Ground every claim in the repo as it is now.** Read the touched modules
   (start from `docs/architecture.md`'s table). File paths, type signatures,
   route entries and test names in the spec must be copied from current code,
   not remembered. Use `docs/glossary.md` vocabulary throughout. Check
   `docs/decisions/` for ADRs touching the same area — do not re-litigate
   them silently; if the spec contradicts one, say so explicitly and get the
   user's sign-off.
3. **Propose the test seams before writing.** Prefer seams that already exist
   (the HTTP surface via `tests/helpers.ts`, the browser via
   `tests/browser.ts`, a pure module import). Aim for the highest seam that
   can express the behavior; the ideal number of seams is one. Name the
   prior-art test file the new tests should imitate. Get the user's sign-off
   on the seams, then write.
4. **Write** `docs/specs/open/NNNN-slug.md` — NNNN = next free number across
   both `open/` and `done/`. Run `bun run lint:docs` to confirm the template
   is complete.

## Template (all seven sections, exactly these headings)

```markdown
# NNNN — Title

## Problem Statement
## Solution
## User Stories
## Implementation Decisions
## Testing Decisions
## Out of Scope
## Further Notes
```

- **User Stories** — exhaustive and numbered: "As an X, I want Y, so that Z".
  Cover error paths and degraded modes, not just the happy path.
- **Implementation Decisions** — include precise file paths, current type
  signatures, and decision-encoding snippets. (Deliberate policy: these specs
  are consumed within days; the `done/` archive makes staleness harmless.
  Precision here is what makes one-shot implementation possible.)
- **Testing Decisions** — the agreed seams, what a good test looks like here,
  and the prior-art test file(s) to imitate.
- **Out of Scope** — be generous. The implementing agent has NO other
  conversation context; this section is what stops it wandering.

## Rules

- The spec must be self-sufficient: assume the implementer sees only
  `AGENTS.md`, this spec, and whatever the spec links.
- Do not write any implementation code. Do not commit unless asked; report
  the spec path when done.
