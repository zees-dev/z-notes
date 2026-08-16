/* ============================================================
   gitsync.test.ts — PHASE 2 acceptance gate for git sync.

   What is being measured, in the same spirit as the phase-1 files: nothing in
   here reaches into the backend's internals. It knows only the fixed
   conventions of this phase:

     - the VAULT is its own git repository, unrelated to this source repo.
       No repo → sync state "offline" / "not a git repository", and the rest
       of the app is entirely unaffected. The PIPELINE never runs `git init`
       (ADR 0017 narrowed the old blanket "the server never runs git init"):
       attach — POST /api/sync/remote, or ZNOTES_VAULT_REPO on first boot — is
       the one user-initiated operation that may, and sections 15–16 own that
       exception. Everything above section 15 is the pipeline, and none of it
       may ever create a repository.
     - attach is non-destructive and atomic: it refuses, naming the paths,
       rather than overwrite a local file, and on any failure it rolls back
       everything it made — leaving the vault byte-identical.
     - tracked set: exactly visible, extension-bearing valid-UTF-8 docs plus
       .znotes/settings.toml (+ vault.pub / identity.age). Hidden,
       extensionless and invalid-UTF-8 payloads never enter it; .znotes/index.db
       (the credential store) is ignored through the repo's own
       .git/info/exclude, whatever the user's .gitignore says.
     - a repo the user is in the middle of — mid-merge, mid-rebase, conflicted
       index, detached HEAD — is refused outright, never resolved or committed.
     - auto-sync: debounce `git.autoSyncSeconds` (default 60, live-reloadable)
       after writes settle → add → commit "sync: <ISO> · <n> file(s): …" →
       push to `git.branch` iff a remote named origin exists.
     - POST /api/sync/now runs the same pipeline now and answers with the
       resulting sync-status object.
     - push rejected → pull --rebase → push; real conflict → rebase aborted
       cleanly, state "error" naming the file, both sides still intact.
     - GET /api/sync/status is real, and every state transition is pushed on
       /events as `sync-status`.
     - the GitHub token lives in sqlite only: never in argv, a remote URL,
       .git/config, logs, SSE payloads or any HTTP response.

   Every git fixture is a local repo plus a bare "origin" reached over a file
   path in a temp dir: no network, no real credentials, no GitHub.

   Fixtures deliberately run with git.autoSyncSeconds = 2 so the debounce is
   observable without making the suite slow.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropVault,
  makeVault,
  sleep,
  startServer,
  waitUntil,
  writeVaultFile,
  type SeedMap,
  type TestServer, git } from "./helpers";

/* ------------------------------------------------------------------
   git plumbing for the fixtures (never for the source repo — every call
   takes an explicit cwd that is a temp directory we made ourselves)
   ------------------------------------------------------------------ */



async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${r.code})\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

async function lsFiles(repo: string): Promise<string[]> {
  return lines(await gitOk(repo, "ls-files")).sort();
}

/** commits on HEAD; 0 for an unborn branch */
async function commitCount(repo: string): Promise<number> {
  const r = await git(repo, "rev-list", "--count", "HEAD");
  if (r.code !== 0) return 0;
  return Number(r.stdout.trim()) || 0;
}

async function headSubject(repo: string): Promise<string> {
  return (await gitOk(repo, "log", "-1", "--pretty=format:%s")).trim();
}

/** paths touched by the tip commit */
async function headFiles(repo: string): Promise<string[]> {
  const out = await gitOk(repo, "log", "-1", "--name-only", "--pretty=format:");
  return lines(out).sort();
}

async function showFile(repo: string, rev: string, path: string): Promise<string> {
  return gitOk(repo, "show", `${rev}:${path}`);
}

async function isIgnored(repo: string, path: string): Promise<boolean> {
  const r = await git(repo, "check-ignore", "-q", "--", path);
  return r.code === 0;
}

/** the origin URL verbatim, or null when there is no origin (or no repo) */
async function originUrl(repo: string): Promise<string | null> {
  const r = await git(repo, "remote", "get-url", "origin");
  return r.code === 0 ? r.stdout.trim() : null;
}

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  "notes/alpha.md": "# Alpha\n\nfirst note\n",
  "notes/beta.md": "# Beta\n\nsecond note\n",
  "notes/gamma.md": "# Gamma\n\nthird note\n",
};

const trash: string[] = [];
const running: TestServer[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trash.push(d);
  return d;
}

function tempVault(seed: SeedMap = SEED): string {
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

interface Fixture {
  vault: string;
  bare: string | null;
}

/**
 * A vault that is already a git repo with one commit of the seed. `origin`:
 * true → a real bare repo on disk (pushable); a string → that URL verbatim
 * (used for the unreachable-host custody test); omitted → no remote at all.
 */
async function gitVault(opts: { seed?: SeedMap; origin?: true | string } = {}): Promise<Fixture> {
  const vault = tempVault(opts.seed ?? SEED);
  await initRepo(vault);
  await gitOk(vault, "add", ".");
  await gitOk(vault, "commit", "-m", "initial");

  if (opts.origin === true) {
    const bare = tempDir("znotes-origin-");
    await gitOk(bare, "init", "--bare", "-b", "main");
    await gitOk(vault, "remote", "add", "origin", bare);
    await gitOk(vault, "push", "-u", "origin", "main");
    return { vault, bare };
  }
  if (typeof opts.origin === "string") {
    await gitOk(vault, "remote", "add", "origin", opts.origin);
  }
  return { vault, bare: null };
}

/** a bare repo with no commits at all, HEAD pointing at `branch` */
async function emptyBare(branch = "main"): Promise<string> {
  const bare = tempDir("znotes-origin-");
  await gitOk(bare, "init", "--bare", "-b", branch);
  return bare;
}

/**
 * A bare repo already carrying `seed` on `branch` — "the vault repo the user
 * brings". Built through a throwaway working copy because a bare repo has no
 * working tree to write files into.
 */
async function seededBare(seed: SeedMap, branch = "main"): Promise<string> {
  const bare = await emptyBare(branch);
  const work = tempVault(seed);
  await initRepo(work);
  await gitOk(work, "add", ".");
  await gitOk(work, "commit", "-m", "vault: initial");
  if (branch !== "main") await gitOk(work, "branch", "-M", branch);
  await gitOk(work, "push", bare, `${branch}:${branch}`);
  return bare;
}

/**
 * A URL that parses fine and can never be reached. A DNS name would work too,
 * but resolution can sit for the whole 30 s git timeout on a machine with a
 * slow resolver; a file:// path that does not exist fails in milliseconds.
 */
function unreachableUrl(): string {
  return `file://${join(tempDir("znotes-gone-"), "not-a-repo.git")}`;
}

/** a second working copy of the bare, standing in for "the other device" */
async function otherClone(bare: string): Promise<string> {
  const dir = tempDir("znotes-other-");
  await gitOk(dir, "clone", bare, ".");
  await gitOk(dir, "config", "user.name", "other device");
  await gitOk(dir, "config", "user.email", "other@z-notes.invalid");
  await gitOk(dir, "config", "commit.gpgsign", "false");
  return dir;
}

/**
 * A `git` shim first on PATH that records the argv of every git the server
 * spawns and then execs the real binary. This is how "the token is never in
 * argv" becomes observable at all: `ps` sampling would race a 20 ms push.
 * It relies on the phase convention that git is spawned as `["git", …]`
 * (Bun.spawn argv array, resolved through PATH) — an absolute-path spawn
 * would bypass the shim and show up here as an empty log.
 */
function gitShim(): { dir: string; log: string; read: () => string[] } {
  const dir = tempDir("znotes-gitshim-");
  const log = join(dir, "argv.log");
  const real = Bun.which("git");
  if (!real) throw new Error("no git on PATH — the phase-2 gate cannot run");
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 }
  );
  return {
    dir,
    log,
    read: () => (existsSync(log) ? lines(readFileSync(log, "utf8")) : []),
  };
}

/** the debounce a server is actually running with, in ms */
const debounceMs = new WeakMap<TestServer, number>();
const debounceOf = (srv: TestServer) => debounceMs.get(srv) ?? 60_000;

async function serverOn(
  vault: string,
  autoSyncSeconds?: number,
  env?: Record<string, string>
): Promise<TestServer> {
  const srv = await startServer({ vault, env });
  running.push(srv);
  if (autoSyncSeconds != null) {
    const r = await srv.api("PUT", "/api/settings", { git: { autoSyncSeconds } });
    expect(r.status).toBe(200);
    /* the timing tests below key off whatever the server says it will use, so
       that they measure debounce *behaviour* rather than a magic number — the
       number itself is asserted once, on its own, further down */
    const effective = Number(r.body?.settings?.git?.autoSyncSeconds);
    expect(Number.isFinite(effective)).toBe(true);
    expect(effective).toBeGreaterThan(0);
    debounceMs.set(srv, effective * 1000);
  }
  return srv;
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
   sync-status helpers
   ------------------------------------------------------------------ */

const STATES = ["synced", "syncing", "offline", "error"];

const status = (srv: TestServer) => srv.get("/api/sync/status");
const syncNow = (srv: TestServer) => srv.api("POST", "/api/sync/now");
const attach = (srv: TestServer, url: string) => srv.api("POST", "/api/sync/remote", { url });

/** every doc path the tree currently carries */
async function docPaths(srv: TestServer): Promise<string[]> {
  const tree = await srv.get("/api/docs");
  expect(tree.status).toBe(200);
  const out: string[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      if (n.type === "folder") walk(n.children ?? []);
      else out.push(n.path);
    }
  };
  walk(tree.body?.tree ?? []);
  return out.sort();
}

