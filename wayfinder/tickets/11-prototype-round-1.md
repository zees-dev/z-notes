---
id: 11
title: Prototype — round 1, six themed UI mockups
label: wayfinder:prototype
status: closed
assignee: fable (session 2026-07-31)
blocked-by: []
---

## Question

What should the app look and feel like? Build six self-contained HTML mockups under `prototypes/` (local only, dummy markdown content from the user's domain: keys, architecture notes, side projects) — one per theme: **modern, minimalistic, cyberpunk/futuristic, terminal/TUI, glassmorphism dark, Notion warm/paper**.

Each mockup must demonstrate, per the [prototype plan](06-prototype-plan.md): sidebar folder tree with nesting, Notion-style block editor surface, `[[doc-links]]` navigation, a secret block in locked and unlocked states, settings view (theme, density, autosave interval, git sync, AI endpoint/model/effort), AI chat pane with a proposed-diff accept/revert flow, compact/comfy density toggle, and a mobile-responsive layout.

Resolution = prototypes delivered for the user to test. Preferred mechanics: one Workflow fanning out one Opus 5 agent per theme, with Fable validating consistency of the demonstrated feature set across themes.

## Resolution

Delivered 2026-07-31 via a six-agent Opus 5 workflow, all agents building from the shared [BRIEF.md](../../prototypes/BRIEF.md) (identical dummy vault, identical AI conversation, identical 8-behavior checklist — only the aesthetic varies). Files under `prototypes/`: `01-modern.html`, `02-minimal.html`, `03-cyberpunk.html`, `04-terminal.html`, `05-glass.html`, `06-notion-warm.html`, plus an `index.html` gallery. Validated: zero external requests in all six, all required markers present (secret age block, gpt-5.6-sol chip, density variables, mobile breakpoints, keyboard handlers); the modern and minimal builds were additionally self-verified by their agents in headless Chromium/jsdom. Interactivity in each: doc navigation (sidebar + [[links]]), summonable slash menu, secret block unlock/re-lock, AI diff Accept→Applied→Revert round-trip, settings modal with a genuinely working Compact/Comfy density toggle, ⌘S save flash, <768px hamburger + chat drawer. Next: user testing → [prototype review & down-select](12-prototype-review-downselect.md).

**Addendum (2026-07-31, evening):** after first user testing, all six were refactored in place — Notion-block machinery (drag handles, gutters, slash menu, per-block editing) fully removed, replaced with Preview | Raw markdown modes (⌘E toggle, edits flow between modes, docs stored as plain markdown strings). See the amended [editor-paradigm resolution](01-editor-paradigm.md) and the feedback log on [prototype review](12-prototype-review-downselect.md). Re-validated: zero leftover block-editor references, zero external requests, all files serving.
