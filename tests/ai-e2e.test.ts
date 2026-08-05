/* ============================================================
   ai-e2e.test.ts — PHASE 4 in a real browser.

   The API-level gate (ai.test.ts) proves the relay is correct. This one proves
   the things only a browser can show:

     - the assistant's answer is rendered PROGRESSIVELY (partial text visible
       before `done`) — the whole point of SPEC §3 delta 4;
     - a plain answer shows NO diff card (the binding user preference: not
       every reply proposes an edit);
     - a tool-call turn renders a real diff, Accept writes the doc in BOTH
       modes, and the change stack is server-authoritative — the older card's
       Revert is disabled and says which one to revert first;
     - a new session drops the thread and keeps the stack;
     - starting a second turn cancels the first: no interleaved bubbles in the
       DOM and, upstream, the first stream really was cancelled.

   Driver: puppeteer-core over the Chromium headless shell Playwright already
   cached, exactly like tests/e2e.test.ts. One server, one page, one mock; only
   two tests drip in real time.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import {
  readVaultText,
  sleep,
  startServer,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { proposeEdits, reply, startMockUpstream, type MockUpstream } from "./mock-upstream";
import { ensureMode as setMode, launchTestBrowser, newAppPage, waitSettings } from "./browser";

const DOC = "notes/e2e-target.md";
const DOC_MD =
  "# E2E target\n" +
  "\n" +
  "The first paragraph is untouched.\n" +
  "\n" +
  "ANCHORONE line waiting for an edit\n" +
  "\n" +
  "ANCHORTWO line waiting for an edit\n" +
  "\n" +
  "The last paragraph is untouched.\n";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [DOC]: DOC_MD,
};

let srv: TestServer;
let mock: MockUpstream;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  mock = await startMockUpstream();
  srv = await startServer({ seed: SEED });

  const put = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: "sk-e2e-key", model: "gpt-5", effort: "high" },
    git: { autoSyncSeconds: 600 },
  });
  expect(`PUT /api/settings → ${put.status}`).toBe("PUT /api/settings → 200");
  await sleep(300);
  mock.reset();

  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });

  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });

  /* the chat panel is open by default; make sure of it before typing into it */
  const open = await page.evaluate(() => document.getElementById("app")!.classList.contains("chat-open"));
  if (!open) {
    await page.click('#chatBtn, [data-act="toggle-chat"]');
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 5000,
    });
  }

  await page.click(`#tree .row.file[data-doc="${DOC}"]`);
  await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 8000 }, DOC);
  await sleep(300);
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (mock) await mock.stop();
});

/* ---------------- helpers ---------------- */

/* the shared toggle, driven by the statusbar CHIP rather than ⌘E: this file's
   point is the chat panel, and a keyboard chord that lands on a chat control is
   noise, not signal — doubly so now that ⌘C is one of them. */
const ensureMode = (want: "raw" | "preview") => setMode(page, want, { via: "chip" });

async function send(text: string) {
  await page.focus("#composer");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const lastAiText = () =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll("#msgs .msg.ai .bubble")];
    return nodes.length ? (nodes[nodes.length - 1].textContent ?? "") : "";
  });

const bubbleTexts = () =>
  page.evaluate(() => [...document.querySelectorAll("#msgs .bubble")].map((n) => n.textContent ?? ""));

const cardCount = () => page.evaluate(() => document.querySelectorAll(".diffcard").length);

const stackCount = () => page.evaluate(() => document.getElementById("stackCnt")!.textContent ?? "");

const docText = () => page.evaluate(() => document.getElementById("doc")!.textContent ?? "");

/** wait until the assistant's last bubble contains `marker`, sampling its length on the way */
async function awaitAnswer(marker: string, samples: number[], timeout = 25000) {
  await waitUntil(
    async () => {
      const t = await lastAiText();
      if (t) samples.push(t.length);
      return t.includes(marker);
    },
    { timeout, interval: 40, label: `the assistant's answer to contain ${marker}` }
  );
}

/* ============================================================
   1 — progressive rendering
   ============================================================ */

