/* ============================================================
   trash.ts — the recoverable delete (SPEC §5, phase 7).

   `DELETE /api/docs/{path}` does not unlink any more: it MOVES the doc (or the
   whole folder subtree) into `.znotes/trash/<id>/`, where it is invisible to
   the vault scan, to search and to the backlink graph by construction —
   `scanDocs`/`scanFolders` skip every dot-directory and `absOf` refuses to
   resolve anything under `.znotes` at all. Nothing about the trash can appear
   in the tree, in `/api/search`, in sqlite or in an AI context.

   ON-DISK LAYOUT — one directory per trashed entry:

       .znotes/trash/
         m7k2x9-4f1a8b3c/
           meta.json                  ← what it was, where it came from, when
           files/projects/homelab.md  ← the BYTES, at their original path

   Three properties this shape buys, each of which was a requirement:

     1. SELF-DESCRIBING ON DISK. sqlite is a disposable cache (db.ts: a corrupt
        index is deleted and rebuilt from the markdown), so trash metadata that
        lived only in sqlite would be destroyed by an index rebuild while the
        bytes sat there unreachable. `meta.json` is the record; sqlite holds
        nothing about the trash at all.
     2. BYTE-FAITHFUL BY CONSTRUCTION. Both directions are ONE `rename(2)` —
        the bytes are never read, re-encoded or re-written, so a doc carrying an
        age block keeps its armor byte-identical through delete → restore, for
        exactly the same reason `moveNode` does.
     3. THE ORIGINAL PATH IS VISIBLE WITHOUT PARSING ANYTHING. `files/` mirrors
        the vault-relative path, so `ls -R .znotes/trash` tells a human what a
        given entry was and where it belongs even with no app running.

   The alternative — one flat blob per entry plus a sidecar index — was rejected
   on (3): a recovery path you can only walk with the app that broke is not a
   recovery path.

   RETENTION. `trash.retentionDays` (default 7, minimum 1) is how long an entry
   survives. Zero is DISALLOWED rather than meaning "purge immediately": it goes
   through the same `NUMBERS` bounds every other numeric setting does, so a PUT
   of 0 is `400 bad-number` and a hand-written `retentionDays = 0` heals to the
   default. "Purge immediately" would turn one mistyped character into a trash
   that silently never retains anything, which is the failure this whole feature
   exists to prevent.

   GIT. `.znotes/trash/` IS COMMITTED — see git.ts `TRACKED_META_DIRS` and the
   report in the delete route. Short version: after a delete the trash holds the
   ONLY live copy of the bytes, so a trash that is not committed means a delete
   on the phone is unrecoverable from the laptop.
   ============================================================ */

import { dirname, resolve } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { absOf, exists, safePath, znotesDir } from "./vault.ts";

/** Vault-relative, POSIX, for git pathspecs and log lines. */
export const TRASH_REL = ".znotes/trash";

export const trashDir = (vault: string) => resolve(znotesDir(vault), "trash");

/**
 * Entry ids are minted here and never accepted from a client unchecked: the id
 * becomes a path segment under `.znotes/`, where `absOf`'s containment check
 * deliberately refuses to help. Lowercase base36 and one dash, nothing else —
 * no `.`, no `/`, no `..`, so `trashEntryDir` cannot be walked out of.
 */
const ID_RE = /^[0-9a-z]{4,16}-[0-9a-z]{4,16}$/;

export const isTrashId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
}

/** Absolute directory for an entry, or null if the id is not one we minted. */
export function trashEntryDir(vault: string, id: string): string | null {
  if (!isTrashId(id)) return null;
  return resolve(trashDir(vault), id);
}

/* ---------- the on-disk record ---------- */

export interface TrashMeta {
  /** schema of this file; bumped only if the layout changes incompatibly */
  v: 1;
  id: string;
  /** where it came from, vault-relative — where Restore puts it back */
  path: string;
  kind: "doc" | "folder";
  deletedAt: string;
  /** total bytes of everything moved */
  bytes: number;
  /** the `.md` docs that left the vault (what the SSE hints and git need) */
  docs: string[];
  /** EVERY file moved, `.md` or not — a folder carries its images along */
  files: string[];
}

