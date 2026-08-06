/**
 * SETTINGS — the two surfaces, and the promise that they are the same surface.
 *
 * z-notes has two ways to set the same thing: `.znotes/settings.toml`, which is
 * the startup surface you hand-write before first boot and commit with the
 * vault, and Settings (⌘,) → `PUT /api/settings`, which is the runtime one.
 * "Parity" is the claim that neither surface can set something the other
 * cannot, and that a value set in either is really *in use* rather than merely
 * stored. Nothing here was covered by an automated test before: the work was
 * verified by hand, which does not survive the next change.
 *
 * The three things these pin:
 *
 *   1. PARITY IS STRUCTURAL, not a list someone remembers to update. Every
 *      settable key is derived from `DEFAULTS`/`NUMBERS` and checked against
 *      the real markup, so adding a setting to the backend without a control
 *      (or a control without a backend key) fails here rather than shipping.
 *   2. A BAD FILE NEVER STOPS THE APP. Values out of range, of the wrong type
 *      or off-step are healed to something usable and the server still boots —
 *      and the healed value is what the file, the API and the running code all
 *      agree on afterwards.
 *   3. WRITING A SETTING CHANGES BEHAVIOUR. Round-tripping through TOML is
 *      necessary but not sufficient; a setting that is stored and ignored is a
 *      lie. Where the effect is observable server-side it is measured on the
 *      wire (the upstream request body, the pushed status event).
 *
 * Automated tests talk to `tests/mock-upstream.ts` — never a real endpoint,
 * never a real key.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  makeVault,
  dropVault,
  readVaultText,
  sleep,
  waitUntil,
  type TestServer,
} from "./helpers";
import { startMockUpstream, reply, type MockUpstream } from "./mock-upstream";
import { DEFAULTS, NUMBERS, BOOLEANS, META } from "../server/settings";

const KEY = "sk-mock-settings-0000000000006789";
const SETTINGS_REL = ".znotes/settings.toml";

const servers: TestServer[] = [];
const mocks: MockUpstream[] = [];
const vaults: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const m of mocks) await m.stop().catch(() => {});
  for (const v of vaults) dropVault(v);
});

async function newServer(opts: Parameters<typeof startServer>[0] = {}): Promise<TestServer> {
  const s = await startServer(opts);
  servers.push(s);
  return s;
}

async function newMock(): Promise<MockUpstream> {
  const m = await startMockUpstream();
  mocks.push(m);
  return m;
}

/** a vault whose settings.toml is written BEFORE the server ever starts */
function vaultWithToml(toml: string, seed: Record<string, string> = { "inbox.md": "# Inbox\n\n" }): string {
  const vault = makeVault(seed);
  vaults.push(vault);
  mkdirSync(join(vault, ".znotes"), { recursive: true });
  writeFileSync(join(vault, ".znotes", "settings.toml"), toml, { encoding: "utf8", flag: "w" });
  return vault;
}

/** `group.key` → value, out of the settings object GET returns */
const at = (settings: any, path: string) => {
  const [g, k] = path.split(".");
  return k === undefined ? settings[g] : settings?.[g]?.[k];
};

/** every dotted path a user can set, derived — never hand-listed */
function settablePaths(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const kk of Object.keys(v)) out.push(`${k}.${kk}`);
    } else out.push(k);
  }
  return out;
}

const html = () => readFileSync(join(import.meta.dir, "..", "app", "index.html"), "utf8");

/* ============================================================
   1. PARITY — derived from the code, not from a list
   ============================================================ */

