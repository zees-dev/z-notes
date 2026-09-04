/* ============================================================
   server.ts — z-notes backend.

   One bun process: Bun.serve hosts the v0 JSON API, the SSE event stream, and
   the static frontend in ./app. Zero runtime deps.

     ZNOTES_VAULTS_DIR home of EVERY vault (default ./vaults), one subdirectory
                       each; scanned at boot, so the filesystem is the registry
     ZNOTES_VAULT      the PRIMARY vault (default <ZNOTES_VAULTS_DIR>/vault;
                       created if missing). It may live outside the home — a
                       deployment mounts one at /vault — and the scan skips it
                       wherever it is, so nothing is ever indexed twice.
     ZNOTES_PORT       listen port       (default 4700)
     ZNOTES_VAULT_REPO vault repo to attach on first boot (ADR 0017)
     ZNOTES_GIT_TOKEN  git credential, absorbed into sqlite on first boot

   sqlite always lives at <vault>/.znotes/index.db — one per vault.
   ============================================================ */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AI } from "./ai.ts";
import { Index } from "./db.ts";
import { GitSync, sanitizeRemote, validRemoteUrl } from "./git.ts";
import { META, Settings } from "./settings.ts";
import { Terminal, TerminalError, bearerOf } from "./terminal.ts";
import { Trash } from "./trash.ts";
import { Reconciler } from "./watch.ts";
import { SSE_HEADERS, sseFrame } from "./sse.ts";
import { BAD_JSON, TOO_LARGE, MAX_BODY_BYTES, JSON_HEADERS, fail, json, readJsonBody } from "./http.ts";
import { DocStore, isDocPath } from "./docs.ts";
import { PRIMARY_VAULT_ID, VaultRegistry, qualify, type VaultStack } from "./vaults.ts";
import { Vault } from "./vault.ts";

/* ONE HOME FOR EVERY VAULT. The vaults home holds them all — the primary at
   `<home>/vault` and every secondary beside it — so an install is one directory
   with one subdirectory per repository, not a `vault` and a `vaults` sitting
   next to each other meaning different things. The primary is still special
   (app-level settings, the keyring, the AI relay and the terminal are its), it
   simply lives with the others; the registry knows to skip it when it scans.
   Both paths stay independently overridable — a deployment that mounts a PVC at
   /vault and nothing else sets `ZNOTES_VAULT` and is untouched by this. */
const VAULTS_DIR = resolve(process.env.ZNOTES_VAULTS_DIR || "./vaults");
const VAULT = resolve(process.env.ZNOTES_VAULT || resolve(VAULTS_DIR, "vault"));
/* An install from before the vaults home existed kept its notes in `./vault`.
   Nothing here adopts it — a second possible default is exactly the ambiguity
   this consolidation removes — but booting into a silently empty vault while
   the notes sit one directory away is not a thing to leave unsaid. */
if (!process.env.ZNOTES_VAULT && !existsSync(VAULT) && existsSync(resolve("./vault"))) {
  process.stderr.write(
    `[z-notes] ./vault exists but the vault is now ${VAULT} — move it there (mv ./vault ${VAULT}), or set ZNOTES_VAULT=./vault to keep it where it is.\n`
  );
}
/* The vault is BROUGHT, not shipped (ADR 0017), so a path that does not exist
   yet is the ordinary first-run shape — a fresh clone, an empty PVC. Create it
   here, explicitly and before anything reads it: db.ts happened to do it as a
   side effect of `mkdirSync(dirname(dbPath))`, which made "the app boots into a
   working empty vault" an accident of an unrelated module. */
mkdirSync(VAULT, { recursive: true });
const vault = new Vault(VAULT);
const PORT = Number(process.env.ZNOTES_PORT || 4700);
const APP_DIR = resolve(import.meta.dir, "..", "app");
const VENDOR_ENTRY = resolve(import.meta.dir, "age-entry.js");
const LOCKFILE = resolve(import.meta.dir, "..", "bun.lock");
const HEARTBEAT_MS = 20_000;


/**
 * Cross-site write guard.
 *
 * The app has no app-level auth — cluster + tailnet are the perimeter — but
 * that perimeter is a NETWORK boundary and a CSRF originates inside it: any
 * page the user's browser visits can POST here. `readJsonBody` parses a body
 * regardless of content-type, so `POST /api/ai/messages` and
 * `POST /api/ai/proposals/{id}/accept` were reachable as CORS-*simple* requests
 * — no preflight, no Origin check — and proposal ids are a walkable `prop_<n>`
 * counter. Two blind fetches were enough to drive a turn, accept the proposal,
 * rewrite a note and push the commit.
 *
 * `Sec-Fetch-Site` is sent by every browser that can mount this attack and
 * cannot be forged from script; `Origin` is the fallback for anything older.
 * A non-browser client (curl, the test harness) sends neither and is unaffected.
 */
function crossSiteWrite(req: Request, url: URL): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const site = req.headers.get("sec-fetch-site");
  // "none" = the user typed/bookmarked it, which no page can forge into a POST
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return origin !== url.origin;
  return false;
}

/**
 * `/api/docs/%40work/b%20c.md` → `@work/b c.md`, or null if a segment cannot be
 * decoded. Percent-decoding only — deciding which vault the result names, and
 * whether the remainder is a legal vault path, is the registry's job.
 */
function decodeDocPath(rest: string): string | null {
  const parts = rest.split("/");
  const decoded: string[] = [];
  for (const p of parts) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (d.includes("/") || d.includes("\\")) return null;
    decoded.push(d);
  }
  return decoded.join("/");
}

/* ============================================================
   Boot: index, settings, reconcile, watch
   ============================================================ */

const index = new Index(vault.dbPath);
const settings = new Settings(vault, index);
await settings.load();

const clients = new Set<SseClient>();
let clientSeq = 0;
let eventSeq = 0;

/* Monotonic vault epoch: bumped on every announced change and persisted, so a
   client that missed events while disconnected can tell by comparing the epoch
   in `hello` with the one it last saw — the stream carries no backlog. */
let vaultEpoch = Number(index.getMeta("vaultEpoch") || 0);

