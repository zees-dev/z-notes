/* ============================================================
   keybar-e2e.test.ts — the soft keyboard carries an editing bar (ADR 0034).

   The claim is only true in a browser: a phone has no Tab, no ⌘Z and no ⌘E,
   and the statusbar's mode chip is under the keyboard, so four verbs move to a
   bar pinned on the keyboard's top edge — and a tap on any of them must leave
   the caret exactly where it was, because the moment the editor blurs the
   keyboard drops and the selection the button was about to act on is gone.

   Headless has no keyboard, so the test sets the two facts the app measures
   for itself: `--kb`, the length `revealRawCaret` reads, and `kb-up` on #app,
   the class the stylesheet reads. Both are published by one listener in
   shell.js; setting them here is standing in for a keyboard, not for a device.

   Prior art: tests/mobile-editing-e2e.test.ts (the PHONE viewport, entering
   Raw through the statusbar chip) and tests/webmcp-e2e.test.ts (calling a
   tool through `document.modelContext`).
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, ensureMode, type AppDriver } from "./browser";

const PHONE = { width: 390, height: 844 };
const DOC = "keybar/list.md";
const SRC = "- alpha\n- bravo\n";
const INDENTED = "  - alpha\n- bravo\n";
const CARET = "- alpha".length;

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: { [DOC]: SRC } });
  /* nothing here is about autosave, and a debounce firing mid-assertion turns
     a byte comparison into a race */
  expect((await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600, tabSize: 2 } })).status).toBe(200);
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  /* closing the page flushes its buffer, so a test that indented leaves the
     doc on disk indented — put the seed back before the next one reads it */
  if (page) await page.close().catch(() => {});
  await srv.putDoc(DOC, SRC).catch(() => {});
  pageErrors.length = 0;
  page = await newAppPage(browser, { ...PHONE, onPageError: (m) => pageErrors.push(m) });
  app = appDriver(page, srv.base);
});

/** the buffer, through the surface editor.js talks to (ADR 0032) */
const buffer = () => page.evaluate(() => (document.getElementById("rawArea") as any).value as string);

const waitBuffer = (want: string) =>
  page.waitForFunction((w) => (document.getElementById("rawArea") as any)?.value === w, { timeout: 8000 }, want);

const barDisplay = () => page.evaluate(() => getComputedStyle(document.getElementById("keybar")!).display);

const focused = () => page.evaluate(() => document.activeElement?.id ?? "");

const tap = (kb: string) => page.click(`#keybar [data-kb="${kb}"]`);

/** whether a bar button is offering itself right now */
const dead = (kb: string) =>
  page.evaluate(
    (sel) => ((document.querySelector(sel as string) as HTMLButtonElement).disabled ? "dead" : "live"),
    `#keybar [data-kb="${kb}"]`
  );

async function openRaw() {
  await app.boot("/d/" + DOC);
  /* the chip, not ⌘E: below the phone breakpoint the chord is the one door
     that does not exist, which is the whole reason this bar does */
  await ensureMode(page, "raw", { via: "chip", settle: 160 });
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

/** Raw, a keyboard "up", and the caret in the editor at `pos`. The keyboard is
    set BEFORE the focus so the bar measures itself against a viewport that is
    already covered. */
async function rawWithKeyboard(pos = CARET) {
  await openRaw();
  await page.evaluate((p) => {
    document.documentElement.style.setProperty("--kb", "300px");
    document.getElementById("app")!.classList.add("kb-up");
    const ta = document.getElementById("rawArea") as any;
    ta.focus();
    ta.setSelectionRange(p, p);
  }, pos);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("keybar")!).display === "flex", {
    timeout: 8000,
  });
}

/** one tool call through the catalogue an agent reads (ADR 0031) */
async function callTool(name: string, input: Record<string, unknown> = {}): Promise<any> {
  const json = await page.evaluate(
    async (n: string, arg: any) => {
      const mc = (document as any).modelContext;
      const list = await mc.getTools();
      const tool = list.find((t: any) => t.name === n);
      if (!tool) throw new Error("no such tool: " + n);
      return await mc.executeTool(tool, arg);
    },
    name,
    input
  );
  return JSON.parse(json as string);
}

