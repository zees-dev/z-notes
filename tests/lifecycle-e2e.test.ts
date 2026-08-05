/* ============================================================
   lifecycle-e2e.test.ts — the SILENT-LOSS paths (SPEC §4 "Saving", §5).

   Both subjects here failed the same way: the app kept going, said nothing,
   and the user's text was gone. They get their own file because both need the
   same unusual fixture — an autosave debounce turned OFF — and because a test
   that can only fail by LOSING SOMETHING deserves to be read on its own.

     1. THE LIFECYCLE FLUSH. The autosave debounce is a `setTimeout`, and a page
        frozen on `visibilitychange → hidden` runs no timers. iOS discards a
        backgrounded tab without reliably firing `pagehide`, which used to be
        the only flush — so up to a full debounce of typing had no route to
        disk. Measured here with the debounce at its MAXIMUM (3600s), so the
        only thing that can possibly write the file is the flush itself: if the
        assertion passes, it passed for exactly one reason.

        Second case: a body over the browser's ~64KiB `keepalive` allowance,
        which `fetch` rejects outright. The flush is `quiet`, so that rejection
        was silent loss growing with how much had been written — the request
        drops `keepalive` rather than the bytes.

     2. THE ORPHANED BUFFER. A doc deleted elsewhere used to take the cache
        entry with it, which turned the next ⌘S into a no-op with no request,
        no dialog and no toast, under an indicator still reading "Unsaved
        changes". A dirty buffer now survives its file and the save asks
        Recreate / Discard. A CLEAN buffer still evaporates — that half is
        asserted too, because "keep everything" would be a different bug.

   `srv.api("DELETE", …)` stands in for the other client throughout: what the
   app sees is a `doc-changed` with `removed: true` on the SSE stream, which is
   byte-identically what a second browser, a `git pull` or an `rm` produces.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser } from "./browser";

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

const FLUSH_DOC = "notes/flush.md";
const BIG_DOC = "notes/big.md";
const ORPHAN_DOC = "notes/orphan.md";
const CLEAN_DOC = "notes/clean.md";
const DISCARD_DOC = "notes/discard.md";
const AUTO_DOC = "notes/autosave-orphan.md";
const HEAL_DOC = "notes/heal.md";
const ANCHOR = "notes/anchor.md";

/** what gets typed and then has to be findable on disk */
const CANARY = "CANARY-" + Math.random().toString(36).slice(2, 10);

/* Comfortably over the 64KiB keepalive allowance and over the 60KiB the client
   budgets for it, so the fallback is what is being measured and not a boundary
   rounding. One long line keeps the raw textarea cheap to render. */
const BIG_BODY = "# Big\n\n" + "x".repeat(90 * 1024) + "\n";

/**
 * THE FIXTURE THAT MAKES THE FLUSH TESTS MEAN ANYTHING: the autosave debounce
 * at the MAXIMUM the settings allow.
 *
 * At the default 10s, "the bytes are on disk a few seconds after hiding" is
 * ambiguous — the debounce could have won the race, and the test would pass
 * with the fix reverted. At 3600s the debounce cannot have fired, so a file
 * that changed changed for exactly one reason.
 *
 * `git.autoSync = false` is unrelated housekeeping: the temp vault is not a
 * repo, and a sync scheduler ticking through the run is noise in the log.
 */
const SETTINGS_TOML = `[editor]\nautosaveSeconds = 3600\n\n[git]\nautoSync = false\n`;

const SEED: SeedMap = {
  ".znotes/settings.toml": SETTINGS_TOML,
  [ANCHOR]: "# Anchor\n\nsomewhere to land after a discard\n",
  [FLUSH_DOC]: "# Flush\n\ntyped here, then the tab is hidden\n",
  [BIG_DOC]: BIG_BODY,
  [ORPHAN_DOC]: "# Orphan\n\ndeleted elsewhere while this buffer is dirty\n",
  [CLEAN_DOC]: "# Clean\n\ndeleted elsewhere with nothing unsaved\n",
  [DISCARD_DOC]: "# Discard\n\ndeleted elsewhere, and the user lets it stand\n",
  [AUTO_DOC]: "# Autosave\n\ndeleted elsewhere while the AUTOSAVE is what notices\n",
  [HEAL_DOC]: "# Heal\n\ntyped while the network is down, and then it comes back\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });
  await boot();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* a veil left standing by a failure must not decide the next test */
afterEach(async () => {
  if (!page) return;
  try {
    await page.evaluate(() => {
      document.querySelectorAll(".veil.show").forEach((v) => v.classList.remove("show"));
      document.getElementById("toast")?.classList.remove("show", "sticky");
    });
  } catch {}
});

async function boot() {
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 25000 });
  await page.waitForFunction(() => document.querySelectorAll("#tree .row.file").length > 0, { timeout: 25000 });
  /* The fixture, verified against the SERVER rather than against the file we
     wrote: settings.ts heals a value it dislikes, and a healed 10 would make
     the flush assertions vacuous without ever failing. */
  const s = await srv.get("/api/settings");
  expect(`the autosave debounce is off for this suite: ${s.body?.settings?.editor?.autosaveSeconds}`).toBe(
    "the autosave debounce is off for this suite: 3600"
  );
}

