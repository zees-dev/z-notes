/* ============================================================
   settings-save-e2e.test.ts — Settings is a FORM now.

   Every control on the page used to PUT on its own keystroke, so the header
   button could only ever be a navigation wearing the word "Done". It is a real
   Save now, and this file measures the four claims that makes:

     · DISABLED ⟺ NO DIFF. Disabled on open, enabled after one change, disabled
       again when that change is undone BY HAND — a value comparison, not a
       "something was touched" flag;
     · ONE PUT, EXACTLY THE CHANGED KEYS. Counted on the wire, with the request
       bodies captured, so a Save that re-sent the whole settings object (and
       would therefore clobber another tab, or raise `bad-model` for a model the
       user never typed) fails here;
     · IT REALLY LANDS. settings.toml on disk, and a reload that comes back
       wearing it;
     · A REFUSED VALUE STAYS DIRTY. The server's typed code is shown next to the
       field that caused it, the button stays enabled, and nothing was stored.

   Plus the one thing that is deliberately NOT buffered: the appearance preview,
   which paints live (you cannot judge a theme from a label) and reverts if you
   leave without saving.

   Real Chromium, real backend, real settings.toml throughout.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page, type HTTPRequest } from "puppeteer-core";
import { SEED_VAULT, readVaultText, sleep, startServer, waitUntil, type TestServer } from "./helpers";
import {
  appDriver,
  gotoSettings as goSettings,
  launchTestBrowser,
  leaveSettings as exitSettings,
  newAppPage,
  pressChord,
  type AppDriver,
} from "./browser";

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

/** every PUT /api/settings this page has issued, body included */
let puts: Array<{ body: any }> = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
  /* the wire, not a spy inside the app: what is being measured is the number
     and shape of the REQUESTS, which is the thing another tab would see */
  page.on("request", (r: HTTPRequest) => {
    if (r.method() !== "PUT" || !r.url().endsWith("/api/settings")) return;
    let body: any = null;
    try {
      body = JSON.parse(r.postData() ?? "null");
    } catch {
      body = r.postData();
    }
    puts.push({ body });
  });
  ui = appDriver(page, srv.base);
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  await srv?.stop();
});

beforeEach(() => {
  puts = [];
});

/* ------------------------------------------------------------------
   vocabulary
   ------------------------------------------------------------------ */

/* the shared app vocabulary — see tests/browser.ts. `ui` is built once here
   because this file keeps ONE page for the whole run (the PUT counter is
   attached to it), and `boot` takes the longer wait this suite always used. */
let ui: AppDriver;
const boot = (at = "/") => ui.boot(at, 25000);
/** a seeded doc that is NOT the one boot opens — somewhere for a Forward to go */
const FWD_DOC = "architecture/event-pipeline.md";
const chord = (code: string) => pressChord(page, code);
const gotoSettings = () => goSettings(page);
const leaveSettings = () => exitSettings(page);

/** the Save button exactly as a user reads it: label, and whether it is live */
const saveBtn = () =>
  page.evaluate(() => {
    const b = document.getElementById("settingsSave") as HTMLButtonElement;
    return { label: (b.textContent ?? "").trim(), disabled: b.disabled };
  });

const dirtyPill = () =>
  page.evaluate(() => {
    const p = document.getElementById("settingsDirty") as HTMLElement;
    return p.hidden ? "" : (p.textContent ?? "");
  });

/* SETTLED, not merely disabled: the button is also disabled while a save is in
   flight, so waiting on `disabled` alone races the response — which is exactly
   how this file first "proved" that the pre-paint cache was not written. */
const waitSave = (disabled: boolean) =>
  page.waitForFunction(
    (d) => {
      const b = document.getElementById("settingsSave") as HTMLButtonElement;
      return !b.classList.contains("busy") && b.disabled === d;
    },
    { timeout: 8000 },
    disabled
  );

async function clickSave() {
  await page.click("#settingsSave");
}

/* ---- the leave-without-saving guard (`guardSettingsExit`) ---- */
const waitConfirm = (shown: boolean) =>
  page.waitForFunction(
    (s) => document.getElementById("cfVeil")!.classList.contains("show") === s,
    { timeout: 8000 },
    shown
  );
/** the guard puts the COUNT where a delete puts the path */
const confirmPath = () => page.evaluate(() => document.getElementById("cfPath")!.textContent ?? "");
const onSettings = () =>
  page.evaluate(() => (document.getElementById("settingsView") as HTMLElement).getAttribute("aria-hidden") === "false");

/** type into a text control the way a user does: clear, type, blur */
async function typeInto(sel: string, value: string) {
  await page.click(sel);
  await page.evaluate((s) => {
    const i = document.querySelector(s as string) as HTMLInputElement;
    i.value = "";
  }, sel);
  await page.type(sel, value);
}

/** the value settings.toml on disk carries for a dotted path */
function fromDisk(path: string): string | null {
  const toml = readVaultText(srv.vault, ".znotes/settings.toml");
  const [group, key] = path.includes(".") ? path.split(".") : ["", path];
  const lines = toml.split("\n");
  let section = "";
  for (const raw of lines) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1];
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (section === group && kv[1] === key) return kv[2].replace(/^"|"$/g, "");
  }
  return null;
}

