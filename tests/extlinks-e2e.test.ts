/* ============================================================
   extlinks-e2e.test.ts — external links render as links (ADR 0016).

   The adapter speaks three external spellings — `[text](url)`, `<url>` and the
   bare URL — and each becomes a real `<a href>` inside the island's
   `.bn-inline-content` (ADR 0037: Edit is BlockNote, so a link is an ordinary
   anchor in the editor's own inline content, not a decorated span of a
   hand-written renderer). What this file holds still is the part that would
   regress silently:

     · RENDER — each spelling is an anchor with the right href, and it is a
       SAFE one: `target=_blank` with `rel=noopener`.
     · REFUSE — the safety story is the scheme gate (`safeUrl`) and the
       code-span skip: a `javascript:` URL produces no anchor at all, a URL
       inside backticks stays inside the code span, and image syntax the
       adapter does not speak becomes a protected source block holding its own
       bytes rather than a half-rendered link.
     · BOUNDARY — a bare URL in prose does not drag its sentence along: the
       trailing punctuation stays text, and a Wikipedia "(bar)" keeps the
       close-paren the URL owns.
     · CLICK — a click on a link in Edit does not take the app anywhere: no
       request leaves for the link's origin and the open doc is still the open
       doc. (There is no click-to-edit door left to guard — ADR 0037 deleted
       it. Spec 0016's copy button after every link is a widget decoration in
       the island now, and block-editor-e2e owns it.)
     · SOURCE — none of it costs a byte on disk.

   EACH CASE IS ITS OWN PARAGRAPH. The adapter's unit of preservation is the
   top-level source group: one unsupported inline (the image) protects the
   whole group it sits in, so a single soft-broken paragraph would have made
   every other case in it opaque too.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const EXT = "links/ext.md";
const EXT_SRC = [
  "# Ext",
  "",
  "read [the docs](https://example.com/docs) first",
  "",
  "bare https://example.com/a?b=1&c=2. end",
  "",
  "angle <https://example.com/x> end",
  "",
  "write [me](mailto:z@example.com)",
  "",
  "evil [click](javascript:alert(1)) is not a link",
  "",
  "literal `https://example.com/lit` stays code",
  "",
  "wiki [[inbox]] stays a pill",
  "",
  "paren https://en.wikipedia.org/wiki/Foo_(bar) end",
  "",
  "image ![alt](https://example.com/i.png) is not an image",
  "",
].join("\n");

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [EXT]: EXT_SRC,
};

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];
const offOrigin: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== srv.base) offOrigin.push(r.url());
  });
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/** The island mounts asynchronously after `renderDoc` — wait for it. */
async function open(path: string) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, path);
  await page.waitForSelector("#doc .bn-editor", { timeout: 20000 });
  await sleep(160);
}

/** every anchor in the island, plus the facts asserted about the blocks */
function readLinks() {
  return page.evaluate(() => {
    const editor = document.querySelector("#doc .bn-editor") as HTMLElement;
    const blocks = [...editor.querySelectorAll(".bn-block-content")] as HTMLElement[];
    const textOf = (starts: string) =>
      blocks.find((b) => (b.textContent ?? "").startsWith(starts))?.textContent ?? "";
    return {
      anchors: [...editor.querySelectorAll(".bn-inline-content a")].map((a) => ({
        href: a.getAttribute("href"),
        text: a.textContent,
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel") || "",
      })),
      wiki: [...editor.querySelectorAll("button.wiki-link")].map((b) => b.getAttribute("data-target")),
      codeText: (editor.querySelector(".bn-inline-content code") as HTMLElement | null)?.textContent ?? "",
      codeHasAnchor: !!editor.querySelector(".bn-inline-content code a"),
      /* the block the image line landed in, and whether it is protected */
      imageType: blocks.find((b) => (b.textContent ?? "").includes("![alt]"))?.dataset.contentType ?? "(none)",
      /* the javascript: line is a protected block: its bytes are shown, never an anchor */
      evilType: blocks.find((b) => (b.textContent ?? "").includes("javascript:alert(1)"))?.dataset.contentType ?? "(none)",
      evilHasAnchor: !!blocks.find((b) => (b.textContent ?? "").includes("javascript:alert(1)"))?.querySelector("a"),
      bareText: textOf("bare "),
      angleText: textOf("angle "),
    };
  });
}

