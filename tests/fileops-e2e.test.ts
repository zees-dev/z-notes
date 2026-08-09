/* ============================================================
   fileops-e2e.test.ts — PHASE 5 e2e gate: sidebar IDE parity (SPEC §5).

   A real browser, the real backend, the real app. What is measured:

     - RENAME happens as an inline edit in the tree — the same idiom as the
       inline-create flow (rounds 2 amendment 4). Esc cancels and changes
       nothing; Enter commits and the tree, the open editor and the statusbar
       path all follow.
     - DELETE asks first, in the app's own modal/veil chrome. Esc (or Cancel)
       leaves the doc alone; confirming removes the row and leaves the editor
       in a sane state.
     - MOVE exists and is fully keyboard-reachable — no drag-only affordance.
     - A BROKEN [[link]] renders flagged and carries a create affordance that
       creates the doc and navigates to it.
     - A second browser page converges after a rename in the first, via SSE,
       with no manual refresh.

   Deliberately implementation-tolerant where the SPEC leaves a choice (which
   control opens the action, which modal element carries the confirm), and
   strict about everything the SPEC fixes (inline input in the tree, Esc
   semantics, what ends up on disk, what the second client sees). When an
   affordance cannot be found at all the failure names every strategy tried.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startServer, type SeedMap, type TestServer } from "./helpers";
import { ensureMode, launchTestBrowser, pressChord, waitForFocusedInput } from "./browser";

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

const RENAME_FROM = "notes/rename-me.md";
const RENAME_TO = "notes/renamed-doc.md";
const KEEPER = "notes/keeper.md";
const DOOMED = "notes/doomed.md";
const MOVER = "notes/mover.md";
const MOVER_TO = "dest/mover.md";
const BROKEN = "notes/broken.md";
const BROKEN_SLUG = "not-a-real-doc";
const CONVERGE_FROM = "notes/converge.md";
const CONVERGE_TO = "notes/converged.md";
/* the phase-5 conflict trigger: a doc the user is TYPING in, whose bytes the
   server rewrites underneath them because it holds a [[link]] to a doc being
   renamed somewhere else in the sidebar */
const CX_REF = "notes/cx-referrer.md";
const CX_TARGET = "notes/cx-target.md";
const CX_TARGET_TO = "notes/cx-target-renamed.md";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nstart here\n",
  [RENAME_FROM]: "# Rename me\n\nthis doc gets a new name from the sidebar\n",
  [KEEPER]: "# Keeper\n\nholds a link to [[rename-me]] that must follow the rename\n",
  [DOOMED]: "# Doomed\n\nthis doc gets deleted from the sidebar\n",
  [MOVER]: "# Mover\n\nthis doc gets moved to another folder\n",
  "dest/anchor.md": "# Anchor\n\njust so dest/ exists before the move\n",
  [BROKEN]: `# Broken\n\na link to [[${BROKEN_SLUG}]] that resolves to nothing, and one to [[inbox]] that does\n`,
  [CONVERGE_FROM]: "# Converge\n\nrenamed in page one while page two watches\n",
  [CX_REF]: "# Cx referrer\n\nholds [[cx-target]] and gets rewritten under the user\n",
  [CX_TARGET]: "# Cx target\n\nrenamed while the referrer has unsaved edits\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;
/** uncaught exceptions only — console noise is logged, never asserted on */
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await instrument(await browser.newPage());
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* one failing test must not cascade into the next: close any inline editor or
   veil the failure left standing, using the app's own Esc path */
afterEach(async () => {
  if (!page) return;
  try {
    for (let i = 0; i < 4; i++) {
      const open = await page.evaluate(
        () =>
          !!document.querySelector("#tree input") ||
          [...document.querySelectorAll(".veil")].some((v) => v.classList.contains("show"))
      );
      if (!open) break;
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () =>
          !document.querySelector("#tree input") &&
          ![...document.querySelectorAll(".veil")].some((v) => v.classList.contains("show")),
        { timeout: 1500 }
      );
    }
  } catch {
    /* best effort — the next test's own waits will report anything real */
  }
});

async function instrument(p: Page): Promise<Page> {
  await p.setViewport({ width: 1440, height: 900 });
  p.on("pageerror", (e) => pageErrors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });
  await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#app:not([hidden])", { timeout: 20000 });
  await p.waitForFunction(() => document.querySelectorAll("#tree .row.file").length > 0, { timeout: 20000 });
  return p;
}

/* ------------------------------------------------------------------
   DOM helpers
   ------------------------------------------------------------------ */

const ROW = (p: string) => `#tree .row.file[data-doc="${p}"]`;
const TREE_INPUT = "#tree input";
/** any input the app opened for this action — inline in the tree, or in a modal */
const ANY_INPUT = "#tree input, .veil.show input, .veil.show textarea";

async function openDoc(p: Page, path: string) {
  /* the tree re-renders whole; a row handle can detach between the wait and
     the click, which is a race in the test, never a product defect */
  for (let i = 0; ; i++) {
    await p.waitForSelector(ROW(path), { timeout: 10000 });
    try {
      await p.click(ROW(path));
      break;
    } catch (err) {
      if (i >= 2) throw err;
    }
  }
  await p.waitForFunction((x) => document.getElementById("stPath")!.textContent === x, { timeout: 10000 }, path);
}

/** [[link]] pills only exist in Preview — make sure that is the mode */
const ensurePreview = (p: Page) => ensureMode(p, "preview");

const treePaths = (p: Page) =>
  p.evaluate(() => [...document.querySelectorAll<HTMLElement>("#tree .row.file")].map((r) => r.dataset.doc!));

const statusPath = (p: Page) => p.evaluate(() => document.getElementById("stPath")!.textContent ?? "");

/** click an element without moving the mouse — hover-revealed controls included */
async function clickMarked(p: Page) {
  const h = await p.$("[data-e2e-hit]");
  if (!h) throw new Error("clickMarked: nothing was marked");
  await h.evaluate((el) => {
    (el as HTMLElement).click();
    el.removeAttribute("data-e2e-hit");
  });
  await h.dispose();
}

/**
 * Open `act` on a doc row. Tries, in order: an explicit control on or beside
 * the row (found by `data-act`, or by the accessible name the SPEC's "matches
 * existing chrome" leaves the app free to choose), a context menu on the row,
 * then the conventional keyboard shortcut. Returns the strategy that worked;
 * throws a report naming all of them when none does.
 */
const ACTION_LABEL: Record<string, RegExp> = {
  rename: /rename/i,
  move: /move/i,
  delete: /delete|remove/i,
};

