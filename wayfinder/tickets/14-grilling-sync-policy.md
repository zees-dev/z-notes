---
id: 14
title: Grilling — git sync policy
label: wayfinder:grilling
status: closed
assignee: z + fable (grilling 2026-08-01)
blocked-by: []
---

## Question

The mechanism is git CLI ([decided](04-git-sync-mechanism.md)); this ticket settles policy: sync cadence (on every save? debounced? interval? manual button too?), commit-message strategy (timestamped? per-file? batched?), what happens when `pull --rebase` hits a real conflict (surface in UI how — block editing? conflict view?), what stays untracked (`.gitignore`: sqlite db, settings?), whether settings/secrets passphrase material ever gets committed, and whether sync status (ahead/behind/dirty) is surfaced in the UI.

## Resolution

**Debounced auto-sync**: after saves settle (default 60s of quiet, configurable), commit and push automatically, batching an edit burst into one commit with an auto-generated message (timestamp + files touched). Manual "Sync now" button and statusbar sync state (synced/syncing/ahead/behind/error) always present. On push rejection: `pull --rebase`; on a real conflict, editing continues but a conflict state surfaces in the UI for manual resolution (per the external-edits decision on the data-model ticket, the app never auto-destroys either side). **Committed to the repo**: notes, `.znotes/settings.toml` (**TOML, not JSON** — theme, density, autosave interval, branch, AI model/effort; never tokens or keys), and the age material (`.znotes/vault.pub`, `.znotes/identity.age`). **Untracked**: the rebuildable sqlite db, and all credentials (GitHub token, AI API key) which live only in sqlite.

Decided with z, 2026-08-01.
