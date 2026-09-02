/* ============================================================
   build-mermaid.ts — the mermaid browser bundle, drawn from node_modules.

   Run: `bun scripts/build-mermaid.ts` (only when the mermaid version in
   package.json changes). It writes `app/vendor/mermaid.js` and that file is
   COMMITTED — this is a GENERATOR, not a build step, exactly as
   `scripts/make-icons.ts` is a generator for `app/icons/*.png`. Nothing at
   runtime shells out to it, `bun run dev` does not invoke it, and the server
   serves the result as a plain static file out of APP_DIR.

   WHY NOT THE /vendor/age.js MACHINERY, which already bundles a dependency at
   boot? Because that machinery needs the dependency present at RUNTIME, and
   `deploy/Dockerfile` therefore ships `node_modules` into the image. Measured:
   mermaid and its tree cost 181 MB there (63 MB → 244 MB), for a library that
   is only ever executed in a browser. Committing the 3.3 MB artifact instead
   keeps mermaid a devDependency, keeps the production image exactly the size
   it is today, and keeps the boot path untouched. `age-encryption` cannot make
   the same trade — it is the crypto, and building it in-process at boot is the
   thing that lets `tests/secrets.test.ts` prove the server never imports it.

   WHAT IS IN THE FILE is decided by `scripts/mermaid-entry.js` and nothing
   else. The banner this script prepends records the exact version, so
   `tests/mermaid.test.ts` can fail the build when package.json moves and the
   artifact does not — the one drift that would otherwise be silent.
   ============================================================ */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "scripts", "mermaid-entry.js");
const OUT = join(ROOT, "app", "vendor", "mermaid.js");

/** The version actually resolved in node_modules — never the range in package.json. */
const installed = await Bun.file(join(ROOT, "node_modules", "mermaid", "package.json"))
  .json()
  .catch(() => null);
if (!installed?.version) {
  process.stderr.write(
    "[build-mermaid] mermaid is not installed. It is a devDependency:\n" + "                bun install\n"
  );
  process.exit(1);
}

const built = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
});
if (!built.success || !built.outputs.length) {
  process.stderr.write("[build-mermaid] bundle failed:\n" + built.logs.map((l) => String(l)).join("\n") + "\n");
  process.exit(1);
}

const js = await built.outputs[0].text();
const sha = new Bun.CryptoHasher("sha256").update(js).digest("hex");

/* The banner is CONTRACT, not decoration: `tests/mermaid.test.ts` parses the
   version out of it. Keep the shape, and keep it a comment a minifier upstream
   of us can never have produced. */
const banner =
  `/*! mermaid@${installed.version} — GENERATED, do not edit.\n` +
  `    Regenerate: bun scripts/build-mermaid.ts (see docs/decisions/0010-mermaid-is-a-committed-bundle.md)\n` +
  `    Entry: scripts/mermaid-entry.js · sha256(body)=${sha} */\n`;

mkdirSync(dirname(OUT), { recursive: true });
await Bun.write(OUT, banner + js);

const kb = (banner.length + js.length) / 1024;
process.stdout.write(
  `[build-mermaid] mermaid@${installed.version} → app/vendor/mermaid.js  ` +
    `${(kb / 1024).toFixed(2)} MB\n[build-mermaid] sha256(body) ${sha}\n`
);
