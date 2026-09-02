/* ============================================================
   settings.ts — <vault>/.znotes/settings.toml + the server-declared meta.

   settings.toml is committed and human-editable. Credentials are NOT in it:
   a raw `git.token` / `ai.apiKey` found in the file (or arriving on
   PUT /api/settings) is absorbed into sqlite, stripped from the file, and
   from then on only ever leaves the server masked.

   `meta` is server-declared capability, not user state — the frontend builds
   every segmented control from it and hard-codes none of the option lists.
   ============================================================ */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Index } from "./db.ts";
import type { Vault } from "./vault.ts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/* ---------- numeric settings: bounds are SERVER-DECLARED ----------
   Same principle as `meta.themes`: the client builds the control and validates
   the value from what the server says, and hard-codes no bound of its own. One
   table drives three things — `meta.numbers` (so the UI can render min/max/step
   and a unit label), PUT validation, and the load-time heal of a hand-edited
   settings.toml — so the three can never drift apart.

   `step` is enforced, not decorative: the number input snaps to it, so the
   server must snap identically or the file and the control would disagree.

   `autoSyncSeconds` is clamped rather than rejected at the edges: a 0 or
   negative debounce is not a cadence at all, and an hour is already far past
   "after saves settle". Anything in between is the user's business — short
   values are exactly what a test or a scratch vault wants. Every other number
   here follows the same rule. */

const AUTOSYNC_MIN_SECONDS = 1;
const AUTOSYNC_MAX_SECONDS = 3600;

type NumberSpec = {
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Error code on PUT. Defaults to `bad-number`; named where one already exists. */
  code?: string;
};

export const NUMBERS: Record<string, NumberSpec> = {
  "editor.autosaveSeconds": { min: 1, max: 3600, step: 1, unit: "seconds" },
  "editor.tabSize": { min: 1, max: 8, step: 1, unit: "spaces" },
  "trash.retentionDays": { min: 1, max: 365, step: 1, unit: "days", code: "bad-retention-days" },
  "git.autoSyncSeconds": {
    min: AUTOSYNC_MIN_SECONDS,
    max: AUTOSYNC_MAX_SECONDS,
    step: 1,
    unit: "seconds",
    code: "bad-auto-sync-seconds",
  },
  "secrets.idleLockMinutes": { min: 1, max: 480, step: 1, unit: "minutes" },
  "secrets.hiddenLockMinutes": { min: 1, max: 480, step: 1, unit: "minutes" },
  "secrets.sessionHours": { min: 1, max: 72, step: 1, unit: "hours" },
  "secrets.clipboardClearSeconds": { min: 5, max: 600, step: 5, unit: "seconds" },
  "ai.maxOutputTokens": { min: 1000, max: 200_000, step: 1000, unit: "tokens" },
  "ai.contextBudgetTokens": { min: 1000, max: 2_000_000, step: 1000, unit: "tokens" },
  "terminal.idleLockMinutes": { min: 1, max: 480, step: 1, unit: "minutes" },
};

/** Settings that are strictly true/false, healed and validated as a group. */
export const BOOLEANS = [
  "editor.clickToEdit",
  "editor.confirmBeforeExit",
  "git.autoSync",
  "terminal.enabled",
  "terminal.allowAiAutoRun",
];

/**
 * The doc the vault/home button opens. Declared here rather than inline in
 * DEFAULTS because `meta.homeDocDefault` publishes it too: the client renders
 * the field's placeholder from the server's value and hard-codes no default of
 * its own, the same rule `meta.themes` and `meta.numbers` already follow.
 */
const HOME_DOC_DEFAULT = "index.md";
export const TRASH_RETENTION_DEFAULT_DAYS = 7;

export const META = {
  themes: [
    { id: "modern", label: "Modern" },
    { id: "minimal", label: "Minimal" },
    { id: "terminal", label: "Terminal" },
  ],
  densities: [
    { id: "compact", label: "Compact" },
    { id: "comfy", label: "Comfy" },
  ],
  efforts: ["low", "medium", "high"],
  colorSchemes: ["system", "dark", "light"],
  contextWindow: 256000,
  homeDocDefault: HOME_DOC_DEFAULT,
  numbers: NUMBERS,
} as const;

export const DEFAULTS = {
  theme: "minimal",
  density: "comfy",
  colorScheme: "system",
  editor: {
    autosaveSeconds: 10,
    tabSize: 2,
    clickToEdit: true,
    confirmBeforeExit: true,
    homeDoc: HOME_DOC_DEFAULT,
  },
  trash: { retentionDays: TRASH_RETENTION_DEFAULT_DAYS },
  /* Which extensions a file dropped on the sidebar tree may have (ADR 0030).
     A comma-separated LIST in one string, because that is how it is edited —
     in one text field, and by hand in this file. The server never gates
     `POST /api/docs` by it: what a doc IS is ADR 0019's question, and the
     sidebar's own "New doc" legitimately makes `report.txt`. This is the
     client's drop filter, published so both surfaces read the same list. */
  upload: { extensions: "md, html, txt, log" },
  git: { branch: "main", autoSync: true, autoSyncSeconds: 60 },
  /* Browser-side auto-lock policy (research §5.2 / §7.2). It lives here rather
     than as a constant in crypto-worker.js for the same reason the autosave
     interval does: it is a user decision, and a threat model that wants five
     minutes and one that wants eight hours are both legitimate. The server
     never enforces it — it only publishes it, and the worker applies it. */
  secrets: { idleLockMinutes: 15, hiddenLockMinutes: 5, sessionHours: 8, clipboardClearSeconds: 30 },
  ai: {
    /* NO default endpoint, deliberately. The boot probe and the relay both gate
       on (baseUrl && apiKey), so any non-empty default here would fire the
       operator's key at a host they never chose the moment they set only
       `ai.apiKey`. Empty means unconfigured: the probe skips and the relay
       refuses with `ai-unconfigured`. Any OpenAI-compatible endpoint works —
       the relay speaks POST {baseUrl}/responses. */
    baseUrl: "",
    model: "gpt-5",
    effort: "high",
    maxOutputTokens: 32_000,
    contextBudgetTokens: 200_000,
  },
  /* `enabled` is the hard off-switch; it is NOT the lock. The lock is
     the password, which lives in sqlite and has no representation here — with
     no password set the terminal is disabled whatever this says, and the AI is
     never even told the `run_command` tool exists. `shell` and `startupCwd`
     empty mean "$SHELL, else /bin/sh" and "the vault root": a committed
     settings.toml must not carry one machine's absolute paths to another.
     `allowAiAutoRun` ships OFF — see the gate in terminal.ts. */
  terminal: {
    enabled: true,
    idleLockMinutes: 10,
    shell: "",
    startupCwd: "",
    allowAiAutoRun: false,
  },
};

const CRED_KEYS = {
  "git.token": "git.tokenMasked",
  "ai.apiKey": "ai.apiKeyMasked",
} as const;

/**
 * The terminal password is a credential too — absorbed, hashed, stripped from
 * the file, never committed. It is just absorbed by
 * `absorbTerminalPassword` rather than by `absorbCredentials`, because the
 * server stores a scrypt hash and there is no masked twin to serve back.
 * `passwordSet` is the OUTPUT of get(); it is stripped on the same pass.
 */
const TERMINAL_CRED_FIELDS = ["password", "passwordSet"] as const;

/**
 * Every field name that makes settings.toml credential-bearing, as it appears
 * in the file. git.ts builds its pre-staging canary regex from THIS list, so a
 * credential can no longer be taught to one side and forgotten by the other —
 * which is exactly how `[terminal] password` came to be committed in plaintext
 * while `ai.apiKey` was caught.
 */
