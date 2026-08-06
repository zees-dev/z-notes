/* ============================================================
   settings.js — the settings page, draft model, look pipeline, AI status.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, apiFail, el, esc, toast } from "./ui.js";
import { refreshTrash } from "./trash.js";
import { autoGrow, guardRawExit, openDoc, syncRaw } from "./editor.js";
import { applyLockPolicy, clearKeyFields, clearTerminalSecretFields, initSecrets, paintVaultKey } from "./secrets.js";
import { updateSessionUI } from "./chat.js";
import { SETTINGS_SECTIONS, app, canPopBack, closeNav, homeTarget, isDrawer, isTriPane, paintHome, routeSettings, toggleChat } from "./shell.js";
import { paintTerminal, refreshTerminalStatus } from "./terminal.js";

/* ============================================================
   SETTINGS
   ============================================================ */
function buildSeg(host, items, current) {
  host.innerHTML = "";
  items.forEach((it) => {
    const b = el("button", it.id === current ? "on acc" : "", esc(it.label));
    b.dataset.v = it.id;
    host.appendChild(b);
  });
}
export function markSeg(host, value) {
  $$("button", host).forEach((b) => {
    b.classList.toggle("on", b.dataset.v === value);
    b.classList.toggle("acc", b.dataset.v === value);
  });
}

/* The pre-paint caches index.html reads. Same contract as `znotes.scheme`
   (see the comment there): a cache of what was last APPLIED, never a setting
   and never a default, rewritten on every apply so the server always wins.
   Without them the shell booted `minimal`/`comfy` and repainted into the real
   theme ~20ms later — on every single load, warm profile included, which is
   the exact failure the scheme resolver was written to avoid. */
export function cacheLook(key, value) {
  try {
    localStorage.setItem("znotes." + key, value);
  } catch (e) {
    /* private mode / storage disabled: the cache is an optimisation, not a
       dependency — the apply itself already happened */
  }
}

export function applyTheme(id, { cache = true } = {}) {
  const link = $("#theme-css");
  const href = "./themes/" + id + ".css";
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  document.documentElement.setAttribute("data-theme", id);
  /* cache:false for the ?theme= override — the cache predicts the NEXT boot,
     and the next boot uses the stored setting, not this URL */
  if (cache) cacheLook("theme", id);
  markSeg($("#themeSeg"), id);
}

export function applyDensity(id, { cache = true } = {}) {
  document.documentElement.setAttribute("data-density", id);
  /* cache:false while PREVIEWING an unsaved pick — see applyLook() */
  if (cache) cacheLook("density", id);
  markSeg($("#densitySeg"), id);
  const ta = $("#rawArea");
  if (ta) autoGrow(ta);
}

/* ---------- colour scheme ----------
   The second axis of the look: `data-theme` picks the stylesheet, `data-scheme`
   picks the palette inside it (base.css §1b). Three things have to move
   together or the page ends up half-dark:

     data-scheme       what every theme's palette keys off
     color-scheme      the UA half — form controls, native scrollbars, and the
                       canvas the page paints on. CSS carries it too (base.css
                       sets the property), but the <meta> is what the browser
                       reads before any stylesheet has loaded.
     znotes.scheme     the pre-paint cache index.html reads. NOT a stored
                       setting and not a default — see the comment there. The
                       server's value overwrites it on every apply, so a stale
                       cache costs one repaint at boot and nothing else.

   What the cache stores is the PREFERENCE ("system" | "dark" | "light"), not
   the scheme it resolved to. Caching the resolved value looks equivalent and is
   not: under `system` — the shipped default — it pins the palette the app
   happened to end on, so an OS that flipped while the app was closed boots into
   the stale one and snaps a frame later. The preference lets the <head> resolve
   the same way this function does, and `matchMedia` is synchronous and needs no
   network, so `system` is flash-free even on a profile that has never run the
   app. A pinned dark/light still costs one repaint on that very first load —
   there is no pre-network way to know a server-side setting — and none after.

   `system` is the only value that needs a listener: it is not a look, it is a
   subscription, and an OS that flips at sunset has to repaint a session that
   has been open since morning. The listener is attached while the setting is
   `system` and removed the moment it is not, so pinning dark cannot leave a
   stray follower behind. */
const schemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let osSchemeListener = null;

