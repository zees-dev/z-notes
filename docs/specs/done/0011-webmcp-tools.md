# 0011 — WebMCP: the app registers its operations as tools an agent can call

## Problem Statement

An AI agent that wants to use z-notes today has two doors: the HTTP API (a
backend integration, blind to the UI and to the user's unsaved buffer) or
brittle DOM actuation of the human interface. WebMCP
(<https://github.com/webmachinelearning/webmcp>, W3C WebML CG draft; Chrome 149
origin trial, Edge 150, ChatGPT's built-in browser, Brave Leo) is the third
door: a page registers **tools** — name, description, JSON-Schema input, an
`execute` callback — on `document.modelContext`, and the browser's agent (or an
in-page/extension agent) discovers and calls them, mediated by the browser.

The API, verbatim from the spec IDL:

```
partial interface Document { [SecureContext, SameObject] readonly attribute ModelContext modelContext; };
[Exposed=Window, SecureContext] interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject = {}, optional ModelContextExecuteToolOptions options = {});
  attribute EventHandler ontoolchange;
};
dictionary ModelContextTool { required DOMString name; USVString title; required DOMString description;
  object inputSchema; required ToolExecuteCallback execute; ToolAnnotations annotations; };
dictionary ToolAnnotations { boolean readOnlyHint = false; boolean untrustedContentHint = false; boolean consequentialHint = false; };
callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options); // options.signal: AbortSignal
dictionary ModelContextRegisterToolOptions { sequence<USVString> exposedTo; AbortSignal signal; };
```

Facts the design leans on (all measured or read from primary sources):

- `name` is 1–128 chars of `[A-Za-z0-9_.-]`; an empty `description`, a
  duplicate name or an unserialisable `inputSchema` rejects `registerTool`.
- `execute`'s return value is JSON-serialised by the browser and handed to the
  agent as a string; `executeTool` resolves to that string. The spec has an
  open issue on plumbing *thrown* errors back to the invoker, so a rejection
  may reach the agent as an opaque failure.
- `[SecureContext]`: `http://localhost` and any HTTPS origin qualify; a plain
  LAN IP does not (the same line the secrets feature already lives on).
- Chrome refuses registration unless the agent cluster is origin-keyed; the
  Netlify/Chrome guidance is to send `Origin-Agent-Cluster: ?1` and
  `Permissions-Policy: tools=(self)` with the page.
- Chrome's own guidance: one responsibility per tool, verbs, positive
  descriptions, explicit types, "validate strictly in code, loosely in
  schema", descriptive errors so the model can self-correct, ≤ 500 chars per
  description, `readOnlyHint` on reads, `untrustedContentHint` on
  user-generated output, `consequentialHint` on the irreversible.
- ChatGPT's browser discovers tools only via JavaScript registration in the
  **top-level** document and asks the user before consequential ones.
- The suite's Chromium (`tests/helpers.ts` `findChromium()`, currently
  Chrome for Testing **145**) has no `document.modelContext`. With
  `--enable-features=WebMCP` it exposes the **previous** shape,
  `navigator.modelContext` with `registerTool / unregisterTool /
  provideContext / clearContext` and no `getTools`/`executeTool`
  (measured 2026-09-04 on a secure `http://localhost` origin).

## Solution

**One frontend module, `app/webmcp.js`, registers every operation the human
UI offers as a WebMCP tool, each wrapping the very function the click or chord
calls; a browser without the API gets an in-page `document.modelContext` so any
automation can use the same door; and the shell is served with the two
headers Chrome wants.**

- `webmcp.js` is the agent's `app.js`: `app.js` wires pointer and keyboard
  input to feature functions, `webmcp.js` wires tool calls to the same
  functions. Nothing imports it but `app.js`, which calls it last in `start()`.
- The catalogue is static: every tool is registered once the app has booted,
  and a tool that cannot act in the current state says so in its result
  (`{"error":"terminal-locked", …}`) rather than being unregistered.
- **Errors are data.** A tool never throws. Failure is
  `{ error: "<slug>", message: "<text>", ...extra }` — the API's own error
  shape (ADR 0002), with the `ApiError` code and message passed through
  verbatim (`exists`, `not-found`, `rev-conflict` + `rev`, `bad-path`, …) and
  `"failed"` for anything else. Success is the payload described per tool.
