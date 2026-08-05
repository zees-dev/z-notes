/* ============================================================
   fileops.test.ts — PHASE 5 acceptance gate.

   SPEC §3 delta 2, §5, §8; wayfinder/tickets/15-grilling-data-model.md.

   The contract this file holds the backend to — written against the SPEC, not
   against the implementation:

     PATCH /api/docs/{path}   {"to":"new/path.md"}
       → 200 {path, from, rev, bytes, mtime, backlinksUpdated, updated[]}
       moves/renames the doc AND rewrites every [[link]] that resolved to it,
       vault-wide, in ONE git commit ("move: old → new" + the touched files).
       409 {"error":"exists"} · 400 {"error":"bad-path"} · 404 {"error":"not-found"}
       A folder path moves the whole subtree under the same rules.

     DELETE /api/docs/{path}  → 204. Human-only (SPEC §8 gives the AI no
       delete/rename powers). A folder deletes its subtree. Backlinks to a
       deleted doc are left BROKEN — never rewritten. One git commit.

     Link semantics (SPEC §5): `[[slug]]` resolves by unique filename slug
       vault-wide; `[[path/slug]]` only on collision. So the slug form is the
       CANONICAL form and a move must produce the *minimal* correct text:
         - rename that changes the slug → rewrite [[old-slug]] → [[new-slug]]
         - move that creates a collision → rewrite the affected links (in the
           moved doc's referrers AND in the referrers of the doc it now
           collides with) to their disambiguating [[path/slug]] form
         - move that changes nothing about resolution (folder rename, slug
           still unique) → slug-form links are left BYTE-IDENTICAL; only
           path-qualified links that named the old folder are rewritten
       Links inside ```age fences, inside ordinary code fences and inside
       `inline code` are NEVER rewritten.

     SSE: doc-changed with reason "moved" for the old path (removed:true) and
       for the new path, and reason "write" for every backlink-rewritten doc.

     Atomicity: a move + N rewrites never leaves the vault half-updated. On
     failure every file already written is rolled back and the call is 5xx.

   Nothing here imports the backend. Every assertion goes through HTTP, the
   filesystem, or `git`.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bytesEqual,
  describeByteDiff,
  dropVault,
  encPath,
  makeVault,
  readVaultBytes,
  readVaultText,
  REPO_ROOT,
  sleep,
  startServer,
  toBytes,
  vaultHas,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { startMockUpstream, toolArgs, turn, reply, type MockUpstream } from "./mock-upstream";

/* ------------------------------------------------------------------
   git plumbing (local copy — test files must not import each other)
   ------------------------------------------------------------------ */

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "z-notes test",
      GIT_AUTHOR_EMAIL: "test@z-notes.invalid",
      GIT_COMMITTER_NAME: "z-notes test",
      GIT_COMMITTER_EMAIL: "test@z-notes.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code: typeof code === "number" ? code : -1, stdout, stderr };
}

async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})\n${r.stderr || r.stdout}`);
  return r.stdout;
}

const commitCount = async (repo: string) => Number((await gitOk(repo, "rev-list", "--count", "HEAD")).trim()) || 0;

/** Paths touched by a commit. `--no-renames` so a rename shows BOTH sides —
    otherwise git's rename detection hides the path a move came from. */
async function commitFiles(repo: string, ref = "HEAD"): Promise<string[]> {
  const out = await gitOk(repo, "show", "--no-renames", "--name-only", "--pretty=format:", ref);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

const commitSubject = (repo: string, ref = "HEAD") =>
  gitOk(repo, "log", "-1", "--pretty=format:%s", ref).then((s) => s.trim());

/** Working-tree paths git considers dirty, ignoring the untracked sqlite index. */
async function dirtyPaths(repo: string): Promise<string[]> {
  const out = await gitOk(repo, "status", "--porcelain");
  return out
    .split("\n")
    .map((s) => s.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith(".znotes/"))
    .sort();
}

async function initRepo(vault: string) {
  await gitOk(vault, "init", "-b", "main");
  await gitOk(vault, "config", "user.name", "z-notes test");
  await gitOk(vault, "config", "user.email", "test@z-notes.invalid");
  await gitOk(vault, "config", "commit.gpgsign", "false");
  /* the sqlite index is never a note — exclude it exactly like git.ts does, so
     "the commit touched exactly these files" is about notes and nothing else */
  mkdirSync(join(vault, ".git", "info"), { recursive: true });
  writeFileSync(
    join(vault, ".git", "info", "exclude"),
    ".znotes/index.db\n.znotes/index.db-wal\n.znotes/index.db-shm\n"
  );
  await gitOk(vault, "add", ".");
  await gitOk(vault, "commit", "-m", "initial");
}

/* ------------------------------------------------------------------
   assertion helpers
   ------------------------------------------------------------------ */

function expectBytes(actual: Uint8Array, expected: Uint8Array, label: string) {
  expect(`${label}: ${bytesEqual(actual, expected) ? "identical" : describeByteDiff(expected, actual)}`).toBe(
    `${label}: identical`
  );
}

function expectFileBytes(vault: string, rel: string, expected: string, label: string) {
  expect(`${label} exists: ${vaultHas(vault, rel)}`).toBe(`${label} exists: true`);
  expectBytes(readVaultBytes(vault, rel), toBytes(expected), label);
}

/**
 * Byte-exact against a small set of *equally correct* results — used only where
 * the SPEC genuinely leaves the choice open (see the folder-rename test). Still
 * byte-exact: anything outside the set fails, with a diff against the first.
 */
function expectFileBytesOneOf(vault: string, rel: string, expected: string[], label: string) {
  expect(`${label} exists: ${vaultHas(vault, rel)}`).toBe(`${label} exists: true`);
  const actual = readVaultBytes(vault, rel);
  const hit = expected.findIndex((e) => bytesEqual(actual, toBytes(e)));
  expect(
    `${label}: ${hit >= 0 ? `matches accepted form #${hit}` : describeByteDiff(toBytes(expected[0]), actual)}`
  ).toBe(`${label}: matches accepted form #${hit >= 0 ? hit : 0}`);
}

/** exactly one commit landed — and no second one is still on its way */
async function expectOneCommit(repo: string, before: number, label: string) {
  await waitUntil(async () => (await commitCount(repo)) > before, { timeout: 10000, label });
  await sleep(SETTLE); // a stray second commit would land right behind the first
  expect(`commits added by ${label}: ${(await commitCount(repo)) - before}`).toBe(`commits added by ${label}: 1`);
}

const patchDoc = (srv: TestServer, path: string, body: unknown) =>
  srv.api("PATCH", "/api/docs/" + encPath(path), body);

const deleteDoc = (srv: TestServer, path: string) => srv.api("DELETE", "/api/docs/" + encPath(path));

/** short settle used only where the assertion is a NEGATIVE (nothing happened) */
const SETTLE = 350;

const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";
const ARMOR_B64 = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4";

/* ============================================================
   fixtures — one git vault carries every non-destructive scenario.
   Slugs are globally distinct on purpose: `[[one]]` may only be
   ambiguous when a test deliberately makes it so.
   ============================================================ */

const MD_ALPHA = "# Alpha\n\nthe doc that gets renamed\n";
const MD_R1 = "# R1\n\nsee [[alpha]] for the details\n";
const MD_R2 = "# R2\n\n- [ ] read [[alpha]] before Friday\n- [ ] then file it\n";
const MD_R3 = "# R3\n\n[[alpha]]\n";
const MD_BYSTANDER = "# Bystander\n\nlinks to [[unrelated-doc]] only, never to the renamed one\n";
const MD_UNRELATED = "# Unrelated doc\n\nnothing to see\n";
/* a link that was ALREADY broken before any of this: a move must not "repair"
   links it did not break */
const MD_GHOST = "# Ghost ref\n\npoints at [[gone-forever]], which never existed\n";

const MD_A_NOTES = "# A notes\n\nthe original holder of the `notes` slug\n";
const MD_B_OTHER = "# B other\n\nthis file keeps its bytes across the move\n";
const MD_REF_A = "# Ref A\n\nthe canonical [[notes]] doc lives in a/\n";
const MD_REF_B = "# Ref B\n\nand the other one is [[other]] over in b/\n";

const MD_FENCE_TARGET = "# Fence target\n\nplain body\n";
const MD_MIXER =
  "# Mixer\n" +
  "\n" +
  "prose link to [[fence-target]] in a sentence.\n" +
  "\n" +
  "```age\n" +
  ARMOR_BEGIN +
  "\n" +
  ARMOR_B64 +
  "\n" +
  "[[fence-target]]\n" +
  ARMOR_END +
  "\n" +
  "```\n" +
  "\n" +
  "```ts\n" +
  'const wiki = "[[fence-target]]";\n' +
  "```\n" +
  "\n" +
  "and inline `[[fence-target]]` must survive too.\n";

const MD_FOLD_ONE = "# Fold one\n\nfirst doc in the folder\n";
const MD_FOLD_TWO = "# Fold two\n\nsecond doc in the folder\n";
const MD_SLUGFORM = "# Slug form\n\nlinks [[fold-one]] by bare slug\n";
const MD_PATHFORM = "# Path form\n\nlinks [[oldfolder/fold-two]] by qualified path\n";

const MD_ERR_SRC = "# Err src\n\nnever moves\n";
const MD_ERR_DST = "# Err dst\n\nalready occupied\n";

const MD_DOOMED = "# Doomed\n\nabout to be deleted\n";
const MD_MOURNER = "# Mourner\n\nstill points at [[doomed]] after the delete\n";

