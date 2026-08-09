# 0011 — Token counts are an estimate, and always were

## Status

Accepted, 2026-08-09. Amends the `tokensEstimated` paragraph in
[the HTTP contract](../specs/done/0002-http-api-v0.md), which promised the
opposite. Removes `gpt-tokenizer` from the dependency list in AGENTS.md.

## Context

`server/ai.ts` counted tokens with `gpt-tokenizer`'s real `o200k_base` BPE
encoder — exact for the default model, and reached by a static top-level
import, so the cost was paid at boot whether or not anyone opened the AI panel.

Measured, that cost is **~123 MB of resident memory** (345 MB RSS with it,
219 MB without, on the same vault) and **55 MB on disk** — the single largest
thing in `node_modules`, and one of the three that ship to production. The
deployment budgets `requests.memory: 192Mi` and its comment described a process
using "~40-70MB RSS": the tokenizer alone was roughly twice the entire request,
so that comment had been wrong since the AI panel landed.

What the exactness bought is the whole argument. Every consumer of the number
is advisory:

- the chat panel paints it with a literal `~`, next to a percentage of a
  256k window this app fills to 200k — 28% slack;
- `assembleContext` uses it to pick which *optional* block to evict, then
  sends the turn unconditionally. No refusal anywhere depends on it, and the
  current document is never truncated by design;
- `clampToTokens` caps an optional linked doc, and already reasoned in
  characters in its own comment.

The real limits are enforced upstream by the endpoint, which answers an
over-window request with an error `runTurn` already handles. And exactness was
conditional anyway: `ai.model` is deliberately un-enumerated so the relay can
point at Claude or Gemini through the AI gateway, for which `o200k_base` is itself
just a heuristic.

The old implementation made the case itself — its own `catch` block already
returned `length / 3.6` and nothing downstream could tell the two apart.

## Decision

`countTokens` is a character estimate: `Math.ceil(text.length / 3.9)`.

The divisor is measured against this repo's own corpora under real
`o200k_base` — markdown 3.85, TypeScript 3.99, JavaScript 3.91 chars/token —
and holds aggregate error inside ±2%, with per-file MAPE of 2–5%. That is an
order of magnitude smaller than the undercount `estimateTokens` already carries
by design for the blocks it cannot cheaply predict.

3.6, the old fallback constant, was the *worse* choice: it over-counted by
7–11%. A word-and-punctuation heuristic is worse still (MAPE 27–38%) — o200k is
a byte-level BPE and character count is simply the better proxy.

`gpt-tokenizer` is removed from `package.json`.

## Consequences

- Server RSS drops ~123 MB and the image loses 55 MB; the deployment's 192Mi
  request becomes honest rather than aspirational, and its comment is corrected
  in the same change.
- The contract text in `0002-http-api-v0.md` now states the estimate and its
  error band, rather than promising a BPE count.
- The lone-surrogate `try/catch` is gone with the encoder — a character count
  cannot throw.
- No test changed. Nothing asserted an exact count: the existing assertions are
  `> 0`, `typeof === "number"` and monotone growth, which is itself evidence
  for how advisory the number always was.
- Two runtime dependencies remain, `age-encryption` and `diff`. Both were
  audited in the same change and both are KEEP — the first because hand-rolling
  ChaCha20-Poly1305 and scrypt is indefensible and would break interop with the
  Go `age` CLI that ADR 0004 guarantees, the second because it is a
  zero-transitive-dep leaf whose replacement would be ~150 lines this repo
  would then own and have to test.
