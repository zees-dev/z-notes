/* ============================================================
   E2E GATE — a real browser against the real backend serving the real app.

   The phase-1 acceptance checklist: boot, tree, navigation, the document's
   measure, ⌘S → disk, external edit → SSE → UI, ⌘K palette, connection dot.

   Driver: puppeteer-core over the Chromium headless shell that Playwright
   already cached (~/Library/Caches/ms-playwright/chromium_headless_shell-*).
   Nothing is downloaded. If the browser is missing the suite fails loudly —
   this gate is measured, never eyeballed.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import {
  startServer,
  readVaultText,
  waitUntil,
  sleep,
  SEED_VAULT,
  SEED_DOC_PATHS,
  type TestServer,
} from "./helpers";
import { forgetBrowserState, launchTestBrowser, newAppPage, pressChord, waitForApp } from "./browser";

const NAV_DOC = "architecture/event-pipeline.md";
const HOMELAB = "projects/homelab.md";

let srv: TestServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });

  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
}, 60000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* ---------------- helpers ---------------- */

/* the shared app vocabulary — see tests/browser.ts. These thunks read `page`
   at call time, which is what the local copies existed to do. */
const chord = (code: string) => pressChord(page, code);
/** the open doc's buffer — what ⌘S writes and SSE refreshes */
const buffer = () =>
  page.evaluate(async () => {
    const { state } = await import("/state.js");
    return state.docs.get(state.active).markdown as string;
  });

/* ---------------- tests ---------------- */

describe("e2e — app boot", () => {
  test("#boot is gone and #app is visible", async () => {
    const s = await page.evaluate(() => ({
      bootHidden: (document.getElementById("boot") as HTMLElement).hidden,
      appHidden: (document.getElementById("app") as HTMLElement).hidden,
      appBox: document.getElementById("app")!.getBoundingClientRect().height,
    }));
    expect(s.bootHidden).toBe(true);
    expect(s.appHidden).toBe(false);
    expect(s.appBox).toBeGreaterThan(400);
  });

  test("the sidebar renders the seeded vault", async () => {
    const tree = await page.evaluate(() => ({
      docs: [...document.querySelectorAll<HTMLElement>("#tree .row.file")].map((r) => r.dataset.doc),
      folders: [...document.querySelectorAll("#tree .row.folder .lbl")].map((n) => n.textContent),
      vaultSub: document.getElementById("vaultSub")!.textContent,
    }));
    expect(tree.docs.slice().sort()).toEqual(SEED_DOC_PATHS.slice().sort());
    expect(tree.folders.slice().sort()).toEqual(["architecture", "journal", "keys", "projects"]);
    expect(tree.vaultSub).toContain(`${SEED_DOC_PATHS.length} docs`);
  });

  test("the statusbar connection dot reaches the connected state", async () => {
    await page.waitForFunction(
      () =>
        document.getElementById("stConnTxt")!.textContent === "connected" &&
        !document.getElementById("stConn")!.classList.contains("down"),
      { timeout: 15000 }
    );
    const conn = await page.evaluate(() => ({
      txt: document.getElementById("stConnTxt")!.textContent,
      down: document.getElementById("stConn")!.classList.contains("down"),
    }));
    expect(conn).toEqual({ txt: "connected", down: false });
  }, 25000);
});

describe("e2e — navigation", () => {
  test("clicking a doc in the tree loads it into #doc", async () => {
    await page.click(`#tree .row.file[data-doc="${NAV_DOC}"]`);
    await page.waitForFunction(
      (p) => document.getElementById("stPath")!.textContent === p,
      { timeout: 5000 },
      NAV_DOC
    );
    await sleep(350); // let the navigation fade-in finish before anything is measured

    const view = await page.evaluate(() => ({
      text: document.getElementById("doc")!.textContent ?? "",
      h1: document.querySelector("#doc h1")?.textContent ?? null,
      active: document.querySelector<HTMLElement>("#tree .row.file.active")?.dataset.doc ?? null,
      lines: document.getElementById("stLines")!.textContent,
    }));
    expect(view.h1).toBe("Event pipeline");
    expect(view.text).toContain('fs.watch on macOS lies');
    expect(view.active).toBe(NAV_DOC);
    expect(view.lines).toBe("9 lines");
  }, 20000);
});

