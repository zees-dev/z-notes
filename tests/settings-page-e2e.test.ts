/* ============================================================
   settings-page-e2e.test.ts — the SEAMS around Settings-as-a-page.

   `tests/routing.test.ts` owns the route itself (deep link, refresh,
   Back/Forward, the rail, Done, Esc, ⌘K over the page) and
   `tests/settings.test.ts` owns the structural parity that proves the move
   carried every control across. Neither covers what happens where the settings
   page MEETS the rest of the app — which is precisely where a page that used to
   be a modal veil behaves differently:

     · a veil floated ABOVE the sidebar; a page sits beside it, so the tree —
       and therefore the whole create flow — is live while Settings is open.
       ⌘N from the settings page, Esc over a half-typed name, and a create that
       has to navigate OUT of Settings to show its result are all new shapes;
     · the terminal is a real interactive surface that used to live inside a
       modal and now lives inside a document-less page. Nothing in the suite
       drove it through a browser at all: tests/terminal.test.ts is API-level;
     · the topbar gear was DELETED in favour of a labelled sidebar row, so the
       one remaining way in has to actually be there, at both densities.

   Real Chromium, real backend, real geometry throughout.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { SEED_VAULT, sleep, startServer, vaultHas, type TestServer } from "./helpers";
import {
  gotoSettings as goSettings,
  launchTestBrowser,
  newAppPage,
  onSettings as isOnSettings,
  pressChord,
  waitForApp,
  waitForFocusedInput,
  waitSettings as waitForSettings,
} from "./browser";

const HOME = "architecture/z-notes-design.md";
const TERM_PASSWORD = "terminal-pass-for-the-settings-page";

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  await srv?.stop();
});

/* ------------------------------------------------------------------
   helpers
   ------------------------------------------------------------------ */

async function boot(at: string, density: "comfy" | "compact" = "comfy") {
  await srv.api("PUT", "/api/settings", { density });
  await page.goto(srv.base + at, { waitUntil: "domcontentloaded" });
  await waitForApp(page, 25000);
  await page.waitForFunction(
    (d) => document.documentElement.getAttribute("data-density") === d,
    { timeout: 10000 },
    density
  );
  await sleep(250);
}

/* the shared settings predicate and its wait — see tests/browser.ts */
const onSettings = () => isOnSettings(page);
const waitSettings = (want: boolean) => waitForSettings(page, want);

/* the shared variadic chord — see tests/browser.ts */
const chord = (code: string, shift = false) =>
  shift ? pressChord(page, code, "Meta", "Shift") : pressChord(page, code);

/** ⌘N (⇧⌘N for a folder), settled — see `waitForFocusedInput` for why the wait
    is on the CARET and not on the node. */
async function startCreateRow(shift = false) {
  await chord("KeyN", shift);
  await waitForFocusedInput(page, "#tree .newrow input", 8000);
}

/* the shared pair — see tests/browser.ts. The guard stays local: this file is
   the one that walks the section rail while already on the page. */
async function gotoSettings() {
  if (await onSettings()) return;
  await goSettings(page);
}

/* ============================================================
   1 · THE WAY IN — the gear is gone, the row must carry it
   ============================================================ */

