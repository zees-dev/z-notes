/* ============================================================
   sw.js — hand-rolled mock of the whole z-notes v0 API (see API.md).

   This file is scaffolding. It exists so the frontend can be built and
   reviewed against a real HTTP/SSE boundary before the bun backend is
   written. Everything lives in memory: reload the page and your edits are
   still there; kill the worker (devtools → Unregister, or a long idle) and
   the vault reseeds. That is the deal.

   Two rules it must never break:
     1. It serves ONLY /api/* and /events. Every other request goes to the
        network with cache: "no-store" — no app file is ever cached, so
        editing app.js and hitting reload shows the new app.js.
     2. skipWaiting + clients.claim, so the first load is controlled and dev
        iteration never needs a manual unregister.
   ============================================================ */
"use strict";

const SCOPE = new URL(self.registration ? self.registration.scope : "./", self.location).pathname;
const API = SCOPE + "api/";
const EVENTS = SCOPE + "events";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

/* ============================================================
   SEED VAULT — the BRIEF's dummy content, byte-for-byte.
   Concatenated rather than templated because the docs contain ``` fences.
   ============================================================ */

const MD_DESIGN =
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

const MD_PIPELINE =
  "# Event pipeline\n" +
  "\n" +
  'fs.watch on macOS lies: eventType is always "rename" and atomic saves name only the temp file.\n' +
  "\n" +
  "- [x] Debounce 120ms\n" +
  "- [x] Reconcile: Glob → stat → hash → sqlite\n" +
  "- [ ] Push change to open editors via SSE\n" +
  "\n" +
  "Related: [[z-notes-design]]\n";

const MD_SIDE =
  "# Side projects\n" +
  "\n" +
  "Active: **z-notes** (this app — [[z-notes-design]]), homelab overhaul, a tiny CLI for age-encrypted dotfiles.\n" +
  "\n" +
  "- [ ] z-notes: review prototype round 1\n" +
  "- [ ] homelab: move DNS off the NAS\n";

const MD_KEYS =
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

/* the age plaintext lives ONLY here and only ever leaves via /api/secrets/unlock */
const SECRET_PLAIN =
  "AWS_ACCESS_KEY_ID=AKIA2E4EXAMPLE7XQ\n" +
  "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n" +
  "HETZNER_API_TOKEN=hz-prod-9f3kx…";

const T0 = Date.now();
const iso = (t) => new Date(t).toISOString();

function seedDocs() {
  const mk = (path, title, slug, md, extra) =>
    Object.assign(
      { path, name: path.split("/").pop(), title, slug, markdown: md, rev: "r1", mtime: T0 - 240000 },
      extra || {}
    );
  const list = [
    mk("inbox.md", "inbox.md", "inbox", ""),
    mk("architecture/z-notes-design.md", "z-notes design", "z-notes-design", MD_DESIGN),
    mk("architecture/event-pipeline.md", "Event pipeline", "event-pipeline", MD_PIPELINE),
    mk("projects/side-projects.md", "Side projects", "side-projects", MD_SIDE),
    mk("projects/homelab.md", "homelab.md", "homelab", ""),
    mk("keys/cloud-keys.md", "Cloud keys", "cloud-keys", MD_KEYS, { hasSecrets: true }),
    mk("journal/2026-07-31.md", "2026-07-31.md", "2026-07-31", ""),
  ];
  const map = new Map();
  list.forEach((d) => map.set(d.path, d));
  return map;
}

function seedTree() {
  return [
    { type: "file", path: "inbox.md" },
    {
      type: "folder",
      path: "architecture",
      name: "architecture",
      open: true,
      children: [{ type: "file", path: "architecture/z-notes-design.md" }, { type: "file", path: "architecture/event-pipeline.md" }],
    },
    {
      type: "folder",
      path: "projects",
      name: "projects",
      open: true,
      children: [{ type: "file", path: "projects/side-projects.md" }, { type: "file", path: "projects/homelab.md" }],
    },
    { type: "folder", path: "keys", name: "keys", open: true, children: [{ type: "file", path: "keys/cloud-keys.md" }] },
    { type: "folder", path: "journal", name: "journal", open: false, children: [{ type: "file", path: "journal/2026-07-31.md" }] },
  ];
}

