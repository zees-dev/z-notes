/* ============================================================
   helpers.ts — harness for the PHASE 1 acceptance gates (SPEC §11).

   Nothing in here knows anything about the backend's internals. It only
   knows the fixed conventions:

     - `bun server/index.ts` at the repo root, env ZNOTES_VAULT / ZNOTES_PORT
     - one ready line on stdout: "z-notes listening on http://localhost:<port>"
     - clean exit on SIGTERM
     - HTTP contract per docs/API.md + SPEC.md §3 deltas
     - SSE at /events

   Every test spawns its own server against its own freshly-built temp vault,
   so tests never share state and the developer's ./vault is never touched.
   ============================================================ */

import type { Subprocess } from "bun";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const SERVER_ENTRY = join(REPO_ROOT, "server", "index.ts");

/* ------------------------------------------------------------------
   vault fixtures
   ------------------------------------------------------------------ */

export type SeedMap = Record<string, string | Uint8Array>;

const enc = new TextEncoder();

export function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? enc.encode(v) : v;
}

export function writeVaultFile(vault: string, rel: string, content: string | Uint8Array): string {
  const p = join(vault, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(toBytes(content)));
  return p;
}

export function readVaultBytes(vault: string, rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(vault, rel)));
}

export function readVaultText(vault: string, rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

export function vaultHas(vault: string, rel: string): boolean {
  return existsSync(join(vault, rel));
}

export function makeVault(seed: SeedMap = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "znotes-test-"));
  for (const [rel, content] of Object.entries(seed)) writeVaultFile(dir, rel, content);
  return dir;
}

export function dropVault(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/* ---- the seeded vault the prototype/frontend was built against ---- */

export const MD_DESIGN =
  "# z-notes design\n" +
  "\n" +
  "Single-user markdown notes app. Bun backend, raw/preview markdown UI, files are the source of truth — see [[event-pipeline]] for how external edits flow in.\n" +
  "\n" +
  "## Decisions\n" +
  "\n" +
  "- [x] Editor: raw markdown + preview modes, lossless by construction\n" +
  "- [x] Secrets: age-encrypted blocks (see [[cloud-keys]])\n" +
  "- [ ] Pick winning UI theme from prototype round 1\n" +
  "- [ ] Write build-ready spec\n" +
  "\n" +
  "## API sketch\n" +
  "\n" +
  "| Endpoint | Method | Purpose |\n" +
  "|---|---|---|\n" +
  "| /api/docs | GET | list vault tree |\n" +
  "| /api/docs/:path | GET/PUT | read / save markdown |\n" +
  "| /events | GET | SSE: files changed on disk |\n" +
  "\n" +
  "```ts\n" +
  "Bun.serve({\n" +
  "  routes: {\n" +
  '    "/api/docs/*": docHandler,\n' +
  '    "/events": sseHandler,\n' +
  "  },\n" +
  "  idleTimeout: 0, // SSE would die at 10s otherwise\n" +
  "});\n" +
  "```\n" +
  "\n" +
  "\n" +
  "> Files are edited outside the app too — the watcher is just a doorbell; reconcile from disk.\n";

export const MD_PIPELINE =
  "# Event pipeline\n" +
  "\n" +
  'fs.watch on macOS lies: eventType is always "rename" and atomic saves name only the temp file.\n' +
  "\n" +
  "- [x] Debounce 120ms\n" +
  "- [x] Reconcile: Glob → stat → hash → sqlite\n" +
  "- [ ] Push change to open editors via SSE\n" +
  "\n" +
  "Related: [[z-notes-design]]\n";

export const MD_SIDE =
  "# Side projects\n" +
  "\n" +
  "Active: **z-notes** (this app — [[z-notes-design]]), homelab overhaul, a tiny CLI for age-encrypted dotfiles.\n" +
  "\n" +
  "- [ ] z-notes: review prototype round 1\n" +
  "- [ ] homelab: move DNS off the NAS\n";

/* the only doc in the seed carrying an armored age fence → hasSecrets */
export const MD_KEYS =
  "# Cloud keys\n" +
  "\n" +
  "Personal AWS + Hetzner credentials. Everything below is encrypted at rest and in git.\n" +
  "\n" +
  "```age\n" +
  "-----BEGIN AGE ENCRYPTED FILE-----\n" +
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4...\n" +
  "Zt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp\n" +
  "-----END AGE ENCRYPTED FILE-----\n" +
  "```\n";

/* one doc carrying a token that occurs nowhere else in the vault, so a search
   assertion can name exactly one expected hit */
export const MD_HOMELAB =
  "# Homelab\n" +
  "\n" +
  "- [ ] Move DNS off the QUOKKA appliance\n" +
  "- [ ] Rack the new switch\n";

export const SEED_VAULT: SeedMap = {
  "inbox.md": "",
  "architecture/z-notes-design.md": MD_DESIGN,
  "architecture/event-pipeline.md": MD_PIPELINE,
  "projects/side-projects.md": MD_SIDE,
  "projects/homelab.md": MD_HOMELAB,
  "keys/cloud-keys.md": MD_KEYS,
  "journal/2026-07-31.md": "",
};

export const SEED_DOC_PATHS = Object.keys(SEED_VAULT).sort();

/* ------------------------------------------------------------------
   misc
   ------------------------------------------------------------------ */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** vault-relative POSIX path → percent-encoded URL path (slashes survive) */
export const encPath = (p: string) => String(p).split("/").map(encodeURIComponent).join("/");

export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const p = s.port;
  await s.stop(true);
  return p;
}

