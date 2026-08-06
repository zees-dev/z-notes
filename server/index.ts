/* ============================================================
   server.ts — z-notes backend, phase 1 (SPEC §12.1).

   One bun process: Bun.serve hosts the v0 API (docs/API.md), the
   SSE event stream, and the static frontend in ./app. Zero runtime deps.

     ZNOTES_VAULT   vault directory      (default ./vault)
     ZNOTES_PORT    listen port          (default 4700)

   sqlite always lives at <vault>/.znotes/index.db.
   ============================================================ */

import { resolve } from "node:path";
import { AI } from "./ai.ts";
import { Index } from "./db.ts";
import { GitSync } from "./git.ts";
import { META, Settings, SettingsError } from "./settings.ts";
import { Terminal, TerminalError, bearerOf } from "./terminal.ts";
import { Trash, TrashError, isTrashId } from "./trash.ts";
import { Reconciler, type ChangeHint, type ChangeHints, type ChangeReason, type DocChange } from "./watch.ts";
import {
  absOf,
  affectedTargets,
  blockedByFile as vaultBlockedByFile,
  buildTree,
  dbPath,
  exists,
  hasSecrets,
  isArmor,
  isRecipient,
  linkSafeTarget,
  makeFolder,
  missingFolders,
  moveNode,
  pruneEmptyFolders,
  planLinkRewrites,
  readDoc,
  readVaultKeys,
  revOf,
  safePath,
  sameNode,
  scanDocs,
  scanFolders,
  scanTree,
  slugOf,
  titleOf,
  vaultName,
  vaultRoot,
  writeDocAtomic,
  writeVaultKeys,
  type FileMeta,
} from "./vault.ts";
import { rm } from "node:fs/promises";

const VAULT = resolve(process.env.ZNOTES_VAULT || "./vault");
const PORT = Number(process.env.ZNOTES_PORT || 4700);
const APP_DIR = resolve(import.meta.dir, "..", "app");
const VENDOR_ENTRY = resolve(import.meta.dir, "age-entry.js");
const LOCKFILE = resolve(import.meta.dir, "..", "bun.lock");
const HEARTBEAT_MS = 20_000;

/* ============================================================
   HTTP helpers
   ============================================================ */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, message: typeof extra.message === "string" ? extra.message : error, ...extra }, status);

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Largest JSON request body any route accepts. A note is text a human typed or
 * pasted; 8 MiB is already far past that, and the cost of the alternative is
 * not just the buffer — the markdown is stored in `files.body` AND a second
 * time in the `files_fts` shadow table (db.ts), inside the vault, and is
 * re-materialised by every tree read and every search. Without a cap the only
 * bound was Bun's 128 MiB default. Refused with 413 and the limit named, the
 * same shape as the identity route.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readJsonBody(req: Request): Promise<any | typeof BAD_JSON | typeof TOO_LARGE> {
  /* The body is drained BEFORE the size is judged, deliberately: answering
     while the client is still sending desynchronises the keep-alive connection
     and the next request on it fails to parse. What bounds the read is
     `maxRequestBodySize` on Bun.serve (set just above MAX_BODY_BYTES, far below
     Bun's 128 MiB default) — anything past that never reaches this function. */
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return TOO_LARGE;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return BAD_JSON;
  }
}
const BAD_JSON = Symbol("bad-json");
const TOO_LARGE = Symbol("too-large");

/**
 * Cross-site write guard.
 *
 * SPEC §10 accepts "no app-level auth — cluster + tailnet are the perimeter",
 * but that perimeter is a NETWORK boundary and a CSRF originates inside it: any
 * page the user's browser visits can POST here. `readJsonBody` parses a body
 * regardless of content-type, so `POST /api/ai/messages` and
 * `POST /api/ai/proposals/{id}/accept` were reachable as CORS-*simple* requests
 * — no preflight, no Origin check — and proposal ids are a walkable `prop_<n>`
 * counter. Two blind fetches were enough to drive a turn, accept the proposal,
 * rewrite a note and push the commit.
 *
 * `Sec-Fetch-Site` is sent by every browser that can mount this attack and
 * cannot be forged from script; `Origin` is the fallback for anything older.
 * A non-browser client (curl, the test harness) sends neither and is unaffected.
 */
function crossSiteWrite(req: Request, url: URL): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const site = req.headers.get("sec-fetch-site");
  // "none" = the user typed/bookmarked it, which no page can forge into a POST
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin !== url.origin;
  return false;
}

/** `/api/docs/a/b%20c.md` → `a/b c.md`, or null if it is not a legal doc path. */
function decodeDocPath(rest: string): string | null {
  const parts = rest.split("/");
  const decoded: string[] = [];
  for (const p of parts) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (d.includes("/") || d.includes("\\")) return null;
    decoded.push(d);
  }
  return safePath(decoded.join("/"));
}

/* ============================================================
   Boot: index, settings, reconcile, watch
   ============================================================ */

const index = new Index(dbPath(VAULT));
const settings = new Settings(VAULT, index);
await settings.load();

const clients = new Set<SseClient>();
let clientSeq = 0;
let eventSeq = 0;

/* Monotonic vault epoch: bumped on every announced change and persisted, so a
   client that missed events while disconnected can tell by comparing the epoch
   in `hello` with the one it last saw — the stream carries no backlog. */
let vaultEpoch = Number(index.getMeta("vaultEpoch") || 0);

/* Every announced change re-arms the debounce — server writes AND the external
   edits the reconciler discovers. The vault is the source of truth and git only
   mirrors it, so a change made in vim has exactly as much claim to a commit as
   one made in the app. */
const recon = new Reconciler(VAULT, index, (change) => {
  vaultEpoch = index.nextSeq("vaultEpoch");
  broadcast("doc-changed", change);
  gitSync.schedule();
});

const GIT_LOG = process.env.ZNOTES_GIT_LOG === "1";

/* ============================================================
   Trash (SPEC §5) — a delete is recoverable.

   Constructed before GitSync only because the delete route needs both; the two
   are otherwise independent. Everything about the on-disk layout, the retention
   rule and the git decision lives in trash.ts.
   ============================================================ */

const trash = new Trash({
  vault: VAULT,
  settings,
  log: (line) => {
    if (GIT_LOG || process.env.ZNOTES_TRASH_LOG === "1") process.stdout.write(`[z-notes] ${line}\n`);
  },
});

