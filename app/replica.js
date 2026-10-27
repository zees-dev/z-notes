/* ============================================================
   replica.js — this device's copy of the vaults, and its outbox.

   A leaf: imports nothing, touches no network. api.js is its only caller.
   IndexedDB database `znotes`, version 1 (ADR 0041):

     docs    qualified path → { path, markdown, rev, mtime, bytes, hasSecrets }
     outbox  qualified path → { path, markdown, baseRev, create, blocked, at }
     meta    `tree`, `settings`, `keyring:<vault id>`, `epoch`, `complete`

   Everything here is armor-only by construction: docs are server bodies and
   the outbox holds `doc.markdown` after the save path's leak gate. No
   plaintext and no passphrase is representable.

   INERT off the canonical origin (`meta[name=znotes-origin]`; unset means any
   origin is canonical) and where IndexedDB cannot be opened: every function
   resolves empty or null and never creates the database, so the app behaves
   exactly as it did before there was a replica.
   ============================================================ */
"use strict";

function canonical() {
  const want = (document.querySelector('meta[name="znotes-origin"]')?.getAttribute("content") || "").trim();
  if (!want) return true;
  try {
    return new URL(want).origin === location.origin;
  } catch (e) {
    return false;
  }
}

let opening = null;
function open() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (!canonical() || typeof indexedDB === "undefined") return resolve(null);
    let req;
    try {
      req = indexedDB.open("znotes", 1);
    } catch (e) {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("docs", { keyPath: "path" });
      db.createObjectStore("outbox", { keyPath: "path" });
      db.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const db = req.result;
      /* another tab deleting or upgrading the database must not wait on us */
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
  });
  return opening;
}

/** Error out of a transaction, with `code: "quota"` when the device is full. */
function failure(e) {
  const err = new Error((e && e.message) || "IndexedDB failed");
  err.name = (e && e.name) || "Error";
  err.code = err.name === "QuotaExceededError" ? "quota" : "idb";
  return err;
}

/**
 * One transaction over one store. `fn` queues its requests and returns the
 * one whose result is the answer; the promise settles on `complete`, so a
 * resolved write is a committed write. `strict` is for the outbox: a save
 * the user was told is on this device must survive the OS dying next.
 * Resolves `undefined` when the replica is inert.
 */
async function tx(store, mode, fn, strict) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(store, mode, strict ? { durability: "strict" } : undefined);
    } catch (e) {
      return reject(failure(e));
    }
    let answer;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => (answer = req.result);
    t.oncomplete = () => resolve(answer);
    t.onabort = () => reject(failure(t.error));
  });
}

const STRICT = true;

export const getDoc = async (path) => (await tx("docs", "readonly", (s) => s.get(path))) || null;

export const putDocs = (docs) =>
  tx("docs", "readwrite", (s) => {
    for (const d of docs) s.put({ path: d.path, markdown: d.markdown, rev: d.rev, mtime: d.mtime, bytes: d.bytes, hasSecrets: !!d.hasSecrets });
  });

export const deleteDocs = (paths) =>
  tx("docs", "readwrite", (s) => {
    for (const p of paths) s.delete(p);
  });

export const allDocs = async () => (await tx("docs", "readonly", (s) => s.getAll())) || [];

export const getMeta = async (k) => {
  const v = await tx("meta", "readonly", (s) => s.get(k));
  return v === undefined ? null : v;
};

export const setMeta = (k, v) => tx("meta", "readwrite", (s) => void s.put(v, k));

/** Write-ahead for a save. Resolves true once durable, null when inert. */
export async function enqueue(e) {
  if (!(await open())) return null;
  const entry = { path: e.path, markdown: e.markdown, baseRev: e.baseRev ?? null, create: !!e.create, blocked: null, at: Date.now() };
  await tx("outbox", "readwrite", (s) => void s.put(entry), STRICT);
  return true;
}

export const outboxEntries = async () => (await tx("outbox", "readonly", (s) => s.getAll())) || [];

export const outboxEntry = async (path) => (await tx("outbox", "readonly", (s) => s.get(path))) || null;

/** The entry is acknowledged — unless a newer save replaced its bytes since. */
export const dequeue = (path, markdown) =>
  tx(
    "outbox",
    "readwrite",
    (s) => {
      const req = s.get(path);
      req.onsuccess = () => {
        if (req.result && req.result.markdown === markdown) s.delete(path);
      };
    },
    STRICT
  );

/** Replay met someone else's change; the entry waits for the user. */
export const block = (path, reason) =>
  tx(
    "outbox",
    "readwrite",
    (s) => {
      const req = s.get(path);
      req.onsuccess = () => {
        if (req.result) s.put(Object.assign(req.result, { blocked: reason }));
      };
    },
    STRICT
  );

export const clearOutboxEntry = (path) => tx("outbox", "readwrite", (s) => void s.delete(path), STRICT);

/** Ask once to be exempt from eviction; the answer is the browser's. */
export async function persist() {
  if (!(await open())) return null;
  try {
    return await navigator.storage.persist();
  } catch (e) {
    return null;
  }
}