describe("settings parity — every key is settable in BOTH surfaces", () => {
  test("every key in DEFAULTS has a control in the Settings panel", async () => {
    const markup = html();
    /* How a key is rendered depends on its type, so the evidence differs:
       numbers carry `data-num="<path>"`, booleans `data-sw="<path>"`, free-text
       fields `data-draft="<path>"`, and enums are segmented controls built from
       `meta`. Whatever the shape, the panel must be able to reach the key.

       Only the four enums still need a hand-maintained map here. The other
       three are STRUCTURAL — they ask the markup for the path itself, so a new
       control cannot be added to app.js and forgotten in this list (which is
       what the free-text map, kept by hand, used to allow). */
    const SEG: Record<string, string> = {
      theme: "themeSeg",
      density: "densitySeg",
      colorScheme: "schemeSeg",
      "ai.effort": "effortSeg",
    };

    const missing: string[] = [];
    for (const path of settablePaths()) {
      const hasControl =
        (NUMBERS[path] && markup.includes(`data-num="${path}"`)) ||
        (BOOLEANS.includes(path) && markup.includes(`data-sw="${path}"`)) ||
        (SEG[path] && markup.includes(`id="${SEG[path]}"`)) ||
        markup.includes(`data-draft="${path}"`);
      if (!hasControl) missing.push(path);
    }
    expect(`keys with no Settings control: ${JSON.stringify(missing)}`).toBe(
      "keys with no Settings control: []"
    );
  });

  /* The shell paints before /api/settings answers, so index.html carries a
     hard-coded first guess at the theme — the <html data-theme> attribute and
     the <link id="theme-css"> href. If either drifts from DEFAULTS.theme, every
     fresh boot flashes the wrong stylesheet for a network round-trip and then
     snaps. Cheap to get wrong (change one, forget the other two), invisible in
     any behavioural test, so it is asserted structurally. */
  test("index.html's pre-settings guess at the theme IS the shipped default", async () => {
    const markup = html();
    expect(`<html data-theme: ${/<html[^>]*\sdata-theme="([^"]+)"/.exec(markup)?.[1]}`).toBe(
      `<html data-theme: ${DEFAULTS.theme}`
    );
    expect(`theme-css href: ${/id="theme-css"[^>]*href="([^"]+)"/.exec(markup)?.[1]}`).toBe(
      `theme-css href: ./themes/${DEFAULTS.theme}.css`
    );
  });

  test("every control in the Settings panel names a key the backend really has", async () => {
    const markup = html();
    const known = new Set(settablePaths());

    const nums = [...markup.matchAll(/data-num="([^"]+)"/g)].map((m) => m[1]);
    const orphanNums = nums.filter((p) => !known.has(p) || !NUMBERS[p]);
    expect(`data-num controls with no NUMBERS spec: ${JSON.stringify(orphanNums)}`).toBe(
      "data-num controls with no NUMBERS spec: []"
    );

    const sws = [...markup.matchAll(/data-sw="([^"]+)"/g)].map((m) => m[1]);
    const orphanSws = sws.filter((p) => !known.has(p) || !BOOLEANS.includes(p));
    expect(`data-sw controls with no BOOLEANS entry: ${JSON.stringify(orphanSws)}`).toBe(
      "data-sw controls with no BOOLEANS entry: []"
    );

    /* the free-text half of the same rule: `paintDraftFields` and the one
       binding loop in wire() both read this attribute, so a typo'd path here is
       a control that silently drafts a key the backend has never heard of */
    const drafts = [...markup.matchAll(/data-draft="([^"]+)"/g)].map((m) => m[1]);
    const orphanDrafts = drafts.filter((p) => !known.has(p) || !!NUMBERS[p] || BOOLEANS.includes(p));
    expect(`data-draft controls with no settable free-text key: ${JSON.stringify(orphanDrafts)}`).toBe(
      "data-draft controls with no settable free-text key: []"
    );

    expect(`controls found: ${nums.length} numeric, ${sws.length} boolean, ${drafts.length} free-text`).toBe(
      `controls found: ${Object.keys(NUMBERS).length} numeric, ${BOOLEANS.length} boolean, 6 free-text`
    );
  });

  test("every key in DEFAULTS survives a write to settings.toml and comes back from it", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    /* force a write of the whole file, then reboot on the SAME vault and read
       every key back — a key the serializer forgets is a key that silently
       reverts to its default on the next restart */
    const put = await s.api("PUT", "/api/settings", { theme: "minimal" });
    expect(put.status).toBe(200);

    const file = readVaultText(s.vault, SETTINGS_REL);
    const absent = settablePaths().filter((p) => {
      const key = p.includes(".") ? p.split(".")[1] : p;
      return !new RegExp(`^\\s*${key}\\s*=`, "m").test(file);
    });
    expect(`keys missing from the written settings.toml: ${JSON.stringify(absent)}`).toBe(
      "keys missing from the written settings.toml: []"
    );
  }, 60000);

  test("meta.numbers publishes bounds for every numeric key, so the client hard-codes none", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    const meta = (await s.get("/api/settings")).body.meta;
    const paths = Object.keys(NUMBERS).sort();
    expect(`meta.numbers paths: ${Object.keys(meta.numbers).sort().join(",")}`).toBe(
      `meta.numbers paths: ${paths.join(",")}`
    );
    for (const p of paths) {
      const spec = meta.numbers[p];
      expect(`${p} spec keys: ${Object.keys(spec).sort().filter((k) => k !== "code").join(",")}`).toBe(
        `${p} spec keys: max,min,step,unit`
      );
      expect(`${p} min<max: ${spec.min < spec.max}`).toBe(`${p} min<max: true`);
      expect(`${p} unit is stated: ${!!spec.unit}`).toBe(`${p} unit is stated: true`);
      /* the shipped default must itself be legal, or the very first render
         shows a value the server would rewrite */
      const def = at(DEFAULTS, p);
      expect(`${p} default ${def} within [${spec.min},${spec.max}]`).toBe(
        `${p} default ${def} within [${spec.min},${spec.max}]`
      );
      expect(`${p} default in range: ${def >= spec.min && def <= spec.max}`).toBe(`${p} default in range: true`);
    }
  }, 60000);
});

/* ============================================================
   2. TOML ROUND-TRIP
   ============================================================ */