/**
 * Error bodies are `{error, message, ...extra}` — key ORDER included (ADR
 * 0002 / docs/style.md: "tests compare serialized bytes"). Asserting on the
 * parsed object cannot see that, so this reads the wire text.
 */
function expectErrorShape(text: string, ...keys: string[]) {
  const at = keys.map((k) => text.indexOf(`"${k}":`));
  for (let i = 0; i < keys.length; i++) expect(`${keys[i]} present: ${at[i] >= 0}`).toBe(`${keys[i]} present: true`);
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

/**
 * Put the repo in a known-quiet state before a timing measurement: flush
 * whatever the startup scan queued, then let any already-armed debounce timer
 * expire against an unchanged tree (which must produce no commit). Without
 * this, "did a commit appear too early?" would really be measuring when the
 * server booted.
 */
/**
 * Auto-sync is fire-and-forget, so its status converges rather than being
 * readable the instant the commit lands. (Manual sync is different: POST
 * /api/sync/now returns the settled object, and is asserted directly.)
 */
async function waitForState(srv: TestServer, state: string, timeout = 10000): Promise<any> {
  return waitUntil(
    async () => {
      const st = await status(srv);
      return st.status === 200 && st.body?.state === state ? st.body : null;
    },
    { timeout, interval: 120, label: `sync state '${state}'` }
  );
}

async function settle(srv: TestServer, debounce: number): Promise<void> {
  const r = await syncNow(srv);
  expect(r.status).toBe(200);
  await sleep(debounce + 400);
}

/** every documented field of the sync-status object (the sync contract) */
function expectStatusShape(body: any) {
  expect(body && typeof body).toBe("object");
  expect(STATES).toContain(body.state);
  expect(typeof body.branch).toBe("string");
  expect(body.remote === null || typeof body.remote === "string").toBe(true);
  expect(body.lastSyncAt === null || typeof body.lastSyncAt === "string").toBe(true);
  expect(Number.isInteger(body.ahead)).toBe(true);
  expect(Number.isInteger(body.behind)).toBe(true);
  expect(typeof body.message).toBe("string");
}

/* ==================================================================
   1. a vault that is not a git repository
   ================================================================== */

describe("vault without git", () => {
  test(
    "state is offline / 'not a git repository', the app is otherwise untouched, and nothing gets git-init'd",
    async () => {
      const vault = tempVault();
      const srv = await serverOn(vault);

      const st = await status(srv);
      expect(st.status).toBe(200);
      expectStatusShape(st.body);
      expect(st.body.state).toBe("offline");
      expect(String(st.body.message).toLowerCase()).toContain("not a git repository");

      /* the whole point of "offline": every other feature still works */
      const tree = await srv.get("/api/docs");
      expect(tree.status).toBe(200);
      const created = await srv.api("POST", "/api/docs", {
        path: "notes/no-git.md",
        markdown: "# No git\n\nstill writable\n",
      });
      expect(created.status).toBe(201);
      const put = await srv.putDoc("notes/alpha.md", "# Alpha\n\nedited without git\n");
      expect(put.status).toBe(200);
      const back = await srv.doc("notes/alpha.md");
      expect(back.body.markdown).toBe("# Alpha\n\nedited without git\n");

      /* manual sync must answer, not explode, and still not create a repo */
      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("offline");

      /* auto-sync would have had ample time here, too */
      await sleep(500);
      expect(existsSync(join(vault, ".git"))).toBe(false);
    },
    30000
  );
});

/* ==================================================================
   2. repo, no remote → local commits only
   ================================================================== */

describe("git vault without a remote", () => {
  test(
    "manual sync commits the doc, ignores index.db, and reports synced / local only",
    async () => {
      const { vault } = await gitVault();
      const srv = await serverOn(vault, 2);

      const before = await commitCount(vault);
      const markdown = "# Alpha\n\ncommitted by the sync pipeline\n";
      const put = await srv.putDoc("notes/alpha.md", markdown);
      expect(put.status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("synced");
      expect(now.body.remote).toBeNull();
      expect(String(now.body.message).toLowerCase()).toMatch(/local only/);
      expect(now.body.ahead).toBe(0);
      expect(now.body.behind).toBe(0);
      expect(typeof now.body.lastSyncAt).toBe("string");

      /* a commit really happened, and it is the doc we wrote */
      expect(await commitCount(vault)).toBe(before + 1);
      expect(await headFiles(vault)).toContain("notes/alpha.md");
      expect(await showFile(vault, "HEAD", "notes/alpha.md")).toBe(markdown);

      /* auto message: "sync: <ISO timestamp> · <n> file(s): <paths>" */
      const subject = await headSubject(vault);
      expect(subject).toMatch(/^sync: \d{4}-\d{2}-\d{2}T[\d:.]+Z\b/);
      expect(subject).toMatch(/\b\d+ file\(s\)/);
      expect(subject).toContain("alpha.md");

      /* tracked set: settings.toml in, the rebuildable sqlite db out */
      const tracked = await lsFiles(vault);
      expect(tracked).toContain("notes/alpha.md");
      expect(tracked).toContain(".znotes/settings.toml");
      expect(tracked.filter((f) => f.includes("index.db"))).toEqual([]);
      expect(await headFiles(vault)).not.toContain(".znotes/index.db");

      /* …and the exclusion is a real ignore rule, not luck. It lives in
         .git/info/exclude, which is per-clone: it can never be staged (so it
         cannot wedge a pull the way an untracked .gitignore does) and it applies
         whatever the user's own .gitignore happens to say. */
      expect(await isIgnored(vault, ".znotes/index.db")).toBe(true);
      expect(readFileSync(join(vault, ".git", "info", "exclude"), "utf8")).toContain(".znotes/index.db");
      /* nothing untracked is left lying in the working tree */
      expect(lines(await gitOk(vault, "status", "--porcelain"))).toEqual([]);

      /* GET agrees with what POST returned */
      const st = await status(srv);
      expect(st.body.state).toBe("synced");
      expect(String(st.body.message).toLowerCase()).toMatch(/local only/);
    },
    30000
  );

  /* The allowlist is the whole tracked-set claim: visible UTF-8 files with an
     explicit extension are app-owned, while hidden and undecodable files are
     still outside it. This asserts the boundary with junk of every shape. */
  test(
    "the tracked set includes visible explicit-extension UTF-8 files, but not hidden or binary files",
    async () => {
      const { vault } = await gitVault({ seed: { "a.md": "# A\n" } });
      writeVaultFile(vault, ".DS_Store", " junk");
      writeVaultFile(vault, "attachment.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]));
      writeVaultFile(vault, "notes.txt", "not markdown\n");
      writeVaultFile(vault, "notes/alpha.md.conflict", "# conflict copy\n");
      writeVaultFile(vault, ".obsidian/workspace.md", "# hidden dir\n");
      writeVaultFile(vault, ".znotes/vault.pub", "age1exampleRecipient\n");
      writeVaultFile(vault, ".znotes/identity.age", "-----BEGIN AGE ENCRYPTED FILE-----\n");

      const srv = await serverOn(vault, 2);
      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("synced");

      expect(await lsFiles(vault)).toEqual([
        ".znotes/identity.age",
        ".znotes/settings.toml",
        ".znotes/vault.pub",
        "a.md",
        "notes.txt",
        "notes/alpha.md.conflict",
      ]);
    },
    30000
  );

  /* Deletions are staged only by the ls-files union in stage(); removing that
     line leaves every other assertion in this file green while deleted notes
     stay in git forever. Renames are the same machinery seen from the side. */
  test(
    "a note deleted on disk is committed as a deletion, and a rename lands as a rename",
    async () => {
      const { vault } = await gitVault();
      const srv = await serverOn(vault, 2);
      await settle(srv, debounceOf(srv));

      rmSync(join(vault, "notes/beta.md"));
      renameSync(join(vault, "inbox.md"), join(vault, "inbox-renamed.md"));

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("synced");

      const tracked = await lsFiles(vault);
      expect(tracked).not.toContain("notes/beta.md");
      expect(tracked).not.toContain("inbox.md");
      expect(tracked).toContain("inbox-renamed.md");

      const nameStatus = lines(await gitOk(vault, "show", "--name-status", "--pretty=format:", "HEAD"));
      expect(nameStatus.some((l) => /^D\s+notes\/beta\.md$/.test(l))).toBe(true);
      expect(
        nameStatus.some((l) => /^(R\d+\s+inbox\.md\s+inbox-renamed\.md|A\s+inbox-renamed\.md)$/.test(l))
      ).toBe(true);
    },
    30000
  );

  test(
    "deleted doc identity comes from HEAD UTF-8 bytes, not diff attributes or NUL heuristics",
    async () => {
      const nulDoc = new TextEncoder().encode("# NUL doc\n\nleft\0right\n");
      const invalidBinary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
      const { vault } = await gitVault({
        seed: {
          ".gitattributes": "*.txt binary\n*.png text\n",
          "nul.txt": nulDoc,
          "forced.txt": "# Forced binary attribute\n\nstill UTF-8\n",
          "asset.png": invalidBinary,
        },
      });
      const srv = await serverOn(vault, 2);
      await settle(srv, debounceOf(srv));

      for (const path of ["nul.txt", "forced.txt", "asset.png"]) rmSync(join(vault, path));

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("synced");

      const tracked = await lsFiles(vault);
      expect(tracked).not.toContain("nul.txt");
      expect(tracked).not.toContain("forced.txt");
      expect(tracked).toContain("asset.png");

      const changed = lines(await gitOk(vault, "show", "--name-status", "--pretty=format:", "HEAD"));
      expect(changed).toContain("D\tnul.txt");
      expect(changed).toContain("D\tforced.txt");
      expect(changed).not.toContain("D\tasset.png");
      expect(lines(await gitOk(vault, "status", "--porcelain"))).toContain("D asset.png");
    },
    30000
  );

  test(
    "a UTF-8 doc staged before its first commit is removed from the index when deleted on disk",
    async () => {
      const { vault } = await gitVault({ seed: { "base.md": "# Base\n" } });
      writeVaultFile(vault, "staged.txt", "# Staged only\n\nvalid UTF-8\n");
      await gitOk(vault, "add", "staged.txt");
      rmSync(join(vault, "staged.txt"));

      const srv = await serverOn(vault, 2);
      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("synced");

      expect(await lsFiles(vault)).not.toContain("staged.txt");
      expect(lines(await gitOk(vault, "status", "--porcelain"))).not.toContain("A staged.txt");
      const absent = await git(vault, "cat-file", "-e", "HEAD:staged.txt");
      expect(absent.code).not.toBe(0);
    },
    30000
  );
});

/* ==================================================================
   3. repo with a bare origin → push + SSE transitions
   ================================================================== */

describe("git vault with an origin", () => {
  test(
    "manual sync pushes, reports 0/0 with a lastSyncAt, and streams synced→syncing→synced",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      const sse = await srv.sse();

      try {
        await sse.waitFor("hello", { timeout: 5000 });

        const markdown = "# Beta\n\npushed to origin\n";
        expect((await srv.putDoc("notes/beta.md", markdown)).status).toBe(200);

        const mark = sse.mark();
        const t0 = Date.now();
        const now = await syncNow(srv);
        expect(now.status).toBe(200);
        expectStatusShape(now.body);
        expect(now.body.state).toBe("synced");
        expect(now.body.ahead).toBe(0);
        expect(now.body.behind).toBe(0);
        expect(typeof now.body.remote).toBe("string");
        expect(String(now.body.remote).length).toBeGreaterThan(0);
        const lastSyncAt = Date.parse(String(now.body.lastSyncAt));
        expect(Number.isFinite(lastSyncAt)).toBe(true);
        expect(lastSyncAt).toBeGreaterThanOrEqual(t0 - 2000);
        expect(lastSyncAt).toBeLessThanOrEqual(Date.now() + 2000);

        /* the bare really received it */
        const bareHead = (await gitOk(bare!, "rev-parse", "main")).trim();
        const localHead = (await gitOk(vault, "rev-parse", "HEAD")).trim();
        expect(bareHead).toBe(localHead);
        expect(await showFile(bare!, "main", "notes/beta.md")).toBe(markdown);

        /* every transition is on the wire, and only the two that happened */
        const events = await sse.collect(500, mark, "sync-status");
        const states = events.map((e) => e.data?.state);
        expect(states).toEqual(["syncing", "synced"]);
        for (const e of events) expectStatusShape(e.data);
      } finally {
        sse.close();
      }
    },
    30000
  );

  /* single-flight is not directly observable from outside, so this measures its
     consequences: three racing syncs must not double-commit, must not trip over
     each other's index.lock, and must each answer with a settled status. */
  test(
    "concurrent Sync now calls never double-commit, error, or leave an index.lock behind",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);

      expect((await srv.putDoc("notes/gamma.md", "# Gamma\n\nracing\n")).status).toBe(200);
      const before = await commitCount(vault);

      const results = await Promise.all([syncNow(srv), syncNow(srv), syncNow(srv)]);
      for (const r of results) {
        expect(r.status).toBe(200);
        expectStatusShape(r.body);
        /* every caller gets the settled result, not a half-finished "syncing"
           and not someone else's collision */
        expect(r.body.state).toBe("synced");
      }

      /* one pending change ⇒ exactly one commit, however many syncs raced */
      await sleep(500);
      expect(await commitCount(vault)).toBe(before + 1);
      expect(existsSync(join(vault, ".git", "index.lock"))).toBe(false);

      await waitForState(srv, "synced");
      expect((await gitOk(bare!, "rev-parse", "main")).trim()).toBe(
        (await gitOk(vault, "rev-parse", "HEAD")).trim()
      );
    },
    30000
  );
});

