/* ============================================================
   ux-e2e.test.ts — the four shell affordances, in a real browser.

   Each one is a place where "it works" and "it works the way a person expects"
   are different claims, so each is measured against the expectation rather than
   against the implementation:

     · THE MODE AFFORDANCE. It is statusbar text, not topbar chrome: one muted
       word that names the mode, clicks to toggle, and still answers to ⌘E,
       while Preview is still what a doc opens in.
     · THE CHORDS THAT SHARE A KEY WITH THE BROWSER. Settings answers to ⌘/ and
       to ⌘,; the chat panel answers to ⌘J and — only when the copy it would
       shadow is a no-op — to ⌘C. The ⌘C block below is the one that matters:
       it proves copy still copies, off the real clipboard, in every state
       where a person could plausibly press it.
     · ESC LAYERING. Esc unwinds ONE layer at a time, top down, and the chat
       panel is the bottom of the stack. The draft survives every path through
       it, because closing the panel is a CSS collapse and not an unmount.
     · CONTEXT MENU. A create lands in the folder that was right-clicked, not
       wherever the tree cursor happened to be; the menu closes on Esc and on a
       click away; and it flips at the viewport edges instead of spilling.
     · HOME. The button goes where `editor.homeDoc` says, follows that setting
       when it changes, does something sensible when it names nothing, and
       leaves a history entry Back can return through.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import {
  startServer,
  sleep,
  vaultHas,
  waitUntil,
  SEED_VAULT,
  encPath,
  readVaultText,
  type TestServer,
} from "./helpers";
import {
  clickWhenHittable,
  launchTestBrowser,
  newAppPage,
  appDriver,
  gotoSettings,
  leaveSettings as exitSettings,
  onSettings as isOnSettings,
  saveSettings,
  waitSettings as waitForSettings,
  type AppDriver,
} from "./browser";

const NAV_DOC = "architecture/event-pipeline.md";
const HOME_DOC = "projects/homelab.md";

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/**
 * A fresh page per test — history, focus and the chat draft are all per-page.
 *
 * `localStorage` is NOT: it belongs to the origin, and every page in this
 * browser shares it. The assistant panel's open/closed state is remembered
 * there (`znotes.chat`, app.js `initChatOpen`), so a test that toggles the
 * panel — ⌘J, ⌘C, or the Esc that unwinds onto it — silently decided what the
 * NEXT test would boot into, and three tests in the Esc-layering group were
 * asserting the panel is open while an earlier one had just persisted
 * "closed". A per-test page that inherits per-origin state is not a fresh
 * fixture; clearing the one key restores the width default (open at 1440),
 * which is what every test here was written against.
 *
 * `beforeLoad` rather than an `evaluate` after boot, because the value has to
 * be gone before `initChatOpen` reads it.
 */
beforeEach(async () => {
  if (page) await page.close().catch(() => {});
  pageErrors.length = 0;
  page = await newAppPage(browser, {
    onPageError: (m) => pageErrors.push(m),
    beforeLoad: () => {
      try {
        localStorage.removeItem("znotes.chat");
      } catch {}
    },
  });
  app = appDriver(page, srv.base);
  await app.boot("/");
});

/* ------------------------------------------------------------------
   helpers
   ------------------------------------------------------------------ */

async function setSetting(patch: Record<string, unknown>) {
  const r = await srv.api("PUT", "/api/settings", patch);
  expect(`PUT /api/settings → ${r.status} ${r.text.slice(0, 120)}`).toBe(
    `PUT /api/settings → 200 ${r.text.slice(0, 120)}`
  );
  return r;
}

const veilOpen = (id: string) => page.evaluate((i) => document.getElementById(i)!.classList.contains("show"), id);
/* the shared settings predicate and its wait — see tests/browser.ts */
const onSettings = () => isOnSettings(page);
const waitSettings = (want: boolean) => waitForSettings(page, want);
/* the shared pair — see tests/browser.ts, where the settle pause the three
   copies of these had drifted on is documented once */
const goSettings = () => gotoSettings(page);
const leaveSettings = () => exitSettings(page);
const chatOpen = () => page.evaluate(() => document.getElementById("app")!.classList.contains("chat-open"));
const menuOpen = () => page.evaluate(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden);

async function rightClick(selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
  if (!box) throw new Error(`no element for ${selector}`);
  await page.mouse.click(box.x, box.y, { button: "right" });
  await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
}

/** menu item labels, top to bottom */
const menuLabels = () =>
  page.evaluate(() => [...document.querySelectorAll("#ctxMenu .menu-item .lbl")].map((n) => n.textContent));

const menuHead = () => page.evaluate(() => document.querySelector("#ctxMenu .menu-head")?.textContent ?? null);

/**
 * Wait for the inline create/rename field to be present AND FOCUSED.
 *
 * `inlineRow` focuses on a 20ms delay (the tree is rebuilt under it first), so
 * a bare `waitForSelector` returns during the gap and the keystrokes that
 * follow land on the document instead of in the field.
 */
async function inlineField() {
  await page.waitForFunction(
    () => {
      const i = document.querySelector("#tree .newrow input");
      return !!i && document.activeElement === i;
    },
    { timeout: 8000 }
  );
}

/* hit-testable clicking — see tests/browser.ts */
const clickSettings = (sel: string) => clickWhenHittable(page, sel);

/** drive the density through the real control — the shell listens to the
    Settings panel, not to a PUT made behind its back */
async function setDensity(id: "comfy" | "compact") {
  if ((await page.evaluate(() => document.documentElement.getAttribute("data-density"))) === id) return;
  await goSettings();
  await clickSettings(`#densitySeg button[data-v="${id}"]`);
  await page.waitForFunction(
    (d) => document.documentElement.getAttribute("data-density") === d,
    { timeout: 8000 },
    id
  );
  /* SAVE it. Appearance is a draft until Save, and exitSettings reverts an
     unsaved preview on the way out — without this the helper returned to comfy
     and every "compact" measurement was a comfy one with the wrong label. Save
     is inert when the pick matches what is stored, so the click is conditional. */
  await saveSettings(page);
  await leaveSettings();
  await sleep(360);
  const got = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
  expect(`density after leaving Settings: ${got}`).toBe(`density after leaving Settings: ${id}`);
}

async function clickMenuItem(label: string) {
  const ok = await page.evaluate((want) => {
    const b = [...document.querySelectorAll<HTMLElement>("#ctxMenu .menu-item")].find(
      (n) => n.querySelector(".lbl")?.textContent === want
    );
    if (!b) return false;
    b.click();
    return true;
  }, label);
  expect(`clicked menu item "${label}": ${ok}`).toBe(`clicked menu item "${label}": true`);
}

/* ============================================================
   1. THE MODE LIVES IN THE STATUSBAR, AND PREVIEW IS STILL THE DEFAULT

   This block used to assert that the topbar's Raw|Preview segmented control
   read left-to-right. That control is GONE: the mode is one muted, clickable
   word in the statusbar (`#stMode`), because which of two views of a document
   you are looking at is state and this bar is where state is said. What the
   block asserts about the MODE itself is unchanged and is if anything stricter
   — Preview is still the default, ⌘E still toggles, and the affordance must
   name the mode in words. Only WHERE it looks has moved.
   ============================================================ */

describe("ux — the mode affordance is statusbar text", () => {
  test("the topbar carries no mode control, and the statusbar chip survives every width and density", async () => {
    for (const [w, h] of [
      [1440, 900],
      [720, 900],
      [420, 800],
    ] as const) {
      await page.setViewport({ width: w, height: h });
      await sleep(240);
      for (const density of ["comfy", "compact"] as const) {
        await setDensity(density);

        const m = await page.evaluate(() => {
          const chip = document.getElementById("stMode");
          const r = chip ? chip.getBoundingClientRect() : null;
          const bar = document.querySelector(".statusbar")!.getBoundingClientRect();
          const words = document.getElementById("stLines")!;
          const cs = chip ? getComputedStyle(chip) : null;
          const cw = getComputedStyle(words);
          return {
            /* the segmented control is not merely hidden — it is not there */
            topbarSeg: !!document.querySelector(".topbar #modeSeg, .topbar .seg.mode"),
            inStatusbar: !!chip && !!chip.closest(".statusbar"),
            text: chip ? chip.textContent!.trim() : null,
            painted: !!r && r.width > 0 && r.height > 0,
            /* inside the bar it belongs to, at every width — a chip that has
               been pushed off the end is not an affordance */
            withinBar: !!r && r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5,
            /* "styled like its neighbours": same size and weight as the line
               count sitting next to it, not a button pretending to be one */
            sameSize: !!cs && cs.fontSize === cw.fontSize,
            sameWeight: !!cs && cs.fontWeight === cw.fontWeight,
            clickable: !!cs && cs.cursor === "pointer",
          };
        });
        const at = `${w}px/${density}`;
        expect(`${at} topbar still has a mode segment: ${m.topbarSeg}`).toBe(`${at} topbar still has a mode segment: false`);
        expect(`${at} chip is in the statusbar: ${m.inStatusbar}`).toBe(`${at} chip is in the statusbar: true`);
        expect(`${at} chip is painted: ${m.painted}`).toBe(`${at} chip is painted: true`);
        expect(`${at} chip stays inside the bar: ${m.withinBar}`).toBe(`${at} chip stays inside the bar: true`);
        expect(`${at} chip says: ${m.text}`).toBe(`${at} chip says: Preview`);
        expect(`${at} chip matches its neighbours (size/weight/cursor): ${m.sameSize}/${m.sameWeight}/${m.clickable}`).toBe(
          `${at} chip matches its neighbours (size/weight/cursor): true/true/true`
        );
      }
    }
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(240);
    await setDensity("comfy");
  }, 120000);

  test("Preview is still what a doc opens in; ⌘E toggles and so does clicking the chip", async () => {
    await app.clickDoc(NAV_DOC);
    const read = () =>
      page.evaluate(() => ({
        raw: document.getElementById("doc")!.classList.contains("raw-mode"),
        mode: document.getElementById("stMode")!.getAttribute("data-mode"),
        text: document.getElementById("stModeTxt")!.textContent,
        title: document.getElementById("stMode")!.getAttribute("title"),
      }));

    const opened = await read();
    expect(`opened in raw-mode: ${opened.raw}`).toBe("opened in raw-mode: false");
    expect(`chip data-mode: ${opened.mode}`).toBe("chip data-mode: preview");
    expect(`chip words: ${opened.text}`).toBe("chip words: Preview");
    /* a single word cannot say both what you are in and what a click does, so
       the title has to — and it has to name the chord as well */
    expect(`title names the chord: ${opened.title!.includes("⌘E")}`).toBe("title names the chord: true");
    expect(`title names the destination: ${opened.title!.includes("Raw")}`).toBe("title names the destination: true");

    await app.chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
    const afterChord = await read();
    expect(`after ⌘E: ${afterChord.mode} / ${afterChord.text}`).toBe("after ⌘E: raw / Raw");

    await app.chord("KeyE");
    await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), { timeout: 5000 });
    expect(`back to: ${(await read()).mode}`).toBe("back to: preview");

    /* …and the chip is a control, not a readout */
    await page.click("#stMode");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
    const afterClick = await read();
    expect(`after clicking the chip: ${afterClick.mode} / ${afterClick.text}`).toBe("after clicking the chip: raw / Raw");
    await page.click("#stMode");
    await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), { timeout: 5000 });
    expect(`after clicking it again: ${(await read()).mode}`).toBe("after clicking it again: preview");
  }, 60000);
});

