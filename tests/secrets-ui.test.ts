/* ============================================================
   secrets-ui.test.ts — what the SECRETS UI actually tells the user.

   tests/secrets-e2e.test.ts proves the happy path and the leak gates. This file
   is about the states that used to be reported wrongly, silently, or not at
   all — a real Chromium, the real backend, real age keys throughout.

   One describe per finding:

   · a ```age fence whose body is NOT armor rendered byte-identically to a real
     one ("Secret block · age · x25519 · encrypted / Locked"), so a credential
     hand-wrapped in a fence was committed and pushed under a badge that said it
     was encrypted (research §4.2/§6)
   · a block whose ciphertext failed its MAC was reported as "not encrypted to
     this vault key" and kept rendering as a healthy locked block
   · an armor body indented into a list item could never be decrypted
   · Lock cancelled the 30s clipboard clear WITHOUT clearing the clipboard
   · Tab out of the passphrase modal landed in the hidden ⌘K box and shipped the
     vault passphrase to GET /api/search?q=…
   · Esc during scrypt closed the modal and unlocked the vault anyway
   · deleting a revealed-and-edited block in Raw wedged every later save
   · three fast ⌘S raised "reload before saving" — advice that destroys work
   · #rawArea, where every secret is typed BEFORE ⌘⇧E, was missing three of the
     six anti-exfiltration attributes the reveal editor carries
   · the create-identity modal's footer collapsed its no-recovery warning into a
     56px column and clipped the primary button in Terminal
   · the ? overlay claims to list everything and listed neither new shortcut
   · #encBtn stayed live when secrets were disabled
   · identity.age without vault.pub was a permanent dead end
   · the MIRROR of that — vault.pub without identity.age — was reported as a
     healthy "ready" vault, so the keyring line named a file that was not on
     disk while Unlock said "no identity yet" and Create was refused with 409
   · a substituted .znotes/vault.pub silently captured every new secret
   · a locked block rendered its ciphertext — first inline, then one click away
     behind a disclosure — so a correctly-encrypted block read as an exposed one
   · reveal was per block and opt-in, so an OPEN vault still cost one click per
     block per doc, and unlocking told the rest of the app nothing
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import * as age from "age-encryption";
import {
  bytesEqual,
  dropVault,
  makeVault,
  readVaultBytes,
  readVaultText,
  sleep,
  startServer,
  waitUntil,
  writeVaultFile,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { launchTestBrowser, pressChord } from "./browser";

const PASSPHRASE = "correct horse battery staple mango velvet";
const PLAIN = "AWS_SECRET_ACCESS_KEY=UICANARYALPHA\n";
const PLAIN2 = "HETZNER_TOKEN=UICANARYBRAVO\n";
const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";

/* the credential someone hand-wrapped in an ```age fence without encrypting it */
const FAKE_SECRET = "AWS_ACCESS_KEY_ID=AKIAPLAINTEXTLEAK";

const KEYS = "keys/cloud-keys.md";
const FAKE = "keys/hand-written.md";
const BROKEN = "keys/merged.md";
const LIST = "notes/list-item.md";
const SCRATCH = "notes/scratch.md";
const WEDGE = "notes/wedge.md";
const RACE = "notes/race.md";
const DRIFT = "notes/drift.md";
/* a SECOND doc with TWO real blocks: the vault-wide reveal has to reach a doc
   that was not on screen when the passphrase was given, and every block in it */
const SECOND = "keys/second.md";
/* one healthy block and one merge-damaged one in the same file */
const MIXED = "keys/mixed.md";
/* the SAME armor twice in one document — copy a fence to make a staging/prod
   pair and this is what you have. Ciphertext alone cannot tell the two apart. */
const DUP = "keys/duplicate.md";
/* one block, edited, then saved while the pane is in RAW */
const RAWSAVE = "keys/raw-save.md";
/* one block whose decrypt fails in a way the worker's classifier does not
   recognise (its `undecryptable` fallthrough) */
const ODD = "keys/undecryptable.md";
/* one block, edited, with the vault locked while its PUT is held open */
const LOCKHOLD = "keys/lock-hold.md";
const SELECTION = "SELECTMEALPHA-BRAVO-CHARLIE";

const DUP_PLAIN = "SECRET_ONE=DUPCANARY\n";
const RAW_PLAIN = "SECRET_TWO=RAWCANARY\n";
const LOCK_PLAIN = "SECRET_THREE=LOCKCANARY\n";
const ODD_PLAIN = "SECRET_FOUR=ODDCANARY\n";

/* the crypto worker's classifier, verbatim (app/crypto-worker.js
   `classifyDecryptError`): every branch it recognises. A message that matches
   NONE of these is the `undecryptable` fallthrough. */
const CLASSIFIED =
  /no identity matched|unrecognized identity|invalid tag|tagLength|expected length|too short|truncat|failed to fetch|network error|error while reading|stream|invalid version|non-ascii|unknown letter|invalid stanza|invalid header|malformed|invalid mac/i;

let identity = "";
let recipient = "";
let wrapped = "";
let armor = "";
let armor2 = ""; // a DIFFERENT ciphertext, so a doc can hold two distinct blocks
let dupArmor = ""; // seeded TWICE into one document
let rawArmor = "";
let lockArmor = "";
let oddArmor = ""; // decrypts to an error the classifier does not know
let oddMessage = ""; // …and what that error actually says, measured bun-side
let foreignRecipient = "";

let srv: TestServer; // the normal vault
let repairSrv: TestServer; // identity.age, no vault.pub
let orphanSrv: TestServer; // vault.pub, no identity.age — the mirror
let emptySrv: TestServer; // no keyring at all
let vaultDir = "";
let repairDir = "";
let orphanDir = "";
let emptyDir = "";
let browser: Browser;

const encryptTo = async (to: string, text: string) => {
  const e = new age.Encrypter();
  e.addRecipient(to);
  return age.armor.encode(await e.encrypt(text)).trimEnd();
};

const fence = (body: string, indent = "") =>
  indent + "```age\n" + body.split("\n").map((l) => indent + l).join("\n") + "\n" + indent + "```\n";

const decryptArmor = async (a: string) => {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(age.armor.decode(a.endsWith("\n") ? a : a + "\n"), "text");
};

/** what a decrypt of this armor SAYS, measured rather than assumed */
const decryptMessage = async (a: string) => {
  try {
    await decryptArmor(a);
    return "decrypted";
  } catch (e) {
    return String((e as Error)?.message || e);
  }
};

/* byte-exact Uint8Array ⇄ string, so an armor can be taken apart and put back
   together without a UTF-8 round trip mangling the binary payload */
const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
const unlatin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/**
 * Armor whose X25519 stanza no longer parses — one extra base64 character in
 * the recipient stanza's share. typage answers "invalid X25519 stanza", which
 * matches none of the crypto worker's classifier branches and therefore lands
 * on its `undecryptable` fallthrough. The armor still has valid PEM SHAPE, so
 * the UI reaches the decrypt rather than flagging it as "not armor".
 */
const undecryptableArmor = async (to: string, text: string) => {
  const lines = latin1(age.armor.decode((await encryptTo(to, text)) + "\n")).split("\n");
  const i = lines.findIndex((l) => l.startsWith("-> X25519 "));
  lines[i] += "A";
  return age.armor.encode(unlatin1(lines.join("\n"))).trimEnd();
};

/** every ```age fence body in a markdown string, in document order */
function ageFences(md: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (cur === null) {
      if (line.trim() === "```age") cur = [];
    } else if (line.trim() === "```") {
      out.push(cur.join("\n"));
      cur = null;
    } else cur.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------
   page helpers
   ------------------------------------------------------------------ */

interface Blk {
  open: boolean;
  badge: string;
  badgeClass: string;
  subtitle: string;
  buttons: string[];
  note: string;
  flagged: boolean;
  revealed: string | null;
}

async function newPage(
  server: TestServer,
  opts: { query?: string; noSubtle?: boolean; clipShim?: boolean; countOps?: boolean } = {}
) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  if (opts.countOps) {
    /* every op the page asks the crypto worker for. A retry LOOP is not a
       state you can photograph — it is a rate, so it has to be counted. */
    await p.evaluateOnNewDocument(() => {
      const w = window as any;
      w.__ops = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg: any, ...rest: any[]) {
        try {
          if (msg && msg.op) w.__ops.push(msg.op);
        } catch {
          /* ignore */
        }
        return (post as any).call(this, msg, ...rest);
      };
    });
  }
  await p.evaluateOnNewDocument(() => {
    (window as any).__toasts = [];
    (window as any).__sent = [];
    const observe = () => {
      const n = document.getElementById("toastTxt");
      if (!n) return;
      new MutationObserver(() => (window as any).__toasts.push(n.textContent ?? "")).observe(n, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
    else observe();
  });
  if (opts.noSubtle) {
    await p.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(window.crypto, "subtle", { configurable: true, get: () => undefined });
      } catch {
        /* ignore */
      }
    });
  }
  if (opts.clipShim) {
    /* deterministic clipboard: headless Chromium refuses real writes, and what
       matters here is what the APP asks the clipboard to hold */
    await p.evaluateOnNewDocument(() => {
      const w = window as any;
      w.__clip = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (t: string) => {
            w.__clip.push(t);
          },
          readText: async () => w.__clip[w.__clip.length - 1] ?? "",
        },
      });
    });
  }
  await p.goto(server.base + "/" + (opts.query ?? ""), { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#app:not([hidden])", { timeout: 25000 });
  return p;
}

async function openDoc(p: Page, path: string) {
  await p.click(`#tree .row.file[data-doc="${path}"]`);
  await p.waitForFunction((x) => document.getElementById("stPath")!.textContent === x, { timeout: 8000 }, path);
  await sleep(250);
}

const blocks = (p: Page): Promise<Blk[]> =>
  p.evaluate(() =>
    [...document.querySelectorAll(".secret")].map((w) => {
      const ta = w.querySelector("textarea");
      const badge = w.querySelector(".badge");
      return {
        open: w.classList.contains("open"),
        badge: (badge?.textContent ?? "").trim(),
        badgeClass: badge?.className ?? "",
        subtitle: (w.querySelector(".secret-s")?.textContent ?? "").trim(),
        buttons: [...w.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()),
        note: (w.querySelector(".secret-note")?.textContent ?? "").trim(),
        flagged: w.classList.contains("flagged"),
        revealed: ta ? (ta as HTMLTextAreaElement).value : null,
      };
    })
  );

const toasts = (p: Page): Promise<string[]> => p.evaluate(() => (window as any).__toasts.slice());
const clearToasts = (p: Page) => p.evaluate(() => ((window as any).__toasts.length = 0));

async function clickBlockButton(p: Page, nth: number, re: RegExp) {
  const clicked = await p.evaluate(
    (i, src) => {
      const rx = new RegExp(src, "i");
      const w = document.querySelectorAll(".secret")[i];
      if (!w) return null;
      const b = [...w.querySelectorAll("button")].find((n) => rx.test((n.textContent ?? "").trim()));
      if (!b) return null;
      (b as HTMLButtonElement).click();
      return (b.textContent ?? "").trim();
    },
    nth,
    re.source
  );
  if (clicked == null) throw new Error(`no button matching ${re} in block ${nth}: ${JSON.stringify(await blocks(p))}`);
  return clicked;
}

/* the shared, page-taking chord — see tests/browser.ts. This file drives
   several pages at once, which is why it takes one. */
const chord = pressChord;

async function typePassphrase(p: Page, pass = PASSPHRASE) {
  await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
  await p.evaluate(() => {
    const i = document.getElementById("ppInput") as HTMLInputElement;
    i.value = "";
    i.focus();
  });
  await p.keyboard.type(pass);
  await p.click('#ppVeil [data-act="pp-ok"]');
}

/** click Unlock on block `nth`, answer the modal if it appears, wait for open */
async function unlockBlock(p: Page, nth = 0) {
  await clickBlockButton(p, nth, /unlock/i);
  await p.waitForFunction(
    () => document.getElementById("ppVeil")!.classList.contains("show") || !!document.querySelector(".secret.open"),
    { timeout: 30000 }
  );
  if (await p.evaluate(() => document.getElementById("ppVeil")!.classList.contains("show"))) await typePassphrase(p);
  await p.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });
}

