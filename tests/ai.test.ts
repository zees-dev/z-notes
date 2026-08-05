/* ============================================================
   ai.test.ts — PHASE 4 acceptance gate (SPEC §8, §3 delta 4, §11).

   Same rule as every other phase file: nothing here reaches into the backend's
   internals. It knows only the fixed contract —

     - the relay POSTs {settings.ai.baseUrl}/responses with the canonical body
       from research §7, Authorization from sqlite, key never client-side;
     - POST /api/ai/messages is an event stream of NORMALIZED app events
       (research §3.2) whose `done` payload is exactly the old non-streaming
       JSON from API.md, so the UI's final state is unchanged;
     - `propose_edits` is validated server-side against ON-DISK BYTES before a
       proposal exists at all (research §4.4), with ≤2 in-turn retries;
     - accept/revert/reject behave exactly as API.md says, with LIFO enforced
       server-side and pre-images restored byte-for-byte (SPEC §11);
     - one git commit per accepted proposal, trailers and all;
     - the API key reaches the upstream and nothing else.

   Every upstream turn is scripted against tests/mock-upstream.ts, so the
   suite is deterministic and instant — the one exception is the abort test in
   ai-e2e.test.ts, which needs real wall-clock drip.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bytesEqual,
  describeByteDiff,
  dropVault,
  encPath,
  makeVault,
  readVaultBytes,
  readVaultText,
  sleep,
  startServer,
  toBytes,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import {
  AiStream,
  proposeEdits,
  reply,
  startMockUpstream,
  toolArgs,
  turn,
  type MockUpstream,
} from "./mock-upstream";

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

/** the key the relay must send upstream and must never hand to a client */
const KEY = "sk-mock-CUSTODYCANARY-91af3d7c";

const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_TAIL = "-----END AGE ENCRYPTED FILE-----";
const ARMOR_B64 = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4";

const MD_TARGET = "# Target\n\nalpha line\nbravo line\ncharlie line\n";
const MD_LINKED = "# Linked\n\nLINKEDDOCMARKER — depth-1 neighbour.\n";
const MD_MAIN =
  "# Main\n\nMAINDOCMARKER prose, links to [[linked]].\n\n" +
  "- [ ] one task\n- [ ] two task\n";
const MD_SECRETS =
  "# Keys\n\nintro line before the block\n\n```age\n" +
  ARMOR_HEAD +
  "\n" +
  ARMOR_B64 +
  "\n" +
  ARMOR_TAIL +
  "\n```\n\ntail line after the block\n";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  "notes/main.md": MD_MAIN,
  "notes/linked.md": MD_LINKED,
  "notes/target.md": MD_TARGET,
  "keys/secrets.md": MD_SECRETS,
  "projects/unique.md": "# Unique\n\nThe QUOKKAWORD appears exactly once in this vault.\n",
};

const servers: TestServer[] = [];
const mocks: MockUpstream[] = [];
const orphanVaults: string[] = [];

async function newMock(): Promise<MockUpstream> {
  const m = await startMockUpstream();
  mocks.push(m);
  return m;
}

async function newServer(opts: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  const s = await startServer(opts);
  servers.push(s);
  return s;
}

/** point the server at the mock and hand it the key; returns after the probe settles */
async function configure(srv: TestServer, mock: MockUpstream, extra: Record<string, unknown> = {}) {
  const r = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high", ...extra },
    git: { autoSyncSeconds: 600 },
  });
  expect(`PUT /api/settings → ${r.status} ${r.text.slice(0, 160)}`).toBe(`PUT /api/settings → 200 ${r.text.slice(0, 160)}`);
  /* the capability probe is fire-and-forget; give it a beat so it never lands
     in the middle of a later assertion about request counts */
  await sleep(250);
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  await Promise.all(mocks.map((m) => m.stop().catch(() => {})));
  for (const v of orphanVaults) dropVault(v);
});

/* ------------------------------------------------------------------
   small utilities
   ------------------------------------------------------------------ */

/**
 * A raw-TCP upstream that answers the capability probe normally and then, on
 * the streaming turn, writes SSE headers and a couple of deltas before killing
 * the socket. `mock-upstream.ts` cannot express this — a Bun.serve handler owns
 * a well-formed response — and a half-written body is the one shape that
 * reaches the relay as a plain Error rather than an AiError.
 */
