/* ============================================================
   api.js — the z-notes v0 client.

   THE ONLY FILE IN THIS APP THAT TOUCHES THE NETWORK.
   Nothing else may call fetch(), EventSource, WebSocket or XHR.
   It implements exactly the app's normative HTTP/SSE contract and knows
   nothing about who serves it — today server/index.ts.
   ============================================================ */
"use strict";

/* The API root, resolved from import.meta.url rather than hard-coded, so the
   app survives being served from anywhere — including a nested /d/<path> URL,
   where a relative "api/…" would otherwise resolve against the doc path. */
export const API_ROOT = new URL("./", import.meta.url);

const url = (p, params) => {
  const u = new URL(p, API_ROOT);
  if (params) {
    Object.keys(params).forEach((k) => {
      if (params[k] != null) u.searchParams.set(k, params[k]);
    });
  }
  return u;
};

/* vault-relative POSIX path → percent-encoded URL path (slashes survive).
   Exported because the doc URL (`/d/<path>`) has to encode a path exactly the
   way `/api/docs/{path}` does — one rule, one implementation. */
export const encPath = (path) =>
  String(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/");

export class ApiError extends Error {
  constructor(status, body, path) {
    super((body && body.message) || (body && body.error) || "HTTP " + status);
    this.name = "ApiError";
    this.status = status;
    this.code = (body && body.error) || "http-" + status;
    this.body = body || {};
    this.path = path;
  }
}

/**
 * The `keepalive` body budget, in bytes.
 *
 * The Fetch standard gives a page ONE 64KiB allowance shared by every inflight
 * keepalive request, and a body over it makes `fetch` reject immediately with a
 * TypeError — not a slow save, a save that never leaves. The lifecycle flush
 * runs with `quiet: true` (an unloading page has nowhere to show an error), so
 * that rejection would be perfectly silent data loss: exactly the failure the
 * flush exists to prevent, with the loss now proportional to how much the user
 * had written.
 *
 * So a body that does not fit is sent WITHOUT keepalive instead. That is a
 * weaker promise — the request dies if the page is really discarded — but it is
 * an honest one, and on every platform that merely backgrounds the tab it
 * completes normally. The headroom below 65536 covers the headers and the
 * request line, which count against the same allowance.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

const byteLen = (s) => new TextEncoder().encode(s).length;

async function request(method, path, { body, params, signal, keepalive, asText, auth } = {}) {
  let res;
  try {
    const headers = body === undefined
      ? { accept: asText ? "text/plain" : "application/json" }
      : { accept: "application/json", "content-type": "application/json" };
    /* The terminal bearer, attached only where it is asked for. It lives in
       this module and nowhere else — see the note above `termToken`. */
    if (auth && termToken) headers.authorization = "Bearer " + termToken;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    /* measured here, where the bytes actually exist — a caller counting
       characters of markdown would miss both the JSON escaping and the UTF-8 */
    const fits = payload === undefined || byteLen(payload) <= KEEPALIVE_MAX_BYTES;
    res = await fetch(url(path, params), {
      method,
      signal,
      /* keepalive lets a write survive the page unloading — the flush on
         pagehide would otherwise be aborted mid-flight */
      keepalive: !!keepalive && fits,
      headers,
      body: payload,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, { error: "network", message: "Cannot reach the z-notes backend." }, path);
  }
  if (res.status === 204) return null;
  /* one route answers with a body that is not JSON (the age armor), and its
     errors still are — so the text branch reads the body once and only parses
     it when the status says it is an error */
  if (asText) {
    const raw = await res.text();
    if (res.ok) return raw;
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      payload = { error: "http-" + res.status, message: raw.slice(0, 200) };
    }
    throw new ApiError(res.status, payload, path);
  }
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (e) {
      payload = { error: "bad-json", message: text.slice(0, 200) };
    }
  }
  if (!res.ok) throw new ApiError(res.status, payload, path);
  return payload;
}

