/* ============================================================
   RECONCILE GATE

   Atomic-save simulation (temp+rename), identical-bytes suppression, burst
   debounce.

   The watcher is a contentless doorbell: on macOS `fs.watch` reports
   `rename` for everything and an atomic save names only the temp file. So the
   only thing worth asserting is what comes out the far end of
   watch → debounce → reconcile → SSE:

     a. temp-file-then-rename must produce ONE doc-changed naming the REAL doc
     b. rewriting identical bytes must produce NOTHING
     c. a burst of writes must coalesce, and the surviving event must carry the
        rev of the final content
     d. a file created outside the app must show up
     e. a file deleted outside the app must leave the index

   Every sub-test uses its own doc so a leaked debounce from the previous one
   cannot be mistaken for a pass.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { renameSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  makeVault,
  writeVaultFile,
  readVaultText,
  sleep,
  waitUntil,
  dropVault,
  SSEClient,
  type TestServer,
} from "./helpers";

const DOCS = {
  "atomic.md": "# Atomic\n\nbefore the atomic save\n",
  "same.md": "# Same\n\nthese bytes never change\n",
  "burst.md": "# Burst\n\nwrite 0\n",
  "doomed.md": "# Doomed\n\nthis file is about to be deleted externally\n",
  "racy.md": "# Racy\n\nthe browser read this copy\n",
  "starved.md": "# Starved\n\nbefore\n",
  "notes/keep.md": "# Keep\n\nuntouched control doc\n",
};

let srv: TestServer;
let vault: string;
let sse: SSEClient;

beforeAll(async () => {
  vault = makeVault(DOCS);
  srv = await startServer({ vault });
  sse = await srv.sse();
  await sse.waitFor("hello", { timeout: 5000 });
  /* let the initial scan settle so nothing from startup lands in a mark window */
  await sleep(400);
}, 30000);

afterAll(async () => {
  if (sse) sse.close();
  if (srv) await srv.stop();
  if (vault) dropVault(vault);
});

const docEvents = (from: number, path: string) =>
  sse.since(from, "doc-changed").filter((e) => e.data && e.data.path === path);

