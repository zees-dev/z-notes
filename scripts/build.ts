/* ============================================================
   build.ts — the release build of the frontend (ADR 0040).

   `bun run build` → dist/ (or the directory given as the one argument): the
   same `buildFrontend` the server runs in memory, at brotli quality 11, with
   the service worker built in. The image runs this and boots with
   `ZNOTES_DIST`, so the Pi neither bundles nor compresses at boot; the
   runtime options (ZNOTES_SW, ZNOTES_ORIGIN) are applied when it loads.
   Any build error exits non-zero, which fails the image build.
   ============================================================ */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildFrontend, writeFrontend } from "../server/frontend.ts";

const ROOT = resolve(import.meta.dir, "..");
const APP_DIR = join(ROOT, "app");
const out = resolve(process.argv[2] || join(ROOT, "dist"));

/* `out` is wiped, so a non-empty `out` must be an earlier build (it has
   build.json). Anything else (the checkout, an ancestor of it, `app/`) is
   somebody's files. */
if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, "build.json"))) {
  process.stderr.write(`[z-notes] refusing to wipe ${out}: it is not an earlier build\n`);
  process.exit(1);
}

const started = performance.now();
const build = await buildFrontend({ appDir: APP_DIR, sw: true, origin: null, quality: 11 });
if (build.error) {
  process.stderr.write(`[z-notes] frontend build failed: ${build.error}\n`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
await writeFrontend(build, APP_DIR, out);

let identity = 0;
let brotli = 0;
for (const rep of build.assets.values()) {
  identity += rep.bytes.byteLength;
  brotli += (rep.encoded.get("br") ?? rep).bytes.byteLength;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
process.stdout.write(
  `[z-notes] build ${build.id}: ${build.assets.size} files, ${kb(identity)} (${kb(brotli)} brotli), ` +
    `${build.boot.length - 1} boot chunks preloaded → ${out} in ${Math.round(performance.now() - started)} ms\n`
);
