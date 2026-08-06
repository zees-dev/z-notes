/* ============================================================
   watch.ts — doorbell → debounce → reconcile → SSE.

   fs.watch on macOS is a CONTENTLESS DOORBELL (verified, see
   docs/bun-capabilities.md §3): eventType is always "rename"
   and an intra-vault atomic save names only the temp file — the file that
   actually changed is never mentioned. So the callback arguments are never
   read. We debounce 120ms and re-derive truth from disk:

       Bun.Glob → stat → (size, mtimeMs) gate → read + hash → sqlite diff

   Server-initiated writes go through this exact same path (with a reason
   hint), so there is one code path that mutates the index and self-inflicted
   events are suppressed by content hash rather than echo-cancellation flags.
   ============================================================ */

import { watch, type FSWatcher } from "node:fs";
import type { type WatchIndex, FileRow } from "./db.ts";
import { byteLength,
  extractLinks,
  hasSecrets,
  hashOf,
  redact,
  revOf,
  slugOf,
  titleOf, type Vault } from "./vault.ts";

export type ChangeReason =
  | "write"
  | "created"
  | "external"
  | "proposal-accepted"
  | "proposal-reverted"
  /* phase 5 (SPEC §3 delta 2): a rename/move emits a PAIR of `moved` events —
     the old path with `removed:true` + `to`, the new path with `from`. A second
     client follows the doc it has open across the move from those two alone. */
  | "moved"
  | "deleted"
  /* phase 7 (trash): the doc came BACK, out of `.znotes/trash`. Distinct from
     `created` because a second client that painted it gone has a buffer to
     retarget rather than a new file to notice — and distinct from `moved`
     because there is no old path in the vault to pair it with. */
  | "restored";

/** A reason, or a reason plus where the doc came from / went to. */
export type ChangeHint =
  | ChangeReason
  | {
      reason: ChangeReason;
      from?: string;
      to?: string;
      /* the trash entry a `deleted` doc landed in / a `restored` doc came out
         of, so a client can offer Undo without correlating a second frame */
      trashId?: string;
    };

export type ChangeHints = Map<string, ChangeHint>;

export interface DocChange {
  path: string;
  rev: string;
  reason: ChangeReason;
  bytes: number;
  mtime: string;
  /** present (and true) only when the doc left the vault — see API.md § Events */
  removed?: true;
  /** on the NEW path of a move: where it came from */
  from?: string;
  /** on the OLD path of a move: where it went */
  to?: string;
  /** on `deleted` / `restored`: the `.znotes/trash` entry it went to / came from */
  trashId?: string;
}

const hintOf = (hints: ChangeHints | undefined, path: string) => {
  const h = hints?.get(path);
  if (!h) return null;
  return typeof h === "string" ? { reason: h } : h;
};

const DEBOUNCE_MS = 120;
/** Trailing debounce only, and a writer that never pauses (git pull, rsync,
    an editor on a 100ms autosave) starves the reconciler for as long as it
    keeps going. Staleness must be bounded by a constant, not by burst length. */
const MAX_WAIT_MS = 500;

