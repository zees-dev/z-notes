/* ============================================================
   api.js — the z-notes v0 client.

   THE ONLY FILE IN THIS APP THAT TOUCHES THE NETWORK.
   Nothing else may call fetch(), EventSource, WebSocket or XHR.
   It implements exactly the app's normative HTTP/SSE contract and knows
   nothing about who serves it — today server/index.ts.

   It also answers from this device's replica when the server is out of
   reach (ADR 0041): reads fall back to the last answer stored, every doc save
   is written to the outbox before it is sent, and the outbox is replayed
   when the network returns.
   ============================================================ */
"use strict";

import * as replica from "./replica.js";
import { relOf, vaultOf, vaultPrefix } from "./ui.js";
import { isAgeOpen, matchDoc, parseSearch, redact } from "../server/search-match.ts";

/* The API root, resolved from the shell's `<base href="/">` rather than
   hard-coded or from import.meta.url (which now names a hashed chunk under
   /assets/), so a nested /d/<path> URL cannot make a relative "api/…" resolve
   against the doc path. */
export const API_ROOT = new URL("./", document.baseURI);

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

/* OFFLINE is what the last request found, never `navigator.onLine`: a
   status-0 failure sets it, any response clears it, and `onChange` hears
   each flip. The message is the one every online-only action shows offline,
   through its own existing error path. */
export const offline = { now: false, onChange: null };
const OFFLINE_MESSAGE = "You're offline — this needs the server.";

function reached(ok) {
  if (offline.now === !ok) return;
  offline.now = !ok;
  if (offline.onChange) offline.onChange(offline.now);
}

/** The status-0 refusal, also for an action whose own path only toasts it. */
export const offlineError = (path) => new ApiError(0, { error: "network", message: OFFLINE_MESSAGE }, path);

function unreachable(err, path) {
  if (err && err.name === "AbortError") return err;
  reached(false);
  return offlineError(path);
}

const isOffline = (err) => !!err && err.status === 0 && err.code === "network";

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
    throw unreachable(err, path);
  }
  reached(true);
  if (res.status === 204) return null;
  /* a connection that drops after the headers is the network gone too: a
     read falls back to the replica, and a PUT whose reply was lost is queued */
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw unreachable(err, path);
  }
  /* one route answers with a body that is not JSON (the age armor), and its
     errors still are — so the text branch reads the body once and only parses
     it when the status says it is an error */
  if (asText) {
    if (res.ok) return text;
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      payload = { error: "http-" + res.status, message: text.slice(0, 200) };
    }
    throw new ApiError(res.status, payload, path);
  }
  let payload = null;
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

/* The replica is a copy: a failure to store into it, or to read it back, never
   fails the request it rides on. */
const remember = (p) => p.catch(() => {});
const recall = (p) => p.catch(() => undefined);

/** A doc body as the replica keeps it. */
const kept = (path, markdown, r) => ({
  path,
  markdown,
  rev: r.rev,
  mtime: r.mtime,
  bytes: r.bytes,
  hasSecrets: String(markdown).split("\n").some(isAgeOpen),
});

/** A read that answers from the replica when the network is gone, and keeps
    every answer it got while it was not. `fallback` resolves `undefined` when
    the replica does not hold the value (`null` is a stored answer). */
async function readThrough(fetch_, store, fallback) {
  try {
    const v = await fetch_();
    remember(store(v));
    return v;
  } catch (err) {
    if (!isOffline(err)) throw err;
    const v = await recall(fallback());
    if (v === undefined) throw err;
    return v;
  }
}

/* GET /api/docs. Offline it is the stored tree, with every doc created on
   this device and not yet acknowledged inserted, so it appears in the tree. */
export const getTree = () =>
  readThrough(
    () => get("api/docs"),
    (r) => replica.setMeta("tree", r),
    async () => {
      const tree = await replica.getMeta("tree");
      return tree ? withCreates(tree, await replica.outboxEntries()) : undefined;
    }
  );

