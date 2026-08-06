/* ============================================================
   INTEGRATION — the seams between routing, settings and the AI status item.

   Three pieces of work landed on the same files at once: URL routing (`/d/…`
   plus a history entry per open overlay), settings parity (every key settable
   in Settings as well as in settings.toml, applied live), and the AI endpoint
   item in the statusbar. Each was verified on its own. What no single one of
   them could check is what happens where they MEET — and that is where the
   defects were:

     - a settings change that moves the AI status (`ai.effort`) reached
       Settings › AI but never the statusbar, because the broadcast was gated
       on the base URL / model / key triple. Two surfaces the code promises
       cannot disagree, silently disagreeing. Pinned here end-to-end, and at
       the API level in settings.test.ts;
     - opening Settings had three separate implementations (⌘, the toolbar
       button, and the statusbar item's own opener), only one of which knew how
       to scroll to a section. They are one function now, and these tests hold
       every entry point to the SAME behaviour — including the history entry
       the routing work depends on.

   Also here: the live-apply claims that are only true in a browser, because
   the thing that applies them is the crypto worker or the autosave timer, not
   the server. The server can only publish a policy; a test that stops at the
   API has not measured the feature.

   Same driver as e2e.test.ts / routing.test.ts. The upstream is always
   tests/mock-upstream.ts — never a real endpoint, never a real key.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import {
  encPath,
  readVaultText,
  sleep,
  startServer,
  waitUntil,
  SEED_VAULT,
  type TestServer,
} from "./helpers";
import {
  BASE_HISTORY_LEN,
  appDriver,
  launchTestBrowser,
  newAppPage,
  onSettings as isOnSettings,
  saveSettings as sharedSaveSettings,
  waitSettings as waitForSettings,
  type AppDriver,
} from "./browser";
import { reply, startMockUpstream, type MockUpstream } from "./mock-upstream";
import { DEFAULTS, NUMBERS } from "../server/settings";

const KEY = "sk-mock-integration-000000000004321";

/* the doc the app boots into — the tree is alphabetical and `architecture/`
   sorts first, so this is deterministic (same constant routing.test.ts uses) */
const A = "architecture/event-pipeline.md";
const B = "architecture/z-notes-design.md";

const BASE_LEN = BASE_HISTORY_LEN;

let srv: TestServer;
let mock: MockUpstream;
let browser: Browser;
let page: Page;
let ui: AppDriver;

beforeAll(async () => {
  mock = await startMockUpstream();
  mock.setDefault(reply.text("ok"));
  srv = await startServer({ seed: SEED_VAULT });
  const put = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: KEY, model: "gpt-5", effort: "high" },
    /* keep the git auto-sync timer out of the way of the timing assertions */
    git: { autoSync: false, autoSyncSeconds: 600 },
  });
  expect(`configure → ${put.status}`).toBe("configure → 200");
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (mock) await mock.stop();
});

beforeEach(async () => {
  page = await newAppPage(browser, {
    /* Record every message the app sends its crypto worker, BEFORE any app code
       runs. This is how the auto-lock policy is measured without compiling a
       test hook into app.js: the instrumentation lives in the test. */
    beforeLoad: () => {
      (window as any).__workerMsgs = [];
      const orig = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, msg: any, ...rest: any[]) {
        try {
          (window as any).__workerMsgs.push(JSON.parse(JSON.stringify(msg)));
        } catch {}
        return (orig as any).call(this, msg, ...rest);
      };
    },
  });
  ui = appDriver(page, srv.base);
});

afterEach(async () => {
  if (page) await page.close().catch(() => {});
});

/* ---------------- helpers ---------------- */

/* the shared app vocabulary — see tests/browser.ts. `ui` is rebuilt per test
   because `page` is, so these thunks read it at call time. */
const enc = encPath;
const dUrl = (p: string) => "/d/" + enc(p);
const boot = (at?: string) => ui.boot(at);
const shown = () => ui.shown();
const urlPath = () => ui.urlPath();
const histLen = () => ui.histLen();
const back = () => ui.back();
const settled = (p: string) => ui.settled(p);
const clickDoc = (p: string) => ui.clickDoc(p);
const chord = (code: string) => ui.chord(code);
const veilUp = (id: string) => ui.veilUp(id);
const waitVeil = (id: string, want: boolean) => ui.waitVeil(id, want);