describe("e2e — layout", () => {
  /**
   * THE MEASURE FLOOR.
   *
   * The document must stay READABLE at every width. It was not: measured, the
   * old shell put every width from 768px up into the three-pane grid with the
   * assistant open, which gave a 768px window a 172px document column and
   * ~120px of text — and since nothing remembered that you had closed the
   * panel, every reload landed there again. 820px gave 224px, 1024px gave 428px.
   *
   * The rule, stated in base.css §11 and asserted here: no PERSISTENT column may
   * take the document's measure below 520px (~45 characters), and where the
   * viewport itself cannot afford 520px the document gets essentially all of it.
   * Measured with the assistant OPEN at every width, because that is the state
   * the failure lived in.
   */
  const FLOOR = 520;
  const MEASURE_WIDTHS = [360, 390, 430, 600, 768, 820, 1024, 1280, 1440, 1920];

  test("the document keeps a usable measure at every width, with the assistant OPEN", async () => {
    const seen: string[] = [];
    try {
      for (const width of MEASURE_WIDTHS) {
        await page.setViewport({ width, height: 900 });
        await sleep(260);
        /* open the assistant HERE, at this width — `chat-open` drives a column
           above 1280 and an overlay below it, and only the column can steal
           measure. Clicking the real control rather than poking the class, so
           the persistence path is exercised too. */
        await page.evaluate(() => {
          const a = document.getElementById("app")!;
          if (!a.classList.contains("chat-open")) (document.getElementById("chatBtn") as HTMLElement).click();
        });
        await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
          timeout: 5000,
        });
        await sleep(420); // the grid/overlay transition

        const m = await page.evaluate(() => {
          const doc = document.getElementById("doc")!;
          const cs = getComputedStyle(doc);
          const r = doc.getBoundingClientRect();
          const sb = document.querySelector(".statusbar") as HTMLElement;
          const conn = document.getElementById("stConn")!.getBoundingClientRect();
          const bar = sb.getBoundingClientRect();
          return {
            measure: Math.round(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
            sbOverflow: sb.scrollWidth - sb.clientWidth,
            connInside: conn.width > 0 && conn.right <= bar.right + 0.5 && conn.left >= bar.left - 0.5,
          };
        });

        /* Below the floor the viewport itself is the constraint, so the claim
           becomes "the document is given the whole window" — 40px of gutters is
           the widest any theme takes at phone widths. */
        const want = width >= FLOOR + 60 ? FLOOR : width - 40;
        seen.push(`${width}px → ${m.measure}px measure (>=${want})`);
        expect(`${width}px → ${m.measure >= want ? "ok" : m.measure + "px"} measure (>=${want})`).toBe(
          `${width}px → ok measure (>=${want})`
        );
        /* and the statusbar under it does not amputate its own right-hand end:
           the shed ladder is a CONTAINER query now, so it fires on the bar's own
           width rather than on a window width the bar never had (measured: a
           172px bar with 222px of content and #stConn clipped off the end) */
        expect(`${width}px statusbar overflow: ${m.sbOverflow}px`).toBe(`${width}px statusbar overflow: 0px`);
        expect(`${width}px #stConn inside the bar: ${m.connInside}`).toBe(`${width}px #stConn inside the bar: true`);
      }
    } finally {
      console.log("    measure floor: " + seen.join(" · "));
      await page.setViewport({ width: 1440, height: 900 });
      await sleep(260);
    }
  }, 180000);

  /**
   * The assistant's open/closed choice SURVIVES A RELOAD.
   *
   * This is half of the fix above: a document column that a resize repaired but
   * a reload broke again is not repaired. The shell used to ship `chat-open` in
   * its markup, so closing the panel lasted exactly as long as the page did.
   */
  test("closing the assistant is remembered across a reload", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(220);
    await page.evaluate(() => {
      const a = document.getElementById("app")!;
      if (a.classList.contains("chat-open")) (document.getElementById("chatBtn") as HTMLElement).click();
    });
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForFunction(() => (document.getElementById("stPath")!.textContent ?? "").trim().length > 1, {
      timeout: 15000,
    });
    expect(
      `after reload, chat-open: ${await page.evaluate(() =>
        document.getElementById("app")!.classList.contains("chat-open")
      )}`
    ).toBe("after reload, chat-open: false");
    /* and the doc has the width back, at the width that used to lose it */
    await page.setViewport({ width: 768, height: 900 });
    await sleep(300);
    const measure = await page.evaluate(() => {
      const d = document.getElementById("doc")!;
      const cs = getComputedStyle(d);
      return Math.round(d.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    });
    expect(`768px measure with the assistant remembered closed: ${measure >= FLOOR ? "ok" : measure + "px"}`).toBe(
      "768px measure with the assistant remembered closed: ok"
    );

    /* leave the suite in the state the rest of it expects */
    await page.evaluate(() => {
      const a = document.getElementById("app")!;
      if (!a.classList.contains("chat-open")) (document.getElementById("chatBtn") as HTMLElement).click();
    });
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(260);
  }, 60000);

  /**
   * NO FOCUSABLE TEXT FIELD IS UNDER 16px ON A PHONE.
   *
   * Mobile Safari zooms the viewport in when a field smaller than 16px takes
   * focus and does not zoom back out when it blurs. That turns the entire
   * responsive layout above into a one-tap casualty: the measure floor, the
   * statusbar ladder and the bottom sheet are all computed for a viewport the
   * user is no longer looking at.
   *
   * This is a SWEEP, not a list. It walks every text field actually in the
   * document rather than the handful someone remembered, because the failure
   * is per-field and a field added later would reintroduce it silently. The
   * four the acceptance checklist names are asserted by name afterwards, so
   * this cannot pass by finding none of them mounted.
   */
  test("no focusable text field computes under 16px at 390px (iOS zoom-on-focus)", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await sleep(320);
    /* the create-row, so .newrow input exists: app.js builds it, the shell
       does not ship it. The sidebar is a drawer at this width, so the control
       is off-canvas — .click() in-page is deliberate: the row only has to be
       MOUNTED for its computed style to be readable, and hit-testing it is the
       drawer's gate, not this one's */
    await page.evaluate(() => (document.querySelector('[data-act="new-doc"]') as HTMLElement | null)?.click());
    await sleep(240);

    const probe = await page.evaluate(() => {
      const sel = "input:not([type]), input[type=text], input[type=search], input[type=password], textarea";
      const under: string[] = [];
      for (const n of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
        const fs = parseFloat(getComputedStyle(n).fontSize);
        if (fs < 16) {
          const id = n.id ? "#" + n.id : "";
          under.push(`${n.tagName.toLowerCase()}${id}.${n.className.trim().replace(/\s+/g, ".")}=${fs}px`);
        }
      }
      const named: Record<string, number | null> = {};
      for (const [k, s] of [
        [".composer", ".composer textarea"],
        [".inp", ".inp"],
        [".term-in", ".term-in"],
      ] as const) {
        const n = document.querySelector(s) as HTMLElement | null;
        named[k] = n ? parseFloat(getComputedStyle(n).fontSize) : null;
      }
      return { under, named, total: document.querySelectorAll(sel).length };
    });

    console.log(`    iOS zoom floor: ${probe.total} fields swept · named ${JSON.stringify(probe.named)}`);
    expect(`fields under 16px: ${probe.under.join(", ") || "none"}`).toBe("fields under 16px: none");
    /* and the three the checklist names were really present to be measured */
    for (const k of [".composer", ".inp", ".term-in"]) {
      expect(`${k} computed: ${probe.named[k] === null ? "NOT MOUNTED" : probe.named[k] + "px"}`).toBe(
        `${k} computed: ${probe.named[k]}px`
      );
      expect(`${k} >= 16px: ${(probe.named[k] ?? 0) >= 16}`).toBe(`${k} >= 16px: true`);
    }

    /* the floor is a phone rule and must not leak onto the desktop, where 16px
       mono in the sidebar would wreck the density the theme gates measure */
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(300);
    const desk = await page.evaluate(() => {
      const n = document.querySelector(".inp") as HTMLElement | null;
      return n ? parseFloat(getComputedStyle(n).fontSize) : null;
    });
    expect(`.inp at 1440px is back under the floor: ${desk !== null && desk < 16}`).toBe(
      ".inp at 1440px is back under the floor: true"
    );

    await page.keyboard.press("Escape");
    await sleep(200);
  }, 90000);
});

