/* ============================================================
   secrets.test.ts — PHASE 3 gate, bun side (SPEC §6, §11; the crypto design is
   fixed in docs/secrets-crypto.md and is NOT re-derived here).

   What this file measures, and nothing else:

     1. The FORMAT is really age v1 as specified — identity generated, wrapped
        under a passphrase with scrypt logN=18, PEM-armored, and unwrapped back
        to the same bytes; a wrong passphrase fails; a single flipped base64
        character fails the MAC and yields NO partial plaintext.
     2. The three new server endpoints (`GET /api/vault/identity`,
        `GET /api/vault/recipient`, `PUT /api/vault/identity`) behave, validate
        shapes only, and never decrypt anything.
     3. `.znotes/identity.age` + `.znotes/vault.pub` land in the phase-2 git
        tracked set (SPEC §7) once the endpoint has written them.
     4. The server has NO plaintext surface at all: no endpoint accepts a
        passphrase or a plaintext, the retired mock `POST /api/secrets/unlock`
        is gone, and no backend module imports the crypto library.
     5. `/vendor/age.js` — typage bundled server-side at startup — is served
        with an ETag and immutable caching (no build step, no committed
        artifact).

   COST BUDGET: scrypt at logN=18 is ~0.5–1 s per run by design. This file
   performs EXACTLY THREE scrypt operations (wrap once in beforeAll; unwrap
   right once; unwrap wrong once). Every other assertion is X25519-only
   (sub-millisecond) or pure HTTP. Do not add a fourth without deleting one.

   The library is imported directly — the implementer pins
   `age-encryption@0.3.0` in package.json; this file adds nothing.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as age from "age-encryption";
import {
  REPO_ROOT,
  dropVault,
  makeVault,
  readVaultText,
  startServer,
  vaultHas,
  writeVaultFile,
  type ApiResult,
  type SeedMap,
  type TestServer,
} from "./helpers";

/* ------------------------------------------------------------------
   fixed conventions of the phase (SPEC §6/§7, research §5.1)
   ------------------------------------------------------------------ */

const IDENTITY_REL = ".znotes/identity.age";
const RECIPIENT_REL = ".znotes/vault.pub";

const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_TAIL = "-----END AGE ENCRYPTED FILE-----";

/* ≥ 60 bits of estimated entropy, per research §5.4 — this is the fixture the
   whole file shares, and the ONLY string that must never be observable. */
const PASSPHRASE = "correct horse battery staple mango velvet";
const WRONG_PASSPHRASE = "correct horse battery staple mango velvel";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  "notes/alpha.md": "# Alpha\n\nfirst note\n",
};

/* ------------------------------------------------------------------
   the age fixtures, built once
   ------------------------------------------------------------------ */

let identity = ""; // AGE-SECRET-KEY-1…
let recipient = ""; // age1…
let wrappedIdentity = ""; // PEM armor of identity.age  ← scrypt op #1

/** an age block encrypted to the vault recipient — no KDF, sub-ms */
async function encryptToVault(plaintext: string): Promise<string> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return age.armor.encode(await e.encrypt(plaintext));
}

async function decryptWithVault(armor: string): Promise<string> {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(age.armor.decode(armor), "text");
}

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);

  const e = new age.Encrypter();
  e.setPassphrase(PASSPHRASE);
  e.setScryptWorkFactor(18); // research §7.2 — typage's default, stated explicitly
  wrappedIdentity = age.armor.encode(await e.encrypt(identity)); // scrypt #1
}, 30000);

/* ------------------------------------------------------------------
   servers / temp dirs
   ------------------------------------------------------------------ */

const running: TestServer[] = [];
const trash: string[] = [];

async function serverOn(vault: string, env?: Record<string, string>): Promise<TestServer> {
  const srv = await startServer({ vault, env });
  running.push(srv);
  return srv;
}

