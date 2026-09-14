/* ============================================================
   linebreaks-e2e.test.ts — Edit's line structure IS the source's (ADR 0015).

   One `\n` in the file is one visual line break in the BlockNote island, and it
   round-trips unchanged. The failure mode is silent: an adapter that reaches
   for CommonMark's soft break joins two source lines with a space, and an
   editor that serialises a `break` node writes two trailing spaces into a file
   that never had them.

   Everything is MEASURED in a real Chromium against the real backend — rects
   and line boxes, never a class name, because "the break rendered" is a claim
   about geometry. A soft break inside a block is a `<br>` in one
   `.bn-inline-content`, so the unit here is the RANGE around each text run:
   its first client rect is where that run sits, and the NUMBER of rects is how
   many line boxes it needed (which is how wrapping stays visible).

   Three groups:

     · BREAKS — n source lines are n rendered lines, in ONE block, each on its
       own line box, and a line still WRAPS when it is wider than the column
       (the failure mode of a fix that reaches for `white-space: pre-wrap`).
     · BLANKS — the two exceptions still emit nothing: blank lines above the
       first block and below the last. Blank-line MULTIPLICITY is no longer a
       visual fact — the adapter parses 1, 2 and 3 blank lines into the same
       separated blocks and gives the bytes back untouched (ADR 0037 retired
       the hand-written renderer that painted `.bgap` separators), so what
       holds the rule now is the byte round-trip below.
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

/* a quote is prose too, and its newline is the same newline */
const QUOTE_SRC = "> one\n> two\n";

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

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [PARA]: PARA_SRC,
  [GAPS]: GAPS_SRC,
  [QUOTE]: QUOTE_SRC,
  [LONG_DOC]: "# Long\n\n" + LONG + "\n",
  /* two leading blanks, and a trailing run — the two exceptions */
  [LEAD]: "\n\n# Top\n\nbody\n\n\n",
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

/** The island mounts ASYNCHRONOUSLY after `renderDoc`, and `.bn-block-content`
    carries `transition: font-size .2s` — so wait for the editor AND for the
    animations to finish before measuring anything. */
async function open(path: string) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, path);
  await page.waitForSelector("#doc .bn-editor", { timeout: 20000 });
  await page.$eval("#doc", async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished));
  });
  await sleep(160); // .doc transitions its padding
}

/**
 * Every block in the island, and — for the block holding the text — the
 * geometry that proves a `\n` became a LINE.
 *
 * A soft break is a `<br>` inside one `.bn-inline-content`, so the element's
 * own rect says nothing: what is measured is a RANGE around each text run.
 * `top` is where that run was laid out, `boxes` is how many line boxes it
 * needed, and the `line-height` is read off the block the runs are IN (a quote
 * is its own block type, and measuring its runs against a paragraph's ruler
 * would be comparing rulers).
 */
