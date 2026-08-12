/* ============================================================
   git.ts — vault git sync (SPEC §7, phase 2).

   THE VAULT IS ITS OWN REPOSITORY. It is not this source tree, and every
   command here is issued with cwd = vault AND verified against
   `git rev-parse --show-toplevel`: if the toplevel is not the vault itself the
   vault is treated as "not a git repository", which is exactly what stops a
   vault nested inside another checkout (./vault inside the z-notes source repo,
   the default!) from ever having commits pushed into the wrong repo. THE
   PIPELINE never `git init`s — an un-initialised vault is a fully working,
   offline vault. `attachRemote` (ADR 0017), the user-initiated operation that
   connects a vault to a remote, is the one place that may: it is atomic, and
   any failure leaves the vault byte-identical to what it found.

   Everything runs through Bun.spawn with an ARGV ARRAY: no shell string, no
   Bun.$, so a note called `x; rm -rf ~`.md is one argument and nothing else.

   CREDENTIAL RULE (SPEC §7, ticket 4): the GitHub token lives only in sqlite.
   It reaches git through the environment of the spawned child and nowhere else
   — never in argv (visible in `ps`), never in a remote URL (which would land in
   .git/config and in every error message), never in a log line, never in an SSE
   payload or HTTP response. `GIT_ASKPASS` points at a three-line helper that
   echoes the env var back; `-c credential.helper=` clears any configured
   helper so the answer is deterministic. Anything git prints is scrubbed of the
   token before it is stored, logged or returned, as a second line of defence.

   Pipeline (auto: debounced; manual: immediate — the same code):
     refuse to run at all if the vault is mid-merge/rebase/cherry-pick/revert,
     has a conflicted index, or is on a detached HEAD →
     add (tracked set only) → commit → push → on non-fast-forward:
     pull --rebase → push again → on conflict: rebase --abort, state "error".
   The app never resolves a conflict and never destroys either side: it only
   ever aborts a rebase IT started, and it refuses to rebase at all while the
   working tree carries changes it did not just commit.
   ============================================================ */

import { chmodSync, existsSync, realpathSync, renameSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CREDENTIAL_FILE_KEYS, validBranchName } from "./settings.ts";
import { trashGitPaths } from "./trash.ts";
import type { Vault } from "./vault.ts";

/* ---------- contract (docs/specs/done/0002-http-api-v0.md § Sync) ---------- */

type SyncState = "synced" | "syncing" | "offline" | "error";

interface SyncStatus {
  state: SyncState;
  branch: string;
  /** origin's host + path ONLY — never a scheme, never credentials. */
  remote: string | null;
  lastSyncAt: string | null;
  ahead: number;
  behind: number;
  message: string;
}

/**
 * `POST /api/sync/remote`. The failure half carries the response verbatim —
 * status and a `{error, message, ...extra}` body in that key order — so the
 * route is a delegation and no HTTP shaping leaks into git.ts.
 */
export type AttachResult =
  | { ok: true; branch: string; created: "repo" | "origin" | "none" }
  | { ok: false; status: number; body: { error: string; message: string; paths?: string[] } };

/**
 * A credential key in the committed settings.toml — see `settingsCanary`.
 *
 * DERIVED from settings.ts's one list rather than spelled out again: the two
 * halves of this guard are the regex that notices a credential and the absorb
 * that removes it, and a key taught to only one of them is either committed in
 * plaintext (missing here) or blocks sync forever (missing there).
 */
const CREDENTIAL_KEY_RE = new RegExp(
  `^[ \\t]*["']?(${CREDENTIAL_FILE_KEYS.join("|")})["']?[ \\t]*=`,
  "m"
);

/** Committed alongside the notes (SPEC §7). `.znotes/index.db` is NOT here. */
const TRACKED_META = [
  ".znotes/settings.toml",
  ".znotes/vault.pub",
  ".znotes/identity.age",
];

/**
 * Committed DIRECTORIES under `.znotes/` — the same idea as `TRACKED_META`, for
 * a tree whose contents are not knowable in advance.
 *
 * `.znotes/trash/` IS COMMITTED, deliberately. After a delete the trash holds
 * the ONLY live copy of the bytes — the working tree no longer has them — so a
 * local-only trash means a delete on the phone is unrecoverable from the
 * laptop except by walking git history by hand, and the two devices disagree
 * about what is recoverable, which is exactly the state a synced vault must not
 * be in. Committing it makes "deleted here, restore there" work with the same
 * pull the notes already ride on.
 *
 * Nothing about the credential rules changes: `NEVER_COMMIT` names index.db and
 * its parked copies explicitly (not `.znotes/` wholesale), `settingsCanary` and
 * `keyringCanary` still gate every commit, and a trashed doc reaches git as the
 * same bytes it had in the vault — the move is one `rename(2)`, so an age block
 * keeps its armor byte-identical and is stored exactly as it already was.
 */
const TRACKED_META_DIRS = [".znotes/trash/"];

const inTrackedDir = (p: string) => TRACKED_META_DIRS.some((d) => p.startsWith(d));

/** Pathspecs for the tracked dirs, without the trailing slash git dislikes. */
const TRACKED_META_DIR_SPECS = TRACKED_META_DIRS.map((d) => d.replace(/\/$/, ""));

/** Overridable ONLY so a test can watch a hung git get killed in seconds. */
const GIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ZNOTES_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();
const DEFAULT_AUTOSYNC_SECONDS = 60;

/* The sqlite index is a rebuildable cache AND the credential store, so it must
   never be committed (SPEC §5/§7). The rules go in `.git/info/exclude`, not in
   a working-tree `.gitignore`: info/exclude is per-clone, so it applies whatever
   the user's own `.gitignore` says, it is never staged, and it can never collide
   with a `.gitignore` that arrives from another device on a pull. */
const EXCLUDE_HEADER = "# z-notes (managed) — never commit the sqlite index (SPEC §5/§7).";
const EXCLUDE_RULES = [
  ".znotes/index.db",
  ".znotes/index.db-wal",
  ".znotes/index.db-shm",
  ".znotes/tmp/",
  /* the previous identity, parked by writeVaultKeys while a replacement lands
     (vault.ts PREV_IDENTITY). It is local crash-recovery, never a committed
     part of the keyring. */
  ".znotes/identity.age.prev",
  /* A corrupt index, parked by db.ts instead of deleted so `sqlite3 .recover`
     can still get the git token, the AI key and the terminal password hash back
     out of it. It is a COPY OF THE CREDENTIAL STORE — the one file in this list
     that must not be committed for secrecy reasons rather than tidiness ones.
     `.znotes/tmp/` does not cover it: it is parked beside index.db, on purpose,
     because .recover wants the -wal sidecar next to its database. */
  ".znotes/index.db.corrupt-*",
  /* the pre-migration copy db.ts parks on a schema bump — same file, same
     credentials, same secrecy rule */
  ".znotes/index.db.v*",
];
/** Paths that must be ignored, whatever else the repo is configured to do. */
const NEVER_COMMIT = [
  ".znotes/index.db",
  ".znotes/index.db-wal",
  ".znotes/index.db-shm",
  /* git PATHSPEC globs, matched by `ls-files` below — a parked corrupt index
     and a pre-migration park both carry the same credentials the live one
     does (db.ts parkCorruptIndex / migrate) */
  ".znotes/index.db.corrupt-*",
  ".znotes/index.db.v*",
];

/* The helper git calls when it needs a username/password. $1 is the prompt
   ("Username for 'https://github.com': "). The values come from this process's
   environment only — see the credential rule above. */
const ASKPASS_SH = `#!/bin/sh
# z-notes GIT_ASKPASS helper — echoes a credential supplied only in the env of
# the git child. The token is never in argv, in a remote URL or in .git/config.
case "$1" in
  Username*|username*) printf %s "\${ZNOTES_GIT_USERNAME}" ;;
  *) printf %s "\${ZNOTES_GIT_PASSWORD}" ;;
esac
`;

/* ---------- small helpers ---------- */

