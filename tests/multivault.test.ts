/* ============================================================
   multivault.test.ts — acceptance gate for several vaults in one server.

   Black-box, in the shape of gitsync.test.ts: real servers over real temp
   vaults, real git over bare file:// remotes, no network and no internals.

   The claims measured here:

     - the PRIMARY vault is unchanged. Its id is the literal `vault`, its doc
       paths stay bare, and `GET /api/docs`'s legacy `tree` key is still the
       primary's tree. With nothing connected the one top-level entry reads
       "<basename> (unsynced)".
     - a SECONDARY vault is addressed as `@<id>/<rel>` through every doc
       surface — docs, search, trash, SSE — while inside its own stack
       everything stays vault-relative, so the repo remains portable.
     - ISOLATION is the heart of the file: each vault commits and pushes to
       its own origin, on its own cadence, and never to another's. It is
       asserted with per-remote commit COUNTS, never by reading logs.
     - adding a vault is attach (ADR 0017) run in a directory this call
       created: a failure leaves no directory and no registry entry behind.
     - disconnecting is a registry operation — the directory and its repo
       stay on disk, untouched.
     - the registry IS the filesystem: a restart rediscovers every vault under
       the vaults home, and a subdirectory whose name is not a vault id is
       skipped with a note rather than crashing the boot.
     - tokens stay in sqlite: never in a response body, never in .git/config.

   Every fixture gets its OWN vaults home and its OWN bare remotes in distinct
   temp dirs, so a test can never observe another test's commits.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Browser } from "puppeteer-core";
import {
  dropVault,
  encPath,
  git,
  makeVault,
  sleep,
  startServer,
  waitUntil,
  writeVaultFile,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

/* ------------------------------------------------------------------
   git plumbing for the fixtures — every call takes an explicit cwd that is a
   temp directory this file made
   ------------------------------------------------------------------ */

async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${r.code})\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** commits on HEAD; 0 for an unborn branch */
async function commitCount(repo: string): Promise<number> {
  const r = await git(repo, "rev-list", "--count", "HEAD");
  if (r.code !== 0) return 0;
  return Number(r.stdout.trim()) || 0;
}

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

const PRIMARY_SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nthe primary vault\n",
  "notes/alpha.md": "# Alpha\n\nprimary alpha\n",
};

const REMOTE_SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nthe brought repo\n",
  "work/beta.md": "# Beta\n\nbrought beta\n",
};

const trash: string[] = [];
const running: TestServer[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trash.push(d);
  return d;
}

function tempVault(seed: SeedMap = PRIMARY_SEED): string {
  const v = makeVault(seed);
  trash.push(v);
  return v;
}

async function initRepo(dir: string): Promise<void> {
  await gitOk(dir, "init", "-b", "main");
  await gitOk(dir, "config", "user.name", "z-notes test");
  await gitOk(dir, "config", "user.email", "test@z-notes.invalid");
  await gitOk(dir, "config", "commit.gpgsign", "false");
}

interface Bare {
  /** the bare repo on disk */
  dir: string;
  /** what `POST /api/vaults` is given */
  url: string;
  /** the last path segment of the sanitized remote — the label AND the id */
  name: string;
}

/**
 * A bare repo NAMED `<name>.git`, so the id and the label derived from its URL
 * are known rather than guessed at from a mkdtemp suffix. Seeded through a
 * throwaway working copy, because a bare repo has no working tree.
 */
async function bareRepo(name: string, seed: SeedMap = {}): Promise<Bare> {
  const dir = join(tempDir("znotes-remote-"), `${name}.git`);
  mkdirSync(dir, { recursive: true });
  await gitOk(dir, "init", "--bare", "-b", "main");
  if (Object.keys(seed).length) {
    const work = tempVault(seed);
    await initRepo(work);
    await gitOk(work, "add", ".");
    await gitOk(work, "commit", "-m", "vault: initial");
    await gitOk(work, "push", dir, "main:main");
  }
  return { dir, url: `file://${dir}`, name };
}

/** parses fine, can never be reached, and fails in milliseconds */
const unreachableUrl = () => `file://${join(tempDir("znotes-gone-"), "not-a-repo.git")}`;

/** a primary vault that is already a repo pushing to `bare` */
async function primaryWithOrigin(bare: Bare, seed: SeedMap = PRIMARY_SEED): Promise<string> {
  const vault = tempVault(seed);
  await initRepo(vault);
  await gitOk(vault, "add", ".");
  await gitOk(vault, "commit", "-m", "initial");
  await gitOk(vault, "remote", "add", "origin", bare.dir);
  await gitOk(vault, "push", "-u", "origin", "main");
  return vault;
}

