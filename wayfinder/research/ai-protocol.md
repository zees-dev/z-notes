---
label: wayfinder:research
ticket: 10
title: AI endpoint protocol & diff-proposal format
researched: 2026-07-31
---

# AI endpoint protocol & diff-proposal contract

Research for [ticket 10](../tickets/10-research-ai-protocol.md). Target: a pluggable
OpenAI-compatible endpoint (default `gpt-5`, configurable reasoning effort, default
high) driving a Notion-style markdown block editor with accept/revert diff proposals.

## TL;DR

1. **Use `/v1/responses` as the primary wire protocol.** This is not a preference — for
   `gpt-5-*`, OpenAI *hard-rejects* function tools combined with any reasoning effort
   other than `none` on `/v1/chat/completions`. Since z-notes wants both structured edit
   proposals (tools) and effort=high, Chat Completions cannot express the requirement.
2. **Keep the edit contract in a plain `type: "function"` tool**, not the native
   `apply_patch` tool and not free text. Plain JSON function tools are the one thing every
   gateway on the path (the AI gateway, LiteLLM, OpenRouter, vLLM) translates correctly.
3. **Anchored search/replace spans** (`find`/`replace` exact substrings) beat unified diff
   for cross-model robustness, and full-document `rewrite` stays as an escape hatch for
   heavy restructuring. Client-side rendering with `jsdiff`.
4. **Stream through the bun backend, never browser→endpoint.** Key custody, zero CORS
   surface, and — decisively — the backend must validate every proposed edit against
   on-disk bytes *before* the UI is allowed to show it as acceptable.
5. **Revert = two layers**: sqlite pre-image blob for instant in-app undo, plus one git
   commit per accepted proposal for durable `git revert`.

---

## 1. Model facts that constrain everything

`gpt-5` (the `gpt-5` alias routes here) is the flagship reasoning model of the 5.6
series alongside `terra` (balanced) and `luna` (high-volume).

