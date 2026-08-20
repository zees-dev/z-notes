# z-notes — agent map

Single-user Markdown-oriented notes app; editable files on disk are the source of truth.
One Bun process serves a no-build frontend, JSON/SSE API, client-side (age) secrets, git sync, AI edit relay and gated terminal.

## Layout

- `server/` — the backend. Flat files, each a deep module with a deliberate export
  surface; `index.ts` is the composition root + route table, `vaults.ts` the vault
  registry it routes through. Forward-only layering (enforced by
  `bun run lint:docs`): `vault db http sse` → `settings watch ai-edits` →
  `trash ai-endpoint` → `git terminal` → `ai docs` → `vaults` → `index`.
- `app/` — the frontend. ES modules, no build step, no runtime deps. Leaf modules
  (`state ui api armor entropy dialogs crypto-worker history`) never import
  feature modules — `history` reaches editor.js and tree.js through callbacks
  the composition root injects (ADR 0014), the same shape `wireDialogs` uses.
  `manifest.json` + `icons/` make it installable (ADR 0007); the icons are drawn by
  `bun scripts/make-icons.ts` and committed — regenerate them if the mark changes.
  `vendor/mermaid.js` is the same deal (ADR 0010): a COMMITTED bundle written by
  `bun scripts/build-mermaid.ts`, regenerated when the pinned mermaid version
  moves. Both are generators, not build steps.
- `docs/` — the knowledge base; [API](docs/specs/done/0002-http-api-v0.md) is
  normative and [product](docs/specs/done/0001-z-notes-v1.md) is the product spec.
- `tests/` — black-box by default (spawn the real server / a real Chromium).
  `helpers.ts` + `browser.ts` are the shared harness; `mock-upstream.ts` fakes the
  AI endpoint. `bun run gates` = the five acceptance suites, plus
  `mermaid-e2e` — a fence is untrusted input (ADR 0010) and its hardening is
  the one thing here that must not regress quietly.
- `deploy/` — Dockerfile + k3s manifests; `deploy/README.md` is the runbook.
- `vaults/` — NOT part of this repo (gitignored). Vaults are bring-your-own
  (ADR 0017) and plural (ADR 0018): `ZNOTES_VAULTS_DIR` (default `./vaults`) is
  the home, one subdirectory per vault, the primary among them at
  `ZNOTES_VAULT` (default `./vaults/vault`).

## Commands

```sh
bun run dev          # bun --hot server/index.ts on :4700
bun test             # full suite (~12 min: spawns servers + headless Chromium)
bun test tests/X.test.ts   # one file — do this while iterating
bun run gates        # the 6 acceptance gates (~70 s) — run before every commit
bun run lint:docs    # docs/link/layering/spec-template enforcement (CI runs it)
```

## Docs taxonomy (five durable types + one transient)

- [docs/architecture.md](docs/architecture.md) — module map, interfaces, layering,
  where state lives. Start here before touching structure.
- [docs/style.md](docs/style.md) — conventions linters can't enforce, and the
  repo's sharp edges (read the "gotchas" section before sweeping the repo).
- [docs/glossary.md](docs/glossary.md) — domain vocabulary + banned synonyms.
  Use these words in code, docs, commits.
- [docs/decisions/](docs/decisions/) — append-only one-page ADRs. Respect them;
  new durable decisions get promoted here by `/implement`.
- [docs/specs/](docs/specs/) — work specs. `open/` = transient, awaiting
  implementation (written by `/spec`); `done/` = the archive. The five founding
  specs live there: 0001 product, 0002 the normative HTTP/SSE contract, 0003
  theming, 0004 secrets crypto, 0005 the Bun platform research. Their durable
  rules are ADRs 0002–0004 — amended later by
  0006 (0004's passphrase floor is advice, not a gate), 0007 (the app is
  installable) and 0008 (on a phone, Back unwinds layers before it leaves).
  0010 (mermaid is a committed bundle, and a fence is untrusted input) and
  0011 (token counts are an estimate) came out of the dependency audit. 0012
  moves 0001's save chrome (the topbar Save button and its permanent pill) to a
  statusbar pip plus a topbar mark that appears only when there is something to
  save; 0013 gives a collapsed caret in Raw the whole-line ⌘X/⌘C/⌘V; 0014
  makes ⌘Z/⌘⇧Z ONE app-owned timeline across documents — text edits and file
  operations in the order they happened, navigating to each step's doc, the
  file ones behind a prompt (`app/history.js`). 0015 gives Preview the source's
  line structure — one newline is one line break, one blank line one blank line
  (amending 0001's soft-break and blank-multiplicity rules) — and every rendered
  line its own `[data-line]`. 0016 renders external URLs as real new-tab
  anchors — http(s)/mailto only; `javascript:` and the rest stay literal text.
  0017 makes the vault bring-your-own — external to this repo, any directory
  qualifies, and attach is the one place `git init` may run. 0018 makes vaults
  plural: the primary keeps today's bare paths and all app-level state,
  secondary vaults are `@id/`-prefixed stacks under the vaults home, and `@` is
  a reserved path segment. 0019 makes explicit extensions literal, 0020 puts
  moves on history, 0021 defines Preview's tested Markdown dialect, 0022 makes asking before a dirty Raw exit a default-on preference, 0023 folds Preview's sections without touching a byte, 0024 drags a folder with its subtree, and 0025 moves the chat panel's second chord to ⌥C so ⌘C is always copy.

## Workflow

Shaping happens in conversation → `/spec` writes `docs/specs/open/NNNN-slug.md`
(self-sufficient; the implementing agent gets no other context) → `/implement`
executes it TDD-at-the-agreed-seams, moves the spec to `done/`, and promotes any
durable decision to an ADR in the same change.

## Hard rules

- The API contract is `docs/specs/done/0002-http-api-v0.md` — behavior-preserving unless a spec says
  otherwise. Error bodies are `{error, message, ...extra}`, key order included.
- The server never sees a passphrase or plaintext secret. Nothing in
  `server/` may import `age-encryption` — `tests/secrets.test.ts` enforces it.
- The AI relay has no route to rename/delete — `tests/fileops.test.ts`
  greps the source of all three `ai*.ts` modules to prove it.
- One deploy replica, ever (sqlite + fs.watch + git working tree; see
  `deploy/k3s/20-deployment.yaml`).
- Zero runtime deps beyond `age-encryption` and `diff`; no frontend
  build step. Adding a dependency is an ADR-sized decision.
