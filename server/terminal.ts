/* ============================================================
   terminal.ts — the password-locked command runner.

   WHAT THIS IS, PRECISELY. Bun 1.4 does have a PTY (`Bun.spawn({terminal})`),
   but it merges stdout and stderr into ONE stream, and this API's contract
   (docs/specs/done/0002-http-api-v0.md § Terminal) streams them as separate
   SSE events. So the runner stays pipe-based, and this is NOT a terminal
   emulator and never claims to be one. It is a STREAMING COMMAND RUNNER:

     - one command at a time, `Bun.spawn([shell, "-lc", wrapper], {detached})`
     - stdout and stderr streamed live, tagged, as they arrive
     - the child's stdin is writable, so a `y/N` prompt or a here-doc still works
     - cancel = SIGTERM to the whole process group, SIGKILL after a grace
     - the working directory PERSISTS between commands

   Full-screen TUIs (vim, htop, `git rebase -i`) cannot work without a TTY and
   are out of scope. The child is given `TERM=dumb`, `PAGER=cat`,
   `GIT_PAGER=cat` and a `GIT_EDITOR` that fails with a readable message, so
   the common ways a program would block waiting for a terminal turn into an
   error the user can read instead of a stall. That covers the pager and the
   editor a tool INVOKES; it cannot cover a TUI the user invokes directly —
   `vim` (or `cat` with no input) simply sits on stdin, and the only ends are
   Stop/Ctrl+C and the wall clock. So a run that has printed nothing for
   IDLE_NOTICE_MS says so in the scrollback rather than looking like progress.

   HOW `cd` PERSISTS. The submitted command is wrapped:

       cd "$__ZNOTES_CWD_IN" || exit 1; <the user's command>
       __znotes_exit=$?; pwd > "$__ZNOTES_CWD_OUT" 2>/dev/null; exit $__znotes_exit

   The user's command sits on LINE 1, spliced after the `cd` on the same line,
   so the shell's own diagnostics ("command not found", a `cd` failure, a parse
   error) carry the line number the user actually typed rather than one offset
   by the wrapper. The trailer is one line, and its variable is named so that a
   parse error which does surface it reads as this app's, not as something the
   user wrote.

   The final `pwd` goes to a TEMP FILE named by an environment variable, never
   to stdout — so no sentinel has to be stripped out of the stream, no output a
   command legitimately produced can ever be mistaken for one, and a command
   that prints megabytes costs nothing extra. After the child exits, the file is
   read, validated as a real directory, adopted as the next command's cwd, and
   deleted. A command that dies before the `pwd` line (a syntax error, `exit`,
   a kill) simply leaves the previous cwd in place, which is the right answer.
   The explicit `cd` on the first line is what makes this survive a login shell
   whose profile does its own `cd`.

   AUTH. A dedicated password, independent of the age vault passphrase — that
   one is client-side only and the server never sees it, so it structurally
   CANNOT gate a server feature. Only a scrypt hash + a random salt are stored,
   in sqlite, next to the other credentials; the password itself never appears
   in a response, a log line, an SSE payload or the settings object. Unlocking
   mints a bearer token held in the browser's memory only.
   ============================================================ */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandRow, TerminalIndex } from "./db.ts";
import type { Settings } from "./settings.ts";
import { sseResponse } from "./sse.ts";
import { ARMOR_BEGIN, ARMOR_CANARY, ARMOR_END, hasSecrets, type Vault } from "./vault.ts";

/* ============================================================
   Password — scrypt, mirroring the vault's crypto posture
   ============================================================ */


/* ============================================================
   Limits
   ============================================================ */

/** Bytes of a single command's output that are streamed before truncation. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Characters of a command's transcript kept for the AI / the record. */
const RECORD_HEAD = 4000;
const RECORD_TAIL = 4000;
/** Nothing runs forever unattended. */
const MAX_COMMAND_MS = 30 * 60_000;
/** SIGTERM → this long → SIGKILL. */
const KILL_GRACE_MS = 4000;
/** Longest command string accepted. */
const MAX_COMMAND_CHARS = 8000;
/** Failed unlocks before the backoff starts biting. */
const FREE_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 60_000;
/** Callers the backoff table remembers at once — see `bucketOf`. */
const MAX_ATTEMPT_BUCKETS = 256;
/** A bucket with no failure for this long is forgotten (and so is its block). */
const ATTEMPT_BUCKET_TTL_MS = 60 * 60_000;
/** No output for this long ⇒ say so, rather than letting a wedge look like work. */
const IDLE_NOTICE_MS = 10_000;
/** Hard ceiling on one unlocked session regardless of activity. */
const SESSION_CEILING_MS = 12 * 3600_000;
/** run_command calls one model turn may make. */
export const MAX_AI_COMMANDS_PER_TURN = 4;

/* ============================================================
   Types
   ============================================================ */

