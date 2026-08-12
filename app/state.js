/* ============================================================
   state.js — caches of what the server said, never a source of truth.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";


/* ============================================================
   STATE — caches of what the server said, never a source of truth
   ============================================================ */
export const state = {
  vault: null,
  tree: [],
  docs: new Map(), // path → { …meta, markdown, rev, loaded }
  docPaths: new Set(), // every doc path the tree knows — the link resolver's world
  slugs: new Map(), // slug → [paths]; two entries is a COLLISION, not a winner
  folderOpen: new Map(), // path → bool (survives tree refetches)
  active: null,
  /* Which PLACE the editor pane is showing: the open doc, or the settings page
     at `/settings`. `active` keeps naming the doc either way — settings is a
     destination you come back FROM, and the doc it returns to is the one it
     never let go of. */
  view: "doc",
  /* How the settings page was ENTERED — "open" (from a doc), "back"/"forward"
     (history traversal). Written by shell.js routing and read back by
     settings.js when leaving; shared mutable, so it lives here. */
  settingsExit: "open",
  settingsSection: "", // the `/settings/<section>` the address bar carries, if any
  mode: "preview",
  /* Raw word wrapping is a view choice, like mode rather than file content.
     It is remembered per browser and never changes the markdown bytes. */
  wordWrap: true,
  dirty: false,
  saving: new Set(), // paths with a PUT in flight
  settings: null,
  meta: null,
  session: null,
  proposals: [],
  stack: [],
  /* Revealed secret blocks: key → { path, armor, indent, plain, dirty }.
     The DOCUMENT MODEL never holds plaintext — doc.markdown keeps the armor as
     the source of truth and this map is the only place a decrypted block lives
     outside its own DOM node (research §6). Keyed by armor, not by
     line number, so it survives re-renders and external edits. */
  reveal: new Map(),
  sync: null,
  conn: "connecting",
  aiStatus: null, // last `meta.ai.status` / `ai-status` seen — see paintAiStatus
  creating: null,
  renaming: null, // { path, kind } — the tree row currently being edited in place
  /* The sidebar trash drawer. `available` is the ONE gate: it starts false and
     is only ever set by a GET /api/trash that answered, so a server without the
     route leaves the block unmounted and leaves the delete dialog saying what
     it said before trash existed. Everything else here is a cache of that GET,
     never a source of truth — `entries` is re-fetched after every delete,
     restore and purge rather than patched in place. */
  trash: {
    available: false,
    open: false,
    loading: false,
    entries: [],
    retentionDays: null,
    error: null, // a failed LIST, shown in the drawer
    busy: new Set(), // entry ids with a restore/purge in flight
    rowErr: new Map(), // entry id → the refusal that row is showing (409 exists)
  },
  confirming: null, // { onOk } — the open confirm dialog
  conflict: null, // { path, disk, mine } — the open save-conflict banner
  /* { path, proceed } — the open exit guard and the way out it is holding back.
     Non-null is what stops a second trigger stacking a second copy. */
  exitGuard: null,
  /* …and the settings page's twin of it: true while the "leave with unsaved
     changes?" confirm is up. Same job — a second trigger (a tree click behind
     the veil, a Back press) must not stack a second dialog over the first and
     replace the destination the first one is holding. */
  settingsGuard: false,
  events: null,
  epoch: null, // vault epoch from the last `hello` — see resyncAfterGap()
  /* The sidebar row the user last touched — { path, kind } — and the ONLY
     thing that makes ⌥N context-aware (see `createParent`). Set by a click or
     a focus on a tree row, cleared by `openDoc` so that opening a doc hands the
     context back to `state.active`. Never trusted blind: `createParent`
     re-checks it against the current tree, because a rename or a delete can
     retire the row underneath it. */
  pick: null,
  /* Terminal. `status` is the SERVER's verdict, never inferred here;
     `commands` are the assistant's command records. The unlock token is not in
     this object and never will be — it lives in api.js alone. */
  term: { status: null, running: null, busy: false, history: [], hist: -1, draft: "", printed: new Set() },
  commands: [],
};