/* ============================================================
   1 · DISABLED ⟺ NO DIFF
   ============================================================ */

describe("the Save button reads the diff, not the fact that something was touched", () => {
  test("it says Save, and it is disabled the moment the page opens", async () => {
    await boot();
    await gotoSettings();
    expect(`the button on arrival: ${JSON.stringify(await saveBtn())}`).toBe(
      `the button on arrival: ${JSON.stringify({ label: "Save", disabled: true })}`
    );
    expect(`no unsaved count is shown: ${JSON.stringify(await dirtyPill())}`).toBe(
      'no unsaved count is shown: ""'
    );
    expect(`and nothing was PUT by opening the page: ${puts.length}`).toBe(
      "and nothing was PUT by opening the page: 0"
    );
  }, 90000);

  test("ONE change enables it — and undoing that change BY HAND disables it again", async () => {
    await boot();
    await gotoSettings();
    await waitSave(true);

    /* a switch: flip it, flip it back */
    await page.click("[data-sw='editor.clickToEdit']");
    await waitSave(false);
    expect(`after one flip: ${JSON.stringify(await saveBtn())}`).toBe(
      `after one flip: ${JSON.stringify({ label: "Save", disabled: false })}`
    );
    expect(`the count says: ${await dirtyPill()}`).toBe("the count says: 1 unsaved change");

    await page.click("[data-sw='editor.clickToEdit']");
    await waitSave(true);
    expect(`flipped back — the button is inert again: ${(await saveBtn()).disabled}`).toBe(
      "flipped back — the button is inert again: true"
    );
    expect(`…and the count is gone: ${JSON.stringify(await dirtyPill())}`).toBe('…and the count is gone: ""');

    /* a segmented control: pick another theme, then pick the stored one back */
    const stored = (await srv.get("/api/settings")).body.settings.theme;
    const other = stored === "modern" ? "minimal" : "modern";
    await page.click(`#themeSeg button[data-v="${other}"]`);
    await waitSave(false);
    await page.click(`#themeSeg button[data-v="${stored}"]`);
    await waitSave(true);

    /* a text field: retype the value it already had */
    const branch = (await srv.get("/api/settings")).body.settings.git.branch;
    await typeInto("#gitBranch", branch + "-x");
    await waitSave(false);
    await typeInto("#gitBranch", branch);
    await waitSave(true);

    /* a number: type another, type the stored one back */
    const secs = (await srv.get("/api/settings")).body.settings.editor.autosaveSeconds;
    await typeInto("[data-num='editor.autosaveSeconds']", String(secs + 3));
    await page.keyboard.press("Tab");
    await waitSave(false);
    await typeInto("[data-num='editor.autosaveSeconds']", String(secs));
    await page.keyboard.press("Tab");
    await waitSave(true);

    /* the whole round trip, and the server was never spoken to once */
    expect(`PUTs issued by four changes and four undos: ${puts.length}`).toBe(
      "PUTs issued by four changes and four undos: 0"
    );
  }, 120000);
});

/* ============================================================
   2 · ONE PUT, EXACTLY THE CHANGED KEYS
   ============================================================ */