/* Every announced change re-arms the debounce — server writes AND the external
   edits the reconciler discovers. The vault is the source of truth and git only
   mirrors it, so a change made in vim has exactly as much claim to a commit as
   one made in the app. */
const recon = new Reconciler(vault, index, (change) => {
  vaultEpoch = index.nextSeq("vaultEpoch");
  broadcast("doc-changed", change);
  gitSync.schedule();
});

const GIT_LOG = process.env.ZNOTES_GIT_LOG === "1";
/* one logger shape for every module: GIT_LOG is the master switch, each
   module gets its own env var on top */
const logFor = (env: string) => (line: string) => {
  if (GIT_LOG || process.env[env] === "1") process.stdout.write(`[z-notes] ${line}\n`);
};
/** The git logger every vault's pipeline shares — argv only, never an env. */
const gitLog = (line: string) => {
  if (GIT_LOG) process.stdout.write(`[z-notes] ${line}\n`);
};

/* ============================================================
   Trash — a delete is recoverable.

   Constructed before GitSync only because the delete route needs both; the two
   are otherwise independent. Everything about the on-disk layout, the retention
   rule and the git decision lives in trash.ts.
   ============================================================ */

const trash = new Trash({
  vault,
  settings,
  log: logFor("ZNOTES_TRASH_LOG"),
});

