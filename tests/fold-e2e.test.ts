/* ============================================================
   fold-e2e.test.ts — Preview's sections fold, and the file never hears about
   it (ADR 0023).

   Folding is a VIEW state laid over the rendered DOM as a post-pass, which is
   the whole reason it needs a browser to be checked at all: the claims are
   "this block is not on screen", "that one still is", and "the chevron is
   there only when it has something to say". None of those is visible from the
   markdown, and all of them are one CSS rule away from being quietly wrong.

   Seven groups:

     · CHEVRONS — one on every h1–h3 THAT HAS SOMETHING UNDER IT and on every
       list item that has a sub-list, and on nothing else. A section holding
       nothing, or holding only blank lines, folds to exactly what it already
       looks like, so it gets no control at all.
     · RANGES — a folded heading hides its own section and stops at the next
       heading of its rank; folds nest; a list item hides only its own list.
     · VISIBILITY — hover-revealed while open, always there while closed.
     · MEMORY — the fold survives a re-render (⌘E and back) and a reload.
     · ORDINALS — two identical headings are two different folds, and the
       second one's chevron folds the second one's range.
     · JUMP — ⌘K onto a line inside a folded section unfolds exactly what was
       covering it, nothing else, and lands the pane on it.
     · SOURCE — none of it costs a byte, and the chevron is not a click-to-edit
       zone while the heading's text still is.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { ensureMode, launchTestBrowser, newAppPage, pressChord, waitForApp } from "./browser";

/* One document, structured so every rule has a boundary to get wrong: an h3
   nested inside an h2's range (so a fold can compose), a second h2 that a fold
   of the first must NOT reach, blank lines everywhere (a `.bgap` belongs to the
   section it sits in), and a list whose first item has children while the other
   two — one of them a task — do not.

   line: 0 "# Notes" · 4 "## Alpha" · 8 "### Alpha detail" · 12 "## Bravo"
         16 "- top one" · 17/18 the kids · 19 "- top two" · 20 the task */
const SRC = [
  "# Notes",
  "",
  "intro",
  "",
  "## Alpha",
  "",
  "alpha body",
  "",
  "### Alpha detail",
  "",
  "detail body",
  "",
  "## Bravo",
  "",
  "bravo body",
  "",
  "- top one",
  "  - kid one",
  "  - kid two",
  "- top two",
  "- [ ] a task",
  "",
].join("\n");

const DOC = "folds/outline.md";

/* ------------------------------------------------------------------
   …and a SECOND document, for the two things the outline above cannot say.

   It is TALL on purpose. Both of the claims below this line are about
   geometry — "the block the search hit named is the block the reader is now
   looking at" — and a document that fits on one screen cannot make them: the
   pane never has to move, so any arithmetic at all would pass. So there is
   filler above the targets (an un-scrolled pane puts them a long way down) and
   filler below them (the scroller has somewhere to go; without it `scrollTop`
   clamps at the bottom and the landing is an accident of the document's
   length rather than the anchor doing its job).

   Its shape carries three fixtures at once:

     · the A / B / C stack — `## A` holding `### B` and `### C`, which is the
       arrangement where "the nearest folded heading above" and "the folded
       heading whose range actually reaches here" are DIFFERENT answers. With
       A and B both folded, only A is hiding `c body`: B's range ended at C.
     · a nested list item (`deep kid`) under a foldable parent, sitting deep in
       the document. Every `li` is `position: relative` (it has to be — the
       chevron is absolutely positioned inside it), so a nested item's
       `offsetParent` is its PARENT ITEM, not the scroller.
     · two `## Log` sections, identical down to their list items, which is the
       only way to see an ordinal do its job.

   Nothing in it contains the letters of either search query out of order, so
   `c body` and `deep kid` each match exactly one line in the whole vault —
   the palette's search is a fuzzy subsequence, not a substring. */
const filler = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => [`${tag} filler ${i + 1}`, ""]).flat();

const JUMP_SRC = [
  "# Jump",
  "",
  ...filler("upper", 30),
  "## A",
  "",
  "a body",
  "",
  "### B",
  "",
  "b body",
  "",
  "### C",
  "",
  "c body",
  "",
  ...filler("middle", 6),
  "## Kids",
  "",
  "- parent item",
  "  - deep kid",
  "  - other kid",
  "- lone item",
  "",
  ...filler("lower", 24),
  "## Log",
  "",
  "- entry one",
  "  - entry detail",
  "- entry two",
  "",
  "log body one",
  "",
  "## Log",
  "",
  "- entry one",
  "  - entry detail",
  "- entry two",
  "",
  "log body two",
  "",
  "## Tail",
  "",
  "tail body",
  "",
  ...filler("tail", 24),
].join("\n");

const JUMP = "folds/jump.md";

/* four list levels — the spine and the deep-fold rules need real depth to be
   wrong about */