describe("e2e — editing", () => {
  test("typing in Edit then ⌘S persists the buffer's exact bytes to disk", async () => {
    await page.click(`#tree .row.file[data-doc="${NAV_DOC}"]`);
    await page.waitForFunction(
      (p) => document.getElementById("stPath")!.textContent === p,
      { timeout: 5000 },
      NAV_DOC
    );
    const paragraph = '#doc .bn-editor [data-content-type="paragraph"]';
    await page.waitForSelector(paragraph, { timeout: 20000 });

    /* THE TOPBAR MARK (ADR 0012) is up only while it has news, so its whole
       contract is readable at the three moments this test already passes
       through: a clean doc, a dirty buffer, and a write that landed. Measured
       as PAINT — the class plus the computed opacity — because "the element is
       in the DOM" says nothing here: it is always in the DOM, holding its 13px
       so the crumb beside it cannot be moved by a keystroke. */
    const tbMark = () =>
      page.evaluate(() => {
        const m = document.getElementById("tbSave")!;
        return {
          cls: m.className.replace("tb-save", "").trim(),
          opacity: Math.round(parseFloat(getComputedStyle(m).opacity) * 100) / 100,
          tick: Math.round(parseFloat(getComputedStyle(m.querySelector(".tick")!).opacity) * 100) / 100,
        };
      });
    expect(`a clean doc wears no mark: ${JSON.stringify(await tbMark())}`).toBe(
      'a clean doc wears no mark: {"cls":"","opacity":0,"tick":0}'
    );

    const marker = "TYPED-BY-E2E-" + Date.now();
    await page.click(paragraph);
    await page.keyboard.press("End");
    await page.keyboard.type(` ${marker}`);

    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
      timeout: 5000,
    });
    await sleep(300); // the mark fades IN; read it settled, not mid-transition
    expect(`an unsaved buffer does: ${JSON.stringify(await tbMark())}`).toBe(
      'an unsaved buffer does: {"cls":"dirty","opacity":1,"tick":0}'
    );

    await chord("KeyS");

    /* the write lands → the dot becomes a tick, holds one beat, and leaves of
       its own accord. Waited on rather than slept through, so neither half can
       pass by racing the other. */
    await page.waitForFunction(() => document.getElementById("tbSave")!.classList.contains("saved"), { timeout: 8000 });
    await sleep(300); // past the cross-fade, still inside the beat
    expect(`the write turns it into a tick: ${JSON.stringify(await tbMark())}`).toBe(
      'the write turns it into a tick: {"cls":"saved","opacity":1,"tick":1}'
    );

    const onDisk = await waitUntil(
      () => {
        const t = readVaultText(srv.vault, NAV_DOC);
        return t.includes(marker) ? t : null;
      },
      { timeout: 8000, label: "⌘S to reach disk" }
    );

    expect(onDisk).toBe(await buffer());

    /* the server agrees with disk */
    const api = await srv.doc(NAV_DOC);
    expect(api.body.markdown).toBe(onDisk);

    /* …and then the topbar is quiet again, without anyone dismissing it */
    await page.waitForFunction(() => document.getElementById("tbSave")!.className === "tb-save", { timeout: 6000 });
    await sleep(250); // the tick cross-fades back out under an already-invisible box
    expect(`and then it leaves on its own: ${JSON.stringify(await tbMark())}`).toBe(
      'and then it leaves on its own: {"cls":"","opacity":0,"tick":0}'
    );
  }, 40000);

  test("an external file edit reaches the UI over SSE while the buffer is clean", async () => {
    /* the save above must have landed: over a dirty buffer an external edit is
       a conflict, not a refresh */
    await page.waitForFunction(
      () => document.getElementById("saveTxt")!.textContent !== "Unsaved changes",
      { timeout: 8000 }
    );

    const marker = "EXTERNAL-EDIT-" + Date.now();
    const next = `# Event pipeline\n\nRewritten by vim.\n\n${marker}\n`;
    writeFileSync(join(srv.vault, NAV_DOC), next, "utf8");

    await page.waitForFunction(
      (m) => (document.getElementById("doc")!.textContent ?? "").includes(m),
      { timeout: 8000 },
      marker
    );

    const shown = await page.evaluate(() => document.getElementById("doc")!.textContent ?? "");
    expect(shown).toContain(marker);
    expect(shown).toContain("Rewritten by vim.");
    expect(shown).not.toContain("TYPED-BY-E2E-");

    /* and the buffer holds the new source verbatim */
    expect(await buffer()).toBe(next);
  }, 30000);
});

