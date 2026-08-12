/* ============================================================
   ai-endpoint.ts — endpoint health under the AI relay (SPEC §8).

   Everything that answers "what is the configured endpoint, and what has it
   proven it can do?": the settings-derived config, the capability probe
   (research §7), the degradation ladder (research §7.4), the derived status
   the statusbar and the settings panel both render, and the announce
   bookkeeping that broadcasts it. State lives in four meta keys of the AI
   index — ai.probe / ai.lastCall / ai.degraded / ai.effortSteps.

   The seam is deliberately narrow: this module sees a settings slice
   (value/credential), the meta KV slice of the index, and callbacks — it
   never touches the vault, sessions, proposals, or an upstream turn. ai.ts
   owns the relay loop and keeps thin delegating methods (status(), metaAi(),
   probe(), announce(), onSettingsSaved(), onEffortChanged()) so the public
   surface server/index.ts routes against is unchanged.
   ============================================================ */

import type { AiIndex } from "./db.ts";
import { DEFAULTS, type Settings } from "./settings.ts";

const MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_CONTEXT_BUDGET = 200_000;
const PROBE_TIMEOUT_MS = 12_000;

/* ============================================================
   Endpoint status (statusbar + settings)

   ONE derivation, server-side, so the settings panel and the statusbar can
   never disagree — and so "reachable" always means an actual request that
   actually happened, never a hardcoded optimism. Two independent real signals
   feed it and the FRESHER one wins:

     - `ai.probe`    — the capability probe (research §7): runs at boot and on
                       every AI settings save, and on demand from the statusbar.
     - `ai.lastCall` — the outcome of the last real relay turn. A probe that
                       succeeded ten minutes ago must not keep claiming "ok"
                       after the endpoint died under a live turn, and vice
                       versa: a turn that just worked outranks a stale failure.
   ============================================================ */

type AiState = "ok" | "degraded" | "unreachable" | "unconfigured" | "unknown";

export interface AiStatus {
  state: AiState;
  /** the configured model, verbatim — never a guess */
  model: string;
  /** the effort ACTUALLY in use, i.e. after any effort rung */
  effort: string;
  /** one human sentence for the tooltip */
  message: string;
  /** ISO of the signal this state came from, or null when there is none */
  checkedAt: string | null;
  /** which signal decided it */
  source: "probe" | "call" | "config";
  configured: boolean;
  /* Deliberately NOT named `degraded`: `meta.ai.degraded` is the one place the
     API contract publishes the rung list, and a second key with the same name
     nested inside it would make "did anything degrade?" ambiguous to read. */
  downgrades: Array<{ id: Rung; message: string }>;
}

interface LastCall {
  ok: boolean;
  /** AiError code, or null on success */
  code: string | null;
  at: string;
}

/* ============================================================
   Degradation ladder (research §7.4)
   ============================================================ */

/** Ordered rungs. Each is permanent once taken, and surfaced in settings meta. */
export const LADDER = [
  "reasoning.summary",
  "store",
  "parallel_tool_calls",
  "max_output_tokens",
  "effort",
  "reasoning",
  "chat-completions",
] as const;
type Rung = (typeof LADDER)[number];

export const RUNG_LABEL: Record<Rung, string> = {
  "reasoning.summary": "reasoning summaries are off — no “thinking” affordance",
  store: "the endpoint rejected store:false",
  parallel_tool_calls: "the endpoint rejected parallel_tool_calls",
  max_output_tokens: "using max_tokens instead of max_output_tokens",
  effort: "reasoning effort was downgraded",
  reasoning: "reasoning is off entirely",
  "chat-completions": "fell back to /chat/completions — reasoning is OFF for tool calls",
};

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
const downgradeEffort = (e: string) => {
  const i = EFFORT_ORDER.indexOf(e);
  return i > 0 ? EFFORT_ORDER[i - 1] : "low";
};
/** `low` (or lower) is as far as the effort rung goes — below it the next rung
    drops `reasoning` entirely, so there is nothing left to downgrade. */
const atEffortFloor = (e: string) => EFFORT_ORDER.indexOf(e) <= 1;

