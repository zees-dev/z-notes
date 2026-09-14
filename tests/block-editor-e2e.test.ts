/* ============================================================
   block-editor-e2e.test.ts — Edit is BlockNote, the file is still Markdown
   (spec 0020, ADR 0037).

   Every claim here needs the real island in a real browser: a visual edit
   rewrites only the source group it touched (frontmatter, ciphertext and
   unsupported HTML keep their bytes), the slash menu / formatting toolbar /
   drag handles are the native ones, a failed bundle still leaves Source
   usable — and the round-trip corpus survives Edit → Source → Edit unchanged.
   ============================================================ */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import { appDriver, ensureMode, launchTestBrowser, newAppPage, pressChord } from "./browser";
import { readVaultText, sleep, startServer, waitUntil, type TestServer } from "./helpers";
import { CORPUS } from "./markdown-corpus";

let srv: TestServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const external = new Set<string>();
let sequence = 0;
let path: string;

beforeAll(async () => {
  srv = await startServer({ seed: { "other.md": "# Other\n" } });
  expect((await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } })).status).toBe(200);
  browser = await launchTestBrowser();
}, 90000);
afterAll(async () => { await browser?.close(); await srv?.stop(); });
beforeEach(async () => {
  await page?.close();
  page = await newAppPage(browser, { onPageError: message => errors.push(message) });
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== srv.base) external.add(request.url());
  });
  path = `case-${++sequence}.md`;
});
/* `/d/{path}` resolves through the listing, which the watcher fills ~150 ms
   after the write; a warm boot is quicker and would resume the previous doc. */
async function writeDoc(markdown: string) {
  writeFileSync(join(srv.vault, path), markdown);
  await waitUntil(async () => JSON.stringify((await srv.api("GET", "/api/docs")).body).includes(path), { label: path + " listed" });
}
async function boot(markdown: string) {
  await writeDoc(markdown);
  await appDriver(page, srv.base).boot("/d/" + path);
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
}
/* ProseMirror ignores DOM selection changes for 50 ms after a view update, so
   a native caret move right after a click or a conversion is never seen. */
const settled = () => sleep(80);
async function endOfFirst(type = "paragraph") {
  await page.click(`.bn-editor [data-content-type="${type}"]`);
  await settled();
  await pressChord(page, "Home", "Control");
  await page.keyboard.press("End");
  await settled();
}
async function currentMarkdown() {
  return page.evaluate(async () => {
    const { state } = await import("/state.js");
    return state.docs.get(state.active).markdown;
  });
}
async function source() {
  await ensureMode(page, "raw", { via: "chip" });
  return page.$eval("#rawArea", element => (element as HTMLTextAreaElement).value);
}
async function save() {
  const response = page.waitForResponse(response => response.url().endsWith("/api/docs/" + path) && response.request().method() === "PUT");
  await pressChord(page, "KeyS");
  expect((await response).ok()).toBe(true);
  await page.waitForFunction(() => document.getElementById("saveTxt")?.textContent === "Saved");
}
const blocks = (type: string) => page.$$(`[data-content-type="${type}"]`);

