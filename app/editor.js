/* ============================================================
   editor.js — the Edit/Source lifecycle, the save pipeline, the exit guard.

   Edit is the BlockNote island (`app/block-editor.tsx`, mounted from
   `/vendor/editor.js`); Source is the line editor in `rawedit.js` (ADR 0032).
   The persisted mode ids are still `preview` and `raw` — every setting, history
   entry, CSS hook and WebMCP enum is written in them.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, activeDoc, apiFail, copyText, countWords, el, esc, lookupLink, toast } from "./ui.js";
import { commitRename, focusQuiet } from "./tree.js";
import { changedLineDiff, conflictDialog, orphanDialog, renderDiff } from "./dialogs.js";
import { bindSecretIds, flushSecretEdits, releaseSecretIds, repaintSecretsUI, secretEl, vault } from "./secrets.js";
import { refreshSessionStats } from "./chat.js";
import { exitSettings, guardSettingsExit, settingAt } from "./settings.js";
import { closeNav, isDrawer, isSheet, markerForLayer, overlayOpen, rememberLastDoc, retireLayerMarker, revealInTree, routeDoc } from "./shell.js";
import { pendingHistory, recordHistory, stepHistory } from "./history.js";
import { createRawEditor } from "./rawedit.js";

/* ============================================================
   EXIT GUARD — leaving a buffer that is not on disk

   The third dialog on the SAME veil chrome as the two above, and for the same
   reason they share one: every one of them asks the single question this app
   has about unsaved work — "what is in front of you is not what is on disk,
   say what happens to it" — and uses the SAME `renderDiff` rows to say what
   "not what is on disk" means. The Raw-exit rows deliberately omit the context
   used by save conflicts; the renderer and modal shell remain shared.

   What it guards is every way out of a DIRTY DOC — in both modes, since Edit
   writes into the same buffer Source does — when `editor.confirmBeforeExit` is
   on. With that preference off, the same gate writes first and proceeds without
   mounting the dialog:

     ⌘E / the statusbar mode chip / Esc
        → `setMode("preview")`, gated in setMode itself so all three arrive
          through one door;
     a tree click, a ⌘K pick, a [[link]], the home button
        → `openDoc`, gated for user navigations only (`replace` marks the
          programmatic re-homes — popstate catch-up, the SSE `moved` echo, an
          accepted proposal — which must never stop to ask);
     ⌘, / ⌘/ / the sidebar Settings row
        → `openSettings`;
     the browser BACK button
        → `onPop`, which is the fiddly one; see there.

   HOW IT MEETS AUTOSAVE. It does not fight it. `markDirty` arms a debounce
   (`editor.autosaveSeconds`, 10s) and `visibilitychange`/`pagehide` flush the
   buffer, so a buffer is "unsaved" only inside that window — once autosave has
   run, `diskText` and the buffer agree and there is genuinely nothing left to
   confirm, so leaving is silent. That makes this dialog INTERMITTENT by nature:
   it appears when you leave quickly after typing and not otherwise. That is the
   honest behaviour and the debounce is a product-level decision, not this guard's to
   change.
   ============================================================ */

/**
 * The rows to show, or null when there is nothing to ask about.
 *
 * Null on all four of: the settings view, no doc, no baseline (nothing ever
 * fetched this doc, so the guard cannot say what changed and must not invent
 * it), and a diff with no `+`/`-` rows — which is the "typed a character and
 * deleted it again" case, where `state.dirty` is still true but the buffer and
 * the file are byte-identical. An empty modal in front of an exit is worse than
 * none.
 *
 * `state.dirty` is deliberately NOT the test. It is a flag about keystrokes;
 * this is a byte comparison against what the server last confirmed, which is
 * the thing the dialog then draws. The two agree in the ordinary case and the
 * comparison is right in every case they do not.
 *
 * A REVEALED SECRET that was edited is dirty with no line to show for it: its
 * plaintext is not in the buffer and must never reach a diff, so it gets one
 * row that names the block and nothing else.
 */
export function rawExitDiff() {
  if (state.view === "settings") return null;
  const doc = activeDoc();
  if (!doc || doc.diskText == null) return null;
  const ta = $("#rawArea");
  /* The Source surface is only the truth while it holds something the model has
     not taken yet (`zSourceValue`, see renderRaw): assigning `value` can
     normalize what it was given, and a readback that differs from the model for
     that reason alone is not an edit. */
  const buf = ta && ta.value !== ta.zSourceValue ? ta.value : String(doc.markdown || "");
  /* a refused edit lives only on the screen (`visualStale`): the guard must
     fire for it, since leaving would unmount the only copy without a word */
  if (visualStale === doc) {
    const rows = buf === doc.diskText ? [] : changedLineDiff(doc.diskText, buf);
    return [{ marker: "+", text: "An edit that cannot be written as Markdown (undo it, or discard)" }, ...rows];
  }
  if (buf === doc.diskText) {
    return [...state.reveal.values()].some((e) => e.path === doc.path && e.dirty)
      ? [{ marker: "+", text: "Edited secret block (plaintext hidden)" }]
      : null;
  }
  /* This confirmation is deliberately terser than the save-conflict view:
     the request is to show ONLY what changed from the original document, not
     one unchanged context row on either side. */
  const rows = changedLineDiff(doc.diskText, buf);
  return rows.length ? rows : null;
}

/**
 * THE GATE. `true` ⇒ the caller may leave now; `false` ⇒ the dialog took over
 * and will run `proceed` itself after either the user's answer or the
 * preference-driven save lands.
 *
 * Every caller passes a `proceed` that re-issues its own action with the
 * force/replace flag set, so the answer travels back out through the same code
 * path it came in on rather than through a re-implementation of it.
 */
export function guardRawExit(proceed, onCancel) {
  const rows = rawExitDiff();
  if (!rows) return true;
  /* already asking — a second trigger (Esc under the open dialog, a stray
     click) must not stack a second copy or replace the pending destination */
  if (state.exitGuard) {
    if (onCancel) onCancel();
    return false;
  }
  const doc = activeDoc();
  if (!settingAt("editor.confirmBeforeExit")) {
    /* The gate stays synchronous for every caller: false means "do not leave
       yet", exactly as it does while the dialog owns the destination. Hold
       that destination in the same slot while the write is in flight, then
       replay the caller's own action only after the server confirms it. */
    const g = { path: doc.path, proceed: proceed, onCancel: onCancel || null, automatic: true };
    state.exitGuard = g;
    void saveDoc(g.path).then((ok) => {
      /* A later owner can only arise by explicit cleanup; never let this save
         retire or navigate for somebody else's pending exit. */
      if (state.exitGuard !== g) return;
      state.exitGuard = null;
      if (!ok) {
        if (g.onCancel) g.onCancel();
        return toast("Could not save " + g.path + " — your changes are still in this tab");
      }
      exitGuardProceed(g);
    });
    return false;
  }
  state.exitGuard = { path: doc.path, proceed: proceed, onCancel: onCancel || null };
  $("#xgPath").textContent = doc.path;
  $("#xgBody").textContent =
    "This is what is in the editor but not in the file. Leaving now without saving throws it away.";
  renderDiff($("#xgDiff"), rows);
  $("#xgVeil").classList.add("show");
  /* THE VEIL TAKES FOCUS, NOT A BUTTON — the same rule `orphanDialog` learned
     the hard way. This dialog is raised by Esc and by the browser Back button
     as often as by a click, i.e. with the caret in the middle of a sentence,
     and a focused button is pressed by the space bar. Tab, Enter on a chosen
     button and Esc all still work; no verb is sitting under the next keystroke,
     and neither of the two that leave is one. */
  setTimeout(() => {
    const m = $("#xgVeil .modal");
    if (m && $("#xgVeil").classList.contains("show")) focusQuiet(m);
  }, 30);
  return false;
}

/** KEEP EDITING — Esc, a click on the scrim, Back. Same thing. */
export function closeExitGuard() {
  const g = state.exitGuard;
  state.exitGuard = null;
  $("#xgVeil").classList.remove("show");
  if (!g) return;
  /* back to exactly where you were: same mode, still dirty, caret in the text.
     The dialog cost a focus and nothing else. */
  const ta = $("#rawArea");
  if (state.mode === "raw") {
    if (ta) focusQuiet(ta);
  } else visual?.focus();
  /* KEEP EDITING IS A CANCELLATION for whoever was trying to leave. Almost
     every caller passes no hook — its action simply does not happen, which is
     the whole point of the guard. The one that has to hear about it is the
     undo timeline (ADR 0014): `applyFileHistory` is awaiting a promise, and
     without this it never settles, so the entry it is holding never goes back
     on offer. */
  if (g.onCancel) g.onCancel();
}

/** Hand the pending destination back its go-ahead, once. */
function exitGuardProceed(g) {
  if (g && g.proceed) g.proceed();
}

/**
 * DISCARD — put the saved document back in the buffer, then leave.
 *
 * The revert is written into BOTH the model and the editor before `proceed`
 * runs, because two of the destinations (`openDoc`, `setMode`) open with a
 * `syncRaw()` that copies the editor over the model — reverting only the
 * model would have the buffer immediately overwrite it.
 *
 * A REVEAL is part of what is being discarded: its plaintext was typed against
 * text that no longer exists, so the entry goes and the block paints locked
 * again from the restored armor.
 */
