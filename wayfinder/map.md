---
label: wayfinder:map
title: z-notes markdown app — way to a build-ready spec
created: 2026-07-31
---

# z-notes markdown app — wayfinder map

## Destination

A **user-validated UI direction** (chosen from themed prototypes after iteration) plus a **build-ready spec** for the single-user, bun-only markdown notes app — every architectural and UX decision made, so implementation can start as a fresh effort with nothing left to decide.

## Notes

- Domain: private developer notes — keys/secrets, architecture, side projects. Single user (z), files also edited outside the app (vim/IDE); the app must pick up external changes.
- Toolchain: **bun only** (bun install / bun build / bun serve) — no npm, no node. Backend ideally a single bun file; sqlite (`bun:sqlite`) for db. Frontend build step is allowed; dependencies must be safe/secure and vetted. UI fully decoupled from backend (future mobile/desktop clients on the same backend).
- Orchestration preference: use **Workflows with Opus 5 agents** for discovery/analysis and prototyping; Fable 5 orchestrates and validates.
- Tracker: local markdown (no remote tracker configured). Tickets live in `wayfinder/tickets/NN-slug.md`; status/assignee/blocked-by in frontmatter. A ticket is unblocked when every id in `blocked-by` is closed.
- Research findings are captured as files under `wayfinder/research/` and linked from their tickets (no throwaway branches — branch creation is restricted in this environment).
- Prototypes are **local-only** self-contained HTML files under `prototypes/` — nothing published externally.

## Decisions so far

- [Editor paradigm](tickets/01-editor-paradigm.md) — **amended after prototype testing**: simple markdown with **Raw + Preview modes** (Notion-style blocks dropped as too complex); lossless round-trip now holds by construction since the source text itself is edited.
- [AI backend](tickets/02-ai-backend.md) — pluggable OpenAI-compatible endpoint (base URL + key + model in settings); default model `gpt-5.6-sol`, configurable effort, default high.
- [Secrets model](tickets/03-secrets-model.md) — inline encrypted blocks: client-side WebCrypto, passphrase-derived key; ciphertext committed to git, server never sees plaintext.
- [Git sync mechanism](tickets/04-git-sync-mechanism.md) — shell out to the local git CLI; settings token used only as HTTPS credential; `pull --rebase` on push rejection.
- [Frontend deps policy](tickets/05-frontend-deps-policy.md) — build step allowed; bun-only toolchain; safe/secure vetted dependencies; bun serves the built app.
- [Prototype plan](tickets/06-prototype-plan.md) — 6 themed, self-contained HTML mockups in `prototypes/`, local only: modern, minimalistic, cyberpunk/futuristic, terminal/TUI, glassmorphism dark, Notion warm/paper.
- [Research — block-editor foundations](tickets/07-research-block-editor-libs.md) — TipTap 3 + mdast bridge was the pick for the block paradigm; **superseded by the editor-paradigm amendment** — the research's own fallback, CodeMirror 6 (byte-stable by construction) or a plain textarea as the Raw surface, is now the operative recommendation.
- [Research — Bun capabilities](tickets/08-research-bun-capabilities.md) — Bun 1.3.14 covers everything with zero runtime deps (Bun.serve+SSE, sqlite FTS5/WAL, bun build HTML, --compile); macOS `fs.watch` is only a "something moved" doorbell → debounce + Glob/stat/hash reconcile; set SSE `idleTimeout: 0`; git via `Bun.spawn` argv.
- [Research — secrets crypto](tickets/09-research-secrets-crypto.md) — "age-in-a-fence": standard age v1 armor in a ```age fence via typage; per-block X25519 encryption to a committed vault recipient, identity wrapped under scrypt logN=18 passphrase; plaintext confined to a crypto Web Worker; index/autosave/AI all read ciphertext-only markdown.
- [Prototype — round 1](tickets/11-prototype-round-1.md) — six themed, feature-identical interactive mockups delivered under `prototypes/` (open `prototypes/index.html`); validated self-contained with all 8 required behaviors; awaiting user review/down-select.
- [Prototype review & down-select](tickets/12-prototype-review-downselect.md) — **all three survivors win as switchable themes of one unified app** (Modern, Minimalistic, Terminal/TUI); interaction model converged over four feedback rounds; frontend strictly behind a versioned HTTP/SSE API contract so new frontends/mobile apps can share the backend — demonstrated via a service-worker mock in the unified prototype.
- [Prototype — unified themed app](tickets/18-prototype-unified-app.md) — delivered at `prototypes/app/` (http://localhost:4600/app/): `API.md` v0 contract, `api.js` as the sole network layer, service-worker mock with SSE + server-enforced LIFO reverts, ~140-token theme contract with all three themes live-switchable; 30 headless checks passed after 10 verifier fixes.
- [Grilling — exposure & auth](tickets/13-grilling-exposure-auth.md) — k3s pod with auto TLS certs; Tailscale for remote; graceful degradation when WebCrypto is unavailable (secrets stay locked, app works); no app-level auth.
- [Grilling — git sync policy](tickets/14-grilling-sync-policy.md) — debounced auto-sync (60s quiet, configurable) with batched auto-message commits; `.znotes/settings.toml` (TOML) + age material committed; sqlite db and all credentials untracked.
- [Grilling — data model & links](tickets/15-grilling-data-model.md) — slug-resolved `[[links]]` with backlink auto-rewrite on rename; external edits auto-reload when clean / conflict banner when dirty; sqlite is rebuildable cache + device-local credentials only.
- [Grilling — AI interaction](tickets/16-grilling-ai-interaction.md) — global assistant with current-doc context; edit + create proposals only; LIFO stack; plain replies carry no proposal; history in sqlite; secrets structurally excluded.
- [Research — AI protocol](tickets/10-research-ai-protocol.md) — `/v1/responses` + SSE relayed through the bun backend (key server-side); one strict `propose_edits` function tool with anchored search/replace spans; server validates edits against on-disk bytes; revert = sqlite pre-image + one git commit per accepted proposal; secrets structurally excluded from context.

## Not yet specified

- **Task semantics** — this is a note-*tasking* app: checkboxes are settled, but task aggregation/rollups/queries (SilverBullet-style) are undefined. Deferred past the spec's v1 unless the user pulls it in.
- **k3s packaging detail** — image build (`bun build --compile` vs oci base), cert-issuance mechanism, manifests; sharpened during implementation, constrained by the exposure decision.

## Out of scope

- **HTML/PDF export & view** — explicitly deferred by the user ("ignore this for now").
- **Native mobile/desktop apps** — future clients; only the backend decoupling that enables them is in scope.
- **Implementation of the app itself** — the destination is the validated UI + spec; building it is the next effort.