/** How often the retention sweep runs while the server is up. */
const TRASH_SWEEP_MS = (() => {
  const raw = Number(process.env.ZNOTES_TRASH_SWEEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

const gitSync = new GitSync({
  vault,
  settings,
  index,
  // `vault` says WHICH vault the frame is about; the statusbar chip stays bound
  // to the primary and every other vault paints its own row
  onStatus: (s) => broadcast("sync-status", { ...s, vault: PRIMARY_VAULT_ID }),
  // argv only; git.ts never hands this an environment, so the token cannot
  // reach a log line even when tracing is on
  log: gitLog,
});

/* `trash-changed` is the ONE event no single stack can answer — the drawer the
   panel renders is the union of every vault's — so the registry intercepts it
   and broadcasts the aggregate instead. Everything else goes straight to the
   bus. Late-bound: the primary DocStore is built before the registry that owns
   the rest, and nothing broadcasts until boot has finished. */
const docsBroadcast = (event: string, data: unknown) => registry.docsBroadcast(event, data);

const docs = new DocStore({ vault, index, recon, trash, git: gitSync, broadcast: docsBroadcast });

/* ============================================================
   The registry — one primary vault, N secondary ones.

   Everything above is the primary stack, built exactly as it always was. The
   registry owns the vaults under ZNOTES_VAULTS_DIR, the `@<id>/` address
   grammar and every aggregate the route table answers with; the route table
   below stays the only router.
   ============================================================ */

const primaryStack: VaultStack = { id: PRIMARY_VAULT_ID, vault, index, settings, recon, trash, git: gitSync, docs };

const registry = new VaultRegistry({
  primary: primaryStack,
  vaultsDir: VAULTS_DIR,
  broadcast,
  // the ONE epoch, in the primary index: the client's gap-resync compares a
  // single number from `hello`, whichever vault moved
  bumpEpoch: () => {
    vaultEpoch = index.nextSeq("vaultEpoch");
  },
  log: logFor("ZNOTES_VAULTS_LOG"),
  gitLog,
});

/* ============================================================
   SSE
   ============================================================ */

interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const enc = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return enc.encode(sseFrame(event, data, ++eventSeq));
}

function broadcast(event: string, data: unknown) {
  if (!clients.size) return;
  const chunk = frame(event, data);
  for (const c of [...clients]) {
    try {
      c.controller.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

const heartbeat = setInterval(() => {
  if (clients.size) broadcast("heartbeat", { t: new Date().toISOString() });
}, HEARTBEAT_MS);

function openStream(): Response {
  let self_: SseClient | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self_ = { id: "c" + ++clientSeq, controller };
      clients.add(self_);
      // first bytes: reconnect hint, then hello
      controller.enqueue(enc.encode("retry: 1000\n\n"));
      controller.enqueue(
        frame("hello", {
          clientId: self_.id,
          serverTime: new Date().toISOString(),
          epoch: vaultEpoch,
        })
      );
    },
    cancel() {
      if (self_) clients.delete(self_);
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/* ============================================================
   AI relay — everything upstream lives in ai.ts.

   The key never reaches the browser, context is assembled here from on-disk
   bytes, and no proposed edit is offered to the UI until it has been validated
   against those same bytes.
   ============================================================ */

/* ============================================================
   Terminal — the password-locked command runner.

   Constructed BEFORE the AI relay because the relay takes it as a dependency:
   `run_command` is only declared to the model when this says the terminal is
   available, and the approval gate lives inside it.
   ============================================================ */

const terminal = new Terminal({
  vault,
  settings,
  index,
  log: logFor("ZNOTES_TERMINAL_LOG"),
  /* NOTIFICATION ONLY. `/events` is the app-wide bus and is not behind the
     terminal password, so it carries an id and a state and never a command
     string or a byte of output — the panel fetches those over the bearer-gated
     route once it knows to. */
  onCommandEvent: (data) => broadcast("terminal-command", data),
});

const ai = new AI({
  vault,
  settings,
  index,
  git: gitSync,
  recon,
  docBody: (p: string) => docs.docBody(p),
  terminal,
  contextWindow: META.contextWindow,
  log: logFor("ZNOTES_AI_LOG"),
  /* The statusbar's AI item is driven by this, exactly like the git chip is
     driven by `sync-status`: pushed on real change, never polled. */
  onStatus: (s) => broadcast("ai-status", s),
});

/* Settings is constructed before gitSync/ai/trash/docs exist; its PUT/GET
   fan-out reaches all of them through this seam, wired once here. */
settings.wire({
  applyGit: () => gitSync.applySettings(),
  scheduleSync: () => gitSync.schedule(),
  aiSettingsSaved: () => ai.onSettingsSaved(),
  aiEffortChanged: () => ai.onEffortChanged(),
  aiAnnounce: () => ai.announce(),
  broadcast,
  retentionDays: () => trash.retentionDays(),
  sweepTrash: (why) => docs.sweepTrash(why),
  announceTrash: () => docs.announceTrash(),
});

/* ============================================================
   /vendor/age.js — the age-encryption (typage) browser bundle.

   The frontend stays build-free, and client-side secrets need exactly one
   crypto library in the browser. Squaring those: bundle `vendor/age-entry.js` with Bun.build
   ONCE at boot, hold the bytes in memory, serve them. No artifact is written,
   nothing is added to `dev`, and the crypto worker gets a plain ESM import.

   Cache shape is the standard content-addressed pair: `/vendor/age.js` is a
   tiny no-cache redirect to `/vendor/age.<hash>.js`, which is immutable for a
   year. The hash is over the lockfile + the entry source, so bumping the
   dependency changes the URL and no stale bundle can survive a restart —
   which matters more here than elsewhere, because this bundle is the crypto.
   ============================================================ */

interface VendorBundle {
  js: string;
  hash: string;
  etag: string;
  name: string;
}

let vendor: VendorBundle | null = null;
let vendorError = "";

async function buildVendor(): Promise<void> {
  try {
    const lock = await Bun.file(LOCKFILE)
      .text()
      .catch(() => "");
    const entry = await Bun.file(VENDOR_ENTRY).text();
    const built = await Bun.build({
      entrypoints: [VENDOR_ENTRY],
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!built.success || !built.outputs.length) {
      throw new Error(built.logs.map((l) => String(l)).join("; ") || "no output");
    }
    const js = await built.outputs[0].text();
    // key on the inputs (lockfile + entry) AND the output, so an identical
    // dependency tree always yields the same URL across restarts
    const hash = Bun.hash(lock + "\0" + entry + "\0" + js).toString(16);
    vendor = { js, hash, etag: `"${hash}"`, name: `age.${hash}.js` };
    vendorError = "";
  } catch (err) {
    vendor = null;
    vendorError = String((err as Error)?.message || err);
    process.stderr.write(`[z-notes] vendor bundle failed: ${vendorError}\n`);
  }
}

/** GET /vendor/… — 302 for the unhashed alias, the bundle for the hashed one. */
function serveVendor(pathname: string, req: Request): Response {
  if (!vendor) {
    // the client feature-detects on worker init; a JSON body it can read beats
    // an opaque 500, and secrets simply degrade to the badge
    return fail(503, "vendor-unavailable", {
      message: "The age bundle could not be built; secrets features are unavailable.",
      detail: vendorError,
    });
  }
  if (pathname === "/vendor/age.js") {
    return new Response(null, {
      status: 302,
      headers: { location: `/vendor/${vendor.name}`, "cache-control": "no-cache" },
    });
  }
  if (pathname !== `/vendor/${vendor.name}`) {
    // a hash from a previous build — send them to the current one
    return new Response(null, {
      status: 302,
      headers: { location: `/vendor/${vendor.name}`, "cache-control": "no-cache" },
    });
  }
  const headers: Record<string, string> = {
    "content-type": "text/javascript; charset=utf-8",
    etag: vendor.etag,
    "cache-control": "public, max-age=31536000, immutable",
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === vendor!.etag)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD")
    return new Response(null, { status: 200, headers: { ...headers, "content-length": String(Buffer.byteLength(vendor.js)) } });
  return new Response(vendor.js, { status: 200, headers });
}

/* ============================================================
   Static frontend (Bun emits no ETag — we add one and honour If-None-Match)
   ============================================================ */

async function serveStatic(pathname: string, req: Request): Promise<Response> {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  if (rel.endsWith("/")) rel += "index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return fail(400, "bad-path", { message: "Malformed URL path." });
  }
  if (decoded.includes("\0") || decoded.split("/").some((s) => s === "..")) {
    return fail(400, "bad-path", { message: "Path escapes the app directory." });
  }
  const abs = resolve(APP_DIR, decoded);
  if (abs !== APP_DIR && !abs.startsWith(APP_DIR + "/")) {
    return fail(400, "bad-path", { message: "Path escapes the app directory." });
  }
  const file = Bun.file(abs);
  let st;
  try {
    st = await file.stat();
  } catch {
    return fail(404, "not-found", { message: `No such file: ${pathname}` });
  }
  if (!st.isFile()) return fail(404, "not-found", { message: `No such file: ${pathname}` });

  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    etag,
    "cache-control": "no-cache",
    "content-type": file.type || "application/octet-stream",
  };
  /* app/webmcp.js registers the app's operations as WebMCP tools (ADR 0031),
     and Chrome refuses that registration unless the page's agent cluster is
     origin-keyed and the `tools` permission is delegated to the origin. Both
     are properties of the document, so they ride on the shell only. `rel` is
     `index.html` for `/`, `/d/*` and `/settings*` alike, and the 304 and HEAD
     branches below share this object, so a cached reload keeps them too. */
  if (rel === "index.html") {
    headers["origin-agent-cluster"] = "?1";
    headers["permissions-policy"] = "tools=(self)";
  }
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(st.size) } });
  return new Response(file, { status: 200, headers });
}

/* ============================================================
   API router — a declarative table.

   One place owns method dispatch (405), the no-route 404, param extraction
   and body pre-parsing; every entry is a delegation to the module that owns
   the behavior. Order matters: first match wins, so literal routes precede
   their {param} siblings and namespace {...rest} catch-alls come last.
   ============================================================ */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RouteCtx {
  req: Request;
  url: URL;
  method: string; // may be HEAD/OPTIONS — those always land in `otherwise`
  rest: string; // pathname minus /api/, still percent-encoded
  params: Record<string, string>;
  body: any; // parsed for PUT/POST/PATCH only, else null
  caller: string | null;
  /** the vault a `pre` resolved this request to; params are BARE from there on */
  stack?: VaultStack;
}

type Handler = (c: RouteCtx) => Response | Promise<Response>;

interface Route {
  /** Segments: literal | "{name}" (one non-empty raw segment) |
      "{...name}" (raw remainder incl. "/", may be empty, must be last). */
  pattern: string;
  methods: Partial<Record<Method, Handler>>;
  /** Runs after pattern match, BEFORE method dispatch — for gates that must
      beat 405 (trash id validation, doc-path decoding). Response short-circuits. */
  pre?: (c: RouteCtx) => Response | null;
  /** Unmatched method on a matched pattern. Default "405". */
  otherwise?: "405" | "no-route" | Handler;
}

function matchPattern(pattern: string, rest: string): Record<string, string> | null {
  const ps = pattern.split("/");
  const rs = rest.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.startsWith("{...")) {
      params[p.slice(4, -1)] = rs.slice(i).join("/");
      return params;
    }
    if (i >= rs.length) return null;
    if (p.startsWith("{")) {
      if (!rs[i]) return null;
      params[p.slice(1, -1)] = rs[i];
    } else if (p !== rs[i]) return null;
  }
  return ps.length === rs.length ? params : null;
}