const ensureRaw = async (p: Page) => {
  if (await p.evaluate(() => document.getElementById("doc")!.classList.contains("raw-mode"))) return;
  await chord(p, "KeyE");
  await p.waitForSelector("#rawArea", { timeout: 8000 });
};

const ensurePreview = async (p: Page) => {
  if (!(await p.evaluate(() => document.getElementById("doc")!.classList.contains("raw-mode")))) return;
  await chord(p, "KeyE");
  await p.waitForSelector(".secret", { timeout: 8000 });
};

/** type at the end of revealed block `nth` — a real keyboard, so the editor's
    own `input` handler is what marks the entry dirty */
async function typeInto(p: Page, nth: number, text: string) {
  await p.evaluate((i) => {
    const ta = [...document.querySelectorAll(".secret.open textarea")][i] as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, nth);
  await p.keyboard.type(text);
}

/* ------------------------------------------------------------------
   boot
   ------------------------------------------------------------------ */

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);
  foreignRecipient = await age.identityToRecipient(await age.generateIdentity());

  const w = new age.Encrypter();
  w.setPassphrase(PASSPHRASE);
  w.setScryptWorkFactor(18);
  wrapped = age.armor.encode(await w.encrypt(identity));

  armor = await encryptTo(recipient, PLAIN.repeat(30));
  armor2 = await encryptTo(recipient, PLAIN2);
  dupArmor = await encryptTo(recipient, DUP_PLAIN);
  rawArmor = await encryptTo(recipient, RAW_PLAIN);
  lockArmor = await encryptTo(recipient, LOCK_PLAIN);
  oddArmor = await undecryptableArmor(recipient, ODD_PLAIN);
  oddMessage = await decryptMessage(oddArmor);

  /* a merge Frankenstein: one flipped base64 character in the last payload line */
  const L = armor.split("\n");
  const i = L.length - 2;
  L[i] = L[i].slice(0, 4) + (L[i][4] === "A" ? "B" : "A") + L[i].slice(5);
  const brokenArmor = L.join("\n");

  const seed: SeedMap = {
    "inbox.md": "# Inbox\n\nnothing yet\n",
    [KEYS]: "# Cloud keys\n\nprose above\n\n" + fence(armor) + "\nprose below\n",
    [FAKE]: "# Hand written\n\nHANDWRITTENMARKER\n\n" + fence(FAKE_SECRET) + "\ntail\n",
    [BROKEN]: "# Merged\n\nMERGEDMARKER\n\n" + fence(brokenArmor) + "\ntail\n",
    [LIST]: "# List\n\n- an item with a secret:\n\n" + fence(armor, "  ") + "\ntail\n",
    [SCRATCH]: `# Scratch\n\nheader line\n\n${SELECTION}\n\ntail line\n`,
    [WEDGE]: "# Wedge\n\nWEDGEMARKER\n\n" + fence(armor) + "\ntail\n",
    [RACE]: "# Race\n\nRACEMARKER\n\n" + fence(armor) + "\ntail\n",
    [DRIFT]: "# Drift\n\nDRIFTMARKER\n\nDRIFTSELECTME\n\ntail line\n",
    [SECOND]: "# Second\n\nSECONDMARKER\n\n" + fence(armor) + "\nbetween\n\n" + fence(armor2) + "\ntail\n",
    [MIXED]: "# Mixed\n\nMIXEDMARKER\n\n" + fence(brokenArmor) + "\nbetween\n\n" + fence(armor2) + "\ntail\n",
    [DUP]: "# Duplicate\n\nDUPMARKER\n\n" + fence(dupArmor) + "\nbetween\n\n" + fence(dupArmor) + "\ntail\n",
    [RAWSAVE]: "# Raw save\n\nRAWSAVEMARKER\n\n" + fence(rawArmor) + "\ntail\n",
    [ODD]: "# Undecryptable\n\nODDMARKER\n\n" + fence(oddArmor) + "\ntail\n",
    [LOCKHOLD]: "# Lock hold\n\nLOCKHOLDMARKER\n\n" + fence(lockArmor) + "\ntail\n",
    ".znotes/identity.age": wrapped,
    ".znotes/vault.pub": recipient + "\n",
  };
  vaultDir = makeVault(seed);
  srv = await startServer({ vault: vaultDir });

  /* the documented writeVaultKeys window / a tidied .znotes: identity, no pub */
  repairDir = makeVault({
    "inbox.md": "# Inbox\n",
    [KEYS]: "# Cloud keys\n\nprose\n\n" + fence(armor),
    ".znotes/identity.age": wrapped,
  });
  repairSrv = await startServer({ vault: repairDir });

  /* the mirror window: writeVaultKeys parked the old identity and died before
     the new one landed, so vault.pub is readable and identity.age is gone */
  orphanDir = makeVault({
    "inbox.md": "# Inbox\n",
    [KEYS]: "# Cloud keys\n\nprose\n\n" + fence(armor),
    ".znotes/vault.pub": recipient + "\n",
  });
  orphanSrv = await startServer({ vault: orphanDir });

  /* first run: a block exists, no keyring at all */
  emptyDir = makeVault({ "inbox.md": "# Inbox\n", [KEYS]: "# Cloud keys\n\nprose\n\n" + fence(armor) });
  emptySrv = await startServer({ vault: emptyDir });

  browser = await launchTestBrowser();
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  await Promise.all(
    [srv?.stop(), repairSrv?.stop(), orphanSrv?.stop(), emptySrv?.stop()].filter(Boolean) as Promise<unknown>[]
  );
  for (const d of [vaultDir, repairDir, orphanDir, emptyDir]) if (d) dropVault(d);
});

/* ============================================================ */

describe("an ```age fence is not evidence of encryption (research §4.2)", () => {
  test("a fence whose body is plaintext is flagged, not certified as encrypted", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, FAKE);
      const [b] = await blocks(p);
      expect(b).toBeDefined();

      /* the whole finding in four assertions: this used to be byte-identical
         to a real block — badge "Locked", subtitle "encrypted", an Unlock
         button — over a live AWS key that gitSync then committed */
      expect(`badge=${b.badge}`).not.toBe("badge=Locked");
      expect(b.badge.toLowerCase()).toContain("not encrypted");
      expect(b.badgeClass).toContain("warn");
      expect(b.subtitle.toLowerCase()).not.toContain("· encrypted");
      expect(b.flagged).toBe(true);

      /* no unlock affordance: there is nothing to unlock */
      expect(b.buttons.filter((x) => /unlock/i.test(x))).toEqual([]);
      /* and it says what to do about it */
      expect(b.note.toLowerCase()).toMatch(/not.*encrypted|nothing here is encrypted/);

      /* the doc around it still renders */
      expect(await p.evaluate(() => document.getElementById("doc")!.textContent)).toContain("HANDWRITTENMARKER");
    } finally {
      await p.close();
    }
  }, 60000);

  test("a REAL block in the same vault is still shown as encrypted and locked", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      const [b] = await blocks(p);
      expect(b.badge).toBe("Locked");
      expect(b.badgeClass).toContain("lock");
      expect(b.flagged).toBe(false);
      expect(b.buttons.some((x) => /unlock/i.test(x))).toBe(true);
    } finally {
      await p.close();
    }
  }, 60000);
});

describe("a MAC failure is an integrity alarm, not a key mismatch", () => {
  test("a merge-damaged block flags itself and STAYS flagged", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, BROKEN);
      expect((await blocks(p))[0].badge).toBe("Locked"); // indistinguishable until tried
      await clearToasts(p);
      await unlockVaultThenFail(p);

      const said = (await toasts(p)).join(" | ");
      /* the old message sent users off to re-enter the passphrase or rotate a
         key that was never the problem */
      expect(said).not.toMatch(/not encrypted to this vault key/i);
      expect(said).toMatch(/integrity/i);

      const [b] = await blocks(p);
      /* …and the verdict STICKS: the block used to keep rendering as a healthy
         "Locked / encrypted" secret, and to keep being committed that way */
      expect(b.badge.toLowerCase()).toContain("integrity");
      expect(b.badgeClass).toContain("warn");
      expect(b.flagged).toBe(true);
      expect(b.subtitle.toLowerCase()).not.toBe("age · x25519 · encrypted");
      expect(b.note.toLowerCase()).toMatch(/merge|modified|hand-edited/);

      /* still there after the toast has faded */
      await sleep(2500);
      expect((await blocks(p))[0].badge.toLowerCase()).toContain("integrity");
    } finally {
      await p.close();
    }
  }, 90000);

  /** click Unlock on the damaged block and answer the passphrase modal */
  async function unlockVaultThenFail(p: Page) {
    await clickBlockButton(p, 0, /unlock/i);
    await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
    await typePassphrase(p);
    await waitUntil(async () => (await toasts(p)).some((t) => /integrity|not encrypted to|could not be decrypted/i.test(t)), {
      timeout: 30000,
      label: "the decrypt verdict",
    });
  }
});