const get = (p, o) => request("GET", p, o);
const put = (p, body, o) => request("PUT", p, Object.assign({ body }, o));
const post = (p, body, o) => request("POST", p, Object.assign({ body: body || {} }, o));
const patch = (p, body, o) => request("PATCH", p, Object.assign({ body }, o));
const del = (p, o) => request("DELETE", p, o);

/* ---------------- docs ---------------- */

export const getTree = () => get("api/docs");

export const getDoc = (path) => get("api/docs/" + encPath(path));

export const putDoc = (path, markdown, rev, opts) => put("api/docs/" + encPath(path), { markdown, rev }, opts);

export const createEntry = ({ path, type, markdown }) => post("api/docs", { path, type, markdown });

/* Rename OR move — they are the same operation, and the server tells them
   apart from the path alone. `path` may be a doc or a folder; a folder takes
   its whole subtree with it. Every `[[link]]` that resolved to a moved doc is
   rewritten vault-wide in the SAME git commit; the reply says how many, and in
   which docs, so the UI can say so out loud.

   → { path, from, rev, bytes, mtime, backlinksUpdated, updated: [paths] }
   409 `exists` when the target is taken. */
export const moveDoc = (path, to) => patch("api/docs/" + encPath(path), { to });

/* Human-only, by construction: the assistant has no delete and no rename,
   so nothing in the AI vocabulary can reach this route. A folder
   takes its subtree with it; backlinks to a deleted doc are left BROKEN rather
   than rewritten — that is the record that something used to be there.

   A delete is not a destruction: what leaves the vault tree lands in the TRASH
   below, and stays there until it is restored or its retention runs out.

   → 204 (this returns null). */
export const deleteDoc = (path) => del("api/docs/" + encPath(path));

/* ---------------- trash ----------------

   Where a deleted doc waits. The store lives under `.znotes/`, which the vault
   scan excludes, so nothing in here is reachable by the tree, search or the
   link resolver — a trashed doc is out of the world, not merely hidden.

   The entries are passed through as the server spells them (trash.ts
   TrashEntry) — there is exactly one server, its shape is typed, and a second
   client-side vocabulary of aliases it never emits was pure dead weight that
   also DROPPED the fields it does send (`restorable`, `blockedBy`, `bytes`).
   `retentionDays` is what the delete confirmation quotes back to the user, so
   an absent one is null and NOT a guessed 30 — the dialog says less rather
   than promising a number this client made up. */

const trashView = (r) => ({
  entries: (r && r.entries) || [],
  retentionDays: r && typeof r.retentionDays === "number" ? r.retentionDays : null,
});

export const getTrash = () => get("api/trash").then(trashView);

/* Put it back where it came from, in one commit. → { path }
   409 `exists` when something now occupies the original path — the one error
   the trash panel has to render in place rather than as a toast. */
export const restoreTrash = (id) => post("api/trash/" + encodeURIComponent(id) + "/restore", {});

/* Irreversible, and the only route in this file that is. → 204 (null). */
export const purgeTrashEntry = (id) => del("api/trash/" + encodeURIComponent(id));

/* Retention sweep. Bare, it drops what is already past its purge time — the
   same thing the server does on its own schedule. `{ all: true }` is the
   user-pressed "Empty trash": everything, expired or not. → { purged: n } */
export const purgeTrash = ({ all = false } = {}) => post("api/trash/purge", { all: all === true });

/* ---------------- vault keyring ----------------

   There is no unlock endpoint and there never will be: decryption happens in
   the browser's crypto worker, and no passphrase or plaintext is representable
   in this file's vocabulary. These three calls move CIPHERTEXT and a PUBLIC
   key, nothing else.

   `getVaultIdentity` returns the age armor as text (the server serves the file
   body verbatim) or null when the vault has no identity yet. */