type TermEvent =
  | { event: "start"; data: { id: string; command: string; cwd: string; at: string; source: string } }
  | { event: "stdout"; data: { chunk: string } }
  | { event: "stderr"; data: { chunk: string } }
  | { event: "notice"; data: { message: string } }
  | { event: "exit"; data: { id: string; code: number | null; signal: string | null; cwd: string; ms: number; truncated: boolean } }
  | { event: "error"; data: { error: string; message: string } };

type TermEmit = (e: TermEvent) => void;

interface TerminalStatus {
  /** The `terminal.enabled` switch. */
  enabled: boolean;
  /** Is a password set? (`false` ⇒ the terminal is disabled and says so.) */
  configured: boolean;
  /** Does the caller's bearer token name a live session? */
  unlocked: boolean;
  /** Are commands available right now — enabled ∧ configured ∧ unlocked. */
  ready: boolean;
  cwd: string;
  vaultRoot: string;
  shell: string;
  idleLockMinutes: number;
  allowAiAutoRun: boolean;
  /** The id of the command running right now, if any. */
  running: string | null;
  /** ms until the idle lock fires, or null when locked. */
  expiresInMs: number | null;
  /** ms the caller must wait before another unlock attempt is accepted. */
  retryAfterMs: number;
  /** Honest, user-facing statement of what this runner cannot do. */
  ptyNote: string;
}

/** The row db.ts stores, unchanged — one shape, no translation layer. */
export type CommandRecord = CommandRow;

const PTY_NOTE =
  "No TTY: this runs one command at a time and streams its output. Full-screen programs (vim, htop, less, git rebase -i) cannot work here — use a real terminal for those.";

/* ============================================================
   Terminal
   ============================================================ */

interface Session {
  token: string;
  createdAt: number;
  lastActivity: number;
}

interface Running {
  id: string;
  proc: any;
  command: string;
  startedAt: number;
  cwdOut: string;
  tmpDir: string;
  killTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  killed: boolean;
}

interface TerminalDeps {
  vault: Vault;
  settings: Pick<Settings, "value" | "terminalPasswordSet" | "setTerminalPassword" | "verifyTerminalPassword" | "warmPasswordDecoy">;
  index: TerminalIndex;
  log: (line: string) => void;
  /** Fired when an AI-originated command record changes — a NOTIFICATION only:
      it carries an id, never a command string and never output, because
      `/events` is the app-wide bus and is not behind the terminal password. */
  onCommandEvent: (data: { id: string; state: string; source: string; at: string }) => void;
}

export class TerminalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "TerminalError";
  }
}

/** One caller's failed-unlock history. Keyed by `bucketOf(caller)`. */
interface Attempts {
  fails: number;
  blockedUntil: number;
  lastFailure: number;
}

export class Terminal {
  private sessions = new Map<string, Session>();
  /**
   * The backoff is PER CALLER, not per process.
   *
   * A single global counter made the control that bounds guessing into the
   * denial: `fails` only ever reset on a SUCCESSFUL unlock, and a blocked
   * caller cannot succeed — so one unauthenticated peer failing every 700 ms
   * held the owner out of their own terminal indefinitely (measured: six
   * consecutive 429s against the correct password, recovering only when the
   * flood stopped). Keying by caller keeps the limiter's whole purpose — one
   * caller's guessing gets exponentially slower — without letting that caller
   * spend anyone else's budget.
   */
  private attempts = new Map<string, Attempts>();
  private running: Running | null = null;
  private cwd: string;
  private seq = 0;

  constructor(private readonly deps: TerminalDeps) {
    const stored = deps.index.getMeta("terminal.cwd");
    this.cwd = this.usableDir(stored) || this.startupCwd();
    this.warmDecoy();
  }

  /**
   * Build the decoy record off the request path.
   *
   * Only when the terminal is ON and has NO password: that is exactly the case
   * where an unlock would otherwise have to build it mid-request (a configured
   * vault verifies against its own record and never touches the decoy), and it
   * keeps the "no derivation on every boot" property for every other vault.
   * `setTimeout(…, 0)` rather than a synchronous call so the ~150 ms is not
   * charged to boot either — the listener is up first.
   */
  private warmDecoy() {
    if (!this.enabled() || this.configured()) return;
    const t = setTimeout(() => {
      try {
        this.deps.settings.warmPasswordDecoy();
      } catch {}
    }, 0);
    // a warm-up must never be the reason a process stays alive
    (t as any).unref?.();
  }

  /* ---------- configuration ---------- */

  private startupCwd(): string {
    const configured = String(this.deps.settings.value("terminal.startupCwd", "") || "").trim();
    return this.usableDir(configured) || this.deps.vault.root;
  }

  private usableDir(p: string | null | undefined): string | null {
    if (!p) return null;
    try {
      const abs = resolve(p);
      return statSync(abs).isDirectory() ? abs : null;
    } catch {
      return null;
    }
  }

