/* The editor island is boot-built, local and immutable; the shell, the API and
   the age bundle stay independent of whether it built at all. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
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
      // a month, and the URL changes with the bytes — see server/index.ts IMMUTABLE_CACHE
      expect(asset.headers.get("cache-control")).toBe("public, max-age=2592000, immutable");
      const bytes = await asset.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1000);

      /* identity, so the length compares against the decoded body above:
         `content-length` is the NEGOTIATED coding's length, not the resource's */
      const head = await fetch(srv.url(path), { method: "HEAD", headers: { "accept-encoding": "identity" } });
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

  test("the shell names the hashed pair, preloads the entry, and its ETag carries the build", async () => {
    const hashed: Record<string, string> = {};
    for (const ext of ["js", "css"]) {
      const alias = await fetch(srv.url(`/vendor/editor.${ext}`), { redirect: "manual" });
      hashed[ext] = alias.headers.get("location")!;
    }

    const shell = await srv.get("/");
    expect(shell.status).toBe(200);
    /* The hot path must not go through the no-cache alias: the stylesheet link
       names the hashed file, carries the hashed entry for editor.js to import,
       and is followed by a modulepreload so the 1.3 MB starts in <head>. */
    expect(shell.text).toContain(`id="editor-css" href="${hashed.css}" data-js="${hashed.js}"`);
    expect(shell.text).toContain(`<link rel="modulepreload" href="${hashed.js}">`);
    expect(shell.text).not.toContain('href="/vendor/editor.css" onload');
    // the shell is revalidated, never held: a release has to reach a warm browser
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    // and the ETag names the build, so a new bundle invalidates the HTML that points at it
    expect(shell.headers.get("etag")).toContain(hashed.js.split(".")[1]);

    // every routing space serves the same rewritten shell
    for (const route of ["/d/inbox.md", "/settings"]) {
      const page = await srv.get(route);
      expect(page.text).toContain(`data-js="${hashed.js}"`);
    }
  });

  test("content-codings are negotiated, each with its own ETag", async () => {
    const path = (await fetch(srv.url("/vendor/editor.js"), { redirect: "manual" })).headers.get("location")!;
    const identity = await fetch(srv.url(path), { headers: { "accept-encoding": "identity" } });
    expect(identity.headers.get("content-encoding")).toBeNull();
    const plain = new Uint8Array(await identity.arrayBuffer());

    for (const [coding, inflate] of [
      ["br", brotliDecompressSync],
      ["gzip", gunzipSync],
    ] as const) {
      const res = await fetch(srv.url(path), { headers: { "accept-encoding": coding }, decompress: false } as RequestInit);
      expect(res.headers.get("content-encoding")).toBe(coding);
      expect(res.headers.get("vary")).toBe("accept-encoding");
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.byteLength).toBeLessThan(plain.byteLength);
      expect(res.headers.get("content-length")).toBe(String(body.byteLength));
      // the coding is a different representation, so it is a different ETag (RFC 9110 §8.8.1)
      expect(res.headers.get("etag")).not.toBe(identity.headers.get("etag"));
      expect(new Uint8Array(inflate(body))).toEqual(plain);
      // and a conditional request matches that representation's tag
      const again = await fetch(srv.url(path), {
        headers: { "accept-encoding": coding, "if-none-match": res.headers.get("etag")! },
      });
      expect(again.status).toBe(304);
    }
  }, 30000);

  test("the shell's own files revalidate instead of being held for a month", async () => {
    const app = await srv.get("/app.js");
    /* NOT content-addressed: a month here would mean a deploy the browser does
       not see until it expires. The 304 below is what makes that cheap. */
    expect(app.headers.get("cache-control")).toBe("no-cache");
    const tree = await srv.get("/tree.js");
    const revalidated = await fetch(srv.url("/tree.js"), {
      headers: { "if-none-match": tree.headers.get("etag")! },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

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
      // the shell names the hashed pair, so its own validator has to move with them
      const shell = await srv.get("/");
      expect(shell.text).toContain(`href="${paths[1]}"`);
      paths.push(shell.headers.get("etag")!);
      aliases.push(paths);
      await srv.stop();
      srv = undefined;
    }
    expect(aliases[0][0]).not.toBe(aliases[1][0]);
    expect(aliases[0][1]).not.toBe(aliases[1][1]);
    expect(aliases[0][2]).not.toBe(aliases[1][2]);

    rmSync(join(root, "app/block-editor.tsx"));
    srv = await harness.startServer({ seed: { "inbox.md": "source survives" } });
    for (const ext of ["js", "css"]) {
      const failed = await srv.get(`/vendor/editor.${ext}`);
      expect(failed.status).toBe(503);
      expect(failed.body.error).toBe("vendor-unavailable");
      expect(failed.body.message).toContain("Source");
      expect(typeof failed.body.detail).toBe("string");
    }
    const degraded = await srv.get("/");
    expect(degraded.status).toBe(200);
    // no bundle to name: the alias stays, and it is what answers 503
    expect(degraded.text).toContain('id="editor-css" href="/vendor/editor.css"');
    expect(degraded.text).not.toContain('<link rel="modulepreload"');
    expect((await srv.doc("inbox.md")).body.markdown).toBe("source survives");
    expect((await srv.get("/vendor/age.js")).status).toBe(200);
  } finally {
    await srv?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
