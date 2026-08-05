/* ============================================================
   terminal.test.ts — SPEC §13, the streaming command runner.

   The whole surface at the API level, against the real server and a real
   shell: the password (set / unlock / lock / change), the exec stream, the
   persistent cwd, cancel, and every refusal that stands between an unauthorised
   caller and a process on the user's machine.

   Two properties get more than a happy path, because they are the ones a
   regression would be silent about:

     · THE PASSWORD IS NEVER READABLE. Not in a response body, not in
       `GET /api/settings`, not in settings.toml, not in the server's own log.
       Asserted by canary — one unmistakable string, searched for everywhere the
       server can write — rather than by inspecting the fields we happen to
       remember.

     · THE AI CANNOT RUN ANYTHING BY ITSELF. Everything in a model's context is
       attacker-influenceable (a pasted note, a fetched page), so `run_command`
       is gated twice: the terminal must be UNLOCKED, and — with the shipped
       default — the user must press Run. Both gates are tested by driving a
       real turn against tests/mock-upstream.ts. NEVER the real proxy: these
       tests script an upstream that asks for `run_command`, which is precisely
       what you must not send to a live endpoint.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  makeVault,
  sleep,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { reply, startMockUpstream, turn, type MockUpstream } from "./mock-upstream";

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

/** The one string that must never come back out. Deliberately unmistakable. */
const PASSWORD = "TERMCANARY-pw-7f2a9c31";
const OTHER_PASSWORD = "TERMCANARY-second-4b8e";
const AI_KEY = "sk-mock-terminal-8812aa";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  "notes/main.md": "# Main\n\nprose\n",
};

const SETTINGS_REL = ".znotes/settings.toml";

const servers: TestServer[] = [];
const mocks: MockUpstream[] = [];

async function newServer(opts: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  const s = await startServer({ seed: SEED, ...opts });
  servers.push(s);
  return s;
}

async function newMock(): Promise<MockUpstream> {
  const m = await startMockUpstream();
  mocks.push(m);
  return m;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  await Promise.all(mocks.map((m) => m.stop().catch(() => {})));
});

/* ------------------------------------------------------------------
   small utilities
   ------------------------------------------------------------------ */

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** set the first password (free, by design) and unlock — the usual preamble */
async function armed(srv: TestServer, password = PASSWORD): Promise<string> {
  const set = await srv.api("POST", "/api/terminal/password", { password });
  expect(`set password → ${set.status}`).toBe("set password → 200");
  const un = await srv.api("POST", "/api/terminal/unlock", { password });
  expect(`unlock → ${un.status}`).toBe("unlock → 200");
  expect(typeof un.body.token).toBe("string");
  return un.body.token as string;
}

interface ExecFrame {
  event: string;
  data: any;
}

interface ExecResult {
  status: number;
  frames: ExecFrame[];
  raw: string;
  stdout: string;
  stderr: string;
  exit: any | null;
  /** resolves once the stream ends */
  finished: Promise<void>;
}

/**
 * Read `POST /api/terminal/exec` (or an approved command's `/run`) as SSE.
 *
 * `onFrame` fires as frames arrive, which is how the cancel test proves the
 * output was STREAMING rather than buffered to the end: it cancels the moment
 * the first stdout chunk lands, while the child is demonstrably still alive.
 */
async function execStream(
  srv: TestServer,
  token: string | null,
  body: unknown,
  opts: { path?: string; onFrame?: (f: ExecFrame, all: ExecFrame[]) => void } = {}
): Promise<ExecResult> {
  const res = await fetch(srv.url(opts.path ?? "/api/terminal/exec"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  const out: ExecResult = {
    status: res.status,
    frames: [],
    raw: "",
    stdout: "",
    stderr: "",
    exit: null,
    finished: Promise.resolve(),
  };
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    out.raw = await res.text();
    return out;
  }

  out.finished = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      out.raw += text;
      buf += text;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          let v = i < 0 ? "" : line.slice(i + 1);
          if (v.startsWith(" ")) v = v.slice(1);
          if (field === "event") event = v;
          else if (field === "data") data.push(v);
        }
        if (!data.length) continue;
        let parsed: any = data.join("\n");
        try {
          parsed = JSON.parse(parsed);
        } catch {}
        const frame = { event, data: parsed };
        out.frames.push(frame);
        if (event === "stdout") out.stdout += parsed?.chunk ?? "";
        if (event === "stderr") out.stderr += parsed?.chunk ?? "";
        if (event === "exit") out.exit = parsed;
        opts.onFrame?.(frame, out.frames);
      }
    }
  })();

  return out;
}

/** run a command to completion and hand back the finished stream */
async function exec(srv: TestServer, token: string | null, command: string): Promise<ExecResult> {
  const r = await execStream(srv, token, { command });
  await r.finished;
  return r;
}

/* ============================================================
   1. THE PASSWORD — set, unlock, lock, change
   ============================================================ */