export const CREDENTIAL_FILE_KEYS: readonly string[] = [
  ...Object.entries(CRED_KEYS).flatMap(([raw, masked]) => [raw.split(".")[1], masked.split(".")[1]]),
  ...TERMINAL_CRED_FIELDS,
];

/** Does this parsed settings object carry a raw or masked credential field? */
function carriesCredential(obj: Json): boolean {
  for (const [credKey, maskedKey] of Object.entries(CRED_KEYS)) {
    const [group, raw] = credKey.split(".");
    const section = (obj as Json)[group];
    if (!isPlainObject(section)) continue;
    if (raw in section || maskedKey.split(".")[1] in section) return true;
  }
  /* Without this the file gate (`absorbFileCredentials`) reports "nothing to
     absorb" for a hand-written terminal password and never calls load(), so
     the plaintext is neither hashed into sqlite nor stripped from disk. */
  const terminal = (obj as Json).terminal;
  if (isPlainObject(terminal) && TERMINAL_CRED_FIELDS.some((f) => f in terminal)) return true;
  return false;
}

export class SettingsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

type Json = Record<string, any>;

const isPlainObject = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);

/* ---------- dotted `group.key` access (every path in NUMBERS/BOOLEANS) ---------- */

const splitPath = (path: string): [string, string] => {
  const i = path.indexOf(".");
  return [path.slice(0, i), path.slice(i + 1)];
};

/** The default for a dotted path, straight out of DEFAULTS. */
function defaultAt(path: string): any {
  const [group, key] = splitPath(path);
  return (DEFAULTS as Json)[group]?.[key];
}

/**
 * Clamp to [min,max] and snap to `step`, exactly as the number input does, so
 * a value typed in the UI, a value hand-written into settings.toml and the
 * value the server stores are always the same value. Unusable input falls back
 * to the shipped default rather than to a bound — 0 means "I got this wrong",
 * not "the fastest possible".
 */
function coerceNumber(path: string, raw: unknown): number {
  const range = NUMBERS[path];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Number(defaultAt(path));
  const clamped = Math.min(range.max, Math.max(range.min, n));
  const steps = Math.round((clamped - range.min) / range.step);
  return Math.min(range.max, range.min + steps * range.step);
}

/**
 * Prefix-preserving mask. Secrets are returned pre-masked; the raw token/key
 * never leaves the server — so this must never
 * return its input, at any length. Below credential length there is nothing
 * safe to reveal, so we emit a constant, which by construction carries no
 * information about the value at all.
 *
 * (An old `GET /api/settings` example showed `"tokenMasked":
 * "ghp_9f3kx2Qm7Lp0"` — but that was the mock's *stored* fixture rendered by a
 * mock that does no masking, not a masked value. The rule above wins, so the
 * fixture token comes back as `ghp_…7Lp0`.)
 */
function mask(value: string | null | undefined): string {
  const v = String(value ?? "");
  if (!v) return "";
  if (v.length < 16) return "•".repeat(8);
  return v.slice(0, 4) + "…" + v.slice(-4);
}

/** Is `small` obtainable from `big` by deleting characters only? */
function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (i < small.length && small[i] === ch) i++;
  return i === small.length;
}

/**
 * Is this string the mask we showed (or an edit of it), rather than a new
 * credential?
 *
 * Two tells, because one is not enough (see absorbCredentials):
 *
 *  - `mask()` emits either `first4…last4` or eight `•`, and neither glyph
 *    appears in a bearer token or an API key — those are ASCII by construction.
 *  - …unless the edit DELETED the glyph. Anything reachable from the mask by
 *    deleting characters is still the mask, not a secret; a real credential
 *    cannot be, since the mask is at most nine characters long and `mask()`
 *    itself treats anything under sixteen as too short to reveal.
 */
const looksMasked = (v: string, current: string): boolean =>
  v.includes("…") || v.includes("•") || (!!current && isSubsequence(v, current));

/**
 * The vault identity is passphrase-wrapped with scrypt logN=18. This
 * is the same primitive one notch down, and the notch is deliberate: logN=18 is
 * 256 MiB per derivation and this one runs SERVER-side on an endpoint an
 * attacker can call in a loop, so the memory cost is also a self-inflicted
 * denial of service. logN=17 is 128 MiB and ~150 ms on this machine — far past
 * what a guessing rig wants to pay per attempt — and the rate limiter below,
 * not the KDF, is what actually bounds the attempt rate.
 *
 * `node:crypto` rather than `Bun.password`: Bun.password is argon2id/bcrypt and
 * would introduce a third KDF into a project that already has exactly one, and
 * rather than `@noble/hashes` (reachable through age-encryption) because that
 * dependency is the BROWSER's crypto and importing it server-side would blur
 * the one boundary that matters — the server never sees a passphrase or a
 * plaintext secret. scrypt with explicit, stored parameters
 * is the smallest thing that is honest about what it is.
 */
const SCRYPT_LOG_N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 32;

/** sqlite credential key. Never in settings.toml, never served, never logged. */
const TERMINAL_PASSWORD_KEY = "terminal.passwordHash";

const scryptOpts = (logN: number, r: number, p: number) => ({
  N: 1 << logN,
  r,
  p,
  // node refuses when maxmem < 128*N*r; give it headroom rather than tracking it
  maxmem: 192 * 1024 * 1024,
});

/** `scrypt$logN$r$p$saltB64$hashB64` — self-describing, so params can move. */
function hashTerminalPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_LEN, scryptOpts(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P));
  return ["scrypt", SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), hash.toString("base64")].join("$");
}

/* A decoy record so an unconfigured terminal burns the same work, and the same
   wall-clock, as a configured one with a wrong password. Without it, `POST
   /api/terminal/unlock` answers instantly when no password is set and slowly
   when one is — which is an oracle for "does this vault have a terminal
   password", answered to anyone who can reach the port.

   Built on first use, not at import: a derivation at module load would put
   ~150 ms on every server boot for a code path most vaults never touch, and
   this module owns it now.

   BUT lazy-on-the-hot-path is its own oracle, and a louder one: the first
   unlock against a vault with NO password paid two derivations (build the
   decoy, then verify against it) where a configured vault paid one — measured
   2.0x, with no overlap between the two sets, so a single request answered the
   question the decoy exists to refuse. `warmDecoy()` below builds it off the
   request path instead, and only for the vaults that can ever need it. */
let decoy: string | null = null;
const decoyRecord = () => (decoy ??= hashTerminalPassword(randomBytes(32).toString("hex")));
/** True once the decoy exists — the warm-up's own idempotence check. */
const decoyWarm = () => decoy !== null;

/**
 * Constant-time verify. Returns false for every failure shape — malformed
 * record, unknown algorithm, wrong password — and burns a full derivation in
 * all of them, including when `stored` is null.
 */
function verifyTerminalPassword(stored: string | null | undefined, password: string): boolean {
  const record = stored || decoyRecord();
  const parts = record.split("$");
  let ok = parts.length === 6 && parts[0] === "scrypt";
  const logN = ok ? Number(parts[1]) : SCRYPT_LOG_N;
  const r = ok ? Number(parts[2]) : SCRYPT_R;
  const p = ok ? Number(parts[3]) : SCRYPT_P;
  if (!Number.isInteger(logN) || logN < 8 || logN > 20 || !Number.isInteger(r) || !Number.isInteger(p)) ok = false;
  const salt = ok ? Buffer.from(parts[4], "base64") : Buffer.alloc(16);
  const want = ok ? Buffer.from(parts[5], "base64") : Buffer.alloc(SCRYPT_LEN);
  let got: Buffer;
  try {
    got = scryptSync(password, salt, want.length || SCRYPT_LEN, scryptOpts(ok ? logN : SCRYPT_LOG_N, r, p));
  } catch {
    return false;
  }
  // length-equal by construction above; timingSafeEqual throws otherwise
  const same = got.length === want.length && timingSafeEqual(got, want);
  // `stored == null` still reaches here, having paid the same cost, and loses
  return ok && same && !!stored;
}