/** Settle the entrance animation, hover a block, and take its drag handle. */
async function grabHandle(selector: string) {
  await page.$eval("#doc", async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.hover(selector);
  const handle = (await page.waitForSelector('[aria-label="Open block menu"]'))!;
  return { handle, start: (await handle.boundingBox())! };
}

async function dragBefore(selector: string, target: string) {
  const { start } = await grabHandle(selector);
  const end = (await (await page.$(target))!.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 25, end.y + 2, { steps: 20 });
  await page.waitForSelector(".prosemirror-dropcursor-block", { timeout: 5000 });
  await page.mouse.up();
}

test("heading conversion keeps the following paragraph separate after save and reload", async () => {
  await boot("# Title\nBody\n");
  await page.click('[data-content-type="heading"]');
  await pressChord(page, "Digit0", "Meta", "Alt");
  await page.waitForFunction(() => !document.querySelector('[data-content-type="heading"]'));
  expect(await page.$$eval('[data-content-type="paragraph"]', nodes => nodes.map(node => node.textContent))).toEqual(["Title", "Body"]);
  await save();
  expect(readVaultText(srv.vault, path)).toBe("Title\n\nBody\n");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('.bn-editor [data-content-type="paragraph"]');
  expect(await page.$$eval('[data-content-type="paragraph"]', nodes => nodes.map(node => node.textContent))).toEqual(["Title", "Body"]);
}, 35000);

test("unfinished protected HTML rejects following text and native moves without advancing the doc", async () => {
  const initialErrors = errors.length;
  await boot("Editable prose\n\n<!-- unfinished");
  await endOfFirst();
  await page.keyboard.type(" changed");
  await save();
  const saved = readVaultText(srv.vault, path);
  expect(saved).toBe("Editable prose changed\n\n<!-- unfinished");
  await page.click(".bn-trailing-block");
  const before = await page.$eval(".bn-editor", element => element.textContent);
  const paragraphs = await blocks("paragraph");
  expect(paragraphs).toHaveLength(2);
  await paragraphs.at(-1)!.click();
  await page.keyboard.type("must not follow");
  expect(await currentMarkdown()).toBe(saved);
  expect(await page.$eval(".bn-editor", element => element.textContent)).toBe(before);
  await dragBefore('[data-content-type="source"]', '[data-content-type="paragraph"]');
  expect(await currentMarkdown()).toBe(saved);
  expect(await page.$eval(".bn-editor", element => element.textContent)).toBe(before);
  expect(await page.$eval('.bn-editor [data-content-type]', element => element.textContent)).toBe("Editable prose changed");
  await endOfFirst();
  await page.keyboard.type(" again");
  await save();
  expect(readVaultText(srv.vault, path)).toBe("Editable prose changed again\n\n<!-- unfinished");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-content-type="source"]');
  expect(await currentMarkdown()).toBe("Editable prose changed again\n\n<!-- unfinished");
  expect(errors.slice(initialErrors)).toEqual([]);
}, 35000);

test("native moving unfinished code closes its fence and preserves following prose on reload", async () => {
  await boot("Prose stays separate\n\n```js\nconst answer = 42;");
  await dragBefore('[data-content-type="codeBlock"]', '[data-content-type="paragraph"]');
  await page.waitForFunction(() => document.querySelector('.bn-editor [data-content-type]')?.getAttribute("data-content-type") === "codeBlock");
  await save();
  expect(readVaultText(srv.vault, path)).toContain("```js\nconst answer = 42;\n```\n\nProse stays separate");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-content-type="codeBlock"]');
  expect(await page.$eval('[data-content-type="codeBlock"] code', element => element.textContent)).toBe("const answer = 42;");
  expect(await page.$eval('[data-content-type="paragraph"]', element => element.textContent)).toBe("Prose stays separate");
}, 35000);

test("visual editing is default; source switches preserve exact original bytes", async () => {
  const original = "---\ntitle: Original\n---\n\n# Heading\n\nProse  \nnext line\n\n<div>opaque</div>\n";
  await boot(original);
  expect(await page.$eval("#stModeTxt", e => e.textContent)).toBe("Edit");
  expect(await source()).toBe(original);
  expect(await page.$eval("#stModeTxt", e => e.textContent)).toBe("Source");
  await ensureMode(page, "preview", { via: "chip" });
  expect(await source()).toBe(original);
  expect(readVaultText(srv.vault, path)).toBe(original);
}, 40000);

test("native slash menu inserts a heading and floating toolbar formats selection", async () => {
  await boot("");
  await page.click(".bn-editor");
  await page.keyboard.type("/heading 2");
  await page.waitForSelector('[role="listbox"], .bn-suggestion-menu');
  await page.keyboard.press("Enter");
  await page.keyboard.type("Launch findings");
  expect(await page.$eval(".bn-editor h2", e => e.textContent)).toBe("Launch findings");
  await pressChord(page, "Home", "Shift");
  await page.waitForSelector('.bn-formatting-toolbar [aria-label="Bold"]');
  await page.click('.bn-formatting-toolbar [aria-label="Bold"]');
  expect(await page.$eval(".bn-editor strong", e => e.textContent)).toBe("Launch findings");
  await save();
  expect(readVaultText(srv.vault, path)).toContain("## **Launch findings**");
}, 40000);

/* A desktop has no list toolbar (ADR 0037): list types are the Markdown
   shortcuts and nesting is Tab / ⇧Tab. The mobile test below taps the buttons. */
