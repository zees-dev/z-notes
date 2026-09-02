/* ============================================================
   upload-e2e.test.ts — a file dropped on the tree becomes a doc (ADR 0030).

   A real browser, the real backend, the real vault on disk. There is no upload
   route to test: the gesture is `POST /api/docs` with the file's text, so what
   is measured here is the CLIENT's half —

     - the destination rule is the move gesture's (a folder row means itself, a
       vault row means that vault's root) and so are its hover mechanics: the
       `drop-target` paint, and the 600 ms dwell that opens a closed folder
       under the pointer;
     - the bytes survive the round trip EXACTLY — CRLF and a missing trailing
       newline included, which is the whole claim of "the file you dropped";
     - every refusal is client-side and named: an extension outside
       `settings.upload.extensions`, and the server's own `409 exists`. One
       refused file never takes an acceptable one down with it.

   Most drags here are synthesised: a `DataTransfer` built in-page and dispatched
   as real `DragEvent`s, the same idiom `tests/ux-e2e.test.ts` uses for a paste.
   The app's handlers read nothing but the event, so that is enough — except for
   a FOLDER, which has no synthesised form: `webkitGetAsEntry()` answers only
   for items the browser itself put in the drag. That one drop goes through
   CDP's `Input.dispatchDragEvent`, carrying real paths on disk.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, vaultHas, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const FOLDER = "projects";
const DROPPED = "projects/note.md";
/** A BOM, CRLF, no trailing newline: the three things a helpful client "fixes"
    on the way past — and `TextDecoder` eats the BOM unless it is told not to */
const BYTES = "\uFEFF# hi\r\nno newline";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nstart here\n",
  [`${FOLDER}/anchor.md`]: "# Anchor\n\nso the folder exists before the drop\n",
  "dup.md": "# Already here\n\nthe name a second drop cannot have\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;
/** real paths on disk: the only kind of drag that can carry a real FOLDER */
let scratch: string;

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  scratch = mkdtempSync(join(tmpdir(), "znotes-drop-"));
  mkdirSync(join(scratch, "notes.md")); // a folder the extension gate would wave through
  writeFileSync(join(scratch, "beside.md"), "# beside\n");
  await boot();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function boot() {
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction(() => document.querySelectorAll("#tree .row.file").length > 0, { timeout: 20000 });
}

type FileSpec = { name: string; body: string; type?: string };

const ROW = (path: string) => `#tree .row.folder[data-path="${path}"]`;
const VAULT_ROW = '#tree .row.vault[data-vault="vault"]';
const DOC_ROW = (path: string) => `#tree .row.file[data-doc="${path}"]`;

const rowClasses = (sel: string) =>
  page.evaluate((s) => [...document.querySelector(s as string)!.classList], sel);

const toastText = () => page.evaluate(() => document.getElementById("toastTxt")!.textContent ?? "");

/**
 * Hand the row a drag carrying `files`, one event at a time.
 *
 * The DataTransfer is rebuilt per call and kept on `window` between them: the
 * app reads `dataTransfer.types` on hover and `dataTransfer.files` on drop, so
 * both have to be the SAME object across the sequence, exactly as a real drag's
 * is.
 */
async function dragEvent(sel: string, type: string, files?: FileSpec[]) {
  await page.evaluate(
    (s, t, specs) => {
      const w = window as any;
      if (specs) {
        const dt = new DataTransfer();
        for (const f of specs as FileSpec[]) dt.items.add(new File([f.body], f.name, { type: f.type || "text/plain" }));
        w.__dt = dt;
      }
      const row = document.querySelector(s as string);
      if (!row) throw new Error("no row for " + s);
      row.dispatchEvent(new DragEvent(t as string, { dataTransfer: w.__dt, bubbles: true, cancelable: true }));
    },
    sel,
    type,
    files ?? null
  );
}

/**
 * The same gesture, but carrying real paths — the browser builds the
 * `DataTransfer` itself, so `webkitGetAsEntry()` answers for real and a FOLDER
 * can be dropped. A synthesised `DataTransfer` cannot do either: its items have
 * no filesystem entry, so every one of them looks like a file.
 */
async function cdpDrop(sel: string, paths: string[]) {
  const client = await page.createCDPSession();
  const at = await page.evaluate((s) => {
    const r = document.querySelector(s as string)!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const)
    await client.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data });
  await client.detach();
}

