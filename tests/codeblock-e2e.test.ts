/* ============================================================
   codeblock-e2e.test.ts — how a fenced code block RENDERS (SPEC §4).

   The change this file exists to hold still: code blocks used to scroll
   sideways, ignore density entirely, and wear three decorative "traffic light"
   dots in the header bar. All three were changed at once, and all three are the
   kind of thing that silently comes back — a stray `overflow-x: auto`, a theme
   that re-hardcodes `--d-pre-pad` for one density, a copy-pasted bar.

   Everything here is MEASURED in a real Chromium against the real backend.
   Nothing asserts on a class name where a rect was available.

   Four groups:

     · WRAP — a long line is content. The `<pre>` must never have anything to
       scroll to, in any theme, at either density, at desktop and phone widths.
     · FIDELITY — wrapping is a rendering choice and may not cost a byte. The
       block's `textContent` is still the source verbatim (tabs, leading spaces
       and every newline), and a wrapped continuation stays visually distinct
       from a real new line via the hanging indent.
     · DENSITY — Compact must be genuinely tighter than Comfy, in every theme.
       This nearly died: base.css was retuned while minimal.css and terminal.css
       still overrode `--d-pre-pad`/`--d-pre-lh` with the old values, which made
       the retune dead in two of the three themes. Measured on real rects, and
       against the pre-change numbers recorded in the budgets below.
     · DOTS — the decoration is gone from the code bar and ONLY from there. The
       AI thinking indicator and the two statusbar connection dots are separate
       mechanisms that happen to be round, and removing the wrong one is a
       regression no CSS-only assertion would catch.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { reply, startMockUpstream, type MockUpstream } from "./mock-upstream";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const THEMES = ["minimal", "modern", "terminal"] as const;
type Theme = (typeof THEMES)[number];
type Density = "comfy" | "compact";

/* ------------------------------------------------------------------
   the documents under measurement
   ------------------------------------------------------------------ */

/* One source line far wider than any column this app is ever rendered in, so
   "does it overflow" is never a question of a few pixels. Spaces throughout:
   ordinary code must break at a space, and a block that only passed because
   `overflow-wrap: anywhere` chopped a giant token would prove nothing. */
const LONG_LINE =
  "const wide = reconcileEverySingleDocumentInTheVault(vaultRoot, " +
  "{ includeHiddenDotDirectories: false, followSymbolicLinks: false, " +
  "hashAlgorithm: \"blake3\", debounceMilliseconds: 120, onProgress: (done, total) => " +
  "report(done, total), onError: (err) => escalate(err) });";

/* A tab and a four-space indent in the same block: `tab-size: 4` renders them
   near-identically, so only `textContent` can tell them apart — which is
   exactly the property a "wrapping is free" claim rests on. */
const WRAP_SRC = [
  "const shortOne = 1;",
  LONG_LINE,
  "\tconst tabbed = 2;",
  "    const deep = 3;",
  "const shortLast = 4;",
].join("\n");

/* Five short lines, nothing to wrap: this block's height is a pure reading of
   the density tokens, with the long line's line-count noise removed. */
const FIVE_SRC = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join("\n");

const WRAP_DOC = "code/wrap.md";
const FIVE_DOC = "code/five.md";

const fence = (lang: string, src: string) => "```" + lang + "\n" + src + "\n```\n";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [WRAP_DOC]: "# Wrap\n\nprose above\n\n" + fence("ts", WRAP_SRC) + "\nprose below\n",
  [FIVE_DOC]: "# Five\n\nprose above\n\n" + fence("ts", FIVE_SRC) + "\nprose below\n",
};

/* ------------------------------------------------------------------
   PRE-CHANGE BUDGETS

   Measured on the build immediately before this change, at 1440x900 in Minimal
   (the shipped default), and recorded here so "more compact than before" is an
   assertion and not a memory. Every number below is what the OLD build
   produced; the new one must come in under it.

     header bar height          39px at BOTH densities (it had no density token)
     five-line block height     149px comfy · 141px compact
     comfy→compact gap           8px  (the whole of the old rescale)
   ------------------------------------------------------------------ */
const BEFORE = { barH: 39, fiveH: { comfy: 149, compact: 141 }, densityGap: 8 };

let srv: TestServer;
let mock: MockUpstream;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  mock = await startMockUpstream();
  srv = await startServer({ seed: SEED });
  await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: "sk-codeblock", model: "gpt-5", effort: "high" },
    git: { autoSyncSeconds: 600 },
  });
  await sleep(250);
  mock.reset();

  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  await Promise.all([srv?.stop(), mock?.stop()].filter(Boolean) as Promise<unknown>[]);
});

