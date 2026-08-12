/* ============================================================
   terminal.js — the password-locked command runner panel.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, I, apiFail, el, esc, toast } from "./ui.js";
import { confirmDialog } from "./dialogs.js";
import { openSettings, paintDraftFields, showSettings } from "./settings.js";

/* ============================================================
   TERMINAL

   A password-locked streaming command runner, living in its own Settings
   section. Three things this file is careful about:

     1. THE TOKEN IS NOT HERE. api.js holds it; this module only ever learns
        booleans (`status.unlocked`, `status.ready`) from the server. There is
        no variable in app.js that could leak it into a note, a URL or a log.
     2. NOTHING IS INFERRED. Every lock/unlock/enabled/cwd fact painted below
        came from `GET /api/terminal/status` or from a command's own `exit`
        event. The panel never decides it is probably unlocked.
     3. IT SAYS WHAT IT CANNOT DO. There is no PTY, so the banner names the
        programs that cannot work here rather than letting one hang.
   ============================================================ */

/* Terminal-flavoured ANSI is noise without a renderer, so it is STRIPPED
   rather than painted: a real emulator is exactly the thing this cannot be
   (no PTY), and half-rendering colour codes would be a lie about that. CSI
   and OSC sequences, the two-byte escapes, and the C0 control bytes that
   are not tab/newline all go; a carriage return becomes a newline, so a
   progress bar reads as successive lines instead of one mangled one. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "").replace(/\r\n?/g, "\n");

/* …and stripping is per STREAM, not per chunk.
   `stripAnsi` is a stateless regex over whatever string it is handed, but
   stdout arrives as arbitrary pipe reads: an escape that straddles a chunk
   boundary is two halves, neither of which matches. The lone ESC at the end of
   chunk one was eaten as a C0 byte and `[31m` at the head of chunk two was
   then printed as literal text — "half-rendered", which is the one thing
   this runner promises it does not do. An OSC split the same way leaks its whole
   payload (a window title) into the scrollback.

   So a per-stream stripper holds back a trailing FRAGMENT — an unfinished
   escape, or a lone CR that may yet turn out to be the CR of a CRLF — and
   prepends it to the next chunk. The hold-back is capped: a program that emits
   a bare ESC and then megabytes of text must not buffer forever, and printing
   the fragment is the honest fallback. */
const ANSI_PENDING_RE = /(?:\x1b\][^\x07\x1b]*|\x1b\[[0-9;?]*[ -\/]*|\x1b|\r)$/;
const ANSI_PENDING_MAX = 64;

function ansiStream() {
  let pending = "";
  return {
    feed(text) {
      const all = pending + String(text);
      const m = ANSI_PENDING_RE.exec(all);
      if (m && all.length - m.index <= ANSI_PENDING_MAX) {
        pending = m[0];
        return stripAnsi(all.slice(0, m.index));
      }
      pending = "";
      return stripAnsi(all);
    },
    /* the command ended: whatever is still held back is all there will ever be */
    flush() {
      const rest = pending;
      pending = "";
      return rest ? stripAnsi(rest) : "";
    },
  };
}

/** One stripper per stream, reset when a command starts and when the pane is
    cleared — a fragment from a finished command is not a prefix of the next. */
let termAnsi = { out: ansiStream(), err: ansiStream() };
function termAnsiReset() {
  termAnsi = { out: ansiStream(), err: ansiStream() };
}
function termAnsiFlush() {
  for (const cls of ["out", "err"]) {
    const rest = termAnsi[cls].flush();
    if (rest) termPut(rest, cls);
  }
}

/**
 * The cwd, shortened for the one-line bar: inside the vault it is shown
 * relative to it, elsewhere the head is elided. The full path is always the
 * title, so nothing is ever only half-true.
 */