const noRoute = (method: string, url: URL) =>
  fail(404, "no-route", { message: `${method} ${url.pathname} is not part of the v0 contract.` });

/** decodeURIComponent with the 400 the id routes answer on garbage. */
const decodeId = (raw: string, what: string): string | Response => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return fail(400, "bad-id", { message: `Malformed ${what} id.` });
  }
};

/** TerminalError → HTTP; anything else rethrows to Bun's error() → 500. */
const term = (h: Handler): Handler => async (c) => {
  try {
    return await h(c);
  } catch (err) {
    if (err instanceof TerminalError) return fail(err.status, err.code, { message: err.message, ...err.extra });
    throw err;
  }
};

/** No such vault — the one 404 the `@<id>/` grammar can produce. */
const noVault = (id: string) => fail(404, "not-found", { message: `No vault @${id}.` });

/**
 * Trash ids are validated BEFORE method dispatch — bad-id beats 405 here. An id
 * may carry the vault it belongs to (`@work/m7k2x9-4f1a8b3c`); the stack is
 * resolved off the front and the handler sees the bare id its own trash minted.
 */
const preTrashId = (c: RouteCtx): Response | null => {
  const raw = decodeId(c.params.id, "trash");
  if (raw instanceof Response) return raw;
  const t = registry.resolveTrashId(raw);
  if (!t) return fail(400, "bad-id", { message: `Not a trash id: ${raw}` });
  if ("unknownVault" in t) return noVault(t.unknownVault);
  c.params.id = t.id;
  c.stack = t.stack;
  return null;
};

/**
 * A PATCH's destination, in the source vault's own address space.
 *
 * Content never crosses a vault: `[[links]]` resolve inside one repository, the
 * move is one `rename(2)` and its backlink rewrites and commit belong to one
 * git history. Refused here, before anything is planned. A `to` that is not a
 * legal path at all is handed on unchanged — the DocStore owns that refusal and
 * its wording.
 */
const crossVaultTo = (stack: VaultStack, body: any): unknown => {
  if (typeof body?.to !== "string") return body;
  const t = registry.resolveDocPath(body.to);
  if (!t) return body;
  if ("unknownVault" in t) return noVault(t.unknownVault);
  if (t.stack !== stack) return fail(400, "bad-path", { message: "A move cannot cross vaults." });
  return { ...body, to: t.rel };
};

/** `/api/vaults/{id}/…` — the vault itself is the resource; unknown is a 404. */
const preVaultId = (c: RouteCtx): Response | null => {
  const id = decodeId(c.params.id, "vault");
  if (id instanceof Response) return id;
  const stack = registry.get(id);
  if (!stack) return noVault(id);
  c.stack = stack;
  return null;
};

/** A doc/trash handler run against the resolved vault, its reply re-qualified. */
const inVault =
  (h: (s: VaultStack, c: RouteCtx) => Response | Promise<Response>): Handler =>
  async (c) =>
    registry.requalify(c.stack!, await h(c.stack!, c));

const aiProp = (action: "accept" | "revert" | "reject"): Handler => async (c) => {
  const id = decodeId(c.params.id, "proposal");
  if (id instanceof Response) return id;
  const out = action === "accept" ? await ai.accept(id) : action === "revert" ? await ai.revert(id) : ai.reject(id);
  return json(out.body, out.status);
};

