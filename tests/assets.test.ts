/* The frontend is built (ADR 0040): the shell names a hashed, immutable
   release, every byte is negotiated and revalidated per coding, and a dist/
   written by scripts/build.ts serves the same release precompressed. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { REPO_ROOT, startServer, type TestServer } from "./helpers.ts";

const IMMUTABLE = "public, max-age=2592000, immutable";

/** What the shell names: the boot entry, the island pair, the preloads, the worker. */
function shellParts(html: string) {
  const assets = JSON.parse(/<script type="application\/json" id="znotes-assets">([^<]+)<\/script>/.exec(html)![1]);
  return {
    id: /<meta name="znotes-build" content="([^"]+)">/.exec(html)![1],
    boot: /<script type="module" src="([^"]+)"><\/script>/.exec(html)![1],
    css: /id="editor-css" href="([^"]+)"/.exec(html)![1],
    preloads: [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]),
    island: assets.island as string,
    worker: assets.worker as string,
  };
}

describe("the built frontend", () => {
  let srv: TestServer;
  let html = "";
  beforeAll(async () => {
    srv = await startServer({ env: { ZNOTES_SW: "on" } });
    html = (await srv.get("/")).text;
  }, 60000);
  afterAll(async () => {
    await srv?.stop();
  });

  test("the shell names the boot entry, the island pair and one modulepreload per boot-closure chunk", async () => {
    const s = shellParts(html);
    expect(s.boot).toMatch(/^\/assets\/boot\.[a-z0-9]+\.js$/);
    expect(s.island).toMatch(/^\/assets\/block-editor\.[a-z0-9]+\.js$/);
    expect(s.css).toMatch(/^\/assets\/block-editor\.[a-z0-9]+\.css$/);
    expect(s.worker).toMatch(/^\/assets\/crypto-worker\.[a-z0-9]+\.js$/);
    /* the boot closure, walked over the served code: every chunk reached by a
       STATIC import (minified `from"…"` / `import"…"`), never a lazy one */
    const closure = new Set<string>();
    for (const queue = [s.boot]; queue.length; ) {
      const url = queue.shift()!;
      const code = (await srv.get(url)).text;
      for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["'](\/assets\/[^"']+\.js)["']/g)) {
        if (!closure.has(m[1])) queue.push(m[1]);
        closure.add(m[1]);
      }
    }
    // the island entry first (ADR 0038), then exactly the boot closure
    expect(s.preloads[0]).toBe(s.island);
    expect(s.preloads.slice(1).sort()).toEqual([...closure].sort());
    // the editor stylesheet sits before base.css, so the app's rules win
    expect(html.indexOf('id="editor-css"')).toBeLessThan(html.indexOf("themes/base.css"));
    expect(html).not.toContain("<!-- znotes:head -->");
    expect(html).toContain('<meta name="znotes-sw" content="on">');
    expect(html).not.toContain('name="znotes-origin"');
  });

  test("#znotes-assets names URLs that answer; hashed assets are immutable and an unknown hash is a 404", async () => {
    const s = shellParts(html);
    for (const url of [s.island, s.worker, s.css, s.boot]) {
      const r = await fetch(srv.url(url));
      expect(`${url} → ${r.status}`).toBe(`${url} → 200`);
      expect(r.headers.get("cache-control")).toBe(IMMUTABLE);
      await r.arrayBuffer();
    }
    /* everything the stylesheet pulls is served by THIS process: a
       self-hoster's browser must never reach out to a CDN for a font */
    const css = (await srv.get(s.css)).text;
    for (const match of css.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)) {
      if (match[1].startsWith("data:")) continue;
      const url = new URL(match[1], srv.url(s.css));
      expect(url.origin).toBe(srv.base);
      expect((await fetch(url)).status).toBe(200);
    }
    // never substitute another asset for a stale hash: the importer is generated
    expect((await srv.get(s.island.replace(/\.[a-z0-9]+\.js$/, ".0000000.js"))).status).toBe(404);
    expect((await srv.get("/assets/missing.js")).status).toBe(404);
    expect((await srv.api("POST", s.island)).status).toBe(405);
  });

  test("content-codings are negotiated, each with its own ETag, HEAD and 304", async () => {
    const { island } = shellParts(html);
    const identity = await fetch(srv.url(island), { headers: { "accept-encoding": "identity" } });
    expect(identity.headers.get("content-encoding")).toBeNull();
    const plain = new Uint8Array(await identity.arrayBuffer());
    expect(plain.byteLength).toBeGreaterThan(1000);
    /* identity, so the length compares against the decoded body above:
       `content-length` is the NEGOTIATED coding's length, not the resource's */
    const head = await fetch(srv.url(island), { method: "HEAD", headers: { "accept-encoding": "identity" } });
    expect(head.headers.get("content-length")).toBe(String(plain.byteLength));
    expect(await head.text()).toBe("");

    for (const [coding, inflate] of [
      ["br", brotliDecompressSync],
      ["gzip", gunzipSync],
    ] as const) {
      const res = await fetch(srv.url(island), { headers: { "accept-encoding": coding }, decompress: false } as RequestInit);
      expect(res.headers.get("content-encoding")).toBe(coding);
      expect(res.headers.get("vary")).toBe("accept-encoding");
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.byteLength).toBeLessThan(plain.byteLength);
      expect(res.headers.get("content-length")).toBe(String(body.byteLength));
      // the coding is a different representation, so it is a different ETag (RFC 9110 §8.8.1)
      expect(res.headers.get("etag")).not.toBe(identity.headers.get("etag"));
      expect(new Uint8Array(inflate(body))).toEqual(plain);
      const again = await fetch(srv.url(island), { headers: { "accept-encoding": coding, "if-none-match": res.headers.get("etag")! } });
      expect(again.status).toBe(304);
    }
  }, 30000);

  test("the shell and the static files revalidate with content-hash ETags", async () => {
    const shell = await fetch(srv.url("/"), { headers: { "accept-encoding": "identity" } });
    const text = await shell.text();
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    expect(shell.headers.get("etag")).toBe(`"${Bun.hash(text).toString(16)}"`);
    // every routing space serves the same shell
    for (const route of ["/d/inbox.md", "/settings"]) expect((await srv.get(route)).text).toBe(text);

    for (const [url, file] of [
      ["/themes/base.css", "app/themes/base.css"],
      ["/manifest.json", "app/manifest.json"],
      ["/icons/icon-192.png", "app/icons/icon-192.png"],
    ]) {
      const r = await fetch(srv.url(url), { headers: { "accept-encoding": "identity" } });
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect(bytes).toEqual(await Bun.file(join(REPO_ROOT, file)).bytes());
      expect(r.headers.get("cache-control")).toBe("no-cache");
      // the BYTES' hash, not size-mtime: two pods serving one release agree
      expect(r.headers.get("etag")).toBe(`"${Bun.hash(bytes).toString(16)}"`);
      const again = await fetch(srv.url(url), { headers: { "accept-encoding": "identity", "if-none-match": r.headers.get("etag")! } });
      expect(again.status).toBe(304);
    }
  });

  test("/sw.js is no-cache JavaScript built for this release", async () => {
    const sw = await srv.get("/sw.js");
    expect(sw.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.headers.get("etag")).toBeTruthy();
    expect(sw.text).toContain(shellParts(html).id);
    expect(sw.text).toContain(shellParts(html).island);
  });

  test("the retired per-file and /vendor URLs are gone", async () => {
    for (const path of ["/app.js", "/tree.js", "/index.html", "/vendor/editor.js", "/vendor/age.js", "/vendor/editor/x.js"]) {
      const r = await srv.get(path);
      expect(`${path} → ${r.status}`).toBe(`${path} → 404`);
      expect(r.body.error).toBe("not-found");
    }
  });
});

