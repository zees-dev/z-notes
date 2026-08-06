/* ============================================================
   ROUTING GATE — browser history against the real backend.

   The app puts one URL per open doc at `/d/<vault path>`. This file measures
   the claims that shape makes: every navigation is a history entry, BACK and
   FORWARD walk the docs, the URL survives a hard reload and a rename, view
   state (⌘E) never costs a doc entry, and an open overlay swallows exactly one
   BACK instead of letting it leave the doc.

   Same driver as e2e.test.ts: puppeteer-core over the cached Chromium headless
   shell. Every test gets a FRESH page, so history depth is measured rather than
   inherited, and everything is driven through the real UI — no test-only hooks
   are compiled into app.js.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, encPath, readVaultText, waitUntil, sleep, SEED_VAULT, type TestServer } from "./helpers";
import {
  BASE_HISTORY_LEN,
  appDriver,
  launchTestBrowser,
  newAppPage,
  onSettings as isOnSettings,
  waitSettings as waitForSettings,
  type AppDriver,
} from "./browser";
/* the shipped default, not a copy of it — index.html's initial <link> and the
   backend default have to name the same stylesheet or a fresh boot flashes */
import { DEFAULTS } from "../settings";

/* A is the doc `firstRealDoc` boots into (the tree is alphabetical inside a
   folder, and `architecture/` sorts first), so every test starts on it. */
const A = "architecture/event-pipeline.md";
const B = "architecture/z-notes-design.md";
const C = "projects/homelab.md";

const BASE_LEN = BASE_HISTORY_LEN;

let srv: TestServer;
let browser: Browser;
let page: Page;
let ui: AppDriver;

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
}, 60000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  page = await newAppPage(browser);
  ui = appDriver(page, srv.base);
});

afterEach(async () => {
  if (page) await page.close().catch(() => {});
});

/* ---------------- helpers ---------------- */

/* the shared app vocabulary — see tests/browser.ts. `ui` is rebuilt per test
   because `page` is, so these thunks read it at call time rather than closing
   over the driver a previous test built. */
const enc = encPath;
const dUrl = (p: string) => "/d/" + enc(p);
const boot = (at?: string) => ui.boot(at);
const shown = () => ui.shown();
const urlPath = () => ui.urlPath();
const histLen = () => ui.histLen();
const settled = (p: string) => ui.settled(p);
const clickDoc = (p: string) => ui.clickDoc(p);
const back = () => ui.back();
const forward = () => ui.forward();
const backTo = (p: string) => ui.backTo(p);
const chord = (code: string) => ui.chord(code);
const veilUp = (id: string) => ui.veilUp(id);
const waitVeil = (id: string, want: boolean) => ui.waitVeil(id, want);

/** open ⌘K, type `query`, walk the cursor to the result naming `needle`, take it */
async function palPick(query: string, needle: string) {
  await chord("KeyK");
  await waitVeil("palVeil", true);
  await page.type("#palInput", query);
  await page.waitForFunction(() => !!document.querySelector("#palList .pal-item.sel"), { timeout: 6000 });
  for (let i = 0; i < 30; i++) {
    const sel = await page.$eval("#palList .pal-item.sel", (n) => n.textContent ?? "");
    if (sel.includes(needle)) break;
    await page.keyboard.press("ArrowDown");
    await sleep(50);
  }
  await page.keyboard.press("Enter");
}

/** the "?" shortcuts overlay — the sample overlay these tests measure the
    marker mechanism with, now that Settings is a page and not a veil */
async function pressHelp() {
  await page.keyboard.down("Shift"); // "?" is shift+/
  await page.keyboard.press("Slash");
  await page.keyboard.up("Shift");
}

/** click a sidebar row-action by its aria-label; they are hover-revealed, so go via the DOM */
const rowAct = (label: string) =>
  page.evaluate((l) => {
    const b = document.querySelector<HTMLElement>(`#tree .rowact[aria-label="${l}"]`);
    if (!b) throw new Error("no row action: " + l);
    b.click();
  }, label);

/* ---------------- URL shape ---------------- */