/** A `TrashMeta` plus everything derived from the live vault + settings. */
export interface TrashEntry {
  id: string;
  path: string;
  name: string;
  kind: "doc" | "folder";
  deletedAt: string;
  bytes: number;
  docCount: number;
  fileCount: number;
  /** when the retention sweep will remove it (deletedAt + retentionDays) */
  purgeAt: string;
  /** already past `purgeAt` — the next sweep takes it */
  expired: boolean;
  /** the payload is really on disk (false ⇒ a crashed or half-synced entry) */
  complete: boolean;
  /** nothing occupies the original path and the payload is there */
  restorable: boolean;
  /** what is in the way, when `restorable` is false */
  blockedBy: string | null;
}

export class TrashError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/* ---------- small disk helpers ----------
   These deliberately do NOT go through `absOf`/`scanTree`: those refuse
   `.znotes` on purpose, which is the property that keeps the trash out of the
   tree. Everything below is confined by construction instead — the entry dir
   comes from a validated id, and every relative path inside it came out of
   `safePath`. */

async function walkFiles(root: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rel ? resolve(root, rel) : root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(root, p)));
    else out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Every file under `.znotes/trash`, vault-relative — what git.ts's bulk
 * `stage()` adds. A free function rather than a method because git.ts is
 * constructed from a settings-shaped dependency object and has no `Trash`.
 */
export async function trashGitPaths(vault: string): Promise<string[]> {
  return (await walkFiles(trashDir(vault))).map((p) => `${TRASH_REL}/${p}`);
}

async function sizeOf(abs: string): Promise<number> {
  try {
    return (await Bun.file(abs).stat()).size;
  } catch {
    return 0;
  }
}

/** Is `value` a usable meta record? A file we cannot trust is not one. */
function parseMeta(id: string, raw: unknown): TrashMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const path = typeof m.path === "string" ? safePath(m.path) : null;
  if (!path) return null;
  const kind = m.kind === "folder" ? "folder" : m.kind === "doc" ? "doc" : null;
  if (!kind) return null;
  const deletedAt = typeof m.deletedAt === "string" && !Number.isNaN(Date.parse(m.deletedAt)) ? m.deletedAt : null;
  if (!deletedAt) return null;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string" && safePath(x)) as string[]) : [];
  return {
    v: 1,
    id,
    path,
    kind,
    deletedAt,
    bytes: Number.isFinite(Number(m.bytes)) ? Number(m.bytes) : 0,
    docs: list(m.docs),
    files: list(m.files),
  };
}

/* ============================================================
   Trash
   ============================================================ */

export interface TrashDeps {
  vault: string;
  settings: { value<T>(path: string, fallback: T): T };
  log?: (line: string) => void;
}

export const DEFAULT_RETENTION_DAYS = 7;

export class Trash {
  private readonly vault: string;

  constructor(private readonly deps: TrashDeps) {
    this.vault = resolve(deps.vault);
  }

  /** Live, never cached: the setting is editable in Settings and in the file. */
  retentionDays(): number {
    const raw = Number(this.deps.settings.value<number>("trash.retentionDays", DEFAULT_RETENTION_DAYS));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_DAYS;
    return Math.min(365, Math.max(1, Math.round(raw)));
  }

  private log(line: string) {
    this.deps.log?.(line);
  }

  /* ---------- git pathspecs ---------- */

  /** Vault-relative paths of everything an entry owns, for a commit pathspec. */
  entryGitPaths(id: string, meta: TrashMeta | null): string[] {
    const base = `${TRASH_REL}/${id}`;
    if (!meta) return [`${base}/meta.json`];
    return [`${base}/meta.json`, ...meta.files.map((f) => `${base}/files/${f}`)];
  }

  /**
   * Every file under `.znotes/trash`, vault-relative — what the bulk `stage()`
   * in git.ts adds so an entry created out of band (a pull, a crash between the
   * move and the commit) still reaches the remote.
   */
  gitPaths(): Promise<string[]> {
    return trashGitPaths(this.vault);
  }

  /* ---------- read ---------- */

  private async readMeta(id: string): Promise<TrashMeta | null> {
    const dir = trashEntryDir(this.vault, id);
    if (!dir) return null;
    try {
      return parseMeta(id, JSON.parse(await Bun.file(resolve(dir, "meta.json")).text()));
    } catch {
      return null;
    }
  }

  /** The ids on disk, newest-looking first is decided by `list()`, not here. */
  private async ids(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(trashDir(this.vault), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && isTrashId(e.name)).map((e) => e.name);
  }