const MD_SUB_A = "# Sub a\n\nunder the doomed folder\n";
const MD_SUB_B = "# Sub b\n\nalso under the doomed folder\n";
const MD_KEEP = "# Keep\n\nsibling of the doomed folder, survives\n";

/* byte-hostile round-trip fixtures: CRLF, tabs, trailing spaces, no final \n */
const MD_WEIRD =
  "# Weird\r\n\r\nline with trailing spaces   \r\n\tTabbed\tline\r\n\r\nno final newline at all";
const MD_CRLF_TARGET = "# Crlf target\n\nplain\n";
const MD_CRLF_REF = "# Crlf ref\r\n\r\nsee [[crlf-target]] here\r\nlast line, no final newline";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\n",

  /* 1 — rename + backlinks */
  "notes/alpha.md": MD_ALPHA,
  "refs/r1.md": MD_R1,
  "refs/r2.md": MD_R2,
  "deep/nest/r3.md": MD_R3,
  "refs/bystander.md": MD_BYSTANDER,
  "notes/unrelated-doc.md": MD_UNRELATED,
  "stale/ghost-ref.md": MD_GHOST,

  /* 2 — collision */
  "a/notes.md": MD_A_NOTES,
  "b/other.md": MD_B_OTHER,
  "ref-a.md": MD_REF_A,
  "ref-b.md": MD_REF_B,

  /* 3 — fences */
  "fence/fence-target.md": MD_FENCE_TARGET,
  "fence/mixer.md": MD_MIXER,

  /* 4 — folder rename. The `.png` is not decoration: API.md promises a folder
     takes its whole subtree "including non-`.md` files", and those are the ones
     no git path in this app can see (`scanDocs`, `stage()` and the pending
     count are all `.md`-only), so they are exactly what a folder op can strand. */
  "oldfolder/fold-one.md": MD_FOLD_ONE,
  "oldfolder/fold-two.md": MD_FOLD_TWO,
  "oldfolder/diagram.png": "PNG-PLACEHOLDER-BYTES\n",
  "fref/slugform.md": MD_SLUGFORM,
  "fref/pathform.md": MD_PATHFORM,

  /* 5 — errors */
  "err/src.md": MD_ERR_SRC,
  "err/dst.md": MD_ERR_DST,

  /* 6 — delete */
  "del/doomed.md": MD_DOOMED,
  "del/mourner.md": MD_MOURNER,
  "delf/sub/sub-a.md": MD_SUB_A,
  "delf/sub/sub-b.md": MD_SUB_B,
  "delf/sub/blob.bin": "BINARY-PLACEHOLDER\n",
  "delf/keep.md": MD_KEEP,

  /* 9 — round trip */
  "rt/weird.md": MD_WEIRD,
  "rt/crlf-target.md": MD_CRLF_TARGET,
  "rt/crlf-ref.md": MD_CRLF_REF,
};

let srv: TestServer;
let vault = "";
const orphanVaults: string[] = [];

beforeAll(async () => {
  vault = makeVault(SEED);
  orphanVaults.push(vault);
  await initRepo(vault);
  srv = await startServer({ vault });
}, 60000);

afterAll(async () => {
  if (srv) await srv.stop();
  for (const v of orphanVaults) dropVault(v);
});

/* ============================================================
   1 — rename: the doc moves and every backlink follows, in one commit
   ============================================================ */

describe("PATCH /api/docs — rename rewrites backlinks (SPEC §3 delta 2, §5)", () => {
  const FROM = "notes/alpha.md";
  const TO = "notes/omega.md";
  const REFERRERS = ["deep/nest/r3.md", "refs/r1.md", "refs/r2.md"]; // sorted

  test("200, backlinksUpdated:3, byte-exact rewrites, one commit, SSE", async () => {
    const before = await commitCount(vault);
    const sse = await srv.sse();
    const mark = sse.mark();

    try {
      const r = await patchDoc(srv, FROM, { to: TO });
      expect(`PATCH → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH → 200 ${r.text.slice(0, 200)}`);

      /* ---- response envelope ---- */
      expect(r.body.path).toBe(TO);
      expect(r.body.from).toBe(FROM);
      expect(r.body.backlinksUpdated).toBe(3);
      /* `updated` is the set of docs whose links were rewritten — the moved doc
         itself is reported by `path`/`from`, not by `updated`. */
      expect([...(r.body.updated ?? [])].sort()).toEqual(REFERRERS);
      expect(typeof r.body.rev).toBe("string");
      expect((r.body.rev ?? "").length).toBeGreaterThan(0);
      expect(r.body.bytes).toBe(Buffer.byteLength(MD_ALPHA, "utf8"));
      expect(`mtime parses: ${Number.isFinite(Date.parse(String(r.body.mtime)))}`).toBe("mtime parses: true");

      /* ---- disk: byte-exact ---- */
      expect(`old path still on disk: ${vaultHas(vault, FROM)}`).toBe("old path still on disk: false");
      expectFileBytes(vault, TO, MD_ALPHA, "the moved doc keeps its bytes");
      expectFileBytes(vault, "refs/r1.md", MD_R1.replace("[[alpha]]", "[[omega]]"), "r1 rewrite");
      expectFileBytes(vault, "refs/r2.md", MD_R2.replace("[[alpha]]", "[[omega]]"), "r2 rewrite");
      expectFileBytes(vault, "deep/nest/r3.md", MD_R3.replace("[[alpha]]", "[[omega]]"), "r3 rewrite");
      /* a doc that never linked to the renamed one is not touched at all */
      expectFileBytes(vault, "refs/bystander.md", MD_BYSTANDER, "the bystander is untouched");
      /* …and a link that was already broken stays broken: a rename repairs
         nothing it did not break */
      expectFileBytes(vault, "stale/ghost-ref.md", MD_GHOST, "an already-broken link is left alone");

      /* ---- API: the index moved with the file ---- */
      const gone = await srv.doc(FROM);
      expect(`GET old → ${gone.status} ${gone.body?.error}`).toBe("GET old → 404 not-found");
      const got = await srv.doc(TO);
      expect(`GET new → ${got.status}`).toBe("GET new → 200");
      expect(got.body.markdown).toBe(MD_ALPHA);
      expect(got.body.slug).toBe("omega");
      expect(got.body.rev).toBe(r.body.rev);

      const tree = await srv.get("/api/docs");
      const paths = JSON.stringify(tree.body.tree);
      expect(`tree still lists the old path: ${paths.includes(FROM)}`).toBe("tree still lists the old path: false");
      expect(`tree lists the new path: ${paths.includes(TO)}`).toBe("tree lists the new path: true");

      /* ---- git: ONE commit, exactly the moved doc + its three referrers ---- */
      await expectOneCommit(vault, before, "the move");
      expect(await commitFiles(vault)).toEqual([FROM, TO, ...REFERRERS].sort());

      const subject = await commitSubject(vault);
      expect(`subject starts with "move: ": ${subject.startsWith("move: ")} (${subject})`).toBe(
        `subject starts with "move: ": true (${subject})`
      );
      expect(`subject names the old path: ${subject.includes(FROM)} (${subject})`).toBe(
        `subject names the old path: true (${subject})`
      );
      expect(`subject names the new path: ${subject.includes(TO)} (${subject})`).toBe(
        `subject names the new path: true (${subject})`
      );

      /* the commit captured everything: nothing left dirty in the work tree */
      expect(await dirtyPaths(vault)).toEqual([]);

      /* the committed blobs are the bytes on disk */
      expect(await gitOk(vault, "show", "HEAD:" + TO)).toBe(readVaultText(vault, TO));
      expect(await gitOk(vault, "show", "HEAD:refs/r1.md")).toBe(readVaultText(vault, "refs/r1.md"));

      /* ---- SSE: moved (removed) + moved (created) + write × 3 ---- */
      const removed = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d?.path === FROM && d?.reason === "moved",
        timeout: 8000,
      });
      expect(`old-path frame removed:true → ${removed.data?.removed}`).toBe("old-path frame removed:true → true");

      const created = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d?.path === TO && (d?.reason === "moved" || d?.reason === "created"),
        timeout: 8000,
      });
      expect(`new-path frame is not a removal: ${!created.data?.removed}`).toBe("new-path frame is not a removal: true");
      expect(created.data?.rev).toBe(r.body.rev);

      for (const ref of REFERRERS) {
        const ev = await sse.waitFor("doc-changed", {
          from: mark,
          match: (d) => d?.path === ref && d?.reason === "write",
          timeout: 8000,
        });
        expect(`write frame for ${ref}: ${ev.data?.path}`).toBe(`write frame for ${ref}: ${ref}`);
      }
    } finally {
      sse.close();
    }
  }, 45000);
});

/* ============================================================
   2 — collision: a move that makes a slug ambiguous must disambiguate
       BOTH sides (SPEC §5 — the subtle one)
   ============================================================ */

