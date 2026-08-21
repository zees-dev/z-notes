/* ============================================================
   db.ts — bun:sqlite index, FTS5, backlinks, AI history, credentials.

   The database is a DISPOSABLE CACHE. Markdown on disk is the source of
   truth; deleting <vault>/.znotes/index.db loses nothing but credentials
   and AI history, both of which have no on-disk representation by design.

   Migrations are "rebuild": on schema_version mismatch every index table is
   dropped and rebuilt from disk (credentials are carried across best-effort).

   Sharp edges obeyed (bun:sqlite):
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

/* ---------- search limits ----------
   A search runs on the one process that also serves SSE, saves and git, so the
   sweep is bounded rather than trusted: past the budget it returns what it has
   and says so. The regex caps are the same argument aimed at backtracking —
   the pattern comes from the vault's owner, but a pattern nobody meant to be
   catastrophic still stalls the app that runs it. */
const SEARCH_BUDGET_MS = 60;
const REGEX_LINE_MAX = 2000;
/** two caps on one line's highlighting: how many matches are walked, and how
    many characters they may light up between them. `/./` over prose reaches
    both, and neither changes WHICH lines are hits — only how much of one is
    painted. */
const REGEX_MATCH_MAX = 64;
const REGEX_IDX_MAX = 240;
/** past this, a document skips the whole-document pre-check and is scanned line
    by line instead — bounded work, and never a rejection over an unseen hit */
const REGEX_PROBE_MAX = 262_144;
const REGEX_BASE = 30;
/** lowercased line cache, in characters — a few MB, not a second vault */
const LINE_CACHE_MAX = 4_000_000;

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
  /* AI proposals (research §5 layer 1). `files` carries the pre- and
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
  /* Terminal commands the ASSISTANT asked for. Only AI-originated
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
  /**
   * One document's lines, split and lowercased ONCE and kept against the hash
   * the reconciler already computes.
   *
   * The scan below reads every line of every document on every keystroke, and
   * it used to `split` and `toLowerCase` all of it each time — the whole vault
   * re-allocated between one letter and the next. Keyed by hash, so an edit
   * invalidates its own document and nothing else, and bounded, so a large
   * vault cannot turn the index into a second copy of itself in memory.
   */
  private lineCache = new Map<string, LineEntry>();
  private lineCacheChars = 0;

  private lines(row: { hash: string; body: string }): LineEntry {
    const hit = this.lineCache.get(row.hash);
    if (hit) return hit;
    /* TRIMMED here, once, because trimmed is what a hit reports and what its
       match offsets index into — doing it in the scan meant re-trimming every
       line of the vault per keystroke, and left the two passes disagreeing
       about where a line starts (see `flat`). Keyed by CONTENT hash, so an edit
       invalidates its own document and two identical documents share an entry. */
    const text = row.body.split("\n").map((l) => l.trim());
    const entry: LineEntry = {
      hash: row.hash,
      text,
      low: text.map((l) => l.toLowerCase()),
      chars: row.body.length,
      acct: 0,
      flat: null,
    };
    if (entry.chars <= LINE_CACHE_MAX) {
      while (this.lineCacheChars + entry.chars > LINE_CACHE_MAX && this.lineCache.size) {
        const oldest = this.lineCache.keys().next().value as string;
        /* `acct`, not `chars`: an evicted entry must hand back everything it
           took, `flat` included, or the counter ratchets up until the cache
           evicts everything on sight and every keystroke rebuilds the vault —
           slower than having no cache at all, and silent. */
        this.lineCacheChars -= this.lineCache.get(oldest)!.acct;
        this.lineCache.delete(oldest);
      }
      this.lineCache.set(row.hash, entry);
      entry.acct = entry.chars;
      this.lineCacheChars += entry.acct;
    }
    return entry;
  }

  /**
   * The document as the per-line pass will see it: trimmed lines, rejoined.
   *
   * The whole-document regex reject has to be asked of EXACTLY this, not of the
   * raw body. Lines are matched trimmed, so `^` means "after the indentation" —
   * and against the raw body `/^- \[/` failed on every indented list item and
   * threw the document away before its lines were ever tried. Built once per
   * document, and only for the regex queries that need it.
   */
  private flatOf(entry: LineEntry): string {
    if (entry.flat === null) {
      entry.flat = entry.text.join("\n");
      /* charge it ONLY to an entry the cache is actually holding: a document
         too big to cache, or one already evicted, is rebuilt every time and
         must not bill the counter every time it is */
      if (this.lineCache.get(entry.hash) === entry) {
        entry.acct += entry.flat.length;
        this.lineCacheChars += entry.flat.length;
      }
    }
    return entry.flat;
  }

  /**
   * GET /api/search: fuzzy (subsequence) or regex over doc paths AND redacted
   * bodies, top 2 hit lines per doc.
   *
   * Two things keep this honest on a large vault. A document is REJECTED WHOLE
   * before its lines are looked at — a line can only match if the body does,
   * for both modes — which is what turns a per-keystroke scan of every line in
   * the vault into a scan of the few documents that can possibly answer. And
   * the sweep runs against a DEADLINE: partial results now beat complete
   * results after the next keystroke has already replaced them, and this is the
   * one process serving SSE, saves and everything else.
   */
  search(q: string, limit: number, forced?: string | null): SearchAnswer {
    const sq = parseSearch(q, forced);
    const out: SearchHit[] = [];
    const until = Date.now() + SEARCH_BUDGET_MS;
    let partial = false;
    let seen = 0;

    if (sq.mode === "regex" && sq.term && !sq.probe) {
      return { results: [], mode: sq.mode, invalid: sq.invalid, partial: false };
    }
    const needle = sq.mode === "fuzzy" ? sq.term.toLowerCase() : "";
    const empty = !sq.term;

    for (const row of this.allFiles()) {
      const path = row.path;
      const name = path.split("/").pop()!;
      if (empty) {
        out.push({ kind: "doc", path, name, text: path, matches: [], score: 0 });
        continue;
      }
      /* EVERY document, not every sixteenth: one `Date.now()` costs nothing
         beside a regex sweep of a document, and a pattern that backtracks can
         spend the whole budget inside a single one — checking in strides let
         fifteen more run after the budget was already gone. */
      seen++;
      if (Date.now() > until) {
        partial = true;
        break;
      }

      const entry = this.lines(row);
      const { text: lines, low } = entry;

      /* THE WHOLE-DOCUMENT REJECT, asked of exactly what the per-line pass will
         see. A line can only match if the document does, in either mode, so a
         `false` here can never hide a hit — and it is what keeps a keystroke
         off the lines of every document that cannot possibly answer. */
      if (sq.mode === "regex") {
        const pm = regexIdx(sq.all!, path);
        if (pm) out.push({ kind: "doc", path, name, text: path, matches: pm, score: 12 + REGEX_BASE });
        /* `probe` is not global, so it carries no lastIndex between documents.
           Past a size the pre-check is skipped rather than truncated: a
           truncated probe could reject a document over a hit it never saw, and
           a wrong answer is worse than a slow one. The per-line pass that then
           runs is bounded line by line. */
        const flat = this.flatOf(entry);
        if (flat.length <= REGEX_PROBE_MAX && !sq.probe!.test(flat)) continue;
      } else {
        const nm = fuzzyOn(needle, path.toLowerCase());
        if (nm) out.push({ kind: "doc", path, name, text: path, matches: nm.idx, score: nm.score + 12 });
        if (!hasSubseq(needle, low)) continue;
      }

      const hits: SearchHit[] = [];
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        if (!text || text.length < 2) continue;
        if (sq.mode === "regex") {
          const r = regexIdx(sq.all!, text.length > REGEX_LINE_MAX ? text.slice(0, REGEX_LINE_MAX) : text);
          if (r) hits.push({ kind: "line", path, name, line: i, text, matches: r, score: regexScore(r, text) });
        } else {
          const r = fuzzyOn(needle, low[i]);
          if (r) hits.push({ kind: "line", path, name, line: i, text, matches: r.idx, score: r.score });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      for (const h of hits.slice(0, 2)) out.push(h);
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? -1) - (b.line ?? -1));
    return { results: out.slice(0, limit), mode: sq.mode, invalid: sq.invalid, partial };
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

  /* ---------- backlink graph, for rename/move ----------

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

  /** The change stack, oldest → newest, as GET /api/ai/proposals serves it. */
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

  /* ---------- terminal commands ---------- */

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
  return fuzzyOn(q.toLowerCase(), hay.toLowerCase());
}