/* ==================================================================
   4. debounced auto-sync
   ================================================================== */

describe("auto-sync debounce", () => {
  /* the interval defaults to 60 s and is live-reloadable, and small values are
     what makes this suite (and hand-testing) practical — a hidden floor would
     silently ignore what the user configured. */
  test(
    "git.autoSyncSeconds defaults to 60 and round-trips exactly as configured",
    async () => {
      const { vault } = await gitVault();
      const srv = await startServer({ vault });
      running.push(srv);

      const initial = await srv.get("/api/settings");
      expect(initial.status).toBe(200);
      expect(initial.body.settings.git.autoSyncSeconds).toBe(60);

      for (const seconds of [2, 30]) {
        const put = await srv.api("PUT", "/api/settings", { git: { autoSyncSeconds: seconds } });
        expect(put.status).toBe(200);
        expect(put.body.settings.git.autoSyncSeconds).toBe(seconds);
        const back = await srv.get("/api/settings");
        expect(back.body.settings.git.autoSyncSeconds).toBe(seconds);
      }
    },
    30000
  );

  test(
    "a save commits and pushes only after git.autoSyncSeconds of quiet",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      const d = debounceOf(srv);
      await settle(srv, d);

      const before = await commitCount(vault);
      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\ndebounced\n")).status).toBe(200);
      const t0 = Date.now();

      /* well inside the window: committing here would defeat batching entirely */
      await sleep(Math.max(0, d * 0.65 - (Date.now() - t0)));
      expect(await commitCount(vault)).toBe(before);

      await waitUntil(async () => (await commitCount(vault)) === before + 1, {
        timeout: d + 3000 - (Date.now() - t0),
        interval: 100,
        label: "the debounced auto-commit",
      });
      expect(await headFiles(vault)).toContain("notes/alpha.md");

      /* auto-sync pushes too, when an origin exists */
      await waitUntil(
        async () =>
          (await gitOk(bare!, "rev-parse", "main")).trim() ===
          (await gitOk(vault, "rev-parse", "HEAD")).trim(),
        { timeout: 6000, interval: 150, label: "the auto push to origin" }
      );

      const st = await waitForState(srv, "synced");
      expect(st.ahead).toBe(0);
      expect(st.behind).toBe(0);
    },
    40000
  );

  test(
    "three rapid saves collapse into ONE commit carrying all three files",
    async () => {
      const { vault } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      const d = debounceOf(srv);
      await settle(srv, d);

      const before = await commitCount(vault);
      const puts = await Promise.all([
        srv.putDoc("notes/alpha.md", "# Alpha\n\nburst 1\n"),
        srv.putDoc("notes/beta.md", "# Beta\n\nburst 2\n"),
        srv.putDoc("notes/gamma.md", "# Gamma\n\nburst 3\n"),
      ]);
      for (const p of puts) expect(p.status).toBe(200);

      await waitUntil(async () => (await commitCount(vault)) > before, {
        timeout: d + 6000,
        interval: 100,
        label: "the burst commit",
      });

      /* another debounce window and a half: a second commit would have landed */
      await sleep(d * 1.5);
      expect(await commitCount(vault)).toBe(before + 1);

      /* settle() above already committed .znotes/settings.toml, and z-notes
         writes no working-tree .gitignore at all, so the burst commit carries
         these three files and nothing else — an equality, not a floor */
      expect(await headFiles(vault)).toEqual(["notes/alpha.md", "notes/beta.md", "notes/gamma.md"]);

      const subject = await headSubject(vault);
      const counted = /(\d+) file\(s\)/.exec(subject);
      expect(counted).not.toBeNull();
      expect(Number(counted![1])).toBe(3);
    },
    40000
  );
});

/* ==================================================================
   5. non-fast-forward push → pull --rebase → push
   ================================================================== */

describe("diverged origin", () => {
  test(
    "a rejected push is rebased and retried, and origin ends with both changes in linear history",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      /* the other device commits and pushes first */
      const other = await otherClone(bare!);
      const remoteMarkdown = "# Inbox\n\nwritten on the other device\n";
      await Bun.write(join(other, "inbox.md"), remoteMarkdown);
      await gitOk(other, "add", "inbox.md");
      await gitOk(other, "commit", "-m", "other: inbox");
      await gitOk(other, "push", "origin", "main");

      /* meanwhile this device edits a different file and syncs */
      const srv = await serverOn(vault, 2);
      const localMarkdown = "# Beta\n\nwritten on this device\n";
      expect((await srv.putDoc("notes/beta.md", localMarkdown)).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("synced");
      expect(now.body.ahead).toBe(0);
      expect(now.body.behind).toBe(0);

      /* both sides survived, in the bare */
      expect(await showFile(bare!, "main", "inbox.md")).toBe(remoteMarkdown);
      expect(await showFile(bare!, "main", "notes/beta.md")).toBe(localMarkdown);

      /* rebase, not merge: history stays linear */
      const merges = lines(await gitOk(bare!, "rev-list", "--merges", "main"));
      expect(merges).toEqual([]);
      const subjects = lines(await gitOk(bare!, "log", "--pretty=format:%s", "main"));
      expect(subjects).toContain("other: inbox");
      expect(subjects.some((s) => s.startsWith("sync: "))).toBe(true);

      /* and locally we are exactly the bare */
      expect((await gitOk(vault, "rev-parse", "HEAD")).trim()).toBe(
        (await gitOk(bare!, "rev-parse", "main")).trim()
      );
      /* nothing left dirty by the rebase */
      expect(lines(await gitOk(vault, "status", "--porcelain")).filter((l) => /^(UU|AA|DD)/.test(l))).toEqual([]);
    },
    40000
  );
});

