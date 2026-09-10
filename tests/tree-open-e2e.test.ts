/* ============================================================
   tree-open-e2e.test.ts — which folders are open survives a reload (spec 0012).

   Disclosure is a VIEW choice: the server's `folders` table only ever seeds a
   folder OPEN, and the client never writes a close back, so before this the
   tree reopened everything on every reload. It is now mirrored per browser in
   `znotes.tree-open`, the twin of Preview's `znotes.folds` (ADR 0023) — which
   is why this needs a real browser: the claims are "the row came back closed"
   and "localStorage was left holding the reason".

   Six claims: a close survives a reload, so does re-opening it, an untouched
   folder still takes the server's word and costs no storage, a folder that
   left the tree takes its key with it, an unreadable blob means no memory
   rather than a broken sidebar — and a REVEAL is not a choice: opening a doc
   inside a collapsed folder shows it for this session without ever writing
   `true` over the close the user asked for.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

/* The doc that is OPEN throughout sits at the vault root on purpose: opening a
   doc reveals its ancestors, and an ancestor is a folder the test would then
   have touched without clicking it. `keep/` is therefore nobody's ancestor. */
const HOME = "inbox.md";
const SEED: SeedMap = {
  [HOME]: "# Inbox\n\nstart here\n",
  "notes/one.md": "# One\n",
  "keep/two.md": "# Two\n",
  /* the reveal case at the foot of this file: the one folder here that IS an
     ancestor of a doc the test opens */
  "deep/three.md": "# Three\n",
};

const STORE = "znotes.tree-open";
const FOLDER = "notes";
const UNTOUCHED = "keep";

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  /* resume: this suite MEASURES `znotes.tree-open` surviving a reload, so the
     harness must not clear it on every navigation */
  page = await newAppPage(browser, { resume: true, onPageError: (m) => pageErrors.push(m) });
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* ------------------------------------------------------------------
   page helpers
   ------------------------------------------------------------------ */

const row = (path: string) => `#tree .row.folder[data-path="${path}"]`;

async function boot() {
  await page.goto(srv.base + "/d/" + HOME, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForSelector(row(FOLDER), { timeout: 15000 });
  await sleep(120);
}

/** How a folder row is drawn right now: is the row `.open`, and is the
    `.children` box beside it `.closed`? The two must always disagree. */
const drawn = (path: string) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel as string) as HTMLElement | null;
    if (!r) return "no such row";
    const kids = r.closest(".rowwrap")!.nextElementSibling as HTMLElement;
    return `open=${r.classList.contains("open")} closed=${kids.classList.contains("closed")}`;
  }, row(path));

/** …and with the memory thrown away first, so the test states its own starting
    point. Two loads, not one: the removal needs a booted origin to run in, and
    only a load that starts from nothing proves what the seed does. */
async function fresh() {
  await boot();
  await page.evaluate((k) => {
    try {
      localStorage.removeItem(k as string);
    } catch {}
  }, STORE);
  await boot();
}

/** what localStorage has been left holding for the tree */
const remembered = () =>
  page.evaluate((k) => {
    try {
      const raw = JSON.parse(localStorage.getItem(k as string) || "null");
      return raw ? JSON.stringify(raw.folders) : "nothing";
    } catch {
      return "unreadable";
    }
  }, STORE);

/* ============================================================
   1 · a close, and the re-open after it, both survive a reload
   ============================================================ */