const firstLine = (s: string) =>
  String(s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";

const nulList = (s: string) => String(s || "").split("\0").filter(Boolean);

/** "a.md, b.md (+3 more)" — a message names files or it is not actionable. */
const listPaths = (paths: string[], max = 4) =>
  paths.slice(0, max).join(", ") + (paths.length > max ? ` (+${paths.length - max} more)` : "");

const MESSAGE_MAX = 300;

/* Progress chatter git writes to stderr on the way to the real failure. The
   first stderr line of a failed `pull --rebase` is `From <remote>` and the first
   line of a rejected `add` is a bare header — neither names anything the user
   can act on, which is the whole job of `message` (SPEC §7, API.md § Sync). */
const NOISE = /^(From\b|remote:|hint:|warning:|Warning:|Everything up-to-date|To\b)/;
const ANCHOR = /^(fatal|error):/i;

/**
 * The actionable part of a git failure: the first `fatal:`/`error:` line if
 * there is one (else the first line that is not progress noise), plus the
 * continuation lines that belong to it — the indented path list under
 * "The following paths are ignored…" or "Please commit or stash them.".
 */
export function gitMessage(stderr: string, stdout: string, fallback: string): string {
  const raw = String(stderr || "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const noisy = (l: string) => !l.trim() || NOISE.test(l.trim());
  let start = raw.findIndex((l) => !noisy(l) && ANCHOR.test(l.trim()));
  if (start < 0) start = raw.findIndex((l) => !noisy(l));
  if (start < 0) return firstLine(stdout) || fallback;

  const parts = [raw[start].trim()];
  for (let i = start + 1; i < raw.length && parts.length < 4; i++) {
    const l = raw[i];
    if (noisy(l)) break;
    parts.push(l.trim());
  }
  return parts.join(" ").slice(0, MESSAGE_MAX) || fallback;
}

/** Redact a credential from anything that might be shown, logged or stored. */
function scrub(text: string, token: string | null): string {
  if (!text) return "";
  if (!token || token.length < 4) return text;
  return text.split(token).join("«redacted»");
}

/**
 * `https://user:pw@github.com/z/vault.git` → `github.com/z/vault`
 * `git@github.com:z/vault.git`            → `github.com/z/vault`
 * A URL may legitimately carry a token in its userinfo (a remote configured
 * outside the app); stripping userinfo unconditionally is what keeps it out of
 * the API response.
 *
 * Userinfo is cut at the LAST `@`, not the first, and without assuming the
 * credential is free of `/` or `@`: `https://user:p/ass@host/z/v.git` and
 * `https://user:p@ss@host/z/v.git` both used to survive the strip and publish
 * the password. Over-stripping a path that itself contains `@` is the safe
 * direction to be wrong in — no output of this function may ever carry a
 * credential.
 */
export function sanitizeRemote(url: string): string | null {
  let u = String(url || "").trim();
  if (!u) return null;
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme
  const at = u.lastIndexOf("@");
  if (at >= 0) u = u.slice(at + 1); // userinfo (user:password@), greedily
  u = u.replace(/^([^/:]+):(?!\d)/, "$1/"); // scp-style host:path → host/path
  u = u.replace(/:\d+\//, "/"); // port
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u || null;
}

/** Longest remote URL attach will look at. A URL is not a document. */
const REMOTE_URL_MAX = 2048;

/**
 * The URL `attachRemote` may hand to git, or null.
 *
 * `https://`, `http://`, `file://` and an absolute path — the last two are what
 * a local remote (and every test fixture) looks like. Everything else is
 * refused, `ssh://` and scp-style `git@host:path` included: those need a key
 * and an agent this server has no story for, and the escape hatch for them is
 * ordinary `git remote add` in the vault, which the pipeline already honours.
 *
 * A URL carrying userinfo is refused however well-formed it is: `git remote
 * add` would write it into `.git/config`, and the credential rule above says a
 * token lives in sqlite and reaches git through the askpass env ONLY. A leading
 * `-` is refused for the same reason `git.branch` is — this string becomes an
 * argv element, and git would read it as an option.
 */
export function validRemoteUrl(url: string): string | null {
  const u = String(url ?? "").trim();
  if (!u || u.length > REMOTE_URL_MAX) return null;
  /* `\` included: WHATWG's parser reads it as a path separator in special
     schemes while git/curl's may read `host\` as userinfo — a parser
     differential with no legitimate URL on the safe side of it. */
  if (/[\s\\\x00-\x1f\x7f]/.test(u)) return null;
  if (u.startsWith("-")) return null;
  if (u.startsWith("/")) return u; // a local remote: a path, not a URL
  if (!/^(https?|file):\/\//i.test(u)) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  return u;
}

/**
 * The paths git named under "The following untracked working tree files would
 * be overwritten by checkout:" — the indented block beneath that header.
 *
 * Best-effort by construction: the wording is not a contract. But attach
 * REFUSES rather than overwrite a local file, and a refusal that cannot name
 * the files is not actionable, so the parse is worth its fragility — and when
 * it finds nothing the caller still fails, just as `attach-failed`.
 */
function overwrittenPaths(stderr: string): string[] {
  const lines = String(stderr || "").split("\n");
  const start = lines.findIndex((l) => /would be overwritten by checkout:/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^[ \t]+\S/.test(lines[i])) break;
    out.push(lines[i].trim());
  }
  return out;
}

/** The refusal half of `attachRemote`, in the contract's key order. */
const attachError = (status: number, error: string, message: string, paths?: string[]): AttachResult => ({
  ok: false,
  status,
  body: paths ? { error, message, paths } : { error, message },
});

function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/* ---------- spawn result ---------- */

interface GitResult {
  code: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** the git binary itself could not be executed */
  missing: boolean;
}

/* ---------- deps (structural: keeps git.ts testable without the server) ---------- */

interface GitSyncDeps {
  vault: Vault;
  settings: {
    value<T>(path: string, fallback: T): T;
    credential(key: "git.token" | "ai.apiKey"): string | null;
    /** settings.toml is committed AND hand-editable: a credential pasted into
        it must move to sqlite before the file is ever staged (SPEC §7). */
    absorbFileCredentials?(): Promise<boolean>;
  };
  index: { getMeta(key: string): string | null; setMeta(key: string, value: string): void };
  /** called on every state transition — the server forwards it as SSE. */
  onStatus?: (status: SyncStatus) => void;
  /** argv-only logger. NEVER hand it an environment. */
  log?: (line: string) => void;
}

type Trigger = "boot" | "auto" | "manual";

interface Observation {
  repo: boolean;
  /** why not, when repo === false */
  reason: string;
  branch: string;
  detached: boolean;
  unborn: boolean;
  /** a merge/rebase/cherry-pick/revert the USER started and has not finished */
  busy: string | null;
  /** paths with an unresolved conflict in the index */
  conflicted: string[];
  originUrl: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  pending: number;
}

/* ============================================================
   GitSync
   ============================================================ */

export class GitSync {
  private readonly vault: string;
  private readonly vaultHandle: Vault;
  /** vault path as the filesystem reports it — /var vs /private/var on macOS */
  private readonly vaultReal: string;
  private askpass: string | null = null;
  /** every live git child, so SIGTERM can kill ALL of them, not just the last */
  private readonly children = new Set<Bun.Subprocess>();
  /** last observed origin URL, so `fail()` can keep it out of `message` */
  private lastOriginUrl: string | null = null;
  /** why the last attach was refused, if it was. An attach at BOOT
      (ZNOTES_VAULT_REPO) reports itself on stderr, which nobody looking at the
      app can see — so the offline status carries the reason too. */
  private lastAttachFailure: string | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private again = false;
  /** Serialises every WRITER of the git index — the sync pipeline and every
      targeted commit. Two writers to one index raced: a `commitPaths` running
      concurrently with an auto-sync hit transient `index.lock` failures, or
      swept the pipeline's staged set into the wrong commit. Read-only
      observation (`status`/`refresh`) stays outside; it never takes the lock. */
  private mutating: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private observedAt = 0;
  private stopped = false;
  private autoSyncWas: boolean;

  private current: SyncStatus;

  constructor(private readonly deps: GitSyncDeps) {
    this.vault = deps.vault.root;
    this.vaultHandle = deps.vault;
    this.vaultReal = (() => {
      try {
        return realpathSync(this.vault);
      } catch {
        return this.vault;
      }
    })();
    this.autoSyncWas = this.autoSyncOn();
    this.current = {
      state: "offline",
      branch: this.branchSetting(),
      remote: null,
      lastSyncAt: deps.index.getMeta("git.lastSyncAt"),
      ahead: 0,
      behind: 0,
      message: "not a git repository",
    };
  }

  /* ---------- settings ---------- */

  private branchSetting(): string {
    const b = this.deps.settings.value<string>("git.branch", "main");
    return typeof b === "string" && b.trim() ? b.trim() : "main";
  }

  private autoSyncOn(): boolean {
    return this.deps.settings.value<boolean>("git.autoSync", true) !== false;
  }

  private autoSyncMs(): number {
    const raw = Number(this.deps.settings.value<number>("git.autoSyncSeconds", DEFAULT_AUTOSYNC_SECONDS));
    const s = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTOSYNC_SECONDS;
    return Math.min(3600, Math.max(1, s)) * 1000;
  }

  /* ---------- lifecycle ---------- */

  /** One observation at boot so the statusbar is truthful before any edit. */
  async start(): Promise<SyncStatus> {
    await this.refresh();
    return this.current;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // never leave a git child behind on SIGTERM — ALL of them, because a
    // read-only refresh can overlap a push and a single slot would lose one
    for (const c of [...this.children]) {
      this.children.delete(c);
      try {
        c.kill("SIGKILL");
      } catch {}
    }
  }

  /** Last known status, without spawning anything. */
  snapshot(): SyncStatus {
    return { ...this.current };
  }

  /**
   * GET /api/sync/status. Re-observes (read-only git) at most once a second so
   * a chatty client cannot turn the statusbar into a fork bomb; while a sync is
   * in flight the in-flight status is authoritative.
   */
  async status(): Promise<SyncStatus> {
    if (this.stopped || this.inflight) return this.snapshot();
    if (Date.now() - this.observedAt < 1000) return this.snapshot();
    await this.refresh();
    return this.snapshot();
  }

  /* ---------- scheduling ---------- */

  /**
   * A doc changed (our write, or someone else's editor). Debounce: the commit
   * happens `git.autoSyncSeconds` after the LAST change settles, so an edit
   * burst becomes one commit. Re-read from settings every time → the interval
   * is live-reloadable.
   */
  schedule(): void {
    if (this.stopped) return;
    if (!this.autoSyncOn()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.trigger("auto").catch(() => {});
    }, this.autoSyncMs());
    // a pending sync must not hold the process open at exit
    (this.timer as any)?.unref?.();
  }

  /** PUT /api/settings changed something — re-evaluate the pending timer. */
  applySettings(): void {
    const on = this.autoSyncOn();
    const was = this.autoSyncWas;
    this.autoSyncWas = on;
    if (!on) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    // switching auto-sync ON must pick up whatever is already uncommitted,
    // not sit idle until the next keystroke
    if (!was || this.timer) this.schedule();
  }

  /**
   * Single-flight with a queued rerun: a sync in flight is never joined by a
   * second one, and a trigger that arrives mid-run is not dropped — it makes
   * the runner loop once more, so the queued work always happens after the
   * changes that asked for it.
   */
  async trigger(kind: Trigger = "manual"): Promise<SyncStatus> {
    if (this.stopped) return this.snapshot();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      this.again = true;
      await this.inflight;
      return this.snapshot();
    }
    const run = (async () => {
      do {
        this.again = false;
        try {
          // under the writer lock: a targeted commit mid-pipeline is the race
          await this.withIndexLock(() => this.execute(kind));
        } catch (err) {
          // an unexpected throw must still leave a truthful status and, above
          // all, must still clear `inflight` — a stuck flag kills sync for good
          this.fail(
            this.current.branch,
            this.current.remote,
            `sync failed: ${String((err as Error)?.message || err)}`
          );
        }
      } while (this.again && !this.stopped);
    })();
    this.inflight = run;
    try {
      await run;
    } finally {
      this.inflight = null;
    }
    return this.snapshot();
  }

  /** The writer lock. Chained like Reconciler.lock: failures do not break the chain. */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutating.then(fn, fn);
    this.mutating = next.catch(() => {});
    return next;
  }

  /* ============================================================
     spawn
     ============================================================ */

  private log(line: string) {
    this.deps.log?.(line);
  }

  /**
   * The helper lives under `.znotes/tmp/`, which is ignored — so a `git clean
   * -xfd` in the vault deletes it. Memoising the PATH without checking that the
   * file is still there turned that into "every authenticated push fails until
   * the server restarts", so the memo is validated on every use.
   *
   * Written to a private temp name and renamed, so the file is never briefly
   * readable at the umask default before `chmod 0700` lands.
   */
  private async ensureAskpass(): Promise<string> {
    if (this.askpass && existsSync(this.askpass)) return this.askpass;
    const dir = resolve(this.vaultHandle.znotesDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, "askpass.sh");
    const tmp = resolve(dir, `askpass.${process.pid}.tmp`);
    await Bun.write(tmp, ASKPASS_SH);
    chmodSync(tmp, 0o700);
    renameSync(tmp, file);
    this.askpass = file;
    return file;
  }

  /**
   * One git invocation. argv array — no shell anywhere. The token, when there
   * is one, is passed ONLY in `env`; the log line carries argv and nothing else.
   */
  private async git(
    args: string[],
    opts: { stdin?: string; token?: string | null; optionalLocks?: boolean } = {}
  ): Promise<GitResult> {
    const token = opts.token ?? null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    env.GIT_TERMINAL_PROMPT = "0"; // or a credential prompt hangs the server forever
    env.LC_ALL = "C"; // stable, parseable messages
    env.LANG = "C";
    if (opts.optionalLocks === false) env.GIT_OPTIONAL_LOCKS = "0";
    const prefix: string[] = [];
    if (token) {
      env.GIT_ASKPASS = await this.ensureAskpass();
      env.ZNOTES_GIT_USERNAME = "x-access-token";
      env.ZNOTES_GIT_PASSWORD = token;
      // clear any configured helper (osxkeychain with a stale token would win
      // over askpass and make auth non-deterministic)
      prefix.push("-c", "credential.helper=");
    }

    const argv = ["git", ...prefix, ...args];
    this.log(`git ${[...prefix, ...args].join(" ")}`); // argv ONLY — env is never logged

    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(argv, {
        cwd: this.vault,
        env,
        stdin: opts.stdin != null ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (err) {
      return {
        code: 127,
        ok: false,
        stdout: "",
        stderr: String((err as Error)?.message || err),
        timedOut: false,
        missing: true,
      };
    }
    this.children.add(proc);
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      if (opts.stdin != null) {
        (proc.stdin as any).write(opts.stdin);
        await (proc.stdin as any).end();
      }
      /* Bun's `timeout` kills only the DIRECT child. git's transport helper
         (`git-remote-http`) is a grandchild that inherits these very pipes, so
         against a black-hole remote the reads below never resolve even after
         git is reaped — `git()` never returns, `inflight` never clears and
         every later sync joins the hang. So the reads are raced against our own
         deadline and abandoned on expiry. */
      const reads = Promise.all([
        new Response(proc.stdout as ReadableStream).text().catch(() => ""),
        new Response(proc.stderr as ReadableStream).text().catch(() => ""),
      ]);
      const expired = new Promise<null>((res) => {
        deadline = setTimeout(() => res(null), GIT_TIMEOUT_MS + 500);
        (deadline as any)?.unref?.();
      });
      const pipes = await Promise.race([reads, expired]);
      if (!pipes) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        return {
          code: -1,
          ok: false,
          stdout: "",
          stderr: `git ${args[0] ?? ""} timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)}s`.trim(),
          timedOut: true,
          missing: false,
        };
      }
      const [out, err] = pipes;
      const code = await proc.exited;
      /* NOT `proc.killed`: Bun 1.3.14 sets that to true for EVERY reaped child,
         including `exit 0` (measured). Reading it as "we killed it" turned an
         ordinary rejected push into a bogus 30s-timeout report and skipped the
         rebase retry entirely. The timeout kill is the pair
         exitCode === null + signalCode set. */
      const timedOut = proc.exitCode === null && proc.signalCode != null;
      return {
        code,
        ok: code === 0,
        stdout: scrub(out, token),
        stderr: scrub(err, token),
        timedOut,
        missing: false,
      };
    } finally {
      if (deadline) clearTimeout(deadline);
      this.children.delete(proc);
    }
  }

  /**
   * Transport options for the commands that talk to a remote: git aborts a
   * transfer that stalls below 1 byte/s, so a half-open connection cannot park
   * `git-remote-http` past our own deadline (that grandchild does not die with
   * its parent, and it is what holds the pipes open).
   */
  private transportOpts(): string[] {
    const stall = Math.max(5, Math.round(GIT_TIMEOUT_MS / 1000) - 5);
    return ["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${stall}`];
  }

  /* ============================================================
     observation (read-only)
     ============================================================ */

  private async detectRepo(): Promise<{ ok: boolean; reason: string }> {
    const r = await this.git(["rev-parse", "--show-toplevel"], { optionalLocks: false });
    if (r.missing) return { ok: false, reason: "git is not installed" };
    if (r.timedOut) return { ok: false, reason: "git timed out" };
    if (!r.ok || !r.stdout.trim()) return { ok: false, reason: "not a git repository" };
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    // NOT a substring test: an enclosing repo (the z-notes source tree around
    // ./vault) must read as "no repo", never as "this repo".
    if (real(r.stdout.trim()) !== real(this.vault)) return { ok: false, reason: "not a git repository" };
    return { ok: true, reason: "" };
  }

  private async observe(): Promise<Observation> {
    const configured = this.branchSetting();
    const base: Observation = {
      repo: false,
      reason: "not a git repository",
      branch: configured,
      detached: false,
      unborn: false,
      busy: null,
      conflicted: [],
      originUrl: null,
      remote: null,
      ahead: 0,
      behind: 0,
      pending: 0,
    };
    const det = await this.detectRepo();
    if (!det.ok) {
      this.lastOriginUrl = null;
      return { ...base, reason: det.reason };
    }

    const head = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { optionalLocks: false });
    const name = head.ok ? head.stdout.trim() : "";
    const unborn = !head.ok; // no commits yet: HEAD points at an unborn branch
    let branch = name && name !== "HEAD" ? name : configured;
    const detached = name === "HEAD";
    if (unborn) {
      // `git branch --show-current` still answers on an unborn HEAD
      const sc = await this.git(["branch", "--show-current"], { optionalLocks: false });
      if (sc.ok && sc.stdout.trim()) branch = sc.stdout.trim();
    }

    const origin = await this.git(["remote", "get-url", "origin"], { optionalLocks: false });
    const originUrl = origin.ok && origin.stdout.trim() ? origin.stdout.trim() : null;
    this.lastOriginUrl = originUrl;

    const busy = await this.inProgressOp();
    const conflicted = await this.conflictedPaths();

    let ahead = 0;
    let behind = 0;
    if (!unborn) {
      const rl = await this.git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
        optionalLocks: false,
      });
      if (rl.ok) {
        const [a, b] = rl.stdout.trim().split(/\s+/);
        ahead = Number(a) || 0;
        behind = Number(b) || 0;
      }
    }

    const st = await this.git(
      ["status", "--porcelain=v1", "-z", "-uall", "--", "*.md", ...TRACKED_META, ...TRACKED_META_DIR_SPECS],
      { optionalLocks: false }
    );
    /* porcelain=v1 -z entries are `XY<space>PATH`; a rename adds a bare second
       entry for the source, which the shape check skips. The pathspec cannot
       express "no dot-directories", so the visibility rule that scanDocs
       applies is re-applied here — otherwise an untracked `.obsidian/notes.md`
       (which this app will never commit) would sit in the statusbar as a
       pending change forever. */
    const pending = st.ok
      ? nulList(st.stdout).filter((e) => {
          if (!/^[ MADRCU?!][ MADRCU?!] /.test(e)) return false;
          const path = e.slice(3);
          if (TRACKED_META.includes(path) || inTrackedDir(path)) return true;
          return /\.md$/i.test(path) && !path.split("/").some((seg) => seg.startsWith("."));
        }).length
      : 0;

    return {
      repo: true,
      reason: "",
      branch,
      detached,
      unborn,
      busy,
      conflicted,
      originUrl,
      remote: originUrl ? sanitizeRemote(originUrl) : null,
      ahead,
      behind,
      pending,
    };
  }

  /** `<vault>/.git`, or wherever `.git` actually points (worktree, submodule). */
  private async gitDir(): Promise<string | null> {
    const g = await this.git(["rev-parse", "--git-dir"], { optionalLocks: false });
    if (!g.ok || !g.stdout.trim()) return null;
    return resolve(this.vault, g.stdout.trim());
  }

  /**
   * A merge/rebase/cherry-pick/revert the user started in the vault and has not
   * finished. The pipeline must not touch a repo in this state: `git add` over
   * the scanned `.md` set would mark conflicted paths RESOLVED with the
   * conflict-marker text as their content, and the commit that follows would
   * complete the user's merge and push the markers to every other device.
   */
  private async inProgressOp(): Promise<string | null> {
    const dir = await this.gitDir();
    if (!dir) return null;
    const marks: [string, string][] = [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ];
    for (const [file, label] of marks) {
      if (await Bun.file(resolve(dir, file)).exists()) return label;
    }
    // rebase state is a DIRECTORY, so `.exists()` (files only) would miss it
    for (const d of ["rebase-merge", "rebase-apply"]) {
      try {
        if ((await Bun.file(resolve(dir, d)).stat()).isDirectory()) return "rebase";
      } catch {}
    }
    return null;
  }

  private async conflictedPaths(): Promise<string[]> {
    const r = await this.git(["diff", "--name-only", "--diff-filter=U", "-z"], { optionalLocks: false });
    return r.ok ? nulList(r.stdout) : [];
  }

  /** The reason the vault cannot be synced right now, phrased for the user. */
  private blockedReason(obs: Observation): string | null {
    if (obs.busy || obs.conflicted.length) {
      const op = obs.busy ?? "conflict";
      const where = obs.conflicted.length ? ` (conflicts in ${listPaths(obs.conflicted)})` : "";
      return `a ${op} is in progress in the vault${where} — finish or abort it in the vault repo, then Sync now`;
    }
    if (obs.detached) {
      return `the vault is on a detached HEAD — check out "${this.branchSetting()}" in the vault repo, then Sync now`;
    }
    return null;
  }

  /** Observe and publish, without running the pipeline. Single-flight. */
  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const p = (async () => {
      const obs = await this.observe();
      this.observedAt = Date.now();
      if (!obs.repo) {
        this.publish(this.offlineStatus(obs));
        return;
      }
      /* a vault parked mid-merge or on a detached HEAD is not "synced": the
         pipeline will refuse to run, and the statusbar has to say so rather
         than claim success until someone happens to press Sync now */
      const blocked = this.blockedReason(obs);
      if (blocked) {
        this.fail(obs.branch, obs.remote, blocked);
        return;
      }
      /* An error state stands only while its CAUSE does. Blocked states above
         re-report themselves each pass; an error whose cause the observation
         can no longer see (a conflict resolved in the vault, a network that
         healed enough for read-only git) used to LATCH — refresh() republished
         it untouched, and only a write or a manual Sync now could clear it, so
         the statusbar stayed red over a repo that was fine. Push failures are
         not observable read-only, so an error with commits still ahead is kept
         rather than painted over; a clean, unblocked repo is not an error. */
      if (this.current.state === "error" && obs.ahead > 0) {
        this.publish({ ...this.current, branch: obs.branch, remote: obs.remote, ahead: obs.ahead, behind: obs.behind });
        return;
      }
      this.publish(this.describe(obs));
    })();
    this.refreshing = p;
    try {
      await p;
    } finally {
      this.refreshing = null;
    }
  }

  /* ============================================================
     status shaping
     ============================================================ */

  private describe(obs: Observation, extra?: string): SyncStatus {
    const lastSyncAt = this.deps.index.getMeta("git.lastSyncAt");
    const parts: string[] = [];
    if (extra) parts.push(extra);
    if (obs.ahead || obs.behind) {
      if (obs.ahead) parts.push(`ahead ${obs.ahead}`);
      if (obs.behind) parts.push(`behind ${obs.behind}`);
    } else if (!extra) {
      parts.push(lastSyncAt ? `synced ${relTime(lastSyncAt)}` : "synced");
    }
    if (obs.pending) parts.push(`${obs.pending} pending`);
    if (obs.detached) parts.push("detached HEAD");
    // remote LAST: the statusbar chip renders message.replace(" · " + remote, "")
    parts.push(obs.remote ? obs.remote : "local only");
    return {
      state: "synced",
      branch: obs.branch,
      remote: obs.remote,
      lastSyncAt,
      ahead: obs.ahead,
      behind: obs.behind,
      message: parts.join(" · "),
    };
  }

  private publish(next: SyncStatus) {
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (changed) this.deps.onStatus?.({ ...next });
  }

  /* ============================================================
     the pipeline
     ============================================================ */

  private async execute(kind: Trigger): Promise<void> {
    const token = this.deps.settings.credential("git.token");

    this.publish({
      ...this.current,
      state: "syncing",
      message: this.current.remote ? `syncing… · ${this.current.remote}` : "syncing…",
    });

    let obs: Observation;
    try {
      obs = await this.observe();
    } catch (err) {
      this.fail(this.branchSetting(), null, `sync failed: ${String((err as Error)?.message || err)}`);
      return;
    }
    this.observedAt = Date.now();

    if (!obs.repo) {
      this.publish(this.offlineStatus(obs));
      return;
    }

    const guard = await this.writeGuards(obs);
    if (guard) {
      this.fail(obs.branch, obs.remote, guard);
      return;
    }

    /* ---------- stage ---------- */
    const staged = await this.stage(obs.unborn);
    if (!staged.ok) {
      this.fail(obs.branch, obs.remote, staged.message);
      return;
    }

    /* ---------- commit ---------- */
    if (staged.paths.length) {
      const commit = await this.commit(staged.paths);
      if (!commit.ok) {
        this.fail(obs.branch, obs.remote, commit.message);
        return;
      }
      obs.unborn = false;
    }

    /* ---------- push ---------- */
    // literal reading of the policy: auto-sync pushes only while auto-sync is
    // on; an explicit "Sync now" always pushes.
    const mayPush = !!obs.originUrl && (kind === "manual" || this.autoSyncOn());
    if (mayPush && !obs.unborn) {
      /* SPEC §7 / API.md: "push to the configured branch". The checked-out
         branch is what actually gets pushed, so if the two disagree the push
         would send a DIFFERENT branch's commits under a "synced" banner. The
         work is committed locally either way; only the push waits. */
      const configured = this.branchSetting();
      if (obs.branch !== configured) {
        this.fail(
          obs.branch,
          obs.remote,
          `the vault is on branch "${obs.branch}" but git.branch is "${configured}" — committed locally, not pushed`
        );
        return;
      }
      const pushed = await this.pushWithRebaseRetry(obs, token);
      if (!pushed.ok) {
        this.fail(obs.branch, obs.remote, pushed.message);
        return;
      }
    }

    /* ---------- re-observe and publish ---------- */
    const after = await this.observe();
    this.observedAt = Date.now();
    if (!after.repo) {
      this.publish(this.offlineStatus(after));
      return;
    }
    const at = new Date().toISOString();
    this.deps.index.setMeta("git.lastSyncAt", at);
    this.publish(this.describe(after));
  }

  /**
   * Every reason NOT to write to this repo, in order — shared verbatim by the
   * sync pipeline and commitPaths, which used to carry its own copy.
   *
   * Why each: staging over a conflicted index marks every conflicted path
   * RESOLVED with its `<<<<<<<` marker text as the content, and the commit
   * would finish the user's merge and push the corruption (SPEC §7: the app
   * never auto-resolves and never destroys either side). A detached HEAD is
   * refused too — commits made there are pushed nowhere and vanish on the next
   * checkout. Then the three canaries: a tracked index.db (the credential
   * store), a credential in settings.toml, and a half-replaced keyring.
   */
  private async writeGuards(obs: Observation): Promise<string | null> {
    const blocked = this.blockedReason(obs);
    if (blocked) return blocked;
    await this.ensureExcludes();
    return (await this.guardIndexDb()) ?? (await this.settingsCanary()) ?? (await this.keyringCanary());
  }

  /** The `offline` status shape, spelled once. */
  private offlineStatus(obs: { branch: string; reason: string }): SyncStatus {
    const failed = this.lastAttachFailure;
    return {
      state: "offline",
      branch: obs.branch,
      remote: null,
      lastSyncAt: this.deps.index.getMeta("git.lastSyncAt"),
      ahead: 0,
      behind: 0,
      message: (failed ? `${obs.reason} — attach failed: ${failed}` : obs.reason).slice(0, MESSAGE_MAX),
    };
  }

  private fail(branch: string, remote: string | null, message: string) {
    this.publish({
      state: "error",
      branch,
      remote,
      lastSyncAt: this.deps.index.getMeta("git.lastSyncAt"),
      ahead: this.current.ahead,
      behind: this.current.behind,
      message: this.cleanMessage(message),
    });
  }

  /**
   * `message` is published verbatim by `GET /api/sync/status`, by every
   * `sync-status` SSE frame and in the statusbar chip's tooltip, so anything
   * git said has to be reduced the same way `remote` is: no raw origin URL, no
   * userinfo, no absolute filesystem paths, bounded length.
   */
  private cleanMessage(message: string): string {
    let s = String(message || "");
    const origin = this.lastOriginUrl;
    if (origin) s = s.split(origin).join(sanitizeRemote(origin) ?? "origin");
    // any scheme://…@ that survived (a remote configured outside the app)
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*@/gi, "");
    for (const root of new Set([this.vault, this.vaultReal])) {
      s = s.split(root + "/").join("").split(root).join("the vault");
    }
    return s.slice(0, MESSAGE_MAX);
  }

  /**
   * z-notes' ignore rules go in `.git/info/exclude`, appended idempotently
   * under a marked header. A working-tree `.gitignore` was wrong twice over: it
   * was skipped entirely whenever the user already had one (so `.znotes/index.db`
   * — the credential store — was left committable by a plain `git add -A`), and
   * as an untracked file this app never stages it wedged `pull --rebase` forever
   * the moment any other device committed one.
   */
  private async ensureExcludes(): Promise<void> {
    const dir = await this.gitDir();
    if (!dir) return;
    const target = resolve(dir, "info", "exclude");
    const file = Bun.file(target);
    const text = (await file.exists()) ? await file.text() : "";
    const have = new Set(text.split("\n").map((l) => l.trim()));
    const missing = EXCLUDE_RULES.filter((r) => !have.has(r));
    if (!missing.length) return;
    await mkdir(resolve(dir, "info"), { recursive: true });
    const head = text && !text.endsWith("\n") ? text + "\n" : text;
    await Bun.write(target, `${head}${EXCLUDE_HEADER}\n${missing.join("\n")}\n`);
  }

  /**
   * The sqlite index holds the GitHub token and the AI key (SPEC §7), so it may
   * never be committed. Untrack it if some earlier `git add -A` caught it, and
   * stop the pipeline outright if git still does not consider it ignored —
   * pushing that file is not a failure worth recovering from afterwards.
   */
  private async guardIndexDb(): Promise<string | null> {
    const tracked = await this.git(["ls-files", "-z", "--", ...NEVER_COMMIT], { optionalLocks: false });
    const hits = tracked.ok ? nulList(tracked.stdout) : [];
    if (hits.length) {
      const rm = await this.git(["rm", "--cached", "--ignore-unmatch", "-q", "--", ...hits]);
      if (!rm.ok) {
        return `the sqlite credential store is tracked by git (${listPaths(hits)}) and could not be untracked — run \`git rm --cached\` in the vault repo`;
      }
    }
    const chk = await this.git(["check-ignore", "-q", "--", NEVER_COMMIT[0]], { optionalLocks: false });
    if (!chk.ok) {
      return `${NEVER_COMMIT[0]} is not ignored by git — sync stopped so the credential store is never committed`;
    }
    return null;
  }

  /**
   * settings.toml is committed and hand-editable, so a token pasted into it
   * while the server is up would be staged and pushed in plaintext (the
   * boot-time absorb only runs at boot; nothing watches the file). Move any
   * credential in it back into sqlite before staging, and refuse to stage the
   * file at all if one is somehow still there.
   */
  private async settingsCanary(): Promise<string | null> {
    const path = TRACKED_META[0];
    const file = Bun.file(resolve(this.vault, path));
    if (!(await file.exists())) return null;
    const carries = async () => CREDENTIAL_KEY_RE.test(await file.text());
    if (!(await carries())) return null;
    await this.deps.settings.absorbFileCredentials?.();
    if (!(await carries())) return null;
    return `${path} carries a credential in plaintext — sync stopped so it is never committed; remove the token/apiKey/password line and re-enter it in Settings`;
  }

  /**
   * The keyring, mid-replace. `writeVaultKeys` parks the old identity at
   * `identity.age.prev` (excluded from git by design — it is local crash
   * recovery, not part of the committed keyring) and a crash between its two
   * renames leaves `identity.age` GONE with the stash as the only copy of the
   * key. Staging then does the one thing that must not happen: it commits and
   * pushes the DELETION of the identity while the file that undoes it is
   * unpushable, so every other clone loses the key too.
   *
   * So sync stops until the keyring is whole again, and says which file to
   * rename back. Both files present, or neither, is not this state and syncs
   * normally.
   */
  private async keyringCanary(): Promise<string | null> {
    const prev = ".znotes/identity.age.prev";
    if (!(await Bun.file(resolve(this.vault, prev)).exists())) return null;
    if (await Bun.file(resolve(this.vault, ".znotes/identity.age")).exists()) return null;
    return `${prev} is present but .znotes/identity.age is missing — a passphrase change was interrupted and that stash is the only copy of the vault key. Sync stopped so the deletion is not committed; rename ${prev} back to .znotes/identity.age`;
  }

  /**
   * Stage exactly the tracked set: every `.md` the vault scanner can see, plus
   * the three `.znotes` files, plus anything already tracked that matches —
   * the last part is what stages DELETIONS (a path gone from disk is not in the
   * scan, so without it `git add -A` would never notice it left).
   *
   * Pathspecs go in over stdin (`--pathspec-from-file=-`), so a vault with
   * thousands of notes cannot overflow argv, and `:(literal)` means a note
   * called `report[2].md` is a filename, not a glob.
   */
  private async stage(unborn: boolean): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
    let disk: string[] = [];
    try {
      disk = await this.vaultHandle.scanDocs();
    } catch (err) {
      return { ok: false, message: `cannot scan the vault: ${String((err as Error)?.message || err)}` };
    }
    const set = new Set<string>(disk);

    const tracked = await this.git(["ls-files", "-z"], { optionalLocks: false });
    const trackedSet = new Set<string>(tracked.ok ? nulList(tracked.stdout) : []);
    for (const p of trackedSet) {
      if (/\.md$/i.test(p) || TRACKED_META.includes(p) || inTrackedDir(p)) set.add(p);
    }
    for (const p of TRACKED_META) {
      if (await Bun.file(resolve(this.vault, p)).exists()) set.add(p);
    }
    /* The trash, whatever is in it right now. The targeted `commitPaths` above
       already commits each delete/restore/purge as it happens, so this is the
       repair path: an entry that arrived on a pull, or one whose own commit was
       skipped (mid-merge, no repo yet) would otherwise sit in `observe()`'s
       pending count forever with nothing able to stage it — the `-uall` status
       pathspec sees these files and the `.md`-only allowlist never did. */
    for (const p of await this.trashPaths()) set.add(p);

    /* `git add` EXITS 1 when an explicitly named pathspec is ignored, and these
       pathspecs are all explicit — so one `archive/` line in the user's own
       .gitignore used to fail the add and wedge the pipeline permanently, with
       nothing ever committed again. Ignore rules do not apply to paths that are
       already tracked, so only untracked ones are filtered out. */
    const untracked = [...set].filter((p) => !trackedSet.has(p));
    if (untracked.length) {
      const chk = await this.git(["check-ignore", "-z", "--stdin"], { stdin: untracked.join("\0") });
      for (const p of nulList(chk.stdout)) set.delete(p);
    }
    if (!set.size) return { ok: true, paths: [] };

    const specs = [...set].map((p) => `:(literal)${p}`).join("\0");
    const add = await this.git(["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      stdin: specs,
    });
    if (!add.ok) {
      return { ok: false, message: gitMessage(add.stderr, add.stdout, `git add failed (exit ${add.code})`) };
    }

    const listed = unborn
      ? await this.git(["ls-files", "--cached", "-z"], { optionalLocks: false })
      : await this.git(["diff", "--cached", "--name-only", "-z"], { optionalLocks: false });
    if (!listed.ok) {
      return { ok: false, message: gitMessage(listed.stderr, listed.stdout, "could not read the staged set") };
    }
    return { ok: true, paths: nulList(listed.stdout).sort() };
  }

  /** Never fatal: a trash that cannot be walked must not wedge the pipeline. */
  private async trashPaths(): Promise<string[]> {
    try {
      return await trashGitPaths(this.vault);
    } catch {
      return [];
    }
  }

  private async commit(paths: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
    const shown = paths.slice(0, 3).join(", ");
    const more = paths.length > 3 ? `, +${paths.length - 3} more` : "";
    const message = `sync: ${new Date().toISOString()} · ${paths.length} file(s): ${shown}${more}`.slice(0, 400);

    const prefix: string[] = ["-c", "commit.gpgsign=false"]; // a pinentry prompt would hang the daemon
    const email = await this.git(["config", "--get", "user.email"], { optionalLocks: false });
    if (!email.ok || !email.stdout.trim()) {
      prefix.push("-c", "user.name=z-notes", "-c", "user.email=z-notes@localhost");
    }
    /* Deliberately a bare index commit, NOT `--only <paths>`: the pipeline's
       contract is "the staged set IS the commit", and two of its own staged
       changes are ones `--only` cannot express — guardIndexDb's `rm --cached`
       repair (a staged REMOVAL of a file still on disk; `--only` would commit
       the working-tree file right back) and the alias-rename respell. The cost
       is that anything the user staged by hand rides along under the sync
       message; the untrack-in-place repair the tests pin depends on exactly
       that sweep. */
    const r = await this.git([...prefix, "commit", "--no-verify", "-m", message]);
    if (r.ok) return { ok: true };
    // a hook or a race can leave nothing to commit — not an error
    if (/nothing to commit|no changes added/i.test(r.stdout + r.stderr)) return { ok: true };
    return { ok: false, message: gitMessage(r.stderr, r.stdout, `git commit failed (exit ${r.code})`) };
  }

  /* ============================================================
     targeted commit — one commit per accepted AI proposal (SPEC §8, phase 4)
     and per file op (SPEC §3 delta 2, phase 5)
     ============================================================ */

  /**
   * Commit exactly `paths` with exactly `message`, then let the ordinary
   * debounced pipeline push it. This is the ONLY entry point that bypasses the
   * generated sync message, and it deliberately reuses every guard the pipeline
   * has: a repo the user is mid-merge in, a tracked `index.db`, a credential
   * pasted into settings.toml — each of those stops this too, because an AI
   * commit is not more important than not corrupting the vault.
   *
   * A vault that is not a git repository is NOT a failure: SPEC §8 says accept
   * still applies the edit, the commit is simply skipped and the reason is
   * recorded on the proposal. So the return value is advisory, never fatal.
   *
   * Phase 5 reuses this verbatim for `move: a → b` and `delete: p`, which is
   * why a rename plus every backlink it rewrote lands as ONE commit (SPEC §5).
   * `paths` there names the old path as well as the new one: since git 2.0 a
   * bare `git add <path>` stages a REMOVAL too, so a vanished path belongs in
   * the list — leaving it out would commit the copy and never the delete, and
   * `git log` would show an add where the vault saw a rename.
   */
  async commitPaths(
    paths: string[],
    message: string
  ): Promise<{ committed: boolean; sha: string | null; reason: string }> {
    /* Under the same writer lock as the pipeline: this method mutates the git
       index (`rm --cached`, `add`, `commit`) and used to run concurrently with
       a debounced sync doing the same — two writers, one index. */
    return this.withIndexLock(() => this.commitPathsLocked(paths, message));
  }

  private async commitPathsLocked(
    paths: string[],
    message: string
  ): Promise<{ committed: boolean; sha: string | null; reason: string }> {
    const skip = (reason: string) => ({ committed: false, sha: null, reason });
    if (this.stopped) return skip("server is shutting down");
    const wanted = [...new Set(paths.filter(Boolean))];
    if (!wanted.length) return skip("nothing to commit");

    let obs: Observation;
    try {
      obs = await this.observe();
    } catch (err) {
      return skip(`could not read the vault repo: ${String((err as Error)?.message || err)}`);
    }
    this.observedAt = Date.now();
    if (!obs.repo) return skip(obs.reason);

    const guard = await this.writeGuards(obs);
    if (guard) return skip(guard);

    /* an explicit pathspec that git ignores makes `add` exit 1 — the same trap
       the bulk stage() defends against, and the same fix */
    const tracked = await this.git(["ls-files", "-z", "--", ...wanted], { optionalLocks: false });
    const trackedSet = new Set(tracked.ok ? nulList(tracked.stdout) : []);
    const untracked = wanted.filter((p) => !trackedSet.has(p));
    const set = new Set(wanted);
    if (untracked.length) {
      const chk = await this.git(["check-ignore", "-z", "--stdin"], { stdin: untracked.join("\0") });
      for (const p of nulList(chk.stdout)) set.delete(p);
    }
    /* A pathspec that is neither on disk NOR in the index is one git can do
       nothing with — and `git add` EXITS 1 on it (`fatal: pathspec 'x' did not
       match any files`), taking every OTHER path in the same commit down with
       it. Two ordinary shapes hit this: a doc created and deleted between two
       syncs (so it was never committed and is now gone), and a trash entry
       purged before its own delete commit had landed. MEASURED: one such path
       turned `delete: a.md` and a two-entry retention purge into silent
       no-commits, leaving the worktree deletions permanently unstaged. */
    for (const p of [...set]) {
      if (trackedSet.has(p)) continue;
      if (!(await Bun.file(resolve(this.vault, p)).exists())) set.delete(p);
    }
    if (!set.size) return skip("nothing git can stage: every path is ignored, or absent and untracked");

    /* ALIAS RENAME (`Foo.md` → `foo.md`, or NFC → NFD). On macOS
       (core.ignorecase=true, the default) the new spelling never enters the
       index by itself: `git add` folds it onto the old entry, and
       `commit --only` then dies on `pathspec 'A.md' did not match any file(s)
       known to git` / `will not add file alias`. The rename was silently never
       committed — a fresh or case-sensitive clone kept the OLD name while every
       rewritten backlink pointed at the new one. Re-spell the index entry by
       hand (`rm --cached` old, then `add` new) and commit the index rather than
       `--only`, which cannot express the swap at all. */
    const aliases = await this.aliasRenames(wanted, trackedSet);
    for (const [oldSpelling] of aliases) {
      const rmc = await this.git(["rm", "--cached", "-q", "--ignore-unmatch", "--", oldSpelling]);
      if (!rmc.ok) {
        return skip(this.cleanMessage(gitMessage(rmc.stderr, rmc.stdout, `git rm --cached failed (exit ${rmc.code})`)));
      }
    }
    const oldSpellings = new Set(aliases.map(([o]) => o));
    // adding the old spelling back would just re-create the alias git refuses
    const specs = [...set].filter((p) => !oldSpellings.has(p));
    const add = await this.git(["add", "--", ...specs]);
    if (!add.ok) {
      return skip(this.cleanMessage(gitMessage(add.stderr, add.stdout, `git add failed (exit ${add.code})`)));
    }

    const prefix: string[] = ["-c", "commit.gpgsign=false"];
    const email = await this.git(["config", "--get", "user.email"], { optionalLocks: false });
    if (!email.ok || !email.stdout.trim()) {
      prefix.push("-c", "user.name=z-notes", "-c", "user.email=z-notes@localhost");
    }
    /* `--only <paths>` so an unrelated staged change cannot ride along: the
       promise "one commit per proposal" has to be literally true for
       `git revert <sha>` to be a clean inverse (research §5). An alias rename
       is the one shape `--only` cannot commit, so there we fall back to an
       index commit — and only after checking the index holds nothing else, so
       the one-commit promise still holds literally. */
    let scope = ["--only", "-m", message, "--", ...specs];
    if (aliases.length) {
      const staged = await this.git(["diff", "--cached", "--name-only", "-z"], { optionalLocks: false });
      const extra = (staged.ok ? nulList(staged.stdout) : []).filter((p) => !set.has(p) && !oldSpellings.has(p));
      if (extra.length) {
        return skip(
          `${aliases[0][0]} → ${aliases[0][1]} is a case-only rename and the git index already holds unrelated staged changes (${extra
            .slice(0, 3)
            .join(", ")}) — commit or reset them in the vault repo, then Sync now`
        );
      }
      scope = ["-m", message];
    }
    const r = await this.git([...prefix, "commit", "--no-verify", ...scope]);
    if (!r.ok) {
      if (/nothing to commit|no changes added/i.test(r.stdout + r.stderr)) return skip("nothing to commit");
      return skip(this.cleanMessage(gitMessage(r.stderr, r.stdout, `git commit failed (exit ${r.code})`)));
    }

    const head = await this.git(["rev-parse", "HEAD"], { optionalLocks: false });
    const sha = head.ok ? head.stdout.trim() || null : null;
    // the commit exists locally; pushing it is the ordinary debounced pipeline's job
    this.schedule();
    return { committed: true, sha, reason: "" };
  }

  /**
   * Pairs of `[oldSpelling, newSpelling]` in `wanted` that name the SAME file
   * under a case-insensitive / unicode-normalising filesystem: the old one is
   * in the index, the new one is not, and the two differ only by case or by
   * NFC/NFD. Empty on Linux and for every ordinary move.
   */
  private async aliasRenames(wanted: string[], trackedSet: Set<string>): Promise<Array<[string, string]>> {
    const key = (p: string) => p.normalize("NFC").toLowerCase();
    const byKey = new Map<string, string>();
    for (const p of wanted) if (trackedSet.has(p)) byKey.set(key(p), p);
    const out: Array<[string, string]> = [];
    for (const p of wanted) {
      if (trackedSet.has(p)) continue;
      const old = byKey.get(key(p));
      if (!old || old === p) continue;
      /* The filesystem gets the casting vote: only where the OLD spelling still
         resolves after the rename do the two names share an inode, which is the
         whole reason git cannot tell them apart. On a case-sensitive
         filesystem this is an ordinary rename and the `--only` path handles it. */
      if (await Bun.file(resolve(this.vault, old)).exists()) out.push([old, p]);
    }
    return out;
  }

  private async hasUpstream(): Promise<boolean> {
    const r = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      optionalLocks: false,
    });
    return r.ok && !!r.stdout.trim();
  }

  private async rebaseInProgress(): Promise<boolean> {
    const g = await this.git(["rev-parse", "--git-dir"], { optionalLocks: false });
    if (!g.ok) return false;
    const dir = resolve(this.vault, g.stdout.trim());
    for (const d of ["rebase-merge", "rebase-apply"]) {
      try {
        if ((await Bun.file(resolve(dir, d)).stat()).isDirectory()) return true;
      } catch {}
    }
    return false;
  }

  private async push(branch: string, token: string | null): Promise<GitResult> {
    const setUpstream = !(await this.hasUpstream());
    const args = [...this.transportOpts(), "push", "--no-verify"];
    if (setUpstream) args.push("--set-upstream");
    args.push("origin", branch);
    return this.git(args, { token });
  }

  /**
   * Tracked paths carrying changes this pipeline did not just commit — an image
   * attachment, a README, anything outside the `*.md` + TRACKED_META allowlist.
   * `pull --rebase` refuses to run with those present (autostash is deliberately
   * off), and `rebase --abort` would hard-reset them away, so the rebase retry
   * must not even be attempted: say which files, and let the user decide.
   */
  private async dirtyOutsideAllowlist(): Promise<string[]> {
    const st = await this.git(["status", "--porcelain=v1", "-z", "-uno"], { optionalLocks: false });
    if (!st.ok) return [];
    return nulList(st.stdout)
      .filter((e) => /^[ MADRCU?!][ MADRCU?!] /.test(e))
      .map((e) => e.slice(3))
      .filter(Boolean);
  }

  /**
   * Push; if the remote moved on (non-fast-forward), rebase our commits on top
   * and push again. A REAL conflict aborts the rebase — the working tree goes
   * back exactly as it was, the remote is untouched, editing keeps working, and
   * the state goes to `error` naming the files. Nothing is auto-resolved and
   * neither side is destroyed; the user fixes it in the vault repo and hits
   * "Sync now", which re-runs this from scratch.
   */
  private async pushWithRebaseRetry(
    obs: Observation,
    token: string | null
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const first = await this.push(obs.branch, token);
    if (first.ok) return { ok: true };
    if (first.timedOut) {
      return { ok: false, message: `push timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)}s` };
    }

    const blob = first.stdout + "\n" + first.stderr;
    const rejected = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected|behind its remote/i.test(blob);
    if (!rejected) {
      return { ok: false, message: gitMessage(first.stderr, first.stdout, `git push failed (exit ${first.code})`) };
    }

    /* everything the app owns is committed by now, so anything still dirty is
       the user's — and a rebase would either refuse to start or, on abort,
       hard-reset it out of existence */
    const dirty = await this.dirtyOutsideAllowlist();
    if (dirty.length) {
      return {
        ok: false,
        message: `origin has moved on, but uncommitted changes in ${listPaths(dirty)} block the rebase — commit or stash them in the vault repo, then Sync now`,
      };
    }

    /* only ever abort a rebase THIS call started (execute() refuses to run at
       all while one is already underway, but the check is cheap and the
       consequence of getting it wrong is a hard reset of the user's tree) */
    const rebaseWasRunning = await this.rebaseInProgress();
    const pull = await this.git(
      [...this.transportOpts(), "-c", "rebase.autoStash=false", "pull", "--rebase", "origin", obs.branch],
      { token }
    );
    if (!pull.ok) {
      const files = await this.conflictedPaths();
      let aborted = true;
      if (!rebaseWasRunning && (await this.rebaseInProgress())) {
        const ab = await this.git(["rebase", "--abort"]);
        aborted = ab.ok || !(await this.rebaseInProgress());
      }
      if (files.length) {
        const shown = listPaths(files);
        return {
          ok: false,
          message: aborted
            ? `rebase conflict in ${shown} — rebase aborted, resolve in the vault repo then Sync now`
            : `rebase conflict in ${shown} — COULD NOT abort the rebase, resolve in the vault repo`,
        };
      }
      return {
        ok: false,
        message: gitMessage(pull.stderr, pull.stdout, `git pull --rebase failed (exit ${pull.code})`),
      };
    }

    const second = await this.push(obs.branch, token);
    if (second.ok) return { ok: true };
    return {
      ok: false,
      message: gitMessage(second.stderr, second.stdout, `git push failed after rebase (exit ${second.code})`),
    };
  }

  /* ============================================================
     attach — connect the vault to a remote repository (ADR 0017)
     ============================================================ */

  /**
   * Is the vault its own repository, and — sanitized, never the raw URL — what
   * does its origin point at? The minimal observation boot provisioning needs
   * to decide whether `ZNOTES_VAULT_REPO` has anything to do. Read-only, and
   * outside the writer lock like every other observation.
   */
  async attachment(): Promise<{ repo: boolean; remote: string | null }> {
    if (!(await this.detectRepo()).ok) return { repo: false, remote: null };
    const origin = await this.git(["remote", "get-url", "origin"], { optionalLocks: false });
    const url = origin.ok ? origin.stdout.trim() : "";
    return { repo: true, remote: url ? sanitizeRemote(url) : null };
  }

  /**
   * Connect the vault directory to a remote repository — the operation behind
   * `POST /api/sync/remote` and `ZNOTES_VAULT_REPO` (spec 0007, ADR 0017), and
   * THE ONE PLACE IN THIS SERVER THAT MAY `git init`.
   *
   * Non-destructive and atomic. It never writes over a working-tree file: a
   * checkout that would is refused, naming the paths. And every failure leaves
   * the vault exactly as it was found — the `.git` this call created is deleted
   * again, or the origin it replaced is put back — so a bad URL, an unreachable
   * host or a wrong token costs the user nothing but the message.
   *
   * Under the writer lock like `commitPaths`: this moves refs, the index and
   * (case B) HEAD, and a debounced sync landing in the middle of it is the same
   * two-writers-one-index race the lock was introduced for.
   */
  async attachRemote(url: string): Promise<AttachResult> {
    const r = await this.withIndexLock(() => this.attachLocked(url));
    this.lastAttachFailure = r.ok ? null : r.body.message;
    return r;
  }

  private async attachLocked(url: string): Promise<AttachResult> {
    const target = validRemoteUrl(url);
    if (!target) {
      return attachError(
        400,
        "bad-url",
        "A remote must be an https://, http:// or file:// URL, or an absolute path, and must not carry a username or password."
      );
    }
    if (this.stopped) return attachError(409, "vault-busy", "the server is shutting down");

    const token = this.deps.settings.credential("git.token");
    let obs: Observation;
    try {
      obs = await this.observe();
    } catch (err) {
      return attachError(
        502,
        "attach-failed",
        this.cleanMessage(`could not read the vault repo: ${String((err as Error)?.message || err)}`)
      );
    }
    this.observedAt = Date.now();
    return obs.repo ? this.attachToRepo(obs, target, token) : this.attachByInit(target, token);
  }

  /**
   * Case A — the vault is already its own repo, so attach is only ever "set
   * origin, and prove it". The working tree is never touched and nothing is
   * ever checked out: the user's repo is theirs, and the branch they have out
   * is the one we adopt.
   */
  private async attachToRepo(obs: Observation, target: string, token: string | null): Promise<AttachResult> {
    const blocked = this.blockedReason(obs);
    if (blocked) return attachError(409, "vault-busy", blocked);

    const previous = obs.originUrl;
    if (previous !== target) {
      const set = await this.git(["remote", previous ? "set-url" : "add", "origin", target]);
      if (!set.ok) {
        return attachError(502, "attach-failed", this.attachMessage(set, `git remote failed (exit ${set.code})`, target));
      }
    }

    const fetched = await this.git([...this.transportOpts(), "fetch", "origin"], { token });
    if (!fetched.ok) {
      // the origin we replaced goes back: a failed attach changes nothing
      if (previous !== target) {
        await this.git(previous ? ["remote", "set-url", "origin", previous] : ["remote", "remove", "origin"]);
      }
      return attachError(502, "attach-failed", this.attachMessage(fetched, `git fetch failed (exit ${fetched.code})`, target));
    }

    /* The checked-out branch becomes `git.branch` (the route persists it). The
       pipeline refuses to push while the two disagree ("committed locally, not
       pushed"), so a brought `master`-headed repo would otherwise meet that
       refusal on its very first sync. A detached HEAD never reaches here —
       blockedReason refused it above — and an unborn HEAD still reports the
       name it will be born under, which is the name a push would use. */
    const branch = validBranchName(obs.branch) ? obs.branch : this.branchSetting();
    return { ok: true, branch, created: previous === target ? "none" : "origin" };
  }

  /**
   * Case B — the vault is not a repository (including a vault nested inside
   * someone else's checkout, which `detectRepo` reports as exactly that). Init,
   * point it at the remote, fetch, check out the remote's default branch.
   *
   * From the init on, EVERY failure rolls back by deleting the `<vault>/.git`
   * this call created and nothing else: the notes, `.znotes/` and the sqlite
   * credential store are never touched, so a failed attach is invisible apart
   * from its message.
   */
  private async attachByInit(target: string, token: string | null): Promise<AttachResult> {
    const dotGit = resolve(this.vault, ".git");
    /* Rollback deletes `<vault>/.git`, so this call has to be what created it.
       A `.git` already sitting there while `detectRepo` says "not a repository"
       is broken or foreign, and destroying it is not attach's call to make. */
    if (existsSync(dotGit)) {
      return attachError(
        409,
        "vault-busy",
        "the vault holds a .git that git cannot read as its own repository — repair or remove it in the vault, then attach again"
      );
    }
    const rollback = () => rm(dotGit, { recursive: true, force: true }).catch(() => {});
    const undo = async (r: GitResult, fallback: string): Promise<AttachResult> => {
      await rollback();
      return attachError(502, "attach-failed", this.attachMessage(r, fallback, target));
    };

    const init = await this.git(["init", `--initial-branch=${this.branchSetting()}`]);
    if (!init.ok) return undo(init, `git init failed (exit ${init.code})`);

    const add = await this.git(["remote", "add", "origin", target]);
    if (!add.ok) return undo(add, `git remote add failed (exit ${add.code})`);

    // the exclude rules exist BEFORE anything can be staged: the sqlite index is
    // the credential store and must never be committable (SPEC §5/§7)
    await this.ensureExcludes();

    const fetched = await this.git([...this.transportOpts(), "fetch", "origin"], { token });
    if (!fetched.ok) return undo(fetched, `git fetch failed (exit ${fetched.code})`);

    /* The remote's default branch rather than ours, for the reason case A
       adopts the checked-out one: the pipeline will not push while the branch
       and `git.branch` disagree. A name arriving over the network reaches an
       argv, so it is held to exactly the rule `git.branch` is held to. */
    const ls = await this.git([...this.transportOpts(), "ls-remote", "--symref", "origin", "HEAD"], { token });
    if (!ls.ok) return undo(ls, `git ls-remote failed (exit ${ls.code})`);
    const named = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(ls.stdout)?.[1] ?? "";
    const branch = named || this.branchSetting();
    if (!validBranchName(branch)) {
      await rollback();
      return attachError(502, "attach-failed", `the remote's default branch is not a usable branch name: ${branch.slice(0, 80)}`);
    }

    /* An EMPTY remote has nothing to check out (and no symref to read): the
       local branch stays unborn, and the first sync commits it and pushes with
       --set-upstream — all ordinary pipeline behavior. */
    const known = await this.git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`], {
      optionalLocks: false,
    });
    if (!known.ok) return { ok: true, branch, created: "repo" };

    const co = await this.checkout(branch);
    if (!co.ok) {
      /* The one refusal that is not a failure: git would have overwritten local
         files with the remote's copies. Attach never destroys a byte, so it
         rolls back and hands the paths to the user instead. Local files that do
         NOT collide simply stay untracked, for the next sync to stage. */
      await rollback();
      if (co.paths.length) {
        return attachError(
          409,
          "checkout-conflict",
          `the remote's copy of ${listPaths(co.paths)} would overwrite ${co.paths.length > 1 ? "files" : "a file"} in the vault — move, remove or merge ${co.paths.length > 1 ? "them" : "it"} by hand, then attach again`,
          co.paths
        );
      }
      return attachError(502, "attach-failed", this.attachMessage(co.result, `git checkout failed (exit ${co.result.code})`, target));
    }
    return { ok: true, branch, created: "repo" };
  }

  /**
   * The checkout that brings the remote's docs into the vault, with ONE
   * exception carved out of "attach never writes over a local file": the
   * `settings.toml` THIS SERVER manufactured seconds ago.
   *
   * `Settings.load()` writes that file at boot whether or not anyone asked for
   * it, and it is in TRACKED_META — so a real vault repo, which commits its
   * own, collides with it EVERY time and the headline case (empty PVC +
   * ZNOTES_VAULT_REPO) could never succeed. The bytes are still not destroyed:
   * the local copy is parked under `.znotes/tmp/` (git-excluded, this app's
   * scratch) and put back if the retry fails, so the vault is byte-identical
   * whichever way it ends.
   *
   * The keyring is deliberately NOT in the exception. A local `identity.age`
   * losing to a remote one is a lost vault key, and that must be refused.
   */
  private async checkout(branch: string): Promise<{ ok: true } | { ok: false; paths: string[]; result: GitResult }> {
    const args = ["checkout", "-b", branch, `origin/${branch}`];
    let co = await this.git(args);
    if (co.ok) return { ok: true };

    const restore = await this.parkLocalSettings(overwrittenPaths(co.stderr));
    if (restore) {
      co = await this.git(args);
      if (co.ok) {
        this.log(`attach: ${TRACKED_META[0]} replaced by the remote's copy; the local one is parked in .znotes/tmp/`);
        return { ok: true };
      }
      await restore();
    }
    /* settings.toml is never in the reported set: it is not something the user
       can act on, and once the paths beside it are gone the retry above deals
       with it. What is left is exactly the list of files to move or merge. */
    const paths = overwrittenPaths(co.stderr).filter((p) => p !== TRACKED_META[0]);
    return { ok: false, paths, result: co };
  }

  /** Park a boot-generated settings.toml, if it is the only thing in the way. */
  private async parkLocalSettings(paths: string[]): Promise<(() => Promise<void>) | null> {
    if (!paths.includes(TRACKED_META[0]) || paths.some((p) => p !== TRACKED_META[0])) return null;
    const from = resolve(this.vault, TRACKED_META[0]);
    const to = resolve(this.vaultHandle.znotesDir, "tmp", "settings.toml.pre-attach");
    try {
      await mkdir(resolve(this.vaultHandle.znotesDir, "tmp"), { recursive: true });
      await rename(from, to);
    } catch {
      return null;
    }
    return () => rename(to, from).catch(() => {});
  }

  /**
   * What git said about a remote operation, reduced the way every published
   * `message` is — plus the URL WE were handed, which `cleanMessage` cannot
   * know about: it is not `lastOriginUrl` yet (case B), or has just been rolled
   * back out of it (case A), and git quotes it in full in most of these errors.
   */
  private attachMessage(r: GitResult, fallback: string, url: string): string {
    const said = gitMessage(r.stderr, r.stdout, fallback);
    return this.cleanMessage(said.split(url).join(sanitizeRemote(url) ?? "origin"));
  }
}
