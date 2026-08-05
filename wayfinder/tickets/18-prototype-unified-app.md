---
id: 18
title: Prototype — unified themed app over a mock API boundary
label: wayfinder:prototype
status: closed
assignee: fable (session 2026-08-01)
blocked-by: [12]
---

## Question

Merge the three surviving prototypes into **one app** under `prototypes/app/`: a single frontend (semantic DOM + CSS design tokens) whose theme switches live between Modern, Minimalistic, and Terminal/TUI from settings, carrying every behavior converged in rounds 1–4. Crucially, it must **demonstrate the frontend/backend decoupling**: the UI talks only to a versioned HTTP/SSE API contract (`API.md`), mocked by a hand-rolled service worker (in-memory vault, simulated latency, SSE events) — zero app logic knows about the mock. The real bun backend later implements the same contract unchanged. Resolution = unified app delivered, all three themes passing the behavior checklist against the mock API.

## Resolution

Delivered 2026-08-01 at `prototypes/app/` (http://localhost:4600/app/) via a three-phase Opus workflow (scaffold → 2 parallel themes → adversarial verify). Ten files: `API.md` (v0 HTTP/SSE contract: docs CRUD with revs + 409 conflicts, secrets unlock, server-side fuzzy search with match offsets, settings with server-declared meta driving the UI controls, sync status, AI sessions/messages/proposals with **server-enforced LIFO revert** and the anchored `propose_edits` shape from the AI-protocol research, `/events` SSE), `api.js` (sole network-touching file), `sw.js` (in-memory mock of the whole contract, 30–80ms latency, SSE pushes), `index.html` + `app.js` (full rounds-1–4 interaction model, zero embedded content, theme live-swap from server meta), `themes/base.css` (~140-token contract + all layout) with `modern/minimal/terminal.css`, and `THEMES.md`. Verifier drove all three themes headlessly: 30 checks passed; 10 issues found and fixed (dead block-gap CSS specificity, attribute-injection escaping, hard-coded seed-doc highlighter, client-baked server values, SSE reconnect with backoff, keepalive save flush, table style leaks, API.md doc gaps). LIFO verified at the API level: direct revert of a non-top proposal returns 409 `not-stack-top`. Known limits recorded honestly by the verifier: in-memory vault resets on SW eviction (by design), no rename/move/delete yet (501), AI messages beyond the seeded proposals return `proposal:null`, no fallback if a theme CSS 404s. serve.ts gained directory-index support so `/app/` resolves.

**Addendum (2026-08-01):** post-delivery user fixes — (1) the browser password-manager prompt on sidebar create: the git-token, AI-key, and passphrase inputs were `type="password"`, which put Chrome's credential heuristics in play; all three are now `type="text"` masked via CSS (`-webkit-text-security: disc`) with `autocomplete="off"`/`data-1p-ignore`, and the create input is likewise opted out — no password fields exist in the app at all. (2) Plain-text chat replies: confirmed the contract and UI already attach diff cards only to messages referencing a proposal (typed messages return `proposal: null`); the mock's canned replies were reworded to be clearly informational so plain answers don't read like pending edits.