describe("settings.toml — the startup surface round-trips", () => {
  test("a hand-written file with every key non-default is served back verbatim", async () => {
    /* deliberately every settable key, all different from DEFAULTS, so a key
       the loader drops shows up as its default rather than as what was asked */
    const toml = [
      `theme = "terminal"`,
      `density = "compact"`,
      `colorScheme = "dark"`,
      ``,
      `[editor]`,
      `autosaveSeconds = 3`,
      `clickToEdit = false`,
      `homeDoc = "architecture/event-pipeline.md"`,
      ``,
      `[trash]`,
      `retentionDays = 21`,
      ``,
      `[git]`,
      `branch = "trunk"`,
      `autoSync = false`,
      `autoSyncSeconds = 300`,
      ``,
      `[secrets]`,
      `idleLockMinutes = 2`,
      `hiddenLockMinutes = 1`,
      `sessionHours = 3`,
      `clipboardClearSeconds = 45`,
      ``,
      `[ai]`,
      `baseUrl = "http://127.0.0.1:9/v1"`,
      `model = "some-other-model"`,
      `effort = "low"`,
      `maxOutputTokens = 5000`,
      `contextBudgetTokens = 11000`,
      ``,
      `[terminal]`,
      `enabled = false`,
      `idleLockMinutes = 25`,
      `shell = "/bin/bash"`,
      `startupCwd = "/usr/local"`,
      `allowAiAutoRun = true`,
      ``,
    ].join("\n");

    const s = await newServer({ vault: vaultWithToml(toml) });
    const got = (await s.get("/api/settings")).body.settings;

    const expected: Record<string, unknown> = {
      theme: "terminal",
      density: "compact",
      colorScheme: "dark",
      "editor.autosaveSeconds": 3,
      "editor.clickToEdit": false,
      "editor.homeDoc": "architecture/event-pipeline.md",
      "trash.retentionDays": 21,
      "git.branch": "trunk",
      "git.autoSync": false,
      "git.autoSyncSeconds": 300,
      "secrets.idleLockMinutes": 2,
      "secrets.hiddenLockMinutes": 1,
      "secrets.sessionHours": 3,
      "secrets.clipboardClearSeconds": 45,
      "ai.baseUrl": "http://127.0.0.1:9/v1",
      "ai.model": "some-other-model",
      "ai.effort": "low",
      "ai.maxOutputTokens": 5000,
      "ai.contextBudgetTokens": 11000,
      "terminal.enabled": false,
      "terminal.idleLockMinutes": 25,
      "terminal.shell": "/bin/bash",
      "terminal.startupCwd": "/usr/local",
      "terminal.allowAiAutoRun": true,
    };
    /* the sweep covers every settable key: if one is added to DEFAULTS and not
       to this table, the count assertion fails and this test must be extended */
    expect(`keys asserted: ${Object.keys(expected).length}`).toBe(`keys asserted: ${settablePaths().length}`);

    for (const [path, want] of Object.entries(expected)) {
      expect(`${path} = ${JSON.stringify(at(got, path))}`).toBe(`${path} = ${JSON.stringify(want)}`);
    }
  }, 60000);

  test("a PUT lands in the file and survives a restart of the same vault", async () => {
    const vault = vaultWithToml(`theme = "modern"\n`);
    const first = await newServer({ vault });
    const put = await first.api("PUT", "/api/settings", {
      theme: "minimal",
      density: "compact",
      editor: { autosaveSeconds: 7 },
      trash: { retentionDays: 14 },
      secrets: { idleLockMinutes: 33 },
      ai: { maxOutputTokens: 9000 },
    });
    expect(put.status).toBe(200);

    const file = readVaultText(vault, SETTINGS_REL);
    for (const line of [`theme = "minimal"`, `density = "compact"`, `autosaveSeconds = 7`, `retentionDays = 14`, `idleLockMinutes = 33`, `maxOutputTokens = 9000`]) {
      expect(`settings.toml contains \`${line}\`: ${file.includes(line)}`).toBe(
        `settings.toml contains \`${line}\`: true`
      );
    }
    await first.stop();

    /* a fresh process reading only the file — nothing carried in memory */
    const second = await newServer({ vault });
    const back = (await second.get("/api/settings")).body.settings;
    expect(`theme after restart: ${back.theme}`).toBe("theme after restart: minimal");
    expect(`density after restart: ${back.density}`).toBe("density after restart: compact");
    expect(`autosaveSeconds after restart: ${back.editor.autosaveSeconds}`).toBe("autosaveSeconds after restart: 7");
    expect(`retentionDays after restart: ${back.trash.retentionDays}`).toBe("retentionDays after restart: 14");
    expect(`idleLockMinutes after restart: ${back.secrets.idleLockMinutes}`).toBe("idleLockMinutes after restart: 33");
    expect(`maxOutputTokens after restart: ${back.ai.maxOutputTokens}`).toBe("maxOutputTokens after restart: 9000");
  }, 90000);

  test("the regenerated file is itself a legal startup file — reboot on it changes nothing", async () => {
    const vault = vaultWithToml(`theme = "modern"\n`);
    const first = await newServer({ vault });
    await first.api("PUT", "/api/settings", { theme: "terminal", git: { autoSyncSeconds: 90 } });
    const before = (await first.get("/api/settings")).body.settings;
    const written = readVaultText(vault, SETTINGS_REL);
    await first.stop();

    const second = await newServer({ vault });
    const after = (await second.get("/api/settings")).body.settings;
    expect(`settings survived a reboot unchanged: ${JSON.stringify(after) === JSON.stringify(before)}`).toBe(
      "settings survived a reboot unchanged: true"
    );
    /* …and the file the second boot wrote is byte-identical to the one it read,
       so booting repeatedly cannot drift the committed file */
    await second.api("PUT", "/api/settings", { theme: "terminal" });
    expect(`file is stable across a reboot+write: ${readVaultText(vault, SETTINGS_REL) === written}`).toBe(
      "file is stable across a reboot+write: true"
    );
  }, 90000);

  test("its own comments never impersonate a table header", async () => {
    /* Found the hard way: a preamble containing the literal `[git]` made
       anything scanning the file for a section (these tests do; so does a
       user's sed) land inside prose and produce invalid TOML. Every bracketed
       header in the file must be a real one, at the start of its line. */
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    await s.api("PUT", "/api/settings", { theme: "modern" });
    const file = readVaultText(s.vault, SETTINGS_REL);

    const offenders = file
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#") && /\[[a-zA-Z][\w.-]*\]/.test(l));
    expect(`comment lines containing a [table] header: ${JSON.stringify(offenders)}`).toBe(
      "comment lines containing a [table] header: []"
    );

    for (const section of Object.keys(DEFAULTS).filter((k) => typeof (DEFAULTS as any)[k] === "object")) {
      const hits = file.split("\n").filter((l) => l === `[${section}]`);
      expect(`[${section}] appears exactly once as a real header: ${hits.length}`).toBe(
        `[${section}] appears exactly once as a real header: 1`
      );
    }
  }, 60000);
});

/* ============================================================
   3. A BAD FILE HEALS — it never stops the boot
   ============================================================ */