describe("terminal — the password gate", () => {
  test("a fresh vault is not default-open: exec is refused before a password exists", async () => {
    const srv = await newServer();

    const status = (await srv.get("/api/terminal/status")).body;
    expect(`configured: ${status.configured}`).toBe("configured: false");
    expect(`unlocked: ${status.unlocked}`).toBe("unlocked: false");
    expect(`ready: ${status.ready}`).toBe("ready: false");

    const run = await exec(srv, null, "echo should-never-run");
    expect(`exec with no password → ${run.status}`).toBe("exec with no password → 403");
    expect(`code: ${JSON.parse(run.raw || "{}")?.error}`).toBe("code: terminal-unconfigured");
    expect(`stdout leaked: ${JSON.stringify(run.stdout)}`).toBe('stdout leaked: ""');
  }, 60000);

  test("set → unlock → exec → lock → refused, all through the real routes", async () => {
    const srv = await newServer();

    const set = await srv.api("POST", "/api/terminal/password", { password: PASSWORD });
    expect(`set → ${set.status}`).toBe("set → 200");
    expect(`configured after set: ${set.body.status.configured}`).toBe("configured after set: true");
    /* setting a password does NOT unlock — the two are separate acts */
    expect(`unlocked after set: ${set.body.status.unlocked}`).toBe("unlocked after set: false");

    const un = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`unlock → ${un.status}`).toBe("unlock → 200");
    expect(`unlocked: ${un.body.status.unlocked}`).toBe("unlocked: true");
    expect(`token looks like a token: ${/^[A-Za-z0-9_-]{20,}$/.test(un.body.token)}`).toBe(
      "token looks like a token: true"
    );
    const token = un.body.token as string;

    const ran = await exec(srv, token, "echo unlocked-and-running");
    expect(`exec while unlocked → ${ran.status}`).toBe("exec while unlocked → 200");
    expect(ran.stdout.trim()).toBe("unlocked-and-running");
    expect(`exit code: ${ran.exit?.code}`).toBe("exit code: 0");

    const lock = await srv.api("POST", "/api/terminal/lock", {}, auth(token));
    expect(`lock → ${lock.status}`).toBe("lock → 200");
    expect(`unlocked after lock: ${lock.body.unlocked}`).toBe("unlocked after lock: false");

    /* the same token, now dead */
    const after = await exec(srv, token, "echo should-never-run");
    expect(`exec after lock → ${after.status}`).toBe("exec after lock → 401");
    expect(`code: ${JSON.parse(after.raw || "{}")?.error}`).toBe("code: terminal-locked");
    expect(`stdout leaked: ${JSON.stringify(after.stdout)}`).toBe('stdout leaked: ""');
  }, 60000);

  test("a bogus bearer is refused, and so is every terminal route without one", async () => {
    const srv = await newServer();
    await armed(srv);

    const bogus = "not-a-real-token-aaaaaaaaaaaaaaaaaaaa";
    const run = await exec(srv, bogus, "echo should-never-run");
    expect(`exec with a bogus bearer → ${run.status}`).toBe("exec with a bogus bearer → 401");

    for (const [method, path] of [
      ["POST", "/api/terminal/stdin"],
      ["POST", "/api/terminal/cancel"],
      ["GET", "/api/terminal/commands"],
    ] as const) {
      const r = await srv.api(method, path, method === "GET" ? undefined : {});
      expect(`${method} ${path} unauthenticated → ${r.status}`).toBe(`${method} ${path} unauthenticated → 401`);
    }

    /* …except status, which is capability and never content */
    const st = await srv.get("/api/terminal/status");
    expect(`GET status unauthenticated → ${st.status}`).toBe("GET status unauthenticated → 200");
    expect(`status.unlocked: ${st.body.unlocked}`).toBe("status.unlocked: false");
  }, 60000);

  test("changing the password needs the current one, and kills every live session", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    const naked = await srv.api("POST", "/api/terminal/password", { password: OTHER_PASSWORD });
    expect(`change with no proof → ${naked.status}`).toBe("change with no proof → 401");

    const changed = await srv.api("POST", "/api/terminal/password", {
      password: OTHER_PASSWORD,
      current: PASSWORD,
    });
    expect(`change with the current password → ${changed.status}`).toBe("change with the current password → 200");

    /* the session minted under the OLD password is exactly what a password
       change is supposed to end */
    const stale = await exec(srv, token, "echo should-never-run");
    expect(`old token after a password change → ${stale.status}`).toBe("old token after a password change → 401");

    const old = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`unlock with the OLD password → ${old.status}`).toBe("unlock with the OLD password → 401");
    const fresh = await srv.api("POST", "/api/terminal/unlock", { password: OTHER_PASSWORD });
    expect(`unlock with the NEW password → ${fresh.status}`).toBe("unlock with the NEW password → 200");
  }, 60000);

  test("a wrong password is refused, and repeated attempts are rate-limited", async () => {
    const srv = await newServer();
    await srv.api("POST", "/api/terminal/password", { password: PASSWORD });

    /* FREE_ATTEMPTS is 3: the first three wrong answers are 401s with no
       backoff, the fourth arms it. Asserted by observed behaviour, not by
       importing the constant — the property is "guessing gets slower". */
    const codes: number[] = [];
    let blockedAt = -1;
    for (let i = 0; i < 8; i++) {
      const r = await srv.api("POST", "/api/terminal/unlock", { password: "wrong-guess-" + i });
      codes.push(r.status);
      if (r.status === 429 && blockedAt < 0) {
        blockedAt = i;
        expect(`429 carries retryAfterMs: ${typeof r.body.retryAfterMs === "number" && r.body.retryAfterMs > 0}`).toBe(
          "429 carries retryAfterMs: true"
        );
      }
      /* never an oracle, and never an echo of what was tried */
      expect(`attempt ${i} echoed the guess: ${r.text.includes("wrong-guess-" + i)}`).toBe(
        `attempt ${i} echoed the guess: false`
      );
    }
    expect(`first three attempts were plain 401s: ${JSON.stringify(codes.slice(0, 3))}`).toBe(
      "first three attempts were plain 401s: [401,401,401]"
    );
    expect(`a block was reached within 8 attempts: ${blockedAt >= 0}`).toBe("a block was reached within 8 attempts: true");

    /* the point of the limiter: while blocked, even the RIGHT password is
       refused — otherwise the block would be trivially skippable */
    const rightWhileBlocked = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`correct password while blocked → ${rightWhileBlocked.status}`).toBe(
      "correct password while blocked → 429"
    );

    /* …and it is a delay, not a lockout: it lifts on its own */
    const wait = Number(rightWhileBlocked.body.retryAfterMs) || 0;
    await sleep(wait + 400);
    const afterWait = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`correct password after the backoff → ${afterWait.status}`).toBe("correct password after the backoff → 200");
  }, 90000);

  test("unlock is not an oracle for whether a vault has a terminal password", async () => {
    const configured = await newServer();
    await configured.api("POST", "/api/terminal/password", { password: PASSWORD });
    const blank = await newServer();

    const a = await configured.api("POST", "/api/terminal/unlock", { password: "some-wrong-password" });
    const b = await blank.api("POST", "/api/terminal/unlock", { password: "some-wrong-password" });

    expect(`configured vault → ${a.status} ${a.body.error}`).toBe(`configured vault → 401 bad-password`);
    expect(`unconfigured vault → ${b.status} ${b.body.error}`).toBe(`unconfigured vault → 401 bad-password`);
    /* identical shape as well as identical code: a differing message is a
       distinguisher too */
    expect(`same message: ${a.body.message === b.body.message}`).toBe("same message: true");
  }, 60000);

  test("unlock is not a TIMING oracle either — the first attempt costs the same both ways", async () => {
    /* The decoy exists so an unconfigured vault burns the same work as a
       configured one with a wrong password. Built lazily on the request path it
       did the opposite: the FIRST unlock against a vault with no password paid
       two derivations (build the decoy, then verify against it) where a
       configured vault paid one — 2x, measured, with no overlap. One request
       answered the question the decoy is there to refuse.

       Medians rather than single samples, and a generous ratio: this asserts
       "the same order of work", not a stopwatch. */
    const firstUnlockMs = async (configured: boolean) => {
      const s = await newServer();
      if (configured) {
        const set = await s.api("POST", "/api/terminal/password", { password: PASSWORD });
        expect(`set → ${set.status}`).toBe("set → 200");
      }
      /* the warm-up runs on the boot tick, off the request path; give the
         process the moment it needs to be idle before the clock starts */
      await sleep(400);
      const t0 = Date.now();
      const r = await s.api("POST", "/api/terminal/unlock", { password: "wrong-on-the-first-try" });
      const ms = Date.now() - t0;
      expect(`first unlock → ${r.status}`).toBe("first unlock → 401");
      return ms;
    };

    const set: number[] = [];
    const unset: number[] = [];
    for (let i = 0; i < 3; i++) {
      set.push(await firstUnlockMs(true));
      unset.push(await firstUnlockMs(false));
    }
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const withPassword = median(set);
    const without = median(unset);

    /* positive control: a real derivation is happening on both sides, so a
       ratio near 1 cannot be two instant answers */
    expect(`configured vault really derives (${withPassword}ms > 40): ${withPassword > 40}`).toBe(
      `configured vault really derives (${withPassword}ms > 40): true`
    );
    const ratio = without / Math.max(1, withPassword);
    expect(
      `unset/set first-unlock ratio ${ratio.toFixed(2)} (set ${JSON.stringify(set)}, unset ${JSON.stringify(
        unset
      )}) is under 1.5: ${ratio < 1.5}`
    ).toBe(
      `unset/set first-unlock ratio ${ratio.toFixed(2)} (set ${JSON.stringify(set)}, unset ${JSON.stringify(
        unset
      )}) is under 1.5: true`
    );
  }, 180000);

  test("one caller's failed attempts cannot lock a DIFFERENT caller out", async () => {
    /* The backoff bounds guessing. On a single global counter it also became
       the denial: `fails` only ever reset on a successful unlock, a blocked
       caller cannot succeed, so one unauthenticated peer failing every 700ms
       held the owner out of their own terminal indefinitely. Two loopback
       addresses are two callers here — same server, same port, different
       sockets. */
    const srv = await newServer();
    await srv.api("POST", "/api/terminal/password", { password: PASSWORD });

    const from = async (host: string, path: string, body?: unknown) => {
      const res = await fetch(`http://${host}:${srv.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: res.status, body: parsed };
    };
    const FLOOD = "127.0.0.1";
    const OWNER = "[::1]";

    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await from(FLOOD, "/api/terminal/unlock", { password: "flood-guess-" + i });
      codes.push(r.status);
    }
    /* the limiter is still doing its job to the caller doing the guessing */
    expect(`the flooder was blocked: ${codes.includes(429)} (${JSON.stringify(codes)})`).toBe(
      `the flooder was blocked: true (${JSON.stringify(codes)})`
    );

    /* the two really are separate callers, and each is told about its OWN
       backoff and nobody else's */
    const floodStatus = await from(FLOOD, "/api/terminal/status");
    const ownerStatus = await from(OWNER, "/api/terminal/status");
    expect(`the flooder is told to wait: ${floodStatus.body.retryAfterMs > 0}`).toBe("the flooder is told to wait: true");
    expect(`the owner is not: ${ownerStatus.body.retryAfterMs}`).toBe("the owner is not: 0");

    /* and the owner can still get in, with no wait, while the flood's block is
       demonstrably still standing */
    const owner = await from(OWNER, "/api/terminal/unlock", { password: PASSWORD });
    expect(`the owner unlocked → ${owner.status}`).toBe("the owner unlocked → 200");
    const stillBlocked = await from(FLOOD, "/api/terminal/unlock", { password: PASSWORD });
    expect(`the flooder is still blocked → ${stillBlocked.status}`).toBe("the flooder is still blocked → 429");
  }, 90000);

  test("`enabled = false` is a hard off-switch, above the password", async () => {
    const srv = await newServer();
    await armed(srv);
    const off = await srv.api("PUT", "/api/settings", { terminal: { enabled: false } });
    expect(`PUT enabled=false → ${off.status}`).toBe("PUT enabled=false → 200");

    const run = await exec(srv, null, "echo should-never-run");
    expect(`exec with the terminal off → ${run.status}`).toBe("exec with the terminal off → 403");
    expect(`code: ${JSON.parse(run.raw || "{}")?.error}`).toBe("code: terminal-disabled");

    const un = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`unlock with the terminal off → ${un.status}`).toBe("unlock with the terminal off → 403");
  }, 60000);
});

/* ============================================================
   2. RUNNING — streaming, cwd, cancel
   ============================================================ */

describe("terminal — running commands", () => {
  test("exec STREAMS: stdout arrives in frames before the stream ends", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    /* three lines with a real gap between them. If the server buffered the
       command and answered at exit, the first chunk and the exit frame would
       land together; the timings below are what distinguish the two. */
    const stamps: Array<{ event: string; at: number }> = [];
    const r = await execStream(
      srv,
      token,
      { command: `echo one; sleep 0.4; echo two; sleep 0.4; echo three` },
      { onFrame: (f) => stamps.push({ event: f.event, at: Date.now() }) }
    );
    await r.finished;

    expect(`exec → ${r.status}`).toBe("exec → 200");
    expect(r.stdout.split("\n").filter(Boolean)).toEqual(["one", "two", "three"]);
    expect(`exit code: ${r.exit?.code}`).toBe("exit code: 0");

    const firstOut = stamps.find((s) => s.event === "stdout");
    const exitAt = stamps.find((s) => s.event === "exit");
    expect(`saw a stdout frame: ${!!firstOut}`).toBe("saw a stdout frame: true");
    expect(`saw an exit frame: ${!!exitAt}`).toBe("saw an exit frame: true");
    /* the whole command takes ~800ms; a buffered implementation delivers the
       first byte within a few ms of the exit. 300ms is a wide margin. */
    const lead = exitAt!.at - firstOut!.at;
    expect(`first stdout led exit by >300ms (was ${lead}ms): ${lead > 300}`).toBe(
      `first stdout led exit by >300ms (was ${lead}ms): true`
    );

    /* the `start` frame comes first and names the command */
    expect(`first frame: ${r.frames[0]?.event}`).toBe("first frame: start");
    expect(r.frames[0]?.data?.command).toBe("echo one; sleep 0.4; echo two; sleep 0.4; echo three");
    expect(`source: ${r.frames[0]?.data?.source}`).toBe("source: user");
  }, 90000);

  test("stdout and stderr stay separate, and a non-zero exit is reported as itself", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    const r = await exec(srv, token, `echo to-out; echo to-err >&2; exit 7`);
    expect(r.stdout.trim()).toBe("to-out");
    expect(r.stderr.trim()).toBe("to-err");
    expect(`exit code: ${r.exit?.code}`).toBe("exit code: 7");
    expect(`exit signal: ${r.exit?.signal}`).toBe("exit signal: null");
  }, 60000);

  test("the cwd persists across commands — and survives a server restart", async () => {
    const vault = makeVault(SEED);
    const srv = await newServer({ vault });
    const token = await armed(srv);

    const home = await exec(srv, token, "pwd");
    expect(`starts at the vault root: ${home.stdout.trim().endsWith(vault.split("/").pop()!)}`).toBe(
      "starts at the vault root: true"
    );

    const moved = await exec(srv, token, "cd /usr && echo moved");
    expect(moved.stdout.trim()).toBe("moved");
    expect(`exit reports the new cwd: ${moved.exit?.cwd}`).toBe("exit reports the new cwd: /usr");

    /* the next command is a SEPARATE shell — this is the whole point */
    const next = await exec(srv, token, "pwd");
    expect(`cwd persisted into the next command: ${next.stdout.trim()}`).toBe("cwd persisted into the next command: /usr");

    /* a command that dies before it can report keeps the previous cwd rather
       than silently resetting to the vault root */
    const died = await exec(srv, token, "cd /tmp; exit 3");
    expect(`exit code: ${died.exit?.code}`).toBe("exit code: 3");
    const stillThere = await exec(srv, token, "pwd");
    expect(`cwd after an early exit: ${stillThere.stdout.trim()}`).toBe("cwd after an early exit: /usr");

    /* and it is durable: a fresh process on the same vault resumes there */
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const rebooted = await newServer({ vault });
    const token2 = (await rebooted.api("POST", "/api/terminal/unlock", { password: PASSWORD })).body.token;
    const afterReboot = await exec(rebooted, token2, "pwd");
    expect(`cwd after a restart: ${afterReboot.stdout.trim()}`).toBe("cwd after a restart: /usr");
  }, 120000);

  test("cancel kills the whole subtree, not just the shell", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    /* `echo go` proves the child is alive and streaming; the `sleep` is the
       thing that must die. A marker in the sleep's argv makes it findable in
       `ps` afterwards — a SIGTERM to the shell alone leaves it holding the
       pipes, which is the bug this guards. */
    const marker = `znotes-cancel-canary-${Date.now()}`;
    let cancelled = false;
    const started = Date.now();
    const r = await execStream(
      srv,
      token,
      { command: `echo go; sleep 300 # ${marker}` },
      {
        onFrame: (f) => {
          if (f.event !== "stdout" || cancelled) return;
          cancelled = true;
          srv.api("POST", "/api/terminal/cancel", {}, auth(token)).catch(() => {});
        },
      }
    );
    await r.finished;
    const elapsed = Date.now() - started;

    expect(`cancel was issued: ${cancelled}`).toBe("cancel was issued: true");
    expect(r.stdout.trim()).toBe("go");
    expect(`the 300s sleep ended in ${elapsed}ms (<20000): ${elapsed < 20000}`).toBe(
      `the 300s sleep ended in ${elapsed}ms (<20000): true`
    );
    expect(`exit signal: ${r.exit?.signal}`).toBe("exit signal: SIGTERM");

    /* the subtree really died — an orphan would still be in the process table */
    await sleep(300);
    const ps = await new Response(Bun.spawn(["ps", "-A", "-o", "args="], { stdout: "pipe" }).stdout).text();
    expect(`an orphan survived cancel: ${ps.includes(marker)}`).toBe("an orphan survived cancel: false");

    /* and the runner is usable again immediately */
    const after = await exec(srv, token, "echo still-here");
    expect(after.stdout.trim()).toBe("still-here");
  }, 90000);

  test("only one command runs at a time", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    const slow = await execStream(srv, token, { command: "sleep 2; echo done" });
    await waitUntil(async () => ((await srv.get("/api/terminal/status")).body.running ? true : null), {
      timeout: 5000,
      label: "a command to be running",
    });
    const second = await exec(srv, token, "echo me-too");
    expect(`a second concurrent exec → ${second.status}`).toBe("a second concurrent exec → 409");

    await srv.api("POST", "/api/terminal/cancel", {}, auth(token));
    await slow.finished;
  }, 60000);

  test("shell diagnostics carry the line number the USER typed, not the wrapper's", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    /* The command is spliced onto line 1 of the wrapper. It used to sit on line
       2, under a `cd` of its own, so every diagnostic the shell reports by line
       number pointed one line past what the user wrote — and a parse error
       quoted `$__zec`, an internal variable, at a line their input does not
       have. Asserted on the SHAPE (":1:" / "line 1"), because zsh, bash and
       dash each phrase it differently. */
    const missing = await exec(srv, token, "nosuchcommand_znotes_xyz");
    expect(`the shell complained: ${missing.stderr.trim().length > 0}`).toBe("the shell complained: true");
    expect(`stderr blames line 1 (${JSON.stringify(missing.stderr.trim())}): ${/[\s:]1:/.test(missing.stderr)}`).toBe(
      `stderr blames line 1 (${JSON.stringify(missing.stderr.trim())}): true`
    );
    expect(`stderr blames a line the user never wrote: ${/[\s:][2-9]:/.test(missing.stderr)}`).toBe(
      "stderr blames a line the user never wrote: false"
    );

    /* a `cd` that fails is reported against the user's own line too */
    const badCd = await exec(srv, token, "cd /no/such/dir/anywhere");
    expect(`cd stderr blames line 2+: ${/[\s:][2-9]:/.test(badCd.stderr)}`).toBe("cd stderr blames line 2+: false");

    /* and nothing names the wrapper's old internal variable */
    const parse = await exec(srv, token, "if [");
    for (const r of [missing, badCd, parse]) {
      expect(`stderr leaks __zec: ${r.stderr.includes("__zec")}`).toBe("stderr leaks __zec: false");
    }
    /* the cwd hand-off still works after the rewrite — the wrapper's whole job */
    const moved = await exec(srv, token, "cd /usr");
    expect(`cwd after the rewritten wrapper: ${moved.exit?.cwd}`).toBe("cwd after the rewritten wrapper: /usr");
  }, 90000);

  test("a command that blocks with nothing to show SAYS so instead of looking like work", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    /* `cat` with no argument is the honest shape of the `vim` case SPEC §13
       names: there is no TTY, so it sits on stdin forever and the only ends are
       Stop/Ctrl+C and the 30-minute clock. TERM=dumb and the GIT_EDITOR shim
       cannot reach it — it is not a pager and not an editor git invoked — so
       the runner says out loud that nothing has been printed. */
    let notice = "";
    const started = Date.now();
    const r = await execStream(
      srv,
      token,
      { command: "cat" },
      {
        onFrame: (f) => {
          if (f.event !== "notice" || notice) return;
          notice = String(f.data?.message ?? "");
          srv.api("POST", "/api/terminal/cancel", {}, auth(token)).catch(() => {});
        },
      }
    );
    await r.finished;
    const elapsed = Date.now() - started;

    expect(`a notice arrived: ${!!notice}`).toBe("a notice arrived: true");
    expect(`it says it is still running: ${/still running/i.test(notice)}`).toBe("it says it is still running: true");
    expect(`it names the way out: ${/Ctrl\+C|Stop/.test(notice)}`).toBe("it names the way out: true");
    /* …and it did not wait for the 30-minute wall clock to say it */
    expect(`said it within 30s (was ${elapsed}ms): ${elapsed < 30000}`).toBe(
      `said it within 30s (was ${elapsed}ms): true`
    );
  }, 90000);

  test("stdin reaches the child", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    let sent = false;
    const r = await execStream(
      srv,
      token,
      { command: `printf 'name? '; read a; echo "answer=$a"` },
      {
        onFrame: (f) => {
          if (f.event !== "stdout" || sent) return;
          sent = true;
          srv.api("POST", "/api/terminal/stdin", { data: "hello\n" }, auth(token)).catch(() => {});
        },
      }
    );
    await r.finished;
    expect(`the prompt streamed before any input: ${sent}`).toBe("the prompt streamed before any input: true");
    expect(`stdin reached the child: ${r.stdout.includes("answer=hello")}`).toBe("stdin reached the child: true");
  }, 60000);

  test("stdin is bound to the command it was typed at, not to `whatever is running`", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    /* What the user is answering is the prompt in front of them. A client whose
       idea of the running command is stale — another tab, or one that missed a
       hand-off — must not be able to put a passphrase or a `y` into a different
       process, so the write names its target and a mismatch is refused. */
    let tried = false;
    const refusals: string[] = [];
    const r = await execStream(
      srv,
      token,
      { command: `printf 'name? '; read a; echo "answer=$a"` },
      {
        onFrame: (f, all) => {
          if (f.event !== "stdout" || tried) return;
          tried = true;
          const id = String(all[0]?.data?.id ?? "");
          (async () => {
            const wrong = await srv.api(
              "POST",
              "/api/terminal/stdin",
              { data: "SECRET-FOR-SOMEONE-ELSE\n", id: "cmd_not_this_one" },
              auth(token)
            );
            refusals.push(`${wrong.status} ${wrong.body?.error}`);
            await srv.api("POST", "/api/terminal/stdin", { data: "hello\n", id }, auth(token));
          })().catch(() => {});
        },
      }
    );
    await r.finished;

    expect(`a stale id was refused: ${JSON.stringify(refusals)}`).toBe(
      'a stale id was refused: ["409 wrong-command"]'
    );
    expect(`the refused line reached the child: ${r.stdout.includes("SECRET-FOR-SOMEONE-ELSE")}`).toBe(
      "the refused line reached the child: false"
    );
    expect(`the right id still works: ${r.stdout.includes("answer=hello")}`).toBe("the right id still works: true");
  }, 60000);
});

