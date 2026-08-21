/* ============================================================
   chat.js — the AI chat panel and the ⌘K palette.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, I, apiFail, cap, el, esc, inline, toast, vaultOf } from "./ui.js";
import { renderDiff } from "./dialogs.js";
import { autoGrow, openDoc, renderDoc, saveDoc, setBaseline, syncRaw } from "./editor.js";
import { closeSess, isOpen } from "./shell.js";
import { commandCard, upsertCommand } from "./terminal.js";

/* ============================================================
   AI CHAT
   ============================================================ */
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const proposalById = (id) => state.proposals.filter((p) => p.id === id)[0];

export function updateSessionUI() {
  const s = state.session;
  if (!s) return;
  /* the relay strips parameters the endpoint rejects rather than failing the
     turn (research §7.4) — but a pluggable-endpoint app must never degrade
     SILENTLY, so every downgrade shows up on the model chip */
  const chip = $(".model-chip");
  if (chip) {
    const d = s.degraded || [];
    chip.classList.toggle("degraded", d.length > 0);
    /* the fallback is the menu affordance, not "" — this repaint runs on the
       first session load and must not erase the chip's only textual hint */
    chip.title = d.length ? "Endpoint downgraded — " + d.map((x) => x.message).join(" · ") : "Reasoning effort";
  }
  $("#sessCount").textContent = s.messageCount;
  $("#sessCountWord").textContent = s.messageCount === 1 ? "msg" : "msgs";
  $("#sessTok").textContent = fmtTok(s.tokensEstimated);
  $("#popMsgs").textContent = s.messageCount + (s.messageCount === 1 ? " message" : " messages");
  $("#popTok").textContent = "~" + fmtTok(s.tokensEstimated) + " tokens";
  $("#sessId").textContent = s.id;
  $("#popModel").textContent = s.model + " · " + s.effort;
  $("#modelName").textContent = s.model;
  $("#modelEffort").textContent = s.effort;
  const mins = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
  $("#popStart").textContent = mins < 1 ? "just now" : mins + " min ago";
  const pct = Math.min(100, (s.tokensEstimated / s.contextWindow) * 100);
  $("#ctxFill").style.width = Math.max(1.5, pct).toFixed(1) + "%";
  $("#ctxPct").textContent = (pct < 0.1 ? "<0.1" : pct.toFixed(1)) + "% of " + Math.round(s.contextWindow / 1000) + "k";
}

/* ============================================================
   EFFORT MENU — the model chip is a button; picking an effort
   PUTs ai.effort and repaints the chip from a session refetch, because the
   chip's contract is the server's effortInUse, not the configured value.
   The PUT is NEVER skipped when the pick equals the shown value: a patch
   that names ai.effort is the documented reset of the degradation ladder's
   effort walk (see putRoute's picksEffort branch in server/settings.ts).
   ============================================================ */
export function openEffort() {
  const host = $("#effortOpts");
  const cur = state.session ? state.session.effort : null;
  host.innerHTML = "";
  for (const eff of (state.meta && state.meta.efforts) || []) {
    const b = el("button", "eff-opt" + (eff === cur ? " on" : ""));
    b.type = "button";
    b.setAttribute("data-effort", eff);
    b.setAttribute("aria-pressed", eff === cur ? "true" : "false");
    b.textContent = cap(eff);
    b.addEventListener("click", () => pickEffort(eff));
    host.appendChild(b);
  }
  /* anchored under the CHIP, inline: .pop's static coordinates are #sessPop's
     slot (base.css), and this menu must hang off the button that opened it.
     Offsets are relative to .chat, the chip's offsetParent. */
  const chip = $("#modelChip");
  const pop = $("#effortPop");
  const w = 200;
  const max = chip.offsetParent ? chip.offsetParent.clientWidth : w + 16;
  pop.style.width = w + "px";
  pop.style.left = Math.max(8, Math.min(chip.offsetLeft, max - w - 8)) + "px";
  pop.style.right = "auto";
  pop.style.top = chip.offsetTop + chip.offsetHeight + 6 + "px";
  pop.classList.add("show");
  chip.setAttribute("aria-expanded", "true");
}

