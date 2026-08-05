/* ============================================================
   mobile-e2e.test.ts — the phone band, measured on the containers that
   actually move.

   Every claim here failed at least once against a gate that was reading the
   wrong box. `document.documentElement.scrollWidth - clientWidth` is 0 while
   the DOCUMENT PANE scrolls sideways by 200+px, because the overflow is
   contained inside `#scroll`; `.composer textarea`'s `max-height` said 110px
   while nothing ever grew the field past two rows; and `--sheet-h` was a
   viewport fraction that took no account of the soft keyboard it is pinned
   above. So each test below names the element it measures and asserts a
   number, not a class list:

     · RENDERED MARKDOWN WRAPS. `#scroll` never scrolls horizontally over a
       note containing a URL, a long token, an inline code span, a blockquote
       or a list item — one doc per construct, so a fix that covers only
       paragraphs fails here.
     · THE COMPOSER GROWS. A multi-line prompt is visible up to the cap, and
       Send keeps its 44px.
     · THE SHEET FITS ABOVE THE KEYBOARD. With `--kb` set to what
       `wireVisualViewport` publishes, the sheet's top edge and its head stay
       on screen at the two phone sizes that used to clip.
     · TOUCH TARGETS. The controls a thumb has to hit on a phone are ≥44px,
       or — where a bar's own height forbids that — hittable across the whole
       bar.
     · THE TREE LONG-PRESS. The only route a phone has to rename or delete a
       FILE opens the same menu the right-click opens, does not open the doc
       under it, and does not fire on a scroll.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { startServer, sleep, SEED_VAULT, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, type AppDriver } from "./browser";

const PHONE = { width: 390, height: 844 };
const URL_TOKEN = "https://internal.example.com/wiki/spaces/ENG/pages/1189273/Event+Pipeline+Design+Notes+v4";
const LONG_WORD = "Supercalifragilisticexpialidociousantidisestablishmentarianismpneumonoultramicroscopicsilicovolcanoconiosis";
const LONG_IDENT = "applicationConfigurationRegistryFactoryProviderSingletonAccessorInstanceBuilder()";

/* one construct per doc — the whole point is that a fix landing on `.md p`
   alone must still fail on the inline-code and blockquote rows. `wrap/all.md`
   is the realistic note the failure was reported against. */
const WRAP_DOCS: Record<string, string> = {
  "wrap/url.md": `# Wrap\n\nThe spec lives at ${URL_TOKEN} and we agreed on it.\n`,
  "wrap/word.md": `# Wrap\n\n${LONG_WORD}\n`,
  "wrap/code.md": `# Wrap\n\nCall \`${LONG_IDENT}\` before anything else.\n`,
  "wrap/quote.md": `# Wrap\n\n> ${URL_TOKEN} is where it lives.\n`,
  "wrap/list.md": `# Wrap\n\n- ${URL_TOKEN}\n- [ ] read it\n`,
  "wrap/head.md": `# ${LONG_WORD}\n\nordinary prose underneath.\n`,
  "wrap/all.md": `# Wrap\n\nThe spec lives at ${URL_TOKEN} and we agreed on it.\n\n- [ ] read it\n- [ ] argue about it\n\nUse \`${LONG_IDENT}\` for that.\n`,
};

let srv: TestServer;
let browser: Browser;
let page: Page;
let app: AppDriver;
const pageErrors: string[] = [];