describe("an indented block decrypts (research §4.1)", () => {
  test("a fence carrying a list item's indentation reveals its plaintext", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, LIST);
      await clearToasts(p);
      await unlockBlock(p, 0);
      const [b] = await blocks(p);
      /* it used to say "This block is not valid age armor — it may have been
         merged or hand-edited" about data `age -d` reads perfectly */
      expect((await toasts(p)).join(" | ")).not.toMatch(/not valid age armor/i);
      expect(b.open).toBe(true);
      expect(b.revealed).toBe(PLAIN.repeat(30));
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("locking clears the clipboard (research §6)", () => {
  test("Copy then Lock clears it immediately instead of cancelling the clear", async () => {
    const p = await newPage(srv, { clipShim: true });
    try {
      await openDoc(p, KEYS);
      await unlockBlock(p, 0);
      await clickBlockButton(p, 0, /copy/i);
      await waitUntil(async () => (await p.evaluate(() => (window as any).__clip.slice())).includes(PLAIN.repeat(30)), {
        timeout: 10000,
        label: "the plaintext to reach the clipboard",
      });

      /* the natural flow: copy it, paste it somewhere, re-lock. This used to
         cancel the 30s clear WITHOUT performing it — the plaintext then sat on
         the system clipboard forever. */
      await clickBlockButton(p, 0, /^\s*lock\b/i);
      await waitUntil(async () => (await p.evaluate(() => (window as any).__clip.at(-1))) === "", {
        timeout: 10000,
        label: "the clipboard to be cleared by the lock",
      });
      expect(await p.evaluate(() => (window as any).__clip.at(-1))).toBe("");
    } finally {
      await p.close();
    }
  }, 90000);

  test("⌘⇧L (lock the whole vault) clears it too", async () => {
    const p = await newPage(srv, { clipShim: true });
    try {
      await openDoc(p, KEYS);
      await unlockBlock(p, 0);
      await clickBlockButton(p, 0, /copy/i);
      await waitUntil(async () => (await p.evaluate(() => (window as any).__clip.slice())).includes(PLAIN.repeat(30)), {
        timeout: 10000,
        label: "the plaintext to reach the clipboard",
      });
      await chord(p, "KeyL", "Meta", "Shift");
      await waitUntil(async () => (await p.evaluate(() => (window as any).__clip.at(-1))) === "", {
        timeout: 10000,
        label: "the clipboard to be cleared by the vault lock",
      });
      expect(await p.evaluate(() => (window as any).__clip.at(-1))).toBe("");
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("the passphrase cannot escape its modal", () => {
  test("Tab never leaves #ppVeil, and the passphrase never reaches a request", async () => {
    const p = await newPage(srv);
    const sent: string[] = [];
    p.on("request", (r) => sent.push(r.method() + " " + r.url() + " " + (r.postData() ?? "")));
    try {
      await openDoc(p, KEYS);
      await clickBlockButton(p, 0, /unlock/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });

      /* Tab used to walk ppInput → Cancel → ppOk → #palInput, the hidden ⌘K
         search box, which fires GET /api/search?q=… on every keystroke */
      const where: string[] = [];
      for (let i = 0; i < 8; i++) {
        await p.keyboard.press("Tab");
        where.push(
          await p.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            return (a?.closest("#ppVeil") ? "in-modal:" : "ESCAPED:") + (a?.id || a?.tagName || "none");
          })
        );
      }
      expect(where.filter((x) => x.startsWith("ESCAPED"))).toEqual([]);

      /* and Shift+Tab, which walked backwards into the settings inputs */
      for (let i = 0; i < 6; i++) {
        await p.keyboard.down("Shift");
        await p.keyboard.press("Tab");
        await p.keyboard.up("Shift");
        expect(await p.evaluate(() => !!document.activeElement?.closest("#ppVeil"))).toBe(true);
      }

      /* now type the passphrase blind, exactly as a user would after the
         masked field silently stopped accepting characters */
      sent.length = 0;
      await p.keyboard.type(PASSPHRASE);
      await sleep(600);

      expect(await p.evaluate(() => (document.getElementById("palInput") as HTMLInputElement).value)).toBe("");
      for (const r of sent) {
        expect(`${r.split(" ")[1]} leaked the passphrase: ${r.includes(PASSPHRASE)}`).toBe(
          `${r.split(" ")[1]} leaked the passphrase: false`
        );
        /* URL-encoded too — a GET query is where it went */
        expect(r.includes(encodeURIComponent(PASSPHRASE))).toBe(false);
        expect(r.includes(PASSPHRASE.replace(/ /g, "+"))).toBe(false);
      }
    } finally {
      await p.close();
    }
  }, 90000);

  test("hidden overlays are out of the tab order entirely", async () => {
    const p = await newPage(srv);
    try {
      const state = await p.evaluate(() =>
        ["#palVeil", "#scVeil", "#ppVeil", "#cxVeil", "#cfVeil"].map((s) => {
          const n = document.querySelector(s)!;
          const cs = getComputedStyle(n);
          return { sel: s, shown: n.classList.contains("show"), visibility: cs.visibility };
        })
      );
      for (const s of state) {
        expect(`${s.sel} shown=${s.shown} visibility=${s.visibility}`).toBe(`${s.sel} shown=false visibility=hidden`);
      }
    } finally {
      await p.close();
    }
  }, 60000);
});

describe("Esc during key derivation cancels the unlock", () => {
  test("the vault does not unlock behind a dismissed modal", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      await clickBlockButton(p, 0, /unlock/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
      await p.evaluate(() => (document.getElementById("ppInput") as HTMLInputElement).focus());
      await p.keyboard.type(PASSPHRASE);
      await p.keyboard.press("Enter");
      await sleep(120); // scrypt logN=18 is ~1s; Esc lands well inside it
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 8000 });

      /* the derive completes regardless — the question is what happens then */
      await sleep(6000);
      expect(await p.evaluate(() => document.getElementById("stVault")!.hidden)).toBe(true);
      expect((await blocks(p))[0].open).toBe(false);

      /* and the vault really is locked: the next reveal asks again */
      await clickBlockButton(p, 0, /unlock/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("saving survives a revealed block disappearing from the document", () => {
  test("deleting an edited reveal in Raw does not wedge every later save", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, WEDGE);
      await unlockBlock(p, 0);

      /* make the reveal dirty */
      await p.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(".secret.open textarea")!;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      await p.keyboard.type("EDITEDINPLACE=1\n");

      /* …then remove the whole fence in Raw, which is an ordinary thing to do */
      await ensureRaw(p);
      await p.evaluate(() => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        ta.value = "# Wedge\n\nWEDGEMARKER\n\nAFTERTHEDELETE\n";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await clearToasts(p);
      await chord(p, "KeyS");

      /* the save used to abort before writing anything, for the rest of the
         session, and the toast told the user to reload — which discards it all */
      const onDisk = await waitUntil(
        () => {
          const t = readVaultText(vaultDir, WEDGE);
          return t.includes("AFTERTHEDELETE") ? t : null;
        },
        { timeout: 15000, label: "the save to reach disk after the fence was deleted" }
      );
      expect(onDisk).not.toContain("```age");
      expect(onDisk).not.toContain("EDITEDINPLACE"); // plaintext never lands on disk

      /* and a further ordinary edit still saves */
      await p.evaluate(() => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        ta.value += "\nSECONDEDIT\n";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await chord(p, "KeyS");
      await waitUntil(() => readVaultText(vaultDir, WEDGE).includes("SECONDEDIT"), {
        timeout: 15000,
        label: "the second save",
      });
      /* The bytes reach disk inside the PUT handler, so the file can be read
         back BEFORE the response — and therefore before the client clears its
         dirty flag. The wedge this test is about was permanent (every later
         save aborted and the indicator never left "Unsaved changes"), so wait
         for the client to acknowledge rather than sampling mid-round-trip. */
      await p.waitForFunction(() => document.getElementById("saveTxt")!.textContent !== "Unsaved changes", {
        timeout: 10000,
      });
      expect(await p.evaluate(() => document.getElementById("saveInd")!.classList.contains("dirty"))).toBe(false);
    } finally {
      await p.close();
    }
  }, 120000);

  test("three ⌘S in the same tick do not raise a false 'reload before saving'", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, RACE);
      await unlockBlock(p, 0);
      await p.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(".secret.open textarea")!;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      await p.keyboard.type("RACEEDIT=1\n");
      await clearToasts(p);

      /* zero gap: three saves enter flushSecretEdits while the first re-encrypt
         is still in the worker */
      await p.evaluate(() => {
        for (let i = 0; i < 3; i++)
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
      });
      await sleep(2500);

      const said = (await toasts(p)).join(" | ");
      expect(said).not.toMatch(/no longer (matches|in this document)/i);
      expect(said).not.toMatch(/reload before saving/i);

      /* and the document on disk is correct and still a secret */
      const md = readVaultText(vaultDir, RACE);
      expect(md).toContain(ARMOR_HEAD);
      expect(md).not.toContain("RACEEDIT");
      const fences = md.split("```age").length - 1;
      expect(`fences on disk: ${fences}`).toBe("fences on disk: 1");
    } finally {
      await p.close();
    }
  }, 120000);
});

describe("the Raw editor is where secrets are typed before ⌘⇧E", () => {
  test("#rawArea carries the same six anti-exfiltration attributes as the reveal editor", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, SCRATCH);
      await ensureRaw(p);
      const attrs = await p.$eval("#rawArea", (n) => ({
        spellcheck: n.getAttribute("spellcheck"),
        autocomplete: n.getAttribute("autocomplete"),
        autocapitalize: n.getAttribute("autocapitalize"),
        autocorrect: n.getAttribute("autocorrect"),
        gramm: n.getAttribute("data-gramm"),
        grammarly: n.getAttribute("data-enable-grammarly"),
      }));
      expect(attrs).toEqual({
        spellcheck: "false",
        autocomplete: "off",
        autocapitalize: "off",
        autocorrect: "off",
        gramm: "false",
        grammarly: "false",
      });
    } finally {
      await p.close();
    }
  }, 60000);
});

describe("encryption is bound to a recipient the vault can actually read", () => {
  test("the encrypt toast names the WHOLE recipient, not a 16-character prefix", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, SCRATCH);
      await ensureRaw(p);
      await p.evaluate((needle) => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        const at = ta.value.indexOf(needle);
        ta.focus();
        ta.setSelectionRange(at, at + needle.length);
      }, SELECTION);
      await clearToasts(p);
      await chord(p, "KeyE", "Meta", "Shift");
      await p.waitForFunction(
        () => ((document.getElementById("rawArea") as HTMLTextAreaElement)?.value ?? "").includes("```age"),
        { timeout: 15000 }
      );
      const said = (await toasts(p)).join(" | ");
      /* a substituted key differs somewhere — a truncated prefix is exactly
         where a swap hides */
      expect(said).toContain(recipient);
    } finally {
      await p.close();
    }
  }, 90000);

  test("a substituted .znotes/vault.pub blocks the encrypt instead of capturing it", async () => {
    /* the finding's exact scenario: both keyring files are tracked and pushed,
       so an ordinary pull (or anyone with write access to the remote) can move
       vault.pub under a running app */
    const p = await newPage(srv);
    try {
      await openDoc(p, DRIFT);
      await ensureRaw(p);
      writeVaultFile(vaultDir, ".znotes/vault.pub", foreignRecipient + "\n");
      await sleep(300);

      await p.evaluate(() => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        const at = ta.value.indexOf("DRIFTSELECTME");
        ta.focus();
        ta.setSelectionRange(at, at + "DRIFTSELECTME".length);
      });
      await clearToasts(p);
      await chord(p, "KeyE", "Meta", "Shift");
      await sleep(1500);

      const said = (await toasts(p)).join(" | ");
      expect(said).toMatch(/keyring changed|recipient changed|no longer matches/i);
      /* it names the key that appeared, in full — the user cannot notice a
         substitution they are never shown */
      expect(said).toContain(foreignRecipient);
      /* and NOTHING was encrypted to it */
      expect(said).not.toMatch(/^Encrypted to|\| Encrypted to/);
      const buf = await p.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
      expect(buf).toContain("DRIFTSELECTME");
      expect(buf).not.toContain("BEGIN AGE ENCRYPTED FILE");
    } finally {
      writeVaultFile(vaultDir, ".znotes/vault.pub", recipient + "\n");
      await p.close();
    }
  }, 90000);
});

describe("identity.age without vault.pub is repairable, not a dead end", () => {
  test("the block offers Unlock, and unlocking rebuilds .znotes/vault.pub", async () => {
    expect(existsSync(join(repairDir, ".znotes", "vault.pub"))).toBe(false);
    const p = await newPage(repairSrv);
    try {
      await openDoc(p, KEYS);
      const [before] = await blocks(p);
      /* every affordance used to read "Create vault identity", and creating
         409'd on the identity that was already there — forever */
      expect(before.buttons.join(" ")).not.toMatch(/create vault identity/i);
      expect(before.buttons.some((x) => /unlock/i.test(x))).toBe(true);

      await unlockBlock(p, 0);
      expect((await blocks(p))[0].revealed).toBe(PLAIN.repeat(30));

      /* and the missing half of the keyring is back, derived from the identity */
      await waitUntil(() => existsSync(join(repairDir, ".znotes", "vault.pub")), {
        timeout: 10000,
        label: ".znotes/vault.pub to be rebuilt",
      });
      expect(readVaultText(repairDir, ".znotes/vault.pub").trim()).toBe(recipient);

      const r = await repairSrv.get("/api/vault/recipient");
      expect(r.status).toBe(200);
      expect(r.body.recipient).toBe(recipient);
    } finally {
      await p.close();
    }
  }, 120000);
});