test("list shortcuts and Tab/Shift-Tab preserve selection and produce nested Markdown", async () => {
  await boot("First item\n");
  await endOfFirst();
  expect(await page.$eval('.z-block-toolbar', e => e.getClientRects().length)).toBe(0);
  /* a conversion re-renders the block: wait for it to be serialised and settle */
  const converted = async (re: RegExp) => {
    await waitUntil(async () => re.test(await currentMarkdown()), { label: String(re) });
    await settled();
  };
  await page.keyboard.press("Home");
  await page.keyboard.type("- ");
  await converted(/^[-*] First item\n$/);
  await endOfFirst("bulletListItem");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second item");
  await page.keyboard.press("Tab");
  expect(await currentMarkdown()).toMatch(/[-*] First item\n +[-*] Second item/);
  await pressChord(page, "Tab", "Shift");
  expect(await currentMarkdown()).toMatch(/[-*] First item\n[-*] Second item/);
  await page.keyboard.press("Home");
  await page.keyboard.type("1. ");
  await converted(/\n1\. Second item\n$/);
  expect(await blocks("numberedListItem")).toHaveLength(1);
  await page.keyboard.press("Home");
  await page.keyboard.type("[] ");
  await converted(/\n[-*] \[ \] Second item\n$/);
  await page.click('.bn-editor input[type="checkbox"], .bn-editor [role="checkbox"]');
  await save();
  expect(readVaultText(srv.vault, path)).toContain("[x] Second item");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-content-type="checkListItem"]');
}, 45000);

test("prose edits preserve neighboring metadata, ciphertext and unsupported source", async () => {
  const before = "---\ntitle: Preserve\n---\n\n";
  const after = "\n\n```age\nopaque-ciphertext\n```\n\n<div data-custom='yes'>opaque html</div>\n";
  await boot(before + "Editable paragraph" + after);
  await page.click('[data-content-type="paragraph"]');
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter(" literal *stars* [brackets] # hash");
  await save();
  const saved = readVaultText(srv.vault, path);
  expect(saved.startsWith(before)).toBe(true);
  expect(saved.endsWith(after)).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-content-type="paragraph"]');
  expect(await page.$eval('[data-content-type="paragraph"]', e => e.textContent)).toBe("Editable paragraph literal *stars* [brackets] # hash");
  expect(await page.$('[data-content-type="paragraph"] em')).toBeNull();
}, 40000);

test("visual navigation protects dirty content and discard restores disk baseline", async () => {
  await boot("Original paragraph\n");
  await endOfFirst();
  await page.keyboard.type(" unsaved visual edit");
  await page.click('#tree [data-doc="other.md"]');
  await appDriver(page, srv.base).waitVeil("xgVeil", true);
  expect(await page.$eval("#xgDiff", e => e.textContent)).toContain("unsaved visual edit");
  expect(readVaultText(srv.vault, path)).toBe("Original paragraph\n");
  await page.click('[data-act="xg-discard"]');
  await appDriver(page, srv.base).settled("other.md");
  await appDriver(page, srv.base).clickDoc(path);
  await page.waitForSelector(".bn-editor");
  expect(await page.$eval(".bn-editor", e => e.textContent)).not.toContain("unsaved visual edit");
}, 40000);

test("clean visual editor refreshes on external disk changes and wiki links navigate", async () => {
  await boot("Original paragraph\n");
  writeFileSync(join(srv.vault, path), "Updated by external writer. See [[other]].\n");
  await page.waitForFunction(() => document.querySelector(".bn-editor")?.textContent?.includes("Updated by external writer"));
  await page.click('.wiki-link[data-target="other"]');
  await appDriver(page, srv.base).settled("other.md");
}, 35000);

