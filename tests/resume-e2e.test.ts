/* ============================================================
   resume-e2e.test.ts — Esc and Enter are a round trip (ADR 0036).

   Esc already left Raw for Preview. The claim here is the other direction:
   Enter, with nothing more specific claiming the key, puts the caret back
   where it was — the same offset, on the same line, at the same height on
   screen. Only a real browser can answer the height half, so the measurement
   is `boxAt` against the rendered block's own rect rather than a line count.

   The second describe is the boundary: Enter is claimed ONLY for "nothing
   focused, document showing", so a focused tree row still renames and a modal
   still takes its primary — both exactly as they did yesterday.

   Prior art: tests/ux-e2e.test.ts (the mode-switch and ADR 0027 anchoring
   shape) and tests/edit-exit-e2e.test.ts (Esc leaving Raw, the exit guard).
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, docMode, ensureMode, type AppDriver } from "./browser";

const ALPHA = "resume/alpha.md";
const BETA = "resume/beta.md";
const FRESH = "resume/fresh.md";
const CRLF = "resume/crlf.md";

/* A FILE FROM WINDOWS, kept byte for byte the way the vault keeps everything
   (server/vault.ts). Its quote lines are the ones Preview's quote reader could
   not read — and `/` renders whatever this browser last opened (ADR 0035), so
   a doc that throws on render throws on the BOOT SCREEN, where there is no
   pane to fall back to. */
const CRLF_SRC = "> quoted\r\n> > deeper\r\nplain tail\r\n";

/* One-line paragraphs separated by blank lines, taller than the pane: every
   source line a test aims at is its own rendered `[data-line]`, so the block
   `resumeRaw` anchors to is the caret's own line and not a paragraph it is
   buried in. */
const doc = (tag: string) => Array.from({ length: 120 }, (_, i) => `${tag} paragraph ${i}`).join("\n\n") + "\n";
const ALPHA_SRC = doc("alpha");
const BETA_SRC = doc("beta");

/** the source line a paragraph index lands on, and the offset a few characters into it */
const lineOf = (para: number) => para * 2;
const offsetOf = (src: string, line: number, col = 6) =>
  src
    .split("\n")
    .slice(0, line)
    .reduce((n, l) => n + l.length + 1, 0) + col;

const ALPHA_LINE = lineOf(8);
const ALPHA_CARET = offsetOf(ALPHA_SRC, ALPHA_LINE);
const BETA_LINE = lineOf(20);
const BETA_CARET = offsetOf(BETA_SRC, BETA_LINE);

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: { [ALPHA]: ALPHA_SRC, [BETA]: BETA_SRC, [FRESH]: doc("fresh"), [CRLF]: CRLF_SRC } });
  /* nothing here is about autosave, and a debounce landing mid-assertion turns
     the exit guard into a race (edit-exit-e2e makes the same trade) */
  expect((await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } })).status).toBe(200);
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  if (page) await page.close().catch(() => {});
  await srv.putDoc(ALPHA, ALPHA_SRC).catch(() => {});
  pageErrors.length = 0;
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
  app = appDriver(page, srv.base);
});

async function enterRawAt(caret: number) {
  await ensureMode(page, "raw");
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
  await page.evaluate((p) => {
    const ta = document.getElementById("rawArea") as any;
    ta.focus();
    ta.setSelectionRange(p, p);
  }, caret);
}

/** Click a doc in the tree and let go of the row: a clicked row KEEPS the
    focus, and a focused row has its own Enter (tree.js `rowKeys` renames).
    What resumes editing is Enter with nothing focused. */
async function switchTo(path: string) {
  await app.clickDoc(path);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function escToPreview() {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), { timeout: 8000 });
}