/* `invalid_request_error` is deliberately NOT here. It is the `type` on nearly
   every OpenAI-family 400 — context-length overflow, a bad model name, a
   malformed input — not just an unknown-parameter rejection, and treating it as
   one made a single ordinary 400 walk the ENTIRE ladder in one turn (7 upstream
   POSTs re-sending the same oversized context) and strip the app of /responses
   and of reasoning permanently, since rungs are only cleared by a settings
   save. Research §7.4: "do not silently degrade an app whose whole premise is a
   pluggable endpoint." Match on evidence that a PARAMETER was refused. */
export const UNRECOGNIZED = /unrecognized|unsupported|unknown (?:field|param|argument)|not supported|unexpected keyword|extra fields|additional propert/i;

/** Fixed, upstream-byte-free classification of a probe response (finding: the
    probe fires the credential at an arbitrary `ai.baseUrl` and used to echo the
    first 200 bytes of whatever answered back through `meta.ai.probe.error`,
    turning a misconfiguration into a general-purpose read oracle). */
const classifyProbe = (status: number): string =>
  status === 401 || status === 403
    ? "the endpoint rejected the API key"
    : status === 404 || status === 405
      ? "the endpoint has no such route"
      : status === 429
        ? "the endpoint is rate-limiting"
        : status >= 500
          ? "the endpoint reported a server error"
          : status === 400
            ? "the endpoint refused the request shape"
            : "the endpoint refused the request";

const UNREACHABLE_PROBE = "the endpoint could not be reached";

/* ============================================================
   Deps — mirror of how ai.ts threads its own
   ============================================================ */

interface EndpointDeps {
  /** the settings seam — value/credential only, exactly AiDeps' slice minus
      the meta-provider hook, which stays with ai.ts */
  settings: Pick<Settings, "value" | "credential">;
  /** the meta KV slice of the AI index — the four ai.* keys above */
  meta: Pick<AiIndex, "getMeta" | "setMeta">;
  /** ai.ts's secret scrubber — no upstream error text is logged raw */
  scrub(text: string): string;
  log?(line: string): void;
  /**
   * Fired whenever the DERIVED endpoint status changes (a probe finished, a
   * relay call succeeded or failed, a rung was taken). server/index.ts broadcasts it
   * on /events so the statusbar tells the truth without polling.
   */
  onStatus?(status: AiStatus): void;
}

/* ============================================================
   AiEndpoint
   ============================================================ */

export class AiEndpoint {
  private probing: Promise<unknown> | null = null;

  constructor(private readonly deps: EndpointDeps) {}

  private log(line: string) {
    this.deps.log?.(line);
  }

  /* ---------------- settings-derived ---------------- */

  cfg() {
    const s = this.deps.settings;
    const baseUrl = String(s.value("ai.baseUrl", "")).trim().replace(/\/+$/, "");
    return {
      baseUrl,
      apiKey: s.credential("ai.apiKey") || "",
      model: String(s.value("ai.model", DEFAULTS.ai.model)),
      effort: String(s.value("ai.effort", "high")),
      maxOutputTokens: Number(s.value("ai.maxOutputTokens", MAX_OUTPUT_TOKENS)) || MAX_OUTPUT_TOKENS,
      budget: Number(s.value("ai.contextBudgetTokens", DEFAULT_CONTEXT_BUDGET)) || DEFAULT_CONTEXT_BUDGET,
    };
  }

  /* ---------------- degradation state ---------------- */

  degraded(): Rung[] {
    try {
      const raw = JSON.parse(this.deps.meta.getMeta("ai.degraded") || "[]");
      return Array.isArray(raw) ? raw.filter((r): r is Rung => (LADDER as readonly string[]).includes(r)) : [];
    } catch {
      return [];
    }
  }

  private setDegraded(rungs: Rung[]) {
    this.deps.meta.setMeta("ai.degraded", JSON.stringify([...new Set(rungs)]));
    // a rung IS a status change — an app whose premise is a pluggable endpoint
    // must never degrade without the statusbar saying so (research §7.4)
    this.announce();
  }

