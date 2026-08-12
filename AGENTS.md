# z-notes — agent map

Single-user markdown notes app. Files on disk are the source of truth; the app is a
view over them. One Bun process serves a no-build vanilla-JS frontend, a JSON/SSE
API, client-side (age) secrets, git sync, an AI edit relay and a gated terminal.

## Layout

- `server/` — the backend. Flat files, each a deep module with a deliberate export
  surface; `index.ts` is the composition root + route table. Forward-only layering
  (enforced by `bun run lint:docs`): `vault db http sse` → `settings watch ai-edits`
  → `trash ai-endpoint` → `git terminal` → `ai docs` → `index`.
- `app/` — the frontend. ES modules, no build step, no runtime deps. Leaf modules
  (`state ui api armor entropy dialogs crypto-worker history`) never import
  feature modules — `history` reaches editor.js and tree.js through callbacks
  the composition root injects (ADR 0014), the same shape `wireDialogs` uses.
  `manifest.json` + `icons/` make it installable (ADR 0007); the icons are drawn by
  `bun scripts/make-icons.ts` and committed — regenerate them if the mark changes.
  `vendor/mermaid.js` is the same deal (ADR 0010): a COMMITTED bundle written by
  `bun scripts/build-mermaid.ts`, regenerated when the pinned mermaid version
  moves. Both are generators, not build steps.
- `docs/` — the knowledge base; see the taxonomy below. `docs/specs/done/0002-http-api-v0.md` is the
  normative HTTP/SSE contract; `docs/specs/done/0001-z-notes-v1.md` is the product spec.
- `tests/` — black-box by default (spawn the real server / a real Chromium).
  `helpers.ts` + `browser.ts` are the shared harness; `mock-upstream.ts` fakes the
  AI endpoint. `bun run gates` = the five acceptance suites, plus
  `mermaid-e2e` — a fence is untrusted input (ADR 0010) and its hardening is
  the one thing here that must not regress quietly.
- `deploy/` — Dockerfile + k3s manifests; `deploy/README.md` is the runbook.
- `vault/` — NOT part of this repo. The vault is external and bring-your-own
  (ADR 0017): `ZNOTES_VAULT`, default `./vault`, gitignored local scratch.

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
  specs live there: 0001 product ("SPEC §N" in code = its section N), 0002 the
  normative HTTP/SSE contract, 0003 theming, 0004 secrets crypto, 0005 the Bun
  platform research. Their durable rules are ADRs 0002–0004 — amended later by
  0006 (0004's passphrase floor is advice, not a gate), 0007 (the app is
  installable) and 0008 (on a phone, Back unwinds layers before it leaves).
  0010 (mermaid is a committed bundle, and a fence is untrusted input) and
  0011 (token counts are an estimate) came out of the dependency audit. 0012
  moves 0001's save chrome (the topbar Save button and its permanent pill) to a
  statusbar pip plus a topbar mark that appears only when there is something to
  save; 0013 gives a collapsed caret in Raw the whole-line ⌘X/⌘C/⌘V; 0014
  makes ⌘Z/⌘⇧Z ONE app-owned timeline across documents — text edits and file
  operations in the order they happened, navigating to the doc each step is
  about, with the file ones behind a prompt (`app/history.js`). 0015 gives
  Preview the source's line structure: one newline is one line break, one blank
  line is one blank line (it amends 0001's soft-break and blank-multiplicity
  rules), and every rendered line carries its own `[data-line]`. 0016 renders
  external URLs (`[text](url)`, `<url>`, bare) as real new-tab anchors —
  http(s)/mailto only; `javascript:` and everything else stays literal text.
  0017 makes the vault bring-your-own — external to this repo, any directory
  qualifies, and attach is the one place `git init` may run.

## Workflow

Shaping happens in conversation → `/spec` writes `docs/specs/open/NNNN-slug.md`
(self-sufficient; the implementing agent gets no other context) → `/implement`
executes it TDD-at-the-agreed-seams, moves the spec to `done/`, and promotes any
durable decision to an ADR in the same change.

## Hard rules

- The API contract is `docs/specs/done/0002-http-api-v0.md` — behavior-preserving unless a spec says
  otherwise. Error bodies are `{error, message, ...extra}`, key order included.
- The server never sees a passphrase or plaintext secret (SPEC §6). Nothing in
  `server/` may import `age-encryption` — `tests/secrets.test.ts` enforces it.
- The AI relay has no route to rename/delete (SPEC §8) — `tests/fileops.test.ts`
  greps the source of all three `ai*.ts` modules to prove it.
- One deploy replica, ever (sqlite + fs.watch + git working tree; see
  `deploy/k3s/20-deployment.yaml`).
- Zero runtime deps beyond `age-encryption` and `diff`; no frontend
  build step. Adding a dependency is an ADR-sized decision.
