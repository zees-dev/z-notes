/* ============================================================
   dialogs.js — the app's modal machinery, shared by every feature module.

   Extracted from tree.js, which had been carrying it since the single-file
   split: the sidebar owned the confirm dialog, the save-conflict banner, the
   orphan dialog and the diff renderer, so terminal.js and chat.js had to
   import "tree" to show a modal. The one thing these dialogs need from the
   tree — refreshing it after a conflict resolution — arrives through
   wireDialogs(), set once by app.js at boot, so this module has no import
   back into tree.js.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, apiFail, clearStickyToast, el, esc, toast } from "./ui.js";
/* Injected by app.js at boot — dialogs import no feature module, so this
   file is a leaf like ui.js: terminal, chat, tree, editor and shell can all
   open a modal without pulling each other in. */
let refreshTree = async () => {};
let renderDoc, saveDoc, setBaseline, setSaveIndicator, app, openFirstDoc;
export function wireDialogs(fns) {
  ({ refreshTree, renderDoc, saveDoc, setBaseline, setSaveIndicator, app, openFirstDoc } = fns);
}

export function confirmDialog(opts) {
  /* `onCancel` is optional and fires on EVERY way out that is not OK — the
      Cancel button, Esc, a click on the veil, Back. A caller that must land
      somewhere either way (goHome: the button is never inert) needs the
      dismissal, not just the confirmation. */
  state.confirming = { onOk: opts.onOk, onCancel: opts.onCancel || null };
  $("#cfTitle").textContent = opts.title;
  $("#cfPath").textContent = opts.path;
  /* An EMPTY body takes the body BOX with it, not just the text. A dialog whose
     whole content is a heading and a footer (askDelete) would otherwise carry a
     zero-height paragraph and its padding — a band of empty panel between the
     path and the verbs that reads as a rendering fault. */
  $("#cfBody").textContent = opts.body || "";
  $("#cfBody").closest(".modal-body").hidden = !opts.body;
  $("#cfOkTxt").textContent = opts.ok || "Confirm";
  /* THE CHROME IS PER CALLER, not hard-coded for the delete case.
     The warning triangle, the red OK button and the footer line are the app's
     destructive-action pattern; wearing them on a dialog whose OK button
     CREATES a file (the missing home doc — a state a fresh vault is in by
     default, since `editor.homeDoc` ships as `index.md`) tells the user the
     opposite of what the action does, under a footer promising data loss that
     is not on offer. `danger` defaults to true so a caller must opt OUT of the
     warning, and `note` is the caller's own words about what is recoverable. */
  const danger = opts.danger !== false;
  $("#cfModal").classList.toggle("safe", !danger);
  $("#cfOk").classList.toggle("danger", danger);
  $("#cfOk").classList.toggle("primary", !danger);
  $("#cfNote").textContent = opts.note || (danger ? "Recoverable only from git history." : "");
  $("#cfVeil").classList.add("show");
  setTimeout(() => $("#cfOk").focus(), 30);
}

export function closeConfirm() {
  const fn = state.confirming && state.confirming.onCancel;
  state.confirming = null;
  $("#cfVeil").classList.remove("show");
  if (fn) fn();
}

/* deliberately NOT closeConfirm(): taking the record first is what keeps the OK
   path from also firing the cancel callback on its way out */
export function confirmOk() {
  const c = state.confirming;
  state.confirming = null;
  $("#cfVeil").classList.remove("show");
  if (c && c.onOk) c.onOk();
}

/* ---------- save conflict (SPEC §5: dirty buffer → banner with diff) ---------- */

/**
 * A 409 used to be answered by re-GETting the doc and assigning the disk text
 * straight over `doc.markdown` — silently destroying whatever the user had
 * typed, with no confirmation and no undo (`renderDoc` rebuilds the textarea,
 * so even the browser's own undo stack went with it). SPEC §5 asks for the
 * opposite: clean buffer → silent reload, dirty buffer → this banner, with the
 * diff and both ways out. The 409 body already carries the server's markdown
 * (SPEC §3 delta 3) precisely so it can be drawn without a second round trip.
 */
export function conflictDialog(path, diskText, mineText) {
  state.conflict = { path: path, disk: diskText, mine: mineText, mode: "conflict" };
  $("#cxTitle").textContent = "This doc changed on disk";
  $("#cxPath").textContent = path;
  $("#cxBody").textContent =
    "Someone — another device, another editor, or a rename that rewrote a [[link]] here — wrote this doc while you were typing. Nothing has been overwritten.";
  $("#cxNote").textContent = "Your unsaved text is still in the editor.";
  renderDiff($("#cxDiff"), lineDiff(diskText, mineText));
  paintConflictMode("conflict");
  $("#cxVeil").classList.add("show");
  setTimeout(() => $("#cxMine").focus(), 30);
}

/**
 * THE SAME VEIL, for the doc that is not there any more.
 *
 * Reused rather than invented: this is the other half of the same question the
 * conflict banner asks — "the file under your buffer moved and you have to say
 * what happens to your text" — and answering it in a second, differently-shaped
 * modal would be two places for the guard on unsaved work to drift apart. Only
 * the wording and the two verbs change.
 *
 * The diff is drawn against an EMPTY disk side, which is literally true: every
 * line here exists only in this tab.
 */