/** How often the retention sweep runs while the server is up. */
const TRASH_SWEEP_MS = (() => {
  const raw = Number(process.env.ZNOTES_TRASH_SWEEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

const gitSync = new GitSync({
  vault: VAULT,
  settings,
  index,
  onStatus: (s) => broadcast("sync-status", s),
  // argv only; git.ts never hands this an environment, so the token cannot
  // reach a log line even when tracing is on
  log: (line) => {
    if (GIT_LOG) process.stdout.write(`[z-notes] ${line}\n`);
  },
});

/* ============================================================
   SSE
   ============================================================ */

interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const enc = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return enc.encode(`id: ${++eventSeq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown) {
  if (!clients.size) return;
  const chunk = frame(event, data);
  for (const c of [...clients]) {
    try {
      c.controller.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

const heartbeat = setInterval(() => {
  if (clients.size) broadcast("heartbeat", { t: new Date().toISOString() });
}, HEARTBEAT_MS);

function openStream(): Response {
  let self_: SseClient | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self_ = { id: "c" + ++clientSeq, controller };
      clients.add(self_);
      // first bytes: reconnect hint, then hello
      controller.enqueue(enc.encode("retry: 1000\n\n"));
      controller.enqueue(
        frame("hello", {
          clientId: self_.id,
          serverTime: new Date().toISOString(),
          epoch: vaultEpoch,
        })
      );
    },
    cancel() {
      if (self_) clients.delete(self_);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/* ============================================================
   Docs
   ============================================================ */

function metaOf(row: {
  path: string;
  title: string;
  slug: string;
  size: number;
  mtimeMs: number;
  empty: number;
  hasSecrets: number;
}): FileMeta {
  return {
    type: "file",
    path: row.path,
    name: row.path.split("/").pop()!,
    title: row.title,
    slug: row.slug,
    bytes: row.size,
    mtime: iso(row.mtimeMs),
    empty: !!row.empty,
    hasSecrets: !!row.hasSecrets,
  };
}

async function treeResponse() {
  const files = index.allFileMeta().map(metaOf);
  return {
    vault: { name: vaultName(VAULT), root: vaultRoot(VAULT), docCount: files.length },
    tree: buildTree(files, index.folderOpen(), await scanFolders(VAULT)),
  };
}

/**
 * Everything here is derived from the bytes just read — never from the sqlite
 * row. The row can lag disk (the reconcile pass is debounced), and pairing
 * fresh markdown with a stale `rev` would make PUT's compare-and-swap validate
 * against content that is no longer there: an external edit would be silently
 * overwritten instead of raising 409.
 */
async function docBody(path: string) {
  const disk = await readDoc(VAULT, path);
  if (!disk) return null;
  const md = disk.markdown;
  return {
    type: "file",
    path,
    name: path.split("/").pop()!,
    title: titleOf(md, path.split("/").pop()!),
    slug: slugOf(path),
    markdown: md,
    rev: revOf(md),
    bytes: disk.size,
    mtime: iso(disk.mtimeMs),
    empty: !md.trim(),
    hasSecrets: hasSecrets(md),
  };
}

/**
 * macOS resolves several distinct strings to the same file (case-insensitive,
 * NFC/NFD-insensitive). A write would land while every index lookup keyed on the
 * client's spelling missed, so resolve to the spelling the index actually holds.
 */
function canonicalDocPath(p: string): string {
  if (index.file(p)) return p;
  const want = p.normalize("NFC").toLowerCase();
  for (const row of index.allFileMeta()) {
    if (row.path.normalize("NFC").toLowerCase() === want) return row.path;
  }
  return p;
}

/* ============================================================
   File ops — PATCH (rename/move) + DELETE (SPEC §3 delta 2, §5, phase 5).

   HUMAN-ONLY, STRUCTURALLY. SPEC §8 gives the assistant no delete and no
   rename: `propose_edits` accepts exactly `replace | insert_after | create |
   rewrite`, ai.ts writes through `writeDocAtomic` and nothing else, and nothing
   in ai.ts can reach the two functions below — they are not exported, not on
   the AI deps object, and the AI never issues an HTTP request against this
   server. The absence is the guarantee.

   Both ops are ONE git commit and are atomic in the sense that matters: the
   vault is never left half-moved. The order is rename → rewrite backlinks →
   reconcile → commit; a failure anywhere in the write phase restores every file
   already touched (the phase-4 accept() rollback pattern) and answers 500.
   ============================================================ */

const isMd = (p: string) => /\.md$/i.test(p);

/** vault.ts blockedByFile, bound to this server's vault. */
const blockedByFile = (target: string) => vaultBlockedByFile(VAULT, target);

/**
 * PATCH /api/docs/{path} `{to}` and DELETE /api/docs/{path}.
 *
 * Runs under the reconcile lock, and OPENS with a full reconcile pass: the
 * whole plan below is computed against the sqlite backlink graph, and that
 * graph is only true if the index has seen every byte on disk. Holding the lock
 * from that pass through the write means nothing can drift underneath it.
 */
async function fileOp(method: "PATCH" | "DELETE", rel: string, body: unknown): Promise<Response> {
  return recon.lock(async () => {
    await recon.reconcileHeld();

    const kind = await exists(VAULT, rel);
    if (!kind) return fail(404, "not-found", { message: `Nothing at ${rel}` });
    // a doc is a .md file (SPEC §5). Anything else that happens to sit in the
    // vault is in no tree, no search result, and is not renamable or deletable
    // through this API either.
    if (kind === "file" && !isMd(rel)) return fail(404, "not-found", { message: `No doc at ${rel}` });
    const from = kind === "file" ? canonicalDocPath(rel) : rel;

    const beforeDocs = await scanDocs(VAULT);
    const subtree = kind === "file" ? [from] : beforeDocs.filter((d) => d.startsWith(from + "/"));
    /* Every FILE the op will actually touch, `.md` or not: `moveNode` is one
       rename(2) and the trash move another, so a folder carries its images and
       its README along (API.md § PATCH). Naming only the `.md` children in the
       commit left those deleted-in-the-worktree and alive-in-HEAD forever — the
       bulk `stage()` is `.md`-only too, so nothing downstream could ever heal
       it, and `dirtyOutsideAllowlist()` then wedged every future push. */
    const payload = kind === "file" ? [from] : await scanTree(VAULT, from);

    return method === "DELETE"
      ? deleteNode(from, kind, subtree, payload)
      : moveNodeOp(from, kind, beforeDocs, subtree, payload, body);
  });
}

async function moveNodeOp(
  from: string,
  kind: "file" | "dir",
  beforeDocs: string[],
  subtree: string[],
  payload: string[],
  body: any
): Promise<Response> {
  const to = safePath(body?.to);
  if (!to || !absOf(VAULT, to)) {
    return fail(400, "bad-path", { message: "`to` must be a vault-relative path that stays inside the vault." });
  }
  if (kind === "file" && !isMd(to)) return fail(400, "bad-path", { message: "A doc path must end in .md." });
  /* The no-op answers first, for a folder exactly as for a doc: `to === from`
     is not "moved inside itself", it is nothing at all, and answering 400 for
     one entity kind and 200 for the other is a contract the client cannot
     reason about. */
  if (to === from) {
    // an explicit no-op is not an error; answer as if it had been done
    const same = kind === "file" ? await docBody(from) : null;
    return json(moveOut(kind, from, from, same, [], 0, kind === "dir" ? new Map() : undefined));
  }
  if (kind === "dir" && to.startsWith(from + "/")) {
    return fail(400, "bad-path", { message: "A folder cannot be moved inside itself." });
  }

  const absFrom = absOf(VAULT, from)!;
  const absTo = absOf(VAULT, to)!;
  const taken = await exists(VAULT, to);
  // ...unless the two spellings are the same inode: on macOS `Foo.md` →
  // `foo.md` is a legal rename that `exists()` reports as a collision
  if (taken && !sameNode(absFrom, absTo)) return fail(409, "exists", { message: `${to} already exists.` });
  const blocker = await blockedByFile(to);
  if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });

  /* ---------- plan ---------- */

  const mapping = new Map<string, string>();
  if (kind === "file") mapping.set(from, to);
  else for (const d of subtree) mapping.set(d, to + d.slice(from.length));

  /* Every spelling the rewriter could emit for a destination has to survive a
     `[[…]]` round trip. It does not for a name carrying `]]` (or a bare `]`, or
     a line break): the rewrite splices it in unescaped, so `[[x]]y]]` lands in
     the prose of every referrer, the renderer paints a broken pill and dumps
     the tail as text, and `LINK_RE` can never see the mangled occurrence again
     — renaming back answers 200 with `backlinksUpdated:0` and repairs nothing.
     Refuse the move instead; nothing has been written yet. */
  for (const dest of mapping.values()) {
    if (!linkSafeTarget(dest.replace(/\.md$/i, "")) || !linkSafeTarget(slugOf(dest))) {
      return fail(400, "bad-path", {
        message: `${dest} cannot be a doc name: "]" and line breaks break out of the [[link]] that would point at it.`,
      });
    }
  }

  /* Candidates = the docs the backlink graph says carry a target whose
     resolution changes. That is a superset of the docs that actually need a
     rewrite (the graph indexes links inside ordinary code fences too, which the
     rewriter refuses to touch) and never a subset. */
  const affected = affectedTargets(beforeDocs, mapping, index.linkTargets());
  const candidates: Array<{ path: string; markdown: string }> = [];
  for (const src of index.backlinkSources(affected)) {
    const disk = await readDoc(VAULT, src);
    if (!disk) continue; // vanished between the pass and here
    candidates.push({ path: mapping.get(src) ?? src, markdown: disk.markdown });
  }
  const rewrites = planLinkRewrites(beforeDocs, mapping, candidates);
  const pre = new Map(candidates.map((c) => [c.path, c.markdown]));

  /* ---------- write (rename first, then the rewrites) ---------- */

  let moved: { created: string | null } | null = null;
  const written: string[] = [];
  try {
    moved = await moveNode(VAULT, from, to);
    for (const r of rewrites) {
      await writeDocAtomic(VAULT, r.path, r.markdown);
      written.push(r.path);
    }
  } catch (err) {
    const message = String((err as Error)?.message || err);
    for (const p of written.reverse()) {
      try {
        await writeDocAtomic(VAULT, p, pre.get(p)!);
      } catch (rollbackErr) {
        process.stderr.write(`[z-notes] move rollback FAILED for ${p} — ${String(rollbackErr)}\n`);
      }
    }
    if (moved) {
      try {
        await moveNode(VAULT, to, from);
        // the scaffolding mkdir -p made for a target that no longer exists
        if (moved.created) await rm(moved.created, { recursive: true, force: true }).catch(() => {});
      } catch (rollbackErr) {
        process.stderr.write(`[z-notes] move rollback FAILED for ${to} — ${String(rollbackErr)}\n`);
      }
    }
    await recon.reconcileHeld().catch(() => {});
    return fail(500, "move-failed", {
      path: from,
      message: `Could not move ${from} → ${to}: ${message}. Nothing was changed.`,
    });
  }

  if (kind === "dir") index.moveFolders(from, to);
  /* An applied AI proposal's pre-image is addressed by PATH. Leaving it behind
     made every revert below it unreachable forever: the drift guard read the
     old path, saw nothing, and answered 409 naming a file the user could no
     longer see. The change stack follows the doc. */
  index.moveProposalFiles(mapping);

  /* ---------- announce ---------- */

  const hints: ChangeHints = new Map<string, ChangeHint>();
  for (const [o, n] of mapping) {
    hints.set(o, { reason: "moved", to: n });
    hints.set(n, { reason: "moved", from: o });
  }
  for (const r of rewrites) if (!hints.has(r.path)) hints.set(r.path, "write");
  await recon.reconcileHeld(hints);

  /* ---------- one commit (SPEC §5: "rewrites all backlinks in one commit") ---------- */

  const links = rewrites.reduce((n, r) => n + r.links, 0);
  const message =
    `move: ${from} → ${to}` +
    (rewrites.length
      ? `\n\nRewrote ${links} [[link]]${links === 1 ? "" : "s"} in ${rewrites.length} doc${rewrites.length === 1 ? "" : "s"}.`
      : "");
  /* Both spellings of every file the rename actually touched — the `.md` docs
     the mapping knows about AND the non-`.md` payload only the filesystem saw. */
  const paths = [
    ...new Set([
      ...mapping.keys(),
      ...mapping.values(),
      ...payload,
      ...payload.map((p) => to + p.slice(from.length)),
      ...rewrites.map((r) => r.path),
    ]),
  ];
  const commit = await commitFileOp(paths, message);

  const doc = kind === "file" ? await docBody(to) : null;
  return json({
    ...moveOut(kind, from, to, doc, rewrites.map((r) => r.path).sort(), links, mapping),
    ...commit,
  });
}

/**
 * `commitPaths` reports every phase-2 guard (mid-merge, detached HEAD, a
 * credential canary, a case-only rename it could not stage) by RETURNING
 * `{committed:false, reason}` — it does not throw. Discarding that, as this
 * used to, meant a move or a delete answered 200/204 with a success toast while
 * nothing reached git and the index was left with a staged change the user was
 * never told about. `ai.accept()` already records the reason on the proposal;
 * the file ops put it on the wire and in the log.
 */
async function commitFileOp(paths: string[], message: string): Promise<{ committed: boolean; commitNote: string | null }> {
  let r = { committed: false, sha: null as string | null, reason: "git commit not attempted" };
  try {
    r = await gitSync.commitPaths(paths, message);
  } catch (err) {
    r = { committed: false, sha: null, reason: String((err as Error)?.message || err) };
  }
  if (!r.committed) process.stderr.write(`[z-notes] commit skipped (${message.split("\n")[0]}) — ${r.reason}\n`);
  return { committed: r.committed, commitNote: r.committed ? null : r.reason };
}

function moveOut(
  kind: "file" | "dir",
  from: string,
  to: string,
  doc: Awaited<ReturnType<typeof docBody>>,
  updated: string[],
  backlinksUpdated: number,
  mapping?: Map<string, string>
) {
  return {
    type: kind === "dir" ? "folder" : "file",
    path: to,
    from,
    rev: doc?.rev ?? null,
    bytes: doc?.bytes ?? null,
    mtime: doc?.mtime ?? null,
    backlinksUpdated,
    updated,
    ...(kind === "dir" ? { moved: [...(mapping ?? new Map())].map(([a, b]) => ({ from: a, to: b })) } : {}),
  };
}

/**
 * DELETE — now a MOVE TO TRASH rather than an unlink (SPEC §5).
 *
 * The doc (or the whole folder subtree) is renamed into `.znotes/trash/<id>/`,
 * which the vault scan, search and the backlink graph cannot see, and the
 * entry, the departure and everything the move carried land in ONE commit,
 * exactly as before. `removeNode` is not on this path any more: nothing in the
 * app unlinks a document the user asked to delete.
 *
 * Backlinks to a deleted doc are still deliberately NOT rewritten — they become
 * broken links, which the preview flags with a create-doc affordance. Rewriting
 * them would erase the only record that something used to be there, and it is
 * now doubly wrong: the doc may well come back.
 */
async function deleteNode(
  from: string,
  kind: "file" | "dir",
  subtree: string[],
  payload: string[]
): Promise<Response> {
  const gone = kind === "file" ? [from] : subtree;
  let meta;
  try {
    meta = await trash.put(from, kind === "file" ? "doc" : "folder", payload);
  } catch (err) {
    // the move either happened or it did not; there is no half-trashed state
    return fail(500, "delete-failed", {
      path: from,
      message: `Could not delete ${from}: ${String((err as Error)?.message || err)}`,
    });
  }
  if (kind === "dir") index.removeFolders(from);

  const hints: ChangeHints = new Map<string, ChangeHint>();
  for (const p of gone) hints.set(p, { reason: "deleted", trashId: meta.id });
  await recon.reconcileHeld(hints);

  /* the whole subtree, not just its `.md` docs — the rename took the
     attachments with it and no other git path can ever notice they left — plus
     the trash entry that now holds them, so the delete and its undo are the
     same commit and a clone can restore from it */
  const paths = [...new Set([...gone, ...payload, ...trash.entryGitPaths(meta.id, meta)])];
  // API.md fixes DELETE at 204 with no body, so the skip reason goes to the log
  if (paths.length) await commitFileOp(paths, `delete: ${from}`);
  await announceTrash();
  /* Sweeping HERE as well as at boot and on the interval is what makes the
     retention window true for a long-lived server that is never restarted. It
     is deliberately after the response's own commit, so a sweep failure cannot
     turn a successful delete into a 500. */
  sweepTrash("after a delete").catch(() => {});
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/* ============================================================
   Trash routes (API.md § Trash)

   Every one of them runs under the reconcile lock, for the same reason the file
   ops do: restore WRITES into the vault, and the plan (is the path free? what
   is in the entry?) is only true while nothing else can move underneath it.
   ============================================================ */

/** The trash list, pushed to every client — same body `GET /api/trash` serves. */
async function announceTrash() {
  try {
    broadcast("trash-changed", await trash.view());
  } catch (err) {
    process.stderr.write(`[z-notes] trash-changed failed: ${String(err)}\n`);
  }
}

/**
 * Apply the retention policy now. Runs at boot, every `TRASH_SWEEP_MS`, and
 * after every delete. One commit for the whole sweep — it is one decision, made
 * by a schedule, not N user actions.
 */
async function sweepTrash(why: string): Promise<string[]> {
  return recon.lock(async () => {
    const { purged, entryPaths } = await trash.sweep();
    if (!purged.length) return purged;
    process.stdout.write(
      `[z-notes] trash: purged ${purged.length} expired entr${purged.length === 1 ? "y" : "ies"} (${why})\n`
    );
    if (entryPaths.length) {
      await commitFileOp(entryPaths, `trash: purge ${purged.length} expired entr${purged.length === 1 ? "y" : "ies"}`);
    }
    await announceTrash();
    return purged;
  });
}

/** POST /api/trash/{id}/restore */
async function restoreTrash(id: string): Promise<Response> {
  return recon.lock(async () => {
    // the same opening move the file ops make: plan against an index that has
    // seen every byte on disk, with the lock held from that pass through the write
    await recon.reconcileHeld();
    let restored;
    try {
      restored = await trash.restore(id);
    } catch (err) {
      if (err instanceof TrashError) return fail(err.status, err.code, { message: err.message, ...err.extra });
      return fail(500, "restore-failed", {
        message: `Could not restore ${id}: ${String((err as Error)?.message || err)}`,
      });
    }
    const { meta, entryPaths } = restored;

    const hints: ChangeHints = new Map<string, ChangeHint>();
    for (const p of meta.docs) hints.set(p, { reason: "restored", trashId: meta.id });
    await recon.reconcileHeld(hints);

    const paths = [...new Set([...meta.files, ...entryPaths])];
    const commit = await commitFileOp(paths, `restore: ${meta.path}`);
    await announceTrash();

    const doc = meta.kind === "doc" ? await docBody(meta.path) : null;
    return json({
      type: meta.kind === "doc" ? "file" : "folder",
      id: meta.id,
      path: meta.path,
      kind: meta.kind,
      deletedAt: meta.deletedAt,
      restored: meta.docs,
      rev: doc?.rev ?? null,
      bytes: doc?.bytes ?? null,
      mtime: doc?.mtime ?? null,
      ...commit,
    });
  });
}

/** DELETE /api/trash/{id} — permanent, and the bytes really do go. */
async function purgeTrashEntry(id: string): Promise<Response> {
  return recon.lock(async () => {
    let out;
    try {
      out = await trash.purgeEntry(id);
    } catch (err) {
      if (err instanceof TrashError) return fail(err.status, err.code, { message: err.message, ...err.extra });
      return fail(500, "purge-failed", {
        message: `Could not delete trash entry ${id}: ${String((err as Error)?.message || err)}`,
      });
    }
    if (out.entryPaths.length) {
      await commitFileOp(out.entryPaths, `trash: delete ${out.meta?.path ?? id}`);
    }
    await announceTrash();
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}

/* ============================================================
   Search — port of the mock's scorer (sw.js), server-side.
   Subsequence match over doc paths AND content lines; the content used is
   the redacted body, so age armor can never surface in a result.
   ============================================================ */

function fuzzy(q: string, hay: string): { score: number; idx: number[] } | null {
  if (!q) return { score: 0, idx: [] };
  const n = q.toLowerCase();
  const h = hay.toLowerCase();
  const idx: number[] = [];
  let from = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    if (c === " ") {
      prev = -2;
      continue;
    }
    const at = h.indexOf(c, from);
    if (at < 0) return null;
    idx.push(at);
    if (at === prev + 1) score += 7;
    else score += 1;
    if (at === 0 || /[\s/\-_.,:|[\]()]/.test(h.charAt(at - 1))) score += 5;
    prev = at;
    from = at + 1;
  }
  if (h.indexOf(n.replace(/\s+/g, "")) >= 0) score += 22;
  score -= idx[0] * 0.08;
  score -= Math.max(0, hay.length - 60) * 0.01;
  return { score, idx };
}

interface SearchHit {
  kind: "doc" | "line";
  path: string;
  name: string;
  line?: number;
  text: string;
  matches: number[];
  score: number;
}

function runSearch(q: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  for (const row of index.allFiles()) {
    const path = row.path;
    const name = path.split("/").pop()!;
    if (!q) {
      out.push({ kind: "doc", path, name, text: path, matches: [], score: 0 });
      continue;
    }
    const nm = fuzzy(q, path);
    if (nm) out.push({ kind: "doc", path, name, text: path, matches: nm.idx, score: nm.score + 12 });
    const lines = row.body.split("\n");
    const hits: SearchHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.length < 2) continue;
      const r = fuzzy(q, raw);
      if (r) hits.push({ kind: "line", path, name, line: i, text: raw, matches: r.idx, score: r.score });
    }
    hits.sort((a, b) => b.score - a.score);
    for (const h of hits.slice(0, 2)) out.push(h);
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

/* ============================================================
   AI relay (SPEC §8, phase 4) — everything upstream lives in ai.ts.

   The key never reaches the browser, context is assembled here from on-disk
   bytes, and no proposed edit is offered to the UI until it has been validated
   against those same bytes.
   ============================================================ */

/* ============================================================
   Terminal (SPEC §13) — the password-locked command runner.

   Constructed BEFORE the AI relay because the relay takes it as a dependency:
   `run_command` is only declared to the model when this says the terminal is
   available, and the approval gate lives inside it.
   ============================================================ */

const terminal = new Terminal({
  vault: VAULT,
  settings,
  index,
  log: (line) => {
    if (GIT_LOG || process.env.ZNOTES_TERMINAL_LOG === "1") process.stdout.write(`[z-notes] ${line}\n`);
  },
  /* NOTIFICATION ONLY. `/events` is the app-wide bus and is not behind the
     terminal password, so it carries an id and a state and never a command
     string or a byte of output — the panel fetches those over the bearer-gated
     route once it knows to. */
  onCommandEvent: (data) => broadcast("terminal-command", data),
});

const ai = new AI({
  vault: VAULT,
  settings,
  index,
  git: gitSync,
  recon,
  docBody,
  terminal,
  contextWindow: META.contextWindow,
  log: (line) => {
    if (GIT_LOG || process.env.ZNOTES_AI_LOG === "1") process.stdout.write(`[z-notes] ${line}\n`);
  },
  /* The statusbar's AI item is driven by this, exactly like the git chip is
     driven by `sync-status`: pushed on real change, never polled. */
  onStatus: (s) => broadcast("ai-status", s),
});

/* ============================================================
   /vendor/age.js — the age-encryption (typage) browser bundle.

   SPEC §2 keeps the frontend build-free, and SPEC §6 needs exactly one library
   in the browser. Squaring those: bundle `vendor/age-entry.js` with Bun.build
   ONCE at boot, hold the bytes in memory, serve them. No artifact is written,
   nothing is added to `dev`, and the crypto worker gets a plain ESM import.

   Cache shape is the standard content-addressed pair: `/vendor/age.js` is a
   tiny no-cache redirect to `/vendor/age.<hash>.js`, which is immutable for a
   year. The hash is over the lockfile + the entry source, so bumping the
   dependency changes the URL and no stale bundle can survive a restart —
   which matters more here than elsewhere, because this bundle is the crypto.
   ============================================================ */

interface VendorBundle {
  js: string;
  hash: string;
  etag: string;
  name: string;
}

let vendor: VendorBundle | null = null;
let vendorError = "";

async function buildVendor(): Promise<void> {
  try {
    const lock = await Bun.file(LOCKFILE)
      .text()
      .catch(() => "");
    const entry = await Bun.file(VENDOR_ENTRY).text();
    const built = await Bun.build({
      entrypoints: [VENDOR_ENTRY],
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!built.success || !built.outputs.length) {
      throw new Error(built.logs.map((l) => String(l)).join("; ") || "no output");
    }
    const js = await built.outputs[0].text();
    // key on the inputs (lockfile + entry) AND the output, so an identical
    // dependency tree always yields the same URL across restarts
    const hash = Bun.hash(lock + "\0" + entry + "\0" + js).toString(16);
    vendor = { js, hash, etag: `"${hash}"`, name: `age.${hash}.js` };
    vendorError = "";
  } catch (err) {
    vendor = null;
    vendorError = String((err as Error)?.message || err);
    process.stderr.write(`[z-notes] vendor bundle failed: ${vendorError}\n`);
  }
}

/** GET /vendor/… — 302 for the unhashed alias, the bundle for the hashed one. */
function serveVendor(pathname: string, req: Request): Response {
  if (!vendor) {
    // the client feature-detects on worker init; a JSON body it can read beats
    // an opaque 500, and secrets simply degrade to the badge (SPEC §6)
    return fail(503, "vendor-unavailable", {
      message: "The age bundle could not be built; secrets features are unavailable.",
      detail: vendorError,
    });
  }
  if (pathname === "/vendor/age.js") {
    return new Response(null, {
      status: 302,
      headers: { location: `/vendor/${vendor.name}`, "cache-control": "no-cache" },
    });
  }
  if (pathname !== `/vendor/${vendor.name}`) {
    // a hash from a previous build — send them to the current one
    return new Response(null, {
      status: 302,
      headers: { location: `/vendor/${vendor.name}`, "cache-control": "no-cache" },
    });
  }
  const headers: Record<string, string> = {
    "content-type": "text/javascript; charset=utf-8",
    etag: vendor.etag,
    "cache-control": "public, max-age=31536000, immutable",
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === vendor!.etag)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD")
    return new Response(null, { status: 200, headers: { ...headers, "content-length": String(Buffer.byteLength(vendor.js)) } });
  return new Response(vendor.js, { status: 200, headers });
}

/* ============================================================
   Static frontend (Bun emits no ETag — we add one and honour If-None-Match)
   ============================================================ */

async function serveStatic(pathname: string, req: Request): Promise<Response> {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  if (rel.endsWith("/")) rel += "index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return fail(400, "bad-path", { message: "Malformed URL path." });
  }
  if (decoded.includes("\0") || decoded.split("/").some((s) => s === "..")) {
    return fail(400, "bad-path", { message: "Path escapes the app directory." });
  }
  const abs = resolve(APP_DIR, decoded);
  if (abs !== APP_DIR && !abs.startsWith(APP_DIR + "/")) {
    return fail(400, "bad-path", { message: "Path escapes the app directory." });
  }
  const file = Bun.file(abs);
  let st;
  try {
    st = await file.stat();
  } catch {
    return fail(404, "not-found", { message: `No such file: ${pathname}` });
  }
  if (!st.isFile()) return fail(404, "not-found", { message: `No such file: ${pathname}` });

  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    etag,
    "cache-control": "no-cache",
    "content-type": file.type || "application/octet-stream",
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(st.size) } });
  return new Response(file, { status: 200, headers });
}

/* ============================================================
   API router
   ============================================================ */

async function api(req: Request, url: URL, caller: string | null): Promise<Response> {
  const method = req.method.toUpperCase();
  const rest = url.pathname.slice("/api/".length);

  let body: any = null;
  if (method === "PUT" || method === "POST" || method === "PATCH") {
    body = await readJsonBody(req);
    if (body === TOO_LARGE)
      return fail(413, "too-large", {
        message: `Request body is larger than the ${Math.round(MAX_BODY_BYTES / (1024 * 1024))} MiB limit.`,
        limit: MAX_BODY_BYTES,
      });
    if (body === BAD_JSON) return fail(400, "bad-json", { message: "Body is not valid JSON." });
  }

  /* ---------- docs ---------- */

  if (rest === "docs") {
    if (method === "GET") return json(await treeResponse());
    if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/docs` });

    const p = safePath(body?.path);
    if (!p) return fail(400, "bad-path", { message: "Path escapes the vault." });
    // safePath is lexical; absOf also resolves symlinks, so this is what stops a
    // link inside the vault from becoming a create outside it
    if (!absOf(VAULT, p)) return fail(400, "bad-path", { message: "Path escapes the vault." });
    const type = body?.type === "folder" ? "folder" : "doc";

    /* The same guard the MOVE applies to its destinations, applied at birth.
       `safePath` stops traversal and `.znotes`, but says nothing about "]" or a
       line break — and a doc whose path carries either cannot survive the
       `[[…]]` that a later rename would splice it into, so the move refuses to
       produce that name. Minting it directly was the way around that refusal:
       one POST and the vault holds a doc that can never be renamed (400 from
       every PATCH) and whose backlinks corrupt whatever rewrote them. A folder
       is checked too — every doc created under it inherits the bad segment. */
    if (!linkSafeTarget(p.replace(/\.md$/i, "")) || !linkSafeTarget(slugOf(p))) {
      return fail(400, "bad-path", {
        message: `${p} cannot be a name: "]" and line breaks break out of the [[link]] that would point at it.`,
      });
    }

    if (type === "folder") {
      if (await exists(VAULT, p)) return fail(409, "exists", { message: `${p} already exists.` });
      const blocker = await blockedByFile(p);
      if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });
      return recon.lock(async () => {
        // re-checked under the lock: the gate above raced anything already held
        if (await exists(VAULT, p)) return fail(409, "exists", { message: `${p} already exists.` });
        /* implicit parents, and a real rollback for them: `a/b/c` makes a and
           a/b on the way, and a failure must not leave that tree standing */
        const implicit = await missingFolders(VAULT, p, true);
        try {
          await makeFolder(VAULT, p);
        } catch (err) {
          await pruneEmptyFolders(VAULT, implicit);
          return fail(500, "write-failed", { message: `${p} could not be created.` });
        }
        index.setFolderOpen(p, true);
        return json({ type: "folder", path: p, name: p.split("/").pop()! }, 201);
      });
    }

    const file = p.replace(/\.md$/i, "") + ".md";
    if (await exists(VAULT, file)) return fail(409, "exists", { message: `${file} already exists.` });
    const blocker = await blockedByFile(file);
    if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });
    const markdown = typeof body?.markdown === "string" ? body.markdown : "";
    return recon.lock(async () => {
      if (await exists(VAULT, file)) return fail(409, "exists", { message: `${file} already exists.` });
      const implicit = await missingFolders(VAULT, file, false);
      try {
        await writeDocAtomic(VAULT, file, markdown);
      } catch (err) {
        await pruneEmptyFolders(VAULT, implicit);
        return fail(500, "write-failed", { message: `${file} could not be created.` });
      }
      await recon.reconcileHeld(new Map<string, ChangeReason>([[file, "created"]]));
      const out = await docBody(file);
      if (out) return json(out, 201);
      await pruneEmptyFolders(VAULT, implicit);
      return fail(500, "write-failed", { message: "The new doc vanished after writing." });
    });
  }

  if (rest === "docs/" || rest.startsWith("docs/")) {
    const decoded = decodeDocPath(rest.slice("docs/".length));
    if (!decoded) return fail(400, "bad-path", { message: "Path escapes the vault." });

    /* The file ops address FOLDERS as well as docs (a folder rename moves the
       subtree), so they are routed before the ".md or it is not a doc" gate;
       fileOp applies that gate itself once it knows what is actually there. */
    if (method === "PATCH" || method === "DELETE") return fileOp(method, decoded, body);

    // SPEC §5: a doc is a .md file. Without this, GET hands out any file that
    // happens to sit in the vault (.env, an ssh key) even though it is in no
    // tree and no search result.
    if (!/\.md$/i.test(decoded)) return fail(404, "not-found", { message: `No doc at ${decoded}` });
    const p = canonicalDocPath(decoded);

    if (method === "GET") {
      const out = await docBody(p);
      return out ? json(out) : fail(404, "not-found", { message: `No doc at ${p}` });
    }

    if (method === "PUT") {
      if (typeof body?.markdown !== "string") return fail(400, "bad-body", { message: "markdown must be a string." });
      const markdown: string = body.markdown;
      const wantRev: string | undefined = typeof body.rev === "string" && body.rev ? body.rev : undefined;

      // the whole read-compare-write runs under the reconcile lock: atomic
      return recon.lock(async () => {
        const current = await docBody(p);
        if (!current) return fail(404, "not-found", { message: `No doc at ${p}` });
        if (wantRev && wantRev !== current.rev) {
          return fail(409, "rev-conflict", {
            rev: current.rev,
            markdown: current.markdown,
            message: "This doc changed since you read it.",
          });
        }
        if (markdown === current.markdown) {
          // identical bytes ⇒ same rev, no write, no doc-changed
          return json({ path: p, rev: current.rev, bytes: current.bytes, mtime: current.mtime });
        }
        await writeDocAtomic(VAULT, p, markdown);
        await recon.reconcileHeld(new Map<string, ChangeReason>([[p, "write"]]));
        // read the result back off disk: a write that landed must never be
        // reported as a server fault because an index lookup missed
        const after = await docBody(p);
        if (!after) return fail(500, "write-failed", { message: "The doc vanished after writing." });
        return json({ path: p, rev: after.rev, bytes: after.bytes, mtime: after.mtime });
      });
    }

    return fail(405, "method-not-allowed", { message: `${method} /api/docs/${p}` });
  }

  /* ---------- trash (API.md § Trash) ----------

     Deliberately a SEPARATE namespace from `/api/docs`: a trashed doc is not a
     doc — it is in no tree, no search result and no backlink, and addressing it
     by its old vault path would be a lie the moment something else is created
     there. Entries are addressed by the opaque id the delete minted. */

  if (rest === "trash") {
    if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/trash` });
    return json(await trash.view());
  }

  if (rest === "trash/purge") {
    if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/trash/purge` });
    /* No body (or `{}`) applies the RETENTION policy — the same sweep the
       schedule runs, on demand. `{"all":true}` is Empty trash: it does not
       consult the window at all, so the two can never be confused for each
       other by an accidental default. */
    if (body?.all === true) {
      return recon.lock(async () => {
        const { purged, entryPaths } = await trash.purgeAll();
        if (entryPaths.length) await commitFileOp(entryPaths, `trash: empty (${purged.length})`);
        if (purged.length) await announceTrash();
        return json({ purged, retentionDays: trash.retentionDays(), all: true });
      });
    }
    return json({ purged: await sweepTrash("requested"), retentionDays: trash.retentionDays(), all: false });
  }

  if (rest.startsWith("trash/")) {
    const restore = /^trash\/([^/]+)\/restore$/.exec(rest);
    const bare = /^trash\/([^/]+)$/.exec(rest);
    const raw = restore?.[1] ?? bare?.[1];
    if (raw != null) {
      let id: string;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return fail(400, "bad-id", { message: "Malformed trash id." });
      }
      if (!isTrashId(id)) return fail(400, "bad-id", { message: `Not a trash id: ${id}` });
      if (restore) {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/${rest}` });
        return restoreTrash(id);
      }
      if (method === "GET") {
        const found = await trash.entry(id);
        return found ? json(found.out) : fail(404, "not-found", { message: `No trash entry ${id}.` });
      }
      if (method === "DELETE") return purgeTrashEntry(id);
      return fail(405, "method-not-allowed", { message: `${method} /api/${rest}` });
    }
    return fail(404, "no-route", { message: `${method} ${url.pathname} is not part of the v0 contract.` });
  }

  /* ---------- search ---------- */

  if (rest === "search") {
    if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/search` });
    const q = (url.searchParams.get("q") || "").trim();
    // clamp both ends: a negative limit would reach out.slice(0, limit) and
    // quietly lop results off the END of the list instead of paging
    const asked = parseInt(url.searchParams.get("limit") || "24", 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(100, asked) : 24;
    return json({ query: q, results: runSearch(q, limit) });
  }

  /* ---------- secrets: retired (SPEC §3 delta 1) ---------- */

  /* The mock decrypted server-side; the real app decrypts in the browser and
     the server never sees a passphrase or a plaintext. Answering with a slug
     the client can branch on (rather than the generic no-route message) is what
     lets the UI degrade to the badge instead of toasting a router internal. */
  if (rest === "secrets" || rest.startsWith("secrets/")) {
    return fail(404, "secrets-client-side", {
      message: "Secrets are decrypted in the browser; the server has no secrets endpoint.",
    });
  }

  /* ---------- vault keyring (SPEC §6) ----------

     Two opaque strings, stored and served. The identity is ALREADY encrypted
     (scrypt logN=18, done in the browser) before it ever arrives, so this
     route handles ciphertext exclusively: no passphrase reaches the process,
     nothing here decrypts, and validation is shape-only. */

  if (rest === "vault/recipient") {
    if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/vault/recipient` });
    const keys = await readVaultKeys(VAULT);
    if (!keys.recipient) return fail(404, "no-identity", { message: "This vault has no age recipient yet." });
    return json({ recipient: keys.recipient });
  }

  if (rest === "vault/identity") {
    if (method === "GET") {
      const keys = await readVaultKeys(VAULT);
      if (!keys.identity) return fail(404, "no-identity", { message: "This vault has no age identity yet." });
      /* the body IS the armor — the client hands it straight to the worker,
         and a JSON wrapper would only be one more place to re-encode it */
      return new Response(keys.identity.endsWith("\n") ? keys.identity : keys.identity + "\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (method === "PUT") {
      const identity = typeof body?.identity === "string" ? body.identity.trim() : "";
      const recipient = typeof body?.recipient === "string" ? body.recipient.trim() : "";
      if (!isArmor(identity))
        return fail(400, "bad-identity", { message: "identity must be an age ASCII-armored file." });
      if (!isRecipient(recipient))
        return fail(400, "bad-recipient", { message: "recipient must be an age1… public key." });
      // 64 KiB is ~100× a wrapped X25519 identity; anything larger is not one
      if (identity.length > 65536) return fail(413, "too-large", { message: "identity is implausibly large." });

      const existing = await readVaultKeys(VAULT);
      const present = !!(existing.identity || existing.recipient);
      if (present && body?.replace !== true)
        return fail(409, "exists", {
          message: "This vault already has an identity. Pass replace:true to overwrite it.",
          recipient: existing.recipient,
        });

      await writeVaultKeys(VAULT, identity, recipient);
      /* `.znotes/` is invisible to the doc reconciler, so nothing else would
         ever ask git to commit the new keyring — both files are in
         TRACKED_META (git.ts) and this is what stages them (SPEC §7). */
      gitSync.schedule();
      return json({ recipient, replaced: present }, present ? 200 : 201);
    }

    return fail(405, "method-not-allowed", { message: `${method} /api/vault/identity` });
  }

  if (rest === "vault" || rest.startsWith("vault/")) {
    return fail(404, "no-route", { message: `${method} ${url.pathname} is not part of the v0 contract.` });
  }

  /* ---------- settings ---------- */

  if (rest === "settings") {
    if (method === "GET") {
      // settings.toml is committed and hand-editable, so it can change under us
      // (a pull, another machine, an editor). Serve what is on disk, not a
      // boot-time snapshot — see Settings.reloadIfChanged.
      const changed = await settings.reloadIfChanged();
      /* A reload IS a settings change and gets the same fan-out a PUT does:
         without it a pulled settings.toml altered behaviour (autoSync timer,
         retention window) with no re-evaluation and no `settings-changed`
         frame, so other tabs kept enforcing the old values indefinitely. */
      if (changed) {
        gitSync.applySettings();
        ai.announce();
        broadcast("settings-changed", settings.get());
        sweepTrash("settings reloaded from disk").catch(() => {});
      }
      return json(settings.get());
    }
    if (method === "PUT") {
      try {
        const endpoint = () =>
          JSON.stringify([
            settings.value("ai.baseUrl", ""),
            settings.value("ai.model", ""),
            settings.credential("ai.apiKey"),
          ]);
        const before = endpoint();
        const retentionBefore = trash.retentionDays();
        /* Whether the patch NAMES ai.effort, not whether the stored value moved:
           the ladder downgrades behind the configured value, so the case that
           has to be caught is a user re-picking the effort they already had. */
        const picksEffort =
          !!body && typeof body === "object" && !Array.isArray(body) &&
          !!(body as any).ai && typeof (body as any).ai === "object" && !Array.isArray((body as any).ai) &&
          (body as any).ai.effort != null;
        const out = await settings.put(body);
        gitSync.applySettings(); // autoSync / autoSyncSeconds / branch apply live
        /* LIVE-APPLY for the retention window. `trash.retentionDays()` is read
           fresh on every use, so the new value is already in force — but a
           SHORTENED window has to be acted on now rather than at the next
           hourly tick, or "keep for 1 day" would go on showing week-old entries
           until something else happened to sweep. Not awaited: a settings save
           must not wait on a git commit. */
        if (trash.retentionDays() !== retentionBefore) {
          sweepTrash("retention changed")
            /* A sweep that removed entries already announced its final list.
               With nothing expired, still announce so every client updates
               the retention label and each entry's recalculated purgeAt. */
            .then((purged) => (purged.length ? undefined : announceTrash()))
            .catch(() => {});
        }
        const after = endpoint();
        /* Capability probe at settings-save (research §7). Deliberately NOT
           awaited: it talks to a third-party endpoint over the network, and a
           settings save must not hang on one. The result lands in sqlite and
           surfaces in `meta.ai.probe` on the next GET.

           Gated on the endpoint TRIPLE because only those three can change what
           the endpoint is capable of — re-probing on every keystroke-sized
           settings save would put a network round-trip behind a theme switch. */
        if (before !== after) ai.onSettingsSaved().catch(() => {});
        /* …but the ladder is wider than the probe. `ai.effort` is settable
           without touching the endpoint, and the degradation walk downgrades it
           BEHIND the configured value — so re-picking an effort has to reset
           that walk, or Settings › AI paints the chosen value while the
           statusbar chip and every upstream body still carry the old one, with
           no way back. onSettingsSaved() already covers this for a triple
           change; this is the same reset without the network round-trip. */
        else if (picksEffort) ai.onEffortChanged();
        /* The derived STATUS is wider still — it carries the model too.
           Announcing unconditionally is free: `announce()` is itself the "only
           when it changed" mechanism, keyed on the whole verdict. */
        ai.announce();
        /* SETTINGS ARE VAULT STATE, AND THEY MOVE BETWEEN CLIENTS LIKE IT.
           `GET /api/settings` was read at boot and after a terminal-password
           write, and nowhere else — so a second tab (a phone left open, a
           desktop from this morning) went on painting and ENFORCING the old
           theme, home doc, autosave interval and lock policy for as long as it
           stayed open, with nothing anywhere saying it was stale.

           `out` is `settings.get()`: exactly the body GET serves, with the git
           token and the AI key already reduced to their `…Masked` prefixes and
           the terminal password reduced to a boolean. There is no credential in
           this frame, which is what makes it safe on a stream that is not
           behind the terminal password. */
        broadcast("settings-changed", out);
        /* settings.toml is a COMMITTED file, and `applySettings` above only
           schedules when auto-sync was just switched on — so on a repo whose
           auto-sync was already on, every settings save left the file dirty
           with no commit until some unrelated edit swept it up. MEASURED on a
           throwaway clone: minutes of "1 pending", cleared only by appending a
           line to a note. A write to a tracked file schedules its own sync,
           like every other write in this server does. */
        gitSync.schedule();
        return json(out);
      } catch (err) {
        if (err instanceof SettingsError) return fail(err.status, err.code, { message: err.message });
        throw err;
      }
    }
    return fail(405, "method-not-allowed", { message: `${method} /api/settings` });
  }

  /* ---------- sync ---------- */

  if (rest === "sync/status") {
    if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/sync/status` });
    return json(await gitSync.status());
  }

  /* Manual "Sync now": the same add → commit → push pipeline the debounce
     runs, started immediately and awaited so the caller gets the outcome. The
     single-flight scheduler means a click during an auto-sync joins that run
     and queues one more instead of racing it. */
  if (rest === "sync/now") {
    if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/sync/now` });
    return json(await gitSync.trigger("manual"));
  }

  /* ---------- terminal (SPEC §13) ----------

     Every route below is under /api, so the `crossSiteWrite` guard at the top
     of `fetch` already refuses a cross-site POST to any of them before this
     router is reached — the unlock, the exec, the stdin write, the cancel, the
     approval and the password change alike. That is deliberate belt-and-braces
     next to the bearer token: the token is the authorisation, the guard is what
     stops another origin from ever getting a request here at all.

     `GET /api/terminal/status` is the only route that answers without one, and
     it answers with capability, never content: enabled/configured/unlocked, the
     cwd, the shell, the bounds. Nothing it returns is a secret and nothing in
     it depends on the password being right. */

  if (rest === "terminal" || rest.startsWith("terminal/")) {
    const token = bearerOf(req);
    try {
      if (rest === "terminal/status") {
        if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/status` });
        return json(terminal.status(token, caller));
      }

      if (rest === "terminal/unlock") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/unlock` });
        const out = terminal.unlock(body?.password, caller);
        return json({ ...out, status: terminal.status(out.token, caller) });
      }

      if (rest === "terminal/lock") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/lock` });
        terminal.lock(token);
        return json(terminal.status(null, caller));
      }

      /* Setting the FIRST password needs no proof (there is nothing to prove
         against, and SPEC §10 puts the perimeter at the network); changing an
         existing one needs the current password or a live session — see
         Terminal.setPassword. */
      if (rest === "terminal/password") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/password` });
        const out = terminal.setPassword(body?.password, body?.current, token, caller);
        // the new password never comes back, not even masked: only whether one exists
        return json({ ...out, status: terminal.status(token, caller) });
      }

      if (rest === "terminal/exec") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/exec` });
        return terminal.exec(token, body?.command);
      }

      if (rest === "terminal/stdin") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/stdin` });
        return json(
          await terminal.writeStdin(token, body?.data, body?.eof === true, typeof body?.id === "string" ? body.id : null)
        );
      }

      if (rest === "terminal/cancel") {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/cancel` });
        return json(await terminal.cancel(token, typeof body?.id === "string" ? body.id : undefined));
      }

      if (rest === "terminal/commands") {
        if (method !== "GET") return fail(405, "method-not-allowed", { message: `${method} /api/terminal/commands` });
        const asked = parseInt(url.searchParams.get("limit") || "30", 10);
        return json({ commands: terminal.list(token, Number.isFinite(asked) ? asked : 30) });
      }

      const cmdAction = /^terminal\/commands\/([^/]+)\/(run|reject)$/.exec(rest);
      if (cmdAction) {
        if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/${rest}` });
        let id: string;
        try {
          id = decodeURIComponent(cmdAction[1]);
        } catch {
          return fail(400, "bad-id", { message: "Malformed command id." });
        }
        if (cmdAction[2] === "run") return terminal.runQueued(token, id);
        return json({ command: terminal.reject(token, id) });
      }
    } catch (err) {
      if (err instanceof TerminalError) return fail(err.status, err.code, { message: err.message, ...err.extra });
      throw err;
    }
    return fail(404, "no-route", { message: `${method} ${url.pathname} is not part of the v0 contract.` });
  }

  /* ---------- ai ---------- */

  if (rest === "ai/sessions/current" && method === "GET") return json(ai.sessionOut());

  /* GET  → the derived endpoint status, cheap, no network (what the statusbar
            paints on load).
     POST → re-run the capability probe NOW and answer with the result (what
            clicking the statusbar item does). Awaited, because the click is a
            question the user is waiting for an answer to — unlike the boot and
            settings-save probes, which must not block anything. */
  if (rest === "ai/status") {
    if (method === "GET") return json({ status: ai.status(), ai: ai.metaAi() });
    if (method === "POST") {
      await ai.probe().catch(() => {});
      return json({ status: ai.status(), ai: ai.metaAi() });
    }
    return fail(405, "method-not-allowed", { message: `${method} /api/ai/status` });
  }

  /* A new session drops the THREAD, never the change stack (API.md): the docs
     the assistant already edited are history the user still has to be able to
     unwind. */
  if (rest === "ai/sessions" && method === "POST") return json(ai.newSession(), 201);

  /* SPEC §3 delta 4: this STREAMS. The response is text/event-stream carrying
     normalized app events (research §3.2) and its final `done` event carries
     exactly the JSON the non-streaming contract returned, so the client's
     completion path is unchanged. */
  if (rest === "ai/messages" && method === "POST") {
    const content = String(body?.content ?? "").trim();
    if (!content) return fail(400, "empty-message", { message: "content is required." });
    return ai.handleMessage(content, body?.docPath);
  }

  if (rest === "ai/proposals" && method === "GET") return json(ai.listProposals());

  const propAction = /^ai\/proposals\/([^/]+)\/(accept|revert|reject)$/.exec(rest);
  if (propAction) {
    if (method !== "POST") return fail(405, "method-not-allowed", { message: `${method} /api/${rest}` });
    let id: string;
    try {
      id = decodeURIComponent(propAction[1]);
    } catch {
      return fail(400, "bad-id", { message: "Malformed proposal id." });
    }
    const action = propAction[2];
    const out =
      action === "accept" ? await ai.accept(id) : action === "revert" ? await ai.revert(id) : ai.reject(id);
    return json(out.body, out.status);
  }

  return fail(404, "no-route", { message: `${method} ${url.pathname} is not part of the v0 contract.` });
}

/* ============================================================
   Server
   ============================================================ */

// full index pass before the first request, then the doorbell goes live
await recon.reconcile();
recon.start();

// the crypto worker's only dependency, bundled once (never written to disk)
await buildVendor();

/* Retention sweep at boot, BEFORE the port opens: a server that was off for a
   month must not serve a trash listing full of entries it is about to delete.
   Never fatal — a trash that cannot be swept is not a reason to refuse to boot. */
await sweepTrash("at boot").catch((err) =>
  process.stderr.write(`[z-notes] trash sweep at boot failed: ${String(err)}\n`)
);
const trashSweep = setInterval(() => {
  sweepTrash("on schedule").catch(() => {});
}, TRASH_SWEEP_MS);
(trashSweep as any)?.unref?.();

/* One read-only git observation before the first request so the statusbar tells
   the truth from the start. It never mutates and never git-inits: a vault that
   is not a repository simply reports `offline`, and everything else works. */
await gitSync.start().catch(() => {});

/* The same courtesy for the AI endpoint, and for the same reason: the statusbar
   must tell the truth from the start. Deliberately NOT awaited — it talks to a
   third-party endpoint over the network and boot must not hang on one, exactly
   as at settings-save. The result lands in sqlite and is pushed as `ai-status`.

   Before this, the capability probe ran ONLY when PUT /api/settings changed the
   base URL, model or key — so a vault configured the intended way (a
   hand-written `settings.toml` whose credential `settings.load()` absorbs at
   boot) never probed at all and `meta.ai.probe` stayed null forever. */
ai.probeAtBoot();

/* declared before `Bun.serve` so `/healthz` can never touch it in the temporal
   dead zone — the listener is live for the rest of this module's evaluation */
let closing = false;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE dies at 10s otherwise (verified — ticket 8)
  development: false,
  /* Hard ceiling under Bun's 128 MiB default, with slack over MAX_BODY_BYTES so
     an oversized body still gets the named 413 from readJsonBody rather than a
     bare connection refusal. */
  maxRequestBodySize: MAX_BODY_BYTES + 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url);
    /* GET /healthz — kubelet probe target (SPEC §10 packaging).

       Deliberately the cheapest possible route: it touches no disk, does not
       scan the vault, does not query sqlite and does not shell out to git, so
       a probe every few seconds costs nothing and can never be the thing that
       wedges under load. It answers exactly one question — "is this process
       still accepting and serving HTTP?" — which is the only question a
       liveness probe should ask.

       It doubles as readiness because of where the listener starts: `Bun.serve`
       is called AFTER the boot-time `recon.reconcile()`, `buildVendor()` and
       `gitSync.start()` have all awaited, so the port does not exist until the
       index is warm. Anything that answers here is genuinely ready.

       `closing` flips first thing in `shutdown()`, so the window between
       SIGTERM and the socket actually closing reports 503 and the endpoints
       controller can pull the pod out of the Service before the last
       in-flight request drains. */
    if (url.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD")
        return fail(405, "method-not-allowed", { message: `${req.method} /healthz` });
      const status = closing ? 503 : 200;
      const body = JSON.stringify({ status: closing ? "shutting-down" : "ok" });
      return new Response(req.method === "HEAD" ? null : body, { status, headers: JSON_HEADERS });
    }
    if (url.pathname === "/events") {
      if (req.method !== "GET") return fail(405, "method-not-allowed", { message: `${req.method} /events` });
      srv.timeout(req, 0);
      return openStream();
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (crossSiteWrite(req, url))
        return fail(403, "cross-site", { message: "Cross-site writes are refused." });
      /* A model turn is quiet for long stretches (reasoning produces no bytes)
         and Bun counts a quiet response as idle. idleTimeout:0 covers it, and
         this covers a future build that sets one (research §3.3). */
      if (url.pathname === "/api/ai/messages") srv.timeout(req, 0);
      /* A command is quiet for long stretches too (a `git push`, a build), and
         Bun counts a quiet response as idle — the same reason the AI turn is
         exempted. `/api/terminal/exec` and the approved-command run both
         stream for as long as the command takes. */
      if (url.pathname === "/api/terminal/exec" || /^\/api\/terminal\/commands\/[^/]+\/run$/.test(url.pathname))
        srv.timeout(req, 0);
      /* The caller's address, for the unlock backoff and nothing else: the
         limiter is per caller so one peer's failed guesses cannot lock the
         owner out (terminal.ts). `requestIP` is Bun's own socket peer — never a
         header, which a client could forge. */
      return api(req, url, srv.requestIP(req)?.address ?? null);
    }
    if (url.pathname.startsWith("/vendor/")) {
      if (req.method !== "GET" && req.method !== "HEAD")
        return fail(405, "method-not-allowed", { message: `${req.method} ${url.pathname}` });
      return serveVendor(url.pathname, req);
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return fail(405, "method-not-allowed", { message: `${req.method} ${url.pathname}` });
    /* `/d/<vault path>` is the frontend's routing space, never a file: the app
       owns one URL per open doc so a doc can be linked, refreshed and walked
       back to. It answers with the SPA shell — the same `index.html` bytes and
       the same ETag as `/`, so nothing about asset caching changes — and the
       app reads the path back out of `location`. The prefix is what keeps it
       collision-free against `/api/*`, `/events`, `/vendor/*`, `/healthz` and
       every real file under app/ (`/app.js`, `/themes/*`). */
    if (url.pathname === "/d" || url.pathname.startsWith("/d/")) return serveStatic("/", req);
    /* `/settings` and `/settings/<section>` are the app's other routing space:
       Settings is a page, not a modal, so it has a real address that can be
       deep-linked, reloaded and walked back out of. Same SPA shell, same ETag.
       Note this is a FRONTEND route and has nothing to do with
       `/api/settings` — the API lives under `/api/*` and was matched above. */
    if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) return serveStatic("/", req);
    return serveStatic(url.pathname, req);
  },
  error(err) {
    // detail to stderr only: err.message carries absolute filesystem paths
    process.stderr.write(`[z-notes] ${String(err?.stack || err)}\n`);
    return fail(500, "server-fault", { message: "The server hit an unexpected error." });
  },
});

process.stdout.write(`z-notes listening on http://localhost:${server.port}\n`);

/* ---------- graceful shutdown ---------- */

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  clearInterval(trashSweep);
  for (const c of [...clients]) {
    try {
      c.controller.close();
    } catch {}
  }
  clients.clear();
  recon.stop();
  // cancels the pending debounce AND kills any git child still running, so a
  // SIGTERM never leaves an orphaned push holding the index lock
  gitSync.stop();
  // SIGKILL anything the terminal still has running and drop every session, so
  // a SIGTERM never leaves an orphaned command holding a pipe
  terminal.stop();
  server.stop(true);
  index.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
