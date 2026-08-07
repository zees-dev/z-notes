/* ============================================================
   shell.js — routing, SSE connection, overlays, panels, home.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, apiFail, dirname, toast } from "./ui.js";
import { closeCtx, loadTree, renderTree, revealFolder } from "./tree.js";
import { closeConfirm, closeConflict, confirmDialog } from "./dialogs.js";
import { adoptTrash, refreshTrash } from "./trash.js";
import { closeExitGuard, guardRawExit, navGate, openDoc, rawExitDiff, renderDoc, saveDoc, setBaseline, setMode, syncRaw, viewedPath } from "./editor.js";
import { closePP } from "./secrets.js";
import { closeEffort, closePal, renderChat, updateSessionUI } from "./chat.js";
import { adoptSettings, cacheLook, exitSettings, paintAiStatus, settingAt, showSettings } from "./settings.js";
import { loadCommands } from "./terminal.js";
import { findDoc } from "./app.js";

/* ============================================================
   SYNC + CONNECTION
   ============================================================ */
export function paintSync(s) {
  state.sync = s;
  $("#stSyncTxt").textContent = s.message.replace(" · " + s.remote, "");
  const el_ = $("#stSync");
  el_.classList.toggle("ok", s.state === "synced");
  el_.classList.toggle("warn", s.state !== "synced");
  el_.title = s.message + " · click to sync now";
  $("#stBranch").lastElementChild.textContent = s.branch;
  const line = $("#syncLineTxt");
  if (line) line.textContent = s.message;
}

/* Statusbar chip → POST /api/sync/now. The status arrives twice: once as the
   response here, and once (or more) as `sync-status` on /events while the
   pipeline moves through syncing → synced|error. Both go through paintSync, so
   a client that never sees the response still ends up painted correctly. */
export async function syncNow() {
  const chip = $("#stSync");
  chip.classList.add("busy");
  toast("Syncing…");
  try {
    const s = await api.syncNow();
    paintSync(s);
    toast(
      s.state === "error"
        ? "Sync failed — " + s.message
        : s.state === "offline"
        ? "Not syncing — " + s.message
        : "Synced · " + s.message
    );
  } catch (err) {
    apiFail(err, "Could not sync");
  } finally {
    chip.classList.remove("busy");
  }
}

/**
 * How long a stream may say nothing before we stop believing it.
 *
 * 2.5× the server's 20s heartbeat, not 1.5×. Two heartbeats can be lost to
 * ordinary scheduling jitter (a busy event loop, a throttled tab waking up)
 * without the connection being dead, and the threshold has to survive
 * HEARTBEAT_MS being raised server-side without the chip starting to flap —
 * at 1.5× a 40s server heartbeat would put the dot in permanent alarm against a
 * perfectly healthy stream. The cost of the wider window is that a black hole
 * is noticed at ~50s instead of ~30s, which is the right trade: a false
 * "reconnecting…" teaches the user to ignore the chip, and a chip nobody reads
 * is worth nothing at any threshold.
 */
const CONN_STALE_MS = 50_000;
/** How often we ask. Cheap: one subtraction and, at most, one repaint. */
const CONN_WATCH_MS = 5_000;

/** Milliseconds since this stream last carried anything, or Infinity if there
    is no stream to ask. */
function connSilence() {
  const h = state.events;
  return h && h.lastFrame ? Date.now() - h.lastFrame : Infinity;
}

/**
 * THE DOT TELLS THE TRUTH ABOUT WHAT IT KNOWS, WHICH IS LESS THAN IT USED TO
 * CLAIM.
 *
 * It used to be painted straight from the EventSource's state, and an open
 * socket that has gone silent reports state "open" indefinitely (see the note
 * over `connectEvents`) — so "connected" was an assertion about the network
 * that this client had no way to make. Now "connected" means BOTH that the
 * handle is open AND that we have heard from the server recently enough for
 * that to still be worth something; the middle state gets its own word rather
 * than being rounded up to health or down to a reconnect that is not happening
 * yet.
 *
 * `st` is the handle's own state change when there is one; called with nothing
 * (from the watchdog) it repaints from the clock alone.
 */
function paintConn(st) {
  if (st) state.conn = st;
  const c = $("#stConn");
  const txt = $("#stConnTxt");
  const quiet = connSilence() > CONN_STALE_MS;
  const live = state.conn === "open" && !quiet;
  c.classList.toggle("down", !live);
  txt.textContent = live
    ? "connected"
    : state.conn === "open"
    ? "no signal"
    : state.conn === "connecting"
    ? "reconnecting…"
    : "offline";
  c.title =
    "SSE /events · " +
    txt.textContent +
    (state.conn === "open" && quiet ? " — the stream is open but has said nothing for " + Math.round(connSilence() / 1000) + "s" : "");
}

function blipConn() {
  const c = $("#stConn");
  if (c.classList.contains("down")) return;
  c.classList.add("blip");
  setTimeout(() => c.classList.remove("blip"), 900);
}

/**
 * THE WATCHDOG.
 *
 * The server heartbeats every 20s and the client used to answer it with a
 * 900ms CSS blink and nothing else — a liveness signal that was decorative.
 * A stream can stop delivering without ever closing (a NAT rebind drops the
 * flow; both ends still believe they have a socket), and the epoch gap-check
 * that recovers the content lives in `onHello`, so it can only run on a NEW
 * connection. Nothing was making a new connection. MEASURED: 75s of a stale
 * document under a chip reading "connected".
 *
 * Silence past the threshold therefore reconnects, and the existing
 * hello → epoch → resyncAfterGap path does the rest.
 *
 * NEVER gated on a liveness probe first. The obvious `fetch("/healthz")` was
 * MEASURED inside the same black hole: it hung for ~15s (the connect timeout,
 * because the new socket goes to the same dead path) and pushed recovery from
 * 48s to 63s — a check that makes the thing it checks for last longer. The
 * reconnect IS the probe; it either finds a live server or fails and hands the
 * existing backoff its answer.
 *
 * A STUCK RECONNECT IS THE SAME BLACK HOLE, one step further in. The watchdog
 * used to refuse anything that was not `open`, on the theory that `connecting`
 * was owned by the backoff below — it is not: the backoff only arms on
 * `closed`. An EventSource whose request went into the hole sits at readyState
 * 0 forever, `onerror` never fires, so it never reaches `closed` and never
 * re-arms anything. MEASURED against a TCP proxy reproducing a NAT rebind:
 * exactly ONE `GET /events` was issued and the chip read "reconnecting…" for
 * minutes over a superseded document, INCLUDING after the network was fully
 * healed — the same stale document as before, under a different lie. Chrome
 * makes it near-certain by reusing a pooled keep-alive socket, which after a
 * rebind is dead too. So `connecting` is watched as well, from the attempt's
 * own `lastFrame` stamp (seeded at construction in api.js), and every
 * watchdog-initiated retry walks the same backoff rather than storming a
 * genuinely dead network with an attempt per 5s.
 */
