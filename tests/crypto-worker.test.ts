/* ============================================================
   crypto-worker.test.ts — the plaintext jail's own contract.

   app/crypto-worker.js is where every cryptographic decision in z-notes is
   made, and the UI can only ever show what this worker returns. So it is
   driven here DIRECTLY — a real Chromium, the real `/vendor/age.js` bundle,
   real scrypt at logN=18, real X25519 — with no app.js in the way.

   Four findings are pinned here:

   1. NOTHING bound encryption to a verified recipient. `OPS.encrypt` gated on
      `if (!S.recipient)` and nothing else, and encrypt-while-locked is a
      headline feature, so the one pairing check that existed (inside
      `unlock`) could be bypassed forever. `.znotes/vault.pub` is a tracked,
      pushed file: pointing it at a foreign key made every new secret
      unreadable by its owner and readable by whoever planted the key —
      silently. The worker now latches the recipient it DERIVES from
      identity.age and refuses a substitute.

   2. `unlock` swallowed `identityToRecipient` failures (`catch (e) {}`), so an
      identity that could not be parsed at all skipped the mismatch check
      entirely and reported success.

   3. Every decrypt failure collapsed into "This block was not encrypted to
      this vault key." A MAC failure is an integrity alarm — research §4.2 says
      a three-way merge inside an armor block ALWAYS produces an undecryptable
      Frankenstein and that the app must flag it — and telling the user their
      key is wrong sends them to rotate a key that is fine.

   4. An armor body indented into a list item (research §4.1) went to
      `armor.decode` verbatim, which rejects leading whitespace.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import * as age from "age-encryption";
import { dropVault, findChromium, makeVault, startServer, type TestServer } from "./helpers";

const PASSPHRASE = "correct horse battery staple mango velvet";
const PLAINTEXT = "AWS_SECRET_ACCESS_KEY=WORKERGATECANARY\n";

let srv: TestServer;
let vaultDir = "";
let browser: Browser;
let page: Page;

/* the vault's real pair */
let identity = "";
let recipient = "";
let wrapped = "";
let armor = "";

/* a second, unrelated vault — the "planted key" */
let foreignIdentity = "";
let foreignRecipient = "";
let foreignArmor = "";

/* identity.age whose PAYLOAD is not an age key at all */
let corruptWrapped = "";
let garbageWrapped = "";

/* damaged copies of `armor` */
let tampered = "";
let truncated = "";

const wrap = async (payload: string) => {
  const e = new age.Encrypter();
  e.setPassphrase(PASSPHRASE);
  e.setScryptWorkFactor(18); // exactly what the app writes
  return age.armor.encode(await e.encrypt(payload));
};

const encryptTo = async (to: string, text: string) => {
  const e = new age.Encrypter();
  e.addRecipient(to);
  return age.armor.encode(await e.encrypt(text)).trimEnd();
};

interface OpResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  result: any;
}

/**
 * Boot a fresh worker, run `ops` in order, return one row per op. A fresh
 * worker per scenario is the point: `S.verifiedRecipient` is session state and
 * a leaked one between cases would make these tests lie.
 */
