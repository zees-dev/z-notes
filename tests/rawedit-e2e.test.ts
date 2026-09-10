/* ============================================================
   rawedit-e2e.test.ts — Raw is a line editor (ADR 0032).

   The claim is typographic and it is only true in a real browser: a heading
   line in Raw computes to the SAME font-size the same heading computes to in
   Preview, and a body line to the same as a paragraph. Everything else here is
   the price of getting there — the surface is a contenteditable now, so the
   things a textarea did for free (a byte-exact `value`, Enter splitting a
   line, Backspace joining two, a paste that is plain text) are this module's
   to do, and each is asserted against the bytes rather than against the DOM.

   The third describe is the other half of that bargain: the edits this module
   deliberately does NOT perform. A `plaintext-only` host tells nobody what a
   `delete*` applies to (Chromium hands back empty `getTargetRanges()`), so a
   collapsed-caret delete is the browser's — which is the only way ⌥⌫ deletes a
   word and ⌫ takes a whole grapheme cluster rather than half of one.

   Prior art: tests/ux-e2e.test.ts (the Raw editing suite) for the seed/read
   shape, tests/mobile-editing-e2e.test.ts for keyboard-driven editing.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, sleep, readVaultText, waitUntil, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, ensureMode, pressChord, type AppDriver } from "./browser";

const DOC = "rawedit/typography.md";
const SRC =
  "# Title\n\n## Second\n\n### Third\n\nbody [x](https://example.com) and [[other]]\n\n```\n# not a heading\n```\n";
const OTHER = "rawedit/other.md";

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: { [DOC]: SRC, [OTHER]: "# Other\n" } });
  /* nothing here is about autosave, and a debounce firing mid-assertion turns
     a byte comparison into a race */
  expect((await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 3600 } })).status).toBe(200);
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  /* Closing the page flushes its buffer (`pagehide` → save), so a test that
     typed leaves the doc on disk holding what it typed. Put the seed back
     before the next one measures bytes against it. */
  if (page) await page.close().catch(() => {});
  for (const [path, text] of [[DOC, SRC], [OTHER, "# Other\n"]] as [string, string][]) {
    await srv.putDoc(path, text).catch(() => {});
  }
  pageErrors.length = 0;
  page = await newAppPage(browser, { onPageError: (m) => pageErrors.push(m) });
  app = appDriver(page, srv.base);
});

/** the buffer, through the surface editor.js talks to */
const buffer = () => page.evaluate(() => (document.getElementById("rawArea") as any).value as string);

async function openRaw(path = DOC) {
  await app.boot("/d/" + path);
  await ensureMode(page, "raw", { settle: 160 });
  await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 8000 });
}

/** the class and size of the `.ln` holding `needle` */
const lineFor = (needle: string) =>
  page.evaluate((n) => {
    const ln = (Array.from(document.querySelectorAll("#rawArea .ln")) as HTMLElement[]).find((x) =>
      (x.textContent ?? "").includes(n)
    );
    return { cls: ln?.className, size: ln ? getComputedStyle(ln).fontSize : "" };
  }, needle);

/** put the caret at `pos`, the way ux-e2e's `seed` does: what is measured is
    the editing, not how the caret got there */
async function caretAt(pos: number) {
  await page.evaluate((p) => {
    const ta = document.getElementById("rawArea") as any;
    ta.focus();
    ta.setSelectionRange(p, p);
  }, pos);
}