/* ==================================================================
   6. a real conflict
   ================================================================== */

describe("rebase conflict", () => {
  test(
    "the rebase is aborted cleanly, both versions survive, editing keeps working, and a later sync retries",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      /* the other device rewrites the same line we are about to rewrite */
      const other = await otherClone(bare!);
      const remoteMarkdown = "# Alpha\n\nREMOTE VERSION of the contested line\n";
      await Bun.write(join(other, "notes/alpha.md"), remoteMarkdown);
      await gitOk(other, "add", "notes/alpha.md");
      await gitOk(other, "commit", "-m", "other: alpha");
      await gitOk(other, "push", "origin", "main");

      const srv = await serverOn(vault, 2);
      const localMarkdown = "# Alpha\n\nLOCAL VERSION of the contested line\n";
      expect((await srv.putDoc("notes/alpha.md", localMarkdown)).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("error");
      /* the message has to name the file — it is the whole recovery affordance */
      expect(now.body.message).toContain("alpha.md");
      /* …and it is published to every client, so it carries no absolute path */
      expect(now.body.message).not.toContain(vault);

      /* the repo is NOT parked mid-rebase */
      expect(existsSync(join(vault, ".git", "rebase-merge"))).toBe(false);
      expect(existsSync(join(vault, ".git", "rebase-apply"))).toBe(false);
      const porcelain = lines(await gitOk(vault, "status", "--porcelain"));
      expect(porcelain.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l))).toEqual([]);

      /* neither side was destroyed: ours on disk and in HEAD, theirs in the bare */
      expect(readFileSync(join(vault, "notes/alpha.md"), "utf8")).toBe(localMarkdown);
      expect((await srv.doc("notes/alpha.md")).body.markdown).toBe(localMarkdown);
      expect(await showFile(vault, "HEAD", "notes/alpha.md")).toBe(localMarkdown);
      expect(await showFile(bare!, "main", "notes/alpha.md")).toBe(remoteMarkdown);
      /* no conflict markers were written into the note */
      expect(readFileSync(join(vault, "notes/alpha.md"), "utf8")).not.toContain("<<<<<<<");

      /* editing continues while the conflict stands */
      const after = "# Gamma\n\nwritten after the conflict\n";
      expect((await srv.putDoc("notes/gamma.md", after)).status).toBe(200);
      expect((await srv.doc("notes/gamma.md")).body.markdown).toBe(after);

      /* and Sync now retries from scratch instead of wedging */
      const retry = await syncNow(srv);
      expect(retry.status).toBe(200);
      expectStatusShape(retry.body);
      expect(retry.body.state).toBe("error");
      expect(existsSync(join(vault, ".git", "rebase-merge"))).toBe(false);
      expect(existsSync(join(vault, ".git", "rebase-apply"))).toBe(false);
      /* the new note was still committed locally — work is never held hostage */
      const localSubjects = lines(await gitOk(vault, "log", "--pretty=format:%s", "HEAD"));
      expect(localSubjects.filter((s) => s.startsWith("sync: ")).length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(join(vault, "notes/gamma.md"), "utf8")).toBe(after);
    },
    40000
  );
});

/* ==================================================================
   7. token custody
   ================================================================== */