export function closeEffort() {
  const pop = $("#effortPop");
  /* focus back on the chip BEFORE the options go — but only when it was
     inside the menu, so an outside click keeps its own target's focus */
  if (pop.contains(document.activeElement)) $("#modelChip").focus();
  /* emptied, not just faded: .pop hides via opacity, which would leave the
     option buttons invisible-but-tabbable — one Enter away from a silent
     PUT that also resets the degradation ladder */
  $("#effortOpts").innerHTML = "";
  pop.classList.remove("show");
  $("#modelChip").setAttribute("aria-expanded", "false");
}

async function pickEffort(effort) {
  try {
    await api.patchSettings({ ai: { effort } });
    state.session = await api.getSession();
    updateSessionUI();
  } catch (err) {
    /* the chip stays as it was — it must never claim an effort the server
       did not accept */
    apiFail(err, "Could not change effort");
  }
  closeEffort();
}

let statsT;
export function refreshSessionStats() {
  clearTimeout(statsT);
  statsT = setTimeout(async () => {
    try {
      const s = await api.getSession();
      if (state.session) {
        state.session.messageCount = s.messageCount;
        state.session.tokensEstimated = s.tokensEstimated;
      }
      updateSessionUI();
    } catch (e) {}
  }, 250);
}

export function renderChat() {
  const host = $("#msgs");
  host.innerHTML = "";
  const s = state.session;
  if (!s) return;
  s.messages.forEach((m, idx) => {
    if (m.kind === "divider") {
      host.appendChild(el("div", "ctx-div", esc(m.content)));
      return;
    }
    const wrap = el("div", "msg " + (m.role === "user" ? "user" : "ai"));
    wrap.dataset.msg = m.id;
    wrap.style.animationDelay = Math.min(idx * 22, 220) + "ms";
    wrap.appendChild(el("div", "who", m.role === "user" ? "You" : s.model));
    /* the "thinking" affordance: reasoning summary deltas, which arrive long
       before the first token of prose does */
    if (m._streaming) {
      const think = el("div", "think");
      think.appendChild(el("span", "dots", "<i></i><i></i><i></i>"));
      const tx = el("span", "tx");
      tx.textContent = m._think || "Thinking…";
      think.appendChild(tx);
      wrap.appendChild(think);
    }
    const bubble = el("div", "bubble");
    bubble.innerHTML = inline(m.content);
    if (m._streaming && !m.content) bubble.hidden = true;
    wrap.appendChild(bubble);
    if (m.proposalId) {
      const p = proposalById(m.proposalId);
      if (p) wrap.appendChild(p.state === "rejected" ? dismissedCard(p) : diffCard(p));
    }
    /* Commands the assistant asked for in this message. Rendered here, under
       the prose that explains them, for the same reason a diff card is: the
       exact thing that would happen must be visible next to the reason. */
    state.commands.filter((c) => c.messageId === m.id).forEach((c) => wrap.appendChild(commandCard(c)));
    host.appendChild(wrap);
  });
  host.scrollTop = host.scrollHeight;
  renderStack();
  updateSessionUI();
}

function diffCard(p) {
  const card = el("div", "diffcard");
  card.dataset.prop = p.id;
  if (p.state === "applied") card.classList.add("applied");
  const head = el("div", "diff-head");
  head.innerHTML =
    I.doc + '<span class="f">' + esc(p.target) + "</span>" +
    '<span class="diff-stat"><span class="p">+' + p.stats.added + '</span><span class="m">−' + p.stats.removed + "</span></span>";
  const body = el("div", "diff-body");
  renderDiff(body, p.diff);
  const foot = el("div", "diff-foot");
  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);
  fillFoot(p, foot);
  return card;
}

function dismissedCard(p) {
  return el(
    "div",
    "dismissed",
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Suggestion dismissed · <span style="font-family:var(--mono);font-size:11px">' + esc(p.label) + "</span>"
  );
}

function fillFoot(p, foot) {
  foot.innerHTML = "";
  if (p.state !== "applied") {
    const acc = el("button", "btn primary sm", I.tick + " Accept");
    acc.addEventListener("click", () => acceptProposal(p.id));
    const rej = el("button", "btn sm", "Reject");
    rej.addEventListener("click", () => rejectProposal(p.id));
    const note = el("span", "note");
    note.style.marginLeft = "auto";
    note.textContent = p.summary;
    foot.appendChild(acc);
    foot.appendChild(rej);
    foot.appendChild(note);
    return;
  }
  const ok = el("span", "applied-note", I.tick + " Applied #" + p.stackIndex);
  const rev = el("button", "btn sm", I.undo + " Revert");
  if (p.revertable) {
    rev.style.marginLeft = "auto";
    rev.title = "Undo this change";
    rev.addEventListener("click", () => revertProposal(p.id));
    foot.appendChild(ok);
    foot.appendChild(rev);
    return;
  }
  rev.disabled = true;
  rev.title = "revert #" + state.stack.length + " first";
  const hint = el("span", "stack-hint", "revert #" + state.stack.length + " first");
  foot.appendChild(ok);
  foot.appendChild(hint);
  foot.appendChild(rev);
}