describe("vault.pub without identity.age says so, instead of claiming to be ready", () => {
  /** the keyring line in Settings › Secrets, which is the panel whose only job
      is to report the keyring — read after the probe has landed */
  async function keyLine(p: Page) {
    await chord(p, "Comma");
    await p.waitForFunction(() => document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 8000,
    });
    /* it starts at the em-dash placeholder; the probe is off the critical path */
    await waitUntil(async () => (await p.$eval("#keyStateTxt", (n) => n.textContent ?? "")).trim().length > 4, {
      timeout: 15000,
      label: "the keyring line to be painted from the probe",
    });
    return p.evaluate(() => ({
      text: (document.getElementById("keyStateTxt")!.textContent ?? "").trim(),
      cls: document.getElementById("keyState")!.className,
      changeDisabled: (document.getElementById("keyChangeBtn") as HTMLButtonElement).disabled,
    }));
  }

  test("the identity really is gone, and the server says both halves disagree", async () => {
    expect(existsSync(join(orphanDir, ".znotes", "identity.age"))).toBe(false);
    expect(existsSync(join(orphanDir, ".znotes", "vault.pub"))).toBe(true);
    expect((await orphanSrv.get("/api/vault/identity")).status).toBe(404);
    expect((await orphanSrv.get("/api/vault/recipient")).status).toBe(200);
  }, 30000);

  test("the keyring line names the MISSING file and the stash that recovers it", async () => {
    const p = await newPage(orphanSrv);
    try {
      const line = await keyLine(p);
      /* it used to read "Locked · .znotes/identity.age + .znotes/vault.pub ·
         age1…" — the name of a file nothing had looked for */
      expect(`says Locked: ${/^Locked\b/.test(line.text)}`).toBe("says Locked: false");
      expect(line.text).toContain("identity.age is MISSING");
      expect(line.text).toContain(".znotes/identity.age.prev");
      expect(line.cls).toContain("off");
      expect(line.cls).not.toContain("locked");
      /* nothing to re-wrap, so the change control is not offered */
      expect(line.changeDisabled).toBe(true);
    } finally {
      await p.close();
    }
  }, 90000);

  test("the block offers neither Unlock nor Create — both were refusals — and says why", async () => {
    const p = await newPage(orphanSrv);
    try {
      await openDoc(p, KEYS);
      const [b] = await blocks(p);
      expect(b).toBeDefined();
      /* Unlock answered "This vault has no identity yet." and the Create it
         suggested was refused by the server with 409 exists: two contradictory
         messages and no route out */
      expect(b.buttons.filter((x) => /unlock|create vault identity/i.test(x))).toEqual([]);
      expect(b.subtitle).toContain("identity.age is missing");
      expect(b.note).toContain(".znotes/identity.age.prev");
    } finally {
      await p.close();
    }
  }, 90000);

  test("⌘⇧E refuses instead of writing a block nobody can ever open", async () => {
    const p = await newPage(orphanSrv);
    try {
      await openDoc(p, KEYS);
      await ensureRaw(p);
      const armorCount = (s: string) => s.split(ARMOR_HEAD).length - 1;
      const before = await p.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
      /* the recipient alone is enough to ENCRYPT — which is the trap: the block
         would be one nobody can ever open ("unrecoverable data-loss-by-
         encryption", vault.ts) */
      await p.evaluate(() => {
        const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
        ta.focus();
        ta.setSelectionRange(2, 7); // inside "# Cloud keys"
      });
      await clearToasts(p);
      await chord(p, "KeyE", "Meta", "Shift");
      await waitUntil(async () => (await toasts(p)).some((t) => /identity\.age is missing/i.test(t)), {
        timeout: 10000,
        label: "the encrypt gesture to refuse",
      });
      await sleep(400);
      const after = await p.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
      expect(`armor blocks after ⌘⇧E: ${armorCount(after)}`).toBe(`armor blocks after ⌘⇧E: ${armorCount(before)}`);
      expect(after).toBe(before);
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("degradation without crypto.subtle", () => {
  test("the toolbar's encrypt button is not live either", async () => {
    const p = await newPage(srv, { noSubtle: true });
    try {
      await openDoc(p, SCRATCH);
      await ensureRaw(p);
      /* the probe finishes off the critical path, so give it a beat */
      await waitUntil(async () => (await p.$eval("#encBtn", (n) => (n as HTMLElement).hidden)) === true, {
        timeout: 10000,
        label: "#encBtn to go away once secrets are disabled",
      });
      const enc = await p.$eval("#encBtn", (n) => ({
        hidden: (n as HTMLElement).hidden,
        visible: !!(n as HTMLElement).offsetParent,
      }));
      /* a live button whose only outcome is an error toast is the dead
         affordance the block rendering was built to avoid */
      expect(enc).toEqual({ hidden: true, visible: false });
    } finally {
      await p.close();
    }
  }, 60000);
});

describe("the ? overlay lists every global shortcut", () => {
  test("⇧⌘E and ⇧⌘L are in it", async () => {
    const p = await newPage(srv);
    try {
      await p.keyboard.press("?");
      await p.waitForFunction(() => document.getElementById("scVeil")!.classList.contains("show"), { timeout: 8000 });
      const rows = await p.$$eval("#scVeil .sc-row", (ns) => ns.map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()));
      const joined = rows.join(" | ");
      expect(joined).toMatch(/encrypt selection.*⇧⌘E/i);
      expect(joined).toMatch(/lock vault.*⇧⌘L/i);
    } finally {
      await p.close();
    }
  }, 60000);

  /* Each of these is a chord app.js really binds and the shortcuts overlay is
     supposed to list, and each was missing from the one surface whose whole
     job is to enumerate them — a user who reaches for ⌘P out of VS Code
     muscle memory and then checks `?` was told it does not exist. Both halves
     are asserted together (the binding WORKS and the overlay SAYS SO), so they
     cannot drift apart again. */
  test("⌘P, Home / End in the menu, and the Menu key are in it — and all of them work", async () => {
    const p = await newPage(srv);
    try {
      /* ⌘P really opens the palette */
      await chord(p, "KeyP");
      await p.waitForFunction(() => document.getElementById("palVeil")!.classList.contains("show"), { timeout: 8000 });
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.getElementById("palVeil")!.classList.contains("show"), { timeout: 8000 });

      /* the Menu key really opens the sidebar menu, and Home / End really move
         inside it (app.js `ctxKeys`) */
      await p.evaluate(() => (document.querySelector("#sidebar .row[data-path]") as HTMLElement).focus());
      await p.keyboard.press("ContextMenu");
      await p.waitForFunction(() => !document.getElementById("ctxMenu")!.hidden, { timeout: 8000 });
      const cells = () =>
        p.evaluate(() => {
          const items = [...document.querySelectorAll("#ctxMenu .menu-item")].filter((n) => !(n as HTMLElement).hidden);
          return { n: items.length, at: items.indexOf(document.activeElement as Element) };
        });
      /* WAIT for the focus to land rather than reading straight after the key.
         `keyboard.press` resolves when the event is dispatched, not when the
         app's handler has moved focus — so a slower machine read `activeElement`
         while it was still the row that opened the menu, and reported -1. */
      const settled = async (want: "last" | "first") => {
        await p
          .waitForFunction(
            (which) => {
              const items = [...document.querySelectorAll("#ctxMenu .menu-item")].filter((n) => !(n as HTMLElement).hidden);
              const at = items.indexOf(document.activeElement as Element);
              return which === "last" ? at === items.length - 1 && at >= 0 : at === 0;
            },
            { timeout: 5000, polling: 50 },
            want
          )
          .catch(() => {});
        return cells();
      };
      await p.keyboard.press("End");
      const end = await settled("last");
      await p.keyboard.press("Home");
      const home = await settled("first");
      expect(`End → last of ${end.n}: ${end.at === end.n - 1}, Home → first: ${home.at}`).toBe(
        `End → last of ${end.n}: true, Home → first: 0`
      );
      await p.keyboard.press("Escape");

      /* …and the overlay says all four exist */
      await p.keyboard.press("?");
      await p.waitForFunction(() => document.getElementById("scVeil")!.classList.contains("show"), { timeout: 8000 });
      const joined = (
        await p.$$eval("#scVeil .sc-row", (ns) => ns.map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()))
      ).join(" | ");
      expect(joined).toMatch(/search vault.*⌘P/i);
      expect(joined).toMatch(/context menu.*Menu/i);
      expect(joined).toMatch(/menu: move.*Home.*End/i);
    } finally {
      await p.close();
    }
  }, 60000);
});

describe("the create-identity modal reads as prose in every theme", () => {
  for (const theme of ["modern", "minimal", "terminal"]) {
    test(`${theme}: the no-recovery warning is legible and no button is clipped`, async () => {
      const p = await newPage(emptySrv, { query: "?theme=" + theme });
      try {
        await openDoc(p, KEYS);
        await clickBlockButton(p, 0, /create vault identity/i);
        await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 8000 });
        await sleep(350); // the modal's transform/opacity transition

        const m = await p.evaluate(() => {
          const modal = document.querySelector("#ppVeil .modal") as HTMLElement;
          const foot = modal.querySelector(".modal-foot") as HTMLElement;
          const note = document.getElementById("ppHint") as HTMLElement;
          const btns = [...foot.querySelectorAll("button")].filter((b) => !(b as HTMLElement).hidden);
          const mr = modal.getBoundingClientRect();
          const nr = note.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(note).lineHeight) || 14;
          return {
            modalW: Math.round(mr.width),
            modalH: Math.round(mr.height),
            footH: Math.round(foot.getBoundingClientRect().height),
            noteW: Math.round(nr.width),
            noteH: Math.round(nr.height),
            noteLines: Math.round(nr.height / lh),
            overflow: foot.scrollWidth - foot.clientWidth,
            worstOverhang: Math.max(
              ...btns.map((b) => Math.round(b.getBoundingClientRect().right - (mr.right - 1)))
            ),
            buttons: btns.map((b) => (b.textContent ?? "").trim()),
            text: note.textContent ?? "",
          };
        });

        /* the warning is the point of the modal: "There is no recovery: lose it
           and the blocks stay encrypted forever" rendered as a 56px column of
           14 one-word lines */
        expect(m.text).toContain("no recovery");
        expect(`${theme} note width ${m.noteW}px`).toBe(`${theme} note width ${m.noteW}px`);
        expect(m.noteW).toBeGreaterThan(220);
        expect(m.noteLines).toBeLessThanOrEqual(4);

        /* three buttons in a 360px modal: Terminal's overflowed by 2px and cut
           the primary button's right border off */
        expect(m.buttons.length).toBe(3);
        expect(`${theme} footer overflow ${m.overflow}px`).toBe(`${theme} footer overflow 0px`);
        expect(m.worstOverhang).toBeLessThanOrEqual(0);

        /* and the footer is no longer half the dialog */
        expect(m.footH).toBeLessThan(m.modalH * 0.4);
      } finally {
        await p.close();
      }
    }, 60000);
  }

  /* NO REQUIREMENTS, AND NO GRADE (ADR 0006).
     There was a gate; then there was a live meter that graded every keystroke
     and landed on "weak"; now there is neither. A readout is a requirement in
     everything but enforcement — it tells the user their passphrase is wrong
     while accepting it anyway, which is the worst of both. The field says what
     the field is for, the generator is one click away, and nothing scores what
     is typed into it.

     `estimateBits` itself is unchanged and still measured — by entropy.test.ts,
     against MIN_BITS, which is now the generator's floor and nothing else. This
     test is about what the DIALOG says. */
  test("typing a weak passphrase is not graded — no bits, no verdict, no colour", async () => {
    const p = await newPage(emptySrv);
    try {
      await openDoc(p, KEYS);
      await clickBlockButton(p, 0, /create vault identity/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 8000 });

      const before = await p.$eval("#ppHint", (n) => n.textContent ?? "");
      await p.evaluate(() => (document.getElementById("ppInput") as HTMLInputElement).focus());
      await p.keyboard.type("password password password");
      await sleep(200);

      const hint = await p.$eval("#ppHint", (n) => ({ text: n.textContent ?? "", cls: n.className }));
      /* the hint did not react to the keystrokes at all */
      expect(`the hint after typing: ${JSON.stringify(hint.text)}`).toBe(
        `the hint after typing: ${JSON.stringify(before)}`
      );
      expect(`no bit count: ${/bits/i.test(hint.text)}`).toBe("no bit count: false");
      expect(`no verdict: ${/weak|good|strong/i.test(hint.text)}`).toBe("no verdict: false");
      expect(hint.cls).not.toContain("bad");

      /* the generator still speaks — it is the one thing that has something to
         say — and it says nothing about a minimum either */
      await p.click('#ppVeil [data-act="pp-generate"]');
      await sleep(200);
      const gen = await p.$eval("#ppHint", (n) => ({ text: n.textContent ?? "", cls: n.className }));
      expect(gen.text).toMatch(/generated/i);
      expect(`the generator quotes no number: ${/bits/i.test(gen.text)}`).toBe("the generator quotes no number: false");
      expect(gen.cls).not.toContain("bad");
    } finally {
      await p.close();
    }
  }, 60000);

  test("a weak passphrase creates the identity — the floor is advice, not a gate", async () => {
    const p = await newPage(emptySrv);
    try {
      await openDoc(p, KEYS);
      await clickBlockButton(p, 0, /create vault identity/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 8000 });

      for (const id of ["ppInput", "ppConfirm"]) {
        await p.evaluate((x) => (document.getElementById(x as string) as HTMLInputElement).focus(), id);
        await p.keyboard.type("password password password");
      }
      await p.click('#ppVeil [data-act="pp-ok"]');
      await p.waitForFunction(() => !document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 20000 });
      expect(`the identity was written: ${existsSync(join(emptyDir, ".znotes", "identity.age"))}`).toBe(
        "the identity was written: true"
      );
    } finally {
      await p.close();
    }
  }, 60000);
});

