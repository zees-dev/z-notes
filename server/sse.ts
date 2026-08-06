/* ============================================================
   sse.ts — the one POST-SSE response envelope.

   Three routes stream a coroutine's events at a browser — the AI turn
   (ai.ts), a human terminal command and an approved AI command (terminal.ts,
   twice) — and each hand-rolled the same ReadableStream + encoder + closed
   flag + error frame + finally-close + headers block. Four copies of transport
   plumbing meant a fix to disconnect handling had to be found four times; two
   of the copies had already drifted (one lost its error `code`).

   `run(emit)` does the work; each emit() writes one `event:`/`data:` frame.
   `onError(err)` names the error frame for a run that threw. `onCancel()`
   fires when the client goes away (Bun calls `cancel` on the stream).
   ============================================================ */

type SseEvent = { event: string; data: unknown };

/* The one copy of the wire format. Everything that speaks SSE — the /events
   bus, the three coroutine streams, the upstream reader, and both test
   harnesses — encodes with sseFrame() and decodes with sseBlocks() +
   parseSseFrame(). The browser's native EventSource stays the independent
   check that the format is actually spec-conformant. */

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export function sseFrame(event: string, data: unknown, id?: number): string {
  return `${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Split an SSE byte stream into raw frame blocks. Never assumes chunk boundaries. */
export async function* sseBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    for (;;) {
      const sep = /\r?\n\r?\n/.exec(buf);
      if (!sep) break;
      yield buf.slice(0, sep.index);
      buf = buf.slice(sep.index + sep[0].length);
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf;
}

/** One frame block → fields. Null when it has no data line (per the SSE spec
    such a block dispatches nothing — that keeps `retry:` preambles out). */
export function parseSseFrame(block: string): { event: string; data: string; id?: string } | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return null;
  return { event, data: data.join("\n"), id };
}

export function sseResponse(
  run: (emit: (e: SseEvent) => void) => Promise<unknown>,
  opts: {
    onError: (err: unknown) => SseEvent;
    onCancel?: () => void;
  }
): Response {
  const enc = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const emit = (e: SseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(sseFrame(e.event, e.data)));
        } catch {
          closed = true;
        }
      };
      run(emit)
        .catch((err) => {
          if (closed) return;
          emit(opts.onError(err));
        })
        .finally(() => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        });
    },
    /* Bun calls this when the browser goes away. A stream nobody is reading
       must stop generating — the caller decides what that means (abort the
       upstream fetch, cancel the running child). */
    cancel: () => {
      closed = true;
      opts.onCancel?.();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