async function enterToRaw() {
  await page.keyboard.press("Enter");
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

/** where the caret sits in the pane, and whether it sits in it at all */
const caretState = (caret: number) =>
  page.evaluate((n) => {
    const ta = document.getElementById("rawArea") as any;
    const s = document.getElementById("scroll")!.getBoundingClientRect();
    const box = ta.boxAt(n);
    return {
      focused: document.activeElement ? (document.activeElement as HTMLElement).id : "",
      caret: ta.selectionStart as number,
      top: box.top - s.top,
      inPane: box.top >= s.top - 1 && box.bottom <= s.bottom + 1,
    };
  }, caret);

/** the rendered block for a source line: where it sits in the pane, if it does */
const blockTop = (line: number) =>
  page.evaluate((l) => {
    const b = document.querySelector(`#doc [data-line="${l}"]`) as HTMLElement | null;
    if (!b) return { found: false, top: 0, onScreen: false };
    const r = b.getBoundingClientRect();
    const s = document.getElementById("scroll")!.getBoundingClientRect();
    return { found: true, top: r.top - s.top, onScreen: r.bottom > s.top && r.top < s.bottom };
  }, line);

describe("Enter resumes editing at the caret", () => {
  test("Enter returns to the caret Esc left behind, on the line where it already sits", async () => {
    await app.boot("/d/" + ALPHA);
    await enterRawAt(ALPHA_CARET);
    await escToPreview();

    const block = await blockTop(ALPHA_LINE);
    expect(`found ${block.found} / on screen ${block.onScreen}`).toBe("found true / on screen true");

    await enterToRaw();
    const at = await caretState(ALPHA_CARET);
    expect(`${at.focused} @ ${at.caret}`).toBe(`rawArea @ ${ALPHA_CARET}`);
    /* ADR 0027's rule, applied to the caret line: the line does not move.
       Within a pixel or two — a caret box and a paragraph box are measured off
       different boxes, and the scroll offset they are set from is an integer. */
    expect(Math.abs(at.top - block.top) <= 2 ? "held" : `moved ${(at.top - block.top).toFixed(1)}px`).toBe("held");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("with the caret's line scrolled off screen, Enter still opens at the caret — in view", async () => {
    await app.boot("/d/" + ALPHA);
    await enterRawAt(ALPHA_CARET);
    await escToPreview();

    await page.evaluate(() => {
      const sc = document.getElementById("scroll")!;
      sc.scrollTop = sc.scrollHeight;
    });
    expect((await blockTop(ALPHA_LINE)).onScreen).toBe(false);

    await enterToRaw();
    const at = await caretState(ALPHA_CARET);
    expect(`caret ${at.caret} / in pane ${at.inPane}`).toBe(`caret ${ALPHA_CARET} / in pane true`);
  }, 60000);

  test("each doc resumes at its own caret, across a switch and back", async () => {
    await app.boot("/d/" + ALPHA);
    await enterRawAt(ALPHA_CARET);
    await escToPreview();

    await switchTo(BETA);
    await enterRawAt(BETA_CARET);
    await escToPreview();

    await switchTo(ALPHA);
    await enterToRaw();
    expect((await caretState(ALPHA_CARET)).caret).toBe(ALPHA_CARET);

    await escToPreview();
    await switchTo(BETA);
    await enterToRaw();
    expect((await caretState(BETA_CARET)).caret).toBe(BETA_CARET);
  }, 60000);

  test("a doc nobody has edited resumes at the top", async () => {
    await app.boot("/d/" + FRESH);
    await enterToRaw();
    expect((await caretState(0)).caret).toBe(0);
  }, 60000);

  test("switching docs in Raw remembers the caret too — the mode never changes", async () => {
    await app.boot("/d/" + ALPHA);
    await enterRawAt(ALPHA_CARET);
    /* B opens in Raw because Raw is where the app already was: this navigation
       never passes through `setMode`, so `openDoc` is the second door out of a
       mounted editor and has to remember what it leaves behind. */
    await switchTo(BETA);
    expect(await docMode(page)).toBe("raw");

    await page.focus("#rawArea");
    await escToPreview();
    await switchTo(ALPHA);
    await enterToRaw();
    expect((await caretState(ALPHA_CARET)).caret).toBe(ALPHA_CARET);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("Discard resumes at the caret, not at the end of the document it reverted", async () => {
    await app.boot("/d/" + ALPHA);
    await enterRawAt(ALPHA_CARET);
    /* dirty AT the caret, so the offset under test is the one the typing left
       behind rather than one the whole buffer was replaced around */
    await page.evaluate((n) => {
      const ta = document.getElementById("rawArea") as any;
      ta.replaceRange(n, n, "typo");
    }, ALPHA_CARET);
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
      timeout: 8000,
    });
    const dirtyCaret = await page.$eval("#rawArea", (n) => (n as any).selectionStart as number);
    expect(dirtyCaret).toBe(ALPHA_CARET + 4);

    await page.keyboard.press("Escape");
    await app.waitVeil("xgVeil", true);
    await page.click('#xgVeil [data-act="xg-discard"]');
    await app.waitVeil("xgVeil", false);
    await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), {
      timeout: 8000,
    });

    await enterToRaw();
    /* the reverted text is longer than this offset, so the clamp is the
       identity here; what is asserted is that putting the saved bytes back did
       not carry the caret to the end of them */
    expect((await caretState(dirtyCaret)).caret).toBe(Math.min(dirtyCaret, ALPHA_SRC.length));
    expect(pageErrors).toEqual([]);
  }, 60000);
});

describe("a doc with CR line endings renders — and boots", () => {
  test("/ resumes a CRLF doc: the quote renders and the boot completes", async () => {
    /* `resume: true` keeps `znotes.last-doc` across this page's loads, which is
       the whole point: the first boot stores the doc, the second one is the
       bare root resolving it (ADR 0035). */
    const errs: string[] = [];
    const rp = await newAppPage(browser, { resume: true, onPageError: (m) => errs.push(m) });
    const rui = appDriver(rp, srv.base);
    try {
      await rui.boot("/d/" + CRLF);
      expect(await rui.shown()).toBe(CRLF);

      await rui.boot("/");
      expect(await rui.shown()).toBe(CRLF);
      const rendered = await rp.evaluate(() => ({
        quotes: document.querySelectorAll("#doc .md blockquote").length,
        /* the CR the HTML parser may turn into a newline is not the point —
           that the line rendered at all is */
        first: (document.querySelector("#doc .md blockquote .pline")?.textContent ?? "").replace(/[\r\n]+$/, ""),
        failed: document.querySelectorAll("#doc .render-error").length,
      }));
      expect(rendered).toEqual({ quotes: 2, first: "quoted", failed: 0 });
      expect(errs).toEqual([]);
      /* and not one byte of it was rewritten by being read */
      expect((await srv.get("/api/docs/" + CRLF)).body.markdown).toBe(CRLF_SRC);
    } finally {
      await rp.close().catch(() => {});
    }
  }, 60000);
});

describe("Enter keeps every meaning it already had", () => {
  test("on a focused tree row it is still the tree's — the rename, not the resume", async () => {
    await app.boot("/d/" + ALPHA);
    const row = `#tree .row.file[data-doc="${BETA}"]`;
    await page.waitForSelector(row, { timeout: 8000 });
    await page.evaluate((sel) => (document.querySelector(sel as string) as HTMLElement).focus(), row);
    await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel as string), {
      timeout: 5000,
    }, row);

    await page.keyboard.press("Enter");
    /* tree.js `rowKeys`: ⏎ renames a row, Space opens it. The mode stays
       Preview and the pane stays on the doc it was on. */
    await page.waitForSelector("#tree .newrow input", { timeout: 8000 });
    expect(await docMode(page)).toBe("preview");
    expect(await app.shown()).toBe(ALPHA);
  }, 60000);

  test("with the exit guard up, Enter presses its primary and the mode does not flip", async () => {
    await app.boot("/d/" + ALPHA);
    await ensureMode(page, "raw");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
    await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      ta.focus();
      ta.value = "edited alpha\n";
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    });
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
      timeout: 8000,
    });

    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await app.waitVeil("xgVeil", true);
    /* the dialog takes the focus itself, a beat after it mounts (guardRawExit
       focuses the modal rather than a button) — Enter before that is still the
       caret's, in the editor underneath */
    await page.waitForFunction(() => !!(document.activeElement && document.activeElement.closest("#xgVeil")), {
      timeout: 5000,
    });

    await page.keyboard.press("Enter");
    await app.waitVeil("xgVeil", false);
    await app.settled(BETA);
    /* "Save & exit" is the primary: the edit reached disk, and nothing about
       Enter silently changed which view of the document is up */
    expect(await docMode(page)).toBe("raw");
    expect((await srv.get("/api/docs/" + ALPHA)).body.markdown).toBe("edited alpha\n");
  }, 60000);
});