export function orphanDialog(path, opts) {
  const doc = state.docs.get(path);
  if (!doc) return;
  state.conflict = { path: path, disk: "", mine: doc.markdown, mode: "orphan" };
  $("#cxTitle").textContent = "This doc is no longer in the vault";
  $("#cxPath").textContent = path;
  $("#cxBody").textContent =
    "It was deleted — on another device, or outside the app — while you were typing. Your text was never on disk under this name, so this tab is the only copy of it. Recreate the file with what is in the editor, or discard the buffer and let the deletion stand.";
  $("#cxNote").textContent = "Discarding cannot be undone from here.";
  renderDiff($("#cxDiff"), lineDiff("", doc.markdown));
  paintConflictMode("orphan");
  $("#cxVeil").classList.add("show");
  /* WHO ASKED FOR THIS VEIL DECIDES WHERE FOCUS GOES.
     Recreate is a BUTTON somebody has to press — but a focused button is
     pressed by SPACE, and this dialog is raised by the ordinary autosave as
     well as by ⌘S. MEASURED at the shipped 10s debounce: a writer typing into a
     doc another device had deleted paused to think, the veil opened by itself,
     `document.activeElement` became #cxRecreate, and resuming with an ordinary
     sentence recreated the file on its first character — the deletion undone
     with no deliberate press — while all 26 characters after that space were
     swallowed by the button. Both failures this dialog exists to prevent, on
     one keystroke.

     So focus is only MOVED for a save the user asked for. Raised unprompted it
     goes to the dialog itself: the veil is on screen and every key that could
     act on it (Tab, Enter on a chosen button, Esc) still works, but no default
     verb is sitting under the space bar. */
  const target = opts && opts.focus === false ? $("#cxVeil .modal") : $("#cxRecreate");
  setTimeout(() => target && target.focus(), 30);
}

/** Which pair of verbs the footer offers. */
function paintConflictMode(mode) {
  const orphan = mode === "orphan";
  $("#cxDisk").hidden = orphan;
  $("#cxMine").hidden = orphan;
  $("#cxDiscard").hidden = !orphan;
  $("#cxRecreate").hidden = !orphan;
}

export function closeConflict() {
  state.conflict = null;
  $("#cxVeil").classList.remove("show");
}

/**
 * RECREATE — write the buffer back into the vault under its old name.
 *
 * A POST, not a PUT: there is no file and no rev to answer, so this is a
 * create in every sense the server has. `doc.markdown` is post-`flushSecretEdits`
 * armor (doSaveDoc runs that before it ever reaches the orphan gate), so the
 * leak gate holds on this path exactly as it does on the ordinary save.
 */
export async function conflictRecreate() {
  const c = state.conflict;
  closeConflict();
  if (!c) return;
  const doc = state.docs.get(c.path);
  if (!doc) return;
  try {
    const r = await api.createEntry({ path: c.path, type: "doc", markdown: doc.markdown });
    delete doc.orphaned;
    setBaseline(doc, doc.markdown);
    doc.rev = r.rev;
    doc.mtime = r.mtime;
    doc.bytes = r.bytes;
    doc.loaded = true;
    if (c.path === state.active) {
      state.dirty = false;
      setSaveIndicator("Saved");
    }
    await refreshTree().catch(() => {});
    clearStickyToast();
    toast("Recreated " + c.path);
  } catch (err) {
    /* still orphaned, still dirty, notice still up — nothing was lost by
       failing, which is the only property that matters here */
    apiFail(err, "Could not recreate " + c.path);
  }
}

/** DISCARD — let the deletion stand, on the user's say-so and nobody else's. */
export async function conflictDiscardOrphan() {
  const c = state.conflict;
  closeConflict();
  if (!c) return;
  state.docs.delete(c.path);
  clearStickyToast();
  if (c.path !== state.active) return toast("Discarded the buffer for " + c.path);
  state.active = null;
  state.dirty = false;
  await refreshTree().catch(() => {});
  toast("Discarded — " + c.path + " stays deleted");
  openFirstDoc();
}

/**
 * The ONE diff-row markup, for both surfaces that show one: the save-conflict
 * banner (rows from `lineDiff`) and the AI proposal card (rows from the
 * server's `p.diff`). Both produce {marker, text} and both must land on the
 * `.dl/.add/.del/.ctx` shape base.css styles exactly once — so a gutter change
 * cannot make the banner guarding unsaved work render unlike the card.
 */
export function renderDiff(box, rows) {
  box.innerHTML = "";
  rows.forEach((d) => {
    const line = el("div", "dl " + (d.marker === "+" ? "add" : d.marker === "-" ? "del" : "ctx"));
    line.innerHTML = '<span class="g">' + (d.marker === " " ? "" : d.marker) + '</span><span class="t">' + esc(d.text) + "</span>";
    box.appendChild(line);
  });
}