/* ============================================================
   1b. THE CHORDS THAT SHARE A KEY WITH SOMETHING ELSE

   ⌘/ and ⌘, are two doors to one routed page. ⌘C is the interesting one: it is
   COPY, and this app only gets to have it when the copy would do nothing.

   HOW THE ⌘C ASSERTIONS ARE MEASURED. `page.keyboard.press` cannot test this.
   Measured on this machine's headless shell: Meta+C through puppeteer's
   keyboard fires a keydown and NOTHING else — no `copy` event, clipboard
   untouched — whether or not the page prevents the default, so every assertion
   built on it would pass vacuously. Chrome delivers a real ⌘C as a key event
   carrying the editing COMMAND the shortcut resolved to, and `preventDefault`
   on that event is exactly what suppresses it. So these tests dispatch the key
   with `commands: ["copy"]` over CDP — the same shape the browser itself
   produces — and then read the REAL system clipboard back. Both halves of the
   causal chain were verified against this browser before the tests were
   written: prevented → no `copy` event and an unchanged clipboard; not
   prevented → a `copy` event and the selection on the clipboard.
   ============================================================ */

describe("ux — ⌘/ and ⌘, open Settings; ⌘C toggles chat only when it is not COPY", () => {
  const chatOpenNow = () => page.evaluate(() => document.getElementById("app")!.classList.contains("chat-open"));

  /** the real clipboard, once the permission is granted for this origin */
  async function clipboardSession() {
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions" as any, {
      origin: srv.base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    } as any);
    /* prove the clipboard is REAL before anything depends on it — a browser
       that silently swallows writes would turn "the clipboard did not change"
       into a tautology */
    const real = await page.evaluate(async () => {
      try {
        await navigator.clipboard.writeText("znotes-clip-probe");
        return (await navigator.clipboard.readText()) === "znotes-clip-probe";
      } catch {
        return false;
      }
    });
    expect(`this browser hands over a real clipboard: ${real}`).toBe("this browser hands over a real clipboard: true");
    /* count the copies the BROWSER performs, independently of the clipboard */
    await page.evaluate(() => {
      (window as any).__copies = 0;
      document.addEventListener("copy", () => ((window as any).__copies as number)++);
    });
    return cdp;
  }

  const copies = () => page.evaluate(() => (window as any).__copies as number);
  const clip = () => page.evaluate(() => navigator.clipboard.readText().catch(() => "<unreadable>"));
  const setClip = (t: string) => page.evaluate((s) => navigator.clipboard.writeText(s), t);

  /** ⌘C exactly as Chrome delivers one (see the block comment above) */
  async function cmdC(cdp: Awaited<ReturnType<typeof clipboardSession>>) {
    const key = { modifiers: 4, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 };
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "rawKeyDown", commands: ["copy"], ...key } as any);
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "keyUp", ...key } as any);
    await sleep(220);
  }

  test("⌘/ opens Settings, and ⌘, still does", async () => {
    expect(`starts on settings: ${await onSettings()}`).toBe("starts on settings: false");

    await app.chord("Slash");
    await waitSettings(true);
    expect(`⌘/ → route: ${await onSettings()} url: ${await app.urlPath()}`).toBe("⌘/ → route: true url: /settings");
    /* the PAGE, not a modal: no veil went up and Esc is not a way out of it */
    expect(`⌘/ raised a veil: ${await page.evaluate(() => !!document.querySelector(".veil.show"))}`).toBe(
      "⌘/ raised a veil: false"
    );

    await leaveSettings();
    expect(`back off settings: ${await onSettings()}`).toBe("back off settings: false");

    await app.chord("Comma");
    await waitSettings(true);
    expect(`⌘, → route: ${await onSettings()} url: ${await app.urlPath()}`).toBe("⌘, → route: true url: /settings");
  }, 60000);

  test("⌘C with nothing focused and nothing selected toggles the chat panel — and copies nothing", async () => {
    const cdp = await clipboardSession();
    await setClip("UNTOUCHED");
    await app.clickDoc(NAV_DOC);
    /* clickDoc leaves the pick on a sidebar row, not in a field, and nothing is
       selected — the exact state in which ⌘C means nothing to the browser */
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      getSelection()?.removeAllRanges();
    });
    const before = await chatOpenNow();

    await cmdC(cdp);
    expect(`chat toggled: ${before} → ${await chatOpenNow()}`).toBe(`chat toggled: ${before} → ${!before}`);
    expect(`copies the browser performed: ${await copies()}`).toBe("copies the browser performed: 0");
    expect(`clipboard: ${await clip()}`).toBe("clipboard: UNTOUCHED");

    /* …and back, so it is a toggle and not a one-way trip */
    await cmdC(cdp);
    expect(`chat toggled back: ${await chatOpenNow()}`).toBe(`chat toggled back: ${before}`);
  }, 60000);

  test("⌘C with text selected in the doc COPIES and leaves the chat alone", async () => {
    const cdp = await clipboardSession();
    await setClip("UNTOUCHED");
    await app.clickDoc(NAV_DOC);
    await page.waitForSelector("#doc p", { timeout: 5000 });

    const want = await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const p = document.querySelector("#doc p")!;
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      return String(s);
    });
    expect(`there is something to copy: ${want.length > 10}`).toBe("there is something to copy: true");
    const before = await chatOpenNow();

    await cmdC(cdp);
    expect(`copies the browser performed: ${await copies()}`).toBe("copies the browser performed: 1");
    expect(`clipboard === the selection: ${(await clip()) === want}`).toBe("clipboard === the selection: true");
    expect(`chat stayed put: ${await chatOpenNow()}`).toBe(`chat stayed put: ${before}`);
  }, 60000);

  test("⌘C inside the raw editor and inside the chat composer copies, and never toggles", async () => {
    const cdp = await clipboardSession();
    await app.clickDoc(NAV_DOC);

    /* ---- the RAW textarea ---- */
    await app.chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
    await setClip("UNTOUCHED");
    const rawWant = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(0, 24);
      return ta.value.slice(0, 24);
    });
    let before = await chatOpenNow();
    await cmdC(cdp);
    expect(`raw: focused element is still the textarea: ${await page.evaluate(() => document.activeElement!.id)}`).toBe(
      "raw: focused element is still the textarea: rawArea"
    );
    expect(`raw: clipboard === the selected source: ${(await clip()) === rawWant}`).toBe(
      "raw: clipboard === the selected source: true"
    );
    expect(`raw: chat stayed put: ${await chatOpenNow()}`).toBe(`raw: chat stayed put: ${before}`);

    await app.chord("KeyE");
    await page.waitForFunction(() => !document.getElementById("doc")!.classList.contains("raw-mode"), { timeout: 5000 });

    /* ---- the CHAT COMPOSER ---- */
    await page.evaluate(() => {
      const app = document.getElementById("app")!;
      if (!app.classList.contains("chat-open")) (document.querySelector("#chatBtn") as HTMLElement).click();
    });
    await setClip("UNTOUCHED");
    const draft = "a draft nobody should lose";
    await page.evaluate((t) => {
      const c = document.getElementById("composer") as HTMLTextAreaElement;
      c.value = t;
      c.focus();
      c.setSelectionRange(0, t.length);
    }, draft);
    before = await chatOpenNow();
    await cmdC(cdp);
    expect(`composer: clipboard === the draft: ${(await clip()) === draft}`).toBe("composer: clipboard === the draft: true");
    expect(`composer: chat stayed open: ${await chatOpenNow()}`).toBe(`composer: chat stayed open: ${before}`);
    expect(`composer: draft intact: ${await page.evaluate(() => (document.getElementById("composer") as HTMLTextAreaElement).value)}`).toBe(
      `composer: draft intact: ${draft}`
    );
  }, 90000);

  test("a focused field with NOTHING selected still keeps ⌘C to itself", async () => {
    /* the case the guard would get wrong if it only tested the selection: an
       empty search box has nothing to copy, but ⌘C there is still the field's
       key, not the app's */
    const cdp = await clipboardSession();
    await app.chord("KeyK");
    await page.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), { timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.tagName === "INPUT", { timeout: 5000 });
    const before = await chatOpenNow();

    await cmdC(cdp);
    expect(`palette still up: ${await veilOpen("palVeil")}`).toBe("palette still up: true");
    expect(`chat stayed put: ${await chatOpenNow()}`).toBe(`chat stayed put: ${before}`);
  }, 60000);

  test("⌘J is still the unconditional toggle, selection or not", async () => {
    await app.clickDoc(NAV_DOC);
    await page.waitForSelector("#doc p", { timeout: 5000 });
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#doc p")!);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    const before = await chatOpenNow();
    await app.chord("KeyJ");
    await sleep(120);
    expect(`⌘J with a live selection: ${before} → ${await chatOpenNow()}`).toBe(`⌘J with a live selection: ${before} → ${!before}`);
  }, 60000);
});

/* ============================================================
   1b. THE WHOLE-LINE CLIPBOARD

   With nothing selected, ⌘X takes the line — the convention every code editor
   has kept since `dd`. It belongs beside the ⌘C block above because it claims
   the same two chords, in the one place they were previously dead: inside the
   raw textarea with a COLLAPSED caret, where the browser has nothing to copy
   and `typing()` has already kept the chat toggle off them.

   Measured on the document, the caret and the real clipboard rather than on
   the handler, and each case is one a person actually meets: a line in the
   middle, the last line of a file with no trailing newline, the only line, a
   live selection (which must stay the browser's), and the round trip back
   through ⌘V.

   The clipboard here is the SYSTEM one — same grant, same realness probe as
   the ⌘C block — because "we called copyText" is not the claim. The claim is
   that the line is on the clipboard.
   ============================================================ */