/** poll `fn` until it returns a truthy value or the deadline passes */
export async function waitUntil<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {}
): Promise<T> {
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 40;
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil timed out after ${timeout}ms${opts.label ? ` waiting for ${opts.label}` : ""} (last: ${String(last)})`
      );
    }
    await sleep(interval);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** human-readable byte diff, so a round-trip failure names the offending byte */
export function describeByteDiff(expected: Uint8Array, actual: Uint8Array): string {
  if (bytesEqual(expected, actual)) return "identical";
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      const ctx = (u: Uint8Array) =>
        JSON.stringify(new TextDecoder().decode(u.slice(Math.max(0, i - 20), i + 20)));
      return `first difference at byte ${i}: expected 0x${expected[i].toString(16)} got 0x${actual[i].toString(
        16
      )}\n  expected …${ctx(expected)}…\n  actual   …${ctx(actual)}…`;
    }
  }
  return `length differs: expected ${expected.length} bytes, got ${actual.length} bytes (common prefix identical)`;
}

/* ------------------------------------------------------------------
   SSE client (fetch + ReadableStream — deliberately NOT EventSource,
   so the raw first bytes and the response headers stay observable)
   ------------------------------------------------------------------ */

export interface SSEEvent {
  event: string;
  data: any;
  id?: string;
  raw: string;
  at: number;
}

export class SSEClient {
  all: SSEEvent[] = [];
  /** every byte the server has sent, decoded — used for `retry:` assertions */
  rawText = "";
  firstChunk = "";
  status = 0;
  headers: Headers = new Headers();
  closed = false;
  error: unknown = null;

  private ctrl = new AbortController();
  private buf = "";

  static async connect(base: string, opts: { timeout?: number } = {}): Promise<SSEClient> {
    const c = new SSEClient();
    const res = await fetch(base + "/events", {
      headers: { accept: "text/event-stream" },
      signal: c.ctrl.signal,
    });
    c.status = res.status;
    c.headers = res.headers;
    if (!res.body) throw new Error("GET /events returned no body");
    const ms = opts.timeout ?? 5000;
    /* resolve-only (never reject) so a losing racer cannot become an
       unhandled rejection and take the test runner down with it */
    const first = await new Promise<"bytes" | "timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), ms);
      c.pump(res.body!, () => {
        clearTimeout(t);
        resolve("bytes");
      });
    });
    if (first === "timeout") {
      c.close();
      throw new Error(`GET /events sent no bytes within ${ms}ms`);
    }
    return c;
  }

  private async pump(body: ReadableStream<Uint8Array>, onFirstChunk: () => void) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let gotFirst = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        if (!gotFirst) {
          gotFirst = true;
          this.firstChunk = chunk;
          onFirstChunk();
        }
        this.rawText += chunk;
        this.buf += chunk;
        this.drain();
      }
    } catch (e) {
      this.error = e;
    } finally {
      this.closed = true;
      if (!gotFirst) onFirstChunk();
    }
  }

  private drain() {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) return;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = parseFrame(block);
      if (ev) this.all.push(ev);
    }
  }

  mark(): number {
    return this.all.length;
  }

  since(from: number, name?: string): SSEEvent[] {
    return this.all.slice(from).filter((e) => !name || e.event === name);
  }

  async waitFor(
    name: string,
    opts: { from?: number; match?: (data: any) => boolean; timeout?: number } = {}
  ): Promise<SSEEvent> {
    const from = opts.from ?? 0;
    const timeout = opts.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    for (;;) {
      for (let i = from; i < this.all.length; i++) {
        const e = this.all[i];
        if (e.event !== name) continue;
        if (opts.match && !opts.match(e.data)) continue;
        return e;
      }
      if (Date.now() >= deadline) {
        const seen = this.all
          .slice(from)
          .map((e) => `${e.event}:${JSON.stringify(e.data)}`)
          .join("\n    ");
        throw new Error(
          `timed out after ${timeout}ms waiting for SSE '${name}'.\n  events since mark:\n    ${seen || "(none)"}`
        );
      }
      await sleep(25);
    }
  }

  /** wait `ms`, then return every matching event that showed up since `from` */
  async collect(ms: number, from: number, name?: string): Promise<SSEEvent[]> {
    await sleep(ms);
    return this.since(from, name);
  }

  close() {
    this.closed = true;
    try {
      this.ctrl.abort();
    } catch {}
  }
}

function parseFrame(block: string): SSEEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }
  /* per the SSE spec a block with no data field dispatches nothing — that is
     what keeps the standalone `retry: 1000` preamble out of `all` */
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join("\n");
  let data: any = null;
  if (rawData) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }
  return { event, data, id, raw: block, at: Date.now() };
}

/* ------------------------------------------------------------------
   server harness
   ------------------------------------------------------------------ */

export interface ApiResult<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  res: Response;
}

export interface TestServer {
  port: number;
  base: string;
  vault: string;
  proc: Subprocess;
  stdoutLines: string[];
  stderrLines: string[];
  readyLine: string;
  exitCode: number | null;
  url(path: string): string;
  api<T = any>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<ApiResult<T>>;
  get<T = any>(path: string): Promise<ApiResult<T>>;
  doc(path: string): Promise<ApiResult>;
  putDoc(path: string, markdown: string, rev?: string | null): Promise<ApiResult>;
  sse(opts?: { timeout?: number }): Promise<SSEClient>;
  stop(): Promise<number>;
}

export interface StartOptions {
  seed?: SeedMap;
  /** reuse an existing vault directory instead of building a fresh one */
  vault?: string;
  env?: Record<string, string>;
  /** how long to wait for the ready line */
  timeout?: number;
  /** keep the temp vault after stop() (debugging) */
  keepVault?: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `server/index.ts not found at ${SERVER_ENTRY}. The backend entrypoint is a fixed convention — ` +
        `phase-1 tests cannot run until it exists.`
    );
  }

  const vault = opts.vault ?? makeVault(opts.seed ?? {});
  const port = await freePort();

  const proc = Bun.spawn(["bun", "server/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ZNOTES_VAULT: vault,
      ZNOTES_PORT: String(port),
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let readyLine = "";
  const timeout = opts.timeout ?? 20000;

  /* the readiness race never rejects — a rejected loser would surface as an
     unhandled rejection long after the winner was awaited */
  type Outcome = { ok: true } | { ok: false; why: string };
  let settle: (o: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((resolve) => (settle = resolve));

  const timer = setTimeout(
    () => settle({ ok: false, why: `no ready line within ${timeout}ms` }),
    timeout
  );

  pumpLines(proc.stdout as ReadableStream<Uint8Array>, stdoutLines, (line) => {
    if (!readyLine && line.includes("listening on http://localhost:")) {
      readyLine = line;
      settle({ ok: true });
    }
  });
  pumpLines(proc.stderr as ReadableStream<Uint8Array>, stderrLines, () => {});
  proc.exited.then((code) => settle({ ok: false, why: `process exited with code ${code}` }));

  const result = await outcome;
  clearTimeout(timer);
  if (!result.ok) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    if (!opts.vault && !opts.keepVault) dropVault(vault);
    throw new Error(
      `bun server/index.ts never announced readiness (${result.why}).\n` +
        `expected stdout line: "z-notes listening on http://localhost:${port}"\n` +
        `stdout:\n${stdoutLines.join("\n") || "(empty)"}\n` +
        `stderr:\n${stderrLines.join("\n") || "(empty)"}`
    );
  }

  const base = `http://localhost:${port}`;

  const srv: TestServer = {
    port,
    base,
    vault,
    proc,
    stdoutLines,
    stderrLines,
    readyLine,
    exitCode: null,
    url: (p: string) => base + (p.startsWith("/") ? p : "/" + p),

    async api<T = any>(method: string, p: string, body?: unknown, init: RequestInit = {}) {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(srv.url(p), {
        method,
        headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...init,
      });
      const text = await res.text();
      let parsed: any = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: res.status, body: parsed as T, text, headers: res.headers, res };
    },

    get: (p: string) => srv.api("GET", p),
    doc: (p: string) => srv.api("GET", "/api/docs/" + encPath(p)),
    putDoc: (p: string, markdown: string, rev?: string | null) =>
      srv.api("PUT", "/api/docs/" + encPath(p), rev === undefined ? { markdown } : { markdown, rev }),

    sse: (o = {}) => SSEClient.connect(base, o),

    async stop() {
      if (srv.exitCode != null) return srv.exitCode;
      proc.kill("SIGTERM");
      let done = false;
      const hardKill = setTimeout(() => {
        if (!done) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }, 5000);
      const code = await proc.exited;
      done = true;
      clearTimeout(hardKill);
      srv.exitCode = typeof code === "number" ? code : -1;
      if (!opts.vault && !opts.keepVault) dropVault(vault);
      return srv.exitCode;
    },
  };

  return srv;
}