export const getVaultIdentity = () =>
  get("api/vault/identity", { asText: true }).catch((err) => {
    if (err && err.status === 404) return null;
    throw err;
  });

export const getVaultRecipient = () =>
  get("api/vault/recipient").catch((err) => {
    if (err && err.status === 404) return null;
    throw err;
  });

export const putVaultIdentity = (identity, recipient, replace) =>
  put("api/vault/identity", { identity, recipient, replace: replace === true });

/* ---------------- search ---------------- */

export const search = (q, { limit = 24, signal } = {}) => get("api/search", { params: { q, limit }, signal });

/* ---------------- settings ---------------- */

export const getSettings = () => get("api/settings");

export const patchSettings = (patch) => put("api/settings", patch);

/* ---------------- sync ---------------- */

export const getSyncStatus = () => get("api/sync/status");

export const syncNow = () => post("api/sync/now", {});

/* ATTACH — connect the vault directory to a remote repository (ADR 0017): the
   one user-initiated operation that may create a repo in the vault. Answers
   with the same sync-status object `syncNow` does; refuses with `bad-url`
   (400), `vault-busy` or `checkout-conflict` (409 — the latter carrying the
   conflicting `paths`) or `attach-failed` (502), having left the vault exactly
   as it was. The credential is never in this call: the server reads the stored
   token itself, and a URL carrying userinfo is refused.

   `remote`, not `url`, because `url` is this module's request-URL builder. */
export const attachRemote = (remote) => post("api/sync/remote", { url: remote });

/* ---------------- vaults ----------------

   Several vaults, one address grammar: a secondary vault's docs are `@<id>/…`
   through every route above, and these five are the only ones that address a
   vault as a THING. The primary (`vault`) is listed like any other and can be
   settings-changed like any other, but it can never be removed.

   Adding a vault IS the attach operation (ADR 0017) run against a directory
   this call creates, so every refusal `attachRemote` can answer is relayed
   verbatim — plus `bad-name` and `exists`. A failed add leaves nothing behind.

   `remote`, not `url`, for the same reason as `attachRemote`: `url` is this
   module's request-URL builder. */

export const getVaults = () => get("api/vaults");

/* `token` omitted COPIES the primary's stored token — one account, N repos, is
   the common case. Pass `""` to attach anonymously; the empty string is a real
   choice here and is sent, where an absent one is not. */
export const addVault = ({ url: remote, name, token }) =>
  post(
    "api/vaults",
    Object.assign({ url: remote }, name ? { name } : null, token != null ? { token } : null)
  );

/* Disconnect. The directory and its repo STAY ON DISK — this drops the vault
   from the registry and nothing else. → 204 (null). */
export const removeVault = (id) => del("api/vaults/" + encodeURIComponent(id));

/* The git slice of that vault's own settings.toml — branch, autoSync,
   autoSyncSeconds, and the write-only credential. → { vault: <descriptor> } */
export const putVaultSettings = (id, git) => put("api/vaults/" + encodeURIComponent(id) + "/settings", { git });

/* That vault's pipeline, now. → its sync-status object, `vault` field included. */
export const syncVault = (id) => post("api/vaults/" + encodeURIComponent(id) + "/sync", {});

/* Point a vault at a (new) remote — the same attach `attachRemote` runs for
   the primary, against this vault's stack. → its sync-status object, `vault`
   field included; refuses with the attach family plus 409 `exists` when
   another vault already holds the remote. */
export const setVaultRemote = (id, remote) => post("api/vaults/" + encodeURIComponent(id) + "/remote", { url: remote });

/* Disconnect a vault from its remote — the repository and every commit stay on
   disk, only `origin` goes. → that vault's sync-status object, now local-only.
   This is what disconnecting the PRIMARY vault means; a secondary is
   unregistered with `removeVault` instead. */
export const clearVaultRemote = (id) => del("api/vaults/" + encodeURIComponent(id) + "/remote");

