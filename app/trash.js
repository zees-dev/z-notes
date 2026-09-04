/* ============================================================
   trash.js — the sidebar trash drawer.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, apiFail, el, esc, toast } from "./ui.js";
import { loadTree } from "./tree.js";
import { confirmDialog } from "./dialogs.js";
import { openDoc } from "./editor.js";
import { revealInTree } from "./shell.js";

/* ============================================================
   TRASH — the sidebar drawer, and what a delete can be undone from

   Everything a deleted doc can still have done to it lives here, in one block
   between the tree and `.sb-foot`. It is a DISCLOSURE, not a route: it opens in
   place, writes nothing to the address bar, and takes no history entry — so
   Back still means "the doc before this one" while it is open, and closing the
   drawer is not something the user has to undo.

   Three rules it keeps:

     - THE SERVER IS THE LIST. Every mutation re-fetches rather than splicing
       the local array: a restore can fail on a path that filled up behind it,
       a purge can race the server's own retention sweep, and a list patched
       from a reply is a second source of truth for something the tree already
       had to re-fetch anyway.
     - IT DEGRADES TO NOTHING. `state.trash.available` is only ever set true by
       a GET that answered; a 404/405 leaves the block unmounted, and every
       sentence in the app that promises a trash is behind the same flag.
     - RESTORE IS ONE CLICK, PERMANENT DELETE IS TWO. Restore is reversible (it
       is a delete away from where it started) and gets no dialog. The other one
       is the only irreversible verb in the sidebar and takes the same confirm
       chrome as everything else destructive — `confirmDialog`, not a second
       modal.
   ============================================================ */

/** Compact "3m" / "2h" / "5d" for a timestamp, past or future. The tree's
    `relTime` is not reusable here: it hard-codes the word "Edited", stops at
    hours, and this column has ~90px for BOTH halves of "deleted X · purges Y". */
function shortSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h";
  return Math.round(h / 24) + "d";
}

/** "deleted 4m ago · purges in 30d" — the second half omitted when the server
    did not say, rather than guessed at from a retention this client invented. */
function trashWhen(e) {
  const now = Date.now();
  const del = e.deletedAt ? new Date(e.deletedAt).getTime() : NaN;
  const gone = e.purgeAt ? new Date(e.purgeAt).getTime() : NaN;
  const parts = [];
  if (!isNaN(del)) parts.push("deleted " + (now - del < 45000 ? "just now" : shortSpan(now - del) + " ago"));
  if (!isNaN(gone)) parts.push(gone <= now ? "purging now" : "purges in " + shortSpan(gone - now));
  return parts.join(" · ");
}

/** The footer line of the delete dialog, once there is a trash to promise. */
export function trashRetentionNote() {
  const d = state.trash.retentionDays;
  return d ? "In the trash for " + d + " day" + (d === 1 ? "" : "s") + ", then purged for good." : "In the trash until it is purged.";
}

/**
 * Re-read the trash from the server and repaint.
 *
 * Fire-and-forget by design — every caller (boot, a delete, a restore) has
 * already done the thing the user asked for, and a trash count that is one
 * refresh stale is not worth blocking on or shouting about. A LIST that fails
 * while the drawer is OPEN is the one case with somewhere to say so.
 */
let trashAgain = false;

/** Adopt the server's whole list. Used by both GET and `trash-changed`, so an
    open drawer follows deletes/restores/purges from another client without a
    close/reopen and there is still only one local shape for the response. */
export function adoptTrash(r) {
  if (!r || !Array.isArray(r.entries)) return;
  state.trash.available = true;
  state.trash.entries = r.entries;
  state.trash.retentionDays = r.retentionDays;
  state.trash.error = null;
  const live = new Set(r.entries.map((e) => e.id));
  [...state.trash.busy].forEach((id) => live.has(id) || state.trash.busy.delete(id));
  [...state.trash.rowErr.keys()].forEach((id) => live.has(id) || state.trash.rowErr.delete(id));
  paintTrash();
}

/** the GET in flight, if any — the coalescing key and the promise a late
    caller is handed */
let trashInflight = null;

/**
 * Re-read the trash. A folder delete announces one `doc-changed` per doc, so
 * this is called in bursts. The last event describes the finished state, so
 * a call that arrives mid-flight is remembered and run once at the end
 * instead of N times over. The promise resolves after that follow-up run,
 * not after the one already in flight: `doDelete` fires this without
 * awaiting it, and the next caller (`list_trash`, a restore by id) used to
 * be handed the pre-delete list and told it was fresh.
 */
export function refreshTrash() {
  if (trashInflight) {
    trashAgain = true;
    return trashInflight.then(() => trashInflight || undefined);
  }
  trashInflight = fetchTrash().finally(() => {
    trashInflight = null;
    if (trashAgain) {
      trashAgain = false;
      trashInflight = refreshTrash();
    }
  });
  return trashInflight;
}

