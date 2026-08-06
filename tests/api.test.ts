/* ============================================================
   CONTRACT GATE — prototypes/app/API.md (normative v0) + SPEC.md §3 deltas.

   The frontend talks to nothing but this contract, so every assertion here is
   something app.js/api.js would notice if it moved.

   SPEC §3 deltas encoded below:
     1. no /api/secrets/unlock (404 like any unknown route)
     2. PATCH / DELETE /api/docs/{path} are implemented (phase 5): rename/move
        rewrites backlinks, delete answers 204 and leaves backlinks broken
     3. PUT rev check is atomic; 409 carries {error, rev, markdown}
     4. POST /api/ai/messages STREAMS (text/event-stream); its terminal `done`
        event carries the JSON the non-streaming contract used to return
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startServer,
  makeVault,
  dropVault,
  readVaultText,
  readVaultBytes,
  encPath,
  refFuzzy,
  waitUntil,
  sleep,
  SEED_VAULT,
  MD_DESIGN,
  MD_HOMELAB,
  type TestServer,
} from "./helpers";
import { AiStream } from "./mock-upstream";

const ODD_PATH = "odd names/sp ace.md";
const ODD_MD = "# sp ace\n\nA doc whose folder AND filename both need percent-encoding.\n";

const SEED = { ...SEED_VAULT, [ODD_PATH]: ODD_MD };
const ALL_PATHS = Object.keys(SEED).sort((a, b) => a.localeCompare(b));

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
}, 30000);

afterAll(async () => {
  if (srv) await srv.stop();
});

/* ------------------------------------------------------------------ */

function flatten(nodes: any[]): any[] {
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      out.push(n);
      if (n.type === "folder") walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}
const files = (tree: any[]) => flatten(tree).filter((n) => n.type === "file");
const folders = (tree: any[]) => flatten(tree).filter((n) => n.type === "folder");
const byPath = (tree: any[], p: string) => flatten(tree).find((n) => n.path === p);

/* ============================================================
   process contract
   ============================================================ */
describe("process contract", () => {
  test("stdout announces readiness with exactly the agreed line", () => {
    const first = srv.stdoutLines.filter((l) => l.trim().length)[0];
    expect(first).toBe(`z-notes listening on http://localhost:${srv.port}`);
  });

  test("the sqlite index lives at <vault>/.znotes/index.db", async () => {
    await waitUntil(() => existsSync(join(srv.vault, ".znotes", "index.db")), {
      timeout: 5000,
      label: ".znotes/index.db",
    });
    expect(existsSync(join(srv.vault, ".znotes", "index.db"))).toBe(true);
  }, 10000);

  test("SIGTERM exits cleanly", async () => {
    const s = await startServer({ seed: { "a.md": "# a\n" } });
    const r = await s.get("/api/docs");
    expect(r.status).toBe(200);
    const code = await s.stop();
    expect(code).toBe(0);
  }, 30000);
});

/* ============================================================
   static frontend at the site root
   ============================================================ */
