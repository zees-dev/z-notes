/* ============================================================
   offline-e2e.test.ts — unsent edits survive a stopped server and a closed tab.

   Offline is a real connection refusal. Each case keeps its origin and vault
   across restarts; only the spec's completeness and outbox checks read IDB.
   ============================================================ */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { appDriver, callTool, launchTestBrowser, newAppPage, pressChord, waitForApp, waitForFocusedInput } from "./browser";
import { dropVault, MD_KEYS, readVaultBytes, readVaultText, REPO_ROOT, sleep, startServer, vaultHas, waitUntil, writeVaultFile, type TestServer } from "./helpers";

const ORIGINAL = "Original paragraph\n";
const OFFLINE = "You're offline — this needs the server.";
let srv: TestServer, browser: Browser, page: Page;
let scratch: string | undefined;

function recordToasts() {
  document.addEventListener("DOMContentLoaded", () => {
    const log: string[] = [];
    Object.assign(window, { offlineToasts: log });
    const text = document.getElementById("toastTxt")!;
    new MutationObserver(() => log.push(text.textContent || "")).observe(text, { childList: true, characterData: true, subtree: true });
  });
}

beforeEach(async () => {
  srv = await startServer({ keepVault: true, env: { ZNOTES_SW: "on" }, seed: {
    "note.md": ORIGINAL,
    "other.md": "A body line with QUOKKA in it.\n",
    "secret.md": MD_KEYS,
  } });
  await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { resume: true, beforeLoad: recordToasts });
}, 60000);