- **Registration target.** In order: `document.modelContext` (the current
  API); else `navigator.modelContext` when it has `registerTool` (the
  Chrome 146–148 shape — same tool dictionary); and when
  `document.modelContext` is absent the module **also** defines it with an
  in-page implementation of `registerTool` / `getTools` / `executeTool` /
  `toolchange` over the same table, so puppeteer-, Playwright- and
  DevTools-driven agents can discover and call tools in every browser today.
  A native `document.modelContext` is never replaced or wrapped.
- **No tool decrypts, reveals or takes a passphrase.** The hard rule that no
  plaintext secret leaves the browser extends to the agent: an agent
  platform is a cloud. `lock_vault` is the only secrets verb.
- The shell responses (`/`, `/d/*`, `/settings*`) carry
  `Origin-Agent-Cluster: ?1` and `Permissions-Policy: tools=(self)`.

## User Stories

1. As a browser agent (ChatGPT's browser, Chrome with the origin trial), I
   open z-notes and see its tools in the site-tools list, so that I can act
   on the vault without scraping the DOM.
2. As an agent, I call `get_app_state` and learn which doc is open, in which
   mode, whether it is dirty, the connection and sync state, whether secrets
   are unlocked and whether the terminal is enabled/unlocked, so that I can
   plan the next call.
3. As an agent, I call `list_docs` and get every vault with a flat list of its
   docs and folders in tree order, qualified paths included.
4. As an agent, I call `read_doc` and get the doc's markdown and `rev`; if it
   is the open doc with unsaved edits I get the buffer and `unsaved: true`.
5. As an agent, I `create_doc` at a path with initial markdown; parent folders
   appear, the doc opens in the UI, ⌘Z asks before removing it (ADR 0014),
   and a taken name answers `{"error":"exists"}`.
6. As an agent, I `write_doc` / `edit_doc` (exact find → replace) /
   `append_to_doc`; the change lands on disk, the open editor repaints, the
   edit is one step on the undo timeline, and a stale `rev` answers
   `{"error":"rev-conflict","rev":"…"}`.
7. As an agent, `edit_doc` with a `find` that occurs twice answers
   `{"error":"ambiguous","count":2}` unless I pass `all: true`; absent
   answers `{"error":"not-found"}`.
8. As an agent, I `move_doc` and backlinks are rewritten exactly as a sidebar
   rename does; a cross-vault destination is refused with the app's message.
9. As an agent, I `delete_doc`; it goes to the trash (when the trash is
   available), the pane moves to the neighbour, and `list_trash` shows it;
   `restore_from_trash` puts it back and opens it.
10. As an agent, `purge_trash` and `empty_trash` are marked consequential, so
    a confirming browser asks the user first.
11. As an agent, I `search_docs` fuzzily or by regex and get the server's
    hits, qualified paths across every vault.
12. As an agent, I `open_doc` (optionally at a line and in a mode) and the
    statusbar, the address bar and the tree all follow; an unsaved buffer is
    saved on the way, never discarded.
13. As an agent, I `set_setting("theme","terminal")` and the page repaints
    and `settings.toml` holds it; an unknown value answers the server's
    own slug (`unknown-theme`).
14. As an agent, I `show_panel` the sidebar, assistant or trash and
    `dismiss_overlay` whatever layer is on top, so that I can put the UI in
    a known state.
15. As an agent, I `ask_assistant` and get the relay's reply text plus any
    proposal it made; `accept_proposal` / `revert_proposal` /
    `reject_proposal` drive the change stack; `new_session` clears context.
    Cancelling the tool call (the agent's `signal`) aborts the stream.
16. As an agent, `unlock_terminal` with the password, `run_command`,
    `cancel_command`, `approve_command` / `reject_command` for the
    assistant's queued commands, and `lock_terminal` — each refused with a
    named error when the terminal is disabled or locked; `run_command` and
    `approve_command` are consequential.
17. As an agent, `sync_vault`, `add_vault`, `set_vault_remote`,
    `disconnect_vault` (consequential) do what the settings page does.
18. As an agent, `undo` / `redo` step the app's timeline; a file step
    raises the app's confirmation and the result says
    `{"applied":false,"confirm":"…"}` until the user answers it.
19. As an agent, no tool returns a decrypted secret and no tool takes a
    passphrase; `lock_vault` exists.
20. As an automation driver on Chromium 145 (no native API), I call
    `document.modelContext.getTools()` / `executeTool()` from `page.evaluate`
    and get the same catalogue and JSON-string results the spec promises.
21. As the app on a browser with a native `document.modelContext`, I register
    there and never overwrite it.
22. As the app on Chrome 146–148, I register on `navigator.modelContext`.
23. As a user on a phone, an insecure LAN origin or a browser with no agent,
    nothing changes: registration is silent, the polyfill costs nothing
    visible, and every existing test still passes.
24. As a reader of the docs, I find one page that says what the tools are,
    where they live, and why errors are data (ADR + architecture + README).

## Implementation Decisions

### Tool catalogue

Names are `snake_case`. Every tool: `title` (short, for the browser's UI),
`description` ≤ 500 chars, `inputSchema` `{ type: "object", properties,
required?, additionalProperties: false }`, every property with a
`description`. Success payloads are objects; failure is
`{ error, message, ...extra }`. `RO` = `readOnlyHint`, `UC` =
`untrustedContentHint`, `CQ` = `consequentialHint`.

| Tool | Input | Wraps | Returns |
|---|---|---|---|
| `get_app_state` RO | — | `state`, `vault` (secrets.js), `state.term.status`, `pendingHistory` | `{ activeDoc, view, settingsSection, mode, unsaved, connection, sync:{state,remote}, vaults:[{id,label,sync}], secrets:{state,unlocked}, terminal:{enabled,unlocked,running}, assistant:{sessionId,model,messages,proposalsPending}, panels:{sidebar,assistant,trash}, undo:{canUndo,canRedo} }` |
| `list_vaults` RO | — | `api.getVaults()` | `{ vaults:[{id,label,prefix,remote,repo,docCount,sync}] }` |
| `list_docs` RO UC | `vault?`, `folder?` | `state.vaults` trees, flattened depth-first | `{ vaults:[{id,label,prefix,docCount}], docs:[{path,type,title,bytes,mtime,empty,hasSecrets}] }` (`folder?` filters to that subtree) |
| `read_doc` RO UC | `path` | active+dirty → `syncRaw()` + buffer; else `api.getDoc` | `{ path,title,rev,markdown,bytes,mtime,hasSecrets,unsaved }` |
| `search_docs` RO UC | `query`, `mode?` (`fuzzy`\|`regex`), `limit?` | `api.search` | the API's response verbatim |
| `list_trash` RO UC | — | `api.getTrash()` | `{ available, retentionDays, entries }` |
| `get_settings` RO | — | `state.settings`, `state.meta` | `{ settings, meta }` (credentials are already masked by the server) |
| `list_proposals` RO | — | `state.proposals`, `state.stack` | `{ proposals:[{id,label,state,stackIndex,path}], stack:[ids] }` |
| `get_conversation` RO UC | `limit?` | `state.session.messages` | `{ sessionId, model, messages:[{id,role,content,proposalId,at}] }` (last `limit`, default 20) |
| `terminal_status` RO | — | `refreshTerminalStatus()` | the status object or `{ error:"terminal-disabled" }` |
| `list_commands` RO UC | — | `state.commands` (after `loadCommands()`) | `{ commands:[{id,command,state,messageId}] }` |
| `open_doc` | `path`, `mode?`, `line?` | `openDoc(path,{force:true,line})` then `setMode` | `{ path, mode }` |
| `set_mode` | `mode` | save if dirty, `setMode(mode,{force:true,silent:true})` | `{ mode }` |
| `open_settings` | `section?` | save if dirty, `showSettings(section,{})` | `{ view:"settings", section }` |
| `show_panel` | `panel` (`sidebar`\|`assistant`\|`trash`), `open` | `openNav/closeNav` or `sidebar-collapsed`, `toggleChat`, `toggleTrash` — only when the state differs | `{ panel, open }` |
| `dismiss_overlay` | — | `dismissTop()` | `{ dismissed }` |
| `create_doc` | `path`, `markdown?` | `mintEntry({path,kind:"doc",markdown},{open:true})` | `{ path, rev }` |
| `create_folder` | `path` | `mintEntry({path,kind:"folder"})` | `{ path }` |
| `write_doc` | `path`, `markdown`, `rev?` | `replaceDocText(path, markdown, rev)` | `{ path, rev, bytes }` |
| `edit_doc` | `path`, `find`, `replace`, `all?` | read → exact replace → `replaceDocText` | `{ path, rev, replaced:n }` |
| `append_to_doc` | `path`, `markdown` | read → append (a `\n` between when the doc lacks one) → `replaceDocText` | `{ path, rev, bytes }` |
| `save_doc` | `path?` | `saveDoc(path)` | `{ path, saved, rev }` |
| `move_doc` | `from`, `to` | `moveByPath(from,to)` | `{ from, to, backlinksUpdated }` |
| `delete_doc` CQ | `path` | save if it is the dirty active doc, `doDelete(path,kind,{force:true})` | `{ path, deleted, trash }` |
| `undo` / `redo` | — | `flushTextRun()`, `stepHistory(redo)` | `{ applied, entry:{kind,path} }`; a file step: `{ applied:false, confirm:"The app is asking the user to confirm" }` |
| `restore_from_trash` | `id` | `restoreTrashEntry(id)` | `{ id, path }` |
| `purge_trash` CQ | `id` | `purgeTrashEntry(id)` | `{ id, purged:true }` |
| `empty_trash` CQ | — | `emptyTrash()` | `{ purged:n }` |
| `set_setting` | `path` (dotted), `value` (any JSON) | `api.patchSettings(nest(path,value))` then `adoptSettings(r)` | `{ path, value }` (the stored value) |
| `sync_vault` | `vault?` | primary: `syncNow()` (shell.js) then `api.getSyncStatus()`; else `api.syncVault(id)` | the sync status object |
| `add_vault` | `url`, `name?`, `token?` | `api.addVault` | the vault descriptor |
| `set_vault_remote` | `vault?`, `url` | `api.attachRemote` / `api.setVaultRemote` | the response |
| `disconnect_vault` CQ | `id` | `api.removeVault` | `{ id, disconnected:true }` |
| `ask_assistant` UC | `message` | `sendMessageText(message,{signal})` | `{ reply, proposal:{id,label,path}\|null, commands:[…] }` |
| `accept_proposal` / `revert_proposal` / `reject_proposal` | `id` | `proposalAction(id, verb)` | `{ id, state }` |
| `new_session` | — | `startNewSession()` | `{ sessionId }` |
| `unlock_terminal` | `password` | `terminalUnlock(password)` | the status object |
| `lock_terminal` | — | `terminalLock()` | `{ unlocked:false }` |
| `run_command` CQ UC | `command` | `runTerminal(command,{capture:true})` | `{ code, signal, ms, cwd, output }` (`output` capped to the last 64 KiB) |
| `cancel_command` | — | `terminalStop()` | `{ cancelled }` |
| `approve_command` CQ UC | `id` | `runTerminal(c.command,{commandId:id,byAi:true,capture:true})` (the card's own call, terminal.js:559) | as `run_command` |
| `reject_command` | `id` | `api.terminalRejectCommand(id)`, `loadCommands()` | `{ id, state:"rejected" }` |
| `lock_vault` | — | `lockVault("manual")` | `{ locked:true }` |

Named refusals the wrappers produce themselves (slug → when):
`terminal-disabled`, `terminal-locked`, `terminal-busy`, `no-session` (the
assistant has no session), `not-found` (a path/id the tree or trash does not
know), `ambiguous` (+`count`), `bad-mode`, `bad-panel`, `bad-vault`,
`no-active-doc`, `aborted`, `assistant-busy` (a turn is still streaming),
`secrets-disabled` (no keyring can open in this context).

### `app/webmcp.js` (new feature module)

Banner per `docs/style.md`. Imports: `state`, `api`, `ui` helpers, and the
feature functions named above. Exports exactly one function,
`registerWebMcpTools()`, called from `start()` in `app/app.js` as the last
line (after `initSecrets().then(…)` is kicked off; it needs nothing from
it). Structure:

```js
/** every tool, in one table — the catalogue IS the module */
const TOOLS = [ { name, title, description, inputSchema, annotations, execute }, … ];

/** ApiError → its own body; anything else → "failed". Never throws. */
const attempt = (fn) => async (input, opts) => { try { return await fn(input || {}, opts); }
  catch (err) { return err && err.name === "AbortError" ? { error: "aborted", message: "Cancelled." }
    : err && err.name === "ApiError" ? { error: err.code, message: err.message, ...extrasOf(err.body) }
    : { error: "failed", message: (err && err.message) || String(err) }; } };

export async function registerWebMcpTools() {
  const native = document.modelContext || (navigator.modelContext && typeof navigator.modelContext.registerTool === "function" ? navigator.modelContext : null);
  if (!document.modelContext) installModelContext(); // the in-page door, over the same table
  const target = native || document.modelContext;
  for (const t of TOOLS) await target.registerTool({ ...t, execute: attempt(t.execute) }).catch((e) => console.warn("[webmcp] " + t.name, e));
  if (native && native !== document.modelContext) for (const t of TOOLS) polyfill.add(t) /* so getTools/executeTool see them too */;
}
```

`installModelContext()` defines a non-enumerable `document.modelContext`
implementing the IDL above over a `Map`: `registerTool` validates the name
regex, non-empty description, duplicate name, serialisable schema (reject
with a `DOMException("…", "InvalidStateError")`), honours `options.signal`
(abort → unregister → `toolchange`); `getTools()` resolves to
`{ name, title, description, inputSchema: structuredClone, annotations,
origin: location.origin, window }` sorted by name; `executeTool(tool, input,
{signal})` looks the tool up **by name**, round-trips `input` through
`JSON.parse(JSON.stringify(input))`, calls `execute(input, { signal })`, and
resolves to `JSON.stringify(result)` (a `undefined` result → `"null"`);
`ontoolchange` + `addEventListener("toolchange")` fire on register/unregister.
No `exposedTo` / `fromOrigins` handling — same-origin only.

### Seams to add in existing modules (all small, all exported)

- `app/tree.js`: `export async function mintEntry({ path, kind, markdown }, { open } = {})`
  — `api.createEntry` → `rememberFileOp({kind:"create",…})` → `revealFolder`
  → `loadTree()` → (`open` && doc) `openDoc(path)` + `setMode("raw",{silent:true,caret:0})`;
  returns the create response. `commitCreate` and `createFromLink` call it
  (keeping their own toasts/error UI); `uploadFiles` may. `export async
  function moveByPath(from, to)` resolves `kind` via `treeLocate` and calls
  `moveEntry`; `moveEntry` returns the PATCH response object on success
  (truthy — the callers test `!== false`) instead of `true`. `export`
  `doDelete` as is.
- `app/editor.js`: `export ensureLoaded`; `export async function replaceDocText(path, markdown, rev)`:
  `ensureLoaded(path)`; if `rev` given and `!== doc.rev` → throw
  `new ApiError(409, { error:"rev-conflict", message:"…", rev: doc.rev })`;
  if active → `syncRaw()`; `doc.markdown = markdown`; `noteTextEdit(path)`;
  `flushTextRun()`; if active → `renderDoc()` (`syncRawFromModel` if Raw);
  `await saveDoc(path, { silent:true })` → `{ path, rev: doc.rev, bytes: doc.bytes }`;
  a save that returns false → throw `{ error:"not-saved" }`-shaped error.
- `app/chat.js`: `export async function sendMessageText(text, { signal } = {})`
  — the body of `sendMessage()` from `abortStream()` on, taking `text`;
  `sendMessage()` reads and clears the composer and delegates. It returns
  `{ reply, proposal, commands }` built from the turn result (`r.messages`
  last assistant `content`, `r.proposal`, `r.commands`). An external
  `signal` aborts the same `streamCtl`. `export function proposalAction(id, verb)`
  → `applyProposal`/`rejectProposal`; returns the proposal's new state
  (`absorbProposalResult` already writes it into `state.proposals`).
- `app/terminal.js`: `terminalUnlock(password)` — the parameter wins, the
  `#termPass` field is the fallback; `export runTerminal`; `opts.capture`
  collects stdout/stderr chunks into a string and the return becomes
  `{ ...exit, output }`; when `state.term.busy` and `capture`, throw
  `{ error:"terminal-busy" }` instead of toasting.
- `app/trash.js`: `export restoreTrashEntry(id)`, `purgeTrashEntry(id)`,
  `emptyTrash` — the first two `refreshTrash()` then find the entry (absent →
  `not-found`) and call the existing functions; they return `{ path }` /
  `{ purged:true }`.
- `app/settings.js`: nothing new — `showSettings`, `adoptSettings`,
  `savedValue` are exported already.
- `app/shell.js`: nothing new — `syncNow`, `dismissTop`, `openNav/closeNav`,
  `toggleChat`, `isDrawer`, `app` are exported.

### Server

`server/index.ts` `serveStatic`: when the resolved file is the shell
(`rel === "index.html"`, which is what `/`, `/d/*` and `/settings*` resolve
to), add `"origin-agent-cluster": "?1"` and `"permissions-policy": "tools=(self)"`
to `headers`. Static assets are untouched. The 304 and HEAD branches share
the same `headers` object, so they carry them too.

### Docs (same change)

- `docs/decisions/0031-the-agent-gets-the-same-doors.md` — format as
  ADR 0030. Decision: every UI operation is a WebMCP tool wrapping the
  function the UI calls; the catalogue lives in `app/webmcp.js`; a browser
  without `document.modelContext` gets an in-page one; errors are data in
  the ADR 0002 shape; no tool decrypts or takes a passphrase; the shell
  carries the two headers. Consequences: a new UI operation is not done
  until it has a tool; the human-approval gates (delete confirm, terminal
  approval) are delegated to the *browser's* confirmation for
  `consequentialHint` tools, so the agent stands in the user's seat.
- `AGENTS.md` (must stay ≤ 100 lines; it is 99): append to the ADR
  sentence list `…0031 registers every UI operation as a WebMCP tool
  (\`app/webmcp.js\`)`. Add `webmcp` to the `app/` bullet's feature list
  sentence if it fits without a new line.
- `docs/architecture.md` Frontend modules: `webmcp.js` in the Features
  bullet, plus one paragraph "Agents" after it saying what the module is,
  the registration order, the polyfill, and that errors are data.
- `docs/specs/done/0002-http-api-v0.md` App shell → `GET /d/{path}`: one
  sentence naming the two headers the shell carries and why.
- `docs/glossary.md` Infrastructure: **tool** (a WebMCP tool: a named,
  schema'd operation in `app/webmcp.js`; *not* the AI relay's upstream tool
  calls, which stay "edits"/"proposals") and **agent** (whatever calls
  tools through `document.modelContext`).
- `README.md`: a "**Agent-ready**" bullet under *What it does* and a short
  "Drive it from an agent" section under *Run it*: Chrome 149+ /
  `chrome://flags/#enable-webmcp-testing` / ChatGPT's browser see the tools;
  any automation can `await document.modelContext.getTools()`.

## Testing Decisions

Two seams: the browser (`tests/browser.ts`) for everything the tools do,
the HTTP seam (`tests/helpers.ts`) for the headers.

**`tests/webmcp-e2e.test.ts`** (new; imitate `tests/upload-e2e.test.ts` for
the server+browser+disk shape, `tests/ai-e2e.test.ts` for the mock upstream,
`tests/terminal.test.ts` `armed()` for the terminal preamble). Tools are
called from `page.evaluate` through `document.modelContext.executeTool` and
the JSON string is parsed in the test. Tests:

1. **Catalogue.** After boot, `getTools()` returns exactly the names in the
   table above (assert the sorted array literally), every name matches
   `/^[A-Za-z0-9_.-]{1,128}$/`, every description is 1–500 chars, every
   `inputSchema.type === "object"`, the eleven `RO` tools carry
   `readOnlyHint`, the six `CQ` tools `consequentialHint`.
2. **Native `document.modelContext` is used, not replaced.** `newAppPage`
   with `beforeLoad` defining a recording `document.modelContext`
   (`registerTool` pushes to `window.__mcpTools`, plus `getTools`); after
   boot `window.__mcpTools.length` equals the catalogue size and
   `document.modelContext` is still the double.
3. **`navigator.modelContext` fallback.** A second browser launched with
   `--enable-features=WebMCP` (add an `args` option to `launchTestBrowser`),
   `beforeLoad` wrapping `navigator.modelContext.registerTool` in a counter;
   after boot the count equals the catalogue size, no `pageerror`, and
   `document.modelContext.getTools()` (the polyfill) lists them too.
4. **Doc lifecycle on disk.** `create_doc` → file exists with the markdown;
   `edit_doc` → bytes replaced; `append_to_doc` → bytes appended; `read_doc`
   → `rev` and `unsaved:false`; `move_doc` → new path on disk, old gone;
   `delete_doc` → gone, `list_trash` lists it; `restore_from_trash` → back;
   `undo` after `edit_doc` → the previous bytes (a text step, no prompt).
5. **Errors are data.** `read_doc` unknown → `{error:"not-found"}`;
   `create_doc` duplicate → `{error:"exists"}`; `edit_doc` ambiguous →
   `{error:"ambiguous",count:2}`; `write_doc` stale rev →
   `{error:"rev-conflict"}`; `set_setting` bad theme → `{error:"unknown-theme"}`
   (the server's slug, verbatim); `run_command` while locked → `{error:"terminal-locked"}` (or
   `terminal-disabled`).
6. **UI follows.** `open_doc` → `#stPath` text and `location.pathname`;
   `set_mode("raw")` → `#doc.raw-mode`; `open_settings("ai")` →
   `route-settings`; `show_panel("assistant", false/true)` → `chat-open`;
   `get_app_state` reflects each.
7. **Settings.** `set_setting("theme", <a meta theme>)` → `html[data-theme]`
   and `settings.toml` on disk.
8. **Search.** `search_docs` finds a seeded doc; `mode:"regex"` echoes
   `mode:"regex"`.
9. **Assistant.** With `startMockUpstream()`, `ask_assistant("hi")` returns
   the mocked reply and the composer is untouched.
10. **Terminal.** Set a password through the API (`armed`'s first step),
    `unlock_terminal` → `run_command("echo hi")` → `output` contains `hi`,
    `code === 0`; `lock_terminal` → `run_command` refused.

**`tests/webmcp.test.ts`** (new, HTTP + source text; imitate the header
assertions in `tests/routing.test.ts`/`tests/api.test.ts` and the source
guard in `tests/fileops.test.ts`):

- `GET /`, `GET /d/a.md`, `GET /settings/ai` carry
  `origin-agent-cluster: ?1` and `permissions-policy: tools=(self)`;
  `GET /app.js` and `GET /api/docs` do not.
- `app/webmcp.js` source contains no `decrypt`, `reveal`, `passphrase` or
  `identity` identifier and does not import `crypto-worker`; every
  `name: "…"` literal in it matches the name regex and is unique.

Then `bun run gates`, `bun run lint:docs`, and the full `bun test` (the
change touches `app.js`, `tree.js`, `editor.js`, `chat.js`, `terminal.js`).

## Out of Scope

- Declarative (`<form toolname>`) tools — ChatGPT ignores them and the app
  has no forms worth exposing.
- Tools that decrypt, reveal, encrypt a range, or take the vault passphrase;
  `encrypt_selection` stays a human gesture on a Raw selection.
- `exposedTo` / cross-origin iframes / `fromOrigins`; Permissions-Policy
  delegation beyond `self`.
- Dynamic registration/unregistration by page state; `provideContext` /
  `clearContext` (removed from the spec).
- Streaming tool results, progress, output schemas, `title` localisation.
- A server-side MCP endpoint, an OpenAPI document, or any HTTP route change
  beyond the two headers.
- Changing any UI behaviour, dialog, toast or keyboard chord; changing the
  API contract (0002) beyond the headers sentence.
- Rate limiting, auditing or a permission model for agents: the network is
  the perimeter (SPEC §10) and the browser is the gate.
- Chrome's evals CLI, the Tool Inspector extension, or any dev dependency.
- Upgrading the suite's Chromium.

## Further Notes

- `tests/api.test.ts` contains NUL bytes: sweeps use `grep -a`.
- `AGENTS.md` is at 99 lines; add to existing sentences, never new lines.
- `moveEntry`'s return-value change is safe: `applyFileHistory` tests
  `ok !== false`, `commitRename` passes it through, drag/drop ignores it.
- `sendMessage()` must keep its exact UI behaviour (temp bubbles, RAF
  paint, abort semantics); only the text source moves.
- `runTerminal` toasts "A command is already running" when busy; the
  `capture` path throws instead so the tool can answer with a slug.
- The polyfill's `executeTool` takes the tool **by name** so a `RegisteredTool`
  from `getTools()` (a copy) works, as it does natively.
- Descriptions should say what the tool does and what it returns, in the
  positive voice; parameter descriptions say the expected shape
  (`"vault-qualified doc path, e.g. notes/todo.md or @work/inbox.md"`).
- `console.warn` on a registration rejection, never a toast: the human UI
  must not report an agent-facing failure.
