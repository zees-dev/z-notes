/* ============================================================
   keybar.js — the soft keyboard carries an editing bar (ADR 0034).

   A phone editing markdown is missing four verbs. There is no Tab, so a list
   item cannot be nested — the commonest structural edit in a notes app. There
   is no ⇧Tab to unnest it. There is no ⌘Z. And the statusbar chip that leaves
   Raw is underneath the keyboard, which is the one place a thumb cannot reach.
   This module is those four verbs, on a bar pinned to the keyboard's top edge.

   IT EXISTS ONLY WHERE A SOFT KEYBOARD DOES, and that is a MEASURED condition
   rather than a guess about the device: `kb-up` is `wireVisualViewport`
   reporting that the visual viewport is actually covered, `raw-focus` is this
   file reporting that the caret is in the editor, and base.css §8a shows the
   bar when both hold. So a tablet with a hardware keyboard, and the desktop,
   never see it, and §11's "one axis, viewport width" rule is untouched.

   THE TAP MUST NOT MOVE THE FOCUS. Everything else here is arithmetic: the
   moment the editor blurs, the keyboard drops, the bar goes with it and the
   selection the button was about to act on is gone. So the bar swallows the
   pointer's default action and the buttons are never focused.

   No action lives here. Indent and Outdent are `indentSelection` — the very
   function Tab calls — Undo and Redo are the app's one timeline (ADR 0014),
   and Done is the door Esc leaves through.
   ============================================================ */
"use strict";

import { $ } from "./ui.js";
import { state } from "./state.js";
import { pendingHistory, stepHistory } from "./history.js";
import { canStepHistory, flushTextRun, indentSelection, setMode } from "./editor.js";

/* The Raw surface's id — the bar is chrome for that one element, and focus
   anywhere else is focus away from it. */
const RAW = "rawArea";

/** A step, taken the way the chord takes it: close the run you were typing
    first, so ⌘Z takes back what you just typed rather than what came before. */
async function step(redo) {
  flushTextRun();
  try {
    if (pendingHistory(redo)) await stepHistory(redo);
  } catch (_) {
    /* A step that fails has already said so itself — a toast, or the prompt a
       file operation asks (ADR 0014). Nothing to add, and a rejection escaping
       a click handler would surface as a page error instead. */
  }
  /* either way: the flush above may itself have put a step on the timeline,
     and the buttons are reporting exactly that */
  refreshKeybar();
}

const ACTIONS = {
  indent: () => indentSelection(false),
  outdent: () => indentSelection(true),
  undo: () => step(false),
  redo: () => step(true),
  /* THE SWITCH FIRST, the blur after it. This is the same call Esc makes,
     guard and all — a dirty buffer gets its question (ADR 0022) — and the
     answer may be "keep editing", which blurring first would have answered
     with a dropped keyboard and a lost caret. The blur is what makes the
     keyboard go away, so it is owed only once the mode actually changed. */
  done: () => {
    setMode("preview", { silent: true });
    const a = document.activeElement;
    if (state.mode === "preview" && a && a.blur) a.blur();
  },
};

/** Live/dead for the two timeline buttons. Cheap enough to run on every
    keystroke; `refreshKeybar` costs a layout read and must not. */
function syncSteps(bar) {
  for (const name of ["undo", "redo"]) {
    const b = bar.querySelector('[data-kb="' + name + '"]');
    if (b) b.disabled = !canStepHistory(name === "redo");
  }
}

let hideTimer = 0;
let published = "";

/**
 * Decide whether the bar is up, and publish its height.
 *
 * `offsetHeight` is 0 exactly when the stylesheet is hiding the bar, so one
 * read answers both questions at once — and `--keybar` is what
 * `revealRawCaret` subtracts to keep the line being typed above the bar that
 * is typing it.
 */
export function refreshKeybar() {
  const bar = $("#keybar");
  if (!bar) return;
  $("#app").classList.toggle("raw-focus", (document.activeElement || {}).id === RAW);
  /* Written only when it CHANGES. An inline custom property on `<html>`
     invalidates inherited values for the whole document, and this runs on
     every focus change anywhere in the app — where the answer is nearly always
     the same 0px it already was, over a Raw editor that is one element per
     line (ADR 0032). */
  const h = bar.offsetHeight + "px";
  if (h !== published) {
    published = h;
    document.documentElement.style.setProperty("--keybar", h);
  }
  syncSteps(bar);
}

/** Wire the markup in index.html. The bar builds nothing: it is chrome, and
    chrome that is in the HTML is chrome the first paint already has. */
export function initKeybar() {
  const bar = $("#keybar");
  if (!bar) return;
  /* `hidden` is the pre-boot state, so nothing shows in a browser that never
     ran this file. From here the stylesheet owns visibility. */
  bar.hidden = false;

  /* THE TRICK. `pointerdown` is the modern event and `mousedown` the
     compatibility one a touch still synthesises where the pointer events are
     not wired through; preventing only one leaves the other free to take the
     focus out of the editor. Delegated to the BAR rather than to the buttons
     so a tap that lands on the padding, the gap or a disabled button (which
     dispatches nothing of its own) is caught by the same handler. */
  for (const type of ["pointerdown", "mousedown"]) bar.addEventListener(type, (e) => e.preventDefault());

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kb]");
    const act = b && ACTIONS[b.dataset.kb];
    if (act) act();
  });

  /* Focus is tracked on the DOCUMENT, not on #rawArea: the editor element is
     rebuilt on every doc render, and a listener on it would be listening to a
     node that has left the page. */
  document.addEventListener("focusin", () => {
    clearTimeout(hideTimer);
    refreshKeybar();
  });
  document.addEventListener("focusout", () => {
    /* Deferred, because focus leaving and coming straight back is ordinary —
       a scroll-into-view, an IME window, the browser's own reshuffle after a
       re-render. Whatever holds the caret a moment later is the answer. */
    clearTimeout(hideTimer);
    hideTimer = setTimeout(refreshKeybar, 120);
  });
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === RAW) syncSteps(bar);
  });

  refreshKeybar();
}