describe("ai e2e — the answer streams into the bubble", () => {
  const FULL =
    "Streaming now. " +
    "The assistant answers a chunk at a time so the reader watches it arrive. ".repeat(3) +
    "ENDOFANSWER";

  test("partial text is visible in the DOM before the turn is done", async () => {
    mock.reset();
    mock.script(reply.text(FULL, { chunkSize: 14, dripMs: 70 }));

    await send("stream me a long answer");

    const samples: number[] = [];
    await awaitAnswer("ENDOFANSWER", samples);

    const partials = samples.filter((n) => n > 0 && n < FULL.length);
    expect(
      `saw a partially-rendered answer (${samples.length} samples, lengths ${Math.min(...samples)}–${Math.max(
        ...samples
      )} of ${FULL.length}): ${partials.length > 0}`
    ).toBe(
      `saw a partially-rendered answer (${samples.length} samples, lengths ${Math.min(...samples)}–${Math.max(
        ...samples
      )} of ${FULL.length}): true`
    );

    expect(await lastAiText()).toBe(FULL);
    /* the user's own turn is in the thread too, above it */
    const bubbles = await bubbleTexts();
    expect(bubbles[bubbles.length - 2]).toContain("stream me a long answer");
  }, 60000);

  test("a plain answer renders NO diff card", async () => {
    expect(`diff cards after a plain answer: ${await cardCount()}`).toBe("diff cards after a plain answer: 0");
    expect(await page.evaluate(() => document.getElementById("stack")!.hidden)).toBe(true);
  }, 20000);
});

/* ============================================================
   2 — a tool-call turn, Accept, and the stack
   ============================================================ */