/* ============================================================
   The LOCKED block shows NO CIPHERTEXT, and UNLOCKING IS VAULT-WIDE

   Two findings, one model.

   · A locked block used to dump its whole armor body — several hundred bytes of
     base64 — straight into the document, and then (round two) behind a
     `<details>` disclosure. Both read as an EXPOSED secret: what a reader saw
     was a wall of ciphertext, not the padlock and the LOCKED badge above it,
     and a summary bar spanning the doc width in a pane that says "click a line
     to edit" is one stray click from the same wall. A locked block now shows
     NOTHING of itself — no armor, no header line, no byte or line count — and
     ⌘E (Raw) is the honest way to see the source.

   · Reveal was PER BLOCK and opt-in: unlocking the vault revealed nothing, and
     every block, in every doc, cost its own click on a vault that was already
     open. Reveal is now vault-wide — one unlock, every block here and in every
     doc opened afterwards — and locking reverses it everywhere.

   What must NOT change is the byte contract: the document model still holds the
   armor verbatim, so unlock → open → save writes the file back byte for byte.
   ============================================================ */

/** what one block is showing: its geometry and BOTH its texts */
const blockView = (p: Page, nth = 0) =>
  p.evaluate((i) => {
    const w = document.querySelectorAll(".secret")[i] as HTMLElement;
    if (!w) return null;
    const mask = w.querySelector(".secret-mask");
    return {
      h: Math.round(w.getBoundingClientRect().height),
      masked: !!mask,
      cells: mask ? mask.children.length : 0,
      /* what is ON SCREEN vs what is in the DOM AT ALL — the whole point of
         this round is that neither one carries the ciphertext */
      visible: w.innerText,
      dom: w.textContent ?? "",
      html: w.innerHTML,
    };
  }, nth);

/** every block's open/revealed state, cheaply */
const revealedTexts = (p: Page): Promise<(string | null)[]> =>
  p.evaluate(() =>
    [...document.querySelectorAll(".secret")].map((w) => {
      const ta = w.querySelector("textarea") as HTMLTextAreaElement | null;
      return w.classList.contains("open") && ta ? ta.value : null;
    })
  );

const waitForReveals = (p: Page, n: number, timeout = 30000) =>
  p.waitForFunction((k) => document.querySelectorAll(".secret.open").length === k, { timeout }, n);

const waitForLocks = (p: Page, timeout = 30000) =>
  p.waitForFunction(
    () => document.querySelectorAll(".secret").length > 0 && !document.querySelector(".secret.open, .secret.revealing"),
    { timeout }
  );

describe("a locked block shows no ciphertext at all", () => {
  test("neither innerText nor textContent carries the armor, and the block is compact", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      const v = (await blockView(p))!;

      /* the premise: this really is a big armor, not a two-line toy */
      const lines = armor.split("\n");
      const bytes = new TextEncoder().encode(armor).length;
      expect(`the armor under test: ${lines.length} lines / ${bytes} bytes`).toBe(
        `the armor under test: ${lines.length} lines / ${bytes} bytes`
      );

      /* NOT ON SCREEN — and, this round, NOT IN THE DOM EITHER. A `<details>`
         kept its children in `textContent`, which is exactly the escape hatch
         a "collapsed" block still left open. */
      for (const [what, needle] of [
        ["a payload line", lines[2]],
        ["the header", "-----BEGIN AGE ENCRYPTED FILE-----"],
        ["the footer", "-----END AGE ENCRYPTED FILE-----"],
        ["the whole armor", armor],
      ] as const) {
        expect(`${what} in innerText: ${v.visible.includes(needle)}`).toBe(`${what} in innerText: false`);
        expect(`${what} in textContent: ${v.dom.includes(needle)}`).toBe(`${what} in textContent: false`);
        expect(`${what} in innerHTML: ${v.html.includes(needle)}`).toBe(`${what} in innerHTML: false`);
      }

      /* nor a SIZE: a mask whose width or count tracked the payload would be a
         readout of the payload */
      expect(`the line count leaked: ${new RegExp(`\\b${lines.length}\\b`).test(v.visible)}`).toBe(
        "the line count leaked: false"
      );
      expect(`the byte count leaked: ${new RegExp(`\\b${bytes}\\b`).test(v.visible)}`).toBe(
        "the byte count leaked: false"
      );

      /* what IS there: the bar, and a fixed row of blanks */
      expect(`the body is masked: ${v.masked}`).toBe("the body is masked: true");
      expect(`the mask is a constant: ${v.cells}`).toBe("the mask is a constant: 14");
      /* lower-cased: the badge's case is `--label-transform`, a theme token */
      expect(v.visible.replace(/\s+/g, " ").trim().toLowerCase()).toBe(
        "secret block age · x25519 · encrypted locked unlock"
      );

      /* and it is COMPACT: a padlock bar over one row of blanks. The old
         inline dump of this armor was ~800px. */
      expect(`the locked block is ${v.h}px: ${v.h < 130}`).toBe(`the locked block is ${v.h}px: true`);
    } finally {
      await p.close();
    }
  }, 60000);

  test("Raw mode is the escape hatch — the source is there, verbatim", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      await ensureRaw(p);
      const raw = await p.$eval("#rawArea", (n) => (n as HTMLTextAreaElement).value);
      expect(`the armor is in Raw, verbatim: ${raw.includes(armor)}`).toBe("the armor is in Raw, verbatim: true");
    } finally {
      await p.close();
    }
  }, 60000);

  test("a fence that is NOT armor is shown in FULL — the exposure is the warning", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, FAKE);
      const v = (await blockView(p))!;

      /* deliberately not masked: those bytes really are plaintext on disk, in
         git and on GitHub, and hiding them would conceal exactly what the note
         above them is warning about */
      expect(`no mask on a flagged fence: ${!v.masked}`).toBe("no mask on a flagged fence: true");
      expect(`the exposed credential is on screen: ${v.visible.includes(FAKE_SECRET)}`).toBe(
        "the exposed credential is on screen: true"
      );

      const b = (await blocks(p))[0];
      expect(`badge: ${b.badge}`).toBe("badge: Not encrypted");
      expect(`flagged: ${b.flagged}`).toBe("flagged: true");
    } finally {
      await p.close();
    }
  }, 60000);

  test("a MAC failure keeps its warning visible and still shows no ciphertext", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, BROKEN);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await p.waitForFunction(() => !!document.querySelector(".secret.flagged"), { timeout: 30000 });
      await sleep(300);

      const b = (await blocks(p))[0];
      const v = (await blockView(p))!;

      /* the note that says WHY it failed is prose, and prose is never hidden —
         but the damaged ciphertext is still ciphertext and stays masked */
      expect(`flagged: ${b.flagged}`).toBe("flagged: true");
      expect(`the note is on screen: ${b.note.length > 0 && v.visible.includes(b.note.slice(0, 40))}`).toBe(
        "the note is on screen: true"
      );
      expect(`still masked: ${v.masked}`).toBe("still masked: true");
      expect(`no armor footer anywhere in the node: ${v.dom.includes("-----END AGE ENCRYPTED FILE-----")}`).toBe(
        "no armor footer anywhere in the node: false"
      );
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("unlocking the vault reveals every block, everywhere", () => {
  test("one unlock reveals BOTH blocks in the doc, then the next doc opened with no further clicks", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, SECOND);
      expect(`two blocks, both locked: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        "two blocks, both locked: [null,null]"
      );

      /* ONE click on ONE block's Unlock, one passphrase */
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);
      expect(`both revealed from one unlock: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `both revealed from one unlock: ${JSON.stringify([PLAIN.repeat(30), PLAIN2])}`
      );

      /* …and a doc that was NOT on screen when the passphrase was given */
      await openDoc(p, KEYS);
      await waitForReveals(p, 1);
      const clicksNeeded = await p.evaluate(
        () => [...document.querySelectorAll(".secret button")].filter((b) => /unlock/i.test(b.textContent ?? "")).length
      );
      expect(`the second doc revealed itself: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `the second doc revealed itself: ${JSON.stringify([PLAIN.repeat(30)])}`
      );
      expect(`Unlock buttons still on screen: ${clicksNeeded}`).toBe("Unlock buttons still on screen: 0");

      /* an INDENTED block in a list item too — the dedent path is on the
         auto-reveal route now, not only the click route */
      await openDoc(p, LIST);
      await waitForReveals(p, 1);
      expect(`the indented block revealed: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `the indented block revealed: ${JSON.stringify([PLAIN.repeat(30)])}`
      );
    } finally {
      await p.close();
    }
  }, 90000);

  test("a damaged block stays flagged while the healthy block beside it reveals", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, MIXED);
      await clickBlockButton(p, 1, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 1);
      await sleep(400);

      const bs = await blocks(p);
      expect(`the damaged block is flagged: ${bs[0].flagged}`).toBe("the damaged block is flagged: true");
      expect(`its badge: ${bs[0].badge}`).toBe("its badge: Integrity check failed");
      expect(`it did not reveal: ${bs[0].open}`).toBe("it did not reveal: false");
      expect(`the healthy block did: ${bs[1].revealed}`).toBe(`the healthy block did: ${PLAIN2}`);

      /* and the flagged one stays flagged across a full re-render rather than
         being retried into a fresh "Locked" chip */
      await chord(p, "KeyE");
      await p.waitForSelector("#rawArea", { timeout: 8000 });
      await chord(p, "KeyE");
      await waitForReveals(p, 1);
      await sleep(300);
      expect(`still flagged after ⌘E: ${(await blocks(p))[0].flagged}`).toBe("still flagged after ⌘E: true");
    } finally {
      await p.close();
    }
  }, 90000);

  test("the revealed state survives ⌘E and an external write to the file", async () => {
    const p = await newPage(srv);
    const seeded = "# Second\n\nSECONDMARKER\n\n" + fence(armor) + "\nbetween\n\n" + fence(armor2) + "\ntail\n";
    try {
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);

      /* ⌘E to Raw and back rebuilds the preview from scratch */
      await chord(p, "KeyE");
      await p.waitForSelector("#rawArea", { timeout: 8000 });
      await chord(p, "KeyE");
      await waitForReveals(p, 2);
      expect(`revealed after ⌘E → Raw → ⌘E: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `revealed after ⌘E → Raw → ⌘E: ${JSON.stringify([PLAIN.repeat(30), PLAIN2])}`
      );

      /* and the case this app calls normal — "files are edited outside the app
         too": the SSE reconcile lands new text and repaints the doc */
      writeVaultFile(vaultDir, SECOND, seeded.replace("SECONDMARKER", "SECONDMARKER edited outside"));
      await p.waitForFunction(() => (document.getElementById("doc")!.textContent ?? "").includes("edited outside"), {
        timeout: 15000,
      });
      await waitForReveals(p, 2);
      expect(`revealed after an external write: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `revealed after an external write: ${JSON.stringify([PLAIN.repeat(30), PLAIN2])}`
      );
    } finally {
      writeVaultFile(vaultDir, SECOND, seeded);
      await p.close();
    }
  }, 90000);
});

