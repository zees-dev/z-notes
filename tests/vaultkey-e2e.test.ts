/* ============================================================
   vaultkey-e2e.test.ts — changing the vault passphrase, end to end
   (SPEC §6; docs/secrets-crypto.md §5.3).

   The user's question this answers: "I should be able to update this secret in
   the settings — I believe this should be stored in the backend though." The
   answer the product gives is a CHANGE PASSPHRASE flow in Settings › Secrets
   that re-wraps the same age identity under a new passphrase, and a note beside
   it saying plainly that the passphrase itself is stored NOWHERE — what lives
   in the backend is the passphrase-wrapped identity file.

   So this file proves two different kinds of thing:

     1. THE CRYPTO, out of band. Everything that matters is re-checked in this
        process with `age-encryption` reading the files straight off disk: the
        new passphrase unwraps `.znotes/identity.age`, the old one does not, the
        key inside is bit-for-bit the key that was there before, `vault.pub` is
        untouched, and a block encrypted BEFORE the change still decrypts. The
        app is never asked whether it succeeded.

     2. THE WORDING. The storage explanation is a security claim rendered as
        prose, so its text is asserted here — if someone softens "is not stored
        anywhere" or drops the contrast with the terminal password (which the
        server DOES store, as a scrypt hash), this test says so.

   It gets its own vault and its own server because it mutates the keyring; the
   other secrets suites assume theirs is stable.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import * as age from "age-encryption";
import { dropVault, makeVault, startServer, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

const OLD_PASS = "correct horse battery staple cardinal tundra";
const NEW_PASS = "quartz meadow anchor bison lantern rivulet ocelot";
const SECRET = "AWS_SECRET_ACCESS_KEY=WRITTEN-BEFORE-THE-PASSPHRASE-CHANGE\n";
const KEYS_DOC = "keys/cloud-keys.md";

let srv: TestServer;
let vaultDir = "";
let browser: Browser;
let page: Page;

let identity = "";
let recipient = "";
let identityBefore = "";
let blockArmor = "";

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);

  const e = new age.Encrypter();
  e.setPassphrase(OLD_PASS);
  e.setScryptWorkFactor(18); // exactly what the app writes (SPEC §6)
  const wrapped = age.armor.encode(await e.encrypt(identity));

  const be = new age.Encrypter();
  be.addRecipient(recipient);
  blockArmor = age.armor.encode(await be.encrypt(SECRET)).trimEnd();

  vaultDir = makeVault({
    "inbox.md": "# Inbox\n",
    [KEYS_DOC]: "# cloud keys\n\n```age\n" + blockArmor + "\n```\n",
  });
  mkdirSync(join(vaultDir, ".znotes"), { recursive: true });
  writeFileSync(join(vaultDir, ".znotes", "identity.age"), wrapped + "\n");
  writeFileSync(join(vaultDir, ".znotes", "vault.pub"), recipient + "\n");
  identityBefore = readFileSync(join(vaultDir, ".znotes", "identity.age"), "utf8");

  srv = await startServer({ vault: vaultDir });
  browser = await launchTestBrowser();
  /* Record EVERY server-bound body before a line of app code runs, so the
     passphrase assertions below are made against the real wire traffic of the
     change rather than against a sample taken afterwards. `fetch`, XHR and
     `sendBeacon` are the three ways a body can leave this page; the crypto
     worker is a separate realm and has no network access of its own, which is
     the property that makes recording only the main world sufficient. */
  page = await newAppPage(browser, {
    beforeLoad: () => {
      const w = window as any;
      w.__reqs = [];
      const note = (method: string, url: unknown, body: unknown) => {
        let b = "";
        try {
          b = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
        } catch {
          b = String(body);
        }
        w.__reqs.push({ method, url: String(url), body: b });
      };
      const realFetch = window.fetch.bind(window);
      window.fetch = (input: any, init?: any) => {
        /* api.js passes a URL OBJECT, not a string, and a Request would carry
           its own `.url` — cover all three or the recording is method-only */
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        note(String(init?.method ?? input?.method ?? "GET").toUpperCase(), url, init?.body);
        return realFetch(input, init);
      };
      const openXhr = XMLHttpRequest.prototype.open;
      const sendXhr = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m: string, u: string, ...rest: any[]) {
        (this as any).__m = m;
        (this as any).__u = u;
        return openXhr.call(this, m, u, ...(rest as [boolean]));
      };
      XMLHttpRequest.prototype.send = function (body?: any) {
        note(String((this as any).__m ?? "GET").toUpperCase(), (this as any).__u, body);
        return sendXhr.call(this, body);
      };
      if (navigator.sendBeacon) {
        const realBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = (url: any, data?: any) => {
          note("BEACON", url, data);
          return realBeacon(url, data);
        };
      }
    },
  });
  await page.goto(srv.base + "/settings/secrets", { waitUntil: "domcontentloaded" });
  await waitForApp(page, 25000);
  await page.waitForFunction(() => (document.getElementById("keyStateTxt")!.textContent || "").length > 3, {
    timeout: 20000,
  });
}, 180000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (vaultDir) dropVault(vaultDir);
});

