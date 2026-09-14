/* The editor island is boot-built, local and immutable; the shell, the API and
   the age bundle stay independent of whether it built at all. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, startServer, type TestServer } from "./helpers.ts";

describe("editor vendor assets", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  }, 60000);
  afterAll(async () => {
    await srv?.stop();
  });

  for (const [ext, mime] of [
    ["js", "javascript"],
    ["css", "text/css"],
  ]) {
    test(`${ext} alias resolves locally with immutable caching and HEAD/304`, async () => {
      const alias = await fetch(srv.url(`/vendor/editor.${ext}`), { redirect: "manual" });
      expect(alias.status).toBe(302);
      expect(alias.headers.get("cache-control")).toBe("no-cache");
      const path = alias.headers.get("location")!;
      expect(path).toMatch(new RegExp(`^/vendor/editor/editor\\.[a-zA-Z0-9_-]+\\.${ext}$`));

      const asset = await fetch(srv.url(path));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain(mime);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      const bytes = await asset.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1000);

      const head = await fetch(srv.url(path), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(await head.text()).toBe("");

      const cached = await fetch(srv.url(path), {
        headers: { "if-none-match": asset.headers.get("etag")! },
      });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");

      /* Everything the bundle references has to be served by THIS process:
         `splitting` emits chunks and the stylesheet pulls fonts, and a
         self-hoster's browser must never reach out to a CDN for either. */
      if (ext === "js") {
        const js = new TextDecoder().decode(bytes);
        const imports = [...js.matchAll(/["'](\/vendor\/editor\/[^"']+\.js)["']/g)];
        expect(imports.length).toBeGreaterThan(0);
        for (const [, chunkPath] of imports) {
          const chunk = await fetch(srv.url(chunkPath), { method: "HEAD" });
          expect(chunk.status).toBe(200);
          expect(chunk.headers.get("content-type")).toContain("javascript");
        }
      }
      if (ext === "css") {
        const css = new TextDecoder().decode(bytes);
        for (const match of css.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)) {
          if (match[1].startsWith("data:")) continue;
          const url = new URL(match[1], srv.url(path));
          expect(url.origin).toBe(srv.base);
          expect((await fetch(url)).status).toBe(200);
        }
      }
    }, 30000);
  }

  test("unknown assets fail without substituting another bundle; methods stay guarded", async () => {
    for (const path of ["/vendor/editor/missing.js", "/vendor/unrelated.js"]) {
      const res = await fetch(srv.url(path), { redirect: "manual" });
      expect(res.status).toBe(404);
    }
    expect((await srv.api("POST", "/vendor/editor.js")).status).toBe(405);
    expect((await srv.api("POST", "/vendor/editor/x.js")).status).toBe(405);
    expect((await srv.get("/healthz")).status).toBe(200);
    const age = await srv.get("/vendor/age.js");
    expect(age.status).toBe(200);
    expect(age.text).toContain("age-encryption.org/v1");
  });
});

/* A throwaway repo root with a trivial island: the point is the BUILD's
   behaviour (hashes follow dependency bytes, a failure is contained), which a
   two-line entry proves as well as the real one and in a fraction of the time.
   node_modules is symlinked so the age bundle is still real. */
test("dependency bytes change asset URLs; a failed build preserves the shell, API and age", async () => {
  const root = mkdtempSync(join(tmpdir(), "znotes-editor-build-"));
  let srv: TestServer | undefined;
  try {
    cpSync(join(REPO_ROOT, "server"), join(root, "server"), { recursive: true });
    mkdirSync(join(root, "tests"));
    cpSync(join(REPO_ROOT, "tests/helpers.ts"), join(root, "tests/helpers.ts"));
    mkdirSync(join(root, "app"));
    cpSync(join(REPO_ROOT, "app/index.html"), join(root, "app/index.html"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    cpSync(join(REPO_ROOT, "bun.lock"), join(root, "bun.lock"));
    const harness: typeof import("./helpers.ts") = await import(join(root, "tests/helpers.ts"));

    await Bun.write(join(root, "app/block-editor.tsx"), 'export { value } from "./dep.js";\nimport "./style.css";\n');
    const aliases: string[][] = [];
    for (const version of ["first", "second"]) {
      await Bun.write(join(root, "app/dep.js"), `export const value = "${version}";`);
      await Bun.write(join(root, "app/style.css"), `body { color: ${version === "first" ? "red" : "blue"}; }`);
      srv = await harness.startServer();
      const paths: string[] = [];
      for (const ext of ["js", "css"]) {
        const res = await fetch(srv.url(`/vendor/editor.${ext}`), { redirect: "manual" });
        expect(res.status).toBe(302);
        paths.push(res.headers.get("location")!);
      }
      aliases.push(paths);
      await srv.stop();
      srv = undefined;
    }
    expect(aliases[0][0]).not.toBe(aliases[1][0]);
    expect(aliases[0][1]).not.toBe(aliases[1][1]);

    rmSync(join(root, "app/block-editor.tsx"));
    srv = await harness.startServer({ seed: { "inbox.md": "source survives" } });
    for (const ext of ["js", "css"]) {
      const failed = await srv.get(`/vendor/editor.${ext}`);
      expect(failed.status).toBe(503);
      expect(failed.body.error).toBe("vendor-unavailable");
      expect(failed.body.message).toContain("Source");
      expect(typeof failed.body.detail).toBe("string");
    }
    expect((await srv.get("/")).status).toBe(200);
    expect((await srv.doc("inbox.md")).body.markdown).toBe("source survives");
    expect((await srv.get("/vendor/age.js")).status).toBe(200);
  } finally {
    await srv?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
