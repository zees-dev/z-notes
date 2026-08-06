/* ============================================================
   trash-e2e.test.ts — the sidebar trash, and where a delete leaves you.

   A real browser, the real backend, the real app. Two things are measured, and
   they are separable:

     1. WHAT OPENS AFTER A DELETE. Not "some doc" — the NEIGHBOUR, in tree
        order: the next sibling, else the previous one, else the parent's next
        sibling once the folder is empty, else the vault. And nothing at all
        when the doc you deleted is not the doc you were reading. All of that
        runs against the real server with no stubbing whatsoever.

     2. THE TRASH DRAWER. Its list/restore/purge routes are served here rather
        than by server.ts, because that half of the contract is landing in
        parallel. This is NOT a fake of the effect: RESTORE re-creates the doc
        through the app's own `POST /api/docs`, so the git commit, the sqlite
        index, the SSE announcement and the 409-on-a-taken-path are all the
        real server's, and DELETE is the real `DELETE /api/docs/{path}` with
        the trash row recorded on the way past. What is stubbed is the storage
        of the entry, not any behaviour the UI is asserted on.

   The first test deliberately runs with the trash routes OFF, because the
   degradation is part of the contract: a server without a trash must leave the
   sidebar exactly as it was and must leave the delete dialog saying what it
   said before — a dialog that promises a trash that is not there is worse than
   one that promises nothing.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, waitUntil, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser } from "./browser";

/* ------------------------------------------------------------------
   fixtures

   The folder names carry the tree ORDER the neighbour walk is asserted on.
   `buildTree` lists folders before files and sorts each group, so at the root
   this is: a-seq/, m-lone/, n-next/, inbox.md.
   ------------------------------------------------------------------ */

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nthe doc you are on when you delete something else\n",
  "a-seq/a1.md": "# A1\n\nfirst of three\n",
  "a-seq/a2.md": "# A2\n\nthe middle one — deleted first\n",
  "a-seq/a3.md": "# A3\n\nthe last one\n",
  "m-lone/only.md": "# Only\n\nthe only doc in its folder\n",
  "n-next/n1.md": "# N1\n\nwhere an emptied m-lone/ has to land\n",
};

const RETENTION_DAYS = 30;

/* ------------------------------------------------------------------
   the trash store — see the header. Node-side, one per file.
   ------------------------------------------------------------------ */

interface Entry {
  id: string;
  path: string;
  kind: "doc" | "folder";
  deletedAt: string;
  size: number;
  purgeAt: string;
  body: string;
}

let store: Entry[] = [];
let trashOn = false;
let nextId = 1;

const publicEntry = (e: Entry) => ({
  id: e.id,
  path: e.path,
  kind: e.kind,
  deletedAt: e.deletedAt,
  size: e.size,
  purgeAt: e.purgeAt,
});