/* the shared settings predicate and its wait — see tests/browser.ts */
const onSettings = () => isOnSettings(page);
const waitSettings = (want: boolean) => waitForSettings(page, want);


/**
 * Boot, then navigate to `B` through the tree.
 *
 * Deliberately NOT a deep-link boot: opening the app straight at `/d/B`
 * REPLACES the entry (so BACK leaves the app rather than falling into a bare
 * shell — routing.test.ts pins that), which would leave nothing underneath for
 * these tests to walk back to. Arriving by a click is what puts a real doc
 * entry beneath the overlay marker.
 */
async function bootThenOpenB() {
  await boot();
  expect(`booted on: ${await shown()}`).toBe(`booted on: ${A}`);
  await clickDoc(B);
}

/** the AI chip exactly as a user reads it */
const aiChip = () =>
  page.evaluate(() => {
    const e = document.getElementById("stAi")!;
    return {
      txt: document.getElementById("stAiTxt")!.textContent ?? "",
      state:
        ["ok", "degraded", "unreachable", "unconfigured", "pending"].find((s) =>
          e.className.split(/\s+/).includes(s)
        ) ?? "?",
    };
  });

/** set a `data-num` settings field the way a user does, and let it round-trip */
async function setNumberField(path: string, value: string) {
  await page.evaluate(
    (p, v) => {
      const inp = document.querySelector(`[data-num="${p}"]`) as HTMLInputElement;
      inp.value = v as string;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    },
    path,
    value
  );
}

const readNumberField = (path: string) =>
  page.evaluate((p) => (document.querySelector(`[data-num="${p}"]`) as HTMLInputElement).value, path);

/**
 * Press Save, and wait for the button to go inert again.
 *
 * Settings BUFFER now: a control writes a draft and one PUT carries the lot, so
 * every "changed a setting, now measure the effect" test in this file has to
 * commit the draft first. That is a change in WHEN the value is written, not in
 * what happens when it is — the live-apply claims below (the crypto worker
 * adopts the new policy, the autosave debounce really shortens, the AI chip
 * repaints) are measured exactly as they were, still without a reload.
 *
 * `busy` as well as `disabled`: the button is also disabled WHILE the save is
 * in flight, so waiting on `disabled` alone races the response. That wait now
 * lives in tests/browser.ts, because four other suites had each written their
 * own version of this block and three of them had it wrong in exactly that way.
 * `expectDirty` keeps this file's precondition: every caller here has just
 * changed a control, so a Save that never went live is a failure, not a no-op.
 */
const saveSettings = () => sharedSaveSettings(page, { expectDirty: true });

/** every auto-lock policy the app has pushed at the crypto worker so far.
    The first one rides on `init` (the worker is configured as it is created);
    every later one is a `configure`. Both carry the same `policy` shape, and
    what this measures is the sequence of policies the worker was actually told
    to enforce — which is the only thing that makes the setting real. */
const lockPolicies = () =>
  page.evaluate(() => ((window as any).__workerMsgs as any[]).filter((m) => m && m.policy).map((m) => m.policy));

/** restore whatever this file changed, so the tests stay order-independent */
async function restoreSettings() {
  await srv.api("PUT", "/api/settings", {
    editor: { autosaveSeconds: DEFAULTS.editor.autosaveSeconds },
    secrets: { ...DEFAULTS.secrets },
    ai: { effort: "high", baseUrl: mock.baseUrl, model: "gpt-5" },
  });
}

/* ============================================================
   1. Live-apply that only a browser can prove
   ============================================================ */