describe("ai e2e — proposals, accept, LIFO in the UI", () => {
  let afterFirst = "";

  test("a propose_edits turn renders a diff card with red and green rows", async () => {
    mock.reset();
    mock.script(
      proposeEdits("Shout at ANCHORONE", {
        op: "replace",
        path: DOC,
        find: "ANCHORONE line waiting for an edit",
        replace: "ANCHORONE LINE WAS EDITED",
        note: "louder",
      })
    );

    await send("edit the first anchor please");
    await page.waitForSelector(".diffcard", { timeout: 25000 });

    const card = await page.evaluate(() => {
      const c = document.querySelector(".diffcard")!;
      return {
        target: c.querySelector(".diff-head .f")?.textContent ?? "",
        added: c.querySelectorAll(".dl.add").length,
        removed: c.querySelectorAll(".dl.del").length,
        addedText: [...c.querySelectorAll(".dl.add .t")].map((n) => n.textContent ?? "").join("\n"),
        removedText: [...c.querySelectorAll(".dl.del .t")].map((n) => n.textContent ?? "").join("\n"),
        accept: !!c.querySelector(".diff-foot .btn.primary"),
      };
    });

    expect(card.target).toBe(DOC);
    expect(`green rows: ${card.added > 0}`).toBe("green rows: true");
    expect(`red rows: ${card.removed > 0}`).toBe("red rows: true");
    expect(card.addedText).toContain("ANCHORONE LINE WAS EDITED");
    expect(card.removedText).toContain("ANCHORONE line waiting for an edit");
    expect(card.accept).toBe(true);

    /* nothing is written before the click */
    expect(readVaultText(srv.vault, DOC)).toBe(DOC_MD);
  }, 60000);

  test("Accept writes the doc, updates BOTH modes and stamps the stack chip", async () => {
    await page.click(".diffcard .diff-foot .btn.primary");

    await page.waitForFunction(
      () => (document.querySelector(".diffcard .applied-note")?.textContent ?? "").includes("Applied #1"),
      { timeout: 15000 }
    );

    afterFirst = await waitUntil(
      () => {
        const t = readVaultText(srv.vault, DOC);
        return t.includes("ANCHORONE LINE WAS EDITED") ? t : null;
      },
      { timeout: 8000, label: "the accepted edit to reach disk" }
    );
    expect(afterFirst).toBe(DOC_MD.replace("ANCHORONE line waiting for an edit", "ANCHORONE LINE WAS EDITED"));

    expect(`stack count: ${await stackCount()}`).toBe("stack count: 1");
    expect(await page.evaluate(() => document.getElementById("stack")!.hidden)).toBe(false);

    /* preview shows it… */
    await ensureMode("preview");
    await page.waitForFunction(() => (document.getElementById("doc")!.textContent ?? "").includes("ANCHORONE LINE WAS EDITED"), {
      timeout: 8000,
    });
    expect(await docText()).toContain("ANCHORONE LINE WAS EDITED");
    expect(await docText()).not.toContain("ANCHORONE line waiting for an edit");

    /* …and Raw is byte-identical to what is on disk */
    await ensureMode("raw");
    const raw = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
    expect(raw).toBe(afterFirst);
    await ensureMode("preview");
  }, 60000);

  test("a second accepted proposal disables the older card's Revert and says which to revert first", async () => {
    mock.reset();
    mock.script(
      proposeEdits("Shout at ANCHORTWO", {
        op: "replace",
        path: DOC,
        find: "ANCHORTWO line waiting for an edit",
        replace: "ANCHORTWO LINE WAS EDITED",
      })
    );

    await send("now edit the second anchor");
    await page.waitForFunction(() => document.querySelectorAll(".diffcard").length === 2, { timeout: 25000 });

    await page.evaluate(() => {
      const cards = document.querySelectorAll<HTMLElement>(".diffcard");
      (cards[cards.length - 1].querySelector(".diff-foot .btn.primary") as HTMLButtonElement).click();
    });

    await page.waitForFunction(() => document.getElementById("stackCnt")!.textContent === "2", { timeout: 15000 });

    const state = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".diffcard")];
      const foot = (c: Element) => c.querySelector(".diff-foot")!;
      const btn = (c: Element) => foot(c).querySelector<HTMLButtonElement>("button:not(.primary)");
      return {
        olderApplied: (foot(cards[0]).textContent ?? "").includes("Applied #1"),
        newerApplied: (foot(cards[1]).textContent ?? "").includes("Applied #2"),
        olderRevertDisabled: !!btn(cards[0])?.disabled,
        newerRevertDisabled: !!btn(cards[1])?.disabled,
        olderHint: foot(cards[0]).querySelector(".stack-hint")?.textContent ?? "",
        stackRows: [...document.querySelectorAll("#stackList .stack-row")].map((r) => ({
          text: r.textContent ?? "",
          top: r.classList.contains("top"),
          disabled: !!r.querySelector("button")?.disabled,
        })),
      };
    });

    expect(state.olderApplied).toBe(true);
    expect(state.newerApplied).toBe(true);
    expect(`older card's Revert disabled: ${state.olderRevertDisabled}`).toBe("older card's Revert disabled: true");
    expect(`newer card's Revert enabled: ${!state.newerRevertDisabled}`).toBe("newer card's Revert enabled: true");
    expect(state.olderHint).toContain("revert #2 first");

    /* the stack list agrees: newest on top, only it is revertable */
    expect(state.stackRows.length).toBe(2);
    expect(state.stackRows[0].top).toBe(true);
    expect(state.stackRows[0].disabled).toBe(false);
    expect(state.stackRows[1].disabled).toBe(true);
  }, 60000);

  test("Reverting the top restores the previous content exactly", async () => {
    await page.evaluate(() => {
      const row = document.querySelector("#stackList .stack-row.top")!;
      (row.querySelector("button") as HTMLButtonElement).click();
    });

    await page.waitForFunction(() => document.getElementById("stackCnt")!.textContent === "1", { timeout: 15000 });

    const restored = await waitUntil(
      () => {
        const t = readVaultText(srv.vault, DOC);
        return t.includes("ANCHORTWO line waiting for an edit") ? t : null;
      },
      { timeout: 8000, label: "the revert to reach disk" }
    );
    expect(restored).toBe(afterFirst);

    await ensureMode("raw");
    const raw = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
    expect(raw).toBe(afterFirst);
    await ensureMode("preview");
  }, 60000);

  test("a new session drops the thread, keeps the stack", async () => {
    const before = await stackCount();
    await page.click('.chat-sub [data-act="new-session"]');

    await page.waitForFunction(() => !!document.querySelector("#msgs .ctx-div"), { timeout: 10000 });

    const after = await page.evaluate(() => ({
      dividers: document.querySelectorAll("#msgs .ctx-div").length,
      userBubbles: document.querySelectorAll("#msgs .msg.user").length,
      stackCnt: document.getElementById("stackCnt")!.textContent ?? "",
      stackHidden: document.getElementById("stack")!.hidden,
      rows: document.querySelectorAll("#stackList .stack-row").length,
    }));

    expect(`dividers: ${after.dividers >= 1}`).toBe("dividers: true");
    expect(`the thread was cleared: ${after.userBubbles === 0}`).toBe("the thread was cleared: true");
    expect(`stack survived: ${after.stackCnt}`).toBe(`stack survived: ${before}`);
    expect(after.stackHidden).toBe(false);
    expect(after.rows).toBe(Number(before));
  }, 40000);
});