beforeAll(async () => {
  srv = await startServer({ seed: { ...SEED_VAULT, ...WRAP_DOCS } });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

beforeEach(async () => {
  if (page) await page.close().catch(() => {});
  pageErrors.length = 0;
  page = await newAppPage(browser, {
    ...PHONE,
    onPageError: (m) => pageErrors.push(m),
    beforeLoad: () => {
      try {
        localStorage.removeItem("znotes.chat");
      } catch {}
    },
  });
  app = appDriver(page, srv.base);
});

/** the container that actually scrolls the document — NOT the page */
const scrollOverflow = () =>
  page.evaluate(() => {
    const sc = document.getElementById("scroll") as HTMLElement;
    return {
      scroll: Math.round(sc.scrollWidth - sc.clientWidth),
      page: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });

/** the theme sheet has LOADED, not merely been swapped in */
const themeReady = (theme: string) =>
  page.waitForFunction(
    (t) =>
      [...document.styleSheets].some((s) => {
        try {
          return (s.href ?? "").endsWith(`/themes/${t}.css`) && !!s.cssRules.length;
        } catch {
          return false;
        }
      }),
    { timeout: 10000 },
    theme
  );

describe("phone — the document pane never scrolls sideways", () => {
  test("every ordinary construct fits #scroll at 360px", async () => {
    await page.setViewport({ width: 360, height: 800 });
    for (const path of Object.keys(WRAP_DOCS)) {
      await app.boot("/d/" + path);
      await sleep(280);
      const m = await scrollOverflow();
      /* the page-level number is measured and printed too, because it reading
         0 while #scroll overflows by 240px is exactly why this went unseen */
      expect(`360px ${path}: #scroll overflows by ${m.scroll}px (page by ${m.page}px)`).toBe(
        `360px ${path}: #scroll overflows by 0px (page by ${m.page}px)`
      );
    }
  }, 180000);

  test("…in all three themes, and in Raw as well as Preview", async () => {
    await page.setViewport({ width: 360, height: 800 });
    for (const theme of ["minimal", "modern", "terminal"]) {
      await app.boot("/d/wrap/all.md?theme=" + theme);
      await themeReady(theme);
      await sleep(280);
      const preview = await scrollOverflow();
      expect(`${theme} preview: #scroll overflows by ${preview.scroll}px`).toBe(
        `${theme} preview: #scroll overflows by 0px`
      );
      await page.evaluate(() => (document.getElementById("stMode") as HTMLElement).click());
      await page.waitForSelector("#doc.raw-mode #rawArea", { timeout: 5000 });
      await sleep(180);
      const raw = await scrollOverflow();
      expect(`${theme} raw: #scroll overflows by ${raw.scroll}px`).toBe(`${theme} raw: #scroll overflows by 0px`);
    }
  }, 180000);
});

describe("phone — the chat composer", () => {
  const read = () =>
    page.evaluate(() => {
      const ta = document.getElementById("composer") as HTMLTextAreaElement;
      const cs = getComputedStyle(ta);
      const send = document.querySelector(".chat .send") as HTMLElement;
      const sr = send.getBoundingClientRect();
      return {
        h: Math.round(ta.getBoundingClientRect().height),
        scrollH: Math.round(ta.scrollHeight),
        cap: Math.round(parseFloat(cs.maxHeight)),
        fs: Math.round(parseFloat(cs.fontSize)),
        send: { w: Math.round(sr.width), h: Math.round(sr.height) },
      };
    });

  test("grows with a multi-line prompt, up to its cap, and Send keeps 44px", async () => {
    await app.boot("/");
    await page.evaluate(() => (document.getElementById("chatBtn") as HTMLElement).click());
    await sleep(380);

    const empty = await read();
    expect(`composer font on a phone: ${empty.fs}px`).toBe("composer font on a phone: 16px");
    expect(`send is ${empty.send.w}x${empty.send.h}`).toBe("send is 44x44");

    await page.focus("#composer");
    await page.type("#composer", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten");
    await sleep(150);
    const grown = await read();

    /* the field tracks its content instead of sitting at two rows */
    expect(`composer grew past its two-row box: ${grown.h > empty.h + 20}`).toBe(
      "composer grew past its two-row box: true"
    );
    /* …and the cap is a real ceiling rather than dead text: the height is
       scrollHeight clamped to max-height */
    expect(`composer height ${grown.h} = min(scrollHeight ${grown.scrollH}, cap ${grown.cap})`).toBe(
      `composer height ${Math.min(grown.scrollH, grown.cap)} = min(scrollHeight ${grown.scrollH}, cap ${grown.cap})`
    );
    /* Send is the ONLY way to send below this breakpoint, so it may not be
       pushed off the sheet by the field growing under it */
    expect(`send is ${grown.send.w}x${grown.send.h}`).toBe("send is 44x44");
    const sendOnScreen = await page.evaluate(() => {
      const r = (document.querySelector(".chat .send") as HTMLElement).getBoundingClientRect();
      const sheet = (document.querySelector(".chat") as HTMLElement).getBoundingClientRect();
      return r.bottom <= sheet.bottom + 1 && r.top >= sheet.top - 1;
    });
    expect(`send stayed inside the sheet: ${sendOnScreen}`).toBe("send stayed inside the sheet: true");

    /* and the field shrinks back rather than leaving its own hole */
    await page.evaluate(() => {
      const ta = document.getElementById("composer") as HTMLTextAreaElement;
      ta.value = "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(100);
    const back = await read();
    expect(`composer returned to ${back.h} (empty was ${empty.h})`).toBe(
      `composer returned to ${empty.h} (empty was ${empty.h})`
    );
  }, 90000);
});

describe("phone — the bottom sheet is keyboard-aware", () => {
  /* `--kb` is published by wireVisualViewport as a length on the root; setting
     it directly is exactly what a raised soft keyboard does, and it is the only
     way to reach that state headlessly. */
  const sheetAt = async (width: number, height: number, kb: number) => {
    await page.setViewport({ width, height });
    await sleep(260);
    return page.evaluate((k: number) => {
      const root = document.documentElement;
      root.style.setProperty("--kb", k + "px");
      const chat = document.querySelector(".chat") as HTMLElement;
      const head = document.querySelector(".chat-head") as HTMLElement;
      const cr = chat.getBoundingClientRect();
      const hr = head.getBoundingClientRect();
      root.style.removeProperty("--kb");
      return { top: Math.round(cr.top), height: Math.round(cr.height), headTop: Math.round(hr.top) };
    }, kb);
  };

  test("the sheet's top edge and its head stay on screen with the keyboard up", async () => {
    await app.boot("/");
    await page.evaluate(() => (document.getElementById("chatBtn") as HTMLElement).click());
    await sleep(380);
    const cases: Array<[number, number, number]> = [
      [360, 640, 290], // measured before the fix: chat.top -8, head.top -7
      [375, 667, 300], // measured before the fix: chat.top -7
      [390, 844, 336], // already fitted — must not regress
      [412, 915, 350],
    ];
    for (const [w, h, kb] of cases) {
      const m = await sheetAt(w, h, kb);
      expect(`${w}x${h} kb=${kb}: chat.top ${m.top}, head.top ${m.headTop}`).toBe(
        `${w}x${h} kb=${kb}: chat.top ${Math.max(0, m.top)}, head.top ${Math.max(0, m.headTop)}`
      );
    }
  }, 120000);

  test("…and with no keyboard the 440px cap is untouched", async () => {
    await app.boot("/");
    await page.evaluate(() => (document.getElementById("chatBtn") as HTMLElement).click());
    await sleep(380);
    const m = await sheetAt(390, 844, 0);
    expect(`390x844 kb=0: the sheet is ${m.height}px`).toBe("390x844 kb=0: the sheet is 440px");
  }, 90000);
});

const openDrawer = async () => {
  await page.evaluate(() => (document.querySelector('.topbar [data-act="nav-open"]') as HTMLElement)?.click());
  await sleep(340);
};

describe("phone — touch targets", () => {
  test("the tree, the row menu, the dialog verbs and the two bars clear their floors", async () => {
    await app.boot("/");
    await openDrawer();

    /* scroll FIRST and settle, then measure. `#tree`'s scroll handler closes the
       context menu (and cancels a long press), and a `scrollIntoView` inside the
       same task delivers its scroll event afterwards — measuring and clicking
       without letting it land closes the menu on the click that opened it. */
    await page.evaluate(() =>
      (document.querySelector('#tree .row.file[data-doc="inbox.md"]') as HTMLElement).scrollIntoView({ block: "center" })
    );
    await sleep(200);
    const box = await page.evaluate(() => {
      const row = document.querySelector('#tree .row.file[data-doc="inbox.md"]') as HTMLElement;
      const r = row.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        h: Math.round(r.height),
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
      };
    });
    expect(`the probe row is on screen: ${box.onScreen}`).toBe("the probe row is on screen: true");
    expect(`tree row height ${box.h} >= 44`).toBe(`tree row height ${Math.max(44, box.h)} >= 44`);

    await page.mouse.click(box.x, box.y, { button: "right" });
    await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 5000 });
    /* the menu mounts at `transform: scale(.97)` and animates to none — a rect
       read mid-transition comes back 3% small and every floor here is off by
       one pixel */
    await sleep(260);

    const menu = await page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>("#ctxMenu .menu-item")];
      const rects = items.map((n) => n.getBoundingClientRect());
      let minGap = Infinity;
      for (let i = 1; i < rects.length; i++) {
        minGap = Math.min(minGap, rects[i].top + rects[i].height / 2 - (rects[i - 1].top + rects[i - 1].height / 2));
      }
      return {
        head: document.querySelector("#ctxMenu .menu-head")?.textContent ?? null,
        labels: items.map((n) => n.querySelector(".lbl")?.textContent),
        count: items.length,
        minH: Math.round(Math.min(...rects.map((r) => r.height))),
        minGap: Math.round(minGap),
      };
    });
    expect(`the menu opened on ${menu.head} with ${JSON.stringify(menu.labels)}`).toBe(
      `the menu opened on inbox.md with ${JSON.stringify(["Open", "New doc", "New folder", "Rename / move", "Delete"])}`
    );
    expect(`shortest menu item ${menu.minH} >= 44`).toBe(`shortest menu item ${Math.max(44, menu.minH)} >= 44`);
    /* the concrete failure this exists for: "Rename / move" sits directly above
       "Delete" and their centres were 19px apart */
    expect(`closest two menu centres ${menu.minGap} >= 44`).toBe(
      `closest two menu centres ${Math.max(44, menu.minGap)} >= 44`
    );

    /* the confirm dialog's verbs — one of them is Delete, which is the one
       press that cannot be undone by pressing it again */
    await page.keyboard.press("Escape");
    await sleep(160);
    const verbs = await page.evaluate(() => {
      const veil = document.getElementById("cfVeil") as HTMLElement;
      veil.classList.add("show");
      /* offsetHeight, not a rect: the modal mounts under
         `transform: translateY(10px) scale(.985)` and animates to none, and a
         rect read before that settles comes back 1.5% small. Offsets ignore
         transforms — the same reason ctxPlace measures with them. */
      const h = [...document.querySelectorAll<HTMLElement>("#cfVeil .modal-foot .btn")].map((b) => b.offsetHeight);
      veil.classList.remove("show");
      return h;
    });
    expect(`the confirm has verbs: ${verbs.length}`).toBe("the confirm has verbs: 2");
    expect(`shortest confirm verb ${Math.min(...verbs)} >= 44`).toBe(
      `shortest confirm verb ${Math.max(44, Math.min(...verbs))} >= 44`
    );

    /* The bars: a 25px control inside a 24px statusbar cannot BE 44px tall, so
       the claim is that its hit area is the bar's full height — read through
       elementFromPoint at the bar's top and bottom edge, over the control's own
       horizontal centre. (`overflow: hidden` on the bar clips hit testing too,
       which is why the bar itself carries the floor.) */
    /* the drawer is a fixed overlay across the left 300px — with it open,
       elementFromPoint over the statusbar returns the drawer, not the chip */
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("nav-open"), { timeout: 4000 });
    await sleep(400);

    const bars = await page.evaluate(() => {
      const probe = (sel: string, barSel: string) => {
        const b = document.querySelector(sel) as HTMLElement | null;
        const bar = document.querySelector(barSel) as HTMLElement | null;
        if (!b || !bar || b.offsetParent === null) return null;
        const r = b.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const hits = (y: number) => {
          const n = document.elementFromPoint(x, y) as HTMLElement | null;
          return !!(n && (n === b || b.contains(n)));
        };
        return { sel, top: hits(br.top + 2), bottom: hits(br.bottom - 2), barH: Math.round(br.height) };
      };
      return [probe("#stMode", ".statusbar"), probe('.topbar [data-act="nav-open"]', ".topbar")].filter(Boolean);
    });
    expect(`both bar controls were probed: ${bars.length}`).toBe("both bar controls were probed: 2");
    for (const b of bars as Array<{ sel: string; top: boolean; bottom: boolean; barH: number }>) {
      expect(`${b.sel} hittable across its ${b.barH}px bar — top ${b.top}, bottom ${b.bottom}`).toBe(
        `${b.sel} hittable across its ${b.barH}px bar — top true, bottom true`
      );
    }
  }, 120000);
});

