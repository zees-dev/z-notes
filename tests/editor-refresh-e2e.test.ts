/* ============================================================
   editor-refresh-e2e.test.ts — a refresh can never overwrite typing, in Edit
   (spec 0020, ADR 0037).

   The orderings only exist against a real server: a held GET landing after a
   keystroke, a stream-gap heal, a tree rebuild, an external move or delete —
   each must leave the buffer (and a dirty revealed secret) exactly where the
   user left it, and a conflicting save must offer the conflict veil instead of
   silently winning.
   ============================================================ */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import { appDriver, launchTestBrowser, newAppPage, pressChord } from "./browser";
import { readVaultText, startServer, waitUntil, type TestServer } from "./helpers";

let srv: TestServer, browser: Browser, page: Page;
let path: string, sequence = 0;
beforeAll(async () => {
  srv = await startServer({ seed: { "other.md": "Other doc\n" } });
  await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } });
  browser = await launchTestBrowser();
}, 90000);
afterAll(async () => { await page?.close(); await browser?.close(); await srv?.stop(); });
beforeEach(async () => {
  await page?.close();
  page = await newAppPage(browser);
  path = `refresh-${++sequence}.md`;
  writeFileSync(join(srv.vault, path), "Original paragraph\n");
});
async function boot() {
  await appDriver(page, srv.base).boot("/d/" + path);
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
}
async function append(text: string) {
  await page.click('.bn-editor [data-content-type="paragraph"]');
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}
/** The statusbar naming `target` is how a re-home shows on screen. */
const atPath = (target: string, options = {}) => page.waitForFunction(p => document.getElementById("stPath")?.textContent === p, options, target);
const settleFrames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function snapshot() {
  return page.evaluate(async () => {
    const { state } = await import("/state.js");
    const doc = state.docs.get(state.active);
    return { markdown: doc.markdown, rev: doc.rev, diskText: doc.diskText, dirty: state.dirty };
  });
}
async function holdRefresh() {
  await page.setRequestInterception(true);
  let release: (() => Promise<void>) | undefined;
  page.on("request", async request => {
    if (!release && request.method() === "GET" && request.url().endsWith("/api/docs/" + path)) {
      // Capture a real server response before typing; deliver those exact bytes later.
      const response = await fetch(request.url());
      const body = await response.text();
      release = async () => {
        const received = page.waitForResponse(r => r.url() === request.url() && r.request().method() === "GET");
        await request.respond({ status: response.status, contentType: "application/json", body });
        await received;
        await settleFrames();
      };
    } else await request.continue();
  });
  return async () => {
    await waitUntil(() => release, { label: "held doc refresh response" });
    return release!;
  };
}
async function stopEvents() {
  await page.evaluate(async () => { (await import("/state.js")).state.events.source.close(); });
}
async function recoverGap() {
  await page.evaluate(async () => { (await import("/shell.js")).healAfterGap(); });
}

for (const cause of ["external event", "stream gap"]) {
  test(`typing during ${cause} refresh keeps the buffer and CAS conflict recovery`, async () => {
    await boot();
    const before = await snapshot();
    if (cause === "stream gap") await stopEvents();
    const held = await holdRefresh();
    writeFileSync(join(srv.vault, path), "External replacement\n");
    if (cause === "stream gap") await recoverGap();
    const release = await held();
    await append(" retained typing");
    const typed = await snapshot();
    expect(typed.markdown).toContain("retained typing");
    await release();
    expect(await snapshot()).toEqual(typed);
    expect(typed.rev).toBe(before.rev);
    expect(typed.diskText).toBe(before.diskText);
    expect(await page.$eval(".bn-editor", e => e.textContent)).toContain("retained typing");
    await pressChord(page, "KeyS");
    await appDriver(page, srv.base).waitVeil("cxVeil", true);
    expect(await page.$eval("#cxVeil", e => e.textContent)).toContain("retained typing");
    await page.click('[data-act="cx-keep-mine"]');
    await waitUntil(() => readVaultText(srv.vault, path).includes("retained typing"), { label: "conflict keep mine saved" });
  }, 40000);
}

test("gap refresh finishing after navigation preserves the new editor and selection", async () => {
  await boot();
  await stopEvents();
  const held = await holdRefresh();
  writeFileSync(join(srv.vault, path), "External replacement\n");
  await recoverGap();
  const release = await held();
  await appDriver(page, srv.base).clickDoc("other.md");
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
  await append(" editing here");
  const before = await page.$(".bn-editor");
  await release();
  expect(await before!.evaluate(e => e.isConnected)).toBe(true);
  await page.keyboard.type(" still focused");
  expect(await page.$eval(".bn-editor", e => e.textContent)).toContain("editing here still focused");
}, 35000);

