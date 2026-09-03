# 0031 — The agent gets the same doors as the hand

## Status

Accepted, 2026-09-04. Implements
[spec 0011](../specs/done/0011-webmcp-tools.md). Reuses the error shape of
[ADR 0002](0002-http-api-v0-error-shape.md), stands on
[ADR 0004](0004-secrets-are-client-side-age.md)'s rule that the plaintext never
leaves the browser, and puts every file operation it performs on
[ADR 0014](0014-file-operations-undo-but-they-ask.md)'s timeline.

## Context

An agent that wanted to use z-notes had two doors and neither was the app's.
The HTTP API is a backend integration: it can write a doc, but it cannot see
which doc is open, cannot read the unsaved buffer, and does not know the app
exists. DOM actuation is the other extreme — a script clicking rows and reading
class names, which breaks on any change to markup that was never a contract.

WebMCP is the third door. A page registers **tools** — a name, a description, a
JSON-Schema input and an `execute` callback — on `document.modelContext`, and
the browser's agent discovers and calls them with the browser mediating. It is
a W3C WebML CG draft shipping behind an origin trial in Chrome 149, in Edge
150, in ChatGPT's browser and in Brave Leo. The registration surface has
already moved once (`navigator.modelContext` in Chrome 146–148), and the
Chromium this repo's suite drives has neither shape without a flag.

## Decision

**Every operation the human UI offers is a WebMCP tool, and the tool wraps the
very function the click or the chord calls.**

- `app/webmcp.js` is the agent's `app.js`. `app.js` wires pointer and keyboard
  input to the feature functions; `webmcp.js` wires tool calls to the same
  ones. Nothing imports it but `app.js`, which calls it last in `start()`. The
  catalogue is one table and the table IS the module.
- The catalogue is **static**. Every tool is registered once, at boot, and a
  tool that cannot act in the current state says so in its result rather than
  disappearing: an agent that has to re-read the tool list to discover that the
  terminal locked mid-session has no way to tell that from a bug.
- **Errors are data.** A tool never throws — the WebMCP spec still has an open
  issue on plumbing a rejection back to the invoker, so a thrown error may
  reach the agent as an opaque failure with nothing to correct against. Failure
  is `{ error, message, ...extra }`, ADR 0002's own shape, with the API's code
  and message passed through verbatim (`exists`, `rev-conflict` + `rev`,
  `bad-path`) and `"failed"` for anything else.
- **Registration goes to the browser's own door first**, and never replaces
  one: `document.modelContext` when it exists, else `navigator.modelContext`
  when it can `registerTool`. When `document.modelContext` is absent the module
  also *defines* it over the same table, so a puppeteer-, Playwright- or
  DevTools-driven agent gets the same catalogue and the same JSON-string
  results in every browser shipping today.
- **No tool decrypts, reveals or takes a passphrase.** An agent platform is a
  cloud, so ADR 0004's rule extends to it unchanged. `lock_vault` is the only
  secrets verb, `encrypt_selection` stays a human gesture on a Raw selection,
  and `tests/webmcp.test.ts` reads the module's source to hold it.
- The shell carries `Origin-Agent-Cluster: ?1` and
  `Permissions-Policy: tools=(self)`. Chrome refuses registration without an
  origin-keyed agent cluster, and says nothing about why; the headers ride on
  `index.html` only, which is what `/`, `/d/*` and `/settings*` all resolve to.

## Consequences

- **A new UI operation is not done until it has a tool.** That is the price of
  the claim, and it is deliberately the same price as a keyboard chord: an
  operation reachable only by mouse was always half-built.
- The human-approval gates the app owns — the delete confirmation, the
  terminal's Run button — are delegated for an agent to the *browser's* own
  confirmation, through `consequentialHint`. The agent stands in the user's
  seat, so the seat is where the asking happens. Nothing about the gates a
  human sees changed.
- Wrapping the UI's functions rather than the HTTP API is what makes the open
  buffer, the undo timeline, the tree and the address bar follow a tool call.
  It also means a tool inherits the function's bugs — which is the point: there
  is one implementation to fix, not an agent-shaped copy of it.
- The in-page implementation is a fallback, not a product. It is same-origin
  only, has no `exposedTo` and no `fromOrigins`, and it is never installed over
  a native one. When the native API is everywhere it can be deleted and nothing
  else changes.
- A registration rejection is a `console.warn`, never a toast. The human UI
  must not report an agent-facing failure to someone who did nothing.