export function exitGuardDiscard() {
  const g = state.exitGuard;
  /* This route LEAVES, so it is not the cancellation `closeExitGuard` reports
     — hand the hook off before closing so it cannot fire on the way through. */
  if (g) g.onCancel = null;
  closeExitGuard();
  if (!g) return;
  const doc = state.docs.get(g.path);
  if (doc && doc.diskText != null) {
    doc.markdown = doc.diskText;
    for (const [key, entry] of state.reveal) if (entry.path === g.path) state.reveal.delete(key);
    if (g.path === state.active) {
      /* the screen is the discarded text again, so whatever refused to
         serialize is gone with it and this doc may be written once more */
      visualStale = null;
      visual?.setMarkdown(doc.markdown);
      repaintSecretsUI();
      syncRawFromModel(doc);
      /* the restored text is where the next undo run starts from, in either
         mode — `syncRawFromModel` only reaches the Source surface */
      markTextBaseline(g.path, doc.markdown);
      /* the debounce is armed against text that no longer exists */
      clearTimeout(dirtyT);
      state.dirty = false;
      setSaveIndicator("Saved");
      updateMeta();
    }
  }
  exitGuardProceed(g);
}

/**
 * SAVE & EXIT — the primary, and the humane default.
 *
 * The user asked for a confirmation before discarding; offering the save as the
 * button under Enter means the safe answer is also the easy one, and the
 * destructive answer stays a deliberate second choice.
 *
 * Leaving is conditional on the write LANDING. `saveDoc` returns false for an
 * orphaned doc (it raises the Recreate/Discard veil instead) and for a failed
 * PUT — walking away from either would be the silent loss this whole dialog
 * exists to stop, so the buffer stays put and says why.
 */
export async function exitGuardSave() {
  const g = state.exitGuard;
  /* Same hand-off as Discard — but held onto, because a save that FAILS
     strands the destination just as surely as Keep editing does, and that is a
     cancellation as far as whoever was leaving is concerned. */
  const cancel = g && g.onCancel;
  if (g) g.onCancel = null;
  closeExitGuard();
  if (!g) return;
  const ok = await saveDoc(g.path);
  if (!ok) {
    if (cancel) cancel();
    return toast("Could not save " + g.path + " — your changes are still in this tab");
  }
  /* A write that landed and left the buffer dirty anyway (a keystroke mid-flight,
     a reveal still waiting for the worker) has not answered the question this
     dialog asked, so it asks again rather than leaving the new text behind. */
  if (g.path === state.active && rawExitDiff()) {
    guardRawExit(g.proceed, cancel);
    return;
  }
  exitGuardProceed(g);
}

/* ============================================================
   SOURCE MODE (`raw`)

   EVERY STRUCTURAL EDIT THIS FILE MAKES GOES THROUGH `ta.replaceRange`, the
   Raw surface's own write primitive (ADR 0032): the one path into the buffer
   that keeps the model and the DOM agreeing, and it fires the `input` event
   itself, so the listener in `renderRaw` still runs (dirty, meta, the caret)
   without anyone dispatching one by hand. It used to be `document.execCommand`,
   for one reason that no longer exists: reaching a textarea's undo stack. ⌘Z
   has been the app's one timeline since ADR 0014.
   ============================================================ */
export function autoGrow(ta) {
  /* Raw is a contenteditable now (ADR 0032) and grows by itself; the composer
     and the `.secret-edit` reveal editor are still textareas that do not. */
  if (!(ta instanceof HTMLTextAreaElement)) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function revealRawCaret() {
  const ta = $("#rawArea");
  const sc = $("#scroll");
  if (!ta || !sc || document.activeElement !== ta) return;
  const root = getComputedStyle(document.documentElement);
  const cssKeyboard = parseFloat(root.getPropertyValue("--kb")) || 0;
  /* …and the editing bar standing on the keyboard's top edge (ADR 0034), which
     is chrome the caret has to clear too. `keybar.js` publishes the bar's own
     rendered height, so this is 0 at every moment the bar is not up. */
  const cssKeybar = parseFloat(root.getPropertyValue("--keybar")) || 0;
  const vv = window.visualViewport;
  const vvTop = vv ? vv.offsetTop : 0;
  const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const visibleTop = Math.max(sc.getBoundingClientRect().top, vvTop) + 12;
  const visibleBottom =
    Math.min(sc.getBoundingClientRect().bottom, vvBottom, window.innerHeight - cssKeyboard - cssKeybar) - 12;
  if (visibleBottom <= visibleTop) return;
  const caret = ta.boxAt(ta.selectionEnd);
  /* CEILED, both ways: these are sub-pixel box coordinates and `scrollTop`
     lands on a device pixel, so a delta of 11.6 leaves the caret a fraction of
     a pixel short of clear — true, invisible, and enough to fail an assertion
     that asks for clear. */
  if (caret.bottom > visibleBottom) sc.scrollTop += Math.ceil(caret.bottom - visibleBottom);
  else if (caret.top < visibleTop) sc.scrollTop -= Math.ceil(visibleTop - caret.top);
}

let caretFrame = 0;
let caretSettle = 0;
/** Keep the Raw insertion point inside the visual viewport, not merely inside
 * the taller layout viewport that continues underneath a soft keyboard. */
export function keepRawCaretVisible() {
  cancelAnimationFrame(caretFrame);
  clearTimeout(caretSettle);
  caretFrame = requestAnimationFrame(revealRawCaret);
  /* Mobile viewport changes and the keyboard animation do not always finish in
     one frame. Recheck once settled; calls during typing coalesce here. */
  caretSettle = setTimeout(revealRawCaret, 220);
}

function applyWordWrap(ta) {
  /* the surface's own `wrap` setter carries the `no-wrap` class with it */
  if (ta) ta.wrap = state.wordWrap ? "soft" : "off";
}

export function syncWrapUI() {
  const chip = $("#stWrap");
  if (!chip) return;
  const raw = state.view === "doc" && state.mode === "raw";
  chip.hidden = !raw;
  chip.dataset.wrap = state.wordWrap ? "on" : "off";
  chip.title = (state.wordWrap ? "Disable" : "Enable") + " Source word wrapping (⌥Z)";
  const txt = $("#stWrapTxt");
  if (txt) txt.textContent = state.wordWrap ? "Wrap" : "No wrap";
}

export function initWordWrap() {
  try {
    state.wordWrap = localStorage.getItem("znotes.wrap") !== "off";
  } catch (_) {
    state.wordWrap = true;
  }
  syncWrapUI();
}

export function toggleWordWrap() {
  if (state.view !== "doc" || state.mode !== "raw") return;
  state.wordWrap = !state.wordWrap;
  try {
    localStorage.setItem("znotes.wrap", state.wordWrap ? "on" : "off");
  } catch (_) {}
  applyWordWrap($("#rawArea"));
  syncWrapUI();
}

/* The renderer accepts any run of decimal digits. Number arithmetic turns a
   long marker into scientific notation, so carry the source digits directly. */
function incrementDecimal(value) {
  const digits = value.split("");
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === "9") {
    digits[i] = "0";
    i--;
  }
  if (i < 0) digits.unshift("1");
  else digits[i] = String.fromCharCode(digits[i].charCodeAt(0) + 1);
  return digits.join("");
}

/**
 * The list half of a continuation, read from the line's text — which is the
 * whole line, or what is left of it after a quote's markers.
 *
 * Its own function precisely so a quoted list can be BOTH: `> - item` carries
 * the markers and the bullet, and each half ends where it would have ended on
 * its own.
 */
function listContinuation(text) {
  const list = /^(?<indent>[ \t]*)(?:(?<bullet>[-*+])|(?<number>\d+)(?<delim>[.)]))(?<gap>[ \t]+)(?:\[(?<check>[ xX])\](?<checkGap>[ \t]*))?/.exec(text);
  if (!list) return null;
  const g = list.groups || {};
  const marker = g.bullet || incrementDecimal(g.number) + g.delim;
  return {
    prefix: g.indent + marker + g.gap + (g.check == null ? "" : "[ ]" + (g.checkGap || " ")),
    emptyItem: !text.slice(list[0].length).trim(),
  };
}

/**
 * The prefix a markdown editor carries onto the next line.
 *
 * Whitespace is copied byte-for-byte. Quote markers repeat at the depth they
 * were typed, bullets keep their marker, tasks restart unchecked, and ordered
 * items advance while retaining `.` versus `)`. A plain indented line keeps
 * only its indentation. Returning null means the browser should perform its
 * ordinary newline.
 *
 * `emptyPrefix` is what an empty item leaves behind when Enter ends it: the
 * quote's own markers under a quoted bullet, nothing at all otherwise.
 */
function markdownContinuation(value, caret) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const before = value.slice(lineStart, caret);
  /* A quote continues the way a list does (spec 0019), and the markers are
     carried EXACTLY as typed, so `> > ` stays two deep and a marker written
     without its space keeps its own spelling. */
  const quote = /^(?<indent>[ \t]*)(?<markers>(?:>[ ]?)+)/.exec(before);
  if (quote) {
    const g = quote.groups;
    const rest = before.slice(quote[0].length);
    /* A LIST INSIDE A QUOTE is both things, so both carry: `> - item` returns
       `> - `, and the bullet is what an empty one drops — Enter on `> - `
       leaves `> `, the way Enter on `  - ` leaves the outer level, and only a
       bare `> ` ends the quote. */
    const inner = listContinuation(rest);
    const markers = g.indent + g.markers;
    return {
      lineStart,
      prefix: markers + (inner ? inner.prefix : ""),
      emptyItem: inner ? inner.emptyItem : !rest.trim(),
      emptyPrefix: inner ? markers : "",
    };
  }
  const list = listContinuation(before);
  if (list) return { lineStart, prefix: list.prefix, emptyItem: list.emptyItem, emptyPrefix: "" };
  const indent = /^[ \t]+/.exec(before);
  return indent ? { lineStart, prefix: indent[0], emptyItem: false, emptyPrefix: "" } : null;
}