describe("settings live-apply — the browser really adopts the new value", () => {
  afterEach(restoreSettings);

  test("the auto-lock policy reaches the real crypto worker mid-session, with no reload", async () => {
    await boot();
    /* the app configures the worker once at init, from the settings it booted
       with — that is the baseline the change has to move */
    await waitUntil(async () => (await lockPolicies()).length > 0, {
      timeout: 20000,
      interval: 150,
      label: "the initial policy to reach the worker",
    });
    const first = (await lockPolicies())[0];
    expect(`policy at boot: ${JSON.stringify(first)}`).toBe(
      `policy at boot: ${JSON.stringify({
        idleMs: DEFAULTS.secrets.idleLockMinutes * 60000,
        hiddenMs: DEFAULTS.secrets.hiddenLockMinutes * 60000,
        hardCapMs: DEFAULTS.secrets.sessionHours * 3600000,
      })}`
    );

    await chord("Comma");
    await waitSettings(true);
    const before = (await lockPolicies()).length;

    await setNumberField("secrets.idleLockMinutes", "2");
    await setNumberField("secrets.hiddenLockMinutes", "1");
    await setNumberField("secrets.sessionHours", "3");
    /* one Save for all three — the policy is pushed at the worker once, from
       what was actually stored, rather than three times from three keystrokes */
    await saveSettings();

    await waitUntil(async () => (await lockPolicies()).length >= before + 1, {
      timeout: 15000,
      interval: 120,
      label: "the changed policy to be pushed at the worker",
    });
    const last = (await lockPolicies()).pop();
    expect(`policy after the change: ${JSON.stringify(last)}`).toBe(
      `policy after the change: ${JSON.stringify({ idleMs: 120000, hiddenMs: 60000, hardCapMs: 10800000 })}`
    );
    /* SAME page, never reloaded — that is the whole claim */
    expect(`without a reload: ${await page.evaluate(() => performance.getEntriesByType("navigation").length)}`).toBe(
      "without a reload: 1"
    );
  }, 90000);

  test("a shortened autosave interval really shortens the wait before bytes hit disk", async () => {
    await boot();
    await chord("Comma");
    await waitSettings(true);
    await setNumberField("editor.autosaveSeconds", "2");
    await saveSettings();
    await waitUntil(async () => (await srv.get("/api/settings")).body.settings.editor.autosaveSeconds === 2, {
      timeout: 8000,
      interval: 100,
      label: "the 2s autosave to be stored",
    });
    await page.evaluate(() => history.back());
    await waitSettings(false);

    /* type into the raw editor and time the write, measured on DISK */
    await chord("KeyE");
    await page.waitForSelector("#rawArea", { visible: true, timeout: 8000 });
    const marker = "autosave-probe-" + Date.now();
    await page.click("#rawArea");
    await page.keyboard.type("\n" + marker + "\n");

    const started = Date.now();
    await waitUntil(async () => readVaultText(srv.vault, A).includes(marker), {
      timeout: 8000,
      interval: 50,
      label: "the autosave to land on disk",
    });
    const took = Date.now() - started;
    /* the default is 10s; this must be nowhere near it. The upper bound is
       generous (scheduling, not the interval, is what varies) but still far
       below the default it replaced. */
    expect(`saved after ${took}ms, well under the 10s default: ${took < 6000}`).toBe(
      `saved after ${took}ms, well under the 10s default: true`
    );
  }, 90000);

  test("a field typed out of range is repainted with what will actually be stored", async () => {
    /* The clamp used to be visible only because the field was repainted from
       the server's ANSWER. A draft has no answer until Save, so the same clamp
       and snap now happen in the control the moment you leave the field — and
       the claim that matters is unchanged and in fact stronger: the field never
       shows a value the server would silently rewrite, at any point. */
    await boot();
    await chord("Comma");
    await waitSettings(true);

    const spec = NUMBERS["secrets.idleLockMinutes"];
    await setNumberField("secrets.idleLockMinutes", String(spec.max + 5000));
    await waitUntil(async () => (await readNumberField("secrets.idleLockMinutes")) === String(spec.max), {
      timeout: 8000,
      interval: 100,
      label: "the field to be clamped to the server-declared maximum",
    });
    expect(`field shows the clamped value: ${await readNumberField("secrets.idleLockMinutes")}`).toBe(
      `field shows the clamped value: ${spec.max}`
    );

    /* off-step snaps too, and the field never keeps a value the server rewrote */
    await setNumberField("secrets.clipboardClearSeconds", "33");
    await waitUntil(async () => (await readNumberField("secrets.clipboardClearSeconds")) === "35", {
      timeout: 8000,
      interval: 100,
      label: "the off-step value to snap",
    });

    /* …and once Saved, what the field shows is exactly what the file carries */
    await saveSettings();
    const stored = (await srv.get("/api/settings")).body.settings.secrets.clipboardClearSeconds;
    expect(`field and server agree: ${await readNumberField("secrets.clipboardClearSeconds")} == ${stored}`).toBe(
      `field and server agree: ${stored} == ${stored}`
    );
    expect(`and the clamp reached the server too: ${(await srv.get("/api/settings")).body.settings.secrets.idleLockMinutes}`).toBe(
      `and the clamp reached the server too: ${spec.max}`
    );
  }, 90000);
});

