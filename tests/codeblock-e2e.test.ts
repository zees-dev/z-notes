/* ============================================================
   codeblock-e2e.test.ts — how a fenced code block RENDERS in Edit.

   The change this file exists to hold still: code blocks used to scroll
   sideways and ignore density entirely. Both are the kind of thing that
   silently comes back — a stray `overflow-x: auto`, a theme that re-hardcodes a
   density token for one density — and the island inherits the claim: the block
   is BlockNote's `codeBlock` now (`pre`/`code` plus the Copy button the island
   adds), so the rules are enforced by different CSS against the same contract.

   Everything here is MEASURED in a real Chromium against the real backend.
   Nothing asserts on a class name where a rect was available.

   Three groups:

     · WRAP — a long line is content. The `<pre>` must never have anything to
       scroll to, in any theme, at either density, at desktop and phone widths.
     · FIDELITY — wrapping is a rendering choice and may not cost a byte. The
       block's `textContent` is still the source verbatim (tabs, leading spaces
       and every newline), Copy puts exactly those bytes on the clipboard, and
       Source is still the file.
     · DENSITY — Compact must be genuinely tighter than Comfy, in every theme.
       This nearly died once: base.css was retuned while minimal.css and
       terminal.css still overrode the code tokens with the old values, which
       made the retune dead in two of the three themes. Measured on real rects.

   The AI thinking indicator and the two statusbar connection dots are separate
   mechanisms that the cutover could plausibly have taken with it, so they keep
   their coverage here.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { reply, startMockUpstream, type MockUpstream } from "./mock-upstream";
import { ensureMode, launchTestBrowser, newAppPage, waitForApp } from "./browser";

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

/** the island's code block: the block content, its `pre`/`code`, and the Copy
    button the island appends to the node view */
const CODE = '#doc .bn-block-content[data-content-type="codeBlock"] pre code';
const COPY = '#doc .bn-block-content[data-content-type="codeBlock"] .z-code-copy';

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
  /* Edit is a lazy `import()`: the block does not exist when `#stPath` does */
  await page.waitForSelector(CODE, { timeout: 25000 });
  await sleep(260); // .doc transitions its padding
}

/** Everything about the first code block on the page, in one round trip. */
function measureCode() {
  return page.$eval(CODE, (code) => {
    const n2 = (v: number) => Math.round(v * 100) / 100;
    const pre = code.closest("pre") as HTMLPreElement;
    const block = code.closest(".bn-block-content")!;
    const cs = getComputedStyle(code);
    const preCs = getComputedStyle(pre);
    /* one rect per LINE BOX, which is the browser's own account of where the
       wrap happened — no reimplementation of the layout here */
    const range = document.createRange();
    range.selectNodeContents(code);
    const rows = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
    return {
      density: document.documentElement.getAttribute("data-density"),
      /* the geometry the density tokens are supposed to drive */
      blockH: n2(block.getBoundingClientRect().height),
      preH: n2(pre.getBoundingClientRect().height),
      fontSize: n2(parseFloat(cs.fontSize)),
      lineHeight: n2(parseFloat(cs.lineHeight)),
      /* the wrap contract */
      whiteSpace: preCs.whiteSpace,
      overflowX: preCs.overflowX,
      overflow: pre.scrollWidth - pre.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: rows.size,
      /* fidelity */
      text: code.textContent,
    };
  });
}

/* ============================================================
   1 · WRAP — nothing here ever scrolls sideways
   ============================================================ */

describe("a fenced code block wraps instead of scrolling", () => {
  test("a 266-character line leaves the <pre> with nothing to scroll to", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    const m = await measureCode();

    expect(`the source line under test is ${LONG_LINE.length} chars`).toBe(
      "the source line under test is 266 chars"
    );
    /* the premise: this line really is wider than the column. Without it a
       "no overflow" pass would be vacuous — five source lines, more than five
       line boxes. */
    expect(`the long line needed extra line boxes: ${m.rows > 5}`).toBe("the long line needed extra line boxes: true");

    expect(`white-space: ${m.whiteSpace}`).toBe("white-space: pre-wrap");
    /* the contract is MEASURED, not read off a property: BlockNote's own
       stylesheet leaves the `pre` at `overflow-x: auto` (the old renderer used
       `hidden`), so what must hold is that there is nothing there to scroll to */
    expect(`pre scrollWidth − clientWidth: ${m.overflow} (overflow-x: ${m.overflowX})`).toBe(
      `pre scrollWidth − clientWidth: 0 (overflow-x: ${m.overflowX})`
    );
    expect(`the page itself scrolls sideways: ${m.docOverflow > 0}`).toBe("the page itself scrolls sideways: false");
  }, 90000);

  test("…in every theme, at both densities, on desktop AND on a phone", async () => {
    const desktopCodeSize: Record<string, number> = {};
    for (const theme of THEMES) {
      for (const density of ["comfy", "compact"] as const) {
        for (const [w, h, where] of [
          [1440, 900, "desktop"],
          [390, 844, "phone"],
        ] as const) {
          await bootAs(theme, density, WRAP_DOC, w, h);
          const m = await measureCode();
          const at = `${theme}/${density}/${where}`;
          if (where === "desktop") desktopCodeSize[theme + "/" + density] = m.fontSize;
          expect(`${at} pre overflow: ${m.overflow}`).toBe(`${at} pre overflow: 0`);
          expect(`${at} white-space: ${m.whiteSpace}`).toBe(`${at} white-space: pre-wrap`);
          expect(`${at} page scrolls sideways: ${m.docOverflow > 0}`).toBe(`${at} page scrolls sideways: false`);
          /* the source is still the source at every one of these widths */
          expect(`${at} literal content intact: ${m.text === WRAP_SRC}`).toBe(`${at} literal content intact: true`);
          /* no phone floor: the viewport meta pins the scale (spec 0013), so
             code reads at the theme's size on a phone as on the desktop */
          if (where === "phone") {
            expect(`${at} code font-size: ${m.fontSize}px`).toBe(`${at} code font-size: ${desktopCodeSize[theme + "/" + density]}px`);
          }
        }
      }
    }
  }, 300000);
});