let connWatchT = null;
/* One tick of grace, so the middle state can actually be SEEN. `paintConn` and
   `connect` in the same task are one frame: the chip went straight from
   "connected" to "reconnecting…" and "no signal" — the word SPEC §9 promises an
   open-but-silent stream — was written and never rendered. The cost is 5s of
   later recovery on a path that has already been silent for 50. */
let connQuietSeen = false;

function checkConn() {
  paintConn();
  const h = state.events;
  if (!h) return;
  const quiet = connSilence() > CONN_STALE_MS;
  if (h.state === "open") {
    if (!quiet) {
      connQuietSeen = false;
      return;
    }
    if (!connQuietSeen) {
      connQuietSeen = true; // this tick paints "no signal"; the next one acts
      return;
    }
    connQuietSeen = false;
    reconnectSoon();
  } else if (h.state === "connecting" && quiet) {
    /* the attempt itself went into the hole — nothing will ever close it */
    reconnectSoon();
  }
}

function startConnWatch() {
  if (connWatchT) return;
  connWatchT = setInterval(checkConn, CONN_WATCH_MS);
}

/* EventSource retries on its own for ordinary drops, but a stream that dies
   mid-flight (backend restart, worker killed) can leave it CLOSED for good.
   Own the recovery so the dot never lies about being permanently offline. */
let reconnectT = null;
let reconnectWait = 0;

/** The 1→2→4→15s walk, shared by both things that ask for a retry: a stream
    that CLOSED, and the watchdog noticing one that never will. A retry already
    scheduled is left alone — the watchdog ticks every 5s and must not restart
    the wait it is waiting on. */
function reconnectSoon() {
  if (reconnectT) return;
  reconnectWait = Math.min(15000, (reconnectWait || 1000) * 2);
  reconnectT = setTimeout(connect, reconnectWait);
}

