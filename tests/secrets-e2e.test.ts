/* ============================================================
   secrets-e2e.test.ts — PHASE 3 gate, real browser, real crypto (SPEC §6, §11).

   The bun-side file proves the FORMAT. This one proves the PRODUCT: a real
   Chromium, the real backend, a temp vault seeded with a REAL age identity and
   a REAL encrypted block that this test generated and can therefore decrypt
   itself. Nothing is mocked; the passphrase is typed into the actual modal and
   the scrypt runs in the actual worker.

   The gates, in the order they run:

     · a locked block shows NEITHER plaintext nor ciphertext — the armor is in
       the document model (Raw), never on the screen (SPEC §6)
     · wrong passphrase → visible failure, block stays locked
     · right passphrase → plaintext revealed, in an editor carrying every
       anti-exfiltration attribute the research leak table names
     · nothing lands in localStorage / sessionStorage / IndexedDB — ever
     · Copy puts the plaintext on the system clipboard and shows a countdown
       that actually counts
     · BYTE STABILITY (research §4.2, the §11 gate): a revealed-but-UNEDITED
       block saved again emits the original armor byte for byte — both on a
       bare ⌘S and when an unrelated edit forces a real write
     · lock-again returns the block to its masked chip and drops the plaintext
     · an EDITED reveal re-encrypts: the file gets NEW armor that decrypts to
       the edit, and the old armor is gone
     · every PUT body the browser ever sent carried armor and never plaintext,
       including the autosave that fires mid-reveal
     · reload ⇒ locked again, nothing persisted
     · Encrypt selection (⌘⇧E) in Raw works while the vault is LOCKED, and the
       fence it writes decrypts — bun-side — to exactly the selection
     · unlocking is VAULT-WIDE and DISPLAY ONLY: one Unlock reveals this doc,
       the next doc opened arrives revealed with no click, and neither costs a
       byte — ⌘S with nothing edited is byte-identical, and the autosave that
       fires while blocks are revealed PUTs armor only
     · degradation: no crypto.subtle ⇒ badge, disabled affordance, doc still
       renders, no console errors

   Driver: puppeteer-core over a Playwright-cached Chromium, same as
   tests/e2e.test.ts. The full Chrome build is preferred when present because
   chrome-headless-shell refuses clipboard writes even with the permission
   granted; if only the shell is available the clipboard assertions run against
   a recording shim instead, and say so.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import * as age from "age-encryption";
import {
  bytesEqual,
  describeByteDiff,
  dropVault,
  makeVault,
  readVaultBytes,
  readVaultText,
  sleep,
  startServer,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { ensureMode as setMode, launchTestBrowser, pressChord, waitForApp } from "./browser";

/* ------------------------------------------------------------------
   fixtures — everything below is generated, so the test can decrypt it
   ------------------------------------------------------------------ */

const PASSPHRASE = "correct horse battery staple mango velvet";
const WRONG_PASSPHRASE = "correct horse battery staple mango velvel";

/* Deliberately DIGIT-FREE. The clipboard countdown is read by pulling the
   digits out of the secret block's own text, and a digit in the plaintext
   would poison that reading. */
const PLAINTEXT =
  "AWS_ACCESS_KEY_ID=CANARYALPHAONLY\n" +
  "AWS_SECRET_ACCESS_KEY=ZZQQXXJJVVBBNNMMOOPPRRSS\n" +
  "region=euwest\n";
const CANARY = "CANARYALPHAONLY";

const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";

/* A SECOND real block, in a doc no other gate touches. Vault-wide reveal is
   about the doc you open NEXT, so proving it needs a doc that was not on screen
   when the passphrase was given — and the byte-stability gate for auto-reveal
   needs a file whose bytes no earlier test has moved. Digit-free for the same
   reason PLAINTEXT is. */
const PLAINTEXT2 = "HETZNER_API_TOKEN=CANARYBRAVOONLY\nproject=hel\n";
const CANARY2 = "CANARYBRAVOONLY";

const KEYS_DOC = "keys/cloud-keys.md";
const OTHER_DOC = "keys/other-keys.md";
const SCRATCH_DOC = "notes/scratch.md";
const SELECTION = "SELECTMEALPHA-BRAVO-CHARLIE";

const SCRATCH_MD = `# Scratch\n\nheader line\n\n${SELECTION}\n\ntail line\n`;

let identity = "";
let recipient = "";
let wrappedIdentity = "";
let blockArmor = ""; // the armor as it sits inside the fence (no trailing NL)
let otherArmor = "";
let keysDoc = "";
let otherDoc = "";

let srv: TestServer;
let vaultDir = "";
let browser: Browser;
let page: Page;
let clipboardIsReal = false;

/** every request the browser made, with its body — the leak evidence */
interface Sent {
  method: string;
  url: string;
  body: string;
}
let sent: Sent[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

/** the browser's own chrome, not the app's: a missing favicon is not a bug */
const isNoise = (t: string) => /favicon/i.test(t);

async function decryptArmor(armor: string): Promise<string> {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(age.armor.decode(armor.endsWith("\n") ? armor : armor + "\n"), "text");
}

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
    } else {
      cur.push(line);
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   browser discovery — prefer a build that can actually reach the clipboard
   ------------------------------------------------------------------ */

function findClipboardChromium(): string | null {
  const roots = [
    join(process.env.HOME ?? "", "Library/Caches/ms-playwright"),
    join(process.env.HOME ?? "", ".cache/ms-playwright"),
  ];
  const patterns = [
    "chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chromium-*/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chromium-*/chrome-linux/chrome",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      const hits = [...glob.scanSync({ cwd: root, onlyFiles: false, followSymlinks: true })].sort();
      if (hits.length) return join(root, hits[hits.length - 1]);
    }
  }
  return null;
}