function tempVault(seed: SeedMap = SEED): string {
  const v = makeVault(seed);
  trash.push(v);
  return v;
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
   shape helpers

   `GET /api/vault/identity` is specified as "the armored contents of
   .znotes/identity.age". Whether that arrives as `text/plain` armor or as
   `{"identity": "<armor>"}` is the one thing the brief leaves open, so the
   assertion is on the ARMOR, not on the envelope: either envelope passes, a
   wrong/absent/mangled armor fails.
   ------------------------------------------------------------------ */

function armorOf(r: ApiResult): string {
  if (r.body && typeof r.body.identity === "string") return r.body.identity;
  return r.text;
}

const okStatus = (s: number) => s === 200 || s === 201;

/* Failure messages that name the offender. `expect(label(x)).toBe(label(want))`
   reads as an equality but prints the actual status / the leaking string. */
const status = (label: string, got: number, want: number[]) =>
  `${label} → ${want.includes(got) ? "ok" : got}`;
const statusOk = (label: string) => `${label} → ok`;

const leak = (label: string, hay: string, needle: string) =>
  `${label}: ${hay.includes(needle) ? "LEAKED" : "clean"}`;
const leakClean = (label: string) => `${label}: clean`;

/* ============================================================
   1. FORMAT — the age round trip itself
   ============================================================ */

describe("secrets — age identity wrap / unwrap (research §7.2)", () => {
  test("the wrapped identity is strict PEM armor carrying a logN=18 scrypt stanza", () => {
    const lines = wrappedIdentity.split("\n");
    expect(lines[0]).toBe(ARMOR_HEAD);
    expect(lines.filter((l) => l === ARMOR_TAIL).length).toBe(1);
    expect(wrappedIdentity.trimEnd().endsWith(ARMOR_TAIL)).toBe(true);

    /* RFC 7468 strict: base64 body wrapped at 64 columns */
    const body = lines.slice(1, lines.indexOf(ARMOR_TAIL));
    expect(body.length).toBeGreaterThan(0);
    for (const l of body) {
      expect(`${l.length} <= 64`).toBe(`${Math.min(l.length, 64)} <= 64`);
      expect(/^[A-Za-z0-9+/=]+$/.test(l)).toBe(true);
    }

    /* the header of an age file is plaintext inside the armor: decode it and
       read the stanza back, so the work factor is measured and not assumed */
    const header = new TextDecoder().decode(age.armor.decode(wrappedIdentity).slice(0, 120));
    expect(header.startsWith("age-encryption.org/v1\n")).toBe(true);
    expect(/^-> scrypt [A-Za-z0-9+/]+ 18$/m.test(header)).toBe(true);

    /* wrapping the identity must not leak it */
    expect(wrappedIdentity.includes(identity)).toBe(false);
    expect(wrappedIdentity.includes(PASSPHRASE)).toBe(false);
  });

  test("the right passphrase unwraps it to the exact identity, which matches the recipient", async () => {
    const d = new age.Decrypter();
    d.addPassphrase(PASSPHRASE);
    const out = await d.decrypt(age.armor.decode(wrappedIdentity), "text"); // scrypt #2

    expect(out).toBe(identity);
    expect(out.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    /* round trip is real, not an echo: the recovered identity derives the same
       public recipient, and that recipient is what blocks are encrypted to */
    expect(await age.identityToRecipient(out)).toBe(recipient);
    expect(recipient.startsWith("age1")).toBe(true);
  }, 30000);

  test("a wrong passphrase fails cleanly — no plaintext, no partial output", async () => {
    const d = new age.Decrypter();
    d.addPassphrase(WRONG_PASSPHRASE);

    let out: unknown = "NOT-ASSIGNED";
    let err: unknown = null;
    try {
      out = await d.decrypt(age.armor.decode(wrappedIdentity), "text"); // scrypt #3
    } catch (e) {
      err = e;
    }

    expect(err).not.toBe(null);
    expect(out).toBe("NOT-ASSIGNED"); // nothing was produced at all
    const msg = String((err as Error)?.message ?? err);
    expect(msg.includes(identity)).toBe(false);
    expect(msg.includes(PASSPHRASE)).toBe(false);
    expect(msg.includes("AGE-SECRET-KEY")).toBe(false);
  }, 30000);
});

describe("secrets — block integrity (age v1 header MAC + STREAM tags)", () => {
  const CANARY = "AWS_SECRET_ACCESS_KEY=CANARYALPHAONLY-QQXXJJVVBB";
  let block = "";

  beforeAll(async () => {
    /* long enough that the armor has a body several lines deep, so the flipped
       character below lands in the PAYLOAD and not only in the header */
    block = await encryptToVault(CANARY + "\n" + "filler line for a multi-chunk payload\n".repeat(6));
  });

  test("a block encrypted to the vault recipient decrypts with the identity", async () => {
    expect(block.startsWith(ARMOR_HEAD)).toBe(true);
    expect(block.includes(CANARY)).toBe(false); // the canary is not sitting in the armor
    const out = await decryptWithVault(block);
    expect(out.startsWith(CANARY + "\n")).toBe(true);
  });

  test("flipping ONE base64 character fails the MAC and yields no partial plaintext", async () => {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const target = lines.length - 3; // inside the payload, well past the header
    const orig = lines[target];
    expect(orig).not.toBe(ARMOR_TAIL);
    const at = 10;
    const flipped = orig[at] === "A" ? "B" : "A";
    lines[target] = orig.slice(0, at) + flipped + orig.slice(at + 1);
    expect(lines[target]).not.toBe(orig); // the tamper actually happened

    let out: unknown = "NOT-ASSIGNED";
    let err: unknown = null;
    try {
      out = await decryptWithVault(lines.join("\n") + "\n");
    } catch (e) {
      err = e;
    }
    expect(err).not.toBe(null);
    expect(out).toBe("NOT-ASSIGNED");
    expect(String((err as Error)?.message ?? err).includes("CANARYALPHAONLY")).toBe(false);
  });

  test("a truncated armor body fails rather than returning the chunks it could read", async () => {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const truncated = lines.slice(0, lines.length - 3).concat([ARMOR_TAIL]).join("\n") + "\n";

    let out: unknown = "NOT-ASSIGNED";
    let err: unknown = null;
    try {
      out = await decryptWithVault(truncated);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBe(null);
    expect(out).toBe("NOT-ASSIGNED");
  });

  test("a block encrypted to a DIFFERENT vault does not decrypt with this identity", async () => {
    const otherId = await age.generateIdentity();
    const otherRec = await age.identityToRecipient(otherId);
    const e = new age.Encrypter();
    e.addRecipient(otherRec);
    const foreign = age.armor.encode(await e.encrypt("NOT-FOR-THIS-VAULT"));

    let out: unknown = "NOT-ASSIGNED";
    try {
      out = await decryptWithVault(foreign);
    } catch {
      /* expected */
    }
    expect(out).toBe("NOT-ASSIGNED");
  });
});

/* ============================================================
   2. THE ENDPOINTS
   ============================================================ */

describe("secrets — GET /api/vault/identity + /api/vault/recipient", () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await serverOn(tempVault());
  }, 30000);

  test("both are 404 no-identity in a vault that has never been set up", async () => {
    for (const p of ["/api/vault/identity", "/api/vault/recipient"]) {
      const r = await srv.get(p);
      expect(`${p} → ${r.status}`).toBe(`${p} → 404`);
      expect(`${p} → ${r.body?.error}`).toBe(`${p} → no-identity`);
      /* a 404 must not be a doc-router accident: the slug is the contract the
         client branches on to offer "Create vault identity" */
    }
  });

  test("PUT writes both files, and the GETs return exactly what was written", async () => {
    const put = await srv.api("PUT", "/api/vault/identity", {
      identity: wrappedIdentity,
      recipient,
      replace: false,
    });
    expect(status("PUT /api/vault/identity", put.status, [200, 201])).toBe(statusOk("PUT /api/vault/identity"));

    /* on disk, byte-for-byte (the armor is the source of truth; a server that
       "normalises" it breaks `age -d .znotes/identity.age` recovery) */
    expect(vaultHas(srv.vault, IDENTITY_REL)).toBe(true);
    expect(vaultHas(srv.vault, RECIPIENT_REL)).toBe(true);
    expect(readVaultText(srv.vault, IDENTITY_REL)).toBe(wrappedIdentity);
    expect(readVaultText(srv.vault, RECIPIENT_REL).trim()).toBe(recipient);

    const gi = await srv.get("/api/vault/identity");
    expect(gi.status).toBe(200);
    expect(armorOf(gi)).toBe(wrappedIdentity);

    const gr = await srv.get("/api/vault/recipient");
    expect(gr.status).toBe(200);
    expect(gr.body?.recipient).toBe(recipient);
  });

  test("the served identity is still the real thing — it decrypts blocks end to end", async () => {
    /* the strongest statement this file can make about the endpoint: take the
       armor from HTTP, unwrap it with the fixture's identity (no scrypt — we
       already hold the identity), and use the RECIPIENT the server served to
       encrypt and then decrypt a fresh block. */
    const gr = await srv.get("/api/vault/recipient");
    const e = new age.Encrypter();
    e.addRecipient(String(gr.body.recipient));
    const armored = age.armor.encode(await e.encrypt("SERVED-RECIPIENT-WORKS"));
    expect(await decryptWithVault(armored)).toBe("SERVED-RECIPIENT-WORKS");

    const gi = await srv.get("/api/vault/identity");
    expect(age.armor.decode(armorOf(gi)).length).toBeGreaterThan(0); // parses as age armor
  });

  test("a second PUT without replace is 409 exists and changes nothing", async () => {
    const other = await age.generateIdentity();
    const otherRec = await age.identityToRecipient(other);
    const before = readVaultText(srv.vault, IDENTITY_REL);

    const r = await srv.api("PUT", "/api/vault/identity", {
      identity: wrappedIdentity,
      recipient: otherRec, // a DIFFERENT recipient, so a silent overwrite is visible
    });
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("exists");

    expect(readVaultText(srv.vault, IDENTITY_REL)).toBe(before);
    expect(readVaultText(srv.vault, RECIPIENT_REL).trim()).toBe(recipient); // NOT otherRec
  });

  test("replace:true rewrites both files together", async () => {
    const other = await age.generateIdentity();
    const otherRec = await age.identityToRecipient(other);
    const e = new age.Encrypter();
    e.addRecipient(otherRec);
    /* a cheap stand-in for a re-wrapped identity: any valid age armor. The
       endpoint validates SHAPE only — it must not decrypt, so it cannot know
       or care that this armor is X25519 rather than scrypt. */
    const otherWrapped = age.armor.encode(await e.encrypt("second identity"));

    const r = await srv.api("PUT", "/api/vault/identity", {
      identity: otherWrapped,
      recipient: otherRec,
      replace: true,
    });
    expect(okStatus(r.status)).toBe(true);
    expect(readVaultText(srv.vault, IDENTITY_REL)).toBe(otherWrapped);
    expect(readVaultText(srv.vault, RECIPIENT_REL).trim()).toBe(otherRec);

    /* put the fixture back so later tests in this describe see the real vault */
    const back = await srv.api("PUT", "/api/vault/identity", {
      identity: wrappedIdentity,
      recipient,
      replace: true,
    });
    expect(okStatus(back.status)).toBe(true);
    expect(readVaultText(srv.vault, RECIPIENT_REL).trim()).toBe(recipient);
  });
});

