/* ============================================================
   sse-watchdog-e2e.test.ts — the connection chip tells the truth, and the
   watchdog keeps trying (SPEC §9).

   `EventSource.readyState` is not liveness. A NAT rebind stops the flow
   without closing it: measured, `readyState` stayed 1 for 75s with `onerror`
   never firing while the pane showed a document superseded 75s earlier. The
   heartbeat clock answers that — and then lost its own answer twice over:

     1. A RECONNECT CAN GO INTO THE SAME HOLE. The new EventSource sits at
        readyState 0 forever; `onerror` never fires, so it never CLOSES, so the
        close-driven backoff never arms. Measured against a TCP proxy
        reproducing a rebind: exactly ONE `GET /events` was ever issued and the
        chip read "reconnecting…" over a stale document for minutes — including
        after the network had been completely healed. Chrome makes it
        near-certain by reusing a pooled keep-alive socket, which the rebind
        killed too.
     2. "NO SIGNAL" WAS NEVER RENDERED. `paintConn()` and `connect()` ran in one
        task, so the word SPEC §9 promises an open-but-silent stream was written
        and replaced before a frame could carry it.

   THE FIXTURE, and why it is not a proxy: the black hole is installed at the
   `EventSource` constructor, which is the exact boundary the app's recovery is
   written against — a stream that never opens and never errors. The page's
   clock is scaled so the 50s threshold and the 1→2→4→15s backoff are reached in
   real seconds; every interval the app uses is measured against `Date.now()`,
   so scaling it moves all of them together and changes none of the logic.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import { SEED_VAULT, sleep, startServer, waitUntil, type TestServer } from "./helpers";
import { launchTestBrowser, waitForApp } from "./browser";

let srv: TestServer;
let browser: Browser;

beforeAll(async () => {
  srv = await startServer({ seed: SEED_VAULT });
  browser = await launchTestBrowser();
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/** the clock scale — one real second is SPEED app-seconds */
const SPEED = 20;

/**
 * `openFirst`: the first stream connects and then goes SILENT (case 2 — an
 * open handle with nothing coming down it). Every later stream is a black hole
 * that never opens and never errors (case 1 — the stuck reconnect).
 */
function blackHole(openFirst: boolean, speed: number) {
  const real = Date.now.bind(Date);
  const t0 = real();
  Date.now = () => t0 + (real() - t0) * speed;

  const w = window as any;
  w.__es = [];
  w.__chip = [];
  w.EventSource = function (this: any, url: string) {
    const n = w.__es.length;
    w.__es.push({ url: String(url), at: real() });
    this.readyState = 0;
    this.addEventListener = () => {};
    this.close = () => {
      this.readyState = 2;
    };
    /* the FIRST stream may open and then say nothing at all — no heartbeat, no
       hello, no error. That is the "open but silent" state. */
    if (n === 0 && openFirst) {
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
      }, 30);
    }
  };

  /* every word the chip has worn, in order. A repaint that is replaced inside
     the same task produces no MutationRecord of its own, so this records what a
     frame could actually have shown — which is the whole point of case 2. */
  document.addEventListener("DOMContentLoaded", () => {
    const txt = document.getElementById("stConnTxt");
    if (!txt) return;
    const push = () => {
      const s = (txt.textContent ?? "").trim();
      if (w.__chip[w.__chip.length - 1] !== s) w.__chip.push(s);
    };
    push();
    new MutationObserver(push).observe(txt, { childList: true, characterData: true, subtree: true });
  });
}

async function blackHolePage(openFirst: boolean): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[browser console]", m.text());
  });
  await page.evaluateOnNewDocument(blackHole, openFirst, SPEED);
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page, 25000);
  return page;
}

const attempts = (page: Page) => page.evaluate(() => (window as any).__es.length as number);
const chipWords = (page: Page) => page.evaluate(() => (window as any).__chip as string[]);
const esLog = (page: Page) => page.evaluate(() => (window as any).__es as Array<{ url: string; at: number }>);

describe("the SSE watchdog", () => {
  test("a reconnect that goes into the same hole is retried, on the backoff, instead of being the last one", async () => {
    const page = await blackHolePage(false);
    try {
      /* the boot connect is attempt #1, and it never opens and never errors:
         the handle stays `connecting` forever, which is precisely the state
         both re-arm paths used to refuse. */
      await sleep(500);
      expect(`the boot made one attempt: ${await attempts(page)}`).toBe("the boot made one attempt: 1");

      await waitUntil(async () => (await attempts(page)) >= 4, {
        timeout: 60000,
        interval: 250,
        label: "the watchdog to keep retrying a stuck reconnect",
      });
      const es = await esLog(page);
      expect(`every retry went to /events: ${es.every((e) => e.url.includes("events"))}`).toBe(
        "every retry went to /events: true"
      );

      /* …and it BACKS OFF rather than storming a dead network. Real
         milliseconds scaled back into the app-seconds the backoff is written
         in; the walk is 1→2→4→15s, so each gap is at least the last. */
      const gaps = es.slice(1).map((e, i) => Math.round(((e.at - es[i].at) * SPEED) / 1000));
      expect(
        `retry gaps in app-seconds ${JSON.stringify(gaps)} — never shrinking: ${gaps.every(
          (g, i) => i === 0 || g >= gaps[i - 1] - 1
        )}`
      ).toBe(`retry gaps in app-seconds ${JSON.stringify(gaps)} — never shrinking: true`);
      expect(`…and never a 5s watchdog storm: ${JSON.stringify(gaps)} all >= 2`).toBe(
        `…and never a 5s watchdog storm: ${JSON.stringify(gaps.map((g) => (g >= 2 ? g : "TOO-SOON:" + g)))} all >= 2`
      );

      /* the chip never claimed to be connected over any of it */
      const words = await chipWords(page);
      expect(`the chip wore ${JSON.stringify(words)} — said connected: ${words.includes("connected")}`).toBe(
        `the chip wore ${JSON.stringify(words)} — said connected: false`
      );
    } finally {
      await page.close().catch(() => {});
    }
  }, 150000);

  test("an OPEN stream that goes silent wears the word SPEC §9 gives it, and then reconnects", async () => {
    const page = await blackHolePage(true);
    try {
      await page.waitForFunction(() => (document.getElementById("stConnTxt")!.textContent ?? "") === "connected", {
        timeout: 15000,
      });
      /* nothing else ever arrives on this stream */
      await waitUntil(async () => (await attempts(page)) >= 2, {
        timeout: 60000,
        interval: 250,
        label: "the silent stream to be reconnected",
      });

      const words = await chipWords(page);
      /* THE MIDDLE STATE IS REAL. It used to be written and replaced inside the
         same task — "connected → reconnecting…" with nothing between them — so
         a stream that was open but saying nothing had no word of its own. */
      expect(`the chip wore ${JSON.stringify(words)} — "no signal" rendered: ${words.includes("no signal")}`).toBe(
        `the chip wore ${JSON.stringify(words)} — "no signal" rendered: true`
      );
      expect(
        `…and it came BEFORE the reconnect: ${words.indexOf("no signal") < words.lastIndexOf("reconnecting…")}`
      ).toBe("…and it came BEFORE the reconnect: true");
      expect(
        `…with the dot down: ${await page.evaluate(() => document.getElementById("stConn")!.classList.contains("down"))}`
      ).toBe("…with the dot down: true");
    } finally {
      await page.close().catch(() => {});
    }
  }, 150000);
});