/** `-` is the disk, `+` is your buffer. Common head and tail are context. */
function lineDiff(disk, mine) {
  const a = String(disk).split("\n");
  const b = String(mine).split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  const ctx = (i) => out.push({ marker: " ", text: a[i] });
  if (head > 0) ctx(head - 1);
  for (let i = head; i < a.length - tail; i++) out.push({ marker: "-", text: a[i] });
  for (let i = head; i < b.length - tail; i++) out.push({ marker: "+", text: b[i] });
  if (tail > 0) out.push({ marker: " ", text: a[a.length - tail] });
  return out.slice(0, 300);
}

/**
 * Added/removed lines only, across as many separate hunks as the edit has.
 *
 * `lineDiff` above intentionally includes a context row and collapses the
 * whole middle between a common head and tail. That is useful in the conflict
 * and proposal surfaces, but it is not the Raw-exit contract: two edits far
 * apart must not make every unchanged line between them appear removed and
 * re-added. Myers' shortest-edit walk gives the real changed rows without
 * copying the full document into the modal. The result is capped at the same
 * 300 visible rows as the other diff surfaces.
 */
export function changedLineDiff(disk, mine) {
  const diskLines = String(disk).split("\n");
  const mineLines = String(mine).split("\n");
  /* Most note edits leave a large common rim. Remove it before retaining the
     Myers frontiers: a two-line edit in a 10,000-line note should cost two
     lines, not two copies of the note. */
  let head = 0;
  while (head < diskLines.length && head < mineLines.length && diskLines[head] === mineLines[head]) head++;
  let tail = 0;
  while (
    tail < diskLines.length - head &&
    tail < mineLines.length - head &&
    diskLines[diskLines.length - 1 - tail] === mineLines[mineLines.length - 1 - tail]
  )
    tail++;
  const a = diskLines.slice(head, diskLines.length - tail);
  const b = mineLines.slice(head, mineLines.length - tail);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  /* The modal displays 300 changed rows. A rewrite whose shortest path is far
     beyond that must not allocate a quadratic trace merely to discard nearly
     all of it; after this bound, a context-free replacement is still an honest
     +/- diff and includes rows from both versions. */
  const walkTo = Math.min(max, 600);
  let v = new Map([[1, 0]]);
  const trace = [];
  const at = (map, k) => (map.has(k) ? map.get(k) : -Infinity);

  for (let d = 0; d <= walkTo; d++) {
    /* The snapshot is V[d-1]. Backtracking from the d-edit endpoint needs
       exactly that frontier to decide which diagonal it came from. */
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && at(v, k - 1) < at(v, k + 1))) x = Math.max(0, at(v, k + 1));
      else x = Math.max(0, at(v, k - 1)) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x < n || y < m) continue;

      const out = [];
      let bx = n;
      let by = m;
      for (let bd = trace.length - 1; bd >= 0; bd--) {
        const prev = trace[bd];
        const bk = bx - by;
        const prevK = bk === -bd || (bk !== bd && at(prev, bk - 1) < at(prev, bk + 1)) ? bk + 1 : bk - 1;
        const prevX = Math.max(0, at(prev, prevK));
        const prevY = prevX - prevK;
        while (bx > prevX && by > prevY) {
          bx--;
          by--;
          out.push({ marker: " ", text: a[bx] });
        }
        if (bd === 0) break;
        if (bx === prevX) {
          by--;
          out.push({ marker: "+", text: b[by] });
        } else {
          bx--;
          out.push({ marker: "-", text: a[bx] });
        }
      }
      return out.reverse().filter((row) => row.marker !== " ").slice(0, 300);
    }
  }
  const oldCount = Math.min(n, m ? 150 : 300);
  const newCount = Math.min(m, 300 - oldCount);
  return [
    ...a.slice(0, oldCount).map((text) => ({ marker: "-", text })),
    ...b.slice(0, newCount).map((text) => ({ marker: "+", text })),
  ];
}

/** Take disk: throw the buffer away, deliberately, on the user's say-so. */
export async function conflictTakeDisk() {
  const c = state.conflict;
  closeConflict();
  if (!c) return;
  const doc = state.docs.get(c.path);
  const fresh = await api.getDoc(c.path).catch(() => null);
  if (!fresh) return toast("Could not re-read " + c.path);
  state.docs.set(c.path, setBaseline(Object.assign({}, doc || {}, fresh, { loaded: true }), fresh.markdown));
  if (c.path === state.active) {
    state.dirty = false;
    renderDoc();
  }
  toast("Took the version on disk");
}

/** Keep mine: re-save the buffer against the rev the server just told us about. */
export async function conflictKeepMine() {
  const c = state.conflict;
  closeConflict();
  if (!c) return;
  const doc = state.docs.get(c.path);
  if (!doc) return;
  const fresh = await api.getDoc(c.path).catch(() => null);
  if (!fresh) return toast("Could not re-read " + c.path);
  doc.rev = fresh.rev; // the buffer is unchanged; only the rev it answers moves
  const ok = await saveDoc(c.path, { silent: true });
  toast(ok ? "Kept your version · " + c.path : "Could not save " + c.path);
}