describe("ux — ⌘X and ⌘C take the whole line when nothing is selected", () => {
  const LINES = "alpha\nbravo\ncharlie";
  /* Its OWN doc, not the shared seed: every test here leaves a mutilated
     buffer behind, and the autosave debounce is live — a slow run would put
     one of them on disk under a doc the suites after this read. */
  const LINE_DOC = "architecture/line-clipboard.md";

  async function realClipboard() {
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions" as any, {
      origin: srv.base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    } as any);
    const real = await page.evaluate(async () => {
      try {
        await navigator.clipboard.writeText("znotes-line-probe");
        return (await navigator.clipboard.readText()) === "znotes-line-probe";
      } catch {
        return false;
      }
    });
    expect(`this browser hands over a real clipboard: ${real}`).toBe("this browser hands over a real clipboard: true");
  }

  /** Put known source in the textarea with the caret at `pos`, bypassing the
      keyboard: what is being measured is the chord, not how the text got there.

      The `input` event is dispatched and then waited out, because the app's
      undo timeline (ADR 0014) learns a document's text from that event — a
      value assigned behind its back would leave ⌘Z pointing at the text this
      doc had before the fixture ran. */
  const seed = async (value: string, pos: number) => {
    await page.evaluate(
      ({ value, pos }) => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        ta.value = value;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      },
      { value, pos }
    );
    await sleep(850); // past the run's idle window, so the fixture is its own entry
  };

  const read = async () => ({
    ...(await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      return { value: ta.value, caret: ta.selectionStart };
    })),
    clip: await page.evaluate(() => navigator.clipboard.readText().catch(() => "<unreadable>")),
  });

  const cut = () => app.chord("KeyX");

  /* UNDO AND REDO, as Chrome actually delivers them.

     `page.keyboard.press` cannot test these for the same reason it cannot test
     ⌘C (see the block above): Chrome resolves the chord to an editing COMMAND
     and hands the renderer that, and puppeteer's plain key event carries no
     command, so ⌘Z through it is a no-op whatever the page does. Dispatched
     over CDP with `commands`, the way the browser itself produces them. */
  async function editingCommand(name: "undo" | "redo") {
    const cdp = await page.createCDPSession();
    const key = { modifiers: name === "redo" ? 12 : 4, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 };
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "rawKeyDown", commands: [name], ...key } as any);
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "keyUp", ...key } as any);
    await sleep(180);
    await cdp.detach().catch(() => {});
  }

  beforeAll(async () => {
    await srv.api("POST", "/api/docs", { path: LINE_DOC, type: "doc", markdown: LINES + "\n" });
  });

  beforeEach(async () => {
    await app.clickDoc(LINE_DOC);
    await page.waitForSelector("#rawArea, #doc", { timeout: 5000 });
    if (await page.evaluate(() => document.getElementById("stMode")!.dataset.mode !== "raw")) await app.chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
  });

  test("⌘X on a line in the middle takes the line and its newline, and parks at column 0", async () => {
    await realClipboard();
    await seed(LINES, 7); // column 1 of "bravo"
    await cut();

    const got = await read();
    expect(`the line left the document: ${JSON.stringify(got.value)}`).toBe(
      'the line left the document: "alpha\\ncharlie"'
    );
    /* terminated on the clipboard even though what was cut is one line: it is
       what makes ⌘V put a LINE back rather than fusing with its landing site */
    expect(`the clipboard holds the terminated line: ${JSON.stringify(got.clip)}`).toBe(
      'the clipboard holds the terminated line: "bravo\\n"'
    );
    /* the START of whatever moved up into that row — "charlie" — not the
       column the caret held, which in an outline drops you inside the next
       bullet's text */
    expect(`the caret is at the start of the line below: ${got.caret}`).toBe(
      "the caret is at the start of the line below: 6"
    );
    /* and it went through the ordinary edit path, so the buffer is dirty */
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
      timeout: 5000,
    });
  }, 60000);

  test("⌘X on the LAST line takes the newline before it, leaving no blank behind", async () => {
    await realClipboard();
    await seed(LINES, 13); // column 1 of "charlie", which has no newline of its own
    await cut();

    const got = await read();
    expect(`no trailing blank line: ${JSON.stringify(got.value)}`).toBe('no trailing blank line: "alpha\\nbravo"');
    expect(`the clipboard is still a terminated line: ${JSON.stringify(got.clip)}`).toBe(
      'the clipboard is still a terminated line: "charlie\\n"'
    );
    expect(`the caret fell to the start of the line above: ${got.caret}`).toBe(
      "the caret fell to the start of the line above: 6"
    );
  }, 60000);

  test("⌘X on the only line empties the document rather than half-deleting it", async () => {
    await realClipboard();
    await seed("solo", 2);
    await cut();

    const got = await read();
    expect(`document: ${JSON.stringify(got.value)} caret: ${got.caret}`).toBe('document: "" caret: 0');
    expect(`clipboard: ${JSON.stringify(got.clip)}`).toBe('clipboard: "solo\\n"');
  }, 60000);

  test("⌘C takes the line without touching the document or the caret", async () => {
    await realClipboard();
    await seed(LINES, 7);
    await page.evaluate(() => navigator.clipboard.writeText("UNTOUCHED"));
    await app.chord("KeyC");
    await sleep(200);

    const got = await read();
    expect(`the document is untouched: ${JSON.stringify(got.value)}`).toBe(
      'the document is untouched: "alpha\\nbravo\\ncharlie"'
    );
    expect(`the caret is untouched: ${got.caret}`).toBe("the caret is untouched: 7");
    expect(`the clipboard holds the line: ${JSON.stringify(got.clip)}`).toBe(
      'the clipboard holds the line: "bravo\\n"'
    );
  }, 60000);

  test("a live SELECTION is still the browser's ⌘X — we never intercept it", async () => {
    await seed(LINES, 0);
    const prevented = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      ta.setSelectionRange(6, 11); // "bravo", selected
      const ev = new KeyboardEvent("keydown", { key: "x", code: "KeyX", metaKey: true, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, value: ta.value };
    });
    expect(`the app prevented the browser's cut: ${prevented.defaultPrevented}`).toBe(
      "the app prevented the browser's cut: false"
    );
    expect(`and changed the document behind it: ${prevented.value !== LINES}`).toBe(
      "and changed the document behind it: false"
    );
  }, 60000);

  test("⌘V of a cut line puts a LINE back — above the caret's line, caret riding with its own text", async () => {
    await realClipboard();
    await seed(LINES, 7);
    await cut(); // "alpha\ncharlie", clipboard "bravo\n", caret at column 1 of "charlie"

    const back = await page.evaluate(async () => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      const text = await navigator.clipboard.readText();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      /* the browser's own paste event, carrying the browser's own clipboard —
         the app decides from the DATA whether this is a line paste */
      ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return { value: ta.value, caret: ta.selectionStart };
    });
    expect(`the line went back where it came from: ${JSON.stringify(back.value)}`).toBe(
      'the line went back where it came from: "alpha\\nbravo\\ncharlie"'
    );
    expect(`the caret rode down with its own line: ${back.caret}`).toBe("the caret rode down with its own line: 12");
  }, 60000);

  test("⌘V of anything ELSE is an ordinary paste", async () => {
    await seed(LINES, 7);
    const ordinary = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      const dt = new DataTransfer();
      dt.setData("text/plain", "from another app");
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, value: ta.value };
    });
    expect(`the app took the paste: ${ordinary.defaultPrevented}`).toBe("the app took the paste: false");
    expect(`the document is the browser's to change: ${JSON.stringify(ordinary.value)}`).toBe(
      'the document is the browser\'s to change: "alpha\\nbravo\\ncharlie"'
    );
  }, 60000);

  test("⌘Z gets the cut line back and ⌘⇧Z takes it away again", async () => {
    await seed(LINES, 7);
    await cut();
    expect(`cut: ${JSON.stringify((await read()).value)}`).toBe('cut: "alpha\\ncharlie"');

    await editingCommand("undo");
    expect(`⌘Z: ${JSON.stringify((await read()).value)}`).toBe('⌘Z: "alpha\\nbravo\\ncharlie"');

    await editingCommand("redo");
    expect(`⌘⇧Z: ${JSON.stringify((await read()).value)}`).toBe('⌘⇧Z: "alpha\\ncharlie"');
  }, 60000);

  test("the app follows the undo — ⌘S after ⌘Z writes the text that is on screen", async () => {
    /* The failure this exists for: the app caches the buffer in `doc.markdown`
       and saves THAT. An undo the app never heard about would leave the cache
       holding text the user rewound away from, and ⌘S would put it back on
       disk under them. The undo's native `input` event (`historyUndo`) is what
       keeps the two in step; this asserts the outcome, on disk. */
    await seed(LINES, 7);
    await cut();
    await editingCommand("undo");
    await app.chord("KeyS");

    const onDisk = await waitUntil(
      () => {
        const t = readVaultText(srv.vault, LINE_DOC);
        return t.includes("bravo") ? t : null;
      },
      { timeout: 8000, label: "⌘S after ⌘Z to reach disk" }
    );
    const inBuffer = (await read()).value;
    expect(`what reached disk is what is on screen: ${onDisk === inBuffer}`).toBe(
      "what reached disk is what is on screen: true"
    );
    expect(`and the line the undo restored is in it: ${onDisk.includes("bravo")}`).toBe(
      "and the line the undo restored is in it: true"
    );
  }, 60000);

  test("the other structural edits are on the same stack — Tab and the list continuation both undo", async () => {
    /* Not incidental to the cut: every edit this pane makes goes through the
       browser's editing command for exactly this reason, so one of the older
       ones is asserted here too. A regression that reached for `setRangeText`
       again would take ⌘Z away from all of them at once. */
    await seed("- alpha\n- bravo\n", 3);
    await page.keyboard.press("Tab");
    await sleep(150);
    expect(`Tab indented: ${JSON.stringify((await read()).value)}`).toBe('Tab indented: "  - alpha\\n- bravo\\n"');
    await editingCommand("undo");
    expect(`⌘Z: ${JSON.stringify((await read()).value)}`).toBe('⌘Z: "- alpha\\n- bravo\\n"');

    await seed("- alpha\n", 7);
    await page.keyboard.press("Enter");
    await sleep(150);
    expect(`Enter continued the list: ${JSON.stringify((await read()).value)}`).toBe(
      'Enter continued the list: "- alpha\\n- \\n"'
    );
    await editingCommand("undo");
    expect(`⌘Z: ${JSON.stringify((await read()).value)}`).toBe('⌘Z: "- alpha\\n"');
  }, 60000);

  afterAll(async () => {
    await srv.api("DELETE", "/api/docs/" + encPath(LINE_DOC)).catch(() => {});
  });
});

/* ============================================================
   1c. FILE-OPERATION UNDO

   ⌘Z outside a text surface takes back the last FILE operation — a delete
   undoes to a restore, a create undoes to a delete — and ⌘⇧Z puts it forward
   again. Every direction ASKS first, which is the part worth measuring: these
   move a file on disk, through git, on a path another device may be looking
   at, and the chord is one keystroke from one people press reflexively.

   The three things that could go wrong are each a test here: it must not
   shadow the editor's own ⌘Z (which is the textarea's, ADR 0013) even when a
   file undo is pending; it must not swallow the chord when it has nothing to
   do with it; and a prompt the user declines must leave the undo still on
   offer rather than spending it.
   ============================================================ */