async function startDyingUpstream(): Promise<{ baseUrl: string; stop: () => void }> {
  const sockets = new Set<any>();
  const srv = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        sockets.add(sock);
        (sock as any).buf = Buffer.alloc(0);
      },
      close(sock) {
        sockets.delete(sock);
      },
      error() {},
      data(sock, chunk) {
        const s = sock as any;
        /* BYTES, not decoded characters: the request body carries the doc and
           the system prompt, whose non-ASCII punctuation makes Content-Length
           and String.length disagree — and then the body never looks complete. */
        s.buf = Buffer.concat([s.buf, Buffer.from(chunk)]);
        const head = s.buf.indexOf("\r\n\r\n");
        if (head < 0) return;
        const len = Number(/content-length:\s*(\d+)/i.exec(s.buf.subarray(0, head).toString("latin1"))?.[1] ?? 0);
        if (s.buf.length < head + 4 + len) return; // body still arriving
        const body = s.buf.subarray(head + 4, head + 4 + len).toString("utf8");
        s.buf = Buffer.alloc(0);
        const send = (text: string) => sock.write(text);

        // the capability probe is `"stream": false` — answer it properly, so
        // the endpoint is genuinely `ok` before the turn that kills it
        if (!/"stream"\s*:\s*true/.test(body)) {
          const json = JSON.stringify({ id: "resp_probe", output: [], model: "gpt-5.6-sol" });
          send(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: " +
              Buffer.byteLength(json) +
              "\r\nconnection: close\r\n\r\n" +
              json
          );
          setTimeout(() => sock.end(), 5);
          return;
        }

        // the real turn: headers, two frames, then the socket simply dies
        send("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n");
        const frame = (event: string, data: unknown) => {
          const s2 = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          send(Buffer.byteLength(s2).toString(16) + "\r\n" + s2 + "\r\n");
        };
        frame("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_die" } });
        frame("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: 1,
          output_index: 0,
          content_index: 0,
          item_id: "msg_die",
          delta: "half an ans",
        });
        setTimeout(() => sock.terminate?.() ?? sock.end(), 40); // RST, mid-body
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${srv.port}/v1`,
    stop: () => {
      for (const s of sockets) s.end?.();
      srv.stop(true);
    },
  };
}

const ppath = (id: string) => "/api/ai/proposals/" + encodeURIComponent(id);
const accept = (srv: TestServer, id: string) => srv.api("POST", ppath(id) + "/accept", {});
const revert = (srv: TestServer, id: string) => srv.api("POST", ppath(id) + "/revert", {});
const reject = (srv: TestServer, id: string) => srv.api("POST", ppath(id) + "/reject", {});

async function seedDoc(srv: TestServer, path: string, markdown: string): Promise<void> {
  const r = await srv.api("POST", "/api/docs", { path, type: "doc", markdown });
  if (r.status === 409) {
    const w = await srv.putDoc(path, markdown);
    expect(`overwrite ${path} → ${w.status}`).toBe(`overwrite ${path} → 200`);
  } else {
    expect(`create ${path} → ${r.status}`).toBe(`create ${path} → 201`);
  }
  await sleep(60);
}

/** deep search for a nested object that satisfies `pred` */
function findObject(root: unknown, pred: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): Record<string, unknown> | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    if (!Array.isArray(v) && pred(v as Record<string, unknown>)) return v as Record<string, unknown>;
    for (const x of Array.isArray(v) ? v : Object.values(v as object)) {
      const hit = walk(x);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/** every key path in the object whose key matches `re`, with its value */
function findByKey(root: unknown, re: RegExp): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as object)) {
      const p = path ? `${path}.${k}` : k;
      if (re.test(k)) out.push([p, val]);
      walk(val, p);
    }
  };
  walk(root, "");
  return out;
}

/** the propose_edits tool definition, whichever nesting the relay used */
function toolDef(body: any): any {
  const tools: any[] = body?.tools ?? [];
  for (const t of tools) {
    if (t?.name === "propose_edits") return t;
    if (t?.function?.name === "propose_edits") return { ...t.function, type: t.type, strict: t.function.strict ?? t.strict };
  }
  return null;
}

function opEnum(tool: any): string[] {
  const params = tool?.parameters ?? {};
  const ops = params?.properties?.edits?.items?.properties?.op?.enum;
  return Array.isArray(ops) ? [...ops] : [];
}

function expectBytes(actual: Uint8Array, expected: Uint8Array, label: string) {
  expect(`${label}: ${bytesEqual(actual, expected) ? "identical" : describeByteDiff(expected, actual)}`).toBe(
    `${label}: identical`
  );
}

/* the one-and-only shared server for everything that does not need its own
   vault: a NON-git vault, which doubles as the "accept works without a repo"
   fixture */
let srv: TestServer;
let mock: MockUpstream;

beforeAll(async () => {
  mock = await newMock();
  srv = await newServer({ seed: SEED });
  await configure(srv, mock);
}, 60000);

/* ============================================================
   1 — the canonical upstream request (research §7)
   ============================================================ */

describe("ai relay — the request that goes upstream", () => {
  beforeEach(() => mock.reset());

  test("POST {baseUrl}/responses carries the canonical body, verbatim", async () => {
    mock.script(reply.text("Nothing to change."));
    await turn(srv, { content: "hello", docPath: "notes/main.md" });

    const reqs = mock.streamed();
    expect(`streamed upstream requests: ${reqs.length}`).toBe("streamed upstream requests: 1");
    const req = reqs[0];

    expect(`path: ${req.path}`).toBe("path: /responses");
    expect(req.body.model).toBe("gpt-5.6-sol");
    expect(req.body.stream).toBe(true);
    expect(req.body.store).toBe(false);
    /* effort is ALWAYS explicit — omitting it silently yields `medium` */
    expect(req.body.reasoning?.effort).toBe("high");
    expect(req.body.reasoning?.summary).toBe("auto");
    expect(req.body.max_output_tokens).toBe(32000);
    expect(req.body.tool_choice).toBe("auto");
    expect(req.body.parallel_tool_calls).toBe(false);
    expect(typeof req.body.instructions === "string" && req.body.instructions.length > 40).toBe(true);
  }, 30000);

  test("the single tool is a strict, flat propose_edits — ops per SPEC §8, no delete_doc", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "hello again", docPath: "notes/main.md" });

    const body = mock.streamed()[0].body;
    expect(Array.isArray(body.tools)).toBe(true);
    expect(`tool count: ${body.tools.length}`).toBe("tool count: 1");

    const tool = toolDef(body);
    expect(tool && tool.type).toBe("function");
    expect(tool.strict).toBe(true);

    const ops = opEnum(tool).slice().sort();
    expect(ops).toEqual(["create", "insert_after", "replace", "rewrite"]);
    expect(ops).not.toContain("delete_doc");

    /* strict structured outputs: every property listed in `required`, no extras */
    const item = tool.parameters.properties.edits.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(["content", "find", "note", "op", "path", "replace"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect([...tool.parameters.required].sort()).toEqual(["edits", "summary"]);
  }, 30000);

  test("the Authorization header carries the key from sqlite", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "auth check", docPath: "notes/main.md" });
    const req = mock.streamed()[0];
    expect(req.authorization).toBe("Bearer " + KEY);
  }, 30000);

  test("context is assembled from on-disk bytes: current doc in full, manifest, linked doc, secrets redacted", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "what does this doc say?", docPath: "notes/main.md" });
    const req = mock.streamed()[0];
    const sent = req.strings;

    /* the current document, NEVER truncated */
    expect(`current doc sent in full: ${sent.includes(MD_MAIN)}`).toBe("current doc sent in full: true");
    /* a vault manifest of paths */
    for (const p of ["notes/main.md", "notes/linked.md", "keys/secrets.md"]) {
      expect(`manifest mentions ${p}: ${sent.includes(p)}`).toBe(`manifest mentions ${p}: true`);
    }
    /* depth-1 link following: [[linked]] resolves and its body rides along */
    expect(`linked doc body attached: ${sent.includes("LINKEDDOCMARKER")}`).toBe("linked doc body attached: true");
    /* the user's turn */
    expect(sent.includes("what does this doc say?")).toBe(true);
  }, 30000);

  /* The manifest is built twice now (headings / no headings) and once per turn
     rather than once per eviction pass, off two different sqlite projections —
     one with `body`, one without. The outline is what the second projection
     must not have quietly dropped. */
  test("the manifest still carries the heading outline of docs that are not the current one", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "what does this doc say?", docPath: "notes/main.md" });
    const sent = mock.streamed().at(-1)!.strings;
    for (const heading of ["# Target", "# Unique", "# Linked"]) {
      expect(`manifest outlines ${heading}: ${sent.includes(heading)}`).toBe(`manifest outlines ${heading}: true`);
    }
  }, 30000);

  test("a secret block is replaced by the placeholder BEFORE assembly, never by silence", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "summarise my keys doc", docPath: "keys/secrets.md" });
    const req = mock.streamed()[0];

    for (const token of [ARMOR_HEAD, ARMOR_TAIL, ARMOR_B64]) {
      expect(`upstream body carries ${token.slice(0, 20)}: ${req.bodyText.includes(token) || req.strings.includes(token)}`)
        .toBe(`upstream body carries ${token.slice(0, 20)}: false`);
    }
    /* …and the model is TOLD there is a secret there (research §6.1) */
    expect(`placeholder present: ${req.strings.includes("⟪secret")}`).toBe("placeholder present: true");
    /* the prose around it survives — the redaction is not "drop the file" */
    expect(req.strings.includes("intro line before the block")).toBe(true);
    expect(req.strings.includes("tail line after the block")).toBe(true);
  }, 30000);

  test("a vault-wide question attaches FTS hits", async () => {
    mock.script(reply.text("ok"));
    await turn(srv, { content: "search my whole vault for QUOKKAWORD", docPath: "notes/main.md" });
    const sent = mock.streamed()[0].strings;
    expect(`FTS hit attached: ${sent.includes("QUOKKAWORD")}`).toBe("FTS hit attached: true");
  }, 30000);
});

/* ============================================================
   2 — the streaming contract (SPEC §3 delta 4, research §3.2)
   ============================================================ */

describe("POST /api/ai/messages — the normalized event stream", () => {
  beforeEach(() => mock.reset());

  test("text deltas arrive as `text` events and `done` carries API.md's non-streaming shape", async () => {
    const ANSWER = "You have two open tasks in this note, and neither is blocked.";
    mock.script(reply.text(ANSWER, { chunkSize: 12 }));

    const s = await turn(srv, { content: "how many tasks?", docPath: "notes/main.md" });

    expect(`status: ${s.status}`).toBe("status: 200");
    expect(`content-type: ${s.contentType.includes("text/event-stream")}`).toBe("content-type: true");
    /* a proxy-proof stream: no buffering, no cache */
    expect(s.headers.get("x-accel-buffering")).toBe("no");
    expect(String(s.headers.get("cache-control") ?? "")).toMatch(/no-cache|no-store/);

    /* it really STREAMED — one blob would be a single delta */
    expect(`text events: ${s.of("text").length >= 2}`).toBe("text events: true");
    expect(s.text()).toBe(ANSWER);

    const done = s.done();
    expect(done).toBeTruthy();
    for (const k of ["session", "messages", "proposal"]) {
      expect(`done carries ${k}: ${k in done}`).toBe(`done carries ${k}: true`);
    }
    expect(done.proposal).toBeNull();

    expect(Array.isArray(done.messages)).toBe(true);
    expect(`messages in done: ${done.messages.length}`).toBe("messages in done: 2");
    const [um, am] = done.messages;
    expect(um.role).toBe("user");
    expect(um.content).toBe("how many tasks?");
    expect(typeof um.id).toBe("string");
    expect(am.role).toBe("assistant");
    expect(am.content).toBe(ANSWER);
    expect(typeof am.id).toBe("string");
    expect(am.id).not.toBe(um.id);
    expect(am.proposalId ?? null).toBeNull();

    expect(typeof done.session.id).toBe("string");
    expect(typeof done.session.messageCount).toBe("number");
    expect(done.session.tokensEstimated).toBeGreaterThan(0);
    expect(done.session.model).toBe("gpt-5.6-sol");
    expect(done.session.effort).toBe("high");

    /* the session really persisted what the stream claimed */
    const sess = await srv.get("/api/ai/sessions/current");
    expect(sess.status).toBe(200);
    const ids = sess.body.messages.map((m: any) => m.id);
    expect(ids).toContain(um.id);
    expect(ids).toContain(am.id);
    expect(sess.body.messages.find((m: any) => m.id === am.id).content).toBe(ANSWER);
  }, 30000);

  test("reasoning summaries surface as `reasoning` events and usage as `usage`", async () => {
    mock.script(
      reply.text("Short answer.", {
        reasoning: "Checking the note for open checkboxes.",
        usage: { input: 4211, output: 118, reasoning: 96, cached: 2048 },
      })
    );
    const s = await turn(srv, { content: "think about it", docPath: "notes/main.md" });

    expect(s.reasoning()).toBe("Checking the note for open checkboxes.");
    const u = s.usage();
    expect(u).toBeTruthy();
    expect(u.input).toBe(4211);
    expect(u.output).toBe(118);
    expect(u.reasoning).toBe(96);
    expect(u.cached).toBe(2048);
  }, 30000);

  test("deltas that ARRIVE out of order still produce the right final message", async () => {
    const ANSWER = "ORDERONE-ORDERTWO-ORDERTHREE-ORDERFOUR-ORDERFIVE-ORDERSIX";
    mock.script(reply.text(ANSWER, { chunkSize: 9, outOfOrder: true }));
    const s = await turn(srv, { content: "ordering", docPath: "notes/main.md" });
    /* deltas are UI-only; `.done` is ground truth (research §3.2) */
    expect(s.done().messages[1].content).toBe(ANSWER);
  }, 30000);

  test("an upstream error mid-stream becomes an `error` event and a session message — never a hang", async () => {
    mock.script(reply.error("upstream fell over", { beforeText: "I was saying " }));
    const before = (await srv.get("/api/ai/sessions/current")).body.messages.length;

    const s = await turn(srv, { content: "trigger an upstream error", docPath: "notes/main.md" });

    const errs = s.errors();
    expect(`error events: ${errs.length >= 1}`).toBe("error events: true");
    expect(typeof errs[0]?.message).toBe("string");
    expect(errs[0].message.length).toBeGreaterThan(0);
    expect(s.closed).toBe(true);

    const after = await srv.get("/api/ai/sessions/current");
    expect(after.status).toBe(200);
    expect(`session grew: ${after.body.messages.length > before}`).toBe("session grew: true");
    /* the failure is recorded, not swallowed */
    const last = after.body.messages[after.body.messages.length - 1];
    expect(`${last.role} message present: ${String(last.content).length > 0}`).toBe(
      `${last.role} message present: true`
    );
  }, 30000);

  test("response.incomplete terminates the turn without a proposal", async () => {
    mock.script(reply.incomplete({ text: "I started rewriting the do", reason: "max_output_tokens" }));
    const s = await turn(srv, { content: "rewrite everything", docPath: "notes/main.md" });
    expect(s.closed).toBe(true);
    const done = s.done();
    expect(`proposal on an incomplete turn: ${done ? done.proposal : null}`).toBe(
      "proposal on an incomplete turn: null"
    );
    expect(`surfaced (error or done): ${s.errors().length > 0 || !!done}`).toBe("surfaced (error or done): true");
  }, 30000);

  test("a non-ladder HTTP failure (401) surfaces as an error, not a 500 page", async () => {
    mock.script(reply.http(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
    const s = await turn(srv, { content: "bad key please", docPath: "notes/main.md" });
    expect(s.closed).toBe(true);
    const surfaced = s.errors().length > 0 || (s.json && typeof s.json.error === "string");
    expect(`401 surfaced to the client: ${!!surfaced}`).toBe("401 surfaced to the client: true");
    /* whatever shape it took, the upstream key text is not in it */
    expect(s.raw.includes(KEY)).toBe(false);
  }, 30000);

  test("an empty message is rejected before anything reaches upstream", async () => {
    const before = mock.mark();
    const r = await srv.api("POST", "/api/ai/messages", { content: "   " });
    expect(r.status).toBe(400);
    expect(mock.since(before).length).toBe(0);
  }, 20000);
});

/* ============================================================
   3 — propose_edits validation matrix (research §4.4)
   ============================================================ */

describe("propose_edits — server-side validation against on-disk bytes", () => {
  beforeEach(() => mock.reset());

  test("happy path: a unique anchor becomes a pending proposal, and NOTHING is written yet", async () => {
    const P = "ai/happy.md";
    const md = "# Happy\n\nalpha line\nbravo line\ncharlie line\n";
    await seedDoc(srv, P, md);

    mock.script(
      proposeEdits("Shout at bravo", {
        op: "replace",
        path: P,
        find: "bravo line",
        replace: "BRAVO LINE",
        note: "louder",
      })
    );

    const s = await turn(srv, { content: "make bravo louder", docPath: P });

    /* the tool args streamed for the shimmer, and the validated record followed */
    expect(`tool_args streamed: ${s.toolArgs().length > 0}`).toBe("tool_args streamed: true");
    const evt = s.proposalEvent();
    expect(evt).toBeTruthy();

    const p = s.done().proposal;
    expect(p).toBeTruthy();
    expect(p.id).toBe(evt.id);
    expect(p.target).toBe(P);
    expect(p.state).toBe("pending");
    expect(typeof p.label).toBe("string");
    expect(p.label.length).toBeGreaterThan(0);
    expect(typeof p.summary).toBe("string");
    expect(p.stackIndex).toBeNull();
    expect(p.revertable).toBe(false);
    expect(typeof p.stats.added).toBe("number");
    expect(typeof p.stats.removed).toBe("number");
    expect(p.stats.added).toBeGreaterThan(0);
    expect(p.stats.removed).toBeGreaterThan(0);

    /* hunks are computed server-side so the client renders without recomputing */
    expect(Array.isArray(p.diff)).toBe(true);
    const markers = new Set(p.diff.map((d: any) => d.marker));
    expect([...markers].every((m) => [" ", "+", "-"].includes(m as string))).toBe(true);
    expect(p.diff.some((d: any) => d.marker === "+" && d.text.includes("BRAVO LINE"))).toBe(true);
    expect(p.diff.some((d: any) => d.marker === "-" && d.text.includes("bravo line"))).toBe(true);
    expect(Array.isArray(p.edits) && p.edits.length === 1).toBe(true);
    expect(p.edits[0].op).toBe("replace");

    /* the assistant message is wired to the proposal */
    const am = s.done().messages.find((m: any) => m.role === "assistant");
    expect(am.proposalId).toBe(p.id);

    /* …and the file is untouched until Accept */
    expect(readVaultText(srv.vault, P)).toBe(md);

    /* it is listed as pending */
    const list = await srv.get("/api/ai/proposals");
    expect(list.status).toBe(200);
    expect(list.body.proposals.some((x: any) => x.id === p.id && x.state === "pending")).toBe(true);
    expect(list.body.stack.length).toBe(0);
  }, 40000);

  test("a not_found anchor is fed back as a tool result and the retry succeeds", async () => {
    const P = "ai/retry.md";
    const md = "# Retry\n\nthe real anchor line\n";
    await seedDoc(srv, P, md);

    mock.script(
      proposeEdits("first attempt", {
        op: "replace",
        path: P,
        find: "an anchor that is nowhere in the file",
        replace: "nope",
      }),
      proposeEdits("corrected attempt", {
        op: "replace",
        path: P,
        find: "the real anchor line",
        replace: "the corrected anchor line",
      })
    );

    const s = await turn(srv, { content: "fix the anchor", docPath: P });

    const reqs = mock.streamed();
    expect(`upstream turns: ${reqs.length}`).toBe("upstream turns: 2");
    /* the failure reason went back as the tool result, not as prose */
    expect(`retry carries the reason: ${/not_?found/i.test(reqs[1].strings)}`).toBe("retry carries the reason: true");

    const p = s.done().proposal;
    expect(p).toBeTruthy();
    expect(p.state).toBe("pending");

    const acc = await accept(srv, p.id);
    expect(`accept → ${acc.status}`).toBe("accept → 200");
    expect(readVaultText(srv.vault, P)).toBe("# Retry\n\nthe corrected anchor line\n");
  }, 40000);

  test("an ambiguous anchor is rejected, retried at most twice, and gives up WITHOUT a proposal", async () => {
    const P = "ai/ambiguous.md";
    const md = "# Ambiguous\n\nrepeat me\nsomething else\nrepeat me\n";
    await seedDoc(srv, P, md);

    const bad = () =>
      proposeEdits("ambiguous edit", { op: "replace", path: P, find: "repeat me", replace: "changed" });
    mock.script(bad(), bad(), bad(), bad(), bad());

    const s = await turn(srv, { content: "change the repeated line", docPath: P });

    const n = mock.streamed().length;
    expect(`upstream turns (1 + ≤2 retries): ${n >= 2 && n <= 3}`).toBe("upstream turns (1 + ≤2 retries): true");
    expect(`retry carries the reason: ${/ambiguous/i.test(mock.streamed()[1].strings)}`).toBe(
      "retry carries the reason: true"
    );

    const done = s.done();
    expect(`proposal after give-up: ${done?.proposal ?? null}`).toBe("proposal after give-up: null");
    expect(`the failure was surfaced: ${s.errors().length > 0 || (done?.messages?.length ?? 0) > 0}`).toBe(
      "the failure was surfaced: true"
    );
    expect(`the stream ended: ${s.closed}`).toBe("the stream ended: true");

    /* no half-made proposal anywhere, and the file is untouched */
    const list = await srv.get("/api/ai/proposals");
    expect(list.body.proposals.filter((x: any) => x.target === P).length).toBe(0);
    expect(readVaultText(srv.vault, P)).toBe(md);
  }, 40000);

  test("an edit whose range intersects an age fence is refused", async () => {
    const P = "ai/fenced.md";
    const md =
      "# Fenced\n\nintro line before\n\n```age\n" + ARMOR_HEAD + "\n" + ARMOR_B64 + "\n" + ARMOR_TAIL + "\n```\n\ntail\n";
    await seedDoc(srv, P, md);

    /* the anchor STARTS outside the block and reaches into it — no armor in the
       anchor itself, so this tests the range check, not the string check */
    const bad = () =>
      proposeEdits("touch the fence", {
        op: "replace",
        path: P,
        find: "intro line before\n\n```age",
        replace: "intro line before\n\n```text",
      });
    mock.script(bad(), bad(), bad());

    const s = await turn(srv, { content: "retitle that fence", docPath: P });

    const done = s.done();
    expect(`proposal over a secret range: ${done?.proposal ?? null}`).toBe("proposal over a secret range: null");
    expect(readVaultText(srv.vault, P)).toBe(md);
    expect(`rejection reason mentions the secret: ${/secret|age|encrypt/i.test(mock.streamed()[1]?.strings ?? "")}`).toBe(
      "rejection reason mentions the secret: true"
    );
    /* the feedback loop must not carry the armor back upstream */
    expect(mock.sawText(ARMOR_HEAD)).toBe(false);
    expect(mock.sawText(ARMOR_B64)).toBe(false);
  }, 40000);

  test("a replacement that CONTAINS a fence marker never becomes a proposal, and never reaches upstream", async () => {
    const P = "ai/injects.md";
    const md = "# Injects\n\nplain line here\n";
    await seedDoc(srv, P, md);

    const bad = () =>
      proposeEdits("smuggle armor in", {
        op: "replace",
        path: P,
        find: "plain line here",
        replace: "```age\n" + ARMOR_HEAD + "\nZm9ydW0=\n" + ARMOR_TAIL + "\n```",
      });
    mock.script(bad(), bad(), bad());

    const s = await turn(srv, { content: "add a secret block", docPath: P });

    const done = s.done();
    expect(`proposal carrying armor: ${done?.proposal ?? null}`).toBe("proposal carrying armor: null");
    expect(readVaultText(srv.vault, P)).toBe(md);
    /* the belt-and-braces canary: the relay never SENDS armor, whatever the
       reason it would have had to (SPEC §6/§8) */
    expect(`armor in an upstream body: ${mock.sawText(ARMOR_HEAD)}`).toBe("armor in an upstream body: false");
    expect(s.closed).toBe(true);
  }, 40000);

  test("a path outside the vault is refused and writes nothing", async () => {
    const outside = join(srv.vault, "..", "znotes-escapee.md");
    const bad = (p: string) =>
      proposeEdits("escape", { op: "create", path: p, content: "# pwned\n" });
    mock.script(bad("../znotes-escapee.md"), bad("/tmp/znotes-escapee.md"), bad("notes/../../znotes-escapee.md"));

    const s = await turn(srv, { content: "write outside the vault", docPath: "notes/main.md" });

    const done = s.done();
    const made = done?.proposal ?? null;
    expect(`proposal for a traversal path: ${made ? `target=${made.target}` : null}`).toBe(
      "proposal for a traversal path: null"
    );
    expect(`file created outside the vault: ${existsSync(outside)}`).toBe("file created outside the vault: false");
    expect(existsSync("/tmp/znotes-escapee.md")).toBe(false);
    expect(`rejection mentions the path: ${/path|traversal|outside|confin|vault/i.test(mock.streamed()[1]?.strings ?? "")}`)
      .toBe("rejection mentions the path: true");
  }, 40000);

  test("op=insert_after splices the content directly after the anchor, byte-exact", async () => {
    const P = "ai/insert.md";
    const md = "# Insert\n\n- [ ] Write build-ready spec\n- [ ] Ship it\n";
    await seedDoc(srv, P, md);

    const inserted = "\n## Open tasks rollup\n\n- pulled from every note\n";
    mock.script(
      proposeEdits("Open tasks rollup", {
        op: "insert_after",
        path: P,
        find: "- [ ] Write build-ready spec",
        content: inserted,
      })
    );

    const s = await turn(srv, { content: "add a rollup", docPath: P });
    const p = s.done().proposal;
    expect(p).toBeTruthy();
    expect(p.edits[0].op).toBe("insert_after");

    const acc = await accept(srv, p.id);
    expect(`accept → ${acc.status} ${acc.text.slice(0, 120)}`).toBe(`accept → 200 ${acc.text.slice(0, 120)}`);

    const expected = md.replace("- [ ] Write build-ready spec", "- [ ] Write build-ready spec" + inserted);
    expectBytes(readVaultBytes(srv.vault, P), toBytes(expected), "insert_after result");
    expect(acc.body.doc.markdown).toBe(expected);
  }, 40000);

  test("op=create makes a new doc with exactly the proposed bytes", async () => {
    const P = "ai/created/brand-new.md";
    const content = "# Brand new\n\nMade by the assistant.\n\n- [ ] first task\n";
    mock.script(proposeEdits("Create a note", { op: "create", path: P, content }));

    expect(existsSync(join(srv.vault, P))).toBe(false);
    const s = await turn(srv, { content: "make me a note", docPath: "notes/main.md" });
    const p = s.done().proposal;
    expect(p).toBeTruthy();
    expect(p.target).toBe(P);
    /* still nothing on disk until Accept */
    expect(existsSync(join(srv.vault, P))).toBe(false);

    const acc = await accept(srv, p.id);
    expect(`accept → ${acc.status}`).toBe("accept → 200");
    expectBytes(readVaultBytes(srv.vault, P), toBytes(content), "created doc");

    await waitUntil(
      async () => {
        const tree = await srv.get("/api/docs");
        return JSON.stringify(tree.body.tree).includes(P);
      },
      { timeout: 6000, label: "the created doc to appear in the tree" }
    );
  }, 40000);

  test("op=rewrite replaces the whole document, byte-exact", async () => {
    const P = "ai/rewrite.md";
    await seedDoc(srv, P, "# Old\n\nline one\nline two\nline three\n");
    const next = "# New\n\nEntirely restructured.\n\n1. one\n2. two\n";
    mock.script(proposeEdits("Restructure", { op: "rewrite", path: P, content: next }));

    const s = await turn(srv, { content: "restructure this note", docPath: P });
    const p = s.done().proposal;
    expect(p).toBeTruthy();
    const acc = await accept(srv, p.id);
    expect(`accept → ${acc.status}`).toBe("accept → 200");
    expectBytes(readVaultBytes(srv.vault, P), toBytes(next), "rewritten doc");
  }, 40000);

  test("a plain answer carries proposal:null — the model is never pressured into the tool", async () => {
    mock.script(reply.text("No edit needed: the note already says that."));
    const s = await turn(srv, { content: "does the note mention X?", docPath: "notes/main.md" });
    const done = s.done();
    expect(done.proposal).toBeNull();
    expect(s.of("proposal").length).toBe(0);
    expect(done.messages[1].proposalId ?? null).toBeNull();
    /* tool_choice stayed "auto" for this turn too */
    expect(mock.streamed()[0].body.tool_choice).toBe("auto");
  }, 30000);
});