describe("PATCH /api/docs — a move that creates a slug collision (SPEC §5)", () => {
  test("links to both colliding docs become [[path/slug]], byte-exactly", async () => {
    const before = await commitCount(vault);

    const r = await patchDoc(srv, "b/other.md", { to: "b/notes.md" });
    expect(`PATCH → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH → 200 ${r.text.slice(0, 200)}`);
    expect(r.body.path).toBe("b/notes.md");
    expect(r.body.from).toBe("b/other.md");

    /* ref-b linked the doc that moved; ref-a linked the doc whose slug JUST
       became ambiguous. Both must be rewritten or one of them now resolves to
       the wrong file — this is the whole point of the collision rule. */
    expect([...(r.body.updated ?? [])].sort()).toEqual(["ref-a.md", "ref-b.md"]);
    expect(r.body.backlinksUpdated).toBe(2);

    expectFileBytes(vault, "b/notes.md", MD_B_OTHER, "the moved doc keeps its bytes");
    expect(`b/other.md still on disk: ${vaultHas(vault, "b/other.md")}`).toBe("b/other.md still on disk: false");

    expectFileBytes(
      vault,
      "ref-a.md",
      MD_REF_A.replace("[[notes]]", "[[a/notes]]"),
      "ref-a disambiguated to the doc it always meant"
    );
    expectFileBytes(
      vault,
      "ref-b.md",
      MD_REF_B.replace("[[other]]", "[[b/notes]]"),
      "ref-b disambiguated to the moved doc"
    );

    /* the doc that did not move is otherwise untouched */
    expectFileBytes(vault, "a/notes.md", MD_A_NOTES, "a/notes.md body untouched");

    await expectOneCommit(vault, before, "the move");
    expect(await commitFiles(vault)).toEqual(["b/notes.md", "b/other.md", "ref-a.md", "ref-b.md"].sort());
    expect(await dirtyPaths(vault)).toEqual([]);
  }, 45000);
});

/* ============================================================
   3 — fence safety: code is not prose (reuses the canary-tested grammar)
   ============================================================ */

describe("PATCH /api/docs — links inside fences and inline code are never rewritten", () => {
  test("only the prose occurrence changes; the age fence, the ts fence and the inline code are byte-identical", async () => {
    const before = await commitCount(vault);

    const r = await patchDoc(srv, "fence/fence-target.md", { to: "fence/renamed-target.md" });
    expect(`PATCH → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH → 200 ${r.text.slice(0, 200)}`);

    /* one doc rewritten, one occurrence inside it */
    expect(r.body.backlinksUpdated).toBe(1);
    expect([...(r.body.updated ?? [])].sort()).toEqual(["fence/mixer.md"]);

    /* String.replace with a string replaces the FIRST match only — and the
       first match is the prose one, by construction of MD_MIXER */
    const expected = MD_MIXER.replace("[[fence-target]]", "[[renamed-target]]");
    expectFileBytes(vault, "fence/mixer.md", expected, "mixer: prose rewritten, code untouched");

    const after = readVaultText(vault, "fence/mixer.md");
    const survivors = after.split("[[fence-target]]").length - 1;
    expect(`untouched [[fence-target]] occurrences (age + ts + inline): ${survivors}`).toBe(
      "untouched [[fence-target]] occurrences (age + ts + inline): 3"
    );
    expect(`the armor line is intact: ${after.includes(ARMOR_B64 + "\n[[fence-target]]\n" + ARMOR_END)}`).toBe(
      "the armor line is intact: true"
    );
    expect(`the ts fence is intact: ${after.includes('const wiki = "[[fence-target]]";')}`).toBe(
      "the ts fence is intact: true"
    );
    expect(`the inline code is intact: ${after.includes("inline `[[fence-target]]` must survive")}`).toBe(
      "the inline code is intact: true"
    );

    await expectOneCommit(vault, before, "the move");
    expect(await commitFiles(vault)).toEqual(
      ["fence/fence-target.md", "fence/renamed-target.md", "fence/mixer.md"].sort()
    );
  }, 45000);
});

/* ============================================================
   4 — folder rename: subtree moves, MINIMAL link rewriting
   ============================================================ */

describe("PATCH /api/docs — folder rename moves the subtree (SPEC §5)", () => {
  test("subtree moves, path-qualified links follow, slug-form links stay byte-identical, one commit", async () => {
    const before = await commitCount(vault);

    const r = await patchDoc(srv, "oldfolder", { to: "newfolder" });
    expect(`PATCH folder → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH folder → 200 ${r.text.slice(0, 200)}`);
    expect(r.body.path).toBe("newfolder");
    expect(r.body.from).toBe("oldfolder");
    /* API.md (normative per SPEC §3): a folder move enumerates the subtree so a
       client can re-point open editors without diffing two trees */
    const movedPairs = [...(r.body.moved ?? [])]
      .map((m: any) => `${m?.from} → ${m?.to}`)
      .sort();
    expect(movedPairs).toEqual([
      "oldfolder/fold-one.md → newfolder/fold-one.md",
      "oldfolder/fold-two.md → newfolder/fold-two.md",
    ]);

    /* the subtree moved, bytes intact */
    expect(`oldfolder/fold-one.md gone: ${!vaultHas(vault, "oldfolder/fold-one.md")}`).toBe(
      "oldfolder/fold-one.md gone: true"
    );
    expect(`oldfolder/fold-two.md gone: ${!vaultHas(vault, "oldfolder/fold-two.md")}`).toBe(
      "oldfolder/fold-two.md gone: true"
    );
    expectFileBytes(vault, "newfolder/fold-one.md", MD_FOLD_ONE, "fold-one moved intact");
    expectFileBytes(vault, "newfolder/fold-two.md", MD_FOLD_TWO, "fold-two moved intact");
    /* API.md: the subtree comes along "including non-`.md` files" */
    expectFileBytes(vault, "newfolder/diagram.png", "PNG-PLACEHOLDER-BYTES\n", "the attachment moved with the folder");
    expect(`oldfolder/diagram.png gone: ${!vaultHas(vault, "oldfolder/diagram.png")}`).toBe(
      "oldfolder/diagram.png gone: true"
    );

    /* `[[fold-one]]` still resolves — the slug is still unique — so rewriting
       it would be gratuitous churn against SPEC §5's "path-qualified only on
       collision". `[[oldfolder/fold-two]]` names a path that no longer exists
       and MUST be rewritten. */
    expectFileBytes(vault, "fref/slugform.md", MD_SLUGFORM, "a still-resolving slug link is left alone");
    /* `[[oldfolder/fold-two]]` names a path that no longer exists, so it MUST
       change. Two rewrites are equally correct and the SPEC does not choose
       between them: follow the folder (`[[newfolder/fold-two]]`, minimal edit,
       keeps the author's qualified form) or canonicalise to the now-unique slug
       (`[[fold-two]]`, since §5 makes the bare slug the normal form). Anything
       else — including leaving it — fails. */
    expectFileBytesOneOf(
      vault,
      "fref/pathform.md",
      [
        MD_PATHFORM.replace("[[oldfolder/fold-two]]", "[[newfolder/fold-two]]"),
        MD_PATHFORM.replace("[[oldfolder/fold-two]]", "[[fold-two]]"),
      ],
      "a path-qualified link follows the folder"
    );
    expect([...(r.body.updated ?? [])].sort()).toEqual(["fref/pathform.md"]);
    expect(r.body.backlinksUpdated).toBe(1);

    /* the API sees the new paths */
    expect((await srv.doc("oldfolder/fold-one.md")).status).toBe(404);
    const moved = await srv.doc("newfolder/fold-one.md");
    expect(`GET newfolder/fold-one.md → ${moved.status}`).toBe("GET newfolder/fold-one.md → 200");
    expect(moved.body.markdown).toBe(MD_FOLD_ONE);

    await expectOneCommit(vault, before, "the move");
    /* the attachment is in the SAME commit. It used to be left behind entirely:
       deleted-unstaged at the old path, untracked at the new one, forever —
       `stage()` is `.md`-only, so no later sync could ever heal it, and
       `dirtyOutsideAllowlist()` then refused every push that needed a rebase. */
    expect(await commitFiles(vault)).toEqual(
      [
        "oldfolder/fold-one.md",
        "oldfolder/fold-two.md",
        "oldfolder/diagram.png",
        "newfolder/fold-one.md",
        "newfolder/fold-two.md",
        "newfolder/diagram.png",
        "fref/pathform.md",
      ].sort()
    );
    expect(await dirtyPaths(vault)).toEqual([]);
  }, 45000);
});

/* ============================================================
   5 — errors: nothing moves, nothing commits
   ============================================================ */