describe("locking reverses the reveal everywhere", () => {
  test("Lock on one block re-locks the whole vault and wipes every plaintext from the DOM", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);

      await clickBlockButton(p, 0, /^lock\b/i);
      await waitForLocks(p);
      await sleep(300);

      expect(`both locked again: ${JSON.stringify(await revealedTexts(p))}`).toBe("both locked again: [null,null]");
      const gone = await p.evaluate(
        (a, b) => {
          const html = document.documentElement.outerHTML;
          const values = [...document.querySelectorAll("input,textarea")].map((n) => (n as HTMLInputElement).value).join("\n");
          return { html: html.includes(a) || html.includes(b), values: values.includes(a) || values.includes(b) };
        },
        PLAIN.trim(),
        PLAIN2.trim()
      );
      expect(`plaintext left anywhere: ${JSON.stringify(gone)}`).toBe('plaintext left anywhere: {"html":false,"values":false}');

      /* the vault, not just this block: the OTHER doc comes back locked too */
      await openDoc(p, KEYS);
      await sleep(500);
      expect(`the other doc is locked: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        "the other doc is locked: [null]"
      );
      const v = (await blockView(p))!;
      expect(`and shows no ciphertext: ${v.masked && !v.dom.includes(ARMOR_HEAD)}`).toBe(
        "and shows no ciphertext: true"
      );
    } finally {
      await p.close();
    }
  }, 90000);

  test("a lock signal from ANOTHER TAB re-locks every block with no click at all", async () => {
    /* The unattended lock paths (idle, tab-hidden, the hard session cap,
       another tab) all arrive at this tab as the SAME worker `locked` event —
       the worker's own clocks are covered in tests/crypto-worker.test.ts. The
       cross-tab one is the only one drivable in a second without faking a
       clock: the real BroadcastChannel the worker is listening on. */
    const p = await newPage(srv);
    try {
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);

      await clearToasts(p);
      await p.evaluate(() => {
        const ch = new BroadcastChannel("znotes-vault-lock");
        ch.postMessage({ type: "lock", reason: "manual" });
        ch.close();
      });

      await waitForLocks(p);
      expect(`locked with no click in this tab: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        "locked with no click in this tab: [null,null]"
      );
      /* and it says WHY, in this tab's own words */
      await waitUntil(async () => (await toasts(p)).some((t) => /another tab/i.test(t)), {
        timeout: 8000,
        label: "the cross-tab lock toast",
      });

      const v = (await blockView(p))!;
      expect(`no ciphertext came back with the lock: ${v.masked && !v.dom.includes(ARMOR_HEAD)}`).toBe(
        "no ciphertext came back with the lock: true"
      );
    } finally {
      await p.close();
    }
  }, 90000);
});

describe("auto-reveal is DISPLAY ONLY — the bytes never move", () => {
  test("unlock → open → save with no edit leaves the file byte-identical", async () => {
    const p = await newPage(srv);
    try {
      const before = readVaultBytes(vaultDir, KEYS);

      /* unlock somewhere ELSE, so KEYS is opened into an already-open vault —
         the exact path auto-reveal added */
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);

      await openDoc(p, KEYS);
      await waitForReveals(p, 1);
      expect(`it revealed itself: ${(await revealedTexts(p))[0] === PLAIN.repeat(30)}`).toBe(
        "it revealed itself: true"
      );

      await chord(p, "KeyS");
      await sleep(900);

      const after = readVaultBytes(vaultDir, KEYS);
      expect(`the file is byte-identical: ${bytesEqual(before, after)}`).toBe("the file is byte-identical: true");
      expect(`the armor is still on disk: ${readVaultText(vaultDir, KEYS).includes(armor)}`).toBe(
        "the armor is still on disk: true"
      );
    } finally {
      await p.close();
    }
  }, 90000);
});

/* ============================================================
   …and it leaks nothing through the surfaces text does not cover.

   `innerText` and `textContent` are two of four places a block can carry its
   ciphertext, and the two that a careless "hide it" fix leaves clean. The other
   two are the ones nobody looks at: an attribute (`title`, `aria-label`, a
   `data-armor` the copy control kept for itself) and the ACCESSIBILITY TREE,
   which is what a screen reader — and any assistive tooling with a view of the
   page — is actually handed.

   The disclosure's own absence is asserted structurally here rather than by its
   symptoms: no `<details>`, no `<summary>`, no `.armorbox` markup, and no dead
   `.armorbox` rules left in the stylesheets, because CSS that still styles a
   node nobody builds is one revert away from building it again.
   ============================================================ */

const ARMOR_TAIL = "-----END AGE ENCRYPTED FILE-----";

/** every string that identifies THIS ciphertext: head, tail, whole, and each
    payload line — a partial render leaks a line, not the lot */
const armorTokens = (a: string) => [
  ARMOR_HEAD,
  ARMOR_TAIL,
  a,
  ...a
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 20),
];

/** the surfaces `blockView` does not read: every attribute of every node in the
    block, plus its structure */
const blockGuts = (p: Page, nth = 0) =>
  p.evaluate((i) => {
    const w = document.querySelectorAll(".secret")[i] as HTMLElement;
    if (!w) return null;
    const attrs: string[] = [];
    const classes: string[] = [];
    const walk = (n: Element) => {
      for (const a of Array.from(n.attributes)) attrs.push(a.name + "=" + a.value);
      classes.push(typeof n.className === "string" ? n.className : "");
      for (const c of Array.from(n.children)) walk(c);
    };
    walk(w);
    return {
      attrs: attrs.join("\n"),
      classes: classes.join(" "),
      details: w.querySelectorAll("details").length,
      summaries: w.querySelectorAll("summary").length,
      visible: w.innerText,
      h: Math.round(w.getBoundingClientRect().height),
      scroll: w.scrollHeight,
      client: w.clientHeight,
    };
  }, nth);

/** how tall the same armor is when a document really renders it — the measured
    stand-in for "the wall this used to be", so the size claim is a COMPARISON
    rather than a number somebody picked */
const armorWallHeight = (p: Page, text: string): Promise<number> =>
  p.evaluate((t) => {
    const host = document.getElementById("doc")!;
    const pre = document.createElement("pre");
    pre.textContent = t;
    host.appendChild(pre);
    const h = Math.round(pre.getBoundingClientRect().height);
    pre.remove();
    return h;
  }, text);

/** is `needle` anywhere a human or a machine could read it, page-wide */
const carries = (p: Page, needle: string) =>
  p.evaluate(
    (n) => ({
      html: document.documentElement.outerHTML.includes(n),
      text: (document.body.innerText ?? "").includes(n),
      values: [...document.querySelectorAll("input,textarea")].some((f) =>
        ((f as HTMLInputElement).value ?? "").includes(n)
      ),
    }),
    needle
  );

describe("a locked block leaks nothing through attributes or the a11y tree", () => {
  test("no armor in any attribute, and none in the accessibility tree", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      const g = (await blockGuts(p))!;
      expect(`the block rendered: ${!!g}`).toBe("the block rendered: true");

      /* POSITIVE CONTROLS: the block is really here, really says what it is,
         and really appears in the a11y tree — otherwise every absence below is
         satisfied by a block that rendered nothing at all */
      expect(g.visible).toContain("Secret block");
      /* the badge is upper-cased by the stylesheet, and `innerText` reports the
         RENDERED text — so this reads it the way the screen does */
      expect(g.visible.toLowerCase()).toContain("locked");
      const a11y = JSON.stringify((await p.accessibility.snapshot({ interestingOnly: false })) ?? null);
      expect(`the block is IN the a11y tree: ${/Secret block|Unlock/.test(a11y)}`).toBe(
        "the block is IN the a11y tree: true"
      );

      const page = await p.evaluate(() => document.documentElement.outerHTML);
      for (const t of armorTokens(armor)) {
        const label = t.slice(0, 22).replace(/\n/g, "\\n");
        /* title=, aria-label=, data-anything= — the places a "hidden" armor
           gets parked when only the text nodes were cleaned up */
        expect(`${label} — in an attribute: ${g.attrs.includes(t)}`).toBe(`${label} — in an attribute: false`);
        expect(`${label} — in the a11y tree: ${a11y.includes(t)}`).toBe(`${label} — in the a11y tree: false`);
        /* and not parked on an ancestor or in a template elsewhere on the page */
        expect(`${label} — anywhere in the page: ${page.includes(t)}`).toBe(`${label} — anywhere in the page: false`);
      }
    } finally {
      await p.close();
    }
  }, 60000);

  test("the armor disclosure is GONE — markup, affordance and stylesheet", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      const g = (await blockGuts(p))!;

      expect(`<details> in the block: ${g.details}`).toBe("<details> in the block: 0");
      expect(`<summary> in the block: ${g.summaries}`).toBe("<summary> in the block: 0");
      expect(
        `<details> anywhere in the pane: ${await p.evaluate(() => document.querySelectorAll("#doc details").length)}`
      ).toBe("<details> anywhere in the pane: 0");
      expect(
        `an armorbox class survives: ${/armorbox|armor-head|armor-meta|armor-show|armor-hide|armor-more/.test(g.classes)}`
      ).toBe("an armorbox class survives: false");

      /* the affordance's own words, and the size readout that was its summary */
      expect(`still offers to show the armor: ${/show armor|hide armor|reveal armor/i.test(g.visible)}`).toBe(
        "still offers to show the armor: false"
      );
      expect(
        `a line or byte count is on screen: ${/\d+\s*(lines?|bytes?|chars?|characters?)/i.test(g.visible)}`
      ).toBe("a line or byte count is on screen: false");
      /* the only digits a locked block may show are the curve's name */
      const digits = g.visible.replace(/x?25519/gi, " ").match(/\d/g) ?? [];
      expect(`stray digits on a locked block: ${JSON.stringify(digits)}`).toBe("stray digits on a locked block: []");

      /* and the CSS that only ever styled it */
      const themes = join(import.meta.dir, "..", "app", "themes");
      const sheets = [...new Bun.Glob("*.css").scanSync({ cwd: themes })];
      expect(`stylesheets found: ${sheets.length > 0}`).toBe("stylesheets found: true");
      for (const f of sheets) {
        const text = readFileSync(join(themes, f), "utf8");
        for (const sel of ["armorbox", "armor-head", "armor-meta", "armor-show", "armor-hide", "armor-more"]) {
          expect(`${f} still styles .${sel}: ${text.includes(sel)}`).toBe(`${f} still styles .${sel}: false`);
        }
      }
    } finally {
      await p.close();
    }
  }, 60000);

  test("the chip is small measured against the wall it replaced, and hides nothing by clipping", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, KEYS);
      const g = (await blockGuts(p))!;
      const wall = await armorWallHeight(p, armor);

      expect(`this armor as document text is ${wall}px, i.e. a wall: ${wall > 200}`).toBe(
        `this armor as document text is ${wall}px, i.e. a wall: true`
      );
      expect(`the locked block is ${g.h}px, and non-zero: ${g.h > 0}`).toBe(
        `the locked block is ${g.h}px, and non-zero: true`
      );
      expect(`…and under a third of the ${wall}px wall: ${g.h * 3 < wall}`).toBe(
        `…and under a third of the ${wall}px wall: true`
      );

      /* the geometric half of the same lie: armor still IN the node, merely
         clipped by an overflow. (The textual half is asserted next door.) */
      expect(`content clipped inside the block: ${g.scroll > g.client + 8}`).toBe(
        "content clipped inside the block: false"
      );
    } finally {
      await p.close();
    }
  }, 60000);
});

/* ============================================================
   TWO REAL TABS.

   The cross-tab lock is asserted next door by posting the worker's own
   BroadcastChannel message, which proves the LISTENER. It cannot prove the
   SENDER: that a tab which locks actually tells the others, and that the tab
   which hears it empties itself while holding its own, independently unlocked
   worker. Two pages, two passphrases, one ⌘⇧L.
   ============================================================ */