/* ---------------- ai ---------------- */

export const getSession = () => get("api/ai/sessions/current");

/* Endpoint reachability for the statusbar. GET is free (the server's already
   recorded signals); POST re-runs the capability probe against the configured
   endpoint and answers with the fresh verdict — that is the on-demand check the
   statusbar item performs when clicked. */
export const getAiStatus = () => get("api/ai/status");

export const checkAiStatus = () => post("api/ai/status", {});

export const newSession = () => post("api/ai/sessions", {});

/* `POST /api/ai/messages` STREAMS. `EventSource` cannot be
   used for it — it is GET-only and cannot carry a body — so this is the
   standard POST + fetch + ReadableStream manual SSE parse.

   Handlers receive the NORMALIZED app events the relay emits; the promise
   resolves with the `done` payload, which is byte-for-byte the JSON shape the
   non-streaming reply used, so callers keep one completion path.

   Pass `handlers.signal` (an AbortController signal) to cancel: aborting the
   fetch closes the response body, which makes the server cancel its stream,
   which aborts the upstream request. Nothing keeps generating for a chat
   nobody is reading. */
export function sendMessageStream(content, docPath, handlers = {}) {
  return streamPost(
    "api/ai/messages",
    { content, docPath },
    handlers,
    { text: "onText", reasoning: "onReasoning", tool_args: "onToolArgs", command: "onCommand", error: "onError" },
    "done",
    { auth: false }
  );
}

/* ---------------- the POST-SSE envelope, shared ----------------

   The fetch, the pre-stream JSON-error path and the handler dispatch are one
   implementation for the same reason `readSse` below is: the AI turn and the
   two terminal streams are the same wire shape, and a second copy of the
   error-body parsing was a second place for it to be subtly wrong.

   `events` maps SSE event name → handler name; `finalEvent` is the frame whose
   payload the promise resolves with (null if the stream ends without one). */
async function streamPost(path, body, handlers, events, finalEvent, { auth } = {}) {
  let res;
  const headers = { accept: "text/event-stream", "content-type": "application/json" };
  if (auth && termToken) headers.authorization = "Bearer " + termToken;
  try {
    res = await fetch(url(path), { method: "POST", signal: handlers.signal, headers, body: JSON.stringify(body) });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, { error: "network", message: "Cannot reach the z-notes backend." }, path);
  }
  /* an error before the stream opens is ordinary JSON (400 empty-message, a
     refusal, a server fault); only a 2xx carries events */
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (e) {
      payload = { error: "bad-json", message: raw.slice(0, 200) };
    }
    /* A rejected token is a locked terminal — drop it here so every caller
       sees a consistent state instead of retrying with something dead. */
    if (auth && res.status === 401) termToken = null;
    throw new ApiError(res.status, payload, path);
  }
  const call = (name, data) => {
    const fn = handlers[name];
    if (fn) fn(data);
  };
  let final = null;
  await readSse(res, (event, data) => {
    if (event === finalEvent) final = data;
    else if (events[event]) call(events[event], data);
  });
  return final;
}

/* ---------------- the SSE reader, shared ----------------

   `EventSource` cannot be used for any of the POST streams — it is GET-only
   and cannot carry a body — so this is the standard fetch + ReadableStream
   manual parse, factored out because there are now three callers (the AI turn,
   a terminal command, an approved AI command) and a second copy of a frame
   parser is a second place for the chunk-boundary handling to be subtly wrong.

   `dispatch(event, data)` is called once per complete frame, in order. */
async function readSse(res, dispatch) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  const frame = (raw) => {
    let event = "message";
    const lines = [];
    raw.split(/\r?\n/).forEach((line) => {
      if (!line || line.charAt(0) === ":") return;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") lines.push(value);
    });
    if (!lines.length) return;
    let data = null;
    try {
      data = JSON.parse(lines.join("\n"));
    } catch (e) {
      return;
    }
    dispatch(event, data);
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    for (;;) {
      const sep = /\r?\n\r?\n/.exec(buf);
      if (!sep) break;
      const raw = buf.slice(0, sep.index);
      buf = buf.slice(sep.index + sep[0].length);
      frame(raw);
    }
  }
  buf += dec.decode();
  if (buf.trim()) frame(buf);
}

