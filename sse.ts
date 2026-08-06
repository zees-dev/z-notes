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

export type SseEvent = { event: string; data: unknown };

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
          controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
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

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
