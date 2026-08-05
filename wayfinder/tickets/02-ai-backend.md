---
id: 2
title: AI backend
label: wayfinder:grilling
status: closed
assignee: z
blocked-by: []
---

## Question

How should the AI integration reach the user's existing ChatGPT/Codex subscription — shell out to the codex CLI, talk to a local proxy, or a pluggable API endpoint?

## Resolution

**Pluggable API endpoint**: settings hold a base URL + API key + model name, speaking the OpenAI-compatible chat/completions protocol. Works with the user's local the AI gateway (subscription-backed), OpenAI, or any compatible endpoint. Default model **`gpt-5`** ("sol 5.6"), with configurable reasoning effort, **default high**. All of it configurable in the settings view.

Decided with z during charting, 2026-07-31.