describe("reconcile gate", () => {
  test("(a) atomic save — temp file inside the vault, renamed over a doc — emits one external doc-changed naming the real doc", async () => {
    const target = "atomic.md";
    const tmpRel = ".atomic.md.tmp-9182";
    const next = "# Atomic\n\nAFTER the atomic save — written via temp+rename\n";

    const mark = sse.mark();
    writeFileSync(join(vault, tmpRel), next, "utf8");
    /* the doorbell now names the TEMP file; only a disk reconcile finds the truth */
    renameSync(join(vault, tmpRel), join(vault, target));

    const ev = await sse.waitFor("doc-changed", {
      from: mark,
      match: (d) => d && d.path === target,
      timeout: 2500,
    });

    expect(ev.data.reason).toBe("external");
    expect(typeof ev.data.rev).toBe("string");
    expect(ev.data.bytes).toBe(Buffer.byteLength(next, "utf8"));
    expect(typeof ev.data.mtime).toBe("string");
    expect(Number.isFinite(Date.parse(ev.data.mtime))).toBe(true);

    /* let any straggler land, then insist there was exactly one */
    await sleep(600);
    expect(docEvents(mark, target).length).toBe(1);

    /* and the temp file must never have been announced as a doc */
    const named = sse.since(mark, "doc-changed").map((e) => e.data.path);
    expect(named).not.toContain(tmpRel);
    expect(named.some((p: string) => p.includes(".tmp-9182"))).toBe(false);

    /* the API agrees with disk, and the rev matches the event */
    const got = await srv.doc(target);
    expect(got.status).toBe(200);
    expect(got.body.markdown).toBe(next);
    expect(got.body.rev).toBe(ev.data.rev);
  }, 20000);

  test("(b) rewriting identical bytes externally emits nothing", async () => {
    const target = "same.md";
    const content = readVaultText(vault, target);

    const mark = sse.mark();
    /* three separate writes of the very same bytes — mtime moves, content does not */
    writeFileSync(join(vault, target), content, "utf8");
    await sleep(200);
    writeFileSync(join(vault, target), content, "utf8");
    await sleep(200);
    writeFileSync(join(vault, target), content, "utf8");

    const events = await sse.collect(1200, mark, "doc-changed");
    expect(events.filter((e) => e.data.path === target).map((e) => e.data)).toEqual([]);
  }, 20000);

  test("(b') the same doc DOES emit when the bytes really change (identical-suppression is not a dead watcher)", async () => {
    const target = "same.md";
    const mark = sse.mark();
    writeFileSync(join(vault, target), "# Same\n\nnow these bytes DID change\n", "utf8");
    const ev = await sse.waitFor("doc-changed", {
      from: mark,
      match: (d) => d && d.path === target,
      timeout: 2500,
    });
    expect(ev.data.reason).toBe("external");
  }, 20000);

  test("(c) a burst of 10 rapid external writes coalesces, and the final rev is correct", async () => {
    const target = "burst.md";
    const final = "# Burst\n\nwrite 9\n";

    const mark = sse.mark();
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(vault, target), `# Burst\n\nwrite ${i}\n`, "utf8");
    }

    await sse.waitFor("doc-changed", {
      from: mark,
      match: (d) => d && d.path === target,
      timeout: 2500,
    });
    await sleep(800); // give any un-coalesced stragglers every chance to arrive

    const events = docEvents(mark, target);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);

    const last = events[events.length - 1];
    expect(last.data.reason).toBe("external");

    const got = await srv.doc(target);
    expect(got.status).toBe(200);
    expect(got.body.markdown).toBe(final);
    expect(last.data.rev).toBe(got.body.rev);
    expect(last.data.bytes).toBe(Buffer.byteLength(final, "utf8"));
  }, 20000);

  test("(d) a doc created externally is announced and joins the tree", async () => {
    const target = "notes/brand-new.md";
    const content = "# Brand new\n\nCreated by vim, not by the app.\n";

    const mark = sse.mark();
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, target), content, "utf8");

    const ev = await sse.waitFor("doc-changed", {
      from: mark,
      match: (d) => d && d.path === target,
      timeout: 2500,
    });
    /* the contract reason vocabulary; a discovered-on-disk file is created|external */
    expect(["created", "external"]).toContain(ev.data.reason);
    expect(ev.data.bytes).toBe(Buffer.byteLength(content, "utf8"));

    const tree = await srv.get("/api/docs");
    expect(flatten(tree.body.tree).map((n: any) => n.path)).toContain(target);

    const got = await srv.doc(target);
    expect(got.status).toBe(200);
    expect(got.body.markdown).toBe(content);
    expect(got.body.rev).toBe(ev.data.rev);
  }, 20000);

  test("(d2) an explicit-extension UTF-8 file is indexed externally and departs if its bytes stop being UTF-8", async () => {
    const target = "notes/external.txt";
    const content = "# External text\n\ncreated outside the app\n";

    const createdMark = sse.mark();
    writeFileSync(join(vault, target), content, "utf8");
    await sse.waitFor("doc-changed", {
      from: createdMark,
      match: (d) => d && d.path === target && !d.removed,
      timeout: 2500,
    });
    expect((await srv.doc(target)).body.markdown).toBe(content);
    expect(flatten((await srv.get("/api/docs")).body.tree).map((n: any) => n.path)).toContain(target);

    const invalidMark = sse.mark();
    writeFileSync(join(vault, target), Buffer.from([0xff, 0xfe, 0xfd]));
    const departed = await sse.waitFor("doc-changed", {
      from: invalidMark,
      match: (d) => d && d.path === target && d.removed === true,
      timeout: 2500,
    });
    expect(departed.data.reason).toBe("external");
    expect((await srv.doc(target)).status).toBe(404);
    expect(flatten((await srv.get("/api/docs")).body.tree).map((n: any) => n.path)).not.toContain(target);
  }, 20000);

  test("(e) a doc deleted externally leaves the index AND is announced", async () => {
    const target = "doomed.md";

    const before = await srv.get("/api/docs");
    expect(flatten(before.body.tree).map((n: any) => n.path)).toContain(target);

    const mark = sse.mark();
    unlinkSync(join(vault, target));

    /* without an event the client's sidebar keeps a ghost row, and an editor
       still holding the doc can only discover the truth by failing to save */
    const ev = await sse.waitFor("doc-changed", {
      from: mark,
      match: (d) => d && d.path === target,
      timeout: 2500,
    });
    expect(ev.data.removed).toBe(true);
    expect(ev.data.reason).toBe("external");
    expect(typeof ev.data.rev).toBe("string");


    const paths = await waitUntil(
      async () => {
        const r = await srv.get("/api/docs");
        const list = flatten(r.body.tree).map((n: any) => n.path);
        return list.includes(target) ? null : list;
      },
      { timeout: 4000, label: `${target} to disappear from GET /api/docs` }
    );

    expect(paths).not.toContain(target);
    expect(paths).toContain("notes/keep.md"); // the rest of the index survived

    const gone = await srv.doc(target);
    expect(gone.status).toBe(404);
  }, 20000);

  /**
   * The window between an external write and the reconcile that follows it is
   * where a save can destroy someone else's work: if `rev` comes from the
   * sqlite row while `markdown` comes from disk, the client's stale rev matches
   * the stale row, the conflict check passes and the external edit is gone.
   * Nothing here waits for the debounce — that is the point.
   */
  test("(f) a PUT inside the un-reconciled window 409s instead of clobbering the external edit", async () => {
    const target = "racy.md";
    const read = await srv.doc(target);
    expect(read.status).toBe(200);
    const revTheClientHolds = read.body.rev;

    const external = "# Racy\n\nEXTERNAL EDIT FROM VIM\n";
    writeFileSync(join(vault, target), external, "utf8");

    /* immediately: GET must not hand back fresh bytes tagged with a stale rev */
    const mid = await srv.doc(target);
    expect(mid.body.markdown).toBe(external);
    expect(mid.body.rev).not.toBe(revTheClientHolds);

    const put = await srv.putDoc(target, "# Racy\n\nBROWSER BUFFER\n", revTheClientHolds);
    expect(put.status).toBe(409);
    expect(put.body.error).toBe("rev-conflict");
    expect(put.body.markdown).toBe(external); // a 409 carries the on-disk markdown
    expect(readVaultText(vault, target)).toBe(external);
  }, 20000);

  /**
   * A trailing-only debounce with no ceiling never fires while something keeps
   * writing (git pull, rsync, an editor on a 100ms autosave), so staleness must
   * be bounded by a constant rather than by the length of the burst.
   */
  test("(g) sustained unrelated churn cannot starve the reconciler", async () => {
    const noise = "noise.md";
    const target = "starved.md";
    let churning = true;
    const churn = (async () => {
      for (let i = 0; churning && i < 60; i++) {
        writeFileSync(join(vault, noise), `# Noise\n\nwrite ${i}\n`, "utf8");
        await sleep(40);
      }
    })();

    try {
      await sleep(300); // let the churn establish itself first
      const mark = sse.mark();
      const next = "# Starved\n\nAFTER — written while the vault is busy\n";
      writeFileSync(join(vault, target), next, "utf8");

      const ev = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d && d.path === target,
        timeout: 1500,
      });
      expect(ev.data.bytes).toBe(Buffer.byteLength(next, "utf8"));

      /* the index — which is what GET /api/docs serves — really caught up */
      const tree = await srv.get("/api/docs");
      const row = flatten(tree.body.tree).find((n: any) => n.path === target);
      expect(row.bytes).toBe(Buffer.byteLength(next, "utf8"));
    } finally {
      churning = false;
      await churn;
    }
  }, 20000);

  test("a doc untouched throughout never emitted an event", () => {
    const noise = sse.since(0, "doc-changed").filter((e) => e.data.path === "notes/keep.md");
    expect(noise.map((e) => e.data)).toEqual([]);
  });
});

function flatten(nodes: any[]): any[] {
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      out.push(n);
      if (n.type === "folder") walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}