const ROUTES: Route[] = [
  /* ---------- docs ---------- */
  {
    pattern: "docs",
    methods: {
      GET: async () => json(await registry.treeBody()),
      POST: async (c) => {
        /* `path` picks the vault here exactly as the URL does on the routes
           below; a body that names no legal path falls through to the primary,
           whose DocStore owns the `bad-path` refusal. */
        const t = registry.resolveDocPath(c.body?.path);
        if (t && "unknownVault" in t) return noVault(t.unknownVault);
        if (!t) return docs.create(c.body);
        return registry.requalify(t.stack, await t.stack.docs.create({ ...c.body, path: t.rel }));
      },
    },
  },
  {
    pattern: "docs/{...path}",
    pre: (c) => {
      const decoded = decodeDocPath(c.params.path);
      const t = decoded === null ? null : registry.resolveDocPath(decoded);
      if (!t) return fail(400, "bad-path", { message: "Path escapes the vault." });
      if ("unknownVault" in t) return noVault(t.unknownVault);
      c.params.path = t.rel; // decoded AND vault-relative from here on
      c.stack = t.stack;
      return null;
    },
    methods: {
      /* The file ops address FOLDERS as well as docs (a folder rename moves
         the subtree), so they dispatch before the ".md or it is not a doc"
         gate — fileOp applies that gate itself once it knows what is there. */
      PATCH: inVault((s, c) => {
        const to = crossVaultTo(s, c.body);
        return to instanceof Response ? to : s.docs.fileOp("PATCH", c.params.path, to);
      }),
      DELETE: inVault((s, c) => s.docs.fileOp("DELETE", c.params.path, c.body)),
      GET: inVault((s, c) => s.docs.read(c.params.path)),
      PUT: inVault((s, c) => s.docs.putDoc(c.params.path, c.body)),
    },
    otherwise: (c) => {
      const s = c.stack!;
      const p = c.params.path;
      if (!isDocPath(p)) return fail(404, "not-found", { message: `No doc at ${qualify(s.id, p)}` });
      return fail(405, "method-not-allowed", {
        message: `${c.method} /api/docs/${qualify(s.id, s.docs.canonicalDocPath(p))}`,
      });
    },
  },

  /* ---------- trash — a SEPARATE namespace from /api/docs:
     a trashed doc is in no tree, no search result and no backlink, and is
     addressed by the opaque id the delete minted. ---------- */
  { pattern: "trash", methods: { GET: async () => json(await registry.trashView()) } },
  { pattern: "trash/purge", methods: { POST: async (c) => json(await registry.trashPurge(c.body)) } },
  { pattern: "trash/{id}/restore", pre: preTrashId, methods: { POST: inVault((s, c) => s.docs.restoreTrash(c.params.id)) } },
  {
    pattern: "trash/{id}",
    pre: preTrashId,
    methods: {
      GET: inVault((s, c) => s.docs.trashEntry(c.params.id)),
      DELETE: inVault((s, c) => s.docs.purgeTrashEntry(c.params.id)),
    },
  },
  { pattern: "trash/{...rest}", methods: {}, otherwise: "no-route" },

  /* ---------- search ---------- */
  {
    pattern: "search",
    methods: {
      GET: (c) => {
        const q = (c.url.searchParams.get("q") || "").trim();
        // clamp both ends: a negative limit would reach out.slice(0, limit) and
        // quietly lop results off the END of the list instead of paging
        const asked = parseInt(c.url.searchParams.get("limit") || "24", 10);
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(100, asked) : 24;
        /* `mode=regex` reads a bare pattern as one; `/pattern/flags` says so
           itself and needs no parameter (ADR 0028) */
        const a = registry.search(q, limit, c.url.searchParams.get("mode"));
        return json({
          query: q,
          mode: a.mode,
          results: a.results,
          ...(a.invalid ? { invalid: a.invalid } : {}),
          ...(a.partial ? { partial: true } : {}),
        });
      },
    },
  },

  /* ---------- secrets: retired — the app decrypts in the
     browser; a stable slug lets the UI degrade to the badge instead of
     toasting a router internal. ANY method. ---------- */
  {
    pattern: "secrets/{...rest}",
    methods: {},
    otherwise: () =>
      fail(404, "secrets-client-side", {
        message: "Secrets are decrypted in the browser; the server has no secrets endpoint.",
      }),
  },

  /* ---------- vault keyring — ciphertext and a public key, stored
     and served; shape validation and storage live on Vault. ---------- */
  {
    pattern: "vault/recipient",
    methods: {
      GET: async () => {
        const out = await vault.recipientOut();
        return json(out.body, out.status);
      },
    },
  },
  {
    pattern: "vault/identity",
    methods: {
      GET: async () => {
        const armor = await vault.identityArmor();
        if (armor === null) return fail(404, "no-identity", { message: "This vault has no age identity yet." });
        /* the body IS the armor — the client hands it straight to the worker,
           and a JSON wrapper would only be one more place to re-encode it */
        return new Response(armor, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      },
      PUT: async (c) => {
        const out = await vault.storeIdentity(c.body);
        // `.znotes/` is invisible to the doc reconciler — this is what stages
        // the keyring files for the next commit
        if (out.stored) gitSync.schedule();
        return json(out.body, out.status);
      },
    },
  },
  { pattern: "vault/{...rest}", methods: {}, otherwise: "no-route" },

  /* ---------- vaults — the registry's own surface. Adding one is the
     ADR 0017 attach against a directory the call creates; disconnecting one is
     a registry operation and leaves the directory (and its repo) on disk. ---------- */
  {
    pattern: "vaults",
    methods: {
      GET: () => json(registry.vaultsBody()),
      POST: async (c) => {
        const r = await registry.addVault(c.body?.url, c.body?.name, c.body?.token);
        return r.ok ? json({ vault: r.vault }, 201) : json(r.body, r.status);
      },
    },
  },
  {
    /* Only the `git` section: theme, editor, AI, terminal and secrets are
       APP settings and live in the primary's `/api/settings` alone. */
    pattern: "vaults/{id}/settings",
    pre: preVaultId,
    methods: {
      PUT: async (c) => {
        const body = c.body;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "git"))
          return fail(400, "bad-body", { message: "Only the git section is settable per vault." });
        const out = await c.stack!.settings.putRoute(body);
        if (out.status !== 200) return json(out.body, out.status);
        registry.announceVaults();
        return json({ vault: registry.descriptor(c.stack!) });
      },
    },
  },
  {
    pattern: "vaults/{id}/sync",
    pre: preVaultId,
    methods: {
      POST: async (c) => json({ ...(await c.stack!.git.trigger("manual")), vault: c.stack!.id }),
    },
  },
  {
    /* Point a vault at a (new) remote — the same attach the primary's
       POST /api/sync/remote runs, against this vault's stack: non-destructive,
       atomic, refusals relayed verbatim. Works for `vault` too, where it is
       that route's twin. */
    pattern: "vaults/{id}/remote",
    pre: preVaultId,
    methods: {
      POST: async (c) => {
        const s = c.stack!;
        const url = String(c.body?.url ?? "");
        /* one remote, one vault — checked BEFORE attach can move origin, and
           only for a URL attach would accept (a bad one gets attach's own
           refusal below, verbatim) */
        if (validRemoteUrl(url)) {
          const taken = registry.remoteTakenBy(url, s.id);
          if (taken)
            return fail(409, "exists", {
              message: `@${taken} is already connected to ${sanitizeRemote(url)}.`,
            });
        }
        const r = await s.git.attachRemote(url);
        if (!r.ok) return json(r.body, r.status);
        const saved = await s.settings.putRoute({ git: { branch: r.branch } });
        if (saved.status !== 200)
          process.stderr.write(
            `[z-notes] vaults: @${s.id} git.branch=${r.branch} was not persisted (${(saved.body as any)?.error ?? saved.status})\n`
          );
        // index and announce the pulled docs BEFORE answering, as the primary
        // attach route does, so the tree is queryable the moment this returns
        await s.recon.reconcile();
        const out = { ...(await s.git.trigger("manual")), vault: s.id };
        // the label derives from the origin, so the row every client shows renames
        registry.announceVaults();
        return json(out);
      },
      /* Disconnect from the remote — `git remote remove origin` and nothing
         else, so the vault stays a working local-only repository. This is what
         "Disconnect" means for the PRIMARY vault, which can never leave the
         app; a secondary's own DELETE /api/vaults/{id} unregisters it instead. */
      DELETE: async (c) => {
        const s = c.stack!;
        const r = await s.git.detachRemote();
        if (!r.ok) return json(r.body, r.status);
        registry.announceVaults();
        return json({ ...s.git.snapshot(), vault: s.id });
      },
    },
  },
  {
    pattern: "vaults/{id}",
    pre: preVaultId,
    methods: {
      GET: (c) => json({ vault: registry.descriptor(c.stack!) }),
      DELETE: async (c) => {
        if (c.stack!.id === PRIMARY_VAULT_ID)
          return fail(400, "primary-vault", { message: "The primary vault cannot be disconnected." });
        await registry.removeVault(c.stack!.id);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      },
    },
  },
  { pattern: "vaults/{...rest}", methods: {}, otherwise: "no-route" },

  /* ---------- settings ---------- */
  {
    pattern: "settings",
    methods: {
      GET: async () => {
        const out = await settings.getRoute();
        return json(out.body, out.status);
      },
      PUT: async (c) => {
        const out = await settings.putRoute(c.body);
        return json(out.body, out.status);
      },
    },
  },

  /* ---------- sync ---------- */
  { pattern: "sync/status", methods: { GET: async () => json(await gitSync.status()) } },
  /* Manual "Sync now": the same add → commit → push pipeline the debounce
     runs, started immediately and awaited so the caller gets the outcome. */
  { pattern: "sync/now", methods: { POST: async () => json(await gitSync.trigger("manual")) } },
  /* Attach (ADR 0017): connect the vault directory to a remote repository. The
     one route in this server that may `git init`; git.ts owns the atomicity and
     hands back the response body verbatim on refusal. */
  {
    pattern: "sync/remote",
    methods: {
      POST: async (c) => {
        const r = await gitSync.attachRemote(String(c.body?.url ?? ""));
        if (!r.ok) return json(r.body, r.status);
        /* putRoute rather than a bare write: it opens with reloadIfChanged(),
           which is exactly what adopts a settings.toml that just arrived in the
           checkout, and it fans the adopted branch out to the git timer and to
           every client the same way a Settings save does. It reports failure as
           a status, not a throw — swallowing it would leave git.branch stale
           and the NEXT push dying with "committed locally, not pushed". */
        const saved = await settings.putRoute({ git: { branch: r.branch } });
        if (saved.status !== 200)
          process.stderr.write(`[z-notes] attach: git.branch=${r.branch} was not persisted (${(saved.body as any)?.error ?? saved.status})\n`);
        // index and announce the pulled docs BEFORE answering, so the tree is
        // queryable the moment the caller sees the response
        await recon.reconcile();
        // exactly the sync-status object, like POST /api/sync/now: this push is
        // what sends local-only docs (or the first commit) to a fresh remote
        const out = json(await gitSync.trigger("manual"));
        // the primary's LABEL is derived from its origin, so an attach renames
        // the top-level row every client is showing
        registry.announceVaults();
        return out;
      },
    },
  },

  /* ---------- terminal — every route is under /api, so the
     crossSiteWrite guard in fetch() already refused a cross-site POST before
     dispatch; the bearer token is the authorisation on top. status is the one
     route that answers without a token, with capability, never content. ---------- */
  { pattern: "terminal/status", methods: { GET: term((c) => json(terminal.status(bearerOf(c.req), c.caller))) } },
  {
    pattern: "terminal/unlock",
    methods: {
      POST: term((c) => {
        const out = terminal.unlock(c.body?.password, c.caller);
        return json({ ...out, status: terminal.status(out.token, c.caller) });
      }),
    },
  },
  {
    pattern: "terminal/lock",
    methods: {
      POST: term((c) => {
        terminal.lock(bearerOf(c.req));
        return json(terminal.status(null, c.caller));
      }),
    },
  },
  /* Setting the FIRST password needs no proof (nothing to prove against, and
     the perimeter is the network); changing an existing one
     needs the current password or a live session — see Terminal.setPassword. */
  {
    pattern: "terminal/password",
    methods: {
      POST: term((c) => {
        const out = terminal.setPassword(c.body?.password, c.body?.current, bearerOf(c.req), c.caller);
        // the new password never comes back, not even masked
        return json({ ...out, status: terminal.status(bearerOf(c.req), c.caller) });
      }),
    },
  },
  { pattern: "terminal/exec", methods: { POST: term((c) => terminal.exec(bearerOf(c.req), c.body?.command)) } },
  {
    pattern: "terminal/stdin",
    methods: {
      POST: term(async (c) =>
        json(
          await terminal.writeStdin(
            bearerOf(c.req),
            c.body?.data,
            c.body?.eof === true,
            typeof c.body?.id === "string" ? c.body.id : null
          )
        )
      ),
    },
  },
  {
    pattern: "terminal/cancel",
    methods: {
      POST: term(async (c) => json(await terminal.cancel(bearerOf(c.req), typeof c.body?.id === "string" ? c.body.id : undefined))),
    },
  },
  {
    pattern: "terminal/commands",
    methods: {
      GET: term((c) => {
        const asked = parseInt(c.url.searchParams.get("limit") || "30", 10);
        return json({ commands: terminal.list(bearerOf(c.req), Number.isFinite(asked) ? asked : 30) });
      }),
    },
  },
  {
    pattern: "terminal/commands/{id}/run",
    methods: {
      POST: term((c) => {
        const id = decodeId(c.params.id, "command");
        return id instanceof Response ? id : terminal.runQueued(bearerOf(c.req), id);
      }),
    },
  },
  {
    pattern: "terminal/commands/{id}/reject",
    methods: {
      POST: term((c) => {
        const id = decodeId(c.params.id, "command");
        return id instanceof Response ? id : json({ command: terminal.reject(bearerOf(c.req), id) });
      }),
    },
  },
  { pattern: "terminal/{...rest}", methods: {}, otherwise: "no-route" },

  /* ---------- ai ---------- */
  { pattern: "ai/sessions/current", methods: { GET: () => json(ai.sessionOut()) }, otherwise: "no-route" },
  /* GET → the derived endpoint status, cheap, no network. POST → re-run the
     capability probe NOW, awaited — the click is a question the user is
     waiting on, unlike the boot and settings-save probes. */
  {
    pattern: "ai/status",
    methods: {
      GET: () => json({ status: ai.status(), ai: ai.metaAi() }),
      POST: async () => {
        await ai.probe().catch(() => {});
        return json({ status: ai.status(), ai: ai.metaAi() });
      },
    },
  },
  /* A new session drops the THREAD, never the change stack. */
  { pattern: "ai/sessions", methods: { POST: () => json(ai.newSession(), 201) }, otherwise: "no-route" },
  /* the turn STREAMS — text/event-stream whose final `done` event carries
     exactly the JSON the non-streaming contract returned. */
  {
    pattern: "ai/messages",
    methods: {
      POST: (c) => {
        const content = String(c.body?.content ?? "").trim();
        if (!content) return fail(400, "empty-message", { message: "content is required." });
        return ai.handleMessage(content, c.body?.docPath);
      },
    },
    otherwise: "no-route",
  },
  { pattern: "ai/proposals", methods: { GET: () => json(ai.listProposals()) }, otherwise: "no-route" },
  { pattern: "ai/proposals/{id}/accept", methods: { POST: aiProp("accept") } },
  { pattern: "ai/proposals/{id}/revert", methods: { POST: aiProp("revert") } },
  { pattern: "ai/proposals/{id}/reject", methods: { POST: aiProp("reject") } },
];