describe("the soft keyboard's editing bar", () => {
  test("the bar is up only while a keyboard is covering a focused editor", async () => {
    await openRaw();
    await page.evaluate(() => (document.getElementById("rawArea") as any).focus());
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("raw-focus"), {
      timeout: 8000,
    });
    /* the caret is in the editor and NOTHING is covering the viewport: the
       desktop and the hardware-keyboard tablet, in the only form headless has.
       The app never sets `kb-up` itself here — the overlap it measures is 0. */
    expect(await page.evaluate(() => document.getElementById("app")!.classList.contains("kb-up"))).toBe(false);
    expect(await barDisplay()).toBe("none");

    /* the tap that raises the keyboard, in the order a phone performs it */
    await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      ta.blur();
      document.documentElement.style.setProperty("--kb", "300px");
      document.getElementById("app")!.classList.add("kb-up");
      ta.focus();
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("keybar")!).display === "flex", {
      timeout: 8000,
    });

    /* the bar sits ON the keyboard's top edge, and publishes its own height so
       `revealRawCaret` can keep the line being typed above it */
    const box = await page.evaluate(() => {
      const bar = document.getElementById("keybar")!;
      const r = bar.getBoundingClientRect();
      return {
        bottom: Math.round(r.bottom),
        keyboardTop: innerHeight - 300,
        height: bar.offsetHeight,
        published: getComputedStyle(document.documentElement).getPropertyValue("--keybar").trim(),
      };
    });
    expect(box.bottom).toBe(box.keyboardTop);
    expect(box.height).toBeGreaterThan(0);
    expect(box.published).toBe(box.height + "px");

    /* the keyboard goes with the focus, and so does the bar */
    await page.evaluate(() => (document.getElementById("rawArea") as any).blur());
    await page.waitForFunction(() => getComputedStyle(document.getElementById("keybar")!).display === "none", {
      timeout: 8000,
    });
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Indent and Outdent do what Tab does, and the caret never leaves the editor", async () => {
    await rawWithKeyboard();
    expect(await buffer()).toBe(SRC);

    await tap("indent");
    await waitBuffer(INDENTED);
    expect(await focused()).toBe("rawArea");

    await tap("outdent");
    await waitBuffer(SRC);
    expect(await focused()).toBe("rawArea");
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Undo and Redo step the app's own timeline", async () => {
    await rawWithKeyboard();
    await tap("indent");
    await waitBuffer(INDENTED);

    await tap("undo");
    await waitBuffer(SRC);

    await tap("redo");
    await waitBuffer(INDENTED);
    expect(await focused()).toBe("rawArea");

    /* …and Redo goes dead the moment there is a text run open under the caret:
       the tap would flush it first, and a flush that records an entry drops
       the redo branch, so a lit button would do nothing (ADR 0034). */
    await tap("undo");
    await waitBuffer(SRC);
    expect(`redo before typing: ${await dead("redo")}`).toBe("redo before typing: live");
    await page.keyboard.type("z");
    await page.waitForFunction(
      () => (document.querySelector('#keybar [data-kb="redo"]') as HTMLButtonElement).disabled,
      { timeout: 8000 }
    );
    expect(`redo after one keystroke: ${await dead("redo")}`).toBe("redo after one keystroke: dead");
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Done leaves Raw for Preview and drops the keyboard with the focus", async () => {
    await rawWithKeyboard(0);
    await tap("done");
    await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), {
      timeout: 8000,
    });
    expect(await page.evaluate(() => document.getElementById("stModeTxt")!.textContent)).toBe("Preview");
    expect(await focused()).not.toBe("rawArea");
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("indent_lines is the same edit through the agent's door", async () => {
    await app.boot("/d/" + DOC);
    /* Preview: the tool answers with the API's error shape rather than throwing */
    expect(await callTool("indent_lines", {})).toEqual({
      error: "not-raw",
      message: "The raw editor is not open. Switch to Raw first.",
    });

    await ensureMode(page, "raw", { via: "chip", settle: 160 });
    await page.evaluate((p) => {
      const ta = document.getElementById("rawArea") as any;
      ta.focus();
      ta.setSelectionRange(p, p);
    }, CARET);

    expect(await callTool("indent_lines", { outdent: false })).toEqual({ ok: true });
    await waitBuffer(INDENTED);
    expect(await callTool("indent_lines", { outdent: true })).toEqual({ ok: true });
    await waitBuffer(SRC);
    expect(pageErrors).toEqual([]);
  }, 45000);
});