function seedSettings() {
  return {
    theme: "modern",
    density: "comfy",
    colorScheme: "system",
    editor: { autosaveSeconds: 10, losslessRoundTrip: true, clickToEdit: true },
    git: { branch: "main", autoSync: true, tokenMasked: "ghp_9f3kx2Qm7Lp0" },
    ai: { baseUrl: "http://127.0.0.1:8317/v1", model: "gpt-5.6-sol", effort: "high", apiKeyMasked: "sk-proj-7hQ2vN8xR1" },
  };
}

const SETTINGS_META = {
  themes: [
    { id: "modern", label: "Modern" },
    { id: "minimal", label: "Minimal" },
    { id: "terminal", label: "Terminal" },
  ],
  densities: [
    { id: "compact", label: "Compact" },
    { id: "comfy", label: "Comfy" },
  ],
  efforts: ["low", "medium", "high"],
  colorSchemes: ["system", "dark", "light"],
  contextWindow: 256000,
};

/* ---------- proposals: anchored search/replace spans (ticket 10) ---------- */
function seedProposals() {
  return [
    {
      id: "prop_1",
      target: "architecture/z-notes-design.md",
      label: "Open tasks rollup",
      summary: "1 file · 4 lines",
      state: "pending",
      stats: { added: 4, removed: 0 },
      stackIndex: null,
      diff: [
        { marker: " ", text: "- [ ] Write build-ready spec" },
        { marker: "+", text: "## Open tasks rollup" },
        { marker: "+", text: "- [ ] Pick winning UI theme ([[z-notes-design]])" },
        { marker: "+", text: "- [ ] Write build-ready spec ([[z-notes-design]])" },
        { marker: "+", text: "- [ ] SSE push to open editors ([[event-pipeline]])" },
      ],
      edits: [
        {
          op: "insert_after",
          anchor: "> Files are edited outside the app too — the watcher is just a doorbell; reconcile from disk.",
          text:
            "\n## Open tasks rollup\n\n" +
            "- [ ] Pick winning UI theme ([[z-notes-design]])\n" +
            "- [ ] Write build-ready spec ([[z-notes-design]])\n" +
            "- [ ] SSE push to open editors ([[event-pipeline]])",
        },
      ],
    },
    {
      id: "prop_2",
      target: "architecture/z-notes-design.md",
      label: "Track round 2 shipping",
      summary: "1 file · 1 line",
      state: "pending",
      stats: { added: 1, removed: 0 },
      stackIndex: null,
      diff: [
        { marker: " ", text: "- [ ] SSE push to open editors ([[event-pipeline]])" },
        { marker: "+", text: "- [ ] Ship prototype round 2" },
      ],
      edits: [
        {
          op: "insert_after",
          anchor: "- [ ] SSE push to open editors ([[event-pipeline]])",
          text: "- [ ] Ship prototype round 2",
        },
      ],
    },
  ];
}

const PROPOSAL_INTRO = {
  prop_1: "Proposed edit — appending a rollup section under **Decisions**:",
  prop_2: "One more line, at the end of that rollup:",
};

function seedThread() {
  const base = [
    ["user", "what changed in the vault today?"],
    [
      "assistant",
      "Three files were touched: **event-pipeline.md** (debounce notes), **side-projects.md** (two new tasks) and **cloud-keys.md** (rotated the Hetzner token). Nothing conflicts with origin/main.",
    ],
    ["user", "does the watcher handle atomic saves yet?"],
    [
      "assistant",
      "Only halfway. **fs.watch** reports `rename` for atomic saves and names the temp file, so you reconcile from disk after a 120ms debounce. Pushing that change out to open editors over SSE is still an open task.",
    ],
    ["user", "remind me what the secret block uses"],
    [
      "assistant",
      "age with an x25519 identity, armored into an `age` fence inside **keys/cloud-keys.md**. The plaintext never touches disk — it is decrypted in memory when you unlock it.",
    ],
    ["user", "summarize open tasks across my vault"],
    [
      "assistant",
      "You have **6 open tasks**: 2 in z-notes design (pick winning theme, write spec), 1 in event-pipeline (SSE push), 2 in side-projects, 1 in inbox. Want me to add a rollup section to [[z-notes-design]]?",
    ],
    ["user", "yes, add it"],
    ["assistant", PROPOSAL_INTRO.prop_1, "prop_1"],
    ["user", "good — track shipping round 2 in there too"],
    ["assistant", PROPOSAL_INTRO.prop_2, "prop_2"],
  ];
  return base.map((m, i) => ({
    id: "m" + (i + 1),
    role: m[0],
    content: m[1],
    proposalId: m[2] || null,
    at: iso(T0 - (base.length - i) * 45000),
  }));
}

