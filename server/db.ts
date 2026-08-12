/* ============================================================
   db.ts — bun:sqlite index, FTS5, backlinks, AI history, credentials.

   The database is a DISPOSABLE CACHE. Markdown on disk is the source of
   truth; deleting <vault>/.znotes/index.db loses nothing but credentials
   and AI history, both of which have no on-disk representation by design.

   Migrations are "rebuild": on schema_version mismatch every index table is
   dropped and rebuilt from disk (credentials are carried across best-effort).

   Sharp edges obeyed (docs/specs/done/0005-bun-platform-foundation.md):
     - one PRAGMA per call (multi-statement pragma strings return nothing)
     - WAL + synchronous=NORMAL + busy_timeout=5000
     - strict:true statements (no $/:/@ sigils, throws on missing params)
   ============================================================ */

import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 3;

/** What the age-fence body is replaced with in the search index. */
const AGE_PLACEHOLDER = "ageblock";

export interface FileRow {
  path: string;
  rev: string;
  hash: string;
  size: number;
  mtimeMs: number;
  title: string;
  slug: string;
  hasSecrets: number;
  empty: number;
  body: string;
}

/** A FileRow with the (potentially very large) `body` column left behind. */
type FileRowMeta = Omit<FileRow, "body">;

const META_COLUMNS = "path, rev, hash, size, mtimeMs, title, slug, hasSecrets, empty";

const INDEX_TABLES = ["files_fts", "files", "backlinks", "folders"];
const ALL_TABLES = [
  ...INDEX_TABLES,
  "ai_proposals",
  "ai_messages",
  "ai_sessions",
  "terminal_commands",
  "credentials",
  "meta",
];

function createSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS files (
    path       TEXT PRIMARY KEY,
    rev        TEXT NOT NULL,
    hash       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtimeMs    REAL NOT NULL,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL,
    hasSecrets INTEGER NOT NULL,
    empty      INTEGER NOT NULL,
    body       TEXT NOT NULL
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS backlinks (
    src TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (src, target)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS backlinks_target ON backlinks(target)`);
  db.run(`CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, open INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS credentials (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ai_sessions (
    id TEXT PRIMARY KEY, startedAt TEXT NOT NULL, contextDocPath TEXT, active INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, seq INTEGER NOT NULL,
    role TEXT NOT NULL, kind TEXT, content TEXT NOT NULL, proposalId TEXT, at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ai_messages_session ON ai_messages(sessionId, seq)`);
  /* AI proposals (SPEC §8, research §5 layer 1). `files` carries the pre- and
     post-images as JSON — the byte-exact undo that makes revert possible before
     any commit exists. `stackIndex` is the 1-based LIFO position while applied
     and NULL otherwise; the server, never the client, owns it. */
  db.run(`CREATE TABLE IF NOT EXISTS ai_proposals (
    id         TEXT PRIMARY KEY,
    sessionId  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    createdAt  TEXT NOT NULL,
    target     TEXT NOT NULL,
    label      TEXT NOT NULL,
    summary    TEXT NOT NULL,
    state      TEXT NOT NULL,
    stackIndex INTEGER,
    added      INTEGER NOT NULL,
    removed    INTEGER NOT NULL,
    diff       TEXT NOT NULL,
    edits      TEXT NOT NULL,
    files      TEXT NOT NULL,
    model      TEXT,
    effort     TEXT,
    commitSha  TEXT,
    commitNote TEXT,
    appliedAt  TEXT,
    revertedAt TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ai_proposals_stack ON ai_proposals(stackIndex)`);
  /* Terminal commands the ASSISTANT asked for (SPEC §13). Only AI-originated
     commands are recorded: what the user types into their own shell is theirs,
     is not replayed into a model context, and stays in the browser's scrollback
     where they can see it and nothing else can. `output` is the truncated
     transcript — the same text the assistant is later shown. */
  db.run(`CREATE TABLE IF NOT EXISTS terminal_commands (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    command    TEXT NOT NULL,
    why        TEXT,
    state      TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    exitCode   INTEGER,
    output     TEXT,
    truncated  INTEGER NOT NULL DEFAULT 0,
    sessionId  TEXT,
    messageId  TEXT,
    createdAt  TEXT NOT NULL,
    finishedAt TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS terminal_commands_created ON terminal_commands(createdAt)`);
  db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(SCHEMA_VERSION)]);
}

/** The glob shape a parked index takes. git.ts ignores exactly this. */
const CORRUPT_INDEX_SUFFIX = ".corrupt-";

/**
 * Move a corrupt index (and whatever sidecars exist) out of the way.
 *
 * Two details are load-bearing:
 *
 *   · each rename is wrapped on its OWN. `renameSync` has no `force` and throws
 *     ENOENT, and after a clean shutdown the -wal and -shm are simply absent —
 *     a naive loop would turn "we lost the credentials" into "the server will
 *     not boot", which is strictly worse than what this replaces.
 *   · the sidecars are named `<base>.corrupt-<ts>-wal`, with the suffix AFTER
 *     the timestamp, so the parked set is still a valid sqlite triple. The WAL
 *     can hold the most recent credential write, and `.recover` only finds it
 *     when it sits beside its database under the right name.
 *
 * @returns the parked main-file path, or null if there was nothing to park.
 */
function parkCorruptIndex(file: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parked = `${file}${CORRUPT_INDEX_SUFFIX}${stamp}`;
  let moved: string | null = null;
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      renameSync(file + ext, parked + ext);
      if (ext === "") moved = parked;
    } catch {
      /* absent (the usual case for the sidecars), or unmovable — either way the
         next open must still be allowed to happen. Only a file that is still
         THERE would block it, so that one is removed as the last resort. */
      try {
        rmSync(file + ext, { force: true });
      } catch {}
    }
  }
  return moved;
}

/* Per-consumer slices of Index. Each module is handed only the methods it
   owns — the type system now enforces what convention used to: ai.ts cannot
   reach the terminal command table, terminal.ts cannot reach the proposal
   stack, watch.ts sees only the file rows. (docs.ts and index.ts hold the
   full Index: the entrypoint wires it, the doc store spans files+folders.)

   The `meta` KV table is one namespace with agreed key ownership:
     vaultEpoch            index.ts   (bumped per doc change)
     git.*                 git.ts
     ai.*, msgSeq, propSeq ai.ts
     terminal.*            terminal.ts
   getMeta/setMeta appear in a slice only when that module owns keys. */

export type WatchIndex = Pick<Index, "allFileMeta" | "upsertFile" | "removeFile" | "touchFileStat">;
export type AiIndex = Pick<
  Index,
  | "getMeta" | "setMeta" | "nextSeq"
  | "file" | "allFiles" | "allFileMeta" | "ftsSnippets"
  | "activeSession" | "createSession" | "setSessionContext" | "messages" | "addMessage"
  | "addProposal" | "proposal" | "proposals" | "stack" | "updateProposal"
>;
export type TerminalIndex = Pick<
  Index,
  "getMeta" | "setMeta" | "addCommand" | "command" | "commands" | "updateCommand"
>;

export class Index {
  readonly db: Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    let opened: Database | null = null;
    try {
      /* MIGRATE INSIDE THE RECOVERY BLOCK, not after it. `Index.open` only
         probes `sqlite_schema`, which reads page 1 — corruption confined to a
         LATER page passes that probe and then throws out of `createSchema`
         inside `migrate()`, where nothing used to catch it. MEASURED: with 0x5a
         scribbled over page 2 of a real index.db (header and schema page
         intact) the server exited 1 with `database disk image is malformed` and
         NOTHING was parked — the boot failure the parking exists for was the
         one shape it did not catch. */
      opened = Index.open(file);
      this.db = opened;
      this.migrate(file);
    } catch (err) {
      /* The db is a disposable cache for everything that has an on-disk source:
         the tree, FTS, backlinks all rebuild from the markdown on the next
         reconcile pass. But FOUR things live here and NOWHERE else by design —
         the git token, the AI key, the terminal password hash and the whole
         ai_proposals undo stack. Deleting the file threw all four away for good,
         silently, at boot.

         So the file is PARKED rather than removed — the same shape vault.ts
         already uses for a replaced identity (`identity.age.prev`). MEASURED:
         with a zeroed header and with a truncated tail, `sqlite3 .recover` on a
         copy of the parked file returned the token, the key and the password
         hash verbatim. With the first pages overwritten by noise it returned
         nothing — parking is not a promise of recovery, it is the difference
         between a recovery that is merely hard and one that is impossible.
         Recovery is a manual, deliberate act either way; this branch only owes
         the user the chance to attempt it. */
      /* a handle that opened and then failed to migrate still holds the file
         (and its -wal); close it before the rename or the parked copy is the
         one the OS is still writing to */
      if (opened) {
        try {
          opened.close();
        } catch {}
      }
      const parked = parkCorruptIndex(file);
      process.stderr.write(
        `[z-notes] index.db unusable (${String((err as Error)?.message || err)}) — rebuilding from disk` +
          (parked
            ? `; the old file is parked at ${parked} (credentials and AI history are recoverable with \`sqlite3 ${parked} .recover\`)\n`
            : `\n`)
      );
      this.db = Index.open(file);
      this.migrate(file);
    }
  }

  private static open(file: string): Database {
    const db = new Database(file, { create: true, strict: true });
    try {
      // one pragma per call — multi-statement pragma strings misbehave
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run("PRAGMA busy_timeout = 5000");
      db.run("PRAGMA foreign_keys = ON");
      // touches the schema, so a file that is not a database fails HERE, where
      // the caller can still recover, rather than deep inside migrate()
      db.query("SELECT count(*) FROM sqlite_schema").get();
    } catch (err) {
      try {
        db.close();
      } catch {}
      throw err;
    }
    return db;
  }

  private migrate(file: string) {
    let version = 0;
    try {
      const row = this.db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      version = row ? Number(row.value) : 0;
    } catch {
      version = 0;
    }
    if (version === SCHEMA_VERSION) {
      createSchema(this.db); // idempotent; heals a partially created db
      return;
    }
    /* Migrations-by-rebuild: keep credentials, throw the rest away. But the
       proposals table is the whole revert/undo stack and the AI history, and
       both live here and NOWHERE else by design (see the recovery branch in
       the constructor) — so a NON-EMPTY old db is parked as a copy first,
       exactly like a corrupt one, rather than silently erased. `VACUUM INTO`
       gives a consistent copy through the open handle. A version-0 db is a
       fresh file; nothing to keep. */
    if (version > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const parked = `${file}.v${version}-${stamp}`;
      try {
        // VACUUM INTO refuses a bound parameter ("non-text filename") — the
        // target must be an SQL string literal. The path is ours, not input.
        this.db.run(`VACUUM INTO '${parked.replaceAll("'", "''")}'`);
        process.stderr.write(
          `[z-notes] index.db schema v${version} → v${SCHEMA_VERSION}: rebuilding; the old file is parked at ${parked} (AI history and the undo stack are recoverable from it)\n`
        );
      } catch (err) {
        process.stderr.write(
          `[z-notes] index.db schema v${version} → v${SCHEMA_VERSION}: rebuilding; parking a copy FAILED (${String((err as Error)?.message || err)}) — AI history and the undo stack will be lost\n`
        );
      }
    }
    let creds: { key: string; value: string; updatedAt: string }[] = [];
    try {
      creds = this.db.query<{ key: string; value: string; updatedAt: string }, []>("SELECT key, value, updatedAt FROM credentials").all();
    } catch {}
    for (const t of ALL_TABLES) {
      try {
        this.db.run(`DROP TABLE IF EXISTS ${t}`);
      } catch {}
    }
    createSchema(this.db);
    const ins = this.db.query("INSERT OR REPLACE INTO credentials (key, value, updatedAt) VALUES ($key, $value, $updatedAt)");
    for (const c of creds) ins.run(c);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  /* ---------- meta ---------- */

  getMeta(key: string): string | null {
    const r = this.db.query<{ value: string }, { key: string }>("SELECT value FROM meta WHERE key = $key").get({ key });
    return r ? r.value : null;
  }

  setMeta(key: string, value: string) {
    this.db
      .query("INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run({ key, value });
  }

  nextSeq(key: string): number {
    const cur = Number(this.getMeta(key) || "0") + 1;
    this.setMeta(key, String(cur));
    return cur;
  }

  /* ---------- files ---------- */

  /** Every row INCLUDING `body` — only for callers that actually read text. */
  allFiles(): FileRow[] {
    return this.db.query<FileRow, []>("SELECT * FROM files ORDER BY path").all();
  }

  /**
   * The same rows without `body`. Most callers (the sidebar tree, path
   * canonicalisation, link resolution, the reconcile pass) never look at the
   * text, and `SELECT *` made every one of them allocate and discard the whole
   * vault — on every SSE-driven tree refresh and every 404.
   */
  /** GET /api/search: fuzzy over paths + redacted bodies (top 2 hit lines per doc). */
  search(q: string, limit: number): SearchHit[] {
    const out: SearchHit[] = [];
    for (const row of this.allFiles()) {
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

  /**
   * FTS5 hits for an ALREADY-SANITIZED MATCH expression, one snippet per doc —
   * ai.ts's context assembly (research §6.2). Raw user text is not a valid
   * expression; building one is the caller's job, and so is deciding what an
   * expression FTS5 refuses to parse costs, because this throws.
   */
  ftsSnippets(expr: string, limit: number): Array<{ path: string; snip: string }> {
    return this.db
      .query<{ path: string; snip: string }, { expr: string; limit: number }>(
        `SELECT path, snippet(files_fts, 1, '', '', '…', 14) AS snip
           FROM files_fts WHERE files_fts MATCH $expr ORDER BY rank LIMIT $limit`
      )
      .all({ expr, limit });
  }

  allFileMeta(): FileRowMeta[] {
    return this.db.query<FileRowMeta, []>(`SELECT ${META_COLUMNS} FROM files ORDER BY path`).all();
  }

  file(path: string): FileRow | null {
    return this.db.query<FileRow, { path: string }>("SELECT * FROM files WHERE path = $path").get({ path });
  }

  upsertFile(row: FileRow, links: string[]) {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO files (path, rev, hash, size, mtimeMs, title, slug, hasSecrets, empty, body)
           VALUES ($path, $rev, $hash, $size, $mtimeMs, $title, $slug, $hasSecrets, $empty, $body)
           ON CONFLICT(path) DO UPDATE SET
             rev = excluded.rev, hash = excluded.hash, size = excluded.size, mtimeMs = excluded.mtimeMs,
             title = excluded.title, slug = excluded.slug, hasSecrets = excluded.hasSecrets,
             empty = excluded.empty, body = excluded.body`
        )
        .run(row as unknown as Record<string, string | number>);
      this.db.query("DELETE FROM files_fts WHERE path = $path").run({ path: row.path });
      const ftsBody = row.hasSecrets ? row.body + "\n" + AGE_PLACEHOLDER : row.body;
      this.db.query("INSERT INTO files_fts (path, body) VALUES ($path, $body)").run({ path: row.path, body: ftsBody });
      this.db.query("DELETE FROM backlinks WHERE src = $src").run({ src: row.path });
      const ins = this.db.query("INSERT OR IGNORE INTO backlinks (src, target) VALUES ($src, $target)");
      for (const target of links) ins.run({ src: row.path, target });
    });
    tx();
  }

  /** Refresh only the (size, mtimeMs) gate watch.ts stats against — the bytes
      are unchanged, so rev/hash/body/fts/backlinks must all stay as they are. */
  touchFileStat(path: string, size: number, mtimeMs: number) {
    this.db
      .query("UPDATE files SET size = $size, mtimeMs = $mtimeMs WHERE path = $path")
      .run({ path, size, mtimeMs });
  }

  removeFile(path: string) {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM files WHERE path = $path").run({ path });
      this.db.query("DELETE FROM files_fts WHERE path = $path").run({ path });
      this.db.query("DELETE FROM backlinks WHERE src = $src").run({ src: path });
    });
    tx();
  }

  /* ---------- backlink graph, for rename/move (SPEC §5, phase 5) ----------

     A move rewrites `[[links]]` vault-wide, and "vault-wide" must not mean
     "read every file on disk on every rename". These two reads narrow it to the
     docs that can possibly hold an affected link.

     The graph is a CACHE, so the caller owes it one thing: run a reconcile pass
     (holding the reconcile lock) before planning, and the rows are then exactly
     what is on disk. Note the stored targets come from `extractLinks(redact())`
     — links inside ordinary code fences ARE in here (a superset, which only
     widens the candidate set) and links inside ```age fences are NOT, which is
     the same rule the rewriter obeys. */

  /** Every distinct `[[target]]` string any doc carries. */
  linkTargets(): string[] {
    return this.db
      .query<{ target: string }, []>("SELECT DISTINCT target FROM backlinks ORDER BY target")
      .all()
      .map((r) => r.target);
  }

  /**
   * Docs carrying at least one of these link targets. Filtered in JS rather
   * than with an `IN (…)` list: the target set is unbounded (one entry per
   * distinct link in the vault) and sqlite's variable limit is not.
   */
  backlinkSources(targets: Iterable<string>): string[] {
    const want = new Set(targets);
    if (!want.size) return [];
    const rows = this.db.query<{ src: string; target: string }, []>("SELECT src, target FROM backlinks").all();
    const out = new Set<string>();
    for (const r of rows) if (want.has(r.target)) out.add(r.src);
    return [...out].sort();
  }

  /* ---------- folders (advisory disclosure state) ---------- */

  folderOpen(): Map<string, boolean> {
    const rows = this.db.query<{ path: string; open: number }, []>("SELECT path, open FROM folders").all();
    return new Map(rows.map((r) => [r.path, !!r.open]));
  }

  setFolderOpen(path: string, open: boolean) {
    this.db
      .query("INSERT INTO folders (path, open) VALUES ($path, $open) ON CONFLICT(path) DO UPDATE SET open = excluded.open")
      .run({ path, open: open ? 1 : 0 });
  }

  /* A moved folder keeps its disclosure state, and a deleted one stops carrying
     one forever. Unlike `files`, these rows have no counterpart on disk, so the
     reconciler cannot heal them: nothing else would ever notice `archive/2019`
     is gone, and a later folder created at the same path would silently inherit
     a stale "closed". */

  moveFolders(from: string, to: string) {
    const prefix = from + "/";
    const tx = this.db.transaction(() => {
      const rows = this.db.query<{ path: string; open: number }, []>("SELECT path, open FROM folders").all();
      const del = this.db.query("DELETE FROM folders WHERE path = $path");
      const ins = this.db.query(
        "INSERT INTO folders (path, open) VALUES ($path, $open) ON CONFLICT(path) DO UPDATE SET open = excluded.open"
      );
      for (const r of rows) {
        if (r.path !== from && !r.path.startsWith(prefix)) continue;
        del.run({ path: r.path });
        ins.run({ path: to + r.path.slice(from.length), open: r.open });
      }
    });
    tx();
  }

  removeFolders(path: string) {
    const prefix = path + "/";
    const tx = this.db.transaction(() => {
      const rows = this.db.query<{ path: string }, []>("SELECT path FROM folders").all();
      const del = this.db.query("DELETE FROM folders WHERE path = $path");
      for (const r of rows) if (r.path === path || r.path.startsWith(prefix)) del.run({ path: r.path });
    });
    tx();
  }

  /* ---------- credentials (raw values live ONLY here) ---------- */

  getCredential(key: string): string | null {
    const r = this.db.query<{ value: string }, { key: string }>("SELECT value FROM credentials WHERE key = $key").get({ key });
    return r ? r.value : null;
  }

  setCredential(key: string, value: string) {
    if (!value) {
      this.db.query("DELETE FROM credentials WHERE key = $key").run({ key });
      return;
    }
    this.db
      .query(
        `INSERT INTO credentials (key, value, updatedAt) VALUES ($key, $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
      )
      .run({ key, value, updatedAt: new Date().toISOString() });
  }

  /* ---------- ai sessions / messages (phase-1 stubs) ---------- */

  activeSession(): { id: string; startedAt: string; contextDocPath: string | null } | null {
    return this.db
      .query<{ id: string; startedAt: string; contextDocPath: string | null }, []>(
        "SELECT id, startedAt, contextDocPath FROM ai_sessions WHERE active = 1 ORDER BY startedAt DESC LIMIT 1"
      )
      .get();
  }

  createSession(id: string, startedAt: string, contextDocPath: string | null) {
    const tx = this.db.transaction(() => {
      this.db.run("UPDATE ai_sessions SET active = 0");
      this.db
        .query("INSERT INTO ai_sessions (id, startedAt, contextDocPath, active) VALUES ($id, $startedAt, $contextDocPath, 1)")
        .run({ id, startedAt, contextDocPath });
    });
    tx();
  }

  setSessionContext(id: string, contextDocPath: string | null) {
    this.db.query("UPDATE ai_sessions SET contextDocPath = $contextDocPath WHERE id = $id").run({ id, contextDocPath });
  }

  messages(sessionId: string) {
    return this.db
      .query<
        { id: string; role: string; kind: string | null; content: string; proposalId: string | null; at: string },
        { sessionId: string }
      >("SELECT id, role, kind, content, proposalId, at FROM ai_messages WHERE sessionId = $sessionId ORDER BY seq")
      .all({ sessionId });
  }

  addMessage(m: {
    id: string;
    sessionId: string;
    seq: number;
    role: string;
    kind: string | null;
    content: string;
    proposalId: string | null;
    at: string;
  }) {
    this.db
      .query(
        `INSERT INTO ai_messages (id, sessionId, seq, role, kind, content, proposalId, at)
         VALUES ($id, $sessionId, $seq, $role, $kind, $content, $proposalId, $at)`
      )
      .run(m);
  }

  /* ---------- ai proposals (phase 4) ---------- */

  addProposal(p: ProposalRow) {
    this.db
      .query(
        `INSERT INTO ai_proposals
           (id, sessionId, seq, createdAt, target, label, summary, state, stackIndex, added, removed,
            diff, edits, files, model, effort, commitSha, commitNote, appliedAt, revertedAt)
         VALUES
           ($id, $sessionId, $seq, $createdAt, $target, $label, $summary, $state, $stackIndex, $added, $removed,
            $diff, $edits, $files, $model, $effort, $commitSha, $commitNote, $appliedAt, $revertedAt)`
      )
      .run(p as unknown as Record<string, string | number | null>);
  }

  proposal(id: string): ProposalRow | null {
    return this.db.query<ProposalRow, { id: string }>("SELECT * FROM ai_proposals WHERE id = $id").get({ id });
  }

  /** Every proposal, oldest first — the order the chat shows them in. */
  proposals(): ProposalRow[] {
    return this.db.query<ProposalRow, []>("SELECT * FROM ai_proposals ORDER BY seq").all();
  }

  /** The change stack, oldest → newest (API.md § GET /api/ai/proposals). */
  stack(): ProposalRow[] {
    return this.db
      .query<ProposalRow, []>("SELECT * FROM ai_proposals WHERE stackIndex IS NOT NULL ORDER BY stackIndex")
      .all();
  }

  /**
   * Follow a human rename/move with the AI change stack.
   *
   * A proposal's pre-image is addressed by path, and phase 5 gave the human two
   * ways to make that path stop existing. Without this, revert's drift guard
   * read the OLD path, found nothing, and answered 409 `drifted` naming a file
   * the user could no longer see — permanently, and for every proposal beneath
   * it too, since the stack is strictly LIFO.
   */
  moveProposalFiles(mapping: Map<string, string>) {
    if (!mapping.size) return;
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query<{ id: string; target: string; files: string }, []>("SELECT id, target, files FROM ai_proposals")
        .all();
      const upd = this.db.query("UPDATE ai_proposals SET target = $target, files = $files WHERE id = $id");
      for (const r of rows) {
        let files: Array<{ path: string }>;
        try {
          files = JSON.parse(r.files);
        } catch {
          continue;
        }
        const target = mapping.get(r.target) ?? r.target;
        let touched = target !== r.target;
        for (const f of files) {
          const next = mapping.get(f.path);
          if (next && next !== f.path) {
            f.path = next;
            touched = true;
          }
        }
        if (touched) upd.run({ id: r.id, target, files: JSON.stringify(files) });
      }
    });
    tx();
  }

  /* ---------- terminal commands (SPEC §13) ---------- */

  addCommand(c: {
    id: string;
    source: string;
    command: string;
    why: string | null;
    state: string;
    cwd: string;
    sessionId: string | null;
    messageId: string | null;
    createdAt: string;
  }) {
    this.db
      .query(
        `INSERT INTO terminal_commands (id, source, command, why, state, cwd, exitCode, output, truncated,
                                        sessionId, messageId, createdAt, finishedAt)
         VALUES ($id, $source, $command, $why, $state, $cwd, NULL, NULL, 0,
                 $sessionId, $messageId, $createdAt, NULL)`
      )
      .run(c as unknown as Record<string, string | number | null>);
  }

  command(id: string): CommandRow | null {
    const r = this.db
      .query<RawCommandRow, { id: string }>("SELECT * FROM terminal_commands WHERE id = $id")
      .get({ id });
    return r ? commandOut(r) : null;
  }

  /** The most recent `limit` records, oldest first — chat order.
      `sessionId` narrows to one session's commands (the AI context path:
      "new session" means the previous session's transcripts stay out of the
      next session's prompt).

      Ties inside one millisecond break on `rowid`, not `id`: ids end in a
      variable-length base36 sequence (seq 35 = "z", seq 36 = "10"), so they
      do not sort lexicographically in creation order. rowid is assigned on
      insert and this process is the only writer. */
  commands(limit: number, sessionId?: string): CommandRow[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit) || 30));
    const rows = sessionId
      ? this.db
          .query<RawCommandRow, { n: number; sessionId: string }>(
            "SELECT * FROM terminal_commands WHERE sessionId = $sessionId ORDER BY createdAt DESC, rowid DESC LIMIT $n"
          )
          .all({ n, sessionId })
      : this.db
          .query<RawCommandRow, { n: number }>("SELECT * FROM terminal_commands ORDER BY createdAt DESC, rowid DESC LIMIT $n")
          .all({ n });
    return rows.map(commandOut).reverse();
  }

  updateCommand(id: string, patch: Record<string, string | number | null>) {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    this.db.query(`UPDATE terminal_commands SET ${sets} WHERE id = $id`).run({ ...patch, id });
  }

  updateProposal(id: string, patch: Partial<ProposalRow>) {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    this.db
      .query(`UPDATE ai_proposals SET ${sets} WHERE id = $id`)
      .run({ ...(patch as Record<string, string | number | null>), id });
  }
}

/* sqlite has no boolean, so `truncated` is stored 0/1 and handed out as one. */
interface RawCommandRow {
  id: string;
  source: string;
  command: string;
  why: string | null;
  state: string;
  cwd: string;
  exitCode: number | null;
  output: string | null;
  truncated: number;
  sessionId: string | null;
  messageId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type CommandRow = Omit<RawCommandRow, "truncated" | "source" | "state"> & {
  truncated: boolean;
  source: "user" | "ai";
  state: "pending" | "running" | "done" | "rejected" | "failed";
};

const commandOut = (r: RawCommandRow): CommandRow => ({
  ...r,
  truncated: !!r.truncated,
  source: r.source as "user" | "ai",
  state: r.state as CommandRow["state"],
});

export interface ProposalRow {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  target: string;
  label: string;
  summary: string;
  state: string;
  stackIndex: number | null;
  added: number;
  removed: number;
  /** JSON: [{marker, text}] */
  diff: string;
  /** JSON: the UI-facing edit list */
  edits: string;
  /** JSON: [{path, op, pre, post}] — the byte-exact undo images */
  files: string;
  model: string | null;
  effort: string | null;
  commitSha: string | null;
  commitNote: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
}

/* ============================================================
   Search — subsequence scorer over doc paths AND content lines; the content
   scored is the redacted body, so age armor can never surface in a result.
   `fuzzy` is exported pure: tests/helpers.ts uses it as the offsets oracle.
   ============================================================ */

export function fuzzy(q: string, hay: string): { score: number; idx: number[] } | null {
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

export interface SearchHit {
  kind: "doc" | "line";
  path: string;
  name: string;
  line?: number;
  text: string;
  matches: number[];
  score: number;
}