describe("settings.toml — unusable values heal instead of refusing to start", () => {
  test("a file of garbage boots, heals every key, and says so on stderr", async () => {
    const toml = [
      `theme = "bogus"`,
      `density = 17`,
      `colorScheme = "puce"`,
      ``,
      `[editor]`,
      `autosaveSeconds = -5`,
      ``,
      `[git]`,
      `branch = "-nope"`,
      `autoSync = "sometimes"`,
      `autoSyncSeconds = 0`,
      ``,
      `[secrets]`,
      `idleLockMinutes = 9999`,
      `clipboardClearSeconds = 33`,
      ``,
      `[ai]`,
      `baseUrl = "file:///etc/passwd"`,
      `model = 3`,
      `effort = true`,
      `maxOutputTokens = 999999999`,
      ``,
    ].join("\n");

    const s = await newServer({ vault: vaultWithToml(toml) });
    const got = (await s.get("/api/settings")).body.settings;

    expect(`theme healed: ${got.theme}`).toBe(`theme healed: ${DEFAULTS.theme}`);
    expect(`density healed: ${got.density}`).toBe(`density healed: ${DEFAULTS.density}`);
    expect(`colorScheme healed: ${got.colorScheme}`).toBe(`colorScheme healed: ${DEFAULTS.colorScheme}`);
    expect(`autosaveSeconds healed: ${got.editor.autosaveSeconds}`).toBe(
      `autosaveSeconds healed: ${DEFAULTS.editor.autosaveSeconds}`
    );
    expect(`git.branch healed: ${got.git.branch}`).toBe(`git.branch healed: ${DEFAULTS.git.branch}`);
    expect(`git.autoSync healed: ${got.git.autoSync}`).toBe(`git.autoSync healed: ${DEFAULTS.git.autoSync}`);
    expect(`ai.baseUrl healed: ${got.ai.baseUrl}`).toBe(`ai.baseUrl healed: ${DEFAULTS.ai.baseUrl}`);
    expect(`ai.model healed: ${got.ai.model}`).toBe(`ai.model healed: ${DEFAULTS.ai.model}`);
    expect(`ai.effort healed: ${got.ai.effort}`).toBe(`ai.effort healed: ${DEFAULTS.ai.effort}`);

    /* out of range CLAMPS to the bound rather than falling back to the default:
       "9999 minutes" is a legible intent (lock as late as possible) and the
       nearest legal value honours it */
    expect(`idleLockMinutes clamped: ${got.secrets.idleLockMinutes}`).toBe(
      `idleLockMinutes clamped: ${NUMBERS["secrets.idleLockMinutes"].max}`
    );
    expect(`maxOutputTokens clamped: ${got.ai.maxOutputTokens}`).toBe(
      `maxOutputTokens clamped: ${NUMBERS["ai.maxOutputTokens"].max}`
    );
    /* off-step snaps to the grid the control offers (step 5) */
    expect(`clipboardClearSeconds snapped: ${got.secrets.clipboardClearSeconds}`).toBe(
      "clipboardClearSeconds snapped: 35"
    );
    expect(`autoSyncSeconds clamped up to the minimum: ${got.git.autoSyncSeconds >= NUMBERS["git.autoSyncSeconds"].min}`).toBe(
      "autoSyncSeconds clamped up to the minimum: true"
    );

    const notices = s.stderrLines.filter((l) => l.includes("settings.toml"));
    expect(`stderr explained the healing: ${notices.length > 0}`).toBe("stderr explained the healing: true");
  }, 60000);

  test("a file that is not even TOML boots on defaults rather than dying", async () => {
    const s = await newServer({ vault: vaultWithToml("this is not toml <<<< [[[\n= = =\n") });
    const got = (await s.get("/api/settings")).body.settings;
    expect(`theme: ${got.theme}`).toBe(`theme: ${DEFAULTS.theme}`);
    expect(`autosaveSeconds: ${got.editor.autosaveSeconds}`).toBe(
      `autosaveSeconds: ${DEFAULTS.editor.autosaveSeconds}`
    );
    /* and it is repaired on the next write, so the damage is not permanent */
    await s.api("PUT", "/api/settings", { theme: "minimal" });
    expect(`file repaired: ${readVaultText(s.vault, SETTINGS_REL).includes(`theme = "minimal"`)}`).toBe(
      "file repaired: true"
    );
  }, 60000);

  test("a section that is not a table is replaced wholesale, not merged into", async () => {
    const s = await newServer({ vault: vaultWithToml(`editor = "nonsense"\nsecrets = 42\n`) });
    const got = (await s.get("/api/settings")).body.settings;
    expect(`editor healed to an object: ${JSON.stringify(got.editor)}`).toBe(
      `editor healed to an object: ${JSON.stringify(DEFAULTS.editor)}`
    );
    expect(`secrets healed to an object: ${JSON.stringify(got.secrets)}`).toBe(
      `secrets healed to an object: ${JSON.stringify(DEFAULTS.secrets)}`
    );
  }, 60000);

  test("the healed value is what the file, the API and the next boot all agree on", async () => {
    /* the failure this prevents: healing in memory only, so the API says 480
       while the committed file still says 9999 and the next tool to read it
       disagrees with the running app */
    const vault = vaultWithToml(`[secrets]\nidleLockMinutes = 9999\n`);
    const s = await newServer({ vault });
    const served = (await s.get("/api/settings")).body.settings.secrets.idleLockMinutes;
    await s.api("PUT", "/api/settings", { theme: "modern" }); // force the rewrite
    const file = readVaultText(vault, SETTINGS_REL);
    expect(`API served: ${served}`).toBe(`API served: ${NUMBERS["secrets.idleLockMinutes"].max}`);
    expect(`file now says the healed value: ${file.includes(`idleLockMinutes = ${served}`)}`).toBe(
      "file now says the healed value: true"
    );
  }, 60000);
});

/* ============================================================
   4. CREDENTIALS — absorbed, stripped, masked
   ============================================================ */