test("native paragraph and heading handles reorder and delete across compact themes", async () => {
  for (const theme of ["modern", "minimal", "terminal"]) {
    expect((await srv.api("PUT", "/api/settings", { theme, density: "compact" })).status).toBe(200);
    for (const heading of ["", "# ", "## ", "### "]) {
      path = `drag-${++sequence}.md`;
      await boot(heading + "Alpha\n\nBeta\n\nGamma\n");
      const { handle, start } = await grabHandle('.bn-editor [data-content-type]');
      expect(await handle.evaluate(e => e.getAttribute("draggable"))).toBe("true");
      const contents = await page.$$('.bn-editor [data-content-type]');
      const origin = (await contents[0].boundingBox())!;
      const end = (await contents[2].boundingBox())!;
      expect(start.y + start.height / 2).toBeGreaterThanOrEqual(origin.y);
      expect(start.y + start.height / 2 + 6).toBeLessThan(origin.y + origin.height);
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(end.x + 25, end.y + end.height * 0.7, { steps: 20 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.bn-editor [data-content-type]')?.textContent === "Beta", { timeout: 5000 });
      await page.hover('[data-content-type="paragraph"]');
      await page.locator('[aria-label="Open block menu"]').click();
      await page.waitForSelector('[role="menuitem"]');
      for (const entry of await page.$$('[role="menuitem"]')) {
        if ((await entry.evaluate(e => e.textContent))?.includes("Delete")) { await entry.click(); break; }
      }
      await save();
      const saved = readVaultText(srv.vault, path);
      expect(saved).not.toContain("Beta");
      expect(saved).toContain(heading + "Alpha");
      expect(saved).toContain("Gamma");
    }
  }
}, 90000);

test("mobile touch lists, table and Mermaid fit a reduced viewport", async () => {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await boot("Mobile item\n\n| A | B |\n| - | - |\n| C | D |\n\n```mermaid\nflowchart LR\n A --> B\n```\n");
  await page.waitForSelector('[data-content-type="diagram"] svg');
  expect(await page.$(".bn-editor table")).not.toBeNull();
  await page.tap('[data-content-type="paragraph"]');
  await page.tap('[aria-label="Bullet list"]');
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Child item");
  await page.tap('[aria-label="Indent"]');
  expect(await currentMarkdown()).toMatch(/[-*] Mobile item\n +[-*] Child item/);
  await page.tap('[aria-label="Outdent"]');
  expect(await currentMarkdown()).toMatch(/[-*] Mobile item\n[-*] Child item/);
  await page.setViewport({ width: 390, height: 500, isMobile: true, hasTouch: true });
  const geometry = await page.evaluate(() => ({
    width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
    font: parseFloat(getComputedStyle(document.querySelector(".bn-editor .bn-block-content")!).fontSize),
    doc: parseFloat(getComputedStyle(document.querySelector("#doc")!).fontSize),
    controls: ["Bullet list", "Numbered list", "Checklist", "Indent", "Outdent"].map(label => {
      const r = document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
    }),
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  /* ONE SIZE IN BOTH MODES. Edit inherits `.doc`'s body copy — the size Source
     draws its own lines at, carrying `--doc-zoom` (ADR 0033) — instead of a
     phone floor of its own: Source has none either (ADR 0032) and the viewport
     meta pins the scale, so a floor here would make the two modes disagree. */
  expect(geometry.font).toBe(geometry.doc);
  for (const r of geometry.controls) {
    expect(r.width).toBeGreaterThan(0); expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(390);
    expect(r.bottom).toBeLessThanOrEqual(500);
  }
  await save();
  expect(readVaultText(srv.vault, path)).toContain("Child item");
}, 50000);


test("failed visual save preserves work and retry writes it", async () => {
  await boot("Original\n");
  await endOfFirst();
  await page.keyboard.type(" retained edit");
  await page.setRequestInterception(true);
  let reject = true;
  page.on("request", request => {
    if (reject && request.url().endsWith("/api/docs/" + path) && request.method() === "PUT") {
      void request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "io", message: "Simulated disk failure" }) });
    } else void request.continue();
  });
  const failure = page.waitForResponse(r => r.request().method() === "PUT" && r.status() === 503);
  await pressChord(page, "KeyS");
  await failure;
  expect(readVaultText(srv.vault, path)).toBe("Original\n");
  expect(await page.$eval(".bn-editor", e => e.textContent)).toContain("retained edit");
  reject = false;
  await save();
  expect(readVaultText(srv.vault, path)).toContain("retained edit");
}, 35000);

test("editing during an in-flight save keeps the newer visual input dirty", async () => {
  await boot("Original\n");
  await endOfFirst();
  await page.keyboard.type(" first");
  await page.setRequestInterception(true);
  let release: (() => void) | undefined;
  page.on("request", request => {
    if (request.url().endsWith("/api/docs/" + path) && request.method() === "PUT" && !release) {
      release = () => { void request.continue(); };
    } else void request.continue();
  });
  await pressChord(page, "KeyS");
  await waitUntil(() => release, { label: "held visual save" });
  await page.keyboard.type(" newer");
  const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/api/docs/" + path));
  release!();
  expect((await response).ok()).toBe(true);
  await page.waitForFunction(() => document.getElementById("saveTxt")?.textContent === "Unsaved changes");
  expect(readVaultText(srv.vault, path)).not.toContain("newer");
  expect(await page.$eval(".bn-editor", e => e.textContent)).toContain("newer");
  await save();
  expect(readVaultText(srv.vault, path)).toContain("first newer");
}, 35000);

test("a failed editor bundle gives a visible error and usable Source editing", async () => {
  await page.setRequestInterception(true);
  /* The shell names the HASHED entry and preloads it (ADR 0038); the
     `/vendor/editor.js` alias is only the fallback. Block both spellings, or
     this stops simulating a failed island load and starts passing for free. */
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/^\/vendor\/editor(?:\.js|\/editor\.[^/]+\.js)$/.test(path)) void request.abort("failed");
    else void request.continue();
  });
  await writeDoc("Recoverable source\n");
  await appDriver(page, srv.base).boot("/d/" + path);
  await page.waitForSelector("#rawArea");
  expect(await page.$eval("#doc", e => e.textContent)).toMatch(/editor.*(unavailable|load|failed)|source.*available/i);
  await page.click("#rawArea");
  await pressChord(page, "End", "Control");
  await page.keyboard.type("Recovered edit\n");
  await save();
  expect(readVaultText(srv.vault, path)).toContain("Recovered edit");
}, 35000);

