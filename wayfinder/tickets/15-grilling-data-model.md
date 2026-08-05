---
id: 15
title: Grilling — data model, links & sqlite's role
label: wayfinder:grilling
status: closed
assignee: z + fable (grilling 2026-08-01)
blocked-by: []
---

## Question

Domain-modeling session over the file/link semantics: what exactly is a doc (any `.md` under the repo root? excluded dirs like `wayfinder/`, `prototypes/`?); folder operations (create/rename/move/delete from the UI — IDE-parity?); `[[doc-link]]` resolution rules (by filename? path? fuzzy?), behavior on rename/move (rewrite backlinks?), and broken-link handling; what sqlite actually stores (settings, doc index, FTS search, backlinks graph, AI chat history — and what's rebuildable cache vs source of truth); and how external edits reconcile with the in-app editor state (file watch → reload vs merge).

## Resolution

A doc is any `.md` under the vault root (app-internal dirs like `.znotes/` excluded). **Links**: `[[slug]]` resolves by unique filename slug vault-wide; path-qualified `[[architecture/event-pipeline]]` needed only on collisions. **Rename/move rewrites all backlinks** in one commit; broken links render visibly flagged with a create-this-doc affordance. Full folder/doc create-rename-move-delete from the UI (IDE parity) — human-only for destructive ops. **External edits** (vim, git pull) while a doc is open: if the in-app buffer is clean, auto-reload with a subtle "updated from disk" blip; if dirty, keep the buffer and raise a conflict banner with a diff and take-disk / keep-mine choices — powered by the watch→debounce→reconcile→SSE pipeline from the Bun research. **sqlite role**: rebuildable index/cache only, plus device-local credentials — doc index, FTS search, backlinks graph, AI chat history, pre-image blobs for the revert stack, tokens/keys. Files on disk + git are the only source of truth; deleting the db loses no notes.

Decided with z, 2026-08-01.