/* ------------------------------------------------------------------
   page helpers
   ------------------------------------------------------------------ */

/** Put the app on `theme`/`density` the way a user would leave it: stored on
    the server, applied by `start()` on the next boot. Deliberately NOT a
    `data-density` poke — that would measure the CSS while skipping the code
    that is supposed to deliver it, and the settings page is not what this file
    is testing. */
async function bootAs(theme: Theme, density: Density, doc: string, width = 1440, height = 900) {
  await srv.api("PUT", "/api/settings", { theme, density });
  await page.setViewport({ width, height });
  await page.goto(srv.base + "/d/" + doc, { waitUntil: "domcontentloaded" });
  await waitForApp(page, 25000);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, doc);
  /* the theme's own stylesheet must have LOADED, not merely been swapped in:
     a measurement taken between the two reads the previous theme's tokens */
  await page.waitForFunction(
    (t, d) => {
      const root = document.documentElement;
      if (root.getAttribute("data-theme") !== t || root.getAttribute("data-density") !== d) return false;
      const link = document.getElementById("theme-css") as HTMLLinkElement | null;
      if (!link || !link.href.endsWith(`/themes/${t}.css`)) return false;
      return [...document.styleSheets].some((s) => {
        try {
          return (s.href ?? "").endsWith(`/themes/${t}.css`) && !!s.cssRules.length;
        } catch {
          return false;
        }
      });
    },
    { timeout: 15000 },
    theme,
    density
  );
  await page.waitForSelector(".code pre", { timeout: 10000 });
  await sleep(260); // .doc transitions its padding
}

/** Everything about the first code block on the page, in one round trip. */
function measureCode() {
  return page.evaluate(() => {
    const n2 = (v: string) => Math.round(parseFloat(v) * 100) / 100;
    const rect = (e: Element | null) => (e ? Math.round(e.getBoundingClientRect().height * 100) / 100 : -1);
    const root = getComputedStyle(document.documentElement);
    const block = document.querySelector(".code")!;
    const bar = block.querySelector(".code-bar")!;
    const pre = block.querySelector("pre") as HTMLPreElement;
    const cs = getComputedStyle(pre);
    const btn = bar.querySelector(".btn") as HTMLElement | null;
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      density: document.documentElement.getAttribute("data-density"),
      /* tokens */
      tCodeFs: n2(root.getPropertyValue("--d-code-fs")),
      tPreLh: n2(root.getPropertyValue("--d-pre-lh")),
      tBarFs: n2(root.getPropertyValue("--d-code-bar-fs")),
      tBtnH: n2(root.getPropertyValue("--d-code-btn-h")),
      tPrePadTop: n2(cs.paddingTop),
      /* the geometry those tokens are supposed to drive */
      blockH: rect(block),
      barH: rect(bar),
      preH: rect(pre),
      btnH: rect(btn),
      fontSize: n2(cs.fontSize),
      lineHeight: n2(cs.lineHeight),
      /* the wrap contract */
      whiteSpace: cs.whiteSpace,
      overflowX: cs.overflowX,
      overflow: pre.scrollWidth - pre.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      /* the decoration that is supposed to be gone */
      barDots: bar.querySelectorAll(".dots, .dot").length,
      barChildren: [...bar.children].map((c) => c.className),
      /* fidelity */
      text: pre.textContent,
      lineCount: block.querySelectorAll(".cline").length,
    };
  });
}

/* ============================================================
   1 · WRAP — nothing here ever scrolls sideways
   ============================================================ */