async function api(req: Request, url: URL, caller: string | null): Promise<Response> {
  const method = req.method.toUpperCase();
  const rest = url.pathname.slice("/api/".length);

  /* Body pre-parse stays BEFORE route matching: a bad or oversized body on any
     /api path — even an unknown one — answers 400/413, not 404. DELETE bodies
     are never parsed. */
  let body: any = null;
  if (method === "PUT" || method === "POST" || method === "PATCH") {
    body = await readJsonBody(req);
    if (body === TOO_LARGE)
      return fail(413, "too-large", {
        message: `Request body is larger than the ${Math.round(MAX_BODY_BYTES / (1024 * 1024))} MiB limit.`,
        limit: MAX_BODY_BYTES,
      });
    if (body === BAD_JSON) return fail(400, "bad-json", { message: "Body is not valid JSON." });
  }

  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, rest);
    if (!params) continue;
    const c: RouteCtx = { req, url, method, rest, params, body, caller };
    const short = route.pre?.(c);
    if (short) return short;
    const h = route.methods[method as Method];
    if (h) return h(c);
    const ow = route.otherwise ?? "405";
    if (ow === "no-route") return noRoute(method, url);
    if (ow === "405") return fail(405, "method-not-allowed", { message: `${method} /api/${rest}` });
    return ow(c);
  }
  return noRoute(method, url);
}