/** every file in the vault except the sqlite db (which is where the token lives) */
function vaultFilesExceptDb(vault: string): string[] {
  const glob = new Bun.Glob("**/*");
  const out: string[] = [];
  for (const rel of glob.scanSync({ cwd: vault, dot: true, onlyFiles: true, followSymlinks: false })) {
    if (/(^|\/)index\.db(-wal|-shm|-journal)?$/.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

describe("token custody", () => {
  test(
    "a failing https sync never writes the token anywhere observable, and fails fast instead of hanging",
    async () => {
      const TOKEN = "ghp_zn0tesFAKEt0kenCUSTODY9x7q2vB";
      /* nothing listens on port 1 → connection refused immediately: the sync
         must fail on its own, not on GIT_TERMINAL_PROMPT hanging forever */
      const REMOTE = "https://127.0.0.1:1/z/vault.git";
      const { vault } = await gitVault({ origin: REMOTE });
      const shim = gitShim();
      const srv = await serverOn(vault, 2, { PATH: `${shim.dir}:${process.env.PATH ?? ""}` });
      const sse = await srv.sse();

      try {
        await sse.waitFor("hello", { timeout: 5000 });

        const put = await srv.api("PUT", "/api/settings", { git: { token: TOKEN } });
        expect(put.status).toBe(200);
        expect(put.text).not.toContain(TOKEN); // masked on the way back out

        expect((await srv.putDoc("notes/beta.md", "# Beta\n\nwill try to push\n")).status).toBe(200);

        const t0 = Date.now();
        const now = await syncNow(srv);
        const elapsed = Date.now() - t0;
        expect(now.status).toBe(200);
        expectStatusShape(now.body);
        /* the fixture IS a git repo — only the remote is dead, so the one
           correct answer is "error". Accepting "offline" here would also accept
           a regression that stops recognising the repo, under which the sync
           never runs and every custody assertion below passes vacuously. */
        expect(now.body.state).toBe("error");
        expect(String(now.body.message)).toMatch(/could not|unable|refused|fail|timed out/i);
        expect(elapsed).toBeLessThan(30000); // a credential prompt would sit forever

        /* the local commit still happened — a dead remote is not lost work */
        expect(await headFiles(vault)).toContain("notes/beta.md");

        /* ---- the token appears nowhere ---- */
        expect(now.text).not.toContain(TOKEN);
        expect(String(now.body.message)).not.toContain(TOKEN);
        expect(String(now.body.remote ?? "")).not.toContain(TOKEN);
        expect(String(now.body.remote ?? "")).not.toContain("@"); // no user:pass@host either

        const st = await status(srv);
        expect(st.text).not.toContain(TOKEN);
        const settings = await srv.get("/api/settings");
        expect(settings.text).not.toContain(TOKEN);

        await sleep(300);
        expect(sse.rawText).not.toContain(TOKEN);
        expect(srv.stdoutLines.join("\n")).not.toContain(TOKEN);
        expect(srv.stderrLines.join("\n")).not.toContain(TOKEN);

        /* argv of every git the server ran — a token there is world-readable
           in `ps`, which is exactly why it has to travel in env instead */
        const argv = shim.read();
        expect(argv.length).toBeGreaterThan(0);
        expect(argv.some((l) => /(^| )push( |$)/.test(l))).toBe(true);
        expect(argv.filter((l) => l.includes(TOKEN))).toEqual([]);

        const gitConfig = readFileSync(join(vault, ".git", "config"), "utf8");
        expect(gitConfig).not.toContain(TOKEN);
        expect(gitConfig).toContain(REMOTE); // the remote URL is untouched, not rewritten

        const leaked = vaultFilesExceptDb(vault).filter((rel) =>
          readFileSync(join(vault, rel)).toString("latin1").includes(TOKEN)
        );
        expect(leaked).toEqual([]);

        /* the server is alive and the app still works after the failure */
        expect((await srv.doc("notes/beta.md")).status).toBe(200);
      } finally {
        sse.close();
      }
    },
    40000
  );
});

/* ==================================================================
   8. external edits
   ================================================================== */

describe("external edits", () => {
  test(
    "a file written straight into the vault is committed once the debounce settles",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      const d = debounceOf(srv);
      await settle(srv, d);

      const before = await commitCount(vault);
      const markdown = "# Vim\n\nwritten outside the app entirely\n";
      writeVaultFile(vault, "notes/from-vim.md", markdown);

      /* the vault is the source of truth; git mirrors it, so this must be
         committed without anyone touching the API */
      await waitUntil(async () => (await commitCount(vault)) === before + 1, {
        timeout: d + 8000,
        interval: 150,
        label: "the auto-commit of an external edit",
      });
      expect(await headFiles(vault)).toContain("notes/from-vim.md");
      expect(await showFile(vault, "HEAD", "notes/from-vim.md")).toBe(markdown);

      await waitUntil(
        async () =>
          (await gitOk(bare!, "rev-parse", "main")).trim() ===
          (await gitOk(vault, "rev-parse", "HEAD")).trim(),
        { timeout: 6000, interval: 150, label: "the push of an external edit" }
      );

      const st = await waitForState(srv, "synced");
      expect(st.ahead).toBe(0);
      expect(st.behind).toBe(0);
    },
    40000
  );
});

/* ==================================================================
   9. a repo the USER is in the middle of

   the app never auto-destroys either side. A vault parked
   mid-merge/mid-rebase, or sitting on a detached HEAD, is a repo whose next
   `git add`/`commit` belongs to the user and to nobody else — staging over a
   conflicted index marks every conflict RESOLVED with its marker text as the
   content, and a commit made on a detached HEAD is pushed nowhere and is
   deleted by the next checkout.
   ================================================================== */

describe("a repo the user is in the middle of", () => {
  test(
    "a merge left conflicted in the vault is never completed, committed or pushed by the app",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      const other = await otherClone(bare!);
      const remoteMarkdown = "# Alpha\n\nREMOTE VERSION\n";
      await Bun.write(join(other, "notes/alpha.md"), remoteMarkdown);
      await gitOk(other, "add", "notes/alpha.md");
      await gitOk(other, "commit", "-m", "other: alpha");
      await gitOk(other, "push", "origin", "main");

      /* exactly what the app's own error message tells the user to do:
         "resolve in the vault repo" */
      writeVaultFile(vault, "notes/alpha.md", "# Alpha\n\nLOCAL VERSION\n");
      await gitOk(vault, "add", "notes/alpha.md");
      await gitOk(vault, "commit", "-m", "local: alpha");
      const pull = await git(vault, "pull", "--no-rebase", "origin", "main");
      expect(pull.code).not.toBe(0);
      expect(existsSync(join(vault, ".git", "MERGE_HEAD"))).toBe(true);
      expect(readFileSync(join(vault, "notes/alpha.md"), "utf8")).toContain("<<<<<<<");

      const srv = await serverOn(vault, 2);
      const headBefore = (await gitOk(vault, "rev-parse", "HEAD")).trim();
      const bareBefore = (await gitOk(bare!, "rev-parse", "main")).trim();

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("error");
      expect(now.body.message).toContain("merge");
      expect(now.body.message).toContain("notes/alpha.md");
      expect(now.body.message).not.toContain(vault);

      /* the merge is still the user's: not completed, not committed, not pushed */
      expect(existsSync(join(vault, ".git", "MERGE_HEAD"))).toBe(true);
      expect((await gitOk(vault, "rev-parse", "HEAD")).trim()).toBe(headBefore);
      expect((await gitOk(bare!, "rev-parse", "main")).trim()).toBe(bareBefore);
      expect(await showFile(bare!, "main", "notes/alpha.md")).toBe(remoteMarkdown);
      expect(await showFile(vault, "HEAD", "notes/alpha.md")).not.toContain("<<<<<<<");

      /* auto-sync gets the same answer, however long it waits */
      await sleep(debounceOf(srv) + 1500);
      expect(existsSync(join(vault, ".git", "MERGE_HEAD"))).toBe(true);
      expect((await gitOk(vault, "rev-parse", "HEAD")).trim()).toBe(headBefore);

      /* and the app is still a working notes app while the merge stands */
      expect((await srv.putDoc("notes/gamma.md", "# Gamma\n\nstill writable\n")).status).toBe(200);

      /* once the user finishes their merge, sync resumes on its own */
      writeVaultFile(vault, "notes/alpha.md", "# Alpha\n\nRESOLVED BY THE USER\n");
      await gitOk(vault, "add", "notes/alpha.md");
      await gitOk(vault, "commit", "--no-edit");
      const retry = await syncNow(srv);
      expect(retry.body.state).toBe("synced");
      expect(await showFile(bare!, "main", "notes/alpha.md")).toBe("# Alpha\n\nRESOLVED BY THE USER\n");
    },
    60000
  );

  test(
    "a rebase the user left in progress is never aborted, so a note saved meanwhile is not hard-reset away",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      const other = await otherClone(bare!);
      await Bun.write(join(other, "inbox.md"), "# Inbox\n\nREMOTE VERSION\n");
      await gitOk(other, "add", "inbox.md");
      await gitOk(other, "commit", "-m", "other: inbox");
      await gitOk(other, "push", "origin", "main");

      writeVaultFile(vault, "inbox.md", "# Inbox\n\nlocal change\n");
      await gitOk(vault, "add", "inbox.md");
      await gitOk(vault, "commit", "-m", "local: inbox");
      const pull = await git(vault, "pull", "--rebase", "origin", "main");
      expect(pull.code).not.toBe(0);
      expect(existsSync(join(vault, ".git", "rebase-merge"))).toBe(true);

      const srv = await serverOn(vault, 2);

      /* the user keeps working, which sync is never allowed to block */
      const doc = await srv.doc("inbox.md");
      expect(doc.status).toBe(200);
      const typed = "# Inbox\n\nIMPORTANT NOTE THE USER JUST TYPED\n";
      expect((await srv.putDoc("inbox.md", typed, doc.body.rev)).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("error");
      expect(now.body.message).toContain("rebase");

      /* `rebase --abort` here would hard-reset the working tree to ORIG_HEAD
         and take the note the app just acknowledged with 200 OK with it */
      expect(readFileSync(join(vault, "inbox.md"), "utf8")).toBe(typed);
      expect((await srv.doc("inbox.md")).body.markdown).toBe(typed);
      expect(existsSync(join(vault, ".git", "rebase-merge"))).toBe(true);
    },
    60000
  );

  test(
    "a detached HEAD is refused instead of being committed onto and reported as synced",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      await gitOk(vault, "checkout", "--detach", "HEAD");

      const srv = await serverOn(vault, 2);
      const before = await commitCount(vault);
      const markdown = "# Alpha\n\nwritten while detached\n";
      expect((await srv.putDoc("notes/alpha.md", markdown)).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("error");
      expect(now.body.message).toContain("detached HEAD");

      /* nothing was committed onto the detached HEAD, so `git checkout main`
         cannot silently delete the note; it is still on disk, uncommitted */
      expect(await commitCount(vault)).toBe(before);
      expect(readFileSync(join(vault, "notes/alpha.md"), "utf8")).toBe(markdown);
      expect((await gitOk(bare!, "rev-parse", "main")).trim()).toBe(
        (await gitOk(vault, "rev-parse", "HEAD")).trim()
      );

      /* back on a branch, the same note syncs normally */
      await gitOk(vault, "checkout", "main");
      const retry = await syncNow(srv);
      expect(retry.body.state).toBe("synced");
      expect(await showFile(bare!, "main", "notes/alpha.md")).toBe(markdown);
    },
    40000
  );
});

/* ==================================================================
   10. ignore custody — the sqlite db holds the credentials
   ================================================================== */

describe("ignore custody", () => {
  test(
    "a pre-existing user .gitignore is left alone, and index.db is still unstageable by a plain `git add -A`",
    async () => {
      const { vault } = await gitVault({ seed: { ...SEED, ".gitignore": "*.log\n" } });
      const srv = await serverOn(vault, 2);

      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\nwith a user .gitignore\n")).status).toBe(200);
      const now = await syncNow(srv);
      expect(now.body.state).toBe("synced");

      /* the user's file is theirs — never rewritten, never appended to */
      expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("*.log\n");
      expect(await isIgnored(vault, ".znotes/index.db")).toBe(true);

      /* the scenario that leaked the token: the user runs git in their own
         vault, exactly as the app's conflict message tells them to */
      await gitOk(vault, "add", "-A");
      const staged = lines(await gitOk(vault, "diff", "--cached", "--name-only"));
      expect(staged.filter((f) => f.includes("index.db"))).toEqual([]);
      await gitOk(vault, "reset", "-q");

      /* and if it ever did get committed, the next sync untracks it in place */
      await gitOk(vault, "add", "-f", ".znotes/index.db");
      await gitOk(vault, "commit", "-m", "user: oops");
      expect(await lsFiles(vault)).toContain(".znotes/index.db");

      expect((await srv.putDoc("notes/beta.md", "# Beta\n\nafter the oops\n")).status).toBe(200);
      const after = await syncNow(srv);
      expect(after.body.state).toBe("synced");
      expect(await lsFiles(vault)).not.toContain(".znotes/index.db");
      expect(existsSync(join(vault, ".znotes", "index.db"))).toBe(true); // untracked, not deleted
    },
    40000
  );

  test(
    "a user .gitignore covering a directory of notes does not wedge the pipeline",
    async () => {
      const { vault } = await gitVault({ seed: { ...SEED, ".gitignore": "archive/\n" } });
      writeVaultFile(vault, "archive/old.md", "# Archived\n\ndeliberately ignored\n");
      const srv = await serverOn(vault, 2);

      /* `git add` EXITS 1 on an explicitly named ignored pathspec, which used to
         fail the whole run — no commit, ever again, on any trigger */
      for (const body of ["one", "two"]) {
        expect((await srv.putDoc("notes/alpha.md", `# Alpha\n\n${body}\n`)).status).toBe(200);
        const r = await syncNow(srv);
        expect(r.body.state).toBe("synced");
      }
      expect(await showFile(vault, "HEAD", "notes/alpha.md")).toBe("# Alpha\n\ntwo\n");
      expect(await lsFiles(vault)).not.toContain("archive/old.md");
      expect(existsSync(join(vault, "archive", "old.md"))).toBe(true);
    },
    40000
  );

  test(
    "a .gitignore committed on another device pulls in cleanly instead of wedging every future sync",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      const other = await otherClone(bare!);
      await Bun.write(join(other, ".gitignore"), "*.log\n");
      await gitOk(other, "add", ".gitignore");
      await gitOk(other, "commit", "-m", "other: gitignore");
      await gitOk(other, "push", "origin", "main");

      const srv = await serverOn(vault, 2);
      const markdown = "# Alpha\n\nlocal while origin gained a .gitignore\n";
      expect((await srv.putDoc("notes/alpha.md", markdown)).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("synced");
      expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("*.log\n");
      expect(await showFile(bare!, "main", "notes/alpha.md")).toBe(markdown);
    },
    40000
  );
});

/* ==================================================================
   11. preconditions the rebase retry cannot fix by itself
   ================================================================== */

describe("blocked rebase", () => {
  test(
    "a dirty tracked file outside the allowlist is named, not surfaced as raw git noise, and nothing is reset",
    async () => {
      const { vault, bare } = await gitVault({
        origin: true,
        seed: { ...SEED, README: "the original readme\n" },
      });

      const other = await otherClone(bare!);
      const remote = "# Zulu\n\nfrom the other device\n";
      await Bun.write(join(other, "notes/zulu.md"), remote);
      await gitOk(other, "add", "notes/zulu.md");
      await gitOk(other, "commit", "-m", "other: zulu");
      await gitOk(other, "push", "origin", "main");

      const srv = await serverOn(vault, 2);
      const edited = "the readme, edited by hand and not yet committed\n";
      writeVaultFile(vault, "README", edited);
      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\nlocal\n")).status).toBe(200);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("error");
      /* the message is the recovery affordance: it has to name the file, and it
         may not carry an absolute path or the raw remote URL */
      expect(now.body.message).toContain("README");
      expect(now.body.message).not.toContain(vault);
      expect(now.body.message).not.toMatch(/^From\b/);

      /* the user's uncommitted work is untouched — no rebase, so no abort */
      expect(readFileSync(join(vault, "README"), "utf8")).toBe(edited);
      const localSubjects = lines(await gitOk(vault, "log", "--pretty=format:%s", "HEAD"));
      expect(localSubjects.some((s) => s.startsWith("sync: "))).toBe(true);

      /* doing what the message says clears it */
      await gitOk(vault, "add", "README");
      await gitOk(vault, "commit", "-m", "user: readme");
      const retry = await syncNow(srv);
      expect(retry.body.state).toBe("synced");
      expect(await showFile(bare!, "main", "notes/zulu.md")).toBe(remote);
      expect(await showFile(bare!, "main", "README")).toBe(edited);
    },
    40000
  );
});

/* ==================================================================
   12. the configured branch is not decoration
   ================================================================== */

describe("git.branch", () => {
  test(
    "a vault checked out on a different branch is reported, not silently pushed as the checked-out one",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      await settle(srv, debounceOf(srv));

      expect((await srv.api("PUT", "/api/settings", { git: { branch: "release" } })).status).toBe(200);
      expect((await srv.putDoc("notes/alpha.md", "# Alpha\n\nfor release?\n")).status).toBe(200);

      const before = await commitCount(vault);
      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);
      expect(now.body.state).toBe("error");
      expect(now.body.message).toContain("release");
      expect(now.body.message).toContain("main");

      /* work is committed locally — it is only the push that waits */
      expect(await commitCount(vault)).toBeGreaterThan(before);
      expect(lines(await gitOk(bare!, "branch", "--list"))).not.toContain("release");
      expect((await gitOk(bare!, "rev-parse", "main")).trim()).not.toBe(
        (await gitOk(vault, "rev-parse", "HEAD")).trim()
      );

      /* agreeing again resumes the push */
      expect((await srv.api("PUT", "/api/settings", { git: { branch: "main" } })).status).toBe(200);
      const retry = await syncNow(srv);
      expect(retry.body.state).toBe("synced");
      expect((await gitOk(bare!, "rev-parse", "main")).trim()).toBe(
        (await gitOk(vault, "rev-parse", "HEAD")).trim()
      );
    },
    40000
  );
});