/* ============================================================
   3. CROSS-SITE — the guard in front of every mutating route
   ============================================================ */

describe("terminal — cross-site writes are refused", () => {
  test("every mutating terminal route refuses a cross-site POST", async () => {
    const srv = await newServer();
    const token = await armed(srv);

    const routes = [
      "/api/terminal/unlock",
      "/api/terminal/lock",
      "/api/terminal/password",
      "/api/terminal/exec",
      "/api/terminal/stdin",
      "/api/terminal/cancel",
      "/api/terminal/commands/cmd_whatever/run",
      "/api/terminal/commands/cmd_whatever/reject",
    ];

    for (const path of routes) {
      /* the header a browser sets on a request a DIFFERENT origin initiated —
         the one thing an attacker's page cannot forge */
      const r = await srv.api("POST", path, { command: "echo should-never-run", password: PASSWORD }, {
        headers: { "sec-fetch-site": "cross-site", authorization: `Bearer ${token}` },
      });
      expect(`cross-site POST ${path} → ${r.status} ${r.body?.error}`).toBe(
        `cross-site POST ${path} → 403 cross-site`
      );
    }

    /* an `Origin` from elsewhere, for the client that sends no Sec-Fetch-Site */
    const byOrigin = await srv.api("POST", "/api/terminal/exec", { command: "echo should-never-run" }, {
      headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
    });
    expect(`cross-origin POST exec → ${byOrigin.status} ${byOrigin.body?.error}`).toBe(
      "cross-origin POST exec → 403 cross-site"
    );

    /* and the guard did not cost the legitimate same-origin caller anything */
    const ok = await exec(srv, token, "echo same-origin-ok");
    expect(ok.stdout.trim()).toBe("same-origin-ok");
  }, 90000);
});