describe("ux — ⌘Z takes back a file operation, after asking", () => {
  const UNDO_DOC = "architecture/file-undo.md";
  const UNDO_TEXT = "# File undo\n\nthe body that has to come back with it\n";

  const docsInTree = () =>
    page.evaluate(() => [...document.querySelectorAll("#tree .row.file")].map((r) => (r as HTMLElement).dataset.doc));
  const confirmUp = () => page.evaluate(() => document.getElementById("cfVeil")!.classList.contains("show"));
  const prompt = () =>
    page.evaluate(() => ({
      title: document.getElementById("cfTitle")!.textContent,
      path: document.getElementById("cfPath")!.textContent,
      ok: document.getElementById("cfOkTxt")!.textContent,
      danger: document.getElementById("cfOk")!.classList.contains("danger"),
      body: document.getElementById("cfBody")!.textContent,
    }));

  /** ⌘Z / ⌘⇧Z with focus deliberately OUTSIDE any text surface. */
  async function fileZ(redo = false) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down("Meta");
    if (redo) await page.keyboard.down("Shift");
    await page.keyboard.press("KeyZ");
    if (redo) await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    await sleep(300);
  }
  const confirm = async () => {
    await page.click('[data-act="cf-ok"]');
    await sleep(900);
  };
  const dismiss = async () => {
    await page.click('[data-act="cf-cancel"]');
    await sleep(200);
  };
  async function ensureRaw() {
    await page.waitForSelector("#stMode", { timeout: 5000 });
    if (await page.evaluate(() => document.getElementById("stMode")!.dataset.mode !== "raw")) await app.chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
  }

  /** delete it the way a person does: the row's own trash affordance */
  async function deleteFromTree(path: string) {
    await page.evaluate((t) => {
      const row = document.querySelector(`#tree .row.file[data-doc="${t}"]`);
      (row?.parentElement?.querySelector(".rowact:last-child") as HTMLElement)?.click();
    }, path);
    await sleep(300);
    await confirm();
  }

  /** A real Chromium pointer drag. Moving through several intermediate points is
      what makes the browser cross its native drag threshold; synthetic
      DragEvents would prove only that a listener can be called.

      `dwell` parks the pointer over another row on the way, long enough for
      hover-to-expand to fire — so the destination row is looked up AFTER it,
      because it may not have been on screen when the drag started. */
  async function dragTreeRow(from: string, onto: string, opts: { dwell?: string; dwellMs?: number } = {}) {
    const center = async (path: string) => {
      const row = await page.$(`#tree .row[data-path="${path}"]`);
      const box = row && (await row.boundingBox());
      if (!box) throw new Error(`drag fixture missing or not visible: ${path}`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const a = await center(from);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    let expanded = false;
    if (opts.dwell) {
      const d = await center(opts.dwell);
      await page.mouse.move(d.x, d.y, { steps: 12 });
      await sleep(opts.dwellMs ?? 900);
      expanded = await page.$eval(
        `#tree .row[data-path="${opts.dwell}"]`,
        (el) => !(el.parentElement!.nextElementSibling as HTMLElement).classList.contains("closed")
      );
    }
    const b = await center(onto);
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await sleep(100);
    const marks = await page.$eval(`#tree .row[data-path="${onto}"]`, (el) => ({
      target: el.classList.contains("drop-target"),
      blocked: el.classList.contains("drop-blocked"),
    }));
    await page.mouse.up();
    return { ...marks, expanded };
  }

  const waitMoveToast = (from: string, to: string) =>
    page.waitForFunction(
      (a, b) => {
        const text = document.getElementById("toastTxt")?.textContent || "";
        return text.includes(a as string) && text.includes(b as string);
      },
      { timeout: 10000 },
      from,
      to
    );

  beforeEach(async () => {
    await srv.api("POST", "/api/docs", { path: UNDO_DOC, type: "doc", markdown: UNDO_TEXT }).catch(() => {});
    await app.clickDoc(NAV_DOC);
    await page.waitForFunction(() => !!document.querySelector("#tree .row.file"), { timeout: 5000 });
  });

  test("a delete undoes to a restore — with the file's contents, not an empty file", async () => {
    await deleteFromTree(UNDO_DOC);
    expect(`the doc is gone from the tree: ${!(await docsInTree()).includes(UNDO_DOC)}`).toBe(
      "the doc is gone from the tree: true"
    );

    await fileZ();
    expect(`⌘Z asks before it acts: ${JSON.stringify(await prompt())}`).toBe(
      `⌘Z asks before it acts: ${JSON.stringify({
        title: "Restore doc",
        path: UNDO_DOC,
        ok: "Restore",
        /* CONSTRUCTIVE, so it must not wear the destructive chrome: a red
           button under a warning triangle over an action that puts a file
           BACK says the opposite of what the button does */
        danger: false,
        body: "Undo — put back the doc you deleted.",
      })}`
    );

    await confirm();
    expect(`the doc is back: ${(await docsInTree()).includes(UNDO_DOC)}`).toBe("the doc is back: true");
    /* the bytes, not just the name — a restore that re-created an empty file
       at the same path would pass every assertion above */
    expect(`with its contents: ${readVaultText(srv.vault, UNDO_DOC) === UNDO_TEXT}`).toBe("with its contents: true");
  }, 90000);

  test("⌘⇧Z deletes it again, and asks with the destructive chrome this time", async () => {
    await deleteFromTree(UNDO_DOC);
    await fileZ();
    await confirm();
    expect(`restored first: ${(await docsInTree()).includes(UNDO_DOC)}`).toBe("restored first: true");

    await fileZ(true);
    const p = await prompt();
    expect(`⌘⇧Z asks: ${p.title} / ${p.ok} / danger=${p.danger} / ${p.body}`).toBe(
      "⌘⇧Z asks: Delete doc / Delete / danger=true / Redo — delete it again."
    );
    await confirm();
    expect(`gone again: ${!(await docsInTree()).includes(UNDO_DOC)}`).toBe("gone again: true");
  }, 90000);

  test("declining the prompt leaves the undo on offer instead of spending it", async () => {
    await deleteFromTree(UNDO_DOC);

    await fileZ();
    await dismiss();
    expect(`Cancel left it deleted: ${!(await docsInTree()).includes(UNDO_DOC)}`).toBe("Cancel left it deleted: true");

    /* the entry is still on the stack — the undo was declined, not used */
    await fileZ();
    expect(`⌘Z still offers the restore: ${await confirmUp()}`).toBe("⌘Z still offers the restore: true");
    await confirm();
    expect(`and it restores: ${(await docsInTree()).includes(UNDO_DOC)}`).toBe("and it restores: true");
  }, 90000);

  test("a create undoes to a delete", async () => {
    const made = "architecture/file-undo-created.md";
    await srv.api("DELETE", "/api/docs/" + encPath(made)).catch(() => {});
    await page.evaluate(() => (document.querySelector('[data-act="new-doc"]') as HTMLElement)?.click());
    await page.waitForSelector(".newrow input", { timeout: 5000 });
    await page.type(".newrow input", "file-undo-created");
    await page.keyboard.press("Enter");
    await page.waitForFunction((m) => !!document.querySelector(`#tree .row.file[data-doc="${m}"]`), { timeout: 8000 }, made);

    await fileZ();
    const p = await prompt();
    expect(`⌘Z on a create asks to delete: ${p.title} / ${p.ok} / danger=${p.danger} / ${p.body}`).toBe(
      "⌘Z on a create asks to delete: Delete doc / Delete / danger=true / Undo — remove the doc you created."
    );
    await confirm();
    expect(`the new doc is gone: ${!(await docsInTree()).includes(made)}`).toBe("the new doc is gone: true");
  }, 90000);

  test("dragging a doc onto another doc moves it to that parent, then undo and redo move it back and forward", async () => {
    const from = "architecture/file-drag.md";
    const to = "projects/file-drag.md";
    const onto = "projects/homelab.md";
    const markdown = "# File drag\n\nbytes that must survive both directions\n";
    await srv.api("DELETE", "/api/docs/" + encPath(from)).catch(() => {});
    await srv.api("DELETE", "/api/docs/" + encPath(to)).catch(() => {});
    try {
      expect((await srv.api("POST", "/api/docs", { path: from, type: "doc", markdown })).status).toBe(201);
      await page.waitForSelector(`#tree .row.file[data-doc="${from}"]`, { timeout: 8000 });
      await app.clickDoc(from);

      expect(`the source is a native drag source: ${await page.$eval(`#tree .row.file[data-doc="${from}"]`, (el) => (el as HTMLElement).draggable)}`).toBe(
        "the source is a native drag source: true"
      );
      expect(`the same-parent drop is rejected: ${(await dragTreeRow(from, "architecture/z-notes-design.md")).target}`).toBe(
        "the same-parent drop is rejected: false"
      );
      expect(`a rejected no-op moved nothing: ${vaultHas(srv.vault, from) && !vaultHas(srv.vault, to)}`).toBe(
        "a rejected no-op moved nothing: true"
      );
      expect(`the destination advertises the drop: ${(await dragTreeRow(from, onto)).target}`).toBe(
        "the destination advertises the drop: true"
      );
      await page.waitForSelector(`#tree .row.file[data-doc="${to}"]`, { timeout: 10000 });
      await app.settled(to);
      /* The SSE echo can re-home the pane before the initiating PATCH resolves;
         the local completion toast is after the history entry was recorded. */
      await waitMoveToast(from, to);
      expect(`the old path is gone: ${!vaultHas(srv.vault, from)}`).toBe("the old path is gone: true");
      expect(`the moved bytes survived: ${readVaultText(srv.vault, to) === markdown}`).toBe("the moved bytes survived: true");

      await fileZ();
      expect(`undo asks to move back: ${JSON.stringify(await prompt())}`).toBe(
        `undo asks to move back: ${JSON.stringify({
          title: "Move doc",
          path: to,
          ok: "Move",
          danger: false,
          body: "Undo — move it back to " + from + ".",
        })}`
      );
      await confirm();
      await page.waitForSelector(`#tree .row.file[data-doc="${from}"]`, { timeout: 10000 });
      await app.settled(from);
      expect(`undo restored the original path: ${vaultHas(srv.vault, from) && !vaultHas(srv.vault, to)}`).toBe(
        "undo restored the original path: true"
      );

      await fileZ(true);
      expect(`redo asks to move forward: ${JSON.stringify(await prompt())}`).toBe(
        `redo asks to move forward: ${JSON.stringify({
          title: "Move doc",
          path: from,
          ok: "Move",
          danger: false,
          body: "Redo — move it again to " + to + ".",
        })}`
      );
      await confirm();
      await page.waitForSelector(`#tree .row.file[data-doc="${to}"]`, { timeout: 10000 });
      await app.settled(to);
      expect(`redo restored the moved path: ${!vaultHas(srv.vault, from) && vaultHas(srv.vault, to)}`).toBe(
        "redo restored the moved path: true"
      );
      expect(`the bytes survived redo: ${readVaultText(srv.vault, to) === markdown}`).toBe("the bytes survived redo: true");
    } finally {
      await srv.api("DELETE", "/api/docs/" + encPath(from)).catch(() => {});
      await srv.api("DELETE", "/api/docs/" + encPath(to)).catch(() => {});
    }
  }, 120000);

  test("a folder drags with its subtree, into a collapsed destination the dwell opened, and undo and redo move it back and forward", async () => {
    const src = "dragfolder";
    const dest = "dragdest";
    const leaf = src + "/leaf.md";
    const moved = dest + "/" + leaf;
    const anchor = dest + "/anchor.md";
    const markdown = "# Leaf\n\nsubtree bytes that must survive both directions\n";
    const clean = async () => {
      for (const p of [moved, leaf, anchor, dest + "/" + src, src, dest]) {
        await srv.api("DELETE", "/api/docs/" + encPath(p)).catch(() => {});
      }
    };
    await clean();
    try {
      expect((await srv.api("POST", "/api/docs", { path: leaf, type: "doc", markdown })).status).toBe(201);
      expect((await srv.api("POST", "/api/docs", { path: anchor, type: "doc", markdown: "# Anchor\n" })).status).toBe(201);
      await page.waitForSelector(`#tree .row.folder[data-path="${src}"]`, { timeout: 8000 });
      await page.waitForSelector(`#tree .row.file[data-doc="${anchor}"]`, { timeout: 8000 });

      expect(`a folder row is a native drag source: ${await page.$eval(`#tree .row.folder[data-path="${src}"]`, (el) => (el as HTMLElement).draggable)}`).toBe(
        "a folder row is a native drag source: true"
      );

      /* Close the destination, so the only way to reach the child row inside it
         is the dwell — a drop on a `display:none` row has no box to aim at. */
      await page.click(`#tree .row.folder[data-path="${dest}"]`);
      expect(`the destination starts closed: ${await page.$eval(`#tree .row.folder[data-path="${dest}"]`, (el) => (el.parentElement!.nextElementSibling as HTMLElement).classList.contains("closed"))}`).toBe(
        "the destination starts closed: true"
      );

      const marks = await dragTreeRow(src, anchor, { dwell: dest });
      expect(`hovering the closed destination opened it mid-drag: ${marks.expanded}`).toBe(
        "hovering the closed destination opened it mid-drag: true"
      );
      expect(`the revealed child advertises the drop: ${marks.target}`).toBe("the revealed child advertises the drop: true");

      await page.waitForSelector(`#tree .row.file[data-doc="${moved}"]`, { timeout: 10000 });
      await waitMoveToast(src, dest + "/" + src);
      expect(`the folder left its old place: ${!vaultHas(srv.vault, leaf)}`).toBe("the folder left its old place: true");
      /* the subtree's bytes at the new path — a folder move that re-created the
         tree empty would satisfy every assertion above */
      expect(`the subtree travelled with it: ${readVaultText(srv.vault, moved) === markdown}`).toBe(
        "the subtree travelled with it: true"
      );

      await fileZ();
      expect(`undo asks to move the folder back: ${JSON.stringify(await prompt())}`).toBe(
        `undo asks to move the folder back: ${JSON.stringify({
          title: "Move folder",
          path: dest + "/" + src,
          ok: "Move",
          danger: false,
          body: "Undo — move it back to " + src + ".",
        })}`
      );
      await confirm();
      await page.waitForSelector(`#tree .row.file[data-doc="${leaf}"]`, { timeout: 10000 });
      expect(`undo restored the subtree: ${readVaultText(srv.vault, leaf) === markdown && !vaultHas(srv.vault, moved)}`).toBe(
        "undo restored the subtree: true"
      );

      await fileZ(true);
      expect(`redo asks to move it forward: ${(await prompt()).body}`).toBe(
        "redo asks to move it forward: Redo — move it again to " + dest + "/" + src + "."
      );
      await confirm();
      await page.waitForSelector(`#tree .row.file[data-doc="${moved}"]`, { timeout: 10000 });
      expect(`redo moved the subtree forward again: ${readVaultText(srv.vault, moved) === markdown && !vaultHas(srv.vault, leaf)}`).toBe(
        "redo moved the subtree forward again: true"
      );
    } finally {
      await clean();
    }
  }, 150000);

  test("a folder dropped inside itself is refused in the tree, without a request and without a timeline entry", async () => {
    const src = "dragself";
    const inner = src + "/inner/leaf.md";
    const clean = async () => {
      for (const p of [inner, src + "/inner", src]) await srv.api("DELETE", "/api/docs/" + encPath(p)).catch(() => {});
    };
    await clean();
    let patches = 0;
    const countPatch = (r: HTTPRequest) => {
      if (r.method() === "PATCH" && r.url().includes("/api/docs/")) patches++;
    };
    page.on("request", countPatch);
    try {
      expect((await srv.api("POST", "/api/docs", { path: inner, type: "doc", markdown: "# Inner\n" })).status).toBe(201);
      await page.waitForSelector(`#tree .row.file[data-doc="${inner}"]`, { timeout: 8000 });

      /* The doc row means its parent folder, which is inside the folder being
         dragged — the same refusal as dropping the folder on its own row. */
      const marks = await dragTreeRow(src, inner);
      expect(`the descendant is painted blocked, not eligible: ${marks.blocked} / ${marks.target}`).toBe(
        "the descendant is painted blocked, not eligible: true / false"
      );
      await page.waitForFunction(
        () => document.getElementById("toastTxt")!.textContent === "A folder cannot be moved inside itself",
        { timeout: 3000 }
      );
      expect(`the refusal sent no move: ${patches}`).toBe("the refusal sent no move: 0");
      expect(`the subtree is untouched: ${readVaultText(srv.vault, inner) === "# Inner\n"}`).toBe(
        "the subtree is untouched: true"
      );

      /* a refused drag is not an operation, so there is nothing to take back */
      await fileZ();
      expect(`⌘Z found nothing on the timeline: ${await confirmUp()}`).toBe("⌘Z found nothing on the timeline: false");
    } finally {
      page.off("request", countPatch);
      await clean();
    }
  }, 120000);

  test("the editor keeps its own ⌘Z, even with a file undo pending", async () => {
    /* THE COLLISION THIS FEATURE COULD HAVE CAUSED. A pending file undo plus a
       caret in the Raw textarea is the state where a greedy binding would eat
       the text undo — and the user would get a dialog about a file they were
       not thinking about instead of their last keystroke back. */
    await deleteFromTree(UNDO_DOC);
    await app.clickDoc(NAV_DOC);
    await ensureRaw();
    await page.click("#rawArea");
    await page.keyboard.type("ZZZ");

    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Meta");
    await sleep(300);

    expect(`focus is still the textarea: ${await page.evaluate(() => document.activeElement!.id)}`).toBe(
      "focus is still the textarea: rawArea"
    );
    expect(`a file dialog was raised: ${await confirmUp()}`).toBe("a file dialog was raised: false");
    expect(`the file history was not touched: ${!(await docsInTree()).includes(UNDO_DOC)}`).toBe(
      "the file history was not touched: true"
    );
  }, 90000);

  test("with nothing to undo the chord is left to the browser", async () => {
    /* Swallowing a chord to do nothing with it is how an app takes a key away
       from the platform. `pendingFileOp` is the guard; this is its assertion. */
    await fileZ(true);
    expect(`⌘⇧Z with an empty redo stack raised a dialog: ${await confirmUp()}`).toBe(
      "⌘⇧Z with an empty redo stack raised a dialog: false"
    );
  }, 60000);

  test("Keep editing at the exit guard leaves the undo on offer; Save & exit really spends it", async () => {
    /* THE PATH THAT WEDGES A NAIVE IMPLEMENTATION. Undoing a create is a
       delete, and a delete of the doc you are looking at goes behind the Raw
       exit guard when the buffer differs from disk. `doDelete` returns false
       there to say "not now" — which is NOT the same as "no" — so the timeline
       cannot settle on the return value alone. Keep editing has to report the
       cancellation, and Save & exit has to report the deed.
       Both directions are asserted, because a fix for either one alone breaks
       the other: reporting "did not happen" at defer time makes Save & exit
       delete the file while the timeline stays put. */
    const made = "architecture/guard-undo.md";
    await srv.api("DELETE", "/api/docs/" + encPath(made)).catch(() => {});
    await app.clickDoc(NAV_DOC);
    await page.evaluate(() => (document.querySelector('[data-act="new-doc"]') as HTMLElement)?.click());
    await page.waitForSelector(".newrow input", { timeout: 5000 });
    await page.type(".newrow input", "guard-undo");
    await page.keyboard.press("Enter");
    await page.waitForFunction((m) => !!document.querySelector(`#tree .row.file[data-doc="${m}"]`), { timeout: 8000 }, made);

    /* type, SAVE, then undo the text — which leaves the buffer differing from
       disk, which is what arms the guard for the step after it */
    await ensureRaw();
    await page.click("#rawArea");
    await page.keyboard.type("saved words");
    await sleep(850);
    await app.chord("KeyS");
    await sleep(800);
    await fileZ();
    expect(`the buffer now differs from disk: ${await page.evaluate(() => (document.getElementById("rawArea") as HTMLTextAreaElement).value === "")}`).toBe(
      "the buffer now differs from disk: true"
    );

    /* ---- KEEP EDITING ---- */
    await fileZ();
    await confirm(); // the delete prompt → hands off to the exit guard
    expect(`the exit guard opened: ${await page.evaluate(() => document.getElementById("xgVeil")!.classList.contains("show"))}`).toBe(
      "the exit guard opened: true"
    );
    await page.keyboard.press("Escape"); // Keep editing
    await sleep(600);
    expect(`the doc is still there: ${(await docsInTree()).includes(made)}`).toBe("the doc is still there: true");
    await fileZ();
    expect(`…and ⌘Z still offers the undo: ${await confirmUp()}`).toBe("…and ⌘Z still offers the undo: true");

    /* ---- SAVE & EXIT, from the prompt that is already up ---- */
    await confirm();
    await page.waitForFunction(() => document.getElementById("xgVeil")!.classList.contains("show"), { timeout: 6000 });
    await page.click('[data-act="xg-save"]');
    await sleep(1800);
    expect(`Save & exit deleted it: ${!(await docsInTree()).includes(made)}`).toBe("Save & exit deleted it: true");
    /* the timeline really moved: the entry is on the redo side now */
    await fileZ(true);
    expect(`…and ⌘⇧Z now offers the redo: ${await confirmUp()}`).toBe("…and ⌘⇧Z now offers the redo: true");
    await dismiss();
    await srv.api("DELETE", "/api/docs/" + encPath(made)).catch(() => {});
  }, 120000);

  test("the ? overlay says both chords exist — the binding and the list cannot drift apart", async () => {
    /* The overlay claims to enumerate every global chord, and a binding nobody
       can discover is a binding that does not exist. Asserted here rather than
       trusted, for the same reason ⌘P is asserted where it is. */
    await page.keyboard.press("?");
    await page.waitForFunction(() => document.getElementById("scVeil")!.classList.contains("show"), { timeout: 8000 });
    const joined = (
      await page.$$eval("#scVeil .sc-row", (ns) => ns.map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()))
    ).join(" | ");
    await page.keyboard.press("Escape");
    expect(`the overlay lists the whole-line clipboard: ${/whole line.*⌘X.*⌘C/i.test(joined)}`).toBe(
      "the overlay lists the whole-line clipboard: true"
    );
    expect(`…and undo / redo: ${/undo \/ redo.*⌘Z.*⇧⌘Z/i.test(joined)}`).toBe("…and undo / redo: true");
  }, 60000);

  afterAll(async () => {
    await srv.api("DELETE", "/api/docs/" + encPath(UNDO_DOC)).catch(() => {});
    await srv.api("DELETE", "/api/docs/" + encPath("architecture/file-undo-created.md")).catch(() => {});
  });
});

