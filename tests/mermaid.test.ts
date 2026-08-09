/* ============================================================
   mermaid.test.ts — the COMMITTED bundle's contract (ADR 0010).

   `app/vendor/mermaid.js` is a build artifact that lives in git, which buys a
   production image that never carries mermaid and costs exactly one new way to
   be wrong: the artifact and the pinned version can drift apart, silently,
   because nothing at runtime rebuilds it. Someone bumps the devDependency,
   forgets `bun scripts/build-mermaid.ts`, and the browser keeps running the
   old library — including any advisory the bump was FOR.

   That is the whole job of this file. It is deliberately not a browser suite:
   what it checks is a property of the repo, and mermaid-e2e.test.ts already
   proves the artifact actually draws.
   ============================================================ */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "app", "vendor", "mermaid.js");

describe("the committed mermaid bundle", () => {
  test("exists, and is the bundle rather than a stub", () => {
    expect(`bundle present: ${existsSync(BUNDLE)}`).toBe("bundle present: true");
    /* a real mermaid build is megabytes; anything under 1 MB is a truncated
       write or a placeholder somebody committed to make a test pass */
    const mb = statSync(BUNDLE).size / 1024 / 1024;
    expect(`bundle is a real build (>1MB): ${mb > 1}`).toBe("bundle is a real build (>1MB): true");
  });

  test("its banner names the SAME version package.json pins", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const pinned = pkg.devDependencies?.mermaid;
    /* exact pin, not a range: the artifact is built from ONE version and a
       caret would make "which version is in app/vendor" unanswerable */
    expect(`mermaid is pinned exactly: ${/^\d+\.\d+\.\d+$/.test(String(pinned))}`).toBe(
      "mermaid is pinned exactly: true"
    );
    const head = readFileSync(BUNDLE, "utf8").slice(0, 400);
    const built = /mermaid@(\d+\.\d+\.\d+)/.exec(head)?.[1];
    expect(`bundle version: ${built}`).toBe(`bundle version: ${pinned}`);
  });

  test("it is a devDependency — the production image must never carry mermaid", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(`in dependencies: ${"mermaid" in (pkg.dependencies || {})}`).toBe("in dependencies: false");
    expect(`in devDependencies: ${"mermaid" in (pkg.devDependencies || {})}`).toBe("in devDependencies: true");
  });

  test("nothing in server/ imports mermaid — it is browser-only, like age", () => {
    /* the same shape as tests/secrets.test.ts's crypto-free assertion, and for
       a related reason: a server-side import would put mermaid back into the
       production image through the node_modules the Dockerfile ships */
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(ROOT, "server");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
      .filter((f) => /\bfrom\s*["']mermaid["']|\brequire\(\s*["']mermaid["']|\bimport\(\s*["']mermaid["']/.test(
        readFileSync(join(dir, f), "utf8")
      ));
    expect(`server modules importing mermaid: ${offenders.join(", ") || "none"}`).toBe(
      "server modules importing mermaid: none"
    );
  });
});
