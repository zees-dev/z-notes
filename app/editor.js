/* ============================================================
   editor.js — raw/preview modes, save pipeline, exit guard (SPEC §4).

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, I, activeDoc, apiFail, countWords, el, esc, toast } from "./ui.js";
import { renderPreview } from "./markdown.js";
import { commitRename, focusQuiet } from "./tree.js";
import { changedLineDiff, conflictDialog, orphanDialog, renderDiff } from "./dialogs.js";
import { flushSecretEdits, vault } from "./secrets.js";
import { refreshSessionStats } from "./chat.js";
import { exitSettings, guardSettingsExit, settingAt } from "./settings.js";
import { closeNav, isDrawer, isSheet, markerForLayer, overlayOpen, retireLayerMarker, revealInTree, routeDoc } from "./shell.js";

/* ============================================================
   EXIT GUARD (SPEC §4) — leaving Raw with text that is not on disk

   The third dialog on the SAME veil chrome as the two above, and for the same
   reason they share one: every one of them asks the single question this app
   has about unsaved work — "what is in front of you is not what is on disk,
   say what happens to it" — and uses the SAME `renderDiff` rows to say what
   "not what is on disk" means. The Raw-exit rows deliberately omit the context
   used by save conflicts; the renderer and modal shell remain shared.

   What it guards is every way OUT of Raw:

     ⌘E / the statusbar mode chip / a click on the pane whitespace / Esc
        → `setMode("preview")`, gated in setMode itself so all four arrive
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
   run, `diskText` and the textarea agree and there is genuinely nothing left to
   confirm, so leaving is silent. That makes this dialog INTERMITTENT by nature:
   it appears when you leave quickly after typing and not otherwise. That is the
   honest behaviour and the debounce is a SPEC §4 decision, not this guard's to
   change.
   ============================================================ */

/**
 * The rows to show, or null when there is nothing to ask about.
 *
 * Null on all four of: not in Raw, no doc, no baseline (nothing ever fetched
 * this doc, so the guard cannot say what changed and must not invent it), and
 * a diff with no `+`/`-` rows — which is the "typed a character and deleted it
 * again" case, where `state.dirty` is still true but the buffer and the file
 * are byte-identical. An empty modal in front of an exit is worse than none.
 *
 * `state.dirty` is deliberately NOT the test. It is a flag about keystrokes;
 * this is a byte comparison against what the server last confirmed, which is
 * the thing the dialog then draws. The two agree in the ordinary case and the
 * comparison is right in every case they do not.
 */
export function rawExitDiff() {
  if (state.mode !== "raw" || state.view === "settings") return null;
  const doc = activeDoc();
  if (!doc || doc.diskText == null) return null;
  const ta = $("#rawArea");
  const buf = ta ? ta.value : String(doc.markdown || "");
  if (buf === doc.diskText) return null;
  /* This confirmation is deliberately terser than the save-conflict view:
     the request is to show ONLY what changed from the original document, not
     one unchanged context row on either side. */
  const rows = changedLineDiff(doc.diskText, buf);
  return rows.length ? rows : null;
}

/**
 * THE GATE. `true` ⇒ the caller may leave now; `false` ⇒ the dialog took over
 * and will run `proceed` itself if the user says so.
 *
 * Every caller passes a `proceed` that re-issues its own action with the
 * force/replace flag set, so the answer travels back out through the same code
 * path it came in on rather than through a re-implementation of it.
 */
export function guardRawExit(proceed) {
  const rows = rawExitDiff();
  if (!rows) return true;
  /* already asking — a second trigger (Esc under the open dialog, a stray
     click) must not stack a second copy or replace the pending destination */
  if (state.exitGuard) return false;
  const doc = activeDoc();
  state.exitGuard = { path: doc.path, proceed: proceed };
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
  /* back to exactly where you were: still Raw, still dirty, caret in the text.
     The dialog cost a focus and nothing else. */
  const ta = $("#rawArea");
  if (ta && state.mode === "raw") focusQuiet(ta);
}

/** Hand the pending destination back its go-ahead, once. */
function exitGuardProceed(g) {
  if (g && g.proceed) g.proceed();
}