/* ============================================================
   1d. THE TIMELINE IS ONE LIST, ACROSS DOCUMENTS

   The scenario this exists for, in the order a person does it:

     edit a.md and save · edit b.md and save · delete a.md
     ⌘Z → a.md comes back (asked)
     ⌘Z → b.md's edit comes back, AND the pane goes to b.md
     ⌘Z → a.md's edit comes back, AND the pane goes to a.md

   Every step of it is something the browser's own undo cannot do: its history
   is per-textarea, dies when `renderDoc` builds the next one, and has no way
   to hold a file operation. This is the test that says the app's timeline
   really is one ordered list spanning documents and kinds — and that it takes
   you to the document it is talking about, which is the difference between an
   undo you can see and a file changing behind your back.
   ============================================================ */

describe("ux — one undo timeline across documents and file operations", () => {
  const DIR = "timeline";
  const A = "timeline/a.md";
  const B = "timeline/b.md";
  const A0 = "# A\n\nalpha body\n";
  const B0 = "# B\n\nbravo body\n";

  const at = () => page.evaluate(() => document.getElementById("stPath")!.textContent);
  const buffer = () => page.evaluate(() => (document.getElementById("rawArea") as HTMLTextAreaElement | null)?.value ?? "(not raw)");
  const inTree = (t: string) => page.evaluate((x) => !!document.querySelector(`#tree .row.file[data-doc="${x}"]`), t);
  const confirmUp = () => page.evaluate(() => document.getElementById("cfVeil")!.classList.contains("show"));
  const accept = async () => {
    await page.click('[data-act="cf-ok"]');
    await sleep(1200);
  };

  async function openRaw(path: string) {
    await page.evaluate((t) => (document.querySelector(`#tree .row.file[data-doc="${t}"]`) as HTMLElement)?.click(), path);
    await page.waitForFunction((t) => document.getElementById("stPath")!.textContent === t, { timeout: 8000 }, path);
    if (await page.evaluate(() => document.getElementById("stMode")!.dataset.mode !== "raw")) await app.chord("KeyE");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
  }
  /** type at the very end, then wait past the run's idle window */
  async function appendAndSave(text: string) {
    await page.click("#rawArea");
    await page.evaluate(() => {
      const t = document.getElementById("rawArea") as HTMLTextAreaElement;
      t.setSelectionRange(t.value.length, t.value.length);
    });
    await page.keyboard.type(text);
    await sleep(850);
    await app.chord("KeyS");
    await sleep(800);
  }
  /** ⌘Z / ⌘⇧Z from outside any text surface */
  async function step(redo = false) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down("Meta");
    if (redo) await page.keyboard.down("Shift");
    await page.keyboard.press("KeyZ");
    if (redo) await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    await sleep(900);
  }

  beforeEach(async () => {
    /* create, then WRITE — the create is a no-op after the first test in this
       block, and each test needs the docs at their seeded text, not at
       whatever the previous one saved into them */
    for (const [path, text] of [[A, A0], [B, B0]] as [string, string][]) {
      await srv.api("POST", "/api/docs", { path, type: "doc", markdown: text }).catch(() => {});
      await srv.putDoc(path, text).catch(() => {});
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await app.shown();
    await page.waitForFunction((t) => !!document.querySelector(`#tree .row.file[data-doc="${t}"]`), { timeout: 8000 }, B);
  });

  test("edit a, edit b, delete a — then three ⌘Z walk back through all three, each in its own doc", async () => {
    await openRaw(A);
    await appendAndSave("MARK-A\n");
    await openRaw(B);
    await appendAndSave("MARK-B\n");

    /* delete a.md the way a person does — the row's own affordance */
    await page.evaluate((t) => {
      const row = document.querySelector(`#tree .row.file[data-doc="${t}"]`);
      (row?.parentElement?.querySelector(".rowact:last-child") as HTMLElement)?.click();
    }, A);
    await sleep(300);
    await accept();
    expect(`a.md deleted: ${!(await inTree(A))}`).toBe("a.md deleted: true");

    /* ---- ⌘Z #1: the file operation, and it asks ---- */
    await step();
    expect(`the first ⌘Z asks: ${await confirmUp()}`).toBe("the first ⌘Z asks: true");
    await accept();
    expect(`a.md is back: ${await inTree(A)}`).toBe("a.md is back: true");

    /* ---- ⌘Z #2: b.md's edit, in b.md ---- */
    await step();
    expect(`the second ⌘Z did not ask: ${!(await confirmUp())}`).toBe("the second ⌘Z did not ask: true");
    expect(`…it went to b.md: ${await at()}`).toBe(`…it went to b.md: ${B}`);
    expect(`…and took the edit back: ${(await buffer()) === B0}`).toBe("…and took the edit back: true");

    /* ---- ⌘Z #3: a.md's edit, in a.md — the doc that was deleted and restored
       two steps ago, whose text entry is OLDER than the delete ---- */
    await step();
    expect(`the third ⌘Z went to a.md: ${await at()}`).toBe(`the third ⌘Z went to a.md: ${A}`);
    expect(`…and took its edit back: ${(await buffer()) === A0}`).toBe("…and took its edit back: true");
  }, 180000);

  test("⌘⇧Z walks the same list forward again, doc by doc", async () => {
    await openRaw(A);
    await appendAndSave("MARK-A\n");
    await openRaw(B);
    await appendAndSave("MARK-B\n");
    await step();
    await step();
    expect(`wound back to: ${await at()} ${(await buffer()) === A0}`).toBe(`wound back to: ${A} true`);

    await step(true);
    expect(`⌘⇧Z re-applied a.md, in a.md: ${await at()} ${(await buffer()).includes("MARK-A")}`).toBe(
      `⌘⇧Z re-applied a.md, in a.md: ${A} true`
    );
    await step(true);
    expect(`…then b.md, in b.md: ${await at()} ${(await buffer()).includes("MARK-B")}`).toBe(
      `…then b.md, in b.md: ${B} true`
    );
  }, 180000);

  test("a run of typing is one step, not one per keystroke", async () => {
    /* The granularity a person means by "what I just typed". Without it ⌘Z is
       useless on a sentence and the timeline never reaches the step before. */
    await openRaw(A);
    await page.click("#rawArea");
    await page.evaluate(() => {
      const t = document.getElementById("rawArea") as HTMLTextAreaElement;
      t.setSelectionRange(t.value.length, t.value.length);
    });
    await page.keyboard.type("one two three four");
    await sleep(850);

    await step();
    expect(`one ⌘Z took the whole run: ${(await buffer()) === A0}`).toBe("one ⌘Z took the whole run: true");
  }, 120000);

  afterAll(async () => {
    for (const p of [A, B]) await srv.api("DELETE", "/api/docs/" + encPath(p)).catch(() => {});
    await srv.api("DELETE", "/api/docs/" + encPath(DIR)).catch(() => {});
  });
});

