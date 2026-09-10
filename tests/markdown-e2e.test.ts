/* ============================================================
   markdown-e2e.test.ts — one document exercises the Preview contract.

   This is deliberately ONE comprehensive browser test. The parser is a
   hand-written, line-aware Markdown subset, so a shallow test of `inline()`
   would miss the seams where the block renderer chooses whether to call it
   (tables once did not), where CSS decides whether semantic markup is visible,
   and where interactive blocks write the source back to disk.

   The specialised suites still own their deep guarantees — Mermaid attack
   hardening, secret encryption, code-block geometry and external-link edge
   cases. This test is the parity map: every documented Preview construct is
   present together, composes with inline formatting, stays safe as DOM, and
   costs no source bytes merely by rendering.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { sleep, startServer, waitUntil, type SeedMap, type TestServer } from "./helpers";
import { ensureMode, launchTestBrowser, newAppPage, waitForApp } from "./browser";

const DOC = "markdown/all.md";
const TARGET = "target.md";
const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";

const SOURCE = [
  "# Heading **bold**",
  "## Subheading *emphasis*",
  "### Detail `inline`",
  "",
  "alpha",
  "bravo",
  "",
  "Inline **bold** *em* ***bold italic*** **_star bold outer_** __*underscore bold outer*__ ___triple underscore___ *__star italic outer__* _**underscore italic outer**_ ~~strike~~ `~~literal~~` `***literal combined***` [[target]] [external](https://example.com/docs)",
  "nested ~~**bold strike**~~, ~~*struck emphasis*~~, *~~emphasized strike~~*, and [~~linked strike~~](https://example.com/struck)",
  "protected ~~`code~~literal` and [safe](https://example.com/a~~b) tail~~; url https://example.com/~~segment~~ stays one literal link; crossing ~~**x~~ y**",
  "split ~~does not",
  "cross lines~~",
  "",
  "- bullet **bold**",
  "  - nested *em*",
  "    - [ ] nested task ~~open~~",
  "- [x] done",
  "7. seven",
  "8) eight",
  "",
  "> quote **bold**",
  "> second ~~strike~~",
  "",
  "---",
  "",
  "| **Header** | [[target]] | [bad](javascript:window.__markdownPwned=4) |",
  "|---|---|---|",
  "| *Cell* | ~~table strike~~ | <img src=x onerror=window.__markdownPwned=3> |",
  "",
  "```ts",
  "const value = 42;",
  "```",
  "",
  "```age",
  ARMOR_HEAD,
  "QUJDRA==",
  "-----END AGE ENCRYPTED FILE-----",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> B{Choice}",
  "  B -->|yes| C[Done]",
  "  B -->|no| D[Retry]",
  "```",
  "",
  "evil <script>window.__markdownPwned = 1</script> [bad](javascript:window.__markdownPwned=2)",
  "image ![alt](https://example.com/i.png) stays literal",
  "",
  /* quotes keep their shape (spec 0019) — appended at the END so every line
     number the assertions above name stays the line it names */
  "> keep    the   spaces",
  ">   two extra",
  "> \tafter a tab",
  "",
  "> outer",
  "> > inner",
  "> outer again",
  "",
  "- a list item",
  "    > aside",
  "",
  /* A CRLF file is first-class — the vault reads bytes back verbatim — and so
     is a line ending in U+2028. Both are lines `RE_QUOTE` admits, so the quote
     reader has to answer for them: it once could not, and a doc with one in it
     threw the whole render away (and, stored as the doc to resume, the boot). */
  "> crlf\r",
  "> u2028\u2028tail",
  "",
  /* A quote UNDER A BULLET is typed with the marker after the bullet, and its
     next lines indented to the item's text; a `>` line indented past the
     bullet is the quote going on, not the list ending. */
  "- > quoted item",
  "  > still quoted",
  "  - > nested quoted",
  "- plain after",
  "",
].join("\n");

/** the source line a fixture line was written on, so the quote assertions
    below survive the corpus growing above them */
const lineOf = (text: string) => SOURCE.split("\n").indexOf(text);
const QUOTE_LINES = {
  spaced: lineOf("> keep    the   spaces"),
  nested: lineOf("> outer"),
  aside: lineOf("    > aside"),
  terminators: lineOf("> crlf\r"),
  inList: lineOf("- > quoted item"),
};

