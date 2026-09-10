/* ============================================================
   zoom-e2e.test.ts — the pinch is the app's now, and it steps TEXT (spec 0013).

   Six claims, each measured on the thing that actually moves rather than on a
   class or a stored string:

     · A two-finger spread over the document pane walks the ladder UP one rung
       per 25 % of finger travel, and `#doc`'s computed font-size is the
       theme's `--d-font` times that rung — not "a bigger number".
     · A pinch IN walks it down and STOPS at the bottom rung. A ladder with no
       floor is how a note ends up at 4px with no gesture that reaches back.
     · A reload paints at the remembered size, and the value is on `<html>`
       before the app has booted — the pre-paint script in index.html, not
       `initZoom()`, which runs two network round trips later.
     · The BROWSER's own zoom is off: the viewport meta says so and the root
       element's `touch-action` says so. Both, because either one alone leaves
       a browser that honours the other still fighting the app for the gesture.
     · `set_text_zoom` is the same choice without a hand (ADR 0031), and an
       off-ladder percent comes back as data in the API's error shape.
     · Raw is zoomed exactly as Preview is — the parity ADR 0032 buys by making
       the source a line editor rather than a textarea.

   Touch is dispatched over CDP: puppeteer's mouse cannot produce a second
   finger. Prior art for the transport is tests/mobile-e2e.test.ts.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { callTool, ensureMode, launchTestBrowser, newAppPage, waitForApp } from "./browser";

const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };

const SEED: SeedMap = {
  "note.md": "# Zoom\n\nA paragraph long enough to be worth making bigger.\n\n```js\nconst a = 1;\n```\n",
};

let srv: TestServer;
let browser: Browser;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/**
 * A phone page with a real touch screen. `localStorage` is per ORIGIN, so the
 * harness's default reset is what stops each test inheriting the rung the last
 * one pinched to; only the persistence case asks for `resume`, because the
 * reset would also wipe the store across the reload it measures.
 */
async function phone(opts: { resume?: boolean } = {}): Promise<Page> {
  const page = await newAppPage(browser, {
    width: PHONE.width,
    height: PHONE.height,
    onPageError: (m) => pageErrors.push(m),
    resume: opts.resume,
  });
  await page.setViewport(PHONE);
  await load(page);
  return page;
}

/** …and the navigation on its own, for the test that reloads twice. */
async function load(page: Page): Promise<void> {
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForSelector("#doc .md", { timeout: 15000 });
}

/** The multiplier the app published on `<html>`. */
const zoom = (p: Page) => p.evaluate(() => document.documentElement.style.getPropertyValue("--doc-zoom"));

/** The document's rendered text size, and the theme size it is a multiple of. */
const docSize = (p: Page) =>
  p.evaluate(() => ({
    doc: parseFloat(getComputedStyle(document.getElementById("doc")!).fontSize),
    base: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--d-font")),
  }));

/**
 * A two-finger gesture over the document pane. The first span is how far apart
 * the fingers land; every span after it is a move to that separation, which is
 * what lets one gesture take several rungs the way a real slow pinch does.
 */
async function pinch(p: Page, ...spans: number[]): Promise<void> {
  const c = await p.evaluate(() => {
    const r = document.getElementById("scroll")!.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const points = (d: number) => [
    { x: c.x - d / 2, y: c.y, id: 1 },
    { x: c.x + d / 2, y: c.y, id: 2 },
  ];
  const cdp = await p.createCDPSession();
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(spans[0]) });
    for (const d of spans.slice(1)) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(d) });
      await sleep(40);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
  await sleep(80);
}

/** the rendered size is the rung times the theme's body size, to within a
    subpixel — the whole claim is that it is MEASURED, not merely stored */
function expectRendered(size: { doc: number; base: number }, rung: number, label: string) {
  const want = size.base * rung;
  expect(`${label}: #doc ${size.doc}px is ${want.toFixed(2)}px ± 0.1 — ${Math.abs(size.doc - want) <= 0.1}`).toBe(
    `${label}: #doc ${size.doc}px is ${want.toFixed(2)}px ± 0.1 — true`
  );
}

/* ------------------------------------------------------------------
   1 — a spread steps up
   ------------------------------------------------------------------ */

describe("pinch out — the text steps up the ladder", () => {
  test("every spread past 25 % buys a rung, and a twitch buys none", async () => {
    const p = await phone();
    expect(`before the gesture: ${await zoom(p)}`).toBe("before the gesture: 1");

    await pinch(p, 80, 120);
    expect(`after one spread: ${await zoom(p)}`).toBe("after one spread: 1.15");
    expectRendered(await docSize(p), 1.15, "at 115 %");

    await pinch(p, 80, 120);
    expect(`after a second spread: ${await zoom(p)}`).toBe("after a second spread: 1.3");
    expectRendered(await docSize(p), 1.3, "at 130 %");

    /* a twitch is not a gesture: under 25 % moves nothing */
    await pinch(p, 100, 115);
    expect(`after a 15 % spread: ${await zoom(p)}`).toBe("after a 15 % spread: 1.3");

    expect(`page errors: ${JSON.stringify(pageErrors)}`).toBe("page errors: []");
  }, 90000);
});

/* ------------------------------------------------------------------
   2 — a pinch steps down, and the ladder has a floor
   ------------------------------------------------------------------ */