describe("external links render as real links in Edit", () => {
  test("[text](url), <url> and the bare URL each become a safe anchor", async () => {
    await open(EXT);
    const m = await readLinks();

    const by = (href: string) => m.anchors.find((a) => a.href === href);
    const docs = by("https://example.com/docs");
    expect(`[text](url) rendered: ${!!docs} as "${docs?.text}"`).toBe('[text](url) rendered: true as "the docs"');
    expect(`bare URL rendered: ${!!by("https://example.com/a?b=1&c=2")}`).toBe("bare URL rendered: true");
    expect(`<url> rendered: ${!!by("https://example.com/x")}`).toBe("<url> rendered: true");
    expect(`mailto rendered: ${!!by("mailto:z@example.com")}`).toBe("mailto rendered: true");

    for (const a of m.anchors) {
      expect(`${a.href} opens a new tab safely: ${a.target === "_blank" && a.rel.includes("noopener")}`).toBe(
        `${a.href} opens a new tab safely: true`
      );
    }
  }, 90000);

  test("the boundary is the URL's, not the sentence's", async () => {
    await open(EXT);
    const m = await readLinks();
    /* the trailing "." stayed prose */
    expect(`bare line reads: ${m.bareText}`).toBe("bare line reads: bare https://example.com/a?b=1&c=2. end");
    /* the angle brackets are consumed, not rendered */
    expect(`angle line reads: ${m.angleText}`).toBe("angle line reads: angle https://example.com/x end");
    /* a paren the URL owns is kept */
    const wiki = m.anchors.find((a) => (a.href || "").startsWith("https://en.wikipedia.org"));
    expect(`wikipedia href: ${wiki?.href}`).toBe("wikipedia href: https://en.wikipedia.org/wiki/Foo_(bar)");
  }, 60000);

  test("what must NOT link, does not", async () => {
    await open(EXT);
    const m = await readLinks();
    const hrefs = m.anchors.map((a) => a.href || "");
    expect(`a javascript: anchor exists: ${hrefs.some((h) => h.startsWith("javascript:"))}`).toBe(
      "a javascript: anchor exists: false"
    );
    /* the scheme gate refuses the link: the line stays a protected block with
       its bytes intact, and nothing in it is an anchor */
    expect(`the evil line: anchor ${m.evilHasAnchor}, block ${m.evilType}`).toBe("the evil line: anchor false, block source");
    expect(`code span kept the URL as text: ${m.codeText === "https://example.com/lit" && !m.codeHasAnchor}`).toBe(
      "code span kept the URL as text: true"
    );
    expect(`the wikilink is still a pill: ${m.wiki.join(",")}`).toBe("the wikilink is still a pill: inbox");
    /* image syntax is not half-rendered: the group is protected, bytes and all */
    expect(`the image line's block: ${m.imageType}`).toBe("the image line's block: source");
  }, 60000);

  test("clicking a link in Edit does not take the app anywhere", async () => {
    await open(EXT);
    const before = await page.evaluate(() => ({
      path: document.getElementById("stPath")!.textContent,
      url: location.pathname,
    }));
    offOrigin.length = 0;
    await page.click('.bn-inline-content a[href="https://example.com/docs"]');
    await sleep(400);
    const after = await page.evaluate(() => ({
      path: document.getElementById("stPath")!.textContent,
      url: location.pathname,
    }));
    expect(`after the click — doc ${after.path}, url ${after.url}`).toBe(
      `after the click — doc ${before.path}, url ${before.url}`
    );
    /* the anchor targets a new tab, so this page must not have fetched it */
    expect(`requests that left this origin: ${JSON.stringify(offOrigin)}`).toBe("requests that left this origin: []");
  }, 60000);

  test("rendering cost no bytes, and nothing threw", async () => {
    const r = await srv.doc(EXT);
    expect(`${EXT}: ${JSON.stringify(r.body.markdown)}`).toBe(`${EXT}: ${JSON.stringify(EXT_SRC)}`);
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  });
});