function paintCwd(cwd) {
  const bar = $("#termCwdLine");
  if (!bar || !cwd) return;
  const root = state.term.status && state.term.status.vaultRoot;
  let shown = cwd;
  if (root && (cwd === root || cwd.indexOf(root + "/") === 0)) shown = "«vault»" + cwd.slice(root.length);
  if (shown.length > 56) shown = "…" + shown.slice(-55);
  bar.textContent = shown;
  bar.title = cwd;
}

/** Put already-stripped text into the pane. The one DOM writer. */
function termPut(text, cls) {
  const out = $("#termOut");
  if (!out) return;
  const empty = $(".empty", out);
  if (empty) empty.remove();
  const pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const node = el("span", "l" + (cls ? " " + cls : ""));
  node.textContent = text;
  out.appendChild(node);
  if (pinned) out.scrollTop = out.scrollHeight;
}

/** Scrollback lines are appended, never re-rendered — output can be long.
    For COMPLETE strings (a prompt echo, a notice, a replayed record). */
export function termWrite(text, cls) {
  termPut(stripAnsi(text), cls);
}

/* stdout and stderr arrive as arbitrary chunks, not lines, so consecutive
   chunks of the same stream are merged into the trailing node rather than each
   becoming its own block — otherwise a progress line would stack vertically.
   Chunks go through the per-stream stripper, which is what makes an escape
   split across two of them still an escape. */
function termAppend(text, cls) {
  const out = $("#termOut");
  if (!out) return;
  const stream = termAnsi[cls];
  const clean = stream ? stream.feed(text) : stripAnsi(text);
  if (!clean) return;
  const last = out.lastElementChild;
  if (last && last.className === "l " + cls) {
    const pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    last.textContent += clean;
    if (pinned) out.scrollTop = out.scrollHeight;
    return;
  }
  termPut(clean, cls);
}

export function termClear() {
  const out = $("#termOut");
  if (!out) return;
  termAnsiReset();
  out.innerHTML = "";
  out.appendChild(el("div", "empty", esc("Nothing yet. Type a command below.")));
}

/** Repaint everything the terminal section shows, from `state.term.status`. */
export function paintTerminal() {
  const st = state.term.status;
  const s = state.settings.terminal || {};
  const line = $("#termState");
  const txt = $("#termStateTxt");
  if (!line || !txt) return;

  const enabled = st ? st.enabled : s.enabled !== false;
  const configured = st ? st.configured : !!s.passwordSet;
  const unlocked = !!(st && st.unlocked);

  line.classList.toggle("off", !enabled || !configured);
  line.classList.toggle("locked", enabled && configured && !unlocked);
  line.classList.toggle("unlocked", unlocked);
  txt.textContent = !enabled
    ? "Disabled — the Enable terminal switch is off."
    : !configured
    ? "Disabled — no terminal password is set, so nothing can run."
    : unlocked
    ? "Unlocked" + (st && st.expiresInMs != null ? " · re-locks after " + Math.round(st.expiresInMs / 60000) + " min idle" : "")
    : "Locked — enter the terminal password to run commands.";

  $("#termLockBtn").hidden = !unlocked;
  $("#termUnlockField").hidden = !(enabled && configured && !unlocked);
  $("#termConsole").hidden = !unlocked;

  /* The password field says which of the two jobs it is doing, and asks for
     the current password only when there is one to ask for. */
  $("#termPwLab").textContent = configured ? "Change terminal password" : "Terminal password";
  $("#termPwHint").textContent = configured
    ? "Leave the new password empty to remove it — that disables the terminal."
    : "Set one to enable the terminal. Independent of your vault passphrase; the server only stores a scrypt hash.";
  $("#termPwBtn").textContent = configured ? "Change" : "Set";
  $("#termCurrent").hidden = !configured || unlocked;

  /* the four SETTINGS on this panel are draft state, and this function is also
     called by every terminal STATUS refresh (unlock, lock, set password) — so
     it must repaint them from the draft or an action would quietly revert an
     edit the user is still holding */
  paintDraftFields();

  if (st) {
    paintCwd(st.cwd);
    $("#termNote").textContent = st.ptyNote;
  }
  paintTermStop();
  refreshCommandCards();
}