async function runWorker(ops: Array<Record<string, unknown>>): Promise<OpResult[]> {
  return page.evaluate(async (list) => {
    const w = new Worker("/crypto-worker.js", { type: "module" });
    const waits = new Map<number, (m: any) => void>();
    let seq = 0;
    w.onmessage = (ev: MessageEvent) => {
      const m = (ev.data || {}) as any;
      if (m.type === "event") return; // unlocked/locked notifications
      const p = waits.get(m.id);
      if (p) {
        waits.delete(m.id);
        p(m);
      }
    };
    const call = (msg: any) =>
      new Promise<any>((res) => {
        const id = ++seq;
        waits.set(id, res);
        const t = setTimeout(() => res({ id, ok: false, error: { code: "timeout", message: "worker never answered" } }), 45000);
        waits.set(id, (m) => {
          clearTimeout(t);
          res(m);
        });
        w.postMessage({ ...msg, id });
      });
    const out: any[] = [];
    for (const o of list as any[]) {
      const m = await call(o);
      out.push({
        ok: !!m.ok,
        code: m.ok ? null : m.error?.code ?? null,
        message: m.ok ? null : m.error?.message ?? null,
        result: m.ok ? m.result : null,
      });
    }
    w.terminate();
    return out;
  }, ops as any);
}

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);
  foreignIdentity = await age.generateIdentity();
  foreignRecipient = await age.identityToRecipient(foreignIdentity);

  wrapped = await wrap(identity);
  /* a real AGE-SECRET-KEY-1 string with one data character changed: bech32
     checksum fails, which the decoder's own comment says MUST be fatal */
  const flip = identity[identity.length - 8] === "q" ? "p" : "q";
  corruptWrapped = await wrap(identity.slice(0, -8) + flip + identity.slice(-7));
  garbageWrapped = await wrap("this is not an age identity at all");

  /* long enough that the armor has payload lines to damage independently of
     the age header, which is what a real merge conflict looks like */
  armor = await encryptTo(recipient, PLAINTEXT.repeat(40));
  foreignArmor = await encryptTo(foreignRecipient, PLAINTEXT);

  /* one flipped base64 character in the LAST payload line → the STREAM's
     ChaCha20-Poly1305 tag no longer verifies */
  const lines = armor.split("\n");
  const i = lines.length - 2;
  const c = lines[i][4];
  lines[i] = lines[i].slice(0, 4) + (c === "A" ? "B" : "A") + lines[i].slice(5);
  tampered = lines.join("\n");

  /* most of the payload gone — armor-valid but an incomplete ciphertext */
  const t = armor.split("\n");
  t.splice(2, t.length - 3);
  truncated = t.join("\n");

  vaultDir = makeVault({ "inbox.md": "# Inbox\n" });
  srv = await startServer({ vault: vaultDir });

  browser = await puppeteer.launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage();
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (vaultDir) dropVault(vaultDir);
});

/* ============================================================ */

describe("crypto worker — encryption is bound to a VERIFIED recipient", () => {
  test("a verified unlock latches the recipient, and a substitute is refused", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE },
      { op: "setRecipient", recipient: foreignRecipient }, // the planted key
      { op: "encrypt", plaintext: PLAINTEXT },
      { op: "init", recipient: foreignRecipient }, // …and again by the other door
      { op: "status" },
    ]);

    expect(`init: ${r[0].ok}`).toBe("init: true");

    /* the unlock derived the recipient rather than taking vault.pub on trust */
    expect(`unlock: ok=${r[1].ok} code=${r[1].code}`).toBe("unlock: ok=true code=null");
    expect(r[1].result.verified).toBe(true);
    expect(r[1].result.recipient).toBe(recipient);

    /* THE gate: a recipient change after verification is a keyring
       substitution, not a configuration change */
    expect(`setRecipient: ok=${r[2].ok} code=${r[2].code}`).toBe("setRecipient: ok=false code=recipient-changed");

    /* and the swap did not take — this is the byte that would have been lost */
    expect(`encrypt to: ${r[3].result.recipient}`).toBe(`encrypt to: ${recipient}`);
    expect(r[3].result.verified).toBe(true);

    expect(`init again: ok=${r[4].ok} code=${r[4].code}`).toBe("init again: ok=false code=recipient-changed");
    expect(r[5].result.recipient).toBe(recipient);
  }, 120000);

  test("encrypt still works while LOCKED but says the key is UNVERIFIED", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "status" },
      { op: "encrypt", plaintext: PLAINTEXT },
    ]);
    expect(r[1].result.unlocked).toBe(false); // the vault really is locked
    expect(`encrypt while locked: ${r[2].ok}`).toBe("encrypt while locked: true");
    /* the recipient is public, so this must keep working — but nothing has
       checked it against identity.age, and the caller has to be able to say so */
    expect(r[2].result.verified).toBe(false);
    expect(r[2].result.recipient).toBe(recipient);
    expect(String(r[2].result.armor)).toContain("BEGIN AGE ENCRYPTED FILE");
  }, 120000);

  test("a foreign vault.pub beside the real identity.age fails the unlock", async () => {
    const r = await runWorker([
      { op: "init", recipient: foreignRecipient },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE },
      { op: "status" },
    ]);
    expect(`unlock: ok=${r[1].ok} code=${r[1].code}`).toBe("unlock: ok=false code=wrong-identity");
    expect(r[2].result.unlocked).toBe(false);
  }, 120000);

  test("a vault with no vault.pub unlocks and hands back the DERIVED recipient", async () => {
    /* the repair path: identity.age alone is not a dead end */
    const r = await runWorker([
      { op: "init" },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE },
    ]);
    expect(`unlock: ok=${r[1].ok} code=${r[1].code}`).toBe("unlock: ok=true code=null");
    expect(r[1].result.recipient).toBe(recipient);
    expect(r[1].result.verified).toBe(true);
  }, 120000);
});