describe("secrets — PUT /api/vault/identity validates shapes and nothing else", () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await serverOn(tempVault());
  }, 30000);

  const garbage: Array<[string, unknown]> = [
    ["identity missing", { recipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }],
    ["recipient missing", { identity: "PLACEHOLDER-ARMOR" }],
    ["identity is not armor", { identity: "just some text", recipient: "age1qqqqqqqqqqqqqqqq" }],
    [
      "identity is PGP armor",
      {
        identity: "-----BEGIN PGP MESSAGE-----\nAAAA\n-----END PGP MESSAGE-----\n",
        recipient: "age1qqqqqqqqqqqqqqqq",
      },
    ],
    ["identity is not a string", { identity: 12345, recipient: "age1qqqqqqqqqqqqqqqq" }],
    ["recipient lacks the age1 prefix", { identity: "PLACEHOLDER-ARMOR", recipient: "AGE-SECRET-KEY-1XYZ" }],
    ["recipient is an ssh key", { identity: "PLACEHOLDER-ARMOR", recipient: "ssh-ed25519 AAAAC3Nz" }],
    ["recipient is not a string", { identity: "PLACEHOLDER-ARMOR", recipient: { r: "age1abc" } }],
    ["body is empty", {}],
  ];

  test("garbage is rejected with 400 and never touches the vault", async () => {
    for (const [label, raw] of garbage) {
      const body: any = { ...(raw as any) };
      if (body.identity === "PLACEHOLDER-ARMOR") body.identity = wrappedIdentity;
      const r = await srv.api("PUT", "/api/vault/identity", body);
      expect(`${label} → ${r.status}`).toBe(`${label} → 400`);
      expect(`${label} wrote identity.age: ${vaultHas(srv.vault, IDENTITY_REL)}`).toBe(
        `${label} wrote identity.age: false`
      );
      expect(`${label} wrote vault.pub: ${vaultHas(srv.vault, RECIPIENT_REL)}`).toBe(
        `${label} wrote vault.pub: false`
      );
    }

    /* control: the same endpoint accepts the well-shaped pair, so the loop
       above is measuring validation and not a dead route */
    const ok = await srv.api("PUT", "/api/vault/identity", { identity: wrappedIdentity, recipient });
    expect(okStatus(ok.status)).toBe(true);
    expect(vaultHas(srv.vault, IDENTITY_REL)).toBe(true);
  }, 30000);

  test("a failed PUT is atomic — a bad recipient never leaves a written identity behind", async () => {
    const vault = tempVault();
    const s2 = await serverOn(vault);
    const r = await s2.api("PUT", "/api/vault/identity", { identity: wrappedIdentity, recipient: "nope" });
    expect(r.status).toBe(400);
    expect(vaultHas(vault, IDENTITY_REL)).toBe(false);
    expect(vaultHas(vault, RECIPIENT_REL)).toBe(false);
    /* and the vault is still usable: the GETs report the same clean 404 */
    expect((await s2.get("/api/vault/identity")).body?.error).toBe("no-identity");
  }, 30000);
});