describe("rawedit — a Raw line is the size of the Preview block it would render as", () => {
  test("headings, body and a fenced # measure the same in both modes", async () => {
    await app.boot("/d/" + DOC);

    /* Preview first: the sizes Raw has to match */
    await ensureMode(page, "preview", { settle: 200 });
    const preview = await page.evaluate(() => {
      const px = (s: string) => {
        const n = document.querySelector("#doc " + s) as HTMLElement | null;
        return n ? getComputedStyle(n).fontSize : "(missing)";
      };
      return { h1: px("h1"), h2: px("h2"), h3: px("h3"), p: px("p") };
    });

    await ensureMode(page, "raw", { settle: 200 });
    const raw = await page.evaluate(() => {
      const px = (s: string) => {
        const n = document.querySelector("#rawArea " + s) as HTMLElement | null;
        return n ? getComputedStyle(n).fontSize : "(missing)";
      };
      const lines = Array.from(document.querySelectorAll("#rawArea .ln")) as HTMLElement[];
      const fenced = lines.find((n) => n.textContent === "# not a heading");
      return {
        h1: px(".ln.h1"),
        h2: px(".ln.h2"),
        h3: px(".ln.h3"),
        /* the body line, addressed by its text so the assertion cannot drift
           onto a heading */
        p: getComputedStyle(lines.find((n) => (n.textContent ?? "").startsWith("body"))!).fontSize,
        fencedClass: fenced ? fenced.className : "(missing)",
        lineCount: lines.length,
      };
    });

    expect(`h1 ${raw.h1} / h2 ${raw.h2} / h3 ${raw.h3} / body ${raw.p}`).toBe(
      `h1 ${preview.h1} / h2 ${preview.h2} / h3 ${preview.h3} / body ${preview.p}`
    );
    /* the claim is only worth something if the sizes actually differ */
    expect(`a heading is bigger than body copy: ${parseFloat(raw.h1) > parseFloat(raw.p)}`).toBe(
      "a heading is bigger than body copy: true"
    );
    /* a `#` inside a fence is not a heading — Preview says so, so Raw does */
    expect(`the fenced line's class: ${raw.fencedClass}`).toBe("the fenced line's class: ln code");
    expect(`one .ln per source line: ${raw.lineCount}`).toBe(`one .ln per source line: ${SRC.split("\n").length}`);
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("every spelling Preview links is highlighted in Raw, and nothing else is", async () => {
    await openRaw();
    await sleep(200); // the highlight is coalesced into a frame
    const hl = await page.evaluate(() => {
      const h = (window as any).CSS?.highlights?.get("raw-link");
      if (!h) return null;
      return Array.from(h as Set<Range>).map((r) => r.toString());
    });
    expect(`highlighted: ${JSON.stringify(hl && hl.sort())}`).toBe(
      `highlighted: ${JSON.stringify(["[[other]]", "[x](https://example.com)"])}`
    );
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("typing `# ` grows the line and deleting it shrinks it back, byte for byte", async () => {
    await openRaw();
    const bodyAt = SRC.indexOf("body");
    await caretAt(bodyAt);
    await page.keyboard.type("# ");
    await sleep(120);

    const grown = await lineFor("body [x]");
    expect(`the line became: ${grown.cls}`).toBe("the line became: ln h1");
    expect(`bytes after typing: ${JSON.stringify(await buffer())}`).toBe(
      `bytes after typing: ${JSON.stringify(SRC.slice(0, bodyAt) + "# " + SRC.slice(bodyAt))}`
    );

    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await sleep(120);
    const shrunk = await lineFor("body [x]");
    expect(`the line went back to: ${shrunk.cls}`).toBe("the line went back to: ln");
    expect(`and so did its size: ${shrunk.size !== grown.size}`).toBe("and so did its size: true");
    expect(`bytes after deleting: ${JSON.stringify(await buffer())}`).toBe(`bytes after deleting: ${JSON.stringify(SRC)}`);
    expect(pageErrors).toEqual([]);
  }, 60000);
});

describe("rawedit — the file is still the file", () => {
  test("a paste carrying HTML lands as plain text only", async () => {
    await openRaw();
    /* A REAL paste, off the real clipboard, with real markup on it. A
       synthetic `paste` event proves nothing here: an untrusted one performs
       no default action, so the buffer would be unchanged whatever the editor
       did with it (ux-e2e leans on exactly that). Prior art for the CDP
       command and the permission grant: tests/ux-e2e.test.ts. */
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions" as any, {
      origin: srv.base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    } as any);
    const armed = await page.evaluate(async () => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob(["<b>bold</b> and <a href='https://x.dev'>a link</a>"], { type: "text/html" }),
            "text/plain": new Blob(["PASTED"], { type: "text/plain" }),
          }),
        ]);
        return true;
      } catch {
        return false;
      }
    });
    expect(`the clipboard really holds markup: ${armed}`).toBe("the clipboard really holds markup: true");

    await caretAt(SRC.length);
    const key = { modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 };
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "rawKeyDown", commands: ["paste"], ...key } as any);
    await cdp.send("Input.dispatchKeyEvent" as any, { type: "keyUp", ...key } as any);
    await sleep(300);
    await cdp.detach().catch(() => {});

    const landed = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      return { value: ta.value as string, html: (ta as HTMLElement).innerHTML };
    });
    expect(`the plain text landed: ${JSON.stringify(landed.value.slice(-7))}`).toBe(
      'the plain text landed: "\\nPASTED"'
    );
    expect(`markup landed: ${/<b>|<a |href=/.test(landed.html)}`).toBe("markup landed: false");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("Enter splits a line, Backspace at a line start joins two, and ⌘S writes the bytes", async () => {
    await openRaw();
    const at = SRC.indexOf("body") + 4; // after "body"
    await caretAt(at);
    await page.keyboard.press("Enter");
    await sleep(120);
    const split = SRC.slice(0, at) + "\n" + SRC.slice(at);
    expect(`split: ${JSON.stringify(await buffer())}`).toBe(`split: ${JSON.stringify(split)}`);
    expect(`one more .ln: ${await page.$$eval("#rawArea .ln", (n) => n.length)}`).toBe(
      `one more .ln: ${split.split("\n").length}`
    );

    await page.keyboard.press("Backspace");
    await sleep(120);
    expect(`joined again: ${JSON.stringify(await buffer())}`).toBe(`joined again: ${JSON.stringify(SRC)}`);

    /* …and the bytes on screen are the bytes that reach disk, trailing newline
       and all */
    await caretAt(SRC.length);
    await page.keyboard.type("TAIL");
    await sleep(120);
    await pressChord(page, "KeyS");
    const onDisk = await waitUntil(
      () => {
        const t = readVaultText(srv.vault, DOC);
        return t.includes("TAIL") ? t : null;
      },
      { timeout: 8000, label: "⌘S to reach disk" }
    );
    expect(`disk === buffer: ${onDisk === (await buffer())}`).toBe("disk === buffer: true");
    expect(`disk: ${JSON.stringify(onDisk)}`).toBe(`disk: ${JSON.stringify(SRC + "TAIL")}`);
    expect(pageErrors).toEqual([]);
  }, 90000);

  test("`value` round-trips a trailing newline, and every other byte", async () => {
    await openRaw(OTHER);
    const cases = ["a\nb\n", "", "\n", "one", "tab\there\n\n\nspaced   out\n", "# h\n\n```\n# c\n```\n"];
    for (const want of cases) {
      const got = await page.evaluate((v) => {
        const ta = document.getElementById("rawArea") as any;
        ta.value = v;
        return { value: ta.value as string, lines: document.querySelectorAll("#rawArea .ln").length };
      }, want);
      expect(`${JSON.stringify(want)} → ${JSON.stringify(got.value)} in ${got.lines} lines`).toBe(
        `${JSON.stringify(want)} → ${JSON.stringify(want)} in ${want.split("\n").length} lines`
      );
    }

    /* the empty-note placeholder is drawn by the element now, not by
       `::placeholder` — which a div does not have */
    const empty = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      ta.value = "";
      const el = ta as HTMLElement;
      return {
        marked: el.classList.contains("is-empty"),
        drawn: getComputedStyle(el, "::before").content,
        placeholder: ta.placeholder as string,
      };
    });
    expect(`empty note marked: ${empty.marked}`).toBe("empty note marked: true");
    expect(`and its placeholder is drawn: ${empty.drawn}`).toBe(
      `and its placeholder is drawn: ${JSON.stringify(empty.placeholder)}`
    );
    expect(pageErrors).toEqual([]);
  }, 60000);
});

