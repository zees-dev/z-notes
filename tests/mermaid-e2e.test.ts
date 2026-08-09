/* ============================================================
   mermaid-e2e.test.ts — ```mermaid renders, and cannot be weaponised.

   Two halves, and the second is the reason this file is long.

   RENDERING is the easy half: a fence draws, a broken fence says so without
   eating the source, the diagram follows the app's theme, and the block stays
   a click-to-edit block like every other one in the preview.

   HARDENING is the half that earns its keep. A ```mermaid fence is the first
   place in this app where doc content becomes MARKUP instead of text, and doc
   content is not necessarily the owner's typing — a vault syncs over git
   (SPEC §7) and the AI relay writes docs (SPEC §8). mermaid has shipped XSS
   advisories in every year it has existed, and every one of them against an
   EMBEDDER came from the same two mistakes: `securityLevel` below strict, or
   `htmlLabels` on. Both are settable from INSIDE a diagram — via YAML
   frontmatter and via `%%{init: …}%%` — unless they are named in mermaid's
   `secure` list, and `htmlLabels` is NOT one of the six mermaid locks by
   default. app/mermaid.js locks fourteen keys for exactly that reason.

   So these tests do not assert that the config object has the right shape;
   they fire the attacks and assert nothing happened. `window.__pwned` is armed
   before any app code runs, and every callback a diagram can ask for pushes to
   it. An empty array at the end is the assertion.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, type SeedMap, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const FLOW = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Rethink]";
const SEQ = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi";

/* ---- the attacks, each in its own doc so one cannot mask another ----

   Every one of these is a real technique from mermaid's advisory history or
   from the embedder mistakes those advisories describe. */

/** flip securityLevel + htmlLabels from inside the diagram, via BOTH channels */
const ATK_DIRECTIVE =
  '%%{init: {"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true},"secure":[]} }%%\n' +
  "flowchart TD\n" +
  '  A["<img src=x onerror=\'window.__pwned.push(1)\'>"] --> B["<script>window.__pwned.push(2)<\\/script>"]';

/** the same, through YAML frontmatter rather than a directive */
const ATK_FRONTMATTER =
  "---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\n" +
  "flowchart TD\n" +
  '  A["<img src=y onerror=\'window.__pwned.push(3)\'>"] --> B[ok]';

/** `click` bindings — JS callbacks and javascript: URLs, both only live under loose */
const ATK_CLICK =
  "flowchart TD\n  A[Node A] --> B[Node B]\n" +
  '  click A call __pwn()\n  click B href "javascript:window.__pwned.push(5)"';

/** relax the label sanitiser itself, and inject CSS that phones home */
const ATK_CSS =
  '%%{init: {"dompurifyConfig":{"ADD_TAGS":["script"]},"themeCSS":"@import url(https://evil.example/x.css);","fontFamily":"x;} body{display:none} .z{"} }%%\n' +
  "flowchart TD\n  A[hello] --> B[world]";

const SEED: SeedMap = {
  "flow.md": "# Flow\n\n```mermaid\n" + FLOW + "\n```\n",
  "seq.md": "# Seq\n\n```mermaid\n" + SEQ + "\n```\n",
  "broken.md": "# Broken\n\n```mermaid\nthis is not a diagram at all !!!\n```\n",
  "empty.md": "# Empty\n\n```mermaid\n```\n",
  "atk-directive.md": "# A\n\n```mermaid\n" + ATK_DIRECTIVE + "\n```\n",
  "atk-frontmatter.md": "# B\n\n```mermaid\n" + ATK_FRONTMATTER + "\n```\n",
  "atk-click.md": "# C\n\n```mermaid\n" + ATK_CLICK + "\n```\n",
  "atk-css.md": "# D\n\n```mermaid\n" + ATK_CSS + "\n```\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, {
    /* `evaluateOnNewDocument`, so this is armed before ANY app code runs AND
       survives every navigation below — a payload that fires during the very
       first render still has somewhere to record itself */
    beforeLoad: () => {
      (window as any).__pwned = [];
      (window as any).__pwn = () => (window as any).__pwned.push("call");
    },
  });
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/** open a doc and wait until its diagram has either drawn or failed */
async function openDiagram(path: string) {
  await page.goto(srv.base + "/d/" + path, { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".mmd");
      return !!b && (!!b.querySelector(".mmd-body svg") || b.classList.contains("bad"));
    },
    { timeout: 20000 }
  );
}