export interface SettingsFanout {
  applyGit(): void;
  scheduleSync(): void;
  aiSettingsSaved(): Promise<unknown>;
  aiEffortChanged(): void;
  aiAnnounce(): void;
  broadcast(event: string, data: unknown): void;
  retentionDays(): number;
  sweepTrash(why: string): Promise<string[]>;
  announceTrash(): Promise<void>;
}

export class Settings {
  private data: Json = structuredClone(DEFAULTS);
  /** Extra server-declared capability merged into `meta` — see setMetaProvider. */
  private metaProvider: (() => Json) | null = null;
  /** The exact bytes this server last read from / wrote to settings.toml — the
      only way to tell "the file changed under us" from "the file is ours". */
  private onDisk: string | null = null;

  /* `adoptEnvToken` is false for every SECONDARY vault (ADR 0018):
     ZNOTES_GIT_TOKEN is primary-only boot provisioning, and a secondary that
     absorbed it would re-credential an explicitly anonymous attach on the next
     restart — offering the primary account's token to whatever remote that
     vault points at. */
  constructor(
    private readonly vault: Vault,
    private readonly index: Index,
    private readonly adoptEnvToken = true
  ) {}

  /* Late-bound collaborators (same pattern as setMetaProvider): Settings is
     constructed before gitSync/ai/trash/docs exist, but a settings change
     fans out to all of them. index.ts wires this once at boot. */
  private fanout!: SettingsFanout;
  wire(f: SettingsFanout) {
    this.fanout = f;
  }

  /** GET /api/settings — serve DISK, and give a reload the same fan-out a PUT gets. */
  async getRoute(): Promise<{ status: number; body: unknown }> {
    // settings.toml is committed and hand-editable, so it can change under us
    // (a pull, another machine, an editor). Serve what is on disk, not a
    // boot-time snapshot — see reloadIfChanged.
    const changed = await this.reloadIfChanged();
    /* A reload IS a settings change: without the fan-out a pulled settings.toml
       altered behaviour (autoSync timer, retention window) with no
       re-evaluation and no `settings-changed` frame. */
    if (changed) {
      this.fanout.applyGit();
      this.fanout.aiAnnounce();
      this.fanout.broadcast("settings-changed", this.get());
      this.fanout.sweepTrash("settings reloaded from disk").catch(() => {});
    }
    return { status: 200, body: this.get() };
  }

  /** PUT /api/settings — the write plus every live-apply the write implies. */
  async putRoute(patch: unknown): Promise<{ status: number; body: unknown }> {
    try {
      const endpoint = () =>
        JSON.stringify([this.value("ai.baseUrl", ""), this.value("ai.model", ""), this.credential("ai.apiKey")]);
      const before = endpoint();
      const retentionBefore = this.fanout.retentionDays();
      /* Whether the patch NAMES ai.effort, not whether the stored value moved:
         the ladder downgrades behind the configured value, so the case that
         has to be caught is a user re-picking the effort they already had. */
      const picksEffort =
        !!patch && typeof patch === "object" && !Array.isArray(patch) &&
        !!(patch as any).ai && typeof (patch as any).ai === "object" && !Array.isArray((patch as any).ai) &&
        (patch as any).ai.effort != null;
      const out = await this.put(patch);
      this.fanout.applyGit(); // autoSync / autoSyncSeconds / branch apply live
      /* LIVE-APPLY for the retention window: a SHORTENED window has to be acted
         on now rather than at the next hourly tick. Not awaited: a settings
         save must not wait on a git commit. */
      if (this.fanout.retentionDays() !== retentionBefore) {
        this.fanout.sweepTrash("retention changed")
          /* A sweep that removed entries already announced its final list. With
             nothing expired, still announce so every client updates the
             retention label and each entry's recalculated purgeAt. */
          .then((purged) => (purged.length ? undefined : this.fanout.announceTrash()))
          .catch(() => {});
      }
      const after = endpoint();
      /* Capability probe at settings-save (research §7). Deliberately NOT
         awaited, and gated on the endpoint TRIPLE — only those three can change
         what the endpoint is capable of. */
      if (before !== after) this.fanout.aiSettingsSaved().catch(() => {});
      /* The ladder is wider than the probe: re-picking an effort must reset the
         degradation walk even when the endpoint did not change. */
      else if (picksEffort) this.fanout.aiEffortChanged();
      /* The derived STATUS is wider still. announce() is itself the "only when
         it changed" mechanism, keyed on the whole verdict. */
      this.fanout.aiAnnounce();
      /* SETTINGS ARE VAULT STATE and move between clients like it: `out` is
         exactly the body GET serves, credentials already masked, so it is safe
         on a stream that is not behind the terminal password. */
      this.fanout.broadcast("settings-changed", out);
      /* settings.toml is a COMMITTED file; a write to a tracked file schedules
         its own sync, like every other write in this server does. */
      this.fanout.scheduleSync();
      return { status: 200, body: out };
    } catch (err) {
      if (err instanceof SettingsError) return { status: err.status, body: { error: err.code, message: err.message } };
      throw err; // reaches Bun's error() → 500 server-fault, as before
    }
  }

  /**
   * `meta` is server-declared capability, not user state.
   * The AI relay has capability that is DISCOVERED rather than compiled in — what
   * the configured AI endpoint actually accepted, and every parameter the
   * degradation ladder had to give up (research §7.4) — so ai.ts registers a
   * provider here instead of settings.ts importing the relay.
   */
  setMetaProvider(fn: (() => Json) | null) {
    this.metaProvider = fn;
  }

  private meta(): Json {
    const extra = this.metaProvider ? this.metaProvider() : null;
    return extra ? { ...META, ...extra } : { ...META };
  }

  /** Read settings.toml, absorbing any raw credentials it carries. */
  async load(): Promise<void> {
    // before anything can need it: boot provisioning attaches a vault repo
    // with this token, and that happens right after load() returns
    this.absorbEnvToken();
    const file = Bun.file(this.vault.settingsPath);
    let parsed: Json = {};
    this.onDisk = null;
    if (await file.exists()) {
      const text = await file.text();
      this.onDisk = text;
      try {
        parsed = (Bun.TOML.parse(text) as Json) ?? {};
      } catch (err) {
        process.stderr.write(`[z-notes] settings.toml is not valid TOML, using defaults: ${String(err)}\n`);
        parsed = {};
        /* Park the bytes before anything can heal over them. The file is
           committed, so an unparseable copy can ARRIVE — a pull, or the
           checkout an attach runs (ADR 0017) — and the next persist() (any
           save, or attach adopting `git.branch`) rewrites the file from
           defaults, which the next sync then commits and pushes. Healing is
           this file's contract (see the preamble it serializes); destroying
           the only local copy of what it healed over is not. */
        await this.parkUnparseable(text);
      }
    }
    this.data = mergeOneLevel(structuredClone(DEFAULTS), parsed);
    // settings.toml is hand-editable and committed, so it can arrive from
    // another machine carrying anything at all. PUT validates; the file must be
    // held to the same standard before git.ts is handed a branch name — or
    // before ai.ts fires the AI credential at whatever `ai.baseUrl` says.
    const healed = this.healAll();
    // absorb BEFORE any persist(): a persist while a raw token is still in
    // this.data would write the credential straight back into the committed file
    const absorbed = [this.absorbCredentials(this.data), this.absorbTerminalPassword(this.data)].some(Boolean);
    // prune AFTER absorb: the credential keys are the one thing that belongs in
    // the file but not in DEFAULTS, and absorb is what removes them
    const pruned = this.pruneUnknown();
    // write back if the file carried credentials, needed healing or pruning, or is absent
    if (absorbed || healed || pruned || !(await file.exists())) await this.persist();
  }