| Property | Value | Source |
|---|---|---|
| Context window | ~1.05M tokens | [artificialanalysis.ai](https://artificialanalysis.ai/models/gpt-5-6-sol-xhigh), [sim.ai](https://www.sim.ai/models/openai/gpt-5-6-sol) |
| Max output | 128K tokens | same |
| Effort levels | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) |
| Default effort | `medium` (in **both** APIs, when omitted) | [Upgrading to gpt-5](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md) |
| Effort param — Responses | `reasoning: { "effort": "high" }` | Reasoning guide |
| Effort param — Chat Completions | `reasoning_effort: "high"` | Migration guide |
| Tokenizer | `o200k_base` / `o200k_harmony` | [tiktokenizer.com](https://tiktokenizer.com/) |

Two consequences for us:

- **Effort must always be sent explicitly.** Omitting it silently gives `medium`, not the
  `high` default that [ticket 02](../tickets/02-ai-backend.md) decided. The migration guide
  calls this out as a migration hazard.
- **A 1M context window means token budgeting is a *cost* problem, not a *capability*
  problem** for a personal notes vault. Even a large vault of markdown notes fits. Budget
  to control latency and spend, not to avoid overflow.

---

## 2. Protocol: `/v1/chat/completions` vs `/v1/responses`

### 2.1 The decisive constraint

OpenAI changed behaviour with the 5.6 family: `/v1/chat/completions` now returns **HTTP
400** for requests that combine function tools with a reasoning effort other than `none`.
The literal error body, reproduced identically in two independent downstream trackers:

```
Function tools with reasoning_effort are not supported for gpt-5 in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

- [LiteLLM #33221](https://github.com/BerriAI/litellm/issues/33221) — filed 2026-07-14
  against LiteLLM v1.92.0; affects `gpt-5`, `-luna`, `-terra`.
- [LibreChat #14355](https://github.com/danny-avila/LibreChat/issues/14355) — notes the
  nastier detail: because 5.6 reasons *by default*, the 400 fires even when the caller
  never sets `reasoning_effort` at all. Their fix is to unconditionally route 5.6 to
  `/v1/responses` unless the user explicitly opts into `reasoning_effort: "none"`.

OpenAI's own migration guide states the same restriction as policy: *"Function tools in
Chat Completions are compatible only with effective reasoning `none`"*, and *"If the
application needs both reasoning and tools: migrate that flow to Responses … otherwise
report it as a compatibility blocker."*
([Upgrading to gpt-5](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md))

z-notes needs **both** — a structured tool call is the whole diff-proposal mechanism, and
effort=high is a settled decision. So Chat Completions is disqualified as the primary
protocol. The only Chat Completions-shaped alternative is `reasoning_effort: "none"`, which
throws away the model's main advantage on a task (restructuring prose and code notes) where
reasoning genuinely helps.

### 2.2 Responses-only features we actually want

| Feature | Param | Useful here? |
|---|---|---|
| Tools + reasoning together | (implicit) | **Required** |
| Reasoning summaries | `reasoning.summary: "auto"` | Yes — "thinking" affordance in chat UI |
| Persisted reasoning across turns | `reasoning.context: "all_turns"` | Nice-to-have; portability risk |
| Pro mode | `reasoning.mode: "pro"` | No |
| Explicit cache boundary | `prompt_cache_breakpoint` | Yes — pin the static prefix |
| Stateless w/ encrypted reasoning | `store: false` | **Yes** — private notes, no server retention |
| Typed streaming events | — | Yes — lets us stream tool args into the diff panel |

Sources: [migration guide](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md),
[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning),
[Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses).

For a private-notes app, `store: false` matters. The reasoning guide's stateless recipe:
keep every output item (including the reasoning item with its `encrypted_content`), append
the next user message, and replay the complete history in `input`. The legacy
`include: ["reasoning.encrypted_content"]` value is still accepted but no longer required.

### 2.3 Proxy / gateway compatibility

| Gateway | `/v1/chat/completions` | `/v1/responses` | Notes |
|---|---|---|---|
| **the AI gateway** (the user's local proxy, `127.0.0.1:8080`) | Yes | **Yes** — `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses` (WebSocket) | [API overview](https://router-for-me-ai-proxyapi.mintlify.app/api/overview) |
| OpenAI direct | Yes (degraded) | Yes | — |
| LiteLLM | Yes | Yes (`/responses` spec-compatible; `litellm_proxy` provider still downconverts internally) | [docs](https://docs.litellm.ai/docs/response_api), [#15342](https://github.com/BerriAI/litellm/issues/15342) |
| OpenRouter | Yes | Yes (apply_patch is Responses-only there) | [apply-patch guide](https://openrouter.ai/docs/guides/features/server-tools/apply-patch) |
| vLLM / Ollama / LM Studio / llama.cpp | Yes | Partial → often absent | [vLLM serving docs](https://docs.vllm.ai/en/stable/serving/online_serving/) |

the AI gateway is the important one, and it is well-positioned: the Codex backend it fronts
*natively* speaks the Responses protocol, so `/v1/responses` is the **least-translated**
path through that proxy, not the most exotic.

Its documented `reasoning_effort` support on `/v1/chat/completions` lists only
`none`/`low`/`medium`/`high` — no `xhigh`, no `max`
([chat docs](https://router-for-me-ai-proxyapi.mintlify.app/api/openai/chat)). Another
reason to prefer `/v1/responses`, where `reasoning.effort` rides through as an object.
Gateways clamping the top effort levels is a recurring complaint
([LibreChat #14203](https://github.com/danny-avila/LibreChat/issues/14203)).

### 2.4 Tool-shape portability through proxies — the sharp edge

the AI gateway translation is reliable for **flat `type: "function"` tools** and unreliable for
anything else:

- [the AI gateway #3298](https://github.com/router-for-me/the AI gateway/issues/3298): Codex-style
  `type: "namespace"` tool groups are not flattened when translating `/v1/responses` to a
  non-Codex upstream — the model silently returns prose instead of calling anything. The
  reporter explicitly confirms *"regular `type: "function"` tools work correctly on
  `/v1/responses`"*.
- Codex CLI's `apply_patch` is shipped as `"type": "custom"` with a **Lark grammar** rather
  than JSON parameters; the AI gateway does not know how to translate that for non-OpenAI
  upstreams.
- OpenRouter exposes its own vendor-namespaced spelling, `{"type": "openrouter:apply_patch"}` —
  i.e. the *tool name itself* is not portable.

**Rule that falls out: the edit contract must be a plain JSON function tool.** Anything
exotic buys model-training affinity at the cost of the "pluggable endpoint" requirement.

### 2.5 How gracefully do unknown params degrade?

Badly, and loudly. OpenAI-family endpoints reject unknown body keys with
`400 Unrecognized request argument supplied: <key>` rather than ignoring them
([error catalogue](https://portkey.ai/error-library/invalid-argument-error-10104),
[openai-python #1354](https://github.com/openai/openai-python/issues/1354)). Local servers
(vLLM, Ollama) tend to be more forgiving and ignore extras, but that is not a guarantee to
build on, and the `max_tokens` → `max_completion_tokens` split is a well-known 400 source.

So the client cannot "just send everything and hope". It needs (a) a capability probe at
settings-save time and (b) a **degradation ladder** that strips params on 400 (§7.4).

---

## 3. Streaming and key custody

### 3.1 Browser-direct is wrong for this app

Three independent reasons:

1. **Key custody.** [Ticket 02](../tickets/02-ai-backend.md) puts the API key in settings.
   Browser-direct means the key is in frontend memory and in the network tab. Even
   single-user, this leaks the key to every extension and every future mobile client that
   would need its own copy.
2. **CORS.** the AI gateway happens to send `Access-Control-Allow-Origin: *`
   ([overview](https://router-for-me-ai-proxyapi.mintlify.app/api/overview)), but arbitrary
   pluggable endpoints will not. Same-origin `/api/ai/*` on the bun server has no CORS
   surface at all.
3. **Validation.** This is the real one. Proposed edits must be checked against the file's
   *on-disk bytes* (anchor uniqueness, secret-block intersection) before the UI offers an
   Accept button. That check belongs on the side that owns the filesystem.

`EventSource` is also a non-starter independently: it is GET-only and cannot set an
`Authorization` header. Every LLM streaming client uses POST + `fetch` +
`ReadableStream` manual SSE parsing.

### 3.2 Shape

```
browser ──POST /api/ai/chat (same-origin, JSON) ──▶ bun
                                                    ├─ assemble context from disk
                                                    ├─ redact secret blocks
                                                    └─ fetch(baseUrl + /responses, stream)
browser ◀── SSE: normalized app events ────────────┘
```

The bun relay **re-emits a normalized event stream** rather than proxying upstream bytes.
The frontend then never learns whether the upstream was Responses or Chat Completions:

| App event | Payload |
|---|---|
| `text` | `{delta}` — assistant prose |
| `reasoning` | `{delta}` — from reasoning summary, if enabled |
| `tool_args` | `{delta}` — raw JSON args, for a "drafting edits…" shimmer |
| `proposal` | full validated proposal record (see §4.4) |
| `usage` | `{input, output, reasoning, cached}` |
| `done` / `error` | — |

Upstream Responses events to consume:
`response.created`, `response.output_item.added/done`, `response.output_text.delta/done`,
`response.reasoning_summary_text.delta/done`, `response.function_call_arguments.delta/done`,
`response.completed` / `response.incomplete` / `response.failed`, `error`.
([event list](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122),
[streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses)).
Order deltas by `sequence_number`; treat only the `.done` payload as ground truth — the
concatenated `function_call_arguments.delta` stream is for UI shimmer, the `.done` string is
what gets `JSON.parse`d.

### 3.3 Bun specifics (verified against Bun docs)

- `Bun.serve` closes idle connections after 10s, and a quiet SSE stream counts as idle.
  **Must call `server.timeout(req, 0)`** in the handler.
  ([Bun SSE guide](https://github.com/oven-sh/bun/blob/main/docs/guides/http/sse.mdx))
- Return `new Response(stream, {headers: {"Content-Type":"text/event-stream","Cache-Control":"no-cache"}})`,
  where `stream` is a `ReadableStream` or an async generator.
- Bun calls the stream's `cancel()` automatically on client disconnect — wire that to an
  `AbortController` on the upstream `fetch` so aborting the chat stops billing immediately.
- Consume upstream with `for await (const chunk of response.body)`
  ([Bun fetch docs](https://github.com/oven-sh/bun/blob/main/docs/runtime/networking/fetch.mdx)).
- Also set `X-Accel-Buffering: no` and do not gzip the SSE response, in case anything sits
  in front of bun later.

the AI gateway additionally offers a WebSocket transport at `ws://host/v1/responses` with
`previous_response_id` chaining
([streaming docs](https://router-for-me-ai-proxyapi.mintlify.app/api/openai/streaming)).
**Skip it** — it is proxy-specific and torpedoes pluggability. SSE is the portable floor.

---

## 4. Diff-proposal contract

### 4.1 The candidates

| Option | Shape | Portability | Fidelity risk |
|---|---|---|---|
| **A. Native `apply_patch` tool** | `{"type":"apply_patch"}` → typed `apply_patch_call` items with `operation: {type, path, diff}` | OpenAI + OpenRouter (renamed) only; Lark-grammar variant breaks the AI gateway translation | Lowest for OpenAI models (trained on it) |
| **B. Plain function tool w/ unified-diff string** | `type:"function"`, arg contains `@@` hunks | High | Context-line matching is the #1 failure mode |
| **C. Plain function tool w/ anchored search/replace** | `type:"function"`, args `{path, find, replace}` | High | Model must reproduce `find` byte-exactly |
| **D. Fenced block in assistant text** | ```` ```diff ```` parsed out of prose | Universal (no tools at all) | Parser fights prose; no strict schema |
| **E. Full-document replacement + client diffing** | model returns whole new doc | Universal | Token-expensive, slow, but very robust |

### 4.2 Evidence on which format models actually get right

**Aider's benchmarks** (the long-running primary source on this):

- Whole-file was *"the most reliable and effective edit format"* across all GPT-3.5/GPT-4
  models ([benchmarks](https://aider.chat/docs/benchmarks.html)).
- Unified diff was introduced specifically to combat GPT-4-Turbo laziness: search/replace
  scored 20% on the laziness benchmark, unified diff 61%
  ([unified diffs](https://aider.chat/docs/unified-diffs.html)) — a result about
  *completeness of the edit*, not about *applying cleanly*.

**A 2026 cross-format benchmark** (29 editing tasks, Python files 100–4200 lines,
[Geometric, 2026-04-02](https://geometricagi.github.io/2026/04/02/ast-edits.html)):

| Format | Haiku 4.5 | o4-mini | GPT-5.4 | Opus 4.6 |
|---|---|---|---|---|
| AST edit | 86.2% | 100% | **100%** | 100% |
| Whole file | 96.6% | 82.8% | **96.6%** | 100% |
| Hashline JSON ops | 82.8% | 79.3% | **100%** | 89.7% |
| Search/replace | 62.1% | 75.9% | **96.6%** | 100% |
| Unified diff | 58.6% | 20.7% | **89.7%** | 93.1% |

Read the GPT-5.4 column — it is the closest available proxy for `gpt-5`. Two things
stand out:

1. **Unified diff is the worst non-hashline format even for the OpenAI model** (89.7%), and
   catastrophic elsewhere (o4-mini 20.7%). It is the riskiest choice for a *pluggable*
   endpoint by a wide margin. That kills option B and most of option A's fidelity argument.
2. **Search/replace (96.6%) ties whole-file (96.6%) on GPT-5.4** while costing a fraction of
   the tokens. Whole-file used *18× the output tokens and 12× the wall time* of the compact
   format on large files.

Both weak spots of search/replace — byte-exact reproduction, ambiguity in large files —
shrink dramatically for a personal markdown notes vault, where a typical note is under a
few hundred lines. And the failure mode is *safe*: a `find` that doesn't match uniquely is
detected server-side and rejected, never silently misapplied.

### 4.3 Why not `apply_patch`, given it exists

`apply_patch` is genuinely attractive on paper: GPT-5.1–5.5 are trained on the V4A grammar,
it is exposed on Responses/Chat/Assistants as `{"tools":[{"type":"apply_patch"}]}`, and it
emits exactly the create/update/delete-file operations a file-backed vault wants
([Apply Patch guide](https://developers.openai.com/api/docs/guides/tools-apply-patch)).
V4A's context-anchored `@@` headers deliberately avoid line numbers, and reference harnesses
fall back exact → ignore-line-endings → ignore-all-whitespace
([V4A write-up](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/)).

It loses on four counts here:

1. **Not portable.** Vendor-namespaced at OpenRouter (`openrouter:apply_patch`), absent from
   local servers, and the Codex CLI's Lark-grammar spelling is a known the AI gateway
   translation failure. The whole point of ticket 02 is a pluggable endpoint.
2. **Its diff body is unified-diff hunks**, so it inherits exactly the format the 2026
   benchmark shows to be the least robust.
3. **Documented parser bugs**: V4A does not correctly handle more than one `@@`
   change-context per file section; indentation is matched strictly (tabs vs spaces);
   Azure-hosted deployments have broken on missing V4A system-prompt scaffolding.
4. **Markdown-hostile**: leading whitespace is semantically load-bearing in markdown (list
   nesting, code-fence indentation), and V4A's whitespace-insensitive fuzzy fallback can
   apply a hunk at a position whose indentation differs from what the model saw. In prose,
   V4A's second failure mode is worse still: `@@` anchors are chosen by scanning for exact
   text, and notes routinely repeat headings like `## Notes` or `## TODO`.

Keep it as an **opportunistic native mode** behind a capability probe, not the contract.

### 4.4 Recommended contract

One strict function tool. Same JSON payload regardless of which transport carried it, so
the apply/render/revert code has exactly one input shape.

```json
{
  "type": "function",
  "name": "propose_edits",
  "description": "Propose edits to markdown documents in the vault. The user reviews every edit as a diff and accepts or rejects it; nothing is written until they accept. Use 'replace' for targeted changes. Use 'rewrite' only when more than about a third of the document changes.",
  "strict": true,
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["summary", "edits"],
    "properties": {
      "summary": { "type": "string", "description": "One sentence describing the whole proposal." },
      "edits": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["op", "path", "find", "replace", "content", "note"],
          "properties": {
            "op":      { "type": "string", "enum": ["replace", "insert_after", "create", "rewrite", "delete_doc"] },
            "path":    { "type": "string", "description": "Vault-relative path, e.g. notes/infra/dns.md" },
            "find":    { "type": ["string", "null"], "description": "For replace/insert_after: the exact existing text, copied byte-for-byte, long enough to be unique in the document." },
            "replace": { "type": ["string", "null"], "description": "For replace: the replacement text. For insert_after: null." },
            "content": { "type": ["string", "null"], "description": "For create/rewrite/insert_after: the new document body or inserted text." },
            "note":    { "type": ["string", "null"], "description": "Why this edit, shown next to the diff hunk." }
          }
        }
      }
    }
  }
}
```

Notes on the shape:

- Strict structured outputs require every property listed in `required`, so optional fields
  are modelled as nullable unions rather than omitted keys.
- `parallel_tool_calls: false` — one proposal per turn keeps the accept/revert UI coherent.
- `rewrite` is the deliberate escape hatch to option E. With a 128K max output and a 1M
  context, whole-note rewrites are affordable for notes, and the benchmark says they are the
  single most robust format. The description biases the model away from overusing it.
- `create` / `delete_doc` answer ticket 16's "can the AI create new docs" question at the
  protocol level — the contract supports it; whether the UI *permits* it is a policy flag.

**Server-side apply algorithm** (bun, before the UI ever sees a proposal):

1. Reject `path` outside the vault root (traversal, symlinks, absolute paths). The
   apply_patch guide flags directory traversal as the primary hazard; same applies here.
2. Read current on-disk bytes; record `sha256`.
3. For `replace` / `insert_after`, locate `find` in three passes:
   exact → line-ending-normalized → per-line-trailing-whitespace-normalized.
   Leading indentation is **never** normalized (markdown semantics).
4. Require **exactly one** match. Zero → `not_found`. Two or more → `ambiguous`.
5. **Secret guard**: compute the byte ranges of every encrypted block; reject the edit if the
   match range intersects one, or if `replace`/`content` contains a secret fence marker.
6. On any rejection, return the failure to the model as the tool result and allow **at most
   two** retries within the same turn (`{"status":"rejected","reason":"ambiguous","occurrences":3}`).
   This is where the tool-shaped contract decisively beats a fenced text block: the retry
   loop is a first-class protocol move.
7. On success emit the proposal record:
   `{id, path, preSha, pre, post, hunks[], note, op}` — `hunks` computed server-side with
   `diff@9` `structuredPatch` so the client renders without recomputing.

**Rendering**: `diff` (jsdiff) v9, current as of ~2026-04, ships its own TypeScript types
since v8 and supports async/abortable mode ([npm](https://www.npmjs.com/package/diff)).
Use `diffLines` for hunk structure and `diffWordsWithSpace` *within* changed lines for
prose-friendly intra-line highlighting — line-level diff alone reads terribly on wrapped
markdown paragraphs.

### 4.5 Fallback ladder for weak endpoints

| Endpoint capability | Contract used |
|---|---|
| Responses + function tools (target) | `propose_edits` tool, `reasoning.effort` as configured |
| Responses, tools rejected | `text.format` json_schema structured output, same schema |
| Chat Completions only | `tools` + `reasoning_effort: "none"`, same schema — **UI warns that reasoning is off** |
| No tools, no structured output | fenced ` ```zedit ` block containing the identical JSON array, parsed out of the assistant text |

Every rung produces the same `edits[]` array. Only the transport changes.

---

## 5. Revert story

**Recommendation: both layers, they solve different problems.**

**Layer 1 — in-app history (primary UX).** sqlite table:

```sql
CREATE TABLE ai_proposal (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  doc_path    TEXT NOT NULL,
  op          TEXT NOT NULL,
  pre_sha     TEXT NOT NULL,
  pre_image   BLOB NOT NULL,
  post_image  BLOB NOT NULL,
  note        TEXT,
  applied_at  INTEGER,
  reverted_at INTEGER
);
```

Accept writes `post_image`. Revert writes `pre_image` — but only after re-hashing the file
and confirming it still equals `post_image`; if it drifted (external vim edit, git pull),
show a three-way merge prompt instead of clobbering. This gives instant undo with no git
round-trip and works for edits made before any commit exists.

**Layer 2 — git (durable).** [Ticket 04](../tickets/04-git-sync-mechanism.md) already
shells out to the git CLI. One commit per accepted proposal:

```
ai: <summary>

Z-Notes-Proposal: <id>
Z-Notes-Model: gpt-5@high
```

If the file is dirty when a proposal is accepted, commit the user's own work first, so every
AI change lands on a clean base and `git revert <sha>` is always a clean single-file
inverse. Never `git reset` — the same history is being pushed to a remote.

Why not git alone: it cannot express "undo this edit I accepted 5 seconds ago" without a
commit already existing, it costs a subprocess round-trip on the interaction hot path, and
it cannot represent a *rejected* proposal at all. Why not sqlite alone: pre-images are
session/database-local and lost if the db is rebuilt, whereas the git history travels with
the vault.

---

## 6. Context assembly, budgeting, secret redaction

### 6.1 The redaction guarantee should be structural, not a filter

The strongest available guarantee falls straight out of
[ticket 03](../tickets/03-secrets-model.md): secret blocks are encrypted client-side and
**only ciphertext is ever written to disk**. Therefore:

> **Invariant: AI context is assembled server-side from on-disk bytes only. The editor never
> ships in-memory document state to `/api/ai/*`.**

Under that invariant, plaintext secrets are unreachable by the AI path by construction —
the bun process does not possess them. There is no filter to get wrong. The alternative
(frontend sends the live decrypted buffer, backend strips secrets) makes correctness depend
on a regex, and one editor refactor away from leaking.

Practical consequences:

- The user's *unsaved* edits are invisible to the AI. Handle it by flushing the buffer to
  disk before an AI turn (this app is file-first and autosaving anyway), and surface it in
  the UI as "saved before asking".
- Replace each ciphertext block with a placeholder before sending —
  `⟪secret: {label} — encrypted, not visible to the assistant⟫`. Two wins: base64 blobs
  don't burn tokens, and the model is told explicitly not to try to edit inside them.
- Placeholders are **not** reversible by the model. The `find` anchor of any proposed edit
  is matched against real on-disk bytes, so §4.4 step 5 must reject edits whose range
  intersects a secret block — otherwise a `rewrite` op could drop a placeholder into the
  file and destroy the ciphertext.

### 6.2 Assembly order (prompt-cache friendly)

Static-to-volatile, so the prefix caches:

1. `instructions` — system prompt: editing rules, markdown round-trip constraints, tool
   usage policy, "never invent secret values".
2. **Vault manifest** — every doc's path + title + heading outline. Cheap, and it is what
   lets the model reference and create sibling docs.
3. **Linked docs, depth 1** — outbound wiki-links/relative-md-links from the current doc,
   each truncated to a per-doc token cap.
4. **Search hits** — optional sqlite FTS results as `path + snippet` when the user's message
   looks like a vault-wide question.
5. **Current document, in full**, clearly delimited with its path.
6. Conversation history, then the user's message.

Place `prompt_cache_breakpoint` after step 2 when the endpoint supports it (Responses-only;
strip on 400).

### 6.3 Budget

- Count with `gpt-tokenizer` (fastest pure-JS BPE, smallest footprint, supports
  `o200k_base`/`o200k_harmony`) or `js-tiktoken` (OpenAI's official pure-JS port) —
  [comparison](https://www.pkgpulse.com/guides/gpt-tokenizer-vs-js-tiktoken-vs-xenova-transformers-llm-2026),
  [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer). Pure-JS matters: no native
  addon to fight bun over.
- Default cap **200K input tokens** — well under the 1.05M window; this is a latency/cost
  dial, not a capability limit. Expose it in settings.
- Priority for eviction, lowest first: search hits → linked docs → vault manifest detail
  (fall back to paths only) → conversation history (summarize older turns).
  The **current document is never truncated**; if it alone exceeds the cap, raise the cap
  rather than send the model a partial document it might `rewrite`.
- `max_output_tokens: 32000` by default. A full-document `rewrite` of a long note plus
  reasoning tokens can be large, and Responses counts reasoning against the output budget —
  an `incomplete` response mid-`rewrite` is the ugliest failure mode available.

---

## Recommendation

### Protocol

**`POST {baseUrl}/responses`, SSE-streamed, relayed by the bun backend.** The key never
reaches the browser; the browser talks only to same-origin `/api/ai/*`.

Canonical request:

```jsonc
POST {baseUrl}/responses
Authorization: Bearer {apiKey}
{
  "model": "gpt-5",
  "stream": true,
  "store": false,
  "instructions": "<system prompt>",
  "input": [ /* replayed items incl. prior reasoning items, then the user turn */ ],
  "reasoning": { "effort": "high", "summary": "auto" },
  "max_output_tokens": 32000,
  "tools": [ { "type": "function", "name": "propose_edits", "strict": true, "parameters": { /* §4.4 */ } } ],
  "tool_choice": "auto",
  "parallel_tool_calls": false
}
```

Always send `reasoning.effort` explicitly — omitting it yields `medium`, not `high`.

### Settings shape

```jsonc
ai: {
  baseUrl:  "http://127.0.0.1:8080/v1",   // the AI gateway default
  apiKey:   "…",                          // server-side only; never serialized to the client
  model:    "gpt-5",
  protocol: "auto",                        // auto | responses | chat
  effort:   "high",                        // none|low|medium|high|xhigh|max
  summary:  "auto",                        // auto | off
  store:    false,
  maxOutputTokens: 32000,
  contextBudgetTokens: 200000,
  allowCreateDocs: true,
  allowDeleteDocs: false,
  capabilities: { responses: true, toolsWithReasoning: true, applyPatch: false, probedAt: "…" }
}
```

### Capability probe (run on settings save, cache the result)

1. `GET {baseUrl}/models` → is `model` listed?
2. `POST {baseUrl}/responses` with `{model, input:"ping", max_output_tokens:16, stream:false, reasoning:{effort:"none"}}`
   → 200 ⇒ `responses: true`; 404/405 ⇒ fall back to `chat`.
3. Repeat with a one-field dummy function tool and `reasoning:{effort:"high"}`
   → 200 ⇒ `toolsWithReasoning: true`.
4. Optionally `{"tools":[{"type":"apply_patch"}]}` → 200 ⇒ `applyPatch: true` (recorded for
   diagnostics; not used by the default contract).

### Degradation ladder (on 400 containing `unrecognized` / `unsupported` / `unknown`)

Strip in order, retry once each: `prompt_cache_breakpoint` → `reasoning.summary` →
`include[]` → `store` → `parallel_tool_calls` → rename `max_output_tokens` → `max_tokens` →
downgrade effort `max` → `xhigh` → `high` → drop `reasoning` entirely → drop to Chat
Completions per §4.5. Surface each permanent downgrade once in the settings panel; do not
silently degrade an app whose whole premise is a pluggable endpoint.

### Diff contract

**A single strict `type: "function"` tool named `propose_edits`** (schema in §4.4) returning
anchored search/replace spans, with `create` / `insert_after` / `delete_doc` / `rewrite`
alongside. Server validates every edit against on-disk bytes (unique-match with three-pass
normalization, path confinement, secret-range intersection) before the UI can offer Accept,
and feeds validation failures back as tool results for up to two in-turn retries. UI renders
per-hunk with `diff@9` (`structuredPatch` + `diffWordsWithSpace` inside changed lines) and
accepts or rejects **per hunk**, since a single proposal routinely mixes one good edit with
one the user dislikes.

### Revert

Two layers: sqlite `ai_proposal` pre-image blob for instant in-app undo (guarded by a
pre-apply hash check against external edits), plus one git commit per accepted proposal
carrying a `Z-Notes-Proposal:` trailer for durable `git revert`.

### Context

Assembled **server-side from on-disk bytes only** — the structural guarantee that plaintext
secrets never reach the endpoint. Ciphertext blocks become
`⟪secret: {label} — encrypted⟫` placeholders. Order: instructions → vault manifest →
linked docs (depth 1) → optional FTS hits → current doc in full → history → user turn.
Budget 200K input tokens by default, counted with `gpt-tokenizer` (`o200k_base`), evicting
search hits first and the current document never.

---

## Open questions handed to ticket 16 (AI interaction model)

- Per-hunk vs whole-proposal accept is recommended above, but the interaction detail
  (keyboard flow, inline-in-editor vs side panel) is a UI decision.
- Whether `create` / `delete_doc` are enabled by default (`allowDeleteDocs: false` proposed).
- Chat thread scope (per-doc vs global) determines whether `store:false` reasoning replay is
  worth the portability risk — long global threads make it more valuable.
- Whether unsaved editor buffers are auto-flushed before an AI turn, or the AI simply
  operates on last-saved state with a visible marker.

## Sources

**OpenAI primary**
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Upgrading to gpt-5](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md)
- [Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Apply Patch tool](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Responses streaming events (community reference)](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122)

**Proxy / gateway behaviour**
- [the AI gateway — API overview](https://router-for-me-ai-proxyapi.mintlify.app/api/overview)
- [the AI gateway — Chat Completions](https://router-for-me-ai-proxyapi.mintlify.app/api/openai/chat)
- [the AI gateway — Streaming & WebSockets](https://router-for-me-ai-proxyapi.mintlify.app/api/openai/streaming)
- [the AI gateway #3298 — namespace tools not flattened](https://github.com/router-for-me/the AI gateway/issues/3298)
- [the AI gateway #1709 — /v1/responses vs /v1/chat/completions](https://github.com/router-for-me/the AI gateway/issues/1709)
- [LiteLLM — /responses endpoint](https://docs.litellm.ai/docs/response_api)
- [LiteLLM #33221 — function tools + reasoning_effort 400 on gpt-5](https://github.com/BerriAI/litellm/issues/33221)
- [LiteLLM #15342 — litellm_proxy lacks native Responses support](https://github.com/BerriAI/litellm/issues/15342)
- [LibreChat #14355 — GPT-5.6 + function tools 400s on chat/completions](https://github.com/danny-avila/LibreChat/issues/14355)
- [LibreChat #14203 — full Responses support: max effort, persisted reasoning](https://github.com/danny-avila/LibreChat/issues/14203)
- [OpenRouter — Apply Patch server tool](https://openrouter.ai/docs/guides/features/server-tools/apply-patch)
- [vLLM — OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/online_serving/)
- [Portkey — "Unrecognized request argument supplied"](https://portkey.ai/error-library/invalid-argument-error-10104)

**Edit formats**
- [Aider — GPT code editing benchmarks](https://aider.chat/docs/benchmarks.html)
- [Aider — Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/docs/unified-diffs.html)
- [Aider — Edit formats](https://aider.chat/docs/more/edit-formats.html)
- [Geometric — AST Edits: the code editing format nobody uses (2026-04-02)](https://geometricagi.github.io/2026/04/02/ast-edits.html)
- [The V4A diff format](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/)
- [Morph — AI code edit formats guide](https://www.morphllm.com/edit-formats)

**Runtime / libraries**
- [Bun — SSE guide](https://github.com/oven-sh/bun/blob/main/docs/guides/http/sse.mdx)
- [Bun — HTTP server / idle timeout](https://github.com/oven-sh/bun/blob/main/docs/runtime/http/server.mdx)
- [Bun — fetch streaming](https://github.com/oven-sh/bun/blob/main/docs/runtime/networking/fetch.mdx)
- [diff (jsdiff) v9 — npm](https://www.npmjs.com/package/diff)
- [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) · [js-tiktoken](https://www.npmjs.com/package/js-tiktoken)
- [LLM token counting in JavaScript 2026](https://www.pkgpulse.com/guides/gpt-tokenizer-vs-js-tiktoken-vs-xenova-transformers-llm-2026)
- [SSE with fetch + ReadableStream and auth headers](https://www.web-developpeur.com/en/blog/sse-fetch-readable-stream-api-key)

**Model specs**
- [Artificial Analysis — GPT-5.6 Sol (xhigh)](https://artificialanalysis.ai/models/gpt-5-6-sol-xhigh)
- [Sim — GPT-5.6 Sol pricing & context window](https://www.sim.ai/models/openai/gpt-5-6-sol)
- [Tiktokenizer — GPT-5.6 tokenizer](https://tiktokenizer.com/)