describe("static frontend", () => {
  test("GET / serves app/index.html", async () => {
    const res = await fetch(srv.url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="app"');
    expect(html).toContain('id="tree"');
  });

  test("GET /app.js and /api.js and /themes/base.css are served", async () => {
    for (const [p, type] of [
      ["/app.js", "javascript"],
      ["/api.js", "javascript"],
      ["/themes/base.css", "css"],
    ] as const) {
      const res = await fetch(srv.url(p));
      expect(`${p} → ${res.status}`).toBe(`${p} → 200`);
      expect(res.headers.get("content-type") ?? "").toContain(type);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  test("Bun.file responses carry a hand-rolled ETag that honours If-None-Match", async () => {
    const first = await fetch(srv.url("/app.js"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(typeof etag).toBe("string");
    expect((etag ?? "").length).toBeGreaterThan(0);
    await first.text();

    const second = await fetch(srv.url("/app.js"), { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);

    const bogus = await fetch(srv.url("/app.js"), { headers: { "if-none-match": '"not-the-etag"' } });
    expect(bogus.status).toBe(200);
    await bogus.text();
  });

  test("an unknown static path is 404, not the SPA shell", async () => {
    const res = await fetch(srv.url("/definitely-not-a-file.js"));
    expect(res.status).toBe(404);
    await res.text();
  });
});

/* ============================================================
   GET /api/docs — the tree
   ============================================================ */
describe("GET /api/docs", () => {
  test("vault header + full tree shape", async () => {
    const r = await srv.get("/api/docs");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");

    expect(typeof r.body.vault?.name).toBe("string");
    expect(typeof r.body.vault?.root).toBe("string");
    expect(r.body.vault.docCount).toBe(ALL_PATHS.length);
    expect(Array.isArray(r.body.tree)).toBe(true);

    const paths = files(r.body.tree)
      .map((n) => n.path)
      .sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(ALL_PATHS);
  });

  test("folders carry children; files carry metadata but never content", async () => {
    const r = await srv.get("/api/docs");
    const arch = byPath(r.body.tree, "architecture");
    expect(arch).toBeTruthy();
    expect(arch.type).toBe("folder");
    expect(arch.name).toBe("architecture");
    expect(Array.isArray(arch.children)).toBe(true);
    expect(arch.children.map((c: any) => c.path).sort()).toEqual([
      "architecture/event-pipeline.md",
      "architecture/z-notes-design.md",
    ]);

    const folderPaths = folders(r.body.tree)
      .map((n) => n.path)
      .sort();
    expect(folderPaths).toEqual(["architecture", "journal", "keys", "odd names", "projects"]);

    for (const f of files(r.body.tree)) {
      expect(f.markdown).toBeUndefined();
      expect(typeof f.name).toBe("string");
      expect(typeof f.title).toBe("string");
      expect(typeof f.slug).toBe("string");
      expect(typeof f.bytes).toBe("number");
      expect(Number.isFinite(Date.parse(f.mtime))).toBe(true);
      expect(typeof f.empty).toBe("boolean");
    }
  });

  test("slug, title, empty and hasSecrets are computed from the file", async () => {
    const r = await srv.get("/api/docs");
    const design = byPath(r.body.tree, "architecture/z-notes-design.md");
    expect(design.slug).toBe("z-notes-design");
    expect(design.title).toBe("z-notes design"); // first ATX h1
    expect(design.empty).toBe(false);
    expect(design.bytes).toBe(Buffer.byteLength(MD_DESIGN, "utf8"));
    expect(design.hasSecrets).toBe(false);

    const keys = byPath(r.body.tree, "keys/cloud-keys.md");
    expect(keys.hasSecrets).toBe(true); // the only doc with an ```age fence

    const inbox = byPath(r.body.tree, "inbox.md");
    expect(inbox.empty).toBe(true);
    expect(inbox.bytes).toBe(0);
    expect(inbox.slug).toBe("inbox");
    /* no H1 ⇒ the title falls back to the file NAME, exactly as the normative
       tree example in API.md shows ({"name":"inbox.md","title":"inbox.md"}) */
    expect(inbox.title).toBe("inbox.md");

    const body = await srv.doc("inbox.md");
    expect(body.body.title).toBe("inbox.md"); // and GET agrees with the tree
  });

  test(".znotes/ is never part of the tree", async () => {
    const r = await srv.get("/api/docs");
    const all = flatten(r.body.tree).map((n) => n.path);
    expect(all.some((p: string) => p === ".znotes" || p.startsWith(".znotes/"))).toBe(false);
  });
});

/* ============================================================
   GET / PUT a doc
   ============================================================ */
describe("GET/PUT /api/docs/{path}", () => {
  test("GET returns the doc body documented in API.md", async () => {
    const r = await srv.doc("architecture/event-pipeline.md");
    expect(r.status).toBe(200);
    expect(r.body.path).toBe("architecture/event-pipeline.md");
    expect(r.body.name).toBe("event-pipeline.md");
    expect(r.body.slug).toBe("event-pipeline");
    expect(r.body.title).toBe("Event pipeline");
    expect(typeof r.body.markdown).toBe("string");
    expect(typeof r.body.rev).toBe("string");
    expect(r.body.bytes).toBe(Buffer.byteLength(r.body.markdown, "utf8"));
    expect(r.body.hasSecrets).toBe(false);
  });

  test("GET an unknown doc → 404 not-found", async () => {
    const r = await srv.doc("nope/does-not-exist.md");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not-found");
  });

  test("PUT with a stale rev → 409 rev-conflict carrying the current rev AND the current markdown", async () => {
    const p = "projects/side-projects.md";
    const start = await srv.doc(p);
    const staleRev = start.body.rev;

    const winner = await srv.putDoc(p, start.body.markdown + "\nwinner\n", staleRev);
    expect(winner.status).toBe(200);
    const currentMarkdown = start.body.markdown + "\nwinner\n";

    const loser = await srv.putDoc(p, start.body.markdown + "\nloser\n", staleRev);
    expect(loser.status).toBe(409);
    expect(loser.body.error).toBe("rev-conflict");
    expect(loser.body.rev).toBe(winner.body.rev);
    expect(loser.body.markdown).toBe(currentMarkdown);

    /* the losing write must not have touched disk */
    expect(readVaultText(srv.vault, p)).toBe(currentMarkdown);

    await srv.putDoc(p, start.body.markdown, winner.body.rev); // restore
  });

  test("the rev check is atomic: concurrent writes from one rev produce exactly one winner", async () => {
    const p = "journal/2026-07-31.md";
    const start = await srv.doc(p);
    const rev = start.body.rev;

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => srv.putDoc(p, `# concurrent\n\nwriter ${i}\n`, rev))
    );
    const ok = attempts.filter((a) => a.status === 200);
    const conflict = attempts.filter((a) => a.status === 409);

    expect(ok.length).toBe(1);
    expect(conflict.length).toBe(7);
    for (const c of conflict) expect(c.body.error).toBe("rev-conflict");

    const onDisk = readVaultText(srv.vault, p);
    expect(onDisk).toMatch(/^# concurrent\n\nwriter [0-7]\n$/);
    const after = await srv.doc(p);
    expect(after.body.rev).toBe(ok[0].body.rev);
    expect(after.body.markdown).toBe(onDisk);
  }, 20000);

  test("PUT without a rev is a forced overwrite", async () => {
    const p = "inbox.md";
    const r = await srv.api("PUT", "/api/docs/" + encPath(p), { markdown: "# inbox\n\nforced\n" });
    expect(r.status).toBe(200);
    expect(readVaultText(srv.vault, p)).toBe("# inbox\n\nforced\n");
    expect(r.body.path).toBe(p);
    expect(r.body.bytes).toBe(Buffer.byteLength("# inbox\n\nforced\n", "utf8"));
    expect(Number.isFinite(Date.parse(r.body.mtime))).toBe(true);
  });

  test("PUT with a non-string markdown → 400", async () => {
    const r = await srv.api("PUT", "/api/docs/" + encPath("inbox.md"), { markdown: 42 });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });

  test("PUT to a doc that does not exist → 404 (create goes through POST /api/docs)", async () => {
    const r = await srv.putDoc("never/created.md", "# nope\n");
    expect(r.status).toBe(404);
    expect(existsSync(join(srv.vault, "never/created.md"))).toBe(false);
  });

  test("percent-encoded segments round-trip (folder and filename both contain a space)", async () => {
    const r = await srv.doc(ODD_PATH);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(ODD_PATH);
    expect(r.body.name).toBe("sp ace.md");
    expect(r.body.slug).toBe("sp ace");
    expect(r.body.markdown).toBe(ODD_MD);

    const next = ODD_MD + "\nedited through an encoded URL\n";
    const w = await srv.putDoc(ODD_PATH, next, r.body.rev);
    expect(w.status).toBe(200);
    expect(readVaultText(srv.vault, ODD_PATH)).toBe(next);

    /* the URL really is encoded, not smuggled raw */
    expect(encPath(ODD_PATH)).toBe("odd%20names/sp%20ace.md");

    await srv.putDoc(ODD_PATH, ODD_MD, w.body.rev);
  });
});

/* ============================================================
   POST /api/docs — create
   ============================================================ */
describe("POST /api/docs", () => {
  test("creates a doc, materialises implicit parents, returns the GET body shape", async () => {
    const p = "made/up/deep/note.md";
    const md = "# Made up\n\nbody\n";
    const r = await srv.api("POST", "/api/docs", { path: p, type: "doc", markdown: md });
    expect(r.status).toBe(201);
    expect(r.body.path).toBe(p);
    expect(r.body.name).toBe("note.md");
    expect(r.body.slug).toBe("note");
    expect(r.body.markdown).toBe(md);
    expect(typeof r.body.rev).toBe("string");

    expect(readVaultText(srv.vault, p)).toBe(md); // exact bytes, no template added

    const tree = await srv.get("/api/docs");
    expect(byPath(tree.body.tree, p)).toBeTruthy();
    expect(byPath(tree.body.tree, "made")?.type).toBe("folder");
    expect(byPath(tree.body.tree, "made/up")?.type).toBe("folder");
    expect(byPath(tree.body.tree, "made/up/deep")?.type).toBe("folder");
  });

  test("creating the same doc twice → 409 exists, and the first content survives", async () => {
    const p = "made/up/deep/note.md";
    const r = await srv.api("POST", "/api/docs", { path: p, type: "doc", markdown: "# clobber\n" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("exists");
    expect(readVaultText(srv.vault, p)).toBe("# Made up\n\nbody\n");
  });

  test("creating a doc emits doc-changed with reason 'created'", async () => {
    const sse = await srv.sse();
    try {
      await sse.waitFor("hello", { timeout: 5000 });
      const mark = sse.mark();
      const p = "made/announced.md";
      const r = await srv.api("POST", "/api/docs", { path: p, type: "doc", markdown: "# announced\n" });
      expect(r.status).toBe(201);
      const ev = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d && d.path === p,
        timeout: 5000,
      });
      expect(ev.data.reason).toBe("created");
      expect(ev.data.rev).toBe(r.body.rev);
    } finally {
      sse.close();
    }
  }, 20000);

  test("creates a folder (on disk, in the tree) and 409s on the second try", async () => {
    const p = "folder-a/sub";
    const r = await srv.api("POST", "/api/docs", { path: p, type: "folder" });
    expect(r.status).toBe(201);
    expect(r.body.type).toBe("folder");
    expect(r.body.path).toBe(p);
    expect(r.body.name).toBe("sub");
    expect(existsSync(join(srv.vault, p))).toBe(true);

    const tree = await srv.get("/api/docs");
    expect(byPath(tree.body.tree, p)?.type).toBe("folder");

    const again = await srv.api("POST", "/api/docs", { path: p, type: "folder" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("exists");
  });

  test("a doc created with no markdown is a real empty file", async () => {
    const p = "made/blank.md";
    const r = await srv.api("POST", "/api/docs", { path: p, type: "doc" });
    expect(r.status).toBe(201);
    expect(readVaultBytes(srv.vault, p).length).toBe(0);
    expect(r.body.markdown).toBe("");
    expect(r.body.empty).toBe(true);
  });
});

/* ============================================================
   path safety
   ============================================================ */
describe("path safety → 400 bad-path", () => {
  const escapes: Array<[string, string]> = [
    ["dot-dot in an encoded segment", "/api/docs/%2e%2e%2f%2e%2e%2fescape.md"],
    ["dot-dot smuggled inside one segment", "/api/docs/a%2f..%2fescape.md"],
    ["leading dot-dot", "/api/docs/..%2fescape.md"],
    ["absolute path", "/api/docs/%2Fetc%2Fpasswd"],
    ["home-relative absolute", "/api/docs/%2FUsers%2Fz%2F.ssh%2Fid_rsa"],
    ["the private .znotes dir", "/api/docs/.znotes/settings.toml"],
    ["the sqlite index", "/api/docs/.znotes%2Findex.db"],
    ["a nested .znotes dir", "/api/docs/notes/.znotes%2Fsneaky.md"],
  ];

  for (const [why, url] of escapes) {
    test(`GET rejects ${why}`, async () => {
      const r = await srv.api("GET", url);
      expect(`${url} → ${r.status}`).toBe(`${url} → 400`);
      expect(r.body?.error).toBe("bad-path");
    });
  }

  test("PUT rejects a path under .znotes/ and writes nothing", async () => {
    const r = await srv.api("PUT", "/api/docs/.znotes%2Fowned.md", { markdown: "# owned\n" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad-path");
    expect(existsSync(join(srv.vault, ".znotes", "owned.md"))).toBe(false);
  });

  test("POST rejects an escaping path in the body and writes nothing outside the vault", async () => {
    const outside = resolve(srv.vault, "..", "znotes-escape.md");
    for (const bad of ["../znotes-escape.md", "/etc/znotes-escape.md", ".znotes/evil.md", "a/../../b.md"]) {
      const r = await srv.api("POST", "/api/docs", { path: bad, type: "doc", markdown: "# pwned\n" });
      expect(`${bad} → ${r.status}`).toBe(`${bad} → 400`);
      expect(r.body.error).toBe("bad-path");
    }
    expect(existsSync(outside)).toBe(false);
  });

  test("a legitimate deep path is NOT rejected (bad-path is not a blanket 400)", async () => {
    const r = await srv.api("POST", "/api/docs", {
      path: "legit/deep/nested/ok.md",
      type: "doc",
      markdown: "# ok\n",
    });
    expect(r.status).toBe(201);
  });
});

/* ============================================================
   search
   ============================================================ */
describe("GET /api/search", () => {
  /** every `matches` array must be paintable onto `text` by the frontend */
  function assertHighlightable(q: string, r: any) {
    const chars = q.toLowerCase().replace(/\s+/g, "").split("");
    expect(Array.isArray(r.matches)).toBe(true);
    expect(r.matches.length).toBe(chars.length);
    let prev = -1;
    r.matches.forEach((at: number, i: number) => {
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThan(prev);
      expect(at).toBeLessThan(r.text.length);
      expect(r.text[at].toLowerCase()).toBe(chars[i]);
      prev = at;
    });
  }

  test("subsequence match over doc paths, with sw.js-compatible offsets", async () => {
    const q = "pipeline";
    const r = await srv.get(`/api/search?q=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    expect(r.body.query).toBe(q);
    expect(Array.isArray(r.body.results)).toBe(true);

    const hit = r.body.results.find(
      (x: any) => x.kind === "doc" && x.path === "architecture/event-pipeline.md"
    );
    expect(hit).toBeTruthy();
    expect(hit.name).toBe("event-pipeline.md");
    expect(hit.text).toBe("architecture/event-pipeline.md");
    expect(typeof hit.score).toBe("number");
    assertHighlightable(q, hit);
    expect(hit.matches).toEqual(refFuzzy(q, hit.text)!.idx);
  });

  test("subsequence match over content lines, with the right 0-based line number", async () => {
    const q = "quokka";
    const r = await srv.get(`/api/search?q=${q}`);
    expect(r.status).toBe(200);

    const hit = r.body.results.find((x: any) => x.kind === "line" && x.path === "projects/homelab.md");
    expect(hit).toBeTruthy();

    const sourceLines = MD_HOMELAB.split("\n");
    expect(hit.line).toBe(2);
    expect(hit.text).toBe(sourceLines[hit.line].trim());
    expect(hit.name).toBe("homelab.md");
    assertHighlightable(q, hit);
    expect(hit.matches).toEqual(refFuzzy(q, hit.text)!.idx);
  });

  test("every line result points at the line it claims, in the file it claims", async () => {
    const q = "the";
    const r = await srv.get(`/api/search?q=${q}&limit=50`);
    expect(r.status).toBe(200);
    const lineHits = r.body.results.filter((x: any) => x.kind === "line");
    expect(lineHits.length).toBeGreaterThan(0);
    for (const h of lineHits) {
      const src = readVaultText(srv.vault, h.path).split("\n");
      expect(Number.isInteger(h.line)).toBe(true);
      expect(h.line).toBeGreaterThanOrEqual(0);
      expect(h.line).toBeLessThan(src.length);
      expect(`${h.path}:${h.line} → ${h.text}`).toBe(`${h.path}:${h.line} → ${src[h.line].trim()}`);
      assertHighlightable(q, h);
    }
  });

  test("every result declares kind doc|line and a real vault path", async () => {
    const r = await srv.get(`/api/search?q=note&limit=50`);
    const known = new Set(files((await srv.get("/api/docs")).body.tree).map((n) => n.path));
    expect(r.body.results.length).toBeGreaterThan(0);
    for (const x of r.body.results) {
      expect(["doc", "line"]).toContain(x.kind);
      expect(known.has(x.path)).toBe(true);
      expect(typeof x.text).toBe("string");
      if (x.kind === "line") expect(Number.isInteger(x.line)).toBe(true);
      else expect(x.text).toBe(x.path);
    }
  });

  test("an empty q returns every doc, kind:doc, path-ordered", async () => {
    const r = await srv.get("/api/search?q=");
    expect(r.status).toBe(200);
    const tree = await srv.get("/api/docs");
    const all = files(tree.body.tree)
      .map((n) => n.path)
      .sort((a, b) => a.localeCompare(b));

    expect(r.body.results.every((x: any) => x.kind === "doc")).toBe(true);
    expect(r.body.results.map((x: any) => x.path)).toEqual(all);
    expect(r.body.results.every((x: any) => Array.isArray(x.matches) && x.matches.length === 0)).toBe(true);
  });

  test("limit is honoured", async () => {
    const wide = await srv.get("/api/search?q=e&limit=50");
    expect(wide.body.results.length).toBeGreaterThan(3);

    const narrow = await srv.get("/api/search?q=e&limit=3");
    expect(narrow.body.results.length).toBe(3);

    const one = await srv.get("/api/search?q=e&limit=1");
    expect(one.body.results.length).toBe(1);
  });

  test("a query nothing matches returns an empty result list, not an error", async () => {
    const r = await srv.get("/api/search?q=" + encodeURIComponent("zzqzzqzzqzzq"));
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);
  });

  /**
   * The seeded vault has fewer than 24 docs, so the default limit and the cap
   * are invisible to every test above — including for empty `q`, where API.md
   * ("an empty q returns every doc") and sw.js (`out.slice(0, limit || 24)`,
   * with limit capped at 100) read differently. sw.js is the tie-breaker for an
   * API.md ambiguity, so `limit` applies to empty `q` exactly as to any query.
   */
  test("limit default (24) and cap (100) apply to empty q as well as to a query", async () => {
    const seed: Record<string, string> = {};
    for (let i = 1; i <= 130; i++) {
      const n = String(i).padStart(3, "0");
      seed[`doc-${n}.md`] = `# doc ${n}\n\nalpha bravo charlie ${n}\n`;
    }
    const big = await startServer({ seed });
    try {
      const count = async (qs: string) => (await big.get(`/api/search?${qs}`)).body.results.length;

      // the vault really is bigger than every bound under test
      expect(files((await big.get("/api/docs")).body.tree).length).toBe(130);

      expect(await count("q=")).toBe(24); // default
      expect(await count("q=&limit=5")).toBe(5); // explicit, empty q
      expect(await count("q=&limit=1000")).toBe(100); // cap, empty q
      expect(await count("q=alpha")).toBe(24); // default, real query
      expect(await count("q=alpha&limit=3")).toBe(3);
      expect(await count("q=alpha&limit=1000")).toBe(100); // cap, real query
    } finally {
      await big.stop();
    }
  }, 30000);
});

/* ============================================================
   settings
   ============================================================ */
describe("/api/settings", () => {
  test("GET returns settings + server-declared meta", async () => {
    const r = await srv.get("/api/settings");
    expect(r.status).toBe(200);
    const { settings: s, meta: m } = r.body;

    expect(Array.isArray(m.themes)).toBe(true);
    expect(m.themes.map((t: any) => t.id).sort()).toEqual(["minimal", "modern", "terminal"]);
    for (const t of m.themes) expect(typeof t.label).toBe("string");
    expect(m.densities.map((d: any) => d.id).sort()).toEqual(["comfy", "compact"]);
    expect(m.efforts).toEqual(["low", "medium", "high"]);
    expect(m.colorSchemes).toEqual(["system", "dark", "light"]);
    expect(typeof m.contextWindow).toBe("number");

    /* every value the settings UI paints must exist and be legal */
    expect(m.themes.some((t: any) => t.id === s.theme)).toBe(true);
    expect(m.densities.some((d: any) => d.id === s.density)).toBe(true);
    expect(m.colorSchemes).toContain(s.colorScheme);
    expect(typeof s.editor.autosaveSeconds).toBe("number");
    expect(typeof s.editor.clickToEdit).toBe("boolean");
    expect(typeof s.git.branch).toBe("string");
    expect(typeof s.git.autoSync).toBe("boolean");
    expect(typeof s.ai.baseUrl).toBe("string");
    expect(typeof s.ai.model).toBe("string");
    expect(m.efforts).toContain(s.ai.effort);
  });

  test("PUT deep-merges one level and leaves siblings alone", async () => {
    const before = await srv.get("/api/settings");
    const keepClickToEdit = before.body.settings.editor.clickToEdit;

    const r = await srv.api("PUT", "/api/settings", {
      theme: "terminal",
      editor: { autosaveSeconds: 20 },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.theme).toBe("terminal");
    expect(r.body.settings.editor.autosaveSeconds).toBe(20);
    expect(r.body.settings.editor.clickToEdit).toBe(keepClickToEdit);
    expect(r.body.settings.git.branch).toBe(before.body.settings.git.branch);
    expect(r.body.meta.themes.length).toBe(before.body.meta.themes.length);

    const after = await srv.get("/api/settings");
    expect(after.body.settings.theme).toBe("terminal");
    expect(after.body.settings.editor.autosaveSeconds).toBe(20);
  });

  test("settings persist to .znotes/settings.toml", async () => {
    await srv.api("PUT", "/api/settings", { theme: "minimal" });
    const toml = await waitUntil(
      () => {
        const p = join(srv.vault, ".znotes", "settings.toml");
        if (!existsSync(p)) return null;
        const t = readFileSync(p, "utf8");
        return t.includes("minimal") ? t : null;
      },
      { timeout: 4000, label: ".znotes/settings.toml to record theme=minimal" }
    );
    expect(toml).toContain("minimal");
    await srv.api("PUT", "/api/settings", { theme: "terminal" });
  }, 10000);

  test("an unknown theme is 400 unknown-theme and changes nothing", async () => {
    const before = await srv.get("/api/settings");
    const r = await srv.api("PUT", "/api/settings", { theme: "vaporwave" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown-theme");
    const after = await srv.get("/api/settings");
    expect(after.body.settings.theme).toBe(before.body.settings.theme);
  });

  test("a stored git token comes back masked and never raw (write channel: git.token)", async () => {
    const RAW = "ghp_TESTONLY_9f3kx2Qm7Lp0_ZZTAILZZ";
    const w = await srv.api("PUT", "/api/settings", { git: { token: RAW } });
    expect(w.status).toBe(200);
    expect(w.text).not.toContain(RAW);

    const r = await srv.get("/api/settings");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(RAW);
    expect(typeof r.body.settings.git.tokenMasked).toBe("string");
    expect(r.body.settings.git.tokenMasked.length).toBeGreaterThan(0);
    expect(r.body.settings.git.tokenMasked).not.toBe(RAW);
    expect(r.body.settings.git.token).toBeUndefined();
  });

  test("a stored git token comes back masked and never raw (write channel: git.tokenMasked — what the shipped settings UI sends)", async () => {
    const RAW = "ghp_UIWRITE_7Lp0Qm2kx3f9_TAILTAIL";
    const w = await srv.api("PUT", "/api/settings", { git: { tokenMasked: RAW } });
    expect(w.status).toBe(200);
    expect(w.text).not.toContain(RAW);

    const r = await srv.get("/api/settings");
    expect(r.text).not.toContain(RAW);
    expect(r.body.settings.git.tokenMasked).not.toBe(RAW);
  });

  test("an AI api key comes back masked and never raw", async () => {
    const RAW = "sk-proj-TESTONLY-7hQ2vN8xR1-ZZTAILZZ";
    const w = await srv.api("PUT", "/api/settings", { ai: { apiKey: RAW } });
    expect(w.status).toBe(200);
    expect(w.text).not.toContain(RAW);

    const r = await srv.get("/api/settings");
    expect(r.text).not.toContain(RAW);
    expect(typeof r.body.settings.ai.apiKeyMasked).toBe("string");
    expect(r.body.settings.ai.apiKey).toBeUndefined();
  });

  /**
   * Regression: every masking test above uses a >20-char credential, which is
   * exactly why a "short values echo unchanged" branch in mask() went unnoticed
   * and served the shipped 16-char fixture token raw. API.md is unconditional —
   * "the raw token/key never leaves the server" — so length must not matter.
   */
  test.each([
    ["shorter than the fixture token", "ghp_short1"],
    ["exactly the API.md fixture length", "ghp_9f3kx2Qm7Lp0"],
    ["a mid-length key", "sk-proj-7hQ2vN8xR1"],
    ["a realistic 40-char PAT", "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6".slice(0, 36)],
  ])("a %s credential is never echoed raw", async (_why, RAW) => {
    const w = await srv.api("PUT", "/api/settings", { git: { token: RAW } });
    expect(w.status).toBe(200);
    expect(w.text).not.toContain(RAW);

    const r = await srv.get("/api/settings");
    expect(r.text).not.toContain(RAW);
    expect(r.body.settings.git.tokenMasked).not.toBe(RAW);
    expect(r.body.settings.git.token).toBeUndefined();

    // the mask must still be a non-empty, displayable hint for the settings input
    expect(r.body.settings.git.tokenMasked.length).toBeGreaterThan(0);

    // and re-submitting the mask untouched (what the UI does when the user edits
    // some other field) must not overwrite the stored credential with the mask
    const shown = r.body.settings.git.tokenMasked;
    await srv.api("PUT", "/api/settings", { git: { tokenMasked: shown } });
    const again = await srv.get("/api/settings");
    expect(again.body.settings.git.tokenMasked).toBe(shown);
    expect(again.text).not.toContain(RAW);
  });

  /**
   * SPEC §7: settings.toml is committed, credentials live in sqlite only. A
   * hand-edited (or historical) settings.toml carrying a raw token must be
   * absorbed into sqlite and rewritten *without* it on boot — otherwise the
   * next `git commit` publishes the secret. Untested until now, and it is a
   * one-shot path, so a regression would be silent.
   */
  test("raw credentials in settings.toml are absorbed into sqlite and stripped from the file on boot", async () => {
    const TOKEN = "ghp_FROMTOML_9f3kx2Qm7Lp0_TAILAAAA";
    const KEY = "sk-proj-FROMTOML-7hQ2vN8xR1-TAILBBBB";
    const toml = [
      'theme = "modern"',
      "",
      "[git]",
      'branch = "main"',
      `token = "${TOKEN}"`,
      "",
      "[ai]",
      `apiKey = "${KEY}"`,
      "",
    ].join("\n");

    const s2 = await startServer({ seed: { ".znotes/settings.toml": toml, "note.md": "# note\n" } });
    try {
      const onDisk = await waitUntil(
        () => {
          const p = join(s2.vault, ".znotes", "settings.toml");
          if (!existsSync(p)) return null;
          const t = readFileSync(p, "utf8");
          return t.includes(TOKEN) || t.includes(KEY) ? null : t;
        },
        { timeout: 5000, label: "settings.toml to be rewritten without credentials" }
      );

      // the committed file is clean...
      expect(onDisk).not.toContain(TOKEN);
      expect(onDisk).not.toContain(KEY);
      // no credential *assignment* survives (the file's header comment may
      // legitimately mention the words "git token" / "AI key")
      const assignments = onDisk
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .map((l) => l.split("=")[0].trim());
      expect(assignments).not.toContain("token");
      expect(assignments).not.toContain("apiKey");
      expect(assignments).not.toContain("tokenMasked");
      expect(assignments).not.toContain("apiKeyMasked");
      // ...but the non-secret settings it carried survived
      expect(onDisk).toContain('branch = "main"');

      // ...the credential is retained (masked over the wire, raw nowhere)
      const r = await s2.get("/api/settings");
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(KEY);
      expect(r.body.settings.git.tokenMasked.length).toBeGreaterThan(0);
      expect(r.body.settings.ai.apiKeyMasked.length).toBeGreaterThan(0);

      // ...and it really is in sqlite, not merely discarded
      const db = readFileSync(join(s2.vault, ".znotes", "index.db"));
      const wal = join(s2.vault, ".znotes", "index.db-wal");
      const blob = Buffer.concat([db, existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]).toString("latin1");
      expect(blob).toContain(TOKEN);
      expect(blob).toContain(KEY);
    } finally {
      await s2.stop();
    }
  }, 30000);

  /**
   * settings.toml is committed and pulled (SPEC §7), so it can arrive from
   * another machine carrying anything at all — and `load()` re-reads it live,
   * not only at boot. `git.branch` has been held to the same standard as PUT
   * since healGit; `ai.baseUrl` — the address the server fires the AI
   * credential at, unattended, on the very next turn — was not, so a pulled
   * file could put `file://`, `gopher://` or a bare hostname there, every one
   * of which PUT rejects. Heal, do not throw: a bad line must not stop boot.
   */
  test("a hostile ai.baseUrl in settings.toml is healed on load, exactly as PUT would reject it", async () => {
    const { DEFAULTS } = await import("../server/settings");

    for (const bad of ["file:///etc/passwd", "gopher://evil.example:70/", "not a url at all"]) {
      const toml = ['theme = "modern"', "", "[ai]", `baseUrl = ${JSON.stringify(bad)}`, ""].join("\n");
      const s2 = await startServer({ seed: { ".znotes/settings.toml": toml, "note.md": "# note\n" } });
      try {
        /* precondition: PUT has always refused this value */
        const put = await s2.api("PUT", "/api/settings", { ai: { baseUrl: bad } });
        expect(`PUT ai.baseUrl=${JSON.stringify(bad)} → ${put.status}`).toBe(
          `PUT ai.baseUrl=${JSON.stringify(bad)} → 400`
        );

        const r = await s2.get("/api/settings");
        expect(`load kept ai.baseUrl=${JSON.stringify(bad)}: ${r.body.settings.ai.baseUrl === bad}`).toBe(
          `load kept ai.baseUrl=${JSON.stringify(bad)}: false`
        );
        expect(`healed to the default: ${r.body.settings.ai.baseUrl}`).toBe(
          `healed to the default: ${DEFAULTS.ai.baseUrl}`
        );

        // and the healed value is written back, so the next pull starts clean
        const onDisk = await waitUntil(
          () => {
            const p = join(s2.vault, ".znotes", "settings.toml");
            if (!existsSync(p)) return null;
            const t = readFileSync(p, "utf8");
            return t.includes(bad.trim() || " IMPOSSIBLE") ? null : t;
          },
          { timeout: 5000, label: "settings.toml to be rewritten without the hostile baseUrl" }
        );
        expect(onDisk).toContain(`baseUrl = ${JSON.stringify(DEFAULTS.ai.baseUrl)}`);
      } finally {
        await s2.stop();
      }
    }
  }, 60000);

  test("a legal ai.baseUrl in settings.toml still survives load (heal, not clobber)", async () => {
    const url = "https://ai.example.test/v1";
    const toml = ['theme = "modern"', "", "[ai]", `baseUrl = "  ${url}  "`, ""].join("\n");
    const s2 = await startServer({ seed: { ".znotes/settings.toml": toml, "note.md": "# note\n" } });
    try {
      const r = await s2.get("/api/settings");
      // trimmed, exactly as PUT trims — but kept
      expect(`ai.baseUrl after load: ${r.body.settings.ai.baseUrl}`).toBe(`ai.baseUrl after load: ${url}`);
    } finally {
      await s2.stop();
    }
  }, 30000);

  test("credentials never reach the committed settings.toml (SPEC §7: sqlite only)", async () => {
    const p = join(srv.vault, ".znotes", "settings.toml");
    expect(existsSync(p)).toBe(true);
    const toml = readFileSync(p, "utf8");
    expect(toml).not.toContain("ghp_TESTONLY_9f3kx2Qm7Lp0_ZZTAILZZ");
    expect(toml).not.toContain("ghp_UIWRITE_7Lp0Qm2kx3f9_TAILTAIL");
    expect(toml).not.toContain("sk-proj-TESTONLY-7hQ2vN8xR1-ZZTAILZZ");
  });
});

/* ============================================================
   sync — API.md "Sync" + SPEC §7.

   This fixture's vault is a plain directory, never a checkout, so it pins the
   documented degraded path: "offline means the vault directory is not a git
   repository at all (message: 'not a git repository'); the server is otherwise
   fully functional." The repo/remote/rebase/conflict paths live in
   tests/gitsync.test.ts against real checkouts.
   ============================================================ */
describe("sync against a vault that is not a git repository", () => {
  test("GET /api/sync/status returns exactly the documented offline object", async () => {
    const r = await srv.get("/api/sync/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      state: "offline",
      branch: "main", // git.branch default, echoed even while offline
      remote: null,
      lastSyncAt: null,
      ahead: 0,
      behind: 0,
      message: "not a git repository",
    });
  });

  test("POST /api/sync/now answers 200 with the same object and never runs git init", async () => {
    // SPEC §7 / git.ts: an un-initialised vault stays un-initialised. A manual
    // "Sync now" must degrade, not silently create a repo the user never asked for.
    const r = await srv.api("POST", "/api/sync/now", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      state: "offline",
      branch: "main",
      remote: null,
      lastSyncAt: null,
      ahead: 0,
      behind: 0,
      message: "not a git repository",
    });
    expect(existsSync(join(srv.vault, ".git"))).toBe(false);
  });

  test("the vault stays fully functional while sync is offline", async () => {
    // "the server is otherwise fully functional" — a doc round-trips after the
    // failed sync, so an offline git layer can never gate the docs API.
    const p = "notes/offline-sync-still-writable.md";
    const md = "# still writable\n\nsync being offline blocks nothing.\n";
    const made = await srv.api("POST", "/api/docs", { path: p, type: "doc", markdown: md });
    expect(made.status).toBe(201);
    expect(readVaultText(srv.vault, p)).toBe(md);

    const edited = md + "\nand edits land too.\n";
    const put = await srv.putDoc(p, edited, made.body.rev);
    expect(put.status).toBe(200);
    expect(readVaultText(srv.vault, p)).toBe(edited);

    const after = await srv.get("/api/sync/status");
    expect(after.status).toBe(200);
    expect(after.body.state).toBe("offline");
  });

  test("the status object never carries the stored GitHub token (SPEC §7)", async () => {
    // A token was PUT into settings earlier in this file and lives in sqlite.
    // It must appear in no response — the raw text, not just the parsed body.
    const r = await srv.get("/api/sync/status");
    expect(r.text).not.toContain("ghp_TESTONLY_9f3kx2Qm7Lp0_ZZTAILZZ");
    expect(r.text).not.toContain("ghp_UIWRITE_7Lp0Qm2kx3f9_TAILTAIL");

    const now = await srv.api("POST", "/api/sync/now", {});
    expect(now.text).not.toContain("ghp_TESTONLY_9f3kx2Qm7Lp0_ZZTAILZZ");
    expect(now.text).not.toContain("ghp_UIWRITE_7Lp0Qm2kx3f9_TAILTAIL");
  });

  test("the sync routes reject the wrong method rather than falling through to 404", async () => {
    const a = await srv.api("POST", "/api/sync/status", {});
    expect(a.status).toBe(405);
    expect(a.body.error).toBe("method-not-allowed");

    const b = await srv.get("/api/sync/now");
    expect(b.status).toBe(405);
    expect(b.body.error).toBe("method-not-allowed");
  });
});

/* ============================================================
   AI session / proposal surface (SPEC §3 delta 4)

   The relay itself is exercised against a scripted upstream in ai.test.ts.
   What is pinned HERE is the part of the contract app.js/api.js binds to
   regardless of what the endpoint does: the session object, the *shape* of a
   turn, and the fact that a turn is a stream whose terminal `done` event is
   the JSON the non-streaming contract used to return.
   ============================================================ */
describe("AI session and message contract", () => {
  test("GET /api/ai/sessions/current lazily creates one persistent session", async () => {
    const a = await srv.get("/api/ai/sessions/current");
    expect(a.status).toBe(200);
    expect(typeof a.body.id).toBe("string");
    expect(a.body.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(a.body.startedAt))).toBe(true);
    expect(typeof a.body.model).toBe("string");
    expect(typeof a.body.effort).toBe("string");
    expect(typeof a.body.contextWindow).toBe("number");
    expect(typeof a.body.messageCount).toBe("number");
    expect(typeof a.body.tokensEstimated).toBe("number");
    expect(Array.isArray(a.body.messages)).toBe(true);

    const b = await srv.get("/api/ai/sessions/current");
    expect(b.body.id).toBe(a.body.id); // lazily created ONCE, then persistent
  });

  /* An earlier `/api/settings` test put an AI key in sqlite, and the shipped
     default base URL points at a local proxy. Blank the base URL so this
     describe exercises the contract rather than whatever happens to be
     listening on this machine — the relay-with-an-endpoint cases live in
     ai.test.ts against a scripted upstream. */
  beforeAll(async () => {
    const r = await srv.api("PUT", "/api/settings", { ai: { baseUrl: "" } });
    expect(r.status).toBe(200);
  });

  /* SPEC §3 delta 4: this route streams. The old blob response is gone, but
     every guarantee it carried has to survive the change of transport — the
     user turn is persisted, an assistant turn always answers it, and a turn
     that produced no edit says `proposal: null` rather than omitting it. */
  test("POST /api/ai/messages streams, and its terminal `done` carries the whole turn", async () => {
    const before = await srv.get("/api/ai/sessions/current");
    const content = "what is in my vault?";

    const s = await AiStream.open(srv, { content, docPath: "architecture/z-notes-design.md" });
    await s.wait(20000);

    expect(s.status).toBe(200);
    expect(s.contentType).toContain("text/event-stream");
    expect(s.json).toBe(null); // not a JSON blob any more

    // `done` terminates the stream and is the client's single completion point
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.events[s.events.length - 1].event).toBe("done");
    expect(s.of("done").length).toBe(1);

    const done = s.done();
    expect(Object.keys(done).sort()).toEqual(["messages", "proposal", "session"]);
    expect(Array.isArray(done.messages)).toBe(true);
    expect(done.messages.length).toBe(2);

    const [um, am] = done.messages;
    expect(um.role).toBe("user");
    expect(um.content).toBe(content);
    expect(am.role).toBe("assistant");
    expect(am.proposalId ?? null).toBe(null);
    expect(done.proposal).toBe(null);
    expect(done.session?.id).toBe(before.body.id);

    /* with no endpoint configured the turn still ENDS, and it ends loudly: an
       error frame the UI can badge, plus an assistant turn that says the same
       thing, so the thread is never left with a question and no answer */
    const errs = s.errors();
    expect(errs.length).toBe(1);
    expect(errs[0].code).toBe("ai-unconfigured");
    expect(errs[0].message).toContain("base URL");
    expect(am.content).toBe(errs[0].message);

    const after = await srv.get("/api/ai/sessions/current");
    expect(after.body.id).toBe(before.body.id);
    expect(after.body.messageCount).toBe(before.body.messageCount + 2);
    const tail = after.body.messages.slice(-2);
    expect(tail[0].content).toBe(content);
    expect(tail[1].content).toBe(am.content);
  });

  test("POST /api/ai/messages with an empty body is 400, not a stream", async () => {
    const r = await srv.api("POST", "/api/ai/messages", { content: "   " });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("empty-message");
    expect(String(r.headers.get("content-type"))).toContain("application/json");
  });

  test("POST /api/ai/sessions starts a fresh session opened by a system divider", async () => {
    const old = await srv.get("/api/ai/sessions/current");
    const r = await srv.api("POST", "/api/ai/sessions", {});
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(old.body.id);
    expect(Array.isArray(r.body.messages)).toBe(true);
    expect(r.body.messages.length).toBeGreaterThan(0);
    expect(r.body.messages[0].role).toBe("system");
    expect(r.body.messages[0].kind).toBe("divider");

    const cur = await srv.get("/api/ai/sessions/current");
    expect(cur.body.id).toBe(r.body.id);
    expect(cur.body.messages[0].kind).toBe("divider");
  });

  test("GET /api/ai/proposals is empty until a turn actually proposes something", async () => {
    const r = await srv.get("/api/ai/proposals");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ proposals: [], stack: [] });
  });

  test("accept / revert / reject are 404 while there are no proposals", async () => {
    for (const action of ["accept", "revert", "reject"]) {
      const r = await srv.api("POST", `/api/ai/proposals/prop_1/${action}`, {});
      expect(`${action} → ${r.status}`).toBe(`${action} → 404`);
    }
  });

  test("the AI session survives a restart (sqlite, not memory)", async () => {
    const vault = makeVault({ "a.md": "# a\n" });
    try {
      const first = await startServer({ vault });
      const marker = "restart marker " + Date.now();
      await first.api("POST", "/api/ai/messages", { content: marker });
      const s1 = await first.get("/api/ai/sessions/current");
      await first.stop();

      const second = await startServer({ vault });
      const s2 = await second.get("/api/ai/sessions/current");
      expect(s2.body.id).toBe(s1.body.id);
      expect(JSON.stringify(s2.body.messages)).toContain(marker);
      await second.stop();
    } finally {
      dropVault(vault);
    }
  }, 45000);
});

/* ============================================================
   SPEC §3 deltas
   ============================================================ */
describe("phase-1 deltas", () => {
  /**
   * Delta 2 said "currently 501" of the mock; phase 5 is where the two routes
   * become real, so the gate flips from "must not exist" to "must answer the
   * shape app.js branches on". Depth — commits, byte-fidelity, collisions,
   * fence safety, rollback — is fileops.test.ts; what belongs HERE is only the
   * contract surface, on throwaway paths so the shared vault stays seeded.
   */
  test("PATCH /api/docs/{path} moves the doc, rewrites backlinks and retires the old path", async () => {
    const from = "delta2/move-me.md";
    const to = "delta2/moved.md";
    const ref = "delta2/refers.md";
    expect((await srv.api("POST", "/api/docs", { path: from, type: "doc", markdown: "# move me\n" })).status).toBe(201);
    expect(
      (await srv.api("POST", "/api/docs", { path: ref, type: "doc", markdown: "see [[move-me]] for details\n" })).status
    ).toBe(201);

    const r = await srv.api("PATCH", "/api/docs/" + encPath(from), { to });
    expect(`PATCH → ${r.status}`).toBe("PATCH → 200");
    expect(r.body.error).toBeUndefined();
    expect(r.body.path).toBe(to);
    expect(r.body.from).toBe(from);
    expect(r.body.type).toBe("file");
    expect(typeof r.body.rev).toBe("string");
    /* occurrences rewritten, and the docs they were rewritten in — never the
       moved doc itself, whose bytes a rename must not touch */
    expect(r.body.backlinksUpdated).toBe(1);
    expect(r.body.updated).toEqual([ref]);

    expect(existsSync(join(srv.vault, from))).toBe(false);
    expect(existsSync(join(srv.vault, to))).toBe(true);
    expect((await srv.doc(from)).status).toBe(404);
    expect((await srv.doc(to)).status).toBe(200);
    expect(readVaultText(srv.vault, ref)).toBe("see [[moved]] for details\n");

    /* and the moved doc is byte-identical — a move is rename(2), not a rewrite */
    expect(readVaultText(srv.vault, to)).toBe("# move me\n");
  });

  test("DELETE /api/docs/{path} → 204 with no body, and the doc stops resolving", async () => {
    const p = "delta2/doomed.md";
    expect((await srv.api("POST", "/api/docs", { path: p, type: "doc", markdown: "# doomed\n" })).status).toBe(201);
    expect(existsSync(join(srv.vault, p))).toBe(true);

    const r = await srv.api("DELETE", "/api/docs/" + encPath(p));
    expect(`DELETE → ${r.status}`).toBe("DELETE → 204");
    expect(r.text).toBe("");
    expect(existsSync(join(srv.vault, p))).toBe(false);
    expect((await srv.doc(p)).status).toBe(404);

    /* deleting what is not there is 404, not a silent success */
    const again = await srv.api("DELETE", "/api/docs/" + encPath(p));
    expect(again.status).toBe(404);
    expect(again.body.error).toBe("not-found");
  });

  /**
   * The route is gone, but "gone" has to be legible: the shipped frontend still
   * has an Unlock button, and `apiFail` toasts `message` verbatim. A generic
   * no-route answer surfaces a router internal in the UI and gives the client
   * no slug to branch on for the SPEC §6 degraded state.
   */
  test("/api/secrets/* is 404 secrets-client-side — a slug the client can degrade on", async () => {
    const post = await srv.api("POST", "/api/secrets/unlock", {
      path: "keys/cloud-keys.md",
      passphrase: "hunter2",
    });
    expect(post.status).toBe(404);
    expect(post.body.error).toBe("secrets-client-side");
    expect(post.body.message).not.toContain("v0 contract");
    expect(post.text).not.toContain("AWS_SECRET_ACCESS_KEY");

    const get = await srv.api("GET", "/api/secrets/unlock");
    expect(get.status).toBe(404);
    expect(get.body.error).toBe("secrets-client-side");
  });

  test("an unknown /api route is 404 with an error slug", async () => {
    const r = await srv.get("/api/definitely-not-a-route");
    expect(r.status).toBe(404);
    expect(typeof r.body?.error).toBe("string");
  });
});

/* ============================================================
   containment, path shape and input clamping

   Regressions pinned here are the ones that let a write land somewhere the
   index can never see it, or a read reach outside the vault.
   ============================================================ */
describe("vault containment and path shape", () => {
  test("a dot-prefixed name is 400 bad-path, not an unindexable ghost doc", async () => {
    /* scanDocs skips every dot segment, so a created `.todo.md` would exist on
       disk, never appear in the tree or search, and 500 on every save */
    for (const bad of [".todo.md", "notes/.hidden.md", ".config/notes.md"]) {
      const r = await srv.api("POST", "/api/docs", { path: bad, type: "doc", markdown: "# ghost\n" });
      expect(`${bad} → ${r.status}`).toBe(`${bad} → 400`);
      expect(r.body.error).toBe("bad-path");
      expect(existsSync(join(srv.vault, bad))).toBe(false);
    }

    const folder = await srv.api("POST", "/api/docs", { path: ".secret", type: "folder" });
    expect(folder.status).toBe(400);
    expect(folder.body.error).toBe("bad-path");
    expect(existsSync(join(srv.vault, ".secret"))).toBe(false);
  });

  test("a symlink inside the vault does not become a read or a write outside it", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "znotes-outside-"));
    const secret = join(outsideDir, "outside.md");
    writeFileSync(secret, "# OUTSIDE\n\nnot part of any vault\n");
    symlinkSync(outsideDir, join(srv.vault, "escape"));
    symlinkSync("/", join(srv.vault, "rootlink"));

    try {
      /* read through the link */
      const read = await srv.api("GET", "/api/docs/escape/outside.md");
      expect(read.status).toBe(404);
      expect(read.text).not.toContain("OUTSIDE");

      const passwd = await srv.api("GET", "/api/docs/rootlink/etc/hosts");
      expect([400, 404]).toContain(passwd.status);

      /* overwrite through the link */
      const put = await srv.api("PUT", "/api/docs/escape/outside.md", { markdown: "PWNED\n" });
      expect([400, 404]).toContain(put.status);
      expect(readFileSync(secret, "utf8")).toContain("not part of any vault");

      /* create through the link */
      const post = await srv.api("POST", "/api/docs", {
        path: "escape/brandnew.md",
        type: "doc",
        markdown: "PWNED\n",
      });
      expect([400, 404]).toContain(post.status);
      expect(existsSync(join(outsideDir, "brandnew.md"))).toBe(false);
    } finally {
      rmSync(join(srv.vault, "escape"), { force: true });
      rmSync(join(srv.vault, "rootlink"), { force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("GET /api/docs/{path} serves .md only — a stray .env in the vault is not a doc", async () => {
    writeFileSync(join(srv.vault, "notes.txt"), "plain text\n");
    writeFileSync(join(srv.vault, ".env"), "SECRET_KEY=abc123\n");
    try {
      const txt = await srv.api("GET", "/api/docs/notes.txt");
      expect(txt.status).toBe(404);
      expect(txt.body.error).toBe("not-found");
      expect(txt.text).not.toContain("plain text");

      const env = await srv.api("GET", "/api/docs/.env");
      expect([400, 404]).toContain(env.status);
      expect(env.text).not.toContain("SECRET_KEY");
    } finally {
      rmSync(join(srv.vault, "notes.txt"), { force: true });
      rmSync(join(srv.vault, ".env"), { force: true });
    }
  });

  test("creating under an existing doc is 409 exists, not a 500 carrying a filesystem path", async () => {
    const folder = await srv.api("POST", "/api/docs", { path: "inbox.md/child", type: "folder" });
    expect(folder.status).toBe(409);
    expect(folder.body.error).toBe("exists");
    expect(folder.text).not.toContain(srv.vault);

    const doc = await srv.api("POST", "/api/docs", { path: "inbox.md/kid.md", type: "doc", markdown: "" });
    expect(doc.status).toBe(409);
    expect(doc.body.error).toBe("exists");
    expect(doc.text).not.toContain(srv.vault);

    /* and the doc that got in the way is still a readable doc, not a directory */
    const inbox = await srv.doc("inbox.md");
    expect(inbox.status).toBe(200);
    expect(existsSync(join(srv.vault, "inbox.md/kid.md"))).toBe(false);
  });

  /**
   * macOS resolves several strings to one file. The write lands either way; what
   * must not happen is the index lookup missing and the route reporting a
   * server fault for a save that succeeded.
   */
  test("a path spelling the filesystem folds (case / NFD) still saves, and never 500s", async () => {
    const created = await srv.api("POST", "/api/docs", {
      path: "folding/case.md",
      type: "doc",
      markdown: "# case\n",
    });
    expect(created.status).toBe(201);

    const caseInsensitive = existsSync(join(srv.vault, "folding/CASE.md"));
    const put = await srv.api("PUT", "/api/docs/folding/CASE.md", { markdown: "# case\n\nsaved\n" });
    if (caseInsensitive) {
      expect(put.status).toBe(200);
      expect(put.body.path).toBe("folding/case.md"); // canonicalised to the indexed spelling
      expect(readVaultText(srv.vault, "folding/case.md")).toBe("# case\n\nsaved\n");
    } else {
      expect(put.status).toBe(404); // separate file on a case-sensitive volume
    }
    expect(put.status).not.toBe(500);

    /* NFC on disk, NFD on the wire */
    const nfc = await srv.api("POST", "/api/docs", { path: "folding/café.md", type: "doc", markdown: "# cafe\n" });
    expect(nfc.status).toBe(201);
    const nfd = await srv.api("PUT", "/api/docs/folding/" + encodeURIComponent("café.md"), {
      markdown: "# cafe\n\nsaved\n",
    });
    expect(nfd.status).not.toBe(500);
    if (nfd.status === 200) {
      expect(nfd.body.path).toBe("folding/café.md");
      expect(readVaultText(srv.vault, "folding/café.md")).toBe("# cafe\n\nsaved\n");
    }
  });

  test("a non-positive search limit falls back to the default instead of truncating from the end", async () => {
    const all = (await srv.get("/api/search?q=")).body.results.length;
    expect(all).toBeGreaterThan(2);

    for (const bad of ["-1", "-3", "-1000", "0"]) {
      const r = await srv.get("/api/search?q=&limit=" + encodeURIComponent(bad));
      expect(`limit=${bad} → ${r.status}`).toBe(`limit=${bad} → 200`);
      expect(`limit=${bad} → ${r.body.results.length}`).toBe(`limit=${bad} → ${all}`);
    }
  });
});

/* ============================================================
   the index is a disposable cache, not a boot dependency
   ============================================================ */
describe("index.db recovery", () => {
  test("a corrupt index.db is rebuilt at boot instead of killing the process", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nthe notes survive\n" });
    try {
      const first = await startServer({ vault });
      await first.stop();

      const db = join(vault, ".znotes", "index.db");
      expect(existsSync(db)).toBe(true);
      writeFileSync(db, randomBytes(4096)); // not a database at all

      const second = await startServer({ vault });
      try {
        const tree = await second.get("/api/docs");
        expect(tree.status).toBe(200);
        expect(files(tree.body.tree).map((n: any) => n.path)).toEqual(["note.md"]);

        const doc = await second.doc("note.md");
        expect(doc.status).toBe(200);
        expect(doc.body.markdown).toBe("# Note\n\nthe notes survive\n");
      } finally {
        await second.stop();
      }
    } finally {
      dropVault(vault);
    }
  }, 40000);
});

/* ============================================================
   Cross-site writes (SPEC §10 — the perimeter is a NETWORK boundary)

   `readJsonBody` parses a body whatever its content-type, so every bodied
   /api/* route was reachable as a CORS-*simple* request: `fetch(url, {method:
   "POST", headers:{"content-type":"text/plain"}, body})` from any page the user
   happens to have open sends no preflight, and nothing looked at `Origin`. The
   attacker cannot read the response and does not need to — proposal ids are a
   walkable `prop_<n>` counter, so two blind POSTs drove an AI turn, accepted
   the proposal, rewrote a note and pushed the commit.

   The perimeter argument does not cover this: the request originates INSIDE the
   tailnet, from the user's own browser.
   ============================================================ */

describe("cross-site writes are refused", () => {
  /** exactly what a drive-by page can send: simple request, no preflight */
  const driveBy = (path: string, body: unknown) =>
    fetch(srv.url(path), {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
      },
      body: JSON.stringify(body),
    });

  test("a cross-site POST cannot create, sync, start a turn or accept a proposal", async () => {
    const targets: Array<[string, unknown]> = [
      ["/api/docs", { path: "evil/pwned.md", type: "doc", markdown: "# Pwned\n" }],
      ["/api/ai/messages", { content: "rewrite notes.md", docPath: "architecture/z-notes-design.md" }],
      ["/api/ai/proposals/prop_1/accept", {}],
      ["/api/ai/proposals/prop_1/revert", {}],
      ["/api/ai/sessions", {}],
      ["/api/sync/now", {}],
    ];
    for (const [path, body] of targets) {
      const res = await driveBy(path, body);
      expect(`cross-site POST ${path} → ${res.status}`).toBe(`cross-site POST ${path} → 403`);
      await res.text();
    }
    expect(`the drive-by created a doc: ${existsSync(join(srv.vault, "evil/pwned.md"))}`).toBe(
      "the drive-by created a doc: false"
    );
  }, 30000);

  test("an Origin that is not ours is refused even without Sec-Fetch-Site", async () => {
    const res = await fetch(srv.url("/api/docs"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ path: "evil/other.md", type: "doc" }),
    });
    expect(`foreign-Origin POST → ${res.status}`).toBe("foreign-Origin POST → 403");
    await res.text();
  }, 20000);

  test("the real client is unaffected: same-origin writes and all reads still work", async () => {
    /* what the browser actually sends for the app's own fetches */
    const same = await fetch(srv.url("/api/docs"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: srv.base,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
      body: JSON.stringify({ path: "sameorigin/ok.md", type: "doc", markdown: "# OK\n" }),
    });
    expect(`same-origin POST → ${same.status}`).toBe("same-origin POST → 201");
    await same.text();

    /* a GET is never a write, and is never blocked — a cross-site read gets no
       CORS header anyway, so the browser refuses to hand it over */
    const read = await fetch(srv.url("/api/docs"), {
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(`cross-site GET /api/docs → ${read.status}`).toBe("cross-site GET /api/docs → 200");
    expect(`…and it grants no CORS access: ${read.headers.get("access-control-allow-origin")}`).toBe(
      "…and it grants no CORS access: null"
    );
    await read.text();

    /* and a plain non-browser client (no Origin, no Sec-Fetch-*) is untouched */
    const cli = await srv.api("POST", "/api/docs", { path: "sameorigin/cli.md", type: "doc", markdown: "# CLI\n" });
    expect(`a header-less client → ${cli.status}`).toBe("a header-less client → 201");
  }, 30000);
});

/* ============================================================
   Request body ceiling.

   `readJsonBody` buffered `await req.text()` with no bound, and Bun.serve set
   no `maxRequestBodySize`, so the only limit anywhere was Bun's 128 MiB
   default — and nothing downstream re-checked. A pasted log or a dropped
   generated file therefore landed in `files.body` AND a second time in the
   `files_fts` shadow table, inside the vault, and was re-materialised into
   memory by every tree read, every search and every AI manifest build. No
   error, no truncation, no warning.
   ============================================================ */
describe("request bodies are bounded", () => {
  const MB = 1024 * 1024;
  /* server.ts MAX_BODY_BYTES; asserted rather than imported so the contract
     stays a number the test states, not whatever the source happens to say */
  const LIMIT = 8 * MB;

  test("an oversized PUT /api/docs/{path} is refused with 413, and nothing is stored", async () => {
    const path = "big.md";
    const small = "# Big\n\nsmall\n";
    const c = await srv.api("POST", "/api/docs", { path, type: "doc", markdown: small });
    expect(`POST ${path} → ${c.status}`).toBe(`POST ${path} → 201`);

    const huge = "x".repeat(LIMIT + 4096);
    const r = await srv.api("PUT", "/api/docs/" + encPath(path), { markdown: huge });
    expect(`oversized PUT → ${r.status} ${r.body?.error}`).toBe("oversized PUT → 413 too-large");
    expect(`the limit is named: ${r.body?.limit}`).toBe(`the limit is named: ${LIMIT}`);

    // the doc on disk is untouched — a refused write is not a partial write
    const after = await srv.doc(path);
    expect(`${path} still holds its old bytes: ${after.body.markdown === small}`).toBe(
      `${path} still holds its old bytes: true`
    );
  }, 30000);

  test("an oversized POST /api/docs and POST /api/ai/messages are refused the same way", async () => {
    const huge = "x".repeat(LIMIT + 4096);
    const a = await srv.api("POST", "/api/docs", { path: "huge-create.md", type: "doc", markdown: huge });
    expect(`oversized POST /api/docs → ${a.status} ${a.body?.error}`).toBe("oversized POST /api/docs → 413 too-large");
    expect(`huge-create.md was created anyway: ${(await srv.doc("huge-create.md")).status === 200}`).toBe(
      "huge-create.md was created anyway: false"
    );

    const b = await srv.api("POST", "/api/ai/messages", { content: huge });
    expect(`oversized POST /api/ai/messages → ${b.status} ${b.body?.error}`).toBe(
      "oversized POST /api/ai/messages → 413 too-large"
    );

    /* …and something far past the cap never gets buffered at all: Bun.serve
       carries its own ceiling just above ours, so this dies at the socket
       rather than costing 128 MiB of RSS */
    const enormous = "x".repeat(LIMIT + 8 * MB);
    const c = await srv.api("PUT", "/api/docs/" + encPath("big.md"), { markdown: enormous });
    expect(`far-oversized PUT → ${c.status}`).toBe("far-oversized PUT → 413");
  }, 30000);

  test("a body a real note could plausibly have still goes through", async () => {
    const path = "plausible.md";
    const md = "# Plausible\n\n" + "lorem ipsum dolor sit amet\n".repeat(20_000); // ~0.5 MiB
    const c = await srv.api("POST", "/api/docs", { path, type: "doc", markdown: md });
    expect(`POST ${path} → ${c.status}`).toBe(`POST ${path} → 201`);
    const w = await srv.putDoc(path, md + "tail\n");
    expect(`PUT ${path} (${Math.round(md.length / 1024)} KiB) → ${w.status}`).toBe(
      `PUT ${path} (${Math.round(md.length / 1024)} KiB) → 200`
    );
  }, 30000);
});

/* ============================================================
   Index projections.

   `allFiles()` was `SELECT *`, and four of its five callers — the sidebar tree,
   path canonicalisation (every 404 and every case/NFC variant), link
   resolution and the reconcile pass — never look at `body`. Every one of them
   allocated and discarded the whole vault's text, on every SSE-driven tree
   refresh. The split is only correct if the body-less projection is otherwise
   the SAME set of rows.
   ============================================================ */
describe("index projections", () => {
  test("allFileMeta() is allFiles() minus the bodies — same rows, no text", async () => {
    const { Index } = await import("../server/db");
    const dir = mkdtempSync(join(tmpdir(), "znotes-projection-"));
    const idx = new Index(join(dir, "index.db"));
    try {
      const rows = [
        { path: "b.md", title: "B", slug: "b", body: "BODYCANARY-B\n# head\n" },
        { path: "a.md", title: "A", slug: "a", body: "BODYCANARY-A\n" },
        { path: "n/c.md", title: "C", slug: "c", body: "BODYCANARY-C\n" },
      ];
      for (const r of rows) {
        idx.upsertFile(
          { path: r.path, rev: "r", hash: "h", size: r.body.length, mtimeMs: 1, title: r.title, slug: r.slug, hasSecrets: 0, empty: 0, body: r.body },
          []
        );
      }

      const full = idx.allFiles();
      const meta = idx.allFileMeta();

      expect(meta.map((r) => r.path)).toEqual(full.map((r) => r.path)); // same rows, same order
      expect(meta.map((r) => r.path)).toEqual(["a.md", "b.md", "n/c.md"]);
      for (const key of ["rev", "hash", "size", "mtimeMs", "title", "slug", "hasSecrets", "empty"] as const) {
        expect(`${key} survives the projection: ${JSON.stringify(meta.map((r) => r[key]))}`).toBe(
          `${key} survives the projection: ${JSON.stringify(full.map((r) => r[key]))}`
        );
      }

      // …and not one byte of document text comes along
      expect(`allFileMeta carries a body column: ${"body" in meta[0]}`).toBe("allFileMeta carries a body column: false");
      expect(`allFileMeta serialises any body text: ${JSON.stringify(meta).includes("BODYCANARY")}`).toBe(
        "allFileMeta serialises any body text: false"
      );
      // positive control: the bodies really are stored
      expect(`allFiles still carries them: ${JSON.stringify(full).includes("BODYCANARY")}`).toBe(
        "allFiles still carries them: true"
      );
    } finally {
      idx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