/* ============================================================
   2. ESC LAYERING
   ============================================================ */

describe("ux — Esc unwinds one layer at a time", () => {
  test("a modal over the chat panel takes the first Esc; the panel takes the next", async () => {
    expect(`chat starts open: ${await chatOpen()}`).toBe("chat starts open: true");

    /* the shortcuts overlay is the modal here: Settings moved out of the veil
       stack when it became a page, and only a REAL overlay measures the
       layering this test is about */
    await page.keyboard.down("Shift");
    await page.keyboard.press("Slash");
    await page.keyboard.up("Shift");
    await app.waitVeil("scVeil", true);
    expect(`overlay open, chat open: ${await veilOpen("scVeil")} / ${await chatOpen()}`).toBe(
      "overlay open, chat open: true / true"
    );

    /* ONE press: the modal goes, the panel stays. A handler that closed both
       would pass an "overlay closed" assertion and lose the panel silently. */
    await page.keyboard.press("Escape");
    await app.waitVeil("scVeil", false);
    expect(`after Esc #1 — overlay: ${await veilOpen("scVeil")}, chat: ${await chatOpen()}`).toBe(
      "after Esc #1 — overlay: false, chat: true"
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
    expect(`after Esc #2 — chat: ${await chatOpen()}`).toBe("after Esc #2 — chat: false");
  }, 60000);

  test("the palette, the context menu and Raw-to-Preview each take a press first", async () => {
    await app.clickDoc(NAV_DOC);

    /* the palette */
    await app.chord("KeyK");
    await app.waitVeil("palVeil", true);
    await page.keyboard.press("Escape");
    await app.waitVeil("palVeil", false);
    expect(`palette closed, chat still open: ${await chatOpen()}`).toBe("palette closed, chat still open: true");

    /* the context menu */
    await rightClick(`#tree .row.file[data-doc="${NAV_DOC}"]`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    expect(`menu closed, chat still open: ${await chatOpen()}`).toBe("menu closed, chat still open: true");

    /* Raw mode: a clean buffer exits directly to Preview. */
    await app.chord("KeyE");
    await page.waitForSelector("#rawArea", { timeout: 5000 });
    await page.click("#rawArea");
    expect(`rawArea focused: ${await page.evaluate(() => document.activeElement?.id)}`).toBe(
      "rawArea focused: rawArea"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("stMode")!.dataset.mode === "preview", { timeout: 5000 });
    expect(`Preview active, chat still open: ${await chatOpen()}`).toBe("Preview active, chat still open: true");

    /* only now does the panel go */
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
    expect(`chat finally closed: ${await chatOpen()}`).toBe("chat finally closed: false");
  }, 90000);

  test("Esc mid-sentence costs the focus, not the panel — and never the draft", async () => {
    const DRAFT = "half-written question about the event pipeline";
    await page.click("#composer");
    await page.keyboard.type(DRAFT);
    expect(`typed: ${await page.$eval("#composer", (t) => (t as HTMLTextAreaElement).value)}`).toBe(`typed: ${DRAFT}`);

    /* press ONE: blur. The surface being written on must not vanish under the
       gesture that means "get out of this field". */
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id !== "composer", { timeout: 5000 });
    expect(`after Esc #1 — chat: ${await chatOpen()}, focused: ${await page.evaluate(() => document.activeElement?.id)}`).toBe(
      `after Esc #1 — chat: true, focused: ${await page.evaluate(() => document.activeElement?.id)}`
    );
    expect(`after Esc #1 — chat still open: ${await chatOpen()}`).toBe("after Esc #1 — chat still open: true");
    expect(`draft intact: ${await page.$eval("#composer", (t) => (t as HTMLTextAreaElement).value)}`).toBe(
      `draft intact: ${DRAFT}`
    );

    /* press TWO: the panel */
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
    expect(`draft survives the panel closing: ${await page.$eval("#composer", (t) => (t as HTMLTextAreaElement).value)}`).toBe(
      `draft survives the panel closing: ${DRAFT}`
    );
    /* it collapses, it does not unmount — that is WHY the draft survives */
    expect(`#composer is still in the document: ${await page.evaluate(() => !!document.getElementById("composer"))}`).toBe(
      "#composer is still in the document: true"
    );

    /* and it is still there when the panel comes back */
    await page.click("#chatBtn");
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
    expect(`draft survives reopening: ${await page.$eval("#composer", (t) => (t as HTMLTextAreaElement).value)}`).toBe(
      `draft survives reopening: ${DRAFT}`
    );
    expect(`aria-expanded: ${await page.$eval("#chatBtn", (b) => b.getAttribute("aria-expanded"))}`).toBe(
      "aria-expanded: true"
    );
  }, 60000);
});

/* ============================================================
   3. THE CONTEXT MENU
   ============================================================ */

describe("ux — the sidebar context menu", () => {
  test("a create lands in the folder that was right-clicked, not wherever the cursor was", async () => {
    /* open a doc in a DIFFERENT folder first: if the menu quietly used "the
       current doc's parent" this is the test that catches it */
    await app.clickDoc(NAV_DOC); // architecture/
    await rightClick(`#tree .row.folder[data-path="projects"]`);

    expect(`menu header names the target: ${await menuHead()}`).toBe("menu header names the target: projects");
    expect(`menu items: ${JSON.stringify(await menuLabels())}`).toBe(
      'menu items: ["New doc","New folder","Rename / move","Delete"]'
    );
    expect(
      `the create hint says where: ${await page.evaluate(() => document.querySelector("#ctxMenu .menu-item .mhint")?.textContent)}`
    ).toBe("the create hint says where: in projects");

    await clickMenuItem("New doc");
    await inlineField();
    await page.keyboard.type("from-menu");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.querySelector('#tree .row.file[data-doc="projects/from-menu.md"]'), {
      timeout: 8000,
    });
    expect(`created on disk at projects/from-menu.md: ${vaultHas(srv.vault, "projects/from-menu.md")}`).toBe(
      "created on disk at projects/from-menu.md: true"
    );
    expect(`…and NOT at the root: ${vaultHas(srv.vault, "from-menu.md")}`).toBe("…and NOT at the root: false");
  }, 90000);

  test("right-clicking empty tree space targets the vault root", async () => {
    /* the panel below the last row — a right-click that resolves to no row */
    const spot = await page.evaluate(() => {
      const tree = document.getElementById("tree") as HTMLElement;
      const rows = [...tree.querySelectorAll<HTMLElement>(".row")];
      const last = rows[rows.length - 1].getBoundingClientRect();
      const box = tree.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(Math.min(last.bottom + 24, box.bottom - 6)) };
    });
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });

    expect(`menu header: ${await menuHead()}`).toBe("menu header: Vault root");
    /* no row is targeted, so there is nothing to rename or delete */
    expect(`menu items: ${JSON.stringify(await menuLabels())}`).toBe('menu items: ["New doc","New folder"]');

    await clickMenuItem("New folder");
    await inlineField();
    await page.keyboard.type("root-level");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.querySelector('#tree .row.folder[data-path="root-level"]'), {
      timeout: 8000,
    });
    expect(`created at the vault root: ${vaultHas(srv.vault, "root-level")}`).toBe("created at the vault root: true");
  }, 90000);

  test("a doc's menu offers Open, and it opens that doc", async () => {
    await app.clickDoc(NAV_DOC);
    await rightClick(`#tree .row.file[data-doc="${HOME_DOC}"]`);
    expect(`menu items: ${JSON.stringify(await menuLabels())}`).toBe(
      'menu items: ["Open","New doc","New folder","Rename / move","Delete"]'
    );
    await clickMenuItem("Open");
    await app.settled(HOME_DOC);
    expect(`opened: ${await app.shown()}`).toBe(`opened: ${HOME_DOC}`);
  }, 60000);

  test("right-clicking the tree does not throw away an in-progress name", async () => {
    /* `openCtx` focuses the menu's first item, the inline field blurs, and the
       blur handler cancels the edit — silently, unlike Esc, which at least says
       "Cancelled". So a right-click anywhere in the tree while naming a new doc
       destroyed the name with no menu-shaped reason to expect it. */
    await app.chord("KeyN");
    await inlineField();
    await page.keyboard.type("my-important-new-doc");

    await page.evaluate(() => {
      const row = document.querySelector('#tree .row.folder[data-path="projects"]') as HTMLElement;
      const r = row.getBoundingClientRect();
      (window as any).__spot = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    const spot = await page.evaluate(() => (window as any).__spot);
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await sleep(300); // longer than the blur-cancel's own 90ms delay

    const after = await page.evaluate(() => ({
      menu: !(document.getElementById("ctxMenu") as HTMLElement).hidden,
      value: (document.querySelector("#tree .newrow input") as HTMLInputElement | null)?.value ?? null,
      focused: document.activeElement === document.querySelector("#tree .newrow input"),
      toast: document.getElementById("toast")!.classList.contains("show")
        ? document.getElementById("toastTxt")!.textContent
        : null,
    }));
    expect(`the menu opened over the edit: ${after.menu}`).toBe("the menu opened over the edit: false");
    expect(`the typed name survived: ${after.value}`).toBe("the typed name survived: my-important-new-doc");
    expect(`the field kept focus: ${after.focused}`).toBe("the field kept focus: true");
    expect(`it said why: ${after.toast}`).toBe("it said why: Finish the name first — Enter to save, Esc to cancel");

    /* and the edit still commits, so the guard is a pause and not a trap */
    await page.keyboard.press("Enter");
    const created = await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLElement>("#tree .row.file")]
          .map((r) => r.dataset.doc!)
          .find((p) => p.endsWith("my-important-new-doc.md")) ?? false,
      { timeout: 8000 }
    );
    const at = String(await created.jsonValue());
    expect(`created on disk at ${at}: ${vaultHas(srv.vault, at)}`).toBe(`created on disk at ${at}: true`);
  }, 90000);

  test("Esc closes it and gives focus back; a click away closes it too", async () => {
    /* keyboard route in, so there is a row to return focus TO */
    await page.evaluate((p) => {
      const row = document.querySelector<HTMLElement>(`#tree .row.file[data-doc="${p}"]`)!;
      row.tabIndex = row.tabIndex ?? 0;
      row.focus();
    }, NAV_DOC);
    await page.keyboard.down("Shift");
    await page.keyboard.press("F10");
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    expect(`⇧F10 opened the menu: ${await menuOpen()}`).toBe("⇧F10 opened the menu: true");
    expect(`focus moved into the menu: ${await page.evaluate(() => !!document.activeElement?.closest("#ctxMenu"))}`).toBe(
      "focus moved into the menu: true"
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    expect(
      `focus returned to the row: ${await page.evaluate((p) => document.activeElement === document.querySelector(`#tree .row.file[data-doc="${p}"]`), NAV_DOC)}`
    ).toBe("focus returned to the row: true");

    /* click-away. Deliberately on the doc pane, i.e. a place that has its own
       click handling — the menu must go before that handler runs, not after. */
    await rightClick(`#tree .row.folder[data-path="projects"]`);
    await page.mouse.click(900, 500);
    await page.waitForFunction(() => (document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    expect(`click-away closed it: ${!(await menuOpen())}`).toBe("click-away closed it: true");
  }, 90000);

  /* The tree is rebuilt for reasons the user did not ask for — a `doc-changed`
     from another device, a vault appearing, a sync landing. Every row is a NEW
     element afterwards, so a keyboard user who had one focused was left on
     <body> and the next ⏎/F2/Del/⇧F10 went nowhere. Measured here the way it
     bites: refresh the tree under a focused row, then press the chord. */
  test("a tree refresh under a focused row does not swallow the next key", async () => {
    /* focus a row and keep a handle on the very element, so the wait below is
       for the REBUILD itself rather than for a guessed interval */
    await page.evaluate((p) => {
      const row = document.querySelector(`#tree .row.file[data-doc="${p}"]`) as HTMLElement;
      (window as unknown as { __row: HTMLElement }).__row = row;
      row.focus();
    }, NAV_DOC);
    /* a real frame off the real stream: a per-vault settings write broadcasts
       `vaults-changed`, which reloads the tree. Nothing about the doc set or
       the trash moves, so the rest of the file sees the vault it expects. */
    expect((await srv.api("PUT", "/api/vaults/vault/settings", { git: { autoSync: true } })).status).toBe(200);
    await page.waitForFunction(() => !(window as unknown as { __row: HTMLElement }).__row.isConnected, {
      timeout: 8000,
    });
    expect(
      `focus survived the rebuild: ${await page.evaluate(
        (p) => document.activeElement === document.querySelector(`#tree .row.file[data-doc="${p}"]`),
        NAV_DOC
      )}`
    ).toBe("focus survived the rebuild: true");

    await page.keyboard.down("Shift");
    await page.keyboard.press("F10");
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    expect(`⇧F10 still opened the menu: ${await menuOpen()}`).toBe("⇧F10 still opened the menu: true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
  }, 90000);

  test("it flips at the viewport edges instead of spilling off screen", async () => {
    const box = await page.evaluate(() => {
      const r = document.getElementById("tree")!.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    });

    /* four corners of the sidebar's own column, each with the pointer within a
       few pixels of a viewport edge */
    const vw = 1440;
    const vh = 900;
    const spots: Array<[string, number, number]> = [
      ["top-left", box.left + 6, 6],
      ["bottom-left", box.left + 6, vh - 6],
      ["top-right", box.left + box.width - 4, 6],
      ["bottom-right", box.left + box.width - 4, vh - 6],
    ];

    for (const [name, x, y] of spots) {
      await page.mouse.click(x, y, { button: "right" });
      await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
      await sleep(120);
      const r = await page.evaluate(() => {
        const m = document.getElementById("ctxMenu") as HTMLElement;
        const b = m.getBoundingClientRect();
        return {
          left: b.left,
          top: b.top,
          right: b.right,
          bottom: b.bottom,
          width: b.width,
          height: b.height,
          opacity: getComputedStyle(m).opacity,
        };
      });
      const inside = r.left >= 0 && r.top >= 0 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
      expect(
        `${name}: menu fully on screen — ${JSON.stringify({
          l: Math.round(r.left),
          t: Math.round(r.top),
          rt: Math.round(r.right),
          b: Math.round(r.bottom),
        })}: ${inside}`
      ).toBe(
        `${name}: menu fully on screen — ${JSON.stringify({
          l: Math.round(r.left),
          t: Math.round(r.top),
          rt: Math.round(r.right),
          b: Math.round(r.bottom),
        })}: true`
      );
      /* it is a real, visible menu at that corner and not a zero-size node that
         trivially fits inside the viewport */
      expect(`${name}: menu has size: ${r.width > 100 && r.height > 40}`).toBe(`${name}: menu has size: true`);
      expect(`${name}: menu is opaque: ${Number(r.opacity) > 0.9}`).toBe(`${name}: menu is opaque: true`);

      /* the bottom row must have flipped UPWARDS past the pointer, not merely
         been clamped — clamping alone would put it under the cursor */
      if (name.startsWith("bottom")) {
        expect(`${name}: opened upwards from the pointer: ${r.bottom <= y + 1}`).toBe(
          `${name}: opened upwards from the pointer: true`
        );
      }
      if (name.endsWith("right")) {
        expect(`${name}: opened leftwards from the pointer: ${r.left <= x + 1}`).toBe(
          `${name}: opened leftwards from the pointer: true`
        );
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => (document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    }
  }, 120000);

  test("it does not steal the browser's own menu outside the sidebar, or over an input", async () => {
    const outside = await page.evaluate(() => {
      const doc = document.getElementById("doc") as HTMLElement;
      const r = doc.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 40),
        clientY: Math.round(r.top + 40),
      });
      doc.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, menu: !(document.getElementById("ctxMenu") as HTMLElement).hidden };
    });
    expect(`in the doc pane — prevented: ${outside.prevented}, our menu: ${outside.menu}`).toBe(
      "in the doc pane — prevented: false, our menu: false"
    );

    /* and inside the sidebar, over the inline create field — paste is the whole
       point of that input, so the native menu has to survive there */
    await rightClick(`#tree .row.folder[data-path="projects"]`);
    await clickMenuItem("New doc");
    await inlineField();
    const overInput = await page.evaluate(() => {
      const inp = document.querySelector("#tree .newrow input") as HTMLElement;
      const r = inp.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 10),
        clientY: Math.round(r.top + r.height / 2),
      });
      inp.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, menu: !(document.getElementById("ctxMenu") as HTMLElement).hidden };
    });
    expect(`over the inline input — prevented: ${overInput.prevented}, our menu: ${overInput.menu}`).toBe(
      "over the inline input — prevented: false, our menu: false"
    );
    await page.keyboard.press("Escape");
  }, 90000);
});

