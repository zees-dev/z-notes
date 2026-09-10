# 0002 — The HTTP/SSE v0 contract is normative; error bodies are `{error, message, ...extra}`

**Status:** accepted · 2026-08-01 (recorded 2026-08-07 at retrofit)

## Context

The frontend was built against a mocked API before the backend existed; the
whole test suite is black-box over HTTP. Both only work if the contract is a
fixed document, not emergent behavior.

## Decision

- [specs/done/0002-http-api-v0.md](../specs/done/0002-http-api-v0.md) is the
  normative contract. Server behavior is byte-compatible with it; changes
  start as a new spec in `specs/open/`, never as an edit to the archive.
- Every error body is `{error: "<stable-slug>", message: "<prose>", ...extra}`
  in exactly that key order (`http.ts` `fail()` is the single constructor).
  Slugs are contract; messages are not.
- Doc writes are CAS on an opaque content-derived `rev`; mismatch is
  `409 rev-conflict` carrying the current `rev` + `markdown`.

## Consequences

Tests may compare serialized bytes. Clients branch on slugs only. Any new
route or field lands in a spec first, and its error slugs are chosen at spec
time, not implementation time.