describe("PATCH /api/docs — refusals (SPEC §3 delta 2)", () => {
  test("a target that already exists is 409 exists and changes nothing", async () => {
    const before = await commitCount(vault);
    const r = await patchDoc(srv, "err/src.md", { to: "err/dst.md" });
    expect(`PATCH onto an existing doc → ${r.status} ${r.body?.error}`).toBe("PATCH onto an existing doc → 409 exists");

    expectFileBytes(vault, "err/src.md", MD_ERR_SRC, "the source survives a 409");
    expectFileBytes(vault, "err/dst.md", MD_ERR_DST, "the target survives a 409");
    await sleep(SETTLE); // negative assertion: nothing to await
    expect(`commits added by a 409: ${(await commitCount(vault)) - before}`).toBe("commits added by a 409: 0");
  }, 30000);

  test("traversal, .znotes and non-.md targets are 400 bad-path", async () => {
    const bad: Array<[string, string]> = [
      ["parent traversal", "../escaped.md"],
      ["embedded traversal", "err/../../escaped.md"],
      ["absolute path", "/tmp/escaped.md"],
      ["app-internal dir", ".znotes/leaked.md"],
      ["app-internal nested", ".znotes/sub/leaked.md"],
      ["not markdown", "err/src.txt"],
      ["no extension", "err/src"],
      ["empty target", ""],
    ];
    const before = await commitCount(vault);

    for (const [label, to] of bad) {
      const r = await patchDoc(srv, "err/src.md", { to });
      expect(`${label} (${JSON.stringify(to)}) → ${r.status}`).toBe(`${label} (${JSON.stringify(to)}) → 400`);
      expect(`${label} error slug: ${r.body?.error}`).toBe(`${label} error slug: bad-path`);
      expect(`${label} carries a message: ${typeof r.body?.message === "string" && r.body.message.length > 0}`).toBe(
        `${label} carries a message: true`
      );
    }

    /* a missing `to` is malformed, not a move to nowhere */
    const noTo = await patchDoc(srv, "err/src.md", {});
    expect(`PATCH with no "to" → ${noTo.status}`).toBe(`PATCH with no "to" → 400`);

    expectFileBytes(vault, "err/src.md", MD_ERR_SRC, "the source survives every refusal");
    expect(`.znotes/leaked.md was created: ${vaultHas(vault, ".znotes/leaked.md")}`).toBe(
      ".znotes/leaked.md was created: false"
    );
    await sleep(SETTLE);
    expect(`commits added by refusals: ${(await commitCount(vault)) - before}`).toBe("commits added by refusals: 0");
  }, 30000);

  test("a missing source is 404 not-found for both PATCH and DELETE", async () => {
    const before = await commitCount(vault);

    const p = await patchDoc(srv, "err/nope.md", { to: "err/whatever.md" });
    expect(`PATCH a missing doc → ${p.status} ${p.body?.error}`).toBe("PATCH a missing doc → 404 not-found");
    expect(`the phantom target was created: ${vaultHas(vault, "err/whatever.md")}`).toBe(
      "the phantom target was created: false"
    );

    const d = await deleteDoc(srv, "err/nope.md");
    expect(`DELETE a missing doc → ${d.status} ${d.body?.error}`).toBe("DELETE a missing doc → 404 not-found");

    const df = await deleteDoc(srv, "err/nosuchfolder");
    expect(`DELETE a missing folder → ${df.status}`).toBe("DELETE a missing folder → 404");

    await sleep(SETTLE);
    expect(`commits added by 404s: ${(await commitCount(vault)) - before}`).toBe("commits added by 404s: 0");
  }, 30000);
});

/* ============================================================
   6 — delete: human-only, subtree-aware, backlinks left BROKEN
   ============================================================ */

describe("DELETE /api/docs — removes the doc and leaves its backlinks broken (SPEC §5)", () => {
  test("204, file gone, referrer byte-unchanged, one commit, SSE removal", async () => {
    const before = await commitCount(vault);
    const sse = await srv.sse();
    const mark = sse.mark();

    try {
      const r = await deleteDoc(srv, "del/doomed.md");
      expect(`DELETE → ${r.status}`).toBe("DELETE → 204");
      expect(`204 body is empty: ${r.text === ""}`).toBe("204 body is empty: true");

      expect(`del/doomed.md still on disk: ${vaultHas(vault, "del/doomed.md")}`).toBe(
        "del/doomed.md still on disk: false"
      );
      const gone = await srv.doc("del/doomed.md");
      expect(`GET the deleted doc → ${gone.status} ${gone.body?.error}`).toBe("GET the deleted doc → 404 not-found");

      /* SPEC §5: a link to a deleted doc becomes a BROKEN link — the referrer
         is not rewritten, not stripped, not touched at all */
      expectFileBytes(vault, "del/mourner.md", MD_MOURNER, "the referrer is byte-identical after a delete");

      await expectOneCommit(vault, before, "the delete");
      expect(await commitFiles(vault)).toEqual(["del/doomed.md"]);
      const subject = await commitSubject(vault);
      expect(`the commit subject names the deleted path: ${subject.includes("del/doomed.md")} (${subject})`).toBe(
        `the commit subject names the deleted path: true (${subject})`
      );
      expect(await dirtyPaths(vault)).toEqual([]);

      const ev = await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d?.path === "del/doomed.md" && d?.removed === true,
        timeout: 8000,
      });
      expect(`removal frame reason is a slug: ${typeof ev.data?.reason === "string" && !!ev.data.reason}`).toBe(
        "removal frame reason is a slug: true"
      );
      expect(`removal frame is not a plain write: ${ev.data?.reason !== "write"}`).toBe(
        "removal frame is not a plain write: true"
      );
    } finally {
      sse.close();
    }
  }, 45000);

  test("deleting a folder removes its subtree and nothing else, in one commit", async () => {
    const before = await commitCount(vault);

    const r = await deleteDoc(srv, "delf/sub");
    expect(`DELETE a folder → ${r.status}`).toBe("DELETE a folder → 204");

    expect(`delf/sub/sub-a.md gone: ${!vaultHas(vault, "delf/sub/sub-a.md")}`).toBe("delf/sub/sub-a.md gone: true");
    expect(`delf/sub/sub-b.md gone: ${!vaultHas(vault, "delf/sub/sub-b.md")}`).toBe("delf/sub/sub-b.md gone: true");
    expect(`delf/sub/blob.bin gone: ${!vaultHas(vault, "delf/sub/blob.bin")}`).toBe("delf/sub/blob.bin gone: true");
    expectFileBytes(vault, "delf/keep.md", MD_KEEP, "the sibling doc survives");

    const tree = await srv.get("/api/docs");
    const listed = JSON.stringify(tree.body.tree);
    expect(`tree still lists the deleted subtree: ${listed.includes("delf/sub/")}`).toBe(
      "tree still lists the deleted subtree: false"
    );
    expect(`tree still lists the sibling: ${listed.includes("delf/keep.md")}`).toBe(
      "tree still lists the sibling: true"
    );

    await expectOneCommit(vault, before, "the delete");
    expect(await commitFiles(vault)).toEqual(
      ["delf/sub/sub-a.md", "delf/sub/sub-b.md", "delf/sub/blob.bin"].sort()
    );
    expect(await dirtyPaths(vault)).toEqual([]);
  }, 45000);
});

/* ============================================================
   7 — round trip: a move is a move, not a normalization pass
   ============================================================ */

describe("PATCH /api/docs — byte fidelity across a move (SPEC §11 round-trip)", () => {
  test("CRLF, tabs, trailing spaces and a missing final newline survive a rename", async () => {
    const r = await patchDoc(srv, "rt/weird.md", { to: "rt/weird-moved.md" });
    expect(`PATCH → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH → 200 ${r.text.slice(0, 200)}`);
    expectFileBytes(vault, "rt/weird-moved.md", MD_WEIRD, "byte-hostile doc after a move");
    expect(r.body.bytes).toBe(Buffer.byteLength(MD_WEIRD, "utf8"));

    const got = await srv.doc("rt/weird-moved.md");
    expect(got.body.markdown).toBe(MD_WEIRD);
  }, 30000);

  test("rewriting a link inside a CRLF file changes only the link", async () => {
    const r = await patchDoc(srv, "rt/crlf-target.md", { to: "rt/crlf-renamed.md" });
    expect(`PATCH → ${r.status} ${r.text.slice(0, 200)}`).toBe(`PATCH → 200 ${r.text.slice(0, 200)}`);
    expect([...(r.body.updated ?? [])].sort()).toEqual(["rt/crlf-ref.md"]);
    expectFileBytes(
      vault,
      "rt/crlf-ref.md",
      MD_CRLF_REF.replace("[[crlf-target]]", "[[crlf-renamed]]"),
      "CRLF referrer: only the link changed"
    );
  }, 30000);
});

/* ============================================================
   8 — atomicity: all files, or none (phase-4 accept() rollback precedent)
   ============================================================ */

describe("PATCH /api/docs — a failed rewrite rolls everything back", () => {
  const AMD = "# Atomic src\n\nmoving target\n";
  const REF1 = "# Ref one\n\nlinks [[atomic-src]] first\n";
  const REF2 = "# Ref two\n\nlinks [[atomic-src]] second\n";

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  test.skipIf(asRoot)(
    "an unwritable referrer aborts the whole move: no file modified, no commit, 5xx",
    async () => {
      const av = makeVault({
        "inbox.md": "# Inbox\n\n",
        "mv/atomic-src.md": AMD,
        "aaa/ref1.md": REF1,
        "zzz/ref2.md": REF2,
      });
      orphanVaults.push(av);
      await initRepo(av);
      const asrv = await startServer({ vault: av });
      const locked = join(av, "zzz");

      try {
        const before = await commitCount(av);
        /* r-x: the directory can be read and its file can be read, but no file
           in it can be created, replaced or renamed into place — whichever
           write strategy the backend uses, the rewrite of zzz/ref2.md fails */
        chmodSync(locked, 0o555);

        const r = await patchDoc(asrv, "mv/atomic-src.md", { to: "mv/atomic-dst.md" });
        expect(
          `PATCH over an unwritable referrer is 5xx: ${r.status >= 500 && r.status <= 599} ` +
            `(got ${r.status} ${r.text.slice(0, 200)})`
        ).toBe(`PATCH over an unwritable referrer is 5xx: true (got ${r.status} ${r.text.slice(0, 200)})`);
        expect(`the failure carries an error slug: ${typeof r.body?.error === "string" && !!r.body.error}`).toBe(
          "the failure carries an error slug: true"
        );
        /* 501 not-implemented is 5xx too — this gate is about a *failed move*,
           not about the endpoint being absent */
        expect(`the 5xx is a real failure, not a stub: ${r.status !== 501 && r.body?.error !== "not-implemented"}`).toBe(
          "the 5xx is a real failure, not a stub: true"
        );
        expect(
          `the failure carries a human message: ${typeof r.body?.message === "string" && r.body.message.length > 0}`
        ).toBe("the failure carries a human message: true");

        chmodSync(locked, 0o755);

        /* NOTHING moved and NOTHING was rewritten */
        expectFileBytes(av, "mv/atomic-src.md", AMD, "the source is still at its old path");
        expect(`the destination was left behind: ${vaultHas(av, "mv/atomic-dst.md")}`).toBe(
          "the destination was left behind: false"
        );
        expectFileBytes(av, "aaa/ref1.md", REF1, "the referrer written before the failure was rolled back");
        expectFileBytes(av, "zzz/ref2.md", REF2, "the referrer that could not be written is unchanged");

        /* the API still resolves the doc where it was */
        const still = await asrv.doc("mv/atomic-src.md");
        expect(`GET the source after the failure → ${still.status}`).toBe("GET the source after the failure → 200");
        expect(still.body.markdown).toBe(AMD);
        expect((await asrv.doc("mv/atomic-dst.md")).status).toBe(404);

        await sleep(SETTLE);
        expect(`commits added by the failed move: ${(await commitCount(av)) - before}`).toBe(
          "commits added by the failed move: 0"
        );
        expect(await dirtyPaths(av)).toEqual([]);
      } finally {
        try {
          chmodSync(locked, 0o755);
        } catch {}
        await asrv.stop();
      }
    },
    60000
  );
});