/**
 * Launch the browser this suite will drive.
 *
 * `findClipboardChromium()` returns a CANDIDATE, not a guarantee — and a
 * candidate that cannot drive the app is worse than no candidate at all,
 * because the whole suite then fails for a reason that has nothing to do with
 * secrets. Measured on this machine: the cached "Google Chrome for Testing"
 * (145.0.7632.6) boots the app correctly — `document.querySelector` finds
 * `#app:not([hidden])` — but puppeteer's wait primitives armed against it go
 * stale the moment the app's boot does its first `history.replaceState`, and
 * the frame detaches partway through the first test.
 *
 * So the candidate is SMOKE-TESTED before the suite commits to it, and the
 * headless shell is the fallback. Nothing is weakened by taking that branch:
 * every assertion in this file still runs, and the clipboard gate already has
 * a first-class path for a browser that will not hand over the real clipboard
 * (see `clipboardIsReal` and the recording shim below) — this just extends the
 * same "verify, do not assume" treatment one step earlier, to whether the
 * browser can be driven at all.
 */
async function launchDrivableBrowser(base: string): Promise<Browser> {
  const candidate = findClipboardChromium();
  if (candidate) {
    let trial: Browser | null = null;
    try {
      trial = await launchTestBrowser(candidate);
      const probe = await trial.newPage();
      /* The exact shape that goes stale: a wait armed IMMEDIATELY after `goto`,
         so it is outstanding while the app's boot calls `history.replaceState`.
         Waiting first and asking afterwards passes on the broken build too —
         which is why this probe does not poll before it measures. */
      await probe.goto(base + "/", { waitUntil: "domcontentloaded" });
      await probe.waitForSelector("#app:not([hidden])", { timeout: 12000 });
      await probe.waitForSelector("#tree .row", { timeout: 4000 });
      await probe.waitForFunction(() => !!document.getElementById("stPath")!.textContent, { timeout: 4000 });
      await probe.close();
      return trial;
    } catch (err) {
      await trial?.close().catch(() => {});
      console.warn(
        `[secrets-e2e] the clipboard-capable Chromium at ${candidate} could not be driven ` +
          `(${String((err as Error)?.message || err).slice(0, 120)}) — falling back to the headless shell`
      );
    }
  }
  return launchTestBrowser();
}

/* ------------------------------------------------------------------
   page helpers — deliberately structural (classes and ids the prototype
   already ships) with text-matched controls, so a re-labelled button fails
   loudly instead of silently selecting the wrong one
   ------------------------------------------------------------------ */

/* the shared app vocabulary — see tests/browser.ts */
const chord = (code: string, ...mods: string[]) => pressChord(page, code, ...mods);
const ensureMode = (want: "raw" | "preview") => setMode(page, want);

async function openDoc(path: string) {
  await page.click(`#tree .row.file[data-doc="${path}"]`);
  await page.waitForFunction(
    (p) => document.getElementById("stPath")!.textContent === p,
    { timeout: 8000 },
    path
  );
  await sleep(250); // navigation fade-in
}

/** the observable state of the first secret block in the document */
async function block() {
  return page.evaluate(() => {
    const w = document.querySelector(".secret");
    if (!w) return null;
    const editor = w.querySelector<HTMLTextAreaElement>("textarea, [contenteditable]");
    const isTa = editor instanceof HTMLTextAreaElement;
    return {
      open: w.classList.contains("open"),
      text: w.textContent ?? "",
      buttons: [...w.querySelectorAll("button")].map((b) => ({
        label: (b.textContent ?? "").trim(),
        disabled: (b as HTMLButtonElement).disabled,
      })),
      revealed: editor ? (isTa ? (editor as HTMLTextAreaElement).value : editor.textContent ?? "") : null,
      editorAttrs: editor
        ? {
            spellcheck: editor.getAttribute("spellcheck"),
            autocomplete: editor.getAttribute("autocomplete"),
            autocapitalize: editor.getAttribute("autocapitalize"),
            autocorrect: editor.getAttribute("autocorrect"),
            gramm: editor.getAttribute("data-gramm"),
            grammarly: editor.getAttribute("data-enable-grammarly"),
            tag: editor.tagName.toLowerCase(),
          }
        : null,
    };
  });
}

/**
 * MASKED, NEVER DROPPED. A locked block renders no ciphertext (SPEC §6), so
 * "the armor is still there" can no longer be read off the block's DOM — the
 * document MODEL is where it has to be, and Raw is that model rendered
 * verbatim. Leaves the pane back in Preview.
 */
async function armorInModel() {
  await ensureMode("raw");
  const raw = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
  await ensureMode("preview");
  await sleep(150);
  return raw.includes(blockArmor);
}

async function clickBlockButton(re: RegExp) {
  const label = await page.evaluate((src) => {
    const rx = new RegExp(src, "i");
    const w = document.querySelector(".secret");
    if (!w) return null;
    const b = [...w.querySelectorAll("button")].find((n) => rx.test((n.textContent ?? "").trim()));
    if (!b) return null;
    (b as HTMLButtonElement).click();
    return (b.textContent ?? "").trim();
  }, re.source);
  if (label == null) {
    const state = await block();
    throw new Error(
      `no button matching ${re} inside .secret — buttons were ` +
        JSON.stringify(state?.buttons ?? null) +
        ` (block open=${state?.open})`
    );
  }
  return label;
}