describe("a fenced code block wraps instead of scrolling (SPEC §4)", () => {
  test("a 240-character line leaves the <pre> with nothing to scroll to", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    const m = await measureCode();

    expect(`the source line under test is ${LONG_LINE.length} chars`).toBe(
      "the source line under test is 266 chars"
    );
    /* the premise: this line really is wider than the column. Without it a
       "no overflow" pass would be vacuous. */
    const wider = await page.evaluate(() => {
      const pre = document.querySelector(".code pre") as HTMLElement;
      const long = pre.querySelectorAll(".cline")[1] as HTMLElement;
      /* `.cline` is display:block, so ITS own getClientRects() is a single
         border box; a Range over its contents reports one rect per highlighted
         FRAGMENT per line box. Distinct `top`s are therefore the line boxes. */
      const r = document.createRange();
      r.selectNodeContents(long);
      const tops = new Set([...r.getClientRects()].map((b) => Math.round(b.top)));
      return { boxes: tops.size, column: Math.round(pre.clientWidth) };
    });
    expect(`the long line needed more than one line box: ${wider.boxes > 1}`).toBe(
      "the long line needed more than one line box: true"
    );

    expect(`white-space: ${m.whiteSpace}`).toBe("white-space: pre-wrap");
    expect(`overflow-x: ${m.overflowX}`).toBe("overflow-x: hidden");
    expect(`pre scrollWidth − clientWidth: ${m.overflow}`).toBe("pre scrollWidth − clientWidth: 0");
    expect(`the page itself scrolls sideways: ${m.docOverflow > 0}`).toBe("the page itself scrolls sideways: false");
  }, 90000);

  test("…in every theme, at both densities, on desktop AND on a phone", async () => {
    for (const theme of THEMES) {
      for (const density of ["comfy", "compact"] as const) {
        for (const [w, h, where] of [
          [1440, 900, "desktop"],
          [390, 844, "phone"],
        ] as const) {
          await bootAs(theme, density, WRAP_DOC, w, h);
          const m = await measureCode();
          const at = `${theme}/${density}/${where}`;
          expect(`${at} pre overflow: ${m.overflow}`).toBe(`${at} pre overflow: 0`);
          expect(`${at} overflow-x: ${m.overflowX}`).toBe(`${at} overflow-x: hidden`);
          expect(`${at} white-space: ${m.whiteSpace}`).toBe(`${at} white-space: pre-wrap`);
          expect(`${at} page scrolls sideways: ${m.docOverflow > 0}`).toBe(`${at} page scrolls sideways: false`);
        }
      }
    }
  }, 300000);
});

/* ============================================================
   2 · FIDELITY — wrapping costs no bytes, and a continuation
       still reads as a continuation
   ============================================================ */

describe("wrapping is a rendering choice and does not touch the source", () => {
  test("the block's textContent is the fence body verbatim — tabs, indents, newlines", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    const m = await measureCode();

    /* the whole thing, byte for byte. Not "contains", not "starts with": the
       per-line spans each keep their own trailing "\n" precisely so this holds,
       and a refactor that stacked plain blocks instead would silently join the
       lines. */
    expect(m.text).toBe(WRAP_SRC);
    expect(`source lines rendered as .cline boxes: ${m.lineCount}`).toBe("source lines rendered as .cline boxes: 5");
    expect(`the tab survived: ${m.text!.includes("\tconst tabbed = 2;")}`).toBe("the tab survived: true");
    expect(`the four-space indent survived: ${m.text!.includes("\n    const deep = 3;")}`).toBe(
      "the four-space indent survived: true"
    );
    expect(`newline count: ${(m.text!.match(/\n/g) || []).length}`).toBe("newline count: 4");
  }, 90000);

  test("a wrapped continuation hangs one step in; a real new line does not", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    /* one rect per LINE BOX, which is the browser's own account of where the
       wrap happened — no reimplementation of the layout here */
    const geo = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".code pre .cline")] as HTMLElement[];
      /* Where each VISUAL line of a source line begins.

         A Range over `.cline` reports one rect per highlighted fragment per
         line box (the block's own getClientRects() would be a single border
         box), so the line boxes are the distinct `top`s and where each begins
         is the smallest `left` among the fragments sharing that top. */
      const lefts = (e: HTMLElement) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        const byTop = new Map<number, number>();
        for (const b of r.getClientRects()) {
          const top = Math.round(b.top);
          byTop.set(top, Math.min(byTop.get(top) ?? Infinity, b.left));
        }
        return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => Math.round(l));
      };
      return { short: lefts(lines[0]), long: lefts(lines[1]), after: lefts(lines[2]) };
    });

    expect(`the long line wrapped into ${geo.long.length > 1 ? "several" : "one"} line boxes`).toBe(
      "the long line wrapped into several line boxes"
    );
    const base = geo.short[0];
    const hang = geo.long[1] - geo.long[0];

    expect(`the long line starts where every other line starts: ${geo.long[0] === base}`).toBe(
      "the long line starts where every other line starts: true"
    );
    expect(`its continuations hang in by ${hang > 0 ? "a positive amount" : "nothing"}`).toBe(
      "its continuations hang in by a positive amount"
    );
    /* every continuation hangs by the SAME amount — a hanging indent, not a
       progressive drift */
    for (let i = 2; i < geo.long.length; i++) {
      expect(`continuation ${i} hangs by ${geo.long[i] - geo.long[0]} (same as the first: ${hang})`).toBe(
        `continuation ${i} hangs by ${hang} (same as the first: ${hang})`
      );
    }
    /* …and the next REAL line is back at the margin, which is the entire point:
       a reader can tell "this is still that line" from "this is the next one" */
    expect(`the next real line is back at the margin: ${geo.after[0] === base}`).toBe(
      "the next real line is back at the margin: true"
    );
  }, 90000);

  test("Raw mode is untouched — the fence is still the bytes on disk", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyE");
    await page.keyboard.up("Meta");
    await page.waitForSelector("#rawArea", { timeout: 8000 });

    const raw = await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
    const onDisk = (await srv.doc(WRAP_DOC)).body.markdown;
    expect(`the raw buffer is the file: ${raw === onDisk}`).toBe("the raw buffer is the file: true");
    expect(`the raw buffer still carries the long line: ${raw.includes(LONG_LINE)}`).toBe(
      "the raw buffer still carries the long line: true"
    );
    /* Raw is the byte-faithful surface and answers to a different rule than the
       preview: it may scroll, and its wrapping is not this change's business.
       What must hold is that the source came through it unaltered. */
    expect(`the tab is still a tab in Raw: ${raw.includes("\tconst tabbed")}`).toBe(
      "the tab is still a tab in Raw: true"
    );
  }, 90000);
});