/* ============================================================
   4 — THE §11 LIFO GATE, API-level and byte-exact
   ============================================================ */

describe("SPEC §11 — accept / revert / reject with server-enforced LIFO", () => {
  /* its own server: the gate is about stack POSITIONS (#1, #2, "revert #2
     first"), so it cannot share a vault with tests that leave things applied */
  const P = "notes/stack.md";
  const ORIGINAL = "# Stack\n\none line\ntwo line\nthree line\n";
  let srv: TestServer;
  let mock: MockUpstream;
  let A = "";
  let B = "";

  beforeAll(async () => {
    mock = await newMock();
    srv = await newServer({ seed: { "inbox.md": "# Inbox\n\nnothing yet\n", [P]: ORIGINAL } });
    await configure(srv, mock);
    mock.reset();

    mock.script(proposeEdits("Shout one", { op: "replace", path: P, find: "one line", replace: "ONE LINE" }));
    A = (await turn(srv, { content: "shout the first line", docPath: P })).done().proposal.id;

    mock.script(proposeEdits("Shout three", { op: "replace", path: P, find: "three line", replace: "THREE LINE" }));
    B = (await turn(srv, { content: "shout the third line", docPath: P })).done().proposal.id;

    expect(A && B && A !== B).toBeTruthy();
    /* the gate starts from an empty stack — otherwise every index below is noise */
    expect((await srv.get("/api/ai/proposals")).body.stack).toEqual([]);
  }, 60000);

  test("accepting A then B stacks them 1,2 and only the top is revertable", async () => {
    const ra = await accept(srv, A);
    expect(`accept A → ${ra.status} ${ra.text.slice(0, 140)}`).toBe(`accept A → 200 ${ra.text.slice(0, 140)}`);
    expect(ra.body.proposal.state).toBe("applied");
    expect(ra.body.proposal.stackIndex).toBe(1);
    expect(ra.body.proposal.revertable).toBe(true);
    expect(ra.body.doc.path).toBe(P);
    expect(ra.body.doc.markdown).toBe(readVaultText(srv.vault, P));

    const rb = await accept(srv, B);
    expect(`accept B → ${rb.status}`).toBe("accept B → 200");
    expect(rb.body.proposal.stackIndex).toBe(2);

    expect(readVaultText(srv.vault, P)).toBe("# Stack\n\nONE LINE\ntwo line\nTHREE LINE\n");

    const list = await srv.get("/api/ai/proposals");
    expect(list.body.stack.map((e: any) => [e.id, e.index, e.revertable])).toEqual([
      [A, 1, false],
      [B, 2, true],
    ]);
  }, 40000);

  test("accepting an already-applied proposal is 409 already-applied", async () => {
    const r = await accept(srv, B);
    expect(`re-accept → ${r.status} ${r.body?.error}`).toBe("re-accept → 409 already-applied");
  }, 20000);

  test("rejecting an APPLIED proposal is 409 applied — revert first", async () => {
    const r = await reject(srv, A);
    expect(`reject applied → ${r.status} ${r.body?.error}`).toBe("reject applied → 409 applied");
    expect(readVaultText(srv.vault, P)).toBe("# Stack\n\nONE LINE\ntwo line\nTHREE LINE\n");
  }, 20000);

  test("reverting A (not the top) is 409 not-stack-top and names what to revert first", async () => {
    const before = readVaultBytes(srv.vault, P);
    const r = await revert(srv, A);
    expect(`revert A → ${r.status} ${r.body?.error}`).toBe("revert A → 409 not-stack-top");
    expect(r.body.requires).toBe(B);
    expect(r.body.requiresIndex).toBe(2);
    expect(typeof r.body.message).toBe("string");
    expectBytes(readVaultBytes(srv.vault, P), before, "file after a refused revert");
  }, 20000);

  test("reverting B then A restores the ORIGINAL bytes exactly", async () => {
    const rb = await revert(srv, B);
    expect(`revert B → ${rb.status} ${rb.text.slice(0, 140)}`).toBe(`revert B → 200 ${rb.text.slice(0, 140)}`);
    expect(readVaultText(srv.vault, P)).toBe("# Stack\n\nONE LINE\ntwo line\nthree line\n");
    expect(rb.body.proposal.state).toBe("pending");
    expect(rb.body.proposal.stackIndex).toBeNull();

    const ra = await revert(srv, A);
    expect(`revert A → ${ra.status}`).toBe("revert A → 200");

    expectBytes(readVaultBytes(srv.vault, P), toBytes(ORIGINAL), "byte-identical restoration");

    const list = await srv.get("/api/ai/proposals");
    expect(list.body.stack).toEqual([]);
    for (const id of [A, B]) {
      const p = list.body.proposals.find((x: any) => x.id === id);
      expect(`${id} state: ${p.state}`).toBe(`${id} state: pending`);
      expect(p.revertable).toBe(false);
      expect(p.stackIndex).toBeNull();
    }
  }, 30000);

  test("a reverted proposal can be accepted again, and a pending one can be rejected", async () => {
    const re = await accept(srv, A);
    expect(`re-accept after revert → ${re.status}`).toBe("re-accept after revert → 200");
    expect(re.body.proposal.stackIndex).toBe(1);
    expect(readVaultText(srv.vault, P)).toBe("# Stack\n\nONE LINE\ntwo line\nthree line\n");

    const back = await revert(srv, A);
    expect(back.status).toBe(200);
    expectBytes(readVaultBytes(srv.vault, P), toBytes(ORIGINAL), "restoration after the second cycle");

    const rj = await reject(srv, B);
    expect(`reject pending → ${rj.status}`).toBe("reject pending → 200");
    expect(rj.body.proposal.state).toBe("rejected");
    expectBytes(readVaultBytes(srv.vault, P), toBytes(ORIGINAL), "reject writes nothing");
  }, 30000);

  test("accept and revert each announce themselves on /events", async () => {
    const sse = await srv.sse();
    try {
      const m0 = sse.mark();
      const acc = await accept(srv, A);
      expect(`accept → ${acc.status}`).toBe("accept → 200");
      const applied = await sse.waitFor("doc-changed", { from: m0, match: (d) => d.path === P });
      expect(`accept reason: ${applied.data.reason}`).toBe("accept reason: proposal-accepted");
      expect(`the event carries the new rev: ${applied.data.rev === acc.body.doc.rev}`).toBe(
        "the event carries the new rev: true"
      );

      const m1 = sse.mark();
      const rev = await revert(srv, A);
      expect(`revert → ${rev.status}`).toBe("revert → 200");
      const reverted = await sse.waitFor("doc-changed", { from: m1, match: (d) => d.path === P });
      expect(`revert reason: ${reverted.data.reason}`).toBe("revert reason: proposal-reverted");
      expectBytes(readVaultBytes(srv.vault, P), toBytes(ORIGINAL), "bytes after the announced revert");
    } finally {
      sse.close();
    }
  }, 40000);
});

/* ============================================================
   5 — drift: the doc moved under the proposal (API.md, research §5)
   ============================================================ */