async function clearFeedback() {
  await page.evaluate(() => {
    const t = document.getElementById("toast");
    t?.classList.remove("show");
    const txt = document.getElementById("toastTxt");
    if (txt) txt.textContent = "";
  });
}

/** type into the passphrase modal and confirm. Does NOT wait for the outcome. */
async function submitPassphrase(pass: string) {
  await page.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), {
    timeout: 10000,
  });
  await page.evaluate(() => {
    const i = document.getElementById("ppInput") as HTMLInputElement;
    i.value = "";
    i.focus();
  });
  await page.keyboard.type(pass);
  await page.click('#ppVeil [data-act="pp-ok"]');
}

/**
 * Click Unlock and wait for the block to reveal. The passphrase modal appears
 * only when the VAULT is locked — the design is one unlock per session, so a
 * second block (or a re-reveal after Lock) opens with no prompt at all. Both
 * paths end in the same place, and this helper asserts neither: it just gets
 * there.
 */
async function unlockBlock(pass = PASSPHRASE) {
  await clickBlockButton(/unlock/i);
  await page.waitForFunction(
    () => document.getElementById("ppVeil")!.classList.contains("show") || !!document.querySelector(".secret.open"),
    { timeout: 30000 }
  );
  const prompted = await page.evaluate(() => document.getElementById("ppVeil")!.classList.contains("show"));
  if (prompted) await submitPassphrase(pass);
  await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });
  return prompted;
}

/**
 * The first visible failure signal after a bad passphrase, whatever form it
 * takes: a toast, or an error-styled node inside the modal. The class list is
 * deliberately broad (`bad`, `err`, `warn`, …) because the SHAPE of the message
 * is the implementer's call — that one exists, and that the block stays locked,
 * is not.
 */
async function waitForFailureSignal(): Promise<string> {
  const h = await page.waitForFunction(
    () => {
      const toast = document.getElementById("toast");
      if (toast?.classList.contains("show")) return "toast: " + (document.getElementById("toastTxt")?.textContent ?? "");
      const veil = document.getElementById("ppVeil");
      if (veil?.classList.contains("show")) {
        const err = veil.querySelector(
          "[class*='err'],[class*='Err'],[class*='bad'],[class*='warn'],[class*='invalid'],[class*='danger'],[role='alert'],[data-error]"
        );
        const t = (err?.textContent ?? "").trim();
        if (t) return "modal: " + t;
      }
      return null;
    },
    { timeout: 40000, polling: 120 }
  );
  return String(await h.jsonValue());
}

const storageDump = () =>
  page.evaluate(async () => {
    const dump = (s: Storage) => {
      const o: Record<string, string> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i) as string;
        o[k] = s.getItem(k) ?? "";
      }
      return o;
    };
    let dbs: string[] = [];
    let dbApi = false;
    try {
      const f = (indexedDB as any).databases;
      if (typeof f === "function") {
        dbApi = true;
        dbs = (await f.call(indexedDB)).map((d: any) => String(d?.name ?? ""));
      }
    } catch {
      /* ignore */
    }
    return { local: dump(localStorage), session: dump(sessionStorage), dbs, dbApi };
  });

/* ------------------------------------------------------------------
   boot
   ------------------------------------------------------------------ */

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);

  const wrap = new age.Encrypter();
  wrap.setPassphrase(PASSPHRASE);
  wrap.setScryptWorkFactor(18); // the one scrypt run this file does bun-side
  wrappedIdentity = age.armor.encode(await wrap.encrypt(identity));

  const e = new age.Encrypter();
  e.addRecipient(recipient);
  blockArmor = age.armor.encode(await e.encrypt(PLAINTEXT)).trimEnd();

  keysDoc =
    "# Cloud keys\n" +
    "\n" +
    "CLOUDKEYSMARKER prose above the block\n" +
    "\n" +
    "- [ ] rotate the access keys\n" +
    "\n" +
    "```age\n" +
    blockArmor +
    "\n```\n" +
    "\n" +
    "CLOUDKEYSTAIL prose below\n";

  const e2 = new age.Encrypter();
  e2.addRecipient(recipient);
  otherArmor = age.armor.encode(await e2.encrypt(PLAINTEXT2)).trimEnd();

  otherDoc =
    "# Other keys\n" +
    "\n" +
    "OTHERKEYSMARKER prose above the block\n" +
    "\n" +
    "```age\n" +
    otherArmor +
    "\n```\n" +
    "\n" +
    "OTHERKEYSTAIL prose below\n";

  const seed: SeedMap = {
    "inbox.md": "# Inbox\n\nnothing yet\n",
    [KEYS_DOC]: keysDoc,
    [OTHER_DOC]: otherDoc,
    [SCRATCH_DOC]: SCRATCH_MD,
    ".znotes/identity.age": wrappedIdentity,
    ".znotes/vault.pub": recipient + "\n",
  };

  vaultDir = makeVault(seed);
  srv = await startServer({ vault: vaultDir });

  /* autosave fast enough to observe inside a test, slow enough that a single
     keystroke burst still coalesces into one PUT */
  const s = await srv.api("PUT", "/api/settings", { editor: { autosaveSeconds: 1 } });
  expect(s.status).toBe(200);

  browser = await launchDrivableBrowser(srv.base);

  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !isNoise(m.text())) consoleErrors.push(m.text());
  });
  page.on("request", (req) => {
    const m = req.method().toUpperCase();
    if (m === "GET" || m === "HEAD") return;
    sent.push({ method: m, url: req.url(), body: req.postData() ?? "" });
  });

  /* real clipboard where the browser allows it; a recording shim otherwise, so
     the copy assertions still measure what the APP does */
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Browser.grantPermissions" as any, {
      origin: srv.base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    } as any);
  } catch {
    /* fall through to the probe below */
  }
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  clipboardIsReal = await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText("znotes-clipboard-probe");
      return (await navigator.clipboard.readText()) === "znotes-clipboard-probe";
    } catch {
      return false;
    }
  });
  if (!clipboardIsReal) {
    await page.evaluateOnNewDocument(() => {
      const w = window as any;
      w.__clip = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (t: string) => {
            w.__clip.push(t);
            return undefined;
          },
          readText: async () => w.__clip[w.__clip.length - 1] ?? "",
        },
      });
    });
    console.warn(
      "[secrets-e2e] this Chromium refuses clipboard writes — the copy gate runs against a recording shim"
    );
  }

  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(page, 25000);
  sent = []; // ignore whatever boot did; every later assertion is about writes
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (vaultDir) dropVault(vaultDir);
});

