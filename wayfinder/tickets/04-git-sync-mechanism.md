---
id: 4
title: Git sync mechanism
label: wayfinder:grilling
status: closed
assignee: z
blocked-by: []
---

## Question

How should GitHub auto-sync work under the hood — shell out to the local git CLI, or reimplement sync over the GitHub REST API?

## Resolution

**Shell out to the local git binary** (add/commit/push; `pull --rebase` when the push is rejected). The GitHub token from settings is used only as the HTTPS credential; target branch configurable, default `main`. This keeps full-fidelity git history consistent with the user editing files outside the app.

Cadence, commit-message strategy, conflict UX, and what stays untracked (sqlite db) are delegated to the [sync policy grilling ticket](14-grilling-sync-policy.md).

Decided with z during charting, 2026-07-31.