test("the existing preservation corpus survives Edit/Source switches byte for byte", async () => {
  for (const fixture of CORPUS) {
    console.log("    preservation: " + fixture.name);
    await page.close();
    page = await newAppPage(browser, { onPageError: message => errors.push(message) });
    path = `corpus-${++sequence}.md`;
    const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(fixture.bytes);
    await boot(original);
    await ensureMode(page, "raw", { via: "chip" });
    // Textarea DOM values normalize CRLF; compare the source buffer owner instead.
    expect(await currentMarkdown()).toBe(original);
    await ensureMode(page, "preview", { via: "chip" });
    expect(await currentMarkdown()).toBe(original);
    expect(readVaultText(srv.vault, path)).toBe(original);
  }
}, 120000);

test("editor requests remain local and normal interactions have no uncaught errors", () => {
  expect([...external]).toEqual([]);
  expect(errors).toEqual([]);
});

test("a copied protected source transaction leaves prose editable and saves both copies", async () => {
  await boot("<div>protected source</div>\n\nEditable prose\n");
  // Exercise the native transaction boundary used by clipboard/block duplication.
  await page.$eval(".tiptap", element => {
    const view = (element as unknown as { editor: { view: import("@tiptap/pm/view").EditorView } }).editor.view;
    let source: { node: import("@tiptap/pm/model").Node; pos: number } | undefined;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "blockContainer" && node.firstChild?.type.name === "source") source = { node, pos };
    });
    if (!source) throw new Error("Missing protected source block");
    const { node, pos } = source;
    const duplicate = node.type.create({ ...node.attrs, id: crypto.randomUUID() }, node.content);
    view.dispatch(view.state.tr.insert(pos + node.nodeSize, duplicate));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-content-type="source"]').length === 2);
  await page.click('[data-content-type="paragraph"]');
  await page.keyboard.press("End");
  await page.keyboard.type(" remains editable");
  expect(await page.$eval('[data-content-type="paragraph"]', e => e.textContent)).toBe("Editable prose remains editable");
  await save();
  const saved = readVaultText(srv.vault, path);
  expect(saved.match(/<div>protected source<\/div>/g)).toHaveLength(2);
  expect(saved).toContain("Editable prose remains editable");
}, 35000);