/* ==================================================================
   13. a credential pasted into the committed settings.toml
   ================================================================== */

describe("settings.toml credential custody", () => {
  test(
    "a token hand-written into settings.toml is absorbed into sqlite and never committed or pushed",
    async () => {
      const TOKEN = "ghp_znotesLEAKCANARY0123456789abcdefXYZ";
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      await settle(srv, debounceOf(srv));

      const file = join(vault, ".znotes", "settings.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace("[git]", `[git]\ntoken = "${TOKEN}"`));
      expect(readFileSync(file, "utf8")).toContain(TOKEN);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.text).not.toContain(TOKEN);
      expect(["synced", "error"]).toContain(now.body.state);

      /* off disk, out of this commit, out of the whole history on both sides */
      expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
      expect(await showFile(vault, "HEAD", ".znotes/settings.toml")).not.toContain(TOKEN);
      expect(lines(await gitOk(vault, "log", "--all", "-S", TOKEN, "--pretty=format:%H"))).toEqual([]);
      expect(lines(await gitOk(bare!, "log", "--all", "-S", TOKEN, "--pretty=format:%H"))).toEqual([]);

      /* it was not thrown away either: it moved to sqlite and comes back masked */
      const settings = await srv.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.text).not.toContain(TOKEN);
      expect(String(settings.body.settings.git.tokenMasked).length).toBeGreaterThan(0);
      expect(settings.body.settings.git.token).toBeUndefined();
    },
    40000
  );

  /* `settings.toml` can carry `[terminal] password = "…"` to bootstrap a fresh
     install — absorbed, hashed, stripped from the file, never committed. The
     pre-staging canary used to look only for token/apiKey, so the bootstrap
     line this documents was committed and PUSHED in plaintext —
     irreversible once a remote exists. Both halves are pinned here: the canary
     has to NOTICE the line (git.ts) and the absorb it calls has to be able to
     REMOVE it (settings.ts), or sync stops forever with no way out but an
     editor. */
  test(
    "a terminal password hand-written into settings.toml mid-session is absorbed, stripped and never committed or pushed",
    async () => {
      const PASSWORD = "znotes-terminal-LEAKCANARY-9876";
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      /* boot the settings snapshot the way a browser does, so this measures the
         MID-SESSION paste rather than the boot-time absorb */
      expect((await srv.get("/api/settings")).status).toBe(200);
      await settle(srv, debounceOf(srv));

      const file = join(vault, ".znotes", "settings.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace("[terminal]", `[terminal]\npassword = "${PASSWORD}"`));
      expect(readFileSync(file, "utf8")).toContain(PASSWORD);

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.text).not.toContain(PASSWORD);
      /* not merely "never committed": sync still COMPLETES. A canary that
         notices the line but cannot strip it would wedge the pipeline here. */
      expect(now.body.state).toBe("synced");

      expect(readFileSync(file, "utf8")).not.toContain(PASSWORD);
      expect(await showFile(vault, "HEAD", ".znotes/settings.toml")).not.toContain(PASSWORD);
      expect(lines(await gitOk(vault, "log", "--all", "-S", PASSWORD, "--pretty=format:%H"))).toEqual([]);
      expect(lines(await gitOk(bare!, "log", "--all", "-S", PASSWORD, "--pretty=format:%H"))).toEqual([]);

      /* adopted, not discarded — the hash is in sqlite and the terminal is armed */
      const settings = await srv.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.text).not.toContain(PASSWORD);
      expect(settings.body.settings.terminal.passwordSet).toBe(true);
      expect(settings.body.settings.terminal.password).toBeUndefined();
    },
    40000
  );
});

describe("keyring custody — a half-replaced identity is never committed away", () => {
  test(
    "identity.age gone with identity.age.prev standing stops sync instead of committing the deletion",
    async () => {
      const identity = "-----BEGIN AGE ENCRYPTED FILE-----\nZ25vdGVzLWtleXJpbmctY2FuYXJ5\n-----END AGE ENCRYPTED FILE-----\n";
      const seed: SeedMap = {
        ...SEED,
        ".znotes/vault.pub": "age1canary0000000000000000000000000000000000000000000000000000\n",
        ".znotes/identity.age": identity,
      };
      const { vault, bare } = await gitVault({ seed, origin: true });
      const srv = await serverOn(vault, 2);
      await settle(srv, debounceOf(srv));
      expect(await lsFiles(vault)).toContain(".znotes/identity.age");

      /* exactly the state writeVaultKeys leaves if it is killed between its two
         renames: the stash is the only copy of the key, and it is excluded from
         git by design — so committing the DELETION loses it on every clone */
      renameSync(join(vault, ".znotes", "identity.age"), join(vault, ".znotes", "identity.age.prev"));
      writeVaultFile(vault, "notes/alpha.md", "# Alpha\n\nedited so there is something to sync\n");

      const now = await syncNow(srv);
      expect(now.status).toBe(200);
      expect(now.body.state).toBe("error");
      expect(now.body.message).toContain("identity.age.prev");
      expect(now.body.message).toContain("rename");

      /* the identity is still in the tip on BOTH sides — the deletion was never
         staged, committed or pushed */
      expect(await showFile(vault, "HEAD", ".znotes/identity.age")).toContain("BEGIN AGE ENCRYPTED FILE");
      expect(await showFile(bare!, "HEAD", ".znotes/identity.age")).toContain("BEGIN AGE ENCRYPTED FILE");

      /* rename it back and the same pipeline runs clean */
      renameSync(join(vault, ".znotes", "identity.age.prev"), join(vault, ".znotes", "identity.age"));
      const again = await syncNow(srv);
      expect(again.body.state).toBe("synced");
      expect(await lsFiles(vault)).toContain(".znotes/identity.age");
    },
    60000
  );
});

/* ==================================================================
   14. a remote that accepts the connection and never answers
   ================================================================== */

describe("hung git", () => {
  test(
    "a git that never returns is killed, reported, and does not wedge every later sync",
    async () => {
      /* the shim leaves a GRANDCHILD holding the inherited stdout/stderr pipes,
         which is exactly what `git-remote-http` does against a black-hole
         remote: reaping the direct child does not close the pipes, so a reader
         that waits for EOF waits forever */
      const dir = tempDir("znotes-hanggit-");
      writeFileSync(join(dir, "git"), "#!/bin/sh\nsleep 120 &\nexec sleep 120\n", { mode: 0o755 });

      const vault = tempVault();
      const srv = await startServer({
        vault,
        env: { PATH: `${dir}:${process.env.PATH ?? ""}`, ZNOTES_GIT_TIMEOUT_MS: "1500" },
      });
      running.push(srv);

      for (const pass of ["first", "second"]) {
        const t0 = Date.now();
        const now = await syncNow(srv);
        expect(now.status).toBe(200);
        expectStatusShape(now.body);
        expect(now.body.state).toBe("offline");
        expect(String(now.body.message)).toContain("timed out");
        /* the second pass is the real assertion: a sync that never returns
           leaves `inflight` set forever and every later trigger joins the hang */
        expect(Date.now() - t0).toBeLessThan(15000);
        expect(pass).toBeTruthy();
      }

      /* the server is still answering everything else */
      expect((await srv.get("/api/docs")).status).toBe(200);
    },
    60000
  );
});