describe("e2e — ⌘K palette", () => {
  /* The mode chips REPORT as much as they control (ADR 0028): a `/regex/`
     query is a regex whoever did or did not click anything, so the chip that
     lights is the one that describes the search actually being run. */
  async function palType(text: string) {
    await page.evaluate(() => {
      const i = document.getElementById("palInput") as HTMLInputElement;
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.focus("#palInput");
    await page.keyboard.type(text);
    await sleep(320); // the palette's own 90ms debounce, plus the round trip
  }
  const litChip = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".pal-mode")].filter((n) => n.classList.contains("on")).map((n) => n.textContent).join(",")
    );

  test("the mode chip follows what is actually being searched", async () => {
    await chord("KeyK");
    await page.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), { timeout: 5000 });

    await palType("quokka");
    expect(`plain text → ${await litChip()}`).toBe("plain text → fuzzy");

    /* nobody touched the chips — the slashes did it */
    await palType("/QUOKK[A]/");
    expect(`/slashed/ → ${await litChip()}`).toBe("/slashed/ → regex");
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("#palList .pal-item")].some((n) => (n.textContent ?? "").includes("QUOKKA"))
      )
    ).toBe(true);

    /* and taking the slashes off gives the plain query back, unstuck */
    await palType("quokka");
    expect(`unwrapped → ${await litChip()}`).toBe("unwrapped → fuzzy");

    /* clicking regex reads the BARE query as a pattern */
    await palType("QUOKK[A]");
    expect(`bare, fuzzy → ${await litChip()}`).toBe("bare, fuzzy → fuzzy");
    await page.click("#palRegex");
    await sleep(320);
    expect(`bare, toggled → ${await litChip()}`).toBe("bare, toggled → regex");
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("#palList .pal-item")].some((n) => (n.textContent ?? "").includes("QUOKKA"))
      )
    ).toBe(true);

    /* clicking FUZZY on a slashed query searches it literally — and leaves the
       text alone. Rewriting the box to strip the slashes was the other option
       and it silently ate characters (`/x/i` came back as `x`). */
    await palType("/QUOKK[A]/");
    expect(`slashed → ${await litChip()}`).toBe("slashed → regex");
    await page.click("#palFuzzy");
    await sleep(320);
    expect(`clicked fuzzy → ${await litChip()}`).toBe("clicked fuzzy → fuzzy");
    expect(await page.evaluate(() => (document.getElementById("palInput") as HTMLInputElement).value)).toBe(
      "/QUOKK[A]/"
    );

    /* …and the NEXT slashed query someone types still detects itself */
    await palType("/QUOKK[A]/");
    expect(`typed again → ${await litChip()}`).toBe("typed again → regex");

    /* a half-typed pattern explains itself instead of claiming nothing matched */
    await palType("/[/");
    expect(await page.evaluate(() => document.querySelector("#palList .pal-empty")?.textContent ?? "")).toContain(
      "Not a pattern yet"
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("palVeil")!.classList.contains("show"), { timeout: 5000 });
    /* leave the toggle as we found it for the tests below */
    await page.evaluate(() => (document.getElementById("palFuzzy") as HTMLButtonElement).click());
  }, 60000);

  test("⌘K searches doc content and opens the hit", async () => {
    await chord("KeyK");
    await page.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), {
      timeout: 5000,
    });
    await page.focus("#palInput");
    await page.keyboard.type("quokka");

    /* the palette opens pre-populated with every doc, so waiting for "any
       result" would pass before the query ran. Wait for the CONTENT hit —
       the QUOKKA line only exists inside projects/homelab.md. */
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#palList .pal-item")].some((n) =>
          (n.textContent ?? "").includes("QUOKKA")
        ),
      { timeout: 8000 }
    );

    const items = await page.evaluate(() =>
      [...document.querySelectorAll("#palList .pal-item")].map((n) => n.textContent ?? "")
    );
    const idx = items.findIndex((t) => t.includes("QUOKKA"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(items[idx]).toContain("homelab.md");

    await page.evaluate((i) => {
      const nodes = document.querySelectorAll<HTMLElement>("#palList .pal-item");
      nodes[i].click();
    }, idx);

    await page.waitForFunction(
      (p) => document.getElementById("stPath")!.textContent === p,
      { timeout: 8000 },
      HOMELAB
    );
    expect(await page.evaluate(() => document.getElementById("palVeil")!.classList.contains("show"))).toBe(false);
    /* the island mounts asynchronously after the doc is routed */
    await page.waitForFunction(
      () => (document.querySelector(".bn-editor")?.textContent ?? "").includes("QUOKKA"),
      { timeout: 20000 }
    );
  }, 30000);

  test("Esc dismisses the palette", async () => {
    await chord("KeyK");
    await page.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), {
      timeout: 5000,
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("palVeil")!.classList.contains("show"), {
      timeout: 5000,
    });
    expect(await page.evaluate(() => document.getElementById("palVeil")!.classList.contains("show"))).toBe(false);
  }, 20000);
});

