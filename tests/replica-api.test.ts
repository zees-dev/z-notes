/* ============================================================
   replica-api.test.ts — the replica's disk reads and replay contract.
   Real HTTP and SSE over isolated primary and secondary vaults.
   ============================================================ */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { dropVault, startServer, writeVaultFile, type TestServer } from "./helpers";

interface TreeNode {
  type: "file" | "folder";
  path: string;
  rev?: string;
  children?: TreeNode[];
}
interface TreeBody {
  tree: TreeNode[];
  vaults: { tree: TreeNode[] }[];
  epoch: number;
}

let srv: TestServer;
let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "znotes-replica-"));
  writeVaultFile(home, "vault/inbox.md", "# Inbox\n\nprimary\n");
  writeVaultFile(home, "vault/README", "extensionless files are outside the doc namespace\n");
  writeVaultFile(home, "work-notes/notes/secondary.md", "# Secondary\n\nsecondary\n");
  srv = await startServer({ vault: join(home, "vault"), env: { ZNOTES_VAULTS_DIR: home } });
}, 30000);
afterAll(async () => {
  await srv?.stop();
  if (home) dropVault(home);
});

test("every tree file carries the doc's rev as its last key", async () => {
  const body = (await srv.get<TreeBody>("/api/docs")).body;
  const check = async (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "folder") await check(node.children!);
      else {
        expect(Object.keys(node).at(-1)).toBe("rev");
        expect(node.rev).toBe((await srv.doc(node.path)).body.rev);
      }
    }
  };
  await check(body.tree);
  for (const vault of body.vaults) await check(vault.tree);
  expect(body.vaults.length).toBe(2);
});

test("epoch is the body's last key and increases after a PUT", async () => {
  const before = (await srv.get<TreeBody>("/api/docs")).body;
  expect(Object.keys(before).at(-1)).toBe("epoch");
  expect(typeof before.epoch).toBe("number");
  expect((await srv.putDoc("inbox.md", "# Inbox\n\nchanged\n")).status).toBe(200);
  const after = (await srv.get<TreeBody>("/api/docs")).body;
  expect(after.epoch).toBeGreaterThan(before.epoch);
});

test("replica reads primary and qualified secondary bodies from disk and reports missing paths", async () => {
  writeVaultFile(home, "work-notes/notes/secondary.md", "# Secondary\r\n\r\nfresh bytes  \r\n");
  const missing = ["absent.md", "@unknown/a.md", "../escape.md", "@work-notes/absent.md", "README"];
  const r = await srv.api("POST", "/api/replica", {
    paths: ["inbox.md", "@work-notes/notes/secondary.md", ...missing],
  });
  expect(r.status).toBe(200);
  expect(Object.keys(r.body)).toEqual(["docs", "missing"]);
  expect(r.body.docs).toEqual([
    (await srv.doc("inbox.md")).body,
    (await srv.doc("@work-notes/notes/secondary.md")).body,
  ]);
  expect(r.body.docs[1].markdown).toBe("# Secondary\r\n\r\nfresh bytes  \r\n");
  expect(r.body.missing).toEqual(missing);
});

test("replica validates 1–500 string paths and only accepts POST from the same origin", async () => {
  for (const body of [null, [], {}, { paths: [] }, { paths: Array(501).fill("inbox.md") }, { paths: [1] }]) {
    const r = await srv.api("POST", "/api/replica", body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad-body");
  }
  expect((await srv.api("POST", "/api/replica", { paths: Array(500).fill("absent.md") })).status).toBe(200);
  expect((await srv.get("/api/replica")).status).toBe(405);
  const crossSite = await srv.api("POST", "/api/replica", { paths: ["inbox.md"] }, {
    headers: { "content-type": "application/json", origin: "https://elsewhere.invalid" },
  });
  expect(crossSite.status).toBe(403);
});

test("replaying identical bytes with a stale rev neither writes nor emits doc-changed", async () => {
  const sse = await srv.sse();
  try {
    await sse.waitFor("hello");
    const old = (await srv.doc("inbox.md")).body;
    const markdown = "# Inbox\n\nreplayed save\n";
    const put = await srv.putDoc("inbox.md", markdown, old.rev);
    expect(put.status).toBe(200);
    await sse.waitFor("doc-changed", { match: (d) => d.path === "inbox.md" && d.rev === put.body.rev });
    const mark = sse.mark();
    const before = statSync(join(home, "vault/inbox.md"));
    const replay = await srv.putDoc("inbox.md", markdown, old.rev);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(put.body);
    expect(statSync(join(home, "vault/inbox.md")).mtimeMs).toBe(before.mtimeMs);
    expect((await sse.collect(400, mark, "doc-changed")).filter((e) => e.data.path === "inbox.md")).toEqual([]);
    const conflict = await srv.putDoc("inbox.md", "different bytes", old.rev);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("rev-conflict");
  } finally {
    sse.close();
  }
});

test("JSON content-codings preserve identity bytes and never code /events", async () => {
  const identity = await srv.api("GET", "/api/docs", undefined, { headers: { "accept-encoding": "identity" } });
  expect(identity.headers.get("content-encoding")).toBeNull();
  for (const [coding, decode] of [["br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
    const res = await fetch(srv.url("/api/docs"), {
      headers: { "accept-encoding": coding }, decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBe(coding);
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(decode(new Uint8Array(await res.arrayBuffer())).toString()).toBe(identity.text);
  }
  const abort = new AbortController();
  try {
    const events = await fetch(srv.url("/events"), { headers: { "accept-encoding": "br, gzip" }, signal: abort.signal });
    expect(events.headers.get("content-encoding")).toBeNull();
    expect(events.headers.get("content-type")).toStartWith("text/event-stream");
  } finally {
    abort.abort();
  }
});