describe("routing — URL shape", () => {
  test("booting at / lands on a doc and REPLACES the entry with /d/<path>", async () => {
    await boot("/");
    expect(await shown()).toBe(A);
    expect(await urlPath()).toBe(dUrl(A));
    expect(await histLen()).toBe(BASE_LEN); // replaceState at boot, never pushState
  }, 30000);

  test("/d/<path> serves the shell byte-identically to /, and shadows no real route", async () => {
    const root = await srv.get("/");
    const deep = await srv.get("/d/" + enc(B));
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");
    expect(deep.headers.get("etag")).toBe(root.headers.get("etag"));
    expect(deep.text).toBe(root.text);
    /* everything that must keep winning against the prefix */
    expect((await srv.get("/api/docs")).status).toBe(200);
    expect((await srv.get("/healthz")).status).toBe(200);
    expect((await srv.get("/app.js")).headers.get("content-type")).toContain("javascript");
    expect((await srv.get("/api.js")).headers.get("content-type")).toContain("javascript");
    expect((await srv.get("/themes/base.css")).headers.get("content-type")).toContain("css");
    expect((await srv.get("/vendor/age.js")).status).toBe(200); // 302 → hashed bundle
  }, 20000);

  test("/settings and /settings/<section> serve the same shell, and never shadow /api/settings", async () => {
    const root = await srv.get("/");
    for (const at of ["/settings", "/settings/ai"]) {
      const r = await srv.get(at);
      expect(`${at} → ${r.status}`).toBe(`${at} → 200`);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("etag")).toBe(root.headers.get("etag"));
      expect(r.text).toBe(root.text);
    }
    /* the API of the same name is under /api/* and was matched long before */
    const api = await srv.get("/api/settings");
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("json");
  }, 20000);

  test("a path needing percent-encoding round-trips through the URL", async () => {
    const odd = "journal/a b & c%.md";
    expect((await srv.api("POST", "/api/docs", { path: odd, type: "doc", markdown: "# odd\n\nhello\n" })).status).toBe(
      201
    );
    try {
      await boot(dUrl(odd));
      expect(await shown()).toBe(odd);
      expect(await urlPath()).toBe(dUrl(odd));
      expect(decodeURIComponent(await urlPath())).toBe("/d/" + odd);
    } finally {
      await srv.api("DELETE", "/api/docs/" + enc(odd));
    }
  }, 40000);
});

/* ---------------- back / forward ---------------- */

describe("routing — BACK and FORWARD walk the docs", () => {
  test("A → B → C, back, back lands on A, forward returns to B", async () => {
    await boot("/"); // A
    await clickDoc(B);
    await clickDoc(C);
    expect(await urlPath()).toBe(dUrl(C));

    await backTo(B);
    await backTo(A);
    expect(await shown()).toBe(A);

    await forward();
    await settled(B);
    expect(await shown()).toBe(B);
  }, 60000);

  test("re-opening the doc already on screen adds no entry, and one BACK still leaves it", async () => {
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    await clickDoc(B);
    await clickDoc(B);
    expect(await histLen()).toBe(len);
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);

  test("a navigation that 404s leaves no entry, no URL change and no broken shell", async () => {
    await boot("/");
    const len = await histLen();
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.url().includes("/api/docs/projects/homelab")) r.respond({ status: 404, contentType: "application/json", body: '{"error":"not-found","message":"gone"}' });
      else r.continue();
    });
    await page.click(`#tree .row.file[data-doc="${C}"]`);
    await sleep(700);
    expect(await shown()).toBe(A);
    expect(await urlPath()).toBe(dUrl(A));
    expect(await histLen()).toBe(len);
  }, 40000);

  test("a [[wiki-link]] click pushes an entry that BACK undoes", async () => {
    await boot("/"); // A = event-pipeline, which carries [[z-notes-design]]
    await page.click('#doc .wl[data-link="z-notes-design"]');
    await settled(B);
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);

  test("a ⌘K pick costs ONE entry — the overlay marker is recycled, not stacked", async () => {
    await boot("/");
    expect(await histLen()).toBe(BASE_LEN);
    await palPick("homelab", "homelab.md");
    await settled(C);
    expect(await histLen()).toBe(BASE_LEN + 1);
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);
});