describe("crypto worker — a corrupted identity fails LOUDLY", () => {
  test("an identity.age whose payload fails its bech32 checksum does not unlock", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: corruptWrapped, passphrase: PASSPHRASE },
      { op: "status" },
      { op: "decrypt", armor },
    ]);
    /* it used to report SUCCESS: the string fallback swallowed the checksum
       failure, identityToRecipient then threw, and the empty catch turned the
       wrong-identity guard into a no-op */
    expect(`unlock: ok=${r[1].ok}`).toBe("unlock: ok=false");
    expect(["bad-identity", "wrong-identity"]).toContain(r[1].code);
    expect(r[2].result.unlocked).toBe(false);
    /* …and every later block then failed with a message blaming the KEY */
    expect(`decrypt after: code=${r[3].code}`).toBe("decrypt after: code=locked");
  }, 120000);

  test("an identity.age wrapping something that is not a key at all does not unlock", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: garbageWrapped, passphrase: PASSPHRASE },
      { op: "status" },
    ]);
    expect(`unlock: ok=${r[1].ok}`).toBe("unlock: ok=false");
    expect(r[2].result.unlocked).toBe(false);
  }, 120000);

  test("a wrong passphrase is still reported as a wrong passphrase", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE + "x" },
    ]);
    expect(`unlock: code=${r[1].code}`).toBe("unlock: code=bad-passphrase");
  }, 120000);
});

describe("crypto worker — decrypt failures are told apart", () => {
  test("integrity failure, wrong key, and malformed armor get DIFFERENT codes", async () => {
    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE },
      { op: "decrypt", armor }, // the healthy control
      { op: "decrypt", armor: tampered },
      { op: "decrypt", armor: truncated },
      { op: "decrypt", armor: foreignArmor },
      { op: "decrypt", armor: "not armor at all" },
    ]);

    expect(`control: ok=${r[2].ok}`).toBe("control: ok=true");
    expect(r[2].result.plaintext).toBe(PLAINTEXT.repeat(40));

    /* one flipped ciphertext byte is a MAC failure — an ALARM, not a key
       mismatch (research §4.2's merge Frankenstein) */
    expect(`tampered: code=${r[3].code}`).toBe("tampered: code=tampered");
    expect(r[3].message).toMatch(/integrity/i);
    expect(r[3].message).toMatch(/modified/i);
    /* Chromium hides the underlying "invalid tag" behind a bare
       TypeError("Failed to fetch") when the payload stream errors inside
       typage's `new Response(stream).text()`. Reaching that point means the
       header parsed and an identity matched, so it is an integrity failure by
       construction — the classification must not depend on the engine's wording. */
    /* and it must NOT accuse the vault key, which is what sent users off to
       re-enter the passphrase or rotate a perfectly good key */
    expect(r[3].message).not.toMatch(/not encrypted to this vault key/i);

    expect(["tampered", "truncated", "bad-armor"]).toContain(r[4].code!);
    expect(r[4].code).not.toBe("no-matching-identity");

    /* a block genuinely encrypted to somebody else's key IS a key mismatch */
    expect(`foreign: code=${r[5].code}`).toBe("foreign: code=no-matching-identity");
    expect(r[5].message).toMatch(/vault key/i);

    expect(`garbage: code=${r[6].code}`).toBe("garbage: code=bad-armor");
  }, 120000);
});