export function applyColorScheme(pref, { cache = true } = {}) {
  const resolved = pref === "system" ? (schemeMedia.matches ? "dark" : "light") : pref;
  const root = document.documentElement;
  root.setAttribute("data-scheme", resolved);
  /* the preference itself, for anything that needs to know WHY it is dark */
  root.setAttribute("data-scheme-pref", pref);
  const meta = $('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", resolved);
  try {
    /* the PREFERENCE, not `resolved` — see the header comment.
       cache:false for the ?scheme= override — the cache exists to predict the
       NEXT boot, and the next boot will use the stored setting, not this URL */
    if (cache) localStorage.setItem("znotes.scheme", pref);
  } catch {
    /* private mode / storage disabled: the cache is an optimisation, not a
       dependency — everything above already happened */
  }
  markSeg($("#schemeSeg"), pref);

  if (pref === "system" && !osSchemeListener) {
    /* cache:false: the OS flipping is not a decision the user made here, so it
       must not promote a merely PREVIEWED `system` into the pre-paint cache.
       When `system` really is the stored value the cache already says so. */
    osSchemeListener = () => applyColorScheme("system", { cache: false });
    schemeMedia.addEventListener("change", osSchemeListener);
  } else if (pref !== "system" && osSchemeListener) {
    schemeMedia.removeEventListener("change", osSchemeListener);
    osSchemeListener = null;
  }
}

/* ---------- numeric settings, entirely server-declared ----------
   `meta.numbers` carries {min,max,step,unit} per dotted path, so the bounds,
   the snap and the unit label all come from the backend — exactly as the theme
   list drives the theme control. Adding a numeric setting is a settings.ts +
   markup change; there is nothing to hard-code here. */

/**
 * The ONE reader for a dotted settings path — see the hard rule at the top of
 * this file ("NO settings defaults").
 *
 * Deliberately unguarded. `start()` awaits `api.getSettings()` and assigns
 * `state.settings` before wire(), initSecrets() or any render, and index.html
 * leaves the app hidden if that throws — which is why start() itself reads
 * `state.settings.theme` with no guard either. The values are guaranteed
 * present and in range: settings.ts healSections() restores a missing group
 * wholesale and healNumbers/coerceNumber clamps every NUMBERS path on load AND
 * on PUT. The `|| fallback` guards that used to sit at five call sites were
 * unreachable, and each carried its own stale copy of a server default.
 */
export function settingAt(path) {
  const [group, key] = path.split(".");
  const section = state.settings[group];
  return section ? section[key] : undefined;
}

function numberSpec(path) {
  return (state.meta && state.meta.numbers && state.meta.numbers[path]) || null;
}

/** Clamp + snap the way settings.ts does, so the field never shows a value the
    server would silently rewrite. */
export function coerceNumberSetting(path, raw) {
  const spec = numberSpec(path);
  const n = Number(raw);
  if (!spec) return Number.isFinite(n) ? n : null;
  if (!Number.isFinite(n) || n <= 0) return null; // let the server's default win
  const clamped = Math.min(spec.max, Math.max(spec.min, n));
  return Math.min(spec.max, spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step);
}

function paintNumbers() {
  $$("[data-num]").forEach((inp) => {
    const path = inp.dataset.num;
    const spec = numberSpec(path);
    if (spec) {
      /* deliberately NOT type=number: no theme styles a spin button, and three
         stylesheets' worth of new chrome is a poor trade for a stepper. The
         bounds are enforced by coerceNumberSetting on the way out and by
         settings.ts on the way in; `title` is how they are discoverable. */
      inp.setAttribute("inputmode", "numeric");
      inp.title = `${spec.min}–${spec.max} ${spec.unit}` + (spec.step > 1 ? `, in steps of ${spec.step}` : "");
      const unit = inp.parentNode && $(".unit", inp.parentNode);
      if (unit) unit.textContent = spec.unit;
    }
    /* the DRAFT, not the stored value — a repaint (arriving back on the page, a
       terminal status refresh) must not silently undo an edit the user made */
    const v = draftValue(path);
    if (v != null) inp.value = v;
  });
}

/** Every free-text draft field and every switch, painted from the DRAFT and
    addressed by the attribute in the markup — like `paintNumbers` above, and
    for the same reason: this table used to be written out at the binding, here,
    again in `paintTerminal` (which owned the other half of these very controls
    — the four switches were split 2/2 with nothing tying the halves together)
    and a fourth time in the §11 parity gate. Called from BOTH painters, because
    both are real entry points. `!!` rather than `!== false`: settings.ts
    materialises every boolean, so the served object always carries one. */
export function paintDraftFields() {
  $$("[data-draft]").forEach((n) => {
    const v = draftValue(n.dataset.draft);
    n.value = v == null ? "" : v;
  });
  $$("[data-sw]").forEach((sw) => sw.classList.toggle("on", !!draftValue(sw.dataset.sw)));
}

export function paintSettings() {
  const s = state.settings,
    m = state.meta;
  buildSeg($("#themeSeg"), m.themes, draftValue("theme"));
  buildSeg($("#densitySeg"), m.densities, draftValue("density"));
  buildSeg($("#schemeSeg"), m.colorSchemes.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), draftValue("colorScheme"));
  buildSeg($("#effortSeg"), m.efforts.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), draftValue("ai.effort"));
  paintNumbers();
  /* the placeholder is `meta.homeDocDefault`, not a literal here: the client
     hard-codes no default, the same rule the theme list and meta.numbers follow */
  $("#homeDoc").placeholder = m.homeDocDefault || "";
  paintDraftFields();
  paintHome();
  paintTerminal();
  /* the two CREDENTIAL fields are not draft state — they are painted from the
     server's mask, because the server's mask is all there is to paint */
  $("#gitToken").value = s.git.tokenMasked;
  $("#aiKey").value = s.ai.apiKeyMasked;
  paintSaveState();
  /* one call: paintAiStatus owns the chip AND (via paintEndpoint) the Settings
     note, so the two surfaces are painted from a single signal and cannot drift */
  paintAiStatus((m.ai && m.ai.status) || null);
}