/* ---------- helpers ---------- */

const hint = () => page.$eval("#keyPassHint", (n) => n.textContent!.trim());
const statusLine = () => page.$eval("#keyStateTxt", (n) => n.textContent!.trim());
const identityOnDisk = () => readFileSync(join(vaultDir, ".znotes", "identity.age"), "utf8");
const recipientOnDisk = () => readFileSync(join(vaultDir, ".znotes", "vault.pub"), "utf8").trim();

async function fill(current: string, next: string, confirm: string) {
  for (const [sel, v] of [
    ["#keyCurrent", current],
    ["#keyNew", next],
    ["#keyConfirm", confirm],
  ] as const) {
    await page.$eval(sel, (n) => ((n as HTMLInputElement).value = ""));
    if (v) await page.type(sel, v);
  }
}

/** click Change and wait for the button to come back — scrypt runs twice here */
async function submit() {
  await page.click("#keyChangeBtn");
  await page.waitForFunction(() => !(document.getElementById("keyChangeBtn") as HTMLButtonElement).disabled, {
    timeout: 60000,
  });
}

/** what the three passphrase fields actually HOLD — the live `value` property,
    which is the thing `outerHTML` can never show */
const keyFieldValues = (): Promise<string[]> =>
  page.evaluate(() =>
    ["keyCurrent", "keyNew", "keyConfirm"].map((id) => (document.getElementById(id) as HTMLInputElement).value)
  );

/** everything a script with access to this page could read a passphrase out of:
    both storages, the serialised DOM, and the value of EVERY field on it */
const pageResidue = (): Promise<string> =>
  page.evaluate(() =>
    JSON.stringify({
      s: { ...sessionStorage },
      l: { ...localStorage },
      d: document.documentElement.outerHTML,
      v: [...document.querySelectorAll("input, textarea")].map((n) => (n as HTMLInputElement).value),
    })
  );

/** unwrap whatever is on disk right now, with `pass` — in THIS process */
async function unwrapOnDisk(pass: string): Promise<string> {
  const d = new age.Decrypter();
  d.addPassphrase(pass);
  return (await d.decrypt(age.armor.decode(identityOnDisk()), "text")).trim();
}

/* ============================================================ */