async function fetchTrash() {
  state.trash.loading = true;
  paintTrash();
  try {
    adoptTrash(await api.getTrash());
  } catch (err) {
    /* A server with no trash route is not an error the user did anything to
       cause: leave the block unmounted and say nothing. Anything else IS a
       failure of a feature that exists, and the open drawer shows it. */
    const missing = err && (err.status === 404 || err.status === 405);
    if (missing) state.trash.available = false;
    else state.trash.error = (err && err.message) || "Could not read the trash";
  } finally {
    state.trash.loading = false;
    paintTrash();
  }
}

/** The row: mounted at all, how many, and which way the chevron points. */
function paintTrash() {
  const box = $("#sbTrash");
  if (!box) return;
  const t = state.trash;
  box.hidden = !t.available;
  if (!t.available) {
    /* a trash that went away cannot stay open over a tree it no longer has */
    t.open = false;
    return;
  }
  const n = t.entries.length;
  const link = $("#trashLink");
  const count = $("#trashCount");
  count.hidden = n === 0;
  count.textContent = String(n);
  link.setAttribute("aria-expanded", t.open ? "true" : "false");
  link.title = n
    ? "Recently deleted — " + n + " item" + (n === 1 ? "" : "s") + ", restore or delete for good"
    : "Recently deleted — nothing in here";
  box.classList.toggle("open", t.open);
  $("#trashList").hidden = !t.open;
  if (t.open) paintTrashList();
}

function paintTrashList() {
  const host = $("#trashList");
  const t = state.trash;
  host.innerHTML = "";
  if (t.error) {
    host.appendChild(el("div", "trash-empty trash-err", esc(t.error)));
    return;
  }
  if (!t.entries.length) {
    host.appendChild(el("div", "trash-empty", t.loading ? "Reading…" : "Nothing deleted yet."));
    return;
  }
  t.entries.forEach((e) => host.appendChild(trashRow(e)));
  /* One press for the whole list, once there is a list worth the press. Below
     three rows it is not a shortcut — it is a second way to do what the row
     buttons already do, sitting one tap from Restore. */
  if (t.entries.length >= 3) {
    const all = el("button", "trash-act purge trash-empty-all", "Empty trash");
    all.type = "button";
    all.title = "Delete all " + t.entries.length + " permanently";
    all.addEventListener("click", askEmptyTrash);
    host.appendChild(all);
  }
}

function trashRow(e) {
  const busy = state.trash.busy.has(e.id);
  const row = el("div", "trash-item" + (busy ? " busy" : ""));
  /* the path is user text in an arbitrary script — `<bdi>` isolates it from the
     rtl box that puts the ellipsis on the LEFT (base.css), so a filename can
     never reorder the punctuation around it */
  const p = el("div", "trash-path", "<bdi>" + esc(e.path) + "</bdi>");
  p.title = e.path + (e.kind === "folder" ? " (folder)" : "");
  row.appendChild(p);
  const when = trashWhen(e);
  if (when) row.appendChild(el("div", "trash-when", esc(when)));

  const acts = el("div", "trash-acts");
  const act = (cls, label, title, fn) => {
    const b = el("button", "trash-act " + cls, esc(label));
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = busy;
    b.addEventListener("click", fn);
    return b;
  };
  acts.appendChild(act("restore", "Restore", "Restore " + e.path + " to its original folder", () => restoreFromTrash(e)));
  acts.appendChild(act("purge", "Delete", "Delete " + e.path + " permanently", () => askPurgeEntry(e)));
  row.appendChild(acts);

  const err = state.trash.rowErr.get(e.id);
  if (err) row.appendChild(el("div", "trash-err", esc(err)));
  return row;
}

/** Open the drawer, or shut it. The first open pays for a fetch; every one
    after that repaints what is already there and re-reads in the background,
    so the list can never be older than the last thing that happened to it. */
export function toggleTrash() {
  const t = state.trash;
  if (!t.available) return;
  t.open = !t.open;
  t.rowErr.clear();
  paintTrash();
  if (t.open) refreshTrash();
}