describe("the sidebar row is the one way into Settings", () => {
  test("it is in the sidebar, below the footer, visible and hit-testable — at both densities", async () => {
    for (const density of ["comfy", "compact"] as const) {
      await boot("/d/" + HOME, density);

      const row = await page.evaluate(() => {
        const link = document.getElementById("settingsLink");
        if (!link) return null;
        const r = link.getBoundingClientRect();
        const foot = document.querySelector(".sb-foot")?.getBoundingClientRect();
        /* hit-testable, not merely present: a row an overlay covers is a row
           nobody can click, and `.veil` used to do exactly that */
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          insideSidebar: !!link.closest(".sidebar"),
          w: Math.round(r.width),
          h: Math.round(r.height),
          belowFoot: !!foot && r.top >= foot.bottom - 1,
          clickable: !!hit && (hit === link || link.contains(hit)),
          kbd: (link.querySelector("kbd")?.textContent ?? "").trim(),
          title: link.getAttribute("title") ?? "",
          label: (link.textContent ?? "").replace(/\s+/g, " ").trim(),
          current: link.getAttribute("aria-current"),
        };
      });

      expect(`${density}: the row exists: ${!!row}`).toBe(`${density}: the row exists: true`);
      expect(`${density}: inside the sidebar: ${row!.insideSidebar}`).toBe(`${density}: inside the sidebar: true`);
      expect(`${density}: below the footer: ${row!.belowFoot}`).toBe(`${density}: below the footer: true`);
      expect(`${density}: has real size: ${row!.w > 0 && row!.h > 0}`).toBe(`${density}: has real size: true`);
      expect(`${density}: hit-testable: ${row!.clickable}`).toBe(`${density}: hit-testable: true`);
      /* labelled text carrying its own shortcut — the thing an unlabelled
         topbar glyph could not do, and the reason the gear was removed.
         The row prints ⌘/ (the conventional chord, and the one the shortcuts
         overlay leads with); ⌘, still opens Settings and is named in the title
         rather than in a second <kbd>, which would out-width the row's
         icon · label · hint rhythm. Both are asserted — the printed one here,
         both of them in ux-e2e, where they are actually pressed. */
      expect(`${density}: it prints its shortcut: ${row!.kbd}`).toBe(`${density}: it prints its shortcut: ⌘/`);
      expect(`${density}: the title names both chords: ${row!.title.includes("⌘/") && row!.title.includes("⌘,")}`).toBe(
        `${density}: the title names both chords: true`
      );
      expect(`${density}: it is labelled: ${row!.label.includes("Settings")}`).toBe(
        `${density}: it is labelled: true`
      );
      expect(`${density}: not current while a doc is open: ${row!.current}`).toBe(
        `${density}: not current while a doc is open: false`
      );
    }
  }, 120000);

  test("there is exactly ONE settings control in the whole shell", async () => {
    await boot("/d/" + HOME);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('[data-act="settings"]')].map((n) => n.id || n.className)
    );
    /* the topbar gear was deleted rather than kept alongside: two ways in, one
       of them unlabelled and stateless, is the duplicate mechanism the move
       existed to remove */
    expect(`settings controls: ${JSON.stringify(found)}`).toBe('settings controls: ["settingsLink"]');
    expect(`a gear left in the topbar: ${await page.evaluate(() => !!document.querySelector('.topbar [data-act="settings"]'))}`).toBe(
      "a gear left in the topbar: false"
    );
  }, 60000);
});

/* ============================================================
   2 · THE TREE IS LIVE — creating from the settings page
   ============================================================ */

