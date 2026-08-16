/* ============================================================
   markdown-inline.test.ts — complexity guard for untrusted inline input.

   Markdown is file content: git, another editor, or the AI relay may supply a
   line deliberately shaped to stress the renderer. Wall-clock microbenchmarks
   are noisy, so this bounded test counts the expensive whole-string operations
   directly. Adding one protected node must not add one more full scan.
   ============================================================ */

import { test, expect } from "bun:test";
import { inline } from "../app/ui.js";

test("a hostile line with many protected nodes is restored in bounded passes", () => {
  const count = 256;
  const marker = "\uE000";
  const source =
    marker.repeat(count) + " " + Array.from({ length: count }, (_, i) => marker + "`code~~" + i + "` ").join("");

  const originalIncludes = String.prototype.includes;
  const originalSplit = String.prototype.split;
  let includesCalls = 0;
  let splitCalls = 0;
  let rendered = "";
  const started = performance.now();

  /* Count scans rather than guessing how fast the host CPU ought to be. The
     wrappers live for one synchronous call and are restored even on failure. */
  String.prototype.includes = function (search: string, position?: number) {
    includesCalls++;
    return originalIncludes.call(this, search, position);
  };
  String.prototype.split = function (separator?: string | RegExp, limit?: number) {
    splitCalls++;
    return originalSplit.call(this, separator as any, limit);
  };
  try {
    rendered = inline(source);
  } finally {
    String.prototype.includes = originalIncludes;
    String.prototype.split = originalSplit;
  }

  const elapsedMs = performance.now() - started;
  const codes = rendered.match(/<code class="ic">code~~\d+<\/code>/g) ?? [];
  const markers = rendered.match(/\uE000/g) ?? [];
  expect({ codes: codes.length, markers: markers.length, strikeTags: (rendered.match(/<del>/g) ?? []).length }).toEqual({
    codes: count,
    markers: count * 2,
    strikeTags: 0,
  });
  expect(`whole-string scans: includes=${includesCalls}, split=${splitCalls}`).toBe(
    `whole-string scans: includes=${Math.min(includesCalls, 8)}, split=${Math.min(splitCalls, 8)}`
  );
  /* A generous ceiling catches an accidental unbounded loop while the scan
     count above carries the deterministic linearity claim. */
  expect(`completed within 1s: ${elapsedMs < 1000}`).toBe("completed within 1s: true");
});