/* ============================================================
   4. THE HOME BUTTON
   ============================================================ */

/* ============================================================
   THE TERMINAL CONSOLE — the UI half of the command runner

   Two claims the panel makes to the user's face, both of which were false:
   that Ctrl+C cancels what is running, and that ANSI is stripped rather than
   half-rendered. Driven through the real console, in the real Settings panel.
   ============================================================ */

const TERM_PW = "UXTERM-pw-9f31c2a4";

describe("ux — the terminal console", () => {
  /** set (or re-set) the password server-side, then unlock through the UI */
  async function unlockConsole() {
    const pw = await srv.api("POST", "/api/terminal/password", { password: TERM_PW, current: TERM_PW });
    expect(`set terminal password → ${pw.status}`).toBe("set terminal password → 200");
    /* the panel paints from the SERVER's status, fetched at boot — so a
       password set behind this page's back needs a load to be seen */
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await goSettings();
    await page.waitForSelector("#termPass", { visible: true, timeout: 8000 });
    await page.click("#termPass");
    await page.keyboard.type(TERM_PW);
    await page.click("#termUnlockBtn");
    await page.waitForFunction(() => !(document.getElementById("termConsole") as HTMLElement).hidden, {
      timeout: 10000,
    });
  }

  /** a session that is NOT this browser tab's — a second tab, or the assistant */
  async function elsewhere(command: string) {
    const un = await srv.api("POST", "/api/terminal/unlock", { password: TERM_PW });
    expect(`second session unlocked → ${un.status}`).toBe("second session unlocked → 200");
    const res = await fetch(srv.url("/api/terminal/exec"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${un.body.token}`,
      },
      body: JSON.stringify({ command }),
    });
    /* read it in the background so the server keeps streaming */
    const drained = (async () => {
      const r = res.body!.getReader();
      let raw = "";
      const dec = new TextDecoder();
      for (;;) {
        const c = await r.read();
        if (c.done) break;
        raw += dec.decode(c.value, { stream: true });
      }
      return raw;
    })();
    const id = await waitUntil(async () => (await srv.get("/api/terminal/status")).body.running, {
      timeout: 8000,
      label: "the other session's command to be running",
    });
    return { id, drained };
  }

  const stopVisible = () => page.evaluate(() => !(document.getElementById("termStopBtn") as HTMLElement).hidden);
  const scrollback = () => page.evaluate(() => document.getElementById("termOut")!.textContent ?? "");

  test("Ctrl+C cancels a command this tab did not start — instead of doing nothing", async () => {
    /* The Stop button and Ctrl+C were both gated on state this tab sets in its
       OWN run loop, so a command started anywhere else (a second tab, or one
       the assistant auto-ran) left the console in a dead end: typing was refused
       with "cancel it first (Ctrl+C)" and Ctrl+C was a no-op in exactly that
       state. The only ways out were the other tab and the 30-minute clock. */
    await unlockConsole();
    expect(`Stop before anything runs: ${await stopVisible()}`).toBe("Stop before anything runs: false");

    const other = await elsewhere("echo OTHER-GO; sleep 25");

    await page.click("#termInput");
    await page.keyboard.type("echo hello-from-this-tab");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /already running/.test(document.getElementById("termOut")!.textContent ?? ""), {
      timeout: 8000,
    });

    /* the refusal names Ctrl+C, so Ctrl+C has to be real from here on */
    expect(`the refusal mentions Ctrl+C: ${/Ctrl\+C/.test(await scrollback())}`).toBe(
      "the refusal mentions Ctrl+C: true"
    );
    expect(`Stop is offered for the other tab's command: ${await stopVisible()}`).toBe(
      "Stop is offered for the other tab's command: true"
    );

    await page.click("#termInput");
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");

    const after = await waitUntil(
      async () => {
        const st = (await srv.get("/api/terminal/status")).body;
        return st.running === null ? "gone" : null;
      },
      { timeout: 15000, label: "the command to be cancelled" }
    );
    expect(`the other tab's command after Ctrl+C: ${after}`).toBe("the other tab's command after Ctrl+C: gone");
    expect(`the console said it was cancelling: ${/cancelling/.test(await scrollback())}`).toBe(
      "the console said it was cancelling: true"
    );
    expect(`it was the right command: ${other.id.startsWith("cmd_")}`).toBe("it was the right command: true");
    await other.drained;
  }, 120000);

  test("an ANSI escape split across two chunks is stripped, not half-rendered", async () => {
    /* stdout arrives as arbitrary pipe reads. `stripAnsi` ran per chunk, so an
       escape straddling a boundary was two halves that matched nothing: the
       lone ESC was eaten as a control byte and `[31m` was printed as text.
       ANSI is supposed to be stripped rather than half-rendered — this is the
       shape that made that false, with a real gap between the two writes. */
    await unlockConsole();
    await page.click("#termInput");
    await page.keyboard.type(`printf '\\033['; sleep 0.5; printf '31mSPLIT-ESCAPE-OK\\033[0m\\n'`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /exit 0/.test(document.getElementById("termOut")!.textContent ?? ""), {
      timeout: 20000,
    });

    /* the echoed prompt line carries the escapes the user TYPED, so the
       assertion reads only the nodes the child's stdout produced */
    const printed = await page.evaluate(() =>
      [...document.querySelectorAll("#termOut .l.out")].map((n) => n.textContent ?? "").join("")
    );
    expect(`the output arrived: ${/SPLIT-ESCAPE-OK/.test(printed)}`).toBe("the output arrived: true");
    expect(`a colour code was painted as text (${JSON.stringify(printed)}): ${/\[31m|\[0m/.test(printed)}`).toBe(
      `a colour code was painted as text (${JSON.stringify(printed)}): false`
    );
    expect(`an ESC survived into the DOM: ${printed.includes("\u001b")}`).toBe("an ESC survived into the DOM: false");
  }, 120000);
});

