/* ============================================================
   ROUND-TRIP GATE

   A golden corpus: open/save cycles stay byte-identical for externally-written
   files (frontmatter, setext, `1)` lists, tabs, trailing spaces).

   Every case is written to disk as raw bytes *before* the server starts, so
   the server has no idea the app authored it. Then: GET → PUT the exact
   markdown string that came back → the file on disk must be byte-identical.

   Comparisons are on Uint8Array, never on strings: a normalisation that
   swaps CRLF for LF, trims a trailing space, or adds a final newline is
   invisible at the string level once both sides have been normalised, and
   very visible here.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  makeVault,
  writeVaultFile,
  readVaultBytes,
  bytesEqual,
  describeByteDiff,
  toBytes,
  dropVault,
  type TestServer,
} from "./helpers";

const enc = new TextEncoder();

interface Golden {
  name: string;
  why: string;
  bytes: Uint8Array;
}

const g = (name: string, why: string, content: string | Uint8Array): Golden => ({
  name,
  why,
  bytes: toBytes(content),
});

const CRLF_TEXT =
  "# CRLF document\r\n" +
  "\r\n" +
  "A file authored on Windows.\r\n" +
  "\r\n" +
  "- item one\r\n" +
  "- item two\r\n";

export const CORPUS: Golden[] = [
  g(
    "corpus/frontmatter.md",
    "YAML frontmatter must survive verbatim, including the --- fences and key order",
    "---\ntitle: Frontmatter survivor\ntags: [notes, spec]\ndate: 2026-08-01\nnested:\n  a: 1\n  b: \"two\"\n---\n\n# Body starts here\n\nText under the frontmatter.\n"
  ),
  g(
    "corpus/setext.md",
    "setext headings must not be rewritten to ATX",
    "Setext H1\n=========\n\nParagraph under an equals-underlined heading.\n\nSetext H2\n---------\n\nMore text, and a thematic break that is not a setext underline:\n\n***\n"
  ),
  g(
    "corpus/ordered-paren.md",
    "`1)` ordered-list delimiters must not be normalised to `1.`",
    "# Ordered lists\n\n1) first\n2) second\n3) third\n\nand the other flavour:\n\n1. alpha\n2. beta\n\nand a list starting at seven:\n\n7) seven\n8) eight\n"
  ),
  g(
    "corpus/hard-tabs.md",
    "hard tabs must not be expanded into spaces",
    "# Tabs\n\n\tindented with one hard tab\n\t\tindented with two hard tabs\n\n- list\n\t- nested by tab\n\ncolumn\tseparated\tby\ttabs\n\n```\n\tliteral tab inside a fence\n```\n"
  ),
  g(
    "corpus/trailing-spaces.md",
    "trailing whitespace (markdown hard line breaks) must not be trimmed",
    "# Trailing whitespace\n\nline with two trailing spaces  \nnext line after a hard break\n\nline with three trailing spaces   \nline with a trailing tab\t\n\n   \n\nthe line above is whitespace-only\n"
  ),
  g(
    "corpus/no-final-newline.md",
    "a missing final newline must not be added",
    "# No final newline\n\nThe last byte of this file is a period."
  ),
  g("corpus/crlf.md", "a Windows CRLF file must stay CRLF end to end", CRLF_TEXT),
  g(
    "corpus/blank-runs.md",
    "3+ consecutive blank lines must not be collapsed — blank-line multiplicity is preserved",
    "# Blank runs\n\nOne blank line above.\n\n\n\nThree blank lines above this paragraph.\n\n\n\n\n\nFive blank lines above this one.\n\n> quote after two blanks\n\n\nlast\n"
  ),
  g(
    "corpus/age-block.md",
    "an armored ```age fence must round-trip untouched — ciphertext is never re-encoded",
    "# Secrets\n\nEverything below is encrypted at rest.\n\n```age\n-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4...\nZt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp\n-----END AGE ENCRYPTED FILE-----\n```\n\ntrailing prose\n"
  ),
  g(
    "corpus/unicode.md",
    "emoji, ZWJ sequences, combining marks, CJK and RTL must survive byte-for-byte",
    "# Unicode 🌍\n\nemoji: 😀 🚀 ✅ 🇸🇪\nZWJ family: 👨‍👩‍👧‍👦\nskin tone: 👋🏽\ncombining: é (e + U+0301) vs é (U+00E9) — these are different byte sequences\ncjk: 日本語のテキスト・中文文本\nrtl: العربية עברית\nmath: ∀x∈ℝ, x² ≥ 0\nnbsp:[ ] zwsp:[​] nnbsp:[ ]\n"
  ),
  g(
    "corpus/bom.md",
    "a UTF-8 BOM written by an external editor must not be stripped",
    "﻿# BOM document\n\nThe first three bytes are EF BB BF.\n"
  ),
  g("corpus/empty.md", "a zero-byte file must stay zero bytes", ""),
  g("corpus/only-newline.md", "a file that is exactly one newline must stay exactly one newline", "\n"),
  g(
    "corpus/mixed-endings.md",
    "a file mixing LF and CRLF must keep each line ending exactly where it was",
    "# Mixed\r\n\r\nCRLF line\r\nLF line\nCRLF line again\r\n\nfinal LF line\n"
  ),
];

/* NOT part of CORPUS: these bytes are not UTF-8 at all (a Latin-1 é, exactly
   what an old editor leaves behind). There is no lossless string form of them,
   so the contract cannot be "round-trips" — it is "the app refuses to touch
   it". A non-fatal decode would serve U+FFFD and write it back on first save. */