  /**
   * Every heal, in order. healSections runs FIRST: everything below assumes
   * its group is an object. Every heal runs — `.some` on an already-evaluated
   * array, never `||`, so a section healed early does not short-circuit the
   * ones after it. Shared by load() and put(): the two used to disagree, so a
   * PUT could persist a value (an untrimmed terminal.shell, a section replaced
   * by a scalar) that the next boot rejected and silently reset.
   */
  private healAll(): boolean {
    return [
      this.healSections(),
      this.healEditor(),
      this.healGit(),
      this.healAi(),
      this.healNumbers(),
      this.healBooleans(),
      this.healEnums(),
      this.healTerminal(),
      this.healUpload(),
    ].some(Boolean);
  }

  /**
   * Re-read settings.toml if the bytes on disk are not the ones this server put
   * there.
   *
   * `this.data` used to be a boot-time snapshot that nothing ever refreshed —
   * `load()` ran at boot and from `absorbFileCredentials()` (which returns early
   * unless the file carries a credential), and `.znotes/` is invisible to the
   * reconciler. But `persist()` rewrites the WHOLE file from that snapshot, so
   * merging a one-field patch into it silently REVERTED every change made on
   * disk since boot — and, because settings.toml is in TRACKED_META, committed
   * and pushed the revert. A setting changed on another machine and pulled here
   * (settings.toml is committed with the vault and pulled on focus) never
   * survived the next save. Cheap: one small read on the settings routes only.
   */
  async reloadIfChanged(): Promise<boolean> {
    const file = Bun.file(this.vault.settingsPath);
    if (!(await file.exists())) return false; // gone: persist() re-creates it
    const text = await file.text().catch(() => null);
    if (text == null || text === this.onDisk) return false;
    await this.load();
    return true;
  }

  /**
   * settings.toml is committed AND hand-editable, so a credential can appear in
   * it at any time — not just at boot, which is the only moment `load()` runs.
   * git.ts calls this before staging the file: anything sensitive moves into
   * sqlite and is stripped from disk, so the plaintext is never committed.
   * Returns true if the file carried one.
   */
  async absorbFileCredentials(): Promise<boolean> {
    const file = Bun.file(this.vault.settingsPath);
    if (!(await file.exists())) return false;
    let parsed: Json;
    try {
      parsed = (Bun.TOML.parse(await file.text()) as Json) ?? {};
    } catch {
      return false; // unparseable: load() already reported it, nothing to absorb
    }
    if (!carriesCredential(parsed)) return false;
    await this.load(); // absorbs into sqlite, strips the fields, rewrites the file
    return true;
  }

  /**
   * A section in settings.toml that is not a table at all (`secrets = "off"`,
   * or a `[secrets]` deleted wholesale on another machine) would otherwise
   * shadow the defaults with something no consumer can read. Restore the shape
   * first; the value-level heals below assume it.
   */
  private healSections(): boolean {
    let touched = false;
    for (const [group, value] of Object.entries(DEFAULTS)) {
      if (!isPlainObject(value)) continue;
      if (isPlainObject(this.data[group])) continue;
      this.data[group] = structuredClone(value);
      touched = true;
    }
    return touched;
  }

  /** Clamp/snap every NUMBERS path; unusable values fall back to the default. */
  private healNumbers(): boolean {
    let touched = false;
    for (const path of Object.keys(NUMBERS)) {
      const [group, key] = splitPath(path);
      const section = this.data[group];
      if (!isPlainObject(section)) continue;
      const fixed = coerceNumber(path, section[key]);
      if (section[key] !== fixed) {
        section[key] = fixed;
        touched = true;
      }
    }
    return touched;
  }

  /** `autoSync = "yes"` is truthy and would silently change behaviour. */
  private healBooleans(): boolean {
    let touched = false;
    for (const path of BOOLEANS) {
      const [group, key] = splitPath(path);
      const section = this.data[group];
      if (!isPlainObject(section)) continue;
      if (typeof section[key] === "boolean") continue;
      section[key] = defaultAt(path);
      touched = true;
    }
    return touched;
  }

  /**
   * The three enums the UI owns end to end. A theme the server does not ship
   * leaves every button in the segmented control unselected and no stylesheet
   * to load, so it is healed rather than served.
   *
   * `ai.effort` is deliberately NOT healed or validated against `meta.efforts`:
   * the relay's degradation ladder walks a WIDER scale (none…max, ai.ts
   * EFFORT_ORDER) and an endpoint that accepts `max` is a legitimate
   * configuration. meta.efforts is what the UI offers, not what the field
   * accepts.
   */
  private healEnums(): boolean {
    const checks: [string, readonly string[]][] = [
      ["theme", META.themes.map((t) => t.id)],
      ["density", META.densities.map((d) => d.id)],
      ["colorScheme", META.colorSchemes as readonly string[]],
    ];
    let touched = false;
    for (const [key, allowed] of checks) {
      if (allowed.includes(String(this.data[key]))) continue;
      process.stderr.write(
        `[z-notes] settings.toml: unusable ${key} "${this.data[key]}", falling back to "${(DEFAULTS as Json)[key]}"\n`
      );
      this.data[key] = (DEFAULTS as Json)[key];
      touched = true;
    }
    return touched;
  }

  /**
   * `editor.homeDoc` is a VAULT-RELATIVE doc path that the browser turns
   * straight into a navigation, so the same rule `git.branch` gets applies: a
   * hand-edited or synced file must not be able to put `/etc/passwd` or
   * `../../secrets.md` in front of the home button. Heal rather than throw — a
   * bad line in a pulled settings.toml must never stop the server booting.
   * Empty is legal and means "no home doc; fall back to the first doc".
   * (editor numbers/switches are healed by healNumbers/healBooleans.)
   */
  private healEditor(): boolean {
    const editor = this.data.editor;
    if (!isPlainObject(editor)) {
      this.data.editor = structuredClone(DEFAULTS.editor);
      return true;
    }
    if (editor.homeDoc == null) return false;
    const raw = typeof editor.homeDoc === "string" ? editor.homeDoc.trim() : null;
    if (raw !== null && !badDocPath(raw)) {
      if (editor.homeDoc === raw) return false;
      editor.homeDoc = raw;
      return true;
    }
    process.stderr.write(
      `[z-notes] settings.toml: unusable editor.homeDoc, falling back to "${DEFAULTS.editor.homeDoc}"\n`
    );
    editor.homeDoc = DEFAULTS.editor.homeDoc;
    return true;
  }

  /** Force the git section back to something usable; true if anything moved. */
  private healGit(): boolean {
    const git = this.data.git;
    if (!isPlainObject(git)) {
      this.data.git = structuredClone(DEFAULTS.git);
      return true;
    }
    let touched = false;
    try {
      validateGit({ branch: git.branch });
      if (typeof git.branch === "string" && git.branch !== git.branch.trim()) {
        git.branch = git.branch.trim();
        touched = true;
      }
    } catch {
      process.stderr.write(`[z-notes] settings.toml: unusable git.branch, falling back to "${DEFAULTS.git.branch}"\n`);
      git.branch = DEFAULTS.git.branch;
      touched = true;
    }
    // git.autoSync and git.autoSyncSeconds are healed by healBooleans/healNumbers
    return touched;
  }