/**
 * The vaults home is ALWAYS explicit here: the default is `./vaults` next to
 * the repo, and a test that fell back to it would index the developer's disk.
 */
async function serverOn(vault: string, vaultsDir: string, env: Record<string, string> = {}): Promise<TestServer> {
  const srv = await startServer({ vault, env: { ZNOTES_VAULTS_DIR: vaultsDir, ...env } });
  running.push(srv);
  return srv;
}

interface TwoVaults {
  srv: TestServer;
  vault: string;
  vaultsDir: string;
  bare: Bare;
  /** the secondary's id */
  id: string;
  /** the secondary's directory under the vaults home */
  dir: string;
  added: any;
}

/** a server with the primary plus one added secondary called `work-notes` */
async function withSecondary(opts: { vault?: string; remoteSeed?: SeedMap } = {}): Promise<TwoVaults> {
  const vaultsDir = tempDir("znotes-vaults-");
  const vault = opts.vault ?? tempVault();
  const srv = await serverOn(vault, vaultsDir);
  const bare = await bareRepo("work-notes", opts.remoteSeed ?? REMOTE_SEED);
  const added = await srv.api("POST", "/api/vaults", { url: bare.url });
  expect(`add → ${added.status} ${added.body?.error ?? ""}`.trim()).toBe("add → 201");
  return { srv, vault, vaultsDir, bare, id: "work-notes", dir: join(vaultsDir, "work-notes"), added };
}

afterAll(async () => {
  for (const s of running) {
    try {
      await s.stop();
    } catch {}
  }
  for (const d of trash) dropVault(d);
});

/* ------------------------------------------------------------------
   shared assertions
   ------------------------------------------------------------------ */

/**
 * Error bodies are `{error, message, ...extra}` — key ORDER included. Asserting
 * on the parsed object cannot see that, so this reads the wire text.
 */
function expectErrorShape(text: string, ...keys: string[]) {
  const at = keys.map((k) => text.indexOf(`"${k}":`));
  for (let i = 0; i < keys.length; i++) expect(`${keys[i]} present: ${at[i] >= 0}`).toBe(`${keys[i]} present: true`);
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

const vaultIds = (body: any): string[] => (body?.vaults ?? []).map((v: any) => v.id);
const vaultById = (body: any, id: string): any => (body?.vaults ?? []).find((v: any) => v.id === id);

/** every doc path in a tree, in tree order */
function treePaths(nodes: any[]): string[] {
  const out: string[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      if (n.type === "folder") walk(n.children ?? []);
      else out.push(n.path);
    }
  };
  walk(nodes ?? []);
  return out;
}

/* ==================================================================
   1. nothing connected — one vault, named after its directory
   ================================================================== */

describe("the unsynced primary vault", () => {
  test(
    "is the only entry, id 'vault', labelled '<basename> (unsynced)', over exactly today's tree",
    async () => {
      const vaultsDir = tempDir("znotes-vaults-");
      const vault = tempVault();
      const srv = await serverOn(vault, vaultsDir);

      const r = await srv.get("/api/docs");
      expect(r.status).toBe(200);
      expect(vaultIds(r.body)).toEqual(["vault"]);

      const v = r.body.vaults[0];
      expect(v.label).toBe(`${basename(vault)} (unsynced)`);
      expect(v.prefix).toBe("");
      expect(v.repo).toBe(false);
      expect(v.remote).toBeNull();

      /* the legacy keys are the contract every existing client and test is
         written against: the new array must MIRROR them, not replace them */
      expect(JSON.stringify(v.tree)).toBe(JSON.stringify(r.body.tree));
      expect(treePaths(v.tree)).toEqual(["notes/alpha.md", "inbox.md"]);
      expect(v.docCount).toBe(r.body.vault.docCount);
    },
    60000
  );
});

/* ==================================================================
   2. adding a vault — and the isolation that is the point of the feature
   ================================================================== */