describe("vault key — what Settings › Secrets SAYS about storage (SPEC §6)", () => {
  test("the status line names the two keyring files and the lock state", async () => {
    const txt = await statusLine();
    expect(`names identity.age: ${txt.includes(".znotes/identity.age")}`).toBe("names identity.age: true");
    expect(`names vault.pub: ${txt.includes(".znotes/vault.pub")}`).toBe("names vault.pub: true");
    expect(`names the recipient: ${txt.includes(recipient)}`).toBe("names the recipient: true");
    expect(`says it is locked: ${txt.startsWith("Locked")}`).toBe("says it is locked: true");
  }, 60000);

  test("the storage note makes every claim the security model depends on", async () => {
    const note = await page.$eval("#keyStoreNote", (n) => (n as HTMLElement).innerText);
    const claims: Array<[string, string]> = [
      ["the passphrase is not stored", "Your passphrase is not stored anywhere."],
      ["not in settings.toml", ".znotes/settings.toml"],
      ["not in sqlite", "never to the sqlite index"],
      ["not in sessionStorage", "never to sessionStorage"],
      ["never sent to the server", "never sent to the server"],
      ["what IS stored is the wrapped key", "What the backend keeps is the wrapped key"],
      ["…which is identity.age", ".znotes/identity.age"],
      ["…plus the public recipient", ".znotes/vault.pub"],
      ["both are committed with the vault", "committed with the vault"],
      ["contrast with the terminal password", "Contrast the terminal password"],
      ["which the server stores a HASH of", "scrypt hash"],
      ["this does not rotate the key", "This does not rotate the vault key."],
      ["old git history stays decryptable", "stay decryptable with the old passphrase"],
    ];
    for (const [label, needle] of claims) {
      expect(`${label}: ${note.includes(needle)}`).toBe(`${label}: true`);
    }
  }, 60000);

  test("the field itself says the key does not change", async () => {
    const h = await hint();
    expect(`mentions identity.age: ${h.includes(".znotes/identity.age")}`).toBe("mentions identity.age: true");
    expect(`promises decryptability: ${h.includes("still decrypts")}`).toBe("promises decryptability: true");
  }, 60000);
});

