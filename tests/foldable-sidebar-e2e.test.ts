/* ============================================================
   foldable-sidebar-e2e.test.ts — an unfolded foldable keeps the tree beside
   the doc (ADR 0045).

   600–1023 wide and at least 480 tall, with `layout.foldableSidebar` on (the
   default), the sidebar is a grid column; a cover screen, a landscape phone and
   the setting off keep the drawer. Measured on the sidebar's and the doc's
   boxes, never on a class.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, waitUntil, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

/* CSS px of real screens: Galaxy Z Fold 5 inner and cover, an older Fold's
   narrower inner screen, a Find N5-class landscape inner screen, a landscape phone. */
const FOLD = { width: 882, height: 1104, hasTouch: true, isMobile: true };
const NARROW_FOLD = { width: 673, height: 841, hasTouch: true, isMobile: true };
const WIDE_FOLD = { width: 945, height: 856, hasTouch: true, isMobile: true };
const COVER = { width: 344, height: 882, hasTouch: true, isMobile: true };
const LANDSCAPE_PHONE = { width: 932, height: 430, hasTouch: true, isMobile: true };

let srv: TestServer;
let browser: Browser;

beforeAll(async () => {
  srv = await startServer({ seed: { "index.md": "# Fold\n\nText.\n", "other.md": "# Other\n" } });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

const setFold = async (on: boolean) =>
  expect((await srv.api("PUT", "/api/settings", { layout: { foldableSidebar: on } })).status).toBe(200);

async function open(viewport: typeof FOLD): Promise<Page> {
  const page = await newAppPage(browser, viewport);
  await page.setViewport(viewport);
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  return page;
}

/** "column" when the tree is on screen beside the doc, "drawer" when it is off-canvas. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const side = document.getElementById("sidebar")!.getBoundingClientRect();
    const main = document.querySelector(".app > .main")!.getBoundingClientRect();
    const hamburger = document.querySelector<HTMLElement>('[data-act="nav-open"]')!;
    if (side.right <= 0) return `drawer, menu ${hamburger.offsetParent ? "shown" : "hidden"}`;
    return side.left >= 0 && side.width > 150 && main.left >= side.right - 1 ? `column, menu ${hamburger.offsetParent ? "shown" : "hidden"}` : `overlap ${JSON.stringify([side, main])}`;
  });

describe("layout.foldableSidebar", () => {
  test("defaults on: an unfolded foldable shows the tree as a column, and opening a doc keeps it", async () => {
    expect((await srv.get("/api/settings")).body.settings.layout).toEqual({ foldableSidebar: true });
    for (const viewport of [FOLD, NARROW_FOLD, WIDE_FOLD]) {
      const page = await open(viewport);
      try {
        expect(`${viewport.width}x${viewport.height}: ${await layout(page)}`).toBe(`${viewport.width}x${viewport.height}: column, menu hidden`);
        await page.click('#tree [data-doc="other.md"]');
        await waitUntil(() => page.evaluate(() => document.querySelector("#doc")?.textContent?.includes("Other") ?? false), { label: "other.md open" });
        expect(`after opening a doc: ${await layout(page)}`).toBe("after opening a doc: column, menu hidden");
      } finally {
        await page.close();
      }
    }
  }, 90000);

  test("a cover screen and a landscape phone keep the drawer", async () => {
    for (const viewport of [COVER, LANDSCAPE_PHONE]) {
      const page = await open(viewport);
      try {
        expect(`${viewport.width}x${viewport.height}: ${await layout(page)}`).toBe(`${viewport.width}x${viewport.height}: drawer, menu shown`);
      } finally {
        await page.close();
      }
    }
  }, 60000);

  test("folding and unfolding moves between drawer and column; off is the drawer", async () => {
    const page = await open(COVER);
    try {
      await page.setViewport(FOLD);
      await waitUntil(async () => (await layout(page)) === "column, menu hidden", { label: "column after unfolding" });
      await page.setViewport(COVER);
      await waitUntil(async () => (await layout(page)) === "drawer, menu shown", { label: "drawer after folding" });
      await page.setViewport(FOLD);
      await setFold(false);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForApp(page);
      expect(`setting off: ${await layout(page)}`).toBe("setting off: drawer, menu shown");
    } finally {
      await page.close();
      await setFold(true);
    }
  }, 60000);
});
