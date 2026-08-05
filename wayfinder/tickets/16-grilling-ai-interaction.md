---
id: 16
title: Grilling — AI interaction model
label: wayfinder:grilling
status: closed
assignee: z + fable (grilling 2026-08-01)
blocked-by: [10]
---

## Question

How does the AI actually behave in the app? Chat scope (per-doc thread vs global assistant vs both); what context it sees (current doc only? linked docs? whole vault on demand?) and how the user controls that; the accept/revert UX for proposed diffs (per-hunk or whole-proposal; revert via git or in-app history — informed by the [AI protocol research](10-research-ai-protocol.md)); whether the AI can create new docs or only edit the open one; chat history persistence; and hard guarantees around secret blocks never reaching the endpoint.

## Resolution

**One global assistant** whose context automatically includes the currently-open doc (contextDocPath), able to propose changes to any doc. **Powers: edit + create only** — proposals may modify existing docs and create new ones, both diffable and on the LIFO stack; delete/rename stay human-only. Accept/revert per proposal with server-enforced LIFO ordering (409 not-stack-top), two-layer revert (sqlite pre-image + one git commit per accepted proposal). **Not all replies propose changes** — plain informational answers carry no proposal (contract: `proposal: null`). Sessions are resettable (context clear) with visible message count and token estimate; **chat history persists in sqlite** across restarts. Secrets are structurally excluded from AI context: the server assembles context from on-disk bytes, which contain only age armor, rendered as placeholders — plus the canary filter from the AI-protocol research.

Decided with z, 2026-08-01.