describe("locking one tab locks the other one's blocks too", () => {
  test("tab A locks; tab B empties itself and says which tab did it", async () => {
    const a = await newPage(srv);
    const b = await newPage(srv);
    try {
      await openDoc(a, SECOND);
      await clickBlockButton(a, 0, /unlock/i);
      await typePassphrase(a);
      await waitForReveals(a, 2);

      /* B has its own worker and its own scrypt run — two genuinely separate
         unlocked sessions, which is the state the lock signal exists for */
      await openDoc(b, KEYS);
      await clickBlockButton(b, 0, /unlock/i);
      await typePassphrase(b);
      await waitForReveals(b, 1);
      expect(`B revealed: ${(await revealedTexts(b))[0] === PLAIN.repeat(30)}`).toBe("B revealed: true");
      await clearToasts(b);

      /* the lock happens in A, and ONLY in A */
      await chord(a, "KeyL", "Meta", "Shift");
      await waitForLocks(a);

      /* …and B follows with no interaction of its own */
      await waitForLocks(b);
      expect(`B is empty: ${JSON.stringify(await revealedTexts(b))}`).toBe("B is empty: [null]");
      expect(`B still shows the plaintext: ${JSON.stringify(await carries(b, "UICANARYALPHA"))}`).toBe(
        'B still shows the plaintext: {"html":false,"text":false,"values":false}'
      );
      expect(`B's vault chip is down: ${await b.evaluate(() => document.getElementById("stVault")!.hidden)}`).toBe(
        "B's vault chip is down: true"
      );
      await waitUntil(async () => (await toasts(b)).some((t) => /another tab/i.test(t)), {
        timeout: 10000,
        label: "tab B's cross-tab lock toast",
      });

      /* and B's block is a masked chip again, not a wall of armor */
      const v = (await blockView(b))!;
      expect(`B's block came back masked and armorless: ${v.masked && !v.dom.includes(ARMOR_HEAD)}`).toBe(
        "B's block came back masked and armorless: true"
      );
      /* the entry point is back, and it asks again */
      await clickBlockButton(b, 0, /unlock/i);
      await b.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
    } finally {
      await a.close();
      await b.close();
    }
  }, 180000);
});

/* ============================================================
   THE UNATTENDED LOCKS.

   Idle and tab-hidden are the two auto-locks a user never asks for, and they
   are the ones that matter most for a vault-wide reveal: the plaintext of every
   doc visited this session is on screen, and nobody is at the keyboard.

   The worker owns the clocks, the server owns the numbers, and `[secrets]`
   floors both at one minute — so these run against their OWN vault, with the
   policy stored BEFORE the page boots (it is read once, at `init`). Nothing
   here sleeps a guess: the wait is on the lock itself, and nothing touches the
   page while the clock runs, because a keystroke or a pointer event would
   legitimately reset the very timer being measured.
   ============================================================ */

describe("the idle and tab-hidden timers lock every block in the UI", () => {
  let fastSrv: TestServer;
  let fastDir = "";

  beforeAll(async () => {
    fastDir = makeVault({
      "inbox.md": "# Inbox\n",
      [SECOND]: "# Second\n\nSECONDMARKER\n\n" + fence(armor) + "\nbetween\n\n" + fence(armor2) + "\ntail\n",
      [KEYS]: "# Cloud keys\n\nprose above\n\n" + fence(armor) + "\nprose below\n",
      ".znotes/identity.age": wrapped,
      ".znotes/vault.pub": recipient + "\n",
    });
    fastSrv = await startServer({ vault: fastDir });
  }, 60000);

  afterAll(async () => {
    if (fastSrv) await fastSrv.stop();
    if (fastDir) dropVault(fastDir);
  });

  /** store the policy the page will boot with — the floor the schema allows */
  async function withPolicy(idleMinutes: number, hiddenMinutes: number) {
    const r = await fastSrv.api("PUT", "/api/settings", {
      secrets: { idleLockMinutes: idleMinutes, hiddenLockMinutes: hiddenMinutes, sessionHours: 72 },
    });
    expect(`the policy was stored: ${r.status}`).toBe("the policy was stored: 200");
  }

  test("going idle re-locks every block, in the doc on screen and the one behind it", async () => {
    await withPolicy(1, 480);
    const p = await newPage(fastSrv);
    try {
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);
      /* visit the OTHER doc too, so the session is holding reveals for a doc
         that will not be on screen when the timer fires */
      await openDoc(p, KEYS);
      await waitForReveals(p, 1);
      await openDoc(p, SECOND);
      await waitForReveals(p, 2);
      await clearToasts(p);

      /* NOTHING below touches the page — the app pings the worker's activity
         clock on keydown and pointerdown, and a ping here would reset the very
         timer under test */
      await waitForLocks(p, 180000);

      expect((await toasts(p)).join(" | ")).toMatch(/idle/i);
      expect(`every block locked: ${JSON.stringify(await revealedTexts(p))}`).toBe("every block locked: [null,null]");
      for (const canary of ["UICANARYALPHA", "UICANARYBRAVO"]) {
        expect(`${canary} survived the idle lock: ${JSON.stringify(await carries(p, canary))}`).toBe(
          `${canary} survived the idle lock: {"html":false,"text":false,"values":false}`
        );
      }
      const v = (await blockView(p))!;
      expect(`and no ciphertext came back with it: ${v.masked && !v.dom.includes(ARMOR_HEAD)}`).toBe(
        "and no ciphertext came back with it: true"
      );

      /* the doc that was NOT on screen when the vault closed */
      await openDoc(p, KEYS);
      await sleep(400);
      expect(`the unwatched doc is locked too: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        "the unwatched doc is locked too: [null]"
      );
      expect(`its plaintext is gone: ${(await carries(p, "UICANARYALPHA")).html}`).toBe("its plaintext is gone: false");

      /* …and the vault really is closed: the next reveal asks again */
      await clickBlockButton(p, 0, /unlock/i);
      await p.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
    } finally {
      await p.close();
    }
  }, 300000);

  test("a hidden tab re-locks the same way, and says which timer did it", async () => {
    await withPolicy(480, 1);
    const p = await newPage(fastSrv);
    try {
      await openDoc(p, SECOND);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 2);
      await clearToasts(p);

      /* what a backgrounded tab looks like to the app: the same event, read
         the same way its handler reads it */
      await p.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitForLocks(p, 180000);
      expect((await toasts(p)).join(" | ")).toMatch(/hidden/i);
      expect(`every block locked: ${JSON.stringify(await revealedTexts(p))}`).toBe("every block locked: [null,null]");
      for (const canary of ["UICANARYALPHA", "UICANARYBRAVO"]) {
        expect(`${canary} survived the hidden lock: ${(await carries(p, canary)).html}`).toBe(
          `${canary} survived the hidden lock: false`
        );
      }
    } finally {
      await p.close();
    }
  }, 300000);
});

/* ------------------------------------------------------------------
   A decrypt cannot be recalled once it is with the worker. Everywhere else in
   this suite a block decrypts in single-digit milliseconds, so a lock always
   lands on a block that has already opened — the "locked while decrypting"
   state is never actually entered. This describe FORCES that window open with
   a payload big enough to make the decrypt measurably slow (~0.6s), and locks
   while the block is provably still pending. The precondition is asserted, not
   assumed: if the decrypt has already finished when the lock goes out, the
   test FAILS rather than passing for the wrong reason.

   What it proves is the OBSERVABLE property — a lock issued mid-decrypt leaves
   the block masked and lands no plaintext, anywhere. It deliberately does not
   claim to isolate `revealEpoch`: the worker is single-threaded, so the answer
   to a decrypt it is already running is always delivered ahead of any lock
   signal queued behind it, and `state.reveal.clear()` is what this particular
   ordering exercises. Removing that clear fails this test; the epoch guard is
   defence in depth for an ordering the worker does not currently produce, and
   no honest test here can distinguish it.
   ------------------------------------------------------------------ */
describe("a decrypt still in flight when the vault locks answers into nothing", () => {
  const BIG1 = "keys/big-one.md";
  const BIG2 = "keys/big-two.md";
  const BIG_CANARY_1 = "SLOWCANARYONEXRAY";
  const BIG_CANARY_2 = "SLOWCANARYTWOYANKEE";
  /* big enough that the worker takes hundreds of ms, small enough to stay a
     test: measured at ~450ms for the round trip on this machine */
  const BULK = "x".repeat(6 * 1024 * 1024);

  let bigSrv: TestServer;
  let bigDir = "";

  beforeAll(async () => {
    const a1 = await encryptTo(recipient, BIG_CANARY_1 + "\n" + BULK + "\n");
    const a2 = await encryptTo(recipient, BIG_CANARY_2 + "\n" + BULK + "\n");
    bigDir = makeVault({
      "inbox.md": "# Inbox\n",
      [BIG1]: "# Big one\n\nBIGONEMARKER\n\n" + fence(a1) + "\ntail\n",
      [BIG2]: "# Big two\n\nBIGTWOMARKER\n\n" + fence(a2) + "\ntail\n",
      ".znotes/identity.age": wrapped,
      ".znotes/vault.pub": recipient + "\n",
    });
    bigSrv = await startServer({ vault: bigDir });
  }, 120000);

  afterAll(async () => {
    if (bigSrv) await bigSrv.stop();
    if (bigDir) dropVault(bigDir);
  });

  test("the late answer is dropped: the block stays masked and its plaintext never lands", async () => {
    const p = await newPage(bigSrv);
    try {
      /* ---- control: this block CAN be revealed at all ---- */
      await openDoc(p, BIG1);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await waitForReveals(p, 1, 120000);
      expect(`the big block does reveal: ${(await revealedTexts(p))[0]?.startsWith(BIG_CANARY_1)}`).toBe(
        "the big block does reveal: true"
      );

      /* ---- the probe: a block this session has NEVER revealed, so the reveal
         map cannot short-circuit the worker round trip.

         Navigating, watching for the pending state and firing the lock all
         happen INSIDE the page, in one evaluate: the window is a few hundred
         milliseconds wide, and a CDP round trip per observation is easily
         enough to miss it and lock a block that has already opened. Deciding
         in-page removes that latency from the measurement entirely. ---- */
      const atLock = await p.evaluate(
        (sel, marker) =>
          new Promise<Record<string, unknown>>((done) => {
            (document.querySelector(sel) as HTMLElement).click();
            const t0 = performance.now();
            const tick = () => {
              const doc = document.getElementById("doc")!;
              const w = doc.querySelector(".secret");
              /* only once the NEW doc is on screen — until then `.secret` is
                 still the previous doc's (already open) block */
              if (w && (doc.textContent ?? "").includes(marker)) {
                if (w.classList.contains("revealing")) {
                  const state = { pending: true, open: w.classList.contains("open") };
                  const ch = new BroadcastChannel("znotes-vault-lock");
                  ch.postMessage({ type: "lock", reason: "manual" });
                  ch.close();
                  return done(state);
                }
                /* the decrypt beat us: say so rather than locking an already
                   open block and proving the wrong thing */
                if (w.classList.contains("open")) return done({ pending: false, open: true });
              }
              if (performance.now() - t0 > 30000) return done({ pending: false, open: false, timedOut: true });
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        `#tree .row.file[data-doc="${BIG2}"]`,
        "BIGTWOMARKER"
      );
      /* THE precondition. Without it this test would pass on a block that had
         already opened, i.e. prove the wrong thing. */
      expect(`decrypt in flight at lock time: ${JSON.stringify(atLock)}`).toBe(
        'decrypt in flight at lock time: {"pending":true,"open":false}'
      );

      /* far past the point the worker must have answered: the same payload
         decrypts in well under a second on the control above */
      await waitForLocks(p);
      await sleep(8000);

      expect(`the answer painted a reveal anyway: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        "the answer painted a reveal anyway: [null]"
      );
      expect(`${BIG_CANARY_2} reached the page: ${JSON.stringify(await carries(p, BIG_CANARY_2))}`).toBe(
        `${BIG_CANARY_2} reached the page: {"html":false,"text":false,"values":false}`
      );
      /* the first block's plaintext went with it — locking is vault-wide */
      expect(`${BIG_CANARY_1} survived the lock: ${(await carries(p, BIG_CANARY_1)).html}`).toBe(
        `${BIG_CANARY_1} survived the lock: false`
      );

      const v = (await blockView(p))!;
      expect(`it came back masked, with no ciphertext: ${v.masked && !v.dom.includes(ARMOR_HEAD)}`).toBe(
        "it came back masked, with no ciphertext: true"
      );
      const b = (await blocks(p))[0];
      expect(`and it offers Unlock again: ${b.badge} / ${JSON.stringify(b.buttons)}`).toBe(
        'and it offers Unlock again: Locked / ["Unlock"]'
      );
    } finally {
      await p.close();
    }
  }, 300000);
});

/* ============================================================
   IDENTITY: a block is not its ciphertext alone

   `state.reveal` was keyed by `path + armor` and the re-encrypt located the
   block with `doc.markdown.indexOf(armor)`. Two identical fences in one
   document — copy a block to make a staging/prod pair — are indistinguishable
   under both, so editing either one rewrote the FIRST fence: the edit landed on
   the wrong block and the other block's content was destroyed, silently, under
   a "Saved to disk" toast.
   ============================================================ */

describe("two identical age fences in one document are two blocks", () => {
  test("editing one rewrites THAT fence and leaves the other byte-identical", async () => {
    const p = await newPage(srv);
    try {
      const before = ageFences(readVaultText(vaultDir, DUP));
      expect(`the fixture holds the same armor twice: ${before.length} fences, identical=${before[0] === before[1]}`).toBe(
        "the fixture holds the same armor twice: 2 fences, identical=true"
      );

      await openDoc(p, DUP);
      await unlockBlock(p, 0);
      await waitForReveals(p, 2);
      expect(`both copies opened: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `both copies opened: ${JSON.stringify([DUP_PLAIN, DUP_PLAIN])}`
      );

      /* ---- edit ONLY the second copy ---- */
      await typeInto(p, 1, "ONLY_THE_SECOND=1\n");
      expect(`only the second editor changed: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `only the second editor changed: ${JSON.stringify([DUP_PLAIN, DUP_PLAIN + "ONLY_THE_SECOND=1\n"])}`
      );
      await clearToasts(p);
      await chord(p, "KeyS");

      const one = await waitUntil(
        () => {
          const f = ageFences(readVaultText(vaultDir, DUP));
          return f.length === 2 && f.join("\n\0\n") !== before.join("\n\0\n") ? f : null;
        },
        { timeout: 20000, label: "the edited block to reach disk" }
      );
      expect(`the untouched copy is byte-identical: ${one[0] === before[0]}`).toBe(
        "the untouched copy is byte-identical: true"
      );
      expect(`what the two fences decrypt to: ${JSON.stringify([await decryptArmor(one[0]), await decryptArmor(one[1])])}`).toBe(
        `what the two fences decrypt to: ${JSON.stringify([DUP_PLAIN, DUP_PLAIN + "ONLY_THE_SECOND=1\n"])}`
      );

      /* ---- and now the FIRST copy, which must not disturb the second ---- */
      await typeInto(p, 0, "ONLY_THE_FIRST=2\n");
      await chord(p, "KeyS");
      const two = await waitUntil(
        () => {
          const f = ageFences(readVaultText(vaultDir, DUP));
          return f.length === 2 && f[0] !== one[0] ? f : null;
        },
        { timeout: 20000, label: "the first block's edit to reach disk" }
      );
      expect(`the second block survived the first block's save: ${two[1] === one[1]}`).toBe(
        "the second block survived the first block's save: true"
      );
      expect(`what the two fences decrypt to now: ${JSON.stringify([await decryptArmor(two[0]), await decryptArmor(two[1])])}`).toBe(
        `what the two fences decrypt to now: ${JSON.stringify([
          DUP_PLAIN + "ONLY_THE_FIRST=2\n",
          DUP_PLAIN + "ONLY_THE_SECOND=1\n",
        ])}`
      );
    } finally {
      await p.close();
    }
  }, 180000);
});