test("CSS-only editor load failure exposes usable Source and saves", async () => {
  await page.setRequestInterception(true);
  let cssRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/vendor/editor.css") { cssRequests++; void request.abort("failed"); }
    else void request.continue();
  });
  await appDriver(page, srv.base).boot("/d/" + path);
  await page.waitForSelector("#rawArea", { timeout: 5000 });
  expect(await page.$eval("#doc", e => e.textContent)).toContain("keep editing in Source");
  await page.click("#rawArea");
  await pressChord(page, "End", "Control");
  await page.keyboard.type("Recovered CSS failure\n");
  await pressChord(page, "KeyS");
  await waitUntil(() => readVaultText(srv.vault, path).includes("Recovered CSS failure"), { label: "Source fallback saved" });
  expect(cssRequests).toBe(1);
}, 35000);

test("an older refresh cannot replace a newer external revision", async () => {
  await boot();
  const held = await holdRefresh();
  writeFileSync(join(srv.vault, path), "First external revision\n");
  const release = await held();
  writeFileSync(join(srv.vault, path), "Newest external revision\n");
  await page.waitForFunction(() => document.querySelector(".bn-editor")?.textContent?.includes("Newest external revision"));
  await release();
  expect((await snapshot()).markdown).toBe("Newest external revision\n");
  expect(await page.$eval(".bn-editor", e => e.textContent)).toContain("Newest external revision");
}, 35000);

for (const mode of ["preview", "raw"]) {
  test(`a real tree refresh retains the ${mode} buffer owner for subsequent typing and save`, async () => {
    await boot();
    if (mode === "raw") await page.click("#stMode");
    const added = `added-${sequence}.md`;
    await srv.api("POST", "/api/docs", { type: "doc", path: added, markdown: "New sibling\n" });
    await page.waitForSelector(`#tree [data-doc="${added}"]`);
    if (mode === "raw") {
      await page.click("#rawArea");
      await pressChord(page, "End", "Control");
      await page.keyboard.type("Saved after tree refresh\n");
    } else await append(" Saved after tree refresh");
    expect((await snapshot()).markdown).toContain("Saved after tree refresh");
    await pressChord(page, "KeyS");
    await waitUntil(() => readVaultText(srv.vault, path).includes("Saved after tree refresh"), { label: "buffer saved after tree refresh" });
  }, 35000);
}

for (const next of ["typing", "navigation", "initially clean typing"]) {
  test(`an external move completes retargeting before tree I/O and preserves ${next}`, async () => {
    await boot();
    if (next !== "initially clean typing") await append(" unsaved before move");
    await page.setRequestInterception(true);
    const pending: import("puppeteer-core").HTTPRequest[] = [];
    let holding = true;
    page.on("request", request => {
      if (holding && request.method() === "GET" && new URL(request.url()).pathname === "/api/docs") pending.push(request);
      else void request.continue();
    });
    const moved = `moved-${sequence}.md`;
    expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
    await waitUntil(() => pending.length > 0, { label: "held moved tree refresh" });
    await atPath(moved, { timeout: 3000 });
    await page.waitForSelector('.bn-editor[contenteditable="true"]');
    if (next !== "navigation") {
      await append(" typed during tree refresh");
      expect((await snapshot()).markdown).toContain("typed during tree refresh");
    } else {
      await page.click('#tree [data-doc="other.md"]');
      await appDriver(page, srv.base).waitVeil("xgVeil", true);
      await page.click('[data-act="xg-discard"]');
      await appDriver(page, srv.base).settled("other.md");
    }
    holding = false;
    await Promise.all(pending.map(request => request.continue()));
    await page.waitForSelector(`#tree [data-doc="${moved}"]`);
    if (next !== "navigation") {
      await pressChord(page, "KeyS");
      await waitUntil(() => readVaultText(srv.vault, moved).includes("typed during tree refresh"), { label: "retargeted typing saved" });
      if (next === "typing") expect(readVaultText(srv.vault, moved)).toContain("unsaved before move");
    } else {
      expect(new URL(page.url()).pathname).toBe("/d/other.md");
      expect(await page.$eval("#stPath", e => e.textContent)).toBe("other.md");
    }
  }, 35000);
}