export function connect() {
  startConnWatch();
  clearTimeout(reconnectT);
  reconnectT = null;
  connQuietSeen = false;
  if (state.events) {
    const prev = state.events;
    state.events = null; /* a close we asked for must not schedule a retry */
    prev.close();
  }
  paintConn("connecting");
  state.events = api.connectEvents({
    onState: (st) => {
      paintConn(st);
      if (st === "open") {
        reconnectWait = 0;
        /* The stream keeps no backlog, so an `ai-status` pushed while we were
           away (or before this client existed — the boot probe finishes in the
           first second) is simply gone. Re-read it once per CONNECTION, which
           is not a timer: a stable session reads it exactly once. */
        api.getAiStatus().then(
          (r) => r && r.status && paintAiStatus(r.status),
          () => {}
        );
        /* Same reasoning, same block: a `settings-changed` pushed while this
           client was disconnected is gone, and settings do NOT move the vault
           epoch — so `resyncAfterGap` (which only runs on an epoch change) can
           never cover them. That is the whole reason this sits here and not
           there: put beside the tree re-read it would be dead code. */
        api.getSettings().then(adoptSettings, () => {});
      } else if (st === "closed" && state.events) {
        reconnectSoon();
      }
    },
    /* The blink is the decoration; the repaint is the point. A stream that has
       just spoken after a silent stretch has to be able to earn "connected"
       back before the next 5s watchdog tick, and `blipConn` refuses to blink at
       all while the chip is `.down` — so the repaint has to come first. */
    onHeartbeat: () => {
      paintConn();
      blipConn();
    },
    onSyncStatus: paintSync,
    /* pushed by the relay whenever the endpoint's real status changes — a
       finished probe, a turn that failed, a rung the ladder took. The statusbar
       item therefore never polls and never guesses. */
    onAiStatus: paintAiStatus,
    /* Settings saved by ANOTHER client (or another tab of this one). Masked
       already — see the note on this event in api.js. A save that moved
       ai.effort also repaints the model chip (spec 0006) — from a session
       refetch, because the chip shows the server's effortInUse, which the
       settings body alone cannot tell us. */
    onSettingsChanged: (payload) => {
      /* captured BEFORE adopt: applySavedSettings overwrites
         state.session.effort with the CONFIGURED value, so a comparison made
         after it would always see equality and the refetch could never fire */
      const sessBefore = state.session ? state.session.effort : null;
      adoptSettings(payload);
      const eff = payload?.settings?.ai?.effort;
      if (eff && sessBefore !== null && eff !== sessBefore) {
        api.getSession()
          .then((s) => {
            state.session = s;
            updateSessionUI();
          })
          .catch(() => {});
      }
    },
    /* The whole server list, not a mutation hint. A permanent purge has no
       doc-changed frame, so this is the only way an already-open drawer on a
       second client can remove the row promptly. */
    onTrashChanged: adoptTrash,
    /* A terminal command record changed state — a NOTIFICATION carrying an id
       and nothing else, because this stream is not behind the terminal
       password. The content comes back over the bearer-gated route, and only
       if this tab is actually unlocked; a locked tab learns nothing. */
    onTerminalCommand: () => {
      if (api.terminalHasToken()) loadCommands().then(renderChat);
    },
    /* The stream keeps no backlog, so anything that happened while we were
       disconnected is invisible. The server's vault epoch changes on every
       announced change: a different epoch than the one we last saw means we
       missed something and must re-read rather than keep showing stale text. */
    onHello: (d) => {
      const e = d && d.epoch;
      if (e == null) return;
      const missed = state.epoch != null && e !== state.epoch;
      state.epoch = e;
      if (missed) resyncAfterGap();
    },
    onDocChanged: async (d) => {
      if (!d) return;
      blipConn();
      /* A move arrives as a PAIR: the old path with removed+`to`, the new path
         with `from` (API.md § Events). The old half carries everything needed
         to follow the doc, so the new half only has to refresh the tree — which
         is what makes a second client converge with no manual reload. */
      if (d.reason === "moved") {
        if (!d.removed) {
          await loadTree().catch(() => {});
          return;
        }
        /* Follow the move only if the moved doc is still the one the user is on.
           A `moved` echo can land more than a second late (the watcher's own
           reconcile re-reports a move the API already announced), by which time
           the user may have clicked something else — following then would yank
           the pane back to a doc they have left. viewedPath() counts a click
           whose fetch is still in flight, which state.active cannot. */
        const wasActive = d.path === viewedPath();
        const cached = state.docs.get(d.path);
        state.docs.delete(d.path);
        if (wasActive && d.to) {
          state.active = d.to;
          if (state.dirty) {
            /* never clobber typing: keep the buffer, just retarget it. The next
               save is an ordinary write to the new path. */
            if (cached) state.docs.set(d.to, Object.assign({}, cached, { path: d.to, name: d.to.split("/").pop() }));
            await loadTree().catch(() => {});
            /* the buffer stays put but its address changed — the one place a
               re-home cannot go through openDoc, so the URL is followed here */
            routeDoc(d.to, true);
            renderDoc({ noFade: true });
            /* sticky for the same reason the deleted half is: the doc under an
               unsaved buffer changed address, and the user has to be able to
               still be reading that when they look back at the screen */
            toast("Moved to " + d.to + " — your unsaved changes are still here", { sticky: true });
            return;
          }
          const ours = navGate();
          state.active = null;
          await loadTree().catch(() => {});
          if (!ours()) return; // the user (or the local move) already navigated
          const next = state.docs.get(d.to);
          if (next) next.loaded = false;
          await openDoc(d.to, { replace: true }).catch(() => {});
          toast("Moved to " + d.to);
          return;
        }
        await loadTree().catch(() => {});
        return;
      }
      /* THE DELETED HALF, and the one that used to throw work away.
         `moved` above already says it in a comment — "never clobber typing:
         keep the buffer, just retarget it" — and this branch was the
         uncommented omission of the same rule: it dropped the cache entry
         unconditionally, and `doSaveDoc` opens with `if (!doc) return false`,
         so the next ⌘S issued NO request, raised NO veil and showed NO toast
         while the indicator went on reading "Unsaved changes" forever.
         MEASURED: ~1000 characters, gone with a 1.9s notice as their only
         trace.

         So a DIRTY buffer survives the doc leaving the vault. It becomes an
         ORPHAN: still on screen, still editable, but with no file behind it —
         which `doSaveDoc` turns into an explicit Recreate-or-Discard rather
         than a silent no-op. This fires on any external removal too (a git
         pull, an `rm`), which is exactly when the buffer is the only copy left.

         Scoped to DIRTY, deliberately: a clean orphan is a cache entry whose
         every byte is also in git, and keeping those around would leave the
         tree and the cache disagreeing for no benefit. */
      if (d.removed) {
        const cached = state.docs.get(d.path);
        const keep = !!cached && d.path === state.active && state.dirty;
        if (keep) cached.orphaned = true;
        else state.docs.delete(d.path);
        loadTree().catch(() => {});
        /* something left the vault — from this tab, another tab, or an `rm`.
           Only a delete through the app puts it in the trash, but only the
           trash itself knows that, so ask rather than assume either way. */
        if (state.trash.available) refreshTrash();
        if (d.path === state.active) {
          const how = d.path + (d.reason === "deleted" ? " was deleted" : " was deleted on disk");
          if (keep) toast(how + " — your unsaved text is still here. Save to recreate it.", { sticky: true });
          else toast(how);
        }
        return;
      }
      const cached = state.docs.get(d.path);
      if (cached && cached.rev === d.rev) return; // our own echo
      if (state.saving.has(d.path)) return; // a write of ours is in flight
      if (d.path === state.active && state.dirty) return; // never clobber typing
      if (d.reason === "created") {
        loadTree().catch(() => {});
        return;
      }
      try {
        const fresh = await api.getDoc(d.path);
        state.docs.set(d.path, setBaseline(Object.assign({}, cached || {}, fresh, { loaded: true }), fresh.markdown));
        if (d.path === state.active) {
          const sc = $("#scroll");
          const keep = sc ? sc.scrollTop : 0;
          renderDoc({ noFade: true });
          if (sc) sc.scrollTop = Math.min(keep, sc.scrollHeight - sc.clientHeight);
          if (d.reason === "external") toast("Reloaded from disk");
        }
      } catch (e) {}
    },
  });
}

/* Re-read everything we cannot know is still current after a stream gap. A
   dirty buffer is never touched — the next save raises the conflict banner. */
async function resyncAfterGap() {
  await loadTree().catch(() => {});
  const path = state.active;
  if (!path || state.dirty || state.saving.has(path)) return;
  try {
    const fresh = await api.getDoc(path);
    const cached = state.docs.get(path);
    if (cached && cached.rev === fresh.rev) return;
    state.docs.set(path, setBaseline(Object.assign({}, cached || {}, fresh, { loaded: true }), fresh.markdown));
    renderDoc({ noFade: true });
    toast("Reloaded from disk");
  } catch (e) {}
}

/* ---------- the page's own lifecycle: flush on the way out, heal on the way in ----------

   `pagehide` used to be the ONLY flush, and iOS does not reliably fire it when
   a backgrounded tab is discarded — the OS freezes the page at
   `visibilitychange` and may never run another line of it. `markDirty` is a
   plain `setTimeout` at editor.autosaveSeconds, and a frozen page runs no
   timers, so up to ten seconds of typing had no path to disk at all. MEASURED:
   after visibilitychange→hidden the canary text was not in the file; after
   pagehide it was.

   So `hidden` now runs exactly what `pagehide` runs. Deliberately NOT by
   lowering editor.autosaveSeconds: SPEC §4 fixes it at 10, and a shorter timer
   would be both a worse fix (it still cannot run while frozen) and pointless
   once the flush happens at the boundary itself.

   `leaving` is the difference between the two callers, and it is `quiet` that
   turns on it: a page on its way out has nowhere to put a question, so an
   orphaned buffer keeps its sticky notice and says nothing. A page that is
   coming BACK does have somewhere — that is the one moment the veil is worth
   raising — and it is also the moment a failure has somebody to report to.
   (`keepalive` rides along with it because only an unloading request needs to
   outlive its document; api.js already drops it for a body over the budget.) */