const CANNED = [
  "Your vault has 7 docs across 4 folders; the largest is **z-notes-design.md**. Working tree is clean against **origin/main**.",
  "The watcher treats every fs event as a doorbell and reconciles from disk — that's why atomic saves from vim don't lose edits. Details are in [[event-pipeline]].",
  "That's already covered in **z-notes-design.md** under `API sketch` — no changes needed.",
  "Short answer: age with an x25519 identity, armored into an `age` fence. The passphrase only unwraps the identity once per session.",
  "Nothing actionable there yet — say the word if you want me to draft it as an edit and I'll put up a proposal card you can accept or reject.",
];

/* ============================================================
   STATE (module scope = the lifetime of this worker)
   ============================================================ */
const db = {
  docs: seedDocs(),
  tree: seedTree(),
  settings: seedSettings(),
  sync: { state: "synced", branch: "main", remote: "origin/main", lastSyncAt: T0 - 120000, ahead: 0, behind: 0 },
  proposals: seedProposals(),
  stack: [], // proposal ids, oldest → newest
  preimages: new Map(), // proposal id → markdown before it was applied
  session: null,
  msgSeq: 100,
  revSeq: 1,
  clientSeq: 0,
  eventSeq: 0,
};

function newSession(keepDivider) {
  db.session = {
    id: "sess_" + Math.random().toString(16).slice(2, 8),
    startedAt: Date.now(),
    contextDocPath: "architecture/z-notes-design.md",
    messages: keepDivider
      ? [
          { id: "m" + ++db.msgSeq, role: "system", kind: "divider", content: "context cleared", at: iso(Date.now()) },
          {
            id: "m" + ++db.msgSeq,
            role: "assistant",
            content:
              "Fresh session — the previous thread is out of context. Your vault and any applied changes are untouched. What should we look at?",
            proposalId: null,
            at: iso(Date.now()),
          },
        ]
      : seedThread(),
  };
  return db.session;
}
newSession(false);
db.session.id = "sess_4f1c9a";
db.session.startedAt = T0 - 540000;

/* ============================================================
   HELPERS
   ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(30 + Math.random() * 50);

function json(body, status, headers) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, headers || {}),
  });
}
const fail = (status, error, extra) => json(Object.assign({ error, message: extra && extra.message ? extra.message : error }, extra || {}), status);

const bytesOf = (s) => new TextEncoder().encode(s || "").length;
const nextRev = () => "r" + ++db.revSeq;

function safePath(p) {
  const s = decodeURIComponent(String(p || "")).replace(/^\/+/, "");
  if (!s || s.includes("..") || s.startsWith("/") || /\\/.test(s)) return null;
  return s;
}

function docMeta(d) {
  return {
    type: "file",
    path: d.path,
    name: d.name,
    title: d.title,
    slug: d.slug,
    bytes: bytesOf(d.markdown),
    mtime: iso(d.mtime),
    empty: !String(d.markdown).trim(),
    hasSecrets: !!d.hasSecrets,
  };
}
function docBody(d) {
  return Object.assign(docMeta(d), { markdown: d.markdown, rev: d.rev });
}

function treeOut(nodes) {
  return nodes
    .map((n) => {
      if (n.type === "folder") return { type: "folder", path: n.path, name: n.name, open: !!n.open, children: treeOut(n.children) };
      const d = db.docs.get(n.path);
      return d ? docMeta(d) : null;
    })
    .filter(Boolean);
}

function titleFrom(md, fallback) {
  const m = /^#\s+(.+)$/m.exec(md || "");
  return m ? m[1].trim() : fallback;
}

/* ============================================================
   SSE
   ============================================================ */
