---
id: 10
title: Research — AI endpoint protocol & diff-proposal format
label: wayfinder:research
status: closed
assignee: research-subagent (fired 2026-07-31)
blocked-by: []
---

## Question

Options for the AI layer speaking to a pluggable OpenAI-compatible endpoint (default model `gpt-5`, configurable reasoning effort):

- Protocol: `/v1/chat/completions` vs `/v1/responses` for compatibility across proxies (the AI gateway, OpenAI, LiteLLM-style gateways); how "reasoning effort" is passed on each and how gracefully unknown params degrade.
- Streaming: SSE handling in the browser vs relayed through the bun backend (CORS, key custody — the key should stay server-side).
- **Diff-proposal contract**: how the model proposes markdown edits so the UI can render an accept/revert diff — structured tool/function call returning old/new spans vs unified diff in a fenced block vs full-document replacement with client-side diffing. Which is most robust for markdown, and what's the revert story (git-backed vs in-app history)?
- Context assembly: current doc + linked docs; token budgeting; where secret-block redaction hooks in.

End with a recommended protocol + diff contract. Findings file: `wayfinder/research/ai-protocol.md`

## Resolution

Speak **`POST {baseUrl}/v1/responses`** with SSE streaming, always relayed through the bun backend so the API key stays server-side and there is no CORS surface — this is forced, not preferred, because OpenAI now returns HTTP 400 (`"Function tools with reasoning_effort are not supported for gpt-5 in /v1/chat/completions"`) for any `gpt-5-*` request that combines function tools with reasoning above `none`, and z-notes needs both tools and effort `high`. Send `reasoning: {effort: "high", summary: "auto"}` explicitly (omitting it silently yields `medium`), `store: false`, `parallel_tool_calls: false`, plus a capability probe at settings-save time and a documented degradation ladder down to `/v1/chat/completions` for weaker endpoints. The diff contract is a **single strict `type: "function"` tool `propose_edits`** returning anchored search/replace spans (`replace` / `insert_after` / `create` / `rewrite` / `delete_doc`), chosen over the native `apply_patch` tool and over unified diff because plain JSON function tools are the only tool shape that survives the AI gateway/LiteLLM/OpenRouter translation, and because unified diff is the least robust format even for GPT-5.x in the 2026 cross-format benchmark while search/replace ties whole-file at a fraction of the tokens. The backend validates every edit against on-disk bytes (unique match with three-pass normalization, path confinement, rejection of any range intersecting an encrypted block) before the UI may offer Accept, and feeds failures back as tool results for up to two in-turn retries; revert is two-layer — a sqlite pre-image blob for instant undo plus one git commit per accepted proposal for durable `git revert`. Context is assembled **server-side from on-disk bytes only**, which makes the secret guarantee structural rather than a filter: the vault already holds only ciphertext, rendered to the model as `⟪secret: … encrypted⟫` placeholders. **Key risk**: this pins the app to endpoints that implement `/v1/responses` well — the AI gateway exposes it and Codex speaks it natively, but its tool-translation layer has open bugs for non-standard tool shapes, and many local servers (Ollama, LM Studio, llama.cpp) still ship Chat Completions only, where the fallback silently costs reasoning quality.

Full findings, comparison tables, and concrete parameters: [../research/ai-protocol.md](../research/ai-protocol.md)