afterEach(async () => {
  await browser?.close();
  await srv?.stop();
  if (srv) dropVault(srv.vault);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function restart(env: Record<string, string> = {}) {
  await srv.stop();
  srv = await startServer({ port: srv.port, keepVault: true, vault: srv.vault, env: { ZNOTES_SW: "on", ...env } });
}

async function boot(path = "note.md") {
  await appDriver(page, srv.base).boot("/d/" + path);
  await page.waitForSelector('.bn-editor[contenteditable="true"]', { timeout: 10000 });
}

async function readReplica<T>(store: "meta" | "outbox", key?: string): Promise<T | null> {
  return page.evaluate(async (store, key) => {
    if (!(await indexedDB.databases()).some(db => db.name === "znotes")) return null;
    return new Promise<T | null>((resolve, reject) => {
      const open = indexedDB.open("znotes");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(store)) { db.close(); resolve(null); return; }
        const objects = db.transaction(store).objectStore(store);
        const read = key === undefined ? objects.getAll() : objects.get(key);
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
  }, store, key);
}

async function readyReplica() {
  await waitUntil(() => readReplica<boolean>("meta", "complete"), { timeout: 12000, label: "replica meta.complete" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
}

async function offline() {
  await boot();
  await readyReplica();
  await srv.stop();
}

async function append(text: string) {
  await page.click('.bn-editor [data-content-type="paragraph"]');
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

const pip = (text: string) => page.waitForFunction(t => document.getElementById("saveTxt")?.textContent === t, { timeout: 10000 }, text);
async function saveOnDevice(suffix: string) {
  await append(suffix);
  await pressChord(page, "KeyS");
  await pip("Saved on this device");
}
const editorText = () => page.$eval(".bn-editor", e => e.textContent || "");
async function diskEquals(path: string, text: string) {
  const expected = new TextEncoder().encode(text);
  await waitUntil(() => vaultHas(srv.vault, path) && readVaultText(srv.vault, path) === text, { timeout: 20000, label: path + " exact bytes on disk" });
  expect(readVaultBytes(srv.vault, path)).toEqual(expected);
}
async function expectOfflineAction(action: () => Promise<unknown>) {
  await page.evaluate(() => { (window as unknown as { offlineToasts: string[] }).offlineToasts.length = 0; });
  await action();
  await waitUntil(() => page.evaluate(message => (window as unknown as { offlineToasts: string[] }).offlineToasts.some(text => text.includes(message)), OFFLINE), { timeout: 5000, label: OFFLINE });
}

// Numbers 1–10 match spec 0024's offline acceptance cases; 11+ guard review findings.
test("1. a complete replica opens the tree, deep link, Edit and WebMCP offline", async () => {
  await offline();
  const shell = await page.reload({ waitUntil: "domcontentloaded" });
  // the worker's own response must carry what the server's shell does (WebMCP needs both)
  expect(shell!.fromServiceWorker()).toBe(true);
  expect(shell!.headers()["origin-agent-cluster"]).toBe("?1");
  expect(shell!.headers()["permissions-policy"]).toBe("tools=(self)");
  await waitForApp(page);
  expect(await page.$$eval("#tree [data-doc]", rows => rows.map(row => row.getAttribute("data-doc")))).toEqual(expect.arrayContaining(["note.md", "other.md", "secret.md"]));
  // This doc was never opened online: the background replica must hold it.
  await boot("other.md");
  expect(await editorText()).toContain("A body line with QUOKKA in it.");
  expect(await page.$eval("#stPath", e => e.textContent)).toBe("other.md");
  const tools = await callTool(page, "list_docs");
  expect(JSON.stringify(tools)).toContain("other.md");
}, 60000);

test("2. an offline edit survives a new page and replays byte for byte", async () => {
  await offline();
  await saveOnDevice(" café 🥝 kept offline");
  await page.close();
  page = await newAppPage(browser, { resume: true, beforeLoad: recordToasts });
  await boot();
  expect(await editorText()).toContain("café 🥝 kept offline");
  await restart();
  await diskEquals("note.md", "Original paragraph café 🥝 kept offline\n");
  await pip("Saved");
}, 60000);

test("3. a reconnect conflict keeps both the disk text and offline text", async () => {
  await offline();
  await saveOnDevice(" my offline version");
  writeVaultFile(srv.vault, "note.md", "Someone else's disk version\n");
  await restart();
  await appDriver(page, srv.base).waitVeil("cxVeil", true);
  const dialog = await page.$eval("#cxVeil", e => e.textContent || "");
  expect(dialog).toContain("Someone else's disk version");
  expect(dialog).toContain("my offline version");
  expect(await editorText()).toContain("my offline version");
  expect(readVaultText(srv.vault, "note.md")).toBe("Someone else's disk version\n");
}, 60000);

test("4. an offline-created new.md appears in the tree and reaches disk", async () => {
  await offline();
  await page.click('[data-act="new-doc"]');
  await waitForFocusedInput(page, ".newrow input");
  await page.keyboard.type("new.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('#tree [data-doc="new.md"]', { timeout: 8000 });
  await appDriver(page, srv.base).settled("new.md");
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
  await append("Created offline café");
  await pressChord(page, "KeyS");
  await pip("Saved on this device");
  expect(vaultHas(srv.vault, "new.md")).toBe(false);
  await restart();
  // a doc created empty has no final newline to keep; online it is the same
  await diskEquals("new.md", "Created offline café");
}, 60000);

test("5. a lost PUT response retries with 200 and no false conflict", async () => {
  await boot();
  const cdp = await page.createCDPSession();
  let failed = false;
  let writtenAtFailure = "";
  let interceptionError: unknown;
  cdp.on("Fetch.requestPaused", event => {
    void (async () => {
      if (event.request.method === "PUT" && !failed) {
        failed = true;
        writtenAtFailure = readVaultText(srv.vault, "note.md");
        expect(event.responseStatusCode).toBe(200);
        await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "ConnectionClosed" });
      } else await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
    })().catch(error => { interceptionError = error; });
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/docs/note.md", requestStage: "Response" }] });
  await append(" reply lost");
  await pressChord(page, "KeyS");
  await waitUntil(() => failed || interceptionError, { label: "PUT response intercepted after the write" });
  if (interceptionError) throw interceptionError;
  expect(writtenAtFailure).toBe("Original paragraph reply lost\n");
  await pip("Saved on this device");
  const retried = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/api/docs/note.md"));
  await pressChord(page, "KeyS");
  expect((await retried).status()).toBe(200);
  await pip("Saved");
  expect(await appDriver(page, srv.base).veilUp("cxVeil")).toBe(false);
  await diskEquals("note.md", writtenAtFailure);
  await cdp.detach();
}, 60000);

test("6. offline rename, delete and AI send explain the refusal and change no files", async () => {
  await boot();
  await page.waitForFunction(() => document.getElementById("sessId")?.textContent !== "—");
  await srv.stop();
  await expectOfflineAction(async () => {
    await page.click('[aria-label="Rename or move note.md"]');
    await waitForFocusedInput(page, ".newrow.renaming input");
    await pressChord(page, "KeyA");
    await page.keyboard.type("renamed.md");
    await page.keyboard.press("Enter");
  });
  await page.keyboard.press("Escape");
  expect(await page.$('#tree [data-doc="note.md"]')).not.toBeNull();
  expect(await page.$('#tree [data-doc="renamed.md"]')).toBeNull();
  await expectOfflineAction(async () => {
    await page.click('[aria-label="Delete note.md"]');
    await appDriver(page, srv.base).waitVeil("cfVeil", true);
    await page.click('[data-act="cf-ok"]');
  });
  expect(await page.$('#tree [data-doc="note.md"]')).not.toBeNull();
  await expectOfflineAction(async () => {
    if (!(await page.$eval("#app", e => e.classList.contains("chat-open")))) await page.click("#chatBtn");
    await page.type("#composer", "Summarize this note");
    await page.click('[data-act="send"]');
  });
  await restart();
  expect(readVaultText(srv.vault, "note.md")).toBe(ORIGINAL);
  expect(vaultHas(srv.vault, "renamed.md")).toBe(false);
  expect(readVaultText(srv.vault, "other.md")).toBe("A body line with QUOKKA in it.\n");
  expect(readVaultText(srv.vault, "secret.md")).toBe(MD_KEYS);
}, 60000);

test("7. offline search finds body lines and excludes secret armor", async () => {
  await offline();
  await pressChord(page, "KeyK");
  await appDriver(page, srv.base).waitVeil("palVeil", true);
  await page.type("#palInput", "QUOKKA");
  await page.waitForFunction(() => document.getElementById("palList")?.textContent?.includes("A body line with QUOKKA in it."), { timeout: 8000 });
  expect(await page.$eval("#palList", e => e.textContent)).toContain("other.md");
  await page.click("#palInput");
  await pressChord(page, "KeyA");
  // This exact token exists in secret.md's armor, nowhere in its prose or path.
  const token = "Zt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp";
  expect(MD_KEYS).toContain(token);
  await page.keyboard.type(token);
  await page.waitForFunction(() => document.getElementById("palList")?.textContent?.includes("No docs or lines match that."), { timeout: 8000 });
  expect(await page.$eval("#palList", e => e.textContent)).not.toContain("secret.md");
}, 60000);

test("8. a new build waits for Reload and saves the dirty buffer before navigating", async () => {
  await boot();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
  const firstBuild = await page.$eval('meta[name="znotes-build"]', e => e.getAttribute("content"));
  // A second real release without editing the shared checkout's frontend.
  const root = mkdtempSync(join(tmpdir(), "znotes-offline-release-"));
  scratch = root;
  for (const dir of ["app", "server", "scripts"]) cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const css = join(root, "app/themes/base.css");
  await Bun.write(css, await Bun.file(css).text() + "\n:root { --offline-e2e-release: 2; }\n");
  const dist = join(root, "dist");
  const build = Bun.spawn(["bun", "scripts/build.ts", dist], { cwd: root, stdout: "ignore", stderr: "pipe" });
  const error = await new Response(build.stderr).text();
  expect(`release build exited ${await build.exited}: ${error}`).toBe("release build exited 0: ");
  await restart({ ZNOTES_DIST: dist });
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await page.waitForFunction(() => document.getElementById("toastTxt")?.textContent?.includes("A new version is ready"), { timeout: 20000 });
  expect(await page.$eval('meta[name="znotes-build"]', e => e.getAttribute("content"))).toBe(firstBuild);
  await append(" saved before release reload");
  const held: HTTPRequest[] = [];
  let holding = true;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (holding && request.method() === "PUT" && request.url().endsWith("/api/docs/note.md")) held.push(request);
    else void request.continue();
  });
  let navigations = 0;
  let diskAtNavigation = "";
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) { navigations++; diskAtNavigation = readVaultText(srv.vault, "note.md"); }
  });
  await page.click("#toastTxt button");
  await waitUntil(() => held.length > 0, { label: "Reload's held save" });
  // A held request cannot reach disk. Reload must remain on this document.
  await sleep(1000);
  expect(navigations).toBe(0);
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  holding = false;
  await Promise.all(held.map(request => request.continue()));
  await navigation;
  await waitForApp(page);
  expect(diskAtNavigation).toBe("Original paragraph saved before release reload\n");
  expect(await page.$eval('meta[name="znotes-build"]', e => e.getAttribute("content"))).not.toBe(firstBuild);
  await diskEquals("note.md", diskAtNavigation);
}, 120000);

test("9. the kill switch unregisters after one navigation without losing the outbox", async () => {
  await offline();
  await saveOnDevice(" survives the kill worker");
  const queued = (await readReplica<Array<{ path: string; markdown: string }>>("outbox")) ?? [];
  expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ path: "note.md", markdown: "Original paragraph survives the kill worker\n" })]));
  // A concurrent disk edit blocks replay, so an acknowledgement cannot drain it.
  writeVaultFile(srv.vault, "note.md", "Changed elsewhere before kill\n");
  await restart({ ZNOTES_SW: "off" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitUntil(async () => {
    try { return await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 0); }
    catch { return false; } // the kill worker itself navigates its clients
  }, { timeout: 15000, label: "kill worker unregistered" });
  await waitForApp(page);
  const remaining = await readReplica<Array<{ path: string; markdown: string }>>("outbox");
  expect(remaining).toEqual(expect.arrayContaining([expect.objectContaining({ path: queued[0].path, markdown: queued[0].markdown })]));
  expect(readVaultText(srv.vault, "note.md")).toBe("Changed elsewhere before kill\n");
}, 60000);

