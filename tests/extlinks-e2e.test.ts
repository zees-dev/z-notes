/* ============================================================
   extlinks-e2e.test.ts — external links render as links (ADR 0016).

   `inline()` speaks three external spellings now — `[text](url)`, `<url>` and
   the bare URL — and each becomes a real underlined `<a href>` in Preview.
   What this file holds still is the part that would regress silently:

     · RENDER — each spelling is an anchor with the right href, opening in a
       new tab, and the underline is MEASURED (computed style), not assumed
       from a class name.
     · REFUSE — the renderer's whole safety story is the scheme gate and the
       code-span skip: a `javascript:` URL stays the literal text the author
       typed, a URL inside backticks stays inside the code span, and image
       syntax is not half-rendered into "!" + a link.
     · BOUNDARY — a bare URL in prose does not drag its sentence along: the
       trailing punctuation stays text, and a Wikipedia "(bar)" keeps the
       close-paren the URL owns.
     · CLICK — an external link is excluded from click-to-edit: clicking it
       must NOT switch the pane to Raw (a link is a click zone that acts
       instead of editing).
     · SOURCE — none of it costs a byte on disk.
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
  "bare https://example.com/a?b=1&c=2. end",
  "angle <https://example.com/x> end",
  "write [me](mailto:z@example.com)",
  "evil [click](javascript:alert(1)) stays text",
  "literal `https://example.com/lit` stays code",
  "wiki [[inbox]] stays a pill",
  "paren https://en.wikipedia.org/wiki/Foo_(bar) end",
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

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

async function open(path: string) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 15000 }, path);
  await page.waitForSelector("#doc .md", { timeout: 15000 });
  await sleep(160);
}

/** every external anchor in the preview, plus the facts asserted about them */
function readLinks() {
  return page.evaluate(() => {
    const md = document.querySelector("#doc .md") as HTMLElement;
    const lineText = (n: number) =>
      (md.querySelector('.pline[data-line="' + n + '"]') as HTMLElement | null)?.textContent ?? "";
    return {
      xl: [...md.querySelectorAll("a.xl")].map((a) => ({
        href: a.getAttribute("href"),
        text: a.textContent,
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel") || "",
        underline: getComputedStyle(a).textDecorationLine,
      })),
      wl: [...md.querySelectorAll("a.wl")].map((a) => a.getAttribute("data-link")),
      codeText: (md.querySelector("code.ic") as HTMLElement | null)?.textContent ?? "",
      codeHasAnchor: !!md.querySelector("code.ic a"),
      evilLine: lineText(6),
      bareLine: lineText(3),
      angleLine: lineText(4),
      imageLine: lineText(10),
    };
  });
}

describe("external links render as real links", () => {
  test("[text](url), <url> and the bare URL each become an underlined anchor", async () => {
    await open(EXT);
    const m = await readLinks();

    const by = (href: string) => m.xl.find((a) => a.href === href);
    const docs = by("https://example.com/docs");
    expect(`[text](url) rendered: ${!!docs} as "${docs?.text}"`).toBe('[text](url) rendered: true as "the docs"');
    expect(`bare URL rendered: ${!!by("https://example.com/a?b=1&c=2")}`).toBe("bare URL rendered: true");
    expect(`<url> rendered: ${!!by("https://example.com/x")}`).toBe("<url> rendered: true");
    expect(`mailto rendered: ${!!by("mailto:z@example.com")}`).toBe("mailto rendered: true");

    for (const a of m.xl) {
      expect(`${a.href} underlined: ${a.underline.includes("underline")}`).toBe(`${a.href} underlined: true`);
      expect(`${a.href} opens a new tab safely: ${a.target === "_blank" && a.rel.includes("noopener")}`).toBe(
        `${a.href} opens a new tab safely: true`
      );
    }
  }, 90000);

  test("the boundary is the URL's, not the sentence's", async () => {
    await open(EXT);
    const m = await readLinks();
    /* the trailing "." stayed prose */
    expect(`bare line reads: ${m.bareLine}`).toBe("bare line reads: bare https://example.com/a?b=1&c=2. end");
    /* the angle brackets are consumed, not rendered */
    expect(`angle line reads: ${m.angleLine}`).toBe("angle line reads: angle https://example.com/x end");
    /* a paren the URL owns is kept */
    const wiki = m.xl.find((a) => (a.href || "").startsWith("https://en.wikipedia.org"));
    expect(`wikipedia href: ${wiki?.href}`).toBe("wikipedia href: https://en.wikipedia.org/wiki/Foo_(bar)");
  }, 60000);

  test("what must NOT link, does not", async () => {
    await open(EXT);
    const m = await readLinks();
    const hrefs = m.xl.map((a) => a.href || "");
    expect(`a javascript: anchor exists: ${hrefs.some((h) => h.startsWith("javascript:"))}`).toBe(
      "a javascript: anchor exists: false"
    );
    expect(`the evil spelling stayed literal: ${m.evilLine.includes("[click](javascript:alert(1))")}`).toBe(
      "the evil spelling stayed literal: true"
    );
    expect(`code span kept the URL as text: ${m.codeText === "https://example.com/lit" && !m.codeHasAnchor}`).toBe(
      "code span kept the URL as text: true"
    );
    expect(`the wikilink is still a pill: ${m.wl.join(",")}`).toBe("the wikilink is still a pill: inbox");
    expect(`image syntax was not half-rendered: ${m.imageLine.includes("![alt](")}`).toBe(
      "image syntax was not half-rendered: true"
    );
  }, 60000);

  test("clicking an external link does not open Raw", async () => {
    await open(EXT);
    /* navigation itself is cancelled (this suite has no business visiting
       example.com) — but only the DEFAULT is cancelled, so every delegated
       handler in the app still sees the click exactly as it would in life */
    await page.evaluate(() => {
      document.addEventListener("click", (e) => e.preventDefault(), { capture: true, once: true });
    });
    await page.click("a.xl");
    await sleep(300);
    const raw = await page.$("#rawArea");
    expect(`Raw opened on a link click: ${!!raw}`).toBe("Raw opened on a link click: false");
  }, 60000);

  test("rendering cost no bytes, and nothing threw", async () => {
    const r = await srv.doc(EXT);
    expect(`${EXT}: ${JSON.stringify(r.body.markdown)}`).toBe(`${EXT}: ${JSON.stringify(EXT_SRC)}`);
    expect(`page errors: ${pageErrors.join(" | ")}`).toBe("page errors: ");
  });
});
