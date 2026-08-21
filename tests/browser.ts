/* ============================================================
   browser.ts — the puppeteer harness every e2e file shares.

   Deliberately NOT in helpers.ts: that file is imported by the pure-API suites
   too, and a top-level `puppeteer-core` import there would load the driver for
   every one of them.

   Three things live here, and each was previously copy-pasted:

     - the launch arguments and the page instrumentation (eight call sites,
       verbatim, and already drifting — one had lost its console listener);
     - `BASE_HISTORY_LEN`, a puppeteer DRIVER detail that two routing files
       depended on and each declared for itself, so a puppeteer upgrade that
       stopped seeding `about:blank` would have had to be fixed twice;
     - `appDriver()`, the boot/navigate/back/veil vocabulary those same two
       files shared line for line (the copies had already drifted on a
       timeout);
     - `onSettings` / `waitSettings`, the same story one release later: SEVEN
       e2e files had each written out the `route-settings` predicate for
       themselves, and the wait had already drifted across four timeouts
       (5000 / 6000 / 8000 / 10000). They are page-taking functions rather than
       `appDriver` members because four of those seven never build a driver;
     - and the round after that: `pressChord` (five copies in four shapes),
       `gotoSettings` / `leaveSettings` (three copies, already drifted across
       three settle pauses), `clickWhenHittable` (two byte-identical copies) and
       `ensureMode` / `docMode` (four copies in four dialects, two of whose
       differences turned out to be load-bearing and survive as options).

   `encPath` is NOT re-implemented here. tests/helpers.ts exports it and app.js
   uses the same rule — a doc URL and the request that fetches that doc have to
   agree segment for segment, so there is one implementation, not four.
   ============================================================ */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { encPath, findChromium } from "./helpers";

/**
 * puppeteer opens every page on about:blank and `page.goto` stacks the shell on
 * top of it, so a page that has pushed nothing sits at 2. Anything above this is
 * an entry the APP created.
 */
export const BASE_HISTORY_LEN = 2;

/**
 * The headless shell, with the flags every suite here runs it under.
 * `executablePath` overrides the discovered binary — secrets-e2e needs a build
 * whose clipboard permission can be granted.
 *
 * THE POINTER PROFILE IS PINNED, and it has to be. Whether a headless browser
 * answers `(hover: hover)` is a property of the machine it runs on, not of the
 * app: the shell on a Mac says yes and the one on a Linux CI runner says no. So
 * `@media (hover: hover)` rules — the fold chevron's reveal (ADR 0023) — were
 * measured under one answer locally and the other in CI, and the suite failed
 * there on a rule that has nothing to do with the operating system. CDP's
 * `Emulation.setEmulatedMedia` does NOT cover `hover`; this blink setting does.
 * `2` is HoverType::kHover and `4` is PointerType::kFine.
 *
 * Device emulation still overrides it, so a test that wants the other answer
 * asks the way it always did — a touch viewport (`hasTouch`/`isMobile`).
 */
export function launchTestBrowser(executablePath?: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: executablePath || findChromium(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    ],
  });
}

export interface NewPageOptions {
  width?: number;
  height?: number;
  /** collect uncaught page errors here instead of printing them */
  onPageError?: (message: string) => void;
  /** runs before ANY app code — for instrumentation the app must not know about */
  beforeLoad?: () => void;
}

/**
 * Wait for `start()` to have finished — `#boot` down, `#app` up.
 *
 * POLLED with `page.evaluate` rather than `page.waitForSelector`, because a
 * WaitTask armed in the gap between `goto(…, "domcontentloaded")` and the app's
 * first `history.replaceState` (openDoc routes the opening doc during boot) is
 * not re-armed by every Chromium build. Measured: against the full "Google
 * Chrome for Testing" that secrets-e2e drives, `waitForSelector("#app:not(
 * [hidden])")` issued straight after `goto` never fires even though
 * `document.querySelector` for the same selector returns the element — while
 * the headless shell handles it. A poll asks the live DOM the same question and
 * cannot be stranded by a world swap, so this is strictly the stronger wait.
 */