/* ============================================================
   AI ENDPOINT STATUS — the statusbar item

   Truthful by construction: every field here is server-derived from real
   signals (`meta.ai.status`, see ai.ts) — the capability probe, the outcome of
   the last relay turn, and an on-demand re-probe when the item is clicked.
   Nothing is inferred in the browser and nothing is assumed; before any signal
   exists the state is `unknown` and the item says so rather than showing green.

   Updates arrive over the SAME /events stream the git chip uses (`ai-status`),
   pushed when the status actually changes. No timer, no polling.
   ============================================================ */
const AI_STATE_CLASSES = ["ok", "degraded", "unreachable", "unconfigured", "pending"];

export function paintAiStatus(st) {
  const el_ = $("#stAi");
  if (!el_) return;
  state.aiStatus = st || null;
  const txt = $("#stAiTxt");
  const cls = !st ? "pending" : st.state === "unknown" ? "pending" : st.state;
  AI_STATE_CLASSES.forEach((c) => el_.classList.toggle(c, c === cls));

  if (!st) {
    txt.textContent = "AI —";
    el_.title = "AI endpoint · status unknown";
    return;
  }
  /* the model and the effort ACTUALLY in use — `st.effort` is post-ladder, so a
     silent downgrade to a weaker effort shows up here rather than hiding behind
     the value in Settings */
  txt.textContent = st.state === "unconfigured" ? "AI not configured" : st.model + " · " + st.effort;
  const head =
    st.state === "ok"
      ? "AI endpoint reachable"
      : st.state === "degraded"
      ? "AI endpoint degraded"
      : st.state === "unreachable"
      ? "AI endpoint unreachable"
      : st.state === "unconfigured"
      ? "AI not configured"
      : "AI endpoint not checked yet";
  const when = st.checkedAt ? " (checked " + new Date(st.checkedAt).toLocaleTimeString() + ")" : "";
  el_.title = head + when + "\n" + (st.message || "") + "\nClick to re-check and open AI settings.";
  // the Settings › AI note says the same thing; repaint it from the same signal
  paintEndpoint();
}

/* Click = a REAL check, not a repaint: POST /api/ai/status re-probes the
   configured endpoint server-side and answers with the fresh verdict. Settings
   opens either way — a broken endpoint is exactly when you want the fields. */
export async function checkAiEndpoint() {
  const el_ = $("#stAi");
  openSettings("ai");
  if (!el_) return;
  el_.classList.add("busy");
  try {
    const r = await api.checkAiStatus();
    /* take the fresher capability block FIRST, then repaint once: paintAiStatus
       is the only thing that repaints AI-derived UI, and painting before this
       assignment would render the note from the meta we just superseded */
    if (r && r.ai && state.meta) state.meta.ai = r.ai;
    if (r && r.status) paintAiStatus(r.status);
  } catch (err) {
    /* the check itself failing is a same-origin problem, not an endpoint
       verdict — never let it repaint the dot into a lie */
    apiFail(err, "Could not check the AI endpoint");
  } finally {
    el_.classList.remove("busy");
  }
}

/**
 * THE way Settings opens — ⌘, the sidebar row, the AI statusbar chip, the
 * assistant's Run/Show-output buttons all come through here, so there is one
 * place that knows what opening Settings means. It is now a NAVIGATION: it
 * pushes `/settings` (or `/settings/<section>`) and paints the page. Nothing
 * else in this file shows the settings view without going through it.
 *
 * `section` is optional; with it the page scrolls to that group and flashes it,
 * which is the whole point of arriving from a statusbar item — and it is in the
 * URL, so the same arrival is a link somebody else can follow.
 */
export function openSettings(section) {
  /* Settings is a NAVIGATION, so it leaves the document behind exactly as a
     tree click does — and an unsaved Raw buffer gets the same question (SPEC
     §4). `showSettings` is deliberately NOT guarded: boot and popstate paint the
     page from an entry that already exists, and a dialog in front of either
     would be arguing with the address bar. */
  if (!guardRawExit(() => showSettings(section, {}))) return;
  showSettings(section, {});
}

/**
 * Paint the settings page. Separate from `openSettings` for exactly one reason:
 * a `popstate` and boot must show the page WITHOUT writing history (the entry
 * they are reacting to already exists), and that is the only difference.
 *
 * `opts.route === false` skips the history write; `opts.replace` reuses the
 * current entry instead of stacking one.
 */