/** @returns {Promise<string|null>} where it landed, or null if it did not. */
async function restoreFromTrash(e) {
  const t = state.trash;
  if (t.busy.has(e.id)) return null;
  t.busy.add(e.id);
  t.rowErr.delete(e.id);
  paintTrashList();
  let landed = e.path;
  try {
    const r = await api.restoreTrash(e.id);
    if (r && r.path) landed = r.path;
  } catch (err) {
    t.busy.delete(e.id);
    /* THE CONFLICT STAYS ON THE ROW. 409 `exists` means something now occupies
       the path this entry wants back, and the only thing the user can do about
       it is move that something — which is a tree operation, next to the row
       that is still sitting there naming the path. A toast would take the
       sentence away from the button that produced it. */
    if (err && (err.status === 409 || err.code === "exists")) {
      t.rowErr.set(e.id, e.path + " is taken — rename what is there, then restore.");
      paintTrashList();
      return null;
    }
    paintTrashList();
    apiFail(err, "Could not restore " + e.path);
    return null;
  }
  t.busy.delete(e.id);
  await loadTree();
  await refreshTrash();
  /* it is back in the world: show the user where, and open it — a restore is a
     deliberate act on a specific doc, and the doc is what they wanted */
  if (state.docPaths.has(landed)) {
    revealInTree(landed);
    await openDoc(landed);
  }
  toast("Restored " + landed);
  return landed;
}

/* Heading, target, verb, footer — the same four parts `askDelete` was cut down
   to. The paragraph that used to sit here said "no restore, no undo" twice over
   a button already labelled "Delete for good", under a footer that names the
   one recovery that does exist. */
function askPurgeEntry(e) {
  confirmDialog({
    title: e.kind === "folder" ? "Delete folder permanently" : "Delete doc permanently",
    path: e.path,
    body: "",
    ok: "Delete for good",
    note: "The git history is what is left.",
    onOk: () => purgeEntry(e),
  });
}

/** @returns {Promise<boolean>} whether the entry is really gone. */
async function purgeEntry(e) {
  const t = state.trash;
  if (t.busy.has(e.id)) return false;
  t.busy.add(e.id);
  t.rowErr.delete(e.id);
  paintTrashList();
  try {
    await api.purgeTrashEntry(e.id);
  } catch (err) {
    t.busy.delete(e.id);
    paintTrashList();
    apiFail(err, "Could not delete " + e.path);
    return false;
  }
  t.busy.delete(e.id);
  await refreshTrash();
  toast("Deleted " + e.path + " for good");
  return true;
}

function askEmptyTrash() {
  const n = state.trash.entries.length;
  confirmDialog({
    title: "Empty trash",
    path: n + " item" + (n === 1 ? "" : "s"),
    body: "",
    ok: "Empty trash",
    note: "The git history is what is left.",
    /* the toast inside is the whole report; the throw below it belongs to the
       caller that has no screen (`webmcp.js`), not to a dialog button */
    onOk: () => emptyTrash().catch(() => {}),
  });
}

export async function emptyTrash() {
  try {
    /* `{ all: true }` — the sweep the SERVER runs on its own drops only what is
       already expired, and this is the user saying they meant all of it */
    const r = await api.purgeTrash({ all: true });
    await refreshTrash();
    /* `purged` is the LIST of ids the route emptied (0002 § POST /api/trash/purge),
       never a count — this read used to ask for a number, always got an object,
       and quietly fell to 0, so the sentence naming what went was dead the day
       it was written and `empty_trash` would have reported the same nothing */
    const n = Array.isArray(r && r.purged) ? r.purged.length : 0;
    toast(n ? "Deleted " + n + " item" + (n === 1 ? "" : "s") + " for good" : "Trash emptied");
    return { purged: n };
  } catch (err) {
    await refreshTrash();
    apiFail(err, "Could not empty the trash");
    throw err;
  }
}

/* ---------- the same two verbs, addressed by id ----------

   A row hands its own entry object to the functions above. A caller that
   only has an id (`webmcp.js`) resolves it against a freshly read list, since
   the question is whether the entry is still there now, and then presses the
   same button the row does. A second restore path would give the drawer two
   answers to "is it still in the trash". */

/** @returns {Promise<{path:string}>} — throws `not-found` / `failed`. */
export async function restoreTrashEntry(id) {
  const e = await trashEntry(id);
  const landed = await restoreFromTrash(e);
  if (!landed) {
    /* the row's own refusal, in the API's words: a 409 leaves its sentence on
       the row rather than in a toast, and that sentence is the whole answer */
    const taken = state.trash.rowErr.get(e.id);
    if (taken) throw new api.ApiError(409, { error: "exists", message: taken });
    throw new api.ApiError(409, { error: "failed", message: "Could not restore " + e.path + "." });
  }
  return { path: landed };
}

/** @returns {Promise<{purged:true}>} — throws `not-found` / `failed`. */
export async function purgeTrashEntry(id) {
  const e = await trashEntry(id);
  if (!(await purgeEntry(e))) throw new api.ApiError(409, { error: "failed", message: "Could not delete " + e.path + "." });
  return { purged: true };
}

async function trashEntry(id) {
  await refreshTrash();
  const e = (state.trash.entries || []).filter((x) => x.id === id)[0];
  if (!e) throw new api.ApiError(404, { error: "not-found", message: "Nothing in the trash with id " + id + "." });
  return e;
}