export async function waitForApp(page: Page, timeout = 25000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const up = await page
      .evaluate(() => {
        const app = document.getElementById("app") as HTMLElement | null;
        return !!app && !app.hidden;
      })
      .catch(() => false);
    if (up) return;
    if (Date.now() >= deadline) {
      const why = await page
        .evaluate(() => document.getElementById("bootMsg")?.textContent ?? "(no #bootMsg)")
        .catch(() => "(page unreachable)");
      throw new Error(`the app never finished booting within ${timeout}ms — #bootMsg said: ${why}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A fresh page at the app's default viewport, with error reporting wired up. */
export async function newAppPage(browser: Browser, opts: NewPageOptions = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  page.on("pageerror", (e) =>
    opts.onPageError ? opts.onPageError(e.message) : console.error("[browser pageerror]", e.message)
  );
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });
  /* Settings buffers its edits now, so app.js arms a `beforeunload` warning
     whenever a draft is unsaved (the one exit the app does not own). With no
     `dialog` listener puppeteer DISMISSES every dialog it is handed — and
     dismissing a beforeunload means "stay on this page", so a `goto` or a
     `reload` issued after any settings click simply hangs until the navigation
     times out. Accept the unload prompt (the browser's "Leave" button) and keep
     puppeteer's dismiss for everything else, which is what every suite here was
     already relying on. */
  page.on("dialog", (d) => {
    void (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {});
  });
  if (opts.beforeLoad) await page.evaluateOnNewDocument(opts.beforeLoad);
  return page;
}

/**
 * The shared app vocabulary, bound to one page.
 *
 * Rebuilt per test rather than per file: `page` is replaced in `beforeEach`, so
 * a driver closed over a stale handle would drive a page that is already gone.
 */
export function appDriver(page: Page, base: string) {
  const dUrl = (p: string) => "/d/" + encPath(p);

  /** the doc the app believes is open — read off the statusbar, not off state */
  const shown = () => page.evaluate(() => document.getElementById("stPath")!.textContent!);
  const urlPath = () => page.evaluate(() => location.pathname);
  const histLen = () => page.evaluate(() => history.length);

  /* history.back()/forward() from the page: puppeteer's own goBack() waits on a
     frame navigation, and these are same-document traversals. */
  const back = () => page.evaluate(() => history.back());
  const forward = () => page.evaluate(() => history.forward());

  const veilUp = (id: string) => page.evaluate((i) => document.getElementById(i)!.classList.contains("show"), id);
  const waitVeil = (id: string, want: boolean) =>
    page.waitForFunction(
      (i, w) => document.getElementById(i as string)!.classList.contains("show") === w,
      { timeout: 8000 },
      id,
      want
    );

  async function boot(at = "/", timeout = 20000) {
    await page.goto(base + at, { waitUntil: "domcontentloaded" });
    await waitForApp(page, timeout);
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").trim().length > 1, {
      timeout: 15000,
    });
  }

  /** wait until BOTH the pane and the address bar agree on `path` */
  async function settled(path: string) {
    await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, path);
    await page.waitForFunction((u) => location.pathname === u, { timeout: 10000 }, dUrl(path));
  }

  /**
   * Click a doc in the tree, and survive the tree being rebuilt underneath the
   * click.
   *
   * `page.click` resolves the selector, then scrolls to it, then presses — and
   * the sidebar re-renders WHOLESALE on any `doc-changed` frame, so a create or
   * a save landing in that window detaches the very node puppeteer is holding
   * ("Node is either not clickable or not an Element"). Nothing is wrong with
   * the app; the harness simply grabbed a node that a legitimate refresh
   * replaced. Retry against the fresh tree instead — the row is identified by
   * its path, so the second attempt asks for the new node by name.
   */
  async function clickDoc(path: string) {
    const sel = `#tree .row.file[data-doc="${path}"]`;
    for (let attempt = 0; ; attempt++) {
      try {
        await page.waitForSelector(sel, { timeout: 10000 });
        await page.click(sel);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    await settled(path);
  }

  async function backTo(path: string) {
    await back();
    await settled(path);
  }

  const chord = (code: string, ...mods: string[]) => pressChord(page, code, ...mods);

  return { dUrl, boot, shown, urlPath, histLen, back, forward, backTo, settled, clickDoc, chord, veilUp, waitVeil };
}

export type AppDriver = ReturnType<typeof appDriver>;

/**
 * A modifier chord, held in order and released in reverse.
 *
 * Page-TAKING rather than an `appDriver` member, for the same reason
 * `onSettings`/`waitSettings` are: the suites that need it mostly never build a
 * driver, and secrets-ui drives several pages at once. Five copies in FOUR
 * shapes had grown out of this — bare `Meta`, `Meta` + a `shift` boolean, and
 * two variadic ones. The variadic form is a strict superset of all of them, so
 * this is the only one left; `appDriver.chord` delegates here.
 */
export async function pressChord(p: Page, code: string, ...mods: string[]): Promise<void> {
  const keys = mods.length ? mods : ["Meta"];
  for (const m of keys) await p.keyboard.down(m);
  await p.keyboard.press(code);
  for (const m of [...keys].reverse()) await p.keyboard.up(m);
}

/**
 * How long after arriving on (or leaving) Settings it is safe to click.
 *
 * ONE answer, in one place. The three copies of this pair had already drifted
 * to 150ms, 200ms and none — undocumented differences nobody could reconcile in
 * place, which is exactly how the `saveSettings` copies became dangerous.
 * 200ms covers the widest of them; `clickWhenHittable` is the real guard for
 * anything that animates, and this is only the settle after the route flip.
 */
const SETTINGS_SETTLE_MS = 200;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ⌘, onto the settings page, and wait until it is really up. */
export async function gotoSettings(p: Page, opts: { settle?: number } = {}): Promise<void> {
  await pressChord(p, "Comma");
  await waitSettings(p, true);
  await pause(opts.settle ?? SETTINGS_SETTLE_MS);
}

/** …and browser Back off it, which is the exit Esc deliberately is not. */
export async function leaveSettings(p: Page, opts: { settle?: number } = {}): Promise<void> {
  await p.evaluate(() => history.back());
  await waitSettings(p, false);
  await pause(opts.settle ?? SETTINGS_SETTLE_MS);
}

/**
 * Click a control once it is really the thing under the pointer.
 *
 * Settings stopped being a modal that floats above everything: it is the pane's
 * content now, so below 768px the assistant's bottom SHEET is dismissed on the
 * way in — and that dismissal is a 320ms slide. A click issued the instant the
 * route flips lands on the sheet mid-animation. Waiting for hit-testability
 * measures the thing that actually matters instead of sleeping a guess.
 *
 * Shared while the two copies were still byte-identical, which is the cheapest
 * moment: the `saveSettings` copies were identical once too.
 */
export async function clickWhenHittable(p: Page, sel: string, timeout = 8000): Promise<void> {
  await p.waitForSelector(sel, { timeout });
  await p.waitForFunction(
    (s) => {
      const el = document.querySelector(s as string) as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    },
    { timeout },
    sel
  );
  await p.click(sel);
}

/** which of the two views of the document is up — `#doc.raw-mode` is the
    contract everything addresses the editor mode by. */
export const docMode = (p: Page): Promise<"raw" | "preview"> =>
  p.evaluate(() => (document.getElementById("doc")!.classList.contains("raw-mode") ? "raw" : "preview"));

/**
 * Put the editor in `want`, whatever it is showing now.
 *
 * The control is a TOGGLE, so the read-first guard is the load-bearing part: an
 * unguarded call undoes the mode it was asked for. Four suites had written this
 * out in four dialects, and the drift had become load-bearing in two of them —
 * both survive as options rather than as copies:
 *
 *   · `via: "chip"` clicks the statusbar mode chip instead of pressing ⌘E, for
 *     a suite whose subject is the chat panel: a keyboard chord that lands on a
 *     chat control is noise, doubly so now that ⌘C is one of them.
 *   · `settle` is the pause a caller needs before it measures COMPUTED STYLE
 *     rather than a class — the stylesheet swap is not done when the class is.
 */
export async function ensureMode(
  p: Page,
  want: "raw" | "preview",
  opts: { via?: "chord" | "chip"; settle?: number } = {}
): Promise<void> {
  if ((await docMode(p)) === want) return;
  if (opts.via === "chip") await p.click("#stMode");
  else await pressChord(p, "KeyE");
  await p.waitForFunction(
    (w) => (document.getElementById("doc")!.classList.contains("raw-mode") ? "raw" : "preview") === w,
    { timeout: 8000 },
    want
  );
  if (opts.settle) await pause(opts.settle);
}

/**
 * Settings is a routed PAGE (`/settings`), not a veil: `route-settings` on
 * `#app` is what says we are on it, arriving is a navigation and leaving is
 * Back or the header's Back button — Esc is not a dismissal there and must
 * never be used as one.
 */
export const onSettings = (p: Page): Promise<boolean> =>
  p.evaluate(() => document.getElementById("app")!.classList.contains("route-settings"));

/** …and the wait on that same predicate, at ONE timeout for every suite. */
export const waitSettings = (p: Page, want: boolean, timeout = 10000) =>
  p.waitForFunction(
    (w) => document.getElementById("app")!.classList.contains("route-settings") === w,
    { timeout },
    want
  );

/**
 * Commit the settings draft and wait until the save has actually LANDED.
 *
 * Settings buffers: a control writes a draft and only `#settingsSave` issues
 * the PUT, so every "change a setting, now measure the effect" test has to come
 * through here. Shared for the reason the rest of this file is: five suites had
 * grown their own copy of this block and the copies had already DRIFTED into
 * two different waits — and the difference was not cosmetic. Three of them
 * waited on `disabled` alone, but app.js disables the button *while the request
 * is in flight* (`busy` + `disabled`, see `saveSettings`), so that predicate is
 * already true one tick after the click and those helpers returned before the
 * server had answered. Every assertion that followed was racing the PUT. The
 * settled wait is `!busy && disabled`: `busy` gone means the response landed,
 * and `disabled` means the draft was accepted rather than bounced back dirty by
 * a refusal.
 *
 * `expectDirty` is the caller's PRECONDITION, and the two kinds of caller
 * genuinely differ:
 *   · `true`  — "I changed something, commit it". Waits for the button to go
 *     live first, so a change that never registered fails here, loudly, rather
 *     than as a confusing assertion three lines later.
 *   · `false` (default) — "make sure this value is the stored one". Re-picking
 *     the density that is already saved is not a change and leaves Save inert,
 *     so a helper that insisted on a live button would hang on the very first
 *     comfy → comfy call. Returns false when there was nothing to save.
 */
export async function saveSettings(p: Page, opts: { expectDirty?: boolean } = {}): Promise<boolean> {
  const live = () => p.evaluate(() => !(document.getElementById("settingsSave") as HTMLButtonElement).disabled);
  if (opts.expectDirty) {
    await p.waitForFunction(() => !(document.getElementById("settingsSave") as HTMLButtonElement).disabled, {
      timeout: 8000,
    });
  } else if (!(await live())) {
    return false;
  }
  await p.click("#settingsSave");
  await p.waitForFunction(
    () => {
      const b = document.getElementById("settingsSave") as HTMLButtonElement;
      return !b.classList.contains("busy") && b.disabled;
    },
    { timeout: 10000 }
  );
  return true;
}

/**
 * Wait until an inline editor really has the caret, not merely a node.
 *
 * `inlineRow` (app.js) focuses on a 20ms timer, because the input is mounted by
 * the same `renderTree()` that is still running when it is created. A
 * `waitForSelector` therefore returns while the row is present and UNFOCUSED,
 * and keystrokes sent in that window go nowhere — silently eating a prefix, so
 * `x/y/z.md` arrives as `z.md` and the assertion fails somewhere else entirely.
 *
 * Shared rather than copied: two files already needed it, which is how the
 * copies in this harness have historically started to drift.
 */
export async function waitForFocusedInput(p: Page, selector: string, timeout = 5000): Promise<void> {
  await p.waitForSelector(selector, { timeout });
  await p.waitForFunction(
    (s) => document.activeElement === document.querySelector(s as string),
    { timeout },
    selector
  );
}