/**
 * What is running, according to the SERVER — with this tab's own in-flight
 * command as the fast path.
 *
 * The Stop button used to be gated on `state.term.running`, which is only ever
 * set by this tab's own `runTerminal`. Anything else — a second tab, or a
 * command the assistant auto-ran — left the console in a dead end: typing was
 * refused with "cancel it first (Ctrl+C)", and Ctrl+C was a documented no-op in
 * exactly that state, so the only ways out were the other tab or the 30-minute
 * wall clock. The server publishes the truth in `status.running`; this reads it.
 */
export const termRunningId = () => state.term.running || (state.term.status && state.term.status.running) || null;

function paintTermStop() {
  const btn = $("#termStopBtn");
  if (btn) btn.hidden = !termRunningId();
}

export async function refreshTerminalStatus() {
  try {
    state.term.status = await api.getTerminalStatus();
  } catch (err) {
    state.term.status = null;
  }
  paintTerminal();
  return state.term.status;
}

export async function terminalUnlock() {
  const inp = $("#termPass");
  const pass = inp.value;
  if (!pass) return toast("Enter the terminal password");
  try {
    state.term.status = await api.terminalUnlock(pass);
    inp.value = "";
    termClear();
    termWrite("Terminal unlocked. " + (state.term.status ? state.term.status.ptyNote : ""), "sys");
    paintTerminal();
    await loadCommands();
    $("#termInput").focus();
  } catch (err) {
    /* The server's own words: it deliberately answers the same way whether or
       not a password is set, and carries the backoff when there is one. */
    inp.value = "";
    toast(err.message || "Wrong terminal password");
    await refreshTerminalStatus();
  }
}

export async function terminalLock(why) {
  await api.terminalLock();
  state.term.status = await api.getTerminalStatus().catch(() => null);
  paintTerminal();
  toast(why ? "Terminal locked — " + why : "Terminal locked");
}

export function terminalSavePassword() {
  const configured = !!(state.term.status && state.term.status.configured);
  /* Clearing is destructive in the sense that matters — it disables the
     terminal and drops every session — so it goes through the same confirm
     dialog every other irreversible action uses (VEILS puts it above Settings,
     so Esc still unwinds in the right order). */
  if (configured && !$("#termNew").value) {
    confirmDialog({
      title: "Remove the terminal password?",
      path: "Settings › Terminal",
      body: "The terminal is disabled without one, every unlocked session ends, and the assistant loses the run_command tool.",
      ok: "Remove",
      /* the hash lives in .znotes/index.db, which is never committed —
         so the delete dialog's "recoverable from git history" is false here */
      note: "The stored hash is in .znotes/index.db, which git never sees — set a new one to re-enable it.",
      onOk: () => doSaveTerminalPassword(),
    });
    return;
  }
  doSaveTerminalPassword();
}

async function doSaveTerminalPassword() {
  const next = $("#termNew").value;
  const current = $("#termCurrent").value;
  try {
    const r = await api.terminalSetPassword(next, current);
    state.term.status = r.status;
    $("#termNew").value = "";
    $("#termCurrent").value = "";
    /* the settings object carries `passwordSet`, and it has just moved */
    const fresh = await api.getSettings();
    state.settings = fresh.settings;
    state.meta = fresh.meta;
    paintTerminal();
    toast(r.configured ? "Terminal password saved" : "Terminal password removed");
  } catch (err) {
    apiFail(err, "Could not save the terminal password");
  }
}

/**
 * Run one command and stream it into the scrollback.
 *
 * Shared by the prompt and by the Run button on an assistant's command card,
 * so an AI-run command lands in exactly the same place, in the same shape,
 * with the same output, as one the user typed. That is not decoration: it is
 * the guarantee that there is no path by which the assistant runs something
 * the user cannot see.
 */