const DEEP_SRC = ["# Deep", "", "- one", "  - two", "    - three", "      - four leaf", "  - two-b", "- one-b", ""].join("\n");
const DEEP = "folds/deep.md";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [DOC]: SRC,
  [JUMP]: JUMP_SRC,
  [DEEP]: DEEP_SRC,
};

/* the fold keys of the document above — content plus ordinal, which is the
   whole point of them: nothing here is a line number */
const H_NOTES = "h1:Notes:0";
const H_ALPHA = "h2:Alpha:0";
const H_DETAIL = "h3:Alpha detail:0";
const H_BRAVO = "h2:Bravo:0";
const LI_TOP = "li:top one:0";

/* …and of folds/jump.md. The `:1`s are the whole point of this half of the
   file: two `## Log` headings are two folds, not one. */
const J_A = "h2:A:0";
const J_B = "h3:B:0";
const J_LOG_1ST = "h2:Log:0";
const J_LOG_2ND = "h2:Log:1";
const J_ENTRY_1ST = "li:entry one:0";
const J_ENTRY_2ND = "li:entry one:1";

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

async function open(path = DOC) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, path);
  await page.waitForSelector("#doc .md", { timeout: 15000 });
  await sleep(160); // .doc transitions its padding
}

/** …and with the remembered folds thrown away first, so a test states its own
    starting point rather than inheriting the one before it. */
async function fresh(path = DOC) {
  await page.evaluate(() => {
    try {
      localStorage.removeItem("znotes.folds");
    } catch {}
  });
  await open(path);
}

const owner = (key: string) => `#doc .md [data-fold="${key}"]`;

/** where the chevron's gutter pad actually is — it is a pseudo-element, so
    there is no node to ask and the geometry has to be read off the style */
async function padPoint(key: string) {
  return page.evaluate((k) => {
    const b = document.querySelector(`#doc .md [data-fold="${k}"] > .fold`) as HTMLElement;
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b, "::before");
    return { x: r.left + parseFloat(cs.left) + parseFloat(cs.width) / 2, y: r.top + parseFloat(cs.height) / 2 };
  }, key);
}

/**
 * Press one chevron the way a person does: over the block first, then out into
 * the gutter. While the section is open the pad takes no pointer at all until
 * something hovers its owner, so a click issued cold would land on the pane.
 */
async function foldClick(key: string) {
  await page.hover(owner(key));
  const pt = await padPoint(key);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  await sleep(90);
}

/** every top-level block of the document, named and marked shown/hidden */
function outline() {
  return page.evaluate(() => {
    const md = document.querySelector("#doc .md")!;
    return [...md.children]
      .map((c) => {
        const tag = c.tagName.toLowerCase();
        const label = c.classList.contains("bgap")
          ? "gap"
          : /^h[123]$/.test(tag)
            ? tag + ":" + (c.textContent ?? "").trim()
            : tag === "p"
              ? "p:" + (c.textContent ?? "").trim()
              : tag;
        /* a rect, not a class name: "hidden" here means the reader cannot see
           it, which is a claim about layout */
        return label + "=" + (c.getClientRects().length ? "shown" : "hidden");
      })
      .join(", ");
  });
}

/** the same question for list items, which are hidden by their parent's class */
function items() {
  return page.evaluate(() => {
    const md = document.querySelector("#doc .md")!;
    return [...md.querySelectorAll("li")]
      .map((li) => (li.querySelector(":scope > .tx")?.textContent ?? "?") + "=" + (li.getClientRects().length ? "shown" : "hidden"))
      .join(", ");
  });
}

/** which blocks are carrying a chevron, in document order */
const chevrons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#doc .md .fold")].map((b) => (b.parentElement as HTMLElement).dataset.fold).join(" | ")
  );

/** the chevron is drawn in pseudo-elements, so this is what "visible" means */
const chevOpacity = (key: string) =>
  page.evaluate((k) => {
    const b = document.querySelector(`#doc .md [data-fold="${k}"] > .fold`) as HTMLElement | null;
    return b ? getComputedStyle(b, "::after").opacity : "no chevron";
  }, key);

/** byte offset of the start of source line `n` — what the caret should land on */
const offsetOf = (src: string, n: number) => src.split("\n").slice(0, n).reduce((a, l) => a + l.length + 1, 0);

/* ------------------------------------------------------------------
   helpers for the tall document — where naming a block by its position in a
   300-line outline would say nothing, and the interesting blocks all have
   unique text instead
   ------------------------------------------------------------------ */

/** shown/hidden for the named top-level blocks, found by their own text */
function blocks(...names: string[]) {
  return page.evaluate((want) => {
    const md = document.querySelector("#doc .md")!;
    return want
      .map((w) => {
        const n = [...md.children].find((c) => (c.textContent ?? "").trim() === w);
        /* a rect again, not a class: "hidden" is a claim about what a reader
           can see, and `.fold-hidden` is only how it is currently spelled */
        return w + "=" + (!n ? "missing" : n.getClientRects().length ? "shown" : "hidden");
      })
      .join(", ");
  }, names);
}

