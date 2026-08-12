/* ============================================================
   linebreaks-e2e.test.ts — Preview's line structure IS the source's (ADR 0015).

   The rule this file holds still has two halves, and both are the kind that
   come back silently: a renderer rewrite that reaches for CommonMark's soft
   break and joins two source lines with a space, and a `blanks - 1` that
   quietly makes the first blank line free again.

   Everything is MEASURED in a real Chromium against the real backend — rects
   and line boxes, never a class name, because "the break rendered" is a claim
   about geometry. The unit throughout is the body line box, read from the
   paragraph's own computed `line-height` so the assertions hold at either
   density and in any theme.

   Four groups:

     · BREAKS — n source lines are n rendered lines, in ONE block, each on its
       own line box, and a line still WRAPS when it is wider than the column
       (the failure mode of a fix that reaches for `white-space: pre-wrap`).
     · BLANKS — every blank line buys exactly one line box, 1/2/3 of them, and
       the two exceptions (leading, trailing) emit nothing.
     · CLICK — each rendered line carries its own [data-line], so click-to-edit
       lands the caret on the line that was clicked and not on the block's
       first. Under this rule a paragraph is routinely many lines, which is
       what makes that distinction matter.
     · SOURCE — none of the above is allowed to cost a byte on disk.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

/* ------------------------------------------------------------------
   the documents under measurement — one rule each, so a failure names itself
   ------------------------------------------------------------------ */

/* line: 0 "# Lines" · 1 "" · 2 alpha · 3 bravo · 4 charlie · 5 "" · 6 delta */
const PARA_SRC = "# Lines\n\nalpha\nbravo\ncharlie\n\ndelta\n";

/* one, two · 1 blank · three · 2 blanks · four · 3 blanks · five */
const GAPS_SRC = "one\ntwo\n\nthree\n\n\nfour\n\n\n\nfive\n";

/* a quote is prose too, and its EMPTY line ("> " alone) used to vanish into
   the join — it is a blank line and now renders as one */
const QUOTE_SRC = "> one\n> two\n>\n> four\n";

/* far wider than any column this app is rendered in, and spaces throughout so
   a pass cannot come from `overflow-wrap: anywhere` chopping a giant token */
const LONG =
  "the paragraph keeps its own newlines now but it must still reflow a line " +
  "that is genuinely wider than the column it is being read in, because that " +
  "is a property of the column and not of the file, and a fix that reached " +
  "for white-space pre-wrap would have taken it away without saying so.";

const PARA = "lines/para.md";
const GAPS = "lines/gaps.md";
const QUOTE = "lines/quote.md";
const LONG_DOC = "lines/long.md";
const LEAD = "lines/lead.md";
const PLAIN = "lines/plain.md";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [PARA]: PARA_SRC,
  [GAPS]: GAPS_SRC,
  [QUOTE]: QUOTE_SRC,
  [LONG_DOC]: "# Long\n\n" + LONG + "\n",
  /* two leading blanks, and a trailing run — the two exceptions */
  [LEAD]: "\n\n# Top\n\nbody\n\n\n",
  [PLAIN]: "# Top\n\nbody\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* ------------------------------------------------------------------
   page helpers
   ------------------------------------------------------------------ */

async function open(path: string) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, path);
  await page.waitForSelector("#doc .md", { timeout: 15000 });
  await sleep(160); // .doc transitions its padding
}

/** Every rendered line on the page, in document order, with the geometry that
    proves it IS a line: its own top, and the line box it was laid out in. */