/**
 * DISCARD — put the saved document back in the buffer, then leave.
 *
 * The revert is written into BOTH the model and the textarea before `proceed`
 * runs, because two of the destinations (`openDoc`, `setMode`) open with a
 * `syncRaw()` that copies the textarea over the model — reverting only the
 * model would have the buffer immediately overwrite it.
 */
export function exitGuardDiscard() {
  const g = state.exitGuard;
  closeExitGuard();
  if (!g) return;
  const doc = state.docs.get(g.path);
  if (doc && doc.diskText != null) {
    doc.markdown = doc.diskText;
    const ta = $("#rawArea");
    if (ta && state.mode === "raw" && state.active === g.path) {
      ta.value = doc.markdown;
      autoGrow(ta);
    }
    if (g.path === state.active) {
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
  closeExitGuard();
  if (!g) return;
  const ok = await saveDoc(g.path);
  if (!ok) return toast("Could not save " + g.path + " — your changes are still in this tab");
  exitGuardProceed(g);
}

/* ============================================================
   RAW MODE
   ============================================================ */
export function autoGrow(ta) {
  /* Measuring an auto-growing textarea means briefly collapsing it. In a long
     Raw doc that collapse clamps the OUTER scroll container; restoring the
     textarea's height does not restore the line the user was looking at. Keep
     the container's position across the measurement so one character cannot
     move the doc out from under its own caret. */
  const sc = ta.id === "rawArea" ? $("#scroll") : null;
  const keep = sc ? sc.scrollTop : 0;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  if (sc) sc.scrollTop = keep;
}

/** The caret has no DOM box of its own. Mirror the bytes before it with the
 * textarea's real typography so wrapped lines count exactly as they do in Raw. */
function rawCaretBox(ta) {
  const cs = getComputedStyle(ta);
  const tr = ta.getBoundingClientRect();
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  Object.assign(mirror.style, {
    position: "fixed",
    left: tr.left + "px",
    top: tr.top + "px",
    width: tr.width + "px",
    boxSizing: "border-box",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "visible",
    whiteSpace: ta.wrap === "off" ? "pre" : "pre-wrap",
    overflowWrap: ta.wrap === "off" ? "normal" : "break-word",
    wordBreak: cs.wordBreak,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    fontVariant: cs.fontVariant,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    wordSpacing: cs.wordSpacing,
    textIndent: cs.textIndent,
    textAlign: cs.textAlign,
    textTransform: cs.textTransform,
    direction: cs.direction,
    padding: cs.padding,
    borderWidth: cs.borderWidth,
    borderStyle: cs.borderStyle,
    tabSize: cs.tabSize,
  });
  marker.textContent = "\u200b";
  mirror.append(document.createTextNode(ta.value.slice(0, ta.selectionEnd)), marker);
  document.body.appendChild(mirror);
  const mr = marker.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  mirror.remove();
  return { top: mr.top, bottom: mr.top + lineHeight };
}

function revealRawCaret() {
  const ta = $("#rawArea");
  const sc = $("#scroll");
  if (!ta || !sc || document.activeElement !== ta) return;
  const cssKeyboard = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb")) || 0;
  const vv = window.visualViewport;
  const vvTop = vv ? vv.offsetTop : 0;
  const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const visibleTop = Math.max(sc.getBoundingClientRect().top, vvTop) + 12;
  const visibleBottom = Math.min(sc.getBoundingClientRect().bottom, vvBottom, window.innerHeight - cssKeyboard) - 12;
  if (visibleBottom <= visibleTop) return;
  const caret = rawCaretBox(ta);
  if (caret.bottom > visibleBottom) sc.scrollTop += caret.bottom - visibleBottom;
  else if (caret.top < visibleTop) sc.scrollTop -= visibleTop - caret.top;
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

function emitRawInput(ta, inputType, data) {
  ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: data == null ? null : data }));
}

function applyWordWrap(ta) {
  if (!ta) return;
  ta.wrap = state.wordWrap ? "soft" : "off";
  ta.classList.toggle("no-wrap", !state.wordWrap);
  autoGrow(ta);
}