/** which foldable blocks are currently collapsed, in document order */
const collapsed = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#doc .md [data-fold]")]
      .filter((n) => n.classList.contains("folded"))
      .map((n) => (n as HTMLElement).dataset.fold)
      .join(" | ")
  );

/** what localStorage has been left holding for one document */
const remembered = (path: string) =>
  page.evaluate((p) => {
    try {
      const all = JSON.parse(localStorage.getItem("znotes.folds") || "{}");
      return (all[p] || []).join(" | ");
    } catch {
      return "unreadable";
    }
  }, path);

/**
 * How far below the top of the scroller a block is sitting, plus the two
 * numbers that say whether the question was worth asking: the pane really had
 * to move to get there, and it was not simply pinned at the bottom.
 */
function landing(text: string) {
  return page.evaluate((t) => {
    const sc = document.getElementById("scroll")!;
    const md = document.querySelector("#doc .md")!;
    const node =
      [...md.children].find((c) => (c.textContent ?? "").trim() === t) ??
      [...md.querySelectorAll("li")].find((li) => (li.querySelector(":scope > .tx")?.textContent ?? "").trim() === t);
    if (!node) return { top: NaN, scrollTop: sc.scrollTop, room: 0 };
    return {
      top: node.getBoundingClientRect().top - sc.getBoundingClientRect().top,
      scrollTop: sc.scrollTop,
      room: sc.scrollHeight - sc.clientHeight - sc.scrollTop,
    };
  }, text);
}

/** `revealLine`'s anchor: the block it scrolled to is put this far down the pane */
const ANCHOR = 110;

/**
 * How far off that anchor a landing is still allowed to be.
 *
 * Not "a rounding error": `renderDoc` arms `.doc.fade-in`, whose first
 * keyframe translates the column down 6px, and `revealLine` reads its
 * rectangles in the same task — so the scroll it computes is 6px too far and
 * the block settles that much high once the animation ends. MEASURED, with the
 * entrance animation suppressed and then restored: 108.75px vs 103px for the
 * same jump on the same document. It is a 6px cosmetic error and nothing here
 * is the place to fix it; what this file is holding down is the difference
 * between 110 and "the top of the document", which is three orders of
 * magnitude bigger.
 */
const ANCHOR_TOL = 8;

/** A measured distance, reported AS the number it was supposed to be when it
    is within `tol` — so a passing run reads as the claim and a failing one
    prints what was actually on screen. */
const near = (v: number, want: number, tol = ANCHOR_TOL) =>
  Math.abs(v - want) <= tol ? String(want) : String(Math.round(v));

/**
 * The real jump-to-line path, driven the way a person drives it: ⌘K, type,
 * click the LINE hit whose snippet carries `needle`.
 *
 * This is `openDoc(path, { line })` — the one entry into `revealLine` a user
 * can actually reach in Preview — and it is taken with a real mouse click on
 * the result row rather than `node.click()`, because half of what is being
 * measured here is geometry and a synthetic click would skip the part where
 * the palette is a real overlay above a real pane.
 */
async function palJump(query: string, needle: string) {
  await pressChord(page, "KeyK");
  await page.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), { timeout: 8000 });
  await page.focus("#palInput");
  await page.keyboard.type(query);
  /* the palette opens pre-populated with every doc, so "any result" would pass
     before the query ran — wait for the LINE hit, which is the one with a
     snippet (`.sn`) under its name */
  const hit = `#palList .pal-item .sn`;
  await page.waitForFunction(
    (sel, n) => [...document.querySelectorAll(sel)].some((s) => (s.textContent ?? "").includes(n)),
    { timeout: 8000 },
    hit,
    needle
  );
  const box = await page.evaluate(
    (sel, n) => {
      const sn = [...document.querySelectorAll(sel)].find((s) => (s.textContent ?? "").includes(n))!;
      const row = sn.closest(".pal-item") as HTMLElement;
      row.scrollIntoView({ block: "nearest" });
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (row.textContent ?? "").trim() };
    },
    hit,
    needle
  );
  await page.mouse.click(box.x, box.y);
  await page.waitForFunction(() => !document.getElementById("palVeil")!.classList.contains("show"), { timeout: 8000 });
  /* `renderDoc` arms the `.fade-in` entrance, which translates the column 6px
     while it plays. Let it finish before anything measures a rectangle. */
  await sleep(420);
  return box.label;
}

const ALL_OPEN =
  "h1:Notes=shown, gap=shown, p:intro=shown, gap=shown, h2:Alpha=shown, gap=shown, p:alpha body=shown, " +
  "gap=shown, h3:Alpha detail=shown, gap=shown, p:detail body=shown, gap=shown, h2:Bravo=shown, gap=shown, " +
  "p:bravo body=shown, gap=shown, ul=shown";