test("10. a non-canonical origin stays online-only and shows its origin notice", async () => {
  const origin = "https://znotes.example.ts.net";
  await restart({ ZNOTES_ORIGIN: origin });
  await boot();
  await page.waitForFunction(() => document.getElementById("toastTxt")?.textContent?.includes("open it there to use it offline."));
  expect(await page.$eval("#toastTxt", e => e.textContent)).toBe("z-notes lives at " + origin + " — open it there to use it offline.");
  expect(await page.$eval("#toastTxt a", e => (e as HTMLAnchorElement).origin)).toBe(origin);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === "znotes"))).toBe(false);
}, 60000);

test("11. a queued edit replays in the background without its doc being reopened", async () => {
  await offline();
  await saveOnDevice(" replayed from the background");
  await page.click('#tree [data-doc="other.md"]');
  await appDriver(page, srv.base).settled("other.md");
  await restart();
  await diskEquals("note.md", "Original paragraph replayed from the background\n");
}, 60000);

test("12. a doc created offline and left empty exists on disk after reconnect", async () => {
  await offline();
  await page.click('[data-act="new-doc"]');
  await waitForFocusedInput(page, ".newrow input");
  await page.keyboard.type("empty.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('#tree [data-doc="empty.md"]', { timeout: 8000 });
  await appDriver(page, srv.base).settled("empty.md");
  expect(vaultHas(srv.vault, "empty.md")).toBe(false);
  await restart();
  await diskEquals("empty.md", "");
}, 60000);

test("13. text discarded after a refused save never reaches disk", async () => {
  await boot();
  await page.setRequestInterception(true);
  const refuse = (request: HTTPRequest) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/docs/note.md")) {
      void request.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "refused" }) });
    } else void request.continue();
  };
  page.on("request", refuse);
  await append(" refused then discarded");
  await pressChord(page, "KeyS");
  await page.waitForFunction(() => (window as unknown as { offlineToasts: string[] }).offlineToasts.includes("refused"), { timeout: 10000 });
  await page.click('#tree [data-doc="other.md"]');
  await appDriver(page, srv.base).waitVeil("xgVeil", true);
  await page.click('[data-act="xg-discard"]');
  await appDriver(page, srv.base).settled("other.md");
  // the refused save wrote ahead to the outbox; Discard must take that entry with it
  const outboxClear = async () => !((await readReplica<Array<{ path: string }>>("outbox")) ?? []).some(entry => entry.path === "note.md");
  await waitUntil(outboxClear, { timeout: 5000, label: "note.md gone from the outbox" });
  // the server must be free to take a replay, or the disk check below proves nothing
  page.off("request", refuse);
  await page.setRequestInterception(false);
  await restart();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await sleep(2000);
  expect(readVaultText(srv.vault, "note.md")).toBe(ORIGINAL);
}, 60000);