async function pumpLines(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: string[],
  onLine: (line: string) => void
) {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        sink.push(line);
        onLine(line);
      }
    }
  } catch {
    /* stream torn down with the process */
  }
  if (buf) {
    sink.push(buf);
    onLine(buf);
  }
}

/* ------------------------------------------------------------------
   headless chromium discovery (shared by the e2e gate)
   ------------------------------------------------------------------ */

/* env vars that pin an explicit binary; first one that exists wins. CI images,
   nix shells and container builds all use one of these. */
const CHROMIUM_ENV_KEYS = ["ZNOTES_CHROMIUM", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"];

/* Playwright cache roots, per platform. PLAYWRIGHT_BROWSERS_PATH is Playwright's
   own override and therefore also ours — "0" means "next to the package" and is
   not a directory, so it is filtered out. */
function chromiumRoots(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    home && join(home, "Library/Caches/ms-playwright"), // macOS
    home && join(home, ".cache/ms-playwright"), // linux, incl. GitHub runners
    home && join(home, "AppData/Local/ms-playwright"), // windows
    "/root/.cache/ms-playwright", // linux containers running as root
    "/ms-playwright", // mcr.microsoft.com/playwright images
  ].filter((r): r is string => !!r && r !== "0");
}

/* Layouts Playwright unpacks into a cache root. Headless shell first — it is what
   the browser gates actually want — then the full browser, whose directory name
   is platform- and arch-suffixed (chrome-mac, chrome-mac-arm64, chrome-linux…). */