export function flushBuffer(opts) {
  if (!state.dirty || !state.active) return;
  syncRaw();
  const leaving = !!(opts && opts.leaving);
  saveDoc(state.active, { silent: true, quiet: leaving, keepalive: leaving });
}

/** …and the mirror: a page coming back has missed everything the stream carried
    while it was away, because the stream keeps no backlog. Reconnect first (the
    `hello` → epoch check is what NOTICES a gap), then re-read what we cannot
    know is still current. Both are safe on a page that missed nothing:
    `resyncAfterGap` compares revs and `connect` is idempotent. */
export function healAfterGap() {
  if (!state.events || state.events.state !== "open") connect();
  /* …and RETRY THE WRITE, which nothing else here does. `doSaveDoc` clears
     `dirtyT` before it attempts the PUT and only `markDirty` re-arms it, so a
     save that failed while the network was down is the LAST attempt: the timer
     is gone and `resyncAfterGap` returns immediately on a dirty buffer by
     design. MEASURED: after the network came back the chip read "connected"
     beside an indicator reading "Unsaved changes", and the text was still not
     on disk 7.5× the debounce later — it took another keystroke. `flushBuffer`
     no-ops on a clean buffer, so this costs nothing on the ordinary path. */
  flushBuffer();
  resyncAfterGap().catch(() => {});
}

/* ============================================================
   OVERLAYS / ESC
   ============================================================ */
export const isOpen = (sel) => {
  const n = $(sel);
  return !!n && n.classList.contains("show");
};
export function openSess() {
  $("#sessPop").classList.add("show");
  $("#sessChip").setAttribute("aria-expanded", "true");
  updateSessionUI();
}
export function closeSess() {
  $("#sessPop").classList.remove("show");
  $("#sessChip").setAttribute("aria-expanded", "false");
}
export function overlayOpen() {
  return (
    VEILS.some(isOpen) ||
    $("#sessPop").classList.contains("show") ||
    $("#effortPop").classList.contains("show") ||
    !!state.creating ||
    !!state.renaming
  );
}

/* The veils, most-modal first. Same order dismissTop() unwinds them in.
   The confirm sits above settings (it can be raised from a row behind it) and
   below the palette. */
/* Settings is NOT here any more: it is a page at `/settings`, not an overlay,
   so Esc has nothing of its to dismiss and `dismissTop()` unwinds exactly the
   layers that really float above the app. */
/* The exit guard is LAST, one layer above the editor it guards and below every
   other modal: Esc with the palette (or a confirm, or the conflict banner) open
   over it must close that first, and only the Esc that reaches the bottom of the
   modal stack is the one that means "Keep editing". */