export const listProposals = () => get("api/ai/proposals");

export const acceptProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/accept", {});

export const revertProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/revert", {});

export const rejectProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/reject", {});

/* ---------------- terminal ----------------

   THE TOKEN LIVES HERE AND NOWHERE ELSE.

   `terminalUnlock` puts the server's bearer token in this module-scoped
   variable and every terminal call attaches it; app.js never receives it,
   never stores it, and could not put it in a URL, a note or a log line if it
   tried. It is deliberately NOT in localStorage or sessionStorage: a reload
   re-locks the terminal, which is the right default for something that runs
   shell commands, and a token that was never persisted cannot be recovered
   from a disk image.

   It is also deliberately not an httpOnly cookie, which the browser would
   attach to every same-origin request automatically — see the note in
   terminal.ts for why ambient authority is the wrong shape here. */

let termToken = null;

/** Does this tab hold an unlock token? (Not proof the server still honours it.) */
export const terminalHasToken = () => !!termToken;

export const getTerminalStatus = () => get("api/terminal/status", { auth: true });

export async function terminalUnlock(password) {
  const r = await post("api/terminal/unlock", { password });
  termToken = r && r.token ? r.token : null;
  /* the token is stripped from what the caller sees: app.js has no use for it
     and every use it could invent would be a way for it to escape this file */
  return r ? r.status : null;
}

export async function terminalLock() {
  if (!termToken) return null;
  /* the token is dropped AFTER the request goes out, not before: `request`
     reads `termToken` at send time, so nulling it first sent a bearer-less
     POST the server answered 401 — the local lock worked and the server-side
     session lived on until the idle timer got it */
  try {
    return await post("api/terminal/lock", {}, { auth: true });
  } catch (err) {
    return null; // the token is gone locally either way; that is what locking means
  } finally {
    termToken = null;
  }
}

/** `next` empty clears the password (and disables the terminal). */
export const terminalSetPassword = (next, current) =>
  post("api/terminal/password", { password: next, current: current || "" }, { auth: true });

export const terminalCommands = (limit) => get("api/terminal/commands", { params: { limit }, auth: true });

/* `id` names the command this input is FOR. The server refuses a mismatch
   (409 `wrong-command`) rather than redirecting the keystrokes: what the user
   is answering is the prompt in front of them, and a tab whose idea of "the
   running command" is stale must not be able to type into a different one. */
export const terminalStdin = (data, eof, id) =>
  post("api/terminal/stdin", { data, eof: !!eof, id: id || null }, { auth: true });

export const terminalCancel = (id) => post("api/terminal/cancel", { id: id || null }, { auth: true });

export const terminalRejectCommand = (id) =>
  post("api/terminal/commands/" + encodeURIComponent(id) + "/reject", {}, { auth: true });

/* Run a command and stream its output. Handlers: onStart, onStdout, onStderr,
   onNotice, onExit, onError. Resolves with the `exit` payload (null if the
   stream ended without one — a cancel mid-flight, say). */
export const terminalExec = (command, handlers) => termStream("api/terminal/exec", { command }, handlers);

/* The same, for a command the assistant asked for and the user approved. */
export const terminalRunCommand = (id, handlers) =>
  termStream("api/terminal/commands/" + encodeURIComponent(id) + "/run", {}, handlers);

async function termStream(path, body, handlers = {}) {
  const exit = await streamPost(
    path,
    body,
    handlers,
    { start: "onStart", stdout: "onStdout", stderr: "onStderr", notice: "onNotice", error: "onError" },
    "exit",
    { auth: true }
  );
  if (exit && handlers.onExit) handlers.onExit(exit);
  return exit;
}

