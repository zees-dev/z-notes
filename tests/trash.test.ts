/* ============================================================
   trash.test.ts — recoverable deletion at the real HTTP/disk boundary.

   The browser suite owns placement and interaction. These checks own the part
   a UI stub cannot prove: bytes really move under .znotes, restoration rebuilds
   missing ancestors, permanent deletion removes the retained copy, and the
   configured retention window drives the real sweep.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { lstatSync, readFileSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { encPath, readVaultText, startServer, vaultHas, waitUntil, type TestServer } from "./helpers";

const servers: TestServer[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});

async function server(seed: Record<string, string>): Promise<TestServer> {
  const s = await startServer({ seed });
  servers.push(s);
  return s;
}

const del = (s: TestServer, path: string) => s.api("DELETE", "/api/docs/" + encPath(path));
const restore = (s: TestServer, id: string) => s.api("POST", "/api/trash/" + encodeURIComponent(id) + "/restore", {});

describe("real trash storage and routes", () => {
  test("delete retains exact bytes; restore rebuilds missing parent hierarchy", async () => {
    const path = "lost/again/note.md";
    const markdown = "# Byte faithful\n\ntrailing spaces stay  \n\n";
    const s = await server({ [path]: markdown, "inbox.md": "# Inbox\n" });
    const events = await s.sse();
    const deleteMark = events.mark();

    const removed = await del(s, path);
    expect(removed.status).toBe(204);
    expect(vaultHas(s.vault, path)).toBe(false);
    const deletedEvent = await events.waitFor("trash-changed", {
      from: deleteMark,
      match: (data) => data?.entries?.some((entry: any) => entry.path === path),
      timeout: 8000,
    });
    expect(deletedEvent.data.retentionDays).toBe(7);

    const list = await s.get("/api/trash");
    expect(list.status).toBe(200);
    expect(list.body.retentionDays).toBe(7);
    expect(list.body.entries).toHaveLength(1);
    const entry = list.body.entries[0];
    expect(entry.path).toBe(path);
    expect(entry.kind).toBe("doc");
    expect(entry.restorable).toBe(true);
    expect(readVaultText(s.vault, `.znotes/trash/${entry.id}/files/${path}`)).toBe(markdown);

    /* Simulate the enclosing hierarchy being removed after the doc. Restore
       must make every missing ancestor, not require the empty folders to have
       survived the original delete. */
    rmSync(join(s.vault, "lost"), { recursive: true, force: true });
    const restoreMark = events.mark();
    const back = await restore(s, entry.id);
    expect(back.status).toBe(200);
    expect(back.body.path).toBe(path);
    expect(readVaultText(s.vault, path)).toBe(markdown);
    expect((await s.get("/api/trash")).body.entries).toHaveLength(0);
    await events.waitFor("trash-changed", {
      from: restoreMark,
      match: (data) => Array.isArray(data?.entries) && data.entries.length === 0,
      timeout: 8000,
    });
    events.close();
  }, 60000);

  test("a deleted folder restores its markdown and non-markdown payload together", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    const s = await server({
      "project/docs/a.md": "# A\n",
      "project/docs/deep/b.md": "# B\n",
      "project/image.bin": "placeholder replaced below",
      "outside.md": "# Outside\n",
    });
    writeFileSync(join(s.vault, "project/image.bin"), binary);

    expect((await del(s, "project")).status).toBe(204);
    expect(vaultHas(s.vault, "project")).toBe(false);
    const entry = (await s.get("/api/trash")).body.entries[0];
    expect(entry.kind).toBe("folder");
    expect(entry.docCount).toBe(2);
    expect(entry.fileCount).toBe(3);

    expect((await restore(s, entry.id)).status).toBe(200);
    expect(readVaultText(s.vault, "project/docs/a.md")).toBe("# A\n");
    expect(readVaultText(s.vault, "project/docs/deep/b.md")).toBe("# B\n");
    expect(readFileSync(join(s.vault, "project/image.bin")).equals(binary)).toBe(true);
  }, 60000);

  test("a legacy folder entry rediscovers every editable doc before restore", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    const s = await server({
      "legacy/a.md": "# A\n",
      "legacy/report.txt": "# Report\n\nvalid UTF-8 stays editable\n",
      "legacy/image.bin": "placeholder replaced below",
      "outside.md": "# Outside\n",
    });
    writeFileSync(join(s.vault, "legacy/image.bin"), binary);
    symlinkSync(join(import.meta.dir, "..", "package.json"), join(s.vault, "legacy/leak.txt"));
    symlinkSync(join(import.meta.dir, ".."), join(s.vault, "legacy/link"));

    expect((await del(s, "legacy")).status).toBe(204);
    const current = (await s.get("/api/trash")).body.entries[0];
    const metaPath = join(s.vault, ".znotes", "trash", current.id, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    /* Before explicit-extension docs, metadata recorded only .md paths even
       though files/ retained every byte. Recreate that committed legacy shape. */
    meta.docs = ["legacy/a.md"];
    expect(meta.files).toContain("legacy/leak.txt");
    /* A hostile committed record can name a regular file THROUGH a retained
       directory symlink even though scanTree itself records only the link. */
    meta.files.push("legacy/link/package.json");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

    const legacy = (await s.get("/api/trash")).body.entries[0];
    expect(legacy.docCount).toBe(2);

    const events = await s.sse();
    const mark = events.mark();
    const back = await restore(s, legacy.id);
    expect(back.status).toBe(200);
    expect(back.body.restored).toEqual(["legacy/a.md", "legacy/report.txt"]);
    const report = await events.waitFor("doc-changed", {
      from: mark,
      match: (data) => data?.path === "legacy/report.txt",
      timeout: 8000,
    });
    expect(report.data.reason).toBe("restored");
    expect(report.data.trashId).toBe(legacy.id);
    expect((await s.doc("legacy/report.txt")).body.markdown).toContain("valid UTF-8");
    expect(readFileSync(join(s.vault, "legacy/image.bin")).equals(binary)).toBe(true);
    expect(lstatSync(join(s.vault, "legacy/leak.txt")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(s.vault, "legacy/link")).isSymbolicLink()).toBe(true);
    events.close();
  }, 60000);

  test("permanent delete removes the retained copy and cannot be restored", async () => {
    const s = await server({ "doomed.md": "# Doomed\n", "keep.md": "# Keep\n" });
    expect((await del(s, "doomed.md")).status).toBe(204);
    const entry = (await s.get("/api/trash")).body.entries[0];

    const purge = await s.api("DELETE", "/api/trash/" + encodeURIComponent(entry.id));
    expect(purge.status).toBe(204);
    expect(vaultHas(s.vault, `.znotes/trash/${entry.id}`)).toBe(false);
    expect((await restore(s, entry.id)).status).toBe(404);
    expect(vaultHas(s.vault, "doomed.md")).toBe(false);
  }, 60000);

  test("retention defaults to a week, is settable, and the real sweep purges expired entries", async () => {
    const s = await server({ "old.md": "# Old\n", "keep.md": "# Keep\n" });
    const initial = await s.get("/api/settings");
    expect(initial.body.settings.trash.retentionDays).toBe(7);
    expect(initial.body.meta.numbers["trash.retentionDays"]).toEqual({
      min: 1,
      max: 365,
      step: 1,
      unit: "days",
      code: "bad-retention-days",
    });

    expect((await del(s, "old.md")).status).toBe(204);
    const entry = (await s.get("/api/trash")).body.entries[0];
    const metaPath = join(s.vault, ".znotes", "trash", entry.id, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.deletedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

    const changed = await s.api("PUT", "/api/settings", { trash: { retentionDays: 3 } });
    expect(changed.status).toBe(200);
    expect(changed.body.settings.trash.retentionDays).toBe(3);
    await waitUntil(async () => (await s.get("/api/trash")).body.entries.length === 0, 10_000, 50);
    expect(vaultHas(s.vault, `.znotes/trash/${entry.id}`)).toBe(false);

    const invalid = await s.api("PUT", "/api/settings", { trash: { retentionDays: 0 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("bad-retention-days");
  }, 60000);

  test("an entry without meta.json is dated by its directory, not purged on sight", async () => {
    const s = await server({ "orphan.md": "# Orphan\n", "keep.md": "# Keep\n" });
    expect((await del(s, "orphan.md")).status).toBe(204);
    const entry = (await s.get("/api/trash")).body.entries[0];
    const dir = join(s.vault, ".znotes", "trash", entry.id);

    /* The mid-checkout shape: `git pull` has laid down files/ and not yet
       meta.json. The bytes are the only live copy — the sweep must not take
       them just because the record is momentarily missing. */
    rmSync(join(dir, "meta.json"));
    const kept = await s.api("POST", "/api/trash/purge", {});
    expect(kept.status).toBe(200);
    expect(kept.body.purged).toEqual([]);
    expect(vaultHas(s.vault, `.znotes/trash/${entry.id}/files/orphan.md`)).toBe(true);

    // same entry, now older than the window: unrestorable litter, and swept
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(dir, old, old);
    const swept = await s.api("POST", "/api/trash/purge", {});
    expect(swept.status).toBe(200);
    expect(swept.body.purged).toEqual([entry.id]);
    expect(vaultHas(s.vault, `.znotes/trash/${entry.id}`)).toBe(false);
  }, 60000);
});
