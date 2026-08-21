/* ============================================================
   mobile-editing-e2e.test.ts — the phone editor behaves like a markdown
   editor, and hidden chrome stays hidden when the soft keyboard is up.

   These are browser seams on purpose: every regression here crosses DOM
   wiring, editor state and (for save/rename) the real HTTP API.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, type AppDriver, ensureMode, waitSettings } from "./browser";

const PHONE = { width: 390, height: 844 };
const CHAT_DOC = "mobile/chat.md";
const RENAME_FROM = "mobile/rename-me.md";
const RENAME_TO = "mobile/renamed.md";
const LIST_DOC = "mobile/lists.md";
const ENTER_DOC = "mobile/enter.md";
const EXIT_DOC = "mobile/exit.md";
const KEYS_DOC = "mobile/keys.md";
const GUTTER_DOC = "mobile/gutter.md";
const WRAP_DOC = "mobile/wrap.md";
const LONG_EDIT_DOC = "mobile/long-edit.md";
const NESTED = "# Lists\n\n- [x] parent\n  - [ ] child\n    - [ ] grandchild\n  - sibling\n- last\n";
const LONG_LINE = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + "\n";
const LONG_EDIT = Array.from({ length: 140 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n") + "\n";

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({
    seed: {
      [CHAT_DOC]: "# Chat\n\nThe editor stays in front.\n",
      [RENAME_FROM]: "# Rename me\n",
      [LIST_DOC]: NESTED,
      [ENTER_DOC]: "# Enter\n",
      [EXIT_DOC]: "# Exit\n\nold text\n",
      [KEYS_DOC]: "- first\nplain\n",
      [GUTTER_DOC]: "- first\nplain\n",
      [WRAP_DOC]: LONG_LINE,
      [LONG_EDIT_DOC]: LONG_EDIT,
    },
  });
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
  const reset = await srv.api("PUT", "/api/settings", { editor: { tabSize: 2 } });
  expect(reset.status).toBe(200);
  pageErrors.length = 0;
  page = await newAppPage(browser, {
    ...PHONE,
    onPageError: (m) => pageErrors.push(m),
    beforeLoad: () => {
      try {
        localStorage.removeItem("znotes.chat");
      } catch {}
    },
  });
  app = appDriver(page, srv.base);
});

async function enterRaw(path: string) {
  await app.boot("/d/" + path);
  await page.click("#stMode");
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

describe("phone editing regressions", () => {
  test("a closed assistant stays completely off-screen when the soft keyboard raises --kb", async () => {
    await app.boot("/d/" + CHAT_DOC);
    const m = await page.evaluate(() => {
      document.documentElement.style.setProperty("--kb", "336px");
      const app = document.getElementById("app")!;
      const chat = document.getElementById("chat")!;
      const r = chat.getBoundingClientRect();
      return { open: app.classList.contains("chat-open"), top: Math.round(r.top), viewport: innerHeight };
    });
    expect(m.open).toBe(false);
    expect(`closed chat top ${m.top} >= viewport ${m.viewport}`).toBe(
      `closed chat top ${Math.max(m.top, m.viewport)} >= viewport ${m.viewport}`
    );
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("clicking the filename edits it in the header and Enter commits it", async () => {
    await app.boot("/d/" + RENAME_FROM);
    await page.click('#crumbs [data-act="rename-active"]');
    await page.waitForFunction(() => document.activeElement?.matches("#crumbs .crumb-rename"), { timeout: 8000 });
    const surface = await page.evaluate(() => ({
      drawer: document.getElementById("app")!.classList.contains("nav-open"),
      treeEditors: document.querySelectorAll("#tree .newrow.renaming input").length,
      topbarOverflow: Math.max(0, document.querySelector<HTMLElement>(".topbar")!.scrollWidth - document.querySelector<HTMLElement>(".topbar")!.clientWidth),
    }));
    expect(surface).toEqual({ drawer: false, treeEditors: 0, topbarOverflow: 0 });
    const selected = await page.$eval("#crumbs .crumb-rename", (n) => {
      const i = n as HTMLInputElement;
      return i.value.slice(i.selectionStart ?? 0, i.selectionEnd ?? 0);
    });
    expect(selected).toBe("rename-me");
    await page.keyboard.type("renamed");
    await page.keyboard.press("Enter");
    await app.settled(RENAME_TO);
    expect((await srv.doc(RENAME_FROM)).status).toBe(404);
    expect((await srv.doc(RENAME_TO)).status).toBe(200);
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Preview retains nested bullet and checklist hierarchy", async () => {
    await app.boot("/d/" + LIST_DOC);
    const hierarchy = await page.evaluate(() => {
      const item = (line: number) => document.querySelector<HTMLElement>(`.md li[data-line="${line}"]`);
      const parent = item(2);
      const child = item(3);
      const grandchild = item(4);
      const sibling = item(5);
      return {
        childParent: child?.parentElement?.closest("li")?.dataset.line ?? null,
        grandchildParent: grandchild?.parentElement?.closest("li")?.dataset.line ?? null,
        siblingParent: sibling?.parentElement?.closest("li")?.dataset.line ?? null,
        grandchildTask: grandchild?.classList.contains("task") ?? false,
        childMarkOpacity: child ? getComputedStyle(child.querySelector(".cb svg")!).opacity : null,
      };
    });
    expect(hierarchy).toEqual({
      childParent: "2",
      grandchildParent: "3",
      siblingParent: "2",
      grandchildTask: true,
      childMarkOpacity: "0",
    });
    expect((await srv.doc(LIST_DOC)).body.markdown).toBe(NESTED);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("Preview uses circular bullet markers instead of dash rules", async () => {
    /* Every bullet is a CIRCLE — square, fully rounded, drawn by CSS and not by
       a background image, which is the claim this test exists for.
       Depth decides whether that circle is FILLED or a RING, alternating so a
       nested list is readable at a glance (base.css `.md ul ul li.bul::before`).
       The ring is painted with an inset box-shadow over a transparent
       background, so "no background colour" is the nested bullet working, not a
       marker that failed to draw — asserting a filled colour at every depth is
       what made this fail once nesting gained its own look.

       NESTED is `- [x] parent` (line 2) · `  - [ ] child` (3) ·
       `    - [ ] grandchild` (4) · `  - sibling` (5) · `- last` (6). */
    await app.boot("/d/" + LIST_DOC);
    const read = (line: number) =>
      page.$eval(`.md li.bul[data-line="${line}"]`, (n) => {
        const s = getComputedStyle(n, "::before");
        return {
          width: s.width,
          height: s.height,
          radius: s.borderRadius,
          image: s.backgroundImage,
          color: s.backgroundColor,
          ring: s.boxShadow,
        };
      });

    const top = await read(6); // `- last`, depth 1
    const nested = await read(5); // `  - sibling`, depth 2

    for (const [what, m] of [
      ["top-level", top],
      ["nested", nested],
    ] as const) {
      expect(`${what} is square: ${m.width === m.height}`).toBe(`${what} is square: true`);
      expect(`${what} radius: ${m.radius}`).toBe(`${what} radius: 50%`);
      expect(`${what} image: ${m.image}`).toBe(`${what} image: none`);
      /* neither depth may render as nothing at all */
      expect(`${what} is drawn: ${m.color !== "rgba(0, 0, 0, 0)" || m.ring !== "none"}`).toBe(`${what} is drawn: true`);
    }

    /* …and the two depths are drawn DIFFERENTLY: filled, then hollow */
    expect(`top-level is filled: ${top.color !== "rgba(0, 0, 0, 0)"}`).toBe("top-level is filled: true");
    expect(`nested is hollow: ${nested.color === "rgba(0, 0, 0, 0)" && nested.ring !== "none"}`).toBe(
      "nested is hollow: true"
    );
  }, 30000);

  test("Enter keeps indentation and continues bullets, checklists and ordered markers", async () => {
    await enterRaw(ENTER_DOC);

    const pressAtEnd = async (line: string) => {
      await page.$eval(
        "#rawArea",
        (n, value) => {
          const ta = n as HTMLTextAreaElement;
          ta.value = value as string;
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        },
        line
      );
      await page.keyboard.press("Enter");
      return page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
    };

    const cases = [
      ["indented bullet", "  - child", "  - child\n  - "],
      ["checked task", "    - [x] done", "    - [x] done\n    - [ ] "],
      ["uppercase checked task", "* [X] done", "* [X] done\n* [ ] "],
      ["checked task with no content gap", "- [x]done", "- [x]done\n- [ ] "],
      ["unchecked task with no content gap", "+ [ ]todo", "+ [ ]todo\n+ [ ] "],
      ["ordered parenthesis", "  7) seven", "  7) seven\n  8) "],
      [
        "ordered marker beyond Number precision",
        "999999999999999999999. huge",
        "999999999999999999999. huge\n1000000000000000000000. ",
      ],
      ["indented prose", "    indented prose", "    indented prose\n    "],
      ["empty task exits the list", "  - [ ] ", ""],
      ["empty task without a content gap exits the list", "- [ ]", ""],
      ["empty ordered item exits the list", "  7) ", ""],
    ] as const;
    for (const [label, source, expected] of cases) {
      expect(`${label}: ${JSON.stringify(await pressAtEnd(source))}`).toBe(
        `${label}: ${JSON.stringify(expected)}`
      );
    }

    const saved = "- parent\n  - child\n  - ";
    await page.$eval(
      "#rawArea",
      (n, value) => {
        const ta = n as HTMLTextAreaElement;
        ta.value = value as string;
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      },
      saved
    );
    await page.click('.topbar .only-mobile[data-act="save"]');
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Saved", { timeout: 8000 });
    expect((await srv.doc(ENTER_DOC)).body.markdown).toBe(saved);
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Enter invokes the primary action on the unsaved-exit modal", async () => {
    await enterRaw(EXIT_DOC);
    const edited = "# Exit\n\nnew text\n";
    await page.$eval(
      "#rawArea",
      (n, value) => {
        const ta = n as HTMLTextAreaElement;
        ta.value = value as string;
        ta.focus();
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      },
      edited
    );
    await page.keyboard.press("Escape");
    await app.waitVeil("xgVeil", true);
    await page.waitForFunction(() => document.activeElement?.closest("#xgVeil") != null, { timeout: 2000 });

    await page.keyboard.press("Enter");
    await app.waitVeil("xgVeil", false);
    await page.waitForFunction(() => document.getElementById("stMode")!.dataset.mode === "preview", { timeout: 8000 });
    expect((await srv.doc(EXIT_DOC)).body.markdown).toBe(edited);
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("the unsaved-exit modal has two equal actions and its scrim keeps editing", async () => {
    await enterRaw(EXIT_DOC);
    const edited = "# Exit\n\nstill editing\n";
    await page.$eval(
      "#rawArea",
      (n, value) => {
        const ta = n as HTMLTextAreaElement;
        ta.value = value as string;
        ta.focus();
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      },
      edited
    );
    await page.keyboard.press("Escape");
    await app.waitVeil("xgVeil", true);

    const actions = await page.$$eval("#xgVeil .modal-foot .btn", (buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { text: button.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })
    );
    expect(actions.map((a) => a.text)).toEqual(["Discard changes", "Save & exit"]);
    expect(actions[0].y).toBe(actions[1].y);
    expect(actions[0].width).toBe(actions[1].width);
    expect(actions[0].height).toBe(actions[1].height);

    await page.mouse.click(4, 4);
    await app.waitVeil("xgVeil", false);
    expect(await page.evaluate(() => document.getElementById("stMode")!.dataset.mode)).toBe("raw");
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe(edited);
    expect(pageErrors).toEqual([]);
  }, 45000);

  test("Tab indents list lines, Shift-Tab outdents them, and the Settings tab size applies live", async () => {
    await enterRaw(KEYS_DOC);
    await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange("- first".length, "- first".length);
    });
    await page.keyboard.press("Tab");
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe("  - first\nplain\n");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("rawArea");

    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe("- first\nplain\n");

    await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      const caret = ta.value.indexOf("plain") + "plain".length;
      ta.setSelectionRange(caret, caret);
    });
    await page.keyboard.press("Tab");
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe("- first\nplain  \n");
    await page.click('.topbar .only-mobile[data-act="save"]');
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Saved", { timeout: 8000 });

    await app.chord("Comma");
    await waitSettings(page, true);
    await page.$eval('[data-num="editor.tabSize"]', (n) => {
      const input = n as HTMLInputElement;
      input.value = "4";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click("#settingsSave");
    await page.waitForFunction(() => (document.getElementById("settingsSave") as HTMLButtonElement).disabled, { timeout: 8000 });
    await page.click('[data-act="close-settings"]');
    await waitSettings(page, false);
    await ensureMode(page, "raw", { via: "chip" });
    await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      ta.value = "- sized";
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await page.keyboard.press("Tab");
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value)).toBe("    - sized");
    expect((await srv.get("/api/settings")).body.settings.editor.tabSize).toBe(4);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("clicking in a list gutter places the caret at the end of that line", async () => {
    await enterRaw(GUTTER_DOC);
    const point = await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      const r = ta.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      return { x: r.left + 1, y: r.top + lh / 2 };
    });
    await page.mouse.click(point.x, point.y);
    expect(await page.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).selectionStart)).toBe("- first".length);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("rawArea");
  }, 30000);

  test("Option-Z and the footer button toggle real Raw word wrapping", async () => {
    await enterRaw(WRAP_DOC);
    const measure = () =>
      page.$eval("#rawArea", (n) => {
        const ta = n as HTMLTextAreaElement;
        return {
          wrap: ta.wrap,
          off: ta.classList.contains("no-wrap"),
          scrollWidth: ta.scrollWidth,
          clientWidth: ta.clientWidth,
          buttonHidden: (document.getElementById("stWrap") as HTMLElement).hidden,
          buttonState: document.getElementById("stWrap")!.dataset.wrap,
        };
      });
    expect(await measure()).toMatchObject({ wrap: "soft", off: false, buttonHidden: false, buttonState: "on" });

    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Alt");
    const off = await measure();
    expect(off).toMatchObject({ wrap: "off", off: true, buttonHidden: false, buttonState: "off" });
    expect(off.scrollWidth).toBeGreaterThan(off.clientWidth);

    await page.click("#stWrap");
    const on = await measure();
    expect(on).toMatchObject({ wrap: "soft", off: false, buttonHidden: false, buttonState: "on" });
    expect(on.scrollWidth).toBeLessThanOrEqual(on.clientWidth + 1);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("typing in the middle of a long Raw doc keeps the same line under the caret", async () => {
    await enterRaw(LONG_EDIT_DOC);
    const before = await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      const sc = document.getElementById("scroll")!;
      const line = 105;
      const caret = ta.value.split("\n").slice(0, line).join("\n").length + line;
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(caret, caret);
      const targetY = 360;
      sc.scrollTop += ta.getBoundingClientRect().top + line * lh - targetY;
      return { scrollTop: sc.scrollTop, caretY: ta.getBoundingClientRect().top + line * lh };
    });

    await page.keyboard.type("x");
    const after = await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      const sc = document.getElementById("scroll")!;
      const line = 105;
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      return { scrollTop: sc.scrollTop, caretY: ta.getBoundingClientRect().top + line * lh };
    });
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(2);
    expect(Math.abs(after.caretY - before.caretY)).toBeLessThan(2);
    expect(pageErrors).toEqual([]);
  }, 30000);

  test("typing at the end of a long Raw doc scrolls the caret above the soft keyboard", async () => {
    await enterRaw(LONG_EDIT_DOC);
    const before = await page.$eval("#rawArea", (n) => {
      const ta = n as HTMLTextAreaElement;
      const sc = document.getElementById("scroll")!;
      const keyboard = 336;
      document.documentElement.style.setProperty("--kb", keyboard + "px");
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
      sc.scrollTop += ta.getBoundingClientRect().bottom - (innerHeight - 30);
      return {
        visibleBottom: innerHeight - keyboard,
        caretBottom: ta.getBoundingClientRect().bottom,
      };
    });
    expect(before.caretBottom).toBeGreaterThan(before.visibleBottom);

    await page.keyboard.type("x");
    await page.waitForFunction(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      const keyboard = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb"));
      return ta.getBoundingClientRect().bottom <= innerHeight - keyboard - 12;
    }, { timeout: 3000 });
    const after = await page.$eval("#rawArea", (n) => ({
      visibleBottom: innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb")),
      caretBottom: (n as HTMLTextAreaElement).getBoundingClientRect().bottom,
    }));
    expect(after.caretBottom).toBeLessThanOrEqual(after.visibleBottom - 12);
    expect(pageErrors).toEqual([]);
  }, 30000);
});