describe("Save issues exactly one PUT carrying exactly what moved", () => {
  test("three controls in three groups → one request, three keys, and the file on disk agrees", async () => {
    await boot();
    await gotoSettings();
    await waitSave(true);

    await page.click("[data-sw='editor.clickToEdit']");
    await typeInto("#gitBranch", "trunk");
    await typeInto("[data-num='secrets.sessionHours']", "6");
    await page.keyboard.press("Tab");
    await waitSave(false);
    expect(`three changes counted: ${await dirtyPill()}`).toBe("three changes counted: 3 unsaved changes");
    expect(`still nothing on the wire: ${puts.length}`).toBe("still nothing on the wire: 0");

    await clickSave();
    await waitSave(true);

    expect(`requests issued by Save: ${puts.length}`).toBe("requests issued by Save: 1");
    expect(`the body Save sent: ${JSON.stringify(puts[0].body)}`).toBe(
      `the body Save sent: ${JSON.stringify({
        editor: { clickToEdit: false },
        git: { branch: "trunk" },
        secrets: { sessionHours: 6 },
      })}`
    );
    /* nothing the user did not touch rode along — no theme, no ai, no terminal,
       and above all no `apiKeyMasked`, which would have stored the MASK */
    expect(`top-level keys in the patch: ${Object.keys(puts[0].body).sort().join(",")}`).toBe(
      "top-level keys in the patch: editor,git,secrets"
    );

    /* it reached the committed file, not just memory */
    await waitUntil(async () => fromDisk("git.branch") === "trunk", {
      timeout: 8000,
      interval: 100,
      label: "settings.toml to carry the new branch",
    });
    expect(`settings.toml: branch=${fromDisk("git.branch")} sessionHours=${fromDisk("secrets.sessionHours")} clickToEdit=${fromDisk("editor.clickToEdit")}`).toBe(
      "settings.toml: branch=trunk sessionHours=6 clickToEdit=false"
    );

    /* and a reload comes back wearing all three */
    await boot();
    await gotoSettings();
    const back = await page.evaluate(() => ({
      branch: (document.getElementById("gitBranch") as HTMLInputElement).value,
      hours: (document.querySelector("[data-num='secrets.sessionHours']") as HTMLInputElement).value,
      click: document.querySelector("[data-sw='editor.clickToEdit']")!.classList.contains("on"),
    }));
    expect(`after a reload: ${JSON.stringify(back)}`).toBe(
      `after a reload: ${JSON.stringify({ branch: "trunk", hours: "6", click: false })}`
    );
    expect(`…and Save is inert again, because there is no diff: ${(await saveBtn()).disabled}`).toBe(
      "…and Save is inert again, because there is no diff: true"
    );

    /* put the vault back */
    await srv.api("PUT", "/api/settings", {
      editor: { clickToEdit: true },
      git: { branch: "main" },
      secrets: { sessionHours: 8 },
    });
  }, 150000);

  test("⌘S on the settings page saves the draft, not a document", async () => {
    /* ⌘S means "save what is in front of me", and on this page there is no
       document to save — the topbar's Save button is hidden here for exactly
       the same reason. */
    await boot();
    await gotoSettings();
    await typeInto("#aiModel", "gpt-5-probe");
    await waitSave(false);
    await chord("KeyS");
    await waitSave(true);

    expect(`⌘S issued: ${puts.length} PUT ${JSON.stringify(puts[0].body)}`).toBe(
      `⌘S issued: 1 PUT ${JSON.stringify({ ai: { model: "gpt-5-probe" } })}`
    );
    expect(`the server stored it: ${(await srv.get("/api/settings")).body.settings.ai.model}`).toBe(
      "the server stored it: gpt-5-probe"
    );
    await srv.api("PUT", "/api/settings", { ai: { model: "gpt-5" } });
  }, 120000);

  test("⌘S saves a NUMERIC field that has not been blurred yet", async () => {
    /* The nine `[data-num]` controls record their draft on `change`, which
       fires on blur or Enter — and ⌘S is neither. So the chord the Save
       button's own tooltip advertises used to reach the dirty guard with an
       EMPTY draft and return, `preventDefault` already spent: no PUT, no toast,
       no browser save dialog, and a pill claiming the page was clean. The edit
       was gone with no signal anywhere. Deliberately NO blur, no Tab, no Enter
       here — that is the whole test. */
    await boot();
    await gotoSettings();
    const before = (await srv.get("/api/settings")).body.settings.editor.autosaveSeconds;
    const wanted = before === 25 ? 30 : 25;
    await typeInto("[data-num='editor.autosaveSeconds']", String(wanted));
    expect(`the caret is still in the field: ${await page.evaluate(() => document.activeElement?.getAttribute("data-num"))}`).toBe(
      "the caret is still in the field: editor.autosaveSeconds"
    );

    await chord("KeyS");
    await waitSave(true);

    expect(`⌘S issued: ${puts.length} PUT ${JSON.stringify(puts[0]?.body)}`).toBe(
      `⌘S issued: 1 PUT ${JSON.stringify({ editor: { autosaveSeconds: wanted } })}`
    );
    expect(`the server stored it: ${(await srv.get("/api/settings")).body.settings.editor.autosaveSeconds}`).toBe(
      `the server stored it: ${wanted}`
    );
    expect(`and settings.toml on disk says: ${fromDisk("editor.autosaveSeconds")}`).toBe(
      `and settings.toml on disk says: ${wanted}`
    );

    await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: before } });
  }, 120000);

  test("a second Save with nothing changed issues nothing at all", async () => {
    await boot();
    await gotoSettings();
    await page.click("[data-sw='editor.clickToEdit']");
    await waitSave(false);
    await clickSave();
    await waitSave(true);
    expect(`the first Save: ${puts.length} PUT`).toBe("the first Save: 1 PUT");

    /* the button is disabled, but click it anyway — a disabled button that
       still fires is the same bug wearing a different hat */
    await page.evaluate(() => (document.getElementById("settingsSave") as HTMLButtonElement).click());
    await sleep(400);
    expect(`after clicking an inert Save: ${puts.length} PUT`).toBe("after clicking an inert Save: 1 PUT");

    await srv.api("PUT", "/api/settings", { editor: { clickToEdit: true } });
  }, 120000);
});

/* ============================================================
   3 · A REFUSED VALUE
   ============================================================ */