export function syncWrapUI() {
  const chip = $("#stWrap");
  if (!chip) return;
  const raw = state.view === "doc" && state.mode === "raw";
  chip.hidden = !raw;
  chip.dataset.wrap = state.wordWrap ? "on" : "off";
  chip.title = (state.wordWrap ? "Disable" : "Enable") + " Raw word wrapping (⌥Z)";
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

/**
 * The prefix a markdown editor carries onto the next line.
 *
 * Whitespace is copied byte-for-byte. Bullets keep their marker, tasks restart
 * unchecked, and ordered items advance while retaining `.` versus `)`. A plain
 * indented line keeps only its indentation. Returning null means the browser
 * should perform its ordinary newline.
 */
function markdownContinuation(value, caret) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const before = value.slice(lineStart, caret);
  const list = /^(?<indent>[ \t]*)(?:(?<bullet>[-*+])|(?<number>\d+)(?<delim>[.)]))(?<gap>[ \t]+)(?:\[(?<check>[ xX])\](?<checkGap>[ \t]+))?/.exec(before);
  if (list) {
    const g = list.groups || {};
    const marker = g.bullet || String(Number(g.number) + 1) + g.delim;
    return {
      lineStart,
      prefix: g.indent + marker + g.gap + (g.check == null ? "" : "[ ]" + g.checkGap),
      emptyItem: !before.slice(list[0].length).trim(),
    };
  }
  const indent = /^[ \t]+/.exec(before);
  return indent ? { lineStart, prefix: indent[0], emptyItem: false } : null;
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
       removing its prefix instead of producing an endless run of markers. */
    ta.setRangeText("", next.lineStart, a, "end");
  } else {
    ta.setRangeText("\n" + next.prefix, a, b, "end");
  }
  emitRawInput(ta, "insertLineBreak", null);
}

const RAW_LIST = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

function leadingOutdent(line, size) {
  if (line[0] === "\t") return line.slice(1);
  const m = /^ +/.exec(line);
  return m ? line.slice(Math.min(size, m[0].length)) : line;
}

/** Tab is source editing in Raw, never focus navigation. On a list line it
 * moves the whole item one hierarchy level; elsewhere it inserts configured
 * spaces. Shift-Tab removes one level from every touched line. */