export const VEILS = ["#palVeil", "#scVeil", "#ppVeil", "#cxVeil", "#cfVeil", "#xgVeil"];
export const hide = (sel) => $(sel).classList.remove("show");
/* veils whose close is more than hiding the node; the rest fall back to hide */
export const CLOSERS = {
  "#palVeil": closePal,
  "#ppVeil": closePP,
  "#cxVeil": closeConflict,
  "#cfVeil": closeConfirm,
  "#xgVeil": closeExitGuard,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside the open modal.
 *
 * Without this, Tab out of the passphrase modal landed in `#palInput` — the ⌘K
 * search box, which is hidden but still in the tab order (a `.veil` is hidden
 * with opacity, never `display`/`visibility`) and which fires
 * `GET /api/search?q=…` on every keystroke. The masked field simply stopped
 * accepting characters, which is exactly the moment a user retypes the whole
 * passphrase — into a server-bound URL. SPEC §11: "plaintext never in any
 * server-bound request". The CSS now makes hidden veils untabbable as well;
 * this keeps focus off the DOCUMENT (`#rawArea` is a textarea that gets saved
 * to disk and pushed to git).
 */
export function trapTab(e) {
  /* the palette drives its own Tab (it moves the result cursor) — never fight
     a handler that has already claimed the key */
  if (e.defaultPrevented) return;
  const sel = VEILS.filter(isOpen)[0];
  if (!sel) return;
  const veil = $(sel);
  const nodes = $$(FOCUSABLE, veil).filter((n) => !n.hidden && n.offsetParent !== null && !n.closest("[hidden]"));
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const a = document.activeElement;
  if (!veil.contains(a)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && a === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && a === last) {
    e.preventDefault();
    first.focus();
  }
}

export function dismissTop() {
  for (const sel of VEILS) {
    if (!isOpen(sel)) continue;
    (CLOSERS[sel] || hide)(sel);
    return true;
  }
  /* popovers, below every modal: a confirm raised FROM the context menu must
     take the first Esc, and it does — the menu is already closed by then */
  if (closeCtx()) return true;
  if ($("#effortPop").classList.contains("show")) {
    closeEffort();
    return true;
  }
  if ($("#sessPop").classList.contains("show")) {
    closeSess();
    return true;
  }
  if (state.creating) {
    state.creating = null;
    renderTree();
    return true;
  }
  if (state.renaming) {
    state.renaming = null;
    renderTree();
    return true;
  }
  /**
   * THE EDITOR LAYER — Esc leaves Raw (SPEC §4).
   *
   * It used to only BLUR the textarea, which is a state nothing else in this
   * app can see: the mode chip still read "Raw", the caret was simply gone, and
   * the second Esc closed the chat panel. Esc now does what the user means by
   * it — go back to reading — and the mode it lands in is Preview.
   *
   * With a buffer that does not match the file, `setMode` stops at the exit
   * guard instead and this Esc raises the diff. Either way Esc was consumed by
   * the editor, so the layers below it (the drawer, the chat panel) do not also
   * get it — which is the same ordering the blur had.
   *
   * Scoped to focus that BELONGS to the editor. Esc with the caret in a sidebar
   * filter, the terminal line or a settings field is that surface's Esc, and
   * every one of those either handles it first or falls through to the layers
   * below exactly as before.
   */
  const ta = $("#rawArea");
  const at = document.activeElement;
  if (ta && state.view !== "settings" && state.mode === "raw" && (at === ta || at === document.body || at === null)) {
    setMode("preview", { silent: true });
    return true;
  }
  if (isDrawer() && app.classList.contains("nav-open")) {
    closeNav();
    return true;
  }
  /**
   * THE BOTTOM LAYER: the chat panel, at every width (it used to be dismissed
   * only in the mobile sheet). Deliberately last, so every rule above still
   * holds — a modal, the palette, the context menu, the session popover, an
   * inline tree editor and Raw-to-Preview each take Esc first, and only
   * once nothing else is up does Esc close the panel.
   *
   * The DRAFT IS NEVER LOST. `toggleChat` collapses a grid column above
   * W_TRIPANE and slides an overlay off-canvas below it; either way #composer
   * and its value stay in the DOM, so reopening shows the half-typed message
   * exactly as it was. And Esc *inside* the composer never reaches this — the
   * composer's own handler blurs it first (see wire()), so Esc mid-sentence
   * costs a focus, not a panel; the second press lands here.
   */
  if (app.classList.contains("chat-open")) {
    toggleChat();
    return true;
  }
  return false;
}

/* ============================================================
   ROUTING — one URL per PLACE the pane can be

   Two shapes, one stack:

     `/d/<vault-relative path, each segment percent-encoded>` — the open doc,
     e.g. `/d/architecture/event-pipeline.md`. The doc path stays a real path so
     the URL is readable and copy-pasteable, and the `/d/` prefix is what makes
     it collision-free forever: `/api/*`, `/events`, `/vendor/*`, `/healthz` and
     every file under app/ live on other first segments, so no vault path can
     ever shadow a route.

     `/settings`, `/settings/<section>` — the settings page. It is the pane's
     other content, not an overlay, so it is a real address: deep-linkable,
     reloadable, and Back from it returns to the doc you were reading. The
     section is in the URL because "open Settings AT the AI group" is exactly
     what the statusbar chip does, and that should be a link anyone can send.

   The server answers both prefixes with the SPA shell.

   MODE (preview ⇄ raw) is deliberately NOT in the URL and creates no entry: it
   is how you are looking at the doc, not which doc you are looking at. Five
   ⌘E presses then Back must land on the previous DOC. A settings SECTION is
   the same kind of thing one level down — it is where you are on a page, so it
   REPLACES the entry: six rail clicks then Back leaves Settings, it does not
   walk you back through six scroll positions.

   There are exactly three writers — `routeDoc`, called only from `openDoc` (the
   single navigation funnel), `routeSettings`, called only from `showSettings`
   (the single settings funnel), and `routeVeil`, driven by one MutationObserver
   over the veils. Nothing else in this file touches `history`.
   ============================================================ */

/* the SAME encoder `/api/docs/{path}` uses — a doc URL and the request that
   fetches that doc must agree segment for segment, so there is one rule.

   The query survives the rewrite. Before routing existed the URL never changed,
   so `?theme=terminal` — an affordance Settings › Theme advertises in so many
   words — lasted the life of the tab and across reloads. Boot ends in a
   replaceState, so dropping it here meant the theme lived exactly one page load
   and the URL could no longer be reloaded or shared. */
const docUrl = (p) => "/d/" + api.encPath(p) + location.search;

/** the doc named by the address bar, or null when we are on the bare shell */
export function urlDoc() {
  const m = /^\/d\/(.+)$/.exec(location.pathname);
  if (!m) return null;
  try {
    return m[1].split("/").map(decodeURIComponent).join("/");
  } catch (e) {
    return null;
  }
}

/* The settings page's address. The section list is here and nowhere else: an
   unknown one (a typo, a link from a future version) degrades to the top of the
   page rather than 404ing or flashing a section that does not exist. It is the
   same list the rail in index.html carries, and `#settingsGrp-<section>` is
   what both resolve to. */
export const SETTINGS_SECTIONS = ["appearance", "editing", "trash", "git", "secrets", "ai", "terminal"];
/* `location.search` rides along for the same reason `docUrl` keeps it:
   `?theme=terminal` must survive every rewrite or it lasts one page load. */
const settingsUrl = (sec) => "/settings" + (sec ? "/" + encodeURIComponent(sec) : "") + location.search;

/** `{ section }` when the address bar names the settings page, else null */
export function urlSettings() {
  const m = /^\/settings(?:\/([^/]*))?\/?$/.exec(location.pathname);
  if (!m) return null;
  let sec = "";
  try {
    sec = m[1] ? decodeURIComponent(m[1]) : "";
  } catch (e) {
    sec = "";
  }
  return { section: SETTINGS_SECTIONS.includes(sec) ? sec : "" };
}

/* Entries carry a monotonic `i` purely so a popstate can tell BACK from
   FORWARD — the DOM gives no other way to know which way the user went, and
   `i === 1` is additionally what `canPopBack` reads (see there). Boot seeds
   `histSeq` from the entry the browser handed us, so a reload in the MIDDLE of
   the stack cannot mint numbers this stack has already spent. */
let histSeq = 0;
let histAt = 0;

/** BOOT's seeding of the history sequence — owned here so the counters stay
    module-local. A reload lands on an entry a PREVIOUS page load numbered, and
    `i` is what tells Back from Forward and the bottom of our stack from the
    middle of it. Carry the sequence on from that number, or the next push
    would mint one this stack has already used. */
export function seedHistory() {
  histSeq = histAt = (history.state || {}).i || 0;
}

/**
 * Is there an app entry UNDER the one we are standing on?
 *
 * Boot numbers the entry the browser handed us 1 (`routeDoc` replaces it, and
 * a replace keeps its `i`), so everything above it was PUSHED onto an app
 * entry and everything at it is the bottom of our stack. Below entry 1 is
 * either nothing or another site: `history.back()` there takes the tab out of
 * the app entirely, dropping an unlocked vault, the terminal session and every
 * revealed block with it.
 */
export const canPopBack = (st) => (((st && st.i) || 0) > 1);

/**
 * How the Back button leaves the settings entry we are STANDING ON — a
 * property of that entry, never of the last arrival, which is why every
 * arrival writes it (a popstate included; inheriting it is what let Back walk
 * off the bottom of the stack):
 *
 *   "back"    an app entry sits directly under this one — we pushed onto it,
 *             or we walked FORWARD onto this one from it;
 *   "forward" we walked BACK onto this entry, so the entry we came from is
 *             still ahead and spending it truncates nothing;
 *   "open"    neither: this is the entry the browser handed us (deep link,
 *             reload), so leaving has to navigate and let that push.
 *
 * Only `leaveSettings` reads it.
 */

/**
 * Record the doc on screen. Called from openDoc AFTER the fetch resolved, so a
 * navigation that 404s never leaves an entry behind.
 *
 * Reuses the current entry instead of stacking a new one when: the caller says
 * so (`replace` — a rename/delete re-home, or a popstate we are just catching
 * up with, where an entry already exists and Back must not return to a path
 * that no longer resolves), the doc is already the one this entry names
 * (re-clicking the open doc), or the entry is the marker an overlay pushed (a
 * ⌘K pick closes the palette and navigates in one gesture — one entry, not two).
 */
export function routeDoc(path, replace) {
  const cur = history.state || {};
  /* …but ONLY when the navigation actually closed the overlay. ⌘K is not
     blocked while Settings is up, and `closePal()` closes only the palette, so
     a ⌘K pick over Settings navigated with Settings still open and marker-less.
     The same shape is reachable without a gesture, from anything that re-homes
     the pane while an overlay is up (the SSE `moved` echo, accept/revert
     Proposal — all `openDoc(…, {replace: true})`). The next BACK then hit
     `onPop`'s dismissal branch on an entry the browser had ALREADY traversed
     away from, leaving the URL naming one doc and the pane showing another for
     the rest of the session. Keep the marker; only its URL follows the pane. */
  if (cur.z === "veil" && VEILS.some(isOpen)) {
    history.replaceState({ z: "veil", i: cur.i }, "", docUrl(path));
    return;
  }
  const reuse = !!replace || cur.z === "veil" || (cur.z === "doc" && cur.path === path);
  const st = { z: "doc", path: path, i: reuse && cur.i != null ? cur.i : ++histSeq };
  histAt = st.i;
  history[reuse ? "replaceState" : "pushState"](st, "", docUrl(path));
}

/**
 * Record the settings page. Called only from `showSettings`, the twin of
 * `routeDoc` and deliberately the same shape:
 *
 *   - an overlay's marker is recycled, never stacked on (⌘K works over the
 *     settings page exactly as it works over a doc, and a pick that navigates
 *     costs one entry);
 *   - arriving from a doc PUSHES, so Back returns to the doc and Forward comes
 *     back here — the whole point of the move;
 *   - arriving when we are already here REPLACES, so the section rail and the
 *     statusbar chip rewrite the address instead of stacking scroll positions.
 */
export function routeSettings(section, replace) {
  const cur = history.state || {};
  if (cur.z === "veil" && VEILS.some(isOpen)) {
    /* a marker is always PUSHED, so an app entry sits under this one */
    state.settingsExit = "back";
    history.replaceState({ z: "veil", i: cur.i }, "", settingsUrl(section));
    return;
  }
  const reuse = !!replace || cur.z === "veil" || cur.z === "settings";
  const st = { z: "settings", section: section || "", i: reuse && cur.i != null ? cur.i : ++histSeq };
  histAt = st.i;
  /* `state.settingsExit` is about the ARRIVAL, so a rail click — which replaces the
     settings entry we are already standing on — must not rewrite what the
     arrival recorded. Everything else does: a push lands on the entry we came
     from, a recycled overlay marker was itself pushed over one, and replacing
     the entry the browser handed us leaves nothing underneath at all. */
  if (!reuse || cur.z === "veil") state.settingsExit = "back";
  else if (cur.z !== "settings") state.settingsExit = "open";
  history[reuse ? "replaceState" : "pushState"](st, "", settingsUrl(section));
}

/**
 * An open overlay owns one history entry, so Back dismisses it instead of
 * leaving the doc. This is the whole mechanism: opening pushes a marker,
 * closing does nothing at all. A marker the user walks back through is spent
 * on `dismissTop()`; a marker its overlay outlived (Esc closed it) is skipped
 * in `onPop`; a marker a navigation lands on is recycled by `routeDoc`. No
 * timers, no in-flight traversal to cancel, no ordering to get wrong.
 */
export function routeVeil() {
  if (!VEILS.some(isOpen)) return;
  if ((history.state || {}).z === "veil") return;
  /* pushing truncates whatever was ahead, so a settings entry that meant to
     leave by spending a FORWARD entry no longer has one to spend */
  if (state.settingsExit === "forward") state.settingsExit = "open";
  histAt = ++histSeq;
  history.pushState({ z: "veil", i: histAt }, "", location.href);
}

/**
 * The traversal the exit guard is putting back, or null.
 *
 * A popstate is an announcement, not a request: by the time we hear about a
 * Back it has already happened, so the only way to hold it is to UNDO it with
 * a `history.forward()` and re-issue it if the user says leave.
 *
 * The dialog is raised on the popstate that lands us back where we were, NOT
 * on the one we intercepted — that ordering is load-bearing. Opening any veil
 * makes `routeVeil` push a marker entry, and a push TRUNCATES everything ahead
 * of it: raising the dialog first would destroy the forward entry the very next
 * line was about to spend.
 */
let guardPop = null;

export function onPop(e) {
  const st = e.state || {};
  if (guardPop) {
    const g = guardPop;
    guardPop = null;
    histAt = st.i || 0;
    /* we are standing where the user was again; now ask */
    guardRawExit(g.replay);
    return;
  }
  const back = (st.i || 0) < histAt;
  /**
   * BROWSER BACK OUT OF A DIRTY RAW BUFFER (SPEC §4).
   *
   * Only BACK, and only when the traversal really leaves: a pop that lands on
   * the entry directly under a marker with nothing below it changes nothing on
   * screen, and a dialog in front of a no-op is noise. FORWARD is deliberately
   * left alone — it is not a way anyone leaves an edit, and holding it would
   * mean pushing the guard's marker over the entry it was trying to reach.
   *
   * A veil already up owns this press (the branch below dismisses it), so the
   * guard never competes with the dismissal — including with ITSELF: Back with
   * this dialog open is Keep editing, exactly as Esc is.
   */
  const noop = st.z === "doc" && st.path === viewedPath() && !canPopBack(st);
  if (back && !noop && !VEILS.some(isOpen) && rawExitDiff()) {
    /* histAt deliberately NOT moved: we are about to be put back on the entry
       it already names, and the forward() below is what lands us there */
    guardPop = { replay: () => history.back() };
    history.forward();
    return;
  }
  histAt = st.i || 0;
  /* Back with a modal up closes the modal. We have landed on the doc entry
     under the marker — the same doc — so there is nothing else to do, and a
     stacked overlay (confirm over settings) re-arms the marker for the next
     press rather than stranding the app one Back from navigating out. */
  if (VEILS.some(isOpen)) {
    dismissTop();
    /* The entry under a marker names the PLACE that was on screen when the
       marker was pushed. If the pane has moved since — a ⌘K pick over the
       settings page, a `moved` echo, an accepted proposal that re-homed the doc
       — that is no longer what is on screen, and leaving it would strand the
       URL on a different note for reload, for copy-link and for every later
       BACK/FORWARD. */
    if (state.view === "settings") {
      if (st.z !== "settings") routeSettings(state.settingsSection, true);
    } else {
      const shown = viewedPath();
      if (shown && st.path !== shown) routeDoc(shown, true);
    }
    routeVeil();
    return;
  }
  /* Walking INTO a settings entry: paint the page, write nothing — the entry we
     are reacting to is the entry. Section included, so Back/Forward through
     `/settings/ai` lands on the AI group and not merely on the page.
     …unless the page is already this exact page, which is the settings twin of
     the doc case below: the entry directly under a marker names the same place,
     so spend nothing on it and keep going the way the user asked. */
  if (st.z === "settings") {
    /* How Back leaves is decided by the entry we LAND on, never by the last
       arrival: walking back means the entry we came from is still ahead, and
       walking forward means the one we came from is still underneath. */
    state.settingsExit = back ? "forward" : "back";
    if (state.view === "settings") {
      /* Two settings entries can only ever be ADJACENT because an overlay
         marker over the page was recycled into one — the rail replaces, so a
         section change never stacks. Same page either way: repaint whatever
         section this entry names (so the address and the pane still agree in
         the FORWARD direction) and otherwise spend nothing here, keeping going
         the way the user asked. */
      if ((st.section || "") !== state.settingsSection) showSettings(st.section, { route: false });
      if (back && canPopBack(st)) history.back();
      return;
    }
    showSettings(st.section, { route: false });
    return;
  }
  /* A marker its overlay outlived. Its URL names wherever the pane was when the
     marker was pushed — which, since Settings became a place, is not always
     where the pane is now (⌘, over an open overlay re-homes the marker onto
     `/settings`, and Back out of it leaves the marker ahead of you). Put the URL
     back on what is really on screen before walking past it, so a FORWARD onto
     a spent marker can never leave the address bar describing another page. */
  if (st.z === "veil") {
    if (state.view === "settings") routeSettings(state.settingsSection, true);
    else {
      const here = viewedPath();
      if (here) routeDoc(here, true);
    }
    if (back) history.back();
    return;
  }
  /* Walking OUT of it. The doc never moved while Settings was up, so the entry
     under it names the doc still in `state.active` — which is precisely the
     shape the skip below exists to eat. Leaving must not be skipped, or one
     Back would sail past the doc it was supposed to return to. */
  const leaving = state.view === "settings";
  if (leaving) exitSettings();
  /* The entry directly under a marker: the only way two neighbouring entries
     name the same doc. Spend nothing on it — keep going the way the user asked.
     (Markers themselves were handled above.) */
  if (!leaving && st.z === "doc" && st.path === viewedPath()) {
    if (back && canPopBack(st)) history.back();
    return;
  }
  const path = st.path || urlDoc();
  if (path && path !== viewedPath()) openDoc(path, { replace: true });
}

/** a deep-linked doc must be visible in the tree, not buried in a closed folder
    — the doc's ancestors are exactly `revealFolder(dirname(path))` */
export function revealInTree(path) {
  if (revealFolder(dirname(path))) renderTree();
}

/* ============================================================
   HOME — the vault button (SPEC §9)

   Which doc is `editor.homeDoc`, a real setting: Settings › Editing, the
   `[editor] homeDoc` key in settings.toml, and `meta.homeDocDefault` so the
   field's placeholder comes from the server like every other option list. Live:
   changing it repaints the button's title/aria immediately, no reload.

   It is a NAVIGATION, not a view change — `openDoc` is the single funnel and it
   pushes a history entry, so Back returns to wherever you came from.
   ============================================================ */

/**
 * The configured home doc, normalised to a doc path. `""` means "no home doc
 * configured", which falls back to the first doc rather than doing nothing.
 * `home = "index"` and `home = "index.md"` are the same doc, the same rule
 * `commitCreate` applies to a typed name.
 */
export function homeTarget() {
  const raw = String(settingAt("editor.homeDoc") || "").trim();
  if (!raw) return "";
  return /\.md$/i.test(raw) ? raw : raw + ".md";
}

/** Say where the button goes, in the tooltip and to a screen reader. */
export function paintHome() {
  const btn = $("#homeBtn");
  if (!btn) return;
  const p = homeTarget();
  const label = "Home — open " + (p || "the first doc in this vault");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

/** Whatever is first in the tree — never a folder path (see findDoc). */
export function openFirstDoc() {
  const first = findDoc(state.tree, (n) => !n.empty) || findDoc(state.tree, () => true);
  if (first) return openDoc(first);
  toast("This vault has no docs yet");
}

/**
 * A missing home doc is a MISCONFIGURATION, not a dead end.
 *
 * Falling back silently would hide the fact that the setting names nothing, and
 * refusing outright would leave the button inert — so it does what a broken
 * `[[link]]` already does in this app (SPEC §5): says what is wrong and offers
 * to create it. Cancel is not a dead end either; it opens the first doc, so the
 * button always lands somewhere.
 */
export function goHome() {
  const p = homeTarget();
  if (!p) return openFirstDoc();
  if (state.docPaths.has(p)) return openDoc(p);
  confirmDialog({
    title: "Home doc does not exist",
    path: p,
    body:
      "Settings › Editing › Home doc names a doc this vault does not have. Create it now, or cancel to open the first doc instead.",
    ok: "Create it",
    /* a create is not a delete: no warning glyph, no red button, and a footer
       that says what actually happens */
    danger: false,
    note: "Creates the file and opens it.",
    onOk: () => createHome(p),
    onCancel: () => openFirstDoc(),
  });
}

async function createHome(path) {
  try {
    await api.createEntry({ path, type: "doc", markdown: "# " + path.split("/").pop().replace(/\.md$/i, "") + "\n\n" });
    await loadTree();
    await openDoc(path);
    toast("Created " + path);
  } catch (err) {
    /* it appeared under us (another tab, an external edit, a pulled commit) —
       that is the outcome we wanted, so open it rather than reporting a clash */
    if (err && err.code === "exists") {
      await loadTree().catch(() => {});
      return openDoc(path);
    }
    apiFail(err, "Could not create " + path);
  }
}

/* ============================================================
   PANELS / MOBILE
   ============================================================ */
export const app = $("#app");

/* ------------------------------------------------------------------
   THE ONE RESPONSIVE AXIS

   Width, and nothing else. There is deliberately no `pointer: coarse` anywhere
   in this app: an iPad with a keyboard and an iPad without one present the
   same layout problem, and a second axis answers it twice — differently.

   These three numbers are the SAME three base.css §11 is written in, and the
   comment there derives them (widest sidebar 262px + a 520px measure floor +
   the document's gutters + widest chat 352px). If one moves, both move.

     W_SHEET   768   below: sidebar drawer + chat BOTTOM SHEET, no ⌘ chords
     W_DOCK   1024   below: the sidebar is a DRAWER, not a column
     W_TRIPANE 1280  at or above: the chat is a COLUMN, not an overlay
   ------------------------------------------------------------------ */
const W_SHEET = 768;
const W_DOCK = 1024;
const W_TRIPANE = 1280;
/** Phone: the chat is a bottom sheet and there is no hardware keyboard to assume. */
export const isSheet = () => window.innerWidth < W_SHEET;
/** Phone or tablet: the sidebar is off-canvas, so `nav-open` means something. */
export const isDrawer = () => window.innerWidth < W_DOCK;
/** The chat takes width from the document rather than covering it. */
export const isTriPane = () => window.innerWidth >= W_TRIPANE;

export function openNav() {
  app.classList.add("nav-open");
  syncScrim();
}
export function closeNav() {
  app.classList.remove("nav-open");
  syncScrim();
}

/**
 * Show/hide the assistant.
 *
 * `open` is a PREFERENCE, not a layout: above W_TRIPANE the class drives a grid
 * column, below it the same class drives a fixed overlay (base.css §11), and
 * either way the panel stays in the DOM — which is what preserves the draft.
 *
 * `persist:false` is for the collapses the APP performs on the user's behalf —
 * arriving at Settings on a phone, where the sheet would cover the page it just
 * navigated to. Recording that as "the user closed the assistant" would mean a
 * detour through Settings silently changed a layout choice.
 */
export function toggleChat(opts) {
  app.classList.toggle("chat-open");
  const open = app.classList.contains("chat-open");
  $("#chatBtn").classList.toggle("on", open);
  $("#chatBtn").setAttribute("aria-expanded", open ? "true" : "false");
  /* the panel collapses (to a zero-width grid column, or off-canvas) but stays
     in the DOM — so focus must not be left sitting inside something the user
     can no longer see */
  if (!open) {
    const c = $("#composer");
    if (c && document.activeElement === c) c.blur();
  }
  if (!opts || opts.persist !== false) cacheLook("chat", open ? "open" : "closed");
  syncScrim();
}

/**
 * The assistant's open/closed state at boot.
 *
 * It is REMEMBERED now. It was not before, and the cost was measured: the shell
 * ships `class="app chat-open"`, so every reload at a tablet width re-entered
 * the three-pane grid and handed the document a 172px column — you could close
 * it, and the next load undid that. A remembered `closed` is now honoured at
 * every width.
 *
 * With nothing remembered the default is open only where the chat is a COLUMN.
 * Below W_TRIPANE `chat-open` means an overlay lying across the document, and
 * a first run should not begin behind one.
 */
export function initChatOpen() {
  let stored = null;
  try {
    stored = localStorage.getItem("znotes.chat");
  } catch (e) {
    /* private mode: fall through to the width default */
  }
  let open = stored === "open" || stored === "closed" ? stored === "open" : isTriPane();
  /* the phone's sheet is a layer, and a layer is never what you arrive behind */
  if (isSheet()) open = false;
  app.classList.toggle("chat-open", open);
  $("#chatBtn").classList.toggle("on", open);
  $("#chatBtn").setAttribute("aria-expanded", open ? "true" : "false");
  syncScrim();
}

/**
 * The scrim belongs to the SIDEBAR DRAWER and to nothing else.
 *
 * It used to cover the document whenever the chat sheet was up, and measured at
 * 390x844 that meant 204px of visible document answering `elementFromPoint`
 * with #scrim: unreadable, unscrollable, and dismissing the sheet was the only
 * thing a tap could do. The assistant is a panel you consult ALONGSIDE a
 * document; the drawer is a menu you are inside of, and only that is modal.
 */
export function syncScrim() {
  const need = isDrawer() && app.classList.contains("nav-open");
  $("#scrim").classList.toggle("show", need);
}

/**
 * THE SOFT KEYBOARD, published as one CSS length.
 *
 * `visualViewport` is the only thing that reports how much of the layout
 * viewport an on-screen keyboard is covering; without it the composer sits
 * underneath the keyboard it just raised. One listener, one custom property,
 * and a clean no-op where the API is absent (it is not in the headless shell,
 * where the overlap is 0 in any case).
 *
 * `--kb` is applied to the SHARED `.doc` container and to the chat panel — and
 * never to #rawArea. A mobile-only inset on the raw textarea is precisely the
 * mode-parity break the SPEC §11 gate exists to catch, and the gate could not
 * catch this one: headless there is no keyboard, so `--kb` is always 0 there.
 */
export function wireVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const publish = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", Math.round(overlap) + "px");
  };
  vv.addEventListener("resize", publish);
  publish();
}