/* ---------------- deep links / reload ---------------- */

describe("routing — deep links and reloads", () => {
  test("a pasted URL opens that nested doc and highlights it in the tree", async () => {
    await boot(dUrl(C));
    expect(await shown()).toBe(C);
    const row = await page.evaluate((p) => {
      const r = document.querySelector<HTMLElement>(`#tree .row.file[data-doc="${p}"]`);
      return { active: !!r && r.classList.contains("active"), visible: !!r && r.offsetParent !== null };
    }, C);
    expect(row).toEqual({ active: true, visible: true });
  }, 30000);

  test("navigating into a COLLAPSED folder reveals the row instead of hiding the open doc", async () => {
    await boot("/");
    await page.evaluate(() => {
      for (const r of [...document.querySelectorAll<HTMLElement>("#tree .row.folder")])
        if (r.classList.contains("open")) r.click();
    });
    expect(
      await page.evaluate((p) => document.querySelector<HTMLElement>(`#tree .row.file[data-doc="${p}"]`)!.offsetParent !== null, C)
    ).toBe(false);

    await palPick("homelab", "homelab.md");
    await settled(C);
    const row = await page.evaluate((p) => {
      const r = document.querySelector<HTMLElement>(`#tree .row.file[data-doc="${p}"]`);
      return { active: !!r && r.classList.contains("active"), visible: !!r && r.offsetParent !== null };
    }, C);
    expect(row).toEqual({ active: true, visible: true });
  }, 60000);

  test("a hard reload keeps the doc rather than falling back to the first one", async () => {
    await boot("/");
    await clickDoc(C);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await settled(C);
    expect(await shown()).toBe(C);
  }, 60000);

  test("?theme= survives boot, navigation and a reload — the affordance Settings advertises", async () => {
    /* REGRESSION. `docUrl` dropped the query, and boot ends in a replaceState,
       so the theme Settings › Theme tells you to try (`Try ?theme=terminal
       too.`) lasted exactly one page load: the address bar was rewritten to a
       bare /d/<path> and a reload came back Modern. */
    const themeOf = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await boot("/?theme=terminal");
    expect(`theme at boot: ${await themeOf()}`).toBe("theme at boot: terminal");
    expect(`query kept at boot: ${await page.evaluate(() => location.search)}`).toBe(
      "query kept at boot: ?theme=terminal"
    );

    await clickDoc(C);
    expect(`query kept across a navigation: ${await page.evaluate(() => location.search)}`).toBe(
      "query kept across a navigation: ?theme=terminal"
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await settled(C);
    expect(`theme after a reload: ${await themeOf()}`).toBe("theme after a reload: terminal");
  }, 60000);

  test("?theme= also survives a Settings visit that touches an UNRELATED appearance control", async () => {
    /* REGRESSION. `applyLook` re-applied all three appearance axes whenever ANY
       one of them was drafted, and an undrafted axis falls through to the
       STORED value — so previewing a density stamped the stored theme over the
       `?theme=` override on the very first click, with no way back short of
       reloading with the query string. The axes are applied one by one now:
       one that was never drafted needs neither previewing nor restoring. */
    const look = () =>
      page.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        density: document.documentElement.getAttribute("data-density"),
      }));

    await boot("/?theme=terminal");
    expect(`the override is on: ${JSON.stringify(await look())}`).toBe(
      `the override is on: ${JSON.stringify({ theme: "terminal", density: DEFAULTS.density })}`
    );

    await chord("Comma");
    await waitForSettings(page, true);
    expect(`arriving on Settings changes nothing: ${JSON.stringify(await look())}`).toBe(
      `arriving on Settings changes nothing: ${JSON.stringify({ theme: "terminal", density: DEFAULTS.density })}`
    );

    /* the OTHER axis — density previews, and the theme must not move with it */
    await page.click('#densitySeg button[data-v="compact"]');
    await sleep(150);
    expect(`after previewing a density: ${JSON.stringify(await look())}`).toBe(
      `after previewing a density: ${JSON.stringify({ theme: "terminal", density: "compact" })}`
    );

    /* leaving reverts the density draft's preview and still leaves the theme alone */
    await back();
    await waitForSettings(page, false);
    expect(`and after leaving: ${JSON.stringify(await look())}`).toBe(
      `and after leaving: ${JSON.stringify({ theme: "terminal", density: DEFAULTS.density })}`
    );
  }, 60000);

  test("a deep link to a path that does not exist falls back to a real doc and says so", async () => {
    await boot("/d/nope/gone.md");
    const view = await page.evaluate(() => ({
      path: document.getElementById("stPath")!.textContent,
      docLen: (document.getElementById("doc")!.textContent ?? "").length,
      toast: document.getElementById("toastTxt")!.textContent,
    }));
    expect(view.path).toBe(A);
    expect(view.docLen).toBeGreaterThan(40);
    expect(view.toast).toContain("nope/gone.md");
    expect(await urlPath()).toBe(dUrl(A));
  }, 30000);

  test("assets, the worker and the API still resolve when the shell came from a nested /d/ URL", async () => {
    const bad: string[] = [];
    /* /api/vault/{identity,recipient} 404 by design in a vault with no keyring
       (SPEC §6) — the client feature-detects on them. Everything else is a bug. */
    const expected404 = (u: string) => u.includes("/api/vault/");
    page.on("requestfailed", (r) => bad.push("FAILED " + r.url()));
    page.on("response", (r) => {
      if (r.status() >= 400 && !expected404(r.url())) bad.push(r.status() + " " + r.url());
    });
    await boot(dUrl(C));
    await page.waitForFunction(() => document.getElementById("stConnTxt")!.textContent === "connected", {
      timeout: 20000,
    });
    const hrefs = await page.evaluate(() => ({
      theme: new URL((document.getElementById("theme-css") as HTMLLinkElement).href).pathname,
      base: document.querySelector("base")!.getAttribute("href"),
    }));
    expect(hrefs).toEqual({ theme: "/themes/" + DEFAULTS.theme + ".css", base: "/" });
    expect(bad).toEqual([]);
  }, 60000);
});

