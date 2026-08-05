---
id: 5
title: Frontend deps policy
label: wayfinder:grilling
status: closed
assignee: z
blocked-by: []
---

## Question

How strict is "minimal dependencies, no build step" for the frontend, given a Notion-style block editor is the heaviest thing to hand-roll in vanilla JS?

## Resolution

**A build step is allowed.** Dependencies must be safe/secure (vetted, well-maintained). The toolchain is **bun only** — `bun install` / `bun build`; no npm, no node. Bun serves the built app. The backend remains a single bun file. UI stays decoupled from the backend (API-only contact) so future clients can reuse the backend.

Decided with z during charting, 2026-07-31.