async function runTerminal(command, opts) {
  const o = opts || {};
  if (state.term.busy) return toast("A command is already running — press Stop or Ctrl+C");
  state.term.busy = true;
  state.term.running = null;
  /* Streamed live below, so `echoCommand` must not replay it from the record
     when the notification for the same id comes back around. */
  if (o.commandId) state.term.printed.add(o.commandId);
  termWrite((o.byAi ? "[assistant] " : "") + "$ " + command, "cmd");
  termAnsiReset();
  $("#termStopBtn").hidden = false;
  const handlers = {
    onStart: (d) => {
      state.term.running = d.id;
      if (state.term.status) state.term.status.running = d.id;
    },
    onStdout: (d) => termAppend(d.chunk, "out"),
    onStderr: (d) => termAppend(d.chunk, "err"),
    onNotice: (d) => termWrite("— " + d.message, "sys"),
    onError: (d) => termWrite("— " + d.message, "err"),
  };
  let exit = null;
  try {
    exit = o.commandId ? await api.terminalRunCommand(o.commandId, handlers) : await api.terminalExec(command, handlers);
  } catch (err) {
    termWrite("— " + (err.message || "The command could not be started"), "err");
    /* 409 busy: something IS running, just not ours — take the id the refusal
       carries so the Stop the message tells the user to press is on screen. */
    if (err.status === 409 && err.body && err.body.running) {
      if (state.term.status) state.term.status.running = err.body.running;
      else await refreshTerminalStatus();
    }
    if (err.status === 401 || err.status === 403 || err.status === 409) {
      state.term.status = await api.getTerminalStatus().catch(() => state.term.status);
      /* and PAINT it: a 401 means the session died (idle lock, another tab's
         lock) — updating the state while leaving the unlocked console on
         screen kept an input field wired to a terminal that will refuse it */
      paintTerminal();
    }
  } finally {
    termAnsiFlush();
    const mine = state.term.running;
    state.term.busy = false;
    state.term.running = null;
    /* clear the server-side echo only if it still names OUR command: a 409 put
       somebody else's id there, and that one is still running */
    if (state.term.status && mine && state.term.status.running === mine) state.term.status.running = null;
    paintTermStop();
  }
  if (exit) {
    const ok = exit.code === 0;
    termWrite(
      "— exit " + (exit.signal ? exit.signal : exit.code) + " · " + exit.ms + "ms" + (exit.cwd ? " · " + exit.cwd : ""),
      ok ? "ok" : "err"
    );
    if (state.term.status) state.term.status.cwd = exit.cwd;
    paintCwd(exit.cwd);
  }
  if (o.commandId) await loadCommands();
  return exit;
}

export function submitTerminal() {
  const inp = $("#termInput");
  const cmd = inp.value;
  if (!cmd.trim()) return;
  inp.value = "";
  const h = state.term.history;
  if (h[h.length - 1] !== cmd) h.push(cmd);
  if (h.length > 200) h.shift();
  state.term.hist = -1;
  state.term.draft = "";
  /* A command already running means this line is an ANSWER to it (a y/N, a
     commit message, a here-doc) — the only way to type into a child without a
     TTY. Echoed as sent, never as a new command. */
  if (state.term.busy) {
    termWrite("> " + cmd, "sys");
    /* addressed to the command THIS tab is streaming: the server refuses the
       write outright if that is no longer what is running, rather than putting
       the line — a `y/N`, a commit message, a passphrase — into something else */
    api.terminalStdin(cmd + "\n", false, state.term.running).catch((err) => termWrite("— " + err.message, "err"));
    return;
  }
  runTerminal(cmd, {});
}