test("a dirty revealed secret follows an external move and saves independently decryptable ciphertext", async () => {
  const age = await import("age-encryption");
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const passphrase = "external move regression passphrase";
  const wrap = new age.Encrypter();
  wrap.setPassphrase(passphrase);
  wrap.setScryptWorkFactor(18);
  const wrapped = age.armor.encode(await wrap.encrypt(identity));
  expect((await srv.api("PUT", "/api/vault/identity", { identity: wrapped, recipient })).status).toBe(201);
  const encrypt = new age.Encrypter();
  encrypt.addRecipient(recipient);
  const original = age.armor.encode(await encrypt.encrypt("SECRET BEFORE MOVE")).trimEnd();
  writeFileSync(join(srv.vault, path), "Secret prose\n\n```age\n" + original + "\n```\n");
  await boot();
  await page.locator(".secret .btn.primary").click();
  await appDriver(page, srv.base).waitVeil("ppVeil", true);
  await page.type("#ppInput", passphrase);
  await page.click("#ppOk");
  await page.waitForSelector(".secret.open textarea", { timeout: 30000 });
  await page.click(".secret.open textarea");
  await pressChord(page, "End", "Control");
  await page.keyboard.type(" EDITED SECRET MOVED");
  const moved = `secret-moved-${sequence}.md`;
  expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
  await atPath(moved);
  await page.waitForSelector(".secret.open textarea");
  expect(await page.$eval(".secret.open textarea", e => (e as HTMLTextAreaElement).value)).toBe("SECRET BEFORE MOVE EDITED SECRET MOVED");
  const sent: string[] = [];
  page.on("request", r => { if (r.method() === "PUT") sent.push(r.postData() || ""); });
  await pressChord(page, "KeyS");
  await waitUntil(() => !readVaultText(srv.vault, moved).includes(original), { label: "moved secret ciphertext saved" });
  const saved = readVaultText(srv.vault, moved);
  const armor = saved.match(/-----BEGIN AGE ENCRYPTED FILE-----[\s\S]*?-----END AGE ENCRYPTED FILE-----/)![0];
  const decrypt = new age.Decrypter();
  decrypt.addIdentity(identity);
  expect(await decrypt.decrypt(age.armor.decode(armor), "text")).toBe("SECRET BEFORE MOVE EDITED SECRET MOVED");
  expect(sent.length).toBeGreaterThan(0);
  for (const body of [saved, ...sent]) expect(body).not.toContain("EDITED SECRET MOVED");

  // Hold the real worker request, then let encryption finish at the moved path.
  await page.evaluate(async () => {
    const { vault } = await import("/secrets.js");
    const worker = vault.worker;
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (message: { op: string }) => {
      if (message.op === "encrypt") {
        worker.postMessage = send;
        (globalThis as unknown as { releaseMoveEncryption: () => void }).releaseMoveEncryption = () => send(message);
      } else send(message);
    };
  });
  await page.click(".secret.open textarea");
  await pressChord(page, "End", "Control");
  await page.keyboard.type(" PENDING ENCRYPTION MOVE");
  await pressChord(page, "KeyS");
  await page.waitForFunction(() => typeof (globalThis as unknown as { releaseMoveEncryption?: () => void }).releaseMoveEncryption === "function");
  const movedAgain = "pending-secret-" + sequence + ".md";
  expect((await srv.api("PATCH", "/api/docs/" + moved, { to: movedAgain })).status).toBe(200);
  await atPath(movedAgain);
  await page.waitForSelector(".secret.open textarea");
  await page.evaluate(() => (globalThis as unknown as { releaseMoveEncryption: () => void }).releaseMoveEncryption());
  await waitUntil(() => readVaultText(srv.vault, movedAgain) !== saved, { label: "pending encryption saved at moved path" });
  const final = readVaultText(srv.vault, movedAgain);
  const finalArmor = final.match(/-----BEGIN AGE ENCRYPTED FILE-----[\s\S]*?-----END AGE ENCRYPTED FILE-----/)![0];
  expect(await decrypt.decrypt(age.armor.decode(finalArmor), "text")).toBe("SECRET BEFORE MOVE EDITED SECRET MOVED PENDING ENCRYPTION MOVE");
  for (const body of [final, ...sent]) expect(body).not.toContain("PENDING ENCRYPTION MOVE");
}, 60000);

