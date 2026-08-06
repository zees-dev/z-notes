/* ============================================================
   mock-upstream.ts — a scriptable stand-in for the OpenAI-compatible
   endpoint the AI relay talks to (research/ai-protocol.md §2, §3).

   It is deliberately dumb: it never reasons about what the relay sent, it
   RECORDS every request verbatim and REPLAYS whatever the test scripted. That
   split is what makes the phase-4 gates falsifiable —

     - the recorded requests are the only place "the key reached upstream",
       "the armor never did" and "the ladder stripped exactly one param" can be
       observed;
     - the scripted replies are the only place a `propose_edits` tool call, a
       mid-stream `error`, a `response.incomplete` or a 400 on an unrecognised
       argument can be made to happen on demand.

   Wire shapes it speaks (all of them real Responses-API/Chat-Completions
   shapes, so a relay written against the docs works against this unchanged):

     POST /responses          stream:true  → typed SSE event sequence
     POST /responses          stream:false → one JSON body (the capability probe)
     POST /chat/completions   stream:true  → `data: {...}` chunks + `data: [DONE]`
     GET  /models             → { data: [ … ] }

   A leading `/v1` is stripped, because settings.ai.baseUrl already ends in
   `/v1` (fixed decision) and the relay appends `/responses` to it.

   This file also carries `AiStream`, the POST-SSE client the phase-4 tests read
   `/api/ai/messages` with. It lives here rather than in helpers.ts because
   helpers.ts is phase-1 property and every consumer of this client is a
   phase-4 file that already imports the mock.
   ============================================================ */

import type { Server } from "bun";
import { parseSseFrame } from "../server/sse";
import { sleep, type TestServer } from "./helpers";

/* ------------------------------------------------------------------
   recording
   ------------------------------------------------------------------ */

export interface RecordedRequest {
  n: number;
  method: string;
  /** path with a leading `/v1` stripped: `/responses`, `/models`, … */
  path: string;
  rawPath: string;
  headers: Record<string, string>;
  authorization: string | null;
  /** the request body exactly as it arrived, before any parsing */
  bodyText: string;
  body: any;
  /** every string VALUE anywhere in the body, joined by \n (JSON-unescaped) */
  strings: string;
  stream: boolean;
  at: number;
  /** true once the relay hung up on us mid-stream (client abort) */
  cancelled: boolean;
  /** true once we finished writing the scripted reply */
  finished: boolean;
  status: number;
  replyKind: string | null;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const k of Object.keys(v as object)) collectStrings((v as any)[k], out);
}