export class Reconciler {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** when the oldest un-serviced doorbell rang (0 = none pending) */
  private firstRing = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly vault: Vault,
    private readonly index: WatchIndex,
    private readonly emit: (change: DocChange) => void
  ) {}

  /** Serialise every mutation + reconcile so passes cannot interleave. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  start() {
    if (this.watcher) return;
    try {
      // ONE recursive watcher on the root (macOS caps watched paths near 4096)
      this.watcher = watch(this.vault.root, { recursive: true }, () => this.ring());
      this.watcher.on("error", () => {});
    } catch (err) {
      process.stderr.write(`[z-notes] fs.watch unavailable: ${String(err)}\n`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.firstRing = 0;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  /** The doorbell. Arguments are deliberately ignored — they are unreliable. */
  private ring() {
    if (this.stopped) return;
    const now = Date.now();
    if (this.firstRing === 0) this.firstRing = now;
    if (this.timer) clearTimeout(this.timer);
    // debounce, but never postpone a pending pass past MAX_WAIT_MS
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstRing + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.firstRing = 0;
      this.lock(() => this.pass()).catch((err) =>
        process.stderr.write(`[z-notes] reconcile failed: ${String(err)}\n`)
      );
    }, wait);
  }

  /** Reconcile now, holding the lock. Hints label server-initiated writes. */
  reconcile(hints?: ChangeHints): Promise<DocChange[]> {
    return this.lock(() => this.pass(hints));
  }

  /** Reconcile without taking the lock — for callers already inside lock(). */
  reconcileHeld(hints?: ChangeHints): Promise<DocChange[]> {
    return this.pass(hints);
  }

  private async pass(hints?: ChangeHints): Promise<DocChange[]> {
    const onDisk = await this.vault.scanDocs();
    const rows = new Map(this.index.allFileMeta().map((r) => [r.path, r]));
    /* Two lists, not one: API.md § Events is normative about the ORDER of a
       `moved` pair — the old path (`removed:true` + `to`) first, THEN the new
       path (`from`) — and the on-disk walk below naturally produces the new
       half first. A client written against the doc must not have to guess. */
    const departed: DocChange[] = [];
    const present: DocChange[] = [];

    for (const path of onDisk) {
      const prev = rows.get(path);
      rows.delete(path);
      /* stat FIRST, read second — the order the header and SPEC §2 promise.
         The gate exists so an unchanged doc costs a stat and nothing else;
         reading before it pulled the whole corpus through JS on every pass,
         under the reconcile lock every write awaits. */
      const st = await this.vault.statDoc(path);
      if (!st) continue; // vanished between scan and stat
      // cheap gate: identical (size, mtimeMs) ⇒ nothing to hash
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && !hints?.has(path)) continue;

      const doc = await this.vault.readDoc(path);
      if (!doc) continue; // vanished between stat and read

      const rev = revOf(doc.markdown);
      if (prev && prev.rev === rev) {
        // identical bytes: refresh the stat gate, emit nothing
        this.touchStat(path, doc.size, doc.mtimeMs);
        continue;
      }

      const body = redact(doc.markdown);
      const row: FileRow = {
        path,
        rev,
        hash: hashOf(doc.markdown),
        size: doc.size,
        mtimeMs: doc.mtimeMs,
        title: titleOf(doc.markdown, path.split("/").pop()!),
        slug: slugOf(path),
        hasSecrets: hasSecrets(doc.markdown) ? 1 : 0,
        empty: doc.markdown.trim() ? 0 : 1,
        body,
      };
      this.index.upsertFile(row, extractLinks(body));
      const hint = hintOf(hints, path);
      present.push({
        path,
        rev,
        reason: hint?.reason ?? (prev ? "external" : "created"),
        bytes: byteLength(doc.markdown),
        mtime: new Date(doc.mtimeMs).toISOString(),
        ...(hint?.from ? { from: hint.from } : {}),
        ...(hint?.trashId ? { trashId: hint.trashId } : {}),
      });
    }

    // anything left in `rows` is gone from disk. It is announced too: without
    // an event the client's tree keeps a ghost row (and an open editor a buffer
    // it can no longer save) until a full reload.
    for (const [path, prev] of rows) {
      this.index.removeFile(path);
      const hint = hintOf(hints, path);
      departed.push({
        path,
        rev: prev.rev,
        // honour the caller's hint here too: reverting an op:create REMOVES the
        // doc it made, so hardcoding "external" told the user their file had
        // been deleted on disk one click after they pressed Revert
        reason: hint?.reason ?? "external",
        bytes: 0,
        mtime: new Date().toISOString(),
        removed: true,
        ...(hint?.to ? { to: hint.to } : {}),
        ...(hint?.trashId ? { trashId: hint.trashId } : {}),
      });
    }

    const changes = [...departed, ...present];
    for (const c of changes) this.emit(c);
    return changes;
  }

  private touchStat(path: string, size: number, mtimeMs: number) {
    this.index.db
      .query("UPDATE files SET size = $size, mtimeMs = $mtimeMs WHERE path = $path")
      .run({ path, size, mtimeMs });
  }
}