describe("the create flow works from the settings page (the tree never left)", () => {
  test("⌘N opens the row in the visible sidebar, with the open doc's folder as context", async () => {
    await boot("/d/" + HOME);
    await gotoSettings();

    await startCreateRow();

    const st = await page.evaluate(() => {
      const inp = document.querySelector("#tree .newrow input") as HTMLInputElement;
      const r = inp.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        onSettings: document.getElementById("app")!.classList.contains("route-settings"),
        url: location.pathname,
        visible: r.width > 0 && r.height > 0,
        clickable: !!hit && (hit === inp || inp.contains(hit)),
        focused: document.activeElement === inp,
        /* the context lives in the label now; the row narrates nothing */
        label: inp.getAttribute("aria-label"),
        hintLine: !!document.querySelector("#tree .newhint"),
      };
    });

    /* the page is still up: creating is not leaving */
    expect(`still on the settings page: ${st.onSettings}`).toBe("still on the settings page: true");
    expect(`url: ${st.url}`).toBe("url: /settings");
    /* a veil would have covered this row, or taken the focus off it */
    expect(`the row is visible: ${st.visible}`).toBe("the row is visible: true");
    expect(`the row is hit-testable: ${st.clickable}`).toBe("the row is hit-testable: true");
    expect(`the caret is in it: ${st.focused}`).toBe("the caret is in it: true");
    /* context is the folder of the doc the pane kept behind the page */
    expect(`aria-label: ${st.label}`).toBe("aria-label: New doc in architecture");
    expect(`no hint line: ${st.hintLine}`).toBe("no hint line: false");
  }, 90000);

  test("Esc cancels the half-typed name and LEAVES THE PAGE UP", async () => {
    await boot("/d/" + HOME);
    await gotoSettings();
    await startCreateRow();
    await page.keyboard.type("half-typed", { delay: 4 });

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
    await sleep(200);

    /* The Esc stack: the inline editor is a layer, the page is not. One press
       takes the row; it must not ALSO unwind the navigation underneath it —
       that was the bug shape when Settings was still in VEILS. */
    expect(`the row is gone: ${await page.evaluate(() => !document.querySelector("#tree .newrow input"))}`).toBe(
      "the row is gone: true"
    );
    expect(`the settings page survived: ${await onSettings()}`).toBe("the settings page survived: true");
    expect(`url: ${await page.evaluate(() => location.pathname)}`).toBe("url: /settings");
    expect(`nothing was created: ${vaultHas(srv.vault, "architecture/half-typed.md")}`).toBe(
      "nothing was created: false"
    );
  }, 90000);

  test("a nested create navigates OUT of Settings and lands on the new doc in Raw", async () => {
    await boot("/d/" + HOME);
    await gotoSettings();
    await startCreateRow();
    await page.keyboard.type("x/y/z.md", { delay: 4 });
    await sleep(200);

    expect(`no hint line: ${await page.evaluate(() => !!document.querySelector("#tree .newhint"))}`).toBe(
      "no hint line: false"
    );

    await page.keyboard.press("Enter");
    await waitSettings(false);
    await page.waitForFunction(
      () => document.getElementById("stPath")!.textContent === "architecture/x/y/z.md",
      { timeout: 15000 }
    );
    await sleep(300);

    const after = await page.evaluate(() => ({
      url: location.pathname,
      onSettings: document.getElementById("app")!.classList.contains("route-settings"),
      raw: !!document.getElementById("rawArea"),
      /* the page's own chrome must have stood down with it */
      current: document.getElementById("settingsLink")!.getAttribute("aria-current"),
      viewHidden: document.getElementById("settingsView")!.getAttribute("aria-hidden"),
    }));

    expect(`url: ${after.url}`).toBe("url: /d/architecture/x/y/z.md");
    expect(`left the settings page: ${!after.onSettings}`).toBe("left the settings page: true");
    /* a new doc opens in Raw — there is nothing to preview yet */
    expect(`opened in Raw: ${after.raw}`).toBe("opened in Raw: true");
    expect(`the sidebar row is no longer current: ${after.current}`).toBe(
      "the sidebar row is no longer current: false"
    );
    expect(`the view is aria-hidden again: ${after.viewHidden}`).toBe("the view is aria-hidden again: true");

    /* and it really exists, with its intermediate folders */
    for (const p of ["architecture/x", "architecture/x/y", "architecture/x/y/z.md"]) {
      expect(`on disk: ${p} → ${vaultHas(srv.vault, p)}`).toBe(`on disk: ${p} → true`);
    }
  }, 120000);
});

/* ============================================================
   2b · THE PANEL'S OWN LAYOUT
   ============================================================ */