/* ============================================================
   3 · DENSITY — Compact is really tighter, in every theme
   ============================================================ */

describe("code blocks answer to density, in every theme", () => {
  test("every code token and every code rect moves DOWN from Comfy to Compact", async () => {
    for (const theme of THEMES) {
      await bootAs(theme, "comfy", FIVE_DOC);
      const comfy = await measureCode();
      await bootAs(theme, "compact", FIVE_DOC);
      const compact = await measureCode();

      expect(`${theme} comfy read as: ${comfy.density}`).toBe(`${theme} comfy read as: comfy`);
      expect(`${theme} compact read as: ${compact.density}`).toBe(`${theme} compact read as: compact`);

      /* Named one by one so a failure says WHICH knob the rescale forgot. The
         two `--d-pre-*` entries are the ones minimal.css and terminal.css were
         quietly pinning to the old values. */
      const tighter: Array<[string, number, number]> = [
        ["--d-code-fs", compact.tCodeFs, comfy.tCodeFs],
        ["--d-pre-lh", compact.tPreLh, comfy.tPreLh],
        ["--d-code-bar-fs", compact.tBarFs, comfy.tBarFs],
        ["--d-code-btn-h", compact.tBtnH, comfy.tBtnH],
        ["pre padding-top", compact.tPrePadTop, comfy.tPrePadTop],
        ["code font-size", compact.fontSize, comfy.fontSize],
        ["code line-height", compact.lineHeight, comfy.lineHeight],
        ["header bar height", compact.barH, comfy.barH],
        ["copy button height", compact.btnH, comfy.btnH],
        ["pre height", compact.preH, comfy.preH],
        ["whole block height", compact.blockH, comfy.blockH],
      ];
      for (const [what, tight, loose] of tighter) {
        expect(`${theme} ${what}: compact ${tight} < comfy ${loose}`).toBe(
          `${theme} ${what}: compact ${tight} < comfy ${loose}${tight < loose ? "" : "  ← NOT TIGHTER"}`
        );
      }
    }
  }, 300000);

  test("the block is measurably smaller than the build before this change", async () => {
    /* Minimal at 1440x900 — the configuration BEFORE was measured in. */
    await bootAs("minimal", "comfy", FIVE_DOC);
    const comfy = await measureCode();
    await bootAs("minimal", "compact", FIVE_DOC);
    const compact = await measureCode();

    /* The bar had no density token at all, so it was 39px in both modes. */
    expect(`comfy bar ${comfy.barH} < the old ${BEFORE.barH}`).toBe(
      `comfy bar ${comfy.barH} < the old ${BEFORE.barH}${comfy.barH < BEFORE.barH ? "" : "  ← NOT SMALLER"}`
    );
    expect(`compact bar ${compact.barH} < the old ${BEFORE.barH}`).toBe(
      `compact bar ${compact.barH} < the old ${BEFORE.barH}${compact.barH < BEFORE.barH ? "" : "  ← NOT SMALLER"}`
    );

    /* Five short lines, so this is the density tokens and nothing else. */
    for (const [d, now, was] of [
      ["comfy", comfy.blockH, BEFORE.fiveH.comfy],
      ["compact", compact.blockH, BEFORE.fiveH.compact],
    ] as const) {
      expect(`${d} five-line block ${now} < the old ${was}`).toBe(
        `${d} five-line block ${now} < the old ${was}${now < was ? "" : "  ← NOT SMALLER"}`
      );
    }

    /* …and the rescale itself got bigger. The old gap was 8px on a 149px block
       — a rounding error dressed up as a setting. This is the assertion that
       "Compact is genuinely tighter" rather than "Compact is a hair shorter". */
    const gap = comfy.blockH - compact.blockH;
    expect(`the comfy→compact gap is ${gap}, was ${BEFORE.densityGap}`).toBe(
      `the comfy→compact gap is ${gap}, was ${BEFORE.densityGap}${gap > BEFORE.densityGap ? "" : "  ← NO WIDER"}`
    );
  }, 180000);
});