describe("a value the server refuses is shown where it happened and stays dirty", () => {
  test("bad-base-url lands next to the Base URL field, Save stays live, nothing is stored", async () => {
    await boot();
    await gotoSettings();
    const before = (await srv.get("/api/settings")).body.settings.ai.baseUrl;

    await typeInto("#aiBase", "not-a-url-at-all");
    await waitSave(false);
    await clickSave();

    /* the error surfaces… */
    await page.waitForFunction(
      () => !(document.getElementById("settingsErr") as HTMLElement).hidden,
      { timeout: 8000 }
    );
    const err = await page.evaluate(() => {
      const box = document.getElementById("settingsErr") as HTMLElement;
      const field = box.closest(".field");
      return {
        text: box.textContent ?? "",
        /* NEXT TO THE FIELD, not in a corner: the box's own field must be the
           one holding #aiBase */
        onTheRightField: !!field && !!field.querySelector("#aiBase"),
        marked: !!field && field.classList.contains("bad"),
      };
    });
    expect(`the code the server sent is shown: ${err.text.includes("bad-base-url")}`).toBe(
      "the code the server sent is shown: true"
    );
    expect(`it is attached to the Base URL field: ${err.onTheRightField} (marked: ${err.marked})`).toBe(
      "it is attached to the Base URL field: true (marked: true)"
    );

    /* …the draft is still dirty, because nothing was saved… */
    expect(`Save is still live: ${!(await saveBtn()).disabled}`).toBe("Save is still live: true");
    expect(`the count still says: ${await dirtyPill()}`).toBe("the count still says: 1 unsaved change");
    /* …and the server kept the old value */
    expect(`the stored baseUrl is untouched: ${(await srv.get("/api/settings")).body.settings.ai.baseUrl === before}`).toBe(
      "the stored baseUrl is untouched: true"
    );

    /* fixing the field clears the error and a second Save takes */
    await typeInto("#aiBase", before);
    await waitSave(true);
    expect(`typing the stored value back cleared the error: ${await page.evaluate(() => (document.getElementById("settingsErr") as HTMLElement).hidden)}`).toBe(
      "typing the stored value back cleared the error: true"
    );
  }, 120000);
});

/* ============================================================
   4 · THE APPEARANCE PREVIEW
   ============================================================ */