describe("crypto worker — an indented block decrypts (research §4.1)", () => {
  test("armor carrying a list item's indentation is dedented before decoding", async () => {
    const inList = armor
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    const quoted = armor
      .split("\n")
      .map((l) => "> " + l)
      .join("\n");

    const r = await runWorker([
      { op: "init", recipient },
      { op: "unlock", identity: wrapped, passphrase: PASSPHRASE },
      { op: "decrypt", armor: inList },
      { op: "decrypt", armor: quoted },
    ]);

    /* before the fix both of these were "This block is not valid age armor —
       it may have been merged or hand-edited", about data `age -d` reads fine */
    expect(`list-indented: ok=${r[2].ok} code=${r[2].code}`).toBe("list-indented: ok=true code=null");
    expect(r[2].result.plaintext).toBe(PLAINTEXT.repeat(40));
    expect(`blockquoted: ok=${r[3].ok} code=${r[3].code}`).toBe("blockquoted: ok=true code=null");
    expect(r[3].result.plaintext).toBe(PLAINTEXT.repeat(40));
  }, 120000);
});

/* ============================================================
   `rewrap` — change the PASSPHRASE without changing the KEY
   (the routine half of the passphrase-change flow)

   The whole security argument for offering this in Settings at all is that the
   KEY is invariant: same identity, same recipient, no corpus pass, so every
   block already written still decrypts. These tests hold that invariant and
   the refusals that protect it, and they check the OUTPUT with `age-encryption`
   in this process — never by asking the worker whether it succeeded.
   ============================================================ */

