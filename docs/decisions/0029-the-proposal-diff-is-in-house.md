# 0029 — The proposal diff is in-house

## Status

Accepted, 2026-09-02. Amends
[ADR 0011](0011-token-counts-are-an-estimate.md), which left the repo with two
runtime dependencies; there is one now. The proposal object in
[spec 0002](../specs/done/0002-http-api-v0.md) is untouched — `diff` is still an
array of `{marker, text}`.

## Context

The `diff` package (jsdiff) was a runtime dependency for a single call:
`structuredPatch` inside `buildDiff()`, turning a proposal's pre/post images
into the rows the review card renders. A dependency for one function is a poor
trade at any size, and this one is not small — it ships a word differ, a patch
parser, a three-way merge and a fuzz-tolerant applier, none of which this repo
calls.

The platform offers no replacement: `node:util.diff` is `undefined` at runtime
on Bun 1.4.0 (established by execution, not by reading a changelog). The choice
was to keep the dependency or to write the diff.

The rest of the context is the deadline. A diff is a VIEW of a proposal — the
edits are already applied to the post-image and Accept writes that, not the
rows — but Myers is O(N·D), and its worst case here is not an attack: it is a
`rewrite` of a long note, whose two sides share almost no lines. There is one
replica, ever (`deploy/k3s/20-deployment.yaml`), so an unbounded diff is the
whole server stopped by an ordinary request. jsdiff was called with its
`timeout` option for exactly that reason, and whatever replaced it inherited
the obligation.

## Decision

**The line-level Myers diff inside `server/ai-edits.ts` IS the diff, and its
bound is a deadline, not a size.**

- `lineHunks(pre, post, context, deadlineMs)` cuts both images into lines after
  each `\n`, diffs them, and returns hunks of `"+text"` / `"-text"` / `" text"`
  rows — the shape `buildDiff()` already consumed. Past the deadline it returns
  `null` and the card says the diff was too large to render, which is what the
  jsdiff timeout did. Nothing else about the rows moved: two lines of context,
  `\r` stripped from row text, the 300-row cap and the `… diff truncated` row.
- **It is Myers' linear-space form** (his §4b: find the middle snake from both
  ends, recurse on the two halves), not the textbook forward pass. The textbook
  form keeps every V array it wrote so it can walk the path back, which is
  O(D²) memory: on 20k unrelated lines a side that trace reaches 1.5GB *inside*
  the 1s budget — twice the pod's limit (768Mi). A bound that OOM-kills the
  replica it exists to protect is not a bound. Two V arrays and a recursion
  that halves the remaining edit distance at every step cost 52MB of RSS on the
  same input.
- **A line carries its newline, so the file's final one is a visible edit.**
  jsdiff tokenised each line with its terminator attached, and ours does too: a
  document missing its final newline diffs as a changed last line, and a
  proposal whose ONLY change is that byte prints `-text` and `+text` with
  identical text. (jsdiff's `\ No newline at end of file` row is the one thing
  `buildDiff()` still drops.) Splitting the terminator OFF instead is one edit
  shorter and renders an EMPTY card for that proposal while Accept goes on
  changing the file — a diff that hides a real change is worse than a diff that
  repeats a line.

## Consequences

- The runtime dependency list is `age-encryption` alone
  ([ADR 0004](0004-secrets-are-client-side-age.md)), so the zero-dependency
  rule has one exception rather than two. ADR 0011 still says "two"; ADRs are
  append-only, so it stays as written and this one amends it.
- It is faster than what it replaced, which widens the deadline's usable range
  instead of narrowing it. Measured on the same machine, unbounded, unrelated
  lines: jsdiff 1.9s at 4k a side and 11.4s at 10k; this diff 0.1s and 0.6s,
  2.4s at 20k. The 1s deadline used to bite around 3k lines a side and now
  bites around 13k.
- Equally minimal diffs are not unique. Against jsdiff over 4000 random
  document pairs the edit distance matched every time, and the rows matched
  exactly in 75% of them; the rest place a change block differently among
  equal lines. Only a human reads these rows, so that is a difference, not a
  regression.
- `tests/ai-edits.test.ts` holds the claims that used to belong to the package
  — context width, the empty diff, CRLF rows, the final-newline row, the
  deadline — and `tests/ai.test.ts` keeps them at the proposal layer.