describe("e2e — a doc deleted outside the app", () => {
  test("disappears from the sidebar without a reload", async () => {
    const doomed = "projects/doomed-by-vim.md";
    const created = await srv.api("POST", "/api/docs", {
      path: doomed,
      type: "doc",
      markdown: "# Doomed\n\ndeleted by vim in a moment\n",
    });
    expect(created.status).toBe(201);

    await page.waitForFunction(
      (p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`),
      { timeout: 8000 },
      doomed
    );

    unlinkSync(join(srv.vault, doomed));

    /* no polling anywhere in app.js: only an event can clear this row */
    await page.waitForFunction(
      (p) => !document.querySelector(`#tree .row.file[data-doc="${p}"]`),
      { timeout: 8000 },
      doomed
    );
    expect(await page.$(`#tree .row.file[data-doc="${doomed}"]`)).toBe(null);
  }, 40000);
});

/* ============================================================
   boot into a brand-new vault

   `firstRealDoc` returns null when every doc is empty — which is exactly the
   state of a vault where the user made a folder and has not typed yet. The
   fallback must still name a DOC: the tree lists folders before root-level
   files, so falling back to `tree[0]` hands openDoc a folder path and boot ends
   on a "No doc at notes" toast with nothing open.
   ============================================================ */
describe("e2e — boot with an all-empty vault", () => {
  test("opens a document, never a folder path", async () => {
    const fresh = await startServer({ seed: { "inbox.md": "", "notes/a.md": "" } });
    const p = await forgetBrowserState(await browser.newPage());
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.setViewport({ width: 1440, height: 900 });
      await p.goto(fresh.base + "/", { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#app:not([hidden])", { timeout: 20000 });
      await p.waitForFunction(
        () => (document.getElementById("stPath")!.textContent ?? "").endsWith(".md"),
        { timeout: 10000 }
      );

      const st = await p.evaluate(() => ({
        path: document.getElementById("stPath")!.textContent ?? "",
        toast: document.getElementById("toastTxt")!.textContent ?? "",
        toastShown: document.getElementById("toast")!.classList.contains("show"),
        active: document.querySelector<HTMLElement>("#tree .row.file.active")?.dataset.doc ?? null,
      }));

      expect(["inbox.md", "notes/a.md"]).toContain(st.path);
      expect(st.active).toBe(st.path);
      expect(st.toastShown && st.toast.startsWith("No doc at")).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await p.close().catch(() => {});
      await fresh.stop();
    }
  }, 60000);
});