test("dark native slash and formatting menus inherit each theme's text and panel colors", async () => {
  for (const theme of ["modern", "minimal", "terminal"]) {
    expect((await srv.api("PUT", "/api/settings", { theme, colorScheme: "dark" })).status).toBe(200);
    await boot("Format these words\n");
    await page.waitForFunction(t => document.documentElement.dataset.theme === t && document.documentElement.dataset.scheme === "dark", {}, theme);
    const textRect = await page.$eval(".bn-editor [data-content-type=paragraph]", element => {
      const range = document.createRange();
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) throw new Error("Missing selectable paragraph text");
      range.selectNodeContents(text);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(textRect.left + 1, textRect.y);
    await page.mouse.down();
    await page.mouse.move(textRect.right - 1, textRect.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForSelector('.bn-formatting-toolbar [aria-label="Bold"]');
    const colors = async (selector: string) => page.$eval(selector, element => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.color = root.getPropertyValue("--text");
      probe.style.backgroundColor = root.getPropertyValue("--panel");
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(element);
      const result = { text: actual.color, panel: actual.backgroundColor, expectedText: expected.color, expectedPanel: expected.backgroundColor };
      probe.remove();
      return result;
    });
    const toolbar = await colors(".bn-formatting-toolbar");
    const bold = await colors(".bn-formatting-toolbar [aria-label=Bold]");
    expect(bold.text).toBe(bold.expectedText);
    expect(toolbar.panel).toBe(toolbar.expectedPanel);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/heading");
    await page.waitForSelector(".bn-suggestion-menu");
    const slash = await colors(".bn-suggestion-menu");
    expect(slash.text).toBe(slash.expectedText);
    expect(slash.panel).toBe(slash.expectedPanel);
    await page.keyboard.press("Escape");
    await page.close();
    page = await newAppPage(browser, { onPageError: message => errors.push(message) });
    path = `theme-${++sequence}.md`;
  }
}, 45000);

/* The reading affordances the cutover owed the doc: nesting is shown by indent
   alone, an external link looks like one, and its URL is one click away. */
const LINKED = "- Parent\n  - Child\n\n- [ ] Task\n  - [x] Sub task\n\nPlain paragraph with no link.\n\nSee <https://example.com/x>, [mail](mailto:a@b.com) and [[other]].\n";

test("nested items draw no guide line and every external link is underlined with one copy button", async () => {
  await boot(LINKED);
  for (const colorScheme of ["light", "dark"]) {
    expect((await srv.api("PUT", "/api/settings", { colorScheme })).status).toBe(200);
    await page.waitForFunction(scheme => document.documentElement.dataset.scheme === scheme, {}, colorScheme);
    const measured = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--wl-fg");
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>("#doc .bn-inline-content a[href]")];
      const line = (text: string) => [...document.querySelectorAll<HTMLElement>('[data-content-type="paragraph"] .bn-inline-content')]
        .find(node => node.textContent!.includes(text))!.getBoundingClientRect().height;
      return {
        // The 24px indent is the only thing that may mark a nested item.
        guides: [...document.querySelectorAll(".bn-block-group .bn-block-group > .bn-block-outer")]
          .map(node => getComputedStyle(node, "::before").display),
        indents: [...document.querySelectorAll(".bn-block-group .bn-block-group")].map(node => getComputedStyle(node).marginLeft),
        links: anchors.map(anchor => ({
          href: anchor.href,
          underline: getComputedStyle(anchor).textDecorationLine,
          color: getComputedStyle(anchor).color,
          followedBy: anchor.nextElementSibling?.className.split(" ")[0] ?? "",
        })),
        expected,
        buttons: document.querySelectorAll(".z-link-copy").length,
        wikiButtons: document.querySelectorAll(".wiki-link + .z-link-copy").length,
        plain: line("Plain paragraph"), linked: line("See https://"),
      };
    });
    expect(measured.guides).toEqual(["none", "none"]);
    expect(measured.indents).toEqual(["24px", "24px"]);
    expect(measured.links).toEqual([
      { href: "https://example.com/x", underline: "underline", color: measured.expected, followedBy: "z-link-copy" },
      { href: "mailto:a@b.com", underline: "underline", color: measured.expected, followedBy: "z-link-copy" },
    ]);
    // One button per external link, and a [[wiki]] link is not one.
    expect(measured.buttons).toBe(2);
    expect(measured.wikiButtons).toBe(0);
    // An inline widget that changed the line box would move every following line.
    expect(measured.linked).toBe(measured.plain);
  }
}, 40000);

test("the copy button puts the exact href on the clipboard and writes nothing to the file", async () => {
  await browser.defaultBrowserContext().overridePermissions(srv.base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  await boot(LINKED);
  const buttons = await page.$$(".z-link-copy");
  expect(buttons).toHaveLength(2);
  await buttons[1]!.click();
  await page.waitForFunction(() => document.getElementById("toast")!.classList.contains("show")
    && document.getElementById("toastTxt")!.textContent === "Copied to clipboard");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("a@b.com");
  // A decoration is outside the document: neither the model nor the file moved.
  expect(await currentMarkdown()).toBe(LINKED);
  expect(readVaultText(srv.vault, path)).toBe(LINKED);
  await ensureMode(page, "raw", { via: "chip" });
  expect(await page.$("#doc .z-link-copy")).toBeNull();
  await ensureMode(page, "preview", { via: "chip" });
  await page.waitForSelector(".z-link-copy");
  expect(await currentMarkdown()).toBe(LINKED);
  expect(readVaultText(srv.vault, path)).toBe(LINKED);
}, 40000);
