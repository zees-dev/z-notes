/* ============================================================
   frontend.ts — every byte of the frontend the server sends.

   The frontend is BUILT (ADR 0040): one `Bun.build` over the shell's boot
   entry, the BlockNote island and the crypto worker, split into content-hashed
   chunks under `/assets/`, plus a second, stable-named build of the service
   worker at `/sw.js`. `scripts/build.ts` runs it once at image build time and
   writes `dist/`, which `loadFrontend` reads at boot with no bundling and no
   compression; without `ZNOTES_DIST` (dev, tests) `buildFrontend` runs the
   same build in memory. Both end in one `FrontendBuild`, so there is one
   serving path, and only exact keys of its map are ever served — no file-system
   walk, so no traversal to defend against.

   Every textual asset is compressed ONCE and held: the island alone is over a
   megabyte of JavaScript, the Pi uploads at roughly 250 KB/s, and compressing
   per request would hand that cost to every load. A content-coding is a
   distinct representation, so each carries its own ETag (RFC 9110 §8.8.1) and
   every response says `vary: accept-encoding`; one tag shared across codings
   would let a revalidation answer 304 to a client holding the other's bytes.
   ============================================================ */

import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as zlib from "node:zlib";

/** Content-addressed assets: the URL changes whenever the bytes do, so the
    browser may keep them for the month the user asked for. Everything that is
    NOT content-addressed (the shell, `/sw.js`, `themes/*.css`,
    `manifest.json`, the icons) stays `no-cache` + ETag on purpose: a month on
    those would hide a deploy from an already-warm browser until it expired,
    and a revalidation that answers 304 costs a few hundred bytes. */
const IMMUTABLE_CACHE = "public, max-age=2592000, immutable";
const REVALIDATE_CACHE = "no-cache";
/** Fonts, images and the woff2 the editor CSS pulls are already compressed;
    a second pass costs build time and gives bytes back. */
const TEXTUAL = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/;
/** Below this the framing costs more than the coding saves. */
export const COMPRESS_MIN = 1024;
const JS_TYPE = "text/javascript; charset=utf-8";

type Coding = "br" | "gzip";
export interface Representation {
  type: string;
  bytes: Uint8Array;
  etag: string;
  encoded: Map<Coding, { bytes: Uint8Array; etag: string }>;
}

export interface FrontendBuild {
  /** build id: Bun.hash over sorted "url\0etag" of every built and static file, hex */
  id: string;
  /** url → representation, for /assets/*, /sw.js and the static files */
  assets: Map<string, Representation>;
  /** the finished app shell */
  shell: Representation;
  /** every URL the service worker installs, "/" first */
  precache: string[];
  /** "" or why the in-memory build failed (dev/tests only) */
  error: string;
  /** the boot entry, then every chunk it reaches by static import */
  boot: string[];
  island: { js: string; css: string };
  worker: string;
}

const enc = (s: string) => new TextEncoder().encode(s);
const tagOf = (bytes: Uint8Array) => `"${Bun.hash(bytes).toString(16)}"`;
const codingTag = (etag: string, suffix: string) => `${etag.slice(0, -1)}-${suffix}"`;

/** Build the identity representation and whatever codings actually shrink it.
    `etag` is the identity tag; a coding's tag is that tag with a suffix. */
function represent(bytes: Uint8Array, type: string, etag: string, quality: number): Representation {
  const rep: Representation = { type, bytes, etag, encoded: new Map() };
  if (!TEXTUAL.test(type) || bytes.byteLength < COMPRESS_MIN) return rep;
  for (const [coding, suffix, out] of [
    ["br", "br", zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } })],
    ["gzip", "gz", zlib.gzipSync(bytes, { level: 9 })],
  ] as const) {
    // a coding that grew the body is not an optimisation; drop it and offer identity
    if (out.byteLength < bytes.byteLength) rep.encoded.set(coding, { bytes: new Uint8Array(out), etag: codingTag(etag, suffix) });
  }
  return rep;
}

/** The codings a request accepts. `;q=0` is a refusal. */
export const offeredCodings = (req: Request) =>
  new Set(
    (req.headers.get("accept-encoding") || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && !/;\s*q=0(?:\.0+)?$/.test(t))
      .map((t) => t.split(";")[0])
  );

/** The coding to send: brotli, then gzip, then identity. */
function negotiate(req: Request, rep: Representation) {
  const offered = offeredCodings(req);
  for (const coding of ["br", "gzip"] as const) {
    const enc = rep.encoded.get(coding);
    if (enc && offered.has(coding)) return { coding, bytes: enc.bytes, etag: enc.etag };
  }
  return { coding: "", bytes: rep.bytes, etag: rep.etag };
}