function continueMarkdownLine(e, ta) {
  if (e.key !== "Enter" || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  /* A modal over the editor owns Enter. In particular, the unsaved-exit guard
     opens before its delayed focus move has necessarily landed. */
  if (overlayOpen()) return;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const next = markdownContinuation(ta.value, a);
  if (!next) return;
  e.preventDefault();
  const lineEnd = ta.value.indexOf("\n", a);
  if (next.emptyItem && a === b && (lineEnd < 0 || a === lineEnd)) {
    /* An empty list item already IS the next line. Enter exits the list by
       removing its prefix instead of producing an endless run of markers —
       one level of it: an empty bullet inside a quote leaves the quote. */
    ta.replaceRange(next.lineStart, a, next.emptyPrefix);
  } else {
    ta.replaceRange(a, b, "\n" + next.prefix);
  }
}

const RAW_LIST = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

function leadingOutdent(line, size) {
  if (line[0] === "\t") return line.slice(1);
  const m = /^ +/.exec(line);
  return m ? line.slice(Math.min(size, m[0].length)) : line;
}

/**
 * Move every line the selection touches one hierarchy level — the Tab edit,
 * with no key attached to it. On a list line the whole item moves; elsewhere
 * the configured spaces go on or come off. `outdent` is what ⇧ meant.
 *
 * Lifted out of the key handler because two doors now open onto it that have
 * no Tab to press: the soft keyboard's editing bar (ADR 0034) and the agent's
 * `indent_lines` (ADR 0031). One function, so a button and the chord cannot
 * drift apart. `false` means there was nothing to act on — no Raw editor, or a
 * dialog over it — which is what those callers report back as a refusal.
 */
export function indentSelection(outdent) {
  const ta = $("#rawArea");
  if (!ta || state.mode !== "raw" || overlayOpen()) return false;
  const size = Number(settingAt("editor.tabSize"));
  const spaces = " ".repeat(Number.isFinite(size) && size > 0 ? size : 2);
  const value = ta.value;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const lineStart = value.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
  let touchedEnd = b;
  if (b > a && value[b - 1] === "\n") touchedEnd--;
  let lineEnd = value.indexOf("\n", touchedEnd);
  if (lineEnd < 0) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const multi = block.includes("\n");
  const currentLine = block.slice(0, block.indexOf("\n") < 0 ? block.length : block.indexOf("\n"));

  if (!outdent && !multi && !RAW_LIST.test(currentLine) && a === b) {
    ta.replaceRange(a, b, spaces);
    return true;
  }

  const lines = block.split("\n");
  const changed = lines.map((line) => (outdent ? leadingOutdent(line, spaces.length) : spaces + line));
  const replacement = changed.join("\n");
  if (replacement === block) return true;
  const firstDelta = changed[0].length - lines[0].length;
  const totalDelta = replacement.length - block.length;
  ta.replaceRange(lineStart, lineEnd, replacement);
  if (a === b) {
    const caret = Math.max(lineStart, a + firstDelta);
    ta.setSelectionRange(caret, caret);
  } else {
    ta.setSelectionRange(Math.max(lineStart, a + firstDelta), Math.max(lineStart, b + totalDelta));
  }
  return true;
}

/** Tab is source editing in Raw, never focus navigation — it is swallowed
 * whether or not the edit above could happen, because the one thing it must
 * never do here is move the focus to the next control. */
function editRawTab(e) {
  if (e.key !== "Tab" || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault();
  e.stopPropagation();
  indentSelection(e.shiftKey);
  return true;
}

function moveListGutterCaret(ta) {
  if (ta.selectionStart !== ta.selectionEnd) return;
  const pos = ta.selectionStart;
  const start = ta.value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  let end = ta.value.indexOf("\n", pos);
  if (end < 0) end = ta.value.length;
  const line = ta.value.slice(start, end);
  const m = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/.exec(line);
  if (!m || pos > start + m[1].length) return;
  ta.setSelectionRange(end, end);
}

/* ============================================================
   WHOLE-LINE CUT / COPY / PASTE

   With nothing selected, ⌘X takes the LINE — the convention every code editor
   has kept since it was a Vim `dd`, and the one thing a markdown source pane
   is asked for most: move this bullet, drop that heading.

   Why keydown and not the `cut` / `copy` clipboard events, which would have
   given us the native clipboard for free: those events do not fire at all when
   the selection is COLLAPSED, which is the entire case this exists for. (A
   browser with nothing selected has nothing to cut.) So the gesture is
   recognised as a chord, the document edit goes through the surface's own
   `replaceRange` (ADR 0032), and the clipboard write through `copyText`, the
   app's one clipboard writer, already best-effort on a browser that refuses.

   A SELECTION is never touched: with one, ⌘X/⌘C are the browser's, unchanged.
   ============================================================ */

/** The text this pane last put on the clipboard AS A LINE. `pasteRawLine`
    consults it to decide whether ⌘V should land a whole line above the caret
    rather than inside it — the same "did this come from a line copy?" test the
    convention rests on, and the same false positive it has always had (text
    copied elsewhere that is byte-identical pastes as a line). */
let lineClip = null;

/** The line containing `pos`, as a [start, end) slice of `value`. `end`
    INCLUDES the newline when there is one — a line is its terminator too, or
    cutting one would leave the blank it used to end. */
function lineRange(value, pos) {
  const start = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = value.indexOf("\n", pos);
  return { start, end: nl < 0 ? value.length : nl + 1, terminated: nl >= 0 };
}

function editRawLineClipboard(e, ta) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return false;
  const k = e.key.toLowerCase();
  if (k !== "x" && k !== "c") return false;
  /* Something is selected: this is the browser's gesture, not ours. So is
     anything pressed under a modal — the guard can open while this editor
     still holds focus, and swallowing a copy there would take a chord away
     from the browser to do nothing with it. Both checks come BEFORE the
     preventDefault for that reason. */
  if (ta.selectionStart !== ta.selectionEnd || overlayOpen()) return false;
  e.preventDefault();

  const value = ta.value;
  const pos = ta.selectionStart;
  const { start, end, terminated } = lineRange(value, pos);
  /* The clipboard always gets a TERMINATED line, including from the last line
     of a file that has no trailing newline. That is what makes the round trip
     work: the paste below inserts the clipboard text verbatim at a line start,
     so a line without its "\n" would fuse with whatever it landed on. */
  lineClip = terminated ? value.slice(start, end) : value.slice(start, end) + "\n";
  copyText(lineClip, { quiet: true });
  if (k === "c") return true;

  /* The last line of the file has no newline of its own, so it takes the one
     BEFORE it — otherwise cutting it leaves the empty line it used to follow. */
  const from = terminated ? start : Math.max(0, start - 1);
  ta.replaceRange(from, end, "");
  /* THE CARET LANDS AT THE START OF THE LINE that moved up into this row.

     Not the column it held — which is what a code editor does, and what this
     did first. In a markdown outline it is the wrong answer nearly every time:
     the lines being cut are list items, the caret is usually somewhere inside
     the text (or at the end of it, since clicking a list gutter parks it
     there), and keeping the column drops you into the MIDDLE of the next item
     — `- [ ] brav|o`. Column 0 is where the next thing you do to a line
     starts, and it is the same answer for every line whatever you cut. */
  const landing = lineRange(ta.value, Math.min(from, ta.value.length));
  ta.setSelectionRange(landing.start, landing.start);
  return true;
}

/** ⌘V of something that was cut or copied AS A LINE puts it back as a line —
    above the caret's line, caret riding down with its own text. Anything else
    (a different clipboard, a selection to replace) is the browser's paste. */
function pasteRawLine(e, ta) {
  if (lineClip == null || ta.selectionStart !== ta.selectionEnd) return;
  const text = e.clipboardData && e.clipboardData.getData("text/plain");
  if (text !== lineClip) return;
  e.preventDefault();
  const pos = ta.selectionStart;
  const { start } = lineRange(ta.value, pos);
  ta.replaceRange(start, start, text);
  const caret = pos + text.length;
  ta.setSelectionRange(caret, caret);
}

function rawKeydown(e, ta) {
  if (editRawLineClipboard(e, ta)) return;
  if (editRawTab(e)) return;
  continueMarkdownLine(e, ta);
}

function renderRaw(doc, host) {
  /* Not a textarea: one contenteditable with one block per source line, so a
     heading is drawn at the heading's size and a link in the link's colour
     (ADR 0032). It answers to the textarea's own vocabulary, which is why
     everything below this line is what it always was. */
  const ta = createRawEditor();
  ta.id = "rawArea";
  /* The SAME six attributes the reveal editor carries (research §6,
     "DOM-adjacent services") — they work on a contenteditable exactly as they
     worked on the textarea. ⌘⇧E only works in Raw, so this surface is where
     every secret in the vault is typed BEFORE it becomes ciphertext — it is the
     one place in the app that holds pre-encryption plaintext. */
  ta.spellcheck = false;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("data-gramm", "false");
  ta.setAttribute("data-enable-grammarly", "false");
  ta.value = doc.markdown;
  /* WHAT THIS SURFACE WAS GIVEN, read back out of it. A surface may normalize
     what it is handed (a CRLF document is the case that bites), and `syncRaw`
     must not report that readback as an edit the user made. */
  ta.zSourceValue = ta.value;
  ta.setAttribute("aria-label", "Markdown source · " + doc.path);
  /* the placeholder is a STARTING POINT, not a notice: an empty note announcing
     its own emptiness says nothing the blank page did not already say */
  ta.placeholder = "# " + doc.title;
  ta.style.tabSize = String(settingAt("editor.tabSize"));
  /* A phone keyboard's undo key, shake-to-undo and the Edit menu arrive as
     `historyUndo`/`historyRedo` rather than as ⌘Z, and they mean the same
     thing (ADR 0014): the app's timeline, not the browser's. A BELT, not the
     phone's undo door, which is the keyboard bar (ADR 0034) — the browser
     fires these only for what its own undo manager holds, and rawedit.js
     cancels every cancelable edit, so that is a composition's leavings. */
  ta.onHistory = (redo) => {
    flushTextRun();
    if (pendingHistory(redo)) stepHistory(redo);
  };
  ta.addEventListener("input", () => {
    /* BEFORE the model moves: the run's `before` is whatever the last closed
       run left, and opening the run has to happen while that is still true. */
    noteTextEdit(doc.path);
    doc.markdown = ta.value;
    ta.zSourceValue = ta.value;
    markDirty();
    updateMeta();
    keepRawCaretVisible();
  });
  ta.addEventListener("keydown", (e) => rawKeydown(e, ta));
  ta.addEventListener("paste", (e) => pasteRawLine(e, ta));
  /* A copy or cut that reaches the browser had a SELECTION (the collapsed case
     never gets here — `editRawLineClipboard` swallows it), so the clipboard now
     holds something that is not a line, and the next ⌘V is an ordinary paste. */
  ta.addEventListener("copy", () => (lineClip = null));
  ta.addEventListener("cut", () => (lineClip = null));
  ta.addEventListener("focus", keepRawCaretVisible);
  ta.addEventListener("select", keepRawCaretVisible);
  ta.addEventListener("click", () => {
    moveListGutterCaret(ta);
    keepRawCaretVisible();
  });
  host.appendChild(ta);
  applyWordWrap(ta);
}

/* pull pending editor edits into the cache before anything re-renders */
export function syncRaw() {
  if (state.mode !== "raw") return;
  const ta = $("#rawArea");
  const doc = activeDoc();
  /* only what the surface actually holds that the model does not: see
     `renderRaw` on `zSourceValue` */
  if (ta && doc && ta.value !== ta.zSourceValue) {
    doc.markdown = ta.value;
    ta.zSourceValue = ta.value;
  }
  /* THE RUN BOUNDARY. Every caller of this is a moment the user left the text
     alone — a mode switch, a doc switch, a save — which is exactly where "what
     I just typed" ends. One flush here covers all three rather than three
     flushes that could drift apart. */
  flushTextRun();
}

/**
 * Push the model back into the Raw editor after something OTHER than typing
 * moved it. `syncRaw` is one-way (editor → model) and doSaveDoc runs it
 * BEFORE `flushSecretEdits`, so a re-encrypt that lands while the pane is in
 * Raw left the editor holding the pre-flush armor — and the next syncRaw
 * (every mode switch does one) wrote that stale armor back over the ciphertext
 * that had just been saved, reverting the edit on disk under a "Saved" toast.
 *
 * The swap is never at the caret (it rewrites a fence body the user is not
 * typing into), so clamping the selection to the new length is enough.
 */
export function syncRawFromModel(doc) {
  if (state.mode !== "raw" || !doc || doc.path !== state.active) return;
  const ta = $("#rawArea");
  if (!ta || ta.value === doc.markdown) return;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  ta.value = doc.markdown;
  ta.zSourceValue = ta.value;
  const n = ta.value.length;
  try {
    ta.setSelectionRange(Math.min(a, n), Math.min(b, n));
  } catch (_) {}
  /* The model moved for a reason that was not typing (a re-encrypt, an
     accepted proposal), so this is where the next run starts from — recording
     it as an edit would put a ciphertext swap on the user's undo timeline. */
  markTextBaseline(doc.path, doc.markdown);
}

/* ============================================================
   EDITOR SHELL
   ============================================================ */
export function updateMeta() {
  const doc = activeDoc();
  if (!doc) return;
  const md = String(doc.markdown || "");
  const n = md === "" ? 0 : md.replace(/\n$/, "").split("\n").length;
  $("#stLines").textContent = n + (n === 1 ? " line" : " lines");
  $("#stWords").textContent = countWords(md) + " words";
}

function renderCrumbs(doc) {
  $("#crumbs").innerHTML = doc.path
    .split("/")
    .map((p, i, a) =>
      i === a.length - 1
        ? '<b class="chip-mono"><button class="crumb-name" data-act="rename-active" title="Rename ' +
          esc(doc.path) +
          '" aria-label="Rename ' +
          esc(doc.path) +
          '">' +
          esc(p) +
          "</button></b>"
        : '<span class="cr-dir">' + esc(p) + "</span>"
    )
    .join('<span class="sep cr-dir">/</span>');
}

export function startHeaderRename() {
  const doc = activeDoc();
  const button = $("#crumbs .crumb-name");
  if (!doc || !button) return;
  const holder = button.parentElement;
  const input = document.createElement("input");
  input.className = "crumb-rename";
  input.setAttribute("aria-label", "Rename " + doc.path);
  const slash = doc.path.lastIndexOf("/");
  const parent = slash < 0 ? "" : doc.path.slice(0, slash + 1);
  input.value = doc.path.slice(slash + 1);
  holder.replaceChildren(input);
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      input.disabled = true;
      await commitRename({ path: doc.path, type: "file" }, parent + input.value);
    }
    if (!input.isConnected) return;
    const now = activeDoc();
    if (now) renderCrumbs(now);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    void finish(e.key === "Enter");
  });
  input.addEventListener("blur", () => void finish(true));
  focusQuiet(input);
  const stemEnd = input.value.replace(/\.md$/i, "").length;
  try {
    input.setSelectionRange(0, stemEnd);
  } catch (_) {}
}

