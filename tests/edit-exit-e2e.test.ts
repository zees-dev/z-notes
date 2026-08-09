/* ============================================================
   edit-exit-e2e.test.ts — unsaved Raw-mode exit is one guarded funnel.

   The modal is not merely present: these checks drive the real textarea and
   every important exit class (Esc, an in-app navigation, browser Back). They
   also pin the most important visual contract — only changed lines are shown,
   never the whole original document as context.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, pressChord, type AppDriver } from "./browser";

const ORIGINAL = "# Alpha\n\nkeep before\nold first\nunchanged middle\nold second\nkeep after\n";
const EDITED = "# Alpha\n\nkeep before\nnew first\nunchanged middle\nnew second\nkeep after\n";
const ALPHA = "alpha.md";
const BETA = "beta.md";
const DELETE_ME = "delete-me.md";
const DELETE_NEXT = "delete-next.md";
const LARGE = "large.md";
const SHORT = "short.md";
const SHORT_MARKDOWN = "# Short\nsecond line";
const LARGE_ORIGINAL = Array.from({ length: 800 }, (_, i) => `old line ${i}`).join("\n") + "\n";
const LARGE_EDITED = Array.from({ length: 800 }, (_, i) => `new line ${i}`).join("\n") + "\n";

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

async function enterRaw() {
  await pressChord(page, "KeyE");
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

async function typeMarkdown(markdown: string) {
  await page.evaluate((text) => {
    const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
  }, markdown);
  await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
    timeout: 5000,
  });
}

const guardOpen = () => app.veilUp("xgVeil");

async function waitGuard(want: boolean) {
  await app.waitVeil("xgVeil", want);
}

async function serverMarkdown(path = ALPHA): Promise<string> {
  const r = await srv.get("/api/docs/" + path);
  expect(r.status).toBe(200);
  return r.body.markdown;
}

async function rawPaneWhitespacePoint() {
  return page.evaluate(() => {
    const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
    const r = ta.getBoundingClientRect();
    const doc = document.getElementById("doc")!.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight);
    const textBottom = r.top + lineHeight * ta.value.split("\n").length;
    const y = textBottom + 12;
    const x = r.left + 24;
    return {
      x,
      y,
      target: (document.elementFromPoint(x, y) as HTMLElement | null)?.id ?? "",
      belowText: y > textBottom,
      outsideTextarea: y > r.bottom,
      insideDocumentPane: y < doc.bottom,
    };
  });
}

describe("unsaved Raw exit", () => {
  test("clicking below a short note exits Raw through the pane whitespace", async () => {
    await app.clickDoc(SHORT);
    await enterRaw();

    const click = await rawPaneWhitespacePoint();
    expect(click.target).toBe("doc");
    expect(click.belowText).toBe(true);
    expect(click.outsideTextarea).toBe(true);
    expect(click.insideDocumentPane).toBe(true);

    await page.mouse.click(click.x, click.y);
    expect(await page.evaluate(() => document.getElementById("stMode")!.dataset.mode)).toBe("preview");
    expect(await guardOpen()).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("clicking below a dirty short note opens the staged-diff exit guard", async () => {
    await app.clickDoc(SHORT);
    await enterRaw();
    await typeMarkdown("# Short\nchanged second line");

    const click = await rawPaneWhitespacePoint();
    expect(click.target).toBe("doc");
    expect(click.outsideTextarea).toBe(true);
    await page.mouse.click(click.x, click.y);
    await waitGuard(true);

    expect(await page.evaluate(() => document.getElementById("stMode")!.dataset.mode)).toBe("raw");
    expect(await page.$$eval("#xgDiff .dl", (rows) =>
      rows.map((row) => ({
        marker: row.querySelector(".g")?.textContent ?? "",
        text: row.querySelector(".t")?.textContent ?? "",
      }))
    )).toEqual([
      { marker: "-", text: "second line" },
      { marker: "+", text: "changed second line" },
    ]);
    await page.keyboard.press("Escape");
    await waitGuard(false);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("Esc shows only changed lines; Esc keeps editing; Discard changes lands in Preview", async () => {
    await enterRaw();
    await typeMarkdown(EDITED);

    await page.keyboard.press("Escape");
    await waitGuard(true);

    const modal = await page.evaluate(() => ({
      title: document.getElementById("xgTitle")!.textContent,
      path: document.getElementById("xgPath")!.textContent,
      rows: [...document.querySelectorAll<HTMLElement>("#xgDiff .dl")].map((r) => ({
        marker: r.querySelector(".g")?.textContent ?? "",
        text: r.querySelector(".t")?.textContent ?? "",
      })),
      raw: document.getElementById("doc")!.classList.contains("raw-mode"),
    }));
    expect(modal.title).toBe("Exit without saving?");
    expect(modal.path).toBe(ALPHA);
    expect(modal.rows).toEqual([
      { marker: "-", text: "old first" },
      { marker: "+", text: "new first" },
      { marker: "-", text: "old second" },
      { marker: "+", text: "new second" },
    ]);
    expect(modal.raw).toBe(true);
    expect(await serverMarkdown()).toBe(ORIGINAL);

    /* Esc on the question is the non-destructive answer. */
    await page.keyboard.press("Escape");
    await waitGuard(false);
    expect(await page.evaluate(() => document.getElementById("doc")!.classList.contains("raw-mode"))).toBe(true);
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe(EDITED);

    await page.keyboard.press("Escape");
    await waitGuard(true);
    await page.click('#xgVeil [data-act="xg-discard"]');
    await waitGuard(false);
    await page.waitForFunction(() => document.getElementById("stMode")!.dataset.mode === "preview", { timeout: 8000 });
    expect(await serverMarkdown()).toBe(ORIGINAL);
    expect(await page.$eval("#doc", (n) => n.textContent!.includes("old first") && !n.textContent!.includes("new first"))).toBe(true);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("a document navigation waits; Save & exit writes, then opens the requested doc", async () => {
    await enterRaw();
    await typeMarkdown(EDITED);

    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await waitGuard(true);
    expect(await app.shown()).toBe(ALPHA);
    expect(await serverMarkdown()).toBe(ORIGINAL);

    await page.click('#xgVeil [data-act="xg-save"]');
    await waitGuard(false);
    await app.settled(BETA);
    expect(await serverMarkdown()).toBe(EDITED);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("browser Back is guarded and Discard changes replays that navigation", async () => {
    await app.clickDoc(BETA);
    await enterRaw();
    const betaEdited = "# Beta\n\nunsaved back-navigation edit\n";
    await typeMarkdown(betaEdited);

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

  test("Esc leaves a clean Raw buffer directly, with no modal", async () => {
    await enterRaw();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("stMode")!.dataset.mode === "preview", { timeout: 8000 });
    expect(await guardOpen()).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("confirming deletion of a dirty Raw doc asks about its staged diff before removing it", async () => {
    await app.clickDoc(DELETE_ME);
    await enterRaw();
    await typeMarkdown("# Delete me\n\nstaged text that is not on disk\n");

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
    await app.clickDoc(LARGE);
    await enterRaw();
    await typeMarkdown(LARGE_EDITED);
    await page.keyboard.press("Escape");
    await waitGuard(true);

    const rows = await page.$$eval("#xgDiff .dl", (all) =>
      all.map((r) => ({ marker: r.querySelector(".g")?.textContent ?? "", text: r.querySelector(".t")?.textContent ?? "" }))
    );
    expect(rows).toHaveLength(300);
    expect(rows.slice(0, 150).every((r) => r.marker === "-" && r.text.startsWith("old line "))).toBe(true);
    expect(rows.slice(150).every((r) => r.marker === "+" && r.text.startsWith("new line "))).toBe(true);

    await page.click('#xgVeil [data-act="xg-discard"]');
    await app.waitVeil("xgVeil", false);
    expect(pageErrors).toEqual([]);
  }, 60000);
});