const ALPHA_FOLDED =
  "h1:Notes=shown, gap=shown, p:intro=shown, gap=shown, h2:Alpha=shown, gap=hidden, p:alpha body=hidden, " +
  "gap=hidden, h3:Alpha detail=hidden, gap=hidden, p:detail body=hidden, gap=hidden, h2:Bravo=shown, gap=shown, " +
  "p:bravo body=shown, gap=shown, ul=shown";

const DETAIL_FOLDED =
  "h1:Notes=shown, gap=shown, p:intro=shown, gap=shown, h2:Alpha=shown, gap=shown, p:alpha body=shown, " +
  "gap=shown, h3:Alpha detail=shown, gap=hidden, p:detail body=hidden, gap=hidden, h2:Bravo=shown, gap=shown, " +
  "p:bravo body=shown, gap=shown, ul=shown";

/* ============================================================
   1 · CHEVRONS — only where there is something to fold
   ============================================================ */

describe("the chevron appears exactly where something can be folded", () => {
  test("every heading and every list item WITH children is foldable; nothing else is", async () => {
    await fresh();
    const owners = await page.evaluate(() =>
      [...document.querySelectorAll("#doc .md [data-fold]")].map((n) => (n as HTMLElement).dataset.fold).join(" | ")
    );
    expect(`foldable: ${owners}`).toBe(
      "foldable: h1:Notes:0 | h2:Alpha:0 | h3:Alpha detail:0 | h2:Bravo:0 | li:top one:0"
    );

    /* the negative half, stated as counts so a stray marker on a paragraph or
       on a childless item cannot hide inside the list above */
    const stray = await page.evaluate(() => {
      const md = document.querySelector("#doc .md")!;
      const leaves = [...md.querySelectorAll("li")].filter((li) => !li.querySelector(":scope > ul"));
      return {
        leaves: leaves.filter((li) => li.hasAttribute("data-fold")).length,
        paras: md.querySelectorAll(":scope > p[data-fold]").length,
      };
    });
    expect(`foldable leaf items: ${stray.leaves}, foldable paragraphs: ${stray.paras}`).toBe(
      "foldable leaf items: 0, foldable paragraphs: 0"
    );
  }, 90000);

  test("a section with nothing in it — or only blank lines — gets no chevron", async () => {
    /* The gutter used to give every h1–h3 a chevron whatever followed it, so an
       empty section offered a control whose two states rendered identically:
       press it and the document does not change. Blank lines do not rescue it,
       because a `.bgap` is a line box rather than content and folds away to the
       same nothing. */
    const EMPTY = "folds/empty.md";
    const src = [
      "# Nothing at all",
      "# Blank lines only",
      "",
      "",
      "# Has a body",
      "",
      "a real paragraph",
      "## Trailing empty child",
      "",
    ].join("\n");
    expect((await srv.api("POST", "/api/docs", { path: EMPTY, markdown: src })).status).toBe(201);
    await page.goto(srv.base + "/d/" + EMPTY, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector("#doc .md", { timeout: 15000 });
    await sleep(160);

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#doc .md h1, #doc .md h2, #doc .md h3")]
        .map((h) => ((h.textContent || "").replace(/\s+/g, " ").trim()) + "=" + (h.querySelector(":scope > .fold") ? "chevron" : "none"))
        .join(" | ")
    );
    expect(rows).toBe(
      "Nothing at all=none | Blank lines only=none | Has a body=chevron | Trailing empty child=none"
    );

    /* the one that DOES fold still folds — the guard must not have taken the
       feature with it */
    await page.click('#doc .md h1[data-fold] > .fold');
    await sleep(200);
    expect(
      await page.evaluate(() => [...document.querySelectorAll("#doc .md p")].every((n) => n.classList.contains("fold-hidden")))
    ).toBe(true);
  }, 90000);

  test("an empty heading does not renumber the folds after it", async () => {
    /* The ordinal is what tells two identically-titled sections apart, and it
       is persisted. If a skipped heading also skipped its number, every later
       fold key would shift by one and a saved fold would reopen on the wrong
       section — a silent corruption of state that outlives the session. */
    const ORD = "folds/ordinals.md";
    const src = ["## Repeat", "## Repeat", "", "body under the second", ""].join("\n");
    expect((await srv.api("POST", "/api/docs", { path: ORD, markdown: src })).status).toBe(201);
    await page.goto(srv.base + "/d/" + ORD, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector("#doc .md", { timeout: 15000 });
    await sleep(160);

    const keys = await page.evaluate(() =>
      [...document.querySelectorAll("#doc .md [data-fold]")].map((n) => (n as HTMLElement).dataset.fold).join(" | ")
    );
    /* the SECOND one is foldable and keeps ordinal 1 — the empty first one
       claimed 0 on its way past without taking a chevron */
    expect(keys).toBe("h2:Repeat:1");
  }, 90000);

  test("the chevron is one empty button per foldable block, and adds no text", async () => {
    await fresh();
    expect(`chevrons: ${await chevrons()}`).toBe(
      "chevrons: h1:Notes:0 | h2:Alpha:0 | h3:Alpha detail:0 | h2:Bravo:0 | li:top one:0"
    );
    /* empty and childless on purpose: it is an overlay of its owner, and the
       mark it shows is drawn in CSS. A child with a box of its own would be
       what the document's first-text-box walk finds. */
    const shape = await page.evaluate(() => {
      const md = document.querySelector("#doc .md")!;
      const btns = [...md.querySelectorAll(".fold")] as HTMLElement[];
      const h1 = md.querySelector("h1") as HTMLElement;
      const hr = h1.getBoundingClientRect();
      const br = (h1.querySelector(":scope > .fold") as HTMLElement).getBoundingClientRect();
      const r2 = (v: number) => Math.round(v * 100) / 100;
      return {
        kids: btns.reduce((n, b) => n + b.childElementCount, 0),
        text: btns.reduce((n, b) => n + (b.textContent ?? "").length, 0),
        heading: `${r2(hr.x)},${r2(hr.y)},${r2(hr.width)},${r2(hr.height)}`,
        button: `${r2(br.x)},${r2(br.y)},${r2(br.width)},${r2(br.height)}`,
        headingText: (h1.textContent ?? "").trim(),
      };
    });
    expect(`child elements: ${shape.kids}, characters of text: ${shape.text}`).toBe("child elements: 0, characters of text: 0");
    expect(`the button's box: ${shape.button}`).toBe(`the button's box: ${shape.heading}`);
    expect(`the heading still reads: ${shape.headingText}`).toBe("the heading still reads: Notes");
  }, 90000);

  test("every chevron sits on ONE spine, whatever its depth — and deep items fold", async () => {
    await fresh(DEEP);
    /* the glyph's x for every foldable block, read off the ::after geometry the
       same way a reader's eye does. A per-owner gutter would put the level-2
       chevron in the middle of the content column, one pixel from the parent's
       bullet — the spine is the claim that nesting moves the PAD's width, never
       the mark. */
    const spine = await page.evaluate(() => {
      const xs = [...document.querySelectorAll("#doc .md [data-fold]")].map((n) => {
        const b = n.querySelector(":scope > .fold") as HTMLElement;
        return b.getBoundingClientRect().left + parseFloat(getComputedStyle(b, "::after").left);
      });
      return { keys: [...document.querySelectorAll("#doc .md [data-fold]")].map((n) => (n as HTMLElement).dataset.fold).join(" | "),
               drift: Math.max(...xs) - Math.min(...xs) };
    });
    expect(`foldable: ${spine.keys}`).toBe("foldable: h1:Deep:0 | li:one:0 | li:two:0 | li:three:0");
    expect(`spine drift across depths: ${spine.drift < 1 ? "under 1px" : spine.drift + "px"}`).toBe(
      "spine drift across depths: under 1px"
    );

    /* …and the chevron out on that spine still folds ITS item: level 3 first,
       then level 2 swallowing it, then level 2 released with 3 still folded */
    await foldClick("li:three:0");
    expect(`three folded: ${await items()}`).toBe(
      "three folded: one=shown, two=shown, three=shown, four leaf=hidden, two-b=shown, one-b=shown"
    );
    await foldClick("li:two:0");
    expect(`two folded: ${await items()}`).toBe(
      "two folded: one=shown, two=shown, three=hidden, four leaf=hidden, two-b=shown, one-b=shown"
    );
    await foldClick("li:two:0");
    expect(`two reopened: ${await items()}`).toBe(
      "two reopened: one=shown, two=shown, three=shown, four leaf=hidden, two-b=shown, one-b=shown"
    );
  }, 90000);
});

/* ============================================================
   2 · RANGES — what a fold does and does not reach
   ============================================================ */

describe("a fold hides its own range and stops there", () => {
  test("folding an h2 takes its section, blank lines included, up to the next h2", async () => {
    await fresh();
    expect(`open: ${await outline()}`).toBe(`open: ${ALL_OPEN}`);

    await foldClick(H_ALPHA);
    expect(`Alpha folded: ${await outline()}`).toBe(`Alpha folded: ${ALPHA_FOLDED}`);

    await foldClick(H_ALPHA);
    expect(`unfolded again: ${await outline()}`).toBe(`unfolded again: ${ALL_OPEN}`);
  }, 90000);

  test("folds nest: unfolding the outer heading leaves the inner one folded", async () => {
    await fresh();
    await foldClick(H_DETAIL);
    expect(`h3 folded: ${await outline()}`).toBe(`h3 folded: ${DETAIL_FOLDED}`);

    /* the h3 is inside the h2's range, so folding the h2 swallows it whole */
    await foldClick(H_ALPHA);
    expect(`both folded: ${await outline()}`).toBe(`both folded: ${ALPHA_FOLDED}`);

    /* …and letting the h2 go must not let the h3 go with it */
    await foldClick(H_ALPHA);
    expect(`outer reopened: ${await outline()}`).toBe(`outer reopened: ${DETAIL_FOLDED}`);
  }, 90000);

  test("folding a list item hides its sub-list and nothing else", async () => {
    await fresh();
    expect(`open: ${await items()}`).toBe("open: top one=shown, kid one=shown, kid two=shown, top two=shown, a task=shown");

    await foldClick(LI_TOP);
    expect(`item folded: ${await items()}`).toBe(
      "item folded: top one=shown, kid one=hidden, kid two=hidden, top two=shown, a task=shown"
    );
    /* the document around it did not move an inch */
    expect(`blocks: ${await outline()}`).toBe(`blocks: ${ALL_OPEN}`);
  }, 90000);
});

/* ============================================================
   3 · VISIBILITY — the collapsed chevron is the only clue
   ============================================================ */

describe("the chevron hides while the section is open and stays while it is closed", () => {
  test("the GUTTER reveals; the text does not; collapsed stays put", async () => {
    await fresh();
    /* the harness's own premise — the headless shell reports a hovering
       pointer, which is what makes the readings below different at all */
    expect(`the test browser hovers: ${await page.evaluate(() => matchMedia("(hover: hover)").matches)}`).toBe(
      "the test browser hovers: true"
    );

    /* hovering the heading's TEXT is reading, and reading lights nothing —
       neither the chevron nor the click-to-edit tint */
    await page.hover(owner(H_BRAVO));
    await sleep(160); // the opacity transition
    const tintOnText = await page.evaluate(() => {
      const h = document.querySelector('#doc .md [data-fold="h2:Bravo:0"]') as HTMLElement;
      return getComputedStyle(h).backgroundColor;
    });
    expect(`text-hovered chevron: ${await chevOpacity(H_BRAVO)}, tint: ${tintOnText}`).toBe(
      "text-hovered chevron: 0, tint: rgba(0, 0, 0, 0)"
    );

    /* …the gutter pad is the one deliberate gesture: chevron AND tint arrive */
    const pt = await padPoint(H_BRAVO);
    await page.mouse.move(pt.x, pt.y);
    await sleep(160);
    const tintOnPad = await page.evaluate(() => {
      const h = document.querySelector('#doc .md [data-fold="h2:Bravo:0"]') as HTMLElement;
      return getComputedStyle(h).backgroundColor !== "rgba(0, 0, 0, 0)";
    });
    expect(`gutter-hovered chevron: ${await chevOpacity(H_BRAVO)}, tinted: ${tintOnPad}`).toBe(
      "gutter-hovered chevron: 1, tinted: true"
    );

    await page.mouse.move(4, 4); // nothing hovered
    await sleep(160);
    expect(`expanded, pointer away: ${await chevOpacity(H_BRAVO)}`).toBe("expanded, pointer away: 0");

    await foldClick(H_BRAVO);
    await page.mouse.move(4, 4);
    await sleep(160);
    expect(`collapsed, pointer away: ${await chevOpacity(H_BRAVO)}`).toBe("collapsed, pointer away: 1");
  }, 90000);

  test("a touch screen, which cannot hover at all, sees every chevron", async () => {
    /* The reason the hide rules are wrapped in `@media (hover: hover)` rather
       than in one of the repo's width breakpoints: this is a POINTER
       capability. Emulated the only way it can be — a real touch device
       profile — because it is the browser's answer to `(hover: none)` that the
       stylesheet is keyed on, not the viewport's width. */
    await page.setViewport({ width: 400, height: 800, hasTouch: true, isMobile: true });
    await fresh();
    expect(`the emulated device hovers: ${await page.evaluate(() => matchMedia("(hover: hover)").matches)}`).toBe(
      "the emulated device hovers: false"
    );
    expect(`untouched, expanded heading: ${await chevOpacity(H_ALPHA)}`).toBe("untouched, expanded heading: 1");

    await page.setViewport({ width: 1440, height: 900, hasTouch: false, isMobile: false });
    await sleep(260);
  }, 90000);
});

/* ============================================================
   4 · MEMORY — a fold outlives the DOM that showed it
   ============================================================ */

describe("a fold survives everything that rebuilds the document", () => {
  test("⌘E to Raw and back, then a full reload", async () => {
    await fresh();
    await foldClick(H_ALPHA);
    expect(`folded: ${await outline()}`).toBe(`folded: ${ALPHA_FOLDED}`);

    /* Raw is the whole file, always — and coming back rebuilds `#doc` from
       scratch, so the fold has to be re-applied from state rather than survive
       in the DOM */
    await ensureMode(page, "raw");
    const raw = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
    expect(`raw shows the whole source: ${raw === SRC}`).toBe("raw shows the whole source: true");
    await ensureMode(page, "preview");
    await page.waitForSelector("#doc .md", { timeout: 10000 });
    await sleep(140);
    expect(`after ⌘E twice: ${await outline()}`).toBe(`after ⌘E twice: ${ALPHA_FOLDED}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector("#doc .md", { timeout: 15000 });
    await sleep(200);
    expect(`after a reload: ${await outline()}`).toBe(`after a reload: ${ALPHA_FOLDED}`);
  }, 120000);
});

/* ============================================================
   5 · ORDINALS — "the second `## Log`" is a different fold from the first

   The key is content plus ordinal precisely so that it survives an edit
   somewhere else in the file, and the price of that choice is that a document
   which repeats itself has to be told apart by COUNTING. A key generator that
   forgot the counter would still look right on every document in group 1 —
   nothing there repeats — and would silently make the two `## Log` sections
   one fold, so that folding either closed both.
   ============================================================ */

describe("two identical blocks are two folds, not one", () => {
  test("the second occurrence of a key is :1, and it folds the second one's range", async () => {
    await fresh(JUMP);
    const owners = await page.evaluate(() =>
      [...document.querySelectorAll("#doc .md [data-fold]")].map((n) => (n as HTMLElement).dataset.fold).join(" | ")
    );
    expect(`foldable: ${owners}`).toBe(
      "foldable: h1:Jump:0 | h2:A:0 | h3:B:0 | h3:C:0 | h2:Kids:0 | li:parent item:0 | " +
        "h2:Log:0 | li:entry one:0 | h2:Log:1 | li:entry one:1 | h2:Tail:0"
    );

    /* the two Log sections are byte-identical, so the only thing that can tell
       this apart from "folding either folds both" is which body went away */
    expect(`open: ${await blocks("log body one", "log body two", "tail body")}`).toBe(
      "open: log body one=shown, log body two=shown, tail body=shown"
    );

    await foldClick(J_LOG_2ND);
    expect(`second Log folded: ${await blocks("log body one", "log body two", "tail body")}`).toBe(
      "second Log folded: log body one=shown, log body two=hidden, tail body=shown"
    );
    expect(`collapsed: ${await collapsed()}`).toBe(`collapsed: ${J_LOG_2ND}`);
    expect(`remembered: ${await remembered(JUMP)}`).toBe(`remembered: ${J_LOG_2ND}`);

    /* …and the first one still folds the FIRST one's range, with both closed */
    await foldClick(J_LOG_1ST);
    expect(`both folded: ${await blocks("log body one", "log body two", "tail body")}`).toBe(
      "both folded: log body one=hidden, log body two=hidden, tail body=shown"
    );
  }, 90000);

  test("the same counting tells two identical list items apart", async () => {
    await fresh(JUMP);
    /* `entry detail` appears twice, under an `entry one` that also appears
       twice — identified here by position, because the text cannot do it */
    const details = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#doc .md li")]
          .filter((li) => (li.querySelector(":scope > .tx")?.textContent ?? "").trim() === "entry detail")
          .map((li, i) => `detail ${i + 1}=` + (li.getClientRects().length ? "shown" : "hidden"))
          .join(", ")
      );
    expect(`open: ${await details()}`).toBe("open: detail 1=shown, detail 2=shown");

    await foldClick(J_ENTRY_2ND);
    expect(`second item folded: ${await details()}`).toBe("second item folded: detail 1=shown, detail 2=hidden");
    expect(`collapsed: ${await collapsed()}`).toBe(`collapsed: ${J_ENTRY_2ND}`);

    await foldClick(J_ENTRY_1ST);
    expect(`both items folded: ${await details()}`).toBe("both items folded: detail 1=hidden, detail 2=hidden");
  }, 90000);
});

/* ============================================================
   6 · JUMP — a search hit unfolds what is covering it, and only that

   ADR 0023: "a jump-to-line unfolds first". The seam driven here is the ⌘K
   PALETTE, which is the real one — a line hit calls
   `openDoc(path, { line })`, and that is the only route into `revealLine` a
   reader has in Preview. It is worth taking the whole path rather than calling
   the internals, because both bugs this group is here to hold down were
   invisible from inside: one is which fold the unfolder picks, the other is
   arithmetic that is only wrong once a block is `position: relative`.

     · PRECISION — with `## A` and `### B` both folded, only A is hiding
       `c body`. B's range ended at `### C`. Unfolding B as well would throw
       away a fold the reader set, on a document they only asked to be shown a
       line of — and `persistFolds` would write the loss to localStorage, so it
       would not even come back on reload.
     · LANDING — the block has to be ON SCREEN afterwards, 110px below the top
       of the pane. Measured as a rectangle, because `offsetTop` is exactly
       what was wrong: every `li` is a positioned box, so a nested item's
       offsets are relative to its parent item and a jump into a sub-list
       scrolled to the top of the document instead.
   ============================================================ */

describe("a jump to a line unfolds precisely what was covering it", () => {
  test("only the section whose range REACHES the line is opened", async () => {
    await fresh(JUMP);
    /* inner first: folding A would hide B's chevron along with everything else */
    await foldClick(J_B);
    await foldClick(J_A);
    expect(`before the jump: ${await blocks("a body", "B", "b body", "C", "c body")}`).toBe(
      "before the jump: a body=hidden, B=hidden, b body=hidden, C=hidden, c body=hidden"
    );
    expect(`collapsed: ${await collapsed()}`).toBe(`collapsed: ${J_A} | ${J_B}`);

    const picked = await palJump("c body", "c body");
    expect(`the palette hit named: ${picked.includes("c body") && picked.includes("jump.md")}`).toBe(
      "the palette hit named: true"
    );

    /* A had to go — it was the one covering the line. B did NOT: its range
       stopped at `### C`, so it never covered anything the reader asked for. */
    expect(`after the jump: ${await blocks("a body", "B", "b body", "C", "c body")}`).toBe(
      "after the jump: a body=shown, B=shown, b body=hidden, C=shown, c body=shown"
    );
    expect(`collapsed: ${await collapsed()}`).toBe(`collapsed: ${J_B}`);
    /* and the surviving fold is still on disk — an unfold that was never asked
       for is worse for being permanent */
    expect(`remembered: ${await remembered(JUMP)}`).toBe(`remembered: ${J_B}`);
  }, 120000);

  test("…and the line is really on screen: 110px below the top of the pane", async () => {
    await fresh(JUMP);
    await foldClick(J_B);
    await foldClick(J_A);
    await palJump("c body", "c body");

    const at = await landing("c body");
    /* the premise, stated out loud: an un-scrolled pane would have this block
       hundreds of pixels below the fold, and the scroller was not simply
       pinned at its own bottom — either would make the number below a
       coincidence rather than a measurement of the anchor */
    expect(`the pane had to travel: ${at.scrollTop > 400}, and had somewhere to stop: ${at.room > 0}`).toBe(
      "the pane had to travel: true, and had somewhere to stop: true"
    );
    expect(`c body sits ${near(at.top, ANCHOR)}px below the top of the pane`).toBe(
      `c body sits ${ANCHOR}px below the top of the pane`
    );
  }, 120000);

  test("a nested list item lands in the same place — the offsetParent trap", async () => {
    /* Nothing is folded here, and that is the point: this one is pure
       arithmetic. `deep kid` is a nested `li` inside `parent item`, which is
       `position: relative` because it carries a chevron — so `offsetTop` is
       measured from the PARENT ITEM and scrolling by it lands the reader at
       the top of the document, several screens above the hit they clicked. */
    await fresh(JUMP);
    expect(`nothing folded: ${(await collapsed()) === ""}`).toBe("nothing folded: true");

    await palJump("deep kid", "deep kid");
    const at = await landing("deep kid");
    expect(`the pane had to travel: ${at.scrollTop > 400}, and had somewhere to stop: ${at.room > 0}`).toBe(
      "the pane had to travel: true, and had somewhere to stop: true"
    );
    expect(`deep kid sits ${near(at.top, ANCHOR)}px below the top of the pane`).toBe(
      `deep kid sits ${ANCHOR}px below the top of the pane`
    );
    /* the item's own parent is still open — a jump unfolds, it does not fold */
    expect(`still open: ${(await collapsed()) === ""}`).toBe("still open: true");
  }, 120000);
});

/* ============================================================
   7 · SOURCE — a view state may not cost a byte, or a click zone
   ============================================================ */

describe("folding is a view choice and the file never learns about it", () => {
  test("the document is byte-identical after a session of folding", async () => {
    await fresh();
    await foldClick(H_ALPHA);
    await foldClick(H_ALPHA);
    await foldClick(LI_TOP);
    await foldClick(H_BRAVO);
    const r = await srv.doc(DOC);
    expect(`${DOC}: ${JSON.stringify(r.body.markdown)}`).toBe(`${DOC}: ${JSON.stringify(SRC)}`);
  }, 90000);

  test("the chevron does not open Raw; the heading's text still does", async () => {
    await fresh();
    await foldClick(H_ALPHA);
    expect(`still in Preview: ${await page.$("#rawArea").then((h) => h === null)}`).toBe("still in Preview: true");

    /* …and the zone beside it is unchanged: a click on the heading itself is
       still a click on line 4 */
    await page.click(owner(H_ALPHA));
    await page.waitForSelector("#rawArea", { timeout: 10000 });
    const caret = await page.evaluate(() => (document.getElementById("rawArea") as HTMLTextAreaElement).selectionStart);
    expect(`caret at ${caret}`).toBe(`caret at ${offsetOf(SRC, 4)}`);
  }, 90000);

  test("nothing threw while any of that folded", () => {
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  });
});
