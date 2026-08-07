/* ============================================================
   effort-chip-e2e.test.ts — spec 0006: change effort from the model chip.

   The chip (`.model-chip`, chat header) shows `<model> · <effort in use>` and
   is now a button: click → a popover listing `meta.efforts`, current one
   marked; pick → PUT /api/settings naming ai.effort → the chip repaints from
   a session refetch. Server behavior (the picksEffort ladder reset) is
   settings.test.ts's business; THIS file proves the browser affordance:

     - the menu lists exactly what GET /api/settings meta.efforts serves,
       with the session's current effort marked;
     - a pick lands in settings (HTTP truth) AND on the chip (DOM truth);
     - picking the effort already in use STILL issues the PUT — a re-pick is
       the documented way to reset the degradation walk, so the UI must not
       "optimize" it away;
     - an outside click closes the menu without writing anything.

   Driver: same one-server one-page shape as ai-e2e.test.ts; the mock
   upstream only exists so the endpoint is configured, no turns are run.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { sleep, startServer, waitUntil, type SeedMap, type TestServer } from "./helpers";
import { startMockUpstream, type MockUpstream } from "./mock-upstream";
import { launchTestBrowser, newAppPage } from "./browser";

const SEED: SeedMap = { "inbox.md": "# Inbox\n\nnothing yet\n" };

let srv: TestServer;
let mock: MockUpstream;
let browser: Browser;
let page: Page;

/** every PUT /api/settings the page has fired, oldest first */
const settingsPuts: string[] = [];

beforeAll(async () => {
  mock = await startMockUpstream();
  srv = await startServer({ seed: SEED });

  const put = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: "sk-e2e-key", model: "gpt-5", effort: "high" },
    git: { autoSyncSeconds: 600 },
  });
  expect(`PUT /api/settings → ${put.status}`).toBe("PUT /api/settings → 200");
  await sleep(300);

  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });
  page.on("request", (r: HTTPRequest) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/settings")
      settingsPuts.push(r.postData() ?? "");
  });

  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });

  const open = await page.evaluate(() => document.getElementById("app")!.classList.contains("chat-open"));
  if (!open) {
    await page.click('#chatBtn, [data-act="toggle-chat"]');
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
  }
  /* the chip paints from the session load; wait for it rather than sleeping */
  await waitUntil(
    async () => (await chipText()) === "gpt-5 · high",
    { timeout: 8000, label: "the model chip to paint the seeded model · effort" }
  );
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (mock) await mock.stop();
});

/* ---------------- helpers ---------------- */

const chipText = () =>
  page.evaluate(() => {
    const name = document.getElementById("modelName")?.textContent ?? "";
    const eff = document.getElementById("modelEffort")?.textContent ?? "";
    return `${name} · ${eff}`;
  });

const menuOpen = () => page.evaluate(() => document.getElementById("effortPop")!.classList.contains("show"));

const menuOptions = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#effortPop [data-effort]")].map((b) => ({
      effort: b.getAttribute("data-effort"),
      current: b.getAttribute("aria-pressed") === "true",
    }))
  );

async function openMenu() {
  await page.click("#modelChip");
  await waitUntil(menuOpen, { timeout: 4000, label: "the effort menu to open" });
}

const storedEffort = async () => {
  const r = await srv.api("GET", "/api/settings");
  return (r.body as any).settings.ai.effort as string;
};

/* ============================================================
   the menu
   ============================================================ */

describe("effort chip e2e — the menu", () => {
  test("chip click lists exactly meta.efforts, current effort marked", async () => {
    const r = await srv.api("GET", "/api/settings");
    const efforts = (r.body as any).meta.efforts as string[];
    expect(efforts.length).toBeGreaterThan(0);

    await openMenu();
    const opts = await menuOptions();
    expect(opts.map((o) => o.effort)).toEqual(efforts);
    expect(opts.filter((o) => o.current).map((o) => o.effort)).toEqual(["high"]);
    expect(await page.evaluate(() => document.getElementById("modelChip")!.getAttribute("aria-expanded"))).toBe(
      "true"
    );
  });

  test("outside click closes the menu without a PUT", async () => {
    if (!(await menuOpen())) await openMenu();
    const puts = settingsPuts.length;
    await page.click("#msgs");
    await waitUntil(async () => !(await menuOpen()), { timeout: 4000, label: "the effort menu to close" });
    expect(settingsPuts.length).toBe(puts);
    expect(await storedEffort()).toBe("high");
  });
});

/* ============================================================
   the pick
   ============================================================ */

describe("effort chip e2e — picking an effort", () => {
  test("a different effort lands in settings AND on the chip", async () => {
    await openMenu();
    await page.click('#effortPop [data-effort="low"]');

    /* the chip repaints from a session refetch — the server's effortInUse
       is the truth the chip displays, so wait on the DOM, then check HTTP */
    await waitUntil(async () => (await chipText()) === "gpt-5 · low", {
      timeout: 8000,
      label: "the chip to repaint model · low",
    });
    expect(await storedEffort()).toBe("low");
    expect(await menuOpen()).toBe(false);

    /* the menu, reopened, marks the new current */
    await openMenu();
    const opts = await menuOptions();
    expect(opts.filter((o) => o.current).map((o) => o.effort)).toEqual(["low"]);
    await page.click("#msgs");
    await waitUntil(async () => !(await menuOpen()), { timeout: 4000, label: "the effort menu to close" });
  });

  test("re-picking the CURRENT effort still issues the PUT (ladder reset path)", async () => {
    const puts = settingsPuts.length;
    await openMenu();
    await page.click('#effortPop [data-effort="low"]');
    await waitUntil(async () => !(await menuOpen()), { timeout: 4000, label: "the effort menu to close" });

    await waitUntil(async () => settingsPuts.length === puts + 1, {
      timeout: 4000,
      label: "the re-pick to issue a PUT /api/settings",
    });
    expect(JSON.parse(settingsPuts[settingsPuts.length - 1]).ai.effort).toBe("low");
    expect(await storedEffort()).toBe("low");
    expect(await chipText()).toBe("gpt-5 · low");
  });
});