describe("drift — a proposal is re-validated against CURRENT bytes", () => {
  const P = "drift/doc.md";
  const ORIGINAL = "# Drift\n\nfirst line\nsecond line\n";
  let dsrv: TestServer;
  let dmock: MockUpstream;

  beforeAll(async () => {
    dmock = await newMock();
    dsrv = await newServer({ seed: { "inbox.md": "# Inbox\n\n", [P]: ORIGINAL } });
    await configure(dsrv, dmock);
  }, 60000);

  test("accept after the file moved under it is 422 anchor-miss, and writes nothing", async () => {
    dmock.reset();
    dmock.script(proposeEdits("Shout the first line", { op: "replace", path: P, find: "first line", replace: "FIRST LINE" }));
    const p = (await turn(dsrv, { content: "shout line one", docPath: P })).done().proposal;
    expect(p).toBeTruthy();

    /* the user edits the doc in the meantime — the anchor is gone */
    const DRIFTED = "# Drift\n\nrewritten by hand\nsecond line\n";
    const put = await dsrv.putDoc(P, DRIFTED);
    expect(`hand edit → ${put.status}`).toBe("hand edit → 200");
    await sleep(120);

    const acc = await accept(dsrv, p.id);
    expect(`accept a drifted proposal → ${acc.status} ${acc.body?.error}`).toBe(
      "accept a drifted proposal → 422 anchor-miss"
    );
    expect(`the stale anchor is named: ${acc.body.anchor}`).toBe("the stale anchor is named: first line");
    /* silently applying somewhere wrong is the failure this prevents */
    expectBytes(readVaultBytes(dsrv.vault, P), toBytes(DRIFTED), "the hand edit survives a refused accept");

    const list = await dsrv.get("/api/ai/proposals");
    expect(`stack after a refused accept: ${JSON.stringify(list.body.stack)}`).toBe("stack after a refused accept: []");

    await dsrv.putDoc(P, ORIGINAL);
    await sleep(120);
  }, 60000);

  test("revert after the APPLIED file drifted is 409 drifted — the later work is never clobbered", async () => {
    dmock.reset();
    dmock.script(proposeEdits("Shout the second line", { op: "replace", path: P, find: "second line", replace: "SECOND LINE" }));
    const p = (await turn(dsrv, { content: "shout line two", docPath: P })).done().proposal;
    expect(p).toBeTruthy();
    expect((await accept(dsrv, p.id)).status).toBe(200);

    /* the user keeps working on top of the accepted edit */
    const LATER = "# Drift\n\nfirst line\nSECOND LINE\nthird line the user added\n";
    expect((await dsrv.putDoc(P, LATER)).status).toBe(200);
    await sleep(120);

    const rev = await revert(dsrv, p.id);
    expect(`revert a drifted proposal → ${rev.status} ${rev.body?.error}`).toBe(
      "revert a drifted proposal → 409 drifted"
    );
    expect(`the drifted path is named: ${rev.body.path}`).toBe(`the drifted path is named: ${P}`);
    expectBytes(readVaultBytes(dsrv.vault, P), toBytes(LATER), "the user's later work survives a refused revert");

    /* and it is still on the stack — a refusal is not a pop */
    const list = await dsrv.get("/api/ai/proposals");
    expect(`still on the stack: ${list.body.stack.some((x: any) => x.id === p.id)}`).toBe("still on the stack: true");
  }, 60000);

  test("an unknown proposal id is 404 on every verb", async () => {
    for (const verb of ["accept", "revert", "reject"] as const) {
      const r = await dsrv.api("POST", ppath("prop_nosuchthing") + "/" + verb, {});
      expect(`${verb} an unknown id → ${r.status} ${r.body?.error}`).toBe(`${verb} an unknown id → 404 not-found`);
    }
  }, 30000);
});

/* ============================================================
   6 — git: one commit per accepted proposal (SPEC §8, research §5)
   ============================================================ */

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})\n${r.stderr || r.stdout}`);
  return r.stdout;
}

const commitCount = async (repo: string) => Number((await gitOk(repo, "rev-list", "--count", "HEAD")).trim()) || 0;

describe("git — one commit per accepted proposal (SPEC §8, research §5)", () => {
  const P = "notes/committed.md";
  const ORIGINAL = "# Committed\n\nbefore the ai touched it\n";
  let gsrv: TestServer;
  let gmock: MockUpstream;
  let vault = "";

  beforeAll(async () => {
    vault = makeVault({ "inbox.md": "# Inbox\n\n", [P]: ORIGINAL });
    orphanVaults.push(vault);
    await gitOk(vault, "init", "-b", "main");
    await gitOk(vault, "config", "user.name", "z-notes test");
    await gitOk(vault, "config", "user.email", "test@z-notes.invalid");
    await gitOk(vault, "config", "commit.gpgsign", "false");
    await gitOk(vault, "add", ".");
    await gitOk(vault, "commit", "-m", "initial");

    gmock = await newMock();
    gsrv = await newServer({ vault });
    await configure(gsrv, gmock);
  }, 60000);

  test("accept lands exactly one commit, subject `ai: <label>`, with both trailers", async () => {
    gmock.reset();
    gmock.script(
      proposeEdits("Rename the intro", {
        op: "replace",
        path: P,
        find: "before the ai touched it",
        replace: "after the ai touched it",
      })
    );
    const p = (await turn(gsrv, { content: "reword the intro", docPath: P })).done().proposal;
    expect(p).toBeTruthy();

    const before = await commitCount(vault);
    const acc = await accept(gsrv, p.id);
    expect(`accept → ${acc.status}`).toBe("accept → 200");

    await waitUntil(async () => (await commitCount(vault)) > before, {
      timeout: 10000,
      label: "the per-proposal commit",
    });
    expect(`commits added: ${(await commitCount(vault)) - before}`).toBe("commits added: 1");

    const subject = (await gitOk(vault, "log", "-1", "--pretty=format:%s")).trim();
    expect(subject).toBe("ai: " + p.label);

    const bodyText = await gitOk(vault, "log", "-1", "--pretty=format:%B");
    expect(`Z-Notes-Proposal trailer: ${bodyText.includes("Z-Notes-Proposal: " + p.id)}`).toBe(
      "Z-Notes-Proposal trailer: true"
    );
    expect(`Z-Notes-Model trailer: ${bodyText.includes("Z-Notes-Model: gpt-5.6-sol@high")}`).toBe(
      "Z-Notes-Model trailer: true"
    );

    const touched = (await gitOk(vault, "log", "-1", "--name-only", "--pretty=format:"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(touched).toContain(P);

    /* and the committed blob is what is on disk */
    const blob = await gitOk(vault, "show", "HEAD:" + P);
    expect(blob).toBe(readVaultText(vault, P));
  }, 60000);

  test("revert lands its own commit and restores the bytes", async () => {
    const list = await gsrv.get("/api/ai/proposals");
    const top = list.body.stack[list.body.stack.length - 1];
    expect(top).toBeTruthy();

    const before = await commitCount(vault);
    const rev = await revert(gsrv, top.id);
    expect(`revert → ${rev.status}`).toBe("revert → 200");

    await waitUntil(async () => (await commitCount(vault)) > before, {
      timeout: 10000,
      label: "the revert commit",
    });
    expect(`commits added by revert: ${(await commitCount(vault)) - before}`).toBe("commits added by revert: 1");
    expectBytes(readVaultBytes(vault, P), toBytes(ORIGINAL), "revert restoration in a repo");

    /* the undo gets its own commit rather than rewriting the one it undoes:
       this history is pushed to a remote (research §5) */
    const bodyText = await gitOk(vault, "log", "-1", "--pretty=format:%B");
    expect(`the revert commit carries its trailer: ${bodyText.includes("Z-Notes-Revert: ")}`).toBe(
      "the revert commit carries its trailer: true"
    );
    /* …and the accept commit is still in history, not rewritten away */
    expect(`the accept commit survives: ${(await gitOk(vault, "log", "--oneline")).includes("ai: " + top.label)}`).toBe(
      "the accept commit survives: true"
    );
  }, 60000);

  test("a vault that is NOT a repo still accepts — no commit, no repo conjured", async () => {
    /* `srv` is the shared, deliberately repo-less vault */
    mock.reset();
    const P2 = "ai/norepo.md";
    await seedDoc(srv, P2, "# No repo\n\nplain vault\n");
    mock.script(proposeEdits("Touch a repo-less vault", { op: "replace", path: P2, find: "plain vault", replace: "PLAIN VAULT" }));
    const p = (await turn(srv, { content: "edit it", docPath: P2 })).done().proposal;

    const acc = await accept(srv, p.id);
    expect(`accept without a repo → ${acc.status}`).toBe("accept without a repo → 200");
    expect(readVaultText(srv.vault, P2)).toBe("# No repo\n\nPLAIN VAULT\n");
    expect(`the server ran git init: ${existsSync(join(srv.vault, ".git"))}`).toBe("the server ran git init: false");

    /* the proposal record does not claim a commit that never happened */
    const list = await srv.get("/api/ai/proposals");
    const rec = list.body.proposals.find((x: any) => x.id === p.id);
    expect(`a commit sha was invented: ${/\b[0-9a-f]{40}\b/.test(JSON.stringify(rec))}`).toBe(
      "a commit sha was invented: false"
    );
    /* the reason IS recorded, so the UI can say why */
    expect(`the skip reason was recorded: ${!!rec.commitNote}`).toBe("the skip reason was recorded: true");
  }, 60000);
});

/* ============================================================
   7 — session semantics
   ============================================================ */

describe("sessions — history, dividers, token estimate", () => {
  test("messages survive a server restart (sqlite, not memory)", async () => {
    const vault = makeVault({ "inbox.md": "# Inbox\n\nhi\n" });
    orphanVaults.push(vault);
    const m = await newMock();

    const first = await startServer({ vault });
    let ids: string[] = [];
    try {
      await configure(first, m);
      m.reset();
      m.script(reply.text("Remembered across restarts."));
      const s = await turn(first, { content: "remember this", docPath: "inbox.md" });
      ids = s.done().messages.map((x: any) => x.id);
      expect(ids.length).toBe(2);
    } finally {
      await first.stop();
    }

    const second = await startServer({ vault });
    servers.push(second);
    const sess = await second.get("/api/ai/sessions/current");
    expect(sess.status).toBe(200);
    const got = sess.body.messages.map((x: any) => x.id);
    for (const id of ids) expect(`${id} survived the restart: ${got.includes(id)}`).toBe(`${id} survived the restart: true`);
    expect(sess.body.messages.find((x: any) => x.id === ids[1]).content).toBe("Remembered across restarts.");
  }, 90000);

  test("a new session inserts a divider and leaves the change stack alone", async () => {
    mock.reset();
    const P = "ai/session-stack.md";
    const original = "# Session stack\n\nkeep\nflip me\n";
    await seedDoc(srv, P, original);

    mock.script(proposeEdits("Flip", { op: "replace", path: P, find: "flip me", replace: "FLIPPED" }));
    const p = (await turn(srv, { content: "flip it", docPath: P })).done().proposal;
    expect((await accept(srv, p.id)).status).toBe(200);

    const stackBefore = (await srv.get("/api/ai/proposals")).body.stack;
    expect(stackBefore.length).toBeGreaterThan(0);

    const ns = await srv.api("POST", "/api/ai/sessions", {});
    expect(`new session → ${ns.status}`).toBe("new session → 201");
    const divider = ns.body.messages.find((x: any) => x.kind === "divider");
    expect(`divider present: ${!!divider}`).toBe("divider present: true");
    expect(divider.role).toBe("system");
    expect(ns.body.messages.filter((x: any) => x.role === "user").length).toBe(0);

    const stackAfter = (await srv.get("/api/ai/proposals")).body.stack;
    expect(stackAfter.map((e: any) => e.id)).toEqual(stackBefore.map((e: any) => e.id));

    /* and the stack still works across the session boundary */
    const rev = await revert(srv, p.id);
    expect(`revert across sessions → ${rev.status}`).toBe("revert across sessions → 200");
    expectBytes(readVaultBytes(srv.vault, P), toBytes(original), "restoration after a new session");
  }, 60000);

  test("tokensEstimated is a positive number that grows with the thread", async () => {
    mock.reset();
    const before = (await srv.get("/api/ai/sessions/current")).body.tokensEstimated;
    expect(typeof before).toBe("number");
    expect(before).toBeGreaterThan(0);

    mock.script(reply.text("A".repeat(600)));
    await turn(srv, { content: "a question that adds real tokens ".repeat(8), docPath: "notes/main.md" });

    const after = (await srv.get("/api/ai/sessions/current")).body.tokensEstimated;
    expect(`tokensEstimated grew (${before} → ${after}): ${after > before}`).toBe(
      `tokensEstimated grew (${before} → ${after}): true`
    );
    expect(Number.isFinite(after)).toBe(true);
  }, 40000);

  test("contextWindow comes from server meta, never the client", async () => {
    const meta = (await srv.get("/api/settings")).body.meta;
    const sess = (await srv.get("/api/ai/sessions/current")).body;
    expect(sess.contextWindow).toBe(meta.contextWindow);
    expect(typeof sess.contextWindow).toBe("number");
  }, 20000);
});

/* ============================================================
   8 — capability probe + degradation ladder (research §7)
   ============================================================ */

describe("capability probe and the degradation ladder", () => {
  test("saving settings probes the endpoint and records the result", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });

    const mark = m.mark();
    await configure(s, m);
    await m.waitForRequests(1, 8000);

    const probed = m.since(mark);
    expect(`probe requests: ${probed.length >= 1}`).toBe("probe requests: true");
    expect(`probe asked /responses: ${probed.some((r) => r.path === "/responses" && !r.stream)}`).toBe(
      "probe asked /responses: true"
    );
    /* the probe never streams and never bills a real turn */
    expect(probed.every((r) => r.stream === false)).toBe(true);
    for (const r of probed) expect(r.authorization).toBe("Bearer " + KEY);

    const settings = (await s.get("/api/settings")).body;
    const caps = findObject(
      settings,
      (o) => "probedAt" in o || ("responses" in o && "toolsWithReasoning" in o)
    );
    expect(`capabilities exposed in GET /api/settings: ${!!caps}`).toBe(
      "capabilities exposed in GET /api/settings: true"
    );
    expect(caps!.responses).toBe(true);
    expect(caps!.toolsWithReasoning).toBe(true);
    expect(typeof caps!.probedAt).toBe("string");
  }, 60000);

  test("a 400 on reasoning.summary strips exactly that param, retries, and records ONE downgrade", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    m.rejectParam("reasoning.summary");
    m.script(reply.text("Answered after the strip."), reply.text("Second turn, one shot."));

    const first = await turn(s, { content: "first turn", docPath: "inbox.md" });
    expect(first.text()).toBe("Answered after the strip.");

    const streamed = m.streamed();
    expect(`upstream attempts for turn 1: ${streamed.length}`).toBe("upstream attempts for turn 1: 2");
    expect(`attempt 1 sent reasoning.summary: ${"summary" in (streamed[0].body.reasoning ?? {})}`).toBe(
      "attempt 1 sent reasoning.summary: true"
    );
    expect(`attempt 2 sent reasoning.summary: ${"summary" in (streamed[1].body.reasoning ?? {})}`).toBe(
      "attempt 2 sent reasoning.summary: false"
    );
    /* only the summary was dropped — effort is still explicit */
    expect(streamed[1].body.reasoning?.effort).toBe("high");
    expect(streamed[1].body.store).toBe(false);
    expect(streamed[1].body.parallel_tool_calls).toBe(false);

    /* the downgrade is permanent: the second turn does not re-learn it */
    const mark = m.mark();
    const second = await turn(s, { content: "second turn", docPath: "inbox.md" });
    expect(second.text()).toBe("Second turn, one shot.");
    expect(`upstream attempts for turn 2: ${m.streamed(mark).length}`).toBe("upstream attempts for turn 2: 1");

    /* …and it is visible, once, in GET /api/settings */
    const settings = (await s.get("/api/settings")).body;
    const blob = JSON.stringify(settings);
    expect(`the downgrade is surfaced: ${/summary/i.test(blob) && /degrad|downgrad|strip|fallback/i.test(blob)}`).toBe(
      "the downgrade is surfaced: true"
    );
  }, 60000);

  test("the ladder walks further down when several params are refused", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    m.rejectParam("reasoning.summary");
    m.rejectParam("store");
    m.rejectParam("parallel_tool_calls");
    m.setDefault(reply.text("Survived the ladder."));

    const st = await turn(s, { content: "walk the ladder", docPath: "inbox.md" });
    expect(st.text()).toBe("Survived the ladder.");

    const last = m.streamed()[m.streamed().length - 1];
    expect(`final attempt kept reasoning.summary: ${"summary" in (last.body.reasoning ?? {})}`).toBe(
      "final attempt kept reasoning.summary: false"
    );
    expect(`final attempt kept store: ${"store" in last.body}`).toBe("final attempt kept store: false");
    expect(`final attempt kept parallel_tool_calls: ${"parallel_tool_calls" in last.body}`).toBe(
      "final attempt kept parallel_tool_calls: false"
    );
    /* the tool contract itself is never sacrificed on the way down */
    expect(`the tool survived: ${!!toolDef(last.body)}`).toBe("the tool survived: true");
    expect(`attempts: ${m.streamed().length <= 6}`).toBe("attempts: true");
  }, 60000);

  test("an endpoint with no /responses collapses to chat-completions and flags itself degraded", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });

    m.setResponsesStatus(404);
    await configure(s, m);

    m.script(reply.text("Answered over chat-completions."));
    const st = await turn(s, { content: "no responses endpoint here", docPath: "inbox.md" });

    expect(`chat-completions used: ${m.chatCompletions().length >= 1}`).toBe("chat-completions used: true");
    expect(st.text()).toBe("Answered over chat-completions.");

    const chat = m.chatCompletions()[0];
    expect(chat.authorization).toBe("Bearer " + KEY);
    expect(`tools still sent: ${JSON.stringify(chat.body.tools ?? []).includes("propose_edits")}`).toBe(
      "tools still sent: true"
    );
    /* function tools + any effort other than "none" is a hard 400 there (research §2.1) */
    expect(`reasoning_effort is none-or-absent: ${(chat.body.reasoning_effort ?? "none") === "none"}`).toBe(
      "reasoning_effort is none-or-absent: true"
    );

    const surfaces = JSON.stringify([
      (await s.get("/api/settings")).body,
      (await s.get("/api/ai/sessions/current")).body,
    ]);
    expect(`degradation is visible to the UI: ${/degrad/i.test(surfaces)}`).toBe(
      "degradation is visible to the UI: true"
    );
    const degraded = findByKey(JSON.parse(surfaces), /degrad/i);
    expect(`a truthy degraded flag: ${degraded.some(([, v]) => !!v)}`).toBe("a truthy degraded flag: true");
  }, 60000);
});

/* ============================================================
   9 — key custody
   ============================================================ */

describe("custody — the key goes upstream and nowhere else", () => {
  test("every /api/* response and every SSE payload is key-free", async () => {
    mock.reset();
    mock.script(proposeEdits("Custody", { op: "replace", path: "notes/target.md", find: "bravo line", replace: "BRAVO" }));
    const stream = await turn(srv, { content: "touch the target doc", docPath: "notes/target.md" });
    const prop = stream.done().proposal;
    expect(prop).toBeTruthy();

    /* it really did reach the upstream — otherwise every check below is vacuous */
    expect(mock.streamed()[0].authorization).toBe("Bearer " + KEY);

    const probes = [
      "/api/docs",
      "/api/docs/" + encPath("notes/target.md"),
      "/api/search?q=&limit=100",
      "/api/search?q=sk&limit=100",
      "/api/settings",
      "/api/sync/status",
      "/api/ai/sessions/current",
      "/api/ai/proposals",
    ];
    for (const p of probes) {
      const r = await srv.get(p);
      expect(`${p} → ${r.status}`).toBe(`${p} → 200`);
      expect(`${p} leaks the key: ${r.text.includes(KEY)}`).toBe(`${p} leaks the key: false`);
    }

    const acc = await accept(srv, prop.id);
    expect(acc.status).toBe(200);
    expect(`accept response leaks the key: ${acc.text.includes(KEY)}`).toBe("accept response leaks the key: false");
    const rev = await revert(srv, prop.id);
    expect(`revert response leaks the key: ${rev.text.includes(KEY)}`).toBe("revert response leaks the key: false");

    expect(`the message stream leaks the key: ${stream.raw.includes(KEY)}`).toBe(
      "the message stream leaks the key: false"
    );

    /* settings expose only the mask */
    const st = (await srv.get("/api/settings")).body;
    expect(st.settings.ai.apiKey).toBeUndefined();
    expect(typeof st.settings.ai.apiKeyMasked).toBe("string");
    expect(st.settings.ai.apiKeyMasked).not.toBe(KEY);

    /* nor does the server ever print it */
    expect(`the key is in the server's own output: ${srv.stdoutLines.concat(srv.stderrLines).join("\n").includes(KEY)}`)
      .toBe("the key is in the server's own output: false");
  }, 60000);
});