const streams = new Set();
let heartbeatTimer = null;

function frame(event, data) {
  return "id: " + ++db.eventSeq + "\nevent: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}
function broadcast(event, data) {
  const chunk = new TextEncoder().encode(frame(event, data));
  streams.forEach((s) => {
    try {
      s.controller.enqueue(chunk);
    } catch (e) {
      streams.delete(s);
    }
  });
}
function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!streams.size) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    broadcast("heartbeat", { t: iso(Date.now()) });
  }, 20000);
}

function openStream() {
  const enc = new TextEncoder();
  let self_ = null;
  const stream = new ReadableStream({
    start(controller) {
      self_ = { controller };
      streams.add(self_);
      controller.enqueue(enc.encode(": z-notes mock event stream\n\n"));
      controller.enqueue(enc.encode(frame("hello", { clientId: "c" + ++db.clientSeq, serverTime: iso(Date.now()) })));
      controller.enqueue(enc.encode(frame("sync-status", syncOut())));
      ensureHeartbeat();
    },
    cancel() {
      if (self_) streams.delete(self_);
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

function syncOut() {
  const mins = Math.max(0, Math.round((Date.now() - db.sync.lastSyncAt) / 60000));
  const when = db.sync.state === "syncing" ? "syncing…" : mins < 1 ? "synced just now" : "synced " + mins + " min ago";
  return {
    state: db.sync.state,
    branch: db.sync.branch,
    remote: db.sync.remote,
    lastSyncAt: iso(db.sync.lastSyncAt),
    ahead: db.sync.ahead,
    behind: db.sync.behind,
    message: when + " · " + db.sync.remote,
  };
}

let syncTimer = null;
function nudgeSync() {
  db.sync.state = "syncing";
  db.sync.ahead = db.sync.ahead + 1;
  broadcast("sync-status", syncOut());
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    db.sync.state = "synced";
    db.sync.ahead = 0;
    db.sync.lastSyncAt = Date.now();
    broadcast("sync-status", syncOut());
  }, 1100);
}

function docChanged(d, reason) {
  broadcast("doc-changed", { path: d.path, rev: d.rev, reason, bytes: bytesOf(d.markdown), mtime: iso(d.mtime) });
}

/* ============================================================
   FUZZY SEARCH (subsequence, same scoring the palette used inline)
   ============================================================ */
function fuzzy(q, hay) {
  if (!q) return { score: 0, idx: [] };
  const n = q.toLowerCase();
  const h = hay.toLowerCase();
  const idx = [];
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

function runSearch(q, limit) {
  const out = [];
  db.docs.forEach((doc, path) => {
    const name = path.split("/").pop();
    if (!q) {
      out.push({ kind: "doc", path, name, text: path, matches: [], score: 0 });
      return;
    }
    const nm = fuzzy(q, path);
    if (nm) out.push({ kind: "doc", path, name, text: path, matches: nm.idx, score: nm.score + 12 });
    const lines = String(doc.markdown || "").split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.length < 2) continue;
      const r = fuzzy(q, raw);
      if (r) hits.push({ kind: "line", path, name, line: i, text: raw, matches: r.idx, score: r.score });
    }
    hits.sort((a, b) => b.score - a.score);
    hits.slice(0, 2).forEach((h) => out.push(h));
  });
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit || 24);
}

/* ============================================================
   AI helpers
   ============================================================ */
function estTokens(session) {
  let chars = 0;
  session.messages.forEach((m) => {
    if (m.kind === "divider") return;
    chars += String(m.content || "").length;
    if (m.proposalId) {
      const p = db.proposals.find((x) => x.id === m.proposalId);
      if (p) chars += p.diff.reduce((a, d) => a + d.text.length + 2, 0);
    }
  });
  const ctx = db.docs.get(session.contextDocPath);
  if (ctx) chars += String(ctx.markdown || "").length;
  return Math.round(chars / 3.6);
}

