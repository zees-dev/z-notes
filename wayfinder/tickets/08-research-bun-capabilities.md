---
id: 8
title: Research — Bun-native capabilities for the single-file backend
label: wayfinder:research
status: closed
assignee: research-subagent (fired 2026-07-31)
blocked-by: []
---

## Question

What can Bun (≥1.3.x) natively provide for the backend, and where are the sharp edges? Confirm concretely, with API names and caveats:

- `Bun.serve` routing, static file serving, WebSocket and SSE support (for live updates when files change on disk).
- `bun:sqlite` — FTS5 availability, WAL mode, prepared statements.
- File watching (`fs.watch` recursive on macOS, debouncing, rename detection) for picking up external edits.
- `Bun.$` shell for git operations (quoting, exit codes, stderr capture).
- `bun build` — bundling a frontend (HTML entrypoints, CSS, code splitting) served by the same single bun file; single-executable option; whether dev can run with zero build via HTML imports.
- Anything relevant to a single-file server architecture (embedding assets, hot reload).

End with a recommended backend shape (single file layout, endpoints vs static, watch→SSE pipeline). Findings file: `wayfinder/research/bun-capabilities.md`

## Resolution

Bun 1.3.14 (the current stable, verified running locally on macOS 26.5 arm64) covers the entire backend surface with zero runtime dependencies: `Bun.serve` routes with params/per-method/static/wildcard plus live `server.reload()`, SSE via `ReadableStream`, WebSocket with pub/sub, `bun:sqlite` with full FTS5 (`bm25`, `snippet`, `unicode61`, `trigram`, external-content) under WAL, safe-by-default `Bun.$` quoting, `bun build` HTML entrypoints, zero-build dev via HTML import with HMR, and a working `--compile` single executable that embeds the bundled frontend. Recommended shape is one process and one entrypoint with a few small modules (not one literal file), serving `/api/*` + `/events` (SSE) alongside the bundled frontend, dev via `bun --hot server.ts` with no build step, and git driven through `Bun.spawn` argv arrays rather than the shell so the token never enters argv. The pivotal finding is that **`fs.watch` on macOS is unreliable in both arguments** — `eventType` is *always* `"rename"` (never `"change"`, even for pure appends), and for intra-vault atomic saves the only event names the temp file while the file that actually changed is never reported — so the watcher must be treated as a contentless "something moved" doorbell feeding a 120 ms debounce into a `Bun.Glob` + `stat` + `Bun.hash` reconcile against SQLite, which was prototyped end-to-end and correctly handles the atomic-save and identical-bytes-suppression cases. Key risk: this is a silent correctness risk, not a performance one — any implementation trusting the watch event payload will serve stale content for externally-edited notes, exactly the failure the app exists to prevent; a secondary trap is `Bun.serve`'s default `idleTimeout: 10`, which silently kills SSE streams after ten seconds and must be set to `0` with a ~20 s heartbeat. Also note `bun:sqlite` binds Apple's *system* SQLite on macOS (3.51.0, not Bun's bundled 3.53.0), so extension loading is unavailable and vector search must not be put on the critical path. Full comparisons, verified transcripts, and concrete parameters: [../research/bun-capabilities.md](../research/bun-capabilities.md)