  /** How many levels the configured effort has been walked down so far. */
  private effortSteps(): number {
    const n = Number(this.deps.meta.getMeta("ai.effortSteps") || "0");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** Take the next rung; false when the ladder is exhausted. */
  stepDown(): Rung | null {
    const have = this.degraded();
    const next = LADDER.find((r) => !have.includes(r));
    if (!next) return null;

    /* `effort` is REPEATABLE. Research §7.4 spells the descent out as
       max → xhigh → high → drop `reasoning`, but a single-shot rung meant a
       gateway that supports only none|low|medium|high (the AI gateway — the
       shipped default base URL) went max → xhigh → reasoning-off, never trying
       `high`, the one value it accepts. Walk the scale one level per 400 and
       only record the rung — i.e. hand the ladder on to `reasoning` — once the
       scale has bottomed out. */
    if (next === "effort") {
      const before = this.effortInUse();
      if (!atEffortFloor(before)) {
        this.deps.meta.setMeta("ai.effortSteps", String(this.effortSteps() + 1));
        const after = this.effortInUse();
        if (atEffortFloor(after)) this.setDegraded([...have, "effort"]);
        this.log(`ai: degraded — effort ${before} → ${after}`);
        this.announce(); // the effort walk is not always a rung, but always a change
        return "effort";
      }
      this.setDegraded([...have, "effort"]); // already at the floor
      return this.stepDown();
    }

    this.setDegraded([...have, next]);
    this.log(`ai: degraded — ${next} (${RUNG_LABEL[next]})`);
    return next;
  }

  /**
   * Jump straight to one rung, skipping the ones above it. An endpoint that has
   * no `/responses` at all (404/405) has not rejected `reasoning.summary` or
   * `store` — recording those on the way down would be a lie about what the
   * endpoint refused, so only the rung that actually applies is stored.
   */
  forceRung(rung: Rung): boolean {
    const have = this.degraded();
    if (have.includes(rung)) return false;
    this.setDegraded([...have, rung]);
    this.log(`ai: degraded — ${rung} (${RUNG_LABEL[rung]})`);
    return true;
  }

  /** The effort actually in use, i.e. the configured one after any walk. */
  effortInUse(): string {
    const { effort } = this.cfg();
    const have = this.degraded();
    if (have.includes("chat-completions") || have.includes("reasoning")) return "none";
    let e = effort;
    for (let i = this.effortSteps(); i > 0 && !atEffortFloor(e); i--) e = downgradeEffort(e);
    return e;
  }

  /* ============================================================
     Status — see the AiStatus comment above
     ============================================================ */

  probeRecord(): any {
    try {
      return JSON.parse(this.deps.meta.getMeta("ai.probe") || "null");
    } catch {
      return null;
    }
  }

  private lastCall(): LastCall | null {
    try {
      const raw = JSON.parse(this.deps.meta.getMeta("ai.lastCall") || "null");
      return raw && typeof raw.at === "string" ? (raw as LastCall) : null;
    } catch {
      return null;
    }
  }

  /**
   * Record how a real relay call actually ended. This is the signal that keeps
   * the statusbar honest between probes: the probe is a snapshot, a turn is the
   * thing the user is actually waiting on.
   */
  noteCall(ok: boolean, code: string | null) {
    const prev = this.lastCall();
    this.deps.meta.setMeta("ai.lastCall", JSON.stringify({ ok, code, at: new Date().toISOString() } satisfies LastCall));
    // only announce when the OUTCOME flipped — a working endpoint must not emit
    // one broadcast per turn forever
    if (!prev || prev.ok !== ok || prev.code !== code) this.announce();
  }

  /** Derive the one status both the settings panel and the statusbar render. */
  status(): AiStatus {
    const { baseUrl, apiKey, model } = this.cfg();
    const rungs = this.degraded();
    const downgrades = rungs.map((id) => ({ id, message: RUNG_LABEL[id] }));
    const effort = this.effortInUse();
    const configured = !!(baseUrl && apiKey);
    const base = { model, effort, configured, downgrades };

    if (!configured) {
      return {
        ...base,
        state: "unconfigured",
        message: !baseUrl
          ? "No AI base URL is configured — set one under Settings → AI."
          : "No AI API key is configured — set one under Settings → AI.",
        checkedAt: null,
        source: "config",
      };
    }

    const probe = this.probeRecord();
    const call = this.lastCall();
    /* A probe recorded against a DIFFERENT base URL or model is not evidence
       about the one configured now — the user may have just retyped it. */
    const probeFresh = probe && probe.probedAt && probe.baseUrl === baseUrl && probe.model === model;
    const probeAt = probeFresh ? String(probe.probedAt) : null;
    const callAt = call ? call.at : null;
    const newest: "probe" | "call" | null =
      probeAt && callAt ? (callAt >= probeAt ? "call" : "probe") : probeAt ? "probe" : callAt ? "call" : null;

    if (!newest) {
      return { ...base, state: "unknown", message: "The endpoint has not been checked yet.", checkedAt: null, source: "config" };
    }

    if (newest === "call") {
      if (!call!.ok) {
        return {
          ...base,
          state: "unreachable",
          message: `The last request to ${baseUrl} failed (${call!.code || "error"}).`,
          checkedAt: call!.at,
          source: "call",
        };
      }
      return {
        ...base,
        state: downgrades.length ? "degraded" : "ok",
        message: downgrades.length
          ? `Working, but downgraded — ${downgrades.map((d) => d.message).join("; ")}.`
          : `${model} · ${effort} — last request to ${baseUrl} succeeded.`,
        checkedAt: call!.at,
        source: "call",
      };
    }

    const reachable = !!probe.responses || !!probe.toolsWithReasoning;
    if (!reachable) {
      return {
        ...base,
        state: "unreachable",
        message: String(probe.error || "The endpoint could not be reached."),
        checkedAt: probeAt,
        source: "probe",
      };
    }
    /* Reachable but the capability this app is built on is missing: that is a
       real downgrade even before the ladder has had to fire. */
    if (!probe.toolsWithReasoning || downgrades.length) {
      const why = downgrades.length
        ? downgrades.map((d) => d.message).join("; ")
        : "the endpoint would not take tools together with reasoning";
      return { ...base, state: "degraded", message: `Working, but downgraded — ${why}.`, checkedAt: probeAt, source: "probe" };
    }
    return {
      ...base,
      state: "ok",
      message: `${model} · ${effort} — ${baseUrl} answered /responses with tools and reasoning.`,
      checkedAt: probeAt,
      source: "probe",
    };
  }

  /** Push the derived status out, but only when it actually changed. */
  private lastAnnounced = "";
  announce(force = false) {
    if (!this.deps.onStatus) return;
    let s: AiStatus;
    try {
      s = this.status();
    } catch {
      return;
    }
    const key = JSON.stringify(s);
    if (!force && key === this.lastAnnounced) return;
    this.lastAnnounced = key;
    this.deps.onStatus(s);
  }

  /* ============================================================
     Capability probe (research §7, "run on settings save")
     ============================================================ */

  /** Called by server/index.ts after PUT /api/settings when the AI block changed. */
  onSettingsSaved(): Promise<unknown> {
    // a new endpoint/model deserves a clean slate: keeping the old ladder would
    // permanently cripple a perfectly capable endpoint the user just configured
    this.setDegraded([]);
    this.deps.meta.setMeta("ai.effortSteps", "0");
    /* The outcome of the last call is evidence about the endpoint that was
       configured THEN. Carrying it across a base-URL/key/model change would let
       a dead old endpoint keep a freshly configured one marked unreachable
       (and vice versa) until the next turn. */
    this.deps.meta.setMeta("ai.lastCall", "");
    this.announce();
    return this.probe();
  }

  /**
   * Called by server/index.ts after PUT /api/settings when `ai.effort` itself changed.
   *
   * Re-picking an effort in Settings is a DIRECT instruction about the value the
   * ladder walked down from, so it has to undo that walk — otherwise Settings ›
   * AI paints the chosen value while the statusbar chip and every upstream body
   * still carry the downgraded one, with no way back except editing the
   * endpoint triple (the only thing that used to call onSettingsSaved). The
   * `effort` rung is dropped with the steps: it only ever means "the effort
   * scale bottomed out", which is no longer true of a freshly chosen value.
   *
   * Deliberately NOT a re-probe: effort cannot change what the endpoint is
   * capable of, and the probe is a network round-trip. The rungs recorded for
   * OTHER parameters stay — they are still evidence about this endpoint.
   */
  onEffortChanged(): void {
    this.deps.meta.setMeta("ai.effortSteps", "0");
    this.setDegraded(this.degraded().filter((r) => r !== "effort")); // announces
    this.announce();
  }

  /**
   * Probe at boot (server/index.ts), NOT awaited.
   *
   * Without this the shipped default endpoint was never verified at all: the
   * probe only ran from PUT /api/settings, and only when `ai.baseUrl`/`ai.model`
   * /`ai.apiKey` actually CHANGED. The intended initial-setup path — a
   * hand-written `settings.toml` whose credential `load()` absorbs at boot —
   * changes nothing afterwards, so `meta.ai.probe` stayed `null` forever on a
   * perfectly working configuration and the app could not say whether its own
   * endpoint was alive. A probe is two small requests; boot does not wait on it.
   */
  probeAtBoot(): void {
    const { baseUrl, apiKey } = this.cfg();
    if (!baseUrl || !apiKey) {
      this.announce(true); // "not configured" is a status worth stating too
      return;
    }
    this.announce(true);
    this.probe().catch(() => {});
  }

  probe(): Promise<unknown> {
    if (this.probing) return this.probing;
    const run = this.runProbe()
      .catch((err) => ({ error: String((err as Error)?.message || err) }))
      .then((out) => {
        this.deps.meta.setMeta("ai.probe", JSON.stringify({ ...(out as object), probedAt: new Date().toISOString() }));
        this.probing = null;
        /* A fresh probe SUPERSEDES an older call outcome, but `status()` picks
           the newest timestamp — and a probe that ran in the same millisecond
           as the last call would lose the tie. Clearing a STALE call record
           here would throw away real evidence, so instead the probe simply
           announces and lets the ordering rule stand. */
        this.announce();
        return out;
      });
    this.probing = run;
    return run;
  }

  private async runProbe() {
    const { baseUrl, apiKey, model } = this.cfg();
    const out: Record<string, unknown> = {
      baseUrl,
      model,
      configured: !!(baseUrl && apiKey),
      modelListed: null,
      responses: false,
      toolsWithReasoning: false,
      error: null,
    };
    if (!baseUrl) {
      out.error = "no base URL configured";
      return out;
    }

    const call = async (path: string, body: unknown | null) => {
      const res = await fetch(baseUrl + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      return { status: res.status, text };
    };

    // 1. is the model listed?
    try {
      const r = await call("/models", null);
      if (r.status === 200) {
        out.modelListed = r.text.includes(`"${model}"`) || r.text.includes(model);
      }
    } catch {
      /* a proxy without /models is not a failure — step 2 is the real test */
    }

    // 2. does /responses answer at all?
    try {
      const r = await call("/responses", {
        model,
        input: "ping",
        max_output_tokens: 16,
        stream: false,
        reasoning: { effort: "none" },
      });
      out.responses = r.status >= 200 && r.status < 300;
      if (!out.responses) out.error = `POST /responses → ${r.status}: ${classifyProbe(r.status)}`;
      // research §7 step 2: 404/405 ⇒ this endpoint is chat-completions only
      if (r.status === 404 || r.status === 405) this.forceRung("chat-completions");
    } catch (err) {
      out.error = UNREACHABLE_PROBE;
      this.log(`ai: probe POST /responses failed — ${this.deps.scrub(String((err as Error)?.message || err))}`);
    }

    // 3. tools + reasoning together — the whole reason this app uses /responses
    if (out.responses) {
      try {
        const r = await call("/responses", {
          model,
          input: "ping",
          max_output_tokens: 16,
          stream: false,
          reasoning: { effort: "high" },
          tools: [
            {
              type: "function",
              name: "z_probe",
              strict: true,
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              },
            },
          ],
          tool_choice: "auto",
        });
        out.toolsWithReasoning = r.status >= 200 && r.status < 300;
        if (!out.toolsWithReasoning) out.error = `tools+reasoning → ${r.status}: ${classifyProbe(r.status)}`;
      } catch (err) {
        out.error = UNREACHABLE_PROBE;
        this.log(`ai: probe tools+reasoning failed — ${this.deps.scrub(String((err as Error)?.message || err))}`);
      }
    }
    return out;
  }
}