function refreshCards() {
  $$(".diffcard").forEach((card) => {
    const p = proposalById(card.dataset.prop);
    if (!p) return;
    card.classList.toggle("applied", p.state === "applied");
    const foot = $(".diff-foot", card);
    if (foot) fillFoot(p, foot);
  });
}

function renderStack() {
  const box = $("#stack"),
    list = $("#stackList"),
    msgs = $("#msgs");
  const pinned = msgs && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
  list.innerHTML = "";
  $("#stackCnt").textContent = state.stack.length;
  box.hidden = state.stack.length === 0;
  state.stack
    .slice()
    .reverse()
    .forEach((entry) => {
      const row = el("div", "stack-row" + (entry.revertable ? " top" : ""));
      row.innerHTML = '<span class="n">#' + entry.index + '</span><span class="lbl">' + esc(entry.label) + "</span>";
      const rev = el("button", "btn sm", "Revert");
      if (entry.revertable) {
        rev.title = "Undo change #" + entry.index;
        rev.addEventListener("click", () => revertProposal(entry.id));
      } else {
        rev.disabled = true;
        rev.title = "revert #" + state.stack.length + " first";
      }
      row.appendChild(rev);
      list.appendChild(row);
    });
  if (pinned && msgs) msgs.scrollTop = msgs.scrollHeight;
}

/** the one place a proposal enters or is refreshed in `state.proposals` */
function upsertProposal(p) {
  const i = state.proposals.findIndex((x) => x.id === p.id);
  if (i >= 0) state.proposals[i] = p;
  else state.proposals.push(p);
}

function absorbProposalResult(r) {
  if (r.proposal) upsertProposal(r.proposal);
  if (r.stack) state.stack = r.stack;
  /* the server is the authority on revertability — re-read it for every card */
  if (r.stack) {
    const top = r.stack.length ? r.stack[r.stack.length - 1].id : null;
    state.proposals.forEach((p) => {
      p.revertable = p.state === "applied" && p.id === top;
      const e = r.stack.filter((x) => x.id === p.id)[0];
      p.stackIndex = e ? e.index : p.state === "applied" ? p.stackIndex : null;
    });
  }
  if (r.doc) {
    const prev = state.docs.get(r.doc.path) || {};
    // setBaseline like every other adopt: an accept/revert rewrote the file on
    // disk, and a stale diskText made the Raw-exit guard diff against bytes
    // that no longer exist
    state.docs.set(r.doc.path, setBaseline(Object.assign({}, prev, r.doc, { loaded: true }), r.doc.markdown));
  }
}

/**
 * Accept and revert are the same nine steps in the same order — flush the
 * buffer, call, absorb, re-home or repaint, refresh the cards/stack/stats,
 * say so — so they are one function. Writing them twice meant a routing
 * decision they are supposed to SHARE (does `openDoc` push an entry? does a
 * dirty buffer save first?) lived in two places, free to drift.
 *
 * Only four things differ, and all four are here: which call, whether the
 * index in the toast comes from the reply or from the pre-call stack depth
 * (revert nulls `stackIndex`), the verb, and the scroll. The `not-stack-top`
 * branch is shared and inert for accept — LIFO is the SERVER's rule and only
 * `AI.revert()` can answer with that code.
 */