/** One asset response for every representation: the negotiated coding, its
    own ETag, and If-None-Match / HEAD answered from the same headers. `extra`
    is for headers that belong to the document rather than to the asset (the
    shell's WebMCP pair). */
function assetResponse(rep: Representation, req: Request, cacheControl: string, extra: Record<string, string> = {}): Response {
  const { coding, bytes, etag } = negotiate(req, rep);
  const headers: Record<string, string> = { ...extra, "content-type": rep.type, etag, "cache-control": cacheControl };
  if (rep.encoded.size) headers["vary"] = "accept-encoding";
  if (coding) headers["content-encoding"] = coding;
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  if (req.method === "HEAD")
    return new Response(null, { status: 200, headers: { ...headers, "content-length": String(bytes.byteLength) } });
  return new Response(bytes, { status: 200, headers });
}

/* ============================================================
   The shell: app/index.html with the build's tags spliced in at one marker,
   before base.css so the app's rules win every collision with the island's.
   ============================================================ */

const MARKER = "<!-- znotes:head -->";
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

interface ShellOpts {
  sw: boolean;
  origin: string | null;
}

function shellFor(template: string, b: Omit<FrontendBuild, "shell" | "assets" | "precache">, opts: ShellOpts): string {
  if (!template.includes(MARKER)) throw new Error(`the shell template has no ${MARKER} marker`);
  /* An inline MODULE script, because a module script is deferred: a classic
     one here would run in <head>, before #bootMsg exists. `<` is escaped so
     no build log can close the tag. */
  const splice = b.error
    ? `<script type="module">document.getElementById("bootMsg").textContent = "The app failed to build — " + ${JSON.stringify(b.error).replace(/</g, "\\u003c")};</script>`
    : [
        `<meta name="znotes-build" content="${b.id}">`,
        `<meta name="znotes-sw" content="${opts.sw ? "on" : "off"}">`,
        ...(opts.origin ? [`<meta name="znotes-origin" content="${attr(opts.origin)}">`] : []),
        `<link rel="stylesheet" id="editor-css" href="${b.island.css}" onload="this.dataset.loaded='true'" onerror="this.dataset.failed='true'">`,
        `<link rel="modulepreload" href="${b.island.js}">`,
        ...b.boot.slice(1).map((url) => `<link rel="modulepreload" href="${url}">`),
        `<script type="application/json" id="znotes-assets">${JSON.stringify({ island: b.island.js, worker: b.worker })}</script>`,
        `<script type="module" src="${b.boot[0]}"></script>`,
      ].join("\n");
  return template.replace(MARKER, () => splice);
}

/* ============================================================
   The service worker. Off (`ZNOTES_SW=off`) is not "no worker": a browser
   that installed one keeps it until a byte-different /sw.js replaces it, so
   off is THIS worker, which removes itself and every cache it owns. It never
   touches IndexedDB and the server never sends Clear-Site-Data: either would
   wipe the outbox, the unsent edits a broken release must not cost.
   ============================================================ */

const KILL_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("znotes-")) await caches.delete(k);
  // navigate() is refused for a page this worker does not control
  await self.clients.claim();
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.navigate(c.url).catch(() => {});
})()));
`;
const killRep = (quality: number) => {
  const bytes = enc(KILL_WORKER);
  return represent(bytes, JS_TYPE, tagOf(bytes), quality);
};

/* ============================================================
   The build.
   ============================================================ */

/** `index.html`, `manifest.json`, `themes/*.css`, `icons/*.png`: copied as-is,
    stable URLs, and a CONTENT-hash ETag (not size-mtime) so two pods agree. */