/* ============================================================
   the gates
   ============================================================ */

describe("secrets e2e — a locked block", () => {
  test("renders as a locked secret showing NEITHER the armor nor the plaintext", async () => {
    await openDoc(KEYS_DOC);
    const b = await block();
    expect(b).not.toBe(null);
    expect(b!.open).toBe(false);
    /* SPEC §6: a locked block shows no ciphertext at all. The armor is not in
       this node's rendered text and not in its DOM either — it is in the
       document model, which is what Raw and the save path read. */
    expect(b!.text).not.toContain(ARMOR_HEAD);
    expect(await armorInModel()).toBe(true);

    /* the prose around the fence still renders — a block that ate the document
       is not a passing secrets feature */
    const docText = await page.evaluate(() => document.getElementById("doc")!.textContent ?? "");
    expect(docText).toContain("CLOUDKEYSMARKER");
    expect(docText).toContain("CLOUDKEYSTAIL");

    /* and there is genuinely no plaintext in the page, anywhere */
    const leak = await page.evaluate(
      (needle) => ({
        html: document.documentElement.outerHTML.includes(needle),
        values: [...document.querySelectorAll("input,textarea")].some((n) =>
          ((n as HTMLInputElement).value ?? "").includes(needle)
        ),
      }),
      CANARY
    );
    expect(leak).toEqual({ html: false, values: false });

    expect(b!.buttons.some((x) => /unlock/i.test(x.label))).toBe(true);
  }, 40000);

  test("the passphrase field is a masked TEXT input, never type=password (SPEC §9)", async () => {
    await clickBlockButton(/unlock/i);
    await page.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), {
      timeout: 10000,
    });
    const f = await page.evaluate(() => {
      const i = document.getElementById("ppInput") as HTMLInputElement;
      const cs = getComputedStyle(i);
      return {
        type: i.type,
        autocomplete: i.getAttribute("autocomplete"),
        security: (cs as any).webkitTextSecurity ?? cs.getPropertyValue("-webkit-text-security"),
      };
    });
    expect(f.type).toBe("text");
    expect(f.autocomplete).toBe("off");
    /* masking is CSS, not the input type — otherwise the browser password
       manager captures the vault passphrase */
    expect(["disc", "circle", "square"]).toContain(String(f.security));

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("ppVeil")!.classList.contains("show"), {
      timeout: 8000,
    });
  }, 30000);

  test("a wrong passphrase fails visibly and the block stays locked", async () => {
    await clearFeedback();
    await clickBlockButton(/unlock/i);
    await submitPassphrase(WRONG_PASSPHRASE);

    const signal = await waitForFailureSignal();
    expect(signal.length).toBeGreaterThan("toast: ".length);

    /* dismiss anything still open, then look at the block itself */
    await page.keyboard.press("Escape");
    await sleep(200);
    const b = await block();
    expect(b!.open).toBe(false);
    expect(b!.revealed).toBe(null);
    /* a refused unlock leaves the block exactly as it was: a masked chip that
       shows neither the plaintext it could not reach nor the ciphertext it
       still holds (SPEC §6) */
    expect(b!.text).not.toContain(ARMOR_HEAD);
    expect(await armorInModel()).toBe(true);
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    expect(html.includes(CANARY)).toBe(false);
    expect(html.includes(ARMOR_HEAD)).toBe(false);
  }, 60000);
});