/* ============================================================
   9 — AI isolation (SPEC §8: "no delete/rename", §1 out of scope)

   Two independent gates: the tool SURFACE the model is given, and the
   BEHAVIOUR when a model invents a delete/rename anyway.
   ============================================================ */

describe("the AI cannot rename or delete (SPEC §8)", () => {
  const KEY = "sk-mock-FILEOPSCANARY-2f81";
  const P = "ai/victim.md";
  const VICTIM = "# Victim\n\nthe assistant may edit this and nothing more\n";

  let aisrv: TestServer;
  let mock: MockUpstream;

  beforeAll(async () => {
    mock = await startMockUpstream();
    aisrv = await startServer({
      seed: { "inbox.md": "# Inbox\n\n", [P]: VICTIM, "ai/other.md": "# Other\n\nlinks [[victim]]\n" },
    });
    const r = await aisrv.api("PUT", "/api/settings", {
      ai: { baseUrl: mock.baseUrl, apiKey: KEY, model: "gpt-5", effort: "high" },
      git: { autoSync: false },
    });
    expect(`PUT /api/settings → ${r.status}`).toBe("PUT /api/settings → 200");
    await sleep(250); // the capability probe is fire-and-forget
  }, 60000);

  afterAll(async () => {
    if (aisrv) await aisrv.stop();
    if (mock) await mock.stop();
  });

  test("the propose_edits schema offers exactly four ops, none of them destructive", async () => {
    mock.reset();
    mock.script(reply.text("nothing to change"));
    await turn(aisrv, { content: "say hello", docPath: P });

    const sent = mock.streamed()[0];
    expect(`the relay reached upstream: ${!!sent}`).toBe("the relay reached upstream: true");

    const tools: any[] = sent.body?.tools ?? [];
    const names = tools.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean).sort();
    expect(names).toEqual(["propose_edits"]);

    const tool = tools.map((t: any) => (t?.name ? t : t?.function)).find((t: any) => t?.name === "propose_edits");
    const ops = tool?.parameters?.properties?.edits?.items?.properties?.op?.enum;
    expect(Array.isArray(ops) ? [...ops].sort() : ops).toEqual(["create", "insert_after", "replace", "rewrite"]);

    /* no destructive verb anywhere in the schema the model is handed */
    const schema = JSON.stringify(tools);
    for (const verb of ["delete_doc", "rename_doc", "move_doc", "remove_doc", "unlink"]) {
      expect(`the tool schema mentions ${verb}: ${schema.includes(verb)}`).toBe(
        `the tool schema mentions ${verb}: false`
      );
    }
    /* the schema has no field a rename could ride in on */
    const editProps = Object.keys(tool?.parameters?.properties?.edits?.items?.properties ?? {}).sort();
    expect(editProps).toEqual(["content", "find", "note", "op", "path", "replace"]);
  }, 45000);

  test("a propose_edits call whose op is a delete or a rename is rejected, with no proposal and no disk change", async () => {
    for (const shape of [
      { label: "delete", args: toolArgs("remove it", [{ op: "delete" as any, path: P, content: null }]) },
      {
        label: "rename",
        args: toolArgs("rename it", [{ op: "rename" as any, path: P, content: "ai/renamed.md" }]),
      },
      { label: "move", args: toolArgs("move it", [{ op: "move" as any, path: P, content: "elsewhere/victim.md" }]) },
    ]) {
      mock.reset();
      /* five identical replies so the retry ladder cannot rescue it by luck */
      mock.script(...Array.from({ length: 5 }, () => reply.tool(shape.args)));

      const s = await turn(aisrv, { content: `please ${shape.label} that doc`, docPath: P });
      const done = s.done();

      expect(`${shape.label}: proposal → ${done?.proposal ?? null}`).toBe(`${shape.label}: proposal → null`);
      expect(`${shape.label}: the failure was surfaced to the user: ${
        s.errors().length > 0 || (done?.messages?.length ?? 0) > 0
      }`).toBe(`${shape.label}: the failure was surfaced to the user: true`);

      const list = await aisrv.get("/api/ai/proposals");
      const mine = (list.body.proposals ?? []).filter((x: any) => x.target === P || x.target === "ai/renamed.md");
      expect(`${shape.label}: proposals recorded for the victim: ${mine.length}`).toBe(
        `${shape.label}: proposals recorded for the victim: 0`
      );

      expectFileBytes(aisrv.vault, P, VICTIM, `${shape.label}: the victim is byte-identical`);
      expect(`${shape.label}: a renamed copy appeared: ${vaultHas(aisrv.vault, "ai/renamed.md")}`).toBe(
        `${shape.label}: a renamed copy appeared: false`
      );
      expect(`${shape.label}: a moved copy appeared: ${vaultHas(aisrv.vault, "elsewhere/victim.md")}`).toBe(
        `${shape.label}: a moved copy appeared: false`
      );
      expect(`${shape.label}: the doc still resolves: ${(await aisrv.doc(P)).status}`).toBe(
        `${shape.label}: the doc still resolves: 200`
      );
    }
  }, 90000);

  test("ai.ts has no route to the rename/delete machinery at all", async () => {
    /* comments are allowed to *discuss* the restriction (and ai.ts does); code
       is not allowed to implement it. Block comments and whole-line `//`
       comments go; a trailing `//` is left alone so a URL inside a string can
       never swallow real code. */
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
    const src = stripComments(readFileSync(join(REPO_ROOT, "ai.ts"), "utf8"));

    /* no destructive tool name is defined or referenced */
    for (const verb of ["delete_doc", "rename_doc", "move_doc", "remove_doc", "delete_folder"]) {
      expect(`ai.ts references ${verb}: ${new RegExp(`\\b${verb}\\b`).test(src)}`).toBe(
        `ai.ts references ${verb}: false`
      );
    }

    /* the op set is a closed literal of exactly the four SPEC §8 ops */
    const opsLine = /new Set\(\[([^\]]*)\]\)/.exec(src.slice(src.indexOf("OPS")));
    expect(`ai.ts declares an OPS set: ${!!opsLine}`).toBe("ai.ts declares an OPS set: true");
    const declared = (opsLine?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();
    expect(declared).toEqual(["create", "insert_after", "replace", "rewrite"]);

    /* and it never calls the HTTP file-op surface either */
    expect(`ai.ts mentions /api/docs: ${src.includes("/api/docs")}`).toBe("ai.ts mentions /api/docs: false");

    /* whatever module ends up owning move/rename, ai.ts must not import it */
    const imports = [...src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["']/g)]
      .map((m) => m[1])
      .join(",");
    for (const fn of ["moveDoc", "renameDoc", "deleteDoc", "removeDoc", "movePath", "renamePath"]) {
      expect(`ai.ts imports ${fn}: ${new RegExp(`\\b${fn}\\b`).test(imports)}`).toBe(`ai.ts imports ${fn}: false`);
    }
  }, 20000);
});

/* ============================================================
   10 — the claims phase 5 made that nothing used to hold it to.

   Every test below pins a defect that shipped green: a rename target that
   breaks out of `[[…]]`, a case-only rename git silently refused, a folder op
   that stranded its attachments, a blockquoted fence the rewriter and the
   renderer disagreed about, the `to === from` split between docs and folders,
   the SSE pair order API.md fixes, a commit skipped without a word, and the
   AI change stack under a human rename or delete.
   ============================================================ */

describe("PATCH /api/docs — a name that cannot survive a [[link]] is refused (SPEC §5)", () => {
  test("`]]` and a newline in the target are 400 bad-path, and every referrer is byte-identical", async () => {
    const V = makeVault({
      "a.md": "# A\n\nthe target\n",
      "ref.md": "prose [[a]] prose\n",
    });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      for (const [label, to] of [
        ["closing delimiter", "x]]y.md"],
        ["stray bracket", "x]y.md"],
        ["newline", "x\ny.md"],
        ["carriage return", "x\ry.md"],
      ] as Array<[string, string]>) {
        const r = await patchDoc(s, "a.md", { to });
        expect(`${label} → ${r.status} ${r.body?.error}`).toBe(`${label} → 400 bad-path`);
        expect(`${label}: a.md is still there: ${vaultHas(V, "a.md")}`).toBe(`${label}: a.md is still there: true`);
        /* the whole point: the damage would land in a doc the user never opened */
        expectFileBytes(V, "ref.md", "prose [[a]] prose\n", `${label}: the referrer is untouched`);
      }

      /* the guard is about the delimiter, not about punctuation — `[[`, `|`,
         `#` and a backtick all round-trip and must keep working */
      const ok = await patchDoc(s, "a.md", { to: "x[[y#z|w`v.md" });
      expect(`a name full of harmless punctuation → ${ok.status}`).toBe("a name full of harmless punctuation → 200");
      expectFileBytes(V, "ref.md", "prose [[x[[y#z|w`v]] prose\n", "the harmless name rewrote cleanly");
      /* …and the rewritten link still resolves, which is what `]]` destroyed */
      const back = await patchDoc(s, "x[[y#z|w`v.md", { to: "a.md" });
      expect(`the inverse rename → ${back.status} · ${back.body?.backlinksUpdated} link(s)`).toBe(
        "the inverse rename → 200 · 1 link(s)"
      );
      expectFileBytes(V, "ref.md", "prose [[a]] prose\n", "the inverse rename restored the referrer exactly");
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("PATCH /api/docs — a case-only rename really reaches git", () => {
  test("Foo.md → foo.md: 200, backlinks rewritten, ONE commit, and HEAD holds only the new spelling", async () => {
    const V = makeVault({
      "case/Foo.md": "# Foo\n\nthe doc\n",
      "case/ref.md": "link [[Foo]] here\n",
    });
    orphanVaults.push(V);
    await initRepo(V);
    const s = await startServer({ vault: V });
    try {
      const before = await commitCount(V);
      const r = await patchDoc(s, "case/Foo.md", { to: "case/foo.md" });
      expect(`case-only rename → ${r.status} ${r.text.slice(0, 160)}`).toBe(`case-only rename → 200 ${r.text.slice(0, 160)}`);
      expect(r.body.path).toBe("case/foo.md");
      expect(`backlinksUpdated: ${r.body.backlinksUpdated}`).toBe("backlinksUpdated: 1");
      expectFileBytes(V, "case/ref.md", "link [[foo]] here\n", "the backlink followed the case change");

      /* the defect: the commit died on `pathspec … did not match any file(s)
         known to git`, the rename never landed, and a case-sensitive clone got
         `Foo.md` with every backlink pointing at `[[foo]]` — while the app said
         "synced". The response now says so too when a commit is skipped. */
      expect(`the move reports it was committed: ${r.body.committed}`).toBe("the move reports it was committed: true");
      expect(`commitNote when it committed: ${r.body.commitNote}`).toBe("commitNote when it committed: null");

      await expectOneCommit(V, before, "the case-only rename");
      const tree = (await gitOk(V, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").map((x) => x.trim()).filter(Boolean).sort();
      expect(tree).toEqual(["case/foo.md", "case/ref.md"]);
      expect(await dirtyPaths(V)).toEqual([]);
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("file ops report a commit they could not make (SPEC §5 'one commit')", () => {
  test("mid-merge: the move still lands on disk, and the response says the commit was skipped", async () => {
    const V = makeVault({
      "m.md": "# M\n\nbase\n",
      "notes/mover.md": "# Mover\n\nmoves\n",
      "notes/ref.md": "see [[mover]] here\n",
      "notes/doomed.md": "# Doomed\n\ngoes away\n",
    });
    orphanVaults.push(V);
    await initRepo(V);
    /* park the repo mid-merge with a real conflict, the way ai.test.ts does for
       accept() — commitPaths refuses, by RETURNING a reason, never throwing */
    await gitOk(V, "checkout", "-q", "-b", "side");
    writeFileSync(join(V, "m.md"), "# M\n\nside\n");
    await gitOk(V, "commit", "-qam", "side");
    await gitOk(V, "checkout", "-q", "main");
    writeFileSync(join(V, "m.md"), "# M\n\nmain\n");
    await gitOk(V, "commit", "-qam", "main");
    const merge = await git(V, "merge", "side");
    expect(`the merge conflicted as intended: ${merge.code !== 0}`).toBe("the merge conflicted as intended: true");

    const s = await startServer({ vault: V });
    try {
      const before = await commitCount(V);
      const r = await patchDoc(s, "notes/mover.md", { to: "notes/moved.md" });
      expect(`mid-merge PATCH → ${r.status}`).toBe("mid-merge PATCH → 200");
      /* the op itself is honoured — the guard is about git, not about the vault */
      expect(`the doc moved on disk: ${vaultHas(V, "notes/moved.md")}`).toBe("the doc moved on disk: true");
      expect(`backlinksUpdated: ${r.body.backlinksUpdated}`).toBe("backlinksUpdated: 1");

      /* the defect: `.catch(() => {})` on a function that never throws. The
         client got 200 and a "1 link rewritten" toast with nothing in git. */
      expect(`the response admits the commit was skipped: ${r.body.committed}`).toBe(
        "the response admits the commit was skipped: false"
      );
      expect(
        `the reason names the merge: ${typeof r.body.commitNote === "string" && /merge/i.test(r.body.commitNote)}`
      ).toBe("the reason names the merge: true");

      const d = await deleteDoc(s, "notes/doomed.md");
      expect(`mid-merge DELETE → ${d.status}`).toBe("mid-merge DELETE → 204");

      await sleep(SETTLE);
      expect(`commits made while mid-merge: ${(await commitCount(V)) - before}`).toBe("commits made while mid-merge: 0");
      /* and the skip is diagnosable rather than silent */
      const logged = s.stderrLines.join("\n");
      expect(`the skip reached the log: ${/commit skipped/.test(logged)}`).toBe("the skip reached the log: true");
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("PATCH /api/docs — links the RENDERER treats as live are rewritten", () => {
  test("an unbalanced blockquoted ``` does not swallow the rest of the file", async () => {
    const V = makeVault({
      "bq/target.md": "# Target\n\nbody\n",
      /* `> ``` ` is a fence for `linkRefs` but NOT for the renderer's
         `/^\s*```/` — it is blockquote content. So the pill after it is live on
         screen, and skipping it silently turned a working link broken. */
      "bq/loose.md": "live [[target]]\n\n> ```\nafter an unbalanced bq fence [[target]]\n",
      /* a WELL-FORMED blockquoted fence is inline code to the renderer, so its
         contents must still be left alone */
      "bq/tight.md": "> ```\n> quoted [[target]]\n> ```\n\nafter the block [[target]]\n",
    });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      const r = await patchDoc(s, "bq/target.md", { to: "bq/renamed.md" });
      expect(`PATCH → ${r.status}`).toBe("PATCH → 200");
      expectFileBytes(
        V,
        "bq/loose.md",
        "live [[renamed]]\n\n> ```\nafter an unbalanced bq fence [[renamed]]\n",
        "both live pills followed the rename"
      );
      expectFileBytes(
        V,
        "bq/tight.md",
        "> ```\n> quoted [[target]]\n> ```\n\nafter the block [[renamed]]\n",
        "a balanced blockquoted fence still shields its contents"
      );
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("PATCH /api/docs — a no-op is a no-op for both entity kinds", () => {
  test("`to === from` answers 200 for a folder exactly as for a doc", async () => {
    const V = makeVault({ "same/a.md": "# A\n\nbody\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      const doc = await patchDoc(s, "same/a.md", { to: "same/a.md" });
      expect(`doc no-op → ${doc.status}`).toBe("doc no-op → 200");
      expect(`doc no-op type/path: ${doc.body.type} ${doc.body.path}`).toBe("doc no-op type/path: file same/a.md");

      /* the self-containment guard used to fire first, so the same request
         answered 400 for a folder — a split API.md never documented */
      const dir = await patchDoc(s, "same", { to: "same" });
      expect(`folder no-op → ${dir.status} ${dir.body?.error ?? ""}`.trim()).toBe("folder no-op → 200");
      expect(`folder no-op type/path: ${dir.body.type} ${dir.body.path}`).toBe("folder no-op type/path: folder same");
      expect(`folder no-op backlinksUpdated: ${dir.body.backlinksUpdated}`).toBe("folder no-op backlinksUpdated: 0");

      /* genuinely moving a folder INTO itself is still refused */
      const inside = await patchDoc(s, "same", { to: "same/deep" });
      expect(`folder into itself → ${inside.status} ${inside.body?.error}`).toBe("folder into itself → 400 bad-path");

      expectFileBytes(V, "same/a.md", "# A\n\nbody\n", "nothing moved");

      /* API.md's table: DELETE of an existing NON-.md file is 404, not 204 */
      writeFileSync(join(V, "same", "notes.txt"), "not a doc\n");
      const d = await deleteDoc(s, "same/notes.txt");
      expect(`DELETE a non-.md file → ${d.status} ${d.body?.error}`).toBe("DELETE a non-.md file → 404 not-found");
      expect(`the non-doc survives: ${vaultHas(V, "same/notes.txt")}`).toBe("the non-doc survives: true");
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("SSE — the `moved` pair arrives in the order API.md documents", () => {
  test("old path (removed + to) first, then the new path (from)", async () => {
    const V = makeVault({ "ev/mover.md": "# Mover\n\nbody\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    const sse = await s.sse();
    try {
      const mark = sse.mark();
      const r = await patchDoc(s, "ev/mover.md", { to: "archive/mover.md" });
      expect(`PATCH → ${r.status}`).toBe("PATCH → 200");

      await sse.waitFor("doc-changed", {
        from: mark,
        match: (d) => d?.path === "archive/mover.md" && d?.from === "ev/mover.md",
        timeout: 8000,
      });
      const moved = sse
        .since(mark, "doc-changed")
        .map((e) => e.data)
        .filter((d: any) => d?.reason === "moved");
      const order = moved.map((d: any) => `${d.path}${d.removed ? " removed" : " from=" + d.from}`);
      expect(order.slice(0, 2)).toEqual(["ev/mover.md removed", "archive/mover.md from=ev/mover.md"]);
      expect(`the removal half carries "to": ${(moved[0] as any)?.to}`).toBe(
        'the removal half carries "to": archive/mover.md'
      );
    } finally {
      sse.close();
      await s.stop();
    }
  }, 60000);
});

describe("PATCH /api/docs — a doc that CARRIES an age fence moves untouched (SPEC §6)", () => {
  test("bytes identical, hasSecrets still true, no armor in search", async () => {
    const SECRET_DOC =
      "# Keys\n\nsome prose with [[plain]] in it\n\n```age\n" +
      ARMOR_BEGIN +
      "\n" +
      ARMOR_B64 +
      "\n" +
      ARMOR_END +
      "\n```\n\ntrailing prose\n";
    const V = makeVault({ "sec/keys.md": SECRET_DOC, "sec/plain.md": "# Plain\n\nbody\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      const r = await patchDoc(s, "sec/keys.md", { to: "sec/vault-keys.md" });
      expect(`PATCH a secret-bearing doc → ${r.status}`).toBe("PATCH a secret-bearing doc → 200");
      expectFileBytes(V, "sec/vault-keys.md", SECRET_DOC, "the ciphertext survived the move byte for byte");

      const tree = await s.get("/api/docs");
      const row = JSON.stringify(tree.body.tree);
      expect(`the moved doc is still flagged as carrying secrets: ${row.includes('"hasSecrets":true')}`).toBe(
        "the moved doc is still flagged as carrying secrets: true"
      );

      const hits = await s.get("/api/search?q=" + encodeURIComponent("AGE ENCRYPTED"));
      expect(`armor reachable through search after a move: ${JSON.stringify(hits.body).includes(ARMOR_BEGIN)}`).toBe(
        "armor reachable through search after a move: false"
      );
    } finally {
      await s.stop();
    }
  }, 60000);
});

/* ============================================================
   11 — the AI change stack meets the phase-5 file ops.

   SPEC §8 gives the assistant no delete and no rename. Two ways that boundary
   used to leak: `op:create` decided "the path is free" by asking readDoc(),
   which answers null for a file it merely cannot DECODE — so the assistant
   could overwrite a latin-1 note the human create path refuses, and revert then
   deleted it outright. And a proposal's pre-image is addressed by path, so a
   human rename or delete used to strand the whole stack behind a 409 naming a
   file that no longer exists.
   ============================================================ */

describe("the AI change stack under a human rename or delete", () => {
  const KEY = "sk-mock-STACKOPS-91af";
  const TARGET = "notes/target.md";
  const TARGET_MD = "# Target\n\nORIGINAL LINE\n";
  const SECOND = "notes/second.md";
  const SECOND_MD = "# Second\n\nsecond line\n";
  const EMPTIED = "notes/emptied.md";
  const EMPTIED_MD = "# Emptied\n\nprecious content\n";
  const LEGACY = "notes/legacy.md";
  /* `# Caf\xE9` in latin-1, then a UTF-16 BOM: readDoc's fatal decoder refuses
     it, exists() does not. */
  const LEGACY_BYTES = Uint8Array.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a, 0x0a, 0xff, 0xfe, 0x0a]);

  let asrv: TestServer;
  let mock: MockUpstream;

  const accept = (id: string) => asrv.api("POST", `/api/ai/proposals/${encodeURIComponent(id)}/accept`, {});
  const revert = (id: string) => asrv.api("POST", `/api/ai/proposals/${encodeURIComponent(id)}/revert`, {});

  async function propose(summary: string, edits: any[], docPath: string) {
    mock.reset();
    mock.script(reply.tool(toolArgs(summary, edits)));
    const done = (await turn(asrv, { content: summary, docPath })).done();
    return done?.proposal ?? null;
  }

  beforeAll(async () => {
    mock = await startMockUpstream();
    const v = makeVault({
      "inbox.md": "# Inbox\n\n",
      [TARGET]: TARGET_MD,
      [SECOND]: SECOND_MD,
      [EMPTIED]: EMPTIED_MD,
    });
    orphanVaults.push(v);
    writeFileSync(join(v, LEGACY), LEGACY_BYTES);
    asrv = await startServer({ vault: v });
    const r = await asrv.api("PUT", "/api/settings", {
      ai: { baseUrl: mock.baseUrl, apiKey: KEY, model: "gpt-5", effort: "high" },
      git: { autoSync: false },
    });
    expect(`PUT /api/settings → ${r.status}`).toBe("PUT /api/settings → 200");
    await sleep(250);
  }, 60000);

  afterAll(async () => {
    if (asrv) await asrv.stop();
    if (mock) await mock.stop();
  });

  test("op:create cannot overwrite a doc the server merely cannot decode", async () => {
    /* the human path refuses it — the AI must not be more powerful */
    const human = await asrv.api("POST", "/api/docs", { path: LEGACY, type: "doc", markdown: "# mine\n" });
    expect(`human create over an undecodable doc → ${human.status} ${human.body?.error}`).toBe(
      "human create over an undecodable doc → 409 exists"
    );
    expect(`the server will not serve it either: ${(await asrv.doc(LEGACY)).status}`).toBe(
      "the server will not serve it either: 404"
    );

    const p = await propose("replace the legacy note", [{ op: "create", path: LEGACY, content: "# Brand new\n" }], "inbox.md");
    expect(`a proposal was offered for an occupied path: ${!!p}`).toBe("a proposal was offered for an occupied path: false");

    /* the bytes are the assertion: this used to succeed, and revert then `rm`ed
       the file because the image claimed `existed:false` */
    const onDisk = readVaultBytes(asrv.vault, LEGACY);
    expectBytes(onDisk, LEGACY_BYTES, "the undecodable note is byte-identical");
  }, 60000);

  test("a human rename re-points the stack: revert still works, at the new path", async () => {
    const p = await propose(
      "rewrite the target",
      [{ op: "replace", path: TARGET, find: "ORIGINAL LINE", replace: "AI REWROTE THIS" }],
      TARGET
    );
    expect(`proposal offered: ${!!p}`).toBe("proposal offered: true");
    expect(`accept → ${(await accept(p.id)).status}`).toBe("accept → 200");
    expectFileBytes(asrv.vault, TARGET, "# Target\n\nAI REWROTE THIS\n", "the AI edit landed");

    const mv = await patchDoc(asrv, TARGET, { to: "notes/renamed.md" });
    expect(`human rename of an edited doc → ${mv.status}`).toBe("human rename of an edited doc → 200");

    /* the defect: revert answered 409 `drifted` naming notes/target.md — a path
       the user could no longer see — and every proposal beneath it was stuck
       behind it forever, because the stack is strictly LIFO */
    const listed = (await asrv.get("/api/ai/proposals")).body;
    const row = listed.proposals.find((x: any) => x.id === p.id);
    expect(`the moved proposal still points at the doc: ${row.target}`).toBe(
      "the moved proposal still points at the doc: notes/renamed.md"
    );
    expect(`it is still offered as revertable: ${row.revertable}`).toBe("it is still offered as revertable: true");

    const rv = await revert(p.id);
    expect(`revert after a rename → ${rv.status} ${rv.body?.error ?? ""}`.trim()).toBe("revert after a rename → 200");
    expectFileBytes(asrv.vault, "notes/renamed.md", TARGET_MD, "the pre-image was restored at the NEW path");
  }, 60000);

  test("a human delete is honest: no Revert button, and a 409 that names the real problem", async () => {
    const p = await propose(
      "touch the second doc",
      [{ op: "replace", path: SECOND, find: "second line", replace: "AI SECOND LINE" }],
      SECOND
    );
    expect(`proposal offered: ${!!p}`).toBe("proposal offered: true");
    expect(`accept → ${(await accept(p.id)).status}`).toBe("accept → 200");

    const del = await deleteDoc(asrv, SECOND);
    expect(`human delete → ${del.status}`).toBe("human delete → 204");

    const listed = (await asrv.get("/api/ai/proposals")).body;
    const row = listed.proposals.find((x: any) => x.id === p.id);
    expect(`a Revert button is still offered: ${row.revertable}`).toBe("a Revert button is still offered: false");
    expect(`the stack top is still offered: ${listed.stack[listed.stack.length - 1]?.revertable}`).toBe(
      "the stack top is still offered: false"
    );

    const rv = await revert(p.id);
    expect(`revert of a deleted target → ${rv.status} ${rv.body?.error}`).toBe(
      "revert of a deleted target → 409 target-gone"
    );
    expect(`the message says the doc is gone, not that it "changed": ${/no longer in the vault/i.test(rv.body?.message ?? "")}`).toBe(
      'the message says the doc is gone, not that it "changed": true'
    );
    expect(`the deleted doc stayed deleted: ${vaultHas(asrv.vault, SECOND)}`).toBe("the deleted doc stayed deleted: false");
  }, 60000);

  test("revert never resurrects a doc the human deleted, even when the post-image is empty", async () => {
    const p = await propose("empty it out", [{ op: "rewrite", path: EMPTIED, content: "" }], EMPTIED);
    expect(`proposal offered: ${!!p}`).toBe("proposal offered: true");
    expect(`accept → ${(await accept(p.id)).status}`).toBe("accept → 200");
    expectFileBytes(asrv.vault, EMPTIED, "", "the emptying rewrite landed");

    const del = await deleteDoc(asrv, EMPTIED);
    expect(`human delete → ${del.status}`).toBe("human delete → 204");

    /* an absent file used to read as "" and therefore MATCH the empty
       post-image, so an unrelated button undid a confirmed, human-only delete */
    const rv = await revert(p.id);
    expect(`revert after the delete → ${rv.status} ${rv.body?.error}`).toBe("revert after the delete → 409 target-gone");
    expect(`the deleted doc was resurrected: ${vaultHas(asrv.vault, EMPTIED)}`).toBe(
      "the deleted doc was resurrected: false"
    );
  }, 60000);
});

/* ============================================================
   POST /api/docs — creation (SPEC §5, API.md § POST /api/docs)

   The client grammar (`a/b/c.md`, `abc/`, a bare name) resolves entirely in the
   browser and arrives here as ONE path. What the backend owes that grammar is
   exactly three things, and this is where they are held:

     1. implicit parent folders, for BOTH entity kinds;
     2. a refusal that changes nothing — no clobber, no half-made tree;
     3. the same name guards the MOVE applies, applied at birth, so a name that
        cannot be renamed later cannot be created now.
   ============================================================ */

describe("POST /api/docs — implicit parents, for docs and for folders", () => {
  test("a/b/c.md makes a and a/b; a/b/c as a folder does the same", async () => {
    const V = makeVault({ "root.md": "# root\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      const doc = await s.api("POST", "/api/docs", { path: "a/b/c.md", type: "doc", markdown: "" });
      expect(`nested doc → ${doc.status}`).toBe("nested doc → 201");
      expect(`reply path: ${doc.body.path}`).toBe("reply path: a/b/c.md");
      expect(`a is a dir: ${statSync(join(V, "a")).isDirectory()}`).toBe("a is a dir: true");
      expect(`a/b is a dir: ${statSync(join(V, "a/b")).isDirectory()}`).toBe("a/b is a dir: true");
      expectFileBytes(V, "a/b/c.md", "", "the nested doc is the empty file that was asked for");

      const fold = await s.api("POST", "/api/docs", { path: "p/q/r", type: "folder" });
      expect(`nested folder → ${fold.status} ${fold.body.type}`).toBe("nested folder → 201 folder");
      for (const d of ["p", "p/q", "p/q/r"]) {
        expect(`${d} is a dir: ${statSync(join(V, d)).isDirectory()}`).toBe(`${d} is a dir: true`);
      }

      /* a doc path without .md gets it — the app can only make markdown docs */
      const bare = await s.api("POST", "/api/docs", { path: "a/b/plain", type: "doc" });
      expect(`bare name → ${bare.status} ${bare.body.path}`).toBe("bare name → 201 a/b/plain.md");
      expect(`a/b/plain (no ext) exists: ${vaultHas(V, "a/b/plain")}`).toBe("a/b/plain (no ext) exists: false");

      /* the new tree is INDEXED, not merely on disk */
      const tree = await s.get("/api/docs");
      const flat: string[] = [];
      const walk = (ns: any[]) => ns.forEach((n) => (n.type === "folder" ? walk(n.children) : flat.push(n.path)));
      walk(tree.body.tree);
      expect(`tree knows the nested doc: ${flat.includes("a/b/c.md")}`).toBe("tree knows the nested doc: true");
    } finally {
      await s.stop();
    }
  }, 60000);
});

describe("POST /api/docs — a create never clobbers and never half-lands", () => {
  test("409 on an existing doc, an existing folder, and a file in the middle of the path", async () => {
    const V = makeVault({ "have.md": "# have\n\noriginal bytes\n", "dir/inside.md": "# inside\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      const dupDoc = await s.api("POST", "/api/docs", { path: "have.md", type: "doc", markdown: "# CLOBBER\n" });
      expect(`duplicate doc → ${dupDoc.status} ${dupDoc.body.error}`).toBe("duplicate doc → 409 exists");
      expect(`message names the path: ${dupDoc.body.message}`).toBe("message names the path: have.md already exists.");
      expectFileBytes(V, "have.md", "# have\n\noriginal bytes\n", "the existing doc is byte-identical after the 409");

      /* the same doc, addressed WITHOUT its extension, is the same doc */
      const dupBare = await s.api("POST", "/api/docs", { path: "have", type: "doc", markdown: "# CLOBBER\n" });
      expect(`duplicate via bare name → ${dupBare.status} ${dupBare.body.error}`).toBe(
        "duplicate via bare name → 409 exists"
      );
      expectFileBytes(V, "have.md", "# have\n\noriginal bytes\n", "the bare-name duplicate clobbered nothing either");

      const dupFolder = await s.api("POST", "/api/docs", { path: "dir", type: "folder" });
      expect(`duplicate folder → ${dupFolder.status} ${dupFolder.body.error}`).toBe("duplicate folder → 409 exists");
      expectFileBytes(V, "dir/inside.md", "# inside\n", "the existing folder's contents survive");

      /* mkdir -p THROUGH a file is ENOTDIR out of the route; name the blocker */
      for (const [label, path, type] of [
        ["doc under a doc", "have.md/child.md", "doc"],
        ["folder under a doc", "have.md/child", "folder"],
        ["deeper under a doc", "have.md/a/b/c.md", "doc"],
      ] as Array<[string, string, string]>) {
        const r = await s.api("POST", "/api/docs", { path, type });
        expect(`${label} → ${r.status} ${r.body.error}`).toBe(`${label} → 409 exists`);
        expect(`${label} names the blocker: ${r.body.message}`).toBe(
          `${label} names the blocker: have.md is a doc, not a folder.`
        );
      }
      expectFileBytes(V, "have.md", "# have\n\noriginal bytes\n", "the blocking doc is still a doc, unmodified");
      expect(`nothing new at the root: ${readdirSync(V).sort().join(" ")}`).toBe(
        "nothing new at the root: .znotes dir have.md"
      );
    } finally {
      await s.stop();
    }
  }, 60000);

  test("a name that cannot survive a [[link]] is refused at creation, not only at rename", async () => {
    const V = makeVault({ "root.md": "# root\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      for (const [label, path, type] of [
        ["closing delimiter", "x]]y.md", "doc"],
        ["stray bracket", "x]y.md", "doc"],
        ["newline", "x\ny.md", "doc"],
        ["carriage return", "x\ry.md", "doc"],
        ["in a folder name", "x]]y", "folder"],
        ["in an intermediate segment", "x]]y/child.md", "doc"],
      ] as Array<[string, string, string]>) {
        const r = await s.api("POST", "/api/docs", { path, type });
        expect(`${label} → ${r.status} ${r.body.error}`).toBe(`${label} → 400 bad-path`);
      }
      expect(`the root is untouched: ${readdirSync(V).sort().join(" ")}`).toBe(
        "the root is untouched: .znotes root.md"
      );

      /* the guard is the delimiter, not punctuation: these must still work */
      const ok = await s.api("POST", "/api/docs", { path: "x[[y#z|w`v.md", type: "doc" });
      expect(`harmless punctuation → ${ok.status}`).toBe("harmless punctuation → 201");
    } finally {
      await s.stop();
    }
  }, 60000);

  test("traversal, .znotes and dot-segments are 400 and create nothing", async () => {
    const V = makeVault({ "root.md": "# root\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      for (const [label, path, type] of [
        ["parent traversal", "../escaped.md", "doc"],
        ["embedded traversal", "a/../../escaped.md", "doc"],
        ["absolute", "/tmp/escaped.md", "doc"],
        ["app-internal", ".znotes/leaked.md", "doc"],
        ["app-internal folder", ".znotes/sub", "folder"],
        ["dot segment", "a/./b.md", "doc"],
        ["dot-prefixed name", ".hidden.md", "doc"],
        ["empty", "", "doc"],
      ] as Array<[string, string, string]>) {
        const r = await s.api("POST", "/api/docs", { path, type });
        expect(`${label} → ${r.status} ${r.body.error}`).toBe(`${label} → 400 bad-path`);
      }
      expect(`.znotes/leaked.md created: ${vaultHas(V, ".znotes/leaked.md")}`).toBe(".znotes/leaked.md created: false");
      expect(`the root is untouched: ${readdirSync(V).sort().join(" ")}`).toBe(
        "the root is untouched: .znotes root.md"
      );
    } finally {
      await s.stop();
    }
  }, 60000);

  test("a create that cannot be written leaves NO implicit folders behind", async () => {
    const V = makeVault({ "root.md": "# root\n" });
    orphanVaults.push(V);
    const s = await startServer({ vault: V });
    try {
      /* Make the vault read-only so `writeDocAtomic`'s rename(2) into it fails
         AFTER the parents have been made. That is the exact shape of the
         failure the rollback exists for; without it the vault keeps `ro/a/b`
         forever, folders nobody asked for that no later create can explain. */
      mkdirSync(join(V, "ro"), { recursive: true });
      const before = readdirSync(join(V, "ro")).sort().join(" ");
      chmodSync(join(V, "ro"), 0o555);
      let r: any;
      try {
        r = await s.api("POST", "/api/docs", { path: "ro/a/b/c.md", type: "doc" });
      } finally {
        chmodSync(join(V, "ro"), 0o755);
      }
      expect(`an unwritable create → ${r.status >= 400}`).toBe("an unwritable create → true");
      expect(`ro/ after the failure: ${JSON.stringify(readdirSync(join(V, "ro")).sort().join(" "))}`).toBe(
        `ro/ after the failure: ${JSON.stringify(before)}`
      );
    } finally {
      await s.stop();
    }
  }, 60000);
});