/* ------------------------------------------------------------------
   DOM / disk helpers
   ------------------------------------------------------------------ */

const diskText = (rel: string) => (existsSync(join(srv.vault, rel)) ? readFileSync(join(srv.vault, rel), "utf8") : null);

const ROW = (p: string) => `#tree .row.file[data-doc="${p}"]`;

async function openDoc(path: string) {
  for (let i = 0; ; i++) {
    await page.waitForSelector(ROW(path), { timeout: 10000 });
    try {
      await page.click(ROW(path));
      break;
    } catch (err) {
      if (i >= 2) throw err;
    }
  }
  await page.waitForFunction((x) => document.getElementById("stPath")!.textContent === x, { timeout: 15000 }, path);
}

/** Raw is the byte-faithful surface, so it is the one the save actually sends. */
async function toRaw() {
  const mode = await page.$eval("#stMode", (b) => b.getAttribute("data-mode"));
  if (mode !== "raw") await page.click("#stMode");
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

/** Append text the way a person would, so `input` → `markDirty` really runs. */
async function typeAtEnd(text: string) {
  await page.focus("#rawArea");
  await page.evaluate(() => {
    const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.type("#rawArea", text);
  await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
    timeout: 8000,
  });
}

/**
 * Hide the page the way the OS does.
 *
 * `document.visibilityState` is read-only, so it is shadowed for the duration
 * of the event — the app reads the property, and a dispatched event with the
 * real value still "visible" would be testing nothing. Restored afterwards so
 * the next test starts from a page that believes it is on screen.
 */
async function hidePage() {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function showPage() {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** poll the file until `want` shows up, and report how long that took */
async function waitOnDisk(rel: string, want: string, timeout = 15000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const body = diskText(rel);
    if (body && body.includes(want)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) return -1;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/* ------------------------------------------------------------------
   1 — the lifecycle flush
   ------------------------------------------------------------------ */

describe("visibilitychange flushes the buffer (SPEC §4)", () => {
  test("hiding the tab writes unsaved text to disk; the debounce never runs", async () => {
    await openDoc(FLUSH_DOC);
    await toRaw();
    await typeAtEnd("\n" + CANARY + "\n");

    /* THE PRE-CONDITION. Without this the test could pass on a file that was
       already written, and the whole measurement would be vacuous. */
    const before = diskText(FLUSH_DOC) ?? "";
    expect(`the canary is on disk BEFORE hiding: ${before.includes(CANARY)}`).toBe(
      "the canary is on disk BEFORE hiding: false"
    );

    const took = await hidePage().then(() => waitOnDisk(FLUSH_DOC, CANARY, 15000));
    expect(`the canary reached disk after hidden: ${took >= 0}`).toBe("the canary reached disk after hidden: true");
    console.log(`[lifecycle] visibilitychange→hidden flushed ${CANARY} in ${took}ms (debounce = 3600s)`);

    /* and the app agrees it is saved, rather than sitting on a phantom dirty */
    await showPage();
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent !== "Unsaved changes", {
      timeout: 8000,
    });
  }, 60000);

  test("a body over the keepalive allowance still lands (it drops keepalive, not the bytes)", async () => {
    await openDoc(BIG_DOC);
    await toRaw();

    const bytes = await page.$eval("#rawArea", (t) => new TextEncoder().encode((t as HTMLTextAreaElement).value).length);
    expect(`the buffer is over the 64KiB keepalive cap: ${bytes > 65536}`).toBe(
      "the buffer is over the 64KiB keepalive cap: true"
    );

    const big = CANARY + "-BIG";
    await typeAtEnd("\n" + big + "\n");
    expect(`the canary is on disk BEFORE hiding: ${(diskText(BIG_DOC) ?? "").includes(big)}`).toBe(
      "the canary is on disk BEFORE hiding: false"
    );

    const took = await hidePage().then(() => waitOnDisk(BIG_DOC, big, 20000));
    expect(`a ${bytes}-byte buffer reached disk after hidden: ${took >= 0}`).toBe(
      `a ${bytes}-byte buffer reached disk after hidden: true`
    );
    console.log(`[lifecycle] ${bytes} bytes flushed on hidden in ${took}ms (keepalive dropped, request kept)`);
    await showPage();
  }, 90000);

  /* THE MIRROR OF THE FLUSH: a save that FAILED has no second attempt of its
     own. `doSaveDoc` clears `dirtyT` before it tries the PUT and only a
     keystroke re-arms it, so a save that lost the network was the LAST one —
     and `resyncAfterGap`, the only other thing the heal runs, returns
     immediately on a dirty buffer by design (it must never clobber typing).
     Measured before the fix: the chip read "connected" beside an indicator
     reading "Unsaved changes", with the text still not on disk long after.

     The debounce is at 3600s for this whole suite, so nothing here can be the
     timer winning a race: the only thing that can write the file is the heal. */
  test("coming back online retries the write that failed while it was down", async () => {
    await openDoc(HEAL_DOC);
    await toRaw();
    const canary = CANARY + "-HEAL";
    await typeAtEnd("\n" + canary + "\n");

    await page.setOfflineMode(true);
    try {
      /* an explicit save, so the failure is deterministic rather than waiting
         on a debounce that is turned off anyway */
      await page.click("[data-act='save']:not([hidden])");
      await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent === "Unsaved changes", {
        timeout: 8000,
      });
      expect(`the failed save left nothing on disk: ${(diskText(HEAL_DOC) ?? "").includes(canary)}`).toBe(
        "the failed save left nothing on disk: false"
      );
      expect(`…and the buffer still says it is unsaved: ${await page.evaluate(() => document.getElementById("saveTxt")!.textContent)}`).toBe(
        "…and the buffer still says it is unsaved: Unsaved changes"
      );
    } finally {
      await page.setOfflineMode(false);
    }

    /* the network comes back. NOTHING is typed and nothing is clicked. */
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const took = await waitOnDisk(HEAL_DOC, canary, 15000);
    expect(`the heal retried the write: ${took >= 0}`).toBe("the heal retried the write: true");
    console.log(`[lifecycle] online → flush wrote ${HEAL_DOC} in ${took}ms (debounce = 3600s)`);
    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent !== "Unsaved changes", {
      timeout: 8000,
    });
  }, 90000);
});

/* ------------------------------------------------------------------
   2 — the orphaned buffer
   ------------------------------------------------------------------ */

describe("a deletion elsewhere never takes an unsaved buffer with it (SPEC §5)", () => {
  test("dirty buffer survives, the notice is sticky, and ⌘S offers Recreate", async () => {
    await openDoc(ORPHAN_DOC);
    await toRaw();
    const typed = CANARY + "-ORPHAN";
    await typeAtEnd("\n" + typed + "\n");

    /* the other client */
    const del = await srv.api("DELETE", "/api/docs/" + encode(ORPHAN_DOC));
    expect(`the other client deleted it: ${del.status}`).toBe("the other client deleted it: 204");
    expect(`the file is gone from disk: ${diskText(ORPHAN_DOC) === null}`).toBe("the file is gone from disk: true");

    /* the app has to have HEARD about it — the sticky notice is the signal */
    await page.waitForFunction(() => document.getElementById("toast")!.classList.contains("sticky"), { timeout: 10000 });

    /* THE FIRST ASSERTION: the text is still on screen. */
    const stillThere = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
    expect(`the buffer still holds what was typed: ${stillThere.includes(typed)}`).toBe(
      "the buffer still holds what was typed: true"
    );

    /* THE SECOND: the notice does not evaporate at 1.9s. */
    await new Promise((r) => setTimeout(r, 2600));
    const notice = await page.evaluate(() => {
      const t = document.getElementById("toast")!;
      return { shown: t.classList.contains("show"), sticky: t.classList.contains("sticky"), text: t.textContent ?? "" };
    });
    expect(`the notice is still up 2.6s later: ${notice.shown && notice.sticky}`).toBe(
      "the notice is still up 2.6s later: true"
    );
    expect(`the notice says the text is still here: ${/unsaved text is still here/i.test(notice.text)}`).toBe(
      "the notice says the text is still here: true"
    );

    /* THE THIRD, and the one that used to be a silent no-op: ⌘S. */
    await page.click("[data-act='save']:not([hidden])");
    await page.waitForFunction(() => document.getElementById("cxVeil")!.classList.contains("show"), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 200)); // the focus move is a 30ms timeout after the veil shows
    const veil = await page.evaluate(() => ({
      path: document.getElementById("cxPath")!.textContent,
      title: document.getElementById("cxTitle")!.textContent ?? "",
      recreate: !(document.getElementById("cxRecreate") as HTMLElement).hidden,
      discard: !(document.getElementById("cxDiscard") as HTMLElement).hidden,
      keepMine: !(document.getElementById("cxMine") as HTMLElement).hidden,
      addedLines: document.querySelectorAll("#cxDiff .dl.add").length,
      focused: (document.activeElement as HTMLElement | null)?.id ?? "",
    }));
    expect(`the veil names the doc: ${veil.path}`).toBe(`the veil names the doc: ${ORPHAN_DOC}`);
    expect(`the veil says the doc is gone: ${/no longer in the vault/i.test(veil.title)}`).toBe(
      "the veil says the doc is gone: true"
    );
    expect(`Recreate and Discard are offered, Keep mine is not: ${veil.recreate && veil.discard && !veil.keepMine}`).toBe(
      "Recreate and Discard are offered, Keep mine is not: true"
    );
    expect(`the diff shows the buffer as added lines: ${veil.addedLines > 0}`).toBe(
      "the diff shows the buffer as added lines: true"
    );
    /* a save the USER asked for hands the default verb the focus: they pressed
       the button, they are looking at the answer, and Tab/⏎ should land on it.
       (The autosave-raised veil deliberately does not — see below.) */
    expect(`a user-initiated save focuses Recreate: ${veil.focused}`).toBe(
      "a user-initiated save focuses Recreate: cxRecreate"
    );

    /* THE FOURTH: Recreate is a button somebody presses, and it really writes. */
    await page.click("[data-act='cx-recreate']");
    const took = await waitOnDisk(ORPHAN_DOC, typed, 15000);
    expect(`Recreate put the buffer back on disk: ${took >= 0}`).toBe("Recreate put the buffer back on disk: true");
    console.log(`[lifecycle] Recreate wrote ${ORPHAN_DOC} in ${took}ms`);

    await page.waitForFunction(() => document.getElementById("saveTxt")!.textContent !== "Unsaved changes", {
      timeout: 8000,
    });
    await page.waitForFunction(
      (p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`),
      { timeout: 10000 },
      ORPHAN_DOC
    );
  }, 90000);

  test("Discard lets the deletion stand", async () => {
    await openDoc(DISCARD_DOC);
    await toRaw();
    await typeAtEnd("\n" + CANARY + "-DISCARD\n");

    const del = await srv.api("DELETE", "/api/docs/" + encode(DISCARD_DOC));
    expect(`deleted elsewhere: ${del.status}`).toBe("deleted elsewhere: 204");
    await page.waitForFunction(() => document.getElementById("toast")!.classList.contains("sticky"), { timeout: 10000 });

    await page.click("[data-act='save']:not([hidden])");
    await page.waitForFunction(() => document.getElementById("cxVeil")!.classList.contains("show"), { timeout: 10000 });
    await page.click("[data-act='cx-discard']");
    await page.waitForFunction(() => !document.getElementById("cxVeil")!.classList.contains("show"), { timeout: 8000 });

    /* it stays deleted, and the app lands somewhere real rather than on a
       document that does not exist */
    await new Promise((r) => setTimeout(r, 800));
    expect(`the file is still gone: ${diskText(DISCARD_DOC) === null}`).toBe("the file is still gone: true");
    const landed = await page.evaluate(() => document.getElementById("stPath")!.textContent ?? "");
    expect(`the pane is not on the discarded doc: ${landed !== DISCARD_DOC && landed.length > 0}`).toBe(
      "the pane is not on the discarded doc: true"
    );
  }, 90000);

  test("a CLEAN buffer still evaporates — retention is scoped to unsaved work", async () => {
    await openDoc(CLEAN_DOC);
    await toRaw();
    expect(await page.evaluate(() => document.getElementById("saveTxt")!.textContent)).not.toBe("Unsaved changes");

    const del = await srv.api("DELETE", "/api/docs/" + encode(CLEAN_DOC));
    expect(`deleted elsewhere: ${del.status}`).toBe("deleted elsewhere: 204");

    /* the row goes, and the notice is the ORDINARY self-expiring kind */
    await page.waitForFunction(
      (p) => !document.querySelector(`#tree .row.file[data-doc="${p}"]`),
      { timeout: 10000 },
      CLEAN_DOC
    );
    const sticky = await page.evaluate(() => document.getElementById("toast")!.classList.contains("sticky"));
    expect(`a clean deletion is NOT sticky: ${sticky}`).toBe("a clean deletion is NOT sticky: false");

    /* and the cache entry is really gone, so nothing can re-create it later */
    const cached = await page.evaluate(
      (p) => !!document.querySelector(`#tree .row.file[data-doc="${p}"]`),
      CLEAN_DOC
    );
    expect(`the clean orphan evaporated: ${!cached}`).toBe("the clean orphan evaporated: true");
  }, 60000);

  /* ------------------------------------------------------------------
     the veil the ORDINARY AUTOSAVE raises
     ------------------------------------------------------------------ */
  test("an autosave-raised veil does not put a destructive default under the caret", async () => {
    await openDoc(AUTO_DOC);
    await toRaw();
    await typeAtEnd("\n" + CANARY + "-AUTO");

    /* the other client, while the buffer is dirty */
    const del = await srv.api("DELETE", "/api/docs/" + encode(AUTO_DOC));
    expect(`the other client deleted it: ${del.status}`).toBe("the other client deleted it: 204");
    await page.waitForFunction(() => document.getElementById("toast")!.classList.contains("sticky"), { timeout: 10000 });

    /* ONLY NOW is the debounce turned on, so the orphan state is established
       before any timer can fire and the sequence cannot race. One more
       keystroke re-arms `dirtyT` at the new interval — which is exactly what a
       writer does: they keep typing, and then they pause to think. */
    const put = await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 1 } });
    expect(`the debounce was turned down for this test: ${put.status}`).toBe(
      "the debounce was turned down for this test: 200"
    );
    try {
      await new Promise((r) => setTimeout(r, 900)); // let settings-changed land
      await page.type("#rawArea", "!");

      /* NOTHING IS CLICKED AND NOTHING IS PRESSED FROM HERE ON. The veil opens
         on its own, which is the whole premise. */
      await page.waitForFunction(() => document.getElementById("cxVeil")!.classList.contains("show"), {
        timeout: 15000,
      });
      await new Promise((r) => setTimeout(r, 200)); // the focus move is a 30ms timeout

      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? "");
      expect(`an unprompted veil did not focus the Recreate button: ${focused}`).not.toBe(
        "an unprompted veil did not focus the Recreate button: cxRecreate"
      );

      /* …and the writer resumes mid-sentence. The FIRST character is a space,
         which is how a focused <button> is pressed. Measured before the fix:
         the file was written back to disk with no deliberate press and all 26
         following characters were swallowed. */
      await page.keyboard.type(" and now the next sentence");
      await new Promise((r) => setTimeout(r, 900));

      expect(`the deliberately deleted file is still deleted: ${diskText(AUTO_DOC) === null}`).toBe(
        "the deliberately deleted file is still deleted: true"
      );
      expect(
        `the veil is still asking: ${await page.evaluate(() => document.getElementById("cxVeil")!.classList.contains("show"))}`
      ).toBe("the veil is still asking: true");

      /* the buttons are still REACHABLE — this is a focus decision, not a trap */
      await page.click("[data-act='cx-discard']");
      await page.waitForFunction(() => !document.getElementById("cxVeil")!.classList.contains("show"), {
        timeout: 8000,
      });
    } finally {
      await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } });
      await new Promise((r) => setTimeout(r, 600));
    }
  }, 120000);

  test("no uncaught page errors along any of it", () => {
    expect(`uncaught page errors: ${pageErrors.join(" | ")}`).toBe("uncaught page errors: ");
  });
});