test("an external move retargets the already scheduled autosave without another keystroke", async () => {
  await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 1 } });
  try {
    await boot();
    await append(" saved after move without more typing");
    const moved = `autosave-moved-${sequence}.md`;
    expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
    await waitUntil(() => readVaultText(srv.vault, moved).includes("saved after move without more typing"), { label: "moved autosave" });
  } finally {
    await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } });
  }
}, 35000);

test("an in-flight save follows a move away and back without blocking later saves", async () => {
  await boot();
  await append(" first pending save");
  const moved = `roundtrip-${sequence}.md`;
  await page.setRequestInterception(true);
  const pending: import("puppeteer-core").HTTPRequest[] = [];
  page.on("request", request => {
    if (request.method() === "PUT" && /\/api\/docs\//.test(request.url()) && pending.length < 2) pending.push(request);
    else void request.continue();
  });
  await pressChord(page, "KeyS");
  await waitUntil(() => pending.length === 1, { label: "first held PUT" });
  expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
  await atPath(moved);
  await pending[0].continue();
  await waitUntil(() => pending.length === 2, { label: "redirected held PUT" });
  expect((await srv.api("PATCH", "/api/docs/" + moved, { to: path })).status).toBe(200);
  await atPath(path);
  await pending[1].continue();
  await waitUntil(() => readVaultText(srv.vault, path).includes("first pending save"), { timeout: 5000, label: "save after roundtrip move" });
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
  await append(" later save still works");
  await pressChord(page, "KeyS");
  await waitUntil(() => readVaultText(srv.vault, path).includes("later save still works"), { label: "later save after roundtrip move" });
}, 35000);

test("a held successful old-path save cannot overwrite the newer moved-path baseline", async () => {
  await boot();
  await append(" first saved buffer");
  await page.setRequestInterception(true);
  let release: (() => Promise<void>) | undefined;
  let writes = 0;
  page.on("request", async request => {
    if (request.method() === "PUT" && /\/api\/docs\//.test(request.url())) {
      writes++;
      if (writes === 1) {
        const response = await fetch(request.url(), { method: "PUT", headers: { "content-type": "application/json" }, body: request.postData() });
        const body = await response.text();
        release = () => request.respond({ status: response.status, contentType: "application/json", body });
        return;
      }
    }
    await request.continue();
  });
  await pressChord(page, "KeyS");
  await waitUntil(() => release, { label: "held successful old-path response" });
  const moved = `success-moved-${sequence}.md`;
  expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
  await atPath(moved);
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
  await append(" newer moved buffer");
  await pressChord(page, "KeyS");
  await settleFrames();
  expect(writes).toBe(1);
  await release!();
  await waitUntil(() => readVaultText(srv.vault, moved).includes("newer moved buffer"), { label: "serialized moved save" });
  await page.waitForFunction(() => document.getElementById("saveTxt")?.textContent === "Saved");
  const final = await snapshot();
  expect(final.diskText).toBe(final.markdown);
  expect(final.dirty).toBe(false);
  expect(final.diskText).toContain("first saved buffer newer moved buffer");
}, 35000);

test("a clean moved doc adopts the server's rewritten self-link and baseline", async () => {
  writeFileSync(join(srv.vault, path), "Self link [[" + path.slice(0, -3) + "]].\n");
  await boot();
  const moved = `self-moved-${sequence}.md`;
  expect((await srv.api("PATCH", "/api/docs/" + path, { to: moved })).status).toBe(200);
  await atPath(moved);
  await page.waitForSelector(`.wiki-link[data-target="${moved.slice(0, -3)}"]`);
  const final = await snapshot();
  expect(final.markdown).toBe(readVaultText(srv.vault, moved));
  expect(final.diskText).toBe(final.markdown);
  expect(final.dirty).toBe(false);
}, 35000);

for (const mode of ["preview", "raw"]) {
  test(`external deletion unmounts the clean ${mode} editor before further typing`, async () => {
    await boot();
    if (mode === "raw") await page.click("#stMode");
    const editor = await page.$(mode === "raw" ? "#rawArea" : ".bn-editor");
    expect(editor).not.toBeNull();
    expect((await srv.api("DELETE", "/api/docs/" + path)).status).toBe(204);
    await page.waitForFunction(() => !document.querySelector("#rawArea, #doc [contenteditable=true]"), { timeout: 3000 });
    expect(await editor!.evaluate(element => element.isConnected)).toBe(false);
    expect(await page.$eval("#doc", element => element.childElementCount)).toBe(0);
  }, 35000);
}
