/* ============================================================
   navigation-bar-e2e.test.ts — the installed app keeps the system bars (ADR 0043).

   The manifest asks for `standalone`, and `installed.navigationBar` off hides
   the bars with the Fullscreen API on a tap. Headless Chromium cannot emulate
   `display-mode`, so `installed()` stubs that one media query before the app
   loads; full screen itself is the browser's, measured on
   `document.fullscreenElement`.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, waitUntil, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };

let srv: TestServer;
let browser: Browser;

beforeAll(async () => {
  srv = await startServer({ seed: { "index.md": "# Bars\n\nText.\n" } });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

const setBar = async (on: boolean) =>
  expect((await srv.api("PUT", "/api/settings", { installed: { navigationBar: on } })).status).toBe(200);

async function phone(installed: boolean): Promise<Page> {
  const page = await newAppPage(browser, {
    ...PHONE,
    beforeLoad: installed
      ? () => {
          const real = window.matchMedia.bind(window);
          window.matchMedia = (q: string) => real(q.includes("display-mode: standalone") ? "all" : q);
        }
      : undefined,
  });
  await page.setViewport(PHONE);
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  return page;
}

const fullscreen = (p: Page) => p.evaluate(() => !!document.fullscreenElement);

describe("installed.navigationBar", () => {
  test("the manifest keeps the system bars and the setting defaults on", async () => {
    const manifest = await (await fetch(srv.base + "/manifest.json")).json();
    expect(`${manifest.display} ${manifest.display_override}`).toBe("standalone undefined");
    expect((await srv.get("/api/settings")).body.settings.installed).toEqual({ navigationBar: true });
    const page = await phone(true);
    try {
      await page.tap("#doc");
      await sleep(300);
      expect(await fullscreen(page)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60000);

  test("off: a tap enters full screen, a tap after leaving it re-enters, and turning it on leaves it", async () => {
    await setBar(false);
    const page = await phone(true);
    try {
      await page.tap("#doc");
      await waitUntil(() => fullscreen(page), { label: "full screen after a tap" });
      await page.evaluate(() => document.exitFullscreen()); // what Back or a swipe does
      await page.tap("#doc");
      await waitUntil(() => fullscreen(page), { label: "full screen again after the next tap" });
      await setBar(true);
      await waitUntil(async () => !(await fullscreen(page)), { label: "full screen left when the setting turns on" });
    } finally {
      await page.close();
    }
  }, 60000);

  test("off: a browser tab ignores it", async () => {
    await setBar(false);
    const page = await phone(false);
    try {
      await page.tap("#doc");
      await sleep(300);
      expect(await fullscreen(page)).toBe(false);
    } finally {
      await page.close();
      await setBar(true);
    }
  }, 60000);
});