/* ============================================================
   10 — regression gates for the phase-4 review findings

   Every test here reproduces one defect end-to-end through the real server and
   the scripted mock, then asserts the behaviour the contract requires. They are
   grouped by the invariant they defend, not by the file they were found in.
   ============================================================ */

describe("custody — an upstream that echoes the key back never re-publishes it", () => {
  test("a 401 whose body quotes the presented key is scrubbed on all three surfaces", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    /* the exact shape every OpenAI-compatible gateway uses — and the shipped
       default baseUrl is a third-party local proxy whose error text z-notes
       does not control */
    m.reset();
    m.setDefault(
      reply.http(401, {
        error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at …`, type: "invalid_request_error" },
      })
    );

    const st = await turn(s, { content: "please fail", docPath: "inbox.md" });
    expect(`the failure surfaced: ${st.errors().length > 0}`).toBe("the failure surfaced: true");

    /* 1 — the SSE stream */
    expect(`the error event leaks the key: ${st.raw.includes(KEY)}`).toBe("the error event leaks the key: false");

    /* 2 — sqlite-backed chat history, re-served on every session load AND
           replayed upstream as `history` on every later turn in this session */
    const sess = await s.get("/api/ai/sessions/current");
    expect(`GET sessions/current leaks the key: ${sess.text.includes(KEY)}`).toBe(
      "GET sessions/current leaks the key: false"
    );

    /* 3 — the capability probe's record, handed to the browser as meta.ai.probe */
    await s.api("PUT", "/api/settings", { ai: { model: "gpt-5.6-sol" } });
    await sleep(300);
    const settings = await s.get("/api/settings");
    expect(`GET /api/settings leaks the key: ${settings.text.includes(KEY)}`).toBe(
      "GET /api/settings leaks the key: false"
    );

    /* the failure is still legible — scrubbing must not blank the diagnosis */
    const shown = JSON.stringify(st.errors());
    expect(`the status is still reported: ${shown.includes("401")}`).toBe("the status is still reported: true");

    /* …and the leaked text never goes back out over the wire either */
    m.setDefault(reply.text("recovered"));
    const mark = m.mark();
    await turn(s, { content: "second turn", docPath: "inbox.md" });
    const replayed = JSON.stringify(m.streamed(mark).map((r) => r.body));
    expect(`the next turn replays the key upstream: ${replayed.includes(KEY)}`).toBe(
      "the next turn replays the key upstream: false"
    );
  }, 60000);

  /* The sibling path, which had no scrub at all: an upstream that answers HTTP
     200 and reports the failure INSIDE the stream. Same message, same AiError,
     same three surfaces — the 401 above was scrubbed only because the scrub sat
     on the `!res.ok` branch. Every mid-stream failure shape is covered:
     `error` on /responses, `response.failed`, and the chat-completions rung. */
  for (const [label, make, rung] of [
    ["a mid-stream `error` event on a 200 stream", (msg: string) => reply.error(msg), "responses"],
    ["a `response.failed` event", (msg: string) => reply.failed(msg), "responses"],
    ["a chat/completions error frame", (msg: string) => reply.error(msg), "chat"],
  ] as Array<[string, (msg: string) => ReturnType<typeof reply.error>, "responses" | "chat"]>) {
    test(`${label} whose text quotes the presented key is scrubbed on all three surfaces`, async () => {
      const m = await newMock();
      const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
      await configure(s, m);

      m.reset();
      // 404 on /responses drives the documented fallback to chat/completions
      if (rung === "chat") m.setResponsesStatus(404);
      m.setDefault(make(`Incorrect API key provided: ${KEY}. You can find your API key at …`));

      const st = await turn(s, { content: "please fail", docPath: "inbox.md" });
      expect(`the failure surfaced: ${st.errors().length > 0}`).toBe("the failure surfaced: true");

      /* 1 — the SSE stream the browser reads */
      expect(`the error event leaks the key: ${st.raw.includes(KEY)}`).toBe("the error event leaks the key: false");

      /* 2 — sqlite-backed chat history, re-served on every session load */
      const sess = await s.get("/api/ai/sessions/current");
      expect(`GET sessions/current leaks the key: ${sess.text.includes(KEY)}`).toBe(
        "GET sessions/current leaks the key: false"
      );

      /* 3 — replayed upstream as `history` on the next turn, possibly to a
             different endpoint after a settings change */
      m.setResponsesStatus(null);
      m.setDefault(reply.text("recovered"));
      const mark = m.mark();
      await turn(s, { content: "second turn", docPath: "inbox.md" });
      const replayed = JSON.stringify(m.streamed(mark).map((r) => r.body));
      expect(`the next turn replays the key upstream: ${replayed.includes(KEY)}`).toBe(
        "the next turn replays the key upstream: false"
      );

      /* the diagnosis survives the scrubbing — a blanked error is not a fix */
      const shown = JSON.stringify(st.errors());
      expect(`the failure is still legible: ${/Incorrect API key/i.test(shown)}`).toBe(
        "the failure is still legible: true"
      );
    }, 60000);
  }

  /* Model-produced prose lands in exactly the same durable, replayed-upstream
     channel, and an endpoint that can be told to echo the key back in an error
     can be told to say it in a completion. */
  test("an assistant message quoting the key is scrubbed before it is persisted", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    m.setDefault(reply.text(`Sure — your key is ${KEY}, use it like this.`));
    await turn(s, { content: "what is my key?", docPath: "inbox.md" });

    const sess = await s.get("/api/ai/sessions/current");
    expect(`GET sessions/current leaks the key: ${sess.text.includes(KEY)}`).toBe(
      "GET sessions/current leaks the key: false"
    );

    m.setDefault(reply.text("ok"));
    const mark = m.mark();
    await turn(s, { content: "second turn", docPath: "inbox.md" });
    const replayed = JSON.stringify(m.streamed(mark).map((r) => r.body));
    expect(`the next turn replays the key upstream: ${replayed.includes(KEY)}`).toBe(
      "the next turn replays the key upstream: false"
    );
  }, 60000);

  test("the probe never echoes upstream bytes back through meta.ai.probe", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    /* an "endpoint" that is really some other internal service: pointing
       ai.baseUrl at it used to hand its response body back to the caller */
    const SECRET_BODY = '{"cluster":"prod-es","secret":"INTERNAL-ONLY-CLUSTER-SECRET-abc123"}';
    const victim = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(SECRET_BODY, { status: 401, headers: { "content-type": "application/json" } }),
    });
    try {
      const r = await s.api("PUT", "/api/settings", {
        ai: { baseUrl: `http://127.0.0.1:${victim.port}/v1`, apiKey: KEY, model: "gpt-5.6-sol" },
      });
      expect(`PUT → ${r.status}`).toBe("PUT → 200");
      await sleep(400);

      const settings = await s.get("/api/settings");
      expect(`the probe echoed the internal body: ${settings.text.includes("INTERNAL-ONLY-CLUSTER-SECRET")}`).toBe(
        "the probe echoed the internal body: false"
      );
      expect(`the probe echoed any of it: ${settings.text.includes("prod-es")}`).toBe(
        "the probe echoed any of it: false"
      );
      /* the outcome is still reported, just classified rather than quoted */
      const probe = findObject(settings.body, (o) => "probedAt" in o) ?? {};
      expect(`the probe recorded a failure: ${!!probe.error}`).toBe("the probe recorded a failure: true");
      expect(`the probe names the status: ${String(probe.error).includes("401")}`).toBe(
        "the probe names the status: true"
      );
    } finally {
      victim.stop(true);
    }
  }, 40000);

  test("ai.baseUrl must be an http(s) URL — the probe is not a general-purpose fetch", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n" } });
    for (const bad of ["file:///etc/passwd", "gopher://x/1", "not a url at all", "ftp://example.invalid/x"]) {
      const r = await s.api("PUT", "/api/settings", { ai: { baseUrl: bad } });
      expect(`PUT ai.baseUrl=${bad} → ${r.status}`).toBe(`PUT ai.baseUrl=${bad} → 400`);
    }
    /* the legitimate values still pass, including "unset" */
    for (const ok of ["http://127.0.0.1:8317/v1", "https://api.example.invalid/v1", ""]) {
      const r = await s.api("PUT", "/api/settings", { ai: { baseUrl: ok } });
      expect(`PUT ai.baseUrl=${JSON.stringify(ok)} → ${r.status}`).toBe(`PUT ai.baseUrl=${JSON.stringify(ok)} → 200`);
    }
  }, 40000);
});