  /** The shell every command runs under: the setting, else $SHELL, else /bin/sh. */
  shell(): string {
    const configured = String(this.deps.settings.value("terminal.shell", "") || "").trim();
    for (const candidate of [configured, process.env.SHELL || "", "/bin/sh"]) {
      if (!candidate) continue;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
    return "/bin/sh";
  }

  private idleMs(): number {
    return Number(this.deps.settings.value("terminal.idleLockMinutes", 10)) * 60_000;
  }

  enabled(): boolean {
    return this.deps.settings.value("terminal.enabled", true) === true;
  }

  configured(): boolean {
    return this.deps.settings.terminalPasswordSet();
  }

  allowAiAutoRun(): boolean {
    return this.deps.settings.value("terminal.allowAiAutoRun", false) === true;
  }

  /** Enabled ∧ a password exists. The AI tool is not even DECLARED unless this
      is true, so a vault that never configured a terminal never tells a model
      the capability exists. */
  available(): boolean {
    return this.enabled() && this.configured();
  }

  /* ---------- password ---------- */

  /**
   * Set, change or clear the password. Changing an existing one requires the
   * current one (or a live unlocked session): otherwise the lock is a sign, not
   * a lock — anyone at the keyboard could replace it and walk straight in.
   *
   * Rate-limited on the same counter as unlock, because "guess the current
   * password" is the same guess.
   */
  setPassword(next: unknown, current: unknown, token: string | null, caller?: string | null): { configured: boolean } {
    const already = this.configured();
    if (already) {
      const viaSession = !!this.session(token);
      if (!viaSession) {
        this.assertNotBlocked(caller);
        if (!this.deps.settings.verifyTerminalPassword(String(current ?? ""))) {
          this.noteFailure(caller);
          throw new TerminalError("bad-password", "The current terminal password is wrong.", 401);
        }
        this.noteSuccess(caller);
      }
    }
    const value = typeof next === "string" ? next : "";
    if (!value) {
      this.deps.settings.setTerminalPassword("");
      this.lockAll();
      this.deps.log("terminal: password cleared — the terminal is disabled");
      /* the vault is now one an unlock has to answer with the decoy */
      this.warmDecoy();
      return { configured: false };
    }
    if (value.length < 8) throw new TerminalError("weak-password", "The terminal password must be at least 8 characters.");
    this.deps.settings.setTerminalPassword(value);
    /* Every existing session dies with the old password: a session minted under
       a password the user has just revoked is exactly what "changed the
       password" is supposed to end. */
    this.lockAll();
    this.deps.log("terminal: password set");
    return { configured: true };
  }

  /* ---------- rate limiting ---------- */

  /**
   * The caller's bucket key. `null` (no address available) is a bucket of its
   * own rather than a shared one, so an unknown caller can still only block
   * other unknown callers.
   *
   * Bounded and swept: the table is an optimisation for a hostile peer, and a
   * hostile peer must not be able to grow it without limit. When it is full the
   * least-recently-failed entry goes — the entry least likely to be mid-backoff.
   */
  private bucketOf(caller: string | null | undefined): string {
    return caller ? String(caller) : "unknown";
  }

  private attemptsFor(caller: string | null | undefined, create: boolean): Attempts | null {
    const key = this.bucketOf(caller);
    const now = Date.now();
    const found = this.attempts.get(key);
    if (found && now - found.lastFailure < ATTEMPT_BUCKET_TTL_MS) return found;
    if (found) this.attempts.delete(key);
    if (!create) return null;
    for (const [k, v] of this.attempts) if (now - v.lastFailure >= ATTEMPT_BUCKET_TTL_MS) this.attempts.delete(k);
    while (this.attempts.size >= MAX_ATTEMPT_BUCKETS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.attempts) if (v.lastFailure < oldest) ((oldest = v.lastFailure), (oldestKey = k));
      if (oldestKey === null) break;
      this.attempts.delete(oldestKey);
    }
    const fresh: Attempts = { fails: 0, blockedUntil: 0, lastFailure: now };
    this.attempts.set(key, fresh);
    return fresh;
  }

  private assertNotBlocked(caller: string | null | undefined) {
    const wait = this.retryAfterMs(caller);
    if (wait > 0) {
      throw new TerminalError(
        "too-many-attempts",
        `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)}s.`,
        429,
        { retryAfterMs: wait }
      );
    }
  }