/* ============================================================
   EDIT MODE (`preview`) — the BlockNote island

   One mounted controller at a time, for one path. The island is a leaf by
   construction: it speaks markdown, lines and callbacks, and knows nothing
   about the shell — every bridge back into the app is in this section.

   LINE NUMBERS. The island counts source lines from 1 (a file's own
   numbering); everything in this file counts from 0. The conversion happens
   here and nowhere else.
   ============================================================ */
let visual = null;
let visualPath = null;
/* THE BUFFER STOPPED FOLLOWING THE SCREEN. The island could not write the
   document back as Markdown, so `doc.markdown` is the last text that DID
   serialize — older than what the user can see. Writes for that doc are refused
   until an edit serializes again: autosaving those bytes would replace the
   visible edit with the previous ones, and say "Saved" while doing it. The DOC
   OBJECT, not its path: a rename moves the buffer, not the problem. */
let visualStale = null;
/* Mounting is asynchronous, so a second render can start before the first has
   finished importing. Only the newest generation may install itself. */
let mountGeneration = 0;
/* a reveal asked for before the island existed: `{ line, anchor }`, 0-based */
let pendingReveal = null;
let editorBundle;

/** Unmount, and hand the secret ids the island was holding back to secrets.js
    so the next mount can bind its own. Called before every re-render. */
export function destroyEditor() {
  mountGeneration++;
  pendingReveal = null;
  visualStale = null;
  if (visual) {
    releaseSecretIds(visualPath, visual.getSecrets());
    visual.destroy();
  }
  visual = null;
  visualPath = null;
}

/** Whether the mounted island still holds a step of its OWN history. Undo in
    Edit is BlockNote's (ADR 0014 as amended) only for as long as this is true:
    with that history exhausted ⌘Z is the app timeline's again, so a file
    operation made from inside Edit is still undoable without leaving it. */
export function visualCanStep(redo) {
  if (!visual) return false;
  return redo ? visual.canRedo() : visual.canUndo();
}

/** Swap one block's ciphertext in the mounted island — the Edit-mode half of
    `replaceArmorInDoc` (secrets.js), keyed by the block id rather than by the
    armor, because identical ciphertext can appear twice in one doc. */
export function replaceVisualSecret(path, id, ciphertext) {
  if (visualPath !== path || !visual) return null;
  return visual.replaceSecret(id, ciphertext);
}

function revealVisual(line, anchor) {
  if (visual) visual.revealLine(line + 1, anchor);
  else pendingReveal = { line, anchor };
}