/* ==================================================================
   15. attach — POST /api/sync/remote (ADR 0017)

   The one operation allowed to create a repository, and the only one that has
   to be trusted with a vault full of the user's only copy of something. Every
   test here is really the same assertion from a different side: attach either
   succeeds completely or leaves the vault byte-identical to what it found.
   ================================================================== */

describe("attach: an empty remote", () => {
  test(
    "a vault that is not a repo becomes one, pushes its docs, and adopts the branch",
    async () => {
      const vault = tempVault();
      const bare = await emptyBare();
      const srv = await serverOn(vault, 2);

      /* precondition, not decoration: without it a passing test could be
         measuring the fixture rather than attach */
      expect(existsSync(join(vault, ".git"))).toBe(false);

      const now = await attach(srv, bare);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);

      expect(await originUrl(vault)).toBe(bare);
      expect(await isIgnored(vault, ".znotes/index.db")).toBe(true);

      /* the response is post-push (the route ends with a manual sync), so the
         bare already carries the seed — nothing to wait for */
      expect(await commitCount(bare)).toBeGreaterThanOrEqual(1);
      expect(await showFile(bare, "main", "notes/alpha.md")).toBe(SEED["notes/alpha.md"]);
      expect(await showFile(bare, "main", "inbox.md")).toBe(SEED["inbox.md"]);

      const settings = await srv.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.body.settings.git.branch).toBe("main");

      const st = await status(srv);
      expect(st.body.state).toBe("synced");
      expect(typeof st.body.remote).toBe("string");
    },
    60000
  );
});

describe("attach: a populated remote", () => {
  /* The brought repo is checked out INTO the vault — so its settings.toml is
     adopted (putRoute's reloadIfChanged) and its default branch becomes
     git.branch, which is what keeps a `trunk`-headed repo off the pipeline's
     "committed locally, not pushed" refusal on its very first sync.

     Note the vault ALWAYS has a `.znotes/settings.toml` of its own by the time
     attach runs — Settings.load() writes one at boot. It is the app's own
     file, and the remote's copy wins; if attach treats it as an ordinary
     untracked file it will collide with itself on every real attach. */
  test(
    "the remote's docs, settings and default branch land, and local-only docs survive and are pushed",
    async () => {
      const bare = await seededBare(
        {
          "remote/one.md": "# One\n\nfrom the brought repo\n",
          "remote/two.md": "# Two\n\nalso from the brought repo\n",
          /* scalars first: a bare key after a table header belongs to the table */
          ".znotes/settings.toml": 'theme = "modern"\n\n[git]\nautoSyncSeconds = 2\n',
        },
        "trunk"
      );
      const vault = tempVault({ "local-only.md": "# Local only\n\nwritten before the repo was attached\n" });
      const srv = await serverOn(vault);

      const now = await attach(srv, bare);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);

      /* the pulled docs are indexed before the response, not eventually */
      const paths = await docPaths(srv);
      expect(paths).toContain("remote/one.md");
      expect(paths).toContain("remote/two.md");
      expect((await srv.doc("remote/one.md")).body.markdown).toBe("# One\n\nfrom the brought repo\n");

      const settings = await srv.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.body.settings.theme).toBe("modern");
      expect(settings.body.settings.git.branch).toBe("trunk");

      /* the local doc was never in the way of the checkout, and the sync the
         route triggers is what carries it to the remote */
      expect(paths).toContain("local-only.md");
      expect(readFileSync(join(vault, "local-only.md"), "utf8")).toBe(
        "# Local only\n\nwritten before the repo was attached\n"
      );
      await waitUntil(
        async () => (await showFile(bare, "trunk", "local-only.md")).length > 0,
        { timeout: 8000, interval: 150, label: "the local-only doc to reach the bare" }
      );
    },
    60000
  );

  /* settings.toml HEALS rather than refuses (its own preamble says so), and a
     brought repo can carry an unparseable one — so the heal will rewrite the
     file from defaults and the triggered sync will push that. The bytes it
     healed over must survive somewhere local, or attach quietly destroyed the
     only copy this machine had. */
  test(
    "a remote settings.toml that is not TOML heals to defaults, with the original bytes parked",
    async () => {
      const GARBAGE = "this is not [[[ valid toml\n";
      const bare = await seededBare({
        "remote/doc.md": "# Doc\n\nfrom the brought repo\n",
        ".znotes/settings.toml": GARBAGE,
      });
      const vault = tempVault({});
      const srv = await serverOn(vault);

      const now = await attach(srv, bare);
      expect(now.status).toBe(200);
      expectStatusShape(now.body);

      /* the unparseable copy is parked as app scratch, never synced */
      expect(readFileSync(join(vault, ".znotes/tmp/settings.toml.unparseable"), "utf8")).toBe(GARBAGE);

      /* and the server is on usable defaults, not wedged on the garbage */
      const settings = await srv.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.body.settings.theme).toBe("minimal");
      expect(await docPaths(srv)).toContain("remote/doc.md");
    },
    60000
  );
});

describe("attach: a remote that would overwrite a local file", () => {
  test(
    "is refused, naming the paths, and leaves no .git and not one changed byte",
    async () => {
      const LOCAL = "# Foo\n\nthe local copy, which is the only copy\n";
      const bare = await seededBare({ "foo.md": "# Foo\n\nthe remote copy\n" });
      const vault = tempVault({ ...SEED, "foo.md": LOCAL });
      const srv = await serverOn(vault, 2);
      const before = readFileSync(join(vault, "foo.md"));

      const now = await attach(srv, bare);
      expect(now.status).toBe(409);
      expect(now.body.error).toBe("checkout-conflict");
      expect(Array.isArray(now.body.paths)).toBe(true);
      expect(now.body.paths).toContain("foo.md");
      /* the message is the whole recovery affordance — it has to name the file */
      expect(String(now.body.message)).toContain("foo.md");
      expect(String(now.body.message)).not.toContain(vault);
      expectErrorShape(now.text, "error", "message", "paths");
      expect(now.text.startsWith('{"error":"checkout-conflict","message":')).toBe(true);

      /* rollback: the repo attach made is gone, and so is any trace of it */
      expect(existsSync(join(vault, ".git"))).toBe(false);
      expect(readFileSync(join(vault, "foo.md")).equals(before)).toBe(true);
      expect((await srv.doc("foo.md")).body.markdown).toBe(LOCAL);
      expect((await status(srv)).body.state).toBe("offline");
    },
    60000
  );

  /* The remote carrying BOTH a clashing doc and a settings.toml: the refusal
     names only the doc — settings.toml is the app's own file, filtered from
     `paths` because the retry handles it once the real conflicts are gone —
     and nothing is parked or replaced on the refusal path. */
  test(
    "a mixed collision names only the user's file, and the local settings.toml stays put",
    async () => {
      const LOCAL = "# Foo\n\nthe local copy\n";
      const bare = await seededBare({
        "foo.md": "# Foo\n\nthe remote copy\n",
        ".znotes/settings.toml": 'theme = "modern"\n',
      });
      const vault = tempVault({ "foo.md": LOCAL });
      const srv = await serverOn(vault);
      const settingsBefore = readFileSync(join(vault, ".znotes/settings.toml"));

      const now = await attach(srv, bare);
      expect(now.status).toBe(409);
      expect(now.body.error).toBe("checkout-conflict");
      expect(now.body.paths).toEqual(["foo.md"]);

      expect(existsSync(join(vault, ".git"))).toBe(false);
      expect(readFileSync(join(vault, "foo.md"), "utf8")).toBe(LOCAL);
      expect(readFileSync(join(vault, ".znotes/settings.toml")).equals(settingsBefore)).toBe(true);
      expect(existsSync(join(vault, ".znotes/tmp/settings.toml.pre-attach"))).toBe(false);
    },
    60000
  );
});

describe("attach: a vault that is already a repo", () => {
  test(
    "origin is replaced only when the fetch proves it, and the working tree is never touched",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });
      const srv = await serverOn(vault, 2);
      const alpha = readFileSync(join(vault, "notes/alpha.md"));
      const headBefore = (await gitOk(vault, "rev-parse", "HEAD")).trim();

      const dead = await attach(srv, unreachableUrl());
      expect(dead.status).toBe(502);
      expect(dead.body.error).toBe("attach-failed");
      expect(typeof dead.body.message).toBe("string");
      expectErrorShape(dead.text, "error", "message");

      /* a failed attach is a no-op: the origin that worked still works */
      expect(await originUrl(vault)).toBe(bare!);
      expect((await gitOk(vault, "rev-parse", "HEAD")).trim()).toBe(headBefore);
      expect(readFileSync(join(vault, "notes/alpha.md")).equals(alpha)).toBe(true);

      const other = await emptyBare();
      const ok = await attach(srv, other);
      expect(ok.status).toBe(200);
      expectStatusShape(ok.body);
      expect(await originUrl(vault)).toBe(other);

      /* case A never checks out — the user's files are exactly where they were */
      expect(readFileSync(join(vault, "notes/alpha.md")).equals(alpha)).toBe(true);
      expect(lines(await gitOk(vault, "status", "--porcelain")).filter((l) => /^(UU|AA|DD)/.test(l))).toEqual([]);
    },
    60000
  );
});