describe("appearance previews live but only Save persists it", () => {
  const look = () =>
    page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      density: document.documentElement.getAttribute("data-density"),
      cachedTheme: localStorage.getItem("znotes.theme"),
    }));

  /* LEAVING IS A QUESTION NOW, not a silent keep.
     The page used to walk away without a word, revert the preview and hold the
     draft for next time — which made "left without saving" and "saved" look
     identical from anywhere else in the app, since the one drafted setting you
     can see from another page is the THEME. So every deliberate exit is gated
     (`guardSettingsExit`), Cancel stays, and OK discards: the question on
     screen is "leave without saving?", and a Yes that quietly kept the answer
     would be answering a different one. */
  test("picking a theme repaints at once; leaving asks, Cancel stays, Discard puts it back", async () => {
    await srv.api("PUT", "/api/settings", { theme: "modern", density: "comfy" });
    await boot();
    await gotoSettings();
    expect(`the stored look: ${JSON.stringify(await look())}`).toBe(
      `the stored look: ${JSON.stringify({ theme: "modern", density: "comfy", cachedTheme: "modern" })}`
    );

    await page.click('#themeSeg button[data-v="terminal"]');
    await page.click('#densitySeg button[data-v="compact"]');
    await page.waitForFunction(
      () =>
        document.documentElement.getAttribute("data-theme") === "terminal" &&
        document.documentElement.getAttribute("data-density") === "compact",
      { timeout: 8000 }
    );
    /* LIVE — that is the whole point of a theme control… */
    expect(`previewing: ${JSON.stringify(await look())}`).toBe(
      /* …but the pre-paint cache still predicts the SAVED look, because the
         next boot will use the saved look */
      `previewing: ${JSON.stringify({ theme: "terminal", density: "compact", cachedTheme: "modern" })}`
    );
    expect(`and nothing was persisted: ${puts.length} PUT`).toBe("and nothing was persisted: 0 PUT");

    /* Back, with two unsaved changes → the guard, not the exit */
    await page.evaluate(() => history.back());
    await waitConfirm(true);
    expect(`the guard names the count: ${await confirmPath()}`).toBe("the guard names the count: 2 unsaved changes");
    expect(`and it is still the settings page: ${await onSettings()}`).toBe("and it is still the settings page: true");

    /* Cancel keeps the page, the draft AND the preview */
    await page.click('#cfVeil [data-act="cf-cancel"]');
    await waitConfirm(false);
    expect(`Cancel stayed: ${await onSettings()}`).toBe("Cancel stayed: true");
    expect(`with the preview intact: ${JSON.stringify(await look())}`).toBe(
      `with the preview intact: ${JSON.stringify({ theme: "terminal", density: "compact", cachedTheme: "modern" })}`
    );
    expect(`and the draft intact: ${await dirtyPill()}`).toBe("and the draft intact: 2 unsaved changes");

    /* Discard and leave → gone, both from the page and from the look */
    await page.evaluate(() => history.back());
    await waitConfirm(true);
    await page.click("#cfOk");
    await page.waitForFunction(() => (document.getElementById("settingsView") as HTMLElement).getAttribute("aria-hidden") === "true", { timeout: 8000 });
    expect(`after discarding: ${JSON.stringify(await look())}`).toBe(
      `after discarding: ${JSON.stringify({ theme: "modern", density: "comfy", cachedTheme: "modern" })}`
    );
    expect(`the server still has: ${(await srv.get("/api/settings")).body.settings.theme}`).toBe(
      "the server still has: modern"
    );

    /* …and the draft really is gone, not merely hidden: coming back is clean */
    await gotoSettings();
    expect(`re-entry is clean: ${await dirtyPill()}`).toBe("re-entry is clean: ");
    expect(`and wearing the stored look: ${JSON.stringify(await look())}`).toBe(
      `and wearing the stored look: ${JSON.stringify({ theme: "modern", density: "comfy", cachedTheme: "modern" })}`
    );

    /* Save → it is the real look now, cache included, and it survives a reload */
    await page.click('#themeSeg button[data-v="terminal"]');
    await page.click('#densitySeg button[data-v="compact"]');
    await waitSave(false);
    await clickSave();
    await waitSave(true);
    expect(`requests issued: ${puts.length}`).toBe("requests issued: 1");
    expect(`the body: ${JSON.stringify(puts[0].body)}`).toBe(
      `the body: ${JSON.stringify({ theme: "terminal", density: "compact" })}`
    );
    expect(`after Save: ${JSON.stringify(await look())}`).toBe(
      `after Save: ${JSON.stringify({ theme: "terminal", density: "compact", cachedTheme: "terminal" })}`
    );

    await boot();
    expect(`and after a reload: ${JSON.stringify(await look())}`).toBe(
      `and after a reload: ${JSON.stringify({ theme: "terminal", density: "compact", cachedTheme: "terminal" })}`
    );
    await srv.api("PUT", "/api/settings", { theme: "modern", density: "comfy" });
  }, 180000);

  /* REGRESSION, and the reason the exit guard above exists at all.
     The seg handler used to re-apply `draftedLook()`, and `setDraft` DELETES
     the entry when the pick equals the stored value — so picking Terminal and
     then Minimal (the stored one) again left the drafted-look list EMPTY and
     applied nothing. The app stayed on Terminal with no draft behind it: Save
     was disabled, Discard was hidden, and `exitSettings` had no axis to
     restore, so a theme nobody saved followed the user off the page and
     survived every later navigation. The axis the user clicked is always the
     axis to repaint, drafted or not. */
  test("clicking back to the STORED theme repaints it, and leaves nothing pending", async () => {
    await srv.api("PUT", "/api/settings", { theme: "minimal" });
    await boot();
    await gotoSettings();
    await waitSave(true);

    await page.click('#themeSeg button[data-v="terminal"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "terminal", {
      timeout: 8000,
    });
    await waitSave(false);

    await page.click('#themeSeg button[data-v="minimal"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "minimal", {
      timeout: 8000,
    });
    /* back to the stored value ⟹ no diff ⟹ nothing to save, nothing to leave
       behind, and no exit guard on the way out */
    await waitSave(true);
    expect(`the pill is empty: ${JSON.stringify(await dirtyPill())}`).toBe('the pill is empty: ""');
    expect(`and nothing went to the server: ${puts.length} PUT`).toBe("and nothing went to the server: 0 PUT");

    await leaveSettings();
    expect(`after leaving, the look is the stored one: ${JSON.stringify(await look())}`).toBe(
      `after leaving, the look is the stored one: ${JSON.stringify({ theme: "minimal", density: "comfy", cachedTheme: "minimal" })}`
    );
    await srv.api("PUT", "/api/settings", { theme: "modern" });
  }, 120000);

  test("Discard throws the draft away and puts the look back, on the page", async () => {
    await srv.api("PUT", "/api/settings", { theme: "modern" });
    await boot();
    await gotoSettings();
    expect(`Discard is not offered while there is nothing to discard: ${await page.evaluate(() => (document.getElementById("settingsDiscard") as HTMLElement).hidden)}`).toBe(
      "Discard is not offered while there is nothing to discard: true"
    );

    await page.click('#themeSeg button[data-v="minimal"]');
    await page.click("[data-sw='git.autoSync']");
    await waitSave(false);
    await page.waitForFunction(() => !(document.getElementById("settingsDiscard") as HTMLElement).hidden, {
      timeout: 8000,
    });

    await page.click("#settingsDiscard");
    await waitSave(true);
    expect(`the look is back: ${await page.evaluate(() => document.documentElement.getAttribute("data-theme"))}`).toBe(
      "the look is back: modern"
    );
    expect(`the switch is back: ${await page.evaluate(() => document.querySelector("[data-sw='git.autoSync']")!.classList.contains("on"))}`).toBe(
      `the switch is back: ${(await srv.get("/api/settings")).body.settings.git.autoSync}`
    );
    expect(`and Discard nothing on the wire: ${puts.length}`).toBe("and Discard nothing on the wire: 0");
  }, 120000);

  /* REGRESSION. The guard read `settingsDirty()` BEFORE flushing the numeric
     field the caret was sitting in — and the nine `[data-num]` controls record
     on `change`, which a history traversal is not. So the page looked clean at
     the exact moment it was asked, the guard waved the press through, and the
     number went with it: no dialog, no toast, no pill. Exactly the failure ⌘S
     had (see "⌘S saves a NUMERIC field…"), reached through the other door.
     Deliberately NO blur, no Tab, no Enter — that is the whole test. */
  test("BACK out of a numeric field the caret is still in asks, instead of losing the edit", async () => {
    await boot();
    await gotoSettings();
    const before = (await srv.get("/api/settings")).body.settings.editor.autosaveSeconds;
    const wanted = before === 25 ? 30 : 25;
    await typeInto("[data-num='editor.autosaveSeconds']", String(wanted));
    expect(`the caret is still in the field: ${await page.evaluate(() => document.activeElement?.getAttribute("data-num"))}`).toBe(
      "the caret is still in the field: editor.autosaveSeconds"
    );
    /* and the draft has NOT heard about it yet — the pill is the proof that this
       test is exercising the ordering rather than a field that already recorded */
    expect(`the pill before the press: "${await dirtyPill()}"`).toBe('the pill before the press: ""');

    await page.evaluate(() => history.back());
    await waitConfirm(true);
    expect(`the guard counted the un-blurred edit: ${await confirmPath()}`).toBe(
      "the guard counted the un-blurred edit: 1 unsaved change"
    );
    expect(`and it is still the settings page: ${await onSettings()}`).toBe("and it is still the settings page: true");

    /* Cancel keeps it, and the edit is in the draft where Save can reach it */
    await page.click('#cfVeil [data-act="cf-cancel"]');
    await waitConfirm(false);
    expect(`the draft survived Cancel: ${await dirtyPill()}`).toBe("the draft survived Cancel: 1 unsaved change");
    await waitSave(false);
    await clickSave();
    await waitSave(true);
    expect(`what reached the wire: ${JSON.stringify(puts[0]?.body)}`).toBe(
      `what reached the wire: ${JSON.stringify({ editor: { autosaveSeconds: wanted } })}`
    );

    await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: before } });
  }, 120000);

  /* REGRESSION. Every layer `onPop` unwinds is gated on BACK, because none of
     them is a gesture you perform with Forward — you do not dismiss a sheet by
     pressing Forward. A DRAFT is not a gesture: Forward off the settings page
     throws the work away exactly as Back does, and it is three presses from a
     cold boot. The guard was reached in one direction only. */
  test("FORWARD off the settings page asks too — a draft is work, not a gesture", async () => {
    await srv.api("PUT", "/api/settings", { theme: "modern" });
    await boot();
    /* THREE entries, BUILT IN STACK ORDER, because Forward can only walk into an
       entry that is really there and a push TRUNCATES everything ahead of it:
       the boot doc, the settings page pushed over it, and a second doc pushed
       over that. Then ONE Back lands us on settings with a real entry still
       ahead. Opening settings last instead would leave it on top of the stack,
       where `history.forward()` is a no-op that fires no popstate at all — which
       is what the first draft of this test measured, and why it timed out on a
       guard that was working. */
    await gotoSettings();
    await ui.clickDoc(FWD_DOC);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => (document.getElementById("settingsView") as HTMLElement).getAttribute("aria-hidden") === "false", { timeout: 8000 });
    await sleep(200);

    await page.click('#themeSeg button[data-v="terminal"]');
    await waitSave(false);

    await page.evaluate(() => history.forward());
    await waitConfirm(true);
    expect(`FORWARD raised the guard: ${await confirmPath()}`).toBe("FORWARD raised the guard: 1 unsaved change");
    expect(`and it is still the settings page: ${await onSettings()}`).toBe("and it is still the settings page: true");

    /* Cancel stays put, preview and all */
    await page.click('#cfVeil [data-act="cf-cancel"]');
    await waitConfirm(false);
    expect(`Cancel stayed: ${await onSettings()}`).toBe("Cancel stayed: true");
    expect(`with the preview intact: ${await page.evaluate(() => document.documentElement.getAttribute("data-theme"))}`).toBe(
      "with the preview intact: terminal"
    );

    /* AND THE DESTINATION IS GONE, which is a property of the architecture and
       not an accident worth papering over: the dialog is a veil, every veil
       pushes a marker, and a push TRUNCATES everything ahead. So the entry the
       press was reaching for is destroyed by the act of ASKING about it, before
       the answer is known. Backwards this costs nothing (entries below are never
       truncated); forwards, Cancel keeps the page and the forward stack does not
       come back. Measured here rather than left to be discovered. */
    await page.evaluate(() => history.forward());
    await sleep(400);
    expect(`a second Forward has nowhere to go: ${await onSettings()}`).toBe(
      "a second Forward has nowhere to go: true"
    );
    expect(`and asks nothing: ${await page.evaluate(() => document.getElementById("cfVeil")!.classList.contains("show"))}`).toBe(
      "and asks nothing: false"
    );

    /* So the OTHER half of the answer — Discard and leave — is measured on a
       fresh stack. The reload drops the draft with it, which is why the theme is
       re-picked below rather than carried over. */
    await boot();
    await gotoSettings();
    await ui.clickDoc(FWD_DOC);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => (document.getElementById("settingsView") as HTMLElement).getAttribute("aria-hidden") === "false", { timeout: 8000 });
    await sleep(200);
    await page.click('#themeSeg button[data-v="terminal"]');
    await waitSave(false);

    /* Discard and leave lands on the doc the press was ASKING for — the one
       ABOVE, not the one below, which is the whole difference between honouring
       a Forward and quietly turning it into a Back. */
    await page.evaluate(() => history.forward());
    await waitConfirm(true);
    await page.click("#cfOk");
    await page.waitForFunction(() => (document.getElementById("settingsView") as HTMLElement).getAttribute("aria-hidden") === "true", { timeout: 8000 });
    await ui.settled(FWD_DOC);
    expect(`the look came back: ${await page.evaluate(() => document.documentElement.getAttribute("data-theme"))}`).toBe(
      "the look came back: modern"
    );
    expect(`and nothing was persisted: ${puts.length} PUT`).toBe("and nothing was persisted: 0 PUT");
  }, 180000);
});