/* ============================================================
   THE RAW BUFFER IS NOT THE MODEL

   `doSaveDoc` runs `syncRaw()` (textarea → model) and only then
   `flushSecretEdits` (which rewrites the model). A save that lands while the
   pane is in Raw therefore left `#rawArea` holding the PRE-flush armor, and
   the next `syncRaw` — every mode switch does one — wrote that stale armor
   back over the ciphertext that had just been saved. The rotated credential
   was destroyed on disk and the superseded one restored, under "Saved".
   ============================================================ */

describe("a save that lands while the pane is in Raw", () => {
  test("the re-encrypted edit survives the trip back to Preview", async () => {
    const p = await newPage(srv);
    try {
      const want = RAW_PLAIN + "ROTATED=1\n";
      await openDoc(p, RAWSAVE);
      await unlockBlock(p, 0);
      await typeInto(p, 0, "ROTATED=1\n");
      expect(`the editor holds the rotation: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `the editor holds the rotation: ${JSON.stringify([want])}`
      );

      /* look at the source — an ordinary thing to do — and save from there */
      await ensureRaw(p);
      await clearToasts(p);
      await chord(p, "KeyS");
      const saved = await waitUntil(
        () => {
          const f = ageFences(readVaultText(vaultDir, RAWSAVE));
          return f.length === 1 && f[0] !== rawArmor ? f[0] : null;
        },
        { timeout: 20000, label: "the re-encrypted block to reach disk" }
      );
      expect(`the save wrote the rotation: ${JSON.stringify(await decryptArmor(saved))}`).toBe(
        `the save wrote the rotation: ${JSON.stringify(want)}`
      );

      /* back to Preview: the mode switch syncs the raw buffer into the model */
      await ensurePreview(p);
      await waitForReveals(p, 1);
      expect(`the block still shows the rotation: ${JSON.stringify(await revealedTexts(p))}`).toBe(
        `the block still shows the rotation: ${JSON.stringify([want])}`
      );

      /* and the next save does not put the superseded ciphertext back */
      await chord(p, "KeyS");
      await sleep(2000);
      const finalFences = ageFences(readVaultText(vaultDir, RAWSAVE));
      expect(`the file still decrypts to the rotation: ${JSON.stringify(await decryptArmor(finalFences[0]))}`).toBe(
        `the file still decrypts to the rotation: ${JSON.stringify(want)}`
      );
      expect(`and the superseded armor is gone: ${!readVaultText(vaultDir, RAWSAVE).includes(rawArmor)}`).toBe(
        "and the superseded armor is gone: true"
      );
    } finally {
      await p.close();
    }
  }, 180000);
});

/* ============================================================
   AN UNCLASSIFIED FAILURE IS STILL A FAILURE

   `FAIL_STATES` covered four codes, and the failure was recorded only when the
   code matched one of them. The worker's `undecryptable` fallthrough (and a
   wedge timeout, which carries no code at all) therefore recorded NOTHING —
   and the repaint that followed re-entered `autoReveal` for a key that was in
   no map, which asked again, which repainted again: an unbounded hot retry
   loop under a block stuck on "Unlocking" with no button to escape it and no
   integrity alarm.
   ============================================================ */

describe("a decrypt failure the classifier does not recognise", () => {
  test("the block is flagged once, offers Retry unlock, and is not asked again", async () => {
    const p = await newPage(srv, { countOps: true });
    try {
      /* PRECONDITION, measured: this fixture really does produce a message no
         branch of the worker's classifier matches */
      expect(`"${oddMessage}" is unclassified: ${!CLASSIFIED.test(oddMessage)}`).toBe(
        '"invalid X25519 stanza" is unclassified: true'
      );

      await openDoc(p, ODD);
      await clickBlockButton(p, 0, /unlock/i);
      await typePassphrase(p);
      await p.waitForFunction(() => !!document.querySelector(".secret.flagged"), {
        timeout: 30000,
      });

      const decrypts = () => p.evaluate(() => (window as any).__ops.filter((o: string) => o === "decrypt").length);
      const n1 = await decrypts();
      await sleep(3000);
      const n2 = await decrypts();
      /* the count is the assertion: the measured loop ran at ~11,000 asks per
         second, so anything bounded here is a different program */
      expect(`decrypt asks: ${n1 <= 4 ? "bounded" : n1} then, 3s later, ${n2 === n1 ? "unchanged" : n2}`).toBe(
        "decrypt asks: bounded then, 3s later, unchanged"
      );

      const [b] = await blocks(p);
      expect(`badge / buttons: ${b.badge} / ${JSON.stringify(b.buttons)}`).toBe(
        'badge / buttons: Could not decrypt / ["Retry unlock"]'
      );
      expect(`flagged, not still unlocking: ${b.flagged} / ${b.subtitle}`).toBe(
        "flagged, not still unlocking: true / age · x25519 · the decrypt failed for an unrecognised reason"
      );
      expect(`the note explains it: ${b.note.includes("did not decrypt")}`).toBe("the note explains it: true");
      expect(`the failure was announced: ${(await toasts(p)).some((t) => t.includes(oddMessage))}`).toBe(
        "the failure was announced: true"
      );

      /* nothing of the plaintext, and a healthy doc still reveals */
      expect(`the canary never appeared: ${JSON.stringify(await carries(p, "ODDCANARY"))}`).toBe(
        'the canary never appeared: {"html":false,"text":false,"values":false}'
      );
      await openDoc(p, KEYS);
      await waitForReveals(p, 1);
    } finally {
      await p.close();
    }
  }, 180000);
});

/* ============================================================
   LOCKING WIPES THE SCREEN BEFORE IT TOUCHES THE NETWORK

   `onVaultLocked` awaited the re-encrypt AND the PUT before clearing
   `state.reveal` and repainting. `putDoc` is a bare fetch with no deadline, so
   a wedged or suspended server held the plaintext in an open editor
   indefinitely — measured unchanged 30s after an idle lock, the exact moment
   the screen is unattended.
   ============================================================ */

describe("locking wipes the screen before it waits on the network", () => {
  test("a PUT that never returns does not keep the plaintext on screen", async () => {
    const p = await newPage(srv);
    try {
      await openDoc(p, LOCKHOLD);
      await unlockBlock(p, 0);
      await typeInto(p, 0, "LOCKEDIT=1\n");
      const want = LOCK_PLAIN + "LOCKEDIT=1\n";

      /* the wedged server: every document write is accepted and never answered */
      const held: import("puppeteer-core").HTTPRequest[] = [];
      await p.setRequestInterception(true);
      p.on("request", (req) => {
        if (req.method() === "PUT" && /\/api\/docs\//.test(req.url())) {
          held.push(req);
          return;
        }
        req.continue().catch(() => {});
      });

      await clearToasts(p);
      /* the real signal: what the idle timer and another tab both send */
      await p.evaluate(() => {
        const ch = new BroadcastChannel("znotes-vault-lock");
        ch.postMessage({ type: "lock", reason: "idle" });
        ch.close();
      });

      /* THE assertion. The wipe is synchronous with the lock, so it does not
         need a second — and it must not wait for a round trip that is not
         coming. */
      await p.waitForFunction(
        (needle) =>
          !document.querySelector(".secret.open, .secret textarea") &&
          ![...document.querySelectorAll("input,textarea")].some((f) =>
            ((f as HTMLInputElement).value ?? "").includes(needle)
          ),
        { timeout: 2000 },
        "LOCKCANARY"
      );
      expect(`the plaintext is gone from every surface: ${JSON.stringify(await carries(p, "LOCKCANARY"))}`).toBe(
        'the plaintext is gone from every surface: {"html":false,"text":false,"values":false}'
      );
      expect(`and the lock was announced: ${(await toasts(p)).some((t) => t.startsWith("Vault locked"))}`).toBe(
        "and the lock was announced: true"
      );

      /* …and this was NOT vacuous: the write really is still outstanding */
      await waitUntil(() => held.length > 0, { timeout: 10000, label: "the lock-time PUT to be issued" });
      expect(`nothing has reached disk yet: ${ageFences(readVaultText(vaultDir, LOCKHOLD))[0] === lockArmor}`).toBe(
        "nothing has reached disk yet: true"
      );

      /* release the wedge: the edit still has to land, re-encrypted */
      for (const r of held) await r.continue().catch(() => {});
      const saved = await waitUntil(
        () => {
          const f = ageFences(readVaultText(vaultDir, LOCKHOLD));
          return f.length === 1 && f[0] !== lockArmor ? f[0] : null;
        },
        { timeout: 20000, label: "the re-encrypted edit to reach disk" }
      );
      expect(`what the released write stored: ${JSON.stringify(await decryptArmor(saved))}`).toBe(
        `what the released write stored: ${JSON.stringify(want)}`
      );
      expect(`and it is ciphertext: ${!readVaultText(vaultDir, LOCKHOLD).includes("LOCKCANARY")}`).toBe(
        "and it is ciphertext: true"
      );
    } finally {
      await p.setRequestInterception(false).catch(() => {});
      await p.close();
    }
  }, 180000);
});