  /** One entry, with everything derived. Null when the id names nothing usable. */
  async entry(id: string): Promise<{ meta: TrashMeta; out: TrashEntry } | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    return { meta, out: await this.decorate(meta) };
  }

  private async decorate(meta: TrashMeta): Promise<TrashEntry> {
    const dir = trashEntryDir(this.vault, meta.id)!;
    const payload = resolve(dir, "files", meta.path);
    const complete = await Bun.file(payload)
      .stat()
      .then(() => true)
      .catch(() => false);
    const blockedBy = await this.blocker(meta.path);
    const purgeAt = new Date(Date.parse(meta.deletedAt) + this.retentionDays() * DAY_MS).toISOString();
    return {
      id: meta.id,
      path: meta.path,
      name: meta.path.split("/").pop()!,
      kind: meta.kind,
      deletedAt: meta.deletedAt,
      bytes: meta.bytes,
      docCount: meta.docs.length,
      fileCount: meta.files.length,
      purgeAt,
      expired: Date.parse(purgeAt) <= Date.now(),
      complete,
      restorable: complete && !blockedBy,
      blockedBy,
    };
  }

  /**
   * What stands between this entry and its original path: the path itself if
   * something is there now, or the ancestor segment that is a FILE rather than
   * a folder (`mkdir -p` through a file throws ENOTDIR, and naming the real
   * problem beats surfacing an errno). Null when the way is clear.
   */
  private async blocker(path: string): Promise<string | null> {
    if (await exists(this.vault, path)) return path;
    const segs = path.split("/");
    let acc = "";
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? acc + "/" + segs[i] : segs[i];
      if ((await exists(this.vault, acc)) === "file") return acc;
    }
    return null;
  }

  /** Every entry, newest deletion first — the order the panel shows them in. */
  async list(): Promise<TrashEntry[]> {
    const out: TrashEntry[] = [];
    for (const id of await this.ids()) {
      const meta = await this.readMeta(id);
      if (!meta) continue; // unreadable record: `sweep()` is what clears it
      out.push(await this.decorate(meta));
    }
    out.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || a.id.localeCompare(b.id));
    return out;
  }

  /** What `GET /api/trash` and the `trash-changed` frame both carry. */
  async view(): Promise<{ retentionDays: number; entries: TrashEntry[] }> {
    return { retentionDays: this.retentionDays(), entries: await this.list() };
  }

  /* ---------- write ---------- */

  /**
   * Move `rel` (a doc, or a folder and everything under it) into the trash.
   *
   * ORDER IS LOAD-BEARING: `meta.json` is written BEFORE the payload moves. A
   * crash between the two leaves an entry whose record points at a payload that
   * is not there — and the doc still live in the vault, which is the safe
   * direction to be interrupted in. The opposite order would leave the bytes in
   * the trash with nothing on disk saying where they belong.
   *
   * @param files every file the move carries, vault-relative (`.md` or not)
   */
  async put(rel: string, kind: "doc" | "folder", files: string[]): Promise<TrashMeta> {
    const src = absOf(this.vault, rel);
    if (!src) throw new TrashError("bad-path", `${rel} is not a vault path.`, 400);
    const id = newId();
    const dir = trashEntryDir(this.vault, id)!;

    let bytes = 0;
    for (const f of files) {
      const abs = absOf(this.vault, f);
      if (abs) bytes += await sizeOf(abs);
    }

    const meta: TrashMeta = {
      v: 1,
      id,
      path: rel,
      kind,
      deletedAt: new Date().toISOString(),
      bytes,
      docs: files.filter((f) => /\.md$/i.test(f)).sort(),
      files: [...files].sort(),
    };

    await mkdir(dir, { recursive: true });
    await Bun.write(resolve(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    const dest = resolve(dir, "files", rel);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(src, dest);
    } catch (err) {
      // nothing left the vault; take the half-built entry with us
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    this.log(`trash: ${rel} → ${TRASH_REL}/${id} (${bytes} bytes)`);
    return meta;
  }

  /**
   * Put an entry back where it came from, recreating any folder hierarchy that
   * was deleted in the meantime.
   *
   * REFUSES rather than clobbers. A live doc is never overwritten by a trashed
   * one — if the path is taken (or an ancestor is now a file) the caller gets a
   * typed 409 and the trash is untouched, so the user can rename the occupant
   * and try again with nothing lost either way.
   */
  async restore(id: string): Promise<{ meta: TrashMeta; entryPaths: string[] }> {
    const found = await this.entry(id);
    if (!found) throw new TrashError("not-found", `No trash entry ${id}.`, 404);
    const { meta } = found;
    const dir = trashEntryDir(this.vault, id)!;
    const payload = resolve(dir, "files", meta.path);
    if (!(await Bun.file(payload).stat().then(() => true).catch(() => false))) {
      throw new TrashError(
        "trash-incomplete",
        `The bytes for ${meta.path} are not in the trash any more — this entry cannot be restored. The original text is in git history.`,
        409,
        { path: meta.path }
      );
    }
    const blocked = await this.blocker(meta.path);
    if (blocked) {
      throw new TrashError(
        "restore-blocked",
        blocked === meta.path
          ? `${meta.path} exists again — restoring would overwrite it. Rename or move it first.`
          : `${blocked} is a doc, not a folder, so ${meta.path} cannot be put back under it.`,
        409,
        { path: meta.path, blockedBy: blocked }
      );
    }

    const dest = absOf(this.vault, meta.path);
    if (!dest) throw new TrashError("bad-path", `${meta.path} is not a vault path any more.`, 400);
    // node returns the TOPMOST directory it had to create, which is exactly the
    // scaffolding to remove again if the rename then fails
    const created = (await mkdir(dirname(dest), { recursive: true })) ?? null;
    const entryPaths = this.entryGitPaths(id, meta);
    try {
      await rename(payload, dest);
    } catch (err) {
      if (created) await rm(created, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    this.log(`trash: restored ${TRASH_REL}/${id} → ${meta.path}`);
    return { meta, entryPaths };
  }

  /**
   * Permanently delete one entry. Returns the git pathspec for the files that
   * just stopped existing, so the caller can commit the removal.
   */
  async purgeEntry(id: string): Promise<{ meta: TrashMeta | null; entryPaths: string[] }> {
    const dir = trashEntryDir(this.vault, id);
    if (!dir) throw new TrashError("bad-id", "Malformed trash id.", 400);
    const meta = await this.readMeta(id);
    /* `meta.files` is the authority when the record is readable, but the dir is
       the authority on what actually exists — a partially-synced entry has
       files the record does not list and vice versa. Union of both, so the
       commit cannot leave a file deleted in the worktree and alive in HEAD. */
    const onDisk = (await walkFiles(dir)).map((p) => `${TRASH_REL}/${id}/${p}`);
    if (!meta && !onDisk.length) throw new TrashError("not-found", `No trash entry ${id}.`, 404);
    const entryPaths = [...new Set([...this.entryGitPaths(id, meta), ...onDisk])];
    await rm(dir, { recursive: true, force: true });
    this.log(`trash: purged ${TRASH_REL}/${id}${meta ? ` (${meta.path})` : ""}`);
    return { meta, entryPaths };
  }

  /**
   * The retention sweep: remove every entry whose `deletedAt` is older than
   * `trash.retentionDays`. Runs at boot, on an interval and after every delete
   * (API.md § Trash), and is what `POST /api/trash/purge` calls with no body.
   *
   * An entry whose `meta.json` is unreadable is swept on the SAME clock, using
   * the directory's mtime — it can never be restored, so leaving it forever
   * would make a crashed write permanent litter, but deleting it on sight would
   * throw away an entry that is merely mid-checkout.
   */
  async sweep(): Promise<{ purged: string[]; entryPaths: string[] }> {
    const cutoff = Date.now() - this.retentionDays() * DAY_MS;
    const purged: string[] = [];
    const entryPaths: string[] = [];
    for (const id of await this.ids()) {
      const meta = await this.readMeta(id);
      let at: number;
      if (meta) at = Date.parse(meta.deletedAt);
      else {
        const dir = trashEntryDir(this.vault, id)!;
        at = await Bun.file(resolve(dir, "meta.json"))
          .stat()
          .then((s) => s.mtimeMs)
          .catch(() => 0);
      }
      if (!(at <= cutoff)) continue;
      const r = await this.purgeEntry(id).catch(() => null);
      if (!r) continue;
      purged.push(id);
      entryPaths.push(...r.entryPaths);
    }
    return { purged, entryPaths };
  }

  /** Empty the trash outright — `POST /api/trash/purge {"all":true}`. */
  async purgeAll(): Promise<{ purged: string[]; entryPaths: string[] }> {
    const purged: string[] = [];
    const entryPaths: string[] = [];
    for (const id of await this.ids()) {
      const r = await this.purgeEntry(id).catch(() => null);
      if (!r) continue;
      purged.push(id);
      entryPaths.push(...r.entryPaths);
    }
    return { purged, entryPaths };
  }
}