  /**
   * Same contract as healGit, for the section that decides where the AI
   * credential is sent. `load()` re-reads settings.toml live — at boot AND
   * whenever git.ts absorbs a credential out of a freshly pulled file — so a
   * settings.toml arriving from another machine could previously put
   * `file://`, `gopher://` or a bare hostname into `ai.baseUrl` unchecked,
   * values `put()` has rejected since validateAi was written. Heal rather than
   * throw: a bad line in a synced file must not stop the server from booting.
   */
  private healAi(): boolean {
    const ai = this.data.ai;
    if (!isPlainObject(ai)) {
      this.data.ai = structuredClone(DEFAULTS.ai);
      return true;
    }
    /* every key heals — one bad line must not shadow the ones after it */
    let touched = false;
    try {
      validateAi({ baseUrl: ai.baseUrl });
      if (typeof ai.baseUrl === "string" && ai.baseUrl !== ai.baseUrl.trim()) {
        ai.baseUrl = ai.baseUrl.trim();
        touched = true;
      }
    } catch {
      process.stderr.write(
        `[z-notes] settings.toml: unusable ai.baseUrl, falling back to "${DEFAULTS.ai.baseUrl}"\n`
      );
      ai.baseUrl = DEFAULTS.ai.baseUrl;
      touched = true;
    }
    /* The same standard the PUT applies, for the file: a hand-edited or synced
       `model = 3` would otherwise reach the relay as a number and be persisted
       back as one. Heals to the default rather than refusing to boot. */
    for (const key of ["model", "effort"] as const) {
      if (ai[key] == null || (typeof ai[key] === "string" && String(ai[key]).trim())) continue;
      process.stderr.write(
        `[z-notes] settings.toml: unusable ai.${key}, falling back to "${DEFAULTS.ai[key]}"\n`
      );
      ai[key] = DEFAULTS.ai[key];
      touched = true;
    }
    return touched;
  }

  /**
   * `terminal.shell` and `terminal.startupCwd` are free text that reaches
   * `Bun.spawn` and a `cd`, and settings.toml is committed — so both can arrive
   * from another machine, where neither path need exist. Heal to "" (meaning
   * "$SHELL / the vault root", which always resolves) rather than refusing to
   * boot; terminal.ts re-checks at spawn time anyway, because a directory can
   * be deleted between a save and a command. `enabled`/`allowAiAutoRun` and
   * `idleLockMinutes` are handled by the generic boolean/number heals.
   */
  private healTerminal(): boolean {
    const t = this.data.terminal;
    if (!isPlainObject(t)) {
      this.data.terminal = structuredClone(DEFAULTS.terminal);
      return true;
    }
    let touched = false;
    for (const key of ["shell", "startupCwd"] as const) {
      const v = t[key];
      if (typeof v === "string" && (!v || v.startsWith("/")) && !v.includes("\0")) {
        if (v !== v.trim()) {
          t[key] = v.trim();
          touched = true;
        }
        continue;
      }
      if (v == null) continue; // absent is fine; mergeOneLevel already gave us the default
      process.stderr.write(`[z-notes] settings.toml: unusable terminal.${key}, falling back to the default\n`);
      t[key] = DEFAULTS.terminal[key];
      touched = true;
    }
    return touched;
  }

  /**
   * `upload.extensions` is a hand-written LIST, so every way to get it wrong is
   * a spelling: a leading dot, capitals, a trailing comma, the same token
   * twice. `normalizeExtensions` answers all of them and is the same function
   * the PUT runs — the rule the numbers get from clamp/snap, for the one
   * free-text list. `""` is a legal outcome and means nothing may be dropped.
   */
  private healUpload(): boolean {
    const up = this.data.upload;
    if (!isPlainObject(up)) {
      this.data.upload = structuredClone(DEFAULTS.upload);
      return true;
    }
    if (up.extensions == null) return false; // absent: mergeOneLevel already gave us the default
    if (typeof up.extensions !== "string") {
      process.stderr.write(
        `[z-notes] settings.toml: unusable upload.extensions, falling back to "${DEFAULTS.upload.extensions}"\n`
      );
      up.extensions = DEFAULTS.upload.extensions;
      return true;
    }
    const fixed = normalizeExtensions(up.extensions);
    if (fixed === up.extensions) return false;
    up.extensions = fixed;
    return true;
  }

  /**
   * FIRST-RUN ONLY, deliberately.
   *
   * settings.toml is the startup surface (see the file preamble), so a fresh
   * install must be able to configure a terminal password without a UI. But the
   * file is also COMMITTED and syncs between machines, so if it could also
   * REPLACE an existing password, anyone who can write a note could push a
   * settings.toml and take the terminal. So: absorbed and hashed when nothing
   * is set, stripped and ignored (loudly) when something is. Changing a
   * password that exists goes through `POST /api/terminal/password`, which
   * demands the current one.
   *
   * Either way the plaintext is deleted from `this.data` before any persist(),
   * so it is never written back to disk and never committed — the same
   * guarantee `git.token` and `ai.apiKey` get.
   */
  private absorbTerminalPassword(obj: Json): boolean {
    const section = obj.terminal;
    if (!isPlainObject(section)) return false;
    let touched = false;
    // `passwordSet` is an OUTPUT of get(); if it comes back in on a PUT it is
    // the UI echoing what we told it, never a credential
    if ("passwordSet" in section) {
      delete section.passwordSet;
      touched = true;
    }
    if (!("password" in section)) return touched;
    const value = section.password;
    delete section.password;
    if (typeof value !== "string" || !value) return true;
    if (this.index.getCredential(TERMINAL_PASSWORD_KEY)) {
      process.stderr.write(
        "[z-notes] settings.toml carried terminal.password but one is already set — ignored and stripped. Change it under Settings → Terminal.\n"
      );
      return true;
    }
    if (value.length < 8) {
      process.stderr.write("[z-notes] settings.toml: terminal.password is shorter than 8 characters — ignored and stripped.\n");
      return true;
    }
    this.index.setCredential(TERMINAL_PASSWORD_KEY, hashTerminalPassword(value));
    process.stderr.write("[z-notes] terminal password adopted from settings.toml and stripped from the file.\n");
    return true;
  }

  /** The unparseable settings.toml, kept where the pre-attach park goes —
      `.znotes/tmp/` is git-excluded app scratch, so the copy never syncs. */
  private async parkUnparseable(text: string): Promise<void> {
    try {
      const dir = resolve(this.vault.znotesDir, "tmp");
      await mkdir(dir, { recursive: true });
      await Bun.write(resolve(dir, "settings.toml.unparseable"), text);
      process.stderr.write("[z-notes] the unparseable settings.toml is copied to .znotes/tmp/settings.toml.unparseable\n");
    } catch {
      /* parking is a courtesy; failing to park must not stop the boot */
    }
  }

  /**
   * FIRST-RUN ONLY, for the same reason `absorbTerminalPassword` is: a
   * container's first boot has no UI and no settings.toml, so `ZNOTES_GIT_TOKEN`
   * is how a fresh PVC gets a credential to attach its vault repo with.
   * Once one is stored the env var is IGNORED — rotation happens in
   * Settings, and a stale value left on the deployment must not silently
   * un-rotate the live token on the next restart.
   *
   * The env var is read here and nowhere else: the credentials table has one
   * owner. The log line says a token was adopted and never what it is.
   */
  private absorbEnvToken(): void {
    if (!this.adoptEnvToken) return;
    const value = process.env.ZNOTES_GIT_TOKEN;
    if (typeof value !== "string" || !value) return;
    if (this.index.getCredential("git.token")) return;
    this.index.setCredential("git.token", value);
    process.stderr.write(
      "[z-notes] git token adopted from ZNOTES_GIT_TOKEN into .znotes/index.db — the env var can be dropped after this boot.\n"
    );
  }