async function renderVisual(doc, host) {
  const generation = mountGeneration;
  const surface = el("div", "block-editor-host");
  surface.textContent = "Loading editor…";
  host.appendChild(surface);
  try {
    /* The bundle is fetched once per page and cached; a failed import must not
       be cached, or a recovered network would never get a second chance. */
    editorBundle ||= import("/vendor/editor.js").catch((err) => {
      editorBundle = null;
      throw err;
    });
    const css = $("#editor-css");
    /* The stylesheet is a plain <link> in the head, so the only honest signals
       are its own events and the flags its inline handlers leave behind (the
       load may have finished before this code ever ran). */
    const stylesheet = new Promise((resolve, reject) => {
      if (css.dataset.failed) return reject(new Error("Editor stylesheet failed"));
      if (css.sheet || css.dataset.loaded) return resolve();
      css.addEventListener("load", resolve, { once: true });
      css.addEventListener("error", reject, { once: true });
    });
    const [{ mountEditor }] = await Promise.all([editorBundle, stylesheet]);
    if (generation !== mountGeneration || !surface.isConnected) return;
    surface.textContent = "";
    visualPath = doc.path;
    visual = mountEditor(surface, {
      markdown: doc.markdown,
      copyText,
      onChange(markdown) {
        if (generation !== mountGeneration) return;
        visualStale = null;
        doc.markdown = markdown;
        /* NOT `noteTextEdit`: undo inside Edit is the island's own
           (ProseMirror history, ADR 0014 as amended) — recording every
           transaction on the app timeline would give ⌘Z two owners. */
        markDirty();
        updateMeta();
      },
      onSource(line) {
        line = Math.max(0, line - 1);
        setMode("raw", { caret: lineOffset(doc.markdown, line), line });
      },
      /* The document on screen is not expressible as Markdown (nesting the
         adapter cannot re-import, formatting Source owns). Saying so beats a
         document that quietly stops being written: the buffer is marked unsaved,
         the write is blocked below, and the edit is still there to undo. */
      onError(message) {
        if (generation !== mountGeneration) return;
        visualStale = doc;
        state.dirty = true;
        setSaveIndicator("Unsaved changes", "dirty");
        toast("This edit cannot be written as Markdown — " + message + ". Undo it, or edit the block in Source.");
      },
      /* The block the island draws for an ```age fence is the app's own secret
         DOM: reveal, edit, copy and lock stay where they have always been, and
         no plaintext ever enters the editor's model. `ord` is the ordinal of
         this ciphertext among the copies of itself ABOVE this block, which is
         what makes two identical fences two different blocks. */
      renderSecret({ id, ciphertext, line, indent = "" }) {
        const prefix = doc.markdown.split("\n").slice(0, line - 1).join("\n");
        const ord = prefix.split(ciphertext).length - 1;
        bindSecretIds(doc.path, ciphertext, ord, id);
        /* the block moved on from the armor a reveal was taken against (an
           edit, a re-encrypt), so that plaintext no longer describes it */
        for (const [key, entry] of state.reveal) {
          if (entry.path === doc.path && entry.ord === id && entry.armor !== ciphertext) state.reveal.delete(key);
        }
        const existing = $$("#doc .secret").find((n) => n.zSecret?.ord === id && n.zSecret.armor === ciphertext);
        return existing || secretEl(doc.path, ciphertext, indent, id);
      },
      resolveWikiLink(target) {
        return lookupLink(target).path || undefined;
      },
      /* through the app's ONE link handler (app.js), so multi-vault
         resolution, the create-on-missing branch and the exit guard all behave
         exactly as they do for a pill the user clicked */
      onWikiLink(target) {
        const link = el("a", "wl");
        link.dataset.link = target;
        host.appendChild(link);
        link.click();
        link.remove();
      },
    });
    if (pendingReveal) visual.revealLine(pendingReveal.line + 1, pendingReveal.anchor);
    pendingReveal = null;
  } catch (err) {
    if (generation !== mountGeneration || !surface.isConnected) return;
    console.error("The visual editor could not load", err);
    /* THE DOC IS STILL EDITABLE. The bundle or its stylesheet is the only thing
       that failed; Source needs neither, so the pane falls back to it and says
       why instead of leaving a blank page behind (SPEC §11). */
    destroyEditor();
    surface.remove();
    state.mode = "raw";
    syncModeUI();
    host.classList.add("raw-mode");
    const notice = el("div", "note bad");
    notice.textContent = "The visual editor could not load. You can keep editing in Source.";
    host.appendChild(notice);
    renderRaw(doc, host);
  }
}

export function renderDoc(opts) {
  opts = opts || {};
  const doc = activeDoc();
  const host = $("#doc");
  /* before the DOM goes: the island holds secret ids and a React root, and
     both have to be handed back rather than thrown away with the innerHTML */
  destroyEditor();
  host.innerHTML = "";
  if (!doc) return;
  host.classList.toggle("raw-mode", state.mode === "raw");
  /* ONE TAB IS ONE WIDTH IN BOTH MODES. `.raw` carries the setting on its own
     element (`renderRaw`), and the shared container is where the island
     inherits it from. */
  host.style.tabSize = String(settingAt("editor.tabSize"));

  /* The `.mode-note` that used to end this line is gone: it restated an
     affordance the statusbar's mode chip already names, and it was the one item
     in the meta line that was about the CHROME rather than the doc. */
  const meta = el("div", "doc-meta");
  meta.innerHTML =
    '<span class="tag">' + esc(doc.path) + "</span>" +
    "<span>" + esc(relTime(doc.mtime)) + "</span>";
  host.appendChild(meta);

  /* An empty doc is an empty editor: there is nothing to announce to somebody
     whose caret is already in the place they would type. */
  if (state.mode === "raw") renderRaw(doc, host);
  else renderVisual(doc, host);

  /* the entrance animation belongs to navigation; a mode switch must not
     translate or fade the container (amendment 11) */
  host.classList.remove("fade-in");
  if (!opts.noFade) {
    void host.offsetWidth;
    host.classList.add("fade-in");
  }

  renderCrumbs(doc);
  /* `.statusbar .path` is the one item with a shrink budget, so it is the one
     that ends up ellipsised — and with no `title` a truncated path could not be
     recovered by hover either */
  $("#stPath").textContent = doc.path;
  $("#stPath").title = doc.path;
  updateMeta();
  $$(".row.file").forEach((r) => r.classList.toggle("active", r.dataset.doc === state.active));
}