function record(path: string, body: string) {
  const now = Date.now();
  store.unshift({
    id: "t" + nextId++,
    path,
    kind: "doc",
    deletedAt: new Date(now).toISOString(),
    size: Buffer.byteLength(body),
    purgeAt: new Date(now + RETENTION_DAYS * 86400000).toISOString(),
    body,
  });
}

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** `/api/docs/a/b%20c.md` → `a/b c.md`, the inverse of api.js `encPath`. */
const decDocPath = (pathname: string) =>
  pathname
    .slice("/api/docs/".length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");

async function installTrashRoutes(p: Page) {
  await p.setRequestInterception(true);
  p.on("request", async (req) => {
    const pass = () => req.continue().catch(() => {});
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return pass();
    }
    const m = u.pathname;
    const method = req.method();
    const reply = (r: ReturnType<typeof json>) => req.respond(r).catch(() => {});

    try {
      /* the real delete, with the entry taken on the way past. Read BEFORE the
         server removes the file — this is the last moment the bytes exist. */
      if (method === "DELETE" && m.startsWith("/api/docs/")) {
        if (trashOn) {
          const rel = decDocPath(m);
          const abs = join(srv.vault, rel);
          if (existsSync(abs)) record(rel, readFileSync(abs, "utf8"));
        }
        return pass();
      }
      if (!m.startsWith("/api/trash")) return pass();
      if (!trashOn) return reply(json(404, { error: "not-found", message: "no trash on this server" }));

      if (m === "/api/trash" && method === "GET")
        return reply(json(200, { entries: store.map(publicEntry), retentionDays: RETENTION_DAYS }));

      if (m === "/api/trash/purge" && method === "POST") {
        const n = store.length;
        store = [];
        return reply(json(200, { purged: n }));
      }

      const restore = /^\/api\/trash\/([^/]+)\/restore$/.exec(m);
      if (restore && method === "POST") {
        const e = store.find((x) => x.id === decodeURIComponent(restore[1]));
        if (!e) return reply(json(404, { error: "not-found" }));
        /* THE REAL CREATE. 409 `exists` is the server's own, not this file's. */
        const res = await fetch(srv.base + "/api/docs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: e.path, type: "file", markdown: e.body }),
        });
        if (res.status === 409) return reply(json(409, { error: "exists", message: e.path + " already exists" }));
        if (!res.ok) return reply(json(500, { error: "restore-failed", message: "HTTP " + res.status }));
        store = store.filter((x) => x !== e);
        return reply(json(200, { path: e.path }));
      }

      const one = /^\/api\/trash\/([^/]+)$/.exec(m);
      if (one && method === "DELETE") {
        const id = decodeURIComponent(one[1]);
        store = store.filter((x) => x.id !== id);
        return reply({ status: 204, contentType: "text/plain", body: "" });
      }
      return reply(json(405, { error: "method-not-allowed" }));
    } catch (err) {
      return reply(json(500, { error: "mock-failed", message: String(err) }));
    }
  });
}

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (mg) => {
    if (mg.type() === "error") console.error("[browser console]", mg.text());
  });
  await installTrashRoutes(page);
  await boot(page);
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

