# 0029 — The proposal diff is in-house

## Status

Accepted, 2026-09-02. Amends
[ADR 0011](0011-token-counts-are-an-estimate.md), which left the repo with two
runtime dependencies; there is one now. The proposal object in
[spec 0002](../specs/done/0002-http-api-v0.md) is untouched: `diff` is still an
array of `{marker, text}`.

## Context

The `diff` package (jsdiff) was a runtime dependency for one call:
`structuredPatch` inside `buildDiff()`, which turns a proposal's pre/post
images into the rows the review card renders. It also ships a word differ, a
patch parser, a three-way merge and a fuzz-tolerant applier that this repo
never calls. `node:util.diff` is `undefined` at runtime on Bun 1.4.0,
established by execution, so the choice was to keep the dependency or write the
diff.

A diff only VIEWS a proposal, since Accept writes the post-image the edits
already produced. But Myers is O(N·D), and its worst case here is an ordinary
request: a `rewrite` of a long note, whose two sides share almost no lines.
There is one replica, ever (`deploy/k3s/20-deployment.yaml`), so an unbounded
diff stops the whole server. jsdiff carried a `timeout` option
for that reason, and its replacement inherits the obligation.

## Decision

**The line-level Myers diff inside `server/ai-edits.ts` IS the diff, and its
bound is a deadline, not a size.**

- `lineHunks(pre, post, context, deadlineMs)` cuts both images into lines after
  each `\n`, diffs them, and returns hunks of `"+text"` / `"-text"` / `" text"`
  rows, the shape `buildDiff()` already consumed. Past the deadline it returns
  `null` and the card says the diff was too large to render, as the jsdiff
  timeout did. The rows are unchanged: two lines of context, `\r` stripped, the
  300-row cap, the `… diff truncated` row.
- **It is Myers' linear-space form** (his §4b: find the middle snake from both
  ends, recurse on the two halves). The textbook forward form keeps every V
  array to walk the path back, at O(D²) memory: on 20k unrelated lines a side
  that trace reaches 1.5GB *inside* the 1s budget, twice the pod's 768Mi limit,
  so the bound would kill the replica it exists to protect. Two V arrays and a
  recursion that halves the remaining edit distance cost 52MB of RSS on the
  same input.
- **A line carries its newline, so the file's final one is a visible edit.**
  Ours tokenises each line with its terminator attached, as jsdiff did. A
  document missing its final newline diffs as a changed last line, and a
  proposal whose ONLY change is that byte prints `-text` and `+text` with
  identical text. Splitting the terminator off saves one edit and renders an
  EMPTY card while Accept still changes the file, which is worse than repeating
  a line. jsdiff's `\ No newline at end of file` row is the one thing
  `buildDiff()` still drops.

## Consequences

- The runtime dependency list is `age-encryption` alone
  ([ADR 0004](0004-secrets-are-client-side-age.md)), so the zero-dependency
  rule has one exception. ADR 0011 still says "two"; ADRs are append-only, so
  this one amends it.
- The new diff is faster, which widens the deadline's usable range. Measured on
  the same machine, unbounded, unrelated lines: jsdiff 1.9s at 4k a side and
  11.4s at 10k; this diff 0.1s and 0.6s, 2.4s at 20k. The 1s deadline used to
  bite around 3k lines a side and now bites around 13k.
- Equally minimal diffs are not unique. Against jsdiff over 4000 random
  document pairs the edit distance always matched and the rows matched exactly
  in 75%; the rest place a change block differently among equal lines. Only a
  human reads these rows, so that costs nothing.
- `tests/ai-edits.test.ts` holds the claims that used to belong to the package:
  context width, the empty diff, CRLF rows, the final-newline row, the
  deadline. `tests/ai.test.ts` keeps them at the proposal layer.