/* ============================================================
   4. THE PASSWORD IS NEVER READABLE
   ============================================================ */

describe("terminal — the password never comes back out", () => {
  test("no response, no settings surface, no file and no log line carries it", async () => {
    const vault = makeVault(SEED);
    /* logging turned fully ON on purpose: "the password is not in the log" is
       only worth anything when the log is actually being written. */
    const srv = await newServer({ vault, env: { ZNOTES_TERMINAL_LOG: "1" } });

    /* every response the password itself passes through */
    const bodies: Array<[string, string]> = [];
    const set = await srv.api("POST", "/api/terminal/password", { password: PASSWORD });
    bodies.push(["POST /api/terminal/password", set.text]);
    const un = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    bodies.push(["POST /api/terminal/unlock", un.text]);
    const token = un.body.token as string;

    const bad = await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD + "-nope" });
    bodies.push(["POST /api/terminal/unlock (wrong)", bad.text]);
    bodies.push(["GET /api/terminal/status", (await srv.get("/api/terminal/status")).text]);
    bodies.push(["GET /api/settings", (await srv.get("/api/settings")).text]);
    bodies.push([
      "GET /api/terminal/commands",
      (await srv.api("GET", "/api/terminal/commands", undefined, auth(token))).text,
    ]);
    /* a PUT that tries to set it through the settings surface must not echo it
       either — it is absorbed and stripped, never stored as text */
    bodies.push([
      "PUT /api/settings {terminal.password}",
      (await srv.api("PUT", "/api/settings", { terminal: { password: PASSWORD } })).text,
    ]);
    const ran = await exec(srv, token, "echo done");
    bodies.push(["POST /api/terminal/exec (SSE)", ran.raw]);

    for (const [where, text] of bodies) {
      expect(`${where} carries the password: ${text.includes(PASSWORD)}`).toBe(
        `${where} carries the password: false`
      );
    }

    /* the committed file */
    const tomlPath = join(vault, SETTINGS_REL);
    const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    expect(`settings.toml carries the password: ${toml.includes(PASSWORD)}`).toBe(
      "settings.toml carries the password: false"
    );
    expect(`settings.toml carries a bare \`password =\` key: ${/^\s*password\s*=/m.test(toml)}`).toBe(
      "settings.toml carries a bare `password =` key: false"
    );

    /* the server's own log — the surface a `console.log(body)` regression hits
       first, and the one nobody reads until it is in a bug report */
    await sleep(200);
    const log = [...srv.stdoutLines, ...srv.stderrLines].join("\n");
    expect(`the server log carries the password: ${log.includes(PASSWORD)}`).toBe(
      "the server log carries the password: false"
    );
    /* the log DOES record that something happened — otherwise "no password in
       the log" would be satisfied by logging nothing at all */
    expect(`the log records the unlock: ${/terminal: unlocked/.test(log)}`).toBe("the log records the unlock: true");

    /* What IS stored is a verifier, not the password. Read after a clean stop
       so sqlite has checkpointed its WAL into the file — otherwise "the
       password is not in index.db" would pass simply because nothing is yet. */
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const stored = readFileSync(join(vault, ".znotes", "index.db")).toString("latin1");
    expect(`the database carries the password verbatim: ${stored.includes(PASSWORD)}`).toBe(
      "the database carries the password verbatim: false"
    );
    expect(`the database carries a scrypt verifier: ${/scrypt\$\d+\$\d+\$\d+\$/.test(stored)}`).toBe(
      "the database carries a scrypt verifier: true"
    );
  }, 90000);

  /* The complement of the test below, and the path the dev vault is seeded
     through: on a vault with NO password yet, a hand-written
     `[terminal] password = "…"` is the documented way to configure a terminal
     without a UI (settings.ts §"FIRST-RUN CREDENTIALS"). The two tests are a
     pair — adopt when there is nothing to overwrite, refuse when there is —
     and only together do they say the rule is a rule rather than a blanket
     yes or a blanket no.

     A TEMP vault, deliberately. The checkout's own `vault/` really does carry a
     seeded password, but its settings.toml and index.db are mutable dev state
     that any run of the app can change, so asserting against them would be
     measuring a fixture nobody maintains. This builds the same situation from
     nothing and tears it down. */
  test("a settings.toml password IS adopted on a vault that has none — and the plaintext does not survive it", async () => {
    const SEEDED = "TERMCANARY-seeded-9d41c7";
    /* written before the server has ever seen this vault: the first-boot
       situation, not a file edited afterwards */
    const vault = makeVault({
      ...SEED,
      [SETTINGS_REL]: `theme = "modern"\n\n[terminal]\nenabled = true\npassword = "${SEEDED}"\n`,
    });

    const srv = await newServer({ vault });

    /* 1 · it is configured without anyone having called POST /password */
    const status = await srv.get("/api/terminal/status");
    expect(`configured straight from the file: ${status.body.configured}`).toBe(
      "configured straight from the file: true"
    );
    expect(`and still locked: ${status.body.unlocked}`).toBe("and still locked: false");

    /* 2 · the seeded string is the one that opens it — the assertion that
       separates "adopted" from "noticed and thrown away" */
    const un = await srv.api("POST", "/api/terminal/unlock", { password: SEEDED });
    expect(`the seeded password unlocks → ${un.status}`).toBe("the seeded password unlocks → 200");
    const token = un.body.token as string;
    expect(`it hands back a token: ${/^[A-Za-z0-9_-]{20,}$/.test(token)}`).toBe("it hands back a token: true");

    /* nothing else does */
    const wrong = await srv.api("POST", "/api/terminal/unlock", { password: SEEDED + "-nope" });
    expect(`a near-miss → ${wrong.status}`).toBe("a near-miss → 401");

    /* 3 · and it is a WORKING terminal, not merely an unlocked flag */
    const ran = await exec(srv, token, "echo adopted-ok");
    expect(`the adopted session runs a command: ${ran.stdout.trim()}`).toBe(
      "the adopted session runs a command: adopted-ok"
    );

    /* 4 · the plaintext is gone from the file it arrived in. `password =` as
       well as the value: a rewrite that left `password = ""` behind would pass
       a substring check while still telling the next reader this is where
       passwords go. */
    await waitUntil(async () => !readFileSync(join(vault, SETTINGS_REL), "utf8").includes(SEEDED), {
      label: "the seeded password to be stripped from settings.toml",
      timeout: 15000,
    });
    const toml = readFileSync(join(vault, SETTINGS_REL), "utf8");
    expect(`settings.toml still carries the plaintext: ${toml.includes(SEEDED)}`).toBe(
      "settings.toml still carries the plaintext: false"
    );
    expect(`settings.toml still carries a \`password =\` key: ${/^\s*password\s*=/m.test(toml)}`).toBe(
      "settings.toml still carries a `password =` key: false"
    );
    /* the rest of the hand-written file survived — stripping one key is not a
       licence to discard the settings that came with it */
    expect(`the neighbouring settings survived: ${(await srv.get("/api/settings")).body.settings.theme}`).toBe(
      "the neighbouring settings survived: modern"
    );

    /* 5 · it says so, once, out loud — a silent adoption is a credential
       appearing from nowhere */
    const log = [...srv.stdoutLines, ...srv.stderrLines].join("\n");
    expect(`the boot log records the adoption: ${/terminal password adopted/i.test(log)}`).toBe(
      "the boot log records the adoption: true"
    );
    expect(`…without printing the password: ${log.includes(SEEDED)}`).toBe("…without printing the password: false");

    /* 6 · what is stored is a verifier. Read after a clean stop so sqlite has
       checkpointed its WAL, or "not in the db" passes because nothing is. */
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const db = readFileSync(join(vault, ".znotes", "index.db")).toString("latin1");
    expect(`index.db carries the plaintext: ${db.includes(SEEDED)}`).toBe("index.db carries the plaintext: false");
    expect(`index.db carries a scrypt verifier: ${/scrypt\$\d+\$\d+\$\d+\$/.test(db)}`).toBe(
      "index.db carries a scrypt verifier: true"
    );
  }, 90000);

  test("a settings.toml password cannot REPLACE one that already exists", async () => {
    const vault = makeVault(SEED);
    const srv = await newServer({ vault });
    await srv.api("POST", "/api/terminal/password", { password: PASSWORD });
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);

    /* a synced settings.toml — the shape an attacker who can write a note has */
    const tomlPath = join(vault, SETTINGS_REL);
    const before = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    Bun.write(tomlPath, before + `\n[terminal]\npassword = "${OTHER_PASSWORD}"\n`);

    const rebooted = await newServer({ vault });
    const attacker = await rebooted.api("POST", "/api/terminal/unlock", { password: OTHER_PASSWORD });
    expect(`the injected password → ${attacker.status}`).toBe("the injected password → 401");
    const owner = await rebooted.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`the real password still works → ${owner.status}`).toBe("the real password still works → 200");

    /* and it was stripped from the file rather than left lying in the vault */
    const after = readFileSync(tomlPath, "utf8");
    expect(`the injected password survived in the file: ${after.includes(OTHER_PASSWORD)}`).toBe(
      "the injected password survived in the file: false"
    );
  }, 90000);
});