const LATIN1_NAME = "corpus-invalid/latin1.md";
const LATIN1_BYTES = new Uint8Array([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a, 0x0a, 0x62, 0x6f, 0x64, 0x79, 0x0a]);

let srv: TestServer;
let vault: string;

beforeAll(async () => {
  vault = makeVault();
  for (const c of CORPUS) writeVaultFile(vault, c.name, c.bytes);
  writeVaultFile(vault, LATIN1_NAME, LATIN1_BYTES);
  srv = await startServer({ vault });
}, 30000);

afterAll(async () => {
  if (srv) await srv.stop();
  if (vault) dropVault(vault);
});

describe("round-trip gate", () => {
  test("every corpus file is indexed and readable", async () => {
    const r = await srv.get("/api/docs");
    expect(r.status).toBe(200);
    const paths = flatten(r.body.tree).map((n: any) => n.path);
    for (const c of CORPUS) expect(paths).toContain(c.name);
  });

  for (const c of CORPUS) {
    test(`byte-identical round-trip: ${c.name} — ${c.why}`, async () => {
      const onDisk = readVaultBytes(vault, c.name);
      expect(bytesEqual(onDisk, c.bytes)).toBe(true); // fixture sanity

      /* GET must hand back the exact on-disk bytes as the JSON string */
      const got = await srv.doc(c.name);
      expect(got.status).toBe(200);
      expect(typeof got.body.markdown).toBe("string");

      const served = enc.encode(got.body.markdown);
      expect(describeByteDiff(c.bytes, served)).toBe("identical");
      expect(got.body.bytes).toBe(c.bytes.length);

      /* PUT the string straight back — the classic "open it, save it" cycle.
         This alone proves nothing: identical bytes short-circuit before the
         write, so the byte comparison below would be the file against itself. */
      const put = await srv.putDoc(c.name, got.body.markdown, got.body.rev);
      expect(put.status).toBe(200);
      expect(put.body.rev).toBe(got.body.rev);

      /* so force a REAL write cycle: dirty the file, then put the original text
         back. Only this exercises writeDocAtomic on these bytes, which is where
         a CRLF→LF, BOM-stripping or final-newline regression would live. */
      const before = statSync(join(vault, c.name));
      const dirty = await srv.putDoc(c.name, got.body.markdown + "ZZZ", got.body.rev);
      expect(dirty.status).toBe(200);
      const mid = statSync(join(vault, c.name));
      expect(`${c.name} written`).toBe(
        `${c.name} ${mid.ino !== before.ino || mid.mtimeMs !== before.mtimeMs ? "written" : "NOT written"}`
      );
      expect(bytesEqual(readVaultBytes(vault, c.name), c.bytes)).toBe(false);

      const restored = await srv.putDoc(c.name, got.body.markdown, dirty.body.rev);
      expect(restored.status).toBe(200);
      expect(restored.body.rev).toBe(got.body.rev);

      const after = readVaultBytes(vault, c.name);
      expect(describeByteDiff(c.bytes, after)).toBe("identical");

      /* and a second read must still agree, so nothing was normalised on write */
      const again = await srv.doc(c.name);
      expect(again.status).toBe(200);
      expect(describeByteDiff(c.bytes, enc.encode(again.body.markdown))).toBe("identical");
    }, 15000);
  }

  test("a file that is not UTF-8 is never served lossily, and never rewritten", async () => {
    const got = await srv.doc(LATIN1_NAME);
    expect(got.status).toBe(404); // not an editable doc — better than U+FFFD
    expect(got.text).not.toContain("�");

    /* it is not in the tree either, so nothing in the UI can open it */
    const tree = await srv.get("/api/docs");
    expect(flatten(tree.body.tree).map((n: any) => n.path)).not.toContain(LATIN1_NAME);

    /* a save aimed at it must not land: the 0xE9 has to still be there */
    const put = await srv.putDoc(LATIN1_NAME, "# Caf�\n\nbody\none more line\n");
    expect(put.status).toBe(404);
    expect(describeByteDiff(LATIN1_BYTES, readVaultBytes(vault, LATIN1_NAME))).toBe("identical");
  }, 15000);

  test("rev is derived from content: identical bytes ⇒ identical rev", async () => {
    const p = "corpus/frontmatter.md";
    const first = await srv.doc(p);
    expect(first.status).toBe(200);
    const original = first.body.markdown;
    const rev0 = first.body.rev;
    expect(typeof rev0).toBe("string");
    expect(rev0.length).toBeGreaterThan(0);

    const changed = original + "\nan extra paragraph\n";
    const w1 = await srv.putDoc(p, changed, rev0);
    expect(w1.status).toBe(200);
    expect(w1.body.rev).not.toBe(rev0);

    const w2 = await srv.putDoc(p, original, w1.body.rev);
    expect(w2.status).toBe(200);
    expect(w2.body.rev).toBe(rev0);

    const back = await srv.doc(p);
    expect(back.body.rev).toBe(rev0);
    expect(describeByteDiff(enc.encode(original), readVaultBytes(vault, p))).toBe("identical");
  }, 15000);

  test("PUT of identical content returns the same rev and emits no doc-changed", async () => {
    const p = "corpus/setext.md";
    const before = await srv.doc(p);
    expect(before.status).toBe(200);
    const bytesBefore = readVaultBytes(vault, p);

    const sse = await srv.sse();
    try {
      await sse.waitFor("hello", { timeout: 5000 });
      const mark = sse.mark();

      const put = await srv.putDoc(p, before.body.markdown, before.body.rev);
      expect(put.status).toBe(200);
      expect(put.body.rev).toBe(before.body.rev);

      /* generous window: a debounced watcher reconcile would land inside it */
      const events = await sse.collect(900, mark, "doc-changed");
      const forThisDoc = events.filter((e) => e.data && e.data.path === p);
      expect(forThisDoc.map((e) => e.data)).toEqual([]);

      expect(describeByteDiff(bytesBefore, readVaultBytes(vault, p))).toBe("identical");
    } finally {
      sse.close();
    }
  }, 20000);

  test("a real change to the same doc DOES emit doc-changed (the negative above is not vacuous)", async () => {
    const p = "corpus/setext.md";
    const before = await srv.doc(p);
    const sse = await srv.sse();
    try {
      await sse.waitFor("hello", { timeout: 5000 });
      const mark = sse.mark();
      const put = await srv.putDoc(p, before.body.markdown + "\nreally changed\n", before.body.rev);
      expect(put.status).toBe(200);
      const ev = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d && d.path === p,
        timeout: 5000,
      });
      expect(ev.data.reason).toBe("write");
      expect(ev.data.rev).toBe(put.body.rev);

      /* restore so the corpus stays pristine for any later run */
      await srv.putDoc(p, before.body.markdown, put.body.rev);
    } finally {
      sse.close();
    }
  }, 20000);
});

function flatten(nodes: any[]): any[] {
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      out.push(n);
      if (n.type === "folder") walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}