function relTime(mtime) {
  if (!mtime) return "";
  const mins = Math.round((Date.now() - new Date(mtime).getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return "Edited " + mins + " min ago";
  const h = Math.round(mins / 60);
  return "Edited " + h + (h === 1 ? " hour ago" : " hours ago");
}

/**
 * THE ON-DISK TEXT, remembered beside the buffer.
 *
 * `doc.markdown` cannot answer "what is on disk?" — the Raw editor writes
 * straight into it on every keystroke (see `renderRaw`), so by the time
 * anything asks, the model and the buffer are the same string. `doc.diskText`
 * is the last markdown the SERVER confirmed, and it is the only thing the exit
 * guard can honestly diff against.
 *
 * Every arrival from the server and every successful write goes through here.
 * A doc with no baseline (nothing ever fetched it) is treated as CLEAN by
 * `rawExitDiff`, never as dirty: a guard that cannot say what changed has
 * nothing to show, and an empty modal in front of an exit is worse than no
 * modal at all.
 *
 * Named `diskText`, not `saved`: this object is `Object.assign`ed over with
 * raw `/api/docs/{path}` response bodies in five places, and a field the
 * server might one day also send would be silently clobbered by one of them.
 */
export function setBaseline(doc, text) {
  if (doc) {
    doc.diskText = String(text == null ? doc.markdown || "" : text);
    /* Every route through here is the document arriving from the SERVER —
       fetched, saved, reloaded after an external write. None is an edit, so
       none may become an undo entry, and each is where the next run starts. */
    markTextBaseline(doc.path, doc.markdown);
  }
  return doc;
}

export async function ensureLoaded(path) {
  const cached = state.docs.get(path);
  if (cached && cached.loaded) return cached;
  const d = await api.getDoc(path);
  const merged = Object.assign({}, cached || {}, d, { loaded: true });
  setBaseline(merged, d.markdown);
  state.docs.set(path, merged);
  return merged;
}

/**
 * Replace a doc's text without a keystroke: the write half of `webmcp.js`.
 * It goes through the pipeline typing goes through rather than PUTting behind
 * the app's back. The buffer is pulled in first, so a character the user
 * typed but did not save is not dropped. The change lands as one step on the
 * shared timeline, so ⌘Z takes it back like any other edit (ADR 0014). The
 * open pane repaints, and `saveDoc` writes it with its conflict, orphan and
 * re-encrypt handling intact. `rev` is optional and is checked against the
 * copy this tab holds, so a caller whose read went stale is told so
 * (`rev-conflict`) instead of overwriting.
 */
export async function replaceDocText(path, markdown, rev) {
  const doc = await ensureLoaded(path);
  if (rev != null && rev !== "" && rev !== doc.rev)
    throw new api.ApiError(409, {
      error: "rev-conflict",
      message: "This doc changed since that rev — read it again before writing.",
      rev: doc.rev,
    });
  const active = path === state.active;
  if (active) syncRaw();
  doc.markdown = String(markdown == null ? "" : markdown);
  /* open a run and close it in the same breath: one call, one entry, however
     many lines moved */
  noteTextEdit(path);
  flushTextRun();
  if (active) {
    if (state.mode === "raw") syncRawFromModel(doc);
    else renderDoc();
  }
  /* silent: the pane already shows the new text, and a toast about a write
     nobody in this tab asked for is the app talking to itself */
  const wrote = await saveDoc(path, { silent: true });
  if (!wrote)
    throw new api.ApiError(409, {
      error: "not-saved",
      message: "The change is in this tab but did not reach disk — " + path + " may have moved or conflicted.",
    });
  return { path, rev: doc.rev, bytes: doc.bytes };
}

/* Navigation token. openDoc awaits a save and a fetch, so two of them can be
   in flight at once — a click during the reload that follows a rename, an SSE
   `moved` echo landing after the user has already moved on. The LAST navigation
   asked for is the one that must win; an older one that finishes late has to
   drop out rather than repaint the pane and the statusbar over it. */
let navSeq = 0;

/* Where the user has asked to be, which is NOT state.active: openDoc only
   commits state.active once the fetch resolves, so for the whole width of that
   round trip state.active still names the doc being navigated AWAY from.
   Anything that reacts to a doc "being the one on screen" has to consult this
   instead, or it answers for a doc the user has already left. */
let navTarget = null;
let navPending = false;
/** the doc the user is looking at, or — mid-navigation — has asked to look at */
export function viewedPath() {
  return navPending ? navTarget : state.active;
}

/* A move re-homes the pane onto the doc's new path, from two places: the local
   action (commitRename) and the SSE `moved` echo. Both reach their openDoc only
   AFTER awaiting a tree reload, and a click can land inside that window — which
   would make a navigation the user asked for lose to one they asked for
   earlier, purely because the follow-up was slower. navSeq alone cannot see
   this: it orders by call time, and the follow-up is called last.

   So: latch the generation before the awaits, and only navigate if nothing else
   has claimed navigation since. This also de-duplicates the two paths — whoever
   re-homes first wins and the other stands down, instead of both fetching. */
export function navGate() {
  const at = navSeq;
  return () => navSeq === at;
}

export async function openDoc(path, opts) {
  if (!path) return;
  /* NAVIGATING AWAY FROM A DIRTY RAW BUFFER asks first — a tree click,
     a ⌘K pick, a [[link]], the home button. `replace` is what the programmatic
     re-homes carry (a popstate we are catching up with, the SSE `moved` echo, an
     accepted proposal, an openDoc that is repairing the address bar), and none
     of those is a person leaving: stopping THEM to ask would strand the pane and
     the URL on different docs. `force` is the dialog's own way back in. */
  if (path !== state.active && !(opts && (opts.replace || opts.force))) {
    if (!guardRawExit(() => openDoc(path, Object.assign({}, opts || {}, { force: true })))) return;
  }
  /* …and the settings page's own unsaved work, on the same terms. NOT gated on
     `path !== state.active`, the way the Raw guard above is: the settings page
     keeps `state.active` naming the doc it will return to, so clicking that
     very doc in the tree is a real exit from a page holding a real draft.
     `force`/`replace` mean the same thing here as there, and the two guards can
     never both fire — `rawExitDiff` returns null on the settings view. */
  if (!(opts && (opts.replace || opts.force))) {
    if (!guardSettingsExit(() => openDoc(path, Object.assign({}, opts || {}, { force: true })))) return;
  }
  const nav = ++navSeq;
  navTarget = path;
  navPending = true;
  /* only the newest navigation may retire the pending flag; an older one
     finishing late has already lost and must leave the newer one's claim up */
  const settle = () => {
    if (nav === navSeq) navPending = false;
  };
  syncRaw();
  if (state.dirty && state.active && state.active !== path) {
    /* the indicator is about to read "Saved" for the NEW doc — say so out loud
       if the old one did not actually reach disk */
    const wrote = await saveDoc(state.active, { silent: true });
    if (!wrote) toast("Unsaved changes in " + state.active + " could not be written — they are still in this tab");
  }
  if (nav !== navSeq) return;
  try {
    await ensureLoaded(path);
  } catch (err) {
    settle();
    apiFail(err, "Could not open " + path);
    /* the address bar may already be on the doc that did not open (a Back into
       something since deleted) — put it back on the doc still on screen */
    if (state.active) routeDoc(state.active, true);
    return;
  }
  if (nav !== navSeq) return;
  settle();
  /* plaintext lives exactly as long as the doc that holds it is on screen */
  for (const [k, e] of [...state.reveal]) if (e.path !== path) state.reveal.delete(k);
  state.active = path;
  /* …and this is where the browser will come back to when it is next handed a
     bare `/` (ADR 0035). Beside `state.active` rather than beside `routeDoc`
     because it is the same fact one shelf up: the doc that is on screen. */
  rememberLastDoc(path);
  /* Opening a doc IS a change of context, so the sidebar pick stops speaking
     for ⌥N: the open doc's folder is the context from here (`createParent`).
     Without this, opening a doc from the palette or a [[link]] would still
     create beside whatever folder was last clicked. */
  state.pick = null;
  /* A doc can arrive dirty: this tab may have been holding unsaved text for it
     already (a buffer left behind by an earlier visit, a proposal written into
     a doc that was not on screen). The baseline is the only honest answer. */
  const doc = activeDoc();
  state.dirty = doc.markdown !== doc.diskText;
  setSaveIndicator(state.dirty ? "Unsaved changes" : "Saved", state.dirty ? "dirty" : undefined);
  /* Opening a doc from the settings page IS how you leave it — the tree, ⌘K,
     a [[link]] and the home button are all navigations, and the pane shows one
     place at a time. Before routeDoc, so the entry it writes describes what is
     about to be on screen. */
  exitSettings();
  /* the URL is written HERE and nowhere else: after the doc is known to exist,
     before it is painted (see the ROUTING section) */
  routeDoc(path, opts && opts.replace);
  revealInTree(path);
  renderDoc();
  $("#scroll").scrollTop = 0;
  /* picking a doc out of a DRAWER is done with the drawer — but a sidebar
     that is a column stays exactly where it is */
  if (isDrawer()) closeNav();
  refreshSessionStats();
  if (opts && opts.line != null) revealLine(opts.line);
}

/* ============================================================
   EDIT ⇄ SOURCE
   ============================================================ */
/* The mode affordance is one muted word in the STATUSBAR (#stMode), not a
   segmented control in the topbar: which of two views of the same document you
   are looking at is state, and state is what the statusbar is for. Everything
   that needs to know the mode from outside reads `data-mode` here — it is the
   one attribute this function is contracted to keep true. The title carries
   what a click does AND the chord, because a single word cannot say both. */
export function syncModeUI() {
  const raw = state.mode === "raw";
  const chip = $("#stMode");
  if (chip) {
    chip.dataset.mode = state.mode;
    chip.title = raw ? "Markdown source — click (or ⌘E) for Edit" : "Visual editing — click (or ⌘E) for Source";
    const txt = $("#stModeTxt");
    if (txt) txt.textContent = raw ? "Source" : "Edit";
  }
  /* encrypt-selection only means anything over a selection in the source — and
     only when secrets work at all. A live button whose only possible outcome is
     an error toast is the dead affordance secrets degradation rules out. */
  const enc = $("#encBtn");
  if (enc) enc.hidden = state.mode !== "raw" || vault.state === "disabled";
  syncWrapUI();
}

function lineOffset(md, lineNo) {
  const lines = md.split("\n");
  let off = 0;
  for (let i = 0; i < lineNo && i < lines.length; i++) off += lines[i].length + 1;
  return Math.min(off, md.length);
}

/* focus without letting the browser scroll anything for us */
function focusRaw(opts) {
  const ta = $("#rawArea");
  if (!ta) return;
  const sc = $("#scroll");
  const keep = sc ? sc.scrollTop : 0;
  try {
    ta.focus({ preventScroll: true });
  } catch (e) {
    ta.focus();
  }
  const pos = Math.max(0, Math.min(opts.caret || 0, ta.value.length));
  ta.setSelectionRange(pos, pos);
  if (!sc) return;
  if (opts.line != null) scrollRawTo(pos, opts.anchor);
  else sc.scrollTop = keep;
}

/**
 * Put the source line holding `offset` back where the reader was already
 * looking — `anchor` pixels below the top of the pane.
 *
 * MEASURED, never `line * lineHeight`. Raw soft-wraps, so a source line is one
 * visual row only until it is longer than the pane; multiplying counts every
 * wrapped row as zero and lands short by the total of everything that wrapped
 * above it. That error grows with the document, which is why the jump was worst
 * in exactly the long notes where losing your place costs the most.
 */
function scrollRawTo(offset, anchor) {
  const ta = $("#rawArea");
  const sc = $("#scroll");
  if (!ta || !sc) return;
  const want =
    sc.scrollTop + (ta.boxAt(offset).top - sc.getBoundingClientRect().top) - (anchor != null ? anchor : 120);
  sc.scrollTop = Math.max(0, Math.min(want, sc.scrollHeight - sc.clientHeight));
}

/* ---------- keeping your place across a mode switch (ADR 0027) ----------

   Edit and Source are two renderings of one document at two different heights,
   so the scroll OFFSET means nothing across the switch — the further into a
   note you are, the further the same pixel lands from the same words. The
   coordinate the two modes do share is the SOURCE LINE. So a switch reads the
   line the reader is looking at and where on screen it sits, and puts it back
   there; on the Edit side both halves of that are measured inside the island,
   which is the only thing that knows which block is which line. */

/** The first line still on screen in Edit, and how far down it sits — the
    island's own measurement, translated into this file's 0-based lines. */
function visualAnchor() {
  const at = visual && visual.anchorLine();
  return at ? { line: Math.max(0, at.line - 1), anchor: at.anchor } : null;
}

/** The same question asked of Source, answered by the caret — the place the user
    was actually working. Null when it is off screen: anchoring to something
    nobody can see would BE the jump this exists to prevent, so that case keeps
    the offset it has rather than inventing a better one. */
function rawAnchor() {
  const ta = $("#rawArea");
  const sc = $("#scroll");
  if (!ta || !sc) return null;
  const box = ta.boxAt(ta.selectionStart);
  const r = sc.getBoundingClientRect();
  if (box.bottom < r.top || box.top > r.bottom) return null;
  return { line: ta.value.slice(0, ta.selectionStart).split("\n").length - 1, anchor: box.top - r.top };
}

export function setMode(m, opts) {
  opts = opts || {};
  if (m !== "raw" && m !== "preview") return;
  if (m === state.mode) {
    if (m === "raw" && opts.caret != null) focusRaw(opts);
    return;
  }
  /* THE ONE DOOR out of Source. ⌘E, the statusbar mode chip and Esc all leave
     through this call, so the unsaved-work guard is here rather than repeated at
     three call sites — `force` is what the dialog's own Save/Discard come back
     through. */
  if (m === "preview" && !opts.force && !guardRawExit(() => setMode("preview", Object.assign({}, opts, { force: true })))) return;
  syncRaw();
  const sc = $("#scroll");
  const keep = sc ? sc.scrollTop : 0;
  /* read the shared coordinate BEFORE the DOM is replaced under us */
  const carry = opts.line != null ? null : state.mode === "preview" ? visualAnchor() : rawAnchor();
  state.mode = m;
  syncModeUI();
  renderDoc({ noFade: true });
  if (sc) sc.scrollTop = Math.max(0, Math.min(keep, sc.scrollHeight - sc.clientHeight));
  if (m === "raw") {
    const doc = activeDoc();
    const at =
      opts.line != null || !carry || !doc
        ? opts
        : { caret: lineOffset(doc.markdown, carry.line), line: carry.line, anchor: carry.anchor };
    /* W_SHEET, not W_DOCK: this one really is about the SOFT KEYBOARD — an
       unasked-for focus that throws a keyboard over half the screen. A tablet
       has the room for it; a phone does not. The PLACE is not the keyboard's to
       decide, though: a phone that declines the focus still owes the reader the
       line they were on. */
    if (!isSheet() || opts.caret != null) focusRaw(at);
    else if (at.line != null) scrollRawTo(at.caret, at.anchor);
    /* …and, on a phone only, make sure Back has an entry to spend on leaving
       Source. `onPop` intercepts that press, and an interception needs a
       popstate to intercept — at the bottom of the stack there is none. See
       `markerForLayer`; it no-ops wherever an entry already exists. */
    if (isSheet()) markerForLayer();
  } else {
    /* the island is not mounted yet (it imports itself), so this is held and
       applied by `renderVisual` the moment it is */
    if (carry) revealVisual(carry.line, carry.anchor);
    /* …and leaving Source hands back a press nothing is owed any more, by
       whichever door it left through — ⌘E, the chip, Esc, or the Back this was
       reserved for. See `retireLayerMarker`. */
    retireLayerMarker();
  }
  if (!opts.silent) toast(m === "raw" ? "Markdown source" : "Visual editing");
}

/** Put a source line in front of the reader: a search hit, an `openDoc({line})`,
    an AI proposal's landing place. 0-based, the way every caller counts. */
function revealLine(lineNo) {
  if (state.mode === "raw") {
    focusRaw({ caret: lineOffset(activeDoc().markdown, lineNo), line: lineNo, anchor: 140 });
    return;
  }
  revealVisual(lineNo);
}

/* ============================================================
   TEXT HISTORY — the timeline's editing half (ADR 0014)

   Typing is not one entry per keystroke and not one entry per session: it is
   one entry per RUN. A run opens on the first edit to a doc, extends while the
   edits keep coming, and closes on the first of — a pause, a save, a mode
   switch, a doc switch, a file operation, or an undo. That is the granularity
   a person means by "what I just typed", and it is the granularity every
   editor's undo has.

   `textMark` is the text as of the last closed run, per doc: the `before` of
   whatever run opens next. It is re-seeded whenever the document arrives from
   somewhere that is not the keyboard (opened, saved, reloaded over SSE, or
   rewritten by an accepted proposal), because none of those is an edit to
   take back — and recording one as if it were would make ⌘Z fight the server.
   ============================================================ */
const TEXT_RUN_MS = 700;
const textMark = new Map();
let runPath = null;
let runBefore = null;
let runTimer = null;

/** Re-seed a doc's baseline: this text is where the next run starts from, and
    getting here was not an edit. */
export function markTextBaseline(path, text) {
  if (!path) return;
  /* CLOSE an open run rather than dropping it. A save that lands inside the
     idle window (type, then ⌘S half a second later) arrives here with the run
     still open, and discarding it would lose exactly the edit the user just
     took the trouble to save from their own undo history. */
  if (runPath === path) flushTextRun();
  textMark.set(path, String(text == null ? "" : text));
}

/** Close the open run, if any, and record it. Idempotent — every flush point
    calls it without knowing whether a run is open. */
export function flushTextRun() {
  clearTimeout(runTimer);
  const path = runPath;
  const before = runBefore;
  runPath = null;
  runBefore = null;
  if (path == null) return;
  const doc = state.docs.get(path);
  const after = doc && typeof doc.markdown === "string" ? doc.markdown : null;
  if (after == null || after === before) return;
  textMark.set(path, after);
  recordHistory({ kind: "text", path, before, after });
}

/**
 * Whether a step is there to take RIGHT NOW, which is what an Undo/Redo
 * control needs to know to decide whether it is live (ADR 0034). The chords
 * never had to ask: they flush the open run first, then look.
 *
 * `pendingHistory` alone is not the answer, because the run still open under
 * the caret is not on the timeline until a flush records it. It counts AS an
 * undo, or a doc being typed into reads as "nothing to undo" for the whole
 * idle window; it counts AGAINST redo, because that flush records a new entry
 * and a new entry drops the redo branch.
 */
export function canStepHistory(redo) {
  return redo ? runPath == null && !!pendingHistory(true) : runPath != null || !!pendingHistory(false);
}

/** Called from the Raw editor's input listener, and from anywhere else that
    moves a doc's text on the user's behalf. */
export function noteTextEdit(path) {
  if (!path) return;
  if (runPath && runPath !== path) flushTextRun();
  if (runPath == null) {
    runPath = path;
    const doc = state.docs.get(path);
    runBefore = textMark.has(path) ? textMark.get(path) : (doc && doc.diskText) || "";
  }
  clearTimeout(runTimer);
  runTimer = setTimeout(flushTextRun, TEXT_RUN_MS);
}

/** Where the caret belongs after a text step: the first character that
    differs. Not recorded with the entry — derived, so it is right even for an
    entry that was produced by a paste, a cut or the assistant. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Put a document back to one side of a text entry, GOING THERE FIRST if it is
 * not the doc on screen. The navigation is the point: an undo that silently
 * rewrote a file you were not looking at would be indistinguishable from
 * nothing happening.
 */
export async function applyTextHistory(entry, undoing) {
  flushTextRun();
  if (!state.docPaths.has(entry.path)) {
    toast(entry.path + " is not in the vault — undo its deletion first");
    return false;
  }
  /* Unsaved work in the doc being left behind is written, not thrown away and
     not turned into a modal: this chord is supposed to be seamless, and the
     buffer it is leaving is the user's. */
  if (state.active && state.active !== entry.path && state.dirty) await saveDoc(state.active, { silent: true });
  if (state.active !== entry.path) await openDoc(entry.path, { force: true });
  const doc = state.docs.get(entry.path);
  if (!doc) return false;
  const target = undoing ? entry.before : entry.after;
  const caret = firstDifference(String(doc.markdown || ""), target);
  doc.markdown = target;
  textMark.set(entry.path, target);
  if (state.mode === "raw") {
    const ta = $("#rawArea");
    if (ta) {
      ta.value = target;
      ta.zSourceValue = ta.value;
      try {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      } catch (_) {}
      keepRawCaretVisible();
    }
  } else {
    renderDoc();
  }
  updateMeta();
  /* An undo is an edit like any other: the buffer now differs from the file,
     so it is dirty and the ordinary save path takes it from here. */
  markDirty();
  return true;
}

/* ============================================================
   SAVE
   ============================================================ */
let dirtyT, flashT, markT;

/** How long "it just saved" stays on screen. ONE constant for both marks: the
    statusbar pip's green blink and the topbar tick are the same beat seen in
    two places, and two timings would show as one outlasting the other. */
const SAVE_FLASH_MS = 1700;

/* THE TOPBAR MARK — up only while it has news.

   `dirty` (amber dot) while the buffer diverges from the file; `saved` (green
   tick, one pop) when a write lands, held for the same beat as the pip's blink
   and then faded out; nothing at all otherwise. `leaving` runs the fade before
   the classes come off, so the mark exits rather than being cut.

   Its own timer, not `flashT`: the pip's flash and this one end at the same
   moment but do different things, and sharing a handle made whichever ran
   second cancel the first's cleanup. */
function topMark(kind) {
  const m = $("#tbSave");
  if (!m) return;
  clearTimeout(markT);
  m.classList.remove("dirty", "saved", "leaving");
  if (kind === "dirty") return void m.classList.add("dirty");
  if (kind !== "saved") return;
  m.classList.add("saved");
  markT = setTimeout(() => {
    m.classList.add("leaving");
    markT = setTimeout(() => m.classList.remove("saved", "leaving"), 340);
  }, SAVE_FLASH_MS);
}

/* The indicator is a statusbar PIP now — one 6px dot, no words on screen — so
   the state has to reach the pointer and the screen reader by other routes:
   `#saveTxt` still carries it as (clipped) text for assistive tech and for the
   tests, and the title carries it for a hover. Everything else about this
   function is unchanged: `dirty`/`flash` are still the two classes, and
   `#saveTxt`'s textContent is still the contract. */
function saveState(txt) {
  const t = $("#saveTxt");
  /* Write only on a real transition. `markDirty` runs on EVERY keystroke, and
     an aria-live region re-announces text that is merely re-assigned — the
     unguarded version read "Unsaved changes" aloud once per character. */
  if (t.textContent === txt) return;
  t.textContent = txt;
  $("#saveInd").title = txt + " — click (or ⌘S) to save now";
}

export function setSaveIndicator(txt, cls) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  if (cls) ind.classList.add(cls);
  saveState(txt);
  /* Every route into this function that is NOT "the buffer went dirty" is a
     document arriving clean — opened, discarded back to its baseline, or
     written by a silent save. None of them is news, so the topbar says
     nothing. */
  topMark(cls === "dirty" ? "dirty" : "none");
}

export function markDirty() {
  state.dirty = true;
  setSaveIndicator("Unsaved changes", "dirty");
  clearTimeout(dirtyT);
  const secs = settingAt("editor.autosaveSeconds");
  /* the path is latched HERE, not read when the timer fires: a doc renamed from
     another device inside the debounce window would otherwise autosave whatever
     happened to be active by then */
  const path = state.active;
  dirtyT = setTimeout(() => saveDoc(path, { auto: true }), Math.max(600, secs * 1000));
}

function flashSave(txt) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  saveState(txt);
  void ind.offsetWidth;
  ind.classList.add("flash");
  topMark("saved");
  clearTimeout(flashT);
  flashT = setTimeout(() => {
    ind.classList.remove("flash");
    if (!state.dirty) saveState("Saved");
  }, SAVE_FLASH_MS);
}