describe("protocol — .done frames that disagree on item identity", () => {
  test("a gateway that drops item_id does not store the message twice", async () => {
    mock.reset();
    mock.script(reply.text("Hello world", { idDrift: "drop-item-id" }));
    const s = await turn(srv, { content: "identity drift a", docPath: "notes/main.md" });
    expect(s.text()).toBe("Hello world");
    expect(s.done().messages[1].content).toBe("Hello world");
  }, 30000);

  test("a terminal event that renumbers the item does not store the message twice", async () => {
    mock.reset();
    mock.script(reply.text("Hi.", { idDrift: "renumber" }));
    const s = await turn(srv, { content: "identity drift b", docPath: "notes/main.md" });
    expect(s.text()).toBe("Hi.");
    expect(s.done().messages[1].content).toBe("Hi.");
  }, 30000);

  test("a run that carries its output ONLY on response.completed is still read", async () => {
    mock.reset();
    mock.script(reply.text("Terminal only.", { idDrift: "terminal-only" }));
    const s = await turn(srv, { content: "identity drift c", docPath: "notes/main.md" });
    expect(s.done().messages[1].content).toBe("Terminal only.");
  }, 30000);

  test("deltas that arrive out of order are REORDERED before the client sees them", async () => {
    const ANSWER = "AAA-BBB-CCC-DDD-EEE-FFF";
    mock.reset();
    mock.script(reply.text(ANSWER, { chunkSize: 4, outOfOrder: true }));
    const s = await turn(srv, { content: "ordering, live", docPath: "notes/main.md" });
    /* the `.done` payload is order-independent by construction, so asserting on
       it alone proves nothing about ordered(); this asserts the DELTAS */
    expect(s.text()).toBe(ANSWER);
    expect(s.done().messages[1].content).toBe(ANSWER);
  }, 30000);
});

describe("protocol — the degradation ladder only descends on a parameter refusal", () => {
  test("an ordinary 400 (context length) does not walk the ladder", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    const mark = m.mark();
    m.setDefault(
      reply.http(400, {
        error: {
          message: "This model's maximum context length is 1048576 tokens, however you requested 1200000.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      })
    );
    const st = await turn(s, { content: "too big", docPath: "inbox.md" });
    expect(`the failure surfaced: ${st.errors().length > 0}`).toBe("the failure surfaced: true");

    /* one attempt, not seven: re-sending an already-oversized context six more
       times is pure token spend on a turn that cannot succeed */
    expect(`upstream attempts for one bad 400: ${m.streamed(mark).length}`).toBe(
      "upstream attempts for one bad 400: 1"
    );

    /* …and nothing was recorded as degraded, so the endpoint keeps /responses
       and its reasoning once the real problem is fixed */
    const settings = (await s.get("/api/settings")).body;
    const rungs = findByKey(settings, /^degraded$/).map(([, v]) => v);
    expect(`rungs recorded: ${JSON.stringify(rungs)}`).toBe("rungs recorded: [[]]");

    m.setDefault(reply.text("Back to normal."));
    const after = m.mark();
    const ok = await turn(s, { content: "smaller", docPath: "inbox.md" });
    expect(ok.text()).toBe("Back to normal.");
    const body = m.streamed(after)[0].body;
    expect(`the next turn still used /responses: ${m.streamed(after)[0].path}`).toBe(
      "the next turn still used /responses: /responses"
    );
    expect(`the next turn still sent reasoning: ${!!body.reasoning}`).toBe("the next turn still sent reasoning: true");
    expect(body.reasoning?.effort).toBe("high");
  }, 60000);

  test("the effort rung walks the whole scale before reasoning is dropped", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    /* a gateway that supports only none|low|medium|high — exactly what research
       §2.3 documents for CLIProxyAPI, the shipped default base URL */
    await configure(s, m, { effort: "max" });

    m.reset();
    m.setDefault(reply.text("Answered."));
    m.rejectEffort(["max", "xhigh"]);

    const st = await turn(s, { content: "walk the effort scale", docPath: "inbox.md" });
    expect(st.text()).toBe("Answered.");

    const efforts = m.streamed().map((r) => (r.body.reasoning ? String(r.body.reasoning.effort) : "(no reasoning)"));
    expect(`"high" was actually tried: ${efforts.includes("high")}`).toBe('"high" was actually tried: true');
    expect(`reasoning was dropped anyway: ${efforts.includes("(no reasoning)")}`).toBe(
      "reasoning was dropped anyway: false"
    );

    /* and the level it landed on is what the session reports and keeps */
    const sess = (await s.get("/api/ai/sessions/current")).body;
    expect(`session effort after the walk: ${sess.effort}`).toBe("session effort after the walk: high");
  }, 60000);
});

describe("protocol — an aborted turn keeps the prose it already streamed", () => {
  test("the thread is never left with a user turn and no answer", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    m.script(reply.text("AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH", { chunkSize: 4, dripMs: 90 }));

    const stream = await AiStream.open(s, { content: "abort me please", docPath: "inbox.md" });
    await waitUntil(() => stream.text().length >= 12, { timeout: 8000, interval: 20, label: "the first deltas" });
    const painted = stream.text();
    stream.abort();
    await sleep(500);

    /* the upstream really was cancelled — otherwise the endpoint bills a turn
       nobody will read (research §3.3) */
    expect(`the upstream stream was cancelled: ${m.streamed()[0].cancelled}`).toBe(
      "the upstream stream was cancelled: true"
    );

    const sess = (await s.get("/api/ai/sessions/current")).body;
    const roles = sess.messages.filter((x: any) => x.kind !== "divider").map((x: any) => x.role);
    expect(`persisted roles after an abort: ${roles.join(",")}`).toBe("persisted roles after an abort: user,assistant");
    const answer = sess.messages[sess.messages.length - 1].content;
    expect(`the streamed prose was kept: ${answer.startsWith(painted.slice(0, 8))}`).toBe(
      "the streamed prose was kept: true"
    );
  }, 60000);
});

describe("protocol — reasoning items survive the in-turn tool retry", () => {
  test("the reasoning item is replayed with the function_call it preceded", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "notes/r.md": "# R\n\nkeepme line\n" } });
    await configure(s, m);

    const BLOB = "ENCRYPTEDREASONINGBLOB-0123456789";
    m.reset();
    /* first call: an anchor that does not exist → rejected → retry */
    m.script(
      reply.tool(toolArgs("miss", [{ op: "replace", path: "notes/r.md", find: "NOSUCHLINE", replace: "x" }]), {
        encryptedReasoning: BLOB,
      }),
      proposeEdits("hit", { op: "replace", path: "notes/r.md", find: "keepme line", replace: "KEPT" })
    );

    const st = await turn(s, { content: "retry with reasoning", docPath: "notes/r.md" });
    expect(`a proposal was reached: ${!!st.done().proposal}`).toBe("a proposal was reached: true");

    const streamed = m.streamed();
    expect(`upstream attempts: ${streamed.length}`).toBe("upstream attempts: 2");

    /* research §2.2: under store:false the WHOLE output must be replayed, and
       the reasoning item is the only thing carrying the chain that produced the
       anchor the model now has to correct */
    expect(`the retry ran stateless: ${streamed[1].body.store}`).toBe("the retry ran stateless: false");
    const input: any[] = streamed[1].body.input ?? [];
    const kinds = input.map((i) => i?.type ?? ("role:" + i?.role));
    expect(`the retry replayed a reasoning item: ${kinds.includes("reasoning")}`).toBe(
      "the retry replayed a reasoning item: true"
    );
    expect(`its encrypted_content survived: ${JSON.stringify(streamed[1].body).includes(BLOB)}`).toBe(
      "its encrypted_content survived: true"
    );
    /* order matters: the reasoning item must PRECEDE the call it belongs to */
    expect(`reasoning precedes the function_call: ${kinds.indexOf("reasoning") < kinds.indexOf("function_call")}`).toBe(
      "reasoning precedes the function_call: true"
    );
  }, 60000);
});

describe("custody — accept is one critical section, and its write phase is all-or-nothing", () => {
  test("two concurrent accepts apply the proposal exactly once", async () => {
    const P = "race/dup.md";
    const ORIGINAL = "# Dup\n\nANCHORLINE\n\ntail\n";
    await seedDoc(srv, P, ORIGINAL);

    mock.reset();
    /* insert_after is the exploitable op: its anchor SURVIVES the first write,
       so a second application matches again and succeeds */
    mock.script(
      proposeEdits("Insert twice?", { op: "insert_after", path: P, find: "ANCHORLINE", content: "\nINSERTED BLOCK\n" })
    );
    const p = (await turn(srv, { content: "insert a block", docPath: P })).done().proposal;
    expect(p).toBeTruthy();

    const [a, b] = await Promise.all([accept(srv, p.id), accept(srv, p.id)]);
    const codes = [a.status, b.status].sort((x, y) => x - y);
    expect(`concurrent accept statuses: ${codes.join(",")}`).toBe("concurrent accept statuses: 200,409");

    const after = readVaultText(srv.vault, P);
    expect(`insertions on disk: ${after.split("INSERTED BLOCK").length - 1}`).toBe("insertions on disk: 1");

    const listed = (await srv.get("/api/ai/proposals")).body;
    expect(`stack entries for this proposal: ${listed.stack.filter((x: any) => x.id === p.id).length}`).toBe(
      "stack entries for this proposal: 1"
    );

    /* the pre-image still describes the TRUE pre-state, so the LIFO unwind is
       byte-exact — the whole point of the stack (SPEC §11) */
    const rev = await revert(srv, p.id);
    expect(`revert → ${rev.status}`).toBe("revert → 200");
    expectBytes(readVaultBytes(srv.vault, P), toBytes(ORIGINAL), "byte-exact unwind after a double accept");
  }, 60000);

  test("a write failure part-way through a multi-file proposal leaves NOTHING changed", async () => {
    const KEEP = "atomic/keep.md";
    const KEEP_ORIGINAL = "# Keep\n\nSAFE LINE\n";
    await seedDoc(srv, KEEP, KEEP_ORIGINAL);

    /* an unwritable target the validator cannot see through: a perfectly
       ordinary doc in a READ-ONLY directory. It reads fine, so `rewrite`
       validates — and then writeDocAtomic's rename() into the locked parent
       fails EACCES. Stands in for every per-file write failure (ENOSPC, a
       read-only parent, …).

       NOT a directory named `*.md` any more: `create` now asks the same
       stat-based exists() the human create path uses, so anything occupying
       the path is rejected up front (that gap let the assistant clobber — and,
       via revert, DELETE — files readDoc could not decode). */
    const LOCKED_DIR = "atomic/locked";
    const BLOCKED = LOCKED_DIR + "/blocked.md";
    const BLOCKED_ORIGINAL = "# Blocked\n\nUNTOUCHED\n";
    await seedDoc(srv, BLOCKED, BLOCKED_ORIGINAL);
    chmodSync(join(srv.vault, LOCKED_DIR), 0o500);
    await sleep(120);

    let acc: Awaited<ReturnType<typeof accept>>;
    let p: any;
    try {
      mock.reset();
      mock.script(
        reply.tool(
          toolArgs("two files, one impossible", [
            { op: "replace", path: KEEP, find: "SAFE LINE", replace: "AI CHANGED THIS" },
            { op: "replace", path: BLOCKED, find: "UNTOUCHED", replace: "AI CHANGED THIS TOO" },
          ])
        )
      );
      p = (await turn(srv, { content: "write two files", docPath: KEEP })).done().proposal;
      expect(p).toBeTruthy();

      acc = await accept(srv, p.id);
    } finally {
      chmodSync(join(srv.vault, LOCKED_DIR), 0o700);
    }
    expect(`accept of an unwritable proposal → ${acc.status}`).toBe("accept of an unwritable proposal → 422");
    expect(`the error names the file: ${acc.text.includes("blocked.md")}`).toBe("the error names the file: true");
    expect(`it is not a server-fault 500: ${acc.body.error}`).toBe("it is not a server-fault 500: write-failed");
    expectBytes(readVaultBytes(srv.vault, BLOCKED), toBytes(BLOCKED_ORIGINAL), "the unwritable file never changed");

    /* the file that DID get written is rolled back to its pre-image */
    expectBytes(readVaultBytes(srv.vault, KEEP), toBytes(KEEP_ORIGINAL), "rollback of the first file");

    /* …and the proposal is left in a state the user can act on: still pending,
       not on the stack, and honestly reported as such */
    const listed = (await srv.get("/api/ai/proposals")).body;
    const row = listed.proposals.find((x: any) => x.id === p.id);
    expect(`state after a failed accept: ${row.state}`).toBe("state after a failed accept: pending");
    expect(`stackIndex after a failed accept: ${row.stackIndex}`).toBe("stackIndex after a failed accept: null");
  }, 60000);

  test("op:create under a path segment that is a FILE is rejected at validate, not at accept", async () => {
    const BLOCKER = "notes/blocker.md";
    await seedDoc(srv, BLOCKER, "# Blocker\n\nI am a document, not a folder.\n");

    mock.reset();
    mock.setDefault(reply.text("I give up."));
    mock.script(proposeEdits("nest under a file", { op: "create", path: BLOCKER + "/child.md", content: "# child\n" }));

    const st = await turn(srv, { content: "put this under my blocker notes", docPath: BLOCKER });
    /* API.md: "the UI is never offered an Accept button for an edit that cannot
       apply" — so there must be no proposal at all */
    expect(`a proposal was offered: ${!!st.done().proposal}`).toBe("a proposal was offered: false");

    /* the rejection is a TOOL RESULT the model can retry against (research §4.4
       step 6), which is the whole reason it must not happen at accept time */
    const retried = mock.streamed();
    expect(`the rejection was fed back for a retry: ${retried.length >= 2}`).toBe(
      "the rejection was fed back for a retry: true"
    );
    const fedBack = JSON.stringify(retried[1].body.input ?? []);
    expect(`the model was told the parent is a file: ${/parent_is_file|not a folder|is a document/.test(fedBack)}`).toBe(
      "the model was told the parent is a file: true"
    );

    /* the blocker itself is untouched and still a document */
    expect(readVaultText(srv.vault, BLOCKER)).toBe("# Blocker\n\nI am a document, not a folder.\n");
  }, 60000);
});