/* ============================================================
   Server
   ============================================================ */

/* ============================================================
   Boot provisioning — ZNOTES_VAULT_REPO (ADR 0017).

   A fresh PVC plus this env var is a self-seeding deployment: attach is init +
   fetch + checkout, which is what lets a non-empty vault and the live
   credential store survive it. BOOTSTRAP ONLY — a vault that is already its own
   repo is left alone, so restarting the pod is a no-op and the env var never
   becomes an enforcer.

   Failure is logged and survived. An unreachable remote or a wrong token must
   leave a working offline vault whose sync status carries the error, never a
   process that dies on boot and takes the notes offline with it.

   Runs BEFORE the reconcile below so the first index pass sees the checked-out
   docs, and after `settings.load()` so the token it fetches with is in sqlite.
   ============================================================ */

const VAULT_REPO = (process.env.ZNOTES_VAULT_REPO || "").trim();
if (VAULT_REPO) {
  try {
    const { repo, remote } = await gitSync.attachment();
    const wanted = sanitizeRemote(VAULT_REPO);
    if (repo) {
      if (remote !== wanted)
        process.stderr.write(
          `[z-notes] the vault is already a git repository (origin ${remote ?? "unset"}); ZNOTES_VAULT_REPO (${wanted}) not applied.\n`
        );
    } else {
      const r = await gitSync.attachRemote(VAULT_REPO);
      if (r.ok) {
        const saved = await settings.putRoute({ git: { branch: r.branch } });
        if (saved.status !== 200)
          process.stderr.write(`[z-notes] attach: git.branch=${r.branch} was not persisted (${(saved.body as any)?.error ?? saved.status})\n`);
        process.stderr.write(`[z-notes] vault attached to ${wanted} on branch ${r.branch}.\n`);
      } else {
        process.stderr.write(`[z-notes] ZNOTES_VAULT_REPO: ${r.body.error} — ${r.body.message}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[z-notes] ZNOTES_VAULT_REPO: attach failed — ${String((err as Error)?.message || err)}\n`);
  }
}

// full index pass before the first request, then the doorbell goes live
await recon.reconcile();
recon.start();

/* Every vault already under the vaults home comes back, each with its own
   index, watcher and git pipeline. Never fatal per vault: the registry logs the
   one that failed and the app boots with the rest. */
await registry.boot();

// the crypto worker's only dependency, bundled once (never written to disk)
await buildVendor();

/* Retention sweep at boot, BEFORE the port opens: a server that was off for a
   month must not serve a trash listing full of entries it is about to delete.
   Never fatal — a trash that cannot be swept is not a reason to refuse to boot. */
for (const stack of registry.stacks()) {
  await stack.docs.sweepTrash("at boot").catch((err) =>
    process.stderr.write(`[z-notes] trash sweep at boot failed: ${String(err)}\n`)
  );
}
const trashSweep = setInterval(() => {
  for (const stack of registry.stacks()) stack.docs.sweepTrash("on schedule").catch(() => {});
}, TRASH_SWEEP_MS);
(trashSweep as any)?.unref?.();

/* One read-only git observation before the first request so the statusbar tells
   the truth from the start. It never mutates and never git-inits: a vault that
   is not a repository simply reports `offline`, and everything else works. */
await gitSync.start().catch(() => {});

/* The same courtesy for the AI endpoint, and for the same reason: the statusbar
   must tell the truth from the start. Deliberately NOT awaited — it talks to a
   third-party endpoint over the network and boot must not hang on one, exactly
   as at settings-save. The result lands in sqlite and is pushed as `ai-status`.

   Before this, the capability probe ran ONLY when PUT /api/settings changed the
   base URL, model or key — so a vault configured the intended way (a
   hand-written `settings.toml` whose credential `settings.load()` absorbs at
   boot) never probed at all and `meta.ai.probe` stayed null forever. */
ai.probeAtBoot();

/* declared before `Bun.serve` so `/healthz` can never touch it in the temporal
   dead zone — the listener is live for the rest of this module's evaluation */
let closing = false;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE dies at 10s otherwise (verified — ticket 8)
  development: false,
  /* Hard ceiling under Bun's 128 MiB default, with slack over MAX_BODY_BYTES so
     an oversized body still gets the named 413 from readJsonBody rather than a
     bare connection refusal. */
  maxRequestBodySize: MAX_BODY_BYTES + 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url);
    /* GET /healthz — kubelet probe target.

       Deliberately the cheapest possible route: it touches no disk, does not
       scan the vault, does not query sqlite and does not shell out to git, so
       a probe every few seconds costs nothing and can never be the thing that
       wedges under load. It answers exactly one question — "is this process
       still accepting and serving HTTP?" — which is the only question a
       liveness probe should ask.

       It doubles as readiness because of where the listener starts: `Bun.serve`
       is called AFTER the boot-time `recon.reconcile()`, `buildVendor()` and
       `gitSync.start()` have all awaited, so the port does not exist until the
       index is warm. Anything that answers here is genuinely ready.

       `closing` flips first thing in `shutdown()`, so the window between
       SIGTERM and the socket actually closing reports 503 and the endpoints
       controller can pull the pod out of the Service before the last
       in-flight request drains. */
    if (url.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD")
        return fail(405, "method-not-allowed", { message: `${req.method} /healthz` });
      const status = closing ? 503 : 200;
      const body = JSON.stringify({ status: closing ? "shutting-down" : "ok" });
      return new Response(req.method === "HEAD" ? null : body, { status, headers: JSON_HEADERS });
    }
    if (url.pathname === "/events") {
      if (req.method !== "GET") return fail(405, "method-not-allowed", { message: `${req.method} /events` });
      srv.timeout(req, 0);
      return openStream();
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (crossSiteWrite(req, url))
        return fail(403, "cross-site", { message: "Cross-site writes are refused." });
      /* A model turn is quiet for long stretches (reasoning produces no bytes)
         and Bun counts a quiet response as idle. idleTimeout:0 covers it, and
         this covers a future build that sets one (research §3.3). */
      if (url.pathname === "/api/ai/messages") srv.timeout(req, 0);
      /* A command is quiet for long stretches too (a `git push`, a build), and
         Bun counts a quiet response as idle — the same reason the AI turn is
         exempted. `/api/terminal/exec` and the approved-command run both
         stream for as long as the command takes. */
      if (url.pathname === "/api/terminal/exec" || /^\/api\/terminal\/commands\/[^/]+\/run$/.test(url.pathname))
        srv.timeout(req, 0);
      /* The caller's address, for the unlock backoff and nothing else: the
         limiter is per caller so one peer's failed guesses cannot lock the
         owner out (terminal.ts). `requestIP` is Bun's own socket peer — never a
         header, which a client could forge. */
      return api(req, url, srv.requestIP(req)?.address ?? null);
    }
    /* `/vendor/*` is THIRD-PARTY CODE, and it arrives two ways. The age bundle
       is built in memory at boot and has no file behind it, so it is matched by
       name here and answered by `serveVendor`. Everything else under the prefix
       — today `mermaid.js`, generated by `bun scripts/build-mermaid.ts` and
       COMMITTED — is an ordinary file in APP_DIR and falls through to
       `serveStatic` below, which already owns traversal-proofing and ETags.
       The guard is narrow on purpose: it used to swallow the whole prefix and
       redirect every miss to the age bundle, which would have served 3 MB of
       crypto to anything that asked for a diagram. */
    if (url.pathname === "/vendor/age.js" || url.pathname.startsWith("/vendor/age.")) {
      if (req.method !== "GET" && req.method !== "HEAD")
        return fail(405, "method-not-allowed", { message: `${req.method} ${url.pathname}` });
      return serveVendor(url.pathname, req);
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return fail(405, "method-not-allowed", { message: `${req.method} ${url.pathname}` });
    /* `/d/<vault path>` is the frontend's routing space, never a file: the app
       owns one URL per open doc so a doc can be linked, refreshed and walked
       back to. It answers with the SPA shell — the same `index.html` bytes and
       the same ETag as `/`, so nothing about asset caching changes — and the
       app reads the path back out of `location`. The prefix is what keeps it
       collision-free against `/api/*`, `/events`, `/vendor/*`, `/healthz` and
       every real file under app/ (`/app.js`, `/themes/*`). */
    if (url.pathname === "/d" || url.pathname.startsWith("/d/")) return serveStatic("/", req);
    /* `/settings` and `/settings/<section>` are the app's other routing space:
       Settings is a page, not a modal, so it has a real address that can be
       deep-linked, reloaded and walked back out of. Same SPA shell, same ETag.
       Note this is a FRONTEND route and has nothing to do with
       `/api/settings` — the API lives under `/api/*` and was matched above. */
    if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) return serveStatic("/", req);
    return serveStatic(url.pathname, req);
  },
  error(err) {
    // detail to stderr only: err.message carries absolute filesystem paths
    process.stderr.write(`[z-notes] ${String(err?.stack || err)}\n`);
    return fail(500, "server-fault", { message: "The server hit an unexpected error." });
  },
});

process.stdout.write(`z-notes listening on http://localhost:${server.port}\n`);

/* ---------- graceful shutdown ---------- */

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  clearInterval(trashSweep);
  for (const c of [...clients]) {
    try {
      c.controller.close();
    } catch {}
  }
  clients.clear();
  const stacks = registry.stacks();
  for (const stack of stacks) {
    stack.recon.stop();
    // cancels the pending debounce AND kills any git child still running, so a
    // SIGTERM never leaves an orphaned push holding the index lock
    stack.git.stop();
  }
  // SIGKILL anything the terminal still has running and drop every session, so
  // a SIGTERM never leaves an orphaned command holding a pipe
  terminal.stop();
  server.stop(true);
  for (const stack of stacks) stack.index.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