function readLines() {
  return page.evaluate(() => {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const md = document.querySelector("#doc .md") as HTMLElement;
    /* the line box is read from the block the lines are IN — a blockquote has
       its own type, and measuring its lines against a paragraph's line-height
       would be comparing two different rulers */
    const first = md.querySelector(".pline");
    const cs = getComputedStyle((first?.parentElement ?? md) as HTMLElement);
    return {
      lineBox: r2(parseFloat(cs.lineHeight)),
      blkGap: r2(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--d-blk-gap")) || 0),
      blocks: [...md.children].map((c) => c.tagName.toLowerCase() + (c.className ? "." + c.className : "")),
      paras: md.querySelectorAll(":scope > p").length,
      bgaps: md.querySelectorAll(":scope > .bgap").length,
      lines: [...md.querySelectorAll(".pline")].map((n) => ({
        text: n.textContent ?? "",
        line: n.getAttribute("data-line"),
        top: r2(n.getBoundingClientRect().top),
        /* one entry per LINE BOX the span was laid out in — a wrapped line is
           one .pline with several, which is how wrapping stays visible here */
        boxes: new Set([...n.getClientRects()].map((b) => Math.round(b.top))).size,
      })),
      mdTop: r2(md.getBoundingClientRect().top),
      firstBlockTop: r2((md.firstElementChild as HTMLElement).getBoundingClientRect().top),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** byte offset of the start of source line `n` — what `lineOffset` in
    editor.js computes, restated here so the caret assertion has an
    independent answer to compare against */
const offsetOf = (src: string, n: number) =>
  src.split("\n").slice(0, n).reduce((a, l) => a + l.length + 1, 0);

/* ============================================================
   1 · BREAKS — one newline is one line
   ============================================================ */

describe("a newline in the source is a line break in Preview", () => {
  test("three source lines are three rendered lines, one line box apart", async () => {
    await open(PARA);
    const m = await readLines();

    /* the block grammar is untouched: the three lines are still ONE paragraph,
       not three (which would put a block gap between each pair) */
    expect(`paragraphs: ${m.paras}, rendered lines: ${m.lines.length}`).toBe("paragraphs: 2, rendered lines: 4");
    expect(`texts: ${m.lines.map((l) => l.text).join("|")}`).toBe("texts: alpha|bravo|charlie|delta");

    const [alpha, bravo, charlie] = m.lines;
    expect(`alpha and bravo share a line: ${alpha.top === bravo.top}`).toBe("alpha and bravo share a line: false");
    /* the measurement that IS the rule: consecutive source lines sit exactly
       one body line box apart — no gap, no join */
    const d1 = bravo.top - alpha.top;
    const d2 = charlie.top - bravo.top;
    expect(`bravo is one line box (${m.lineBox}px) below alpha: ${Math.abs(d1 - m.lineBox) < 1.2}`).toBe(
      `bravo is one line box (${m.lineBox}px) below alpha: true`
    );
    expect(`charlie is one line box below bravo: ${Math.abs(d2 - m.lineBox) < 1.2}`).toBe(
      "charlie is one line box below bravo: true"
    );
  }, 90000);

  test("each rendered line carries the source line it came from", async () => {
    await open(PARA);
    const m = await readLines();
    expect(`data-line: ${m.lines.map((l) => l.line).join(",")}`).toBe("data-line: 2,3,4,6");
  }, 60000);

  test("a quote breaks the same way, and its empty line is a line", async () => {
    await open(QUOTE);
    const m = await readLines();
    expect(`quote lines: ${m.lines.length}`).toBe("quote lines: 4");
    expect(`texts: ${m.lines.map((l) => JSON.stringify(l.text)).join("|")}`).toBe(
      'texts: "one"|"two"|""|"four"'
    );
    /* the empty one occupies a line box rather than collapsing: four lines
       spanning three gaps of one box each */
    const span = m.lines[3].top - m.lines[0].top;
    expect(`four quote lines span three line boxes: ${Math.abs(span - 3 * m.lineBox) < 1.5}`).toBe(
      "four quote lines span three line boxes: true"
    );
  }, 60000);

  test("a line WIDER than the column still wraps — this is not `pre-wrap`", async () => {
    await open(LONG_DOC);
    const m = await readLines();
    expect(`source lines rendered: ${m.lines.length}`).toBe("source lines rendered: 1");
    /* one source line, several line boxes: the reflow that belongs to the
       column is still happening, and the page has nothing to scroll sideways */
    expect(`the long line needed more than one line box: ${m.lines[0].boxes > 1}`).toBe(
      "the long line needed more than one line box: true"
    );
    expect(`the page scrolls sideways: ${m.docOverflow > 0}`).toBe("the page scrolls sideways: false");
  }, 60000);
});

/* ============================================================
   2 · BLANKS — every blank line is a blank line
   ============================================================ */

describe("a blank line in the source is a blank line in Preview", () => {
  test("one, two and three blanks buy one, two and three line boxes", async () => {
    await open(GAPS);
    const m = await readLines();
    expect(`rendered lines: ${m.lines.map((l) => l.text).join("|")}`).toBe("rendered lines: one|two|three|four|five");

    const top = (t: string) => m.lines.find((l) => l.text === t)!.top;
    /* deltas measured top-to-top, so each is "one line box for the line itself,
       plus one for every blank above it, plus the block gap between blocks" */
    const plain = top("two") - top("one"); // no blank at all
    const cases: Array<[string, number, number]> = [
      ["1 blank", top("three") - top("two"), 2],
      ["2 blanks", top("four") - top("three"), 3],
      ["3 blanks", top("five") - top("four"), 4],
    ];
    expect(`no blank at all is one line box: ${Math.abs(plain - m.lineBox) < 1.2}`).toBe(
      "no blank at all is one line box: true"
    );
    for (const [name, got, boxes] of cases) {
      const want = boxes * m.lineBox + m.blkGap;
      expect(`${name}: ${Math.abs(got - want) < 1.5} (${got}px vs ${want}px)`).toBe(
        `${name}: true (${got}px vs ${want}px)`
      );
    }
    /* and the mechanism is the one the CSS knows about, not a stack of empty
       paragraphs: three separators for three blank runs */
    expect(`bgap elements: ${m.bgaps}`).toBe("bgap elements: 3");
  }, 90000);

  test("blank lines above the first block and below the last render nothing", async () => {
    await open(LEAD);
    const lead = await readLines();
    await open(PLAIN);
    const plain = await readLines();

    /* two leading newlines in the file, no void at the top of the document:
       the heading is the FIRST thing emitted, exactly as in the file without
       them (the one bgap in this doc is the blank between heading and body) */
    expect(`first block: ${lead.blocks[0]}, gaps in the doc: ${lead.bgaps}`).toBe("first block: h1, gaps in the doc: 1");
    expect(`the first block sits where it does without them: ${lead.firstBlockTop === plain.firstBlockTop}`).toBe(
      "the first block sits where it does without them: true"
    );
    /* the file's terminating newline is a trailing blank; honouring those would
       hang an empty line under every document in the vault */
    expect(`last block is the body, not a gap: ${lead.blocks[lead.blocks.length - 1]}`).toBe(
      "last block is the body, not a gap: p"
    );
  }, 90000);
});

/* ============================================================
   3 · CLICK — the caret lands on the line that was clicked
   ============================================================ */

describe("click-to-edit reaches the clicked line, not the block's first", () => {
  test("clicking the third line of a paragraph opens Raw at the third line", async () => {
    await open(PARA);
    await page.click('.pline[data-line="4"]');
    await page.waitForSelector("#rawArea", { timeout: 10000 });
    const caret = await page.evaluate(() => (document.getElementById("rawArea") as HTMLTextAreaElement).selectionStart);
    const want = offsetOf(PARA_SRC, 4);
    expect(`caret at ${caret} (line 4 starts at ${want})`).toBe(`caret at ${want} (line 4 starts at ${want})`);
    /* the assertion is only worth something if the block's own answer differs */
    expect(`the block would have said ${offsetOf(PARA_SRC, 2)}`).toBe("the block would have said 9");
  }, 90000);

  test("clicking the first line still opens Raw at the first line", async () => {
    await open(PARA);
    await page.click('.pline[data-line="2"]');
    await page.waitForSelector("#rawArea", { timeout: 10000 });
    const caret = await page.evaluate(() => (document.getElementById("rawArea") as HTMLTextAreaElement).selectionStart);
    expect(`caret at ${caret}`).toBe(`caret at ${offsetOf(PARA_SRC, 2)}`);
  }, 60000);
});

/* ============================================================
   4 · SOURCE — a rendering rule may not cost a byte
   ============================================================ */

describe("rendering is a rendering choice and does not touch the file", () => {
  test("every document is byte-identical to what was seeded", async () => {
    for (const [path, src] of Object.entries(SEED)) {
      const r = await srv.doc(path);
      expect(`${path}: ${JSON.stringify(r.body.markdown)}`).toBe(`${path}: ${JSON.stringify(src)}`);
    }
  }, 60000);

  test("nothing threw while any of that rendered", () => {
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  });
});