describe("adding a vault", () => {
  test(
    "its docs round-trip through @id/… and each vault commits to its OWN origin, never the other's",
    async () => {
      const primaryBare = await bareRepo("primary-notes");
      const vault = await primaryWithOrigin(primaryBare);
      const { srv, id, dir, bare } = await withSecondary({ vault });

      /* the descriptor names the repo, not the directory it was cloned into */
      const added = (await srv.get(`/api/vaults/${id}`)).body.vault;
      expect(added.id).toBe(id);
      expect(added.label).toBe(bare.name);
      expect(added.prefix).toBe(`@${id}/`);
      expect(added.repo).toBe(true);
      expect(String(added.remote)).toContain(bare.name);

      /* the tree carries qualified paths, so the client can use them verbatim */
      const tree = await srv.get("/api/docs");
      expect(vaultIds(tree.body)).toEqual(["vault", id]);
      expect(treePaths(vaultById(tree.body, id).tree)).toEqual([`@${id}/work/beta.md`, `@${id}/inbox.md`]);
      /* …while the primary's own tree is untouched by any of it */
      expect(treePaths(tree.body.tree)).toEqual(["notes/alpha.md", "inbox.md"]);

      const doc = await srv.doc(`@${id}/work/beta.md`);
      expect(doc.status).toBe(200);
      expect(doc.body.path).toBe(`@${id}/work/beta.md`);
      expect(doc.body.markdown).toBe(REMOTE_SEED["work/beta.md"]);

      const written = "# Beta\n\nedited through the qualified path\n";
      expect((await srv.putDoc(`@${id}/work/beta.md`, written)).status).toBe(200);
      expect((await srv.doc(`@${id}/work/beta.md`)).body.markdown).toBe(written);
      /* on disk it is vault-relative — the prefix is addressing, never content */
      expect(readFileSync(join(dir, "work/beta.md"), "utf8")).toBe(written);

      /* ---- isolation, by commit count on each bare ---- */
      expect((await srv.api("POST", "/api/sync/now")).status).toBe(200);
      const secSync = await srv.api("POST", `/api/vaults/${id}/sync`);
      expect(secSync.status).toBe(200);
      expect(secSync.body.vault).toBe(id);
      const p0 = await commitCount(primaryBare.dir);
      const s0 = await commitCount(bare.dir);
      expect(s0).toBeGreaterThan(0);

      expect((await srv.putDoc(`@${id}/inbox.md`, "# Inbox\n\nsecondary write\n")).status).toBe(200);
      expect((await srv.api("POST", `/api/vaults/${id}/sync`)).status).toBe(200);
      expect(await commitCount(bare.dir)).toBe(s0 + 1);
      expect(await commitCount(primaryBare.dir)).toBe(p0);

      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\nprimary write\n")).status).toBe(200);
      expect((await srv.api("POST", "/api/sync/now")).status).toBe(200);
      expect(await commitCount(primaryBare.dir)).toBe(p0 + 1);
      expect(await commitCount(bare.dir)).toBe(s0 + 1);

      /* and neither repo has heard of the other's doc */
      expect(existsSync(join(dir, "notes/alpha.md"))).toBe(false);
      expect(existsSync(join(srv.vault, "work/beta.md"))).toBe(false);
    },
    120000
  );
});

/* ==================================================================
   3. per-vault sync settings
   ================================================================== */