describe("settings.toml — a credential written by hand is absorbed and stripped", () => {
  test("apiKey in the file is moved into sqlite, removed from disk and served masked", async () => {
    const vault = vaultWithToml(`[ai]\nmodel = "gpt-5.6-sol"\napiKey = ${JSON.stringify(KEY)}\n`);
    const s = await newServer({ vault });

    /* the write that strips it happens on load; force one anyway so this does
       not depend on load-time write ordering */
    await s.api("PUT", "/api/settings", { theme: "modern" });
    const file = readVaultText(vault, SETTINGS_REL);
    expect(`the key is gone from settings.toml: ${!file.includes(KEY)}`).toBe(
      "the key is gone from settings.toml: true"
    );
    expect(`no apiKey line remains: ${!/^\s*apiKey\s*=/m.test(file)}`).toBe("no apiKey line remains: true");

    const got = (await s.get("/api/settings")).body.settings;
    expect(`served masked: ${got.ai.apiKeyMasked}`).toBe(`served masked: sk-m…6789`);
    expect(`the raw key is not in the response: ${!JSON.stringify(got).includes(KEY)}`).toBe(
      "the raw key is not in the response: true"
    );
  }, 60000);

  test("a git token written by hand is absorbed the same way", async () => {
    const tok = "ghp_mocktoken0000000000000000004321";
    const vault = vaultWithToml(`[git]\nbranch = "main"\ntoken = ${JSON.stringify(tok)}\n`);
    const s = await newServer({ vault });
    await s.api("PUT", "/api/settings", { theme: "modern" });
    const file = readVaultText(vault, SETTINGS_REL);
    expect(`token gone from the file: ${!file.includes(tok)}`).toBe("token gone from the file: true");
    const got = (await s.get("/api/settings")).body.settings;
    expect(`served masked: ${got.git.tokenMasked}`).toBe("served masked: ghp_…4321");
  }, 60000);

  test("editing the pre-filled key field cannot destroy the stored credential", async () => {
    /* REGRESSION. The Settings key input is bound to `ai.apiKeyMasked` and is
       PRE-FILLED with the mask, so most of what arrives in it is a mask — but
       only an EXACT echo was declined. One Backspace therefore stored the
       truncated mask AS the credential: the real key gone from sqlite, already
       stripped from disk, unrecoverable, and the relay left authenticating as
       `••••••••`. No confirmation, no undo. */
    const vault = vaultWithToml(`[ai]\napiKey = ${JSON.stringify(KEY)}\n`);
    const s = await newServer({ vault });
    const shown = (await s.get("/api/settings")).body.settings.ai.apiKeyMasked;
    expect(`the field is pre-filled with: ${shown}`).toBe("the field is pre-filled with: sk-m…6789");

    for (const [what, typed] of [
      ["one Backspace", shown.slice(0, -1)],
      ["a character typed onto the end", shown + "x"],
      ["the middle deleted", shown.slice(0, 4) + shown.slice(5)],
      ["the exact mask echoed back", shown],
    ] as Array<[string, string]>) {
      const r = await s.api("PUT", "/api/settings", { ai: { apiKeyMasked: typed } });
      expect(`${what} → ${r.status}`).toBe(`${what} → 200`);
      const now = (await s.get("/api/settings")).body.settings.ai.apiKeyMasked;
      expect(`${what} left the credential: ${now}`).toBe(`${what} left the credential: sk-m…6789`);
    }

    /* …and a real replacement still gets through, or the field would be inert */
    const NEW = "sk-mock-replacement-000000001234";
    await s.api("PUT", "/api/settings", { ai: { apiKeyMasked: NEW } });
    expect(`a full replacement is stored: ${(await s.get("/api/settings")).body.settings.ai.apiKeyMasked}`).toBe(
      "a full replacement is stored: sk-m…1234"
    );
  }, 60000);

  test("a file carrying BOTH the raw credential and a stale mask keeps the RAW one", async () => {
    /* REGRESSION. `absorbCredentials` walked `[raw, masked]`, so the later
       field won and a stale `apiKeyMasked` overwrote the real key beside it. */
    const vault = vaultWithToml(`[ai]\napiKey = ${JSON.stringify(KEY)}\napiKeyMasked = "xxxx…yyyy"\n`);
    const s = await newServer({ vault });
    const got = (await s.get("/api/settings")).body.settings;
    expect(`the raw key won: ${got.ai.apiKeyMasked}`).toBe("the raw key won: sk-m…6789");
    const file = readVaultText(vault, SETTINGS_REL);
    expect(`neither field is left on disk: ${!/^\s*apiKey/m.test(file)}`).toBe("neither field is left on disk: true");
    expect(`the stale mask is gone too: ${!file.includes("xxxx…yyyy")}`).toBe("the stale mask is gone too: true");
  }, 60000);

  /* REGRESSION. `load()` merges the file over DEFAULTS by copying every key the
     TOML carries, so a setting RETIRED in a later version survived forever — in
     the file and in what `GET /api/settings` served. `editor.losslessRoundTrip`
     was removed as a dead control and still came back as a real settings field
     on any vault whose file predated the removal: a key with no control, no
     consumer and no effect, which is the parity contract broken from the other
     side. Parity is only structural if the served object cannot exceed
     DEFAULTS either. */
  test("a retired setting left in the file is dropped, not served back", async () => {
    const vault = vaultWithToml(
      `theme = "modern"\nnonsenseTopLevel = 1\n\n[editor]\nautosaveSeconds = 12\nlosslessRoundTrip = true\n`
    );
    const s = await newServer({ vault });

    const got = (await s.get("/api/settings")).body.settings;
    expect(`retired key served: ${"losslessRoundTrip" in got.editor}`).toBe("retired key served: false");
    expect(`unknown top-level served: ${"nonsenseTopLevel" in got}`).toBe("unknown top-level served: false");
    // the live key beside it is untouched — pruning is not a reset
    expect(`the real setting survived: ${got.editor.autosaveSeconds}`).toBe("the real setting survived: 12");

    // and it is gone from disk, so it cannot come back on the next boot
    const file = readVaultText(vault, SETTINGS_REL);
    expect(`no losslessRoundTrip line: ${!/^\s*losslessRoundTrip\s*=/m.test(file)}`).toBe(
      "no losslessRoundTrip line: true"
    );
    expect(`no nonsenseTopLevel line: ${!/^\s*nonsenseTopLevel\s*=/m.test(file)}`).toBe(
      "no nonsenseTopLevel line: true"
    );

    // nothing the app DOES define was lost in the prune
    const served = (await s.get("/api/settings")).body.settings;
    for (const path of settablePaths()) {
      expect(`${path} still served: ${at(served, path) !== undefined}`).toBe(`${path} still served: true`);
    }
  }, 60000);
});