test("ZNOTES_SW=off serves the worker that removes itself", async () => {
  const srv = await startServer({ env: { ZNOTES_SW: "off" } });
  try {
    const html = (await srv.get("/")).text;
    expect(html).toContain('<meta name="znotes-sw" content="off">');
    const sw = await srv.get("/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.text).toContain("registration.unregister()");
    expect(sw.text).not.toContain(shellParts(html).id);
    // the outbox lives in IndexedDB: the kill switch must never wipe it
    expect(sw.text).not.toContain("indexedDB");
    expect(sw.headers.get("clear-site-data")).toBeNull();
  } finally {
    await srv.stop();
  }
}, 60000);

/* A throwaway repo root with a trivial frontend: the point is the BUILD's
   behaviour (hashes follow dependency bytes, a failure is contained), which
   two-line entries prove as well as the real ones and in a fraction of the time. */
test("dependency bytes change asset URLs and the shell ETag; a failed build keeps the API and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "znotes-frontend-build-"));
  let srv: TestServer | undefined;
  try {
    cpSync(join(REPO_ROOT, "server"), join(root, "server"), { recursive: true });
    mkdirSync(join(root, "tests"));
    cpSync(join(REPO_ROOT, "tests/helpers.ts"), join(root, "tests/helpers.ts"));
    mkdirSync(join(root, "app"));
    cpSync(join(REPO_ROOT, "app/index.html"), join(root, "app/index.html"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    const harness: typeof import("./helpers.ts") = await import(join(root, "tests/helpers.ts"));

    await Bun.write(join(root, "app/boot.js"), 'import { value } from "./dep.js";\ndocument.title = value;\n');
    await Bun.write(join(root, "app/block-editor.tsx"), 'export { value } from "./dep.js";\nimport "./style.css";\n');
    await Bun.write(join(root, "app/crypto-worker.js"), "self.onmessage = () => {};\n");
    const seen: string[][] = [];
    for (const version of ["first", "second"]) {
      await Bun.write(join(root, "app/dep.js"), `export const value = "${version}";`);
      await Bun.write(join(root, "app/style.css"), `body { color: ${version === "first" ? "red" : "blue"}; }`);
      srv = await harness.startServer();
      const shell = await srv.get("/");
      const s = shellParts(shell.text);
      seen.push([s.boot, s.island, s.css, shell.headers.get("etag")!, s.id]);
      await srv.stop();
      srv = undefined;
    }
    for (let i = 0; i < seen[0].length; i++) expect(seen[0][i]).not.toBe(seen[1][i]);

    rmSync(join(root, "app/block-editor.tsx"));
    // a browser that installed a worker is released by the kill worker even when the build failed
    srv = await harness.startServer({ env: { ZNOTES_SW: "off" } });
    const kill = await srv.get("/sw.js");
    expect(kill.status).toBe(200);
    expect(kill.headers.get("cache-control")).toBe("no-cache");
    expect(kill.text).toContain("registration.unregister()");
    await srv.stop();
    srv = await harness.startServer({ seed: { "inbox.md": "source survives" } });
    const degraded = await srv.get("/");
    expect(degraded.status).toBe(200);
    expect(degraded.text).toContain("The app failed to build — ");
    expect(degraded.text).not.toContain('<link rel="modulepreload"');
    expect((await srv.doc("inbox.md")).body.markdown).toBe("source survives");
    expect((await srv.get("/healthz")).status).toBe(200);
    expect((await srv.get("/themes/base.css")).status).toBe(404); // this root ships no themes
  } finally {
    await srv?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);

/* dist mode: what the image boots from. The release is the in-memory one,
   byte for byte, but read from disk and served precompressed at q11. */
test("scripts/build.ts writes a dist/ the server serves precompressed", async () => {
  const out = mkdtempSync(join(tmpdir(), "znotes-dist-"));
  let mem: TestServer | undefined;
  let dist: TestServer | undefined;
  try {
    const build = Bun.spawnSync(["bun", "scripts/build.ts", out], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(`build exit ${build.exitCode}: ${build.stderr.toString()}`).toBe("build exit 0: ");
    const manifest = await Bun.file(join(out, "build.json")).json();

    [mem, dist] = await Promise.all([startServer({ env: { ZNOTES_SW: "on" } }), startServer({ env: { ZNOTES_SW: "on", ZNOTES_DIST: out } })]);
    const fromMem = shellParts((await mem.get("/")).text);
    const fromDist = shellParts((await dist.get("/")).text);
    expect(fromDist).toEqual(fromMem);
    expect(fromDist.id).toBe(manifest.id);

    let compressed = 0;
    for (const [url, f] of Object.entries(manifest.files) as [string, { br?: string }][]) {
      const identity = new Uint8Array(await (await fetch(dist.url(url), { headers: { "accept-encoding": "identity" } })).arrayBuffer());
      if (!f.br) continue;
      const res = await fetch(dist.url(url), { headers: { "accept-encoding": "br" }, decompress: false } as RequestInit);
      expect(res.headers.get("content-encoding")).toBe("br");
      const body = new Uint8Array(await res.arrayBuffer());
      // the file the build wrote, not a boot-time recompression…
      expect(body).toEqual(await Bun.file(join(out, f.br)).bytes());
      // …and it decodes to exactly the identity bytes
      expect(new Uint8Array(brotliDecompressSync(body))).toEqual(identity);
      compressed++;
    }
    expect(compressed).toBeGreaterThan(10);

    // the runtime options are applied at load: one dist serves either mode
    await dist.stop();
    dist = await startServer({ env: { ZNOTES_SW: "off", ZNOTES_DIST: out, ZNOTES_ORIGIN: "https://znotes.example.ts.net" } });
    const off = (await dist.get("/")).text;
    expect(off).toContain('<meta name="znotes-sw" content="off">');
    expect(off).toContain('<meta name="znotes-origin" content="https://znotes.example.ts.net">');
    expect((await dist.get("/sw.js")).text).toContain("registration.unregister()");
  } finally {
    await Promise.all([mem?.stop(), dist?.stop()]);
    rmSync(out, { recursive: true, force: true });
  }
}, 120000);

test("an unreadable ZNOTES_DIST fails the boot loudly", async () => {
  await expect(startServer({ env: { ZNOTES_DIST: join(tmpdir(), "znotes-no-such-dist") }, timeout: 20000 })).rejects.toThrow(/never announced readiness/);
}, 30000);