async function invokeRowAction(p: Page, path: string, act: "rename" | "delete" | "move", keys: string[]) {
  const sel = ROW(path);
  const label = ACTION_LABEL[act].source;
  await p.waitForSelector(sel, { timeout: 10000 });
  await p.hover(sel).catch(() => {});

  const tried: string[] = [];

  /* 1 — a control on (or beside) the row */
  const direct = await p.evaluate(
    (s, a, lab) => {
      const row = document.querySelector(s);
      if (!row) return false;
      /* the row itself, or an actions strip the app parks right next to it —
         NEVER the whole parent list, which would find another row's button */
      const scopes: Element[] = [row];
      if (row.nextElementSibling && !row.nextElementSibling.classList.contains("row"))
        scopes.push(row.nextElementSibling);
      const re = new RegExp(lab, "i");
      for (const sc of scopes) {
        const hit = [...sc.querySelectorAll("[data-act], button, [role='button']")].find((b) => {
          const da = (b.getAttribute("data-act") || "").toLowerCase();
          if (da.includes(a)) return true;
          const name = b.getAttribute("aria-label") || b.getAttribute("title") || "";
          return re.test(name);
        });
        if (hit) {
          hit.setAttribute("data-e2e-hit", "");
          return true;
        }
      }
      return false;
    },
    sel,
    act,
    label
  );
  tried.push(`[data-act*="${act}"] or a control named /${label}/i on the row`);
  if (direct) {
    await clickMarked(p);
    return "row control";
  }

  /* 2 — a context menu on the row */
  const menu = await p.evaluate(
    (s) => {
      const row = document.querySelector(s) as HTMLElement | null;
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.x + r.width / 2),
          clientY: Math.round(r.y + r.height / 2),
        })
      );
      return true;
    },
    sel
  );
  tried.push("contextmenu on the row");
  if (menu) {
    const found = await p
      .waitForFunction(
        (a, lab) => {
          const cands = [...document.querySelectorAll<HTMLElement>('[role="menu"] *, .menu *, .ctx *, .pop.show *')];
          const re = new RegExp(lab, "i");
          const hit = cands.find(
            (el) =>
              (el.getAttribute("data-act") || "").toLowerCase().includes(a) ||
              re.test((el.textContent || "").trim())
          );
          if (!hit) return false;
          hit.setAttribute("data-e2e-hit", "");
          return true;
        },
        { timeout: 1200 },
        act,
        label
      )
      .then(() => true)
      .catch(() => false);
    if (found) {
      await clickMarked(p);
      return "context menu";
    }
    await p.keyboard.press("Escape").catch(() => {});
  }

  /* 3 — the conventional keyboard shortcut on the focused row */
  for (const key of keys) {
    tried.push(`focus the row + ${key}`);
    await p.focus(sel);
    await p.keyboard.press(key as any);
    const opened = await p
      .waitForSelector(ANY_INPUT, { timeout: 800 })
      .then(() => true)
      .catch(() => false);
    const dialog = await p.evaluate(() => !!document.querySelector(".veil.show"));
    if (opened || dialog) return `keyboard ${key}`;
  }

  throw new Error(
    `no "${act}" affordance found for ${path}. Tried:\n  - ` +
      tried.join("\n  - ") +
      `\nSPEC §5 requires rename/move/delete from the sidebar; whichever control the app uses ` +
      `must be discoverable by one of these (a data-act attribute is the app's existing idiom).`
  );
}

/**
 * The state of an inline editor the app just opened. Rename is an inline edit
 * in the tree "matching the inline-create idiom", which means: the input is
 * focused and ready to be typed over — the user never has to select anything.
 */
const inputState = (p: Page, selector: string) =>
  p.evaluate((s) => {
    const el = document.querySelector<HTMLInputElement>(s);
    if (!el) return null;
    return {
      value: el.value,
      selected: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
      focused: document.activeElement === el,
    };
  }, selector);

/** type over whatever the app preselected — no select-all of our own */
async function typeOverSelection(p: Page, selector: string, value: string) {
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.waitForFunction(
    (s) => document.activeElement === document.querySelector(s),
    { timeout: 5000 },
    selector
  );
  await p.keyboard.type(value, { delay: 4 });
}

/** type into the action's input, replacing whatever is there */
async function typeInto(p: Page, selector: string, value: string) {
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.focus(selector);
  await p.evaluate((s) => {
    const el = document.querySelector(s) as HTMLInputElement;
    el.focus();
    el.select?.();
  }, selector);
  await p.keyboard.down("Meta");
  await p.keyboard.press("KeyA");
  await p.keyboard.up("Meta");
  await p.keyboard.type(value, { delay: 4 });
}

/** the visible confirm surface, and its buttons' labels */
const dialogState = (p: Page) =>
  p.evaluate(() => {
    const veils = [...document.querySelectorAll<HTMLElement>(".veil")].filter(
      (v) => v.classList.contains("show") && v.getBoundingClientRect().height > 0
    );
    const v = veils[veils.length - 1];
    if (!v) return { open: false, text: "", buttons: [] as string[] };
    return {
      open: true,
      text: (v.textContent || "").replace(/\s+/g, " ").trim(),
      buttons: [...v.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
    };
  });

async function waitForDialog(p: Page, label: string) {
  await p
    .waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLElement>(".veil")].some(
          (v) => v.classList.contains("show") && v.getBoundingClientRect().height > 0
        ),
      { timeout: 5000 }
    )
    .catch(() => {
      throw new Error(
        `${label}: no confirm surface appeared. A destructive op is human-confirmed (SPEC §5) and must reuse ` +
          `the app's existing .veil/.modal chrome so Esc dismisses it.`
      );
    });
  return dialogState(p);
}

async function clickConfirm(p: Page) {
  const ok = await p.evaluate(() => {
    const veils = [...document.querySelectorAll<HTMLElement>(".veil")].filter((v) => v.classList.contains("show"));
    const v = veils[veils.length - 1];
    if (!v) return null;
    const btns = [...v.querySelectorAll("button")];
    const label = (b: Element) => (b.textContent || "").trim().toLowerCase();
    const hit =
      btns.find((b) => /delete|remove/i.test(label(b)) && !/cancel|keep/i.test(label(b))) ??
      btns.find((b) => /confirm|yes|ok/i.test(label(b)));
    if (!hit) return null;
    (hit as HTMLElement).click();
    return label(hit);
  });
  if (!ok) {
    const st = await dialogState(p);
    throw new Error(`no confirm button in the dialog. Buttons seen: ${JSON.stringify(st.buttons)}`);
  }
  return ok;
}

/* ------------------------------------------------------------------
   0 — the inline CREATE idiom the rename above is modelled on

   Rename has been driven end-to-end here since it was written; create — the
   idiom rename copies, right down to the Esc toast and the blur-cancels timer —
   never was. Everything below is measured through the real sidebar buttons.
   ------------------------------------------------------------------ */