/* ============================================================
   4 · DOTS — removed from the bar, and from nowhere else
   ============================================================ */

describe("the decorative dots left the code bar and nothing else", () => {
  test("the code bar carries the language and the copy button, and no dots", async () => {
    for (const theme of THEMES) {
      await bootAs(theme, "comfy", WRAP_DOC);
      const m = await measureCode();
      expect(`${theme}: round decorations in the code bar: ${m.barDots}`).toBe(
        `${theme}: round decorations in the code bar: 0`
      );
      expect(`${theme}: what the bar holds: ${m.barChildren.join(" + ")}`).toBe(
        `${theme}: what the bar holds: lang + btn sm`
      );
    }
  }, 180000);

  test("the statusbar connection dots are still there", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    const dots = await page.evaluate(() => ({
      conn: document.querySelectorAll("#stConn .dot").length,
      ai: document.querySelectorAll("#stAi .dot").length,
      connVisible: !!(document.querySelector("#stConn .dot") as HTMLElement)?.getBoundingClientRect().width,
    }));
    expect(`the SSE connection dot: ${dots.conn}`).toBe("the SSE connection dot: 1");
    expect(`the AI endpoint dot: ${dots.ai}`).toBe("the AI endpoint dot: 1");
    expect(`the connection dot has real size: ${dots.connVisible}`).toBe("the connection dot has real size: true");
  }, 90000);

  test("the AI thinking indicator still pulses its three dots", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);

    /* dripped slowly on purpose: the thinking row exists only WHILE the turn is
       streaming its reasoning summary, so this has to be caught in flight */
    mock.reset();
    mock.script(
      reply.text("Here is the answer.", {
        reasoning: "Weighing the options before answering, at some length so the row is up long enough to read.",
        chunkSize: 8,
        dripMs: 90,
      })
    );

    const open = await page.evaluate(() => document.getElementById("app")!.classList.contains("chat-open"));
    if (!open) {
      await page.click("#chatBtn");
      await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
        timeout: 5000,
      });
    }

    await page.click("#composer");
    await page.keyboard.type("what does this block do?");
    await page.keyboard.press("Enter"); // plain Enter sends; Shift+Enter is a newline

    await page.waitForSelector(".think .dots", { timeout: 25000 });
    const think = await page.evaluate(() => {
      const dots = document.querySelector(".think .dots")!;
      const i = dots.querySelectorAll("i");
      const cs = getComputedStyle(i[0]);
      return {
        count: i.length,
        animation: cs.animationName,
        width: Math.round(i[0].getBoundingClientRect().width),
        /* the same query the code bar answers 0 to */
        inCodeBar: document.querySelectorAll(".code-bar .dots, .code-bar .dot").length,
      };
    });

    expect(`the thinking indicator's dots: ${think.count}`).toBe("the thinking indicator's dots: 3");
    expect(`they animate: ${think.animation}`).toBe("they animate: thinkpulse");
    expect(`each is ${think.width}px wide`).toBe("each is 4px wide");
    /* both truths in one breath: the mechanism is alive, and it is not in the bar */
    expect(`dots in the code bar while it runs: ${think.inCodeBar}`).toBe("dots in the code bar while it runs: 0");

    await page.waitForFunction(() => !document.querySelector(".think"), { timeout: 30000 }).catch(() => {});
  }, 120000);

  test("no page errors were raised by any of this", () => {
    expect(`page errors: ${pageErrors.join(" | ") || "none"}`).toBe("page errors: none");
  });
});
