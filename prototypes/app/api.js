/* ============================================================
   api.js — the z-notes v0 client.

   THE ONLY FILE IN THIS APP THAT TOUCHES THE NETWORK.
   Nothing else may call fetch(), EventSource, WebSocket or XHR.
   It implements exactly the contract in ./API.md and knows nothing
   about who serves it — today a mock service worker, later bun.
   ============================================================ */
"use strict";

/* The API root. In production this is the site root; here it is the app's own
   directory, because a service worker can only intercept inside its scope.
   Resolved from import.meta.url so it survives being served from anywhere. */
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

/* vault-relative POSIX path → percent-encoded URL path (slashes survive) */
const encPath = (path) =>
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

async function request(method, path, { body, params, signal, keepalive } = {}) {
  let res;
  try {
    res = await fetch(url(path, params), {
      method,
      signal,
      /* keepalive lets a write survive the page unloading — the flush on
         pagehide would otherwise be aborted mid-flight */
      keepalive: !!keepalive,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, { error: "network", message: "Cannot reach the z-notes backend." }, path);
  }
  if (res.status === 204) return null;
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

/* ---------------- docs ---------------- */

export const getTree = () => get("api/docs");

export const getDoc = (path) => get("api/docs/" + encPath(path));

export const putDoc = (path, markdown, rev, opts) => put("api/docs/" + encPath(path), { markdown, rev }, opts);

export const createEntry = ({ path, type, markdown }) => post("api/docs", { path, type, markdown });

/* ---------------- secrets ---------------- */

export const unlockSecret = (path, passphrase) => post("api/secrets/unlock", { path, passphrase });

/* ---------------- search ---------------- */

export const search = (q, { limit = 24, signal } = {}) => get("api/search", { params: { q, limit }, signal });

/* ---------------- settings ---------------- */

export const getSettings = () => get("api/settings");

export const patchSettings = (patch) => put("api/settings", patch);

/* ---------------- sync ---------------- */

export const getSyncStatus = () => get("api/sync/status");

/* ---------------- ai ---------------- */

export const getSession = () => get("api/ai/sessions/current");

export const newSession = () => post("api/ai/sessions", {});

export const sendMessage = (content, docPath) => post("api/ai/messages", { content, docPath });

export const listProposals = () => get("api/ai/proposals");

export const acceptProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/accept", {});

export const revertProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/revert", {});

export const rejectProposal = (id) => post("api/ai/proposals/" + encodeURIComponent(id) + "/reject", {});

/* ---------------- events (SSE) ----------------
   Returns a handle whose `state` is one of connecting | open | closed.
   EventSource already reconnects with backoff; we only surface the state so
   the statusbar dot can tell the truth. */
export function connectEvents(handlers = {}) {
  const es = new EventSource(url("events"));
  const handle = {
    state: "connecting",
    source: es,
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
  const on = (name, fn) => {
    if (!fn) return;
    es.addEventListener(name, (ev) => {
      let data = null;
      try {
        data = ev.data ? JSON.parse(ev.data) : null;
      } catch (e) {
        data = null;
      }
      fn(data, ev);
    });
  };
  es.onopen = () => setState("open");
  es.onerror = () => setState(es.readyState === 2 ? "closed" : "connecting");
  on("hello", handlers.onHello);
  on("doc-changed", handlers.onDocChanged);
  on("sync-status", handlers.onSyncStatus);
  on("heartbeat", handlers.onHeartbeat);
  return handle;
}