describe("attach: refusals", () => {
  test(
    "a URL that could carry a credential or an argv option is rejected before git ever runs",
    async () => {
      const vault = tempVault();
      const srv = await serverOn(vault, 2);

      const refused = [
        /* a credential in the URL would land in .git/config verbatim */
        "https://carol:s3cr3t@example.invalid/z/vault.git",
        /* scp-style is ssh, which is out of scope — and it is also the shape
           that slips past a naive `new URL()` check */
        "git@github.com:you/vault.git",
        /* argv option injection: `git remote add origin --upload-pack=…` */
        "--upload-pack=/bin/sh",
      ];
      for (const url of refused) {
        const r = await attach(srv, url);
        expect(`${url} → ${r.status} ${r.body?.error}`).toBe(`${url} → 400 bad-url`);
        expectErrorShape(r.text, "error", "message");
        expect(existsSync(join(vault, ".git"))).toBe(false);
        expect(r.text).not.toContain("s3cr3t");
      }
    },
    40000
  );

  test(
    "a vault the user is in the middle of is refused with the pipeline's own message",
    async () => {
      const { vault, bare } = await gitVault({ origin: true });

      const other = await otherClone(bare!);
      await Bun.write(join(other, "notes/alpha.md"), "# Alpha\n\nREMOTE VERSION\n");
      await gitOk(other, "add", "notes/alpha.md");
      await gitOk(other, "commit", "-m", "other: alpha");
      await gitOk(other, "push", "origin", "main");

      writeVaultFile(vault, "notes/alpha.md", "# Alpha\n\nLOCAL VERSION\n");
      await gitOk(vault, "add", "notes/alpha.md");
      await gitOk(vault, "commit", "-m", "local: alpha");
      const pull = await git(vault, "pull", "--no-rebase", "origin", "main");
      expect(pull.code).not.toBe(0);
      expect(existsSync(join(vault, ".git", "MERGE_HEAD"))).toBe(true);

      const srv = await serverOn(vault, 2);
      const r = await attach(srv, await emptyBare());
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("vault-busy");
      expect(String(r.body.message)).toContain("merge");
      expect(String(r.body.message)).not.toContain(vault);
      expectErrorShape(r.text, "error", "message");

      /* the merge is still the user's, and so is the origin */
      expect(existsSync(join(vault, ".git", "MERGE_HEAD"))).toBe(true);
      expect(await originUrl(vault)).toBe(bare!);
    },
    60000
  );
});

describe("attach: token custody", () => {
  test(
    "the stored token reaches git only through the askpass env — never argv, .git/config or a response",
    async () => {
      const TOKEN = "ghp_zn0tesFAKEt0kenATTACH4m1pQ7z";
      const vault = tempVault();
      const bare = await emptyBare();
      const shim = gitShim();
      const srv = await serverOn(vault, 2, { PATH: `${shim.dir}:${process.env.PATH ?? ""}` });

      const put = await srv.api("PUT", "/api/settings", { git: { token: TOKEN } });
      expect(put.status).toBe(200);
      expect(put.text).not.toContain(TOKEN);

      const now = await attach(srv, bare);
      expect(now.status).toBe(200);
      expect(now.text).not.toContain(TOKEN);

      const gitConfig = readFileSync(join(vault, ".git", "config"), "utf8");
      expect(gitConfig).not.toContain(TOKEN);
      expect(gitConfig).toContain(bare); // the URL is stored verbatim, unrewritten

      /* argv of every git attach ran — a token there is world-readable in `ps` */
      const argv = shim.read();
      expect(argv.some((l) => /(^| )fetch( |$)/.test(l))).toBe(true);
      expect(argv.filter((l) => l.includes(TOKEN))).toEqual([]);

      await sleep(300);
      expect((await status(srv)).text).not.toContain(TOKEN);
      expect((await srv.get("/api/settings")).text).not.toContain(TOKEN);
      expect(srv.stdoutLines.join("\n")).not.toContain(TOKEN);
      expect(srv.stderrLines.join("\n")).not.toContain(TOKEN);
      expect(
        vaultFilesExceptDb(vault).filter((rel) => readFileSync(join(vault, rel)).toString("latin1").includes(TOKEN))
      ).toEqual([]);
    },
    60000
  );
});

/* ==================================================================
   16. boot provisioning — ZNOTES_VAULT_REPO / ZNOTES_GIT_TOKEN

   A fresh PVC plus two env vars must be a self-seeding deployment, and a
   restart of that same pod must be a no-op. Env vars are a BOOTSTRAP, never an
   enforcer: an unreachable remote yields a working offline vault, not a crash
   loop.
   ================================================================== */

describe("boot provisioning", () => {
  test(
    "an empty vault is seeded from ZNOTES_VAULT_REPO, and restarting does no work twice",
    async () => {
      const bare = await seededBare({
        "boot/one.md": "# One\n\nseeded at boot\n",
        "boot/two.md": "# Two\n\nalso seeded at boot\n",
      });
      const vault = tempDir("znotes-bootvault-");
      const first = await startServer({ vault, env: { ZNOTES_VAULT_REPO: bare } });
      running.push(first);

      const paths = await docPaths(first);
      expect(paths).toContain("boot/one.md");
      expect(paths).toContain("boot/two.md");
      expect(await originUrl(vault)).toBe(bare);

      const settled = await syncNow(first);
      expect(settled.status).toBe(200);
      expect(settled.body.state).toBe("synced");
      const head = (await gitOk(vault, "rev-parse", "HEAD")).trim();
      const commits = await commitCount(vault);
      await first.stop();

      /* second boot, same vault, same env: the vault is already its own repo,
         so provisioning must skip entirely. A re-init would show up here as a
         fresh history; a second attach as an extra commit. */
      const second = await startServer({ vault, env: { ZNOTES_VAULT_REPO: bare } });
      running.push(second);
      expect(second.readyLine.length).toBeGreaterThan(0);
      expect((await gitOk(vault, "rev-parse", "HEAD")).trim()).toBe(head);
      expect(await commitCount(vault)).toBe(commits);
      expect(await originUrl(vault)).toBe(bare);
      expect(await docPaths(second)).toEqual(paths);

      const again = await syncNow(second);
      expect(again.status).toBe(200);
      expect(again.body.state).toBe("synced");
    },
    90000
  );

  test(
    "an unreachable ZNOTES_VAULT_REPO boots a working offline vault instead of crash-looping",
    async () => {
      const vault = tempDir("znotes-bootvault-");
      const srv = await startServer({ vault, env: { ZNOTES_VAULT_REPO: unreachableUrl() } });
      running.push(srv);

      expect(srv.readyLine.length).toBeGreaterThan(0);

      const st = await status(srv);
      expect(st.status).toBe(200);
      expectStatusShape(st.body);
      expect(["offline", "error"]).toContain(st.body.state);
      /* rolled back: a half-made repo would make every later sync lie */
      expect(existsSync(join(vault, ".git"))).toBe(false);

      /* and it is a working notes app, which is the whole point of not crashing */
      const created = await srv.api("POST", "/api/docs", {
        path: "notes/offline.md",
        markdown: "# Offline\n\nstill writable\n",
      });
      expect(created.status).toBe(201);
    },
    60000
  );

  test(
    "ZNOTES_GIT_TOKEN seeds an empty credential store and never clobbers a stored one",
    async () => {
      const ENV_TOKEN = "znotes_env_TOKEN_00000000000_ENVX";
      const STORED_TOKEN = "stored_ui_TOKEN_11111111111_UIXX";

      /* first run, nothing stored: the env var is what arms the credential */
      const fresh = tempVault();
      const seeded = await startServer({ vault: fresh, env: { ZNOTES_GIT_TOKEN: ENV_TOKEN } });
      running.push(seeded);
      const fromEnv = await seeded.get("/api/settings");
      expect(fromEnv.status).toBe(200);
      expect(fromEnv.text).not.toContain(ENV_TOKEN);
      const envMask = String(fromEnv.body.settings.git.tokenMasked);
      expect(envMask.length).toBeGreaterThan(0);

      /* a token stored through the UI is the live one, and a stale env var on
         the next boot must not roll it back — rotation happens in the UI */
      const vault = tempVault();
      const before = await startServer({ vault });
      running.push(before);
      expect((await before.api("PUT", "/api/settings", { git: { token: STORED_TOKEN } })).status).toBe(200);
      const storedMask = String((await before.get("/api/settings")).body.settings.git.tokenMasked);
      expect(storedMask.length).toBeGreaterThan(0);
      expect(storedMask).not.toBe(envMask); // else the assertion below proves nothing
      await before.stop();

      const after = await startServer({ vault, env: { ZNOTES_GIT_TOKEN: ENV_TOKEN } });
      running.push(after);
      const settings = await after.get("/api/settings");
      expect(settings.status).toBe(200);
      expect(String(settings.body.settings.git.tokenMasked)).toBe(storedMask);
      expect(settings.text).not.toContain(ENV_TOKEN);
      expect(settings.text).not.toContain(STORED_TOKEN);
    },
    90000
  );

  test(
    "a vault directory that does not exist yet is created, and the app works in it",
    async () => {
      const vault = join(tempDir("znotes-novault-"), "nope");
      expect(existsSync(vault)).toBe(false);

      const srv = await startServer({ vault });
      running.push(srv);
      expect(srv.readyLine.length).toBeGreaterThan(0);
      expect(await docPaths(srv)).toEqual([]);

      const created = await srv.api("POST", "/api/docs", {
        path: "first.md",
        markdown: "# First\n\ninto a vault that had to be made\n",
      });
      expect(created.status).toBe(201);
      const markdown = "# First\n\nand written again\n";
      expect((await srv.putDoc("first.md", markdown)).status).toBe(200);
      expect((await srv.doc("first.md")).body.markdown).toBe(markdown);
      expect(readFileSync(join(vault, "first.md"), "utf8")).toBe(markdown);
    },
    40000
  );
});
