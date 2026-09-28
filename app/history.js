/* ============================================================
   history.js — ONE undo timeline for the whole app.

   Not one per document, and not one per kind of thing. A person's session is a
   single ordered list of things they did — rewrote a.md, deleted b.md — and ⌘Z
   walks back up that list whatever the next step turns out to be, taking them
   to the document it is about. It holds file operations, agent writes and
   protected-block edits; typing in Edit is the island's own history, and ⌘Z
   reaches this timeline once that has nothing left (ADR 0014, amended by 0039).

   The app owns the timeline. This module owns nothing else: it is a leaf
   (state and ui only), it holds the two stacks, and the actual work of putting
   a document or a file back is INJECTED by the composition root — the same
   `wireDialogs` shape dialogs.js uses, and the reason a leaf can drive
   editor.js and tree.js without importing either.
   ============================================================ */
"use strict";

/* Deep enough to cover a working session, bounded because every entry holds
   two copies of a document's text. Notes are small; sixty of them are not the
   thing that will run this tab out of memory. */
const MAX = 60;

const past = [];
const future = [];

/** (entry, undoing) => Promise<boolean>. False means "did not happen" — a
    declined prompt, a restore blocked by something now occupying the path —
    and leaves the entry exactly where it was, still on offer. */
let applyEntry = null;

export function wireHistory(fn) {
  applyEntry = fn;
}

/**
 * Record something the user did. Any new entry drops the redo branch: the
 * future it described is no longer reachable from here.
 */
export function recordHistory(entry) {
  if (entry.kind === "text" && entry.before === entry.after) return;
  past.push(entry);
  if (past.length > MAX) past.shift();
  future.length = 0;
}

/** What ⌘Z / ⌘⇧Z would do next, or null. Read before the chord is swallowed,
    so an empty timeline leaves the key to the browser. */
export function pendingHistory(redo) {
  const stack = redo ? future : past;
  return stack.length ? stack[stack.length - 1] : null;
}

export async function stepHistory(redo) {
  const from = redo ? future : past;
  const to = redo ? past : future;
  const entry = from[from.length - 1];
  if (!entry || !applyEntry) return false;
  const ok = await applyEntry(entry, !redo);
  if (ok === false) return false;
  /* The stacks move only after the work landed. Read `from` again rather than
     trusting the index: applying an entry can itself record (a save, a tree
     reload), and the array may not be the shape it was. */
  const at = from.lastIndexOf(entry);
  if (at >= 0) from.splice(at, 1);
  to.push(entry);
  return true;
}