describe("secrets e2e — unlock and reveal", () => {
  test("the right passphrase reveals the plaintext", async () => {
    await clearFeedback();
    await unlockBlock();

    const b = await block();
    expect(b!.open).toBe(true);
    expect(b!.revealed).toBe(PLAINTEXT);
    expect(b!.buttons.some((x) => /copy/i.test(x.label))).toBe(true);
    expect(b!.buttons.some((x) => /^lock\b/i.test(x.label.replace(/\s+/g, " ")))).toBe(true);
  }, 60000);

  test("the reveal editor carries every anti-exfiltration attribute (research §6)", async () => {
    const b = await block();
    expect(b!.editorAttrs).not.toBe(null);
    expect(b!.editorAttrs).toEqual({
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      gramm: "false",
      grammarly: "false",
      tag: b!.editorAttrs!.tag, // textarea or contenteditable — either is fine
    });
  }, 20000);

  test("no crypto material reaches localStorage, sessionStorage or IndexedDB", async () => {
    const s = await storageDump();
    const blob = JSON.stringify(s.local) + "\n" + JSON.stringify(s.session);
    for (const needle of [PASSPHRASE, identity, "AGE-SECRET-KEY", CANARY, ARMOR_HEAD, wrappedIdentity]) {
      const label = needle.slice(0, 24);
      expect(`${label} in web storage: ${blob.includes(needle)}`).toBe(`${label} in web storage: false`);
    }
    /* the design is absolute: nothing goes in IndexedDB at all (research §5.2),
       so the database list is empty rather than merely crypto-free */
    expect(s.dbApi).toBe(true); // otherwise the line below proves nothing
    expect(s.dbs).toEqual([]);
  }, 20000);

  test("Copy puts the plaintext on the clipboard and shows a countdown that ticks", async () => {
    /* The countdown is the only number the block can legitimately show: the
       PLAINTEXT fixture is deliberately digit-free, and `x25519` in the block's
       subtitle is stripped (and would be filtered by the ≤60 bound anyway). */
    const digitsIn = (t: string) =>
      (t.replace(/x?25519/gi, " ").match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n <= 60);

    /* the clipboard API only settles for a focused document — a real user's
       copy happens in the focused tab, so put the tab there */
    await page.bringToFront();
    await page.evaluate(() => window.focus());

    const before = digitsIn((await block())!.text);
    await clickBlockButton(/copy/i);

    /* the countdown must APPEAR (the research table asks for a visible one) */
    const after = await waitUntil(
      async () => {
        const d = digitsIn((await block())!.text);
        if (d.length > before.length || d.some((n) => n > 0 && n <= 30 && !before.includes(n))) return d;
        /* surface the app's own explanation instead of a bare timeout */
        const why = await page.evaluate(() => ({
          toast: document.getElementById("toastTxt")?.textContent ?? "",
          focused: document.hasFocus(),
          buttons: [...document.querySelectorAll(".secret button")].map((b) => (b.textContent ?? "").trim()),
        }));
        if (/refus|denied|unavailable|fail/i.test(why.toast) || !why.focused) {
          throw new Error(
            `no countdown — toast="${why.toast}" focused=${why.focused} realClipboard=${clipboardIsReal} buttons=${JSON.stringify(why.buttons)}`
          );
        }
        return null;
      },
      { timeout: 10000, label: "a visible clipboard countdown inside .secret" }
    );
    const first = Math.max(...after);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(30);

    /* …and it must actually count down, not be a static label */
    await sleep(2200);
    const later = digitsIn((await block())!.text);
    expect(Math.max(...later)).toBeLessThan(first);

    const clip = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch (e) {
        return "READ-FAILED " + String(e);
      }
    });
    expect(clip).toBe(PLAINTEXT);
  }, 40000);
});

describe("secrets e2e — byte stability (research §4.2, SPEC §11)", () => {
  test("a revealed but UNEDITED block: ⌘S leaves the file byte-identical", async () => {
    const before = readVaultBytes(vaultDir, KEYS_DOC);
    expect(new TextDecoder().decode(before)).toBe(keysDoc); // nothing has touched it yet

    expect((await block())!.open).toBe(true); // still revealed from the previous describe
    const mark = sent.length;
    await chord("KeyS");
    await sleep(900);

    const after = readVaultBytes(vaultDir, KEYS_DOC);
    expect(describeByteDiff(before, after)).toBe("identical");
    expect(bytesEqual(before, after)).toBe(true);

    /* the save really went to the server — otherwise "byte-identical" would
       only be saying that nothing happened */
    const puts = sent.slice(mark).filter((r) => r.method === "PUT" && r.url.includes("/api/docs/"));
    expect(puts.length).toBeGreaterThan(0);
    /* …and it carried the ORIGINAL armor, not a re-encrypt */
    for (const p of puts) {
      expect(p.body.includes(CANARY)).toBe(false);
      expect(p.body.includes(JSON.stringify(blockArmor).slice(1, -1))).toBe(true);
    }
  }, 40000);

  test("an unrelated edit while revealed rewrites ONLY the edit — the armor is byte-identical", async () => {
    const before = readVaultText(vaultDir, KEYS_DOC);
    expect((await block())!.open).toBe(true);

    /* ticking a task is a real edit that saves immediately (app convention),
       so this forces a genuine write while a block is revealed-but-unedited */
    await page.click("#doc .cb");
    const after = await waitUntil(
      () => {
        const t = readVaultText(vaultDir, KEYS_DOC);
        return t !== before ? t : null;
      },
      { timeout: 10000, label: "the checkbox edit to reach disk" }
    );

    expect(ageFences(after)).toEqual(ageFences(before)); // the gate
    expect(ageFences(after)[0]).toBe(blockArmor);
    /* and literally nothing else moved */
    expect(after.replace("- [x] rotate the access keys", "- [ ] rotate the access keys")).toBe(before);
    expect(after.includes(CANARY)).toBe(false);

    /* the block is still open and still shows the same plaintext */
    const b = await block();
    expect(b!.open).toBe(true);
    expect(b!.revealed).toBe(PLAINTEXT);
  }, 40000);

  test("Lock returns the block to its masked chip and drops the plaintext", async () => {
    await clickBlockButton(/^\s*lock\b/i);
    await page.waitForFunction(() => !document.querySelector(".secret.open"), { timeout: 10000 });

    const b = await block();
    expect(b!.open).toBe(false);
    expect(b!.revealed).toBe(null);
    /* re-locking restores the LOCKED rendering, which shows no ciphertext
       either (SPEC §6) — the armor went back to the model, not to the screen */
    expect(b!.text).not.toContain(ARMOR_HEAD);
    expect(await armorInModel()).toBe(true);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    expect(html.includes(CANARY)).toBe(false);
    expect(html.includes(ARMOR_HEAD)).toBe(false);

    /* locking is not a save: the file is untouched by it */
    expect(ageFences(readVaultText(vaultDir, KEYS_DOC))[0]).toBe(blockArmor);
  }, 30000);
});