describe("crypto-worker · rewrap (research §5.3 'change passphrase')", () => {
  const NEXT = "meadow anchor bison lantern rivulet ocelot quartz";

  test("the same identity comes back under the new passphrase, and the old one stops working", async () => {
    const [init, re] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: wrapped, current: PASSPHRASE, next: NEXT },
    ]);
    expect(`init ok: ${init.ok}`).toBe("init ok: true");
    expect(`rewrap ok: ${re.ok} ${re.code ?? ""}`.trim()).toBe("rewrap ok: true");

    /* the recipient is UNCHANGED — the wire-level tell that nothing rotated */
    expect(`recipient unchanged: ${re.result.recipient === recipient}`).toBe("recipient unchanged: true");
    /* …and the file itself is new: a fresh scrypt salt, so not the same bytes */
    expect(`armor is new bytes: ${re.result.identity.trim() !== wrapped.trim()}`).toBe("armor is new bytes: true");
    expect(`armor is age armor: ${re.result.identity.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")}`).toBe(
      "armor is age armor: true"
    );

    /* verified OUT OF BAND, in this process, with the real library */
    const openWith = async (pass: string) => {
      const d = new age.Decrypter();
      d.addPassphrase(pass);
      return (await d.decrypt(age.armor.decode(re.result.identity), "text")).trim();
    };
    expect(`NEW passphrase yields the SAME key: ${(await openWith(NEXT)) === identity}`).toBe(
      "NEW passphrase yields the SAME key: true"
    );
    let oldWorks = true;
    try {
      await openWith(PASSPHRASE);
    } catch {
      oldWorks = false;
    }
    expect(`OLD passphrase still opens it: ${oldWorks}`).toBe("OLD passphrase still opens it: false");

    /* the point of the invariant: a block encrypted BEFORE the change still
       decrypts with the key the new passphrase yields */
    const d = new age.Decrypter();
    d.addIdentity(await openWith(NEXT));
    const plain = await d.decrypt(age.armor.decode(armor), "text");
    expect(`the pre-existing block still decrypts: ${plain === PLAINTEXT.repeat(40)}`).toBe(
      "the pre-existing block still decrypts: true"
    );
  }, 180000);

  test("a wrong current passphrase is bad-passphrase, and nothing comes back", async () => {
    const [, re] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: wrapped, current: "not the passphrase", next: NEXT },
    ]);
    expect(`→ ${re.ok} ${re.code}`).toBe("→ false bad-passphrase");
    expect(`no armor handed back: ${re.result === null}`).toBe("no armor handed back: true");
  }, 180000);

  test("an identity that does not pair with this vault's recipient is refused", async () => {
    /* the foreign key unwraps fine — the refusal is about WHICH key it is.
       Writing it back would replace a working keyring with a dead one. */
    const foreignWrapped = await wrap(foreignIdentity);
    const [, re] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: foreignWrapped, current: PASSPHRASE, next: NEXT },
    ]);
    expect(`→ ${re.ok} ${re.code}`).toBe("→ false wrong-identity");
  }, 180000);

  test("a wrapped payload that is not an age key at all is refused, not re-wrapped", async () => {
    const [, re] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: garbageWrapped, current: PASSPHRASE, next: NEXT },
    ]);
    expect(`→ ${re.ok} ${re.code}`).toBe("→ false bad-identity");
  }, 180000);

  test("empty and identical passphrases are refused before any scrypt runs", async () => {
    const [, noNext, same, noCurrent] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: wrapped, current: PASSPHRASE, next: "" },
      { op: "rewrap", identity: wrapped, current: PASSPHRASE, next: PASSPHRASE },
      { op: "rewrap", identity: wrapped, current: "", next: NEXT },
    ]);
    expect(`empty new → ${noNext.code}`).toBe("empty new → no-passphrase");
    expect(`unchanged → ${same.code}`).toBe("unchanged → same-passphrase");
    expect(`empty current → ${noCurrent.code}`).toBe("empty current → no-passphrase");
  }, 180000);

  test("rewrap does NOT unlock the session — proving a passphrase is not asking for a decrypt window", async () => {
    const [, re, st, dec] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: wrapped, current: PASSPHRASE, next: NEXT },
      { op: "status" },
      { op: "decrypt", armor },
    ]);
    expect(`rewrap ok: ${re.ok}`).toBe("rewrap ok: true");
    expect(`still locked: ${st.result.unlocked === false}`).toBe("still locked: true");
    expect(`decrypt → ${dec.ok} ${dec.code}`).toBe("decrypt → false locked");
    /* it DOES latch the recipient it derived — the same standard `unlock` uses */
    expect(`recipient verified by derivation: ${st.result.verified}`).toBe("recipient verified by derivation: true");
  }, 180000);

  test("there is still no way to ask the worker for the identity itself", async () => {
    /* rewrap takes armor and returns armor. If it ever leaked the unwrapped
       AGE-SECRET-KEY-1 string, the jail in the file header would be a comment. */
    const [, re] = await runWorker([
      { op: "init", recipient },
      { op: "rewrap", identity: wrapped, current: PASSPHRASE, next: NEXT },
    ]);
    const flat = JSON.stringify(re.result);
    expect(`the reply mentions AGE-SECRET-KEY: ${flat.includes("AGE-SECRET-KEY")}`).toBe(
      "the reply mentions AGE-SECRET-KEY: false"
    );
    expect(`the reply mentions either passphrase: ${flat.includes(PASSPHRASE) || flat.includes(NEXT)}`).toBe(
      "the reply mentions either passphrase: false"
    );
    expect(`the reply's keys: ${Object.keys(re.result).sort().join(",")}`).toBe("the reply's keys: identity,recipient");
  }, 180000);
});