  /** Move raw/masked credential fields out of a settings object into sqlite. */
  private absorbCredentials(obj: Json): boolean {
    let touched = false;
    for (const [credKey, maskedKey] of Object.entries(CRED_KEYS)) {
      const [group, raw] = credKey.split(".");
      const maskedField = maskedKey.split(".")[1];
      const section = obj[group];
      if (!isPlainObject(section)) continue;
      /* masked FIRST, raw LAST. A settings.toml carrying BOTH `apiKey = "<real>"`
         and a stale `apiKeyMasked` used to end with the MASK stored as the
         credential, because the later field won. The raw field is the one that
         is unambiguously a secret, so it must always be the last word. */
      for (const field of [maskedField, raw]) {
        if (!(field in section)) continue;
        const value = section[field];
        delete section[field];
        touched = true;
        if (typeof value !== "string") continue;
        /* The masked field is what the UI's key input is bound to, and that
           input is PRE-FILLED with the mask — so most of what arrives in it is
           the mask, not a new secret. Only an exact echo used to be declined,
           which meant one Backspace in the field stored the truncated mask AS
           the credential: the real key gone from sqlite and already stripped
           from disk, unrecoverable, with the relay then authenticating as
           `••••••••`. Anything still carrying a mask glyph is the mask.

           EMPTY is not the mask, it is the one deliberate gesture the field
           has: clear it and save ⇒ delete the stored credential. It used to be
           swallowed by the subsequence test ("" is a subsequence of anything),
           which made a stored token literally unremovable from the API. */
        if (field === maskedField && value && looksMasked(value, mask(this.index.getCredential(credKey)))) continue;
        this.index.setCredential(credKey, value);
      }
    }
    return touched;
  }

  /**
   * Drop keys no setting declares any more.
   *
   * `load()` merges the file over DEFAULTS permissively — every key the TOML
   * carries is copied through. So a setting RETIRED in a later version lives on
   * forever: in the file, and in the object `GET /api/settings` serves. That is
   * a ghost with no control and no consumer, and it breaks the parity contract
   * (every setting is settable in both surfaces) from the other direction.
   * Runs after absorbCredentials(), which removes the one class of key that
   * legitimately appears in the file but never in DEFAULTS.
   */
  private pruneUnknown(): boolean {
    let touched = false;
    for (const key of Object.keys(this.data)) {
      const def = (DEFAULTS as Json)[key];
      if (def === undefined) {
        delete this.data[key];
        touched = true;
        continue;
      }
      if (!isPlainObject(def) || !isPlainObject(this.data[key])) continue;
      for (const sub of Object.keys(this.data[key])) {
        if (sub in def) continue;
        delete this.data[key][sub];
        touched = true;
      }
    }
    return touched;
  }

  get(): { settings: Json; meta: Json } {
    const settings = structuredClone(this.data);
    settings.git = { ...(settings.git ?? {}), tokenMasked: mask(this.index.getCredential("git.token")) };
    settings.ai = { ...(settings.ai ?? {}), apiKeyMasked: mask(this.index.getCredential("ai.apiKey")) };
    /* Not `passwordMasked`: there is nothing to mask. Only a scrypt HASH is
       stored, and the prefix of a hash is neither useful to a human nor safe to
       publish, so the only fact served is whether one exists — which is what
       the panel needs to say "set a password" instead of offering a prompt. */
    settings.terminal = {
      ...(settings.terminal ?? {}),
      passwordSet: !!this.index.getCredential(TERMINAL_PASSWORD_KEY),
    };
    return { settings, meta: this.meta() };
  }

  /* The credentials table has ONE owner: this class. The terminal's password
     hash is a credential like the git token and the AI key, so its reads and
     writes come through here too — terminal.ts holds no table access. */
  terminalPasswordSet(): boolean {
    return !!this.index.getCredential(TERMINAL_PASSWORD_KEY);
  }
  /** Hashes here — plaintext never lands in sqlite. Empty string clears. */
  setTerminalPassword(plain: string): void {
    this.index.setCredential(TERMINAL_PASSWORD_KEY, plain ? hashTerminalPassword(plain) : "");
  }
  /** Constant-time, decoy-backed: same work whether or not a hash is stored. */
  verifyTerminalPassword(password: string): boolean {
    return verifyTerminalPassword(this.index.getCredential(TERMINAL_PASSWORD_KEY), password);
  }
  /** Pre-build the decoy off the request path (see decoyRecord above). */
  warmPasswordDecoy(): void {
    decoyRecord();
  }

  /** Raw credential, for server-side use only (git/ai relays in later phases). */
  credential(key: keyof typeof CRED_KEYS): string | null {
    return this.index.getCredential(key);
  }

  value<T = unknown>(path: string, fallback: T): T {
    const parts = path.split(".");
    let cur: any = this.data;
    for (const p of parts) {
      if (!isPlainObject(cur) || !(p in cur)) return fallback;
      cur = cur[p];
    }
    return (cur ?? fallback) as T;
  }

  /** PUT /api/settings — partial object, deep-merged one level. */
  async put(patch: unknown): Promise<{ settings: Json; meta: Json }> {
    if (!isPlainObject(patch)) throw new SettingsError("bad-body", "Settings patch must be an object.");
    if (patch.theme != null && !META.themes.some((t) => t.id === patch.theme))
      throw new SettingsError("unknown-theme", `No such theme: ${patch.theme}`);
    if (patch.density != null && !META.densities.some((d) => d.id === patch.density))
      throw new SettingsError("unknown-density", `No such density: ${patch.density}`);
    if (patch.colorScheme != null && !(META.colorSchemes as readonly string[]).includes(String(patch.colorScheme)))
      throw new SettingsError("unknown-color-scheme", `No such colour scheme: ${patch.colorScheme}`);
    validateEditor(patch.editor);
    validateGit(patch.git);
    validateAi(patch.ai);
    validateTerminal(patch.terminal);
    validateUpload(patch.upload);
    validateNumbers(patch);
    validateBooleans(patch);

    /* Merge onto what is on DISK, not onto a boot-time snapshot: persist()
       rewrites the whole file, so a stale snapshot turns every save into a
       silent revert of anything that arrived since boot (see reloadIfChanged). */
    await this.reloadIfChanged();

    const clean = structuredClone(patch) as Json;
    if (isPlainObject(clean.editor) && typeof clean.editor.homeDoc === "string")
      clean.editor.homeDoc = clean.editor.homeDoc.trim();
    if (isPlainObject(clean.git) && typeof clean.git.branch === "string")
      clean.git.branch = clean.git.branch.trim();
    /* normalised on the way IN, so the response carries what was stored — the
       same promise the number clamp makes, for the one free-text list */
    if (isPlainObject(clean.upload) && typeof clean.upload.extensions === "string")
      clean.upload.extensions = normalizeExtensions(clean.upload.extensions);
    // the same clamp/snap the file gets on load and the number input applies in
    // the browser — one rule, three surfaces
    for (const path of Object.keys(NUMBERS)) {
      const [group, key] = splitPath(path);
      const section = clean[group];
      if (!isPlainObject(section) || section[key] == null) continue;
      section[key] = coerceNumber(path, section[key]);
    }
    this.absorbCredentials(clean);
    this.absorbTerminalPassword(clean);
    this.data = mergeOneLevel(this.data, clean);
    /* The same standard load() holds the file to, applied to what a PUT can
       produce. Without it a PUT could replace a whole section with a scalar
       (`{"secrets":"off"}` → every consumer of that group reads its fallback),
       or park an untrimmed terminal.shell that the next boot rejects — and
       whatever it parked was merged, served AND persisted into the committed
       settings.toml until then. pruneUnknown drops the arbitrary top-level
       keys mergeOneLevel would otherwise carry through. */
    this.healAll();
    this.pruneUnknown();
    await this.persist();
    return this.get();
  }