/* ============================================================
   4b. settings.toml IS THE FILE ON DISK, not a boot-time snapshot
   ============================================================ */

describe("settings.toml — a change made on disk mid-session is seen, not clobbered", () => {
  test("an external edit survives the next unrelated save and is served back", async () => {
    /* REGRESSION. `load()` ran only at boot, nothing watched the file
       (`.znotes/` is invisible to the reconciler), and `persist()` rewrites the
       WHOLE file from the in-memory snapshot. So an unrelated one-field PUT
       silently REVERTED everything that had arrived since boot — and because
       settings.toml is in TRACKED_META, committed and pushed the revert. The
       cross-machine case (SPEC §7: committed with the vault, pull on focus) is
       exactly this: a setting changed on machine A never survived on B. */
    const vault = vaultWithToml(`theme = "modern"\n\n[editor]\nautosaveSeconds = 10\n`);
    const s = await newServer({ vault });
    expect(`boot theme: ${(await s.get("/api/settings")).body.settings.theme}`).toBe("boot theme: modern");

    // stand in for a git pull / another machine / a hand edit
    writeFileSync(join(vault, ".znotes", "settings.toml"), `theme = "terminal"\n\n[editor]\nautosaveSeconds = 42\n`, "utf8");

    const seen = (await s.get("/api/settings")).body.settings;
    expect(`the edit is visible: ${seen.theme} / ${seen.editor.autosaveSeconds}`).toBe(
      "the edit is visible: terminal / 42"
    );

    const put = await s.api("PUT", "/api/settings", { density: "compact" });
    expect(`the unrelated PUT succeeded: ${put.status}`).toBe("the unrelated PUT succeeded: 200");

    const after = (await s.get("/api/settings")).body.settings;
    expect(`theme after an unrelated save: ${after.theme}`).toBe("theme after an unrelated save: terminal");
    expect(`autosaveSeconds after an unrelated save: ${after.editor.autosaveSeconds}`).toBe(
      "autosaveSeconds after an unrelated save: 42"
    );
    expect(`the PUT still applied: ${after.density}`).toBe("the PUT still applied: compact");

    const file = readVaultText(vault, SETTINGS_REL);
    expect(`the file was not reverted: ${/theme = "terminal"/.test(file)}`).toBe("the file was not reverted: true");
  }, 60000);

  test("a credential pasted into the file mid-session is still absorbed, not served raw", async () => {
    /* the reload path runs the same heal+absorb `load()` does, so the SPEC §7
       guarantee (plaintext never committed) has to survive it */
    const vault = vaultWithToml(`theme = "modern"\n`);
    const s = await newServer({ vault });
    writeFileSync(join(vault, ".znotes", "settings.toml"), `theme = "modern"\n\n[ai]\napiKey = ${JSON.stringify(KEY)}\n`, "utf8");

    const got = (await s.get("/api/settings")).body.settings;
    expect(`absorbed and masked: ${got.ai.apiKeyMasked}`).toBe("absorbed and masked: sk-m…6789");
    expect(`the raw key is not in the response: ${!JSON.stringify(got).includes(KEY)}`).toBe(
      "the raw key is not in the response: true"
    );
    expect(`the key is gone from disk: ${!readVaultText(vault, SETTINGS_REL).includes(KEY)}`).toBe(
      "the key is gone from disk: true"
    );
  }, 60000);
});

/* ============================================================
   5. PUT — validation refuses, with the documented code
   ============================================================ */