/* ============================================================
   3. GIT — the two files join the phase-2 tracked set (SPEC §7)
   ============================================================ */

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

describe("secrets — identity.age and vault.pub are committed (SPEC §7)", () => {
  test("a sync after PUT /api/vault/identity commits both files", async () => {
    const vault = tempVault();
    await gitOk(vault, "init", "-b", "main");
    await gitOk(vault, "config", "user.name", "z-notes test");
    await gitOk(vault, "config", "user.email", "test@z-notes.invalid");
    await gitOk(vault, "config", "commit.gpgsign", "false");
    await gitOk(vault, "add", ".");
    await gitOk(vault, "commit", "-m", "initial");

    const srv = await serverOn(vault);

    /* control: before the PUT neither file is tracked */
    const before = (await gitOk(vault, "ls-files")).split("\n").map((s) => s.trim());
    expect(before.includes(IDENTITY_REL)).toBe(false);
    expect(before.includes(RECIPIENT_REL)).toBe(false);

    const put = await srv.api("PUT", "/api/vault/identity", { identity: wrappedIdentity, recipient });
    expect(okStatus(put.status)).toBe(true);

    const sync = await srv.api("POST", "/api/sync/now", {});
    expect(sync.status).toBe(200);

    const tracked = (await gitOk(vault, "ls-files")).split("\n").map((s) => s.trim());
    expect(tracked.includes(IDENTITY_REL)).toBe(true);
    expect(tracked.includes(RECIPIENT_REL)).toBe(true);
    expect(tracked.includes(".znotes/index.db")).toBe(false); // the credential store never goes

    /* the committed bytes are the armor, unchanged */
    const committed = await gitOk(vault, "show", `HEAD:${IDENTITY_REL}`);
    expect(committed).toBe(wrappedIdentity);

    /* and the passphrase is nowhere in the repository's object store */
    const objects = await gitOk(vault, "cat-file", "--batch-all-objects", "--batch");
    expect(objects.includes(PASSPHRASE)).toBe(false);
    expect(objects.includes(identity)).toBe(false);
    expect(objects.includes(ARMOR_HEAD)).toBe(true); // positive control: we really read the blobs
  }, 60000);
});