/** does `body` carry this dotted key at all (even set to null)? */
function hasPath(body: any, path: string): boolean {
  const parts = path.split(".");
  let cur = body;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return false;
    if (!(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

/* ------------------------------------------------------------------
   scripted replies
   ------------------------------------------------------------------ */

export interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  cached?: number;
}

export type Reply =
  /** assistant prose; `chunkSize`/`dripMs` control how it is cut into deltas */
  | {
      kind: "text";
      text: string;
      reasoning?: string;
      chunkSize?: number;
      dripMs?: number;
      usage?: Usage;
      /** emit the output_text deltas with scrambled arrival order (sequence_number stays truthful) */
      outOfOrder?: boolean;
      /** field-fidelity variance a translating gateway can introduce in the
          item IDENTITY carried by the three different `.done` payloads:
          - "drop-item-id": `response.output_text.done` has no `item_id`
          - "renumber": the terminal `response.completed` re-lists the message
            under a regenerated id
          - "terminal-only": no `.done` frames at all — the run carries its
            output solely on `response.completed` */
      idDrift?: "drop-item-id" | "renumber" | "terminal-only";
    }
  /** a `propose_edits` function call; `args` is stringified for the wire */
  | {
      kind: "tool";
      args: unknown;
      name?: string;
      text?: string;
      chunkSize?: number;
      dripMs?: number;
      usage?: Usage;
      /** emit a `reasoning` output item carrying this `encrypted_content`
          before the function_call — what a real store:false run does, and what
          the stateless recipe (research §2.2) says must be replayed on retry */
      encryptedReasoning?: string;
      /** MEASURED against the live the AI gateway gateway (gpt-5): a real
          reasoning turn also emits `response.reasoning_summary_part.added/.done`
          around the summary deltas, carries `content: []` on the reasoning item,
          and puts `obfuscation` on every `output_text.delta`. None of it is in
          the docs' event list, and a relay that switch-cased on the full set
          would have broken on the real thing. Opt-in so the plain shapes stay
          readable, and pinned by a test. */
      realGateway?: boolean;
      /** reasoning summary text, streamed before the tool call (real runs do) */
      reasoning?: string;
    }
  /** an `error` event in the middle of an otherwise normal stream */
  | { kind: "error"; message: string; code?: string; beforeText?: string; dripMs?: number }
  /** response.incomplete (hit max_output_tokens mid-answer) */
  | { kind: "incomplete"; text?: string; reason?: string }
  /** response.failed */
  | { kind: "failed"; message?: string }
  /** a plain HTTP failure — no SSE at all */
  | { kind: "http"; status: number; body: unknown }
  /** the canonical `400 Unrecognized request argument supplied: <param>` */
  | { kind: "unrecognized"; param: string; message?: string };

export const reply = {
  text(text: string, opts: Partial<Extract<Reply, { kind: "text" }>> = {}): Reply {
    return { kind: "text", text, ...opts };
  },
  tool(args: unknown, opts: Partial<Extract<Reply, { kind: "tool" }>> = {}): Reply {
    return { kind: "tool", args, ...opts };
  },
  error(message: string, opts: Partial<Extract<Reply, { kind: "error" }>> = {}): Reply {
    return { kind: "error", message, ...opts };
  },
  incomplete(opts: Partial<Extract<Reply, { kind: "incomplete" }>> = {}): Reply {
    return { kind: "incomplete", ...opts };
  },
  failed(message = "upstream exploded"): Reply {
    return { kind: "failed", message };
  },
  http(status: number, body: unknown): Reply {
    return { kind: "http", status, body };
  },
  unrecognized(param: string, message?: string): Reply {
    return { kind: "unrecognized", param, message };
  },
};

/* ---- propose_edits argument builders (research §4.4, ops per SPEC §8) ---- */

export type EditOp = "replace" | "insert_after" | "create" | "rewrite";

export interface EditSpec {
  op: EditOp;
  path: string;
  find?: string | null;
  replace?: string | null;
  content?: string | null;
  note?: string | null;
}

/** fills every strict-schema key, exactly like a real structured-output call */
export function edit(e: EditSpec): Required<EditSpec> {
  return {
    op: e.op,
    path: e.path,
    find: e.find ?? null,
    replace: e.replace ?? null,
    content: e.content ?? null,
    note: e.note ?? null,
  };
}

export function toolArgs(summary: string, edits: EditSpec[]): { summary: string; edits: Required<EditSpec>[] } {
  return { summary, edits: edits.map(edit) };
}

/** one-liner for the common case: a single edit proposal */
export function proposeEdits(summary: string, e: EditSpec): Reply {
  return reply.tool(toolArgs(summary, [e]));
}

/* ------------------------------------------------------------------
   standing rules (the degradation-ladder lever)
   ------------------------------------------------------------------ */

export interface RejectRule {
  /** dotted body key whose mere presence triggers the 400 */
  param: string;
  status?: number;
  message?: string;
  /** only reject the first N matching requests (default: forever) */
  times?: number;
  hits?: number;
}

/* ------------------------------------------------------------------
   the server
   ------------------------------------------------------------------ */

export interface MockUpstream {
  port: number;
  /** what settings.ai.baseUrl must be set to — already ends in /v1 */
  baseUrl: string;
  requests: RecordedRequest[];

  /** queue replies, consumed in order by streaming /responses + /chat/completions */
  script(...replies: Reply[]): void;
  /** reply used when the queue is empty */
  setDefault(r: Reply): void;
  /** every POST /responses answers this status (404 ⇒ the chat-completions rung) */
  setResponsesStatus(status: number | null): void;
  /** 400 on any request carrying this dotted key, until removed */
  rejectParam(param: string, opts?: Omit<RejectRule, "param">): void;
  /**
   * 400 on any request whose `reasoning.effort` is one of these VALUES — a
   * gateway that supports the parameter but caps the scale (research §2.3:
   * the AI gateway advertises only none|low|medium|high). Distinct from
   * rejectParam, which fires on the key's mere presence.
   */
  rejectEffort(values: string[]): void;
  clearRules(): void;

  /** forget every recorded request, queued reply and standing rule */
  reset(): void;
  mark(): number;
  since(n: number): RecordedRequest[];
  /** requests that asked for a stream (i.e. real chat turns, never the probe) */
  streamed(from?: number): RecordedRequest[];
  probes(from?: number): RecordedRequest[];
  chatCompletions(from?: number): RecordedRequest[];

  /** substring search across BOTH leak surfaces: the raw request bodies and
      every string value in them, JSON-unescaped */
  sawText(needle: string): boolean;

  waitForRequests(n: number, timeout?: number): Promise<RecordedRequest[]>;
  stop(): Promise<void>;
}

export async function startMockUpstream(): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  let queue: Reply[] = [];
  let fallback: Reply = reply.text("ok");
  let responsesStatus: number | null = null;
  let rules: RejectRule[] = [];
  let rejectedEfforts: string[] = [];
  let n = 0;

  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const unrecognizedBody = (param: string, message?: string) => ({
    error: {
      message: message ?? `Unrecognized request argument supplied: ${param}`,
      type: "invalid_request_error",
      param,
      code: "unknown_parameter",
    },
  });

  const server: Server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const rawPath = url.pathname;
      const path = rawPath.replace(/^\/v1(?=\/|$)/, "") || "/";
      const bodyText = req.method === "POST" ? await req.text() : "";
      let body: any = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
      }
      const strs: string[] = [];
      collectStrings(body, strs);

      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

      const rec: RecordedRequest = {
        n: ++n,
        method: req.method,
        path,
        rawPath,
        headers,
        authorization: req.headers.get("authorization"),
        bodyText,
        body,
        strings: strs.join("\n"),
        stream: body?.stream === true,
        at: Date.now(),
        cancelled: false,
        finished: false,
        status: 0,
        replyKind: null,
      };
      requests.push(rec);

      /* ---- GET /models — capability probe step 1 ---- */
      if (path === "/models" && req.method === "GET") {
        rec.status = 200;
        rec.finished = true;
        return jsonRes(200, {
          object: "list",
          data: [
            { id: "gpt-5", object: "model", owned_by: "openai" },
            { id: "gpt-5-terra", object: "model", owned_by: "openai" },
            { id: "gpt-5-luna", object: "model", owned_by: "openai" },
          ],
        });
      }

      /* ---- standing 400 rules (checked BEFORE the queue, so a rejected
             request never burns a scripted reply) ---- */
      for (const rule of rules) {
        if (!hasPath(body, rule.param)) continue;
        if (rule.times != null && (rule.hits ?? 0) >= rule.times) continue;
        rule.hits = (rule.hits ?? 0) + 1;
        rec.status = rule.status ?? 400;
        rec.replyKind = "rule:" + rule.param;
        rec.finished = true;
        return jsonRes(rec.status, unrecognizedBody(rule.param, rule.message));
      }

      /* ---- a capped effort scale: the parameter is supported, this VALUE is not ---- */
      if (rejectedEfforts.length) {
        const eff = body?.reasoning?.effort ?? body?.reasoning_effort;
        if (typeof eff === "string" && rejectedEfforts.includes(eff)) {
          rec.status = 400;
          rec.replyKind = "rule:effort=" + eff;
          rec.finished = true;
          return jsonRes(400, unrecognizedBody("reasoning.effort", `Unsupported value: 'reasoning.effort' does not support '${eff}'.`));
        }
      }

      if (path === "/responses" && responsesStatus != null) {
        rec.status = responsesStatus;
        rec.replyKind = "responses-disabled";
        rec.finished = true;
        return jsonRes(responsesStatus, {
          error: { message: "Unknown endpoint /v1/responses", type: "invalid_request_error", code: "not_found" },
        });
      }

      if (path !== "/responses" && path !== "/chat/completions") {
        rec.status = 404;
        rec.finished = true;
        return jsonRes(404, { error: { message: `no mock route for ${req.method} ${rawPath}` } });
      }

      /* ---- the non-streaming capability probe ---- */
      if (!rec.stream) {
        rec.status = 200;
        rec.replyKind = "probe";
        rec.finished = true;
        return jsonRes(200, {
          id: "resp_probe",
          object: "response",
          status: "completed",
          model: body?.model ?? "gpt-5",
          output: [
            {
              id: "msg_probe",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "pong", annotations: [] }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        });
      }

      const r = queue.length ? queue.shift()! : fallback;
      return emit(rec, r, path);
    },
  });

  /* ------------------------------------------------------------------
     reply emission
     ------------------------------------------------------------------ */

  function emit(rec: RecordedRequest, r: Reply, path: string): Response {
    rec.replyKind = r.kind;

    if (r.kind === "http") {
      rec.status = r.status;
      rec.finished = true;
      return jsonRes(r.status, r.body);
    }
    if (r.kind === "unrecognized") {
      rec.status = 400;
      rec.finished = true;
      return jsonRes(400, unrecognizedBody(r.param, r.message));
    }

    if (!rec.stream) {
      /* a scripted probe reply that is not an HTTP failure: answer JSON */
      rec.status = 200;
      rec.finished = true;
      const text = r.kind === "text" ? r.text : "pong";
      return jsonRes(200, {
        id: "resp_probe",
        object: "response",
        status: "completed",
        output: [{ id: "msg_probe", type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      });
    }

    rec.status = 200;
    const chat = path === "/chat/completions";
    const enc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let live = true;
        const send = (chunk: string) => {
          if (!live || rec.cancelled) return false;
          try {
            controller.enqueue(enc.encode(chunk));
            return true;
          } catch {
            live = false;
            return false;
          }
        };
        try {
          await (chat ? writeChat(r, send, rec) : writeResponses(r, send, rec));
        } catch {
          /* the relay hung up mid-write; `cancel` already recorded it */
        }
        rec.finished = !rec.cancelled;
        try {
          if (live && !rec.cancelled) controller.close();
        } catch {}
      },
      cancel() {
        rec.cancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  type Send = (chunk: string) => boolean;

  /* ---- Responses API typed events (research §3.2) ---- */
  async function writeResponses(r: Reply, send: Send, rec: RecordedRequest) {
    let seq = 0;
    const ev = (type: string, data: Record<string, unknown>) =>
      send(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);

    const respId = "resp_" + rec.n;
    ev("response.created", { response: { id: respId, object: "response", status: "in_progress" } });
    ev("response.in_progress", { response: { id: respId, object: "response", status: "in_progress" } });

    /* `cache_write_tokens` is MEASURED from the live the AI gateway gateway, which
       reports it alongside `cached_tokens`. The relay must keep reading only the
       two keys it knows and pass the rest by. */
    const usageOf = (u?: Usage) => ({
      input_tokens: u?.input ?? 128,
      output_tokens: u?.output ?? 32,
      total_tokens: (u?.input ?? 128) + (u?.output ?? 32),
      input_tokens_details: { cached_tokens: u?.cached ?? 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: u?.reasoning ?? 0 },
    });

    const drip = async (ms?: number) => {
      if (ms && ms > 0) await sleep(ms);
    };

    /* reasoning summary first, exactly like the real thing */
    const reasoningText = r.kind === "text" ? r.reasoning : undefined;
    if (reasoningText) {
      const rid = "rs_" + rec.n;
      ev("response.output_item.added", {
        output_index: 0,
        item: { id: rid, type: "reasoning", summary: [] },
      });
      for (const piece of chunk(reasoningText, 24)) {
        if (rec.cancelled) return;
        ev("response.reasoning_summary_text.delta", { item_id: rid, output_index: 0, summary_index: 0, delta: piece });
      }
      ev("response.reasoning_summary_text.done", { item_id: rid, output_index: 0, summary_index: 0, text: reasoningText });
      ev("response.output_item.done", {
        output_index: 0,
        item: { id: rid, type: "reasoning", summary: [{ type: "summary_text", text: reasoningText }] },
      });
    }

    if (r.kind === "text" || r.kind === "incomplete" || r.kind === "error" || r.kind === "failed") {
      const text =
        r.kind === "text" ? r.text : r.kind === "incomplete" ? (r.text ?? "half an ans") : (r as any).beforeText ?? "";
      const mid = "msg_" + rec.n;
      if (text) {
        ev("response.output_item.added", {
          output_index: 1,
          item: { id: mid, type: "message", role: "assistant", status: "in_progress", content: [] },
        });
        ev("response.content_part.added", {
          item_id: mid,
          output_index: 1,
          content_index: 0,
          part: { type: "output_text", text: "" },
        });
        const size = (r as any).chunkSize ?? 16;
        const pieces = chunk(text, size);
        const order = r.kind === "text" && r.outOfOrder ? scramble(pieces.length) : pieces.map((_, i) => i);
        /* sequence_number is truthful; the ARRIVAL order is not. Stamp by PIECE
           index BEFORE scrambling — stamping `seq++` inside the scrambled loop
           made the numbers monotonic on the wire, so ordered()'s reorder buffer
           was never entered and the test named for it proved nothing (it only
           read the `.done` payload, which is order-independent by construction).
           With this, the deltas the client sees really do arrive transposed. */
        const base = seq;
        const stamped = pieces.map((_, i) => base + i);
        seq += pieces.length;
        for (const i of order) {
          if (rec.cancelled) return;
          await drip((r as any).dripMs);
          send(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              sequence_number: stamped[i],
              item_id: mid,
              output_index: 1,
              content_index: 0,
              delta: pieces[i],
              _piece: i,
            })}\n\n`
          );
        }
        if (r.kind === "error") {
          ev("error", { code: (r as any).code ?? "server_error", message: (r as any).message, param: null });
          return;
        }
        const drift = r.kind === "text" ? r.idDrift : undefined;
        if (drift !== "terminal-only") {
          ev("response.output_text.done", {
            // a gateway that loses `item_id` in translation
            ...(drift === "drop-item-id" ? {} : { item_id: mid }),
            output_index: 1,
            content_index: 0,
            text,
          });
          ev("response.content_part.done", {
            item_id: mid,
            output_index: 1,
            content_index: 0,
            part: { type: "output_text", text },
          });
          ev("response.output_item.done", {
            output_index: 1,
            item: {
              id: mid,
              type: "message",
              role: "assistant",
              status: r.kind === "incomplete" ? "incomplete" : "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          });
        }
      } else if (r.kind === "error") {
        ev("error", { code: (r as any).code ?? "server_error", message: (r as any).message, param: null });
        return;
      }

      if (r.kind === "incomplete") {
        ev("response.incomplete", {
          response: {
            id: respId,
            status: "incomplete",
            incomplete_details: { reason: r.reason ?? "max_output_tokens" },
            output: [],
            usage: usageOf(),
          },
        });
        return;
      }
      if (r.kind === "failed") {
        ev("response.failed", {
          response: {
            id: respId,
            status: "failed",
            error: { code: "server_error", message: r.message ?? "upstream exploded" },
            output: [],
          },
        });
        return;
      }

      ev("response.completed", {
        response: {
          id: respId,
          object: "response",
          status: "completed",
          output: [
            {
              // a gateway that regenerates the id on the terminal re-list
              id: (r as any).idDrift === "renumber" ? "message_" + rec.n : mid,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: usageOf((r as any).usage),
        },
      });
      return;
    }

    /* ---- function call ---- */
    if (r.kind === "tool") {
      const argsText = typeof r.args === "string" ? r.args : JSON.stringify(r.args);
      const fid = "fc_" + rec.n;
      const callId = "call_" + rec.n;
      const rid = "rs_" + rec.n;

      if (r.encryptedReasoning || r.realGateway || r.reasoning) {
        const summaryText = r.reasoning ?? (r.realGateway ? "**Planning the edit**" : "");
        const item = () => ({
          id: rid,
          type: "reasoning",
          // the live gateway sends `content: []` alongside `summary`
          ...(r.realGateway ? { content: [] } : {}),
          summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
          ...(r.encryptedReasoning ? { encrypted_content: r.encryptedReasoning } : {}),
        });
        ev("response.output_item.added", { output_index: 0, item: { ...item(), summary: [] } });
        if (summaryText) {
          // the real gateway brackets the summary deltas with part events
          if (r.realGateway)
            ev("response.reasoning_summary_part.added", {
              item_id: rid,
              output_index: 0,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            });
          for (const piece of chunk(summaryText, 24)) {
            if (rec.cancelled) return;
            ev("response.reasoning_summary_text.delta", { item_id: rid, output_index: 0, summary_index: 0, delta: piece });
          }
          ev("response.reasoning_summary_text.done", { item_id: rid, output_index: 0, summary_index: 0, text: summaryText });
          if (r.realGateway)
            ev("response.reasoning_summary_part.done", {
              item_id: rid,
              output_index: 0,
              summary_index: 0,
              part: { type: "summary_text", text: summaryText },
            });
        }
        ev("response.output_item.done", { output_index: 0, item: item() });
      }

      if (r.text) {
        const mid = "msg_" + rec.n;
        ev("response.output_item.added", {
          output_index: 1,
          item: { id: mid, type: "message", role: "assistant", status: "in_progress", content: [] },
        });
        for (const piece of chunk(r.text, r.chunkSize ?? 16)) {
          if (rec.cancelled) return;
          await drip(r.dripMs);
          ev("response.output_text.delta", { item_id: mid, output_index: 1, content_index: 0, delta: piece });
        }
        ev("response.output_text.done", { item_id: mid, output_index: 1, content_index: 0, text: r.text });
        ev("response.output_item.done", {
          output_index: 1,
          item: {
            id: mid,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: r.text, annotations: [] }],
          },
        });
      }

      ev("response.output_item.added", {
        output_index: 2,
        item: { id: fid, type: "function_call", name: r.name ?? "propose_edits", call_id: callId, arguments: "" },
      });
      for (const piece of chunk(argsText, r.chunkSize ?? 24)) {
        if (rec.cancelled) return;
        await drip(r.dripMs);
        ev("response.function_call_arguments.delta", { item_id: fid, output_index: 2, delta: piece });
      }
      /* the `.done` string is the ground truth the relay JSON.parses */
      ev("response.function_call_arguments.done", { item_id: fid, output_index: 2, arguments: argsText });
      ev("response.output_item.done", {
        output_index: 2,
        item: {
          id: fid,
          type: "function_call",
          name: r.name ?? "propose_edits",
          call_id: callId,
          arguments: argsText,
          status: "completed",
        },
      });
      ev("response.completed", {
        response: {
          id: respId,
          object: "response",
          status: "completed",
          output: [
            /* MEASURED: the live gateway re-lists the reasoning item on the
               terminal event as well, ahead of the function_call. */
            ...(r.realGateway && (r.encryptedReasoning || r.reasoning)
              ? [
                  {
                    id: rid,
                    type: "reasoning",
                    content: [],
                    summary: r.reasoning ? [{ type: "summary_text", text: r.reasoning }] : [],
                    ...(r.encryptedReasoning ? { encrypted_content: r.encryptedReasoning } : {}),
                  },
                ]
              : []),
            {
              id: fid,
              type: "function_call",
              name: r.name ?? "propose_edits",
              call_id: callId,
              arguments: argsText,
            },
          ],
          usage: usageOf(r.usage),
        },
      });
    }
  }

  /* ---- Chat Completions chunks (the bottom rung of the ladder) ---- */
  async function writeChat(r: Reply, send: Send, rec: RecordedRequest) {
    const id = "chatcmpl_" + rec.n;
    const chunkOf = (delta: Record<string, unknown>, finish: string | null = null) =>
      send(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-5",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      );

    if (r.kind === "text") {
      chunkOf({ role: "assistant", content: "" });
      for (const piece of chunk(r.text, r.chunkSize ?? 16)) {
        if (rec.cancelled) return;
        if (r.dripMs) await sleep(r.dripMs);
        chunkOf({ content: piece });
      }
      chunkOf({}, "stop");
    } else if (r.kind === "tool") {
      const argsText = typeof r.args === "string" ? r.args : JSON.stringify(r.args);
      chunkOf({
        role: "assistant",
        tool_calls: [
          { index: 0, id: "call_" + rec.n, type: "function", function: { name: r.name ?? "propose_edits", arguments: "" } },
        ],
      });
      for (const piece of chunk(argsText, r.chunkSize ?? 24)) {
        if (rec.cancelled) return;
        chunkOf({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
      }
      chunkOf({}, "tool_calls");
    } else if (r.kind === "error") {
      send(`data: ${JSON.stringify({ error: { message: r.message, type: "server_error" } })}\n\n`);
      return;
    }
    send("data: [DONE]\n\n");
  }

  /* ------------------------------------------------------------------
     public surface
     ------------------------------------------------------------------ */

  const mock: MockUpstream = {
    port: server.port!,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,

    script: (...rs) => queue.push(...rs),
    setDefault: (r) => (fallback = r),
    setResponsesStatus: (s) => (responsesStatus = s),
    rejectParam: (param, opts = {}) => rules.push({ param, ...opts }),
    rejectEffort: (values) => (rejectedEfforts = [...values]),
    clearRules: () => {
      rules = [];
      rejectedEfforts = [];
    },

    reset() {
      requests.length = 0;
      queue = [];
      rules = [];
      rejectedEfforts = [];
      responsesStatus = null;
      fallback = reply.text("ok");
    },

    mark: () => requests.length,
    since: (from) => requests.slice(from),
    streamed: (from = 0) => requests.slice(from).filter((r) => r.stream && r.path === "/responses"),
    probes: (from = 0) => requests.slice(from).filter((r) => !r.stream && r.method === "POST"),
    chatCompletions: (from = 0) => requests.slice(from).filter((r) => r.path === "/chat/completions"),
    sawText: (needle) =>
      requests.some((r) => r.bodyText.includes(needle) || r.strings.includes(needle)),

    async waitForRequests(want, timeout = 5000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (requests.length >= want) return requests.slice();
        if (Date.now() >= deadline) {
          throw new Error(
            `mock upstream saw ${requests.length} request(s), expected ${want} within ${timeout}ms:\n` +
              requests.map((r) => `  ${r.method} ${r.path} stream=${r.stream}`).join("\n")
          );
        }
        await sleep(20);
      }
    },

    async stop() {
      await server.stop(true);
    },
  };

  return mock;
}

function chunk(s: string, size: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** a deterministic non-identity permutation (adjacent swaps) */
function scramble(len: number): number[] {
  const idx = [...Array(len).keys()];
  for (let i = 0; i + 1 < len; i += 2) {
    const t = idx[i];
    idx[i] = idx[i + 1];
    idx[i + 1] = t;
  }
  return idx;
}

/* ============================================================
   AiStream — POST + fetch + ReadableStream SSE reader.

   EventSource is GET-only (research §3.1), so both the real frontend and this
   test client parse SSE by hand. Kept live rather than buffered so a test can
   observe partial state and abort mid-stream.
   ============================================================ */

export interface SSEEvent {
  event: string;
  data: any;
  raw: string;
  at: number;
}

export class AiStream {
  status = 0;
  headers: Headers = new Headers();
  contentType = "";
  events: SSEEvent[] = [];
  raw = "";
  /** set when the server answered JSON instead of an event stream */
  json: any = null;
  closed = false;
  error: unknown = null;
  finished!: Promise<void>;

  private ctrl = new AbortController();
  private buf = "";

  static async open(
    srv: TestServer,
    body: { content: string; docPath?: string | null },
    opts: { path?: string } = {}
  ): Promise<AiStream> {
    const s = new AiStream();
    const res = await fetch(srv.url(opts.path ?? "/api/ai/messages"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: s.ctrl.signal,
    });
    s.status = res.status;
    s.headers = res.headers;
    s.contentType = res.headers.get("content-type") ?? "";
    if (!res.body) {
      s.closed = true;
      s.finished = Promise.resolve();
      return s;
    }
    if (!s.contentType.includes("text/event-stream")) {
      const text = await res.text();
      s.raw = text;
      try {
        s.json = JSON.parse(text);
      } catch {
        s.json = null;
      }
      s.closed = true;
      s.finished = Promise.resolve();
      return s;
    }
    s.finished = s.pump(res.body);
    return s;
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        this.raw += text;
        this.buf += text;
        this.drain();
      }
    } catch (e) {
      this.error = e;
    } finally {
      this.closed = true;
    }
  }

  private drain() {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) return;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = parseFrame(block);
      if (ev) this.events.push(ev);
    }
  }

  of(name: string): SSEEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  /** concatenated `{delta}` payloads for a normalized event kind */
  deltas(name: string): string {
    return this.of(name)
      .map((e) => (typeof e.data?.delta === "string" ? e.data.delta : ""))
      .join("");
  }

  text(): string {
    return this.deltas("text");
  }

  reasoning(): string {
    return this.deltas("reasoning");
  }

  toolArgs(): string {
    return this.deltas("tool_args");
  }

  done(): any | null {
    const e = this.of("done");
    return e.length ? e[e.length - 1].data : null;
  }

  proposalEvent(): any | null {
    const e = this.of("proposal");
    return e.length ? e[e.length - 1].data : null;
  }

  errors(): any[] {
    return this.of("error").map((e) => e.data);
  }

  usage(): any | null {
    const e = this.of("usage");
    return e.length ? e[e.length - 1].data : null;
  }

  /** the whole stream, decoded — used when a test wants to grep the wire */
  wire(): string {
    return this.raw;
  }

  abort() {
    try {
      this.ctrl.abort();
    } catch {}
  }

  async wait(timeout = 20000): Promise<AiStream> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const guard = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeout)));
    const won = await Promise.race([this.finished.then(() => "done" as const), guard]);
    if (timer) clearTimeout(timer);
    if (won === "timeout") {
      this.abort();
      throw new Error(
        `POST /api/ai/messages never ended within ${timeout}ms (a hung relay stream).\n` +
          `  events so far: ${this.events.map((e) => e.event).join(", ") || "(none)"}`
      );
    }
    return this;
  }

  async waitForEvent(name: string, timeout = 10000): Promise<SSEEvent> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = this.of(name);
      if (hit.length) return hit[hit.length - 1];
      if (this.closed || Date.now() >= deadline) {
        throw new Error(
          `no '${name}' event within ${timeout}ms (closed=${this.closed}); saw: ${
            this.events.map((e) => e.event).join(", ") || "(none)"
          }`
        );
      }
      await sleep(20);
    }
  }
}

function parseFrame(block: string): SSEEvent | null {
  const f = parseSseFrame(block);
  if (!f) return null;
  let data: any = f.data;
  try {
    data = JSON.parse(f.data);
  } catch {}
  return { event: f.event, data, raw: block, at: Date.now() };
}

/** open a turn, wait for it to end, return the stream */
export async function turn(
  srv: TestServer,
  body: { content: string; docPath?: string | null },
  timeout = 20000
): Promise<AiStream> {
  const s = await AiStream.open(srv, body);
  await s.wait(timeout);
  return s;
}