  private noteFailure(caller: string | null | undefined) {
    const a = this.attemptsFor(caller, true)!;
    a.fails++;
    a.lastFailure = Date.now();
    if (a.fails > FREE_ATTEMPTS) {
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (a.fails - FREE_ATTEMPTS - 1));
      a.blockedUntil = a.lastFailure + backoff;
    }
    // never says whether a password is set, never echoes what was tried, and
    // never names the caller — the log is not an access list
    this.deps.log(`terminal: unlock refused (${a.fails} consecutive failures from this caller)`);
  }

  private noteSuccess(caller: string | null | undefined) {
    this.attempts.delete(this.bucketOf(caller));
  }

  retryAfterMs(caller?: string | null): number {
    const a = this.attemptsFor(caller, false);
    return a ? Math.max(0, a.blockedUntil - Date.now()) : 0;
  }

  /* ---------- sessions ---------- */

  /**
   * A BEARER token in the reply body, not an httpOnly cookie.
   *
   * A cookie is ambient authority: the browser attaches it to every same-origin
   * request whether or not the page meant to make one, so anything that got a
   * request through the `Sec-Fetch-Site` guard in server/index.ts would be
   * authenticated for free. A bearer token sits in one JS variable in api.js
   * and has to be attached deliberately, so a cross-site request cannot carry
   * it even if the CSRF guard is ever bypassed. It is also never written to
   * disk or to storage, so closing the tab re-locks the terminal — which is the
   * right default for a shell.
   *
   * The trade is honest: an XSS in this page could read the variable, where it
   * could not read an httpOnly cookie. But this app has no app-level auth at
   * all, so script running in the page can already read and rewrite
   * every note and drive the AI relay; the cross-site vector is the one that
   * this choice actually closes.
   */
  unlock(password: unknown, caller?: string | null): { token: string; expiresAt: string; idleLockMinutes: number } {
    if (!this.enabled()) throw new TerminalError("terminal-disabled", "The terminal is switched off in Settings.", 403);
    this.assertNotBlocked(caller);
    /* Deliberately the SAME answer, with the same work behind it, whether or
       not a password is set: this endpoint must not be an oracle for "is there
       a terminal password on this vault". `GET /api/terminal/status` tells the
       app `configured:false` so the panel can say the terminal is disabled —
       that is a same-origin read for the user, not a probe result. */
    if (!this.deps.settings.verifyTerminalPassword(typeof password === "string" ? password : "")) {
      this.noteFailure(caller);
      throw new TerminalError("bad-password", "Wrong terminal password.", 401, {
        retryAfterMs: this.retryAfterMs(caller),
      });
    }
    this.noteSuccess(caller);
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { token, createdAt: now, lastActivity: now });
    this.deps.log("terminal: unlocked");
    return {
      token,
      expiresAt: new Date(now + this.idleMs()).toISOString(),
      idleLockMinutes: Number(this.deps.settings.value("terminal.idleLockMinutes", 10)),
    };
  }

  /** The live session for this token, sweeping expired ones. Never throws. */
  private session(token: string | null | undefined): Session | null {
    this.sweep();
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    s.lastActivity = Date.now();
    return s;
  }

  private sweep() {
    const now = Date.now();
    const idle = this.idleMs();
    for (const [token, s] of this.sessions) {
      if (now - s.lastActivity > idle || now - s.createdAt > SESSION_CEILING_MS) this.sessions.delete(token);
    }
  }

  lock(token: string | null) {
    if (token) this.sessions.delete(token);
  }

  lockAll() {
    this.sessions.clear();
  }

  /** Throws 401 unless the token names a live session and the terminal is on. */
  private authed(token: string | null): Session {
    if (!this.enabled()) throw new TerminalError("terminal-disabled", "The terminal is switched off in Settings.", 403);
    if (!this.configured())
      throw new TerminalError(
        "terminal-unconfigured",
        "The terminal has no password set, so it is disabled. Set one under Settings → Terminal.",
        403
      );
    const s = this.session(token);
    if (!s) throw new TerminalError("terminal-locked", "The terminal is locked. Unlock it with your terminal password.", 401);
    return s;
  }

  status(token: string | null, caller?: string | null): TerminalStatus {
    const s = this.session(token);
    return {
      enabled: this.enabled(),
      configured: this.configured(),
      unlocked: !!s,
      ready: this.available() && !!s,
      cwd: this.cwd,
      vaultRoot: this.deps.vault.root,
      shell: this.shell(),
      idleLockMinutes: Number(this.deps.settings.value("terminal.idleLockMinutes", 10)),
      allowAiAutoRun: this.allowAiAutoRun(),
      running: this.running ? this.running.id : null,
      expiresInMs: s ? Math.max(0, this.idleMs() - (Date.now() - s.lastActivity)) : null,
      /* the CALLER's own backoff — another peer's failures are not this
         caller's business and must not be reported as their wait */
      retryAfterMs: this.retryAfterMs(caller),
      ptyNote: PTY_NOTE,
    };
  }

  /* ============================================================
     Running a command
     ============================================================ */

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${(++this.seq).toString(36)}`;
  }

  /**
   * The wrapper described at the top of this file. Nothing about the command is
   * quoted, escaped or inspected, because the whole point is that it is a real
   * shell line — it is spliced in after a `;`, so a trailing `# comment` or a
   * `&` still comments or backgrounds only itself.
   *
   * It goes on LINE 1. The `cd` used to sit on a line of its own, which pushed
   * every diagnostic the shell reports by line number one line down from what
   * the user typed: `nosuchcommand` came back as `zsh:2: command not found`,
   * and a typo in a three-line paste was reported against a line that did not
   * exist in it. The trailer is one line for the same reason, and `__znotes_exit`
   * is named so that a parse error which quotes it reads as ours.
   */
  private wrap(command: string): string {
    return [
      `cd "$__ZNOTES_CWD_IN" || exit 1; ${command}`,
      '__znotes_exit=$?; pwd > "$__ZNOTES_CWD_OUT" 2>/dev/null; exit $__znotes_exit',
    ].join("\n");
  }

  private childEnv(cwdIn: string, cwdOut: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    env.__ZNOTES_CWD_IN = cwdIn;
    env.__ZNOTES_CWD_OUT = cwdOut;
    env.ZNOTES_VAULT = this.deps.vault.root;
    /* There is no terminal on the other end of these pipes. Everything below
       turns a program that would BLOCK waiting for one into a program that
       either behaves or says why it cannot — the difference between a hung
       command and a readable error. */
    env.TERM = "dumb";
    env.NO_COLOR = "1";
    env.CLICOLOR = "0";
    env.PAGER = "cat";
    env.GIT_PAGER = "cat";
    env.LESS = "-FRX";
    env.GIT_EDITOR =
      "printf '%s\\n' 'z-notes terminal has no TTY, so no editor can open here. Use git commit -m \"…\", or edit the file and re-run.' >&2; false";
    env.GIT_SEQUENCE_EDITOR = env.GIT_EDITOR;
    return env;
  }

  /**
   * Signal a command's whole process group.
   *
   * `proc.kill()` reaches the shell only, so a `sleep 300` it started would be
   * reparented to init and keep the pipes open. The shell is spawned
   * `detached: true`, which makes it its own group leader (pgid == pid). The
   * negative pid then reaches every process the command started, on macOS and
   * in the container alike, with no `ps` to parse. The fallback covers a group
   * that is already gone (ESRCH).
   */
  private signalGroup(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }

  /** SIGTERM the group now, SIGKILL it if it is still there after the grace. */
  async cancel(token: string | null, id?: string): Promise<{ cancelled: boolean; id: string | null }> {
    this.authed(token);
    const run = this.running;
    if (!run || (id && id !== run.id)) return { cancelled: false, id: run ? run.id : null };
    return this.cancelRun(run);
  }

  private cancelRun(run: Running): { cancelled: boolean; id: string } {
    run.killed = true;
    this.signalGroup(run.proc.pid, "SIGTERM");
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        this.signalGroup(run.proc.pid, "SIGKILL");
      }, KILL_GRACE_MS);
    }
    return { cancelled: true, id: run.id };
  }

  /**
   * Write to the running child's stdin — how a `y/N` prompt gets answered.
   *
   * BOUND TO AN ID. The caller says which command it believes it is typing
   * into, and a mismatch is refused rather than silently redirected: what the
   * user is answering is the prompt in front of them, and a client whose idea
   * of "the running command" is stale (or was never the one that started it)
   * must not be able to feed a passphrase to a different process. `id` is
   * optional only for a caller that has no id to offer, which is not the app.
   */
  async writeStdin(token: string | null, data: unknown, eof: boolean, id?: string | null): Promise<{ ok: true; id: string }> {
    this.authed(token);
    const run = this.running;
    if (!run) throw new TerminalError("not-running", "Nothing is running, so there is nothing to type into.", 409);
    if (id && id !== run.id)
      throw new TerminalError(
        "wrong-command",
        "That is not the command running now — nothing was typed into it.",
        409,
        { running: run.id }
      );
    const text = typeof data === "string" ? data : "";
    try {
      if (text) run.proc.stdin?.write(text);
      if (eof) await run.proc.stdin?.end();
      else run.proc.stdin?.flush?.();
    } catch (err) {
      throw new TerminalError("stdin-failed", `Could not write to the command: ${String((err as Error)?.message || err)}`, 409);
    }
    return { ok: true, id: run.id };
  }

  /**
   * The one place a command is executed. Everything else (the SSE route, the
   * AI's approved command, the AI's auto-run) funnels through here, so there is
   * exactly one implementation of the wrapper, the cwd hand-off, the caps and
   * the kill path.
   *
   * SINGLE FLIGHT LIVES HERE, not in the callers. `exec()` and `runQueued()`
   * each restated the check so they could answer 409 on the HTTP envelope
   * before opening a stream; `autoRun()` — the one caller the MODEL can reach —
   * restated nothing, so an assistant command displaced whatever the user was
   * running: `this.running` was overwritten, the user's Ctrl+C then found
   * nothing to cancel, their process outlived even the server's shutdown kill,
   * and every line they typed at their own visible prompt was written into the
   * model's process instead. The guard belongs at the assignment it protects.
   */
  private async execute(
    command: string,
    source: "user" | "ai",
    emit: TermEmit,
    id: string
  ): Promise<{ code: number | null; signal: string | null; cwd: string; ms: number; truncated: boolean; transcript: string }> {
    if (this.running)
      throw new TerminalError("busy", "A command is already running — cancel it first (Ctrl+C).", 409, {
        running: this.running.id,
      });
    const shell = this.shell();
    const cwdIn = this.usableDir(this.cwd) || this.startupCwd();
    const tmpDir = mkdtempSync(join(tmpdir(), "znotes-term-"));
    const cwdOut = join(tmpDir, "cwd");
    const startedAt = Date.now();

    emit({ event: "start", data: { id, command, cwd: cwdIn, at: new Date(startedAt).toISOString(), source } });

    let proc: any;
    try {
      proc = Bun.spawn([shell, "-lc", this.wrap(command)], {
        cwd: cwdIn,
        env: this.childEnv(cwdIn, cwdOut),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // its own process group, so cancel can reach everything it starts
        detached: true,
      });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new TerminalError("spawn-failed", `Could not start ${shell}: ${String((err as Error)?.message || err)}`, 500);
    }

    const run: Running = { id, proc, command, startedAt, cwdOut, tmpDir, killTimer: null, hardTimer: null, killed: false };
    this.running = run;
    run.hardTimer = setTimeout(() => {
      emit({ event: "notice", data: { message: `Still running after ${Math.round(MAX_COMMAND_MS / 60000)} minutes — killing it.` } });
      this.cancelRun(run);
    }, MAX_COMMAND_MS);

    let streamed = 0;
    let truncated = false;
    /* The transcript kept for the record and for the AI is capped separately
       and much harder than the live stream: the browser can scroll, a model
       context cannot. */
    let head = "";
    let tail = "";
    /* A TUI invoked directly (`vim`, `cat` with no argument) prints whatever it
       prints and then sits on stdin forever. Nothing above can prevent that —
       there is no TTY to refuse — so the run says so instead of looking like
       work in progress. Once per command: the point is to explain a wedge, not
       to narrate a long quiet build. */
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let saidIdle = false;
    const armIdleNotice = () => {
      if (saidIdle) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        saidIdle = true;
        emit({
          event: "notice",
          data: {
            message: `Still running, and nothing printed for ${Math.round(
              IDLE_NOTICE_MS / 1000
            )}s. If it is waiting for input, type a line and press Enter; there is no TTY here, so a full-screen program (vim, htop) will never draw — press Stop or Ctrl+C.`,
          },
        });
      }, IDLE_NOTICE_MS);
    };
    armIdleNotice();
    const record = (text: string) => {
      armIdleNotice();
      if (head.length < RECORD_HEAD) head += text.slice(0, RECORD_HEAD - head.length);
      tail = (tail + text).slice(-RECORD_TAIL);
    };

    const pump = async (stream: ReadableStream<Uint8Array> | null, event: "stdout" | "stderr") => {
      if (!stream) return;
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = dec.decode(chunk.value, { stream: true });
        if (!text) continue;
        record(text);
        if (streamed >= MAX_OUTPUT_BYTES) {
          if (!truncated) {
            truncated = true;
            emit({ event: "notice", data: { message: `Output passed ${Math.round(MAX_OUTPUT_BYTES / 1048576)} MiB — the rest is not shown.` } });
          }
          continue; // keep draining: a blocked pipe would wedge the child
        }
        streamed += chunk.value.byteLength;
        emit({ event, data: { chunk: text } });
      }
      const rest = dec.decode();
      if (rest) {
        record(rest);
        if (!truncated) emit({ event, data: { chunk: rest } });
      }
    };

    let code: number | null = null;
    let signal: string | null = null;
    try {
      await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
      code = await proc.exited;
      signal = (proc.signalCode as string | null) ?? null;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (run.hardTimer) clearTimeout(run.hardTimer);
      if (run.killTimer) clearTimeout(run.killTimer);
      try {
        proc.stdin?.end?.();
      } catch {}
      /* Adopt the child's final PWD. Absent (killed, syntax error, `exit`) or
         no longer a directory ⇒ keep what we had; a cwd is state the user
         relies on and must never be silently reset by a failed command. */
      let nextCwd = this.cwd;
      try {
        const written = readFileSync(cwdOut, "utf8").trim();
        const usable = this.usableDir(written);
        if (usable) nextCwd = usable;
      } catch {}
      rmSync(tmpDir, { recursive: true, force: true });
      if (nextCwd !== this.cwd) {
        this.cwd = nextCwd;
        this.deps.index.setMeta("terminal.cwd", nextCwd);
      }
      this.running = null;
    }

    const ms = Date.now() - startedAt;
    /* `head` filled to its cap means there is more than head+tail can hold, so
       the middle is elided; short output is entirely in `head` and `tail` is
       just a suffix of it, which must not be appended twice. */
    const transcript = head.length < RECORD_HEAD ? head : `${head}\n…\n${tail}`;
    emit({ event: "exit", data: { id, code, signal, cwd: this.cwd, ms, truncated } });
    return { code, signal, cwd: this.cwd, ms, truncated, transcript };
  }

  private validate(command: unknown): string {
    const c = typeof command === "string" ? command : "";
    if (!c.trim()) throw new TerminalError("empty-command", "There is no command to run.");
    if (c.length > MAX_COMMAND_CHARS)
      throw new TerminalError("too-long", `A command may be at most ${MAX_COMMAND_CHARS} characters.`, 413);
    if (c.includes("\0")) throw new TerminalError("bad-command", "A command may not contain a NUL byte.");
    return c;
  }

  /**
   * `POST /api/terminal/exec` — the human path. Answers with an SSE stream so
   * output is live; the browser reuses exactly the fetch+parse machinery
   * `POST /api/ai/messages` already uses.
   */
  /**
   * The single-flight check below is safe without a lock, and deliberately so:
   * `ReadableStream`'s `start` runs synchronously during construction, and
   * `execute()` assigns `this.running` before its first `await`. So by the time
   * this function RETURNS, `this.running` is already set — a second request
   * cannot observe the gap, because nothing yields inside it.
   */
  exec(token: string | null, command: unknown): Response {
    this.authed(token);
    const cmd = this.validate(command);
    if (this.running)
      throw new TerminalError("busy", "A command is already running — cancel it first (Ctrl+C).", 409, { running: this.running.id });

    const id = this.nextId("cmd");
    return sseResponse((emit) => this.execute(cmd, "user", emit as TermEmit, id), {
      onError: (err) => ({
        event: "error",
        data: { error: (err as TerminalError)?.code || "exec-failed", message: String((err as Error)?.message || err) },
      }),
      /* The browser went away. A command the user can no longer see is a
         command nobody asked to keep running — but a teardown that arrives
         late must never reach past its own command. */
      onCancel: () => {
        const run = this.running;
        if (run && run.id === id) this.cancelRun(run);
      },
    });
  }

  /* ============================================================
     AI access

     THE GATE. Note content and AI context are attacker-influenceable: a note
     can be written by anyone the user pastes from, a fetched doc can carry
     injected instructions, and the assembled context is exactly the text a
     prompt injection travels in. Silent shell access would therefore turn any
     hostile string anywhere in the vault into code execution on this machine.
     So by default `run_command` does not run anything: it QUEUES a command,
     which the user sees as a card with the exact string on it and a Run button,
     the same shape `propose_edits` already uses for writes. `allowAiAutoRun`
     removes the click for users who want that, and ships OFF.

     The terminal must also be UNLOCKED. A locked terminal refuses the tool
     outright and tells the model so, which is a truthful answer rather than a
     silent no-op.
     ============================================================ */

  /** Record an AI command request. Returns the record; nothing has run yet. */
  queueAiCommand(command: string, why: string, sessionId: string, messageId: string | null): CommandRecord {
    const createdAt = new Date().toISOString();
    const id = this.nextId("run");
    this.deps.index.addCommand({
      id,
      source: "ai",
      command,
      why: why || null,
      state: "pending",
      cwd: this.cwd,
      sessionId,
      messageId,
      createdAt,
    });
    this.deps.onCommandEvent({ id, state: "pending", source: "ai", at: createdAt });
    return this.deps.index.command(id)!;
  }

  /** Attach the assistant message a queued command belongs under, once it exists. */
  attachMessage(id: string, messageId: string) {
    this.deps.index.updateCommand(id, { messageId });
  }

  command(id: string): CommandRecord | null {
    return this.deps.index.command(id);
  }

  /** Recent AI command records, newest last. Bearer-gated: output is in here. */
  list(token: string | null, limit = 30): CommandRecord[] {
    this.authed(token);
    return this.deps.index.commands(limit);
  }

  /**
   * Run a queued AI command — the "Run" button on the approval card, and the
   * auto-run path. Streams exactly like the human path so the output lands in
   * the same scrollback.
   */
  runQueued(token: string | null, id: string): Response {
    this.authed(token);
    const rec = this.deps.index.command(id);
    if (!rec) throw new TerminalError("not-found", `No such command: ${id}`, 404);
    if (rec.state === "done" || rec.state === "failed")
      throw new TerminalError("already-run", "That command has already run.", 409);
    if (rec.state === "rejected") throw new TerminalError("rejected", "That command was rejected.", 409);
    if (rec.state === "running") throw new TerminalError("busy", "That command is already running.", 409);
    if (this.running) throw new TerminalError("busy", "A command is already running — cancel it first (Ctrl+C).", 409);

    return sseResponse((emit) => this.runRecord(rec, emit as TermEmit), {
      onError: (err) => ({
        event: "error",
        data: { error: (err as TerminalError)?.code || "exec-failed", message: String((err as Error)?.message || err) },
      }),
      /* The browser went away — and the command it went away from is `rec`,
         not "whatever is running now". Same shape as exec()'s: a teardown that
         arrives late must never reach past its own command. */
      onCancel: () => {
        const run = this.running;
        if (run && run.id === rec.id) this.cancelRun(run);
      },
    });
  }

  /**
   * A command's transcript, as it is allowed to become DURABLE.
   *
   * `cat keys/cloud-keys.md`, `git show`, `grep -r` — the things the terminal
   * is advertised for — put whatever is in the vault on stdout, age armor
   * included. This record is written to sqlite and replayed into EVERY later AI
   * context, so armor reaching it breaks two rules at once: armor must never
   * reach the search index, and — because the relay's canary then refuses
   * every assembled context that carries it — the assistant stops working
   * entirely, in every session, until index.db is deleted.
   *
   * Withheld whole rather than block-by-block: a transcript is arbitrary
   * program output and can be truncated mid-block (RECORD_HEAD/RECORD_TAIL), so
   * "cut out from BEGIN to END" has cases where it leaves ciphertext behind.
   * Over-redacting is the safe direction (vault.ts says the same of `redact`);
   * the live stream the user is watching is untouched.
   */
  private durableOutput(transcript: string): string {
    const t = String(transcript ?? "");
    if (!t.includes(ARMOR_CANARY) && !t.includes(ARMOR_BEGIN) && !t.includes(ARMOR_END) && !hasSecrets(t)) return t;
    this.deps.log("terminal: command output withheld from the record — it contains an encrypted block");
    return "⟪output withheld: this command printed an age-encrypted block⟫";
  }

  /** Execute a record and write the outcome back onto it. */
  async runRecord(rec: CommandRecord, emit: TermEmit): Promise<CommandRecord> {
    this.deps.index.updateCommand(rec.id, { state: "running" });
    this.deps.onCommandEvent({ id: rec.id, state: "running", source: rec.source, at: new Date().toISOString() });
    try {
      const out = await this.execute(rec.command, "ai", emit, rec.id);
      this.deps.index.updateCommand(rec.id, {
        state: "done",
        exitCode: out.code,
        output: this.durableOutput(out.transcript),
        truncated: out.truncated ? 1 : 0,
        cwd: out.cwd,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      this.deps.index.updateCommand(rec.id, {
        state: "failed",
        output: String((err as Error)?.message || err),
        finishedAt: new Date().toISOString(),
      });
      this.deps.onCommandEvent({ id: rec.id, state: "failed", source: rec.source, at: new Date().toISOString() });
      throw err;
    }
    const after = this.deps.index.command(rec.id)!;
    this.deps.onCommandEvent({ id: rec.id, state: after.state, source: rec.source, at: new Date().toISOString() });
    return after;
  }

  reject(token: string | null, id: string): CommandRecord {
    this.authed(token);
    const rec = this.deps.index.command(id);
    if (!rec) throw new TerminalError("not-found", `No such command: ${id}`, 404);
    if (rec.state !== "pending") throw new TerminalError("not-pending", "That command is not waiting for approval.", 409);
    this.deps.index.updateCommand(id, { state: "rejected", finishedAt: new Date().toISOString() });
    const after = this.deps.index.command(id)!;
    this.deps.onCommandEvent({ id, state: "rejected", source: rec.source, at: after.finishedAt || new Date().toISOString() });
    return after;
  }

  /**
   * Auto-run, in-turn (only when `terminal.allowAiAutoRun` is on AND the
   * terminal is unlocked). Nothing streams to a browser here — the relay is
   * server-side — so the record and the `/events` notification are what make
   * the command visible; the panel picks both up and paints them into the
   * scrollback exactly like an approved one.
   */
  async autoRun(rec: CommandRecord): Promise<CommandRecord> {
    return this.runRecord(rec, () => {});
  }

  /** Is any session live right now? (The AI gate — not per-token.) */
  anyUnlocked(): boolean {
    this.sweep();
    return this.sessions.size > 0;
  }

  /** Cheap read for the AI context block: the last few AI commands and results.
      Session-scoped — "new session" (ai.ts) means a cleared context, and the
      previous session's transcripts must not ride into the next prompt. */
  recentForContext(sessionId: string, limit = 6): CommandRecord[] {
    return this.deps.index.commands(limit, sessionId).filter((c) => c.state === "done" || c.state === "failed");
  }

  /** SIGTERM anything still running — called from the server's shutdown path. */
  stop() {
    const run = this.running;
    if (run) {
      this.signalGroup(run.proc.pid, "SIGKILL");
      if (run.killTimer) clearTimeout(run.killTimer);
      if (run.hardTimer) clearTimeout(run.hardTimer);
      try {
        rmSync(run.tmpDir, { recursive: true, force: true });
      } catch {}
    }
    this.running = null;
    this.sessions.clear();
  }
}

/** `Bearer <token>` → token, or null. The only place the header shape is known. */
export function bearerOf(req: Request): string | null {
  const raw = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}