describe("phone — the tree long-press", () => {
  /* Touch is dispatched over CDP: puppeteer's mouse cannot produce
     `pointerType: "touch"`, and the handler refuses a mouse on purpose (a mouse
     already has the right button). */
  const touch = async (fn: (cdp: any) => Promise<void>) => {
    const cdp = await page.createCDPSession();
    try {
      await fn(cdp);
    } finally {
      await cdp.detach().catch(() => {});
    }
  };
  /* scroll, settle, THEN measure — `#tree`'s scroll handler cancels a long
     press, and a scroll event delivered mid-gesture would cancel this one */
  const rowPoint = async (sel: string) => {
    await page.evaluate((s: string) => (document.querySelector(s) as HTMLElement).scrollIntoView({ block: "center" }), sel);
    await sleep(200);
    return page.evaluate((s: string) => {
      const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, sel);
  };

  const menuOpen = () => page.evaluate(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden);
  const menuLabels = () =>
    page.evaluate(() => [...document.querySelectorAll("#ctxMenu .menu-item .lbl")].map((n) => n.textContent));

  test("a 700ms press on a FILE row opens the menu, and does not open the doc under it", async () => {
    await app.boot("/");
    await openDrawer();
    const before = await page.evaluate(() => document.getElementById("stPath")!.textContent);
    const p = await rowPoint('#tree .row.file[data-doc="inbox.md"]');

    await touch(async (cdp) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
      await sleep(700);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await page.waitForFunction(() => !(document.getElementById("ctxMenu") as HTMLElement).hidden, { timeout: 4000 });

    expect(`long-press menu: ${JSON.stringify(await menuLabels())}`).toBe(
      `long-press menu: ${JSON.stringify(["Open", "New doc", "New folder", "Rename / move", "Delete"])}`
    );

    /* the press must not ALSO open the doc and close the drawer under the menu
       — that loop is the whole reason this gesture exists */
    await sleep(320);
    const after = await page.evaluate(() => ({
      path: document.getElementById("stPath")!.textContent,
      nav: document.getElementById("app")!.classList.contains("nav-open"),
      menu: !(document.getElementById("ctxMenu") as HTMLElement).hidden,
    }));
    expect(
      `after the press — the doc moved: ${after.path !== before}, drawer open: ${after.nav}, menu open: ${after.menu}`
    ).toBe("after the press — the doc moved: false, drawer open: true, menu open: true");
    expect(`page errors: ${JSON.stringify(pageErrors)}`).toBe("page errors: []");
  }, 90000);

  test("a short tap is still a tap, and a drag is still a scroll", async () => {
    await app.boot("/");
    await openDrawer();
    const p = await rowPoint('#tree .row.file[data-doc="inbox.md"]');

    await touch(async (cdp) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
      await sleep(120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await sleep(400);
    expect(`a short tap opened a menu: ${await menuOpen()}`).toBe("a short tap opened a menu: false");

    await openDrawer();
    const q = await rowPoint('#tree .row.file[data-doc="inbox.md"]');
    await touch(async (cdp) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: q.x, y: q.y }] });
      await sleep(120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: q.x, y: q.y - 60 }] });
      await sleep(700);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await sleep(250);
    expect(`a drag opened a menu: ${await menuOpen()}`).toBe("a drag opened a menu: false");
  }, 90000);
});