/**
 * The scorer proper, over an ALREADY-LOWERCASED needle and haystack.
 *
 * Split out because `fuzzy` lowercased its haystack on every call, and the
 * search below calls it once per line of every document in the vault on every
 * keystroke — so the whole vault was being re-lowercased, and re-allocated,
 * between one letter and the next. The caller now lowercases each body once and
 * keeps it (see `lines`).
 */
function fuzzyOn(n: string, h: string): { score: number; idx: number[] } | null {
  if (!n) return { score: 0, idx: [] };
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
  /* an all-whitespace needle matches everything and indexes nothing, so there
     is no first offset to discount — `idx[0]` there made every score NaN, and
     NaN sorts nowhere */
  score -= (idx.length ? idx[0] : 0) * 0.08;
  score -= Math.max(0, h.length - 60) * 0.01;
  return { score, idx };
}

/* ---------- regex queries ----------

   A regex is written `/pattern/flags`, so it survives a URL, a bookmark and a
   curl without a second parameter to say what it is — and the palette's toggle
   is then a READING of the query as much as a control over it. `mode=regex`
   forces the reading for a pattern the user would rather not wrap.

   `g` and `y` are stripped: iteration is this file's job, and a caller-supplied
   `lastIndex` is a foot-gun in a matcher that runs over every line in a vault. */
const SLASHED = /^\/(.*)\/([a-z]*)$/s;
const FLAGS_OK = /^[imsu]*$/;

export type SearchMode = "fuzzy" | "regex";