describe("a field whose control is a whole row wide stacks instead of crushing its label", () => {
  /* Found by looking at the page rather than at the DOM. `.field .ctl` is
     `flex: 0 0 auto` — correct for the switch/segment/number box the row was
     designed around, and wrong for the two controls this panel grew later: the
     three vault-passphrase inputs, and the paragraph of prose explaining where
     the passphrase is stored. Neither can shrink, so both took their width out
     of the LABEL (measured at 9px wide and 320px tall — one word per line) and
     then out of the page, leaving Settings with a ~1300px horizontal scroll.

     Every existing test passed throughout: they all assert text, and the text
     was all present. Only geometry sees this. */
  const layout = () =>
    page.evaluate(() => {
      const rect = (e: Element | null) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const of = (id: string) => {
        const f = document.getElementById(id);
        return f ? { field: rect(f), lab: rect(f.querySelector(".lab")), ctl: rect(f.querySelector(".ctl")) } : null;
      };
      const keyField = document.getElementById("keyCurrent")?.closest(".field") ?? null;
      const noteField = document.getElementById("keyStoreNote")?.closest(".field") ?? null;
      const body = document.getElementById("settingsBody")!;
      return {
        key: keyField
          ? { field: rect(keyField), lab: rect(keyField.querySelector(".lab")), ctl: rect(keyField.querySelector(".ctl")) }
          : null,
        note: noteField
          ? { field: rect(noteField), lab: rect(noteField.querySelector(".lab")), ctl: rect(noteField.querySelector(".ctl")) }
          : null,
        term: of("termPwField"),
        bodyOverflow: body.scrollWidth - body.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

  test("the vault-passphrase label keeps a real width, and Settings never scrolls sideways", async () => {
    await boot("/settings/secrets");
    const L = await layout();

    expect(`the field was found: ${!!L.key}`).toBe("the field was found: true");
    /* the label is a LINE of text, not a column of single words */
    expect(`the label is wider than it is tall: ${L.key!.lab!.w > L.key!.lab!.h}`).toBe(
      "the label is wider than it is tall: true"
    );
    expect(`the label fills the row: ${L.key!.lab!.w >= L.key!.field!.w - 2}`).toBe(
      "the label fills the row: true"
    );
    /* the control took its own line rather than the label's space */
    expect(`the control is on its own line: ${L.key!.ctl!.l === L.key!.field!.l}`).toBe(
      "the control is on its own line: true"
    );

    expect(`the settings body scrolls sideways by: ${L.bodyOverflow}px`).toBe(
      "the settings body scrolls sideways by: 0px"
    );
    expect(`the page scrolls sideways by: ${L.pageOverflow}px`).toBe("the page scrolls sideways by: 0px");
  }, 60000);

  test("the prose note wraps instead of widening the panel", async () => {
    await boot("/settings/secrets");
    const L = await layout();
    expect(`the note field was found: ${!!L.note}`).toBe("the note field was found: true");
    expect(`the note stays inside the panel: ${L.note!.ctl!.w <= L.note!.field!.w}`).toBe(
      "the note stays inside the panel: true"
    );
    /* prose, not a single very long line */
    expect(`it is taller than one line: ${L.note!.ctl!.h > 40}`).toBe("it is taller than one line: true");
  }, 60000);

  test("the ordinary rows are untouched — label left, control right, one line", async () => {
    await boot("/settings/terminal");
    /* the regression the first fix caused: wrapping EVERY field put the switch
       of any row with a two-line description onto a line of its own. Flexbox
       breaks lines on unshrunk sizes, so wrapping has to be opt-in per field. */
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#settingsGrp-terminal .field")]
        .filter((f) => f.querySelector(".sw, .ctl.num, .ctl > .inp"))
        .filter((f) => !f.classList.contains("stacked"))
        .map((f) => {
          const lab = f.querySelector(".lab")!.getBoundingClientRect();
          const ctl = f.querySelector(".ctl")!.getBoundingClientRect();
          return {
            name: (f.querySelector(".lab b")?.textContent ?? "?").trim(),
            sameLine: Math.abs(lab.top - ctl.top) < lab.height + 4,
            ctlIsRight: ctl.left > lab.left + lab.width - 2,
          };
        })
    );
    expect(`ordinary rows measured: ${rows.length > 0}`).toBe("ordinary rows measured: true");
    for (const r of rows) {
      expect(`"${r.name}": control beside the label: ${r.sameLine && r.ctlIsRight}`).toBe(
        `"${r.name}": control beside the label: true`
      );
    }
  }, 60000);

});

/* ============================================================
   3 · THE TERMINAL, DRIVEN FROM THE PAGE
   ============================================================ */

describe("the terminal is usable from /settings/terminal", () => {
  test("set a password, unlock, and run a command — all without a document", async () => {
    await srv.api("PUT", "/api/settings", { terminal: { enabled: true } });
    /* deep link straight at the section: the page has to come up complete from
       a cold navigation, not only from a ⌘, that had a doc under it */
    await boot("/settings/terminal");

    expect(`arrived on the settings page: ${await onSettings()}`).toBe("arrived on the settings page: true");
    expect(`url: ${await page.evaluate(() => location.pathname)}`).toBe("url: /settings/terminal");

    const state = () => page.$eval("#termStateTxt", (n) => (n.textContent ?? "").trim());
    const shown = (id: string) =>
      page.evaluate((i) => {
        const e = document.getElementById(i as string);
        if (!e || e.hasAttribute("hidden")) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, id);

    expect(`before a password: ${await state()}`).toBe(
      "before a password: Disabled — no terminal password is set, so nothing can run."
    );
    expect(`the console is not up yet: ${await shown("termConsole")}`).toBe("the console is not up yet: false");

    /* 1 · set the password from the page */
    await page.click("#termNew");
    await page.keyboard.type(TERM_PASSWORD, { delay: 2 });
    await page.click("#termPwBtn");
    await page.waitForFunction(
      () => /^Locked/.test((document.getElementById("termStateTxt")?.textContent ?? "").trim()),
      { timeout: 15000 }
    );
    expect(`after Set: ${await state()}`).toBe(
      "after Set: Locked — enter the terminal password to run commands."
    );
    expect(`the unlock field appeared: ${await shown("termUnlockField")}`).toBe("the unlock field appeared: true");

    /* 2 · unlock */
    await page.click("#termPass");
    await page.keyboard.type(TERM_PASSWORD, { delay: 2 });
    await page.click("#termUnlockBtn");
    await page.waitForFunction(
      () => /^Unlocked/.test((document.getElementById("termStateTxt")?.textContent ?? "").trim()),
      { timeout: 20000 }
    );
    expect(`the console is up: ${await shown("termConsole")}`).toBe("the console is up: true");

    /* 3 · run something and read the scrollback */
    await page.click("#termInput");
    await page.keyboard.type("echo z-notes-from-the-settings-page");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (document.getElementById("termOut")?.innerText ?? "").includes("exit 0"),
      { timeout: 25000 }
    );

    const out = await page.$eval("#termOut", (n) => (n as HTMLElement).innerText);
    expect(`the command echoed: ${out.includes("z-notes-from-the-settings-page")}`).toBe(
      "the command echoed: true"
    );
    expect(`it exited cleanly: ${out.includes("exit 0")}`).toBe("it exited cleanly: true");

    /* the page never stopped being a page while all of that happened */
    expect(`still on the settings page: ${await onSettings()}`).toBe("still on the settings page: true");
    expect(`still at its URL: ${await page.evaluate(() => location.pathname)}`).toBe(
      "still at its URL: /settings/terminal"
    );
  }, 180000);

  test("the terminal password never reached settings.toml", async () => {
    /* the server stores a scrypt HASH; the plaintext must not survive anywhere
       the vault gets committed from */
    const toml = await Bun.file(srv.vault + "/.znotes/settings.toml")
      .text()
      .catch(() => "");
    expect(`the password is in settings.toml: ${toml.includes(TERM_PASSWORD)}`).toBe(
      "the password is in settings.toml: false"
    );
  }, 30000);
});

describe("no page errors", () => {
  test("nothing threw across any of it", () => {
    expect(`page errors: ${pageErrors.join(" | ") || "none"}`).toBe("page errors: none");
  });
});