function staticFiles(appDir: string): { url: string; path: string }[] {
  const list = (dir: string, ext: string) =>
    existsSync(join(appDir, dir))
      ? readdirSync(join(appDir, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => ({ url: `/${dir}/${f}`, path: join(appDir, dir, f) }))
      : [];
  const manifest = existsSync(join(appDir, "manifest.json")) ? [{ url: "/manifest.json", path: join(appDir, "manifest.json") }] : [];
  return [...manifest, ...list("themes", ".css"), ...list("icons", ".png")];
}

const buildError = (err: unknown) => {
  const e = err as { errors?: unknown[]; message?: string };
  return e?.errors?.length ? e.errors.map(String).join("; ") : String(e?.message || err);
};

/** Every `mermaid` import except the facade's own resolves to the facade, so
    mermaid leaves the island's static graph and loads on first use. */
const lazyMermaid = (appDir: string): import("bun").BunPlugin => ({
  name: "lazy-mermaid",
  setup(b) {
    const facade = resolve(appDir, "mermaid-lazy.ts");
    b.onResolve({ filter: /^mermaid$/ }, (args) => (args.importer === facade ? undefined : { path: facade }));
  },
});

export async function buildFrontend(opts: { appDir: string; sw: boolean; origin: string | null; quality: 9 | 11 }): Promise<FrontendBuild> {
  const { appDir, quality } = opts;
  const template = await Bun.file(join(appDir, "index.html")).text();
  const assets = new Map<string, Representation>();
  for (const { url, path } of staticFiles(appDir)) {
    const file = Bun.file(path);
    const bytes = await file.bytes();
    assets.set(url, represent(bytes, file.type || "application/octet-stream", tagOf(bytes), quality));
  }
  const statics = [...assets.keys()];
  const parts = { id: "", error: "", boot: [] as string[], island: { js: "", css: "" }, worker: "" };
  try {
    const built = await Bun.build({
      entrypoints: ["boot.js", "block-editor.tsx", "crypto-worker.js"].map((f) => join(appDir, f)),
      target: "browser",
      format: "esm",
      splitting: true,
      minify: true,
      sourcemap: "none",
      publicPath: "/assets/",
      naming: { entry: "[name].[hash].[ext]", chunk: "chunk.[hash].[ext]", asset: "[name].[hash].[ext]" },
      // React and its dependents ship dev-only branches behind this flag
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      metafile: true,
      plugins: [lazyMermaid(appDir)],
    });
    if (!built.success || !built.metafile) throw new Error(built.logs.map(String).join("; ") || "no output");
    for (const output of built.outputs) {
      const bytes = new Uint8Array(await output.arrayBuffer());
      assets.set(`/assets/${basename(output.path)}`, represent(bytes, output.type, tagOf(bytes), quality));
    }
    /* The metafile (Bun 1.4) keys each output by "./<name>" with
       `entryPoint`, `cssBundle` and `imports[{path, kind}]`; a static import is
       `import-statement`, a lazy one `dynamic-import`. */
    const outputs = built.metafile.outputs as Record<string, { entryPoint?: string; cssBundle?: string; imports: { path: string; kind: string }[] }>;
    const url = (key: string) => `/assets/${basename(key)}`;
    const entry = (name: string) => {
      // entries are `[name].[hash].js`; every other script is `chunk.[hash].js`
      const key = Object.keys(outputs).find((k) => basename(k).startsWith(`${name}.`) && k.endsWith(".js") && outputs[k].entryPoint);
      if (!key) throw new Error(`the build has no ${name} entry`);
      return key;
    };
    const boot = entry("boot");
    const island = entry("block-editor");
    const css = outputs[island].cssBundle;
    if (!css) throw new Error("the island built no stylesheet");
    /* The boot closure is what <head> preloads. The island's is NOT: every
       island chunk in <head> delayed first paint in the prototype (P2). */
    const closure = new Set([boot]);
    for (const key of closure)
      for (const dep of outputs[key]?.imports ?? []) if (dep.kind === "import-statement") closure.add(dep.path);
    Object.assign(parts, { boot: [...closure].map(url), island: { js: url(island), css: url(css) }, worker: url(entry("crypto-worker")) });
  } catch (err) {
    for (const key of [...assets.keys()]) if (!statics.includes(key)) assets.delete(key);
    parts.error = buildError(err);
  }
  // the template is in the id: a shell-only change is still a new release
  parts.id = Bun.hash(
    [...assets, ["/index.html", { etag: tagOf(enc(template)) }] as const]
      .map(([url, rep]) => `${url}\0${rep.etag}`)
      .sort()
      .join("\n")
  ).toString(16);
  const precache = parts.error ? [] : ["/", ...[...assets.keys()].filter((u) => u.startsWith("/assets/")).sort(), ...statics];
  /* off is the kill worker even over a failed build: it is how a broken
     release is taken back */
  if (!opts.sw) {
    assets.set("/sw.js", killRep(quality));
  } else if (!parts.error) {
    try {
      const sw = await buildWorker(appDir, parts.id, precache);
      assets.set("/sw.js", represent(sw, JS_TYPE, tagOf(sw), quality));
    } catch (err) {
      parts.error = buildError(err);
    }
  }
  if (!template.includes(MARKER)) parts.error ||= `app/index.html has no ${MARKER} marker`;
  const head = template.includes(MARKER) ? template : template.replace("</head>", `${MARKER}\n</head>`);
  return { ...parts, assets, precache, shell: shellRep(shellFor(head, parts, opts), quality) };
}

const shellRep = (html: string, quality: number) => {
  const bytes = enc(html);
  return represent(bytes, "text/html;charset=utf-8", tagOf(bytes), quality);
};

async function buildWorker(appDir: string, id: string, precache: string[]): Promise<Uint8Array> {
  const built = await Bun.build({
    entrypoints: [join(appDir, "sw.js")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    naming: "sw.js",
    define: { __ZNOTES_BUILD__: JSON.stringify(id), __ZNOTES_PRECACHE__: JSON.stringify(precache) },
  });
  if (!built.success || built.outputs.length !== 1) throw new Error(built.logs.map(String).join("; ") || "no service worker output");
  return new Uint8Array(await built.outputs[0].arrayBuffer());
}

/* ============================================================
   dist/ — what `scripts/build.ts` writes and the image boots from.

     build.json  { id, precache, files: { url: { type, etag, file, br?, gz? } }, boot, island, worker }
     assets/…, sw.js, static/index.html + manifest.json, themes/, icons/
   ============================================================ */

interface Manifest {
  id: string;
  precache: string[];
  files: Record<string, { type: string; etag: string; file: string; br?: string; gz?: string }>;
  boot: string[];
  island: { js: string; css: string };
  worker: string;
}

/** Write a successful build into `outDir` (already empty). */
export async function writeFrontend(build: FrontendBuild, appDir: string, outDir: string): Promise<void> {
  if (build.error) throw new Error(build.error);
  const files: Manifest["files"] = {};
  for (const [url, rep] of build.assets) {
    const file = url.startsWith("/assets/") || url === "/sw.js" ? url.slice(1) : `static${url}`;
    files[url] = { type: rep.type, etag: rep.etag, file };
    await Bun.write(join(outDir, file), rep.bytes);
    for (const [coding, suffix] of [["br", "br"], ["gzip", "gz"]] as const) {
      const coded = rep.encoded.get(coding);
      if (!coded) continue;
      files[url][suffix] = `${file}.${suffix}`;
      await Bun.write(join(outDir, `${file}.${suffix}`), coded.bytes);
    }
  }
  await Bun.write(join(outDir, "static/index.html"), Bun.file(join(appDir, "index.html")));
  const { id, precache, boot, island, worker } = build;
  await Bun.write(join(outDir, "build.json"), JSON.stringify({ id, precache, files, boot, island, worker } satisfies Manifest, null, 1));
}

/** Read `dist/` as built: no bundling and no compression, except the shell,
    which depends on the runtime options. Throws when it is unreadable — an
    image without its frontend is a broken image. */
export async function loadFrontend(distDir: string, opts: ShellOpts): Promise<FrontendBuild> {
  const m: Manifest = await Bun.file(join(distDir, "build.json")).json();
  const assets = new Map<string, Representation>();
  for (const [url, f] of Object.entries(m.files)) {
    const rep: Representation = { type: f.type, etag: f.etag, bytes: await Bun.file(join(distDir, f.file)).bytes(), encoded: new Map() };
    if (f.br) rep.encoded.set("br", { bytes: await Bun.file(join(distDir, f.br)).bytes(), etag: codingTag(f.etag, "br") });
    if (f.gz) rep.encoded.set("gzip", { bytes: await Bun.file(join(distDir, f.gz)).bytes(), etag: codingTag(f.etag, "gz") });
    assets.set(url, rep);
  }
  if (!opts.sw) assets.set("/sw.js", killRep(9));
  const template = await Bun.file(join(distDir, "static/index.html")).text();
  const parts = { id: m.id, error: "", boot: m.boot, island: m.island, worker: m.worker };
  return { ...parts, assets, precache: m.precache, shell: shellRep(shellFor(template, parts, opts), 9) };
}

/* ============================================================
   Serving.
   ============================================================ */

/* app/webmcp.js registers the app's operations as WebMCP tools (ADR 0031),
   and Chrome refuses that registration unless the page's agent cluster is
   origin-keyed and the `tools` permission is delegated to the origin. Both are
   properties of the document, so they ride on the shell only — on its 304 and
   HEAD too, which share these headers. */
const SHELL_HEADERS = { "origin-agent-cluster": "?1", "permissions-policy": "tools=(self)" };

/** `/d/*` and `/settings/*` are the frontend's routing spaces, never files:
    they answer with the shell, byte-identical to `/`, and the app reads the
    address back out of `location`. `/settings` is a page, not `/api/settings`,
    which the router matched long before this. */
const isShellPath = (p: string) => p === "/" || p === "/d" || p.startsWith("/d/") || p === "/settings" || p.startsWith("/settings/");

/** The response for a frontend path, or null: not a frontend path (404). An
    unknown hashed name is null too and is never answered with another asset —
    the importer is generated, so a substitute would be wrong code. */
export function serveFrontend(build: FrontendBuild, pathname: string, req: Request): Response | null {
  if (isShellPath(pathname)) return assetResponse(build.shell, req, REVALIDATE_CACHE, SHELL_HEADERS);
  const rep = build.assets.get(pathname);
  if (!rep) return null;
  return assetResponse(rep, req, pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
}