/* One save at a time per DOC, keyed by the doc object rather than by its path.

   A rename from another device moves the buffer to a new path while a save is
   in flight (`onDocChanged` retargets the same object, shell.js), and a queue
   keyed by the old string would let the follow-up write to a path that no
   longer exists — or, worse, race a second queue under the new one.

   `flushSecretEdits` re-encrypts a dirty reveal and only clears its `dirty`
   flag AFTER the worker round-trip, so two overlapping saves both saw the same
   dirty entry, both re-encrypted it, and the loser's `replaceArmorInDoc` missed
   because the winner had already swapped the armor. That surfaced as a false
   "reload before saving" alarm — advice that, in a dirty buffer, destroys work.
   ⌘S is bound on the document, on the toolbar and on a 10s timer, so overlap is
   ordinary. At most one follow-up is queued: later keystrokes still get written,
   without a stampede of PUTs. */
const saveInflight = new Map(); // doc object → { p, queued }

export function saveDoc(path, opts) {
  path = path || state.active;
  const doc = path ? state.docs.get(path) : null;
  if (!doc) return Promise.resolve(false);
  const cur = saveInflight.get(doc);
  if (cur) {
    if (cur.queued) return cur.queued;
    cur.queued = cur.p.then(() => {
      if (saveInflight.get(doc) === cur) saveInflight.delete(doc);
      /* `doc.path`, not `path`: the follow-up writes wherever the doc is by then */
      return saveDoc(doc.path, opts);
    });
    return cur.queued;
  }
  const rec = { queued: null };
  rec.p = doSaveDoc(doc, opts).finally(() => {
    if (saveInflight.get(doc) === rec && !rec.queued) saveInflight.delete(doc);
  });
  saveInflight.set(doc, rec);
  return rec.p;
}