/* ============================================================
   2. Settings × the AI status item
   ============================================================ */

describe("settings × the AI statusbar item — the two surfaces cannot disagree", () => {
  afterEach(restoreSettings);

  test("changing the reasoning effort in Settings repaints the statusbar chip", async () => {
    /* REGRESSION, end-to-end. The status broadcast fired only when a PUT moved
       ai.baseUrl / ai.model / ai.apiKey, but the derived status also carries
       the effort in use — so this chip kept reading `high` after the user had
       chosen `low`, for the rest of the session. */
    await boot();
    await waitUntil(async () => (await aiChip()).state === "ok", {
      timeout: 25000,
      interval: 150,
      label: "the AI chip to reach ok",
    });
    expect(`chip before: ${(await aiChip()).txt}`).toBe("chip before: gpt-5 · high");

    await chord("Comma");
    await waitSettings(true);
    await page.click("#effortSeg button[data-v='low']");
    await saveSettings();

    await waitUntil(async () => (await aiChip()).txt === "gpt-5 · low", {
      timeout: 15000,
      interval: 150,
      label: "the chip to adopt the new effort",
    });
    expect(`chip after: ${(await aiChip()).txt}`).toBe("chip after: gpt-5 · low");
    /* still a working endpoint — an effort change is not a health change */
    expect(`chip state after: ${(await aiChip()).state}`).toBe("chip state after: ok");

    /* and Settings › AI agrees, because both are painted from one signal */
    const note = await page.evaluate(() => document.getElementById("aiEndpointNote")!.textContent ?? "");
    expect(`the settings note is populated too: ${note.length > 0}`).toBe("the settings note is populated too: true");
  }, 120000);

  test("an unrelated settings change leaves the chip exactly as it was", async () => {
    await boot();
    await waitUntil(async () => (await aiChip()).state === "ok", {
      timeout: 25000,
      interval: 150,
      label: "the AI chip to reach ok",
    });
    const before = await aiChip();

    await chord("Comma");
    await waitSettings(true);
    await page.click("#densitySeg button[data-v='compact']");
    await saveSettings();
    await sleep(1200);

    expect(`chip unchanged: ${JSON.stringify(await aiChip())}`).toBe(`chip unchanged: ${JSON.stringify(before)}`);
  }, 90000);
});

/* ============================================================
   3. Routing × the overlays other work opens
   ============================================================ */