/* ---------------- view state ---------------- */

describe("routing — editor MODE is view state, not navigation", () => {
  test("⌘E five times adds no entries and BACK still lands on the previous DOC", async () => {
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    for (let i = 0; i < 5; i++) {
      await chord("KeyE");
      await sleep(120);
    }
    expect(await histLen()).toBe(len);
    expect(await urlPath()).toBe(dUrl(B));
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);
});

/* ---------------- settings is a PLACE, not an overlay ---------------- */

/* on the settings page? the shared predicate — see tests/browser.ts */
const onSettings = () => isOnSettings(page);
const waitSettings = (want: boolean) => waitForSettings(page, want);
/** the group the page was opened AT flashes; that class is the only evidence */
const focusedGrp = () =>
  page.evaluate(() => document.querySelector(".sv-wrap .grp.focused")?.id ?? "(none)");

describe("routing — Settings is a page at /settings", () => {
  test("⌘, navigates to /settings, and BACK returns to the doc / FORWARD comes back", async () => {
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    await chord("Comma");
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings");
    expect(await histLen()).toBe(len + 1); // a real entry, not a marker

    await back();
    await waitSettings(false);
    expect(await shown()).toBe(B);
    expect(await urlPath()).toBe(dUrl(B));

    await forward();
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings");
  }, 60000);

  test("the sidebar row is the entry point, and it marks itself current", async () => {
    await boot("/");
    expect(await page.$eval("#settingsLink", (n) => n.className)).not.toContain("on");
    await page.click("#settingsLink");
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings");
    expect(await page.$eval("#settingsLink", (n) => n.className)).toContain("on");
    expect(await page.$eval("#settingsLink", (n) => n.getAttribute("aria-current"))).toBe("page");
    /* and the topbar gear it replaced is gone — one entry point, not two */
    expect(await page.$$eval("[data-act='settings']", (ns) => ns.length)).toBe(1);
  }, 60000);

  test("/settings/<section> is deep-linkable and survives a reload", async () => {
    await boot("/settings/ai");
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings/ai");
    await waitUntil(async () => (await focusedGrp()) === "settingsGrp-ai", { timeout: 6000 });
    /* the doc is open BEHIND the page, so leaving has somewhere to go */
    expect(await shown()).toBe(A);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings/ai");
  }, 60000);

  test("an unknown section degrades to the top of the page instead of 404ing", async () => {
    await boot("/settings/not-a-section");
    await waitSettings(true);
    expect(await focusedGrp()).toBe("(none)");
  }, 60000);

  test("the section rail rewrites the URL without stacking one entry per click", async () => {
    await boot("/");
    await chord("Comma");
    await waitSettings(true);
    const len = await histLen();
    for (const sec of ["editing", "trash", "git", "secrets", "terminal"]) {
      await page.click(`#settingsNav button[data-sec="${sec}"]`);
      await page.waitForFunction((s) => location.pathname === "/settings/" + s, { timeout: 4000 }, sec);
    }
    expect(await histLen()).toBe(len); // four clicks, zero new entries
    await back();
    await waitSettings(false);
    expect(await shown()).toBe(A); // ONE back leaves Settings, not four
  }, 60000);

  test("Done spends the entry the arrival pushed — the stack ends where it started", async () => {
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    await chord("Comma");
    await waitSettings(true);
    await page.click("#settingsView [data-act='close-settings']");
    await waitSettings(false);
    expect(await shown()).toBe(B);
    expect(await urlPath()).toBe(dUrl(B));
    expect(await histLen()).toBe(len + 1); // the settings entry is still ahead, for FORWARD
  }, 60000);

  test("Done still takes ONE press when an overlay left a spent marker above the page", async () => {
    /* ⌘K over the page pushes a dismissal marker; Esc closes the palette and
       leaves the marker behind. Done then walks back onto the settings entry it
       already came from — which must be spent like any other duplicate, not
       painted again and counted as the press. */
    await boot("/");
    await clickDoc(B);
    await chord("Comma");
    await waitSettings(true);
    await chord("KeyK");
    await waitVeil("palVeil", true);
    await page.keyboard.press("Escape");
    await waitVeil("palVeil", false);
    expect(await onSettings()).toBe(true);

    await page.click("#settingsView [data-act='close-settings']");
    await waitSettings(false);
    expect(`one press landed on: ${await shown()}`).toBe(`one press landed on: ${B}`);
    expect(await urlPath()).toBe(dUrl(B));
  }, 60000);

  test("Done still takes ONE press after a rail click recycled a spent marker", async () => {
    /* The marker Esc left behind is CONVERTED into a settings entry by the next
       rail click, so the page now owns two adjacent entries. Done must still
       cost one press and one stack, not leave the user standing on Settings
       needing two more Backs — and FORWARD must still come back here. */
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    await chord("Comma");
    await waitSettings(true);
    await chord("KeyK");
    await waitVeil("palVeil", true);
    await page.keyboard.press("Escape");
    await waitVeil("palVeil", false);
    await page.click(`#settingsNav button[data-sec="git"]`);
    await page.waitForFunction(() => location.pathname === "/settings/git", { timeout: 4000 });

    await page.click("#settingsView [data-act='close-settings']");
    await waitSettings(false);
    expect(`one press landed on: ${await shown()}`).toBe(`one press landed on: ${B}`);
    expect(await urlPath()).toBe(dUrl(B));
    /* the doc entry is the one it started on: Done spent entries, it did not
       stack a fresh one on top of the settings page */
    expect(`entries added by the whole round trip: ${(await histLen()) - len}`).toBe(
      "entries added by the whole round trip: 2"
    );
    await forward();
    await waitSettings(true);
  }, 60000);

  test("Done on a DEEP-LINKED settings entry reached by Back stays inside the app", async () => {
    /* `/settings` is a link somebody else can follow, so it can be the BOTTOM
       of our stack. Walking back onto that entry and pressing Done must not
       `history.back()` past it: below it is another site, and the tab would
       leave the app with the unlocked vault, the terminal session and every
       revealed block still in memory. */
    await boot("/settings");
    await waitSettings(true);
    await clickDoc(B); // pushes a doc entry over the bottom settings entry
    await chord("Comma"); // …and a second settings entry over that
    await waitSettings(true);
    await back();
    await waitSettings(false);
    await back(); // back onto the settings entry the browser handed us
    await waitSettings(true);

    await page.click("#settingsView [data-act='close-settings']");
    await waitSettings(false);
    expect(`still in the app: ${await page.evaluate(() => !!document.getElementById("app"))}`).toBe(
      "still in the app: true"
    );
    expect(await urlPath()).toBe(dUrl(B));
  }, 60000);

  test("Done on a settings entry reached by Back spends the FORWARD entry, truncating nothing", async () => {
    await boot("/settings");
    await waitSettings(true);
    await clickDoc(B);
    await clickDoc(C);
    const len = await histLen();
    await back();
    await settled(B);
    await back();
    await waitSettings(true);
    expect(await histLen()).toBe(len); // walking back spends nothing

    await page.click("#settingsView [data-act='close-settings']");
    await waitSettings(false);
    expect(`Done landed on: ${await shown()}`).toBe(`Done landed on: ${B}`);
    expect(`entries after Done: ${await histLen()}`).toBe(`entries after Done: ${len}`);
    /* the entry Done did NOT spend a push on is still ahead */
    await forward();
    await settled(C);
  }, 60000);

  test("opening a doc from the settings page leaves it, and Back returns to Settings", async () => {
    await boot("/");
    await chord("Comma");
    await waitSettings(true);
    await clickDoc(C);
    expect(await onSettings()).toBe(false);
    await back();
    await waitSettings(true);
    expect(await urlPath()).toBe("/settings");
  }, 60000);

  test("Esc on the settings page is not a dismissal — it is a page, and it stays", async () => {
    await boot("/");
    await chord("Comma");
    await waitSettings(true);
    await page.keyboard.press("Escape");
    await sleep(400);
    expect(await onSettings()).toBe(true);
    expect(await urlPath()).toBe("/settings");
  }, 60000);

  test("⌘, with an overlay already open never strands the URL on the wrong page", async () => {
    /* The overlay owns the current entry (its dismissal marker), so arriving at
       Settings re-homes that marker onto `/settings` rather than stacking a
       second one — and walking back out of it must put the address bar back on
       the doc, in BOTH directions. */
    await boot("/");
    await clickDoc(B);
    await pressHelp();
    await waitVeil("scVeil", true);
    const len = await histLen();

    await chord("Comma");
    await waitSettings(true);
    expect(`no second entry: ${(await histLen()) - len}`).toBe("no second entry: 0");
    expect(await urlPath()).toBe("/settings");

    await page.keyboard.press("Escape"); // the overlay goes; the page stays
    await waitVeil("scVeil", false);
    expect(await onSettings()).toBe(true);

    await back();
    await waitSettings(false);
    expect(`pane after BACK: ${await shown()}`).toBe(`pane after BACK: ${B}`);
    expect(`url after BACK: ${await urlPath()}`).toBe(`url after BACK: ${dUrl(B)}`);

    await forward(); // onto the spent marker, whose URL said /settings
    await sleep(600);
    expect(`pane after FORWARD: ${await shown()}`).toBe(`pane after FORWARD: ${B}`);
    expect(`url after FORWARD: ${await urlPath()}`).toBe(`url after FORWARD: ${dUrl(B)}`);
    expect(await onSettings()).toBe(false);
  }, 60000);

  test("⌘K over the settings page still works, and the pick leaves it", async () => {
    await boot("/");
    await chord("Comma");
    await waitSettings(true);
    await palPick("homelab", "homelab.md");
    await settled(C);
    expect(await onSettings()).toBe(false);
    expect(await urlPath()).toBe(dUrl(C));
  }, 60000);
});

/* ---------------- overlays ---------------- */

describe("routing — an open overlay swallows exactly one BACK", () => {
  test("BACK with the ⌘K palette open closes it and stays on the doc", async () => {
    await boot("/");
    await clickDoc(B);
    await chord("KeyK");
    await waitVeil("palVeil", true);
    await back();
    await waitVeil("palVeil", false);
    expect(await shown()).toBe(B);
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);

  test("BACK with the shortcuts overlay open closes it", async () => {
    await boot("/");
    await clickDoc(B);
    await page.keyboard.down("Shift"); // "?" is shift+/
    await page.keyboard.press("Slash");
    await page.keyboard.up("Shift");
    await waitVeil("scVeil", true);
    await back();
    await waitVeil("scVeil", false);
    expect(await shown()).toBe(B);
  }, 60000);

  test("Esc still closes an overlay, and the BACK after it is a doc BACK, not a wasted press", async () => {
    await boot("/");
    await clickDoc(B);
    await pressHelp();
    await waitVeil("scVeil", true);
    await page.keyboard.press("Escape");
    await waitVeil("scVeil", false);
    expect(await shown()).toBe(B);
    await backTo(A); // the spent marker must be skipped, not consume the press
    expect(await shown()).toBe(A);
  }, 60000);

  test("opening and Esc-ing an overlay five times costs ONE entry, not five", async () => {
    await boot("/");
    await clickDoc(B);
    const len = await histLen();
    for (let i = 0; i < 5; i++) {
      await pressHelp();
      await waitVeil("scVeil", true);
      await page.keyboard.press("Escape");
      await waitVeil("scVeil", false);
    }
    expect(await histLen()).toBe(len + 1); // the single marker, reused
    await backTo(A);
    expect(await shown()).toBe(A);
  }, 60000);

  test("FORWARD onto a spent marker is inert — no loop, no navigation, no crash", async () => {
    await boot("/");
    await clickDoc(B);
    await pressHelp();
    await waitVeil("scVeil", true);
    await page.keyboard.press("Escape");
    await waitVeil("scVeil", false);
    await backTo(A);
    await forward();
    await settled(B);
    await forward(); // onto the spent marker
    await sleep(600);
    expect(await shown()).toBe(B);
    expect(await urlPath()).toBe(dUrl(B));
    expect(await veilUp("scVeil")).toBe(false);
  }, 60000);

  test("a confirm raised FROM the settings page unwinds one BACK at a time", async () => {
    /* Settings is a page now, so the tree behind it is genuinely clickable and
       a row action really can raise a modal from it. The marker still belongs to
       the confirm alone: the first BACK spends it, the second leaves the PAGE. */
    await boot("/");
    await chord("Comma");
    await waitSettings(true);
    await rowAct("Delete homelab.md");
    await waitVeil("cfVeil", true);

    await back();
    await waitVeil("cfVeil", false);
    expect(await onSettings()).toBe(true);
    expect(await urlPath()).toBe("/settings");

    await back();
    await waitSettings(false);
    expect(await shown()).toBe(A);
    expect(await urlPath()).toBe(dUrl(A));
    /* nothing was deleted */
    expect((await srv.doc(C)).status).toBe(200);
  }, 60000);

  test("navigating from INSIDE an open overlay never leaves the URL naming another doc", async () => {
    /* REGRESSION. `routeDoc` recycled the overlay's history marker whenever the
       current entry was one, on the assumption that a navigation always closes
       the overlay that pushed it. ⌘K is not blocked while another overlay is up
       and `closePal()` closes only the palette, so a ⌘K pick over one replaced
       the marker with a doc entry while that overlay was still up and
       marker-less. The next BACK then hit the dismissal branch on an entry the
       browser had ALREADY traversed away from: it closed the overlay and
       returned without repainting, leaving `location.pathname` on one doc and
       the pane on another — wrong for reload, wrong for copy-link, wrong for
       every further BACK. (Driven through the shortcuts overlay: Settings, the
       original vehicle, is a page now and closes on a navigation.) */
    await boot("/");
    await clickDoc(B);
    await pressHelp();
    await waitVeil("scVeil", true);

    await palPick("homelab", "homelab.md");
    await settled(C);
    expect(await veilUp("scVeil")).toBe(true); // ⌘K does not close what it opened over

    await back();
    await waitVeil("scVeil", false); // the marker is still there to spend
    expect(`pane: ${await shown()}`).toBe(`pane: ${C}`);
    expect(`url: ${await urlPath()}`).toBe(`url: ${dUrl(C)}`);

    /* and the app is not stranded: it still navigates afterwards */
    await clickDoc(B);
    expect(await urlPath()).toBe(dUrl(B));
  }, 60000);

  test("a doc re-homed under an open overlay keeps the URL and the pane together", async () => {
    /* the same shape without ⌘K: anything that calls openDoc(…, {replace:true})
       while a veil is up — the SSE `moved` echo, accept/revertProposal — used to
       spend the marker the same way. Driven here through a real rename issued by
       another client, which the server echoes over SSE. */
    const renamed = "projects/homelab-moved.md";
    await boot("/");
    await clickDoc(C);
    await pressHelp();
    await waitVeil("scVeil", true);

    const r = await srv.api("PATCH", "/api/docs/" + enc(C), { to: renamed });
    expect(`the move → ${r.status}`).toBe("the move → 200");
    try {
      await settled(renamed);
      expect(await veilUp("scVeil")).toBe(true);

      await back();
      await waitVeil("scVeil", false);
      expect(`pane after BACK: ${await shown()}`).toBe(`pane after BACK: ${renamed}`);
      expect(`url after BACK: ${await urlPath()}`).toBe(`url after BACK: ${dUrl(renamed)}`);
    } finally {
      await srv.api("PATCH", "/api/docs/" + enc(renamed), { to: C });
    }
  }, 60000);
});

/* ---------------- the URL follows the doc; edits are never dropped ---------------- */

describe("routing — renames and dirty buffers", () => {
  test("a rename while the doc is open leaves the URL on the NEW path, and that URL reloads", async () => {
    const renamed = "projects/homelab-renamed.md";
    await boot("/");
    await clickDoc(C);
    await rowAct("Rename or move homelab.md");
    await page.waitForSelector("#tree .newrow.renaming input", { timeout: 6000 });
    await sleep(120); // the row focuses itself on a 20ms timer
    await page.$eval("#tree .newrow.renaming input", (el, v) => ((el as HTMLInputElement).value = v as string), renamed);
    await page.keyboard.press("Enter");
    await settled(renamed);
    expect(await urlPath()).toBe(dUrl(renamed));

    try {
      /* the rename REPLACED its entry: BACK must not return to a 404 */
      await backTo(A);
      expect(await shown()).toBe(A);

      /* and the new URL survives a cold load in a fresh page */
      const p2 = await browser.newPage();
      try {
        await p2.goto(srv.base + dUrl(renamed), { waitUntil: "domcontentloaded" });
        await p2.waitForSelector("#app:not([hidden])", { timeout: 20000 });
        await p2.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, renamed);
        expect(await p2.evaluate(() => document.getElementById("stPath")!.textContent)).toBe(renamed);
      } finally {
        await p2.close().catch(() => {});
      }
    } finally {
      await srv.api("PATCH", "/api/docs/" + enc(renamed), { path: C });
    }
  }, 90000);

  test("BACK with a dirty buffer waits for confirmation, then Save & exit writes before navigating", async () => {
    await boot("/");
    await clickDoc(B);
    await chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 6000 });
    await page.click("#rawArea");
    await page.keyboard.down("Meta");
    await page.keyboard.press("ArrowDown"); // end of the textarea
    await page.keyboard.up("Meta");
    await page.keyboard.type("\nROUTING-DIRTY-MARKER\n");
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent !== "Saved", { timeout: 6000 });

    await back();
    await waitVeil("xgVeil", true);
    expect(await shown()).toBe(B);
    expect(await urlPath()).toBe(dUrl(B));
    expect(readVaultText(srv.vault, B)).not.toContain("ROUTING-DIRTY-MARKER");

    await page.click('#xgVeil [data-act="xg-save"]');
    await waitVeil("xgVeil", false);
    await settled(A);
    await waitUntil(() => readVaultText(srv.vault, B).includes("ROUTING-DIRTY-MARKER"), {
      timeout: 10000,
      label: "Save & exit to write the dirty buffer before replaying BACK",
    });
    expect(readVaultText(srv.vault, B)).toContain("ROUTING-DIRTY-MARKER");
    /* and FORWARD brings the text back — the raw buffer still carries it */
    await forward();
    await settled(B);
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 6000 });
    expect(await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value)).toContain("ROUTING-DIRTY-MARKER");
  }, 90000);
});