describe("PUT /api/settings — malformed values are refused by code", () => {
  test("each malformed field answers 400 with its documented code, and changes nothing", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    const before = JSON.stringify((await s.get("/api/settings")).body.settings);

    const cases: Array<[string, unknown, string]> = [
      ["unknown theme", { theme: "bogus" }, "unknown-theme"],
      ["unknown density", { density: "roomy" }, "unknown-density"],
      ["unknown colour scheme", { colorScheme: "puce" }, "unknown-color-scheme"],
      ["negative autosave", { editor: { autosaveSeconds: -1 } }, "bad-number"],
      ["non-numeric autosave", { editor: { autosaveSeconds: "soon" } }, "bad-number"],
      ["zero auto-sync interval", { git: { autoSyncSeconds: 0 } }, "bad-auto-sync-seconds"],
      ["non-boolean autoSync", { git: { autoSync: "yes" } }, "bad-auto-sync"],
      ["non-boolean editor switch", { editor: { clickToEdit: "yes" } }, "bad-boolean"],
      ["empty branch", { git: { branch: "" } }, "bad-branch"],
      ["branch starting with a dash", { git: { branch: "-x" } }, "bad-branch"],
      ["non-http base URL", { ai: { baseUrl: "file:///etc/passwd" } }, "bad-base-url"],
      ["unparseable base URL", { ai: { baseUrl: "not a url" } }, "bad-base-url"],
      ["negative token ceiling", { ai: { maxOutputTokens: -4 } }, "bad-number"],
      ["a patch that is not an object", "nope", "bad-body"],
      /* REGRESSION. `ai.model` and `ai.effort` had no type check on either
         surface, so an object sailed through PUT and `serializeToml` wrote
         `model = "[object Object]"` into the committed file — a value that
         survives every boot, that the relay then sends forever, and that
         `atEffortFloor()` reads as past the floor, so the ladder skips the whole
         effort walk. `git.branch` has been checked all along. */
      ["a model that is not a string", { ai: { model: { a: 1 } } }, "bad-model"],
      ["a numeric model", { ai: { model: 12345 } }, "bad-model"],
      ["a blank model", { ai: { model: "   " } }, "bad-model"],
      ["an effort that is not a string", { ai: { effort: { a: 1 } } }, "bad-effort"],
      ["a blank effort", { ai: { effort: "" } }, "bad-effort"],
      ["git that is not an object", { git: "yes" }, "bad-git"],
      ["ai that is not an object", { ai: 7 }, "bad-ai"],
    ];

    for (const [label, patch, code] of cases) {
      const r = await s.api("PUT", "/api/settings", patch);
      expect(`${label} → ${r.status} ${r.body?.error ?? r.text.slice(0, 80)}`).toBe(
        `${label} → 400 ${code}`
      );
    }

    const after = JSON.stringify((await s.get("/api/settings")).body.settings);
    expect(`no refused PUT changed anything: ${before === after}`).toBe("no refused PUT changed anything: true");
  }, 90000);

  test("out-of-range but well-formed numbers are CLAMPED on PUT, not refused", async () => {
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    const spec = NUMBERS["secrets.idleLockMinutes"];
    const r = await s.api("PUT", "/api/settings", { secrets: { idleLockMinutes: spec.max + 1000 } });
    expect(`PUT status: ${r.status}`).toBe("PUT status: 200");
    expect(`clamped to the max: ${r.body.settings.secrets.idleLockMinutes}`).toBe(`clamped to the max: ${spec.max}`);

    /* and off-step snaps, so the field can never show a value the server would
       silently rewrite behind the user's back */
    const step = NUMBERS["secrets.clipboardClearSeconds"];
    const r2 = await s.api("PUT", "/api/settings", { secrets: { clipboardClearSeconds: 33 } });
    expect(`snapped to the step grid: ${r2.body.settings.secrets.clipboardClearSeconds % step.step}`).toBe(
      "snapped to the step grid: 0"
    );
  }, 60000);

  test("ai.effort accepts the relay's whole ladder, not just what the UI offers", async () => {
    /* deliberate: `meta.efforts` is the menu, `ai.ts EFFORT_ORDER` is the range
       the degradation ladder works over. Validating the field against the menu
       would make the ladder unable to write down where it ended up. */
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    for (const e of ["none", "low", "medium", "high", "max"]) {
      const r = await s.api("PUT", "/api/settings", { ai: { effort: e } });
      expect(`effort=${e} → ${r.status} (${r.body?.settings?.ai?.effort})`).toBe(`effort=${e} → 200 (${e})`);
    }
    expect(`the UI menu is a subset: ${META.efforts.every((e) => ["none", "low", "medium", "high", "max"].includes(e))}`).toBe(
      "the UI menu is a subset: true"
    );
  }, 60000);
});

/* ============================================================
   6. LIVE-APPLY — a setting that is stored and ignored is a lie
   ============================================================ */