/** ↑/↓ walk the history; the in-progress line is kept as `draft` at index -1. */
export function terminalHistory(dir) {
  const inp = $("#termInput");
  const h = state.term.history;
  if (!h.length) return;
  if (state.term.hist === -1) {
    if (dir < 0) return; // already at the newest
    state.term.draft = inp.value;
    state.term.hist = h.length - 1;
  } else {
    const next = state.term.hist + (dir < 0 ? 1 : -1);
    if (next >= h.length) {
      state.term.hist = -1;
      inp.value = state.term.draft;
      return;
    }
    state.term.hist = Math.max(0, next);
  }
  inp.value = h[state.term.hist];
  requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
}

/**
 * Cancel whatever is running — including a command this tab did not start.
 *
 * `id` is passed when we know it, so a cancel can never reach past the command
 * it was aimed at; when only the server knows, its id is used. Nothing running
 * at all is said out loud rather than silently ignored.
 */
export async function terminalStop() {
  const id = termRunningId();
  if (!id) {
    await refreshTerminalStatus();
    if (!termRunningId()) return toast("Nothing is running");
  }
  termWrite("— cancelling…", "sys");
  try {
    const r = await api.terminalCancel(termRunningId());
    if (r && r.cancelled === false) termWrite("— nothing was running", "sys");
  } catch (err) {
    termWrite("— " + err.message, "err");
  }
  /* the truth after the fact, not an assumption: a cancel that reached nothing
     must not leave a Stop button implying it did */
  if (!state.term.busy) await refreshTerminalStatus();
}

/* ---------- assistant command records ---------- */

export async function loadCommands() {
  try {
    const r = await api.terminalCommands(40);
    state.commands = (r && r.commands) || [];
  } catch (err) {
    /* Locked: the records are behind the terminal password too, because they
       carry command OUTPUT. An empty list is the honest state to paint. */
    state.commands = [];
  }
  state.commands.forEach(echoCommand);
  refreshCommandCards();
  return state.commands;
}

/**
 * "Every AI-run command is visible in the terminal scrollback", enforced here
 * rather than left to whichever path happened to run it.
 *
 * A command the user approved streamed into the scrollback as it ran (the Run
 * button goes through `runTerminal`, which marks it printed). One the assistant
 * AUTO-RAN did not — that happened server-side, inside the model turn — so it
 * is replayed here from its record the moment this tab learns about it. Either
 * way the user ends up looking at the same thing.
 */
function echoCommand(c) {
  if (!c || c.source !== "ai") return;
  if (c.state !== "done" && c.state !== "failed") return;
  if (state.term.printed.has(c.id)) return;
  state.term.printed.add(c.id);
  termWrite("[assistant] $ " + c.command, "cmd");
  if (c.output) termWrite(c.output, c.exitCode === 0 ? "out" : "err");
  termWrite(
    "— " + (c.state === "failed" ? "did not run" : "exit " + (c.exitCode == null ? "?" : c.exitCode)) +
      (c.truncated ? " · output truncated" : ""),
    c.exitCode === 0 ? "ok" : "err"
  );
}

const commandById = (id) => state.commands.filter((c) => c.id === id)[0] || null;

/** The one place a command record enters or is refreshed in `state.commands`. */
export function upsertCommand(c) {
  if (!c || !c.id) return;
  const i = state.commands.findIndex((x) => x.id === c.id);
  if (i >= 0) state.commands[i] = Object.assign({}, state.commands[i], c);
  else state.commands.push(c);
  echoCommand(state.commands[i >= 0 ? i : state.commands.length - 1]);
}

/**
 * The approval card — deliberately the diff card's shape, because it makes the
 * same promise: the exact thing that will happen is on screen, and nothing
 * happens until you press a button.
 */
/* The card builds this and `refreshCommandCards` repaints it; the two copies
   were byte-identical, so a new lifecycle state meant editing both or watching
   the card and its repaint disagree. */
const cmdStateLabel = (c) =>
  c.state === "pending"
    ? "waiting for you"
    : c.state === "running"
    ? "running…"
    : c.state === "rejected"
    ? "rejected"
    : c.state === "failed"
    ? "failed"
    : "exit " + (c.exitCode == null ? "?" : c.exitCode);