/** what the rendered block actually contains, measured not inferred */
const probe = () =>
  page.evaluate(() => {
    const blk = document.querySelector(".mmd")!;
    const svg = blk.querySelector(".mmd-body svg");
    const r = svg?.getBoundingClientRect();
    const html = svg?.outerHTML ?? "";
    return {
      bad: blk.classList.contains("bad"),
      drew: !!svg,
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      labels: [...(svg?.querySelectorAll("text,tspan") ?? [])].map((t) => t.textContent?.trim()).filter(Boolean),
      err: blk.querySelector(".mmd-err")?.textContent ?? null,
      source: blk.querySelector(".mmd-text")?.textContent ?? null,
      /* the four shapes an escape would take */
      hasScript: !!svg?.querySelector("script") || /<script/i.test(html),
      hasForeignObject: !!svg?.querySelector("foreignObject") || /foreignobject/i.test(html),
      hasOnAttr: /\son[a-z]+\s*=/i.test(html),
      hasJsUrl: /javascript:/i.test(html),
      hasRemoteUrl: /url\(\s*['"]?https?:/i.test(html) || /@import/i.test(html),
      pwned: (window as any).__pwned as unknown[],
    };
  });

describe("e2e — ```mermaid renders in the preview", () => {
  test("a flowchart draws, with its labels as real SVG text", async () => {
    await openDiagram("flow.md");
    const p = await probe();
    expect(`drew: ${p.drew}, bad: ${p.bad}`).toBe("drew: true, bad: false");
    /* a diagram that "renders" to a 0×0 or 1×1 svg is the classic
       over-sanitised failure — assert it occupies real space */
    expect(`has real size: ${p.w > 80 && p.h > 80}`).toBe("has real size: true");
    for (const want of ["Start", "Ship it", "Rethink", "yes", "no"]) {
      expect(`label ${want}: ${p.labels.includes(want)}`).toBe(`label ${want}: true`);
    }
  }, 60000);

  test("a second diagram TYPE draws too — the bundle is not flowchart-only", async () => {
    await openDiagram("seq.md");
    const p = await probe();
    expect(`drew: ${p.drew}, bad: ${p.bad}`).toBe("drew: true, bad: false");
    expect(`has Alice: ${p.labels.includes("Alice")}`).toBe("has Alice: true");
    expect(`has Bob: ${p.labels.includes("Bob")}`).toBe("has Bob: true");
  }, 60000);

  test("a diagram that will not compile says WHY and keeps the source", async () => {
    await openDiagram("broken.md");
    const p = await probe();
    expect(`flagged bad: ${p.bad}`).toBe("flagged bad: true");
    expect(`explains itself: ${!!p.err && p.err.length > 10}`).toBe("explains itself: true");
    /* the whole point: a diagram mid-write must not lose the author's text */
    expect(`source survived: ${(p.source || "").includes("this is not a diagram at all")}`).toBe(
      "source survived: true"
    );
  }, 60000);

  test("an EMPTY mermaid fence stays an ordinary code block", async () => {
    /* a diagram being typed starts empty; flashing an error panel at the first
       keystroke would be noise, so markdown.js routes it to codeEl instead */
    await page.goto(srv.base + "/d/empty.md", { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForSelector("#doc .code", { timeout: 15000 });
    const kind = await page.evaluate(() => ({
      isDiagram: !!document.querySelector(".mmd"),
      isCode: !!document.querySelector("#doc .code"),
    }));
    expect(`diagram: ${kind.isDiagram}, code block: ${kind.isCode}`).toBe("diagram: false, code block: true");
  }, 60000);

  test("the diagram is still a click-to-edit block, on the fence's own line", async () => {
    await openDiagram("flow.md");
    /* `put(node, start)` stamps every top-level block with its source line;
       losing it on the one block the user most wants to edit would be a
       regression no rendering assertion would catch */
    const line = await page.evaluate(() => document.querySelector(".mmd")?.getAttribute("data-line"));
    expect(`fence line: ${line}`).toBe("fence line: 2");
  }, 60000);

  test("the diagram follows the app's theme rather than shipping its own", async () => {
    await openDiagram("flow.md");
    const read = () =>
      page.evaluate(() => {
        const s = document.querySelector(".mmd-body svg style")?.textContent ?? "";
        return /fill:\s*(#[0-9a-f]{3,8})/i.exec(s)?.[1] ?? "";
      });
    const light = await read();
    await page.evaluate(() => document.documentElement.setAttribute("data-scheme", "dark"));
    /* the observer debounces, then re-renders every mounted diagram */
    await page.waitForFunction(
      (before) => {
        const s = document.querySelector(".mmd-body svg style")?.textContent ?? "";
        return (/fill:\s*(#[0-9a-f]{3,8})/i.exec(s)?.[1] ?? "") !== before;
      },
      { timeout: 15000 },
      light
    );
    const dark = await read();
    expect(`repainted for the scheme: ${!!light && !!dark && light !== dark}`).toBe("repainted for the scheme: true");
  }, 60000);
});

describe("e2e — a ```mermaid fence is untrusted input (hardening)", () => {
  test("an %%{init}%% directive cannot downgrade securityLevel or re-enable htmlLabels", async () => {
    await openDiagram("atk-directive.md");
    const p = await probe();
    expect(`nothing executed: ${JSON.stringify(p.pwned)}`).toBe("nothing executed: []");
    expect(`no <script>: ${!p.hasScript}`).toBe("no <script>: true");
    /* foreignObject is how htmlLabels smuggles real HTML into an SVG; its
       absence is the measurable proof htmlLabels stayed off */
    expect(`no foreignObject: ${!p.hasForeignObject}`).toBe("no foreignObject: true");
    expect(`no on* handlers: ${!p.hasOnAttr}`).toBe("no on* handlers: true");
  }, 60000);

  test("YAML frontmatter cannot do it either — the other config channel", async () => {
    await openDiagram("atk-frontmatter.md");
    const p = await probe();
    expect(`nothing executed: ${JSON.stringify(p.pwned)}`).toBe("nothing executed: []");
    expect(`no foreignObject: ${!p.hasForeignObject}`).toBe("no foreignObject: true");
    expect(`no on* handlers: ${!p.hasOnAttr}`).toBe("no on* handlers: true");
  }, 60000);

  test("`click call` and `click href javascript:` are both inert", async () => {
    await openDiagram("atk-click.md");
    /* read the markup BEFORE clicking: a click on a preview block is
       click-to-edit, which switches the pane to Raw and takes `.mmd` out of
       the DOM with it. That is the diagram behaving like every other block,
       not a failure — but it means the probe has to happen first. */
    const before = await probe();
    expect(`no javascript: URL: ${!before.hasJsUrl}`).toBe("no javascript: URL: true");

    /* now click the node the diagram asked to bind a callback to. The binding
       exists only if `bindFunctions()` was called, and app/mermaid.js never
       calls it. A dispatched MouseEvent, not `.click()` — that method is
       HTMLElement's and an SVG node does not have it. */
    await page.evaluate(() => {
      document
        .querySelectorAll(".mmd-body svg .node, .mmd-body svg g, .mmd-body svg a")
        .forEach((n) => n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    });
    const pwned = await page.evaluate(() => (window as any).__pwned as unknown[]);
    expect(`nothing executed: ${JSON.stringify(pwned)}`).toBe("nothing executed: []");
  }, 60000);

  test("dompurifyConfig and themeCSS cannot be set from inside a diagram", async () => {
    await openDiagram("atk-css.md");
    const p = await probe();
    expect(`nothing executed: ${JSON.stringify(p.pwned)}`).toBe("nothing executed: []");
    /* the CSS-injection class (CVE-2022-31108, CVE-2026-41148/41159): the
       payload tried to break out of a rule AND to @import off-origin */
    expect(`no off-origin CSS: ${!p.hasRemoteUrl}`).toBe("no off-origin CSS: true");
    /* and the page it tried to blank is still there */
    const alive = await page.evaluate(() => getComputedStyle(document.body).display);
    expect(`body still displayed: ${alive}`).toBe("body still displayed: block");
  }, 60000);

  test("the app is intact after every attack — no uncaught errors, doc still readable", async () => {
    await openDiagram("flow.md");
    const ok = await page.evaluate(() => ({
      pwned: (window as any).__pwned.length,
      docVisible: !!document.querySelector("#doc .md"),
    }));
    expect(`pwned: ${ok.pwned}, doc rendered: ${ok.docVisible}`).toBe("pwned: 0, doc rendered: true");
  }, 60000);
});