describe("vault key — the refusals write nothing (SPEC §6)", () => {
  test("a wrong current passphrase fails and leaves identity.age byte-identical", async () => {
    await fill("this is not the vault passphrase", NEW_PASS, NEW_PASS);
    await submit();
    expect(`hint: ${await hint()}`).toBe("hint: That passphrase does not unwrap this vault identity.");
    expect(`identity.age untouched: ${identityOnDisk() === identityBefore}`).toBe("identity.age untouched: true");
  }, 120000);

  test("a weak new passphrase hits the same entropy floor first-run enforces", async () => {
    await fill(OLD_PASS, "hunter2", "hunter2");
    await submit();
    const h = await hint();
    expect(`refused for entropy: ${h.startsWith("Too weak")}`).toBe("refused for entropy: true");
    expect(`names the floor: ${h.includes("60 bits minimum")}`).toBe("names the floor: true");
    expect(`identity.age untouched: ${identityOnDisk() === identityBefore}`).toBe("identity.age untouched: true");
  }, 120000);

  test("a mismatched confirmation is refused", async () => {
    await fill(OLD_PASS, NEW_PASS, NEW_PASS + "x");
    await submit();
    expect(`hint: ${await hint()}`).toBe("hint: The two new passphrases do not match.");
    expect(`identity.age untouched: ${identityOnDisk() === identityBefore}`).toBe("identity.age untouched: true");
  }, 120000);

  test("re-using the current passphrase is refused", async () => {
    await fill(OLD_PASS, OLD_PASS, OLD_PASS);
    await submit();
    expect(`hint: ${await hint()}`).toBe("hint: That is the passphrase you already have.");
    expect(`identity.age untouched: ${identityOnDisk() === identityBefore}`).toBe("identity.age untouched: true");
  }, 120000);

  test("Generate SHOWS what it tells you to write down, and re-masks the moment you type", async () => {
    const masking = (id: string) =>
      page.evaluate((x) => getComputedStyle(document.getElementById(x)!).webkitTextSecurity ?? "", id);
    await fill("", "", "");
    expect(`#keyNew starts masked: ${(await masking("keyNew")) === "disc"}`).toBe("#keyNew starts masked: true");

    await page.click("#keyGen");
    await page.waitForFunction(() => (document.getElementById("keyNew") as HTMLInputElement).value.length > 0, {
      timeout: 8000,
    });
    /* the whole finding: this said "Write it down NOW — nothing here can show
       it to you again" over a field rendering discs, with no reveal control
       anywhere in the panel and no recovery path for the vault (SPEC §6) */
    expect(`#keyNew is legible: ${(await masking("keyNew")) !== "disc"}`).toBe("#keyNew is legible: true");
    expect(await hint()).toMatch(/shown above/i);

    await page.focus("#keyNew");
    await page.keyboard.type("x");
    expect(`masked again once typed into: ${(await masking("keyNew")) === "disc"}`).toBe(
      "masked again once typed into: true"
    );
    await fill("", "", "");
  }, 120000);

  test("a finished attempt takes the passphrases OUT of the DOM, refusal or not", async () => {
    /* An input's live `value` is never serialised into `outerHTML`, so the
       residue sweep below reads the property — the old assertion could not see
       this at all. The settings page is a CSS route change and is never
       unmounted, so anything left here lives for the rest of the session. */
    await fill("WRONGPASSPHRASE-RESIDUE-PROBE", NEW_PASS, NEW_PASS);
    await submit();
    expect(`hint: ${await hint()}`).toBe("hint: That passphrase does not unwrap this vault identity.");
    expect(await keyFieldValues()).toEqual(["", "", ""]);

    /* a refusal the user is meant to CORRECT keeps what they typed — and then
       leaving the page has to take it with them, the way closing the modal does */
    await fill(OLD_PASS, NEW_PASS, NEW_PASS + "-MISMATCH-RESIDUE-PROBE");
    await submit();
    expect(`hint: ${await hint()}`).toBe("hint: The two new passphrases do not match.");
    expect(`still there to correct: ${(await keyFieldValues())[0].length > 0}`).toBe("still there to correct: true");

    await page.click("#settingsView [data-act='close-settings']");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 8000,
    });
    expect(await keyFieldValues()).toEqual(["", "", ""]);

    /* and nothing of either probe survived anywhere in the page */
    const blob = await pageResidue();
    for (const probe of ["WRONGPASSPHRASE-RESIDUE-PROBE", "MISMATCH-RESIDUE-PROBE"]) {
      expect(`${probe} still readable: ${blob.includes(probe)}`).toBe(`${probe} still readable: false`);
    }

    /* back to Settings › Secrets for everything after this */
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 8000,
    });
    expect(`back on the secrets section: ${await page.evaluate(() => location.pathname)}`).toBe(
      "back on the secrets section: /settings/secrets"
    );
  }, 120000);

  test("leaving Settings takes the TERMINAL secrets with it too, not just the passphrases", async () => {
    /* `clearKeyFields` covered the three passphrase inputs and nothing else, so
       an abandoned terminal password stayed in the DOM for the lifetime of the
       tab — and was silently resubmitted if the user came back and pressed
       Change. app.js files the terminal password under the same reasoning as
       the credential fields ("an unsaved secret held longer than it needs to
       be"); this is that reasoning actually applied. */
    const termFieldValues = (): Promise<string[]> =>
      page.evaluate(() =>
        ["termNew", "termCurrent", "termPass"].map((id) => (document.getElementById(id) as HTMLInputElement).value)
      );

    /* #termNew is the visible one, so it is really typed into; the other two
       are hidden until the terminal is configured / locked, and what matters
       about them is the value they HOLD */
    await page.click("#settingsNav button[data-sec='terminal']");
    await page.waitForFunction(() => location.pathname === "/settings/terminal", { timeout: 8000 });
    await page.click("#termNew");
    await page.keyboard.type("TERMINAL-PASSWORD-RESIDUE-PROBE");
    await page.evaluate(() => {
      (document.getElementById("termCurrent") as HTMLInputElement).value = "TERMINAL-CURRENT-RESIDUE-PROBE";
      (document.getElementById("termPass") as HTMLInputElement).value = "TERMINAL-UNLOCK-RESIDUE-PROBE";
    });
    expect(`typed and held: ${JSON.stringify((await termFieldValues()).map((v) => v.length > 0))}`).toBe(
      "typed and held: [true,true,true]"
    );

    await page.click("#settingsView [data-act='close-settings']");
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 8000,
    });
    expect(`after leaving: ${JSON.stringify(await termFieldValues())}`).toEqual('after leaving: ["","",""]');

    /* and nowhere else on the page either — same sweep the passphrases get */
    const blob = await pageResidue();
    for (const probe of ["TERMINAL-PASSWORD-RESIDUE-PROBE", "TERMINAL-CURRENT-RESIDUE-PROBE", "TERMINAL-UNLOCK-RESIDUE-PROBE"]) {
      expect(`${probe} still readable: ${blob.includes(probe)}`).toBe(`${probe} still readable: false`);
    }

    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 8000,
    });
    await page.click("#settingsNav button[data-sec='secrets']");
    await page.waitForFunction(() => location.pathname === "/settings/secrets", { timeout: 8000 });
  }, 120000);
});