/** @returns {Promise<boolean>} whether the document actually reached the server */
async function doSaveDoc(doc, opts) {
  opts = opts || {};
  const path = doc.path;
  if (path === state.active) syncRaw();
  /* `visualStale`: these bytes are older than the screen, so there is nothing
     here that may be written. The notice went up when it happened. */
  if (visualStale === doc) {
    if (!opts.quiet) toast("Not saved — this doc has an edit that cannot be written as Markdown");
    return false;
  }
  /* THE leak gate (research §6 "Autosave"): the payload is built
     from doc.markdown, which holds armor only. A block that was revealed but
     not edited contributes its original bytes; a block that WAS edited is
     turned back into ciphertext here, before a single byte is serialized.
     There is no path from this function to a plaintext request body. */
  try {
    await flushSecretEdits(doc);
  } catch (err) {
    return false;
  }
  /* An external move can complete while the worker re-encrypts a dirty secret —
     start again at the path this doc now has rather than PUTting to the old one. */
  if (doc.path !== path) return doSaveDoc(doc, opts);
  clearTimeout(dirtyT);
  /* THE ORPHAN GATE. This buffer's file left the vault while it was dirty (see
     the `removed` branch in `connect`), so there is nothing to PUT to — and a
     save that quietly does nothing is exactly the failure the retention was
     added to stop. Ask, with both real answers on the table, and never guess:
     recreating a doc somebody deliberately deleted on another device would be
     the same kind of silent decision in the other direction. */
  if (doc.orphaned) {
    /* an unloading or backgrounded page has nowhere to put a question; the
       buffer and the sticky notice both stay, which is the honest outcome.
       `focus` is false for an AUTOSAVE — see orphanDialog: the veil must not
       take the caret out from under someone who is still typing. */
    if (!opts.quiet) orphanDialog(path, { focus: !opts.auto });
    return false;
  }
  state.saving.add(path);
  /* the exact bytes this PUT carries, latched BEFORE the await: a keystroke
     that lands mid-flight moves `doc.markdown` on, and recording that as the
     baseline would call the buffer clean over text the server never saw */
  const sent = doc.markdown;
  try {
    const r = await api.putDoc(path, sent, doc.rev, opts.keepalive ? { keepalive: true } : null);
    doc.rev = r.rev;
    doc.mtime = r.mtime;
    doc.bytes = r.bytes;
    setBaseline(doc, sent);
    if (path === state.active) {
      /* WHAT THE SERVER TOOK IS NOT NECESSARILY WHAT IS IN FRONT OF THE USER: a
         keystroke that landed mid-flight, or a reveal still holding an unsaved
         edit, leaves the buffer dirty over text that did reach disk. Saying
         "Saved" there would be the lie the exit guard then acts on. */
      state.dirty = doc.markdown !== sent || [...state.reveal.values()].some((e) => e.path === path && e.dirty);
      if (state.dirty) markDirty();
      else if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
      /* A SILENT save still may not leave the indicator lying. `silent` has
         always meant "no flash, no toast"; it never meant "go on reading Unsaved
         changes over text that is now on disk". */
      else setSaveIndicator("Saved");
    } else if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
    if (!opts.auto && !opts.silent) toast(state.sync && state.sync.remote ? "Saved to disk · " + state.sync.remote : "Saved to disk");
    refreshSessionStats();
    return true;
  } catch (err) {
    /* …and the same move can land while the PUT is in flight: the write failed
       against a path this doc has left, so it is reissued rather than reported. */
    if (doc.path !== path) return doSaveDoc(doc, opts);
    /* A PUT to a doc that is not there. The `doc-changed` that would have told
       us can be lost (the stream was down, the tab was frozen) or simply not
       have arrived yet, so the 404 is the SECOND way into the orphan state and
       has to reach the same dialog — otherwise the gap between "deleted" and
       "we heard about it" is a window where the save fails with a toast and the
       text has no route back to disk. */
    if (err && err.status === 404) {
      doc.orphaned = true;
      if (!opts.quiet) orphanDialog(path, { focus: !opts.auto });
      return false;
    }
    /* the unload flush cannot show anything to anybody — never log from it */
    if (opts.quiet) return false;
    if (err && err.code === "rev-conflict") {
      const mine = doc.markdown;
      const disk = err.body && typeof err.body.markdown === "string" ? err.body.markdown : null;
      /* buffer dirty ⇒ the banner, never a silent overwrite. `state.dirty`
         tracks the ACTIVE doc only, so a background buffer whose text differs
         from disk counts as dirty too — that is exactly the case phase 5
         introduced, where a rename rewrote a [[link]] in a doc the user was
         typing in but had not saved. */
      const dirty = (path === state.active && state.dirty) || (disk != null && disk !== mine);
      if (dirty) {
        if (disk != null) conflictDialog(path, disk, mine);
        else toast("This doc changed on disk — your unsaved text was kept");
        return false;
      }
      toast("This doc changed on disk — reloading");
      const fresh = await api.getDoc(path).catch(() => null);
      if (fresh) {
        // setBaseline like every other adopt: skipping it left diskText naming
        // the pre-conflict bytes, and the Raw-exit guard then offered to
        // "discard" text that was already on disk
        state.docs.set(path, setBaseline(Object.assign({}, doc, fresh, { loaded: true }), fresh.markdown));
        if (path === state.active) renderDoc();
      }
    } else apiFail(err, "Save failed");
    return false;
  } finally {
    state.saving.delete(path);
  }
}