describe("e2e — sidebar inline create (SPEC §5)", () => {
  const NEWROW = "#tree .newrow input";

  test("the New doc button opens a focused, empty inline row with a placeholder", async () => {
    /* Creation is context-aware, so the context has to be PINNED before the
       label can be asserted — a root-level doc puts it at the vault root. */
    await openDoc(page, "inbox.md");
    await page.click('[data-act="new-doc"]');
    await waitForFocusedInput(page, NEWROW);
    const st = await page.evaluate((s) => {
      const i = document.querySelector<HTMLInputElement>(s as string)!;
      return {
        focused: document.activeElement === i,
        value: i.value,
        placeholder: i.placeholder,
        /* the same password-manager suppression the rename row carries — an
           inline tree input is not a credential field */
        onePassword: i.getAttribute("data-1p-ignore"),
        autocomplete: i.getAttribute("autocomplete"),
        name: i.getAttribute("name"),
        spellcheck: i.spellcheck,
        label: i.getAttribute("aria-label"),
      };
    }, NEWROW);
    expect(`focused: ${st.focused}`).toBe("focused: true");
    expect(`seeded empty: ${JSON.stringify(st.value)}`).toBe('seeded empty: ""');
    /* the field EXPLAINS NOTHING (SPEC §5): the placeholder is a bare "name",
       the grammar is not narrated, and there is no hint line under the input */
    expect(`placeholder: ${st.placeholder}`).toBe("placeholder: name");
    expect(`no hint line: ${await page.evaluate(() => !document.querySelector("#tree .newhint"))}`).toBe(
      "no hint line: true"
    );
    /* the label names the CONTEXT the create will land in, which is the whole
       point of the context-aware ⌘N — a blind "New doc name" could not say it */
    expect(`aria-label: ${st.label}`).toBe("aria-label: New doc in the vault root");
    expect(`password managers suppressed: ${st.onePassword === "" && st.autocomplete === "off" && st.name === ""}`).toBe(
      "password managers suppressed: true"
    );
    expect(`spellcheck off: ${st.spellcheck}`).toBe("spellcheck off: false");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
  }, 45000);

  test("Esc cancels, says so, and writes nothing", async () => {
    await page.click('[data-act="new-doc"]');
    await waitForFocusedInput(page, NEWROW);
    await page.keyboard.type("throwaway", { delay: 4 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
    expect(`the toast says so: ${await page.evaluate(() => document.getElementById("toastTxt")!.textContent)}`).toBe(
      "the toast says so: Cancelled"
    );
    expect(`nothing was written → ${(await srv.doc("throwaway.md")).status}`).toBe("nothing was written → 404");
  }, 45000);

  test("Enter on an EMPTY name cancels rather than creating, and the row closes", async () => {
    /* the one place create and rename genuinely differ: create checks the empty
       name BEFORE it latches, so it can fall through to cancel(). A shared
       helper that latched first would leave this row stuck open forever. */
    await page.click('[data-act="new-doc"]');
    await waitForFocusedInput(page, NEWROW);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
    expect(`the tree is back: ${await page.evaluate(() => !!document.querySelector("#tree .row.file"))}`).toBe(
      "the tree is back: true"
    );
    /* …and the app still works: a second create opens normally */
    await page.click('[data-act="new-doc"]');
    await waitForFocusedInput(page, NEWROW);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
  }, 45000);

  test("Enter commits: the doc is created, opened, and on disk", async () => {
    /* the new doc lands beside the OPEN one — pin that, so the assertion is
       about the create and not about whatever the previous test left active */
    await openDoc(page, KEEPER);
    const made = "notes/inline-created.md";
    try {
      await page.click('[data-act="new-doc"]');
      await waitForFocusedInput(page, NEWROW);
      await page.keyboard.type("inline-created.md", { delay: 4 });
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`),
        { timeout: 10000 },
        made
      );
      await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, made);
      expect(`GET the created doc → ${(await srv.doc(made)).status}`).toBe("GET the created doc → 200");
    } finally {
      await srv.api("DELETE", "/api/docs/" + made.split("/").map(encodeURIComponent).join("/"));
    }
  }, 45000);

  test("the New folder button opens the same row with the folder placeholder", async () => {
    await openDoc(page, "inbox.md");
    await page.click('[data-act="new-folder"]');
    await waitForFocusedInput(page, NEWROW);
    const st = await page.evaluate((s) => {
      const i = document.querySelector<HTMLInputElement>(s as string)!;
      return { placeholder: i.placeholder, label: i.getAttribute("aria-label") };
    }, NEWROW);
    expect(`placeholder: ${st.placeholder}`).toBe("placeholder: name");
    expect(`aria-label: ${st.label}`).toBe("aria-label: New folder in the vault root");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
  }, 45000);
});

/* ------------------------------------------------------------------
   1 — rename via the inline input
   ------------------------------------------------------------------ */

describe("e2e — sidebar rename (SPEC §5, inline-create idiom)", () => {
  test("Esc cancels the inline rename and changes nothing", async () => {
    await openDoc(page, RENAME_FROM);
    const strategy = await invokeRowAction(page, RENAME_FROM, "rename", ["F2", "Enter"]);
    // a non-empty template literal is truthy whatever `strategy` is — assert
    // the value itself, the way the move test at the bottom of this file does
    expect(strategy.length).toBeGreaterThan(0);

    /* the fixed decision: rename is an INLINE EDIT IN THE TREE, matching the
       inline-create idiom — focused, seeded, and ready to be typed over. The
       app may seed the bare name or the full vault path (the full path is what
       lets one control serve rename AND move); either way the *name* must be
       what a keystroke replaces. */
    await waitForFocusedInput(page, TREE_INPUT);
    const st = await inputState(page, TREE_INPUT);
    expect(`the inline input exists: ${!!st}`).toBe("the inline input exists: true");
    expect(`the inline input takes focus: ${st!.focused}`).toBe("the inline input takes focus: true");
    expect(`the inline input is seeded with the doc's identity: ${st!.value}`).toBe(
      `the inline input is seeded with the doc's identity: ${
        ["rename-me.md", "notes/rename-me.md"].includes(st!.value) ? st!.value : "rename-me.md or notes/rename-me.md"
      }`
    );
    expect(`the name is preselected, so one keystroke renames: ${JSON.stringify(st!.selected)}`).toBe(
      `the name is preselected, so one keystroke renames: ${
        ["rename-me", "rename-me.md"].includes(st!.selected) ? JSON.stringify(st!.selected) : '"rename-me"'
      }`
    );

    await typeOverSelection(page, TREE_INPUT, "cancelled-name");
    await page.keyboard.press("Escape");

    await page.waitForFunction(() => !document.querySelector("#tree input"), { timeout: 5000 });
    const paths = await treePaths(page);
    expect(`the original row survives Esc: ${paths.includes(RENAME_FROM)}`).toBe("the original row survives Esc: true");
    expect(`Esc created a row anyway: ${paths.some((p) => p.includes("cancelled-name"))}`).toBe(
      "Esc created a row anyway: false"
    );
    expect(await statusPath(page)).toBe(RENAME_FROM);

    const still = await srv.doc(RENAME_FROM);
    expect(`the doc is untouched on the server → ${still.status}`).toBe("the doc is untouched on the server → 200");
    const ghost = await srv.doc("notes/cancelled-name.md");
    expect(`the cancelled name was written → ${ghost.status}`).toBe("the cancelled name was written → 404");
  }, 45000);

  test("Enter commits: tree, open editor, statusbar and disk all follow", async () => {
    await invokeRowAction(page, RENAME_FROM, "rename", ["F2", "Enter"]);
    await typeOverSelection(page, TREE_INPUT, "renamed-doc");
    await page.keyboard.press("Enter");

    await page.waitForFunction((p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`), { timeout: 10000 }, RENAME_TO);

    const paths = await treePaths(page);
    expect(`the new row is in the tree: ${paths.includes(RENAME_TO)}`).toBe("the new row is in the tree: true");
    expect(`the old row is gone: ${!paths.includes(RENAME_FROM)}`).toBe("the old row is gone: true");

    /* the open editor followed the doc rather than pointing at a dead path */
    await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, RENAME_TO);
    const active = await page.evaluate(
      () => document.querySelector<HTMLElement>("#tree .row.file.active")?.dataset.doc ?? null
    );
    expect(`the renamed row is the active one: ${active}`).toBe(`the renamed row is the active one: ${RENAME_TO}`);

    /* disk + backlinks */
    const moved = await srv.doc(RENAME_TO);
    expect(`GET the new path → ${moved.status}`).toBe("GET the new path → 200");
    expect((await srv.doc(RENAME_FROM)).status).toBe(404);

    const keeper = await srv.doc(KEEPER);
    expect(`the backlink was rewritten: ${keeper.body.markdown.includes("[[renamed-doc]]")}`).toBe(
      "the backlink was rewritten: true"
    );
    expect(`the stale backlink is gone: ${!keeper.body.markdown.includes("[[rename-me]]")}`).toBe(
      "the stale backlink is gone: true"
    );

    /* and the referrer's own row is still there, once */
    expect(paths.filter((p) => p === KEEPER).length).toBe(1);
  }, 45000);
});

/* ------------------------------------------------------------------
   2 — delete, confirmed
   ------------------------------------------------------------------ */

describe("e2e — sidebar delete needs a confirm (SPEC §5, human-only)", () => {
  test("Esc on the confirm leaves the doc alone", async () => {
    await openDoc(page, DOOMED);
    await invokeRowAction(page, DOOMED, "delete", ["Delete", "Backspace"]);

    const dlg = await waitForDialog(page, "delete confirm");
    expect(`the confirm names the doc: ${dlg.text.includes("doomed")}  — text was: ${dlg.text.slice(0, 160)}`).toBe(
      `the confirm names the doc: true  — text was: ${dlg.text.slice(0, 160)}`
    );
    expect(`the confirm offers a way out: ${dlg.buttons.some((b) => /cancel|keep|no/i.test(b))}`).toBe(
      "the confirm offers a way out: true"
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => ![...document.querySelectorAll(".veil")].some((v) => v.classList.contains("show")),
      { timeout: 5000 }
    );

    const paths = await treePaths(page);
    expect(`the row survives a cancelled delete: ${paths.includes(DOOMED)}`).toBe(
      "the row survives a cancelled delete: true"
    );
    expect(`the doc survives on the server → ${(await srv.doc(DOOMED)).status}`).toBe(
      "the doc survives on the server → 200"
    );
  }, 45000);

  test("confirming removes the row, deletes the file and leaves the editor sane", async () => {
    await openDoc(page, DOOMED);
    const before = await treePaths(page);

    await invokeRowAction(page, DOOMED, "delete", ["Delete", "Backspace"]);
    await waitForDialog(page, "delete confirm");
    await clickConfirm(page);

    await page.waitForFunction((p) => !document.querySelector(`#tree .row.file[data-doc="${p}"]`), { timeout: 10000 }, DOOMED);

    const after = await treePaths(page);
    expect(`rows removed: ${before.length - after.length}`).toBe("rows removed: 1");
    expect(`the deleted doc is gone from the tree: ${!after.includes(DOOMED)}`).toBe(
      "the deleted doc is gone from the tree: true"
    );
    expect(`GET the deleted doc → ${(await srv.doc(DOOMED)).status}`).toBe("GET the deleted doc → 404");

    /* the editor moved somewhere real — never left pointing at a dead path.
       Re-homing is a second round trip after the tree reload, so wait for it
       rather than sampling the instant the row vanishes. */
    await page
      .waitForFunction((p) => document.getElementById("stPath")!.textContent !== p, { timeout: 8000 }, DOOMED)
      .catch(() => {}); // the assertion below is the one that reports
    const st = await statusPath(page);
    expect(`the statusbar still names the deleted doc: ${st === DOOMED}`).toBe(
      "the statusbar still names the deleted doc: false"
    );
    expect(`the editor landed on a doc that exists: ${st === "" || after.includes(st)} (${st})`).toBe(
      `the editor landed on a doc that exists: true (${st})`
    );
    if (st) {
      expect(`the landing doc resolves → ${(await srv.doc(st)).status}`).toBe("the landing doc resolves → 200");
    }
  }, 45000);
});

/* ------------------------------------------------------------------
   3 — move, keyboard-reachable
   ------------------------------------------------------------------ */

describe("e2e — sidebar move is keyboard-reachable (SPEC §5)", () => {
  test("a move can be driven with the keyboard alone and lands the doc in the new folder", async () => {
    await openDoc(page, MOVER);

    /* keyboard only: focus the row, then either a shortcut opens the move, or a
       focusable control named /move/i is reachable by Tab from the row. A
       drag-only affordance fails here — which is the point. */
    await page.focus(ROW(MOVER));
    const startedOn = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.doc ?? "");
    expect(`the tree row itself is focusable: ${startedOn}`).toBe(`the tree row itself is focusable: ${MOVER}`);

    let how = "";
    for (const key of ["F6", "KeyM", "F2"]) {
      await page.keyboard.press(key as any);
      const opened = await page
        .waitForSelector(ANY_INPUT, { timeout: 600 })
        .then(() => true)
        .catch(() => false);
      if (opened) {
        how = `shortcut ${key}`;
        break;
      }
      await page.focus(ROW(MOVER));
    }

    if (!how) {
      /* Tab-scan for a control whose accessible name says "move" */
      for (let i = 0; i < 6 && !how; i++) {
        await page.keyboard.press("Tab");
        const name = await page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null;
          if (!a) return "";
          return (
            a.getAttribute("aria-label") ||
            a.getAttribute("title") ||
            a.getAttribute("data-act") ||
            a.textContent ||
            ""
          ).trim();
        });
        if (/move/i.test(name)) {
          await page.keyboard.press("Enter");
          const opened = await page
            .waitForSelector(ANY_INPUT, { timeout: 1500 })
            .then(() => true)
            .catch(() => false);
          if (opened) how = `Tab to "${name}" + Enter`;
        }
      }
    }

    expect(
      `the move affordance is keyboard-reachable: ${how || "NO — tried F6/M/F2 on the focused row and 6 Tab stops"}`
    ).toBe(`the move affordance is keyboard-reachable: ${how}`);
    expect(how.length).toBeGreaterThan(0);

    const inputSel = (await page.$(TREE_INPUT)) ? TREE_INPUT : ".veil.show input";
    await typeInto(page, inputSel, MOVER_TO);
    await page.keyboard.press("Enter");

    await page.waitForFunction((p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`), { timeout: 10000 }, MOVER_TO);

    const paths = await treePaths(page);
    expect(`the doc is in its new folder: ${paths.includes(MOVER_TO)}`).toBe("the doc is in its new folder: true");
    expect(`the old location is gone: ${!paths.includes(MOVER)}`).toBe("the old location is gone: true");
    expect(`GET the moved doc → ${(await srv.doc(MOVER_TO)).status}`).toBe("GET the moved doc → 200");
    expect((await srv.doc(MOVER)).status).toBe(404);
  }, 60000);
});

/* ------------------------------------------------------------------
   4 — broken links
   ------------------------------------------------------------------ */

describe("e2e — a broken [[link]] is flagged and offers to create the doc (SPEC §5)", () => {
  test("the dead pill is flagged, the live one is not, and the create affordance creates + opens", async () => {
    await openDoc(page, BROKEN);
    await ensurePreview(page);
    await page.waitForFunction(
      (s) => !!document.querySelector(`#doc a.wl[data-link="${s}"]`),
      { timeout: 10000 },
      BROKEN_SLUG
    );

    const pills = await page.evaluate((s) => {
      const read = (link: string) => {
        const a = document.querySelector<HTMLElement>(`#doc a.wl[data-link="${link}"]`);
        if (!a) return null;
        return {
          cls: a.className,
          flagged:
            /broken|missing|dead|unresolved/i.test(a.className) ||
            a.hasAttribute("data-broken") ||
            a.getAttribute("aria-invalid") === "true" ||
            /broken|missing|unresolved|create/i.test(a.getAttribute("title") || ""),
          title: a.getAttribute("title") || "",
        };
      };
      return { dead: read(s), live: read("inbox") };
    }, BROKEN_SLUG);

    expect(`the dead pill rendered: ${!!pills.dead}`).toBe("the dead pill rendered: true");
    expect(`the live pill rendered: ${!!pills.live}`).toBe("the live pill rendered: true");
    expect(`the dead pill is flagged: ${pills.dead!.flagged} (class="${pills.dead!.cls}")`).toBe(
      `the dead pill is flagged: true (class="${pills.dead!.cls}")`
    );
    expect(`the resolving pill is NOT flagged: ${!pills.live!.flagged} (class="${pills.live!.cls}")`).toBe(
      `the resolving pill is NOT flagged: true (class="${pills.live!.cls}")`
    );

    /* the create affordance: a control inside the pill, or the pill itself */
    await page.evaluate((s) => {
      const a = document.querySelector<HTMLElement>(`#doc a.wl[data-link="${s}"]`)!;
      const inner = [...a.querySelectorAll("[data-act]")].find((b) =>
        /create|new/i.test(b.getAttribute("data-act") || "")
      ) as HTMLElement | undefined;
      (inner ?? a).click();
    }, BROKEN_SLUG);

    await page.waitForFunction(
      (s) => (document.getElementById("stPath")!.textContent ?? "").endsWith(`${s}.md`),
      { timeout: 10000 },
      BROKEN_SLUG
    );

    const created = await statusPath(page);
    expect(`the created doc is open: ${created.endsWith(`${BROKEN_SLUG}.md`)} (${created})`).toBe(
      `the created doc is open: true (${created})`
    );
    const paths = await treePaths(page);
    expect(`the created doc is in the tree: ${paths.includes(created)}`).toBe("the created doc is in the tree: true");
    expect(`GET the created doc → ${(await srv.doc(created)).status}`).toBe("GET the created doc → 200");

    /* going back, the pill is no longer flagged — the link resolves now */
    await openDoc(page, BROKEN);
    await ensurePreview(page);
    await page
      .waitForFunction(
        (s) => {
          const a = document.querySelector<HTMLElement>(`#doc a.wl[data-link="${s}"]`);
          return !!a && !/broken|missing|dead|unresolved/i.test(a.className);
        },
        { timeout: 5000 },
        BROKEN_SLUG
      )
      .catch(() => {}); // let the assertion below produce the readable failure
    const after = await page.evaluate((s) => {
      const a = document.querySelector<HTMLElement>(`#doc a.wl[data-link="${s}"]`);
      return a ? a.className : "(gone)";
    }, BROKEN_SLUG);
    expect(`the pill stopped being flagged: ${!/broken|missing|dead|unresolved/i.test(after)} (class="${after}")`).toBe(
      `the pill stopped being flagged: true (class="${after}")`
    );
  }, 60000);
});

/* ------------------------------------------------------------------
   5 — a second client converges over SSE
   ------------------------------------------------------------------ */

describe("e2e — a second page converges after a rename, with no refresh (SPEC §5 SSE)", () => {
  test("page two's tree and open doc follow the rename made in page one", async () => {
    const p2 = await instrument(await browser.newPage());
    try {
      await openDoc(p2, CONVERGE_FROM);
      const reloads = await p2.evaluate(() => {
        (window as any).__e2eNavCount = ((window as any).__e2eNavCount ?? 0) + 1;
        return (window as any).__e2eNavCount;
      });
      expect(reloads).toBe(1);

      /* the rename happens in page one */
      await openDoc(page, CONVERGE_FROM);
      await invokeRowAction(page, CONVERGE_FROM, "rename", ["F2", "Enter"]);
      await typeOverSelection(page, TREE_INPUT, "converged");
      await page.keyboard.press("Enter");
      await page.waitForFunction((p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`), { timeout: 10000 }, CONVERGE_TO);

      /* page two never reloaded, never re-fetched by hand: SSE alone */
      await p2.waitForFunction(
        (from, to) => {
          const rows = [...document.querySelectorAll<HTMLElement>("#tree .row.file")].map((r) => r.dataset.doc);
          return rows.includes(to) && !rows.includes(from);
        },
        { timeout: 15000 },
        CONVERGE_FROM,
        CONVERGE_TO
      );

      const stillOne = await p2.evaluate(() => (window as any).__e2eNavCount);
      expect(`page two reloaded to converge: ${stillOne !== 1}`).toBe("page two reloaded to converge: false");

      /* its open editor followed too, rather than sitting on a 404 path */
      await p2.waitForFunction((to) => document.getElementById("stPath")!.textContent === to, { timeout: 15000 }, CONVERGE_TO);
      expect(await statusPath(p2)).toBe(CONVERGE_TO);

      const active = await p2.evaluate(
        () => document.querySelector<HTMLElement>("#tree .row.file.active")?.dataset.doc ?? null
      );
      expect(`page two's active row: ${active}`).toBe(`page two's active row: ${CONVERGE_TO}`);
    } finally {
      await p2.close().catch(() => {});
    }
  }, 90000);

  test("nothing in the whole file-ops flow threw in the browser", async () => {
    /* filter the noise other suites tolerate; a rename/delete flow must be clean */
    const real = pageErrors.filter((m) => !/favicon|Failed to load resource/i.test(m));
    expect(real).toEqual([]);
  });
});

/* ------------------------------------------------------------------
   6 — a save that 409s raises the conflict banner (SPEC §5)

   "buffer clean → silent reload …; buffer dirty → conflict banner with diff,
   take-disk / keep-mine". The client used to do neither: on `rev-conflict` it
   re-GET the doc and assigned the disk text straight over the user's buffer,
   destroying unsaved work with no confirmation and no undo. Phase 5 supplies a
   trigger that needs no second device — renaming a doc rewrites the [[links]]
   in its referrers, one of which the user may be typing in right now.
   ------------------------------------------------------------------ */

describe("e2e — a dirty buffer is never overwritten by a 409 (SPEC §5)", () => {
  const TYPED = "MY UNSAVED PARAGRAPH";

  test("renaming a linked doc while typing raises the banner, and Keep mine wins", async () => {
    const errorsBefore = pageErrors.length;
    await openDoc(page, CX_REF);

    /* type in Raw, which is the exact source the save will send */
    /* the statusbar mode chip — one button, it toggles, and the doc opens in
       Preview, so one click is Raw. Asserted rather than assumed. */
    expect(await page.$eval("#stMode", (b) => b.getAttribute("data-mode"))).toBe("preview");
    await page.click("#stMode");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
    await page.focus("#rawArea");
    await page.keyboard.press("End");
    await page.type("#rawArea", "\n" + TYPED + "\n");
    await page.waitForFunction(() => !!document.querySelector("#stDirty, .dirty, [data-dirty='true']") || true);

    /* the server rewrites CX_REF's [[link]] on disk, out from under the buffer */
    const mv = await srv.api("PATCH", "/api/docs/" + CX_TARGET.split("/").map(encodeURIComponent).join("/"), {
      to: CX_TARGET_TO,
    });
    expect(`the referrer was rewritten server-side: ${mv.status} ${mv.body?.backlinksUpdated}`).toBe(
      "the referrer was rewritten server-side: 200 1"
    );

    /* now save: the rev the buffer carries is stale, so this is the 409 */
    await page.click("[data-act='save']:not([hidden])");

    await page.waitForFunction(() => document.getElementById("cxVeil")!.classList.contains("show"), { timeout: 10000 });

    /* the banner names the doc, shows a diff, and offers BOTH ways out */
    const shown = await page.evaluate(() => ({
      path: document.getElementById("cxPath")!.textContent,
      diffLines: document.querySelectorAll("#cxDiff .dl").length,
      hasAdd: !!document.querySelector("#cxDiff .dl.add"),
      hasDel: !!document.querySelector("#cxDiff .dl.del"),
      takeDisk: !!document.querySelector("[data-act='cx-take-disk']"),
      keepMine: !!document.querySelector("[data-act='cx-keep-mine']"),
      raw: (document.getElementById("rawArea") as HTMLTextAreaElement | null)?.value ?? "",
    }));
    expect(`the banner names the doc: ${shown.path}`).toBe(`the banner names the doc: ${CX_REF}`);
    expect(`the banner draws a diff: ${shown.diffLines > 0 && shown.hasAdd && shown.hasDel}`).toBe(
      "the banner draws a diff: true"
    );
    expect(`take-disk offered: ${shown.takeDisk}`).toBe("take-disk offered: true");
    expect(`keep-mine offered: ${shown.keepMine}`).toBe("keep-mine offered: true");

    /* THE assertion: the typing is still in the editor, untouched */
    expect(`the buffer still holds what was typed: ${shown.raw.includes(TYPED)}`).toBe(
      "the buffer still holds what was typed: true"
    );

    /* keep-mine re-saves against the rev the server just reported */
    await page.click("[data-act='cx-keep-mine']");
    await page.waitForFunction(() => !document.getElementById("cxVeil")!.classList.contains("show"), { timeout: 5000 });
    await page.waitForFunction(
      async (path, needle) => {
        const r = await fetch("/api/docs/" + path.split("/").map(encodeURIComponent).join("/"));
        if (!r.ok) return false;
        return String((await r.json()).markdown).includes(needle);
      },
      { timeout: 10000 },
      CX_REF,
      TYPED
    );

    const onDisk = (await srv.doc(CX_REF)).body.markdown as string;
    expect(`keep-mine reached disk: ${onDisk.includes(TYPED)}`).toBe("keep-mine reached disk: true");

    const real = pageErrors.slice(errorsBefore).filter((m) => !/favicon|Failed to load resource/i.test(m));
    expect(real).toEqual([]);
  }, 90000);
});

/* ------------------------------------------------------------------
   0b — CONTEXT-AWARE, PATH-AWARE creation (SPEC §5)

   Two claims, both measured through the real keyboard and the real sidebar,
   both checked against the FILES the server actually holds:

     · ⌘N / ⇧⌘N create relative to what you are looking at — the picked folder,
       else the picked-or-open doc's folder, else the vault root;
     · the input takes a PATH, and the trailing slash is what says "folder".

   Plus the refusal that used to be a toast: a duplicate now keeps the row open
   with the typed name still in it and the server's own 409 message under it.

   The row is otherwise SILENT: no hint line narrates the grammar while you
   type. The only second line that ever mounts is a refusal.
   ------------------------------------------------------------------ */

describe("e2e — creation is context-aware and path-aware (SPEC §5)", () => {
  const NEWROW = "#tree .newrow input";
  /* the ONLY thing this selector can ever match now is a refusal */
  const HINT = "#tree .newhint";

  const chordN = async (shift: boolean) => {
    await page.keyboard.down("Meta");
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press("KeyN");
    if (shift) await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    await waitForFocusedInput(page, NEWROW);
  };
  const ctx = () => page.$eval(NEWROW, (n) => n.getAttribute("aria-label")!);
  const hint = () => page.$eval(HINT, (n) => n.textContent!);
  const focusRow = (path: string) =>
    page.evaluate((p) => (document.querySelector(`#tree .row[data-path="${p}"]`) as HTMLElement).focus(), path);
  const escape = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
  };
  const del = (p: string) => srv.api("DELETE", "/api/docs/" + p.split("/").map(encodeURIComponent).join("/"));

  test("⌘N from an OPEN doc creates in that doc's parent folder", async () => {
    await openDoc(page, KEEPER); // notes/keeper.md
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await chordN(false);
    expect(`context: ${await ctx()}`).toBe("context: New doc in notes");
    await escape();
  }, 45000);

  test("⌘N from a FOCUSED folder row creates inside that folder", async () => {
    await openDoc(page, KEEPER); // the open doc says "notes"…
    await focusRow("dest"); // …and the picked folder overrules it
    await chordN(false);
    expect(`context: ${await ctx()}`).toBe("context: New doc in dest");
    await escape();
  }, 45000);

  test("⇧⌘N resolves the SAME context — a folder create is no longer pinned to the root", async () => {
    await openDoc(page, KEEPER);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await chordN(true);
    expect(`context: ${await ctx()}`).toBe("context: New folder in notes");
    await escape();
  }, 45000);

  test("a/b/c.md creates the intermediate folders and the doc, and opens it in Raw", async () => {
    await openDoc(page, KEEPER);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    try {
      await chordN(false);
      await page.keyboard.type("a/b/c.md", { delay: 4 });
      /* nothing is narrated while typing — a legal path draws no second line */
      expect(`no hint line: ${!(await page.$(HINT))}`).toBe("no hint line: true");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.getElementById("stPath")!.textContent === "notes/a/b/c.md",
        { timeout: 10000 }
      );
      expect(`GET notes/a/b/c.md → ${(await srv.doc("notes/a/b/c.md")).status}`).toBe("GET notes/a/b/c.md → 200");
      expect(`the folders are real: ${statSync(join(srv.vault, "notes/a/b")).isDirectory()}`).toBe(
        "the folders are real: true"
      );
      expect(`url: ${await page.evaluate(() => location.pathname)}`).toBe("url: /d/notes/a/b/c.md");
      expect(`opens in Raw: ${await page.evaluate(() => document.getElementById("doc")!.classList.contains("raw-mode"))}`).toBe(
        "opens in Raw: true"
      );
    } finally {
      await del("notes/a/b/c.md");
    }
  }, 45000);

  test("a bare name gets .md; a trailing slash makes a FOLDER instead", async () => {
    await openDoc(page, KEEPER);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    try {
      await chordN(false);
      await page.keyboard.type("plain", { delay: 4 });
      expect(`bare name draws no hint: ${!(await page.$(HINT))}`).toBe("bare name draws no hint: true");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.getElementById("stPath")!.textContent === "notes/plain.md",
        { timeout: 10000 }
      );

      /* the same DOC-mode gesture, with a trailing slash: a folder, not a doc */
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await chordN(false);
      await page.keyboard.type("abc/", { delay: 4 });
      expect(`trailing slash draws no hint: ${!(await page.$(HINT))}`).toBe("trailing slash draws no hint: true");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => !!document.querySelector('#tree .row.folder[data-path="notes/abc"]'),
        { timeout: 10000 }
      );
      expect(`notes/abc is a dir: ${statSync(join(srv.vault, "notes/abc")).isDirectory()}`).toBe(
        "notes/abc is a dir: true"
      );
      expect(`notes/abc.md was NOT made: ${existsSync(join(srv.vault, "notes/abc.md"))}`).toBe(
        "notes/abc.md was NOT made: false"
      );
    } finally {
      await del("notes/plain.md");
      await del("notes/abc");
    }
  }, 45000);

  test("a duplicate is refused: the row stays open, the name stays typed, the server's 409 is shown", async () => {
    await openDoc(page, KEEPER); // context = notes/, where keeper.md already is
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const bytesBefore = readFileSync(join(srv.vault, KEEPER), "utf8");
    await chordN(false);
    await page.keyboard.type("keeper.md", { delay: 4 });
    await page.keyboard.press("Enter");
    /* the hint carries the SERVER's sentence, not a generic one — proof the
       409 was surfaced rather than swallowed */
    await page.waitForFunction(
      () => (document.querySelector("#tree .newhint")?.textContent || "").includes("Pick another name"),
      { timeout: 10000 }
    );
    const st = await page.evaluate(() => {
      const note = document.querySelector("#tree .newhint") as HTMLElement;
      /* the line no longer needs a `.bad` modifier — it exists ONLY for
         refusals — so measure the paint instead of a class name: it must be
         rendered in the danger colour, visibly, not merely present */
      const danger = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim();
      const probe = document.createElement("span");
      probe.style.color = danger;
      document.body.appendChild(probe);
      const dangerRGB = getComputedStyle(probe).color;
      probe.remove();
      return {
        open: !!document.querySelector("#tree .newrow input"),
        value: (document.querySelector("#tree .newrow input") as HTMLInputElement).value,
        hint: note.textContent,
        visible: note.getBoundingClientRect().height > 0 && !note.hidden,
        danger: getComputedStyle(note).color === dangerRGB,
      };
    });
    expect(`row still open: ${st.open}`).toBe("row still open: true");
    expect(`typed name kept: ${st.value}`).toBe("typed name kept: keeper.md");
    expect(`hint: ${st.hint}`).toBe("hint: notes/keeper.md already exists. Pick another name.");
    expect(`the refusal is visible: ${st.visible}`).toBe("the refusal is visible: true");
    expect(`painted as a refusal: ${st.danger}`).toBe("painted as a refusal: true");
    /* and the doc that was already there is untouched */
    expect(`keeper.md unchanged: ${readFileSync(join(srv.vault, KEEPER), "utf8") === bytesBefore}`).toBe(
      "keeper.md unchanged: true"
    );
    /* the row is correctable in place, which is the point of holding it open */
    await waitForFocusedInput(page, NEWROW);
    await page.keyboard.type("2", { delay: 4 });
    /* the refusal described the OLD value: typing retires the whole LINE, and
       nothing informational takes its place. Asserted as absence rather than as
       "empty or hidden": SPEC §5 says the line is mounted only to carry a
       refusal, and an emptied one left in the DOM at zero height is the shape
       that claim used to be false of. */
    expect(`the refusal line is gone: ${await page.evaluate(() => !document.querySelector("#tree .newhint"))}`).toBe(
      "the refusal line is gone: true"
    );
    await escape();
  }, 45000);

  test("an intermediate segment that is a DOC is refused before the round trip", async () => {
    await openDoc(page, KEEPER);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await chordN(false);
    await page.keyboard.type("keeper.md/child.md", { delay: 4 });
    /* silent while typing… */
    expect(`no hint while typing: ${!(await page.$(HINT))}`).toBe("no hint while typing: true");
    await page.keyboard.press("Enter");
    await Bun.sleep(200);
    /* …and the refusal lands on Enter, before any round trip */
    expect(`hint: ${await hint()}`).toBe("hint: notes/keeper.md is a doc, not a folder.");
    expect(`still open, nothing sent: ${!!(await page.$(NEWROW))}`).toBe("still open, nothing sent: true");
    await escape();
  }, 45000);

  test("a name carrying `]` is refused — the client mirrors the server's link guard", async () => {
    await openDoc(page, KEEPER);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await chordN(false);
    await page.keyboard.type("x]]y", { delay: 4 });
    await page.keyboard.press("Enter");
    await Bun.sleep(200);
    expect(`hint mentions the link: ${(await hint()).includes("[[link]]")}`).toBe("hint mentions the link: true");
    expect(`nothing was written: ${existsSync(join(srv.vault, "notes/x]]y.md"))}`).toBe("nothing was written: false");
    await escape();
  }, 45000);

  test("the create context reveals itself: a collapsed ancestor is opened so the input is visible", async () => {
    /* make a folder two deep, collapse everything, then create inside it */
    await srv.api("POST", "/api/docs", { path: "deep/er/est", type: "folder" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('#tree .row.folder[data-path="deep"]', { timeout: 15000 });
    const boxH = (sel: string) =>
      page.evaluate((s) => {
        const n = document.querySelector(s as string) as HTMLElement | null;
        return n ? n.getBoundingClientRect().height : -1;
      }, sel);
    await page.click('#tree .row.folder[data-path="deep"]');
    await page.waitForFunction(
      () => (document.querySelector('#tree .row.folder[data-path="deep/er/est"]') as HTMLElement)
              .getBoundingClientRect().height === 0,
      { timeout: 5000 }
    );
    expect(`est is collapsed out of sight: ${await boxH('#tree .row.folder[data-path="deep/er/est"]')}`).toBe(
      "est is collapsed out of sight: 0"
    );
    try {
      await openDoc(page, KEEPER);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await chordN(false);
      /* a leading slash re-bases on the vault root rather than the context —
         which is now proved by WHERE the doc lands, not by a hint line */
      await page.keyboard.type("/deep/er/est/from-root.md", { delay: 4 });
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.getElementById("stPath")!.textContent === "deep/er/est/from-root.md",
        { timeout: 10000 }
      );
      /* and the row it created is now VISIBLE — every ancestor was opened */
      expect(
        `the new row is visible: ${(await boxH('#tree .row.file[data-doc="deep/er/est/from-root.md"]')) > 0}`
      ).toBe("the new row is visible: true");
    } finally {
      await del("deep");
    }
  }, 60000);
});

/* ------------------------------------------------------------------
   THE THREE GESTURES — rename and create without going through a menu.

   Everything below already had a route: rename lived on F2 and on the
   hover pencil, create on ⌘N. What was missing was the gesture the hand
   already knows, and in one case a chord that a browser tab is even
   capable of receiving:

     · DOUBLE-CLICK a row → rename. The pointer twin of ⏎, and the
       gesture every file manager on both platforms has trained.
     · ⏎ on the focused row → rename. The row is a <button>, so Enter and
       Space were the SAME gesture and one was spare. Enter goes to
       rename (the file-manager rule) and Space keeps open/toggle — which
       is why "Space still opens" is a test here and not an afterthought:
       spending Enter would be a regression if it left the row with no
       keyboard way to open at all.
     · ⌥N / ⌥⇧N → create. ⌘N is the BROWSER's "new window" and a tab
       never sees it, so the old binding was unreachable outside an
       installed app. ⌘N stays bound and its own tests above still pass;
       these prove the chord that actually arrives.

   One thing these tests CANNOT prove, stated so nobody deletes the
   guard that handles it: puppeteer synthesises `e.key` from its own key
   table, so ⌥N arrives here as `key: "n"`. On real macOS ⌥N is a DEAD
   KEY and `e.key` is "Dead" — which is why app.js matches on `e.code`,
   and why removing that branch would pass this suite and break the
   feature on every Mac.
   ------------------------------------------------------------------ */

describe("e2e — rename and create are reachable by gesture (⏎, double-click, ⌥N)", () => {
  const NEWROW = "#tree .newrow input";
  const RENAMING = "#tree .newrow.renaming input";
  const FOLDER_ROW = (p: string) => `#tree .row.folder[data-path="${p}"]`;

  const focusRow = (path: string) =>
    page.evaluate((p) => (document.querySelector(`#tree .row[data-path="${p}"]`) as HTMLElement).focus(), path);
  const del = (p: string) => srv.api("DELETE", "/api/docs/" + p.split("/").map(encodeURIComponent).join("/"));
  /** the path the inline editor is carrying — a rename row is seeded with it */
  const editing = () => page.$eval(RENAMING, (n) => (n as HTMLInputElement).value);
  const ctx = () => page.$eval(NEWROW, (n) => n.getAttribute("aria-label")!);
  const escape = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tree .newrow input"), { timeout: 5000 });
  };
  /** park the app on a known doc with NOTHING picked, so context is unambiguous */
  const parkOn = async (path: string) => {
    await openDoc(page, path);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  test("double-clicking a doc row opens the rename editor on THAT doc", async () => {
    await parkOn(KEEPER);
    await page.click(ROW("inbox.md"), { count: 2 });
    await waitForFocusedInput(page, RENAMING);
    expect(`editing: ${await editing()}`).toBe("editing: inbox.md");
    await escape();
  }, 45000);

  test("double-clicking a FOLDER row renames the folder, not something inside it", async () => {
    await parkOn(KEEPER);
    await page.click(FOLDER_ROW("dest"), { count: 2 });
    await waitForFocusedInput(page, RENAMING);
    /* the two clicks toggle the folder twice and startRename reveals it again,
       so it ends up OPEN — showing what would travel with the move */
    expect(`editing: ${await editing()}`).toBe("editing: dest");
    await escape();
  }, 45000);

  test("⏎ on a focused row renames it — and does NOT open the doc", async () => {
    await parkOn(KEEPER);
    await focusRow("inbox.md");
    await page.keyboard.press("Enter");
    await waitForFocusedInput(page, RENAMING);
    expect(`editing: ${await editing()}`).toBe("editing: inbox.md");
    /* the whole point of preventDefault in rowKeys: without it the button's
       native Enter→click still fires and inbox.md opens behind the row */
    expect(`still on: ${await statusPath(page)}`).toBe(`still on: ${KEEPER}`);
    await escape();
  }, 45000);

  test("Space still OPENS the focused row — ⏎ took rename, not the row's only key", async () => {
    await parkOn(KEEPER);
    await focusRow("inbox.md");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "inbox.md", { timeout: 10000 });
    expect(`opened: ${await statusPath(page)}`).toBe("opened: inbox.md");
    /* and it opened INSTEAD of renaming — no inline editor was mounted */
    expect(`no rename row: ${!(await page.$(RENAMING))}`).toBe("no rename row: true");
  }, 45000);

  test("⌥N opens the create row with the same context ⌘N resolves", async () => {
    await parkOn(KEEPER); // notes/keeper.md
    await pressChord(page, "KeyN", "Alt");
    await waitForFocusedInput(page, NEWROW);
    expect(`context: ${await ctx()}`).toBe("context: New doc in notes");
    await escape();
  }, 45000);

  test("⌥⇧N creates a FOLDER in that same context", async () => {
    await parkOn(KEEPER);
    await pressChord(page, "KeyN", "Alt", "Shift");
    await waitForFocusedInput(page, NEWROW);
    expect(`context: ${await ctx()}`).toBe("context: New folder in notes");
    await escape();
  }, 45000);

  test("a double-click rename reaches DISK, not just the input", async () => {
    const from = "notes/gesture-src.md";
    const to = "notes/gesture-dst.md";
    await srv.api("POST", "/api/docs", { path: from, type: "doc", markdown: "# gesture\n" });
    await page.waitForSelector(ROW(from), { timeout: 10000 });
    try {
      await page.click(ROW(from), { count: 2 });
      await waitForFocusedInput(page, RENAMING);
      /* the row seeds the FULL PATH with only the basename preselected, so a
         bare name replaces the name and leaves the folder alone — typing a
         path here would nest it. Same contract F2 has. */
      await page.keyboard.type("gesture-dst", { delay: 4 });
      await page.keyboard.press("Enter");
      await page.waitForSelector(ROW(to), { timeout: 10000 });
      expect(`on disk: ${existsSync(join(srv.vault, to))}`).toBe("on disk: true");
      expect(`old path gone: ${!existsSync(join(srv.vault, from))}`).toBe("old path gone: true");
    } finally {
      await del(to).catch(() => {});
      await del(from).catch(() => {});
    }
  }, 60000);
});