export function showSettings(section, opts) {
  const o = opts || {};
  const sec = SETTINGS_SECTIONS.includes(String(section || "")) ? String(section) : "";
  /* the doc keeps its unsaved text either way, but the buffer must reach
     `state.docs` before the textarea leaves the DOM */
  if (state.view !== "settings") syncRaw();
  state.view = "settings";
  state.settingsSection = sec;
  app.classList.add("route-settings");
  if (o.route !== false) routeSettings(sec, o.replace);
  paintSettingsRoute();
  /* Re-entry re-shows the draft the last visit left behind, preview included:
     leaving does not discard (see exitSettings), so arriving must not pretend
     it did. Guarded, so a clean page repaints nothing — the controls are
     already right, and `?theme=` deep-linked straight at /settings must survive
     arriving here. */
  if (settingsDirty()) {
    paintSettings();
    applyLook(draftedLook(), { preview: true });
  }
  paintSaveState();
  /* The keyring line is the one row in this panel that is not a stored setting
     — it is live state (is there an identity, is it unlocked, which recipient),
     so it is repainted from the worker every time the page is shown rather than
     inherited from whatever the last paint happened to leave behind. */
  initSecrets().then(paintVaultKey, paintVaultKey);
  /* Settings is part of the PANE now, and two things can be lying across that
     pane when you arrive: the sidebar drawer (below W_DOCK) and the assistant,
     which is an overlay or a sheet at anything below W_TRIPANE. A modal used to
     float over both; a page cannot, so each is stood down at the width where it
     would actually be covering the page you just navigated to. Collapsing the
     chat keeps its draft — `toggleChat` is a CSS collapse, not an unmount — and
     it is `persist: false`, because a detour through Settings is not the user
     deciding they are done with the assistant. */
  if (isDrawer()) closeNav();
  if (!isTriPane() && app.classList.contains("chat-open")) toggleChat({ persist: false });
  const body = $("#settingsBody");
  const target = sec && $("#settingsGrp-" + sec);
  if (!target) {
    if (body) body.scrollTop = 0;
    return;
  }
  requestAnimationFrame(() => {
    try {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) {
      target.scrollIntoView();
    }
    target.classList.add("focused");
    setTimeout(() => target.classList.remove("focused"), 1600);
  });
}

/** the settings page's own chrome: which section is current, and the sidebar
    row that says "you are here" */
function paintSettingsRoute() {
  const on = state.view === "settings";
  const link = $("#settingsLink");
  if (link) {
    link.classList.toggle("on", on);
    link.setAttribute("aria-current", on ? "page" : "false");
  }
  $$("#settingsNav button").forEach((b) => {
    const cur = on && b.dataset.sec === state.settingsSection;
    b.classList.toggle("on", cur);
    /* the rail scrolls sideways on a phone, where `/settings/terminal` would
       otherwise arrive with its own tab off the right edge */
    if (cur) {
      try {
        b.scrollIntoView({ inline: "nearest", block: "nearest" });
      } catch (e) {
        /* pre-options scrollIntoView would scroll the whole page — skip it */
      }
    }
  });
  const view = $("#settingsView");
  if (view) view.setAttribute("aria-hidden", on ? "false" : "true");
}

/**
 * Stop showing the settings page. PAINT ONLY — it writes no history, because
 * every way out of Settings is already a navigation that owns its own entry:
 * Back (the entry under it), a tree click or ⌘K pick (`openDoc` pushes), or the
 * Back button (which spends the entry the arrival pushed).
 */
export function exitSettings() {
  if (state.view !== "settings") return;
  /* the page stays mounted, so leaving it is the only "close" it has: anything
     typed into a secret field — the vault passphrases OR the terminal's
     password and unlock inputs — must not outlive the visit */
  clearKeyFields();
  clearTerminalSecretFields();
  /* ---------- LEAVING WITH AN UNSAVED DRAFT ----------
     KEEP the draft, REVERT the preview, and SAY SO. The three exits from this
     page are browser Back, a tree/⌘K navigation and the header's Back button,
     and they all land here — but only one of them is a button we could have put
     a modal in front of. A confirm on a browser Back means catching a popstate
     that has already happened and pushing the entry back, which is how a page
     ends up fighting the history stack; and auto-reverting would be exactly the
     silent discard of edits the user believes they made. So nothing is thrown
     away: the draft survives, the toast says it survived, and re-entry (⌘, /
     ⌘/ / the sidebar row / a deep link) paints it again with Save still lit.

     The one thing that does NOT survive is the appearance PREVIEW. A theme is
     the whole app's look, and an unsaved pick must not become the look of a
     page the user is not even on — the preview is a tool for judging a theme
     while you are choosing it, not a half-applied setting. It comes back the
     moment Settings does.

     A reload IS a discard, because the draft is in memory — `beforeunload`
     (wired in `wire()`) is what makes that one loud instead of silent. */
  applyLook(draftedLook(), { preview: false });
  if (settingsDirty()) {
    const n = Object.keys(settingsDraft).length;
    toast(n + " settings change" + (n === 1 ? "" : "s") + " still unsaved — reopen Settings to Save or Discard");
  }
  state.view = "doc";
  state.settingsSection = "";
  app.classList.remove("route-settings");
  paintSettingsRoute();
  /* the pane is showing the doc again; a raw buffer that was mid-edit when
     Settings took over must be re-measured for the textarea's height */
  const ta = $("#rawArea");
  if (ta) autoGrow(ta);
}

/**
 * The Back button, and the only place that decides how leaving Settings meets
 * the history stack. It spends an entry that already exists whenever one does,
 * so a doc → Settings → Back round trip leaves the stack exactly as it found
 * it and FORWARD still gets you back to Settings — `state.settingsExit` says which
 * side of this entry that entry is on. Only when there is neither (a deep
 * link, a reload: Settings IS the entry the browser handed us) does leaving
 * navigate to the doc the pane kept and let that push.
 *
 * The `canPopBack` re-check is belt and braces: `history.back()` from the
 * bottom of our own stack does not leave Settings, it leaves the APP.
 */