describe("custody — an anchored edit never changes a document's line endings", () => {
  const CRLF = "crlf/doc.md";
  const ORIGINAL = "# CRLF\r\n\r\nalpha line\r\nbravo line\r\ncharlie line\r\n";

  test("replace splices CRLF into a CRLF file (SPEC §1: byte-faithful)", async () => {
    await seedDoc(srv, CRLF, ORIGINAL);
    mock.reset();
    /* the model sends LF-only text — which is exactly what pass 2 of findAnchor
       exists to tolerate, and exactly what used to corrupt the file */
    mock.script(
      proposeEdits("reword", { op: "replace", path: CRLF, find: "alpha line\nbravo line", replace: "ALPHA\nBRAVO" })
    );
    const p = (await turn(srv, { content: "reword the first two lines", docPath: CRLF })).done().proposal;
    expect(p).toBeTruthy();

    /* the diff card is display text, not bytes: no stray CR in it */
    const diffText = JSON.stringify(p.diff);
    expect(`the diff carries a literal CR: ${diffText.includes("\\r")}`).toBe("the diff carries a literal CR: false");

    expect((await accept(srv, p.id)).status).toBe(200);
    const after = readVaultText(srv.vault, CRLF);
    expect(`bare LFs left in a CRLF file: ${(after.match(/(?<!\r)\n/g) || []).length}`).toBe(
      "bare LFs left in a CRLF file: 0"
    );
    expect(after).toBe("# CRLF\r\n\r\nALPHA\r\nBRAVO\r\ncharlie line\r\n");

    expect((await revert(srv, p.id)).status).toBe(200);
    expectBytes(readVaultBytes(srv.vault, CRLF), toBytes(ORIGINAL), "CRLF revert");
  }, 60000);

  test("insert_after does the same", async () => {
    await seedDoc(srv, CRLF, ORIGINAL);
    mock.reset();
    mock.script(
      proposeEdits("add", { op: "insert_after", path: CRLF, find: "alpha line\n", content: "inserted one\ninserted two\n" })
    );
    const p = (await turn(srv, { content: "add two lines", docPath: CRLF })).done().proposal;
    expect(p).toBeTruthy();
    expect((await accept(srv, p.id)).status).toBe(200);

    const after = readVaultText(srv.vault, CRLF);
    expect(`bare LFs left in a CRLF file: ${(after.match(/(?<!\r)\n/g) || []).length}`).toBe(
      "bare LFs left in a CRLF file: 0"
    );
    expect(after).toBe("# CRLF\r\n\r\nalpha line\r\ninserted one\r\ninserted two\r\nbravo line\r\ncharlie line\r\n");
  }, 60000);

  test("an LF document is left alone (the fix only ever adds CR where CR already is)", async () => {
    const LF = "crlf/plain.md";
    const LF_ORIGINAL = "# LF\n\nalpha line\nbravo line\n";
    await seedDoc(srv, LF, LF_ORIGINAL);
    mock.reset();
    mock.script(
      proposeEdits("reword", { op: "replace", path: LF, find: "alpha line\nbravo line", replace: "ALPHA\nBRAVO" })
    );
    const p = (await turn(srv, { content: "reword", docPath: LF })).done().proposal;
    expect((await accept(srv, p.id)).status).toBe(200);
    expect(readVaultText(srv.vault, LF)).toBe("# LF\n\nALPHA\nBRAVO\n");
  }, 60000);
});

describe("custody — multi-edit and multi-file proposals (research §4.4)", () => {
  const A = "multi/a.md";
  const B = "multi/b.md";
  const A_ORIGINAL = "# A\n\nalpha one\nalpha two\nalpha three\n";
  const B_ORIGINAL = "# B\n\nbravo one\nbravo two\n";

  beforeEach(async () => {
    await seedDoc(srv, A, A_ORIGINAL);
    await seedDoc(srv, B, B_ORIGINAL);
    mock.reset();
    mock.setDefault(reply.text("I could not do it."));
  });

  test("a middle edit that cannot apply rejects the WHOLE proposal — nothing is written", async () => {
    mock.script(
      reply.tool(
        toolArgs("three edits, one impossible", [
          { op: "replace", path: A, find: "alpha one", replace: "ALPHA ONE" },
          { op: "replace", path: A, find: "NOSUCHLINE", replace: "x" },
          { op: "replace", path: A, find: "alpha three", replace: "ALPHA THREE" },
        ])
      )
    );
    const st = await turn(srv, { content: "three edits", docPath: A });
    expect(`a proposal was offered: ${!!st.done().proposal}`).toBe("a proposal was offered: false");
    expectBytes(readVaultBytes(srv.vault, A), toBytes(A_ORIGINAL), "no partial application at validate");
  }, 60000);

  test("two files apply together and unwind together, byte for byte", async () => {
    mock.script(
      reply.tool(
        toolArgs("touch both files", [
          { op: "replace", path: A, find: "alpha one", replace: "ALPHA ONE" },
          { op: "replace", path: B, find: "bravo two", replace: "BRAVO TWO" },
          { op: "insert_after", path: A, find: "alpha three\n", content: "alpha four\n" },
        ])
      )
    );
    const p = (await turn(srv, { content: "touch both", docPath: A })).done().proposal;
    expect(p).toBeTruthy();
    expect(`the proposal names both files: ${p.summary}`).toBe("the proposal names both files: 2 files · 5 lines");
    /* nothing is written until it is accepted */
    expectBytes(readVaultBytes(srv.vault, A), toBytes(A_ORIGINAL), "A before accept");
    expectBytes(readVaultBytes(srv.vault, B), toBytes(B_ORIGINAL), "B before accept");

    expect((await accept(srv, p.id)).status).toBe(200);
    expect(readVaultText(srv.vault, A)).toBe("# A\n\nALPHA ONE\nalpha two\nalpha three\nalpha four\n");
    expect(readVaultText(srv.vault, B)).toBe("# B\n\nbravo one\nBRAVO TWO\n");

    expect((await revert(srv, p.id)).status).toBe(200);
    expectBytes(readVaultBytes(srv.vault, A), toBytes(A_ORIGINAL), "A after revert");
    expectBytes(readVaultBytes(srv.vault, B), toBytes(B_ORIGINAL), "B after revert");
  }, 60000);

  test("edits apply sequentially against the RUNNING image, so an anchor a previous edit duplicated is ambiguous", async () => {
    mock.script(
      reply.tool(
        toolArgs("duplicate then anchor on it", [
          { op: "insert_after", path: A, find: "alpha two", content: "alpha one\n" },
          { op: "replace", path: A, find: "alpha one", replace: "X" },
        ])
      )
    );
    const st = await turn(srv, { content: "duplicate then anchor", docPath: A });
    expect(`a proposal was offered: ${!!st.done().proposal}`).toBe("a proposal was offered: false");
    const fedBack = JSON.stringify(mock.streamed()[1]?.body?.input ?? []);
    expect(`the model was told it is ambiguous: ${fedBack.includes("ambiguous")}`).toBe(
      "the model was told it is ambiguous: true"
    );
    expectBytes(readVaultBytes(srv.vault, A), toBytes(A_ORIGINAL), "untouched after an ambiguous multi-edit");
  }, 60000);

  test("creating the same path twice in one proposal is rejected", async () => {
    mock.script(
      reply.tool(
        toolArgs("create it twice", [
          { op: "create", path: "multi/new.md", content: "# one\n" },
          { op: "create", path: "multi/new.md", content: "# two\n" },
        ])
      )
    );
    const st = await turn(srv, { content: "create twice", docPath: A });
    expect(`a proposal was offered: ${!!st.done().proposal}`).toBe("a proposal was offered: false");
    expect(`the file was created anyway: ${existsSync(join(srv.vault, "multi/new.md"))}`).toBe(
      "the file was created anyway: false"
    );
  }, 60000);
});

describe("custody — a refused revert commit is recorded, not swallowed", () => {
  const P = "notes/blocked.md";
  const ORIGINAL = "# Blocked\n\nbase line\n";
  let bsrv: TestServer;
  let bmock: MockUpstream;
  let vault = "";

  beforeAll(async () => {
    vault = makeVault({ "inbox.md": "# Inbox\n\n", [P]: ORIGINAL, "m.md": "# M\n\nbase\n" });
    orphanVaults.push(vault);
    await gitOk(vault, "init", "-b", "main");
    await gitOk(vault, "config", "user.name", "z-notes test");
    await gitOk(vault, "config", "user.email", "test@z-notes.invalid");
    await gitOk(vault, "config", "commit.gpgsign", "false");
    await gitOk(vault, "add", ".");
    await gitOk(vault, "commit", "-m", "initial");
    /* a side branch that will conflict, so the repo can be parked mid-merge */
    await gitOk(vault, "checkout", "-b", "side");
    writeFileSync(join(vault, "m.md"), "# M\n\nside\n");
    await gitOk(vault, "commit", "-am", "side edit");
    await gitOk(vault, "checkout", "main");
    writeFileSync(join(vault, "m.md"), "# M\n\nmain\n");
    await gitOk(vault, "commit", "-am", "main edit");

    bmock = await newMock();
    bsrv = await newServer({ vault });
    await configure(bsrv, bmock);
  }, 60000);

  test("revert records WHY it could not commit, and keeps the accept commit's sha", async () => {
    bmock.reset();
    bmock.script(proposeEdits("edit n", { op: "replace", path: P, find: "base line", replace: "AI LINE" }));
    const p = (await turn(bsrv, { content: "edit it", docPath: P })).done().proposal;
    expect(p).toBeTruthy();

    const acc = await accept(bsrv, p.id);
    expect(`accept → ${acc.status}`).toBe("accept → 200");
    const accepted = acc.body.proposal;
    expect(`accept recorded a commit: ${/^[0-9a-f]{40}$/.test(String(accepted.commit))}`).toBe(
      "accept recorded a commit: true"
    );

    /* now park the vault mid-merge — commitPaths RETURNS {committed:false,
       reason}, it does not throw, so a caller that ignores the return value
       cannot tell the difference between "committed" and "refused" */
    const merge = await git(vault, "merge", "side");
    expect(`the merge conflicted: ${merge.code !== 0}`).toBe("the merge conflicted: true");

    const before = await commitCount(vault);
    const rev = await revert(bsrv, p.id);
    expect(`revert → ${rev.status}`).toBe("revert → 200");
    await sleep(400);
    expect(`commits added while blocked: ${(await commitCount(vault)) - before}`).toBe(
      "commits added while blocked: 0"
    );

    /* the bytes ARE restored — this is about the record, not the disk */
    expectBytes(readVaultBytes(vault, P), toBytes(ORIGINAL), "revert restoration while blocked");

    const reverted = rev.body.proposal;
    expect(`the refusal was recorded: ${!!reverted.commitNote}`).toBe("the refusal was recorded: true");
    expect(`the reason names the merge: ${/merge/i.test(String(reverted.commitNote))}`).toBe(
      "the reason names the merge: true"
    );
    /* the pointer to the commit the user would `git revert` by hand survives */
    expect(`the accept commit is still reachable: ${reverted.commit === accepted.commit}`).toBe(
      "the accept commit is still reachable: true"
    );

    await git(vault, "merge", "--abort");
  }, 90000);
});