async function applyProposal(id, undo) {
  syncRaw();
  if (state.dirty) await saveDoc(state.active, { silent: true });
  try {
    const n = state.stack.length;
    const r = await (undo ? api.revertProposal(id) : api.acceptProposal(id));
    absorbProposalResult(r);
    if (r.doc && state.active !== r.doc.path) await openDoc(r.doc.path);
    else renderDoc();
    refreshCards();
    renderStack();
    refreshSessionStats();
    toast((undo ? "Reverted #" + n : "Applied #" + r.proposal.stackIndex) + " · " + r.proposal.label);
    if (!undo) {
      const sc = $("#scroll");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  } catch (err) {
    if (err && err.code === "not-stack-top") {
      toast(err.message);
      return;
    }
    apiFail(err, (undo ? "Revert" : "Accept") + " failed");
  }
}

const acceptProposal = (id) => applyProposal(id, false);
const revertProposal = (id) => applyProposal(id, true);

async function rejectProposal(id) {
  try {
    const r = await api.rejectProposal(id);
    absorbProposalResult(r);
    const card = $('.diffcard[data-prop="' + id + '"]');
    if (card) {
      card.style.opacity = "0";
      card.style.transform = "translateY(-4px)";
      setTimeout(() => card.replaceWith(dismissedCard(r.proposal)), 200);
    } else renderChat();
    toast("Suggestion dismissed");
  } catch (err) {
    if (err && err.code === "applied") {
      toast("Revert it first");
      return;
    }
    apiFail(err, "Reject failed");
  }
}

export async function loadProposals() {
  const r = await api.listProposals();
  state.proposals = r.proposals;
  state.stack = r.stack;
}

export async function loadSession() {
  state.session = await api.getSession();
}

export async function startNewSession() {
  try {
    // a turn still streaming belongs to the session being thrown away
    abortStream();
    state.session = await api.newSession();
    closeSess();
    renderChat();
    toast("Context cleared · new session");
  } catch (err) {
    apiFail(err, "Could not start a session");
  }
}

/* ---------------- streaming turn ----------------

   POST /api/ai/messages streams. Deltas paint into the live
   bubble; the terminal `done` event carries exactly the JSON the non-streaming
   contract returned, and it goes through `absorbTurn` — the same code the blob
   reply used — so the proposal card, the stack and the session stats have one
   completion path, not two. */

let streamCtl = null;
let tmpSeq = 0;

function abortStream() {
  if (!streamCtl) return;
  const c = streamCtl;
  streamCtl = null;
  c.abort(); // → fetch cancelled → server cancels its stream → upstream aborted
}

/** The completion path. Identical to what the non-streaming reply did. */
function absorbTurn(r) {
  const s = state.session;
  if (!r || !s) return;
  (r.messages || []).forEach((m) => s.messages.push(m));
  if (r.session) {
    s.messageCount = r.session.messageCount;
    s.tokensEstimated = r.session.tokensEstimated;
    s.degraded = r.session.degraded || null;
  }
  if (r.proposal) upsertProposal(r.proposal);
  /* The records only learn which message they belong under once the turn's
     prose has an id, so the authoritative copy arrives here, on `done`. */
  (r.commands || []).forEach(upsertCommand);
  renderChat();
}

export async function sendMessage() {
  const ta = $("#composer");
  const text = ta.value.trim();
  if (!text) return;
  const s = state.session;
  if (!s) return;
  ta.value = "";
  autoGrow(ta); // …and shrinks back: a sent prompt must not leave its own hole
  abortStream(); // a new message supersedes whatever is still arriving

  const uid = "tmp" + ++tmpSeq;
  const at = new Date().toISOString();
  const tmpUser = { id: uid + "u", role: "user", content: text, at };
  const tmpAi = { id: uid + "a", role: "assistant", content: "", proposalId: null, at, _streaming: true, _think: "" };
  s.messages.push(tmpUser, tmpAi);
  renderChat();

  const ctl = new AbortController();
  streamCtl = ctl;
  let acc = "";
  let think = "";
  let raf = 0;

  /* one paint per frame, not one per delta: a fast stream would otherwise
     re-parse inline markdown hundreds of times a second */
  const paint = () => {
    raf = 0;
    tmpAi.content = acc;
    tmpAi._think = think;
    const wrap = $('.msg[data-msg="' + uid + 'a"]');
    if (!wrap) return;
    const bubble = $(".bubble", wrap);
    if (bubble) {
      bubble.hidden = !acc;
      bubble.innerHTML = inline(acc);
    }
    const tx = $(".think .tx", wrap);
    if (tx) tx.textContent = think ? think.slice(-160) : acc ? "Writing…" : "Thinking…";
    const host = $("#msgs");
    if (host) host.scrollTop = host.scrollHeight;
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const drop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    s.messages = s.messages.filter((m) => m.id !== tmpUser.id && m.id !== tmpAi.id);
  };

  try {
    /* THE RELAY IS THE PRIMARY VAULT'S. Its context assembly, its search and
       its proposals all run on that one stack, so a doc in a secondary vault
       goes UNNAMED rather than naming a path the relay cannot open — the same
       shape a turn with no doc open already has. */
    const docPath = vaultOf(state.active) === "vault" ? state.active : null;
    const r = await api.sendMessageStream(text, docPath, {
      signal: ctl.signal,
      onText: (d) => {
        acc += d.delta;
        schedule();
      },
      onReasoning: (d) => {
        think = (think + d.delta).replace(/\s+/g, " ").slice(-400);
        schedule();
      },
      onToolArgs: () => {
        think = "Drafting edits…";
        schedule();
      },
      /* A run_command record, arriving mid-turn: queued for approval, or (when
         the user has switched auto-run on) already run. Absorbed as it lands so
         the card is there the instant the turn's prose is. */
      onCommand: (c) => {
        upsertCommand(c);
        think = c && c.state === "pending" ? "Asking to run a command…" : "Running a command…";
        schedule();
      },
      onError: (e) => toast((e && e.message) || "The assistant hit an error"),
    });
    if (streamCtl === ctl) streamCtl = null;
    drop();
    absorbTurn(r);
  } catch (err) {
    if (streamCtl === ctl) streamCtl = null;
    /* An abort is the user's own doing (new message, new session) — not a
       fault. But the SERVER keeps the aborted turn: the user message was
       persisted before the stream opened and runTurn's abort branch keeps the
       streamed partial as the assistant reply. Dropping both here left the
       thread missing a turn the backend holds — invisible now, back on reload,
       and replayed upstream as two consecutive user messages. Keep the same
       two messages the server kept. */
    if (err && err.name === "AbortError") {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      tmpAi.content = acc;
      tmpAi._streaming = false;
      tmpAi._think = "";
      // the server keeps the partial only when something streamed; mirror it
      if (!acc) s.messages = s.messages.filter((m) => m.id !== tmpAi.id);
      renderChat();
      return;
    }
    drop();
    renderChat();
    apiFail(err, "Message failed");
  }
}

/* ============================================================
   ⌘K PALETTE — server-side fuzzy search
   ============================================================ */
let palResults = [],
  palSel = 0,
  palAbort = null,
  palT = null;

function markUp(text, idx, window_) {
  let start = 0,
    str = text;
  if (window_ && text.length > window_ && idx.length) {
    start = Math.max(0, idx[0] - 18);
    str = text.slice(start, start + window_);
  }
  const set = {};
  idx.forEach((i) => (set[i - start] = true));
  let out = "";
  for (let i = 0; i < str.length; i++) out += set[i] ? "<mark>" + esc(str[i]) + "</mark>" : esc(str[i]);
  return (start > 0 ? "…" : "") + out + (start + str.length < text.length ? "…" : "");
}

function renderPal() {
  const list = $("#palList");
  list.innerHTML = "";
  $("#palCount").textContent =
    (palResults.length ? palResults.length + " result" + (palResults.length > 1 ? "s" : "") : "") +
    (palPartial ? (palResults.length ? " · " : "") + "partial" : "");
  if (!palResults.length) {
    /* a pattern mid-typing is not a failed search — say what is wrong with it
       and let the next keystroke fix it, rather than "nothing matched" */
    list.appendChild(
      palInvalid ? el("div", "pal-empty bad", "Not a pattern yet — " + palInvalid) : el("div", "pal-empty", "No docs or lines match that.")
    );
    return;
  }
  palResults.forEach((r, i) => {
    const b = el("button", "pal-item" + (i === palSel ? " sel" : ""));
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === palSel ? "true" : "false");
    const ico = r.kind === "doc" ? I.file : I.search;
    let html =
      '<span class="pico">' + ico + '</span><span class="col">' +
      '<span class="nm">' + esc(r.name) +
      '<span class="pth">' + (r.kind === "doc" ? markUp(r.text, r.matches, 0) : esc(r.path)) + "</span></span>";
    if (r.kind === "line") html += '<span class="sn">' + markUp(r.text, r.matches, 96) + "</span>";
    html += "</span>";
    if (r.kind === "line") html += '<span class="ln">L' + (r.line + 1) + "</span>";
    b.innerHTML = html;
    b.addEventListener("click", () => palOpen(i));
    b.addEventListener("mousemove", () => {
      if (palSel === i) return;
      palSel = i;
      $$(".pal-item", list).forEach((x, j) => x.classList.toggle("sel", j === i));
    });
    list.appendChild(b);
  });
}