describe("secrets e2e — an EDITED reveal re-encrypts", () => {
  const EDIT = "\nEDITEDBYTHEEETWOEGATE=YES\n";

  test("editing the revealed plaintext and saving writes NEW armor that decrypts to the edit", async () => {
    await unlockBlock(); // the previous test locked it
    const mark = sent.length;

    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".secret.open textarea");
      if (!ta) throw new Error("no reveal editor to type into");
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await page.keyboard.type(EDIT);

    /* let AUTOSAVE do the writing — the mid-reveal autosave is exactly the path
       the leak table calls out (research §6, "Autosave") */
    const armorNow = await waitUntil(
      () => {
        const fences = ageFences(readVaultText(vaultDir, KEYS_DOC));
        return fences.length === 1 && fences[0] !== blockArmor ? fences[0] : null;
      },
      { timeout: 15000, label: "the autosave to write re-encrypted armor" }
    );

    const file = readVaultText(vaultDir, KEYS_DOC);
    expect(file.includes(blockArmor)).toBe(false); // the old armor is GONE
    expect(file.includes(CANARY)).toBe(false); // and no plaintext took its place
    expect(armorNow.startsWith(ARMOR_HEAD)).toBe(true);

    const round = await decryptArmor(armorNow);
    expect(round).toBe(PLAINTEXT + EDIT);

    /* the autosave PUT that carried it never contained plaintext */
    const puts = sent.slice(mark).filter((r) => r.method === "PUT" && r.url.includes("/api/docs/"));
    expect(puts.length).toBeGreaterThan(0);
    for (const p of puts) {
      expect(p.body.includes(CANARY)).toBe(false);
      expect(p.body.includes("EDITEDBYTHEEETWOEGATE")).toBe(false);
      expect(p.body).toContain("BEGIN AGE ENCRYPTED FILE");
    }
  }, 90000);

  test("no request the browser has EVER sent contained plaintext (SPEC §11)", async () => {
    expect(sent.length).toBeGreaterThan(0);
    const needles = [CANARY, "EDITEDBYTHEEETWOEGATE", PASSPHRASE, WRONG_PASSPHRASE, identity, "AGE-SECRET-KEY"];
    for (const r of sent) {
      const where = `${r.method} ${new URL(r.url).pathname}`;
      for (const n of needles) {
        const label = `${where} / ${n.slice(0, 20)}`;
        expect(`${label}: ${(r.body + r.url).includes(n) ? "LEAKED" : "clean"}`).toBe(`${label}: clean`);
      }
    }
  }, 20000);
});

describe("secrets e2e — the session does not survive a reload", () => {
  test("reload ⇒ locked again, and nothing was persisted anywhere", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForApp(page, 25000);
    await openDoc(KEYS_DOC);

    const b = await block();
    expect(b!.open).toBe(false);
    expect(b!.revealed).toBe(null);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    expect(html.includes(CANARY)).toBe(false);
    expect(html.includes("EDITEDBYTHEEETWOEGATE")).toBe(false);

    const s = await storageDump();
    const blob = JSON.stringify(s.local) + JSON.stringify(s.session);
    for (const n of [PASSPHRASE, identity, "AGE-SECRET-KEY", CANARY, ARMOR_HEAD]) {
      expect(`${n.slice(0, 20)} survived the reload: ${blob.includes(n)}`).toBe(
        `${n.slice(0, 20)} survived the reload: false`
      );
    }
    expect(s.dbs).toEqual([]);
  }, 60000);
});

describe("secrets e2e — Encrypt selection works while LOCKED", () => {
  test("⌘⇧E in Raw replaces the selection with a fence that decrypts to it", async () => {
    /* precondition: the vault really is locked — this is the whole point (the
       recipient is public, so writing a secret needs no passphrase) */
    await openDoc(KEYS_DOC);
    expect((await block())!.open).toBe(false);

    await openDoc(SCRATCH_DOC);
    await ensureMode("raw");
    await page.waitForSelector("#rawArea", { timeout: 8000 });

    const selected = await page.evaluate((needle) => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      const at = ta.value.indexOf(needle);
      if (at < 0) throw new Error("selection anchor not found in #rawArea");
      ta.focus();
      ta.setSelectionRange(at, at + needle.length);
      return ta.value.slice(at, at + needle.length);
    }, SELECTION);
    expect(selected).toBe(SELECTION);

    await chord("KeyE", "Meta", "Shift");

    await page.waitForFunction(
      () => ((document.getElementById("rawArea") as HTMLTextAreaElement)?.value ?? "").includes("```age"),
      { timeout: 15000 }
    );

    const buffer = await page.$eval("#rawArea", (t) => (t as HTMLTextAreaElement).value);
    expect(buffer.includes(SELECTION)).toBe(false); // the selection was REPLACED
    const fences = ageFences(buffer);
    expect(fences.length).toBe(1);
    expect(fences[0].startsWith(ARMOR_HEAD)).toBe(true);

    /* the ONLY proof that matters: bun-side, with the vault identity */
    expect((await decryptArmor(fences[0])).trimEnd()).toBe(SELECTION);

    await chord("KeyS");
    const onDisk = await waitUntil(
      () => {
        const t = readVaultText(vaultDir, SCRATCH_DOC);
        return t.includes("```age") ? t : null;
      },
      { timeout: 10000, label: "⌘S to write the new fence" }
    );
    expect(onDisk).toBe(buffer);
    expect(ageFences(onDisk)[0]).toBe(fences[0]);
    /* the vault never unlocked to do any of this */
    expect(await page.evaluate(() => document.getElementById("ppVeil")!.classList.contains("show"))).toBe(false);
  }, 60000);
});