  /** Stable, human-readable serialisation — credentials never included. */
  private async persist(): Promise<void> {
    const target = this.vault.settingsPath;
    await mkdir(dirname(target), { recursive: true });
    const text = serializeToml(this.data);
    const file = Bun.file(target);
    /* Remember what we wrote. Without it every save looks like an EXTERNAL edit
       to reloadIfChanged(), which would then re-read the file on the next PUT —
       and two saves in flight together would race, the second reloading a
       snapshot that predates the first and persisting over it. */
    if ((await file.exists()) && (await file.text()) === text) {
      this.onDisk = text;
      return;
    }
    await Bun.write(target, text);
    this.onDisk = text;
  }
}

/* ---------- generic value validation (PUT) ----------
   The mirror of healNumbers/healBooleans. The file heals silently because a bad
   line in a synced file must not stop the server booting; an API caller gets
   told, because there is someone there to tell. */

function validateNumbers(patch: Json): void {
  for (const [path, range] of Object.entries(NUMBERS)) {
    const [group, key] = splitPath(path);
    const section = patch[group];
    if (!isPlainObject(section) || !(key in section) || section[key] == null) continue;
    const n = Number(section[key]);
    if (!Number.isFinite(n) || n <= 0)
      throw new SettingsError(range.code ?? "bad-number", `${path} must be a positive number of ${range.unit}.`);
  }
}

function validateBooleans(patch: Json): void {
  for (const path of BOOLEANS) {
    const [group, key] = splitPath(path);
    const section = patch[group];
    if (!isPlainObject(section) || !(key in section) || section[key] == null) continue;
    if (typeof section[key] !== "boolean")
      throw new SettingsError(path === "git.autoSync" ? "bad-auto-sync" : "bad-boolean", `${path} must be true or false.`);
  }
}

/* ---------- editor settings ---------- */

/**
 * The one rule for a vault-relative doc path in settings, shared by the PUT
 * validator and the file heal so the two can never drift. Absolute paths, `..`
 * segments, backslashes, a Windows drive letter, a URL scheme and control
 * characters are all refused: this string is handed to the browser, which turns
 * it into `/d/<path>` and then into `GET /api/docs/{path}`. Empty is legal and
 * means "no home doc".
 */
function badDocPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.includes("\\")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return true; // a scheme, and `C:` with it
  if (/[\x00-\x1f\x7f]/.test(p)) return true;
  return p.split("/").some((seg) => seg === ".." || seg === ".");
}

function validateEditor(editor: unknown): void {
  if (editor == null) return;
  if (!isPlainObject(editor)) throw new SettingsError("bad-editor", "editor must be an object.");
  if (!("homeDoc" in editor) || editor.homeDoc == null) return;
  if (typeof editor.homeDoc !== "string")
    throw new SettingsError("bad-home-doc", "editor.homeDoc must be a string.");
  if (badDocPath(editor.homeDoc.trim()))
    throw new SettingsError("bad-home-doc", `editor.homeDoc must be a vault-relative path: ${editor.homeDoc}`);
}

/* ---------- git settings (phase 2) ----------
   `git.branch` reaches an argv array in git.ts. Bun.spawn never involves a
   shell, so there is no injection to escape — but a branch that begins with `-`
   would still be read by git as an OPTION rather than a ref, and whitespace or
   control characters are not legal ref names anyway. Reject them here so the
   sync layer only ever sees a usable name. `autoSync`/`autoSyncSeconds` are
   handled by the generic validators above. */

/**
 * The whole rule, over an already-trimmed name. Exported because attach
 * (git.ts) resolves a branch name from `git ls-remote --symref` — a string that
 * arrives from the network and reaches the same argv — and holding it to a
 * second, hand-copied version of this rule is exactly how the two would drift.
 */
export function validBranchName(name: string): boolean {
  if (typeof name !== "string" || !name) return false;
  if (name.startsWith("-")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) || name.includes("..") || name.endsWith(".lock")) return false;
  return true;
}

function validateGit(git: unknown): void {
  if (git == null) return;
  if (!isPlainObject(git)) throw new SettingsError("bad-git", "git must be an object.");
  if ("branch" in git && git.branch != null) {
    const b = git.branch;
    if (typeof b !== "string" || !b.trim())
      throw new SettingsError("bad-branch", "git.branch must be a non-empty string.");
    const name = b.trim();
    // the leading `-` is called out by name; validBranchName covers it too
    if (name.startsWith("-"))
      throw new SettingsError("bad-branch", "git.branch may not start with '-'.");
    if (!validBranchName(name))
      throw new SettingsError("bad-branch", `Not a valid git branch name: ${name}`);
  }
}

/**
 * `ai.baseUrl` is the address the server fires the AI credential at, unattended,
 * the moment settings are saved (the capability probe). An unvalidated string
 * meant `file://`, `gopher://` or a bare hostname were all accepted and probed.
 * http/https only, and it must parse.
 */
