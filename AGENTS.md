# z-notes — agent map

Single-user Markdown notes app; files on disk are the source of truth. One Bun process serves a
no-build frontend, JSON/SSE API, client-side (age) secrets, git sync, AI edit relay and gated terminal.

## Layout

- `server/` — the backend. Flat files, each a deep module with a deliberate export surface;
  `index.ts` is the composition root + route table, `vaults.ts` the vault registry it routes through.
  Forward-only layering (`bun run lint:docs`): `vault db http sse` → `settings watch ai-edits` →
  `trash ai-endpoint` → `git terminal` → `ai docs` → `vaults` → `index`.
- `app/` — the frontend. ES modules served as-is, plus one React island the server bundles at boot:
  `block-editor.tsx`, the BlockNote editor (Edit) over `markdown-source.ts`, a byte-preserving MDAST
  adapter (ADR 0037). Leaf modules (`state ui api armor entropy dialogs crypto-worker history
  markdown-source`) never import feature modules; `history` reaches editor.js/tree.js through injected
  callbacks (ADR 0014). `webmcp.js` wraps every UI operation as a WebMCP tool (ADR 0031). `icons/` is
  COMMITTED generator output (ADR 0007).
- `docs/` — the knowledge base; [API](docs/specs/done/0002-http-api-v0.md) is normative, [product](docs/specs/done/0001-z-notes-v1.md) the product spec.
- `tests/` — black-box by default (real server, real Chromium); `helpers.ts` +
  `browser.ts` are the harness, `mock-upstream.ts` fakes the AI endpoint. `bun run
  gates` = five acceptance suites plus `mermaid-e2e`: a fence is untrusted input
  (ADR 0010) and its hardening must not regress quietly.
- `deploy/` — Dockerfile + k3s manifests; `deploy/README.md` is the runbook.
- `.agents/skills/` — canonical skills (`spec implement clean-code`), symlinked from `.claude/skills/`.
  `CONTEXT.md` is domain language only; `docs/` is design only; `scripts/lint-docs.ts` enforces the shape.
- `vaults/` — NOT in this repo (gitignored). Bring-your-own (ADR 0017), plural (ADR 0018): `ZNOTES_VAULTS_DIR`
  (default `./vaults`) holds one subdirectory per vault, the primary at `ZNOTES_VAULT` (default `./vaults/vault`).

## Commands

```sh
bun run dev          # bun --hot server/index.ts on :4700
bun test [tests/X.test.ts]  # full suite ~5 min (--parallel=4, servers + Chromium); one file while iterating
bun run gates        # the 6 acceptance gates (~70 s) — run before every commit
bun run lint:docs    # docs/link/layering/spec-template enforcement (CI runs it)
```

## Docs taxonomy (five durable types + one transient)

- [docs/architecture.md](docs/architecture.md) — module map, interfaces, layering, where state
  lives. Start here before touching structure.
- [docs/style.md](docs/style.md) — conventions linters can't enforce, and the repo's sharp edges ("gotchas").
- [CONTEXT.md](CONTEXT.md) — domain language only, with banned synonyms. Use these words.
- [docs/adr/](docs/adr/) — one-page decisions that hold today; [README](docs/adr/README.md) is the narrative.
- [docs/specs/](docs/specs/) — work specs. `open/` = transient, awaiting implementation (written by
  `/spec`); `done/` = the archive, holding the five founding specs (0001 product, 0002 the normative
  HTTP/SSE contract, 0003 theming, 0004 secrets crypto, 0005 the Bun platform research).

## Workflow

Shaping happens in conversation → `/spec` writes `docs/specs/open/NNNN-slug.md`
(self-sufficient; the implementing agent gets no other context) → `/implement`
executes it TDD-at-the-agreed-seams, moves the spec to `done/`, and promotes any
durable decision to an ADR in the same change. Features and major bug fixes take the
pipeline below; small fixes and mechanical edits are done directly.

| Harness | Coordinator | Implementers | Fresh independent reviewer | Delegation |
| --- | --- | --- | --- | --- |
| Claude | Fable (high) | Opus 5 (`opus`, max) | Fable (`fable`, high) | Workflows |
| Codex | `gpt-6-astra` (high) | `gpt-6-astra` (medium) | `gpt-6-astra` (high) | native agent threads |

Select child models explicitly and verify them through the harness's own controls; prompt text is not
configuration. If a model or native delegation cannot be selected, stop and ask; no silent fallback.
Delegation never authorizes super.engineering orchestration, worktrees, commits or deployment.

1. **Coordinator researches, designs, decomposes**: reads code, ADRs and spec; settles decisions; defines
   tasks, file ownership, dependencies and acceptance criteria. Analysis fan-out is fine.
2. **Separate agents implement** from that brief, independent tasks in parallel, never two on one file.
   The coordinator does not write the bulk of the code. Clean, minimal; an abstraction earns its keep.
3. **Coordinator consolidates and validates** the merged diff against the spec, not the agents' reports.
4. **A fresh agent reviews adversarially** with spec, constraints and diff, never a reused implementation
   thread. The coordinator triages, delegates real fixes, and re-reviews until clean.
5. **Coordinator verifies the running app** (`bun run dev`, the e2e harness) by measurement, never by
   eye; then `/clean-code`, `bun run gates`. Report checks and blockers honestly.

Never commit or push unless the user asks. Every agent applies the repo-owned `clean-code` skill
before any `git commit`, then runs `bun run gates` and `bun run lint:docs`.

## Principles

- **Knob before code.** An existing setting, preference or seam before a new one.
- **Smallest change that works**, in the layer that owns the boundary, reusing what exists.
- **Documented behaviour is design, not a bug.** Changing it changes the ADR and spec too; say so.
- **Deletion over addition, boring over clever.** Bare-minimal tests; do not gold-plate the suite.

## Rules that bite

- **Verify by measurement, never by eye**: browser assertions, byte comparisons, live probes.
- The API contract is `docs/specs/done/0002-http-api-v0.md` — behavior-preserving unless a spec says
  otherwise. Error bodies are `{error, message, ...extra}`, key order included.
- The server never sees a passphrase or plaintext secret. Nothing in `server/` may import
  `age-encryption` — `tests/secrets.test.ts` enforces it.
- The AI relay has no route to rename/delete (`tests/fileops.test.ts` greps all three `ai*.ts`); one
  deploy replica, ever (sqlite + fs.watch + git working tree; `deploy/k3s/20-deployment.yaml`).
- Runtime deps are exactly pinned: `age-encryption` plus the BlockNote/React/MDAST editor set (ADR 0037),
  bundled by the server at boot — no separate build command. Any further dependency is an ADR.
- Source-text tests (`docs/style.md` gotchas) fail on incidental reformatting of `server/ai*.ts`,
  crypto imports and theme CSS. `tests/api.test.ts` holds NUL bytes: grep skips it silently.
- `bun run lint:docs` enforces: this file ≤100 lines, resolving links, server layering, spec templates.