const SEED: SeedMap = {
  [DOC]: SOURCE,
  [TARGET]: "# Target\n",
};

let srv: TestServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  browser = await launchTestBrowser();
  page = await newAppPage(browser, {
    onPageError: (message) => pageErrors.push(message),
    beforeLoad: () => {
      (window as any).__markdownPwned = 0;
    },
  });
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

describe("the documented Markdown subset renders as one safe, byte-faithful document", () => {
  test("blocks, inline constructs, special fences and interactions all agree", async () => {
    await page.goto(srv.base + "/d/" + DOC, { waitUntil: "domcontentloaded" });
    await waitForApp(page);
    await page.waitForFunction((path) => document.getElementById("stPath")!.textContent === path, { timeout: 15000 }, DOC);
    await page.waitForSelector("#doc .md", { timeout: 15000 });
    await page.waitForFunction(
      () => !!document.querySelector("#doc .mmd-body svg") || document.querySelector("#doc .mmd")?.classList.contains("bad"),
      { timeout: 20000 }
    );
    await sleep(160);

    /* Rendering alone may not rewrite so much as one delimiter. Assert this
       BEFORE the task interaction below deliberately changes one marker. */
    const untouched = await srv.doc(DOC);
    expect(untouched.status).toBe(200);
    expect(untouched.body.markdown).toBe(SOURCE);

    const m = await page.evaluate((Q: typeof QUOTE_LINES) => {
      const md = document.querySelector("#doc .md") as HTMLElement;
      const at = (line: number) => md.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
      const line = (n: number) => md.querySelector(`.pline[data-line="${n}"]`) as HTMLElement | null;
      const item = (n: number) => md.querySelector(`li[data-line="${n}"]`) as HTMLElement | null;
      const decoration = (node: Element | null) => (node ? getComputedStyle(node).textDecorationLine : "missing");
      const firstStrike = line(7)?.querySelector("del") ?? null;
      const tableStrike = md.querySelector("tbody del");
      const bulletStyle = getComputedStyle(item(13)!, "::before");
      const quote = md.querySelector("blockquote")!;
      const quoteStyle = getComputedStyle(quote);
      const quoteAt = (n: number) => md.querySelector(`blockquote[data-line="${n}"]`) as HTMLElement;
      const QUOTED_ITEM = ":scope > .tx > blockquote > .pline";
      const spaced = quoteAt(Q.spaced);
      const nested = quoteAt(Q.nested);
      const terminators = quoteAt(Q.terminators);
      const inset = (node: HTMLElement) => parseFloat(getComputedStyle(node).marginLeft);
      const plines = (node: Element, sel: string) => [...node.querySelectorAll(sel)].map((n) => n.textContent);
      const plineNos = (node: Element, sel: string) => [...node.querySelectorAll(sel)].map((n) => n.getAttribute("data-line"));
      const divider = md.querySelector(".divider") as HTMLElement;
      const diagram = md.querySelector(".mmd-body svg") as SVGElement | null;
      const diagramRect = diagram?.getBoundingClientRect();
      const secret = md.querySelector(".secret") as HTMLElement | null;
      const url = [...md.querySelectorAll<HTMLAnchorElement>("a.xl")].find((a) => a.getAttribute("href") === "https://example.com/~~segment~~");
      const linkedStrike = [...md.querySelectorAll<HTMLAnchorElement>("a.xl")].find((a) => a.href === "https://example.com/struck");
      const protectedLink = [...md.querySelectorAll<HTMLAnchorElement>("a.xl")].find((a) => a.getAttribute("href") === "https://example.com/a~~b");
      const protectedStrike = line(9)?.querySelector("del");
      const combinedEmphasis = [...(line(7)?.querySelectorAll("em > strong, strong > em") ?? [])].map((inner) => ({
        text: inner.textContent,
        nesting: inner.parentElement!.tagName + ">" + inner.tagName,
        italic: getComputedStyle(inner).fontStyle === "italic",
        bold: parseFloat(getComputedStyle(inner).fontWeight) >= 600,
      }));

      return {
        /* Aggregate the regression's two failure surfaces. One failed equality
           reports BOTH a missing strike pass and tables bypassing inline(). */
        formatting: {
          paragraphStrike: firstStrike?.textContent ?? null,
          paragraphDecoration: decoration(firstStrike),
          combinedEmphasis,
          nestedBoldStrike: !!line(8)?.querySelector("del strong"),
          struckEmphasis: !!line(8)?.querySelector("del em"),
          emphasizedStrike: !!line(8)?.querySelector("em del"),
          linkedLabelStrike: !!linkedStrike?.querySelector("del"),
          protectedCode: protectedStrike?.querySelector("code.ic")?.textContent ?? null,
          protectedHref: protectedLink?.getAttribute("href") ?? null,
          protectedLinkInsideStrike: !!protectedLink?.closest("del"),
          protectedLineStrikeCount: line(9)?.querySelectorAll("del").length ?? -1,
          codeStayedLiteral: line(7)?.querySelector("code.ic")?.textContent ?? null,
          combinedCodeStayedLiteral:
            [...(line(7)?.querySelectorAll("code.ic") ?? [])].find((node) => node.textContent?.includes("literal combined"))
              ?.textContent ?? null,
          tableHeadBold: md.querySelector("thead strong")?.textContent ?? null,
          tableWiki: md.querySelector("thead a.wl")?.getAttribute("data-link") ?? null,
          tableCellEm: md.querySelector("tbody em")?.textContent ?? null,
          tableCellStrike: tableStrike?.textContent ?? null,
          tableStrikeDecoration: decoration(tableStrike),
        },
        headings: ["h1", "h2", "h3"].map((tag) => ({
          text: md.querySelector(tag)?.textContent ?? null,
          size: parseFloat(getComputedStyle(md.querySelector(tag)!).fontSize),
        })),
        paragraph: {
          lines: [4, 5].map((n) => line(n)?.textContent ?? null),
          breakCount: at(4)?.querySelectorAll("br").length ?? -1,
          dataLines: [...(at(4)?.querySelectorAll(".pline") ?? [])].map((n) => n.getAttribute("data-line")),
          bold: line(7)?.querySelector("strong")?.textContent ?? null,
          emphasis: line(7)?.querySelector("em")?.textContent ?? null,
          wiki: line(7)?.querySelector("a.wl")?.getAttribute("data-link") ?? null,
          external: line(7)?.querySelector("a.xl")?.getAttribute("href") ?? null,
          splitStrikeCount: (line(10)?.querySelectorAll("del").length ?? 0) + (line(11)?.querySelectorAll("del").length ?? 0),
          splitText: [line(10)?.textContent, line(11)?.textContent],
          urlHref: url?.getAttribute("href") ?? null,
          urlText: url?.textContent ?? null,
          urlStrikeCount: url?.querySelectorAll("del").length ?? -1,
        },
        lists: {
          bullet: item(13)?.classList.contains("bul") ?? false,
          nestedParent: item(14)?.parentElement?.closest("li")?.getAttribute("data-line") ?? null,
          taskParent: item(15)?.parentElement?.closest("li")?.getAttribute("data-line") ?? null,
          taskUnchecked: item(15)?.querySelector(".cb")?.getAttribute("aria-pressed") ?? null,
          taskStrike: item(15)?.querySelector("del")?.textContent ?? null,
          taskChecked: item(16)?.querySelector(".cb")?.getAttribute("aria-pressed") ?? null,
          ordered: [17, 18].map((n) => item(n)?.querySelector(".li-marker")?.textContent ?? null),
          bulletRound: bulletStyle.width === bulletStyle.height && bulletStyle.borderRadius === "50%",
        },
        quoteAndRule: {
          lines: plines(quote, ".pline"),
          dataLines: plineNos(quote, ".pline"),
          strike: md.querySelector("blockquote del")?.textContent ?? null,
          border: parseFloat(quoteStyle.borderLeftWidth) > 0,
          divider: divider.getBoundingClientRect().height > 0,
        },
        /* a quote keeps its shape: the whitespace after the marker, the depth
           the markers say, and the indent before them (spec 0019) */
        quotes: {
          spacing: plines(spaced, ".pline"),
          spacingLines: plineNos(spaced, ".pline"),
          whiteSpace: getComputedStyle(spaced.querySelector(".pline")!).whiteSpace,
          outerLines: plines(nested, ":scope > .pline"),
          innerLines: plines(nested, ":scope > blockquote > .pline"),
          /* one marker per depth was consumed and no more: nothing prints a `>` */
          markersPrinted: [...md.querySelectorAll("blockquote .pline")].filter((n) => n.textContent!.includes(">")).length,
          asideIsInset: inset(quoteAt(Q.aside)) > inset(nested),
          /* the CR the HTML parser may have turned into a newline is not the
             point — that the line rendered AT ALL is */
          terminators: plines(terminators, ".pline").map((t) => t!.replace(/[\r\n]+$/, "")),
          /* the quoted item: its quote holds the continuation line, the nested
             item holds its own, the list is still one list, and the item's
             blockquote is not inset the way a document-level `    > aside` is */
          inList: plines(item(Q.inList)!, QUOTED_ITEM),
          inListNested: plines(item(Q.inList + 2)!, QUOTED_ITEM),
          inListLines: plineNos(item(Q.inList)!, QUOTED_ITEM),
          listIntact: item(Q.inList)!.parentElement === item(Q.inList + 3)!.parentElement,
          inListInset: inset(item(Q.inList)!.querySelector("blockquote") as HTMLElement),
        },
        table: {
          heads: md.querySelectorAll("thead th").length,
          rows: md.querySelectorAll("tbody tr").length,
          cells: md.querySelectorAll("tbody td").length,
        },
        code: {
          language: md.querySelector(".code:not(.mmd) .lang")?.textContent ?? null,
          text: md.querySelector(".code:not(.mmd) pre")?.textContent ?? null,
          lines: md.querySelectorAll(".code:not(.mmd) .cline").length,
          keywords: md.querySelectorAll(".code:not(.mmd) .tk-key").length,
          numbers: md.querySelectorAll(".code:not(.mmd) .tk-num").length,
        },
        secret: {
          exists: !!secret,
          flagged: secret?.classList.contains("flagged") ?? null,
          armorVisible: secret?.outerHTML.includes("BEGIN AGE ENCRYPTED FILE") ?? true,
        },
        mermaid: {
          drew: !!diagram,
          width: diagramRect ? Math.round(diagramRect.width) : 0,
          height: diagramRect ? Math.round(diagramRect.height) : 0,
          labels: [...(diagram?.querySelectorAll("text,tspan") ?? [])].map((n) => n.textContent?.trim()).filter(Boolean),
        },
        safety: {
          scripts: md.querySelectorAll("script").length,
          images: md.querySelectorAll("img").length,
          jsLinks: [...md.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.getAttribute("href")?.startsWith("javascript:")).length,
          pwned: (window as any).__markdownPwned,
          evilText: line(46)?.textContent ?? null,
          imageText: line(47)?.textContent ?? null,
          tableUnsafeText: md.querySelector("thead th:last-child")?.textContent ?? null,
        },
      };
    }, QUOTE_LINES);

    expect(m.formatting).toEqual({
      paragraphStrike: "strike",
      paragraphDecoration: "line-through",
      combinedEmphasis: [
        { text: "bold italic", nesting: "EM>STRONG", italic: true, bold: true },
        { text: "star bold outer", nesting: "STRONG>EM", italic: true, bold: true },
        { text: "underscore bold outer", nesting: "STRONG>EM", italic: true, bold: true },
        { text: "triple underscore", nesting: "EM>STRONG", italic: true, bold: true },
        { text: "star italic outer", nesting: "EM>STRONG", italic: true, bold: true },
        { text: "underscore italic outer", nesting: "EM>STRONG", italic: true, bold: true },
      ],
      nestedBoldStrike: true,
      struckEmphasis: true,
      emphasizedStrike: true,
      linkedLabelStrike: true,
      protectedCode: "code~~literal",
      protectedHref: "https://example.com/a~~b",
      protectedLinkInsideStrike: true,
      protectedLineStrikeCount: 1,
      codeStayedLiteral: "~~literal~~",
      combinedCodeStayedLiteral: "***literal combined***",
      tableHeadBold: "Header",
      tableWiki: "target",
      tableCellEm: "Cell",
      tableCellStrike: "table strike",
      tableStrikeDecoration: "line-through",
    });

    expect(m.headings.map((h) => h.text)).toEqual(["Heading bold", "Subheading emphasis", "Detail inline"]);
    expect(m.headings[0].size).toBeGreaterThan(m.headings[1].size);
    expect(m.headings[1].size).toBeGreaterThan(m.headings[2].size);
    expect(m.paragraph).toEqual({
      lines: ["alpha", "bravo"],
      breakCount: 1,
      dataLines: ["4", "5"],
      bold: "bold",
      emphasis: "em",
      wiki: "target",
      external: "https://example.com/docs",
      splitStrikeCount: 0,
      splitText: ["split ~~does not", "cross lines~~"],
      urlHref: "https://example.com/~~segment~~",
      urlText: "https://example.com/~~segment~~",
      urlStrikeCount: 0,
    });
    expect(m.lists).toEqual({
      bullet: true,
      nestedParent: "13",
      taskParent: "14",
      taskUnchecked: "false",
      taskStrike: "open",
      taskChecked: "true",
      ordered: ["7.", "8)"],
      bulletRound: true,
    });
    expect(m.quoteAndRule).toEqual({
      lines: ["quote bold", "second strike"],
      dataLines: ["20", "21"],
      strike: "strike",
      border: true,
      divider: true,
    });
    expect(m.quotes).toEqual({
      /* one space per marker is the marker's; every other byte is the text's,
         and `pre-wrap` is what makes that visible rather than merely present */
      spacing: ["keep    the   spaces", "  two extra", "\tafter a tab"],
      spacingLines: [QUOTE_LINES.spaced, QUOTE_LINES.spaced + 1, QUOTE_LINES.spaced + 2].map(String),
      whiteSpace: "pre-wrap",
      outerLines: ["outer", "outer again"],
      innerLines: ["inner"],
      markersPrinted: 0,
      asideIsInset: true,
      terminators: ["crlf", "u2028\u2028tail"],
      inList: ["quoted item", "still quoted"],
      inListNested: ["nested quoted"],
      inListLines: [QUOTE_LINES.inList, QUOTE_LINES.inList + 1].map(String),
      listIntact: true,
      inListInset: 0,
    });
    expect(m.table).toEqual({ heads: 3, rows: 1, cells: 3 });
    expect(m.code).toEqual({ language: "ts", text: "const value = 42;", lines: 1, keywords: 1, numbers: 1 });
    expect(m.secret).toEqual({ exists: true, flagged: false, armorVisible: false });
    expect(m.mermaid.drew).toBe(true);
    expect(`diagram occupies real space: ${m.mermaid.width}x${m.mermaid.height} → ${m.mermaid.width > 40 && m.mermaid.height > 1}`).toBe(
      `diagram occupies real space: ${m.mermaid.width}x${m.mermaid.height} → true`
    );
    expect(m.mermaid.labels).toEqual(expect.arrayContaining(["Start", "Done"]));
    expect(m.safety).toEqual({
      scripts: 0,
      images: 0,
      jsLinks: 0,
      pwned: 0,
      evilText: "evil <script>window.__markdownPwned = 1</script> [bad](javascript:window.__markdownPwned=2)",
      imageText: "image ![alt](https://example.com/i.png) stays literal",
      tableUnsafeText: "[bad](javascript:window.__markdownPwned=4)",
    });

    /* A task checkbox is the one Preview construct that edits in place. It
       flips only its own marker, writes immediately, and remains in Preview. */
    await page.click('.md li[data-line="15"] > .cb');
    const changed = SOURCE.replace("    - [ ] nested task ~~open~~", "    - [x] nested task ~~open~~");
    await waitUntil(async () => (await srv.doc(DOC)).body.markdown === changed, {
      timeout: 8000,
      label: "task toggle to reach disk",
    });
    expect(await page.$("#rawArea")).toBe(null);
    expect(await page.$eval('.md li[data-line="15"] > .cb', (n) => n.getAttribute("aria-pressed"))).toBe("true");
    expect((await srv.doc(DOC)).body.markdown).toBe(changed);

    /* ONE TAB IS ONE WIDTH IN BOTH MODES. Keeping a quote's whitespace
       (spec 0019) made `.md blockquote .pline` `pre-wrap`, and a `pre-wrap`
       span with no tab-size takes the UA's 8 while `.raw` renders tabs at the
       `editor.tabSize` setting — a tab-aligned quote reflowed on every ⌘E. */
    const previewTab = await page.$eval(
      `.md blockquote[data-line="${QUOTE_LINES.spaced}"] .pline`,
      (n) => getComputedStyle(n).tabSize
    );
    await ensureMode(page, "raw");
    await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
    const rawTab = await page.$eval("#rawArea", (n) => getComputedStyle(n).tabSize);
    expect(`preview ${previewTab} · raw ${rawTab}`).toBe(`preview ${rawTab} · raw ${rawTab}`);

    expect(pageErrors).toEqual([]);
  }, 120000);
});