function withCreates(body, entries) {
  for (const e of entries) {
    if (!e.create) continue;
    const id = vaultOf(e.path);
    const v = (body.vaults || []).find((x) => x.id === id);
    if (v) insertFile((v.tree = v.tree || []), e);
    if (id === "vault" && body.tree && body.tree !== (v && v.tree)) insertFile(body.tree, e);
  }
  return body;
}

function insertFile(nodes, e) {
  const prefix = vaultPrefix(vaultOf(e.path));
  const segs = relOf(e.path).split("/");
  let at = prefix;
  for (const seg of segs.slice(0, -1)) {
    at += seg;
    let folder = nodes.find((n) => n.type === "folder" && n.path === at);
    if (!folder) nodes.push((folder = { type: "folder", path: at, name: seg, open: true, children: [] }));
    nodes = folder.children;
    at += "/";
  }
  if (nodes.some((n) => n.path === e.path)) return;
  const name = segs[segs.length - 1];
  nodes.push({ type: "file", path: e.path, name, title: name.replace(/\.md$/i, ""), slug: name.replace(/\.md$/i, ""), bytes: byteLen(e.markdown), mtime: null, empty: !e.markdown.trim(), hasSecrets: false });
}

/**
 * GET /api/docs/{path}, offline from the replica — and, online or not,
 * OVERLAID with the outbox: a doc whose last save the server never
 * acknowledged answers with those bytes, the rev they were based on and
 * `pending: true`, carrying the server's own text as `diskMarkdown`. A doc
 * known only to the outbox (created here, or gone from the server) answers as
 * a synthetic pending doc, so it opens and its save meets the server's answer.
 * `overlay: false` is the server's (or the replica's) doc alone — what a
 * conflict resolution re-reads.
 */
export async function getDoc(path, { overlay = true } = {}) {
  let doc = null;
  let failure = null;
  try {
    doc = await get("api/docs/" + encPath(path));
    remember(replica.putDocs([kept(path, doc.markdown, doc)]));
  } catch (err) {
    if (!isOffline(err) && err.status !== 404) throw err;
    failure = err;
    const local = isOffline(err) ? await recall(replica.getDoc(path)) : null;
    if (local) doc = Object.assign({ type: "file", name: path.split("/").pop(), empty: !local.markdown.trim() }, local);
  }
  const entry = overlay ? await recall(replica.outboxEntry(path)) : null;
  if (entry && doc) return Object.assign({}, doc, { markdown: entry.markdown, rev: entry.baseRev, pending: true, diskMarkdown: doc.markdown });
  if (entry) {
    const name = path.split("/").pop();
    return { type: "file", path, name, markdown: entry.markdown, rev: entry.baseRev, bytes: byteLen(entry.markdown), mtime: null, empty: !entry.markdown.trim(), hasSecrets: false, pending: true, diskMarkdown: "" };
  }
  if (!doc) throw failure;
  return doc;
}

/* The write-ahead: true once the save is durable on this device, false when
   there is no replica to hold it (the save then goes out exactly as before). */
async function writeAhead(entry) {
  try {
    return (await replica.enqueue(entry)) === true;
  } catch (err) {
    if (err && err.code === "quota")
      throw new ApiError(0, { error: "quota", message: "Not saved — this device is out of storage." }, entry.path);
    return false;
  }
}

/** The server took these bytes: drop them from the outbox, keep the doc. */
async function acknowledged(path, markdown, r) {
  await recall(replica.dequeue(path, markdown));
  remember(replica.putDocs([kept(path, markdown, r)]));
}

/**
 * PUT /api/docs/{path}, written to the outbox FIRST. A save the network never
 * carried answers `{ path, rev, queued: true }` — on this device, not on the
 * server; 409 and 404 throw as always and the entry stays.
 *
 * A doc created on this device and never acknowledged (`rev == null` over a
 * `create` entry) has nothing to PUT to, so its save is the create — and the
 * create's `409 exists` is answered as the rev-conflict it is, with the
 * server's text, so the ordinary conflict banner takes it.
 *
 * The unload flush (`keepalive`) cannot wait for the write-ahead: the page may
 * be gone before it commits, so the request leaves at once beside it. That is
 * the same loss window the autosave cadence bounds online.
 */