/* ============================================================
   UNLOCKING IS VAULT-WIDE — AND IT IS DISPLAY ONLY (SPEC §6, §11)

   Reveal used to be per block and opt-in. It is now vault-wide: one Unlock, one
   passphrase, and every age block decrypts — in this doc and in every doc
   opened afterwards. That is a RENDERING change and nothing else, which is
   exactly the claim this describe exists to pin down. The document model still
   holds the armor verbatim, so:

     · opening a doc into an already-open vault and saving it without editing
       must leave the file BYTE-IDENTICAL (the §11 gate, now on the auto-reveal
       path rather than the click path), and
     · the AUTOSAVE that fires while every block on screen is revealed must PUT
       armor only — intercepted here as the request body the browser actually
       sent, not inferred from what landed on disk.

   Runs last of the unlocked describes because the two before it need a LOCKED
   vault (reload, then ⌘⇧E while locked).
   ============================================================ */

describe("secrets e2e — unlocking is vault-wide, and it is display only", () => {
  test("one unlock reveals this doc — and the doc opened NEXT, with no click", async () => {
    /* the precondition the two describes above left behind — including the
       PANE MODE: ⌘⇧E is a Raw-only gesture, so the suite arrives here in Raw,
       where there is no rendered block to look at */
    await openDoc(OTHER_DOC);
    await ensureMode("preview");
    expect(`the vault starts locked: ${(await block())!.open}`).toBe("the vault starts locked: false");

    /* the entry point: ONE Unlock button, ONE passphrase */
    const prompted = await unlockBlock();
    expect(`the passphrase was asked for: ${prompted}`).toBe("the passphrase was asked for: true");
    expect((await block())!.revealed).toBe(PLAINTEXT2);

    /* a DIFFERENT doc, opened afterwards, arrives revealed. Its armor is the
       RE-ENCRYPTED one the edited-reveal gate wrote, so what it must decrypt to
       is read back from disk and decrypted bun-side rather than assumed. */
    const expected = await decryptArmor(ageFences(readVaultText(vaultDir, KEYS_DOC))[0]);
    await openDoc(KEYS_DOC);
    await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });

    const k = await block();
    expect(k!.open).toBe(true);
    expect(k!.revealed).toBe(expected);
    /* no second passphrase, and no leftover per-block affordance */
    expect(await page.evaluate(() => document.getElementById("ppVeil")!.classList.contains("show"))).toBe(false);
    expect(k!.buttons.some((x) => /unlock/i.test(x.label))).toBe(false);
    expect(k!.buttons.some((x) => /copy/i.test(x.label))).toBe(true);
  }, 90000);

  test("⌘S on an auto-revealed, UNEDITED doc leaves the file byte-identical", async () => {
    await openDoc(OTHER_DOC);
    await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });
    expect((await block())!.revealed).toBe(PLAINTEXT2);

    const before = readVaultBytes(vaultDir, OTHER_DOC);
    /* nothing has written this file yet — otherwise "identical" would be a
       claim about a file the suite had already rewritten once */
    expect(new TextDecoder().decode(before)).toBe(otherDoc);

    const mark = sent.length;
    await chord("KeyS");
    await sleep(900);

    const after = readVaultBytes(vaultDir, OTHER_DOC);
    expect(describeByteDiff(before, after)).toBe("identical");
    expect(bytesEqual(before, after)).toBe(true);

    /* the save really went to the server — otherwise "byte-identical" would
       only be saying that nothing happened */
    const puts = sent.slice(mark).filter((r) => r.method === "PUT" && r.url.includes("/api/docs/"));
    expect(puts.length).toBeGreaterThan(0);
    for (const p of puts) {
      expect(`the PUT carried the plaintext: ${p.body.includes(CANARY2)}`).toBe("the PUT carried the plaintext: false");
      expect(`the PUT carried the ORIGINAL armor: ${p.body.includes(JSON.stringify(otherArmor).slice(1, -1))}`).toBe(
        "the PUT carried the ORIGINAL armor: true"
      );
    }
  }, 90000);

  test("an AUTOSAVE fired while the blocks are revealed carries armor, never plaintext", async () => {
    await openDoc(OTHER_DOC);
    await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });
    const before = readVaultText(vaultDir, OTHER_DOC);
    const mark = sent.length;

    /* an edit to the DOCUMENT, not to the secret: the reveal stays clean, so
       nothing may be re-encrypted and the stored armor must go back out
       untouched. No ⌘S — `editor.autosaveSeconds` is 1, and the write this
       waits for IS the autosave (research §6, "Autosave"). */
    await ensureMode("raw");
    await page.evaluate(() => {
      const ta = document.getElementById("rawArea") as HTMLTextAreaElement;
      ta.focus();
      ta.value = ta.value.replace("OTHERKEYSTAIL", "OTHERKEYSTAIL AUTOSAVEMARKER");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ensureMode("preview");

    const after = await waitUntil(
      () => {
        const t = readVaultText(vaultDir, OTHER_DOC);
        return t.includes("AUTOSAVEMARKER") ? t : null;
      },
      { timeout: 20000, label: "the autosave to reach disk while a block is revealed" }
    );

    /* the armor is byte-identical across a save that happened while its own
       plaintext was on screen, and the edit is the ONLY thing that moved */
    expect(ageFences(after)).toEqual(ageFences(before));
    expect(ageFences(after)[0]).toBe(otherArmor);
    expect(after).toBe(before.replace("OTHERKEYSTAIL", "OTHERKEYSTAIL AUTOSAVEMARKER"));
    expect(after.includes(CANARY2)).toBe(false);

    /* …and the request that carried it: armor in, plaintext never */
    const puts = sent.slice(mark).filter((r) => r.method === "PUT" && r.url.includes("/api/docs/"));
    expect(puts.length).toBeGreaterThan(0);
    for (const p of puts) {
      expect(`the autosave body carried the plaintext: ${p.body.includes(CANARY2)}`).toBe(
        "the autosave body carried the plaintext: false"
      );
      expect(p.body).toContain("BEGIN AGE ENCRYPTED FILE");
    }

    /* the block is still revealed on the other side of the autosave — the save
       must not have quietly re-locked what it wrote */
    await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 30000 });
    expect((await block())!.revealed).toBe(PLAINTEXT2);
  }, 120000);

  test("no request sent while the vault was open carried a plaintext of any block", () => {
    expect(sent.length).toBeGreaterThan(0);
    const needles = [CANARY, CANARY2, "EDITEDBYTHEEETWOEGATE", PASSPHRASE, identity, "AGE-SECRET-KEY"];
    for (const r of sent) {
      const where = `${r.method} ${new URL(r.url).pathname}`;
      for (const n of needles) {
        const label = `${where} / ${n.slice(0, 20)}`;
        expect(`${label}: ${(r.body + r.url).includes(n) ? "LEAKED" : "clean"}`).toBe(`${label}: clean`);
      }
    }
  }, 20000);
});