/* ============================================================
   2 · FIDELITY — wrapping and editing cost no bytes
   ============================================================ */

describe("wrapping is a rendering choice and does not touch the source", () => {
  test("the block's textContent is the fence body verbatim — tabs, indents, newlines", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    const m = await measureCode();

    /* the whole thing, byte for byte. Not "contains", not "starts with" */
    expect(m.text).toBe(WRAP_SRC);
    expect(`the tab survived: ${m.text!.includes("\tconst tabbed = 2;")}`).toBe("the tab survived: true");
    expect(`the four-space indent survived: ${m.text!.includes("\n    const deep = 3;")}`).toBe(
      "the four-space indent survived: true"
    );
    expect(`newline count: ${(m.text!.match(/\n/g) || []).length}`).toBe("newline count: 4");
  }, 90000);

  test("Copy puts the fence body on the clipboard, byte for byte", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    await browser
      .defaultBrowserContext()
      .overridePermissions(srv.base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);

    await page.click(COPY);
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Copied", { timeout: 8000 }, COPY);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(WRAP_SRC);
    /* copying is a read: the file must not have moved */
    expect((await srv.doc(WRAP_DOC)).body.markdown).toBe(SEED[WRAP_DOC]);
  }, 90000);

  test("Raw mode is untouched — the fence is still the bytes on disk", async () => {
    await bootAs("minimal", "comfy", WRAP_DOC);
    await ensureMode(page, "raw");
    await page.waitForSelector("#rawArea", { timeout: 8000 });

    const raw = await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
    const onDisk = (await srv.doc(WRAP_DOC)).body.markdown;
    expect(`the raw buffer is the file: ${raw === onDisk}`).toBe("the raw buffer is the file: true");
    expect(`the raw buffer still carries the long line: ${raw.includes(LONG_LINE)}`).toBe(
      "the raw buffer still carries the long line: true"
    );
    /* Source is the byte-faithful surface and answers to a different rule than
       Edit: it may scroll, and its wrapping is not this change's business. What
       must hold is that the source came through it unaltered. */
    expect(`the tab is still a tab in Raw: ${raw.includes("\tconst tabbed")}`).toBe(
      "the tab is still a tab in Raw: true"
    );
    /* …and back in Edit, still verbatim */
    await ensureMode(page, "preview");
    await page.waitForSelector(CODE, { timeout: 25000 });
    expect((await measureCode()).text).toBe(WRAP_SRC);
  }, 90000);
});

/* ============================================================
   3 · DENSITY — Compact is really tighter, in every theme
   ============================================================ */

describe("code blocks answer to density, in every theme", () => {
  test("every code rect moves DOWN from Comfy to Compact", async () => {
    for (const theme of THEMES) {
      await bootAs(theme, "comfy", FIVE_DOC);
      const comfy = await measureCode();
      await bootAs(theme, "compact", FIVE_DOC);
      const compact = await measureCode();

      expect(`${theme} comfy read as: ${comfy.density}`).toBe(`${theme} comfy read as: comfy`);
      expect(`${theme} compact read as: ${compact.density}`).toBe(`${theme} compact read as: compact`);

      /* Named one by one, and asserted in ONE breath, so a failure names every
         knob the rescale forgot rather than only the first.

         (Not `pre padding-top`: measured, the island's code block keeps a flat
         24px in both densities and all three themes — the old `--d-pre-pad`
         token belonged to a DOM that no longer exists, and the block's own
         padding is not claimed to scale.) */
      const knobs: Array<[string, number, number]> = [
        ["code font-size", compact.fontSize, comfy.fontSize],
        ["code line-height", compact.lineHeight, comfy.lineHeight],
        ["pre height", compact.preH, comfy.preH],
        ["whole block height", compact.blockH, comfy.blockH],
      ];
      expect(
        `${theme}: ` +
          knobs
            .map(([what, tight, loose]) => (tight < loose ? `${what} tighter` : `${what} NOT TIGHTER (${tight} vs ${loose})`))
            .join(", ")
      ).toBe(`${theme}: ` + knobs.map(([what]) => `${what} tighter`).join(", "));
    }
  }, 300000);
});

/* ============================================================
   4 · the round indicators the cutover must not have taken
   ============================================================ */

describe("shell indicators survive the editor cutover", () => {
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
        /* the same query the code block answers 0 to */
        inCodeBlock: document.querySelectorAll(
          '.bn-block-content[data-content-type="codeBlock"] .dots, .bn-block-content[data-content-type="codeBlock"] .dot'
        ).length,
      };
    });

    expect(`the thinking indicator's dots: ${think.count}`).toBe("the thinking indicator's dots: 3");
    expect(`they animate: ${think.animation}`).toBe("they animate: thinkpulse");
    expect(`each is ${think.width}px wide`).toBe("each is 4px wide");
    /* both truths in one breath: the mechanism is alive, and it is not decorating
       the code block */
    expect(`dots in the code block while it runs: ${think.inCodeBlock}`).toBe("dots in the code block while it runs: 0");

    await page.waitForFunction(() => !document.querySelector(".think"), { timeout: 30000 }).catch(() => {});
  }, 120000);

  test("no page errors were raised by any of this", () => {
    expect(`page errors: ${pageErrors.join(" | ") || "none"}`).toBe("page errors: none");
  });
});
