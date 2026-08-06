/* ============================================================
   index-recovery.test.ts — a corrupt index is PARKED, never deleted, and the
   app still boots (SPEC §7).

   Four things live in index.db and NOWHERE else by design: the git token, the
   AI key, the terminal password hash and the whole ai_proposals undo stack.
   That is why the recovery path renames the file instead of removing it — the
   difference between a recovery that is merely hard and one that is
   impossible.

   The shape this file exists for is the one the recovery used to MISS.
   `Index.open` probes with `SELECT count(*) FROM sqlite_schema`, which reads
   page 1; damage confined to a later page passes that probe and then throws out
   of `createSchema()` inside `migrate()` — which sat outside the try/catch.
   Measured: the server exited 1 with `database disk image is malformed`,
   `.znotes/` still holding an untouched index.db and no `.corrupt-*` beside it,
   which under the k3s deployment is a CrashLoopBackOff until a human
   intervenes.

   So the sweep below is over WHICH PAGE is damaged, not over whether damage is
   detected at all: page 1 was the only shape that ever worked.
   ============================================================ */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../server/db";
import { dropVault, startServer, waitUntil, SEED_VAULT } from "./helpers";

const PAGE = 4096;

/** a real index.db, built by the real class and then closed */
function freshIndex(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "znotes-idx-"));
  const file = join(dir, "index.db");
  const ix = new Index(file);
  /* something worth parking: credentials are the whole justification for the
     rename, so the fixture carries one */
  ix.db.run("INSERT OR REPLACE INTO credentials (key, value, updatedAt) VALUES ('probe', 'secret-value', '2026-01-01')");
  /* checkpointed, so the fixture's bytes are in the MAIN file rather than in a
     -wal sidecar — otherwise "the parked copy still holds them" would be a
     claim about the sidecar, which is a different (weaker) thing */
  ix.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  ix.close();
  return { dir, file };
}

/** scribble over whole pages, leaving the rest of the file byte-intact */
function scribble(file: string, fromPage: number, toPage: number) {
  const buf = readFileSync(file);
  buf.fill(0x5a, (fromPage - 1) * PAGE, Math.min(buf.length, toPage * PAGE));
  writeFileSync(file, buf);
}

/* the parked MAIN file only — parkCorruptIndex renames the -wal and -shm
   sidecars alongside it, and counting those would say "3" for one parking */
const parked = (dir: string) => readdirSync(dir).filter((n) => /\.corrupt-[^/]+$/.test(n) && !/-(wal|shm)$/.test(n));

describe("a corrupt index is parked and the app keeps booting", () => {
  test("damage on a LATER page — the shape that used to exit 1 with nothing parked", async () => {
    const { dir, file } = freshIndex();
    try {
      const before = readFileSync(file);
      expect(`the fixture is a real sqlite file: ${before.subarray(0, 15).toString("latin1")}`).toBe(
        "the fixture is a real sqlite file: SQLite format 3"
      );
      scribble(file, 2, 3);
      const damaged = readFileSync(file);
      /* page 1 is untouched, which is exactly why Index.open's probe passes */
      expect(`the header survived the corruption: ${readFileSync(file).subarray(0, 15).toString("latin1")}`).toBe(
        "the header survived the corruption: SQLite format 3"
      );

      const ix = new Index(file); // used to THROW `database disk image is malformed`
      const rows = ix.db.query<{ n: number }, []>("SELECT count(*) AS n FROM credentials").get();
      ix.close();

      expect(`the index reopened and is usable again: ${rows?.n}`).toBe("the index reopened and is usable again: 0");
      expect(`the old file was parked rather than deleted: ${parked(dir).length}`).toBe(
        "the old file was parked rather than deleted: 1"
      );
      /* PARKED, not emptied: the file was RENAMED, so it is still the same
         length and still a sqlite file — which is what `sqlite3 .recover` has
         to work on. (Not byte-identical to what was written: `Index.open` sets
         its pragmas before the failure and those touch the header. And the
         credential this fixture wrote lived on one of the pages that were
         scribbled — parking has never been a promise of recovery, only the
         difference between hard and impossible.) */
      const keep = readFileSync(join(dir, parked(dir)[0]!));
      expect(`the parked copy is ${keep.length} bytes of ${damaged.length}`).toBe(
        `the parked copy is ${damaged.length} bytes of ${damaged.length}`
      );
      expect(`…and still a sqlite file: ${keep.subarray(0, 15).toString("latin1")}`).toBe(
        "…and still a sqlite file: SQLite format 3"
      );
      /* the fresh index that replaced it is a DIFFERENT file, not the same one
         reopened */
      expect(`the new index is not the parked one: ${readFileSync(file).length !== 0}`).toBe(
        "the new index is not the parked one: true"
      );
    } finally {
      dropVault(dir);
    }
  });

  test("…and every other shape it already handled still works", () => {
    const shapes: Array<[string, (f: string) => void]> = [
      ["a zeroed header", (f) => scribble(f, 1, 1)],
      ["noise over the first pages", (f) => scribble(f, 1, 4)],
      ["page 3 alone", (f) => scribble(f, 3, 3)],
      ["a truncated tail", (f) => writeFileSync(f, readFileSync(f).subarray(0, PAGE * 2 + 17))],
      ["not a database at all", (f) => writeFileSync(f, "this is not a database\n")],
    ];
    for (const [what, damage] of shapes) {
      const { dir, file } = freshIndex();
      try {
        damage(file);
        let threw = "";
        try {
          new Index(file).close();
        } catch (err) {
          threw = String((err as Error)?.message ?? err);
        }
        expect(`${what}: booted (${threw})`).toBe(`${what}: booted ()`);
        expect(`${what}: parked ${parked(dir).length}`).toBe(`${what}: parked 1`);
      } finally {
        dropVault(dir);
      }
    }
  });

  test("the SERVER survives it too — it used to exit 1 before it ever listened", async () => {
    /* a real boot, so what is measured is the process reaching its ready line
       and not just a class not throwing */
    const first = await startServer({ seed: SEED_VAULT, keepVault: true });
    const vault = first.vault;
    const dbFile = join(vault, ".znotes", "index.db");
    await first.stop();
    await waitUntil(() => existsSync(dbFile), { timeout: 5000, interval: 100, label: "index.db to exist" });

    scribble(dbFile, 2, 3);
    let second: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      second = await startServer({ vault });
      expect(`the server came up over a corrupt index: ${second.readyLine.includes("listening on http://localhost:")}`).toBe(
        "the server came up over a corrupt index: true"
      );
      const health = await fetch(second.url("/healthz"));
      expect(`GET /healthz → ${health.status}`).toBe("GET /healthz → 200");
      expect(`the old index was parked: ${parked(join(vault, ".znotes")).length}`).toBe("the old index was parked: 1");
      /* and it SAID so, rather than failing silently */
      const said = second.stderrLines.join("\n");
      expect(`stderr explains the parking: ${/index\.db unusable/.test(said) && /parked at/.test(said)}`).toBe(
        "stderr explains the parking: true"
      );
    } finally {
      if (second) await second.stop();
      else dropVault(vault);
    }
  }, 90000);
});
