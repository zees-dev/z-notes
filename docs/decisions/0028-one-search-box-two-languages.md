# 0028 — One search box, two languages

## Status

Accepted, 2026-08-21. Extends
[spec 0002](../specs/done/0002-http-api-v0.md)'s `GET /api/search` additively —
no field changes meaning, and fuzzy queries answer exactly as before.

## Context

Search was subsequence-only. That is the right default for reaching a document
whose name you half-remember, and the wrong tool for every question with a
*shape*: find the `TODO(name)` markers, the four-digit error codes, the lines
that start with `WARN`. Those are regular expressions, and there was nowhere to
type one.

The scan behind it also read every line of every document on every keystroke,
re-splitting and re-lowercasing the whole vault between one letter and the next.
Adding a second, heavier matcher on top of that was not an option without fixing
it first.

## Decision

**The one box takes both, and says which one it just used.**

- **`/pattern/flags` is a regex**, and says so without a second parameter — it
  survives a URL, a bookmark and a `curl`. **`mode=regex`** reads a *bare*
  pattern as one, which is what the palette's toggle sends. Anything else is
  fuzzy, unchanged.
- **The slash form only claims a query whose tail is real flags.** `/etc/hosts`
  and `/usr/bin` are paths people search for, not patterns with a flag set
  called `hosts`; reading them as regex made ordinary text unsearchable and
  answered with a complaint about a flag nobody typed. **`mode=fuzzy`** is the
  matching escape hatch for text that genuinely is shaped like a pattern — it
  is what the fuzzy chip sends, so clicking it never rewrites what you typed.
- **The toggle reports as much as it controls.** The chips are painted from the
  mode the *server answered with*, so a `/regex/` query lights the regex chip
  with nobody clicking anything. The explicit choice and the detected mode are
  kept apart: unwrapping `/foo/` back to `foo` returns to fuzzy rather than
  leaving regex silently on, and clicking `fuzzy` while the box holds slashes
  removes them, so the control always does what it says.
- **`m` is always on.** This searches a vault line by line, so `^` and `$` mean
  the ends of a line — what a person means by them here, and what makes the
  whole-document pre-check agree with the per-line pass. `g` and `y` are
  stripped: iteration is the server's job, and a caller-supplied `lastIndex` in
  a matcher that runs over every line of every document is a foot-gun.
- **A pattern that will not compile is a result, not an error.** `200`, empty
  results, and `invalid` carrying the reason. A box being typed into holds an
  incomplete pattern most of the time; a 400 per keystroke would be a toast
  storm over normal typing.
- **A document is rejected whole before its lines are scored.** A line can only
  match if the document does, in both modes, so the per-keystroke cost collapses
  from every line in the vault to the lines of the few documents that can
  possibly answer. Lines are split and lowercased once and kept against the
  content hash the reconciler already computes.
- **The sweep runs against a deadline** and reports `partial` when it hits one.
  This is the one process serving SSE, saves and git: partial results now beat
  complete results delivered after the next keystroke has replaced them.

## Consequences

- Measured over 400 documents (~48k lines): a selective fuzzy query went 8.0ms →
  1.5ms, the one-character worst case 6.9ms → 3.3ms, and regex queries land in
  1–3ms.
- **`^` and `$` mean the ends of the line as DISPLAYED**, indentation excluded,
  because lines are matched trimmed — which is also what the hit shows and what
  its offsets index into. The pre-check is asked of exactly that rejoined text;
  asked of the raw body instead, `/^- \[/` matched no indented list item
  anywhere, because the document was discarded before its lines were tried.
- The regex is the vault owner's own, and a catastrophic one stalls only their
  own search — but it stalls the single process, so it is bounded rather than
  trusted: lines are capped before matching, highlight offsets are capped, and
  the deadline ends the sweep. This narrows backtracking; it does not abolish
  it, and a small enough budget is the only honest guard available in-process.
- The line cache is bounded at 4M source characters **per vault**, and that is
  the accounting unit, not the memory: an entry holds trimmed lines, lowercased
  lines and (for regex) a rejoined copy, so at the cap expect tens of MB per
  vault once per-string overhead is counted. Keyed by hash — two identical
  documents share one entry, and an edit invalidates only its own.
- Every character an entry adds to that counter is one eviction gives back.
  Billing more than is refunded — as building the rejoined copy did, including
  for documents too large to cache at all — ratchets the counter up until the
  cache evicts everything on sight and each keystroke rebuilds the vault:
  slower than no cache, and invisible, because search still answers correctly.
  `tests/index-recovery.test.ts` holds that invariant, white-box, for that
  reason.