/* ============================================================
   3 — abort: a new turn cancels the one in flight
   ============================================================ */

describe("ai e2e — starting a second turn aborts the first", () => {
  test("no interleaved bubbles, and the upstream stream really was cancelled", async () => {
    mock.reset();
    const SLOW =
      "FIRSTREPLYSTART " + "this first reply is deliberately slow so it is still arriving. ".repeat(4) + "ENDOFFIRST";
    const FAST = "SECONDREPLYSTART and it finishes immediately. SECONDDONE";
    mock.script(reply.text(SLOW, { chunkSize: 8, dripMs: 110 }), reply.text(FAST, { chunkSize: 200 }));

    const mark = mock.mark();
    await send("first question");
    /* let it actually start streaming, then interrupt it */
    await sleep(350);
    await send("second question");

    const samples: number[] = [];
    await awaitAnswer("SECONDDONE", samples);
    await sleep(600); // any stray deltas from the aborted turn would land here

    const streamed = mock.streamed(mark);
    expect(`upstream turns: ${streamed.length >= 2}`).toBe("upstream turns: true");
    expect(`the first upstream stream was cancelled: ${streamed[0].cancelled}`).toBe(
      "the first upstream stream was cancelled: true"
    );
    expect(`the first stream ran to completion anyway: ${streamed[0].finished}`).toBe(
      "the first stream ran to completion anyway: false"
    );

    const bubbles = await bubbleTexts();
    const dom = bubbles.join("\n");
    expect(`the aborted reply finished in the DOM: ${dom.includes("ENDOFFIRST")}`).toBe(
      "the aborted reply finished in the DOM: false"
    );
    expect(`the second reply is present: ${dom.includes("SECONDDONE")}`).toBe("the second reply is present: true");
    expect(`the second reply is rendered once: ${dom.split("SECONDDONE").length - 1}`).toBe(
      "the second reply is rendered once: 1"
    );
    /* nothing merged the two answers into one bubble */
    for (const b of bubbles) {
      expect(`a bubble mixes both replies: ${b.includes("SECONDREPLYSTART") && b.includes("FIRSTREPLYSTART")}`).toBe(
        "a bubble mixes both replies: false"
      );
    }
  }, 90000);
});

/* ============================================================
   6 — the statusbar's AI item

   The point of the item is that it is TRUTHFUL, so the gate is a state
   TRANSITION driven by real signal, not the presence of a green dot: point the
   relay at a dead port and the item must say unreachable while the rest of the
   app keeps working; point it back and it must recover. Nothing here polls —
   every repaint comes from the `ai-status` push on /events.
   ============================================================ */