function editRawTab(e, ta) {
  if (e.key !== "Tab" || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault();
  e.stopPropagation();
  if (overlayOpen()) return true;
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

  if (!e.shiftKey && !multi && !RAW_LIST.test(currentLine) && a === b) {
    ta.setRangeText(spaces, a, b, "end");
    emitRawInput(ta, "insertText", spaces);
    return true;
  }

  const lines = block.split("\n");
  const changed = lines.map((line) => (e.shiftKey ? leadingOutdent(line, spaces.length) : spaces + line));
  const replacement = changed.join("\n");
  if (replacement === block) return true;
  const firstDelta = changed[0].length - lines[0].length;
  const totalDelta = replacement.length - block.length;
  ta.setRangeText(replacement, lineStart, lineEnd, "end");
  if (a === b) {
    const caret = Math.max(lineStart, a + firstDelta);
    ta.setSelectionRange(caret, caret);
  } else {
    ta.setSelectionRange(Math.max(lineStart, a + firstDelta), Math.max(lineStart, b + totalDelta));
  }
  emitRawInput(ta, e.shiftKey ? "deleteContentBackward" : "insertText", e.shiftKey ? null : spaces);
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

function rawKeydown(e, ta) {
  if (editRawTab(e, ta)) return;
  continueMarkdownLine(e, ta);
}

function renderRaw(doc, host) {
  const ta = el("textarea", "raw");
  ta.id = "rawArea";
  /* The SAME six attributes the reveal editor carries (research §6,
     "DOM-adjacent services"). ⌘⇧E only works in Raw, so this textarea is where
     every secret in the vault is typed BEFORE it becomes ciphertext — it is the
     one field in the app that holds pre-encryption plaintext. */
  ta.spellcheck = false;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("data-gramm", "false");
  ta.setAttribute("data-enable-grammarly", "false");
  ta.value = doc.markdown;
  ta.setAttribute("aria-label", "Markdown source · " + doc.path);
  /* the placeholder is a STARTING POINT, not a notice: an empty note announcing
     its own emptiness says nothing the blank page did not already say */
  ta.placeholder = "# " + doc.title;
  ta.style.tabSize = String(settingAt("editor.tabSize"));
  ta.addEventListener("input", () => {
    doc.markdown = ta.value;
    autoGrow(ta);
    markDirty();
    updateMeta();
    keepRawCaretVisible();
  });
  ta.addEventListener("keydown", (e) => rawKeydown(e, ta));
  ta.addEventListener("focus", keepRawCaretVisible);
  ta.addEventListener("select", keepRawCaretVisible);
  ta.addEventListener("click", () => {
    moveListGutterCaret(ta);
    keepRawCaretVisible();
  });
  host.appendChild(ta);
  applyWordWrap(ta);
}

/* pull pending textarea edits into the cache before anything re-renders */
export function syncRaw() {
  if (state.mode !== "raw") return;
  const ta = $("#rawArea");
  const doc = activeDoc();
  if (ta && doc) doc.markdown = ta.value;
}

/**
 * Push the model back into the Raw textarea after something OTHER than typing
 * moved it. `syncRaw` is one-way (textarea → model) and doSaveDoc runs it
 * BEFORE `flushSecretEdits`, so a re-encrypt that lands while the pane is in
 * Raw left the textarea holding the pre-flush armor — and the next syncRaw
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
  const n = ta.value.length;
  try {
    ta.setSelectionRange(Math.min(a, n), Math.min(b, n));
  } catch (_) {}
  autoGrow(ta);
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

export function renderDoc(opts) {
  opts = opts || {};
  const doc = activeDoc();
  const host = $("#doc");
  host.innerHTML = "";
  if (!doc) return;
  host.classList.toggle("raw-mode", state.mode === "raw");

  /* The `.mode-note` that used to end this line ("raw source · click outside to
     preview" / "preview · click a line to edit") is gone. It restated an
     affordance the statusbar's mode chip already names and the pane itself
     already teaches on the first click, on every doc, forever — and it was the
     one item in the meta line that was about the CHROME rather than the doc. */
  const meta = el("div", "doc-meta");
  meta.innerHTML =
    '<span class="tag">' + esc(doc.path) + "</span>" +
    "<span>" + esc(relTime(doc.mtime)) + "</span>";
  host.appendChild(meta);

  if (state.mode === "raw") renderRaw(doc, host);
  else if (!String(doc.markdown).trim()) {
    /* A NEW NOTE SAYS ITS NAME AND NOTHING ELSE.
       The instruction that used to sit here ("This note is empty. Switch to
       Raw (⌘E) to write markdown.") described the blank page it was printed
       on, and named a chord half the app's widths do not have. What stays is
       the click TARGET — `previewClickToEdit` opens Raw from `.empty-doc`, so
       the affordance survives the words being deleted. */
    const e = el("div", "empty-doc");
    e.innerHTML = '<div class="ring">' + I.note + "</div><h3>" + esc(doc.title) + "</h3>";
    host.appendChild(e);
  } else renderPreview(doc, host);

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
 * `doc.markdown` cannot answer "what is on disk?" — the Raw textarea writes
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
  if (doc) doc.diskText = String(text == null ? doc.markdown || "" : text);
  return doc;
}

async function ensureLoaded(path) {
  const cached = state.docs.get(path);
  if (cached && cached.loaded) return cached;
  const d = await api.getDoc(path);
  const merged = Object.assign({}, cached || {}, d, { loaded: true });
  setBaseline(merged, d.markdown);
  state.docs.set(path, merged);
  return merged;
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
  /* NAVIGATING AWAY FROM A DIRTY RAW BUFFER asks first (SPEC §4) — a tree click,
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
  /* Opening a doc IS a change of context, so the sidebar pick stops speaking
     for ⌘N: the open doc's folder is the context from here (`createParent`).
     Without this, opening a doc from the palette or a [[link]] would still
     create beside whatever folder was last clicked. */
  state.pick = null;
  state.dirty = false;
  setSaveIndicator("Saved");
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
   PREVIEW ⇄ RAW
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
    chip.title = raw ? "Raw markdown source — click (or ⌘E) for Preview" : "Rendered preview — click (or ⌘E) for Raw";
    const txt = $("#stModeTxt");
    if (txt) txt.textContent = raw ? "Raw" : "Preview";
  }
  /* encrypt-selection only means anything over a selection in the source — and
     only when secrets work at all. A live button whose only possible outcome is
     an error toast is the dead affordance SPEC §6's degradation rules out. */
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
  if (opts.line != null) {
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const y = ta.offsetTop + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth) + opts.line * lh;
    const want = y - (opts.anchor != null ? opts.anchor : 120);
    sc.scrollTop = Math.max(0, Math.min(want, sc.scrollHeight - sc.clientHeight));
  } else {
    sc.scrollTop = keep;
  }
}