export function leaveSettings() {
  if (state.view !== "settings") return;
  if (state.settingsExit === "back" && canPopBack(history.state)) {
    history.back();
    return;
  }
  if (state.settingsExit === "forward") {
    history.forward();
    return;
  }
  const path = state.active || homeTarget();
  exitSettings();
  if (path) openDoc(path);
}

/* `meta.ai` is server-declared capability: what the probe found at settings-save
   and every parameter the relay permanently gave up (research §7). Surfaced
   because an app whose whole premise is a pluggable endpoint must never degrade
   without saying so.

   Painted only from paintAiStatus, off `state.meta.ai` — whoever has fresher
   meta assigns it there first, so there is one place this is read from. */
function paintEndpoint() {
  const field = $("#aiEndpointField"),
    note = $("#aiEndpointNote");
  if (!field || !note) return;
  const cur = (state.meta && state.meta.ai) || null;
  if (!cur) {
    field.hidden = true;
    return;
  }
  const p = cur.probe;
  const bits = [];
  if (p && p.probedAt) {
    bits.push(p.responses ? "✓ /responses" : "✗ /responses");
    bits.push(p.toolsWithReasoning ? "✓ tools + reasoning" : "✗ tools + reasoning");
    if (p.error) bits.push(String(p.error).slice(0, 160));
  } else if (p) {
    bits.push("not probed yet");
  }
  const d = cur.degraded || [];
  let html = bits.length ? '<span class="mono">' + bits.map(esc).join(" · ") + "</span>" : "";
  if (d.length) {
    html +=
      (html ? "<br>" : "") +
      '<b style="color:var(--warn,#b26b00)">Degraded:</b> ' +
      d.map((x) => esc(x.message)).join("; ");
  }
  /* The derived status is the same sentence the statusbar's tooltip carries, so
     the two surfaces can never disagree — and it is present even before the
     first probe has landed, which is when "the field is simply blank" was most
     confusing. */
  const st = state.aiStatus || cur.status || null;
  if (st) {
    html =
      '<b class="ep-' +
      esc(st.state) +
      '">' +
      esc(st.state === "ok" ? "Reachable" : st.state[0].toUpperCase() + st.state.slice(1)) +
      "</b> — " +
      esc(st.message) +
      (html ? "<br>" + html : "");
  }
  note.innerHTML = html;
  field.hidden = !html;
}

/**
 * The IMMEDIATE write — one PUT, applied now.
 *
 * After the draft model below, this is no longer how a *setting* is changed:
 * it is how an OPERATION is performed. The two callers left are the credential
 * fields (the GitHub token and the AI key), and they are deliberately not
 * draft state — see the line drawn above `settingsDraft`.
 */
export async function pushSettings(patch) {
  try {
    const r = await api.patchSettings(patch);
    state.settings = r.settings;
    state.meta = r.meta;
    return r.settings;
  } catch (err) {
    apiFail(err, "Could not save settings");
    return null;
  }
}

/* ============================================================
   SETTINGS DRAFT — the buffered model behind the Save button

   Every control on this page used to PUT on its own keystroke, which meant a
   Save button would have had nothing left to save and a Cancel nothing left to
   undo. Settings is now a FORM: a control writes a local draft, Save writes the
   draft to the server in one PUT, and "no diff" and "nothing to do" are the
   same state — which is exactly what the Save button's `disabled` reads.

   The draft is a flat map of DOTTED PATH → pending value, never a copy of the
   settings object. Two consequences, both load-bearing:

     · the diff is the map itself. Setting a control back to the value the
       server has DELETES the entry, so flip-and-flip-back returns the button
       to disabled without a deep comparison anywhere;
     · the PUT carries exactly the keys that moved. Nothing re-sends a value the
       user never touched, so two tabs editing different sections cannot clobber
       each other, and `bad-model` can only ever be raised by a model the user
       actually typed.

   ---------- WHAT IS *NOT* DRAFT STATE ----------

   The line is "is this a value with a diff, or a thing that happens?" — and it
   is drawn at the API boundary, not at the visual one:

     · CREDENTIALS (`#gitToken`, `#aiKey`). They are write-only: the server
       serves a MASK, so the field's "current value" is not the value. There is
       nothing to diff against, an unsaved secret sitting in a draft is a secret
       held longer than it needs to be, and a Discard that silently reverted a
       key rotation would be a security surprise. They PUT on change, as before.
     · The TERMINAL PASSWORD (`#termNew`/`#termCurrent`/Set/Change) — same
       reasoning, plus the server hashes it: there is no value to come back.
     · The VAULT PASSPHRASE flow (Generate / Change / Lock). It never touches
       settings at all — it re-wraps `identity.age` in the crypto worker.
     · Every BUTTON that performs an action: unlock, lock, sync now, run a
       command, clear the console, re-probe the AI endpoint. A verb is not a
       setting; none of them has a "before" to revert to.

   All of those keep working exactly as they did, mid-draft, and none of them
   dirties the Save button.
   ============================================================ */

