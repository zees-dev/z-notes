/* ============================================================
   http.ts — the JSON response plumbing every module shapes replies with.

   json()/fail() define the contract's error body ({error, message, ...extra})
   and its key order — byte-identical output matters because the test suite
   compares serialized bodies. readJsonBody() owns the 8 MiB cap + bad-json
   sentinel; the router turns the sentinels into 413/400 once, for every route.
   ============================================================ */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, message: typeof extra.message === "string" ? extra.message : error, ...extra }, status);

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Largest JSON request body any route accepts. A note is text a human typed or
 * pasted; 8 MiB is already far past that, and the cost of the alternative is
 * not just the buffer — the markdown is stored in `files.body` AND a second
 * time in the `files_fts` shadow table (db.ts), inside the vault, and is
 * re-materialised by every tree read and every search. Without a cap the only
 * bound was Bun's 128 MiB default. Refused with 413 and the limit named, the
 * same shape as the identity route.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readJsonBody(req: Request): Promise<any | typeof BAD_JSON | typeof TOO_LARGE> {
  /* The body is drained BEFORE the size is judged, deliberately: answering
     while the client is still sending desynchronises the keep-alive connection
     and the next request on it fails to parse. What bounds the read is
     `maxRequestBodySize` on Bun.serve (set just above MAX_BODY_BYTES, far below
     Bun's 128 MiB default) — anything past that never reaches this function. */
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return TOO_LARGE;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return BAD_JSON;
  }
}
const BAD_JSON = Symbol("bad-json");
const TOO_LARGE = Symbol("too-large");

export { json, fail, iso, readJsonBody, BAD_JSON, TOO_LARGE, MAX_BODY_BYTES, JSON_HEADERS };
