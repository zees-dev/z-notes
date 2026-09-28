/* ============================================================
   edit-exit-e2e.test.ts — leaving an unsaved doc is one guarded funnel.

   The modal is not merely present: these checks type through the real editor
   and drive every exit class (an in-app navigation, browser Back, deleting
   the open doc). They also pin the most important visual contract — only
   changed lines are shown, never the whole original document as context.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { sleep, startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, gotoSettings, saveSettings, type AppDriver } from "./browser";

const ORIGINAL = "# Alpha\n\nkeep before\n\nfirst\n\nunchanged middle\n\nsecond\n\nkeep after\n";
const ALPHA = "alpha.md";
const BETA = "beta.md";
const DELETE_ME = "delete-me.md";
const DELETE_NEXT = "delete-next.md";
const LARGE = "large.md";
const SHORT = "short.md";
const SHORT_MARKDOWN = "# Short\nsecond line";
const LARGE_ORIGINAL = Array.from({ length: 800 }, (_, i) => `old line ${i}`).join("\n") + "\n";

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({
    seed: {
      [ALPHA]: ORIGINAL,
      [BETA]: "# Beta\n\nsecond doc\n",
      [DELETE_ME]: "# Delete me\n\noriginal retained bytes\n",
      [DELETE_NEXT]: "# Delete next\n\nneighbour\n",
      [LARGE]: LARGE_ORIGINAL,
      [SHORT]: SHORT_MARKDOWN,
    },
  });
  const defaults = await srv.get("/api/settings");
  expect(defaults.status).toBe(200);
  expect(defaults.body.settings.editor.confirmBeforeExit).toBe(true);
  /* Keep autosave out of this interaction test. The guard is intentionally
     silent once autosave has really landed, so a short debounce would make the
     expected modal depend on test-machine timing. */
  const set = await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } });
  expect(set.status).toBe(200);
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  if (page) await page.close().catch(() => {});
  pageErrors.length = 0;
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
  app = appDriver(page, srv.base);
  await app.boot("/d/alpha.md");
});

/** Type at the end of the paragraph that reads `line`, through the Edit island. */
async function appendTo(line: string, text: string) {
  await (await page.waitForSelector(`xpath///*[contains(@class,"bn-inline-content")][.="${line}"]`, { timeout: 15000 }))!.click();
  await sleep(80); // ProseMirror ignores a caret move for 50 ms after a view update
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
    timeout: 5000,
  });
}

const guardOpen = () => app.veilUp("xgVeil");
const editorText = () => page.$eval("#doc .bn-editor", (n) => n.textContent!);

async function waitGuard(want: boolean) {
  await app.waitVeil("xgVeil", want);
  /* the veil takes the focus 30 ms after it shows; a key sent before that lands in the editor */
  if (want) await page.waitForFunction(() => !!document.activeElement?.closest("#xgVeil"), { timeout: 2000 });
}

async function serverMarkdown(path = ALPHA): Promise<string> {
  const r = await srv.get("/api/docs/" + path);
  expect(r.status).toBe(200);
  return r.body.markdown;
}