/* ---------- search mode (ADR 0028) ----------

   Two ways to say the same thing, and they must never disagree on screen. A
   `/pattern/flags` query is self-describing, so it WINS: while the box holds
   one, the search is a regex whatever the chips last said, and the chips say
   so. Anything else is the toggle's to decide. The server is still the one
   that reads the query — the chips are painted from the mode it answers with,
   never from a guess made here. */
const SLASHED = /^\/(.*)\/[a-z]*$/s;
/** what the CHIPS were last told to mean — never overwritten by a detected
    mode, or unwrapping `/foo/` back to `foo` would leave regex silently on */
let palToggle = "fuzzy";
/** "read THIS query literally, slashes and all" — set by clicking the fuzzy
    chip, cleared by the next edit, so it never outlives the query it was for */
let palForceFuzzy = false;
let palInvalid = null;
/** the server ran out of budget before it ran out of vault — say so rather
    than letting a truncated sweep look like the whole answer */
let palPartial = false;

function paintPalModes(mode) {
  $("#palFuzzy").classList.toggle("on", mode !== "regex");
  $("#palRegex").classList.toggle("on", mode === "regex");
  const foot = $("#palFoot");
  if (foot) foot.textContent = "GET /api/search · " + mode;
}

/**
 * A chip was clicked. Clicking `fuzzy` while the box holds `/…/` has to mean
 * something, and what it means is "search that text literally" — so the query
 * is sent with `mode=fuzzy` rather than rewritten. Unwrapping it to `foo` was
 * the other option and it silently ate characters: `/x/i` came back as `x`.
 *
 * The intent lasts until the query changes. That way the next `/…/` someone
 * TYPES still lights the regex chip by itself, which is the whole point of the
 * slash form, while the click still wins over the query it was aimed at.
 */