export function setMode(m, opts) {
  opts = opts || {};
  if (m !== "raw" && m !== "preview") return;
  if (m === state.mode) {
    if (m === "raw" && opts.caret != null) focusRaw(opts);
    return;
  }
  /* THE ONE DOOR out of Raw (SPEC §4). ⌘E, the statusbar mode chip, a click on
     the pane whitespace and Esc all leave through this call, so the unsaved-work
     guard is here rather than repeated at four call sites — `force` is what the
     dialog's own Save/Discard come back through. */
  if (m === "preview" && !opts.force && !guardRawExit(() => setMode("preview", Object.assign({}, opts, { force: true })))) return;
  syncRaw();
  const sc = $("#scroll");
  const keep = sc ? sc.scrollTop : 0;
  state.mode = m;
  syncModeUI();
  renderDoc({ noFade: true });
  if (sc) sc.scrollTop = Math.max(0, Math.min(keep, sc.scrollHeight - sc.clientHeight));
  if (m === "raw") {
    /* W_SHEET, not W_DOCK: this one really is about the SOFT KEYBOARD — an
       unasked-for focus that throws a keyboard over half the screen. A tablet
       has the room for it; a phone does not. */
    if (!isSheet() || opts.caret != null) focusRaw(opts);
    /* …and, on a phone only, make sure Back has an entry to spend on leaving
       Raw. `onPop` intercepts that press, and an interception needs a popstate
       to intercept — at the bottom of the stack there is none. See
       `markerForLayer`; it no-ops wherever an entry already exists. */
    if (isSheet()) markerForLayer();
  } else {
    /* …and leaving Raw hands back a press nothing is owed any more, by whichever
       door it left through — ⌘E, the chip, a click on the whitespace, Esc, or
       the Back this was reserved for. See `retireLayerMarker`. */
    retireLayerMarker();
  }
  if (!opts.silent) toast(m === "raw" ? "Raw markdown" : "Rendered preview");
}

/* ---------- click a rendered line → edit that line in Raw ---------- */
let downPt = null;
let downInRaw = false;

/** The pointerdown half of the two click zones — owned here so the state it
    writes stays module-local; wiring only registers it. */
export function trackScrollPointerDown(e) {
  downPt = { x: e.clientX, y: e.clientY };
  downInRaw = !!(e.target && e.target.closest && e.target.closest(".raw"));
}

export function previewClickToEdit(e) {
  if (state.mode !== "preview") return;
  if (settingAt("editor.clickToEdit") === false) return;
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest("button, a, input, textarea, select, .secret-bar, .cb, .wl")) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && String(sel).trim()) return;
  if (downPt && (Math.abs(e.clientX - downPt.x) > 4 || Math.abs(e.clientY - downPt.y) > 4)) return;

  const block = t.closest("[data-line]");
  const doc = activeDoc();
  if (!block) {
    if (doc && !String(doc.markdown).trim() && t.closest(".empty-doc")) {
      e.zModeSwitch = true;
      setMode("raw", { caret: 0, silent: true });
    }
    return;
  }
  const lineNo = parseInt(block.dataset.line, 10);
  if (isNaN(lineNo)) return;
  /* claim the event: it still bubbles to #scroll, where click-outside lives */
  e.zModeSwitch = true;
  const sc = $("#scroll");
  const anchor = block.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  setMode("raw", { caret: lineOffset(doc.markdown, lineNo), line: lineNo, anchor, silent: true });
}

export function paneClickToPreview(e) {
  if (state.mode !== "raw") return;
  if (e.zModeSwitch) return;
  if (overlayOpen()) return;
  const t = e.target;
  if (!t || !t.closest || !t.isConnected) return;
  if (t.closest(".raw")) return;
  if (t.closest("button, a, input, textarea, select, label, kbd, .secret-bar")) return;
  if (t.closest(".topbar, .statusbar, .sidebar, .chat, .modal, .veil, .pop")) return;
  if (downInRaw) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && String(sel).trim()) return;
  if (downPt && (Math.abs(e.clientX - downPt.x) > 4 || Math.abs(e.clientY - downPt.y) > 4)) return;
  setMode("preview", { silent: true });
}