function proposalOut(p) {
  const top = db.stack.length ? db.stack[db.stack.length - 1] : null;
  return {
    id: p.id,
    target: p.target,
    label: p.label,
    summary: p.summary,
    state: p.state,
    stats: p.stats,
    stackIndex: p.stackIndex,
    revertable: p.state === "applied" && top === p.id,
    diff: p.diff,
    edits: p.edits,
  };
}
function stackOut() {
  const top = db.stack.length ? db.stack[db.stack.length - 1] : null;
  return db.stack.map((id, i) => {
    const p = db.proposals.find((x) => x.id === id);
    return { id, label: p ? p.label : id, index: i + 1, revertable: id === top };
  });
}
function sessionOut(withMessages) {
  const s = db.session;
  const out = {
    id: s.id,
    startedAt: iso(s.startedAt),
    model: db.settings.ai.model,
    effort: db.settings.ai.effort,
    contextWindow: SETTINGS_META.contextWindow,
    contextDocPath: s.contextDocPath,
    messageCount: s.messages.filter((m) => m.kind !== "divider").length,
    tokensEstimated: estTokens(s),
  };
  if (withMessages !== false) out.messages = s.messages;
  return out;
}

/* apply one anchored edit; returns {ok, markdown} or {error} */
function applyEdit(md, edit) {
  const lines = md.split("\n");
  if (edit.op === "insert_after" || edit.op === "replace") {
    const anchor = edit.anchor.trim();
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === anchor) hits.push(i);
    if (hits.length === 0) return { error: "anchor-miss", anchor: edit.anchor };
    if (hits.length > 1) return { error: "anchor-ambiguous", anchor: edit.anchor };
    const at = hits[0];
    const ins = String(edit.text).split("\n");
    if (edit.op === "replace") lines.splice(at, 1, ...ins);
    else lines.splice(at + 1, 0, ...ins);
    return { ok: true, markdown: lines.join("\n") };
  }
  if (edit.op === "append") return { ok: true, markdown: md.replace(/\s*$/, "\n") + edit.text };
  return { error: "unsupported-op", op: edit.op };
}

/* ============================================================
   ROUTES
   ============================================================ */
