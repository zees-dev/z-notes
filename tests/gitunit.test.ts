/* ============================================================
   gitunit.test.ts — the three pieces of git.ts that are not reachable
   black-box from the HTTP surface, and that custody depends on:

     - `sanitizeRemote`, the ONLY thing standing between a remote URL's
       userinfo and `SyncStatus.remote` (the sync contract: "no credentials").
     - `gitMessage`, which decides whether `state:"error"` names something the
       user can act on or just repeats git's progress chatter.
     - the GIT_ASKPASS helper, which lives under `.znotes/tmp/` — an ignored
       directory a `git clean -xfd` deletes — and whose path used to be
       memoised for the lifetime of the process.

   Everything else about git.ts is measured end-to-end in gitsync.test.ts.
   ============================================================ */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { GitSync, gitMessage, sanitizeRemote } from "../server/git";
import { Vault } from "../server/vault";
import { dropVault, makeVault } from "./helpers";

const trash: string[] = [];
afterAll(() => {
  for (const d of trash) dropVault(d);
});

describe("sanitizeRemote", () => {
  test("reduces a remote to host + path", () => {
    expect(sanitizeRemote("https://github.com/z/vault.git")).toBe("github.com/z/vault");
    expect(sanitizeRemote("git@github.com:z/vault.git")).toBe("github.com/z/vault");
    expect(sanitizeRemote("ssh://git@example.com:2222/z/vault.git")).toBe("example.com/z/vault");
    expect(sanitizeRemote("")).toBeNull();
  });

  /* This value is published by GET /api/sync/status and by every `sync-status`
     SSE frame. A credential that survives the strip is a credential on the
     wire, so the strip may not assume the password is free of `/` or `@`. */
  test("strips userinfo whatever the credential contains", () => {
    const cases = [
      "https://x-access-token:ghp_TOKEN0123456789@github.com/z/vault.git",
      "https://user:sec%2Fret@example.com/z/vault.git",
      "https://user:p/ass@example.com/z/vault.git", // an unescaped slash
      "https://user:p@ss@example.com/z/vault.git", // an unescaped at-sign
      "https://user:tricky/@host@example.com/z/vault.git",
    ];
    for (const url of cases) {
      const out = String(sanitizeRemote(url));
      expect(out).not.toContain("@");
      expect(out).not.toContain("ghp_");
      expect(out).not.toContain("ass");
      expect(out).not.toContain("ret");
      expect(out).not.toContain("://");
      expect(out.endsWith("example.com/z/vault") || out === "github.com/z/vault").toBe(true);
    }
  });
});

describe("gitMessage", () => {
  /* `From <remote>` is the first line of every failed fetch/pull, and it names
     nothing the user can do — the actual cause is further down. */
  test("skips fetch progress and reports the real failure with its detail", () => {
    const stderr =
      "From /tmp/some-bare-origin\n" +
      " * branch            main       -> FETCH_HEAD\n" +
      "error: The following untracked working tree files would be overwritten by checkout:\n" +
      "\t.gitignore\n" +
      "Please move or remove them before you switch branches.\n" +
      "Aborting\n";
    const msg = gitMessage(stderr, "", "fallback");
    expect(msg).toContain("untracked working tree files");
    expect(msg).toContain(".gitignore");
    expect(msg).not.toMatch(/^From\b/);
  });

  test("keeps the path list under a bare header", () => {
    const stderr =
      "The following paths are ignored by one of your .gitignore files:\n" +
      "archive/old.md\n" +
      "hint: Use -f if you really want to add them.\n";
    const msg = gitMessage(stderr, "", "fallback");
    expect(msg).toContain("archive/old.md");
    expect(msg).not.toContain("hint:");
  });

  test("carries the actionable second line of a blocked rebase", () => {
    const msg = gitMessage(
      "error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.\n",
      "",
      "fallback"
    );
    expect(msg).toContain("unstaged changes");
    expect(msg).toContain("commit or stash");
  });

  test("falls back rather than returning an empty string", () => {
    expect(gitMessage("", "", "fallback")).toBe("fallback");
    expect(gitMessage("remote: Counting objects\n", "", "fallback")).toBe("fallback");
    expect(gitMessage("", "something on stdout\n", "fallback")).toBe("something on stdout");
  });
});

describe("the GIT_ASKPASS helper", () => {
  function sync(vault: string): GitSync {
    return new GitSync({
      vault: new Vault(vault),
      settings: { value: <T,>(_p: string, fb: T) => fb, credential: () => null },
      index: { getMeta: () => null, setMeta: () => {} },
    });
  }

  /* `.znotes/tmp/` is ignored, so `git clean -xfd` in the vault removes the
     helper. Caching only its PATH meant every authenticated push failed with
     "cannot exec" from then until the server was restarted. */
  test("is rewritten when it has been deleted, and is never group/other readable", async () => {
    const vault = makeVault();
    trash.push(vault);
    const gs = sync(vault);

    const first = await (gs as any).ensureAskpass();
    expect(existsSync(first)).toBe(true);
    expect(statSync(first).mode & 0o077).toBe(0);
    expect(first).toBe(join(vault, ".znotes", "tmp", "askpass.sh"));

    rmSync(join(vault, ".znotes", "tmp"), { recursive: true, force: true });
    expect(existsSync(first)).toBe(false);

    const second = await (gs as any).ensureAskpass();
    expect(second).toBe(first);
    expect(existsSync(second)).toBe(true);
    expect(statSync(second).mode & 0o077).toBe(0);
    expect(await Bun.file(second).text()).toContain("ZNOTES_GIT_PASSWORD");
  });
});
