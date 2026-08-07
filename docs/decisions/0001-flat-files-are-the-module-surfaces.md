# 0001 — Flat files are the module surfaces; layering is enforced by lint, not folders

**Status:** accepted · 2026-08-07

## Context

The agent-first architecture this repo adopted (see `AGENTS.md`, workflow
section) prescribes "one folder per module with an `index.ts` surface" as its
deep-module mechanism. z-notes' backend had just been refactored into flat
single-file modules under `server/`, each with a deliberately narrow export
surface (`ai.ts` exports exactly `AI`; consumers receive `Pick`-typed slices),
and its Dockerfile, test harness and source-text assertion tests all address
those flat paths.

## Decision

Keep flat files. A file **is** the module: its export list is the surface, its
non-exported declarations are the internals. The properties folder-per-module
buys (a deliberate surface, no bypass imports, forward-only layering) are
enforced mechanically instead, by `scripts/lint-docs.ts`: a layer table over
`server/*.ts` that fails CI on any backward or same-layer import, and a leaf
rule over `app/*.js`.

## Consequences

- New server modules must be registered in the lint layer table (and
  `docs/architecture.md`) or CI fails with instructions — that step is the
  moment layering is *decided* rather than accreted.
- No `src/` reshuffle: Docker `COPY server/`, `bun server/index.ts`, and the
  three source-text tests keep working untouched.
- If a module ever grows genuine submodules (as `ai.ts` did — split into
  `ai-edits.ts` / `ai-endpoint.ts`), the split stays flat and sibling-named,
  and the layer table gains a row.