/** enter + over, which is what a pointer arriving over a row produces */
async function dragOver(sel: string, files: FileSpec[]) {
  await dragEvent(sel, "dragenter", files);
  await dragEvent(sel, "dragover");
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("dropping a file on the tree uploads it", () => {
  test("a closed folder opens under the drag, and takes the file byte for byte", async () => {
    /* folders open by default — close this one, so the dwell has something to
       do and the assertion below is about the drag rather than the seed */
    await page.click(ROW(FOLDER));
    await page.waitForFunction((s) => !document.querySelector(s as string)!.classList.contains("open"), {}, ROW(FOLDER));

    const files: FileSpec[] = [{ name: "note.md", body: BYTES, type: "text/markdown" }];
    await dragOver(ROW(FOLDER), files);
    expect(`hovering paints the target: ${(await rowClasses(ROW(FOLDER))).includes("drop-target")}`).toBe(
      "hovering paints the target: true"
    );

    /* the move gesture's own 600 ms dwell, not a second timer */
    await page.waitForFunction((s) => document.querySelector(s as string)!.classList.contains("open"), { timeout: 4000 }, ROW(FOLDER));

    await dragEvent(ROW(FOLDER), "drop");
    await page.waitForSelector(DOC_ROW(DROPPED), { timeout: 10000 });

    const onDisk = readFileSync(join(srv.vault, FOLDER, "note.md"));
    expect(`bytes on disk: ${JSON.stringify(onDisk.toString("utf8"))}`).toBe(`bytes on disk: ${JSON.stringify(BYTES)}`);

    expect(`the toast said where it went: ${await toastText()}`).toBe(
      "the toast said where it went: Uploaded 1 file to projects"
    );
  }, 90000);

  test("a mixed drop on the vault row takes what it can and names what it refused", async () => {
    const files: FileSpec[] = [
      { name: "photo.png", body: "not really a png", type: "image/png" },
      { name: "dup.md", body: "# a second dup\n" },
      { name: "ok.md", body: "# ok\n" },
    ];
    await dragOver(VAULT_ROW, files);
    await dragEvent(VAULT_ROW, "drop");
    await page.waitForSelector(DOC_ROW("ok.md"), { timeout: 10000 });

    const toast = await toastText();
    expect(`one file landed: ${toast.includes("Uploaded 1 file")}`).toBe("one file landed: true");
    expect(`the extension refusal names the file: ${toast.includes("photo.png")}`).toBe(
      "the extension refusal names the file: true"
    );
    expect(`the duplicate refusal names the file: ${toast.includes("dup.md")}`).toBe(
      "the duplicate refusal names the file: true"
    );
    expect(`and says why: ${toast.includes("already exists")}`).toBe("and says why: true");

    /* nothing was overwritten and nothing was invented */
    expect(`dup.md is untouched: ${readFileSync(join(srv.vault, "dup.md"), "utf8")}`).toBe(
      `dup.md is untouched: ${SEED["dup.md"]}`
    );
    expect(`no photo.png was written: ${vaultHas(srv.vault, "photo.png")}`).toBe("no photo.png was written: false");
  }, 90000);

  test("a folder is refused wherever it sits in the drop, not just first", async () => {
    /* the folder goes SECOND deliberately: `webkitGetAsEntry()` answers only
       while the drop event is dispatching, so an upload loop that asks after
       its first `await` gets `null` here and refuses the folder as the wrong
       file type — and this one is named `notes.md`, so that mistake would read
       a directory as a document */
    await cdpDrop(VAULT_ROW, [join(scratch, "beside.md"), join(scratch, "notes.md")]);
    await page.waitForSelector(DOC_ROW("beside.md"), { timeout: 10000 });

    const toast = await toastText();
    expect(`the file beside it landed: ${toast.includes("Uploaded 1 file")}`).toBe("the file beside it landed: true");
    expect(`and the folder got the folder's reason: ${toast.includes("notes.md: folders cannot be uploaded")}`).toBe(
      "and the folder got the folder's reason: true"
    );
    expect(`nothing was written for it: ${vaultHas(srv.vault, "notes.md")}`).toBe("nothing was written for it: false");
  }, 90000);

  test("a file under the cap whose JSON body is over it is refused by size", async () => {
    /* 4.5 MiB of newlines is a 9 MiB request: `markdown` travels as a JSON
       string, where every newline costs two bytes. Gated on `file.size` alone
       this one reaches the server's body limit and comes back as
       "Failed to fetch", which names neither the size nor the file. */
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["\n".repeat(4.5 * 1024 * 1024)], "newlines.log", { type: "text/plain" }));
      (window as any).__dt = dt;
      const row = document.querySelector('#tree .row.vault[data-vault="vault"]')!;
      for (const t of ["dragenter", "dragover", "drop"])
        row.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(
      () => (document.getElementById("toastTxt")!.textContent ?? "").includes("newlines.log"),
      { timeout: 20000 }
    );
    expect(`refused by size: ${await toastText()}`).toBe(
      "refused by size: newlines.log: too large to send — the limit is 8 MiB"
    );
    await pause(200);
    expect(`nothing was written: ${vaultHas(srv.vault, "newlines.log")}`).toBe("nothing was written: false");
  }, 90000);

  test("narrowing the accepted types is what the next drop obeys", async () => {
    const put = await srv.api("PUT", "/api/settings", { upload: { extensions: "md" } });
    expect(`PUT ${put.status} → ${put.body?.settings?.upload?.extensions}`).toBe("PUT 200 → md");
    await boot(); // the page reads the setting it booted with

    await dragOver(VAULT_ROW, [{ name: "notes.txt", body: "plain text\n" }]);
    await dragEvent(VAULT_ROW, "drop");
    await page.waitForFunction(
      () => (document.getElementById("toastTxt")!.textContent ?? "").includes("notes.txt"),
      { timeout: 10000 }
    );

    expect(`the toast refused it: ${await toastText()}`).toBe("the toast refused it: notes.txt: only md can be uploaded");
    await pause(50);
    expect(`nothing was written: ${vaultHas(srv.vault, "notes.txt")}`).toBe("nothing was written: false");
  }, 90000);
});

describe("a drop that misses the tree does nothing at all", () => {
  test("the editor pane swallows it — no navigation, no write", async () => {
    const swallowed = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["# stray\n"], "stray.md", { type: "text/markdown" }));
      const doc = document.getElementById("doc")!;
      const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
      doc.dispatchEvent(over);
      const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      doc.dispatchEvent(drop);
      return { over: over.defaultPrevented, effect: dt.dropEffect, drop: drop.defaultPrevented };
    });
    expect(`dragover was taken: ${swallowed.over}, effect ${swallowed.effect}`).toBe(
      "dragover was taken: true, effect none"
    );
    expect(`the browser never got the drop: ${swallowed.drop}`).toBe("the browser never got the drop: true");
    await pause(200);
    expect(`nothing was written: ${vaultHas(srv.vault, "stray.md")}`).toBe("nothing was written: false");
  }, 60000);
});