async function handle(request, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === EVENTS && method === "GET") return openStream(); // no latency on the stream

  await latency();

  let body = null;
  if (method === "PUT" || method === "POST") {
    try {
      const t = await request.text();
      body = t ? JSON.parse(t) : {};
    } catch (e) {
      return fail(400, "bad-json", { message: "Body is not valid JSON." });
    }
  }

  const rest = path.slice(API.length); // e.g. "docs/architecture/x.md"

  /* ---------- docs ---------- */
  if (rest === "docs" && method === "GET") {
    return json({ vault: { name: "z-notes", root: "~/vault", docCount: db.docs.size }, tree: treeOut(db.tree) });
  }

  if (rest === "docs" && method === "POST") {
    const p = safePath(body.path);
    if (!p) return fail(400, "bad-path", { message: "Path escapes the vault." });
    const type = body.type === "folder" ? "folder" : "doc";
    if (type === "folder") {
      if (findFolder(db.tree, p)) return fail(409, "exists", { message: "That folder already exists." });
      insertNode(p, { type: "folder", path: p, name: p.split("/").pop(), open: true, children: [] });
      return json({ type: "folder", path: p, name: p.split("/").pop() }, 201);
    }
    const file = p.replace(/\.md$/i, "") + ".md";
    if (db.docs.has(file)) return fail(409, "exists", { message: "That doc already exists." });
    const slug = file.split("/").pop().replace(/\.md$/i, "");
    const md = typeof body.markdown === "string" ? body.markdown : "";
    const d = {
      path: file,
      name: file.split("/").pop(),
      title: titleFrom(md, slug),
      slug,
      markdown: md,
      rev: nextRev(),
      mtime: Date.now(),
    };
    db.docs.set(file, d);
    insertNode(file, { type: "file", path: file });
    docChanged(d, "created");
    nudgeSync();
    return json(docBody(d), 201);
  }

  if (rest.startsWith("docs/")) {
    const p = safePath(rest.slice("docs/".length));
    if (!p) return fail(400, "bad-path", { message: "Path escapes the vault." });
    const d = db.docs.get(p);
    if (!d) return fail(404, "not-found", { message: "No doc at " + p });
    if (method === "GET") return json(docBody(d));
    if (method === "PUT") {
      if (typeof body.markdown !== "string") return fail(400, "bad-body", { message: "markdown must be a string." });
      if (body.rev && body.rev !== d.rev) return fail(409, "rev-conflict", { rev: d.rev, message: "This doc changed since you read it." });
      d.markdown = body.markdown;
      d.title = titleFrom(d.markdown, d.slug);
      d.rev = nextRev();
      d.mtime = Date.now();
      docChanged(d, "write");
      nudgeSync();
      return json({ path: d.path, rev: d.rev, bytes: bytesOf(d.markdown), mtime: iso(d.mtime) });
    }
    if (method === "DELETE") return fail(501, "not-implemented", { message: "Delete is reserved in v0." });
    return fail(405, "method-not-allowed");
  }

  /* ---------- secrets ---------- */
  if (rest === "secrets/unlock" && method === "POST") {
    const p = safePath(body.path);
    const d = p && db.docs.get(p);
    if (!d) return fail(404, "not-found", { message: "No doc at " + body.path });
    if (!d.hasSecrets) return fail(404, "no-secret-block", { message: "That doc has no armored block." });
    if (!body.passphrase) return fail(401, "bad-passphrase", { message: "Passphrase required." });
    return json({ path: d.path, plaintext: SECRET_PLAIN, identity: "age · x25519" });
  }

  /* ---------- search ---------- */
  if (rest === "search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "24", 10) || 24);
    return json({ query: q, results: runSearch(q, limit) });
  }

  /* ---------- settings ---------- */
  if (rest === "settings" && method === "GET") return json({ settings: db.settings, meta: SETTINGS_META });
  if (rest === "settings" && method === "PUT") {
    if (body.theme && !SETTINGS_META.themes.some((t) => t.id === body.theme)) return fail(400, "unknown-theme", { message: "No such theme: " + body.theme });
    if (body.density && !SETTINGS_META.densities.some((t) => t.id === body.density)) return fail(400, "unknown-density");
    Object.keys(body).forEach((k) => {
      if (body[k] && typeof body[k] === "object" && !Array.isArray(body[k]) && db.settings[k] && typeof db.settings[k] === "object") {
        Object.assign(db.settings[k], body[k]);
      } else {
        db.settings[k] = body[k];
      }
    });
    return json({ settings: db.settings, meta: SETTINGS_META });
  }

  /* ---------- sync ---------- */
  if (rest === "sync/status" && method === "GET") return json(syncOut());

  /* ---------- ai ---------- */
  if (rest === "ai/sessions/current" && method === "GET") return json(sessionOut());
  if (rest === "ai/sessions" && method === "POST") {
    newSession(true); // the change stack deliberately survives: clearing context drops the thread, not the doc history
    return json(sessionOut(), 201);
  }

  if (rest === "ai/messages" && method === "POST") {
    const content = String(body.content || "").trim();
    if (!content) return fail(400, "empty-message", { message: "content is required." });
    if (body.docPath && db.docs.has(body.docPath)) db.session.contextDocPath = body.docPath;
    const now = Date.now();
    const um = { id: "m" + ++db.msgSeq, role: "user", content, proposalId: null, at: iso(now) };
    const am = {
      id: "m" + ++db.msgSeq,
      role: "assistant",
      content: CANNED[db.msgSeq % CANNED.length],
      proposalId: null,
      at: iso(now + 400),
    };
    db.session.messages.push(um, am);
    return json({ session: sessionOut(false), messages: [um, am], proposal: null });
  }

  if (rest === "ai/proposals" && method === "GET") return json({ proposals: db.proposals.map(proposalOut), stack: stackOut() });

  const pm = /^ai\/proposals\/([^/]+)\/(accept|revert|reject)$/.exec(rest);
  if (pm && method === "POST") {
    const p = db.proposals.find((x) => x.id === decodeURIComponent(pm[1]));
    if (!p) return fail(404, "not-found", { message: "No proposal " + pm[1] });
    const doc = db.docs.get(p.target);
    if (!doc) return fail(404, "not-found", { message: "Proposal targets a missing doc." });
    const action = pm[2];

    if (action === "accept") {
      if (p.state === "applied") return fail(409, "already-applied", { message: "That change is already on the stack." });
      let md = doc.markdown;
      for (const e of p.edits) {
        const r = applyEdit(md, e);
        if (r.error) return fail(422, r.error, { anchor: e.anchor, message: "The document moved under this proposal — re-ask the model." });
        md = r.markdown;
      }
      db.preimages.set(p.id, doc.markdown);
      doc.markdown = md;
      doc.title = titleFrom(md, doc.slug);
      doc.rev = nextRev();
      doc.mtime = Date.now();
      db.stack.push(p.id);
      p.state = "applied";
      p.stackIndex = db.stack.length;
      docChanged(doc, "proposal-accepted");
      nudgeSync();
      return json({ proposal: proposalOut(p), stack: stackOut(), doc: docBody(doc) });
    }

    if (action === "revert") {
      if (p.state !== "applied") return fail(409, "not-applied", { message: "That proposal is not on the stack." });
      const top = db.stack[db.stack.length - 1];
      if (top !== p.id) {
        const tp = db.proposals.find((x) => x.id === top);
        return fail(409, "not-stack-top", {
          requires: top,
          requiresIndex: db.stack.length,
          message: "revert #" + db.stack.length + " first" + (tp ? " (" + tp.label + ")" : ""),
        });
      }
      const pre = db.preimages.get(p.id);
      if (pre == null) return fail(500, "no-preimage", { message: "Lost the pre-image for that change." });
      doc.markdown = pre;
      doc.title = titleFrom(pre, doc.slug);
      doc.rev = nextRev();
      doc.mtime = Date.now();
      db.preimages.delete(p.id);
      db.stack.pop();
      p.state = "pending";
      p.stackIndex = null;
      docChanged(doc, "proposal-reverted");
      nudgeSync();
      return json({ proposal: proposalOut(p), stack: stackOut(), doc: docBody(doc) });
    }

    /* reject */
    if (p.state === "applied") return fail(409, "applied", { message: "Revert it before rejecting." });
    p.state = "rejected";
    return json({ proposal: proposalOut(p), stack: stackOut() });
  }

  return fail(404, "no-route", { message: method + " " + path + " is not part of the v0 contract." });
}