/* ============================================================
   4. NO PLAINTEXT SURFACE ANYWHERE ON THE SERVER
   ============================================================ */

describe("secrets — the server has no plaintext surface (SPEC §3 delta 1, §6)", () => {
  let srv: TestServer;
  let vault: string;

  beforeAll(async () => {
    vault = tempVault();
    srv = await serverOn(vault);
    const r = await srv.api("PUT", "/api/vault/identity", { identity: wrappedIdentity, recipient });
    expect(okStatus(r.status)).toBe(true);
  }, 30000);

  test("the retired mock route POST /api/secrets/unlock is gone", async () => {
    const r = await srv.api("POST", "/api/secrets/unlock", {
      path: "notes/alpha.md",
      passphrase: PASSPHRASE,
    });
    expect(r.status).toBe(404);
    expect(r.body?.plaintext).toBeUndefined();
    expect(r.text.includes(PASSPHRASE)).toBe(false); // not even echoed back
  });

  test("no /api/secrets/* or vault decryption route exists", async () => {
    const probes: Array<[string, string, unknown]> = [
      ["POST", "/api/secrets/unlock", { passphrase: PASSPHRASE }],
      ["POST", "/api/secrets/decrypt", { armor: ARMOR_HEAD, passphrase: PASSPHRASE }],
      ["POST", "/api/secrets/encrypt", { plaintext: "hunter2" }],
      ["GET", "/api/secrets", undefined],
      ["POST", "/api/vault/unlock", { passphrase: PASSPHRASE }],
      ["POST", "/api/vault/decrypt", { armor: ARMOR_HEAD }],
      ["POST", "/api/vault/identity/unwrap", { passphrase: PASSPHRASE }],
    ];
    for (const [method, path, body] of probes) {
      const label = `${method} ${path}`;
      const r = await srv.api(method, path, body);
      expect(status(label, r.status, [404, 405])).toBe(statusOk(label));
      expect(leak(label, r.text, PASSPHRASE)).toBe(leakClean(label));
    }
  });

  test("a passphrase smuggled into PUT /api/vault/identity is rejected or dropped on the floor", async () => {
    const r = await srv.api("PUT", "/api/vault/identity", {
      identity: wrappedIdentity,
      recipient,
      replace: true,
      passphrase: PASSPHRASE,
      plaintext: "AWS_SECRET_ACCESS_KEY=hunter2",
    });

    /* Either answer is correct — refuse the unknown field, or ignore it. What
       is NOT correct is persisting or echoing it. */
    expect([200, 201, 400]).toContain(r.status);
    expect(r.text.includes(PASSPHRASE)).toBe(false);
    expect(r.text.includes("hunter2")).toBe(false);

    /* nothing under the vault carries either string */
    const files = vaultFiles(vault);
    expect(files.length).toBeGreaterThan(0); // the scan really walked something
    for (const [rel, bytes] of files) {
      expect(leak(`${rel} / passphrase`, bytes, PASSPHRASE)).toBe(leakClean(`${rel} / passphrase`));
      expect(leak(`${rel} / plaintext`, bytes, "hunter2")).toBe(leakClean(`${rel} / plaintext`));
    }
  });

  test("nothing the server ever printed contains the passphrase or the identity", async () => {
    const out = srv.stdoutLines.concat(srv.stderrLines).join("\n");
    expect(out.includes(PASSPHRASE)).toBe(false);
    expect(out.includes(identity)).toBe(false);
    expect(out.includes("AGE-SECRET-KEY")).toBe(false);
    expect(out.includes("hunter2")).toBe(false);
  });

  test("no backend module imports the crypto library — the server cannot decrypt", async () => {
    const glob = new Bun.Glob("*.ts");
    const files = [...glob.scanSync({ cwd: join(REPO_ROOT, "server"), onlyFiles: true })].filter((f) => !f.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(3); // index.ts, vault.ts, db.ts, … really were found

    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(join(REPO_ROOT, "server", f), "utf8"));
      const imports =
        /\bfrom\s*["']age-encryption["']/.test(src) ||
        /\brequire\(\s*["']age-encryption["']\s*\)/.test(src) ||
        /\bimport\(\s*["']age-encryption["']\s*\)/.test(src);
      const decrypts = /\bnew\s+Decrypter\b/.test(src) || /\.addPassphrase\s*\(/.test(src) || /\.addIdentity\s*\(/.test(src);
      if (imports || decrypts) offenders.push(f);
    }
    /* Bundling typage for /vendor/age.js goes through a tiny entry file (server/age-entry.js)
       fed to Bun.build — the backend's own module graph must stay crypto-free,
       which is what makes "the server never sees a passphrase" structural. */
    expect(offenders).toEqual([]);
  });
});

/** crude but sufficient: block + line comments out, `://` left alone */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** every regular file under `dir` (vault-relative path → latin1 text) */
function vaultFiles(dir: string): Array<[string, string]> {
  const glob = new Bun.Glob("**/*");
  const out: Array<[string, string]> = [];
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    if (rel.startsWith(".git/")) continue;
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    out.push([rel, readFileSync(abs).toString("latin1")]);
  }
  return out;
}

/* ============================================================
   5. /vendor/age.js — typage bundled at startup, no build step (SPEC §6 note)
   ============================================================ */

describe("secrets — the typage bundle is served, cached and immutable", () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await serverOn(tempVault());
  }, 30000);

  test("GET /vendor/age.js is a real JS module carrying the age v1 implementation", async () => {
    const r = await srv.get("/vendor/age.js");
    expect(`GET /vendor/age.js → ${r.status}`).toBe("GET /vendor/age.js → 200");
    expect((r.headers.get("content-type") ?? "").toLowerCase()).toContain("javascript");
    expect(r.text.length).toBeGreaterThan(10_000); // a stub or a 404 page would not be
    /* the format string is load-bearing inside typage; a bundle that lost it is
       not the library */
    expect(r.text.includes("age-encryption.org/v1")).toBe(true);
    /* and the bundle is not a source map / directory listing */
    expect(r.text.trimStart().startsWith("<")).toBe(false);
  });

  test("it carries an ETag and immutable caching, and answers 304 to If-None-Match", async () => {
    const first = await srv.get("/vendor/age.js");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect((first.headers.get("cache-control") ?? "").toLowerCase()).toContain("immutable");

    const again = await fetch(srv.url("/vendor/age.js"), { headers: { "if-none-match": String(etag) } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    /* the ETag is stable across requests — it is keyed to the lockfile, not to
       the moment the response was built */
    const third = await srv.get("/vendor/age.js");
    expect(third.headers.get("etag")).toBe(etag);
  });

  test("nothing in the bundle is vault-specific", async () => {
    const r = await srv.get("/vendor/age.js");
    expect(r.text.includes(identity)).toBe(false);
    expect(r.text.includes(recipient)).toBe(false);
    expect(r.text.includes(PASSPHRASE)).toBe(false);
  });
});

/* ============================================================
   writeVaultKeys — the keyring is a PAIR, and no window may destroy a key.

   Two files, two renames, and the rename pair is not atomic. The function's own
   comment justified writing the identity first because "a recipient without its
   identity is unrecoverable data-loss-by-encryption" — but identity-first plus
   a crash leaves a NEW identity beside the OLD recipient, and the old identity,
   the only key that reads every existing block, was gone. Both orderings could
   produce "the recipient we encrypt to has no matching identity".

   The fix is not a better ordering (there isn't one): the replaced identity is
   moved aside first and deleted only once the new pair is complete, so every
   intermediate state is recoverable.
   ============================================================ */
describe("secrets — writeVaultKeys never destroys the only key it holds", () => {
  test("a first write leaves exactly the pair, with no temp or backup residue", async () => {
    const { writeVaultKeys, readVaultKeys, PREV_IDENTITY } = await import("../server/vault");
    const vault = tempVault();
    await writeVaultKeys(vault, wrappedIdentity, recipient);

    const keys = await readVaultKeys(vault);
    expect(keys.identity).toBe(wrappedIdentity.trim());
    expect(keys.recipient).toBe(recipient);
    expect(vaultHas(vault, ".znotes/" + PREV_IDENTITY)).toBe(false);
    expect([...new Bun.Glob("**/*.tmp").scanSync({ cwd: vault })]).toEqual([]);
  }, 30000);

  test("a replace parks the old identity and only removes it once the new pair is whole", async () => {
    const { writeVaultKeys, readVaultKeys, PREV_IDENTITY } = await import("../server/vault");
    const vault = tempVault();
    await writeVaultKeys(vault, wrappedIdentity, recipient);

    const other = await age.generateIdentity();
    const otherRec = await age.identityToRecipient(other);
    const w = new age.Encrypter();
    w.setPassphrase(PASSPHRASE);
    w.setScryptWorkFactor(10); // shape is what this endpoint validates
    const otherWrapped = age.armor.encode(await w.encrypt(other));

    await writeVaultKeys(vault, otherWrapped, otherRec);

    const keys = await readVaultKeys(vault);
    expect(keys.identity).toBe(otherWrapped.trim());
    expect(keys.recipient).toBe(otherRec);
    /* the pair is CONSISTENT: the recipient on disk is derivable from the
       identity on disk, which is the invariant the whole feature rests on */
    expect(await age.identityToRecipient(await unwrap(otherWrapped, PASSPHRASE))).toBe(keys.recipient);
    /* and the backup is gone once the write completed */
    expect(vaultHas(vault, ".znotes/" + PREV_IDENTITY)).toBe(false);
    expect([...new Bun.Glob("**/*.tmp").scanSync({ cwd: vault })]).toEqual([]);
  }, 30000);

  test("rewriting the SAME identity (the vault.pub repair path) parks nothing", async () => {
    const { writeVaultKeys, readVaultKeys, PREV_IDENTITY } = await import("../server/vault");
    const vault = tempVault();
    await writeVaultKeys(vault, wrappedIdentity, recipient);
    /* the repair path re-declares the identity byte for byte to rebuild a lost
       vault.pub — it must not churn a backup file into the vault */
    await writeVaultKeys(vault, wrappedIdentity, recipient);
    const keys = await readVaultKeys(vault);
    expect(keys.identity).toBe(wrappedIdentity.trim());
    expect(keys.recipient).toBe(recipient);
    expect(vaultHas(vault, ".znotes/" + PREV_IDENTITY)).toBe(false);
  }, 30000);

  test("the parked identity is never committed (git.ts exclude rules)", async () => {
    const { PREV_IDENTITY } = await import("../server/vault");
    const git = await Bun.file(join(REPO_ROOT, "server", "git.ts")).text();
    expect(git).toContain(".znotes/" + PREV_IDENTITY);
    /* …and it is not in the tracked set either */
    const tracked = /TRACKED_META = \[([\s\S]*?)\]/.exec(git)?.[1] ?? "";
    expect(tracked).not.toContain(PREV_IDENTITY);
  });
});

async function unwrap(armor: string, passphrase: string): Promise<string> {
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  return (await d.decrypt(age.armor.decode(armor), "text")).trim();
}