/* ============================================================
   5 · THE LINE BETWEEN A SETTING AND AN ACTION
   ============================================================ */

describe("credentials and actions are not draft state", () => {
  test("typing an API key saves it immediately and does not dirty the Save button", async () => {
    await boot();
    await gotoSettings();
    await waitSave(true);

    await typeInto("#aiKey", "sk-test-key-that-is-long-enough-to-mask");
    await page.keyboard.press("Tab");
    await waitUntil(async () => puts.length >= 1, {
      timeout: 8000,
      interval: 100,
      label: "the credential to be written immediately",
    });
    /* the field carries the real key on the way OUT — it is the mask only on
       the way back, once sqlite has absorbed it */
    expect(`the credential went out on its own: ${JSON.stringify(puts[0].body)}`).toBe(
      `the credential went out on its own: ${JSON.stringify({
        ai: { apiKeyMasked: "sk-test-key-that-is-long-enough-to-mask" },
      })}`
    );
    expect(`…and it never entered the draft: ${(await saveBtn()).disabled}`).toBe(
      "…and it never entered the draft: true"
    );
    /* the server absorbed it into sqlite and answers with a mask, never the key */
    const served = (await srv.get("/api/settings")).body.settings.ai.apiKeyMasked;
    expect(`the server serves it masked: ${served}`).toBe("the server serves it masked: sk-t…mask");
  }, 120000);

  test("an action taken mid-draft neither saves nor loses the draft", async () => {
    await boot();
    await gotoSettings();
    await typeInto("[data-num='terminal.idleLockMinutes']", "7");
    await page.keyboard.press("Tab");
    await page.click("[data-sw='terminal.enabled']");
    await waitSave(false);
    const beforeCount = await dirtyPill();

    /* Generate is an ACTION on the vault passphrase — it writes nothing and
       must leave the settings draft exactly as it found it */
    await page.click("#keyGen");
    await sleep(400);
    expect(`the draft is untouched by the action: ${await dirtyPill()} (was ${beforeCount})`).toBe(
      `the draft is untouched by the action: ${beforeCount} (was ${beforeCount})`
    );
    expect(`and the action put nothing on the settings wire: ${puts.length}`).toBe(
      "and the action put nothing on the settings wire: 0"
    );
    /* the terminal fields the action's repaint touches still show the draft */
    expect(`the drafted number survived the repaint: ${await page.evaluate(() => (document.querySelector("[data-num='terminal.idleLockMinutes']") as HTMLInputElement).value)}`).toBe(
      "the drafted number survived the repaint: 7"
    );

    await page.click("#settingsDiscard");
    await waitSave(true);
  }, 120000);
});

