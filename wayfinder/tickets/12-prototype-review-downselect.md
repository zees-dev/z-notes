---
id: 12
title: Prototype review & down-select
label: wayfinder:grilling
status: closed
assignee: fable (session 2026-08-01)
blocked-by: [11]
---

## Question

Which prototype direction wins? The user tests the round-1 mockups and gives feedback; iterate (possibly additional prototype rounds refining or hybridizing themes) until one UI direction is chosen. Capture: winning theme (or hybrid), what to keep/change from the losers, and any interaction-model feedback (blocks, sidebar, chat, settings) that should bind the spec.

## Feedback so far

- 2026-07-31, after first hands-on with round 1: **Notion-like block input is too complex** — user redirected the editor paradigm to simple markdown with Raw and Preview modes (recorded as the amended resolution of the editor-paradigm ticket). Prototypes refactored accordingly; theme down-select still open.
- 2026-07-31, round-2 review: **down-selected to Modern, Minimalistic, and Terminal/TUI** (cyberpunk, glass, notion-warm dropped). Interaction feedback binding on all survivors: density defaults denser (old Compact becomes Comfy/default; new Compact tighter still); click on Preview body enters Raw edit mode (except checkboxes → toggle in place, links → navigate); working new-doc/new-folder from sidebar; chat gets visible session details (message count, token count, scrollable history) and a context reset; accepted AI changes form a revert **stack** (LIFO — newer must be reverted before older); fuzzy search across all docs (⌘K palette); statusbar meta (lines, sync, shortcuts, WS connected state) is liked — keep in all; Esc dismisses modals; shortcuts for most things. Bug: modern's Raw mode shifted the whole UI up.
- 2026-07-31, round-3 review: **mode-switch continuity** — Raw and Preview must share the identical container (borders, padding, margins, width); only the text swaps (rendered ↔ markdown source). No component/chrome change between modes. Also: clicking the whitespace *outside* the doc content while in Raw returns to Preview (complement of click-to-edit).
- 2026-08-01, round-4 review: **source-faithful vertical spacing in Preview** — blank lines between blocks must not collapse; N consecutive blank lines should render as proportionally larger gaps (e.g. two blank lines between a code fence and a quote → visibly double spacing), keeping Preview's vertical rhythm consistent with Raw.

## Resolution

**No single winner — all three.** The unified direction (decided by z, 2026-08-01): one app whose **theme switches between Modern, Minimalistic, and Terminal/TUI** (settings-controlled), on the interaction model converged over four feedback rounds (raw/preview with container parity, click-to-edit / click-outside, source-faithful blank-line spacing, LIFO change stack, chat sessions with reset, ⌘K fuzzy search, dense-by-default density, statusbar meta, Esc + shortcuts everywhere). Binding architectural corollary reaffirmed: the frontend must be fully decoupled from the backend — it talks only to a versioned HTTP/SSE API contract, so a new frontend or a mobile app can be built on the same backend. The prototype demonstrates this with a mock service-worker backend implementing the contract; the real bun backend later implements the same contract (after the spec and comprehensive testing). Delivery of the unified prototype: [Prototype — unified themed app](18-prototype-unified-app.md).