function readLines(type: string) {
  return page.evaluate((contentType) => {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const editor = document.querySelector("#doc .bn-editor") as HTMLElement;
    const blocks = [...editor.querySelectorAll(".bn-block-content")] as HTMLElement[];
    const host = blocks.find((b) => b.dataset.contentType === contentType)!;
    const inline = host.querySelector(".bn-inline-content") as HTMLElement;
    const runs: { text: string; top: number; boxes: number }[] = [];
    for (const node of [...inline.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      runs.push({
        text: node.textContent ?? "",
        top: r2(rects[0]!.top),
        boxes: new Set(rects.map((r) => Math.round(r.top))).size,
      });
    }
    return {
      lineBox: r2(parseFloat(getComputedStyle(inline).lineHeight)),
      types: blocks.map((b) => b.dataset.contentType + (b.dataset.level ? ":" + b.dataset.level : "")),
      breaks: inline.querySelectorAll("br").length,
      runs,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, type);
}

/* ============================================================
   1 · BREAKS — one newline is one line
   ============================================================ */

describe("a newline in the source is a visual line break in Edit", () => {
  test("three source lines are three rendered lines, one line box apart", async () => {
    await open(PARA);
    const m = await readLines("paragraph");

    /* the block grammar is untouched: the three lines are still ONE paragraph,
       not three (which would put a block gap between each pair) */
    expect(`blocks: ${m.types.join("|")}`).toBe("blocks: heading|paragraph|paragraph");
    expect(`runs in the first paragraph: ${m.runs.map((r) => r.text).join("|")}`).toBe(
      "runs in the first paragraph: alpha|bravo|charlie"
    );
    expect(`and they are separated by breaks, not by blocks: ${m.breaks}`).toBe(
      "and they are separated by breaks, not by blocks: 2"
    );

    const [alpha, bravo, charlie] = m.runs;
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

  test("a quote breaks the same way", async () => {
    await open(QUOTE);
    const m = await readLines("quote");
    expect(`quote runs: ${m.runs.map((r) => r.text).join("|")}`).toBe("quote runs: one|two");
    const span = m.runs[1].top - m.runs[0].top;
    expect(`the second quote line is one line box below the first: ${Math.abs(span - m.lineBox) < 1.5}`).toBe(
      "the second quote line is one line box below the first: true"
    );
  }, 60000);

  test("a line WIDER than the column still wraps — this is not `pre-wrap` alone", async () => {
    await open(LONG_DOC);
    const m = await readLines("paragraph");
    expect(`source lines rendered: ${m.runs.length}, breaks: ${m.breaks}`).toBe("source lines rendered: 1, breaks: 0");
    /* one source line, several line boxes: the reflow that belongs to the
       column is still happening, and the page has nothing to scroll sideways */
    expect(`the long line needed more than one line box: ${m.runs[0].boxes > 1}`).toBe(
      "the long line needed more than one line box: true"
    );
    expect(`the page scrolls sideways: ${m.docOverflow > 0}`).toBe("the page scrolls sideways: false");
  }, 60000);
});

/* ============================================================
   2 · BLANKS — the two exceptions still emit nothing

   MULTIPLICITY is deliberately absent here. In Edit a blank run is block
   separation, not a rendered line: `GAPS_SRC`'s one, two and three blank lines
   all parse to the same four separated paragraphs, and the adapter hands the
   original bytes back untouched. The rule that remains enforceable is the byte
   round-trip in §3, which `GAPS` is seeded for.
   ============================================================ */

describe("a blank line in the source costs no block in Edit", () => {
  test("blank lines above the first block and below the last render nothing", async () => {
    await open(LEAD);
    const lead = await readLines("paragraph");

    /* two leading newlines in the file, no empty block at the top of the
       document: the heading is the FIRST thing emitted, exactly as in the file
       without them. The file's terminating newline plus its trailing run is the
       other exception — honouring those would hang an empty block under every
       document in the vault. */
    expect(`blocks: ${lead.types.join("|")}`).toBe("blocks: heading|paragraph");
    expect(`the body is the last block: ${lead.types[lead.types.length - 1]}`).toBe("the body is the last block: paragraph");
  }, 90000);

  test("the blank runs are still in the file, all three of them", async () => {
    await open(GAPS);
    const m = await readLines("paragraph");
    /* four paragraphs, whatever the gaps between them were */
    expect(`blocks: ${m.types.join("|")}`).toBe("blocks: paragraph|paragraph|paragraph|paragraph");
    /* …and the model the editor is holding is the file, byte for byte */
    const held = await page.evaluate(async () => {
      const { state } = await import("/state.js");
      return state.docs.get(state.active).markdown as string;
    });
    expect(`the buffer: ${JSON.stringify(held)}`).toBe(`the buffer: ${JSON.stringify(GAPS_SRC)}`);
  }, 90000);
});

/* ============================================================
   3 · SOURCE — a rendering rule may not cost a byte
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
