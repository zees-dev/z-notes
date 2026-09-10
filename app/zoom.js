/* ============================================================
   zoom.js — the pinch belongs to the app, and it steps TEXT (ADR 0033).

   A phone pinch over a notes app means "make this bigger to read", and the
   browser answers it by scaling the LAYOUT — chrome, sidebar and all — leaving
   the shell scrolled sideways with the topbar half off screen. Installed to a
   home screen it does nothing at all. So the app takes the gesture: the
   viewport meta and `touch-action` switch the browser's version off, and this
   module puts the two fingers on a fixed ladder of text sizes instead.

   A LADDER, not a free-flowing scale. Every rung is a size the theme still
   reads correctly at, the step is legible on a 4" screen, and the value is
   short enough to say out loud in a toast. A continuous factor would land on
   1.0736 and stay there.

   ONE published number: `--doc-zoom` on `<html>`. base.css multiplies the
   document's own sizes by it (§7) and NOTHING else reads it, which is what
   keeps the chrome still while the note grows. The persisted value is the
   MULTIPLIER, never an index into the array below, so a later change to the
   ladder still reads an old store, to the nearest rung.

   The rung is a property of the READER, not of the file: there is deliberately
   no per-document zoom, and this module knows nothing about docs or modes.
   ============================================================ */
"use strict";

import { $, toast } from "./ui.js";

/** The ladder, as a multiplier of the theme's body size. Index 1 is 100 %. */
export const ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];

const ZOOM_STORE = "znotes.zoom";

/* How much the fingers have to travel to buy a rung. Asymmetric on purpose:
   spreading has the whole screen to move in and pinching only the gap the
   fingers already opened, so equal thresholds make "smaller" the harder of the
   two gestures to perform. A step per 25 % / 20 % is roughly one deliberate
   pinch — small enough that a slow one takes several rungs, large enough that
   a two-finger scroll or a thumb resting on the bezel takes none. */
const GROW = 1.25;
const SHRINK = 0.8;

/* The applied rung. Module-local rather than in state.js: nothing outside this
   file has a reason to read it except through `zoomFactor()`, and it is a
   property of this browser rather than a cache of what the server said. */
let factor = 1;

/** The rung nearest `n` — the only way a number becomes a zoom. A hand-edited
    store, a stale ladder and a percent off an agent all arrive through here. */
function nearest(n) {
  const x = Number(n);
  /* `<= 0` and not just NaN: `Number("")` is 0, and an empty store is a browser
     that has never zoomed rather than one asking for the smallest rung — which
     is also what the pre-paint script in index.html decided about it. */
  if (!Number.isFinite(x) || x <= 0) return 1;
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - x) < Math.abs(best - x) ? s : best), ZOOM_STEPS[0]);
}

/** The multiplier the document is currently rendered at. */
export function zoomFactor() {
  return factor;
}

/** Publish a rung: the custom property is the app's whole zoom mechanism, and
    the write-through is what makes the size outlive the tab. `announce` is off
    exactly once — at boot, where a toast would narrate a size nobody just
    chose. A private-mode browser that refuses the write still zooms. */
function apply(rung, announce) {
  factor = rung;
  document.documentElement.style.setProperty("--doc-zoom", String(rung));
  try {
    localStorage.setItem(ZOOM_STORE, String(rung));
  } catch (_) {
    /* the rung holds for this session either way */
  }
  if (announce) toast("Text size " + Math.round(rung * 100) + "%");
  return rung;
}

/** Set the text size to the rung nearest `f`, and say so. Returns what was
    actually applied, which is what the caller should report. */
export function setZoom(f) {
  return apply(nearest(f), true);
}

/** One rung up (`+1`) or down (`-1`). At either end of the ladder this is a
    no-op AND silent: a toast repeating the size the user is already at reads
    as a step that happened, and the gesture that produced it fires many times
    a second. */
export function stepZoom(dir) {
  const next = ZOOM_STEPS.indexOf(factor) + (dir > 0 ? 1 : -1);
  if (next < 0 || next >= ZOOM_STEPS.length) return factor;
  return apply(ZOOM_STEPS[next], true);
}

/**
 * Restore the remembered rung and take the pinch off the browser.
 *
 * The restore is a re-apply, not the first one: index.html's pre-paint script
 * has already put the same value on `<html>` so the reload does not flash the
 * old size. This is what puts it in `factor`, and what normalises a store
 * written by an older ladder.
 */
export function initZoom() {
  let stored = null;
  try {
    stored = localStorage.getItem(ZOOM_STORE);
  } catch (_) {
    /* a browser with no storage simply starts at 100 % every time */
  }
  apply(stored == null ? 1 : nearest(stored), false);

  const sc = $("#scroll");
  /* the finger separation the current rung was bought at, 0 when no pinch is
     under way */
  let d0 = 0;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  /* `>= 2`, not `=== 2`, and on every arrival AND departure: a third finger
     landing, or a 3→2 lift, changes which two fingers `spread` is measuring,
     and a gap measured across that change is not one anybody's hand opened. */
  const gauge = (e) => {
    d0 = e.touches.length >= 2 ? spread(e.touches) : 0;
  };
  for (const type of ["touchstart", "touchend", "touchcancel"]) sc.addEventListener(type, gauge, { passive: true });

  sc.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 2 || !d0) return;
      /* NOT passive, and this is why: without the preventDefault the two
         fingers are still the scroller's, and a pinch pans the document out
         from under the text it is resizing. */
      e.preventDefault();
      const d = spread(e.touches);
      const r = d / d0;
      if (r >= GROW || r <= SHRINK) {
        stepZoom(r >= GROW ? 1 : -1);
        /* the rung was bought at THIS separation, so a long slow pinch keeps
           stepping instead of measuring everything against where it started */
        d0 = d;
      }
    },
    { passive: false }
  );

  /* Safari's proprietary pinch, which is NOT a touch event and arrives even
     where `touch-action` has already spoken. A browser that never fires these
     pays for two dead listeners; one that does would otherwise scale the whole
     page on top of the ladder. */
  for (const type of ["gesturestart", "gesturechange"])
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