export function palSetMode(mode) {
  /* a keystroke from moments ago still has a query armed; let it land after
     this one and it would repaint the chips from the mode we just left */
  clearTimeout(palT);
  palToggle = mode;
  palForceFuzzy = mode === "fuzzy";
  paintPalModes(mode);
  palQuery($("#palInput").value.trim());
  $("#palInput").focus();
}

async function palQuery(q) {
  if (palAbort) palAbort.abort();
  palAbort = new AbortController();
  try {
    /* only FORCE the mode where the query does not already say it, or where the
       user has just said otherwise about this exact query */
    const forced = palForceFuzzy ? "fuzzy" : palToggle === "regex" && !SLASHED.test(q) ? "regex" : null;
    const r = await api.search(q, { mode: forced, signal: palAbort.signal });
    palResults = r.results;
    palInvalid = r.invalid || null;
    palPartial = !!r.partial;
    /* painted from the mode the SERVER answered with — the one that actually
       produced these results */
    paintPalModes(r.mode || "fuzzy");
    palSel = 0;
    renderPal();
    $("#palList").scrollTop = 0;
  } catch (err) {
    if (err && err.name === "AbortError") return;
    apiFail(err, "Search failed");
  }
}

export function palMove(d) {
  if (!palResults.length) return;
  palSel = (palSel + d + palResults.length) % palResults.length;
  renderPal();
  const sel = $(".pal-item.sel");
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}

export function palOpen(i) {
  const r = palResults[i == null ? palSel : i];
  if (!r) return;
  closePal();
  openDoc(r.path, r.kind === "line" ? { line: r.line } : null);
}

export function openPal() {
  if (isOpen("#palVeil")) return;
  $("#palVeil").classList.add("show");
  const inp = $("#palInput");
  inp.value = "";
  /* the palette opens the way it was left LAST time in one respect only — the
     chip — and forgets everything about the query that is now gone */
  palForceFuzzy = false;
  palInvalid = null;
  palPartial = false;
  clearTimeout(palT);
  paintPalModes(palToggle);
  palQuery("");
  setTimeout(() => inp.focus(), 40);
}
export function closePal() {
  $("#palVeil").classList.remove("show");
  const inp = $("#palInput");
  if (inp && document.activeElement === inp) inp.blur();
}

/** The palette input's debounce — owned here so `palT` stays module-local;
    wiring only registers it. */
export function palInputChanged(e) {
  const q = e.target.value.trim();
  /* a new query is a new question: the "read this literally" the fuzzy chip
     set was about the old one, and must not outlive it */
  palForceFuzzy = false;
  clearTimeout(palT);
  palT = setTimeout(() => palQuery(q), 90);
}