const CHROMIUM_PATTERNS = [
  "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
  "chromium_headless_shell-*/chrome-linux/headless_shell",
  "chromium_headless_shell-*/chrome-win/headless_shell.exe",
  "chromium-*/chrome-linux/chrome",
  "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
  "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chromium-*/chrome-win/chrome.exe",
];

/* last resort: a system-installed Chrome/Chromium. Still a real browser, so the
   gate keeps its teeth; it just means CI does not hard-fail when the Playwright
   download is unavailable. */
const CHROMIUM_SYSTEM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Playwright build revisions are numeric ("chromium-1208"): sort by number, not
    lexically, so 1208 does not sort above 999 the wrong way round. */
function revisionOf(relPath: string): number {
  const m = /-(\d+)(?:[/\\]|$)/.exec(relPath.split(/[/\\]/)[0] ?? "");
  return m ? Number(m[1]) : -1;
}

export function findChromium(): string {
  for (const key of CHROMIUM_ENV_KEYS) {
    const v = process.env[key];
    if (v && existsSync(v)) return v;
  }

  const roots = chromiumRoots();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const pattern of CHROMIUM_PATTERNS) {
      const glob = new Bun.Glob(pattern);
      const hits = [...glob.scanSync({ cwd: root, onlyFiles: false, followSymlinks: true })];
      if (!hits.length) continue;
      hits.sort((a, b) => revisionOf(a) - revisionOf(b) || a.localeCompare(b));
      return join(root, hits[hits.length - 1]);
    }
  }

  for (const p of CHROMIUM_SYSTEM_PATHS) if (existsSync(p)) return p;

  throw new Error(
    "No Chromium found. The browser gates need a real browser.\n" +
      "Looked at $" +
      CHROMIUM_ENV_KEYS.join(", $") +
      ", then:\n" +
      roots.map((r) => CHROMIUM_PATTERNS.map((p) => `  ${r}/${p}`).join("\n")).join("\n") +
      "\n" +
      CHROMIUM_SYSTEM_PATHS.map((p) => `  ${p}`).join("\n") +
      "\nInstall one with:  bunx playwright install chromium --only-shell"
  );
}

