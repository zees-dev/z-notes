/* ============================================================
   webmcp.test.ts — the two claims about the agent door that are NOT behaviour
   in a browser: what the shell response carries, and what the catalogue module
   is allowed to contain (ADR 0031).

   The headers are a precondition, not a decoration. Chrome refuses
   `registerTool` unless the document's agent cluster is origin-keyed and the
   `tools` permission is delegated to the origin, so a shell served without
   `Origin-Agent-Cluster: ?1` and `Permissions-Policy: tools=(self)` registers
   nothing and says nothing about why. They ride on the SHELL only — `/`,
   `/d/*` and `/settings*`, which are one file — and never on a static asset or
   an API reply.

   The source guard is the same instrument `tests/fileops.test.ts` points at the
   AI relay, aimed at the other hard rule: the server never sees a passphrase or
   a plaintext secret, and an agent platform is a cloud, so no tool may decrypt,
   reveal or take one. Comments may DISCUSS that restriction (webmcp.js does);
   code may not implement it.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, startServer, stripComments, type SeedMap, type TestServer } from "./helpers";

const SEED: SeedMap = {
  "a.md": "# A\n\nthe doc whose URL is a shell URL\n",
};

const servers: TestServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
});

async function server(): Promise<TestServer> {
  const s = await startServer({ seed: SEED });
  servers.push(s);
  return s;
}

/* ------------------------------------------------------------------
   1 — the shell carries the two headers WebMCP registration needs
   ------------------------------------------------------------------ */

describe("the app shell carries the agent headers", () => {
  test("every shell URL has them, and nothing else does", async () => {
    const srv = await server();

    /* the three addresses that resolve to index.html: the root, a doc URL and
       the settings page. They are one file with one ETag, so a client that has
       any of them cached must still be told both facts. */
    for (const path of ["/", "/d/a.md", "/settings/ai"]) {
      const r = await srv.get(path);
      expect(`GET ${path} → ${r.status}`).toBe(`GET ${path} → 200`);
      expect(`GET ${path} origin-agent-cluster: ${r.headers.get("origin-agent-cluster")}`).toBe(
        `GET ${path} origin-agent-cluster: ?1`
      );
      expect(`GET ${path} permissions-policy: ${r.headers.get("permissions-policy")}`).toBe(
        `GET ${path} permissions-policy: tools=(self)`
      );
    }

    /* an asset is not a document: it has no agent cluster to key and no tools
       to delegate, so the headers would be bytes on every request for nothing */
    for (const path of ["/app.js", "/api/docs"]) {
      const r = await srv.get(path);
      expect(`GET ${path} → ${r.status}`).toBe(`GET ${path} → 200`);
      expect(`GET ${path} origin-agent-cluster: ${r.headers.get("origin-agent-cluster")}`).toBe(
        `GET ${path} origin-agent-cluster: null`
      );
      expect(`GET ${path} permissions-policy: ${r.headers.get("permissions-policy")}`).toBe(
        `GET ${path} permissions-policy: null`
      );
    }
  }, 30000);

  test("a 304 and a HEAD carry them too — a cached reload registers tools as well", async () => {
    const srv = await server();
    const first = await srv.get("/");
    const etag = first.headers.get("etag") ?? "";
    expect(`the shell has an ETag: ${etag.length > 0}`).toBe("the shell has an ETag: true");

    const cached = await srv.api("GET", "/", undefined, { headers: { "if-none-match": etag } });
    expect(`conditional GET / → ${cached.status}`).toBe("conditional GET / → 304");
    expect(`304 origin-agent-cluster: ${cached.headers.get("origin-agent-cluster")}`).toBe(
      "304 origin-agent-cluster: ?1"
    );
    expect(`304 permissions-policy: ${cached.headers.get("permissions-policy")}`).toBe(
      "304 permissions-policy: tools=(self)"
    );

    const head = await srv.api("HEAD", "/d/a.md");
    expect(`HEAD /d/a.md → ${head.status}`).toBe("HEAD /d/a.md → 200");
    expect(`HEAD origin-agent-cluster: ${head.headers.get("origin-agent-cluster")}`).toBe(
      "HEAD origin-agent-cluster: ?1"
    );
    expect(`HEAD permissions-policy: ${head.headers.get("permissions-policy")}`).toBe(
      "HEAD permissions-policy: tools=(self)"
    );
  }, 30000);
});

/* ------------------------------------------------------------------
   2 — the catalogue module, as source text
   ------------------------------------------------------------------ */

const WEBMCP = join(REPO_ROOT, "app", "webmcp.js");

/** 1–128 chars of `[A-Za-z0-9_.-]` — the WebMCP spec's own rule for a tool name */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

describe("the tool catalogue module", () => {
  test("no tool decrypts, reveals or takes a passphrase", () => {
    expect(
      existsSync(WEBMCP)
        ? "app/webmcp.js is there"
        : "app/webmcp.js is MISSING — the WebMCP tool catalogue module has not landed yet"
    ).toBe("app/webmcp.js is there");

    /* comments may discuss the rule (this module's banner does); code may not
       reach past it. Same instrument as the AI-relay guard in fileops.test.ts:
       block and whole-line comments go, a trailing `//` is left alone so a URL
       in a string can never swallow real code. */
    const src = stripComments(readFileSync(WEBMCP, "utf8"));

    for (const word of ["decrypt", "reveal", "passphrase", "identity"]) {
      expect(`webmcp.js references ${word}: ${new RegExp(`\\b${word}`, "i").test(src)}`).toBe(
        `webmcp.js references ${word}: false`
      );
    }

    /* the plaintext jail is reachable from exactly one place, and it is not
       here — an agent platform is a cloud (ADR 0004, ADR 0031) */
    expect(`webmcp.js imports crypto-worker: ${src.includes("crypto-worker")}`).toBe(
      "webmcp.js imports crypto-worker: false"
    );
  }, 20000);

  test("every tool name is legal and declared once", () => {
    expect(
      existsSync(WEBMCP)
        ? "app/webmcp.js is there"
        : "app/webmcp.js is MISSING — the WebMCP tool catalogue module has not landed yet"
    ).toBe("app/webmcp.js is there");

    const src = stripComments(readFileSync(WEBMCP, "utf8"));
    const names = [...src.matchAll(/\bname:\s*"([^"]*)"/g)].map((m) => m[1]);

    expect(`webmcp.js declares tools: ${names.length > 0}`).toBe("webmcp.js declares tools: true");

    const illegal = names.filter((n) => !TOOL_NAME.test(n));
    expect(`names the browser would refuse: ${JSON.stringify(illegal)}`).toBe(
      "names the browser would refuse: []"
    );

    /* a duplicate name rejects `registerTool` — and silently, because a
       registration failure is a console.warn, never a toast */
    const seen = new Set<string>();
    const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(`names declared twice: ${JSON.stringify([...new Set(duplicates)])}`).toBe(
      "names declared twice: []"
    );
  }, 20000);
});