/* ============================================================
   5. THE AI TOOL — unlocked AND approved, both required

   Everything here runs against tests/mock-upstream.ts. A scripted `run_command`
   is precisely the payload you must never send to a live endpoint, and the
   gates below are only observable when the upstream is under test control.
   ============================================================ */

async function aiServer(opts: { autoRun?: boolean; password?: string | null } = {}) {
  const srv = await newServer();
  const mock = await newMock();
  const r = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: AI_KEY, model: "gpt-5", effort: "high" },
    git: { autoSyncSeconds: 600 },
    terminal: { allowAiAutoRun: !!opts.autoRun },
  });
  expect(`PUT /api/settings → ${r.status}`).toBe("PUT /api/settings → 200");
  let token: string | null = null;
  if (opts.password !== null) token = await armed(srv, opts.password ?? PASSWORD);
  await sleep(250); // let the capability probe settle
  return { srv, mock, token };
}

const runCommand = (command: string, why = "because the test asked") =>
  reply.tool({ command, why }, { name: "run_command" });

describe("terminal — the AI tool is gated twice", () => {
  test("with no terminal password the model is never even told the tool exists", async () => {
    const { srv, mock } = await aiServer({ password: null });

    mock.script(reply.text("nothing to run"));
    await turn(srv, { content: "what is in this vault?" });

    /* asserted on the WIRE, which is the only thing the model can act on: the
       tool list the request declares and the system prompt it carries */
    const sent = mock.streamed().at(-1)!;
    const declared = (sent.body.tools ?? []).map((t: any) => t?.name ?? t?.function?.name).sort();
    expect(`declared tools: ${JSON.stringify(declared)}`).toBe('declared tools: ["propose_edits"]');
    expect(`the raw body mentions run_command anywhere: ${sent.bodyText.includes("run_command")}`).toBe(
      "the raw body mentions run_command anywhere: false"
    );
    /* and the system prompt does not advertise a capability that is not there */
    expect(`the prompt has a terminal section: ${/## The terminal/.test(sent.strings)}`).toBe(
      "the prompt has a terminal section: false"
    );
  }, 90000);

  test("with a password set the tool is declared — and refused while LOCKED", async () => {
    const { srv, mock, token } = await aiServer();
    await srv.api("POST", "/api/terminal/lock", {}, auth(token!));
    expect(`locked: ${(await srv.get("/api/terminal/status")).body.unlocked}`).toBe("locked: false");

    mock.script(runCommand("touch /tmp/znotes-should-never-exist"), reply.text("I cannot, it is locked."));
    await turn(srv, { content: "check the repo status" });

    /* the tool IS declared once a password exists — the capability is real, it
       is the running of it that is gated */
    const declared = (mock.streamed()[0].body.tools ?? []).map((t: any) => t?.name ?? t?.function?.name).sort();
    expect(`declared tools: ${JSON.stringify(declared)}`).toBe('declared tools: ["propose_edits","run_command"]');
    expect(`the prompt has a terminal section: ${/## The terminal/.test(mock.streamed()[0].strings)}`).toBe(
      "the prompt has a terminal section: true"
    );

    /* the model is TOLD, so it can ask the user to unlock instead of inventing
       output — and nothing was queued for later */
    expect(`the tool result says refused: ${mock.sawText('"status":"refused"')}`).toBe(
      "the tool result says refused: true"
    );
    expect(`the tool result names the reason: ${mock.sawText('"reason":"terminal-locked"')}`).toBe(
      "the tool result names the reason: true"
    );

    /* nothing ran and nothing is waiting: a locked terminal queues no work */
    const token2 = (await srv.api("POST", "/api/terminal/unlock", { password: PASSWORD })).body.token;
    const list = await srv.api("GET", "/api/terminal/commands", undefined, auth(token2));
    expect(`commands recorded while locked: ${list.body.commands.length}`).toBe("commands recorded while locked: 0");
    expect(`the command ran anyway: ${existsSync("/tmp/znotes-should-never-exist")}`).toBe(
      "the command ran anyway: false"
    );
  }, 90000);

  test("unlocked but with the shipped default, the command WAITS for the user", async () => {
    const { srv, mock, token } = await aiServer();
    expect(`allowAiAutoRun default: ${(await srv.get("/api/terminal/status")).body.allowAiAutoRun}`).toBe(
      "allowAiAutoRun default: false"
    );

    const canary = `znotes-approval-canary-${Date.now()}`;
    mock.script(runCommand(`echo ${canary}`), reply.text("asked; waiting for you."));
    const t = await turn(srv, { content: "print the canary" });

    /* the turn ENDED rather than running anything */
    const list = await srv.api("GET", "/api/terminal/commands", undefined, auth(token!));
    expect(`one command is recorded: ${list.body.commands.length}`).toBe("one command is recorded: 1");
    const rec = list.body.commands[0];
    expect(`state: ${rec.state}`).toBe("state: pending");
    expect(`command: ${rec.command}`).toBe(`command: echo ${canary}`);
    expect(`output before approval: ${JSON.stringify(rec.output)}`).toBe("output before approval: null");
    expect(`exitCode before approval: ${JSON.stringify(rec.exitCode)}`).toBe("exitCode before approval: null");

    /* the TURN ENDED. Not "the model was told to wait and kept going" — the
       relay stopped, so there is exactly ONE upstream call and no follow-up
       into which output could ever have been folded. */
    expect(`upstream calls this turn: ${mock.streamed().length}`).toBe("upstream calls this turn: 1");
    expect(`the output reached the model: ${mock.sawText(canary)}`).toBe("the output reached the model: false");
    expect(`the turn's own stream leaked the output: ${t.wire().includes(canary + "\\n")}`).toBe(
      "the turn's own stream leaked the output: false"
    );

    /* the user's surface DOES learn about it — that is the Run/Reject card */
    const shown = t.done()?.commands ?? [];
    expect(`the client was shown 1 pending command: ${shown.length} / ${shown[0]?.state}`).toBe(
      "the client was shown 1 pending command: 1 / pending"
    );

    /* the user presses Run — and only then does it execute */
    const ran = await execStream(srv, token!, {}, { path: `/api/terminal/commands/${rec.id}/run` });
    await ran.finished;
    expect(`approved run → ${ran.status}`).toBe("approved run → 200");
    expect(ran.stdout.trim()).toBe(canary);

    const after = await srv.api("GET", "/api/terminal/commands", undefined, auth(token!));
    expect(`state after Run: ${after.body.commands[0].state}`).toBe("state after Run: done");
    expect(`exitCode after Run: ${after.body.commands[0].exitCode}`).toBe("exitCode after Run: 0");
  }, 120000);

  test("Reject leaves the command unrun, permanently", async () => {
    const { srv, mock, token } = await aiServer();
    mock.script(runCommand("touch /tmp/znotes-rejected-should-not-exist"), reply.text("ok"));
    await turn(srv, { content: "do the thing" });

    const list = await srv.api("GET", "/api/terminal/commands", undefined, auth(token!));
    const id = list.body.commands[0].id;
    const rej = await srv.api("POST", `/api/terminal/commands/${id}/reject`, {}, auth(token!));
    expect(`reject → ${rej.status}`).toBe("reject → 200");
    expect(`state: ${rej.body.command.state}`).toBe("state: rejected");

    const late = await execStream(srv, token!, {}, { path: `/api/terminal/commands/${id}/run` });
    await late.finished;
    expect(`running a rejected command → ${late.status}`).toBe("running a rejected command → 409");
    expect(`it ran anyway: ${existsSync("/tmp/znotes-rejected-should-not-exist")}`).toBe("it ran anyway: false");
  }, 90000);

  test("auto-run is the user's own decision — and it STILL needs an unlocked terminal", async () => {
    const { srv, mock, token } = await aiServer({ autoRun: true });

    const canary = `znotes-autorun-canary-${Date.now()}`;
    mock.script(runCommand(`echo ${canary}`), reply.text("done, here is the output."));
    await turn(srv, { content: "print the canary" });

    /* the output reached the model IN-TURN — the difference auto-run makes */
    expect(`upstream calls this turn: ${mock.streamed().length}`).toBe("upstream calls this turn: 2");
    expect(`the tool result says ran: ${mock.sawText('"status":"ran"')}`).toBe("the tool result says ran: true");
    expect(`the output reached the model: ${mock.sawText(canary)}`).toBe("the output reached the model: true");

    const list = await srv.api("GET", "/api/terminal/commands", undefined, auth(token!));
    expect(`state: ${list.body.commands[0].state}`).toBe("state: done");

    /* now lock it: auto-run is not a bypass for the password */
    await srv.api("POST", "/api/terminal/lock", {}, auth(token!));
    mock.script(runCommand(`echo second-${canary}`), reply.text("locked."));
    await turn(srv, { content: "print it again" });
    expect(`auto-run while locked was refused: ${mock.sawText('"reason":"terminal-locked"')}`).toBe(
      "auto-run while locked was refused: true"
    );
    expect(`the second command's output reached the model: ${mock.sawText("second-" + canary + "\n")}`).toBe(
      "the second command's output reached the model: false"
    );
  }, 120000);

  test("an auto-run command cannot displace the command the USER is running", async () => {
    /* The single-flight rule was restated by the two callers that answer HTTP
       and by neither of the ones the model can reach, so an auto-run walked
       straight over a user's command: `running` was overwritten, the user's
       Ctrl+C then found nothing to cancel, their process outlived even the
       server's shutdown kill, and every line they typed at their own prompt was
       written into the model's process. The guard now lives at the assignment,
       so this is the one place it can be checked. */
    const { srv, mock, token } = await aiServer({ autoRun: true });
    const marker = `/tmp/znotes-busy-canary-${Date.now()}`;

    const user = await execStream(srv, token!, { command: `echo USER-GO; sleep 5; echo USER-DONE` });
    const userId = await waitUntil(async () => (await srv.get("/api/terminal/status")).body.running, {
      timeout: 8000,
      label: "the user's command to be running",
    });

    mock.script(runCommand(`touch ${marker}`), reply.text("something else is running."));
    await turn(srv, { content: "make that file" });

    /* the model is TOLD, in words it can act on — not handed a 500 */
    expect(`the tool result says refused: ${mock.sawText('"status":"refused"')}`).toBe(
      "the tool result says refused: true"
    );
    expect(`…and names the reason: ${mock.sawText('"reason":"busy"')}`).toBe("…and names the reason: true");
    expect(`the AI command ran anyway: ${existsSync(marker)}`).toBe("the AI command ran anyway: false");

    /* the user's command is STILL the one running, under its own id */
    const during = (await srv.get("/api/terminal/status")).body;
    expect(`still the user's command: ${during.running === userId}`).toBe("still the user's command: true");

    /* …and it finishes, on its own stream, with its own exit */
    await user.finished;
    expect(`the user's command survived: ${user.stdout.includes("USER-DONE")}`).toBe(
      "the user's command survived: true"
    );
    expect(`exit code: ${user.exit?.code}`).toBe("exit code: 0");
    expect(`nothing left running: ${(await srv.get("/api/terminal/status")).body.running}`).toBe(
      "nothing left running: null"
    );
  }, 120000);

  test("the user's Ctrl+C still reaches their own command while the assistant is mid-turn", async () => {
    /* The half that mattered most: with the displaced command invisible to the
       server, cancel answered `{cancelled:false}` and the process was left
       alive with nobody able to reach it. */
    const { srv, mock, token } = await aiServer({ autoRun: true });
    const canary = `znotes-cancel-during-ai-${Date.now()}`;
    /* `sh -c '…' <name>` puts <name> in the CHILD's argv as $0, so the canary
       identifies every process in this run's subtree — the login shell that
       carries the command string, and the sh under it — and can never be
       confused with a stray from anything else on the machine. The trailing
       `; :` is load-bearing: a shell whose whole body is ONE simple command
       execs it in place and the argv (canary included) is gone. */
    const subtree = async () => {
      const ps = await new Response(Bun.spawn(["ps", "-A", "-o", "args="], { stdout: "pipe" }).stdout).text();
      return ps.split("\n").filter((l) => l.includes(canary)).length;
    };

    const user = await execStream(srv, token!, { command: `echo GO; sh -c 'sleep 120; :' ${canary}` });
    /* wait for the whole SUBTREE (the shell AND its sleep), not just for the
       server to report a run: a cancel issued into the gap where the shell has
       not forked yet is a race with the OS, not a test of this code */
    await waitUntil(async () => (await subtree()) >= 2, { timeout: 15000, label: "the command's subtree" });

    mock.script(runCommand("echo nope"), reply.text("busy."));
    await turn(srv, { content: "run something" });
    expect(`the AI was refused: ${mock.sawText('"reason":"busy"')}`).toBe("the AI was refused: true");

    /* the user's own cancel, with no id — the Ctrl+C shape — reaches the user's
       own command, because that is still what `running` names */
    const cancelled = await srv.api("POST", "/api/terminal/cancel", {}, auth(token!));
    expect(`cancel → ${cancelled.status} cancelled=${cancelled.body.cancelled}`).toBe("cancel → 200 cancelled=true");
    await user.finished;
    expect(`the user's command was signalled: ${user.exit?.signal}`).toBe("the user's command was signalled: SIGTERM");

    await sleep(400);
    expect(`processes left behind: ${await subtree()}`).toBe("processes left behind: 0");
  }, 120000);

  test("a runaway model is capped at a handful of commands per turn", async () => {
    const { srv, mock, token } = await aiServer({ autoRun: true });
    mock.script(
      ...Array.from({ length: 9 }, (_, i) => runCommand(`echo runaway-${i}`)),
      reply.text("stopped")
    );
    await turn(srv, { content: "keep going forever" }, 60000);

    const list = await srv.api("GET", "/api/terminal/commands", undefined, auth(token!));
    const ran = list.body.commands.filter((c: any) => c.state === "done").length;
    expect(`commands run in one turn (${ran}) is capped below 9: ${ran > 0 && ran < 9}`).toBe(
      `commands run in one turn (${ran}) is capped below 9: true`
    );
  }, 120000);
});