describe("pinch in — the text steps down, and stops", () => {
  test("20 % of travel is one rung down; the bottom rung is the bottom", async () => {
    const p = await phone();

    await pinch(p, 200, 140);
    expect(`after one pinch in: ${await zoom(p)}`).toBe("after one pinch in: 0.85");
    expectRendered(await docSize(p), 0.85, "at 85 %");

    /* six more rungs' worth of travel with only one rung below: the ladder
       must absorb it rather than run off the end into an unreadable size */
    await pinch(p, 300, 200, 140, 100, 70);
    expect(`after pinching past the floor: ${await zoom(p)}`).toBe("after pinching past the floor: 0.85");
    expectRendered(await docSize(p), 0.85, "still at 85 %");
  }, 90000);
});

/* ------------------------------------------------------------------
   3 — it survives a reload, without a flash of the old size
   ------------------------------------------------------------------ */

describe("the rung is remembered", () => {
  test("a reload has --doc-zoom on <html> before the app boots", async () => {
    /* the one page here that keeps the store across its own reload, so the rung
       the previous test left is cleared by hand and the clean state reached
       with a navigation instead */
    const p = await phone({ resume: true });
    await p.evaluate(() => {
      try {
        localStorage.removeItem("znotes.zoom");
      } catch {}
    });
    await load(p);
    expect(`a browser that has never zoomed: ${await zoom(p)}`).toBe("a browser that has never zoomed: 1");

    await pinch(p, 80, 120, 180);
    expect(`before the reload: ${await zoom(p)}`).toBe("before the reload: 1.3");

    await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
    /* read at DOMContentLoaded: `initZoom()` runs deep inside `start()`, behind
       the settings and tree round trips, so anything on <html> at this instant
       was put there by the pre-paint script in index.html */
    const early = await p.evaluate(() => ({
      zoom: document.documentElement.style.getPropertyValue("--doc-zoom"),
      booted: !(document.getElementById("app") as HTMLElement).hidden,
    }));
    expect(`at DOMContentLoaded — zoom ${early.zoom}, app booted ${early.booted}`).toBe(
      "at DOMContentLoaded — zoom 1.3, app booted false"
    );

    await waitForApp(p);
    await p.waitForSelector("#doc .md", { timeout: 15000 });
    expect(`after boot: ${await zoom(p)}`).toBe("after boot: 1.3");
    expectRendered(await docSize(p), 1.3, "after the reload");
  }, 90000);
});

/* ------------------------------------------------------------------
   4 — the browser's own zoom is switched off
   ------------------------------------------------------------------ */

describe("the browser does not zoom the layout", () => {
  test("the viewport meta pins the scale and the root refuses a pinch", async () => {
    const p = await phone();
    const seen = await p.evaluate(() => ({
      meta: document.querySelector("meta[name=viewport]")!.getAttribute("content")!,
      root: getComputedStyle(document.documentElement).touchAction,
      scroll: getComputedStyle(document.getElementById("scroll")!).touchAction,
    }));
    expect(`viewport meta pins the scale: ${seen.meta.includes("maximum-scale=1")}`).toBe(
      "viewport meta pins the scale: true"
    );
    expect(`viewport meta forbids user scaling: ${seen.meta.includes("user-scalable=no")}`).toBe(
      "viewport meta forbids user scaling: true"
    );
    expect(`touch-action — html ${seen.root}, #scroll ${seen.scroll}`).toBe(
      "touch-action — html pan-x pan-y, #scroll pan-x pan-y"
    );
  }, 90000);
});

/* ------------------------------------------------------------------
   5 — the same choice, without a hand
   ------------------------------------------------------------------ */

describe("set_text_zoom", () => {
  test("takes a percent off the ladder and refuses anything else as data", async () => {
    const p = await phone();

    const ok = await callTool(p, "set_text_zoom", { percent: 150 });
    expect(`set_text_zoom(150) → ${JSON.stringify(ok)}`).toBe('set_text_zoom(150) → {"percent":150}');
    expect(`--doc-zoom after the tool: ${await zoom(p)}`).toBe("--doc-zoom after the tool: 1.5");
    expectRendered(await docSize(p), 1.5, "at 150 %");

    const bad = await callTool(p, "set_text_zoom", { percent: 140 });
    expect(`set_text_zoom(140) → ${JSON.stringify(bad)}`).toBe(
      `set_text_zoom(140) → ${JSON.stringify({
        error: "invalid-arg",
        message: "percent must be one of 85, 100, 115, 130, 150, 175, 200",
      })}`
    );
    expect(`the refusal moved nothing: ${await zoom(p)}`).toBe("the refusal moved nothing: 1.5");

    /* the app's own state answers with the percent, not the multiplier */
    const state = await callTool(p, "get_app_state");
    expect(`get_app_state.textZoom: ${state.textZoom}`).toBe("get_app_state.textZoom: 150");
  }, 90000);
});

/* ------------------------------------------------------------------
   6 — Raw is zoomed exactly as Preview is (spec 0014's parity)
   ------------------------------------------------------------------ */

describe("Raw at zoom", () => {
  test("the source reads at the size the preview does", async () => {
    const p = await phone();
    await pinch(p, 80, 120);

    const prose = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#doc .md p")!).fontSize));
    await ensureMode(p, "raw", { settle: 200 });
    const raw = await p.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById("rawArea")!).fontSize)
    );
    expect(`Raw ${raw}px = Preview ${prose}px`).toBe(`Raw ${prose}px = Preview ${prose}px`);
  }, 90000);
});