describe("routing × Settings — every way in is one navigation to /settings", () => {
  afterEach(restoreSettings);

  /* Settings is entered from two places (the sidebar row and ⌘,) plus the AI
     chip, which arrives AT a section. They are one function now; this is the
     test that keeps them one, by holding all of them to identical history
     behaviour rather than to an implementation. The topbar gear is gone — the
     sidebar row is the labelled, discoverable entry that replaced it. */
  const OPENERS: Array<[string, string, () => Promise<void>]> = [
    ["⌘,", "/settings", async () => chord("Comma")],
    ["the sidebar row", "/settings", async () => void (await page.click("[data-act='settings']"))],
    ["the AI statusbar item", "/settings/ai", async () => void (await page.click("#stAi"))],
  ];

  for (const [label, url, open] of OPENERS) {
    test(`entering Settings via ${label} costs ONE entry, and BACK returns to the same doc`, async () => {
      await bootThenOpenB();
      const len0 = await histLen();
      const url0 = await urlPath();

      await open();
      await waitSettings(true);
      expect(`${label}: entries added by opening: ${(await histLen()) - len0}`).toBe(
        `${label}: entries added by opening: 1`
      );
      expect(`${label}: the URL is the page: ${await urlPath()}`).toBe(`${label}: the URL is the page: ${url}`);

      await back();
      await waitSettings(false);
      expect(`${label}: BACK left it and returned to the doc: ${await shown()}`).toBe(
        `${label}: BACK left it and returned to the doc: ${B}`
      );
      expect(`${label}: URL after BACK: ${await urlPath()}`).toBe(`${label}: URL after BACK: ${url0}`);
      /* the app is not stranded: the next BACK is a real doc BACK */
      await back();
      await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, A);
      expect(`${label}: the following BACK navigated docs: ${await shown()}`).toBe(
        `${label}: the following BACK navigated docs: ${A}`
      );
    }, 90000);
  }

  test("the AI item opens Settings SCROLLED TO the AI section, and puts that section in the URL", async () => {
    /* the statusbar opener is the one with extra behaviour; it must not have
       bought that behaviour with a second history entry — and the section it
       scrolls to is now a link anyone can follow */
    await bootThenOpenB();
    const len0 = await histLen();
    await page.click("#stAi");
    await waitSettings(true);

    const inView = () =>
      page.evaluate(() => {
        const g = document.getElementById("settingsGrp-ai")!;
        const body = document.getElementById("settingsBody")!;
        const gr = g.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        return gr.top >= br.top - 6 && gr.top < br.bottom;
      });
    await waitUntil(inView, { timeout: 10000, interval: 120, label: "the AI section to scroll into view" });
    expect(`scrolled to the AI section: ${await inView()}`).toBe("scrolled to the AI section: true");
    expect(`the section is in the URL: ${await urlPath()}`).toBe("the section is in the URL: /settings/ai");
    expect(`entries added: ${(await histLen()) - len0}`).toBe("entries added: 1");

    await back();
    await waitSettings(false);
    expect(`still on the doc: ${await shown()}`).toBe(`still on the doc: ${B}`);
  }, 90000);

  test("leaving Settings by BACK lands on the doc, and the press after it navigates docs", async () => {
    await bootThenOpenB();
    await chord("Comma");
    await waitSettings(true);
    await page.evaluate(() => history.back());
    await waitSettings(false);
    expect(`back on the doc: ${await shown()}`).toBe(`back on the doc: ${B}`);

    /* nothing was left behind to swallow the next press */
    await back();
    await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, A);
    expect(`one BACK reached the previous doc: ${await shown()}`).toBe(`one BACK reached the previous doc: ${A}`);
  }, 90000);

  test("changing a setting neither navigates nor stacks entries", async () => {
    await boot(dUrl(B));
    await chord("Comma");
    await waitSettings(true);
    /* the address the page owns; a control is not a destination, so nothing
       below may move it or add to the stack */
    const url0 = await urlPath();
    const len = await histLen();

    /* a spread of control types: segmented, switch, numeric */
    await page.click("#themeSeg button[data-v='minimal']");
    await page.click("[data-sw='editor.clickToEdit']");
    await setNumberField("secrets.sessionHours", "6");
    await sleep(900);

    expect(`the URL never moved: ${await urlPath()}`).toBe(`the URL never moved: ${url0}`);
    expect(`no entries added by changing settings: ${(await histLen()) - len}`).toBe(
      "no entries added by changing settings: 0"
    );
    expect(`still the same doc: ${await shown()}`).toBe(`still the same doc: ${B}`);

    /* …and neither does SAVING them, which is the new button and the only
       thing on this page that talks to the server */
    await saveSettings();
    expect(`the URL never moved on Save either: ${await urlPath()}`).toBe(
      `the URL never moved on Save either: ${url0}`
    );
    expect(`no entries added by saving: ${(await histLen()) - len}`).toBe("no entries added by saving: 0");
    expect(`still the same doc after Save: ${await shown()}`).toBe(`still the same doc after Save: ${B}`);

    await page.click("#themeSeg button[data-v='modern']");
    await page.click("[data-sw='editor.clickToEdit']");
    await saveSettings();
  }, 90000);

  test("a hard reload of a deep URL re-applies the stored settings and re-paints the chip", async () => {
    /* the two features on the same boot path: the URL decides the doc, the file
       decides the theme, and the pushed status decides the chip */
    await srv.api("PUT", "/api/settings", { theme: "terminal", ai: { effort: "medium" } });
    await boot(dUrl(B));
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "terminal", {
      timeout: 10000,
    });
    expect(`doc from the URL: ${await shown()}`).toBe(`doc from the URL: ${B}`);
    expect(`theme from the file: ${await page.evaluate(() => document.documentElement.getAttribute("data-theme"))}`).toBe(
      "theme from the file: terminal"
    );
    await waitUntil(async () => (await aiChip()).txt === "gpt-5 · medium", {
      timeout: 25000,
      interval: 200,
      label: "the chip to paint the stored effort after a reload",
    });
    expect(`chip after reload: ${(await aiChip()).txt}`).toBe("chip after reload: gpt-5 · medium");
    await srv.api("PUT", "/api/settings", { theme: "modern" });
  }, 120000);
});