export async function putDoc(path, markdown, rev, opts) {
  const prev = rev == null ? await recall(replica.outboxEntry(path)) : null;
  const create = !!(prev && prev.create);
  const ahead = writeAhead({ path, markdown, baseRev: rev, create });
  if (opts && opts.keepalive) ahead.catch(() => {});
  else await ahead; // a full device refuses here, before anything is sent
  try {
    const r = create ? await createAsSave(path, markdown, opts) : await put("api/docs/" + encPath(path), { markdown, rev }, opts);
    await acknowledged(path, markdown, r);
    return r;
  } catch (err) {
    if (isOffline(err) && (await ahead.catch(() => false))) return { path, rev, queued: true };
    throw err;
  }
}

async function createAsSave(path, markdown, opts) {
  try {
    return await post("api/docs", { path, type: "doc", markdown }, opts);
  } catch (err) {
    if (!err || err.code !== "exists") throw err;
    const disk = await getDoc(path, { overlay: false });
    if (disk.markdown === markdown) return disk; // the create's reply was lost, not the create
    throw new ApiError(409, { error: "rev-conflict", rev: disk.rev, markdown: disk.markdown, message: err.message }, path);
  }
}

/* POST /api/docs. A doc is written to the outbox first, like a save; offline
   it answers `{ path, type: "doc", rev: null, queued: true }` and appears in
   the tree from there. Any refusal the server DID give puts the outbox back
   as it was: the create did not happen, and replaying it later would only
   raise the same refusal again with nobody watching. Folders are online only.

   A path this device already holds unsent bytes for is taken, as the server
   would say: the create must not overwrite them. `recreate` is the one create
   that may — the orphan dialog writing that very buffer back. */
export async function createEntry({ path, type, markdown }, { recreate = false } = {}) {
  if (type !== "doc") return post("api/docs", { path, type, markdown });
  const prev = await recall(replica.outboxEntry(path));
  if (prev && !recreate) throw new ApiError(409, { error: "exists", message: `${path} already exists.` }, path);
  const durable = await writeAhead({ path, markdown, baseRev: null, create: true });
  try {
    const r = await post("api/docs", { path, type, markdown });
    await acknowledged(path, markdown, r);
    return r;
  } catch (err) {
    if (isOffline(err) && durable) return { path, type: "doc", rev: null, queued: true };
    if (durable) remember(prev ? replica.enqueue(prev) : replica.clearOutboxEntry(path));
    throw err;
  }
}

/* ---------------- the outbox, for the shell ---------------- */

export const blockedEntries = async () => (await recall(replica.outboxEntries()) || []).filter((e) => e.blocked);

/** A conflict resolved by leaving the buffer clean or discarding it. */
export const clearOutboxEntry = (path) => remember(replica.clearOutboxEntry(path));

/**
 * REPLAY: every non-blocked outbox entry, one at a time, as the save or create
 * it was. `owned(path)` names the buffers the editor's own save path writes
 * (the open doc) — those are skipped, so a doc has one writer. A refusal
 * blocks its entry for the user; the first status 0 stops the walk. Each
 * entry is read again just before it is sent: a Discard or a newer save may
 * have changed it since the walk began.
 * → { sent: [{ path, markdown, rev, mtime, bytes }], blocked: [paths] }
 */
export async function replayOutbox(owned = () => false) {
  const sent = [];
  const blocked = [];
  for (const { path } of await recall(replica.outboxEntries()) || []) {
    const e = await recall(replica.outboxEntry(path));
    if (!e) continue;
    if (e.blocked) {
      blocked.push(e.path);
      continue;
    }
    if (owned(e.path)) continue;
    try {
      const r = e.create
        ? await replayCreate(e)
        : await put("api/docs/" + encPath(e.path), { markdown: e.markdown, rev: e.baseRev });
      await acknowledged(e.path, e.markdown, r);
      sent.push({ path: e.path, markdown: e.markdown, rev: r.rev, mtime: r.mtime, bytes: r.bytes });
    } catch (err) {
      if (err && err.status === 0) break;
      const reason = err.code === "rev-conflict" ? "rev-conflict" : err.code === "exists" ? "exists" : err.status === 404 ? "not-found" : null;
      if (!reason) continue;
      await recall(replica.block(e.path, reason));
      blocked.push(e.path);
    }
  }
  return { sent, blocked };
}