describe("ai e2e — the endpoint status item in the statusbar", () => {
  const aiChip = () =>
    page.evaluate(() => {
      const e = document.getElementById("stAi")!;
      return {
        txt: document.getElementById("stAiTxt")!.textContent ?? "",
        cls: e.className,
        title: e.title,
        visible: !!(e.offsetWidth || e.offsetHeight),
      };
    });

  const chipState = async () => {
    const c = await aiChip();
    return ["ok", "degraded", "unreachable", "unconfigured", "pending"].find((s) => c.cls.split(/\s+/).includes(s)) ?? "?";
  };

  test("it reads the model and the effort actually in use, with an ok dot", async () => {
    await waitUntil(async () => (await chipState()) === "ok", {
      timeout: 20000,
      interval: 150,
      label: "the AI chip to reach ok",
    });
    const c = await aiChip();
    expect(`chip text: ${c.txt}`).toBe("chip text: gpt-5 · high");
    expect(`chip visible at 1440: ${c.visible}`).toBe("chip visible at 1440: true");
    /* the tooltip is the same sentence the server derived — never invented here */
    expect(`tooltip names the state: ${/reachable/i.test(c.title)}`).toBe("tooltip names the state: true");
  }, 40000);

  test("a dead endpoint turns it unreachable without breaking the app, and it recovers", async () => {
    const good = mock.baseUrl;
    const before = await docText();

    const put = await srv.api("PUT", "/api/settings", { ai: { baseUrl: "http://127.0.0.1:9/v1" } });
    expect(`PUT → ${put.status}`).toBe("PUT → 200");

    await waitUntil(async () => (await chipState()) === "unreachable", {
      timeout: 25000,
      interval: 200,
      label: "the AI chip to go unreachable",
    });
    const down = await aiChip();
    expect(`still shows which model: ${down.txt}`).toBe("still shows which model: gpt-5 · high");

    /* the REST of the app is untouched: the tree still navigates and the doc
       still renders. A broken AI endpoint is not a broken notes app. */
    await page.click(`#tree .row.file[data-doc="inbox.md"]`);
    await page.waitForFunction(() => document.getElementById("stPath")!.textContent === "inbox.md", { timeout: 8000 });
    await page.click(`#tree .row.file[data-doc="${DOC}"]`);
    await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 8000 }, DOC);
    expect(`the doc still renders: ${(await docText()) === before}`).toBe("the doc still renders: true");

    const back = await srv.api("PUT", "/api/settings", { ai: { baseUrl: good } });
    expect(`PUT back → ${back.status}`).toBe("PUT back → 200");
    await waitUntil(async () => (await chipState()) === "ok", {
      timeout: 25000,
      interval: 200,
      label: "the AI chip to recover",
    });
  }, 90000);

  test("clicking it re-probes and routes to Settings at the AI section", async () => {
    const mark = mock.mark();
    await page.click("#stAi");
    /* Settings is a page now: the chip NAVIGATES to /settings/ai */
    await waitSettings(page, true);
    expect(`the chip routed to: ${await page.evaluate(() => location.pathname)}`).toBe(
      "the chip routed to: /settings/ai"
    );
    /* a REAL check, not a repaint: the click must have hit the endpoint */
    await waitUntil(async () => mock.probes(mark).length > 0, {
      timeout: 15000,
      interval: 150,
      label: "an on-demand probe upstream",
    });
    /* the scroll is smooth, so it settles a frame or several after the click */
    const inView = () =>
      page.evaluate(() => {
        const g = document.getElementById("settingsGrp-ai")!;
        const body = document.getElementById("settingsBody")!;
        const gr = g.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        return gr.top >= br.top - 6 && gr.top < br.bottom;
      });
    await waitUntil(inView, { timeout: 8000, interval: 120, label: "the AI section to scroll into view" });
    expect(`the AI section is scrolled into view: ${await inView()}`).toBe("the AI section is scrolled into view: true");
    /* the panel says the same thing the chip's tooltip does */
    const note = await page.evaluate(() => document.getElementById("aiEndpointNote")!.textContent ?? "");
    expect(`the endpoint note is populated: ${note.length > 0}`).toBe("the endpoint note is populated: true");
    await page.evaluate(() => history.back());
    /* the transient busy animation must clear */
    await waitUntil(
      async () => page.evaluate(() => !document.getElementById("stAi")!.classList.contains("busy")),
      { timeout: 20000, interval: 200, label: "the busy flag to clear" }
    );
  }, 60000);

  test("it collapses to the dot alone before it disappears, and never amputates the bar", async () => {
    /* REGRESSION. `#stAiTxt` was `white-space: nowrap` with no cap and only an
       all-or-nothing collapse at ≤1349px, and `#stPath` was the only item in
       the bar with any shrink budget. So between the tiers the bar OVERFLOWED —
       and `.statusbar` is `overflow: hidden`, so there is no scroll and no
       ellipsis: #stSync and #stConn, both required by SPEC §9, were simply
       gone. A realistic proxy model id did it at the app's own default 1440.
       Measured here on the geometry, not on the class list. */
    const measure = () =>
      page.evaluate(() => {
        const e = document.getElementById("stAi")!;
        const bar = document.querySelector(".statusbar")! as HTMLElement;
        const right = bar.getBoundingClientRect().right;
        const dot = e.querySelector(".dot")!.getBoundingClientRect();
        return {
          visible: !!(e.offsetWidth || e.offsetHeight),
          width: Math.round(e.getBoundingClientRect().width),
          textShown: getComputedStyle(document.getElementById("stAiTxt")!).display !== "none",
          overflows: bar.scrollWidth > bar.clientWidth + 1,
          /* the two items the overflow used to eat, measured against the bar's
             own right edge rather than against scrollWidth */
          connClipped: document.getElementById("stConn")!.getBoundingClientRect().right > right + 1,
          syncClipped: document.getElementById("stSync")!.getBoundingClientRect().right > right + 1,
          dotVisible: dot.width > 0 && dot.right <= right + 1,
        };
      });

    const sweep = async (label: string) => {
      const at: Record<number, any> = {};
      /* FIXTURE WIDTHS, and why they moved. The shed ladder is a CONTAINER
         query on the bar now, not a viewport query: this bar lives inside the
         document pane, so its width is the window minus the sidebar minus the
         chat column, and the old thresholds described a number the bar never
         had. 1700px used to show `#stAiTxt` and no longer does — at 1700 the
         bar is ~1094px, and the full complement needs 1219px in the widest
         theme. 1920 (bar ~1314) is the width that still shows it, and 1800
         (bar ~1194) is the one just under the rung, so the transition is still
         BRACKETED rather than assumed. 820 and 900 are new: those are exactly
         the widths the old ladder amputated the bar at (measured: 172px of bar
         holding 222px of content, with #stConn clipped off the end). */
      for (const w of [1920, 1800, 1600, 1500, 1440, 1400, 1366, 1350, 1200, 1000, 900, 820, 760, 420]) {
        await page.setViewport({ width: w, height: 900 });
        await sleep(260);
        at[w] = await measure();
        expect(`${label} ${w}px overflows the statusbar: ${at[w].overflows}`).toBe(
          `${label} ${w}px overflows the statusbar: false`
        );
        expect(`${label} ${w}px keeps the SSE dot on the bar: ${!at[w].connClipped}`).toBe(
          `${label} ${w}px keeps the SSE dot on the bar: true`
        );
        expect(`${label} ${w}px keeps the sync state on the bar: ${!at[w].syncClipped}`).toBe(
          `${label} ${w}px keeps the sync state on the bar: true`
        );
      }
      return at;
    };

    try {
      /* `ai.model` is free text — "Model id, as the endpoint names it" — so a
         proxy/OpenRouter style id is an ordinary configuration, not an edge.
         Swept FIRST because it is the case that used to amputate the bar. */
      const long = await srv.api("PUT", "/api/settings", {
        ai: { model: "anthropic/claude-opus-4-1-20250805-thinking" },
      });
      expect(`the long model id → ${long.status}`).toBe("the long model id → 200");
      await sleep(400);
      await sweep("long model id");

      await srv.api("PUT", "/api/settings", { ai: { model: "gpt-5" } });
      await sleep(400);
      const at = await sweep("default model");
      expect(`1920: text shown: ${at[1920].textShown}`).toBe("1920: text shown: true");
      /* it sheds its label on the same ladder every other statusbar item uses,
         so it can never spend the doc path's shrink budget instead of its own */
      expect(`1440: dot only: ${at[1440].visible && !at[1440].textShown}`).toBe("1440: dot only: true");
      expect(`1440 is narrower than 1920: ${at[1440].width < at[1920].width}`).toBe(
        "1440 is narrower than 1920: true"
      );
      /* the dot is the part that must survive: a silently-unreachable endpoint
         is exactly what the statusbar exists to say */
      for (const w of [1440, 1366, 1350, 1200, 1000]) {
        expect(`${w}px still paints the AI dot: ${at[w].dotVisible}`).toBe(`${w}px still paints the AI dot: true`);
      }
      /* below the hide-sm breakpoint it goes, with its neighbours */
      expect(`420: hidden: ${at[420].visible}`).toBe("420: hidden: false");
    } finally {
      await srv.api("PUT", "/api/settings", { ai: { model: "gpt-5" } });
      await page.setViewport({ width: 1440, height: 900 });
      await sleep(220);
    }
  }, 90000);

  test("a doc path the bar had to ellipsise is still readable on hover", async () => {
    /* `#stPath` is written as textContent only, so a truncated path could not be
       recovered at all — no title, no scroll */
    const t = await page.evaluate(() => {
      const p = document.getElementById("stPath")!;
      return { txt: p.textContent ?? "", title: p.title };
    });
    expect(`the title carries the whole path: ${t.title === t.txt && t.title.length > 0}`).toBe(
      "the title carries the whole path: true"
    );
  }, 30000);
});