describe("ux — the home button", () => {
  test("it opens the configured doc, pushes ONE history entry, and Back returns", async () => {
    await setSetting({ editor: { homeDoc: HOME_DOC } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").length > 1, {
      timeout: 15000,
    });

    await app.clickDoc(NAV_DOC);
    const before = await app.histLen();

    await page.click("#homeBtn");
    await app.settled(HOME_DOC);
    expect(`home opened: ${await app.shown()}`).toBe(`home opened: ${HOME_DOC}`);
    expect(`url: ${await app.urlPath()}`).toBe(`url: /d/${encPath(HOME_DOC)}`);
    expect(`history grew by: ${(await app.histLen()) - before}`).toBe("history grew by: 1");

    /* Back has to come back to where the user was, or the button is a trap */
    await app.backTo(NAV_DOC);
    expect(`Back returned to: ${await app.shown()}`).toBe(`Back returned to: ${NAV_DOC}`);
    await app.forward();
    await app.settled(HOME_DOC);
    expect(`Forward went to: ${await app.shown()}`).toBe(`Forward went to: ${HOME_DOC}`);
  }, 90000);

  test("it follows a CHANGED setting live, with no reload", async () => {
    await setSetting({ editor: { homeDoc: HOME_DOC } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").length > 1, {
      timeout: 15000,
    });

    expect(`the button says where it goes: ${await page.$eval("#homeBtn", (b) => b.title)}`).toBe(
      `the button says where it goes: Home — open ${HOME_DOC}`
    );

    /* change it through the real control, not through the API */
    await page.evaluate(() => ((window as any).__sameDocument = true));
    await goSettings();
    await page.click("#homeDoc");
    await page.evaluate(() => {
      const i = document.getElementById("homeDoc") as HTMLInputElement;
      i.value = "";
    });
    await page.type("#homeDoc", NAV_DOC);
    await page.keyboard.press("Tab");
    /* …and Save. Settings are DRAFTS until the Save button now, and the home
       button follows the SAVED setting (`settingAt`, not `draftValue`) — a
       typed-but-unsaved path is shown in the field and nowhere else. The claim
       this test makes is "a real settings change moves the button WITHOUT a
       reload", and that claim is untouched: the change is still made through
       the real control and the `__sameDocument` assertion below is what
       carries the "no reload" half of it. */
    await saveSettings(page, { expectDirty: true });
    await page.waitForFunction(
      (p) => (document.getElementById("homeBtn") as HTMLElement).title === `Home — open ${p}`,
      { timeout: 8000 },
      NAV_DOC
    );
    await leaveSettings();

    expect(`no reload happened: ${await page.evaluate(() => (window as any).__sameDocument)}`).toBe(
      "no reload happened: true"
    );

    await app.clickDoc(HOME_DOC);
    await page.click("#homeBtn");
    await app.settled(NAV_DOC);
    expect(`home now goes to: ${await app.shown()}`).toBe(`home now goes to: ${NAV_DOC}`);

    /* …and it round-tripped to the file the user can commit */
    const back = (await srv.get("/api/settings")).body.settings;
    expect(`the server stored: ${back.editor.homeDoc}`).toBe(`the server stored: ${NAV_DOC}`);
  }, 120000);

  test("a home doc that does not exist is reported and offered, and Cancel still lands somewhere", async () => {
    const MISSING = "notes/does-not-exist.md";
    await setSetting({ editor: { homeDoc: MISSING } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").length > 1, {
      timeout: 15000,
    });

    /* CANCEL first: the button must never be inert. Started from a doc that is
       NOT the tree's first, so "it fell back to the first doc" is distinguishable
       from "nothing happened at all". */
    await app.clickDoc(HOME_DOC);
    await page.click("#homeBtn");
    await app.waitVeil("cfVeil", true);
    expect(`the dialog names the missing doc: ${await page.$eval("#cfPath", (n) => n.textContent)}`).toBe(
      `the dialog names the missing doc: ${MISSING}`
    );
    await page.click('#cfVeil [data-act="cf-cancel"]');
    await app.waitVeil("cfVeil", false);
    await app.settled(NAV_DOC);
    expect(`Cancel fell back to the first doc: ${await app.shown()}`).toBe(
      `Cancel fell back to the first doc: ${NAV_DOC}`
    );
    expect(`…and it was not created: ${vaultHas(srv.vault, MISSING)}`).toBe("…and it was not created: false");

    /* now CREATE it */
    await page.click("#homeBtn");
    await app.waitVeil("cfVeil", true);
    await page.click("#cfOk");
    await app.settled(MISSING);
    expect(`created and opened: ${await app.shown()}`).toBe(`created and opened: ${MISSING}`);
    expect(`it is on disk: ${vaultHas(srv.vault, MISSING)}`).toBe("it is on disk: true");

    /* and now that it exists the button is a plain navigation again */
    await app.clickDoc(NAV_DOC);
    await page.click("#homeBtn");
    await app.settled(MISSING);
    expect(`second press went straight there: ${await veilOpen("cfVeil")}`).toBe("second press went straight there: false");
  }, 120000);

  test("a blank setting means `the first doc`, and a path outside the vault is refused", async () => {
    await setSetting({ editor: { homeDoc: "" } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").length > 1, {
      timeout: 15000,
    });
    expect(`the button says so: ${await page.$eval("#homeBtn", (b) => b.title)}`).toBe(
      "the button says so: Home — open the first doc in this vault"
    );
    await page.click("#homeBtn");
    await sleep(600);
    expect(`it opened something: ${(await app.shown()).length > 1}`).toBe("it opened something: true");

    /* the setting reaches `Bun.spawn`-adjacent code paths and a `cd`; a path
       that escapes the vault is refused by the SERVER, not by the input */
    for (const bad of ["../../etc/passwd", "/etc/passwd"]) {
      const r = await srv.api("PUT", "/api/settings", { editor: { homeDoc: bad } });
      expect(`PUT homeDoc=${JSON.stringify(bad)} → ${r.status} ${r.body?.error}`).toBe(
        `PUT homeDoc=${JSON.stringify(bad)} → 400 bad-home-doc`
      );
    }
  }, 90000);

  test("a confirm that CREATES does not wear the delete pattern", async () => {
    /* `confirmDialog` set only the title/path/body/label; the warning triangle,
       the red OK button and "Recoverable only from git history." were baked
       into the markup for the delete case. The Home flow — a plain create, and
       a state a fresh vault is in by default since `editor.homeDoc` ships as
       `index.md` — inherited all three, so the one button in the app that makes
       a file was dressed as the one pattern that destroys one. */
    const MISSING = "notes/tone-check.md";
    await setSetting({ editor: { homeDoc: MISSING } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").length > 1, {
      timeout: 15000,
    });

    await page.click("#homeBtn");
    await app.waitVeil("cfVeil", true);
    const create = await page.evaluate(() => ({
      ok: document.getElementById("cfOk")!.className,
      safe: document.getElementById("cfModal")!.classList.contains("safe"),
      note: document.getElementById("cfNote")!.textContent,
      warnShown: getComputedStyle(document.querySelector("#cfModal .cf-ico .i-warn")!).display,
    }));
    expect(`create dialog OK button: ${create.ok}`).toBe("create dialog OK button: btn primary");
    expect(`create dialog wears the safe chrome: ${create.safe}`).toBe("create dialog wears the safe chrome: true");
    expect(`create dialog warning glyph: ${create.warnShown}`).toBe("create dialog warning glyph: none");
    expect(`create dialog footer: ${create.note}`).toBe(
      "create dialog footer: Cancel opens the first doc instead."
    );

    await page.click('#cfVeil [data-act="cf-cancel"]');
    await app.waitVeil("cfVeil", false);

    /* …and the destructive one still does, because that is what makes the
       pattern worth anything */
    await rightClick(`#tree .row.file[data-doc="${HOME_DOC}"]`);
    await clickMenuItem("Delete");
    await app.waitVeil("cfVeil", true);
    const del = await page.evaluate(() => ({
      ok: document.getElementById("cfOk")!.className,
      safe: document.getElementById("cfModal")!.classList.contains("safe"),
      note: document.getElementById("cfNote")!.textContent,
      warnShown: getComputedStyle(document.querySelector("#cfModal .cf-ico .i-warn")!).display,
    }));
    expect(`delete dialog OK button: ${del.ok}`).toBe("delete dialog OK button: btn danger");
    expect(`delete dialog wears the safe chrome: ${del.safe}`).toBe("delete dialog wears the safe chrome: false");
    expect(`delete dialog warning glyph shown: ${del.warnShown !== "none"}`).toBe(
      "delete dialog warning glyph shown: true"
    );
    expect(`delete dialog footer: ${del.note}`).toBe("delete dialog footer: In the trash for 7 days, then purged for good.");
    await page.click('#cfVeil [data-act="cf-cancel"]');
    await app.waitVeil("cfVeil", false);
    expect(`nothing was deleted: ${vaultHas(srv.vault, HOME_DOC)}`).toBe("nothing was deleted: true");

    await setSetting({ editor: { homeDoc: HOME_DOC } });
  }, 120000);

  test("no page errors were raised anywhere in this file's flows", async () => {
    /* the cheapest possible guard against a merge that left a handler calling a
       function that no longer exists — every test above shares this collector */
    expect(`page errors: ${JSON.stringify(pageErrors)}`).toBe("page errors: []");
  }, 20000);
});