/* A create whose reply was lost has already happened: `409 exists` over these
   very bytes is that create, acknowledged rather than blocked. */
async function replayCreate(e) {
  try {
    return await post("api/docs", { path: e.path, type: "doc", markdown: e.markdown });
  } catch (err) {
    if (!err || err.code !== "exists") throw err;
    const disk = await getDoc(e.path, { overlay: false }).catch((g) => (isOffline(g) ? Promise.reject(g) : null));
    if (disk && disk.markdown === e.markdown) return disk;
    throw err;
  }
}

/* The replica refresh never runs on the boot critical path: each step waits
   for the page to be idle. */
const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 50)));
const REPLICA_BATCH = 200;
const REPLICA_BATCH_BYTES = 4 * 1024 * 1024;
let refreshing = null;
let refreshAgain = false;
let persisted = false;

/**
 * Bring the replica's docs level with the tree: re-read every doc whose rev
 * moved or that it lacks (`POST /api/replica`, batched), drop docs no tree
 * holds any more (unless the outbox still does), then mark it complete at the
 * tree's epoch. `epoch` is the server's latest (`hello`); equal to the stored
 * one over a complete replica means nothing moved, and nothing is asked. No
 * `epoch` means the vault moved under this session, and the tree is re-read.
 * A request made while one runs is one more pass after it (a tree re-read),
 * not dropped: what it was asked for may be newer than what is running.
 */
export function refreshReplica(epoch = null) {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = fillReplica(epoch)
    .catch(() => {})
    .finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        refreshReplica();
      }
    });
  return refreshing;
}

async function fillReplica(epoch) {
  await idle();
  let tree = await replica.getMeta("tree");
  if (!tree) return; // inert, or nothing read yet
  if (epoch != null && epoch === (await replica.getMeta("epoch")) && (await replica.getMeta("complete"))) return;
  /* the diff trusts the stored tree, so it must be no older than what moved */
  if (epoch == null || !(tree.epoch >= epoch)) {
    tree = await get("api/docs");
    await replica.setMeta("tree", tree);
  }
  const want = new Map();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === "folder") walk(n.children);
      else want.set(n.path, n);
    }
  };
  if (Array.isArray(tree.vaults) && tree.vaults.length) tree.vaults.forEach((v) => walk(v.tree));
  else walk(tree.tree);
  const have = new Map((await replica.allDocs()).map((d) => [d.path, d.rev]));
  const stale = [...want.values()].filter((n) => have.get(n.path) !== n.rev);
  while (stale.length) {
    const paths = [];
    let bytes = 0;
    while (stale.length && paths.length < REPLICA_BATCH && (!paths.length || bytes + (stale[0].bytes || 0) <= REPLICA_BATCH_BYTES)) {
      const n = stale.shift();
      paths.push(n.path);
      bytes += n.bytes || 0;
    }
    await idle();
    const r = await post("api/replica", { paths });
    await replica.putDocs(r.docs.map((d) => kept(d.path, d.markdown, d)));
  }
  const queued = new Set((await replica.outboxEntries()).map((e) => e.path));
  const gone = [...have.keys()].filter((p) => !want.has(p) && !queued.has(p));
  if (gone.length) await replica.deleteDocs(gone);
  await replica.setMeta("epoch", tree.epoch);
  await replica.setMeta("complete", true);
  if (!persisted) {
    persisted = true;
    replica.persist();
  }
}

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

/* Both are kept on the device under the primary vault's keyring key, so
   secrets reveal offline. The identity is the passphrase-WRAPPED keyring —
   the same bytes the vault's git repository holds. The two fields arrive
   from parallel reads, so their read-modify-writes are chained. */
