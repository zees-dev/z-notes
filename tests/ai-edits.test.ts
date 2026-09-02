/* ============================================================
   ai-edits.test.ts — the proposal diff, now that it is ours.

   buildDiff() was a thin wrapper around jsdiff's `structuredPatch` until
   ADR 0029 replaced it with a line-level Myers diff inside ai-edits.ts. The
   claims below used to belong to the dependency: the rows a reviewer reads
   (two lines of context, `+`/`-`/` ` markers, no stray CR) and the 1s deadline
   that answers a rewrite whose two sides share almost nothing.

   tests/ai.test.ts pins the same rows one layer up, on a live proposal.
   ============================================================ */

import { test, expect } from "bun:test";
import { buildDiff } from "../server/ai-edits.ts";

const doc = (lines: string[], eol = "\n") => lines.join(eol) + eol;
const numbered = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
const oneFile = (pre: string, post: string) => buildDiff([{ path: "note.md", pre, post, existed: true }]);

test("a replaced line comes back with two lines of context on each side", () => {
  const before = numbered(6, "line");
  const { diff, added, removed } = oneFile(doc(before), doc(before.map((l, i) => (i === 2 ? "CHANGED" : l))));
  expect(diff.map((d) => d.marker)).toEqual([" ", " ", "-", "+", " ", " "]);
  expect(diff.map((d) => d.text)).toEqual(["line 0", "line 1", "line 2", "CHANGED", "line 3", "line 4"]);
  expect(`+${added} -${removed}`).toBe("+1 -1");
});

test("two identical images produce no rows at all", () => {
  const same = doc(numbered(40, "line"));
  const { diff, added, removed } = oneFile(same, same);
  expect(`rows: ${diff.length}, +${added} -${removed}`).toBe("rows: 0, +0 -0");
});

test("a CRLF document yields rows with no carriage return in them", () => {
  const before = numbered(5, "line");
  const { diff } = oneFile(doc(before, "\r\n"), doc(before.map((l, i) => (i === 1 ? "CHANGED" : l)), "\r\n"));
  expect(diff.map((d) => d.marker + d.text)).toEqual([" line 0", "-line 1", "+CHANGED", " line 2", " line 3"]);
});

test("two sides that share nothing bail at the deadline instead of stopping the server", () => {
  /* 20k lines a side takes ~2.4s unbounded on this machine and grows with the
     square, so the 1s deadline is what returns — and the edit is untouched by
     it: only the preview is lost. */
  const { diff, added, removed } = oneFile(doc(numbered(20000, "alpha")), doc(numbered(20000, "bravo")));
  expect(diff).toEqual([
    { marker: " ", text: "— note.md: diff too large to render; the edit itself is unaffected —" },
  ]);
  expect(`+${added} -${removed}`).toBe("+0 -0");
});

test("adding the file's final newline is a change, and the card says so", () => {
  /* the one edit whose whole content is a byte the eye cannot see: an
     unterminated last line is not the same line as a terminated one, so Accept
     changing the file and the card showing nothing must not be possible */
  const { diff, added, removed } = oneFile("a\nb\nc", "a\nb\nc\n");
  expect(diff.map((d) => d.marker + d.text)).toEqual([" a", " b", "-c", "+c"]);
  expect(`+${added} -${removed}`).toBe("+1 -1");
});