/* ============================================================
   5b · A SAVE THAT ARRIVED FROM SOMEWHERE ELSE, WHILE THIS TAB HOLDS A DRAFT

   The draft outranks an incoming save on the paths it HOLDS. It used to
   outrank it on every path, and since `exitSettings` keeps a draft past the
   visit, one unsaved density click made the tab permanently deaf — to a theme,
   a home doc, an auto-lock policy, the terminal verdict. Unrepairably so:
   Save applies only the paths IT drafted and Discard only the drafted look
   axes, so neither ever reached the adopted one.

   The out-of-band PUTs here go through `srv.api`, not the page, so they are
   another client by construction and never enter the `puts` counter.
   ============================================================ */

describe("a settings-changed that lands on a tab with an unsaved draft", () => {
  const dataAttr = (a: string) => page.evaluate((x) => document.documentElement.getAttribute(x as string), a);
  const themeCache = () =>
    page.evaluate(() => {
      try {
        return localStorage.getItem("znotes.theme");
      } catch {
        return null;
      }
    });
  const remote = async (patch: Record<string, unknown>) => {
    const r = await srv.api("PUT", "/api/settings", patch);
    expect(`another client PUT ${JSON.stringify(patch)} → ${r.status}`).toBe(
      `another client PUT ${JSON.stringify(patch)} → 200`
    );
  };
  const waitAttr = (a: string, want: string) =>
    page.waitForFunction(
      (x, w) => document.documentElement.getAttribute(x as string) === w,
      { timeout: 8000 },
      a,
      want
    );

  test("a path the draft does NOT hold is applied — the draft does not deafen the tab", async () => {
    await remote({ theme: "minimal", density: "comfy" });
    await boot();
    await gotoSettings();
    await waitSave(true);

    /* one unsaved change, on a field that has nothing to do with appearance */
    await page.click("[data-sw='editor.clickToEdit']");
    await waitSave(false);

    await remote({ theme: "terminal" });
    /* before the fix this timed out: the global dirty guard returned before
       applySavedSettings and the tab stayed on minimal for good */
    await waitAttr("data-theme", "terminal");
    expect(`the tab adopted the remote theme: ${await dataAttr("data-theme")}`).toBe(
      "the tab adopted the remote theme: terminal"
    );
    /* …and the user's own pending answer is still pending */
    expect(`the draft survived: ${await dirtyPill()}`).toBe("the draft survived: 1 unsaved change");

    await page.click("#settingsDiscard");
    await waitSave(true);
    await remote({ theme: "minimal" });
    await waitAttr("data-theme", "minimal");
  }, 120000);

  test("…but the path the draft DOES hold is left alone, and this tab's Save still wins", async () => {
    await remote({ theme: "minimal" });
    await boot();
    await gotoSettings();
    await waitSave(true);

    await page.click('#themeSeg button[data-v="modern"]');
    await waitAttr("data-theme", "modern"); // the preview
    await waitSave(false);

    await remote({ theme: "terminal" });
    await sleep(700);
    expect(`a colleague's theme did not yank the preview: ${await dataAttr("data-theme")}`).toBe(
      "a colleague's theme did not yank the preview: modern"
    );
    expect(`and it is still an unsaved change: ${await dirtyPill()}`).toBe(
      "and it is still an unsaved change: 1 unsaved change"
    );

    await clickSave();
    await waitSave(true);
    expect(`this tab's own answer landed: ${await dataAttr("data-theme")}`).toBe(
      "this tab's own answer landed: modern"
    );
    expect(`…on disk too: ${fromDisk("theme")}`).toBe("…on disk too: modern");

    await remote({ theme: "minimal" });
    await waitAttr("data-theme", "minimal");
  }, 120000);

  test("a draft the incoming save ABSORBS is applied, not stranded with no button left to press", async () => {
    await remote({ theme: "minimal" });
    await boot();
    await gotoSettings();
    await waitSave(true);

    await page.click('#themeSeg button[data-v="terminal"]');
    await waitAttr("data-theme", "terminal");
    await waitSave(false);
    /* a PREVIEW deliberately does not write the pre-paint cache — that cache
       predicts the next boot, and the next boot uses the stored value */
    expect(`the preview left the boot cache alone: ${await themeCache()}`).toBe(
      "the preview left the boot cache alone: minimal"
    );

    /* the other client stores exactly what this one was about to */
    await remote({ theme: "terminal" });
    await waitSave(true);
    expect(`the draft was absorbed: ${await dirtyPill()}`).toBe("the draft was absorbed: ");
    /* …and because it was, the path is no longer drafted and IS applied: the
       cache is the discriminator, since the preview had already painted it.
       Before the fix the guard returned first and this stayed on minimal, with
       Save disabled and Discard hidden — nothing left to press. */
    await page.waitForFunction(() => localStorage.getItem("znotes.theme") === "terminal", { timeout: 8000 });
    expect(`the absorbed path was applied for real: ${await themeCache()}`).toBe(
      "the absorbed path was applied for real: terminal"
    );

    await remote({ theme: "minimal" });
    await waitAttr("data-theme", "minimal");
  }, 120000);

  test("a ?theme= pin is not the vault's to take back — and does not deafen the other axes", async () => {
    await remote({ theme: "minimal", density: "comfy" });
    await boot("/?theme=terminal");
    expect(`the URL pinned the look: ${await dataAttr("data-theme")}`).toBe("the URL pinned the look: terminal");

    await remote({ theme: "modern" });
    await sleep(800);
    expect(`a remote save did not stamp over the pin: ${await dataAttr("data-theme")}`).toBe(
      "a remote save did not stamp over the pin: terminal"
    );
    /* the pin is one axis, not a mute button on the whole payload */
    await remote({ density: "compact" });
    await waitAttr("data-density", "compact");

    await remote({ theme: "minimal", density: "comfy" });
    await boot();
    await waitAttr("data-theme", "minimal");
  }, 120000);
});

/* ============================================================
   6 · nothing threw
   ============================================================ */

describe("no page errors", () => {
  test("the whole file ran without an uncaught exception in the browser", () => {
    expect(`page errors: ${JSON.stringify(pageErrors)}`).toBe("page errors: []");
  });
});