/** dotted path → pending value. Empty object ⟺ no diff ⟺ Save disabled. */
let settingsDraft = Object.create(null);

/** The value the SERVER has, for any path — including the three top-level ones
    (`theme`, `density`, `colorScheme`) that `settingAt` cannot address. */
export function savedValue(path) {
  const i = path.indexOf(".");
  return i < 0 ? state.settings[path] : settingAt(path);
}

/** …and the value the CONTROL should be showing: the draft if it has one. */
function draftValue(path) {
  return path in settingsDraft ? settingsDraft[path] : savedValue(path);
}

export function clearDraft(path) {
  delete settingsDraft[path];
}
export const settingsDirty = () => Object.keys(settingsDraft).length > 0;

/**
 * Flush the numeric field the caret is sitting in into the draft.
 *
 * The nine `[data-num]` controls record on `change` alone, because the clamp
 * and the step-snap rewrite `value` and doing that on every keystroke would
 * fight the typing. `change` fires on blur or Enter — and `⌘S` is neither, so
 * a field typed into and saved without leaving first had an EMPTY draft: the
 * save returned at its dirty guard with `preventDefault` already spent, the
 * pill said nothing was pending, and `beforeunload` stayed silent too. Every
 * other exit (clicking Save, a tree click, Escape) blurs first and was fine,
 * which is why only the chord lost the edit.
 *
 * Dispatching the control's own `change` rather than duplicating the coercion
 * keeps one implementation of the clamp/snap.
 */