function revealLine(lineNo) {
  if (state.mode === "raw") {
    focusRaw({ caret: lineOffset(activeDoc().markdown, lineNo), line: lineNo, anchor: 140 });
    return;
  }
  const blocks = $$("#doc [data-line]");
  let best = null;
  blocks.forEach((b) => {
    const l = parseInt(b.dataset.line, 10);
    if (l <= lineNo && (!best || l >= parseInt(best.dataset.line, 10))) best = b;
  });
  if (!best) return;
  const sc = $("#scroll");
  sc.scrollTop = Math.max(0, best.offsetTop - 110);
  best.classList.remove("flash-line");
  void best.offsetWidth;
  best.classList.add("flash-line");
  setTimeout(() => best.classList.remove("flash-line"), 1300);
}

/* ============================================================
   SAVE
   ============================================================ */
let dirtyT, flashT;

export function setSaveIndicator(txt, cls) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  if (cls) ind.classList.add(cls);
  $("#saveTxt").textContent = txt;
}

export function markDirty() {
  state.dirty = true;
  setSaveIndicator("Unsaved changes", "dirty");
  clearTimeout(dirtyT);
  const secs = settingAt("editor.autosaveSeconds");
  dirtyT = setTimeout(() => saveDoc(state.active, { auto: true }), Math.max(600, secs * 1000));
}

function flashSave(txt) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  $("#saveTxt").textContent = txt;
  void ind.offsetWidth;
  ind.classList.add("flash");
  clearTimeout(flashT);
  flashT = setTimeout(() => {
    ind.classList.remove("flash");
    if (!state.dirty) $("#saveTxt").textContent = "Saved";
  }, 1700);
}

/* One save at a time per path.

   `flushSecretEdits` re-encrypts a dirty reveal and only clears its `dirty`
   flag AFTER the worker round-trip, so two overlapping saves both saw the same
   dirty entry, both re-encrypted it, and the loser's `replaceArmorInDoc` missed
   because the winner had already swapped the armor. That surfaced as a false
   "reload before saving" alarm — advice that, in a dirty buffer, destroys work.
   ⌘S is bound on the document, on the toolbar and on a 10s timer, so overlap is
   ordinary. At most one follow-up is queued: later keystrokes still get written,
   without a stampede of PUTs. */
const saveInflight = new Map(); // path → { p, queued }

export function saveDoc(path, opts) {
  path = path || state.active;
  if (!path) return Promise.resolve(false);
  const cur = saveInflight.get(path);
  if (cur) {
    if (cur.queued) return cur.queued;
    cur.queued = cur.p.then(() => {
      if (saveInflight.get(path) === cur) saveInflight.delete(path);
      return saveDoc(path, opts);
    });
    return cur.queued;
  }
  const rec = { queued: null };
  rec.p = doSaveDoc(path, opts).finally(() => {
    if (saveInflight.get(path) === rec && !rec.queued) saveInflight.delete(path);
  });
  saveInflight.set(path, rec);
  return rec.p;
}

/** @returns {Promise<boolean>} whether the document actually reached the server */
async function doSaveDoc(path, opts) {
  opts = opts || {};
  const doc = state.docs.get(path);
  if (!doc) return false;
  if (path === state.active) syncRaw();
  /* THE leak gate (SPEC §11, research §6 "Autosave"): the payload is built
     from doc.markdown, which holds armor only. A block that was revealed but
     not edited contributes its original bytes; a block that WAS edited is
     turned back into ciphertext here, before a single byte is serialized.
     There is no path from this function to a plaintext request body. */
  try {
    await flushSecretEdits(doc);
  } catch (err) {
    return false;
  }
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
    if (path === state.active) state.dirty = false;
    if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
    /* A SILENT save still may not leave the indicator lying. `silent` has
       always meant "no flash, no toast"; it never meant "go on reading Unsaved
       changes over text that is now on disk". Harmless while the only silent
       saves were on a page that was leaving — and wrong the moment the
       lifecycle flush started running on a page that comes BACK. */
    else if (path === state.active) setSaveIndicator("Saved");
    if (!opts.auto && !opts.silent) toast(state.sync && state.sync.remote ? "Saved to disk · " + state.sync.remote : "Saved to disk");
    refreshSessionStats();
    return true;
  } catch (err) {
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