/* ------------------------------------------------------------------
   reference fuzzy scorer — ported verbatim from the retired prototype mock.

   The gate is not "the server produced some numbers": the frontend's
   highlighter paints `matches` straight onto `text`, so the offsets have to be
   the ones this algorithm produces (leftmost-greedy subsequence). Scores are
   the server's business; the offsets are the contract.
   ------------------------------------------------------------------ */

export function refFuzzy(q: string, hay: string): { score: number; idx: number[] } | null {
  if (!q) return { score: 0, idx: [] };
  const n = q.toLowerCase();
  const h = hay.toLowerCase();
  const idx: number[] = [];
  let from = 0,
    score = 0,
    prev = -2;
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

/* ------------------------------------------------------------------
   git in a test repo. One copy of the spawn plumbing: argv only, prompts
   off, system config off, a pinned identity so commits are deterministic.
   Five test files used to carry this verbatim.
   ------------------------------------------------------------------ */

export async function git(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "z-notes test",
      GIT_AUTHOR_EMAIL: "test@z-notes.invalid",
      GIT_COMMITTER_NAME: "z-notes test",
      GIT_COMMITTER_EMAIL: "test@z-notes.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code: typeof code === "number" ? code : -1, stdout, stderr };
}

export async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** crude but sufficient: block + line comments out, `://` left alone */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