afterEach(async () => {
  if (!page) return;
  for (let i = 0; i < 4; i++) {
    const open = await page
      .evaluate(() => [...document.querySelectorAll(".veil")].some((v) => v.classList.contains("show")))
      .catch(() => false);
    if (!open) break;
    await page.keyboard.press("Escape").catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
});

/* ------------------------------------------------------------------
   page vocabulary
   ------------------------------------------------------------------ */

async function boot(p: Page, query = "") {
  await p.goto(srv.base + "/" + query, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#app:not([hidden])", { timeout: 25000 });
  await p.waitForFunction(() => document.querySelectorAll("#tree .row.file").length > 0, { timeout: 25000 });
}

const ROW = (path: string) => `#tree .row.file[data-doc="${path}"]`;
const statusPath = (p: Page) => p.evaluate(() => document.getElementById("stPath")!.textContent ?? "");
const treePaths = (p: Page) =>
  p.evaluate(() => [...document.querySelectorAll<HTMLElement>("#tree .row.file")].map((r) => r.dataset.doc!));

async function openDoc(p: Page, path: string) {
  for (let i = 0; ; i++) {
    await p.waitForSelector(ROW(path), { timeout: 15000 });
    try {
      await p.click(ROW(path));
      break;
    } catch (err) {
      if (i >= 2) throw err;
    }
  }
  await p.waitForFunction((x) => document.getElementById("stPath")!.textContent === x, { timeout: 15000 }, path);
}

/** Click the row's own Delete button — no hover needed, the click is synthetic
    so a `:hover`-revealed control is still a real control to press. */
async function pressRowDelete(p: Page, path: string) {
  await p.waitForSelector(ROW(path), { timeout: 15000 });
  const found = await p.evaluate((sel) => {
    const row = document.querySelector(sel);
    const acts = row && row.parentElement ? row.parentElement.querySelector(".rowacts") : null;
    const btn = acts ? (acts.lastElementChild as HTMLElement | null) : null;
    if (!btn) return false;
    btn.click();
    return true;
  }, ROW(path));
  if (!found) throw new Error("no delete affordance beside " + path);
  await p.waitForFunction(() => document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
}

const confirmText = (p: Page) =>
  p.evaluate(() => ({
    title: document.getElementById("cfTitle")!.textContent ?? "",
    path: document.getElementById("cfPath")!.textContent ?? "",
    body: document.getElementById("cfBody")!.textContent ?? "",
    note: document.getElementById("cfNote")!.textContent ?? "",
    ok: document.getElementById("cfOkTxt")!.textContent ?? "",
  }));

async function confirmOk(p: Page) {
  await p.click("#cfOk");
  await p.waitForFunction(() => !document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
}

async function deleteDoc(p: Page, path: string) {
  await pressRowDelete(p, path);
  await confirmOk(p);
  await p.waitForFunction((x) => !document.querySelector(`#tree .row.file[data-doc="${x}"]`), { timeout: 15000 }, path);
}

const trashState = (p: Page) =>
  p.evaluate(() => {
    const box = document.getElementById("sbTrash")!;
    const link = document.getElementById("trashLink") as HTMLElement | null;
    const count = document.getElementById("trashCount") as HTMLElement | null;
    return {
      mounted: !box.hidden,
      open: link ? link.getAttribute("aria-expanded") === "true" : false,
      count: count && !count.hidden ? count.textContent : null,
      rows: [...document.querySelectorAll<HTMLElement>("#trashList .trash-item")].map((r) => ({
        path: (r.querySelector(".trash-path") as HTMLElement)?.textContent ?? "",
        when: (r.querySelector(".trash-when") as HTMLElement)?.textContent ?? "",
        acts: [...r.querySelectorAll<HTMLElement>(".trash-act")].map((b) => b.textContent ?? ""),
        err: (r.querySelector(".trash-err") as HTMLElement)?.textContent ?? "",
      })),
      empty: (document.querySelector("#trashList .trash-empty") as HTMLElement)?.textContent ?? null,
    };
  });

const waitTrashRows = (p: Page, n: number) =>
  p.waitForFunction((k) => document.querySelectorAll("#trashList .trash-item").length === k, { timeout: 15000 }, n);

async function openTrash(p: Page) {
  const already = await p.evaluate(() => document.getElementById("trashLink")!.getAttribute("aria-expanded") === "true");
  if (!already) await p.click("#trashLink");
  await p.waitForFunction(() => document.getElementById("trashLink")!.getAttribute("aria-expanded") === "true", {
    timeout: 8000,
  });
  /* the open pays for a fetch — wait for it to have settled */
  await p.waitForFunction(() => !document.querySelector("#trashList .trash-empty")?.textContent?.includes("Reading"), {
    timeout: 15000,
  });
}

/** Press Restore / Delete on the nth trash row. */
async function pressTrashAct(p: Page, row: number, which: "restore" | "purge") {
  const ok = await p.evaluate(
    (i, cls) => {
      const r = document.querySelectorAll<HTMLElement>("#trashList .trash-item")[i];
      const b = r ? (r.querySelector("." + cls) as HTMLElement | null) : null;
      if (!b) return false;
      b.click();
      return true;
    },
    row,
    which
  );
  if (!ok) throw new Error(`no ${which} button on trash row ${row}`);
}

const vaultHasDoc = (rel: string) => existsSync(join(srv.vault, rel));

/* ==================================================================
   1 · WHAT OPENS AFTER A DELETE
   ================================================================== */

describe("after a delete, the neighbour opens", () => {
  test("with no trash route, the sidebar stays as it was and the dialog keeps its old promise", async () => {
    /* trashOn is still false here — this is the degradation, measured first so
       nothing later can have taught the app the trash exists. */
    const t = await trashState(page);
    expect(`the trash block is mounted: ${t.mounted}`).toBe("the trash block is mounted: false");

    await pressRowDelete(page, "a-seq/a1.md");
    const c = await confirmText(page);
    expect(`the note says: ${c.note}`).toBe("the note says: Recoverable only from git history.");
    expect(`it does not promise a trash: ${!/trash/i.test(c.body)}`).toBe("it does not promise a trash: true");
    expect(`and it still warns about links: ${/BROKEN/.test(c.body)}`).toBe("and it still warns about links: true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 5000 });
    expect(`a1 is untouched: ${vaultHasDoc("a-seq/a1.md")}`).toBe("a1 is untouched: true");

    /* from here on the routes are live */
    trashOn = true;
    await boot(page);
    await page.waitForFunction(() => !document.getElementById("sbTrash")!.hidden, { timeout: 15000 });
    expect(`now the block is mounted: ${(await trashState(page)).mounted}`).toBe("now the block is mounted: true");
  }, 90000);

  test("the delete dialog now says trash, for how long, and still says BROKEN", async () => {
    await pressRowDelete(page, "a-seq/a2.md");
    const c = await confirmText(page);
    expect(`the note: ${c.note}`).toBe(`the note: In the trash for ${RETENTION_DAYS} days, then purged for good.`);
    expect(`no git-history promise: ${!/git history/i.test(c.note + c.body)}`).toBe("no git-history promise: true");
    expect(`the body says where it goes: ${/goes to the trash/.test(c.body)}`).toBe(
      "the body says where it goes: true"
    );
    expect(`…and that links break until it is restored: ${/BROKEN until it is restored/.test(c.body)}`).toBe(
      "…and that links break until it is restored: true"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 5000 });
  }, 60000);

  test("deleting the MIDDLE doc of a folder opens the next sibling", async () => {
    await openDoc(page, "a-seq/a2.md");
    expect(`before: ${await statusPath(page)}`).toBe("before: a-seq/a2.md");
    expect(`the folder holds: ${JSON.stringify((await treePaths(page)).filter((p) => p.startsWith("a-seq/")))}`).toBe(
      'the folder holds: ["a-seq/a1.md","a-seq/a2.md","a-seq/a3.md"]'
    );

    await deleteDoc(page, "a-seq/a2.md");
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "a-seq/a3.md", {
      timeout: 15000,
    });
    expect(`after: ${await statusPath(page)}`).toBe("after: a-seq/a3.md");
  }, 90000);

  test("deleting the LAST doc of a folder opens the previous sibling", async () => {
    await openDoc(page, "a-seq/a3.md");
    expect(`the folder now holds: ${JSON.stringify((await treePaths(page)).filter((p) => p.startsWith("a-seq/")))}`).toBe(
      'the folder now holds: ["a-seq/a1.md","a-seq/a3.md"]'
    );

    await deleteDoc(page, "a-seq/a3.md");
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "a-seq/a1.md", {
      timeout: 15000,
    });
    expect(`after: ${await statusPath(page)}`).toBe("after: a-seq/a1.md");
  }, 90000);

  test("emptying a folder climbs to the parent's next sibling", async () => {
    await openDoc(page, "m-lone/only.md");
    await deleteDoc(page, "m-lone/only.md");
    /* m-lone/ has nothing left, so the walk goes up and takes the next folder
       at the root — n-next/, whose first doc is n1 */
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "n-next/n1.md", {
      timeout: 15000,
    });
    expect(`after: ${await statusPath(page)}`).toBe("after: n-next/n1.md");
  }, 90000);

  test("deleting a doc you are NOT reading does not navigate", async () => {
    await openDoc(page, "inbox.md");
    /* let the open's own history write land before it is used as a baseline —
       `stPath` is painted from the buffer, the URL is written a tick later */
    await new Promise((r) => setTimeout(r, 500));
    const snap = () =>
      page.evaluate(() => ({
        path: document.getElementById("stPath")!.textContent,
        url: location.pathname,
        len: history.length,
        state: history.state && history.state.z,
      }));
    const before = await snap();

    await deleteDoc(page, "a-seq/a1.md");
    /* give any stray navigation a chance to happen before asserting it did not */
    await new Promise((r) => setTimeout(r, 700));
    const after = await snap();
    expect(`still on: ${after.path}`).toBe("still on: inbox.md");
    expect(`the address bar did not move: ${after.url === before.url}`).toBe("the address bar did not move: true");
    /* The confirm owns the one overlay-dismissal marker every modal owns
       (routing.test.ts). The delete itself must not add a document entry. */
    expect(`only the confirm marker was minted: ${after.len === before.len + 1 && after.state === "veil"}`).toBe(
      "only the confirm marker was minted: true"
    );
  }, 90000);
});

/* ==================================================================
   2 · THE TRASH DRAWER
   ================================================================== */

describe("the sidebar trash", () => {
  test("sits above New doc / Folder, is quieter than both, and counts what is in it", async () => {
    const geom = await page.evaluate(() => {
      const trash = document.getElementById("trashLink")!.getBoundingClientRect();
      const foot = document.querySelector(".sb-foot")!.getBoundingClientRect();
      const nav = document.querySelector(".sb-nav")!.getBoundingClientRect();
      const tree = document.getElementById("tree")!.getBoundingClientRect();
      const cs = (el: Element) => getComputedStyle(el);
      const px = (v: string) => parseFloat(v);
      return {
        trashBottom: trash.bottom,
        footTop: foot.top,
        navTop: nav.top,
        treeBottom: tree.bottom,
        inFoot: !!document.getElementById("trashLink")!.closest(".sb-foot"),
        inNav: !!document.getElementById("trashLink")!.closest(".sb-nav"),
        trashSize: px(cs(document.getElementById("trashLink")!).fontSize),
        miniSize: px(cs(document.querySelector('.mini[data-act="new-doc"]')!).fontSize),
        navSize: px(cs(document.getElementById("settingsLink")!).fontSize),
        trashColor: cs(document.getElementById("trashLink")!).color,
        navColor: cs(document.getElementById("settingsLink")!).color,
      };
    });
    expect(`the trash sits above .sb-foot: ${geom.trashBottom <= geom.footTop}`).toBe(
      "the trash sits above .sb-foot: true"
    );
    expect(`…and below the tree: ${geom.trashBottom >= geom.treeBottom}`).toBe("…and below the tree: true");
    expect(`…and above .sb-nav: ${geom.trashBottom <= geom.navTop}`).toBe("…and above .sb-nav: true");
    expect(`it is in neither block: ${!geom.inFoot && !geom.inNav}`).toBe("it is in neither block: true");
    expect(`its type is smaller than New doc's (${geom.trashSize} < ${geom.miniSize})`).toBe(
      `its type is smaller than New doc's (${geom.trashSize} < ${geom.miniSize})`
    );
    expect(`smaller than New doc: ${geom.trashSize < geom.miniSize}`).toBe("smaller than New doc: true");
    expect(`smaller than Settings: ${geom.trashSize < geom.navSize}`).toBe("smaller than Settings: true");
    expect(`and a different, quieter ink than Settings: ${geom.trashColor !== geom.navColor}`).toBe(
      "and a different, quieter ink than Settings: true"
    );

    /* four docs have been deleted by the block above */
    await page.waitForFunction(() => document.getElementById("trashCount")!.textContent === "4", { timeout: 15000 });
    const t = await trashState(page);
    expect(`the badge reads: ${t.count}`).toBe("the badge reads: 4");
    expect(`and it is shut: ${!t.open}`).toBe("and it is shut: true");
  }, 60000);

  test("expands in place, listing every deleted doc with when it went and when it goes", async () => {
    const before = await page.evaluate(() => ({ url: location.pathname, len: history.length }));
    await openTrash(page);
    await waitTrashRows(page, 4);
    const t = await trashState(page);
    const after = await page.evaluate(() => ({ url: location.pathname, len: history.length }));

    expect(`the paths listed: ${JSON.stringify(t.rows.map((r) => r.path))}`).toBe(
      'the paths listed: ["a-seq/a1.md","m-lone/only.md","a-seq/a3.md","a-seq/a2.md"]'
    );
    expect(`each row dates itself: ${t.rows.every((r) => /^deleted /.test(r.when))}`).toBe(
      "each row dates itself: true"
    );
    expect(`each row says when it is purged: ${t.rows.every((r) => /purges in \d+d$/.test(r.when))}`).toBe(
      "each row says when it is purged: true"
    );
    expect(`the first row reads: ${t.rows[0].when.replace(/\d+/g, "N")}`).toBe(
      "the first row reads: deleted just now · purges in Nd"
    );
    expect(`the two verbs: ${JSON.stringify(t.rows[0].acts)}`).toBe('the two verbs: ["Restore","Delete"]');
    expect(`it is a disclosure, not a route: ${after.url === before.url && after.len === before.len}`).toBe(
      "it is a disclosure, not a route: true"
    );
  }, 60000);

  test("Restore puts the doc back at its original path, with its bytes", async () => {
    await openTrash(page);
    await waitTrashRows(page, 4);
    /* row 3 is a-seq/a2.md — the middle doc from the first block */
    const target = (await trashState(page)).rows[3].path;
    expect(`restoring: ${target}`).toBe("restoring: a-seq/a2.md");
    expect(`it is off disk now: ${!vaultHasDoc(target)}`).toBe("it is off disk now: true");

    await pressTrashAct(page, 3, "restore");
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "a-seq/a2.md", {
      timeout: 20000,
    });

    expect(`back on disk: ${vaultHasDoc("a-seq/a2.md")}`).toBe("back on disk: true");
    expect(`with its bytes: ${JSON.stringify(readFileSync(join(srv.vault, "a-seq/a2.md"), "utf8"))}`).toBe(
      `with its bytes: ${JSON.stringify(SEED["a-seq/a2.md"])}`
    );
    expect(`back in the tree: ${(await treePaths(page)).includes("a-seq/a2.md")}`).toBe("back in the tree: true");
    expect(`and open in the editor: ${await statusPath(page)}`).toBe("and open in the editor: a-seq/a2.md");
    await page.waitForFunction(() => document.getElementById("trashCount")!.textContent === "3", { timeout: 15000 });
    expect(`the badge is down to: ${(await trashState(page)).count}`).toBe("the badge is down to: 3");
  }, 90000);

  test("a restore onto an occupied path is refused ON THE ROW, and changes nothing", async () => {
    /* put something back where a3 used to be, so its restore has to fail */
    const res = await fetch(srv.base + "/api/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a-seq/a3.md", type: "file", markdown: "# Squatter\n\nnot the original\n" }),
    });
    expect(`the squatter was created: ${res.status}`).toBe("the squatter was created: 201");

    await boot(page);
    await openTrash(page);
    await waitTrashRows(page, 3);
    const rows = (await trashState(page)).rows.map((r) => r.path);
    const i = rows.indexOf("a-seq/a3.md");
    expect(`a3 is still in the trash at row ${i}: ${i >= 0}`).toBe(`a3 is still in the trash at row ${i}: true`);

    await pressTrashAct(page, i, "restore");
    await page.waitForFunction(
      (k) => !!document.querySelectorAll("#trashList .trash-item")[k]?.querySelector(".trash-err"),
      { timeout: 15000 },
      i
    );
    const t = await trashState(page);
    expect(`the row says: ${t.rows[i].err}`).toBe(
      "the row says: a-seq/a3.md is taken — rename what is there, then restore."
    );
    expect(`the entry is still in the trash: ${t.rows.length === 3}`).toBe("the entry is still in the trash: true");
    expect(`and the squatter is untouched: ${JSON.stringify(readFileSync(join(srv.vault, "a-seq/a3.md"), "utf8"))}`).toBe(
      `and the squatter is untouched: ${JSON.stringify("# Squatter\n\nnot the original\n")}`
    );
    /* the refusal is on the row, not floating over the app */
    expect(`no toast carried it away: ${await page.evaluate(() => !document.getElementById("toast")!.classList.contains("show"))}`).toBe(
      "no toast carried it away: true"
    );
  }, 90000);

  test("Delete permanently asks first, and Escape leaves the entry alone", async () => {
    await openTrash(page);
    await waitTrashRows(page, 3);
    const before = (await trashState(page)).rows.map((r) => r.path);

    await pressTrashAct(page, 0, "purge");
    await page.waitForFunction(() => document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
    const c = await confirmText(page);
    expect(`the dialog: ${c.title} / ${c.ok}`).toBe("the dialog: Delete permanently / Delete for good");
    expect(`it names the doc: ${c.path}`).toBe(`it names the doc: ${before[0]}`);
    expect(`and says there is no way back: ${/no restore after this, and no undo/.test(c.body)}`).toBe(
      "and says there is no way back: true"
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
    expect(`the trash is unchanged: ${JSON.stringify((await trashState(page)).rows.map((r) => r.path))}`).toBe(
      `the trash is unchanged: ${JSON.stringify(before)}`
    );
  }, 60000);

  test("…and confirming removes it for good", async () => {
    await openTrash(page);
    await waitTrashRows(page, 3);
    const before = (await trashState(page)).rows.map((r) => r.path);

    await pressTrashAct(page, 0, "purge");
    await page.waitForFunction(() => document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
    await confirmOk(page);
    await waitTrashRows(page, 2);

    const t = await trashState(page);
    expect(`gone from the list: ${JSON.stringify(t.rows.map((r) => r.path))}`).toBe(
      `gone from the list: ${JSON.stringify(before.slice(1))}`
    );
    expect(`the badge follows: ${t.count}`).toBe("the badge follows: 2");
    expect(`and it did not come back to the vault: ${!vaultHasDoc(before[0])}`).toBe(
      "and it did not come back to the vault: true"
    );
  }, 90000);

  test("an empty trash says so, and drops its badge", async () => {
    await openTrash(page);
    await waitTrashRows(page, 2);
    for (const which of [0, 0]) {
      await pressTrashAct(page, which, "purge");
      await page.waitForFunction(() => document.getElementById("cfVeil")!.classList.contains("show"), { timeout: 8000 });
      await confirmOk(page);
      await new Promise((r) => setTimeout(r, 250));
    }
    await waitTrashRows(page, 0);
    const t = await trashState(page);
    expect(`the drawer reads: ${t.empty}`).toBe("the drawer reads: Nothing deleted yet.");
    expect(`the badge is gone: ${t.count}`).toBe("the badge is gone: null");
    expect(`but the row is still there: ${t.mounted}`).toBe("but the row is still there: true");
  }, 90000);
});

/* ==================================================================
   3 · PHONE + THEMES
   ================================================================== */

describe("the trash at phone width and in every theme", () => {
  test("in the 390px drawer it is above New doc / Folder and every target clears 44px", async () => {
    /* something to look at, deleted from the DESKTOP page: the store is one
       per file, so what matters here is the drawer, not who filled it */
    await fetch(srv.base + "/api/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a-seq/phone.md", type: "file", markdown: "# Phone\n" }),
    });
    await boot(page);
    await openDoc(page, "a-seq/phone.md");
    await deleteDoc(page, "a-seq/phone.md");

    const p = await browser.newPage();
    try {
      await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      p.on("pageerror", (e) => pageErrors.push(e.message));
      await installTrashRoutes(p);
      await boot(p);

      /* the sidebar is a drawer at this width — open it */
      await p.click('[data-act="nav-open"]');
      await p.waitForFunction(() => document.getElementById("app")!.classList.contains("nav-open"), { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 350)); // the drawer transition

      await p.waitForFunction(() => !document.getElementById("sbTrash")!.hidden, { timeout: 15000 });
      await openTrash(p);
      await waitTrashRows(p, 1);

      const m = await p.evaluate(() => {
        const r = (el: Element) => {
          const b = el.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
        };
        const link = document.getElementById("trashLink")!;
        const acts = [...document.querySelectorAll<HTMLElement>("#trashList .trash-act")];
        const list = document.getElementById("trashList")!;
        return {
          link: r(link),
          foot: r(document.querySelector(".sb-foot")!),
          side: r(document.getElementById("sidebar")!),
          acts: acts.map(r),
          labels: acts.map((a) => a.textContent),
          listScrolls: getComputedStyle(list).overflowY,
          listH: list.getBoundingClientRect().height,
          treeH: document.getElementById("tree")!.getBoundingClientRect().height,
          docHOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      expect(`still above New doc / Folder: ${m.link.bottom <= m.foot.top}`).toBe(
        "still above New doc / Folder: true"
      );
      expect(`the trash row is ${Math.round(m.link.h)}px tall, ≥44: ${m.link.h >= 44}`).toBe(
        `the trash row is ${Math.round(m.link.h)}px tall, ≥44: true`
      );
      expect(`the two verbs: ${JSON.stringify(m.labels)}`).toBe('the two verbs: ["Restore","Delete"]');
      expect(`both clear 44px: ${JSON.stringify(m.acts.map((a) => Math.round(a.h)))}`).toBe(
        "both clear 44px: [44,44]"
      );
      /* side by side, and not touching — one undoes a delete, the other completes it */
      const gap = m.acts[1].left - m.acts[0].right;
      expect(`with ${Math.round(gap)}px between them: ${gap >= 6}`).toBe(`with ${Math.round(gap)}px between them: true`);
      expect(`everything is inside the drawer: ${m.acts.every((a) => a.right <= m.side.right + 0.5)}`).toBe(
        "everything is inside the drawer: true"
      );
      expect(`the list scrolls inside itself: ${m.listScrolls}`).toBe("the list scrolls inside itself: auto");
      expect(`and the tree still has room (${Math.round(m.treeH)}px): ${m.treeH > 80}`).toBe(
        `and the tree still has room (${Math.round(m.treeH)}px): true`
      );
      expect(`no horizontal overflow: ${!m.docHOverflow}`).toBe("no horizontal overflow: true");

      /* the sidebar footer still fits under it — the drawer is not scrolled off */
      expect(`New doc is on screen: ${m.foot.bottom <= 844}`).toBe("New doc is on screen: true");
    } finally {
      await p.setRequestInterception(false).catch(() => {});
      await p.close();
    }
  }, 180000);

  test("it is legible and correctly ordered in minimal, modern and terminal", async () => {
    const report: string[] = [];
    for (const theme of ["minimal", "modern", "terminal"]) {
      const p = await browser.newPage();
      try {
        await p.setViewport({ width: 1440, height: 900 });
        p.on("pageerror", (e) => pageErrors.push(e.message));
        await installTrashRoutes(p);
        await boot(p, "?theme=" + theme);
        await p.waitForFunction(() => !document.getElementById("sbTrash")!.hidden, { timeout: 15000 });
        await openTrash(p);
        const m = await p.evaluate((th) => {
          const link = document.getElementById("trashLink")!;
          const foot = document.querySelector(".sb-foot")!;
          const cs = getComputedStyle(link);
          const item = document.querySelector("#trashList .trash-item, #trashList .trash-empty")!;
          return {
            theme: document.documentElement.getAttribute("data-theme"),
            asked: th,
            above: link.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top,
            inSidebar:
              link.getBoundingClientRect().right <= document.getElementById("sidebar")!.getBoundingClientRect().right + 0.5,
            ink: cs.color,
            size: cs.fontSize,
            quieter: cs.color !== getComputedStyle(document.getElementById("settingsLink")!).color,
            painted: !!item && item.getBoundingClientRect().height > 0,
          };
        }, theme);
        expect(`${theme}: the theme really loaded: ${m.theme}`).toBe(`${theme}: the theme really loaded: ${theme}`);
        expect(`${theme}: above the footer, inside the sidebar: ${m.above && m.inSidebar}`).toBe(
          `${theme}: above the footer, inside the sidebar: true`
        );
        expect(`${theme}: quieter than Settings: ${m.quieter}`).toBe(`${theme}: quieter than Settings: true`);
        expect(`${theme}: the drawer paints: ${m.painted}`).toBe(`${theme}: the drawer paints: true`);
        report.push(`${theme} → ${m.size} ${m.ink}`);
      } finally {
        await p.setRequestInterception(false).catch(() => {});
        await p.close();
      }
    }
    console.log("[trash] " + report.join(" · "));
  }, 180000);

  test("nothing threw in the page, in any of that", () => {
    expect(`uncaught page errors: ${JSON.stringify(pageErrors)}`).toBe("uncaught page errors: []");
  });
});