/* ---------------- events (SSE) ----------------
   Returns a handle whose `state` is one of connecting | open | closed, and
   whose `lastFrame` is when this stream last carried a byte we could see.

   `state` ALONE IS NOT LIVENESS, and this is not theoretical. MEASURED against
   a TCP proxy that stops forwarding without closing — a Wi-Fi→cellular NAT
   rebind, the commonest way a mobile connection dies — `readyState` stayed 1
   for 75 seconds, `onerror` never fired, and the statusbar went on saying
   "connected" over a document that had been superseded 75 seconds earlier. The
   socket is open; nothing is coming down it, and TCP will not say so until a
   retransmit budget the browser never surfaces runs out.

   So the handle also reports WHEN, and the caller decides what silence means.
   The server's 20s heartbeat is what makes that answerable at all: on a healthy
   stream `lastFrame` can never be older than one heartbeat interval. */
export function connectEvents(handlers = {}) {
  const es = new EventSource(url("events"));
  const handle = {
    state: "connecting",
    source: es,
    /* Seeded at construction, not at the first frame: an EventSource that is
       still opening has not gone quiet, and a watchdog that could not tell
       those apart would pre-empt the caller's own reconnect backoff. */
    lastFrame: Date.now(),
    close() {
      if (handle.state === "closed") return; // idempotent: closing twice must not re-notify
      handle.state = "closed";
      es.close();
      if (handlers.onState) handlers.onState("closed");
    },
  };
  const setState = (s) => {
    if (handle.state === s) return;
    handle.state = s;
    if (handlers.onState) handlers.onState(s);
  };
  /* Registered for EVERY event this stream carries, whether or not the caller
     asked for it: the stamp is about the BYTES arriving, not about anyone
     caring what they said. `hello` in particular — the server's first frames
     are `retry:` then `hello`, so stamping there is what makes the chip go
     green on the same tick the stream opens instead of waiting up to 20s for
     the first heartbeat. */
  const on = (name, fn) => {
    es.addEventListener(name, (ev) => {
      handle.lastFrame = Date.now();
      if (!fn) return;
      let data = null;
      try {
        data = ev.data ? JSON.parse(ev.data) : null;
      } catch (e) {
        data = null;
      }
      fn(data, ev);
    });
  };
  es.onopen = () => {
    handle.lastFrame = Date.now();
    setState("open");
  };
  es.onerror = () => setState(es.readyState === 2 ? "closed" : "connecting");
  on("hello", handlers.onHello);
  on("doc-changed", handlers.onDocChanged);
  /* carries `vault` — which vault's pipeline moved. The statusbar chip is the
     primary's; every vault row reads its own frames off the same stream. */
  on("sync-status", handlers.onSyncStatus);
  /* The whole vault list — byte for byte `GET /api/vaults` — on add, remove and
     any per-vault settings change. A list, not a hint: what changed is rarely
     one field and the body is small. */
  on("vaults-changed", handlers.onVaultsChanged);
  on("ai-status", handlers.onAiStatus);
  /* `{settings, meta}` — byte for byte what `GET /api/settings` serves, so the
     credentials are already masked. Nothing secret is representable here. */
  on("settings-changed", handlers.onSettingsChanged);
  /* Same body as GET /api/trash, normalised through the same one reader. */
  on("trash-changed", handlers.onTrashChanged ? (data, ev) => handlers.onTrashChanged(trashView(data), ev) : null);
  /* A NOTIFICATION, never content: `{id, state, source, at}`. The command
     string and its output come back over the bearer-gated
     `GET /api/terminal/commands`, because this stream is not behind the
     terminal password. */
  on("terminal-command", handlers.onTerminalCommand);
  on("heartbeat", handlers.onHeartbeat);
  return handle;
}