describe("PUT /api/settings — the new value is really in use, mid-session", () => {
  test("ai.maxOutputTokens reaches the NEXT upstream request without a restart", async () => {
    const m = await newMock();
    m.setDefault(reply.text("ok"));
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await s.api("PUT", "/api/settings", {
      ai: { baseUrl: m.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high" },
      git: { autoSyncSeconds: 600 },
    });
    await sleep(250);

    const readCeiling = async (label: string) => {
      const mark = m.mark();
      await s.api("POST", "/api/ai/messages", { content: label, docPath: "inbox.md" });
      await waitUntil(async () => m.since(mark).some((r) => r.stream), {
        timeout: 10000,
        interval: 50,
        label: "the relay turn to reach the mock",
      });
      const turn = m.since(mark).filter((r) => r.stream).pop()!;
      return (turn.body as any)?.max_output_tokens;
    };

    expect(`ceiling before: ${await readCeiling("first")}`).toBe(`ceiling before: ${DEFAULTS.ai.maxOutputTokens}`);

    const put = await s.api("PUT", "/api/settings", { ai: { maxOutputTokens: 5000 } });
    expect(`PUT status: ${put.status}`).toBe("PUT status: 200");

    /* SAME process, no restart — this is the whole claim */
    expect(`ceiling after: ${await readCeiling("second")}`).toBe("ceiling after: 5000");
  }, 90000);

  test("ai.effort changes the statusbar's verdict AND is pushed on /events", async () => {
    /* REGRESSION. The capability probe (and with it the status broadcast) was
       fired only when a PUT changed ai.baseUrl / ai.model / ai.apiKey. But the
       derived status also carries the effort actually in use, and `ai.effort`
       is settable without touching any of those three — so changing effort in
       Settings left the statusbar item reading the OLD effort indefinitely,
       while Settings › AI read the new one. Two surfaces the code promises
       cannot disagree, disagreeing. */
    const m = await newMock();
    m.setDefault(reply.text("ok"));
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    await s.api("PUT", "/api/settings", {
      ai: { baseUrl: m.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high" },
      git: { autoSyncSeconds: 600 },
    });
    await sleep(300);
    expect(`effort before: ${(await s.get("/api/ai/status")).body.status.effort}`).toBe("effort before: high");

    const sse = await s.sse();
    try {
      const mark = sse.mark();
      const probesBefore = m.mark();
      await s.api("PUT", "/api/settings", { ai: { effort: "low" } });

      const ev = await sse.waitFor("ai-status", { from: mark, timeout: 8000 });
      expect(`pushed effort: ${ev.data.effort}`).toBe("pushed effort: low");
      expect(`derived effort: ${(await s.get("/api/ai/status")).body.status.effort}`).toBe("derived effort: low");

      /* and it did NOT cost a network round-trip: an effort change cannot make
         the endpoint more or less capable, so nothing may re-probe */
      await sleep(400);
      expect(`upstream requests caused by an effort change: ${m.since(probesBefore).length}`).toBe(
        "upstream requests caused by an effort change: 0"
      );
    } finally {
      sse.close();
    }
  }, 90000);

  test("re-picking an effort in Settings undoes a ladder downgrade — on the wire, not just in the file", async () => {
    /* REGRESSION, and the other half of the test above. Announcing on every PUT
       broadcast the right VALUE only while the ladder had not moved. Once one
       400 walked `reasoning.effort` down, `ai.effortSteps` was reset by exactly
       one thing — `onSettingsSaved()`, gated on the baseUrl/model/apiKey triple
       — so re-picking High in Settings returned 200, wrote `effort = "high"` to
       settings.toml and painted High in the segmented control, while the chip,
       the session and every upstream body still said `medium`. The only escape
       was to edit the base URL and change it back. */
    const m = await newMock();
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\nhello\n" } });
    await s.api("PUT", "/api/settings", {
      ai: { baseUrl: m.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high" },
      git: { autoSyncSeconds: 600 },
    });
    await sleep(300);

    /* one transient rejection of `high`, then the endpoint is healthy again */
    m.reset();
    m.setDefault(reply.text("ok"));
    m.rejectEffort(["high"]);
    await s.api("POST", "/api/ai/messages", { content: "walk it down", docPath: "inbox.md" });
    await waitUntil(async () => (await s.get("/api/ai/status")).body.status.effort !== "high", {
      timeout: 10000,
      interval: 50,
      label: "the ladder to downgrade the effort",
    });
    m.clearRules();
    expect(`effort after the ladder walked: ${(await s.get("/api/ai/status")).body.status.effort}`).toBe(
      "effort after the ladder walked: medium"
    );

    /* the user re-picks High in Settings › AI */
    const put = await s.api("PUT", "/api/settings", { ai: { effort: "high" } });
    expect(`re-pick → ${put.status}, stored ${put.body.settings.ai.effort}`).toBe("re-pick → 200, stored high");

    expect(`the chip's effort after the re-pick: ${(await s.get("/api/ai/status")).body.status.effort}`).toBe(
      "the chip's effort after the re-pick: high"
    );
    /* the `effort` rung goes with the steps — it only ever meant "the scale
       bottomed out", which is not true of a value the user just chose. The
       rungs recorded for OTHER parameters stay: they are still evidence about
       this endpoint, and an effort pick says nothing about them. */
    const rungs = (await s.get("/api/ai/status")).body.status.downgrades.map((d: any) => d.id);
    expect(`the effort rung was dropped: ${!rungs.includes("effort")}`).toBe("the effort rung was dropped: true");

    /* the claim that matters: the NEXT upstream request carries it */
    const mark = m.mark();
    await s.api("POST", "/api/ai/messages", { content: "and now?", docPath: "inbox.md" });
    await waitUntil(async () => m.streamed(mark).length > 0, {
      timeout: 10000,
      interval: 50,
      label: "the next relay turn",
    });
    expect(`effort on the wire after the re-pick: ${m.streamed(mark)[0].body.reasoning?.effort}`).toBe(
      "effort on the wire after the re-pick: high"
    );
    const sess = (await s.get("/api/ai/sessions/current")).body;
    expect(`the session agrees: ${sess.effort}`).toBe("the session agrees: high");
  }, 90000);

  test("a settings PUT that changes nothing observable pushes no status event", async () => {
    /* the other half of the same rule: `announce()` is the only dedupe, so a
       theme change must not spam every connected client with an AI status */
    const m = await newMock();
    m.setDefault(reply.text("ok"));
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    await s.api("PUT", "/api/settings", {
      ai: { baseUrl: m.baseUrl, apiKey: KEY, model: "gpt-5.6-sol", effort: "high" },
      git: { autoSyncSeconds: 600 },
    });
    await sleep(300);

    const sse = await s.sse();
    try {
      const mark = sse.mark();
      await s.api("PUT", "/api/settings", { theme: "minimal" });
      await s.api("PUT", "/api/settings", { density: "compact" });
      await sleep(600);
      expect(`ai-status events from unrelated settings: ${sse.since(mark, "ai-status").length}`).toBe(
        "ai-status events from unrelated settings: 0"
      );
    } finally {
      sse.close();
    }
  }, 90000);

  test("the secrets lock policy is published to the client, which is what applies it", async () => {
    /* the server never enforces the browser's auto-lock — it publishes the
       policy and crypto-worker.js applies it. So the contract the server owes
       is that a PUT is visible on the very next GET, in the units the worker
       expects. The applying half is measured in the browser (secrets-ui). */
    const s = await newServer({ seed: { "inbox.md": "# Inbox\n\n" } });
    const put = await s.api("PUT", "/api/settings", {
      secrets: { idleLockMinutes: 2, hiddenLockMinutes: 1, sessionHours: 3, clipboardClearSeconds: 45 },
    });
    expect(put.status).toBe(200);
    const got = (await s.get("/api/settings")).body.settings.secrets;
    expect(`policy served back: ${JSON.stringify(got)}`).toBe(
      `policy served back: ${JSON.stringify({ idleLockMinutes: 2, hiddenLockMinutes: 1, sessionHours: 3, clipboardClearSeconds: 45 })}`
    );
  }, 60000);
});