function validateAi(ai: unknown): void {
  if (ai == null) return;
  if (!isPlainObject(ai)) throw new SettingsError("bad-ai", "ai must be an object.");
  if ("baseUrl" in ai && ai.baseUrl != null) {
    const raw = ai.baseUrl;
    if (typeof raw !== "string") throw new SettingsError("bad-base-url", "ai.baseUrl must be a string.");
    const url = raw.trim();
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new SettingsError("bad-base-url", `Not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new SettingsError("bad-base-url", "ai.baseUrl must be an http:// or https:// URL.");
    }
  }
  /* Type only, deliberately no enum: `ai.model` is whatever the endpoint calls
     it and `ai.effort` is open by design (KEY_DOC). But an object or a number
     used to sail through both PUT and the file heal and be SERIALISED as
     `"[object Object]"` — a value that survives every boot, that the relay then
     sends forever, and that `atEffortFloor()` reads as past the floor, so the
     ladder skips the whole effort walk. git.branch has had this check all
     along; these are the same kind of free-text string. */
  for (const key of ["model", "effort"] as const) {
    if (!(key in ai) || ai[key] == null) continue;
    if (typeof ai[key] !== "string" || !String(ai[key]).trim())
      throw new SettingsError(`bad-${key}`, `ai.${key} must be a non-empty string.`);
  }
}

/**
 * `terminal.shell` becomes argv[0] of a `Bun.spawn` and `terminal.startupCwd`
 * becomes its `cwd`. Neither reaches a shell string, so there is no injection
 * to escape — but a relative path would resolve against whatever the server's
 * process happened to be started in, which is not a thing a user can reason
 * about. Absolute or empty; empty means the built-in default.
 */
function validateTerminal(terminal: unknown): void {
  if (terminal == null) return;
  if (!isPlainObject(terminal)) throw new SettingsError("bad-terminal", "terminal must be an object.");
  for (const key of ["shell", "startupCwd"] as const) {
    if (!(key in terminal) || terminal[key] == null) continue;
    const v = terminal[key];
    if (typeof v !== "string") throw new SettingsError(`bad-${key.toLowerCase()}`, `terminal.${key} must be a string.`);
    const trimmed = v.trim();
    if (!trimmed) continue; // "" is legal and means the default
    if (!trimmed.startsWith("/") || trimmed.includes("\0"))
      throw new SettingsError(`bad-${key.toLowerCase()}`, `terminal.${key} must be an absolute path (or empty for the default).`);
  }
  if ("password" in terminal && terminal.password != null && typeof terminal.password !== "string")
    throw new SettingsError("bad-password", "terminal.password must be a string.");
}

/**
 * One list, one spelling. Split on commas AND whitespace, drop the leading
 * dots people write out of habit, lowercase, and keep only what can actually be
 * a file extension — de-duplicated, in the order they were written.
 *
 * Exported because it is the WHOLE rule: the file heal, the PUT and the
 * browser's drop filter all have to agree on which extensions a dropped file
 * may have, and a second copy of "split on commas" is how they would stop
 * agreeing. `""` is a legal answer and means nothing may be dropped.
 */
export function normalizeExtensions(raw: string): string {
  const seen = new Set<string>();
  for (const token of String(raw).split(/[\s,]+/)) {
    const ext = token.replace(/^\.+/, "").toLowerCase();
    if (/^[a-z0-9]{1,16}$/.test(ext)) seen.add(ext);
  }
  return [...seen].join(", ");
}

/** Type only: the VALUE is a spelling, and `normalizeExtensions` heals it. */
function validateUpload(upload: unknown): void {
  if (upload == null) return;
  if (!isPlainObject(upload)) throw new SettingsError("bad-upload", "upload must be an object.");
  if ("extensions" in upload && upload.extensions != null && typeof upload.extensions !== "string")
    throw new SettingsError("bad-extensions", "upload.extensions must be a comma-separated string.");
}

function mergeOneLevel(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}

const SCALAR_ORDER = ["theme", "density", "colorScheme"];
const SECTION_ORDER = ["editor", "trash", "upload", "git", "secrets", "ai", "terminal"];

/* ---------- the file is the STARTUP surface, so it documents itself ----------
   settings.toml is how a fresh install is configured before anything has a UI:
   drop a file in, boot, done. That only works if the file says what every key
   is and what it may be, so the serializer emits the documentation rather than
   expecting a human to keep a hand-written template in sync with DEFAULTS.
   Every write regenerates these comments, so they can never go stale — and a
   hand-added comment of your own will not survive, which is the trade. */

const SECTION_DOC: Record<string, string> = {
  editor: "Editor behaviour.",
  trash: "Recoverable-delete retention. Expired entries are permanently removed by the scheduled sweep.",
  upload: "Files dropped onto the sidebar tree.",
  git: "Git sync. The remote itself is ordinary git config (`git remote add origin …`).",
  secrets: "Browser-side auto-lock policy for encrypted blocks. Applied by the crypto worker.",
  ai: "AI relay. The browser never talks to the endpoint; the server does.",
  terminal:
    'Backend command runner. The password is NOT here — only a scrypt hash, in .znotes/index.db. To set one on a fresh install add `password = "…"` below and start the server; it is hashed, stripped from this file and never committed. An existing password can only be changed from Settings.',
};

const KEY_DOC: Record<string, string> = {
  theme: "Stylesheet: modern | minimal | terminal.",
  density: "comfy | compact. Comfy is the everyday scale; compact is tighter still.",
  colorScheme: "system | dark | light. `system` follows the OS and repaints live.",
  "editor.autosaveSeconds": "Write to disk this long after you stop typing.",
  "editor.tabSize": "Spaces inserted by Tab in Raw mode, and the width used to display literal tab bytes.",
  "editor.clickToEdit": "Clicking rendered text jumps to that line in Raw.",
  "editor.confirmBeforeExit": "Ask before leaving edits that have not reached disk; off saves them first.",
  "editor.homeDoc":
    "Doc the vault button (top left) opens. Vault-relative path; empty means the first doc.",
  "trash.retentionDays": "Keep deleted docs this long before the scheduled permanent purge.",
  "upload.extensions":
    "Comma-separated extensions a dropped file may have. Anything else is refused before it is sent.",
  "git.branch": "Branch every sync commits to.",
  "git.autoSync": "Commit + push after saves settle; a rejected push pulls --rebase and retries.",
  "git.autoSyncSeconds": "Debounce: sync this long after the last change settles.",
  "secrets.idleLockMinutes": "Lock the vault after this much inactivity.",
  "secrets.hiddenLockMinutes": "Lock the vault after the tab has been hidden this long.",
  "secrets.sessionHours": "Hard ceiling on one unlocked session, activity or not.",
  "secrets.clipboardClearSeconds": "Clear a copied secret from the clipboard after this long.",
  "ai.baseUrl":
    "OpenAI-compatible endpoint you supply (POST {baseUrl}/responses); http:// or https:// only. Empty means the AI relay is off.",
  "ai.model": "Model id, as the endpoint names it.",
  "ai.effort": "Reasoning effort. The UI offers low | medium | high; an endpoint may accept more.",
  "ai.maxOutputTokens": "Cap on one reply.",
  "ai.contextBudgetTokens": "Cap on the context assembled from your notes.",
  "terminal.enabled": "Hard off-switch. Off also hides the run_command tool from the assistant.",
  "terminal.idleLockMinutes": "Re-lock the terminal after this much inactivity.",
  "terminal.shell": 'Absolute path to the shell, or "" for $SHELL (else /bin/sh).',
  "terminal.startupCwd": 'Absolute directory the first command starts in, or "" for the vault root.',
  "terminal.allowAiAutoRun":
    "Let the assistant run commands WITHOUT your per-command approval. Off by default: note text and fetched documents can carry injected instructions, and this is what stops them becoming a shell.",
};

/** `# what it is — bounds. Default: x.` for one key, or "" if nothing to say. */
function keyDoc(path: string, key: string): string {
  const bits: string[] = [];
  const doc = KEY_DOC[path];
  if (doc) bits.push(doc);
  const range = NUMBERS[path];
  if (range) bits.push(`${range.min}–${range.max} ${range.unit}, step ${range.step}.`);
  const def = path.includes(".") ? defaultAt(path) : (DEFAULTS as Json)[key];
  if (def !== undefined) bits.push(`Default: ${tomlValue(def)}.`);
  return bits.length ? `# ${bits.join(" ")}` : "";
}

function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(tomlValue).join(", ") + "]";
  return JSON.stringify(String(v));
}

function serializeToml(data: Json): string {
  const scalars = Object.keys(data).filter((k) => !isPlainObject(data[k]));
  const sections = Object.keys(data).filter((k) => isPlainObject(data[k]));
  const order = (known: string[], keys: string[]) => [
    ...known.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !known.includes(k)).sort(),
  ];

  const out: string[] = [
    "# z-notes settings — committed with the vault.",
    "#",
    "# This file is the STARTUP surface: hand-write it before first boot and the",
    "# server adopts it. Every key here is also editable at RUNTIME in Settings",
    "# (⌘,), which rewrites this file — so these comments are regenerated on",
    "# every write and your own will not survive. Out-of-range or unparseable",
    "# values are healed back to the default rather than refused, so a bad line",
    "# from another machine can never stop the app booting.",
    "#",
    "# FIRST-RUN CREDENTIALS. Credentials are deliberately absent below: they live",
    "# in .znotes/index.db only and are served masked. To configure one without",
    '# touching the UI, add `apiKey = "…"` to the ai section (or `token = "…"` to',
    // Deliberately no literal `[section]` header anywhere in this preamble:
    // anything scanning the file for a table (tests do; so will a user's sed)
    // must land on the real one, not on a line of prose.
    "# the git section) and start the server — it is absorbed into index.db and",
    "# stripped from this file on the next write, so it is never committed.",
    "",
  ];
  for (const k of order(SCALAR_ORDER, scalars)) {
    const doc = keyDoc(k, k);
    if (doc) out.push(doc);
    out.push(`${k} = ${tomlValue(data[k])}`);
  }
  for (const s of order(SECTION_ORDER, sections)) {
    out.push("");
    if (SECTION_DOC[s]) out.push(`# ${SECTION_DOC[s]}`);
    out.push(`[${s}]`);
    for (const k of Object.keys(data[s])) {
      const doc = keyDoc(`${s}.${k}`, k);
      if (doc) out.push(doc);
      out.push(`${k} = ${tomlValue(data[s][k])}`);
    }
  }
  out.push("");
  return out.join("\n");
}