describe("unsaved exit", () => {
  test("a navigation waits and shows only changed lines; Esc and the scrim keep editing", async () => {
    await appendTo("first", " edited");
    await appendTo("second", " edited");

    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await waitGuard(true);
    const modal = await page.evaluate(() => ({
      title: document.getElementById("xgTitle")!.textContent,
      path: document.getElementById("xgPath")!.textContent,
      rows: [...document.querySelectorAll<HTMLElement>("#xgDiff .dl")].map((r) => ({
        marker: r.querySelector(".g")?.textContent ?? "",
        text: r.querySelector(".t")?.textContent ?? "",
      })),
    }));
    expect(modal.title).toBe("Exit without saving?");
    expect(modal.path).toBe(ALPHA);
    expect(modal.rows).toEqual([
      { marker: "-", text: "first" },
      { marker: "+", text: "first edited" },
      { marker: "-", text: "second" },
      { marker: "+", text: "second edited" },
    ]);
    expect(await app.shown()).toBe(ALPHA);
    expect(await serverMarkdown()).toBe(ORIGINAL);

    /* Esc on the question is the non-destructive answer, and so is a click on the scrim. */
    await page.keyboard.press("Escape");
    await waitGuard(false);
    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await waitGuard(true);
    await page.mouse.click(4, 4);
    await waitGuard(false);
    expect(await app.shown()).toBe(ALPHA);
    expect(await editorText()).toContain("second edited");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("turning off Ask before leaving edits saves before navigation without a prompt", async () => {
    expect((await srv.get("/api/settings")).body.settings.editor.confirmBeforeExit).toBe(true);
    try {
      await gotoSettings(page);
      await page.click("[data-sw='editor.confirmBeforeExit']");
      expect(await saveSettings(page, { expectDirty: true })).toBe(true);
      expect((await srv.get("/api/settings")).body.settings.editor.confirmBeforeExit).toBe(false);

      /* Saving the draft applies the preference live; no reload is needed. */
      await app.clickDoc(SHORT);
      await appendTo("second line", " saved on leaving");
      await page.click(`#tree .row.file[data-doc="${BETA}"]`);
      await app.settled(BETA);
      expect(await guardOpen()).toBe(false);
      const saved = await serverMarkdown(SHORT);
      expect(saved).toContain("second line saved on leaving");

      /* No prompt must not become navigate-at-any-cost. If the automatic write
         fails, the doc and its only copy of the new text stay where they are. */
      await app.clickDoc(SHORT);
      await appendTo("second line saved on leaving", " and kept");
      await page.setRequestInterception(true);
      const refuseSave = (request: HTTPRequest) => {
        if (request.method() === "PUT" && request.url().endsWith("/api/docs/short.md")) void request.abort();
        else void request.continue();
      };
      page.on("request", refuseSave);
      try {
        await page.click(`#tree .row.file[data-doc="${BETA}"]`);
        await page.waitForFunction(
          () => document.getElementById("toast")!.textContent!.includes("your changes are still in this tab"),
          { timeout: 10000 }
        );
        expect(await app.shown()).toBe(SHORT);
        expect(await editorText()).toContain("saved on leaving and kept");
        expect(await serverMarkdown(SHORT)).toBe(saved);
      } finally {
        page.off("request", refuseSave);
        await page.setRequestInterception(false);
      }
      expect(pageErrors).toEqual([]);
    } finally {
      const restored = await srv.api("PUT", "/api/settings", { editor: { confirmBeforeExit: true } });
      expect(restored.status).toBe(200);
    }
  }, 60000);

  test("browser Back is guarded and Discard changes replays that navigation", async () => {
    await app.clickDoc(BETA);
    await appendTo("second doc", " with an unsaved edit");

    await app.back();
    await waitGuard(true);
    expect(await app.shown()).toBe(BETA);
    expect(await app.urlPath()).toBe("/d/beta.md");

    await page.click('#xgVeil [data-act="xg-discard"]');
    await waitGuard(false);
    await app.settled(ALPHA);
    expect(await serverMarkdown(BETA)).toBe("# Beta\n\nsecond doc\n");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("confirming deletion of a dirty doc asks about its staged diff before removing it", async () => {
    await app.clickDoc(DELETE_ME);
    await appendTo("original retained bytes", " and staged text");

    await page.evaluate((path) => {
      const b = document.querySelector<HTMLElement>(
        `#tree .row.file[data-doc="${path}"] + .rowacts .rowact[aria-label^="Delete "]`
      );
      if (!b) throw new Error("delete row action is missing");
      b.click();
    }, DELETE_ME);
    await app.waitVeil("cfVeil", true);
    await page.click('#cfVeil [data-act="cf-ok"]');
    await waitGuard(true);
    expect(await serverMarkdown(DELETE_ME)).toBe("# Delete me\n\noriginal retained bytes\n");

    await page.click('#xgVeil [data-act="xg-discard"]');
    await waitGuard(false);
    await app.settled(DELETE_NEXT);
    expect((await srv.get("/api/docs/" + DELETE_ME)).status).toBe(404);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("a large rewrite stays bounded and still shows only removed and added rows", async () => {
    /* the file is one 800-line paragraph; a triple click selects all of it, so
       801 rows change and the modal keeps 150 removed and the one added */
    await app.clickDoc(LARGE);
    await (await page.waitForSelector("#doc .bn-inline-content", { timeout: 15000 }))!.click({ count: 3 });
    await sleep(80);
    await page.keyboard.type("new");
    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await waitGuard(true);

    const rows = await page.$$eval("#xgDiff .dl", (all) =>
      all.map((r) => ({ marker: r.querySelector(".g")?.textContent ?? "", text: r.querySelector(".t")?.textContent ?? "" }))
    );
    expect(rows).toHaveLength(151);
    expect(rows.slice(0, 150).every((r) => r.marker === "-" && r.text.startsWith("old line "))).toBe(true);
    expect(rows[150]).toEqual({ marker: "+", text: "new" });

    await page.click('#xgVeil [data-act="xg-discard"]');
    await waitGuard(false);
    expect(pageErrors).toEqual([]);
  }, 60000);
});