describe("secrets e2e — degradation without crypto.subtle (SPEC §6)", () => {
  test("the block explains itself, the affordance is off, and the doc still works", async () => {
    const p = await browser.newPage();
    const errs: string[] = [];
    const consoles: string[] = [];
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error" && !isNoise(m.text())) consoles.push(m.text());
    });

    try {
      await p.setViewport({ width: 1440, height: 900 });
      /* the exact shape of a browser with no WebCrypto SubtleCrypto — an
         insecure origin, which is what LAN/mobile exposure looks like */
      await p.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(window.crypto, "subtle", { configurable: true, get: () => undefined });
        } catch {
          /* ignore */
        }
      });

      await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
      await waitForApp(p, 25000);
      expect(await p.evaluate(() => (window.crypto as any).subtle)).toBe(undefined);

      await p.click(`#tree .row.file[data-doc="${KEYS_DOC}"]`);
      await p.waitForFunction(
        (path) => document.getElementById("stPath")!.textContent === path,
        { timeout: 8000 },
        KEYS_DOC
      );
      await sleep(400);

      const s = await p.evaluate(() => {
        const w = document.querySelector(".secret");
        return {
          present: !!w,
          text: w?.textContent ?? "",
          open: !!w?.classList.contains("open"),
          buttons: [...(w?.querySelectorAll("button") ?? [])].map((b) => ({
            label: (b.textContent ?? "").trim(),
            disabled: (b as HTMLButtonElement).disabled,
          })),
          docText: document.getElementById("doc")!.textContent ?? "",
          h1: document.querySelector("#doc h1")?.textContent ?? null,
        };
      });

      expect(s.present).toBe(true);
      expect(s.open).toBe(false);
      /* the badge has to SAY why — a silently dead button is the failure mode */
      expect(/unavailable|not available|unsupported|disabled|secure context|no crypto/i.test(s.text)).toBe(true);
      /* …and it still shows no ciphertext: "we cannot decrypt here" is not a
         reason to paint the armor into the document (SPEC §6). The source is
         one ⌘E away, exactly as it is for every other locked block. */
      expect(s.text).not.toContain(ARMOR_HEAD);
      expect(s.docText).not.toContain(ARMOR_HEAD);
      /* no live unlock affordance */
      const live = s.buttons.filter((b) => /unlock|create vault/i.test(b.label) && !b.disabled);
      expect(live).toEqual([]);
      /* everything else about the app still works */
      expect(s.h1).toBe("Cloud keys");
      expect(s.docText).toContain("CLOUDKEYSMARKER");
      expect(s.docText).toContain("CLOUDKEYSTAIL");

      expect(errs).toEqual([]);
      expect(consoles).toEqual([]);
    } finally {
      await p.close().catch(() => {});
    }
  }, 60000);

  /* Same strictness as `toEqual([])`, but the message CARRIES the payload. This
     assertion covers the whole file's main session, so when it fires it fires
     long after the line that caused it, and "Expected [] " with nothing to read
     is the difference between a five-minute fix and a bisect. */
  test("the main session logged no page errors and no console errors either", () => {
    expect(`page errors: ${JSON.stringify(pageErrors)}`).toBe("page errors: []");
    expect(`console errors: ${JSON.stringify(consoleErrors)}`).toBe("console errors: []");
  });
});