export interface SearchQuery {
  mode: SearchMode;
  /** the pattern or the fuzzy needle — what the user meant, minus delimiters */
  term: string;
  /** non-global, for `test`; null when the pattern will not compile */
  probe: RegExp | null;
  /** the same pattern with `g`, for walking every match on a line */
  all: RegExp | null;
  /** why the pattern was refused, for the palette to say out loud */
  invalid: string | null;
}

export function parseSearch(q: string, forced?: string | null): SearchQuery {
  /* The slash form only claims a query whose tail is REAL flags. `/etc/hosts`
     and `/usr/bin` are paths people search for, not patterns with a flag set
     called "hosts" — reading them as regex made ordinary text unsearchable and
     answered with a complaint about a flag the user never typed. */
  const m = SLASHED.exec(q);
  const slashed = !!m && FLAGS_OK.test(m[2].replace(/[gy]/g, ""));
  /* `mode=fuzzy` is the other way out: it takes a query at its word even when
     it is shaped like a pattern, which is what the palette's fuzzy chip sends
     so that clicking it never has to rewrite what you typed. */
  if (forced === "fuzzy" || (forced !== "regex" && !slashed)) {
    return { mode: "fuzzy", term: q, probe: null, all: null, invalid: null };
  }
  const src = slashed ? m![1] : q;
  const flags = slashed ? m![2].replace(/[gy]/g, "") : "";
  if (!src) return { mode: "regex", term: "", probe: null, all: null, invalid: null };
  try {
    /* `m` ALWAYS: this searches a vault line by line, so `^` and `$` mean the
       ends of a line — which is both what a person means by them here and what
       makes the whole-body pre-check below agree with the per-line pass. Without
       it `/^WARN/` pre-rejected every document whose FIRST line was not WARN,
       and found nothing anywhere. */
    return {
      mode: "regex",
      term: src,
      probe: new RegExp(src, flags.includes("m") ? flags : flags + "m"),
      all: new RegExp(src, (flags.includes("m") ? flags : flags + "m") + "g"),
      invalid: null,
    };
  } catch (err) {
    /* a half-typed pattern is the NORMAL state of a box being typed into, so
       this is a result the palette can render, never an error it must toast */
    return { mode: "regex", term: src, probe: null, all: null, invalid: cleanRegexError(err) };
  }
}

function cleanRegexError(err: unknown): string {
  const raw = String((err as Error)?.message || err);
  return raw.replace(/^Invalid regular expression:?\s*/i, "").replace(/^\/.*\/[a-z]*:\s*/, "") || "invalid pattern";
}

/**
 * Could any ONE line hold this needle? Asked of the whole document before its
 * lines are scored, and cheap enough to be worth asking: it walks the lines
 * already lowercased in the cache and allocates nothing.
 *
 * The pointer carries ACROSS lines on purpose — that is the concatenation test,
 * which is a superset of the per-line one, so a `false` here can never hide a
 * line that would have matched.
 */
function hasSubseq(n: string, lines: string[]): boolean {
  let i = 0;
  for (const line of lines) {
    let from = 0;
    while (i < n.length) {
      const c = n[i];
      if (c === " ") {
        i++;
        continue;
      }
      const at = line.indexOf(c, from);
      if (at < 0) break;
      i++;
      from = at + 1;
    }
    if (i >= n.length) return true;
  }
  return i >= n.length;
}

/** Every match on one line, as the character offsets the clients highlight —
    capped, because `.` over a long line is a legal thing to ask for and a
    highlight per character is not worth serialising. */
function regexIdx(re: RegExp, text: string): number[] | null {
  re.lastIndex = 0;
  const idx: number[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < REGEX_MATCH_MAX) {
    for (let i = m.index; i < m.index + m[0].length && idx.length < REGEX_IDX_MAX; i++) idx.push(i);
    /* a zero-length match (`x*`, a lone anchor) never advances lastIndex */
    if (m[0].length === 0) re.lastIndex++;
    if (idx.length >= REGEX_IDX_MAX) break;
  }
  return idx.length ? idx : null;
}

/** A regex hit has no subsequence score to earn, so rank by where and how much
    it matched: earlier and denser first, long lines discounted the same way
    `fuzzyOn` discounts them, so the two modes sort alike. */
function regexScore(idx: number[], text: string): number {
  return REGEX_BASE + Math.min(idx.length, 24) * 0.5 - idx[0] * 0.08 - Math.max(0, text.length - 60) * 0.01;
}

/** one document's lines, ready to match: trimmed, lowercased, and (for regex)
    rejoined — see `Index.lines` for why all three are kept rather than derived */
interface LineEntry {
  /** its own key, so `flatOf` can tell whether this entry is still cached */
  hash: string;
  text: string[];
  low: string[];
  chars: number;
  /** what this entry has added to `lineCacheChars` — the ONE number eviction
      gives back. Grows when `flat` is built; 0 for an entry never cached. */
  acct: number;
  flat: string | null;
}

export interface SearchAnswer {
  results: SearchHit[];
  mode: SearchMode;
  /** the reason a regex would not compile — results are empty when set */
  invalid: string | null;
  /** the deadline cut the sweep short; what is here is real, just not all */
  partial: boolean;
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