function findFolder(nodes, p) {
  for (const n of nodes) {
    if (n.type !== "folder") continue;
    if (n.path === p) return n;
    const f = findFolder(n.children, p);
    if (f) return f;
  }
  return null;
}

/* place a new node under its parent folder, creating folders as needed */
function insertNode(path, node) {
  const parts = path.split("/");
  parts.pop();
  let list = db.tree;
  let acc = "";
  for (const part of parts) {
    acc = acc ? acc + "/" + part : part;
    let f = findFolder(list, acc);
    if (!f) {
      f = { type: "folder", path: acc, name: part, open: true, children: [] };
      list.push(f);
    }
    f.open = true;
    list = f.children;
  }
  list.push(node);
}

/* ============================================================
   FETCH
   ============================================================ */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  const mine = url.origin === self.location.origin && (url.pathname === EVENTS || url.pathname.startsWith(API));
  if (mine) {
    event.respondWith(
      handle(req, url).catch((err) => fail(500, "mock-fault", { message: String((err && err.message) || err) }))
    );
    return;
  }

  /* Everything else: straight to the network, never cached. The point of this
     worker is the API, not offline. Navigations keep the browser's own
     behaviour so a hard reload works normally. */
  if (req.method === "GET" && url.origin === self.location.origin && req.mode !== "navigate") {
    event.respondWith(fetch(url.href, { cache: "no-store", credentials: "same-origin" }).catch(() => fetch(req)));
  }
});
