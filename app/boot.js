/* ============================================================
   boot.js — the page's entry: start the app, then offer it offline.

   The shell names this file as its one module script; it imports app.js
   statically, so the whole shell is one graph the build splits and <head>
   preloads. A throw in start() leaves the splash up, carrying the reason.

   The service worker is registered AFTER start() resolves, never before: the
   first visit's editing path must not share the network with a precache of
   the whole release. Only when the shell says the worker is on and the page
   is on the canonical origin (ADR 0042): another origin would fill a second
   device copy that the canonical one never sees.
   ============================================================ */
"use strict";

import { start } from "./app.js";
import { exitDiff } from "./editor.js";
import { commitFocusedNumber, settingsDirty } from "./settings.js";
import { flushBuffer } from "./shell.js";
import { notice } from "./ui.js";

/* The e2e harness's handle on the running app: the suites import this entry
   (the module map hands back THIS instance) to read what the page holds. */
export { state } from "./state.js";
export { replaceDocText } from "./editor.js";
export { healAfterGap } from "./shell.js";
export { vault } from "./secrets.js";
export { pendingHistory } from "./history.js";

const bootMsg = document.getElementById("bootMsg");
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || "";

function fatal(text, detail) {
  bootMsg.innerHTML = "<b>" + text + '</b><br><span style="font-size:12px">' + detail + "</span>";
}

function offOrigin(origin) {
  const KEY = "znotes.origin-notice";
  try {
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
  } catch (e) {}
  const link = document.createElement("a");
  link.href = origin + location.pathname + location.search;
  link.textContent = origin;
  notice("z-notes lives at ", link, " — open it there to use it offline.");
}

async function registerWorker() {
  let reg;
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  } catch (err) {
    console.warn("[z-notes] service worker", err);
    return;
  }
  /* `controllerchange` also fires when the FIRST worker claims this page;
     only a Reload the user asked for may reload it */
  let accepted = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (accepted) location.reload();
  });
  const offer = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    const reload = document.createElement("button");
    reload.className = "btn";
    reload.textContent = "Reload";
    reload.addEventListener("click", async () => {
      /* saved, or at least on the device, before the page goes — and typing
         that landed during that save gets a second pass. Text still at risk
         after it (a full device, a refused save) keeps the page, and so does
         a settings draft — it lives in memory only (the unload guard's read). */
      await flushBuffer();
      if (exitDiff()) await flushBuffer();
      if (exitDiff()) return notice("Not reloaded — unsaved changes are not on this device yet. A new version is ready ", reload);
      commitFocusedNumber();
      if (settingsDirty()) return notice("Not reloaded — settings changes are unsaved. A new version is ready ", reload);
      accepted = true;
      reg.waiting?.postMessage({ type: "skip-waiting" });
    });
    notice("A new version is ready ", reload);
  };
  offer();
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    next?.addEventListener("statechange", () => {
      if (next.state === "installed") offer();
    });
  });
}

async function boot() {
  bootMsg.textContent = "loading vault…";
  try {
    await start();
  } catch (err) {
    console.error(err);
    fatal("The app failed to start", String((err && err.message) || err));
    return;
  }
  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;
  let origin = meta("znotes-origin");
  try {
    origin = origin && new URL(origin).origin;
  } catch (e) {}
  if (origin && origin !== location.origin) return offOrigin(origin);
  if (meta("znotes-sw") === "on" && "serviceWorker" in navigator) registerWorker();
}
boot();
