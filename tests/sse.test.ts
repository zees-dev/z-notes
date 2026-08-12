/* ============================================================
   /events — SSE gate

   The conventions being measured:
     - idleTimeout: 0 on Bun.serve (otherwise the stream dies at 10 s)
     - first bytes carry `retry: 1000`
     - a `hello` event with clientId + serverTime on connect
     - a `heartbeat` every 20 s
     - `doc-changed` per the HTTP contract: {path, rev, reason, bytes, mtime}
     - Cache-Control: no-store

   NOTE: this file contains the suite's one deliberately slow test (~21 s): the
   heartbeat/idle-survival check cannot be faked with a shorter wait, because
   the whole point is that nothing crosses the wire for longer than Bun's
   default 10 s idle timeout.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, sleep, type TestServer } from "./helpers";

const SEED = {
  "notes/live.md": "# Live\n\nwatch me change\n",
  "notes/other.md": "# Other\n\nsomething else\n",
};

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
}, 30000);

afterAll(async () => {
  if (srv) await srv.stop();
});

describe("/events", () => {
  test("response headers are a real event stream that must not be cached", async () => {
    const sse = await srv.sse();
    try {
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);
      expect((sse.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
    } finally {
      sse.close();
    }
  }, 15000);

  test("the first bytes on the wire include `retry: 1000`", async () => {
    const sse = await srv.sse();
    try {
      expect(sse.firstChunk.length).toBeGreaterThan(0);
      expect(sse.firstChunk).toContain("retry: 1000");
    } finally {
      sse.close();
    }
  }, 15000);

  test("hello carries a clientId and a serverTime, and each connection gets its own clientId", async () => {
    const a = await srv.sse();
    const b = await srv.sse();
    try {
      const ha = await a.waitFor("hello", { timeout: 5000 });
      const hb = await b.waitFor("hello", { timeout: 5000 });

      for (const h of [ha, hb]) {
        expect(typeof h.data.clientId).toBe("string");
        expect(h.data.clientId.length).toBeGreaterThan(0);
        expect(typeof h.data.serverTime).toBe("string");
        expect(Number.isFinite(Date.parse(h.data.serverTime))).toBe(true);
        /* the clock the server reports must be roughly now */
        expect(Math.abs(Date.parse(h.data.serverTime) - Date.now())).toBeLessThan(60000);
      }
      expect(ha.data.clientId).not.toBe(hb.data.clientId);
    } finally {
      a.close();
      b.close();
    }
  }, 15000);

  /**
   * The stream keeps no backlog and never replays `Last-Event-ID`, so a client
   * that was disconnected while the vault changed has no way to learn it —
   * unless `hello` carries something it can compare. Without this the dot goes
   * green over stale content and the next save 409s out of nowhere.
   */
  test("hello carries a vault epoch that moves when the vault changes and holds still when it does not", async () => {
    const first = await srv.sse();
    let epoch0: number;
    try {
      const hello = await first.waitFor("hello", { timeout: 5000 });
      expect(typeof hello.data.epoch).toBe("number");
      epoch0 = hello.data.epoch;
    } finally {
      first.close();
    }

    /* a reconnect with nothing in between must NOT look like a missed event */
    const quiet = await srv.sse();
    try {
      const hello = await quiet.waitFor("hello", { timeout: 5000 });
      expect(hello.data.epoch).toBe(epoch0);
    } finally {
      quiet.close();
    }

    /* the vault changes while no client is listening */
    const path = "notes/other.md";
    const cur = await srv.doc(path);
    const put = await srv.putDoc(path, cur.body.markdown + "\nchanged offline\n", cur.body.rev);
    expect(put.status).toBe(200);

    const back = await srv.sse();
    try {
      const hello = await back.waitFor("hello", { timeout: 5000 });
      expect(hello.data.epoch).not.toBe(epoch0);
    } finally {
      back.close();
    }
  }, 20000);

  test("doc-changed on PUT carries {path, rev, reason:'write', bytes, mtime} and reaches every client", async () => {
    const a = await srv.sse();
    const b = await srv.sse();
    try {
      await a.waitFor("hello", { timeout: 5000 });
      await b.waitFor("hello", { timeout: 5000 });
      const markA = a.mark();
      const markB = b.mark();

      const path = "notes/live.md";
      const before = await srv.doc(path);
      expect(before.status).toBe(200);
      const next = "# Live\n\nchanged by the API at " + Date.now() + "\n";

      const put = await srv.putDoc(path, next, before.body.rev);
      expect(put.status).toBe(200);

      const evA = await a.waitFor("doc-changed", {
        from: markA,
        match: (d) => d && d.path === path,
        timeout: 5000,
      });
      const evB = await b.waitFor("doc-changed", {
        from: markB,
        match: (d) => d && d.path === path,
        timeout: 5000,
      });

      for (const ev of [evA, evB]) {
        const d = ev.data;
        /* the five documented fields (the event contract) … */
        expect(Object.keys(d).sort()).toEqual(
          expect.arrayContaining(["bytes", "mtime", "path", "reason", "rev"])
        );
        /* … and nothing else, so the payload stays the contract */
        expect(Object.keys(d).sort()).toEqual(["bytes", "mtime", "path", "reason", "rev"]);
        expect(d.path).toBe(path);
        expect(d.reason).toBe("write");
        expect(d.rev).toBe(put.body.rev);
        expect(d.bytes).toBe(Buffer.byteLength(next, "utf8"));
        expect(Number.isFinite(Date.parse(d.mtime))).toBe(true);
      }
      /* the writer sees its own echo — that is what lets the client compare revs */
      expect(evA.data.rev).toBe(evB.data.rev);
    } finally {
      a.close();
      b.close();
    }
  }, 20000);

  test(
    "a heartbeat arrives within 25 s and the stream is still alive afterwards (Bun idleTimeout trap)",
    async () => {
      const sse = await srv.sse();
      try {
        await sse.waitFor("hello", { timeout: 5000 });
        const mark = sse.mark();
        const t0 = Date.now();

        /* nothing crosses the wire from here: with Bun's default idleTimeout the
           connection would already be dead at 10 s */
        const hb = await sse.waitFor("heartbeat", { from: mark, timeout: 25000 });
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeGreaterThan(12000); // proves we really sat idle past 12 s
        expect(elapsed).toBeLessThan(25000);
        expect(sse.closed).toBe(false);
        expect(hb.data == null || typeof hb.data === "object").toBe(true);

        /* and the same socket still delivers real events after the idle stretch */
        const mark2 = sse.mark();
        const path = "notes/other.md";
        const cur = await srv.doc(path);
        const next = "# Other\n\nstill connected at " + Date.now() + "\n";
        const put = await srv.putDoc(path, next, cur.body.rev);
        expect(put.status).toBe(200);

        const ev = await sse.waitFor("doc-changed", {
          from: mark2,
          match: (d) => d && d.path === path,
          timeout: 5000,
        });
        expect(ev.data.rev).toBe(put.body.rev);
      } finally {
        sse.close();
      }
    },
    45000
  );

  /**
   * SETTINGS ARE VAULT STATE AND THEY TRAVEL.
   *
   * `GET /api/settings` is read at boot and after a terminal-password write,
   * and nowhere else — so before this event a second client went on painting
   * AND ENFORCING a theme, home doc, autosave interval and auto-lock policy
   * that had been changed hours earlier somewhere else, with nothing saying it
   * was stale. Two properties are pinned here, and the second one is the one
   * that keeps this stream safe to have at all:
   *
   *   · it reaches a client that did not issue the PUT, and
   *   · it is the SAME masked body `GET` serves. The git token, the AI key and
   *     the terminal password live in sqlite only; a frame carrying any of them
   *     would put a credential on a stream that is deliberately not behind the
   *     terminal password.
   */
  test("settings-changed reaches every client, carrying the masked GET body and no credential", async () => {
    const TOKEN = "ghp_" + "z".repeat(36);
    const KEY = "sk-" + "y".repeat(40);
    const sse = await srv.sse();
    try {
      await sse.waitFor("hello", { timeout: 5000 });
      const mark = sse.mark();

      const put = await srv.api("PUT", "/api/settings", {
        density: "compact",
        editor: { autosaveSeconds: 12 },
        git: { token: TOKEN },
        ai: { apiKey: KEY },
      });
      expect(put.status).toBe(200);

      const ev = await sse.waitFor("settings-changed", { from: mark, timeout: 5000 });
      expect(ev.data.settings.density).toBe("compact");
      expect(ev.data.settings.editor.autosaveSeconds).toBe(12);

      /* byte-for-byte what GET serves, so a client can adopt it without a
         second round trip and without a second shape to reason about */
      const got = await srv.get("/api/settings");
      expect(JSON.stringify(ev.data.settings)).toBe(JSON.stringify(got.body.settings));

      /* THE LEAK GATE for this event */
      const wire = JSON.stringify(ev.data);
      expect(`the frame carries the raw token: ${wire.includes(TOKEN)}`).toBe("the frame carries the raw token: false");
      expect(`the frame carries the raw AI key: ${wire.includes(KEY)}`).toBe("the frame carries the raw AI key: false");
      expect(typeof ev.data.settings.git.tokenMasked).toBe("string");
      expect(typeof ev.data.settings.ai.apiKeyMasked).toBe("string");

      /* …and it does NOT move the vault epoch: the epoch is a docs revision,
         and a settings save that bumped it would make every client re-read the
         tree and the open doc for nothing. This is exactly why the client
         re-reads settings once per CONNECTION instead of in the epoch
         gap-check. */
      const before = await srv.sse();
      const e0 = (await before.waitFor("hello", { timeout: 5000 })).data.epoch;
      before.close();
      const put2 = await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 13 } });
      expect(put2.status).toBe(200);
      const after = await srv.sse();
      const e1 = (await after.waitFor("hello", { timeout: 5000 })).data.epoch;
      after.close();
      expect(`the epoch moved on a settings save: ${e1 !== e0}`).toBe("the epoch moved on a settings save: false");
    } finally {
      sse.close();
    }
  }, 25000);

  test("no sync-status events are pushed in phase 1 (git sync lands in phase 2)", async () => {
    const sse = await srv.sse();
    try {
      await sse.waitFor("hello", { timeout: 5000 });
      const mark = sse.mark();
      const cur = await srv.doc("notes/live.md");
      await srv.putDoc("notes/live.md", cur.body.markdown + "\nnudge\n", cur.body.rev);
      const events = await sse.collect(1000, mark, "sync-status");
      expect(events.map((e) => e.data)).toEqual([]);
    } finally {
      sse.close();
    }
  }, 20000);
});