export function commitFocusedNumber() {
  const n = document.activeElement;
  if (!n || !n.matches || !n.matches("[data-num]")) return;
  n.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Record a control's new value — or, if it is the value the server already has,
 * un-record it. That second half is the whole diff: it is what makes flipping a
 * switch and flipping it back leave the page as clean as it started.
 */
export function setDraft(path, value) {
  if (value === savedValue(path)) delete settingsDraft[path];
  else settingsDraft[path] = value;
  clearSettingsError();
  paintSaveState();
}

/** the flat draft, re-nested into the one-level patch PUT /api/settings takes */
function draftPatch() {
  const patch = {};
  Object.keys(settingsDraft).forEach((path) => {
    const i = path.indexOf(".");
    if (i < 0) {
      patch[path] = settingsDraft[path];
      return;
    }
    const group = path.slice(0, i);
    if (!patch[group]) patch[group] = {};
    patch[group][path.slice(i + 1)] = settingsDraft[path];
  });
  return patch;
}

export function paintSaveState() {
  const btn = $("#settingsSave");
  if (!btn) return;
  const n = Object.keys(settingsDraft).length;
  btn.disabled = n === 0;
  const dis = $("#settingsDiscard");
  if (dis) dis.hidden = n === 0;
  const pill = $("#settingsDirty");
  if (pill) {
    pill.hidden = n === 0;
    pill.textContent = n + " unsaved change" + (n === 1 ? "" : "s");
  }
}

/* The server answers a bad value with a TYPED code, and most of those codes
   name exactly one control. Map them, so the message lands under the field the
   user has to fix rather than in a toast that says "somewhere on this page". */
const SETTINGS_ERROR_FIELDS = {
  "unknown-theme": "#themeSeg",
  "unknown-density": "#densitySeg",
  "unknown-color-scheme": "#schemeSeg",
  "bad-effort": "#effortSeg",
  "bad-model": "#aiModel",
  "bad-base-url": "#aiBase",
  "bad-ai": "#aiBase",
  "bad-branch": "#gitBranch",
  "bad-git": "#gitBranch",
  "bad-home-doc": "#homeDoc",
  "bad-editor": "#homeDoc",
  "bad-shell": "#termShell",
  "bad-startupcwd": "#termCwd",
  "bad-terminal": "#termShell",
  "bad-auto-sync": "[data-sw='git.autoSync']",
  "bad-auto-sync-seconds": "[data-num='git.autoSyncSeconds']",
  "bad-retention-days": "[data-num='trash.retentionDays']",
};

export function clearSettingsError() {
  const box = $("#settingsErr");
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
  $$(".field.bad").forEach((f) => f.classList.remove("bad"));
  /* park it back in the head: one element, so it can never be orphaned inside a
     field whose error has been fixed */
  const head = $("#settingsView .sv-head");
  if (head && box.parentNode !== head.parentNode) head.parentNode.insertBefore(box, head.nextSibling);
}

/** Show a failed save where it happened, and leave the draft DIRTY — a value
    the server refused has not been saved, and the button must keep saying so. */
function showSettingsError(err) {
  const box = $("#settingsErr");
  if (!box) return;
  clearSettingsError();
  const code = (err && err.code) || "save-failed";
  const msg = (err && err.message) || "Could not save settings";
  box.textContent = msg + " (" + code + ")";
  box.hidden = false;
  const sel = SETTINGS_ERROR_FIELDS[code];
  const ctl = sel && $(sel);
  const field = ctl && ctl.closest(".field");
  if (field) {
    field.classList.add("bad");
    field.appendChild(box);
    try {
      field.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      field.scrollIntoView();
    }
  }
  toast(msg);
}

/**
 * THE save. One PUT carrying exactly the keys that moved; on success the draft
 * becomes the new baseline (the server's answer IS the baseline — it clamps,
 * trims and snaps) and the button goes disabled again.
 */
export async function saveSettings() {
  commitFocusedNumber();
  if (!settingsDirty()) return;
  const btn = $("#settingsSave");
  const paths = Object.keys(settingsDraft);
  const patch = draftPatch();
  if (btn) {
    btn.classList.add("busy");
    btn.disabled = true;
  }
  try {
    const r = await api.patchSettings(patch);
    state.settings = r.settings;
    state.meta = r.meta;
    settingsDraft = Object.create(null);
    clearSettingsError();
    /* repaint every control from the SERVER's answer, never from the draft: an
       out-of-range number comes back clamped and an untrimmed path trimmed, and
       a field must never keep a value that was not stored */
    paintSettings();
    applySavedSettings(paths);
    paintSaveState();
    toast("Settings saved");
  } catch (err) {
    /* a 0/network failure has no typed code, and `showSettingsError` says so
       rather than blaming a field */
    showSettingsError(err);
    paintSaveState();
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

/**
 * Live-apply, on SAVE. Every consumer that used to be poked by an individual
 * control's own PUT is poked here instead, from the stored values — so "no
 * restart" is still true, it just now happens once per Save rather than once
 * per keystroke.
 */
function applySavedSettings(paths) {
  const s = state.settings;
  // theme / density / colour scheme — re-applied WITH the pre-paint cache now
  applyLook(paths.filter((p) => LOOK_PATHS.indexOf(p) >= 0), { preview: false });
  applyLockPolicy(); // the crypto worker's idle / hidden / session clocks
  paintHome(); // editor.homeDoc — the vault button's target and title
  if (state.session) {
    state.session.effort = s.ai.effort;
    state.session.model = s.ai.model;
    updateSessionUI();
  }
  /* `terminal.enabled` / `shell` / `startupCwd` change what the SERVER will
     accept, not just what is stored — re-read the verdict rather than assume */
  if (paths.some((p) => p.indexOf("terminal.") === 0)) refreshTerminalStatus();
  if (paths.some((p) => p.indexOf("trash.") === 0)) refreshTrash();
}

/* ---------- settings that arrived from somewhere else ----------

   Every dotted path a settings payload addresses. The shape is fixed at one
   level (scalars at the top, scalar leaves in a group), which is the same shape
   `draftPatch` builds and `savedValue` reads — so this walk cannot disagree
   with them about what a path is. */
function settingPaths(s) {
  const out = [];
  Object.keys(s || {}).forEach((k) => {
    const v = s[k];
    if (v && typeof v === "object" && !Array.isArray(v)) Object.keys(v).forEach((k2) => out.push(k + "." + k2));
    else out.push(k);
  });
  return out;
}

const valueAt = (s, path) => {
  const i = path.indexOf(".");
  if (i < 0) return s ? s[path] : undefined;
  const g = s ? s[path.slice(0, i)] : null;
  return g ? g[path.slice(i + 1)] : undefined;
};

/** The paths whose STORED value actually moved between two payloads. */
function changedSettingPaths(before, after) {
  const seen = Object.create(null);
  const all = [];
  settingPaths(before)
    .concat(settingPaths(after))
    .forEach((p) => {
      if (seen[p]) return;
      seen[p] = true;
      all.push(p);
    });
  return all.filter((p) => valueAt(before, p) !== valueAt(after, p));
}

/**
 * ADOPT A SETTINGS PAYLOAD THIS CLIENT DID NOT WRITE.
 *
 * Settings are vault state, and a tab left open all day used to be the last
 * place to hear about them: they were read at boot and essentially never again,
 * so a theme, a home doc or an auto-lock policy changed on the phone left the
 * desktop painting AND ENFORCING the old one indefinitely, silently.
 *
 * The load-bearing part is the DIFF. The obvious implementation — re-apply
 * every appearance axis that is not currently drafted — reintroduces exactly
 * the regression recorded above `draftedLook()`: it stamps the stored theme
 * over a `?theme=` / `?scheme=` URL override, which is a this-page-load-only
 * look that is deliberately not a setting at all. Applying only the paths whose
 * saved value MOVED leaves an untouched axis untouched, so the override
 * survives — and it makes the saving client's own echo a no-op for free, since
 * `saveSettings` has already assigned the same values by the time this lands.
 */
export function adoptSettings(payload) {
  if (!payload || !payload.settings) return;
  /* …and an axis this page load was PINNED to by `?theme=` / `?scheme=` is not
     the vault's to move — see `urlPinnedLook`. */
  const changed = changedSettingPaths(state.settings, payload.settings).filter((p) => urlPinnedLook.indexOf(p) < 0);
  state.settings = payload.settings;
  if (payload.meta) state.meta = payload.meta;
  /* A LIVE DRAFT OUTRANKS AN INCOMING SAVE **ON THE PATHS IT ACTUALLY HOLDS**,
     because those are this user's own pending answer to the same question and
     they are looking at them. It does not outrank anything else: the guard used
     to be the GLOBAL `settingsDirty()`, so one unsaved density click made the
     tab permanently deaf to every incoming change — theme, auto-lock policy,
     terminal verdict — and `exitSettings` deliberately KEEPS a draft past the
     visit, so "permanently" was literal. Worse, the miss was unrepairable: Save
     applies only the paths THIS client drafted and Discard only the drafted
     look axes, so neither one ever reached the adopted path.

     Controls repaint either way — `paintSettings` reads `draftValue`, so a
     drafted field keeps the draft and every other field picks up the new stored
     value. */
  if (settingsDirty()) {
    /* …and the draft is re-diffed against the new baseline, or a field whose
       drafted value is now also the SAVED value would keep claiming to be an
       unsaved change. "Empty object ⟺ no diff" is the invariant this whole
       page rests on. Re-diffed FIRST, so a path the incoming save absorbed is
       no longer drafted and falls through to be applied below — otherwise a
       draft that emptied itself here left the app wearing the old value with
       neither Save nor Discard left to press. */
    Object.keys(settingsDraft).forEach((p) => {
      if (settingsDraft[p] === savedValue(p)) delete settingsDraft[p];
    });
    paintSettings();
    paintSaveState();
    const free = changed.filter((p) => !(p in settingsDraft));
    if (free.length) applySavedSettings(free);
    return;
  }
  if (!changed.length) return;
  paintSettings();
  applySavedSettings(changed);
}

/** Throw the draft away and put every control back on the stored value —
    including ENFORCING it. Discard used to re-apply only the drafted appearance
    axes, so a remote change that collided with a drafted auto-lock policy or
    terminal field was painted and never applied; `applySavedSettings` over the
    same drafted paths is the one call that covers every consumer, and it hands
    `applyLook` exactly the drafted look axes it was handed before. */
export function discardSettingsDraft() {
  if (!settingsDirty()) return;
  const paths = Object.keys(settingsDraft);
  const n = paths.length;
  settingsDraft = Object.create(null);
  clearSettingsError();
  paintSettings();
  applySavedSettings(paths);
  paintSaveState();
  toast("Discarded " + n + " unsaved change" + (n === 1 ? "" : "s"));
}

/**
 * APPEARANCE IS THE ONE GROUP THAT PREVIEWS.
 *
 * You cannot judge a theme, a density or a colour scheme from a label — the
 * only way to pick one is to look at the app wearing it. So these three paint
 * the moment they are clicked, while still being ordinary draft entries that
 * only Save persists.
 *
 * `preview` decides ONE further thing: whether the pre-paint localStorage cache
 * is written. That cache predicts the NEXT boot, and the next boot uses the
 * SAVED value — so a preview must never touch it, or leaving without saving
 * would leave the shell booting into a theme that was never stored and snapping
 * out of it a frame later. Leaving the page, saving and discarding all re-apply
 * with `preview: false`, which is what restores both the look and the cache.
 */
const LOOK_APPLIERS = { theme: applyTheme, density: applyDensity, colorScheme: applyColorScheme };
const LOOK_PATHS = Object.keys(LOOK_APPLIERS);

/** The appearance axes that are actually DRAFTED — read before any caller
    clears the draft. An axis nobody touched needs neither previewing nor
    restoring, and re-applying it anyway would stamp the stored value over the
    `?theme=` / `?scheme=` override, which is this-page-load-only and is
    deliberately not a setting at all: previewing a density used to snap the
    whole app out of a URL-previewed theme on the very first click. */
export const draftedLook = () => LOOK_PATHS.filter((p) => p in settingsDraft);

/**
 * THE APPEARANCE AXES THIS PAGE LOAD WAS PINNED TO BY THE URL.
 *
 * `?theme=` / `?scheme=` are a look-at-it override for ONE page load that is
 * deliberately not a setting at all (SPEC §9). The moved-paths diff in
 * `adoptSettings` protects an axis a remote save left alone; it cannot protect
 * the pinned axis when the remote save moves THAT one. MEASURED: a page opened
 * at `/?theme=terminal` over a stored `modern` booted pinned as intended and
 * then flipped to `minimal` — cache and all — the moment another device saved a
 * theme, so a kiosk, demo or screenshot tab silently changed appearance
 * mid-session. `start()` records the axes it honoured here and the adopt path
 * skips them.
 *
 * The pin is SPENT by this client applying the axis on purpose (a Save, a
 * Discard, leaving the page with a drafted look) — that is the user answering
 * the question the URL pre-answered, and a pin that outlived it would make the
 * tab permanently deaf to that axis instead.
 */
let urlPinnedLook = [];
export const pinLookFromUrl = (axes) => (urlPinnedLook = axes);

/** `axes` is the list to (re-)apply — the drafted ones on the way in and out of
    the page, the SAVED ones after a Save, when the draft is already gone. */
export function applyLook(axes, { preview }) {
  const at = preview ? draftValue : savedValue;
  const cache = !preview;
  for (const p of axes) {
    if (!preview) urlPinnedLook = urlPinnedLook.filter((a) => a !== p);
    LOOK_APPLIERS[p](at(p), { cache });
  }
}