describe("rawedit — the deletes the browser keeps", () => {
  /** Seed `text` through the surface, then park the caret at `pos`. */
  async function seed(text: string, pos: number) {
    await page.evaluate(
      (v, p) => {
        const ta = document.getElementById("rawArea") as any;
        ta.value = v;
        ta.focus();
        ta.setSelectionRange(p, p);
      },
      text,
      pos
    );
  }

  test("⌥⌫ takes the word, not one character", async () => {
    await openRaw(OTHER);
    const line = "alpha beta gamma\ntail\n";
    await seed(line, "alpha beta".length);
    /* the real chord, through the real keyboard: the whole point is that the
       BROWSER decides what "a word" is here, and nothing in the app can be
       asked that question */
    await page.keyboard.down("Alt");
    await page.keyboard.press("Backspace");
    await page.keyboard.up("Alt");
    await sleep(150);
    /* exactly what a textarea does: the word goes, the space before it stays */
    expect(`after ⌥⌫: ${JSON.stringify(await buffer())}`).toBe(`after ⌥⌫: ${JSON.stringify("alpha  gamma\ntail\n")}`);
    expect(`.ln per line: ${await page.$$eval("#rawArea .ln", (n) => n.length)}`).toBe(".ln per line: 3");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("⌫ takes a whole grapheme cluster — a ZWJ family, a flag pair", async () => {
    await openRaw(OTHER);
    const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 8 UTF-16 code units
    const FLAG = "\u{1F1EF}\u{1F1F5}"; // two regional indicators, 4
    await seed("a" + FAMILY + "b" + FLAG + "c\n", 1 + FAMILY.length);
    await page.keyboard.press("Backspace");
    await sleep(150);
    expect(`the family went whole: ${JSON.stringify(await buffer())}`).toBe(
      `the family went whole: ${JSON.stringify("ab" + FLAG + "c\n")}`
    );

    await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      const p = ta.value.indexOf("c");
      ta.setSelectionRange(p, p);
    });
    await page.keyboard.press("Backspace");
    await sleep(150);
    expect(`and so did the flag: ${JSON.stringify(await buffer())}`).toBe(
      `and so did the flag: ${JSON.stringify("abc\n")}`
    );
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("⌫ at a line start still joins the two lines, byte for byte", async () => {
    await openRaw(OTHER);
    const two = "first\nsecond\n";
    await seed(two, "first\n".length);
    await page.keyboard.press("Backspace");
    await sleep(150);
    expect(`joined: ${JSON.stringify(await buffer())}`).toBe(`joined: ${JSON.stringify("firstsecond\n")}`);
    expect(`one .ln per line: ${await page.$$eval("#rawArea .ln", (n) => n.length)}`).toBe("one .ln per line: 2");
    expect(pageErrors).toEqual([]);
  }, 60000);

  test("a text node carrying its own newline is normalised, not counted twice", async () => {
    await openRaw(OTHER);
    await seed("one\nthree\n", 0);
    /* what WebKit leaves behind for a line break inside a `pre-wrap` host: a
       "\n" INSIDE a text node, so the model reads a line the DOM has no `.ln`
       for. `compositionend` is the reconcile's other door — the one an
       untrusted `input` cannot reach. */
    const landed = await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as any;
      (ta.children[0] as HTMLElement).firstChild!.nodeValue = "one\ntwo";
      ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      const at = ta.value.indexOf("three");
      ta.focus();
      ta.setSelectionRange(at, at);
      const sel = document.getSelection()!;
      const node = sel.anchorNode!;
      const ln = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement))!;
      return {
        value: ta.value as string,
        lines: ta.querySelectorAll(".ln").length as number,
        caretLine: ln.classList.contains("ln") ? ln.textContent : "(not a line)",
      };
    });
    expect(`bytes: ${JSON.stringify(landed.value)}`).toBe(`bytes: ${JSON.stringify("one\ntwo\nthree\n")}`);
    expect(`one .ln per line: ${landed.lines}`).toBe(
      `one .ln per line: ${landed.value.split("\n").length}`
    );
    expect(`the caret landed on: ${landed.caretLine}`).toBe("the caret landed on: three");
    expect(pageErrors).toEqual([]);
  }, 60000);
});