const KEYRING = "keyring:vault";
let keyringWrite = Promise.resolve();
const keepKeyring = (field) => (value) =>
  (keyringWrite = keyringWrite.catch(() => {}).then(async () => {
    await replica.setMeta(KEYRING, Object.assign((await replica.getMeta(KEYRING)) || {}, { [field]: value }));
  }));
const keyringField = (field) => async () => ((await replica.getMeta(KEYRING)) || {})[field];
const noneOn404 = (p) =>
  p.catch((err) => {
    if (err && err.status === 404) return null;
    throw err;
  });

export const getVaultIdentity = () =>
  readThrough(() => noneOn404(get("api/vault/identity", { asText: true })), keepKeyring("identity"), keyringField("identity"));

export const getVaultRecipient = () =>
  readThrough(() => noneOn404(get("api/vault/recipient")), keepKeyring("recipient"), keyringField("recipient"));

/* …and what it wrote is what a GET would now answer, so a first setup or a
   passphrase change is the keyring offline reveals with. */
export async function putVaultIdentity(identity, recipient, replace) {
  const r = await put("api/vault/identity", { identity, recipient, replace: replace === true });
  remember(keepKeyring("identity")(String(identity).trim() + "\n"));
  remember(keepKeyring("recipient")({ recipient: r.recipient }));
  return r;
}

/* ---------------- search ---------------- */

/** `mode: "regex"` reads a BARE pattern as a regex; a `/pattern/flags` query
    says so itself and needs no parameter (ADR 0028). */
export async function search(q, { limit = 24, mode = null, signal } = {}) {
  try {
    return await get("api/search", { params: { q, limit, mode }, signal });
  } catch (err) {
    if (!isOffline(err)) throw err;
    const docs = await recall(replica.allDocs());
    if (!docs || !docs.length) throw err;
    return Object.assign(localSearch(docs, await recall(replica.outboxEntries()), q, limit, mode), { offline: true });
  }
}

/**
 * GET /api/search's answer, computed over the replica (and the outbox's unsent
 * bytes) with the server's own matcher. Lines are REDACTED before they are
 * looked at — never armor — then trimmed; each vault's docs match on their
 * vault-relative path and are qualified after, as the server merges them.
 */
function localSearch(docs, entries, q, limit, mode) {
  const query = String(q || "").trim();
  const asked = parseInt(limit, 10);
  const cap = Number.isFinite(asked) && asked > 0 ? Math.min(100, asked) : 24;
  const sq = parseSearch(query, mode);
  const answer = (results) => Object.assign({ query, mode: sq.mode, results }, sq.invalid ? { invalid: sq.invalid } : null);
  if (sq.mode === "regex" && sq.term && !sq.probe) return answer([]);
  const bodies = new Map(docs.map((d) => [d.path, d.markdown]));
  for (const e of entries || []) bodies.set(e.path, e.markdown);
  const out = [];
  for (const [path, markdown] of bodies) {
    const lines = sq.term ? redact(markdown).split("\n").map((l) => l.trim()) : [];
    for (const hit of matchDoc(relOf(path), lines, lines.map((l) => l.toLowerCase()), sq)) out.push(Object.assign(hit, { path }));
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? -1) - (b.line ?? -1));
  return answer(out.slice(0, cap));
}

/* ---------------- settings ---------------- */

export const getSettings = () =>
  readThrough(
    () => get("api/settings"),
    (r) => replica.setMeta("settings", r),
    async () => (await replica.getMeta("settings")) ?? undefined
  );

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
    throw unreachable(err, path);
  }
  reached(true);
  /* an error before the stream opens is ordinary JSON (400 empty-message, a
     refusal, a server fault); only a 2xx carries events */
  if (!res.ok || !res.body) {
    let raw;
    try {
      raw = await res.text();
    } catch (err) {
      throw unreachable(err, path); // the connection dropped after the headers
    }
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
  await readSse(res, path, (event, data) => {
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

   `dispatch(event, data)` is called once per complete frame, in order. A
   stream that breaks mid-read is the network gone, like any request's. */
async function readSse(res, path, dispatch) {
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
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw unreachable(err, path);
    }
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
