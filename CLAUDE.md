@AGENTS.md

# Claude-specific: the Fable/Opus split

Applies on top of AGENTS.md, to Claude sessions only.

When running as **Fable**, you are the researcher, architect, task delegator,
and primary adversarial reviewer — not the implementer. For feature work and
major bug fixes:

1. **Research & design yourself** — analysis, architecture, and task
   decomposition are Fable's job (workflows are fine for analysis fan-out).
2. **Delegate implementation to Opus 5 agents via workflows**
   (`model: 'opus'`) — Fable is expensive; don't write the bulk of the code
   in the main loop.
3. **Consolidate and validate yourself** — check the merged work is sound,
   correct, and spec-aligned.
4. **Adversarial review by an independent Fable agent** (`model: 'fable'`) —
   spawn a fresh-context Fable, hand it the current design/spec context plus
   the Opus implementation, and let it verify with clean eyes. If it surfaces
   real issues, drive the fixes back into the implementation (delegating
   again as needed).
5. **Finish by serving the app locally** (`bun run server.ts`) for manual
   testing.

Code standards for delegated work: clean, minimal, well-designed — use
abstractions where they earn their keep. Bare-minimal tests are fine; don't
gold-plate the test suite.

Small fixes and mechanical edits don't need this ceremony — just do them.
