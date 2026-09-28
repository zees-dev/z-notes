/* ============================================================
   resume-e2e.test.ts — `/` resumes the last doc (ADR 0035), and Enter belongs
   to whatever has the focus.

     · THE ROOT URL renders whatever this browser last opened — so a document
       the editor cannot parse throws on the BOOT SCREEN, where there is no
       pane to fall back to. The fixture is a FILE FROM WINDOWS, kept byte for
       byte the way the vault keeps everything (server/vault.ts): its CRLF
       quote lines are the ones the old Preview quote reader could not read,
       and the island has to mount, show them and give the bytes back
       untouched.
     · ENTER on the exit guard is its primary action. (⏎ on a focused tree
       row is measured in tests/fileops-e2e.test.ts.)

   Prior art: tests/edit-exit-e2e.test.ts (the exit guard).
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, type AppDriver } from "./browser";

const ALPHA = "resume/alpha.md";
const BETA = "resume/beta.md";
const CRLF = "resume/crlf.md";

/* A quote the adapter reads (one paragraph, two soft-broken lines), a NESTED
   quote it will not round-trip and therefore protects, and a plain tail —
   every line of it terminated the way Windows terminates lines. */
const CRLF_SRC = "> quoted\r\n> and more\r\n\r\n> > deeper\r\n\r\nplain tail\r\n";

/* One-line paragraphs separated by blank lines, taller than the pane. */
const doc = (tag: string) => Array.from({ length: 120 }, (_, i) => `${tag} paragraph ${i}`).join("\n\n") + "\n";
const ALPHA_SRC = doc("alpha");
const BETA_SRC = doc("beta");

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: { [ALPHA]: ALPHA_SRC, [BETA]: BETA_SRC, [CRLF]: CRLF_SRC } });
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
      await rp.waitForSelector("#doc .bn-editor", { timeout: 20000 });
      const rendered = await rp.evaluate(() => {
        const blocks = [...document.querySelectorAll("#doc .bn-editor .bn-block-content")] as HTMLElement[];
        const quote = blocks.find((b) => b.dataset.contentType === "quote");
        return {
          types: blocks.map((b) => b.dataset.contentType).join("|"),
          /* the CR the HTML parser may turn into a newline is not the point —
             that the quote's lines rendered at all is */
          quoted: (quote?.textContent ?? "").replace(/[\r\n]+/g, ""),
          breaks: quote?.querySelectorAll("br").length ?? -1,
          failed: document.querySelectorAll("#doc .note.bad").length,
        };
      });
      /* the nested quote is syntax the adapter will not round-trip, so it is a
         protected `source` block rather than a render failure */
      expect(rendered).toEqual({ types: "quote|source|paragraph", quoted: "quotedand more", breaks: 1, failed: 0 });
      expect(errs).toEqual([]);
      /* and not one byte of it was rewritten by being read */
      expect((await srv.get("/api/docs/" + CRLF)).body.markdown).toBe(CRLF_SRC);
    } finally {
      await rp.close().catch(() => {});
    }
  }, 60000);
});

describe("Enter belongs to whatever has the focus", () => {
  test("with the exit guard up, Enter presses its primary", async () => {
    await app.boot("/d/" + ALPHA);
    await (await page.waitForSelector('#doc .bn-editor [data-content-type="paragraph"]', { timeout: 20000 }))!.click();
    await page.keyboard.type("EDITED-ALPHA");
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
      timeout: 8000,
    });

    await page.click(`#tree .row.file[data-doc="${BETA}"]`);
    await app.waitVeil("xgVeil", true);
    /* the dialog takes the focus itself, a beat after it mounts (guardExit
       focuses the modal rather than a button) — Enter before that is still the
       caret's, in the editor underneath */
    await page.waitForFunction(() => !!(document.activeElement && document.activeElement.closest("#xgVeil")), {
      timeout: 5000,
    });

    await page.keyboard.press("Enter");
    await app.waitVeil("xgVeil", false);
    await app.settled(BETA);
    /* "Save & exit" is the primary: the edit reached disk */
    expect((await srv.get("/api/docs/" + ALPHA)).body.markdown).toContain("EDITED-ALPHA");
  }, 60000);
});