export function commandCard(c) {
  const card = el("div", "cmdcard");
  card.dataset.cmd = c.id;
  if (c.state === "done") card.classList.add(c.exitCode === 0 ? "ran" : "failed");
  if (c.state === "failed") card.classList.add("failed");
  if (c.state === "rejected") card.classList.add("rejected");

  const head = el("div", "cmd-head");
  head.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg> Terminal command' +
    '<span class="st">' +
    esc(cmdStateLabel(c)) +
    "</span>";
  const body = el("div", "cmd-body");
  body.textContent = "$ " + c.command;
  card.appendChild(head);
  card.appendChild(body);
  if (c.why) {
    const why = el("div", "cmd-why");
    why.textContent = c.why;
    card.appendChild(why);
  }
  const foot = el("div", "cmd-foot");
  fillCommandFoot(c, foot);
  card.appendChild(foot);
  return card;
}

function fillCommandFoot(c, foot) {
  foot.innerHTML = "";
  const ready = !!(state.term.status && state.term.status.ready);
  if (c.state === "pending") {
    const run = el("button", "btn primary sm", I.tick + " Run");
    run.disabled = !ready || state.term.busy;
    run.title = ready ? "Run this command and show its output" : "Unlock the terminal first (Settings → Terminal)";
    run.addEventListener("click", async () => {
      /* NOT openSettings(): that call is a GATED navigation — with a dirty Raw
         buffer it raises the exit guard and paints nothing, and this handler
         used to run the command anyway, streaming its output into a page the
         user was never shown. Running the command is the decision the click
         made; the navigation is only so the output is visible, so it must not
         be re-blocked. showSettings is the ungated painter boot/popstate use. */
      showSettings("terminal", {});
      await runTerminal(c.command, { commandId: c.id, byAi: true });
    });
    const rej = el("button", "btn sm", "Reject");
    rej.addEventListener("click", async () => {
      try {
        const r = await api.terminalRejectCommand(c.id);
        upsertCommand(r.command);
        refreshCommandCards();
      } catch (err) {
        apiFail(err, "Could not reject the command");
      }
    });
    foot.appendChild(run);
    foot.appendChild(rej);
    const note = el("span", "note");
    note.textContent = ready ? "Nothing runs until you press Run." : "The terminal is locked.";
    foot.appendChild(note);
    return;
  }
  const note = el("span", "note");
  note.style.marginLeft = "0";
  note.textContent =
    c.state === "rejected"
      ? "You rejected this command; it never ran."
      : c.state === "running"
      ? "Running — output is in Settings → Terminal."
      : "Output is in Settings → Terminal." + (c.truncated ? " (truncated)" : "");
  foot.appendChild(note);
  if (c.state === "done" || c.state === "failed") {
    const show = el("button", "btn sm", "Show output");
    show.style.marginLeft = "auto";
    show.addEventListener("click", () => {
      openSettings("terminal");
      /* already in the scrollback (echoCommand ran when the record arrived) —
         this scrolls to it rather than printing a second copy */
      const out = $("#termOut");
      if (out) out.scrollTop = out.scrollHeight;
    });
    foot.appendChild(show);
  }
}

function refreshCommandCards() {
  $$(".cmdcard").forEach((card) => {
    const c = commandById(card.dataset.cmd);
    if (!c) return;
    card.classList.toggle("ran", c.state === "done" && c.exitCode === 0);
    card.classList.toggle("failed", c.state === "failed" || (c.state === "done" && c.exitCode !== 0));
    card.classList.toggle("rejected", c.state === "rejected");
    const st = $(".cmd-head .st", card);
    if (st) st.textContent = cmdStateLabel(c);
    const foot = $(".cmd-foot", card);
    if (foot) fillCommandFoot(c, foot);
  });
}