describe("vault key — the change itself, proved out of band", () => {
  test("the passphrase changes, the KEY does not, and everything already encrypted still opens", async () => {
    const recipientBefore = recipientOnDisk();

    await fill(OLD_PASS, NEW_PASS, NEW_PASS);
    await submit();
    await page.waitForFunction(
      () => (document.getElementById("keyCurrent") as HTMLInputElement).value === "",
      { timeout: 60000 }
    );

    /* ---- what the UI reports ---- */
    const toast = await page.$eval("#toastTxt", (n) => n.textContent!.trim());
    expect(`toast: ${toast}`).toBe("toast: Vault passphrase changed · the key is unchanged, so every block still decrypts");
    const cleared = await page.evaluate(() =>
      ["keyCurrent", "keyNew", "keyConfirm"].every((i) => (document.getElementById(i) as HTMLInputElement).value === "")
    );
    expect(`all three fields cleared: ${cleared}`).toBe("all three fields cleared: true");

    /* ---- out of band, with age-encryption, off the disk ---- */
    expect(`identity.age was rewritten: ${identityOnDisk() !== identityBefore}`).toBe(
      "identity.age was rewritten: true"
    );
    expect(`vault.pub is UNCHANGED: ${recipientOnDisk() === recipientBefore}`).toBe("vault.pub is UNCHANGED: true");

    const key = await unwrapOnDisk(NEW_PASS);
    expect(`the NEW passphrase unwraps it: ${key.startsWith("AGE-SECRET-KEY-1")}`).toBe(
      "the NEW passphrase unwraps it: true"
    );
    expect(`and it is the SAME key: ${key === identity}`).toBe("and it is the SAME key: true");
    expect(`whose recipient still matches: ${(await age.identityToRecipient(key)) === recipient}`).toBe(
      "whose recipient still matches: true"
    );

    let oldStillWorks = true;
    try {
      await unwrapOnDisk(OLD_PASS);
    } catch {
      oldStillWorks = false;
    }
    expect(`the OLD passphrase still unwraps it: ${oldStillWorks}`).toBe("the OLD passphrase still unwraps it: false");

    /* the invariant the UI promises: no corpus pass was needed */
    const doc = readFileSync(join(vaultDir, KEYS_DOC), "utf8");
    const onDisk = doc.split("```age\n")[1].split("\n```")[0];
    expect(`the block's armor is byte-identical: ${onDisk.trim() === blockArmor.trim()}`).toBe(
      "the block's armor is byte-identical: true"
    );
    const d = new age.Decrypter();
    d.addIdentity(key);
    expect(`and it still decrypts: ${(await d.decrypt(age.armor.decode(onDisk), "text")) === SECRET}`).toBe(
      "and it still decrypts: true"
    );

    /* the UI's own promise about git history, checked: the PREVIOUS bytes of
       identity.age — which is what a `git show HEAD~1` hands you — still open
       with the OLD passphrase, and yield the same key */
    const old = new age.Decrypter();
    old.addPassphrase(OLD_PASS);
    const fromHistory = (await old.decrypt(age.armor.decode(identityBefore), "text")).trim();
    expect(`a git-history copy + the OLD passphrase still yields the key: ${fromHistory === identity}`).toBe(
      "a git-history copy + the OLD passphrase still yields the key: true"
    );
  }, 180000);

  test("neither passphrase reached sqlite, settings.toml, or any browser storage", async () => {
    const hay =
      readFileSync(join(vaultDir, ".znotes", "settings.toml"), "utf8") +
      readFileSync(join(vaultDir, ".znotes", "index.db")).toString("latin1");
    expect(`OLD passphrase on the server side: ${hay.includes(OLD_PASS)}`).toBe("OLD passphrase on the server side: false");
    expect(`NEW passphrase on the server side: ${hay.includes(NEW_PASS)}`).toBe("NEW passphrase on the server side: false");
    /* the identity's PLAINTEXT key must never have been written anywhere the
       server can see it either — only the wrapped armor is ever PUT */
    expect(`the raw key on the server side: ${hay.includes(identity)}`).toBe("the raw key on the server side: false");

    const blob = await pageResidue();
    for (const [label, n] of [
      ["OLD passphrase", OLD_PASS],
      ["NEW passphrase", NEW_PASS],
      ["the raw key", identity],
      ["any age secret key", "AGE-SECRET-KEY"],
    ] as Array<[string, string]>) {
      expect(`${label} in the browser: ${blob.includes(n)}`).toBe(`${label} in the browser: false`);
    }
  }, 60000);

  test("neither passphrase was ever in a request body — or in the server's log", async () => {
    /* SPEC §11: "plaintext never in any server-bound request". The passphrase
       is typed into a field, handed to the crypto worker, spent on scrypt and
       dropped; what the network is allowed to carry is the WRAPPED armor and
       nothing else. Asserted over every request this page made from before its
       first line of script ran, which includes the PUT that stored the re-wrap. */
    const reqs: Array<{ method: string; url: string; body: string }> = await page.evaluate(
      () => (window as any).__reqs.slice()
    );

    /* the recorder has to have been working, or "nothing leaked" is vacuous */
    expect(`requests recorded: ${reqs.length > 0}`).toBe("requests recorded: true");
    const wrote = reqs.filter((r) => r.method === "PUT" && r.url.includes("/api/vault/identity"));
    expect(`the identity was PUT ${wrote.length} time(s)`).toBe("the identity was PUT 1 time(s)");
    /* …and that PUT really carried the new wrapped key, so the body under
       examination is the one that matters */
    expect(`the PUT carried age armor: ${wrote[0].body.includes("BEGIN AGE ENCRYPTED FILE")}`).toBe(
      "the PUT carried age armor: true"
    );

    const wire = reqs.map((r) => `${r.method} ${r.url}\n${r.body}`).join("\n");
    for (const [label, needle] of [
      ["the OLD passphrase", OLD_PASS],
      ["the NEW passphrase", NEW_PASS],
      ["the unwrapped key", identity],
      ["any age secret key", "AGE-SECRET-KEY"],
      ["the block plaintext", SECRET.trim()],
    ] as Array<[string, string]>) {
      expect(`${label} on the wire: ${wire.includes(needle)}`).toBe(`${label} on the wire: false`);
    }
    /* not even as a URL parameter — the shape the ⌘K box once turned a
       passphrase into (tests/secrets-ui.test.ts) */
    const urls = reqs.map((r) => decodeURIComponent(r.url)).join("\n");
    expect(`a passphrase in a URL: ${urls.includes(OLD_PASS) || urls.includes(NEW_PASS)}`).toBe(
      "a passphrase in a URL: false"
    );

    /* and nothing echoed it into the server's own output, where it would end up
       in a terminal scrollback, a container log and any log shipper */
    const log = [...srv.stdoutLines, ...srv.stderrLines].join("\n");
    expect(`log lines captured: ${srv.stdoutLines.length + srv.stderrLines.length > 0}`).toBe(
      "log lines captured: true"
    );
    for (const [label, needle] of [
      ["the OLD passphrase", OLD_PASS],
      ["the NEW passphrase", NEW_PASS],
      ["the unwrapped key", identity],
    ] as Array<[string, string]>) {
      expect(`${label} in the server log: ${log.includes(needle)}`).toBe(`${label} in the server log: false`);
    }
  }, 60000);

  test("Settings › Secrets fits its panel: the label survives and nothing scrolls sideways", async () => {
    /* The passphrase field arrived as three inputs plus two buttons in a `.ctl`
       that is `flex: 0 0 auto`. It could not shrink, so it took its width out
       of the LABEL — 9px wide, 320px tall, one word per line — and then out of
       the page, giving Settings a ~1300px horizontal scroll. Every test in this
       file passed throughout, because they all read text and the text was there.
       Asserted here, on the vault that actually has a keyring to describe. */
    await page.goto(srv.base + "/settings/secrets", { waitUntil: "domcontentloaded" });
    await waitForApp(page, 25000);
    await page.waitForFunction(() => (document.getElementById("keyStateTxt")!.textContent || "").length > 3, {
      timeout: 20000,
    });

    for (const [w, h, where] of [
      [1440, 900, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await page.setViewport({ width: w, height: h });
      await new Promise((r) => setTimeout(r, 350));
      const m = await page.evaluate(() => {
        const r = (e: Element | null) => {
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) };
        };
        const field = document.getElementById("keyCurrent")!.closest(".field")!;
        const body = document.getElementById("settingsBody")!;
        const tx = document.getElementById("keyStateTxt")!;
        const row = tx.closest(".key-state")!;
        return {
          lab: r(field.querySelector(".lab"))!,
          ctl: r(field.querySelector(".ctl"))!,
          field: r(field)!,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          stateText: (tx.textContent ?? "").trim(),
          stateClipped: tx.scrollWidth - tx.clientWidth,
          stateFits: tx.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
        };
      });

      /* the label is a line of text, not a column of single words */
      expect(`${where}: the label is wider than it is tall: ${m.lab.w > m.lab.h}`).toBe(
        `${where}: the label is wider than it is tall: true`
      );
      expect(`${where}: the control starts at the row's left edge: ${m.ctl.l === m.field.l}`).toBe(
        `${where}: the control starts at the row's left edge: true`
      );
      expect(`${where}: settings body scrolls sideways by ${m.bodyOverflow}px`).toBe(
        `${where}: settings body scrolls sideways by 0px`
      );
      expect(`${where}: the page scrolls sideways by ${m.pageOverflow}px`).toBe(
        `${where}: the page scrolls sideways by 0px`
      );

      /* the status line ends in a 62-character `age1…` recipient — one
         unbreakable token, and the part you came to this panel to read */
      expect(`${where}: the status line names the recipient: ${m.stateText.includes(recipient)}`).toBe(
        `${where}: the status line names the recipient: true`
      );
      expect(`${where}: characters clipped off the status line: ${m.stateClipped}`).toBe(
        `${where}: characters clipped off the status line: 0`
      );
      expect(`${where}: the status line stays inside its row: ${m.stateFits}`).toBe(
        `${where}: the status line stays inside its row: true`
      );
    }
    await page.setViewport({ width: 1440, height: 900 });
  }, 90000);

  test("the new passphrase is the one that unlocks the app now", async () => {
    /* the round trip that matters to a human: reload, open the doc, and the
       block opens with the passphrase they just set — and not with the old one */
    await page.goto(srv.base + "/d/" + KEYS_DOC.split("/").map(encodeURIComponent).join("/"), {
      waitUntil: "domcontentloaded",
    });
    await waitForApp(page, 25000);
    await page.waitForSelector("#doc .secret", { timeout: 15000 });
    await page.click("#doc .secret .secret-bar button.primary");
    await page.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 8000 });

    await page.type("#ppInput", OLD_PASS);
    await page.click("#ppOk");
    await page.waitForFunction(
      () => (document.getElementById("ppHint")!.textContent || "").includes("does not unwrap"),
      { timeout: 60000 }
    );
    expect(`the OLD passphrase is rejected by the app: true`).toBe("the OLD passphrase is rejected by the app: true");

    await page.$eval("#ppInput", (n) => ((n as HTMLInputElement).value = ""));
    await page.type("#ppInput", NEW_PASS);
    await page.click("#ppOk");
    await page.waitForFunction(() => !document.getElementById("ppVeil")!.classList.contains("show"), {
      timeout: 60000,
    });
    /* the plaintext lives in a textarea, so it is the VALUE that has to be
       read — `innerText` would be empty and the assertion would be a lie */
    await page.waitForSelector("#doc .secret.open textarea.secret-edit", { timeout: 15000 });
    const revealed = await page.$eval("#doc .secret.open textarea.secret-edit", (n) => (n as HTMLTextAreaElement).value);
    expect(`the block revealed with the new passphrase: ${revealed === SECRET}`).toBe(
      "the block revealed with the new passphrase: true"
    );
  }, 180000);
});