describe("a folder's disclosure survives a reload", () => {
  test("clicked closed → still closed; clicked open again → still open", async () => {
    await fresh();
    expect(`as seeded: ${await drawn(FOLDER)}`).toBe("as seeded: open=true closed=false");

    await page.click(row(FOLDER));
    expect(`after the click: ${await drawn(FOLDER)}`).toBe("after the click: open=false closed=true");
    expect(`remembered: ${await remembered()}`).toBe(`remembered: {"${FOLDER}":false}`);

    await boot();
    expect(`after a reload: ${await drawn(FOLDER)}`).toBe("after a reload: open=false closed=true");
    expect(`still remembered: ${await remembered()}`).toBe(`still remembered: {"${FOLDER}":false}`);

    await page.click(row(FOLDER));
    expect(`re-opened: ${await remembered()}`).toBe(`re-opened: {"${FOLDER}":true}`);
    await boot();
    expect(`after a second reload: ${await drawn(FOLDER)}`).toBe("after a second reload: open=true closed=false");
  }, 120000);

  test("a folder nobody touched renders as the server says, and costs no storage", async () => {
    expect(`untouched: ${await drawn(UNTOUCHED)}`).toBe("untouched: open=true closed=false");
    expect(`remembered: ${await remembered()}`).toBe(`remembered: {"${FOLDER}":true}`);
  }, 60000);
});

/* ============================================================
   2 · a key outlives nothing — a folder that left the tree takes it along
   ============================================================ */

describe("a renamed folder does not leave a ghost behind", () => {
  test("the stale key is gone after the next load", async () => {
    const r = await srv.api("PATCH", "/api/docs/" + FOLDER, { to: FOLDER + "-elsewhere" });
    expect(`PATCH → ${r.status}`).toBe("PATCH → 200");

    await page.goto(srv.base + "/d/" + HOME, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector(row(FOLDER + "-elsewhere"), { timeout: 15000 });
    await sleep(120);
    expect(`remembered: ${await remembered()}`).toBe("remembered: {}");
  }, 90000);
});

/* ============================================================
   3 · an unreadable store is no memory, not a broken sidebar
   ============================================================ */

describe("a store this version cannot read means the server's answer", () => {
  test("every folder boots open and nothing throws", async () => {
    await page.evaluate((k) => {
      try {
        localStorage.setItem(k as string, "not json");
      } catch {}
    }, STORE);
    pageErrors.length = 0;

    await page.goto(srv.base + "/d/" + HOME, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector(row(UNTOUCHED), { timeout: 15000 });
    await sleep(120);

    expect(`renamed folder: ${await drawn(FOLDER + "-elsewhere")}`).toBe("renamed folder: open=true closed=false");
    expect(`untouched folder: ${await drawn(UNTOUCHED)}`).toBe("untouched folder: open=true closed=false");
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  }, 90000);
});

/* ============================================================
   4 · a reveal is not a choice — the open doc's folder is shown, not remembered
   ============================================================ */

describe("opening a doc inside a collapsed folder does not un-collapse it for good", () => {
  const REVEALED = "deep";
  const INSIDE = "deep/three.md";

  test("the close survives the reload that reveals the doc, and the row is closed elsewhere", async () => {
    await page.goto(srv.base + "/d/" + INSIDE, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector(row(REVEALED), { timeout: 15000 });
    await sleep(120);
    expect(`with the doc open inside it: ${await drawn(REVEALED)}`).toBe(
      "with the doc open inside it: open=true closed=false"
    );

    await page.click(row(REVEALED));
    expect(`clicked closed: ${await drawn(REVEALED)}`).toBe("clicked closed: open=false closed=true");
    expect(`remembered: ${await remembered()}`).toBe(`remembered: {"${REVEALED}":false}`);

    /* the same URL again: `openDoc` reveals the active doc's ancestors on every
       boot, so this is the load that used to write the close back to `true` */
    await page.goto(srv.base + "/d/" + INSIDE, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector(row(REVEALED), { timeout: 15000 });
    await sleep(120);
    expect(`after the reveal: ${await remembered()}`).toBe(`after the reveal: {"${REVEALED}":false}`);

    /* …and away from that doc the row is drawn the way it was clicked */
    await page.goto(srv.base + "/d/" + HOME, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector(row(REVEALED), { timeout: 15000 });
    await sleep(120);
    expect(`elsewhere: ${await drawn(REVEALED)}`).toBe("elsewhere: open=false closed=true");
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  }, 120000);
});
