/* ============================================================
   rawedit.test.ts — the two pure passes behind the Raw line editor.

   `classifyLines` decides how big a source line is drawn and `linkRanges`
   decides what is coloured, so both are answers about UNTRUSTED file content
   and both must agree with what Preview does with the same bytes. Imported
   directly (prior art: tests/markdown-inline.test.ts) — neither touches the
   DOM, so neither needs a browser.
   ============================================================ */

import { test, expect } from "bun:test";
import { classifyLines, linkRanges } from "../app/rawedit.js";

test("a line is the size of the Preview block it would render as", () => {
  const cases: [string, string[]][] = [
    ["# one\n## two\n### three", ["h1", "h2", "h3"]],
    /* Preview renders only #–###; #### is a paragraph there and body here */
    ["#### four\n#nospace\nplain", ["", "", ""]],
    ["a\n\nb", ["", "", ""]],
    /* the fence lines are code too, so ``` never grows into a heading */
    ["```\n# not a heading\n```\nafter", ["code", "code", "code", ""]],
    ["  ```js\n# inside\n  ```\n# outside", ["code", "code", "code", "h1"]],
    /* an unterminated fence swallows the rest of the file, as the renderer does */
    ["```\n# still code", ["code", "code"]],
  ];
  for (const [src, want] of cases) {
    expect(`${JSON.stringify(src)} → ${classifyLines(src).join("|")}`).toBe(`${JSON.stringify(src)} → ${want.join("|")}`);
  }
});

/** the spellings, not the offsets — an offset table proves nothing a reader
    can check against the source line beside it */
const spellings = (src: string) => linkRanges(src).map((r) => src.slice(r.start, r.end));

test("every spelling Preview links is highlighted, and nothing else is", () => {
  const cases: [string, string[]][] = [
    ["see [[other note]] please", ["[[other note]]"]],
    ["a [text](https://example.com) b", ["[text](https://example.com)"]],
    ["mail [me](mailto:z@example.com)", ["[me](mailto:z@example.com)"]],
    /* only http(s)/mailto ever becomes a link (ADR 0016) */
    ["danger [x](javascript:alert(1))", []],
    ["<https://example.com/a>", ["<https://example.com/a>"]],
    ["bare https://example.com/a and on", ["https://example.com/a"]],
    /* the sentence's punctuation is not part of the URL */
    ["see https://example.com/a).", ["https://example.com/a"]],
    ["wiki https://en.wikipedia.org/wiki/A_(b) end", ["https://en.wikipedia.org/wiki/A_(b)"]],
    /* a fence and a code span both promise their contents are literal */
    ["`https://example.com` stays plain", []],
    ["`[[wiki]]` too", []],
    ["```\nhttps://example.com\n[[wiki]]\n```", []],
    /* two on one line, and one is inside the other's label */
    ["[[a]] and [b](https://x.dev/c)", ["[[a]]", "[b](https://x.dev/c)"]],
  ];
  for (const [src, want] of cases) {
    expect(`${JSON.stringify(src)} → ${JSON.stringify(spellings(src))}`).toBe(
      `${JSON.stringify(src)} → ${JSON.stringify(want)}`
    );
  }
});

test("ranges are offsets into the whole document, across lines", () => {
  const src = "# T\n\nsee [[x]]\n";
  const [r] = linkRanges(src);
  expect(`${r.start}..${r.end} = ${JSON.stringify(src.slice(r.start, r.end))}`).toBe('9..14 = "[[x]]"');
});