describe("events — reverting an op:create attributes the removal to the proposal", () => {
  test("doc-changed carries reason:proposal-reverted, not external", async () => {
    const CREATED = "made/by-ai.md";
    mock.reset();
    mock.script(proposeEdits("make a doc", { op: "create", path: CREATED, content: "# Made\n\nby ai\n" }));
    const p = (await turn(srv, { content: "make me a doc", docPath: "inbox.md" })).done().proposal;
    expect(p).toBeTruthy();

    const sse = await srv.sse();
    try {
      const m0 = sse.mark();
      expect((await accept(srv, p.id)).status).toBe(200);
      const created = await sse.waitFor("doc-changed", { from: m0, match: (d) => d.path === CREATED });
      expect(`accept reason: ${created.data.reason}`).toBe("accept reason: proposal-accepted");

      const m1 = sse.mark();
      expect((await revert(srv, p.id)).status).toBe(200);
      const removed = await sse.waitFor("doc-changed", { from: m1, match: (d) => d.path === CREATED });
      /* API.md: revert "Emits doc-changed (reason proposal-reverted)" and a
         create-revert "removes the document it created (that path then reports
         removed:true)" — the two are meant to co-occur. Hardcoding "external"
         made the client toast "<path> was deleted on disk" one click after the
         user pressed Revert. */
      expect(`revert removed the doc: ${removed.data.removed}`).toBe("revert removed the doc: true");
      expect(`revert reason: ${removed.data.reason}`).toBe("revert reason: proposal-reverted");
    } finally {
      sse.close();
    }
  }, 60000);
});

/* ============================================================
   Endpoint status — the statusbar's only source of truth.

   Everything here is a REGRESSION of behaviour measured against the live
   CLIProxyAPI gateway the app ships pointed at (http://127.0.0.1:8317/v1,
   gpt-5.6-sol). The two findings these pin:

     1. the capability probe ran ONLY when PUT /api/settings changed the base
        URL, model or key — so a vault set up the intended way (a hand-written
        settings.toml whose credential settings.load() absorbs at boot) NEVER
        probed, and `meta.ai.probe` stayed null on a perfectly working endpoint;
     2. nothing recorded whether a REAL turn reached the endpoint, so a status
        item had nothing honest to render between probes.
   ============================================================ */

describe("endpoint status — probed at boot, and truthful between probes", () => {
  test("a vault configured only through settings.toml is probed at boot", async () => {
    const m = await newMock();
    const vault = makeVault({ "inbox.md": "# Inbox\n\n" });
    orphanVaults.push(vault);
    /* the documented initial-setup path: a hand-edited settings.toml carrying
       the raw credential, which settings.ts absorbs into sqlite at load() */
    mkdirSync(join(vault, ".znotes"), { recursive: true });
    writeFileSync(
      join(vault, ".znotes", "settings.toml"),
      `[ai]\nbaseUrl = ${JSON.stringify(m.baseUrl)}\nmodel = "gpt-5.6-sol"\neffort = "high"\napiKey = ${JSON.stringify(KEY)}\n`,
      { encoding: "utf8", flag: "w" }
    );

    const mark = m.mark();
    const s = await newServer({ vault });
    await m.waitForRequests(mark + 1, 10000);

    /* the credential really was absorbed, not left in the committed file */
    expect(`the key stayed in settings.toml: ${readVaultText(vault, ".znotes/settings.toml").includes(KEY)}`).toBe(
      "the key stayed in settings.toml: false"
    );

    const probed = m.since(mark);
    expect(`boot probed /responses: ${probed.some((r) => r.path === "/responses" && !r.stream)}`).toBe(
      "boot probed /responses: true"
    );
    for (const r of probed) expect(r.authorization).toBe("Bearer " + KEY);

    await waitUntil(
      async () => !!(await s.get("/api/settings")).body.meta.ai.probe,
      { timeout: 10000, interval: 100, label: "meta.ai.probe to be recorded at boot" }
    );
    const meta = (await s.get("/api/settings")).body.meta.ai;
    expect(meta.probe.responses).toBe(true);
    expect(meta.probe.toolsWithReasoning).toBe(true);
    expect(`status after a boot probe: ${meta.status.state}`).toBe("status after a boot probe: ok");
    expect(`model reported: ${meta.status.model} · ${meta.status.effort}`).toBe("model reported: gpt-5.6-sol · high");
    expect(`no rung fired on a healthy endpoint: ${JSON.stringify(meta.degraded)}`).toBe(
      "no rung fired on a healthy endpoint: []"
    );
  }, 60000);

  test("GET /api/ai/status is free; POST re-probes on demand", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    await configure(s, m);

    const mark = m.mark();
    const g = await s.get("/api/ai/status");
    expect(g.status).toBe(200);
    expect(`GET made no upstream request: ${m.since(mark).length}`).toBe("GET made no upstream request: 0");
    expect(`GET state: ${g.body.status.state}`).toBe("GET state: ok");

    const p = await s.api("POST", "/api/ai/status", {});
    expect(p.status).toBe(200);
    const after = m.since(mark);
    expect(`POST re-probed: ${after.some((r) => r.path === "/responses" && !r.stream)}`).toBe("POST re-probed: true");
    expect(`POST answered a fresh verdict: ${p.body.status.state}`).toBe("POST answered a fresh verdict: ok");
  }, 60000);

  test("a real turn that fails flips the status to unreachable, and a good one flips it back", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    expect((await s.get("/api/ai/status")).body.status.state).toBe("ok");

    /* an endpoint that answers 500 on the real turn — NOT a parameter refusal,
       so the ladder must stay put and only the status may change */
    m.reset();
    m.setDefault(reply.http(500, { error: { message: "boom" } }));
    const bad = await turn(s, { content: "will fail", docPath: "inbox.md" });
    expect(`the turn reported an error: ${bad.errors().length > 0}`).toBe("the turn reported an error: true");

    const down = (await s.get("/api/ai/status")).body.status;
    expect(`state after a failed turn: ${down.state}`).toBe("state after a failed turn: unreachable");
    expect(`the failure is attributed to a call: ${down.source}`).toBe("the failure is attributed to a call: call");
    expect(`no rung fired on a 500: ${JSON.stringify((await s.get("/api/settings")).body.meta.ai.degraded)}`).toBe(
      "no rung fired on a 500: []"
    );

    m.reset();
    m.setDefault(reply.text("back"));
    const good = await turn(s, { content: "will work", docPath: "inbox.md" });
    expect(good.text()).toBe("back");
    const up = (await s.get("/api/ai/status")).body.status;
    expect(`state after a good turn: ${up.state}`).toBe("state after a good turn: ok");
  }, 90000);

  test("status is pushed on /events, never polled", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhi\n" } });
    await configure(s, m);
    const sse = await s.sse();
    try {
      const mark = sse.mark();
      m.reset();
      m.setDefault(reply.http(503, { error: { message: "nope" } }));
      await turn(s, { content: "fail me", docPath: "inbox.md" });
      const ev = await sse.waitFor("ai-status", { from: mark });
      expect(`pushed state: ${ev.data.state}`).toBe("pushed state: unreachable");
      expect(`pushed model: ${ev.data.model}`).toBe("pushed model: gpt-5.6-sol");
    } finally {
      sse.close();
    }
  }, 90000);

  test("an unconfigured endpoint says so instead of showing green", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    const st = (await s.get("/api/ai/status")).body.status;
    expect(`state with no key: ${st.state}`).toBe("state with no key: unconfigured");
    expect(`configured flag: ${st.configured}`).toBe("configured flag: false");
  }, 30000);

  test("a probe recorded against a DIFFERENT base URL is not evidence about this one", async () => {
    const a = await newMock();
    const b = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    await configure(s, a);
    expect((await s.get("/api/ai/status")).body.status.state).toBe("ok");

    /* b is stopped before the probe can reach it: the old probe record still
       names `a`, and must not be read as a verdict about `b` */
    await b.stop();
    await s.api("PUT", "/api/settings", { ai: { baseUrl: b.baseUrl } });
    await waitUntil(
      async () => (await s.get("/api/ai/status")).body.status.state !== "ok",
      { timeout: 12000, interval: 100, label: "the status to stop claiming the old endpoint's verdict" }
    );
    const st = (await s.get("/api/ai/status")).body.status;
    expect(`state pointed at a dead endpoint: ${st.state}`).toBe("state pointed at a dead endpoint: unreachable");
  }, 60000);

  test("a rung that fires shows up as degraded, not as ok", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await configure(s, m);

    m.reset();
    m.rejectParam("reasoning.summary");
    m.script(reply.text("stripped and answered"));
    const t = await turn(s, { content: "go", docPath: "inbox.md" });
    expect(t.text()).toBe("stripped and answered");

    const st = (await s.get("/api/ai/status")).body.status;
    expect(`state after one rung: ${st.state}`).toBe("state after one rung: degraded");
    expect(`the rung is named: ${st.downgrades.map((d: any) => d.id).join(",")}`).toBe(
      "the rung is named: reasoning.summary"
    );
  }, 90000);

  test("an endpoint that dies MID-STREAM flips the chip, and says so in words the user can read", async () => {
    /* REGRESSION. The success was recorded as soon as the response HEADERS
       arrived, and the only failure recorded afterwards was `err instanceof
       AiError`. A transport death while the body is streaming — proxy restart,
       connection reset, tailnet drop, or the UPSTREAM_TIMEOUT_MS half of the
       AbortSignal.any — throws a plain Error/DOMException, so nothing was
       recorded and `status()` kept deriving `ok` from that stale success. The
       chat bubble said the socket closed unexpectedly while the statusbar chip
       stayed green; only sending a SECOND message corrected it. And the raw
       message ("…pass `verbose: true` in the second argument to fetch()") went
       verbatim into the toast, into the persisted transcript, and from there
       back upstream as history. */
    const dead = await startDyingUpstream();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    try {
      await s.api("PUT", "/api/settings", {
        ai: { baseUrl: dead.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high" },
        git: { autoSyncSeconds: 600 },
      });
      await sleep(400);
      expect(`state before the turn: ${(await s.get("/api/ai/status")).body.status.state}`).toBe(
        "state before the turn: ok"
      );

      const t = await turn(s, { content: "die on me", docPath: "inbox.md" });
      expect(`the turn reported an error: ${t.errors().length > 0}`).toBe("the turn reported an error: true");

      /* the whole point: the chip is right NOW, not after the next message */
      const st = (await s.get("/api/ai/status")).body.status;
      expect(`state right after the stream died: ${st.state}`).toBe("state right after the stream died: unreachable");
      expect(`attributed to the call: ${st.source}`).toBe("attributed to the call: call");

      /* …and nothing of the runtime's own internals reached the durable
         transcript, which is replayed upstream as history on the next turn */
      const sess = (await s.get("/api/ai/sessions/current")).body;
      const persisted = JSON.stringify(sess.messages);
      expect(`no fetch() advice leaked into the transcript: ${!/verbose: true/.test(persisted)}`).toBe(
        "no fetch() advice leaked into the transcript: true"
      );
      expect(`the user is told what happened: ${/closed mid-response/.test(persisted)}`).toBe(
        "the user is told what happened: true"
      );
    } finally {
      dead.stop();
    }
  }, 90000);
});

/* ============================================================
   Protocol — the shapes the LIVE gateway actually emits.

   Measured against CLIProxyAPI/gpt-5.6-sol and modelled by
   mock-upstream's `realGateway` option: reasoning items carrying
   `content: []` AND `encrypted_content`, `reasoning_summary_part.added/.done`
   bracketing the summary deltas, and the reasoning item re-listed on
   `response.completed` ahead of the function_call.
   ============================================================ */

describe("protocol — the live gateway's reasoning-item shape", () => {
  test("summary parts stream, the item is replayed on retry, and it is not counted twice", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "notes/g.md": "# G\n\nreal line here\n" } });
    await configure(s, m);

    const BLOB = "gAAAAAB-LIVEGATEWAYBLOB-0123456789";
    const SUMMARY = "**Planning insertion after checklist item**";
    m.reset();
    m.script(
      reply.tool(toolArgs("miss", [{ op: "replace", path: "notes/g.md", find: "NOSUCHANCHOR", replace: "x" }]), {
        realGateway: true,
        reasoning: SUMMARY,
        encryptedReasoning: BLOB,
      }),
      reply.tool(toolArgs("hit", [{ op: "replace", path: "notes/g.md", find: "real line here", replace: "REPLACED" }]), {
        realGateway: true,
        reasoning: SUMMARY,
        encryptedReasoning: BLOB,
      })
    );

    const st = await turn(s, { content: "edit it", docPath: "notes/g.md" });
    expect(`a proposal was reached: ${!!st.done().proposal}`).toBe("a proposal was reached: true");

    /* the summary reached the browser exactly once per attempt — the part
       events must not double it */
    expect(`reasoning delivered: ${st.reasoning()}`).toBe(`reasoning delivered: ${SUMMARY + SUMMARY}`);

    const streamed = m.streamed();
    expect(`upstream attempts: ${streamed.length}`).toBe("upstream attempts: 2");
    const input: any[] = streamed[1].body.input ?? [];
    const kinds = input.map((i) => i?.type ?? "role:" + i?.role);
    expect(`the retry replayed the reasoning item ONCE: ${kinds.filter((k) => k === "reasoning").length}`).toBe(
      "the retry replayed the reasoning item ONCE: 1"
    );
    expect(`its encrypted_content survived: ${JSON.stringify(streamed[1].body).includes(BLOB)}`).toBe(
      "its encrypted_content survived: true"
    );
    expect(`reasoning precedes the function_call: ${kinds.indexOf("reasoning") < kinds.indexOf("function_call")}`).toBe(
      "reasoning precedes the function_call: true"
    );
  }, 90000);

  test("a gateway that reports cache_write_tokens does not disturb the usage event", async () => {
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhi\n" } });
    await configure(s, m);
    m.reset();
    m.script(reply.text("counted", { usage: { input: 1555, output: 51, reasoning: 24, cached: 0 } }));
    const t = await turn(s, { content: "count me", docPath: "inbox.md" });
    expect(JSON.stringify(t.usage())).toBe(JSON.stringify({ input: 1555, output: 51, reasoning: 24, cached: 0 }));
  }, 60000);
});