describe("per-vault settings", () => {
  test(
    "auto-sync off in one vault stops only that vault, and non-git keys are refused",
    async () => {
      const primaryBare = await bareRepo("primary-notes");
      const vault = await primaryWithOrigin(primaryBare);
      const { srv, id, dir } = await withSecondary({ vault });

      expect((await srv.api("PUT", "/api/settings", { git: { autoSyncSeconds: 2 } })).status).toBe(200);
      const fast = await srv.api("PUT", `/api/vaults/${id}/settings`, { git: { autoSyncSeconds: 2 } });
      expect(fast.status).toBe(200);
      expect(fast.body.vault.git.autoSyncSeconds).toBe(2);

      const off = await srv.api("PUT", `/api/vaults/${id}/settings`, { git: { autoSync: false } });
      expect(off.status).toBe(200);
      expect(off.body.vault.id).toBe(id);
      expect(off.body.vault.git.autoSync).toBe(false);
      /* the echo is not the only record of it — it persisted */
      expect((await srv.get(`/api/vaults/${id}`)).body.vault.git.autoSync).toBe(false);
      /* …and the primary was not dragged along with it */
      expect((await srv.get("/api/settings")).body.settings.git.autoSync).toBe(true);

      /* quiesce both repos so the counts below measure the writes below */
      expect((await srv.api("POST", "/api/sync/now")).status).toBe(200);
      expect((await srv.api("POST", `/api/vaults/${id}/sync`)).status).toBe(200);
      await sleep(2600);
      const p0 = await commitCount(vault);
      const s0 = await commitCount(dir);

      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\nprimary still auto-commits\n")).status).toBe(200);
      expect((await srv.putDoc(`@${id}/inbox.md`, "# Inbox\n\nthis one must sit\n")).status).toBe(200);

      await waitUntil(async () => (await commitCount(vault)) === p0 + 1, {
        timeout: 12000,
        interval: 150,
        label: "the primary's debounced auto-commit",
      });
      /* another whole debounce window on top: a commit here would mean the
         per-vault switch is decoration */
      await sleep(3000);
      expect(await commitCount(dir)).toBe(s0);
      expect(readFileSync(join(dir, "inbox.md"), "utf8")).toBe("# Inbox\n\nthis one must sit\n");

      const bad = await srv.api("PUT", `/api/vaults/${id}/settings`, { theme: "modern" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("bad-body");
      expectErrorShape(bad.text, "error", "message");
      expect((await srv.get("/api/settings")).body.settings.theme).not.toBe("modern");
    },
    120000
  );
});

/* ==================================================================
   4. the address grammar
   ================================================================== */

describe("the @id/ grammar", () => {
  test(
    "an unknown vault is 404, an @-segment is never content, and a move cannot cross vaults",
    async () => {
      const { srv, id } = await withSecondary();

      const missing = await srv.doc("@unknown/x.md");
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("not-found");
      expect(String(missing.body.message)).toContain("@unknown");
      expectErrorShape(missing.text, "error", "message");

      const created = await srv.api("POST", "/api/docs", { path: "@zzz/new.md", markdown: "" });
      expect(created.status).toBe(404);
      expect(created.body.error).toBe("not-found");

      /* an `@` segment is reserved so disk and grammar can never disagree —
         in the primary and inside a secondary alike */
      for (const path of ["notes/@x/a.md", `@${id}/@x/a.md`]) {
        const r = await srv.api("POST", "/api/docs", { path, markdown: "" });
        expect(`${path} → ${r.status} ${r.body?.error}`).toBe(`${path} → 400 bad-path`);
        expectErrorShape(r.text, "error", "message");
      }

      const crossed = await srv.api("PATCH", "/api/docs/" + encPath(`@${id}/inbox.md`), { to: "stolen.md" });
      expect(crossed.status).toBe(400);
      expect(crossed.body.error).toBe("bad-path");
      expectErrorShape(crossed.text, "error", "message");
      /* refused, not half-done */
      expect((await srv.doc(`@${id}/inbox.md`)).status).toBe(200);
      expect((await srv.doc("stolen.md")).status).toBe(404);
    },
    90000
  );
});

/* ==================================================================
   5. search across vaults
   ================================================================== */

describe("search", () => {
  test(
    "the same slug in two vaults yields both, qualified, and limit still bounds the merge",
    async () => {
      const { srv, id } = await withSecondary();

      const body = "# Quokka\n\nthe QUOKKA appliance\n";
      expect((await srv.api("POST", "/api/docs", { path: "notes/quokka.md", markdown: body })).status).toBe(201);
      const secondary = await srv.api("POST", "/api/docs", { path: `@${id}/quokka.md`, markdown: body });
      expect(secondary.status).toBe(201);
      expect(secondary.body.path).toBe(`@${id}/quokka.md`);

      const hits = await srv.get("/api/search?q=quokka&limit=24");
      expect(hits.status).toBe(200);
      const paths = new Set<string>((hits.body.results ?? []).map((h: any) => h.path));
      expect(paths.has("notes/quokka.md")).toBe(true);
      expect(paths.has(`@${id}/quokka.md`)).toBe(true);

      const capped = await srv.get("/api/search?q=quokka&limit=1");
      expect(capped.status).toBe(200);
      expect(capped.body.results.length).toBe(1);
    },
    90000
  );
});

/* ==================================================================
   6. one trash drawer, several vaults
   ================================================================== */

describe("trash", () => {
  test(
    "a secondary delete is listed with its vault, restores through the qualified id, and purge empties both",
    async () => {
      const { srv, id, dir } = await withSecondary();
      const beta = REMOTE_SEED["work/beta.md"] as string;

      expect((await srv.api("DELETE", "/api/docs/" + encPath(`@${id}/work/beta.md`))).status).toBe(204);

      const listed = await srv.get("/api/trash");
      expect(listed.status).toBe(200);
      const entry = (listed.body.entries ?? []).find((e: any) => e.vault === id);
      expect(entry).toBeTruthy();
      expect(entry.path).toBe(`@${id}/work/beta.md`);
      expect(entry.id.startsWith(`@${id}/`)).toBe(true);

      /* one path parameter: the qualified id's slash is percent-encoded, the
         same spelling app/api.js sends (encodeURIComponent, not encPath) */
      const restored = await srv.api("POST", `/api/trash/${encodeURIComponent(entry.id)}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body.path).toBe(`@${id}/work/beta.md`);
      expect((await srv.doc(`@${id}/work/beta.md`)).body.markdown).toBe(beta);
      expect(readFileSync(join(dir, "work/beta.md"), "utf8")).toBe(beta);

      /* one deletion in each vault, then one purge for the pair */
      expect((await srv.api("DELETE", "/api/docs/" + encPath("inbox.md"))).status).toBe(204);
      expect((await srv.api("DELETE", "/api/docs/" + encPath(`@${id}/inbox.md`))).status).toBe(204);
      const both = await srv.get("/api/trash");
      expect(both.body.entries.length).toBe(2);

      const purged = await srv.api("POST", "/api/trash/purge", { all: true });
      expect(purged.status).toBe(200);
      expect(purged.body.all).toBe(true);
      expect(purged.body.purged.length).toBe(2);
      expect(purged.body.purged.some((p: string) => p.startsWith(`@${id}/`))).toBe(true);
      expect(purged.body.purged.some((p: string) => !p.startsWith("@"))).toBe(true);
      expect((await srv.get("/api/trash")).body.entries).toEqual([]);
    },
    90000
  );
});

/* ==================================================================
   7. disconnecting — a registry operation, never a deletion
   ================================================================== */

describe("disconnecting a vault", () => {
  test(
    "the entry leaves, the directory and its repo stay, and the primary cannot be disconnected",
    async () => {
      const { srv, id, dir } = await withSecondary();
      expect(vaultIds((await srv.get("/api/vaults")).body)).toEqual(["vault", id]);

      const gone = await srv.api("DELETE", `/api/vaults/${id}`);
      expect(gone.status).toBe(204);
      expect(gone.text).toBe("");
      expect(vaultIds((await srv.get("/api/vaults")).body)).toEqual(["vault"]);
      expect((await srv.get(`/api/vaults/${id}`)).status).toBe(404);
      expect((await srv.doc(`@${id}/inbox.md`)).status).toBe(404);

      /* "the folder stays at <path>" is a promise, not UI copy */
      expect(existsSync(join(dir, "inbox.md"))).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(await commitCount(dir)).toBeGreaterThan(0);

      const primary = await srv.api("DELETE", "/api/vaults/vault");
      expect(primary.status).toBe(400);
      expect(primary.body.error).toBe("primary-vault");
      expectErrorShape(primary.text, "error", "message");
      expect(vaultIds((await srv.get("/api/vaults")).body)).toEqual(["vault"]);

      expect((await srv.api("DELETE", "/api/vaults/never-existed")).status).toBe(404);
    },
    90000
  );
});

/* ==================================================================
   8. a failed add leaves nothing behind
   ================================================================== */

describe("add-vault refusals", () => {
  test(
    "an unreachable remote rolls the directory back, and a duplicate id or remote is refused outright",
    async () => {
      const vaultsDir = tempDir("znotes-vaults-");
      const srv = await serverOn(tempVault(), vaultsDir);

      const dead = await srv.api("POST", "/api/vaults", { url: unreachableUrl(), name: "ghost" });
      expect(dead.status).toBe(502);
      expect(dead.body.error).toBe("attach-failed");
      expectErrorShape(dead.text, "error", "message");
      expect(existsSync(join(vaultsDir, "ghost"))).toBe(false);
      expect(readdirSync(vaultsDir)).toEqual([]);
      expect(vaultIds((await srv.get("/api/vaults")).body)).toEqual(["vault"]);

      const bare = await bareRepo("work-notes", REMOTE_SEED);
      expect((await srv.api("POST", "/api/vaults", { url: bare.url })).status).toBe(201);

      /* the same id from a DIFFERENT remote — a name collision, not a re-add */
      const twin = await bareRepo("work-notes", REMOTE_SEED);
      const sameId = await srv.api("POST", "/api/vaults", { url: twin.url });
      expect(sameId.status).toBe(409);
      expect(sameId.body.error).toBe("exists");
      expectErrorShape(sameId.text, "error", "message");

      /* …and the same remote under a different id */
      const sameRemote = await srv.api("POST", "/api/vaults", { url: bare.url, name: "second-copy" });
      expect(sameRemote.status).toBe(409);
      expect(sameRemote.body.error).toBe("exists");

      expect(existsSync(join(vaultsDir, "second-copy"))).toBe(false);
      expect(readdirSync(vaultsDir).sort()).toEqual(["work-notes"]);
      expect(vaultIds((await srv.get("/api/vaults")).body)).toEqual(["vault", "work-notes"]);
    },
    120000
  );
});

/* ==================================================================
   8b. re-pointing a vault at a new remote
   ================================================================== */

describe("re-pointing a vault", () => {
  test(
    "POST /api/vaults/{id}/remote moves the vault to a new origin, and a taken remote is refused",
    async () => {
      const { srv, id, bare } = await withSecondary();
      const before = await commitCount(bare.dir);

      const next = await bareRepo("moved-notes", REMOTE_SEED);
      const r = await srv.api("POST", `/api/vaults/${id}/remote`, { url: next.url });
      expect(r.status).toBe(200);
      expect(r.body.vault).toBe(id);
      expect(String(vaultById((await srv.get("/api/vaults")).body, id).remote)).toContain("moved-notes");

      /* commits land on the NEW origin now, and never again on the old one */
      const put = await srv.api("PUT", "/api/docs/" + encPath(`@${id}/inbox.md`), {
        markdown: "# Inbox\n\nmoved home\n",
      });
      expect(put.status).toBe(200);
      expect((await srv.api("POST", `/api/vaults/${id}/sync`, {})).status).toBe(200);
      await waitUntil(async () => (await commitCount(next.dir)) > 1, {
        timeout: 15000,
        label: "the edit reaching the new origin",
      });
      expect(await commitCount(bare.dir)).toBe(before);

      /* one remote, one vault: the primary may not take the secondary's */
      const taken = await srv.api("POST", "/api/vaults/vault/remote", { url: next.url });
      expect(taken.status).toBe(409);
      expect(taken.body.error).toBe("exists");
      expectErrorShape(taken.text, "error", "message");

      /* disconnecting the remote leaves the vault, its docs and its repo — it
         is the origin that goes, and the id stays registered */
      const off = await srv.api("DELETE", `/api/vaults/${id}/remote`);
      expect(off.status).toBe(200);
      expect(off.body.remote).toBeNull();
      const after = vaultById((await srv.get("/api/vaults")).body, id);
      expect(after.remote).toBeNull();
      expect(after.repo).toBe(true);
      expect((await srv.doc(`@${id}/inbox.md`)).status).toBe(200);
      /* idempotent: nothing left to disconnect is not a failure */
      expect((await srv.api("DELETE", `/api/vaults/${id}/remote`)).status).toBe(200);
    },
    120000
  );
});

/* ==================================================================
   9. the registry is the filesystem
   ================================================================== */

describe("boot scan", () => {
  test(
    "a restart rediscovers the vault, and a subdirectory that is not a vault id is skipped with a note",
    async () => {
      const vaultsDir = tempDir("znotes-vaults-");
      const vault = tempVault();
      const first = await serverOn(vault, vaultsDir);
      const bare = await bareRepo("work-notes", REMOTE_SEED);
      expect((await first.api("POST", "/api/vaults", { url: bare.url })).status).toBe(201);
      await first.stop();

      /* nothing here should stop a boot, and nothing should silently index it */
      mkdirSync(join(vaultsDir, "Has Spaces!"), { recursive: true });

      const second = await serverOn(vault, vaultsDir);
      expect(second.readyLine.length).toBeGreaterThan(0);

      const back = await second.get("/api/vaults");
      expect(vaultIds(back.body)).toEqual(["vault", "work-notes"]);
      expect(vaultById(back.body, "work-notes").label).toBe("work-notes");

      /* rediscovered means INDEXED, not merely listed */
      expect(treePaths(vaultById((await second.get("/api/docs")).body, "work-notes").tree)).toEqual([
        "@work-notes/work/beta.md",
        "@work-notes/inbox.md",
      ]);
      expect((await second.doc("@work-notes/work/beta.md")).status).toBe(200);

      await waitUntil(() => second.stderrLines.join("\n").includes("Has Spaces!"), {
        timeout: 5000,
        interval: 100,
        label: "the skipped-subdirectory note on stderr",
      });
    },
    120000
  );
});

/* ==================================================================
   9b. the default layout: every vault under one home
   ================================================================== */

describe("one home for every vault", () => {
  test(
    "the primary living inside the vaults home is the layout, not a nesting fault",
    async () => {
      const vaultsDir = tempDir("znotes-vaults-");
      const vault = join(vaultsDir, "vault");
      mkdirSync(vault, { recursive: true });
      writeVaultFile(vault, "inbox.md", "# Inbox\n\nthe primary, at home\n");
      const srv = await serverOn(vault, vaultsDir);

      const bare = await bareRepo("work-notes", REMOTE_SEED);
      expect((await srv.api("POST", "/api/vaults", { url: bare.url })).status).toBe(201);

      /* both vaults, each exactly once — a primary counted twice would be a
         second entry, or its docs would show up under the other's tree */
      const body = (await srv.get("/api/docs")).body;
      expect(vaultIds(body)).toEqual(["vault", "work-notes"]);
      expect(treePaths(vaultById(body, "vault").tree)).toEqual(["inbox.md"]);
      expect(treePaths(vaultById(body, "work-notes").tree)).toEqual([
        "@work-notes/work/beta.md",
        "@work-notes/inbox.md",
      ]);
      expect(srv.stderrLines.join("\n")).not.toContain("nested");

      /* and it survives the boot scan, which walks the home the primary is in */
      await srv.stop();
      const second = await serverOn(vault, vaultsDir);
      expect(vaultIds((await second.get("/api/vaults")).body)).toEqual(["vault", "work-notes"]);
      expect(treePaths(vaultById((await second.get("/api/docs")).body, "vault").tree)).toEqual(["inbox.md"]);
      expect(second.stderrLines.join("\n")).not.toContain("skipping vault");
    },
    120000
  );
});

/* ==================================================================
   10. credential hygiene
   ================================================================== */

describe("credential hygiene", () => {
  test(
    "an explicit token never leaves sqlite, and an omitted one inherits the primary's",
    async () => {
      const PRIMARY_TOKEN = "ghp_znotesPRIMARYt0ken000000000AAAA";
      const EXPLICIT_TOKEN = "ghp_znotesEXPLICITt0ken00000000BBBB";
      const vaultsDir = tempDir("znotes-vaults-");
      const srv = await serverOn(tempVault(), vaultsDir);

      expect((await srv.api("PUT", "/api/settings", { git: { token: PRIMARY_TOKEN } })).status).toBe(200);
      const primaryMask = String((await srv.get("/api/settings")).body.settings.git.tokenMasked);
      expect(primaryMask.length).toBeGreaterThan(0);

      const withToken = await bareRepo("work-notes", REMOTE_SEED);
      const added = await srv.api("POST", "/api/vaults", { url: withToken.url, token: EXPLICIT_TOKEN });
      expect(added.status).toBe(201);
      expect(added.text).not.toContain(EXPLICIT_TOKEN);
      expect(added.text).not.toContain(PRIMARY_TOKEN);

      const config = readFileSync(join(vaultsDir, "work-notes", ".git", "config"), "utf8");
      expect(config).not.toContain(EXPLICIT_TOKEN);
      expect(config).toContain(withToken.dir); // the URL is stored verbatim, unrewritten

      const inherited = await bareRepo("notes-two", REMOTE_SEED);
      const second = await srv.api("POST", "/api/vaults", { url: inherited.url });
      expect(second.status).toBe(201);

      /* one account, N repos: the omitted token is the primary's, deliberately */
      const listed = await srv.get("/api/vaults");
      expect(listed.text).not.toContain(EXPLICIT_TOKEN);
      expect(listed.text).not.toContain(PRIMARY_TOKEN);
      const explicitMask = String(vaultById(listed.body, "work-notes").git.tokenMasked);
      const inheritedMask = String(vaultById(listed.body, "notes-two").git.tokenMasked);
      expect(explicitMask.length).toBeGreaterThan(0);
      expect(explicitMask).not.toBe(primaryMask); // else the next line proves nothing
      expect(inheritedMask).toBe(primaryMask);

      expect(srv.stdoutLines.join("\n")).not.toContain(EXPLICIT_TOKEN);
      expect(srv.stderrLines.join("\n")).not.toContain(EXPLICIT_TOKEN);
    },
    120000
  );

  test(
    "ZNOTES_GIT_TOKEN is primary-only: an anonymous add stays anonymous, restarts included",
    async () => {
      const ENV_TOKEN = "ghp_znotesENVt0ken0000000000000CCCC";
      const vaultsDir = tempDir("znotes-vaults-");
      const vault = tempVault();
      const first = await serverOn(vault, vaultsDir, { ZNOTES_GIT_TOKEN: ENV_TOKEN });

      /* the primary adopts it — that is what the env var is for */
      expect(String((await first.get("/api/settings")).body.settings.git.tokenMasked).length).toBeGreaterThan(0);

      const bare = await bareRepo("anon-notes", REMOTE_SEED);
      expect((await first.api("POST", "/api/vaults", { url: bare.url, token: "" })).status).toBe(201);
      expect(String(vaultById((await first.get("/api/vaults")).body, "anon-notes").git.tokenMasked)).toBe("");
      await first.stop();

      /* the boot scan runs settings.load() again; the choice must survive it */
      const second = await serverOn(vault, vaultsDir, { ZNOTES_GIT_TOKEN: ENV_TOKEN });
      expect(String(vaultById((await second.get("/api/vaults")).body, "anon-notes").git.tokenMasked)).toBe("");
    },
    120000
  );
});

/* ==================================================================
   11. the event stream
   ================================================================== */

describe("SSE", () => {
  test(
    "add and remove announce vaults-changed, sync-status names its vault, and a secondary edit is qualified",
    async () => {
      const primaryBare = await bareRepo("primary-notes");
      const vault = await primaryWithOrigin(primaryBare);
      const vaultsDir = tempDir("znotes-vaults-");
      const srv = await serverOn(vault, vaultsDir);
      const bare = await bareRepo("work-notes", REMOTE_SEED);
      const id = "work-notes";
      const sse = await srv.sse();

      try {
        await sse.waitFor("hello", { timeout: 5000 });

        let mark = sse.mark();
        expect((await srv.api("POST", "/api/vaults", { url: bare.url })).status).toBe(201);
        const announced = await sse.waitFor("vaults-changed", { from: mark, timeout: 10000 });
        expect(vaultIds(announced.data)).toContain(id);

        /* every sync frame says which vault it is about — the statusbar chip
           stays primary-bound and the vault rows key off this */
        mark = sse.mark();
        expect((await srv.api("POST", "/api/sync/now")).status).toBe(200);
        const primaryFrames = await sse.collect(600, mark, "sync-status");
        expect(primaryFrames.length).toBeGreaterThan(0);
        expect([...new Set(primaryFrames.map((e) => e.data?.vault))]).toEqual(["vault"]);

        mark = sse.mark();
        expect((await srv.api("POST", `/api/vaults/${id}/sync`)).status).toBe(200);
        const secondaryFrames = await sse.collect(600, mark, "sync-status");
        expect(secondaryFrames.length).toBeGreaterThan(0);
        expect([...new Set(secondaryFrames.map((e) => e.data?.vault))]).toEqual([id]);

        /* the watcher of a secondary vault speaks the qualified grammar too */
        mark = sse.mark();
        writeVaultFile(join(vaultsDir, id), "external.md", "# External\n\nwritten outside the app\n");
        const changed = await sse.waitFor("doc-changed", {
          from: mark,
          match: (d) => d?.path === `@${id}/external.md`,
          timeout: 15000,
        });
        expect(changed.data.path).toBe(`@${id}/external.md`);

        mark = sse.mark();
        expect((await srv.api("DELETE", `/api/vaults/${id}`)).status).toBe(204);
        const removed = await sse.waitFor("vaults-changed", { from: mark, timeout: 10000 });
        expect(vaultIds(removed.data)).toEqual(["vault"]);
      } finally {
        sse.close();
      }
    },
    120000
  );
});

/* ==================================================================
   12. the sidebar, in a real browser
   ================================================================== */

describe("the tree", () => {
  test(
    "draws one expanded row per vault, aligns sibling rows, guides its children, and collapses on click",
    async () => {
      const { srv } = await withSecondary();
      const browser: Browser = await launchTestBrowser();

      try {
        const page = await newAppPage(browser);
        await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
        await waitForApp(page);
        await page.waitForSelector("#tree .row.vault", { timeout: 15000 });

        /* one top-level row per vault, each over a children box that is open */
        const vaults = await page.evaluate(() =>
          [...document.querySelectorAll("#tree .row.vault")].map((row) => {
            const kids = row.parentElement!.nextElementSibling as HTMLElement;
            return {
              kind: (row as HTMLElement).dataset.kind ?? "",
              isChildren: kids.classList.contains("children"),
              closed: kids.classList.contains("closed"),
              guide: kids.style.getPropertyValue("--guide-x").trim(),
              rows: kids.querySelectorAll(".row").length,
            };
          })
        );
        expect(vaults.length).toBe(2);
        for (const v of vaults) {
          expect(v.kind).toBe("vault");
          expect(v.isChildren).toBe(true);
          expect(v.closed).toBe(false);
          expect(v.rows).toBeGreaterThan(0);
          /* the branch guide is positioned per box, so its x is inline */
          expect(v.guide).toMatch(/^[\d.]+px$/);
        }

        /* a folder and a file that are siblings sit at ONE indent */
        const pads = await page.evaluate(() => {
          const folder = document.querySelector('#tree .row.folder[data-path="notes"]') as HTMLElement;
          const file = document.querySelector('#tree .row.file[data-doc="inbox.md"]') as HTMLElement;
          return [getComputedStyle(folder).paddingLeft, getComputedStyle(file).paddingLeft];
        });
        expect(pads[0]).toBe(pads[1]);

        /* clicking the vault row puts its whole subtree away */
        await page.click("#tree .row.vault");
        await page.waitForFunction(
          () => {
            const file = document.querySelector('#tree .row.file[data-doc="inbox.md"]') as HTMLElement | null;
            return !file || file.offsetParent === null;
          },
          { timeout: 8000 }
        );
        const collapsed = await page.evaluate(() => {
          const row = document.querySelector("#tree .row.vault")!;
          return (row.parentElement!.nextElementSibling as HTMLElement).classList.contains("closed");
        });
        expect(collapsed).toBe(true);
      } finally {
        await browser.close().catch(() => {});
      }
    },
    120000
  );
});
