/* ============================================================
   tree.js — sidebar tree, create/rename/move/delete, context menu, dialogs.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, I, apiFail, clearStickyToast, dirname, dragHasFiles, el, esc, normTarget, relOf, syncDotClass, toast, vaultOf, vaultPrefix, vaultRootKey, withDefaultExtension } from "./ui.js";
import { cells } from "./markdown.js";
import { confirmDialog } from "./dialogs.js";
import { refreshTrash, trashRetentionNote } from "./trash.js";
import { flushTextRun, guardRawExit, navGate, openDoc, renderDoc, saveDoc, setBaseline, setMode, setSaveIndicator } from "./editor.js";
import { app, isDrawer, openFirstDoc, openNav, revealInTree } from "./shell.js";
import { recordHistory } from "./history.js";

/* ============================================================
   SIDEBAR TREE

   ONE TOP-LEVEL ROW PER VAULT, and everything under it is that vault's own
   tree with its paths already qualified by the server. The rows below a vault
   row know nothing about vaults: `node()` draws whatever path it is handed.

   INDENTATION IS ONE FORMULA — `8 + depth*14` px for EVERY row, folder and file
   alike. Files used to indent 6px further than their folder siblings, which was
   a mis-alignment dressed as a hierarchy; the chevron column they were missing
   is now an empty box of the same width, so labels line up at every depth and
   the only thing that moves a row is its depth.
   ============================================================ */

/** Every row's left inset, and the ONE place the step is written down. */
const rowPad = (depth) => 8 + depth * 14;

/** Where a `.children` box draws its branch guide: a step in from its parent
    row's text, so each row's tick runs from the line to its own content. */
const guideX = (parentDepth) => rowPad(parentDepth) + 7 + "px";

function indexTree(nodes, seen, bySlug) {
  nodes.forEach((n) => {
    if (n.type === "folder") {
      if (!state.folderOpen.has(n.path)) state.folderOpen.set(n.path, !!n.open);
      indexTree(n.children, seen, bySlug);
    } else {
      seen.add(n.path);
      const slug = n.path.split("/").pop().replace(/\.md$/i, "");
      const list = bySlug.get(slug);
      if (list) list.push(n.path);
      else bySlug.set(slug, [n.path]);
      const prev = state.docs.get(n.path);
      state.docs.set(n.path, Object.assign({ markdown: "", rev: null, loaded: false }, prev || {}, n));
    }
  });
}

export async function loadTree() {
  const r = await api.getTree();
  state.vault = r.vault;
  state.tree = r.tree;
  /* `vaults[]` is the whole picture; `vault`/`tree` are the primary's slice of
     it, kept for the header and for anything that only ever meant the primary.
     A server that answered without `vaults[]` still has one vault — draw it as
     one row rather than an empty sidebar. */
  state.vaults =
    Array.isArray(r.vaults) && r.vaults.length
      ? r.vaults
      : [{ id: "vault", label: r.vault.name, root: r.vault.root, docCount: r.vault.docCount, remote: null, repo: false, prefix: "", sync: state.sync, tree: r.tree }];
  /* The tree is the authoritative doc set, so the link world is rebuilt from
     it rather than accumulated: after a rename or a delete a stale slug would
     otherwise keep resolving to a path that is now a 404, and a slug that has
     just become AMBIGUOUS would keep silently resolving to whichever doc was
     indexed last. One slug map PER VAULT — a link never crosses one. */
  const seen = new Set();
  const slugs = new Map();
  state.vaults.forEach((v) => {
    const bySlug = new Map();
    slugs.set(v.id, bySlug);
    indexTree(v.tree || [], seen, bySlug);
    bySlug.forEach((list) => list.sort());
  });
  state.docPaths = seen;
  state.slugs = slugs;
  for (const p of [...state.docs.keys()]) if (!seen.has(p) && p !== state.active) state.docs.delete(p);
  renderTree();
  $("#vaultName").textContent = r.vault.name;
  $("#vaultSub").textContent =
    r.vault.root + " · " + r.vault.docCount + " docs" + (state.vaults.length > 1 ? " · " + state.vaults.length + " vaults" : "");
}

/** The descriptor for a vault id, or null. */
const vaultById = (id) => state.vaults.find((v) => v.id === id) || null;

/* ---------- drag/drop moves ----------

   The tree has one meaningful spatial drop: INTO a folder. A doc row therefore
   means its parent folder, a folder row means itself, and a vault row means that
   vault's root. There is deliberately no before/after drop — tree order comes
   from the filesystem and is not state the client can rearrange.

   A doc row and a FOLDER row are both drag sources: the server's move is one
   `rename(2)`, so a folder travels with everything under it. A vault row is a
   destination only — it is a repository, not an entry that can be somewhere
   else. */
let dragged = null;
/** The one pending hover-to-expand timer, and the row it is counting for. */
let dwell = null;

const basename = (path) => {
  const rel = relOf(path);
  return rel.slice(rel.lastIndexOf("/") + 1);
};

/** The destination rule both drops obey: a doc row means its parent folder, a
    folder row means itself, a vault row means that vault's root ("" for the
    primary, "@id" for a secondary). */
const dropFolder = (target, kind) => (kind === "doc" ? dirname(target) : target);

function dropPlan(source, target, kind) {
  const parent = dropFolder(target, kind);
  const id = vaultOf(parent);
  const prefix = vaultPrefix(id);
  const rel = relOf(parent);
  const to = prefix + (rel ? rel + "/" : "") + basename(source);
  return {
    to,
    sameVault: vaultOf(source) === id,
    /* Mirror of the server's descendant guard: a folder carries its subtree,
       so nothing inside it is a place it can go — its own row and its own docs
       included. Said here so the user hears it on hover instead of after a
       round trip that ends in a 400. */
    inside: parent === source || parent.indexOf(source + "/") === 0,
    useful: to !== source,
  };
}

/** The one sentence a blocked target owes the user, or null when it is fine. */
const refusalFor = (plan) =>
  !plan.sameVault ? "A move cannot cross vaults" : plan.inside ? "A folder cannot be moved inside itself" : null;

/** Drop the pending expand — for one row, or (no argument) for the whole drag. */
function clearDwell(row) {
  if (!dwell || (row && dwell.row !== row)) return;
  clearTimeout(dwell.timer);
  dwell = null;
}

function clearDropMarks() {
  clearDwell();
  $$("#tree .drop-target, #tree .drop-blocked, #tree .drag-source").forEach((row) =>
    row.classList.remove("drop-target", "drop-blocked", "drag-source")
  );
}

function wireDragSource(row, path, kind) {
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    dragged = { path, type: kind, refusal: null };
    let ghost = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", path);
      /* The automatic drag image is the row at sidebar width — the indent and
         the branch guides overlapping it come along. Snapshot a chip of icon +
         name instead. It must be in the document, painted, when the browser
         reads it, so it leaves on the next frame, not now. */
      ghost = el("div", "drag-ghost");
      ghost.appendChild(row.querySelector(".ico").cloneNode(true));
      ghost.appendChild(row.querySelector(".lbl").cloneNode(true));
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 14, 14);
    }
    /* One frame later: the snapshot is taken, and fading the source row can no
       longer bleed into it. */
    requestAnimationFrame(() => {
      if (ghost) ghost.remove();
      row.classList.add("drag-source");
    });
  });
  row.addEventListener("dragend", () => {
    /* Chromium does not dispatch `drop` when the active target advertises
       `dropEffect = none`. Keep dragend as the explanation fallback for a
       native-cancelled cross-vault release; a normal eligible drop clears the
       source first and therefore cannot toast twice. */
    const refusal = dragged && dragged.refusal;
    dragged = null;
    clearDropMarks();
    if (refusal) toast(refusal);
  });
}

function wireDropTarget(row, path, kind, kids) {
  /* Hovering a closed destination opens it, so a drag can reach children that
     were not on screen when it started. The expansion is the two class toggles
     the click handler does, WRITTEN IN PLACE: a `renderTree()` here would
     replace the element the pointer is over and Chromium cancels the drag with
     it — the same reason a sync frame repaints one dot instead of the tree. */
  const armDwell = () => {
    if (dwell && dwell.row === row) return;
    clearDwell();
    dwell = {
      row,
      timer: setTimeout(() => {
        dwell = null;
        if (kind === "vault") state.vaultOpen.set(row.dataset.vault, true);
        else state.folderOpen.set(path, true);
        row.classList.add("open");
        kids.classList.remove("closed");
      }, 600),
    };
  };
  const paint = (e) => {
    /* A drag from outside has no plan and no refusal: every row is a legal
       destination, and which of the dropped files it takes is decided on the
       drop, against the file itself. The hover mechanics stay the move's, so
       paint, dwell and dragleave are unchanged. */
    if (dragHasFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      row.classList.add("drop-target");
      if (kids && kids.classList.contains("closed")) armDwell();
      else clearDwell(row);
      return null;
    }
    if (!dragged) return null;
    const plan = dropPlan(dragged.path, path, kind);
    e.preventDefault();
    const refusal = refusalFor(plan);
    dragged.refusal = refusal;
    /* Keep a useful but refused target eligible for `drop`: that event is the
       only reliable place to explain the refusal. The red target styling is
       the invalid-state signal; the handler below still guarantees no PATCH. */
    if (e.dataTransfer) e.dataTransfer.dropEffect = plan.useful ? "move" : "none";
    row.classList.toggle("drop-target", !refusal && plan.useful);
    row.classList.toggle("drop-blocked", !!refusal || !plan.useful);
    if (!refusal && plan.useful && kids && kids.classList.contains("closed")) armDwell();
    else clearDwell(row);
    return plan;
  };
  row.addEventListener("dragenter", paint);
  row.addEventListener("dragover", paint);
  row.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    row.classList.remove("drop-target", "drop-blocked");
    /* Only this row's timer: the next target's `dragenter` has already armed
       its own by the time this fires. */
    clearDwell(row);
    if (dragged) dragged.refusal = null;
  });
  row.addEventListener("drop", (e) => {
    if (dragHasFiles(e)) {
      /* both, and in this order: preventDefault stops the browser navigating
         to the file, stopPropagation keeps the window-level swallow (app.js)
         off a drop this row has claimed */
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      const dt = e.dataTransfer;
      uploadFiles([...dt.files], directoryFlags(dt), dropFolder(path, kind)).catch((err) => apiFail(err, "Upload failed"));
      return;
    }
    const source = dragged;
    const plan = source && paint(e);
    dragged = null;
    clearDropMarks();
    if (!source || !plan) return;
    e.stopPropagation();
    const refusal = refusalFor(plan);
    if (refusal) {
      toast(refusal);
      return;
    }
    if (!plan.useful) return;
    moveEntry({ path: source.path, type: source.type === "folder" ? "folder" : "file" }, plan.to);
  });
}

/* ---------- drop to upload (ADR 0030) ----------

   There is no upload route. A dropped file is `POST /api/docs` carrying its
   text, so every refusal below is the CLIENT deciding not to send: the
   accepted-extension list, the body cap, the UTF-8 check. The refusals left
   over, a duplicate name or a name the server will not mint, come back from
   the server and are read out verbatim. What a doc IS stays ADR 0019's
   question, and the server still rules on it. */

/** The server's body cap, refused here so an oversized drop gets a sentence
    instead of a raw 413. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** `webkitGetAsEntry()` answers only while the drop event is being dispatched,
    because Chromium empties the drag data store the moment the handler
    returns. So the flags are read here, before the upload loop's first await. */
const directoryFlags = (dt) => [...(dt.items || [])].map((it) => !!it.webkitGetAsEntry?.()?.isDirectory);

/** What the toast calls the destination: a folder by its path, a vault's root
    by the vault's name. The server's label carries a sync status ("Notes
    (unsynced)") that would read here as a warning about the upload. */
function folderLabel(folder) {
  const rel = relOf(folder);
  if (rel) return rel;
  const v = vaultById(vaultOf(folder));
  return ((v && v.label) || "the vault").replace(/ \(unsynced\)$/, "");
}

/**
 * Every file in one drop, in the order it was dropped, into `folder`.
 *
 * `dirs[i]` is the answer `directoryFlags` already took for `files[i]`, which
 * cannot be asked for here, one `await` too late. The loop is serial because
 * each create is a write plus a reconcile pass under the same lock. One file
 * being refused never stops the next, so reasons are collected and reported
 * once at the end.
 */
async function uploadFiles(files, dirs, folder) {
  if (!files.length) return;
  /* the server heals the setting to exactly this spelling on read and on PUT
     (`normalizeExtensions`, settings.ts), so the client only splits */
  const accepted = new Set(state.settings.upload.extensions.split(", ").filter(Boolean));
  const wrongType = accepted.size
    ? "only " + [...accepted].join(", ") + " can be uploaded"
    : "no file type is accepted for upload";
  const tooLarge = "too large to send, the limit is " + MAX_UPLOAD_BYTES / (1024 * 1024) + " MiB";
  const made = [];
  const refused = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = file.name;
    if (dirs[i]) {
      refused.push(name + ": folders cannot be uploaded");
      continue;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!accepted.has(ext)) {
      refused.push(name + ": " + wrongType);
      continue;
    }
    /* `fatal` is the whole check: a doc is UTF-8 text (ADR 0019), and a lossy
       decode would write mojibake to disk and call it a note. `ignoreBOM`
       keeps a leading U+FEFF as text, because the promise is the bytes the
       file had. */
    let markdown;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    } catch (err) {
      refused.push(name + ": not UTF-8 text");
      continue;
    }
    const path = folder ? folder + "/" + name : name;
    const payload = { path, type: "doc", markdown };
    /* The cap is on the REQUEST, and `markdown` travels inside it as a JSON
       string, where a newline or a quote costs two bytes and another control
       character costs six. A 6 MiB log of short CRLF lines is a 12 MiB
       request, so the gate weighs what is actually sent. */
    if (new Blob([JSON.stringify(payload)]).size > MAX_UPLOAD_BYTES) {
      refused.push(name + ": " + tooLarge);
      continue;
    }
    try {
      await api.createEntry(payload);
    } catch (err) {
      refused.push(name + ": " + ((err && err.message) || "could not be created"));
      continue;
    }
    /* the same timeline entry an inline create makes, so ⌘Z asks before
       deleting it exactly as it does there (ADR 0014) */
    rememberFileOp({ kind: "create", path, type: "doc", markdown });
    made.push(path);
  }
  if (made.length) {
    revealFolder(folder);
    await loadTree();
  }
  const lines = made.length
    ? ["Uploaded " + made.length + " file" + (made.length === 1 ? "" : "s") + " to " + folderLabel(folder)]
    : [];
  lines.push(...refused);
  /* sticky only when something was refused: a refusal the user blinks past is
     a file they will believe arrived */
  toast(lines.join(" · "), refused.length ? { sticky: true } : undefined);
  if (made.length === 1) await openDoc(made[0]);
}

/**
 * A `sync-status` frame named a vault: keep its descriptor current and repaint
 * that one row's dot WHERE IT IS. A full `renderTree()` per frame would tear
 * down the inline create/rename row and the focused row with it, several times
 * a sync — and nothing about a dot needs the tree rebuilt.
 */
export function adoptVaultSync(s) {
  const v = vaultById((s && s.vault) || "vault");
  if (!v) return;
  v.sync = s;
  /* `offline` is published exactly when the directory is not a repository —
     which is the same question "does this row carry a dot at all" asks */
  v.repo = s.state !== "offline";
  const row = $('#tree .row.vault[data-vault="' + v.id + '"]');
  if (!row) return;
  const had = $(".dot", row);
  if (!v.repo) {
    if (had) had.remove();
    return;
  }
  const dot = had || row.appendChild(el("span", "dot"));
  dot.className = "dot " + syncDotClass(s);
  dot.title = s.message || "";
}

export function renderTree() {
  const host = $("#tree");
  /* An armed hover-expand holds the row and children box it counted for, and
     the rebuild below detaches both. Chromium ends the drag with the detached
     source, but the timer would still fire: class toggles on orphaned nodes,
     plus a `folderOpen` write for a row that now renders closed — leaving the
     next click on that folder a visible no-op. */
  clearDwell();
  /* WHICH ROW HAD THE KEYBOARD, so the rebuild below can give it back.
     `renderTree` replaces every row, and it runs for reasons the user did not
     ask for — a `doc-changed` from another device, a sync landing, a vault
     appearing. Without this, focus falls to <body> mid-keystroke and the next
     ⏎/F2/Del/Menu press goes nowhere: the tree's whole keyboard surface
     silently stops working until something is clicked. */
  const had = document.activeElement;
  const hadRow = had && had.closest ? had.closest("#tree .row[data-path]") : null;
  const refocus = hadRow ? { path: hadRow.dataset.path, kind: hadRow.dataset.kind } : null;
  host.innerHTML = "";
  /* create/rename mount points, keyed by the folder they belong to — and a
     vault's ROOT is a key like any other ("" for the primary, "@id" else) */
  const slots = new Map();

  /* Rename / delete affordances. They live BESIDE the row, never inside it:
     `.row` is a <button> and a button inside a button is not a thing. Both are
     tabindex=-1 — the row itself is the tab stop, and ⏎ / F2 / Delete on the
     focused row do the same two jobs from the keyboard. */
  const rowActs = (path, kind, name) => {
    const box = el("span", "rowacts");
    const mk = (title, svg, fn) => {
      const b = el("button", "rowact", svg);
      b.type = "button";
      b.tabIndex = -1;
      b.title = title;
      b.setAttribute("aria-label", title + " " + name);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      return b;
    };
    box.appendChild(mk("Rename or move", I.pencil, () => startRename(path, kind)));
    box.appendChild(mk("Delete", I.trash, () => askDelete(path, kind)));
    return box;
  };

  /* Double-click renames — the pointer twin of ⏎ on a focused row, and the
     gesture every file manager has trained into the hand.

     Both underlying clicks still land, deliberately. A doc therefore OPENS and
     then goes into rename, which is the right way round: the rename row names
     a doc you can now see. A folder toggles twice and would land back where it
     started, except `startRename` reveals its own ancestors — so a closed
     folder ends up open, showing what is about to be moved with it. Neither is
     a race with the rename row: `renderTree` mounts that row from
     `state.renaming`, so whichever repaint lands last still draws it. */
  const renameOnDouble = (row, path, kind) =>
    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      startRename(path, kind);
    });

  const node = (n, depth, parent) => {
    if (state.renaming && state.renaming.path === n.path) {
      parent.appendChild(renameRow(n, depth));
      if (n.type === "folder") {
        // keep the subtree mounted so a rename does not collapse the tree
        const kids = el("div", "children");
        kids.style.setProperty("--guide-x", guideX(depth));
        kids.style.setProperty("--pass-x", guideX(depth - 1));
        slots.set(n.path, { box: kids, depth: depth + 1 });
        parent.appendChild(kids);
        n.children.forEach((c) => node(c, depth + 1, kids));
      }
      return;
    }
    if (n.type === "folder") {
      const open = state.folderOpen.get(n.path) !== false;
      const wrap = el("div", "rowwrap");
      /* full/bare drives the icon's fill: a folder with anything inside reads
         filled, an empty one reads as a gray well */
      const row = el("button", "row folder" + (open ? " open" : "") + (n.children && n.children.length ? " full" : " bare"));
      row.style.paddingLeft = rowPad(depth) + "px";
      /* what the context menu reads off whatever was right-clicked. Uniform
         across both row kinds — `data-doc` stays on files because that is the
         selector the doc-open path and the tests already use. */
      row.dataset.path = n.path;
      row.dataset.kind = "folder";
      /* no chevron: disclosure reads from the text (`.open` lights the label)
         and from the branch guides, the way `tree(1)` output does */
      row.innerHTML = '<span class="ico">' + I.folder + '</span><span class="lbl">' + esc(n.name) + "</span>";
      const kids = el("div", "children" + (open ? "" : " closed"));
      kids.style.setProperty("--guide-x", guideX(depth));
      kids.style.setProperty("--pass-x", guideX(depth - 1));
      slots.set(n.path, { box: kids, depth: depth + 1 });
      row.addEventListener("click", () => {
        state.pick = { path: n.path, kind: "folder" };
        const now = !(state.folderOpen.get(n.path) !== false);
        state.folderOpen.set(n.path, now);
        row.classList.toggle("open", now);
        kids.classList.toggle("closed", !now);
      });
      row.addEventListener("focus", () => (state.pick = { path: n.path, kind: "folder" }));
      row.addEventListener("keydown", (e) => rowKeys(e, n.path, "folder"));
      renameOnDouble(row, n.path, "folder");
      wireDragSource(row, n.path, "folder");
      wireDropTarget(row, n.path, "folder", kids);
      wrap.appendChild(row);
      wrap.appendChild(rowActs(n.path, "folder", n.name));
      parent.appendChild(wrap);
      parent.appendChild(kids);
      n.children.forEach((c) => node(c, depth + 1, kids));
    } else {
      const wrap = el("div", "rowwrap");
      const row = el("button", "row file" + (n.empty ? " inert" : "") + (state.active === n.path ? " active" : ""));
      row.style.paddingLeft = rowPad(depth) + "px";
      row.dataset.doc = n.path;
      row.dataset.path = n.path;
      row.dataset.kind = "doc";
      row.innerHTML =
        '<span class="ico">' +
        (n.hasSecrets ? I.key : I.file) +
        '</span><span class="lbl">' +
        esc(n.name) +
        '</span><span class="dot"></span>';
      row.addEventListener("click", () => openDoc(n.path));
      row.addEventListener("focus", () => (state.pick = { path: n.path, kind: "doc" }));
      row.addEventListener("keydown", (e) => rowKeys(e, n.path, "doc"));
      renameOnDouble(row, n.path, "doc");
      wireDragSource(row, n.path, "doc");
      /* Dropping ON a doc means its parent folder; rows are never reordered. */
      wireDropTarget(row, n.path, "doc", null);
      wrap.appendChild(row);
      wrap.appendChild(rowActs(n.path, "doc", n.name));
      parent.appendChild(wrap);
    }
  };
  /* THE VAULT ROWS. Expanded by default, no rename and no delete — a vault is
     not a folder you can move, and disconnecting one lives in Settings where
     the sentence about the directory staying on disk fits. Its children are its
     own tree, one step in. */
  state.vaults.forEach((v) => {
    const open = state.vaultOpen.get(v.id) !== false;
    const rootKey = vaultRootKey(v.id);
    const wrap = el("div", "rowwrap");
    const row = el("button", "row vault" + (open ? " open" : ""));
    row.style.paddingLeft = rowPad(0) + "px";
    row.dataset.path = rootKey;
    row.dataset.kind = "vault";
    row.dataset.vault = v.id;
    row.innerHTML =
      '<span class="ico">' +
      I.vault +
      '</span><span class="lbl">' +
      esc(v.label) +
      "</span>" +
      (v.repo ? '<span class="dot ' + syncDotClass(v.sync) + '" title="' + esc((v.sync && v.sync.message) || "") + '"></span>' : "");
    const kids = el("div", "children" + (open ? "" : " closed"));
    kids.style.setProperty("--guide-x", guideX(0));
    slots.set(rootKey, { box: kids, depth: 1 });
    /* the vault root is a FOLDER as far as context goes — `createParent` and
       `treeHas` both already speak that language, and a third kind of pick
       would only be a third thing they had to learn */
    const pickRoot = () => (state.pick = { path: rootKey, kind: "folder" });
    row.addEventListener("click", () => {
      pickRoot();
      const now = !(state.vaultOpen.get(v.id) !== false);
      state.vaultOpen.set(v.id, now);
      row.classList.toggle("open", now);
      kids.classList.toggle("closed", !now);
    });
    row.addEventListener("focus", pickRoot);
    wireDropTarget(row, rootKey, "vault", kids);
    wrap.appendChild(row);
    host.appendChild(wrap);
    host.appendChild(kids);
    (v.tree || []).forEach((n) => node(n, 1, kids));
  });

  if (state.creating) {
    const c = state.creating;
    const folder = c.kind === "folder";
    const slot = slots.get(c.parent) || slots.get("") || { box: host, depth: 0 };
    slot.box.appendChild(
      inlineRow({
        depth: slot.depth,
        folder: folder,
        value: c.value || "",
        busy: !!c.busy,
        placeholder: "name",
        label: (folder ? "New folder" : "New doc") + " in " + (c.parent || "the vault root"),
        /* The row explains NOTHING. There is no narration of the path grammar,
           no echo of the path that will be made: the field is a field. The
           second line exists only when the create is REFUSED — a bad path, or
           the server's 409 — which is the one thing the user cannot see for
           themselves, and the reason the row holds itself open. */
        error: c.error || undefined,
        onInput: (v) => {
          c.value = v;
          /* a refusal describes the value that produced it; the moment the
             value changes it is stale, so the line goes rather than lingering */
          c.error = null;
        },
        onCommit: (v) => {
          c.value = v;
          if (!v) return false;
          const plan = parseCreate(v, c.kind, c.parent);
          if (!plan.ok) {
            c.error = plan.error;
            renderTree();
            return "hold";
          }
          commitCreate(plan);
          return "hold";
        },
        onCancel: () => {
          state.creating = null;
          renderTree();
        },
      })
    );
  }

  /* ├ vs └ — marked once the boxes are fully built (create row included): the
     LAST row in each box ends its line slice at its own tick, and an open
     subtree hanging below it draws no continuation at that depth. */
  $$(".children", host).forEach((box) => {
    const kids = [...box.children];
    let last = -1;
    kids.forEach((elm, i) => {
      if (elm.classList.contains("rowwrap") || elm.classList.contains("newwrap")) last = i;
    });
    if (last < 0) return;
    kids[last].classList.add("t-end");
    for (let i = last + 1; i < kids.length; i++) kids[i].classList.add("t-off");
  });

  /* …and hand the keyboard back to the row that had it. Only when the teardown
     above is what took it (focus is on <body> now) and the row is still in the
     tree — never steal it from an inline editor, a dialog, or wherever the user
     has since moved. `focusQuiet` keeps the scroll position. */
  if (refocus && (!document.activeElement || document.activeElement === document.body)) {
    const back = $(`#tree .row[data-kind="${refocus.kind}"][data-path="${CSS.escape(refocus.path)}"]`);
    if (back) focusQuiet(back);
  }
}

/* ============================================================
   CREATION — context, path grammar, refusal

   THE CONTEXT. ⌥N (doc) and ⌥⇧N (folder) create RELATIVE to whatever the user
   is looking at, because "new" without a place is a guess the user then has to
   undo with a move:

     · a folder row clicked or focused in the sidebar → inside that folder
     · a doc row clicked or focused, or simply the open doc → its parent folder
     · nothing picked and nothing open → the vault root

   Both gestures resolve it the same way. A folder that is the context is
   revealed (every ancestor opened) before the inline row mounts, so the input
   is never created inside a collapsed subtree where nothing can be typed.

   THE GRAMMAR, in the create input:

     abc            → abc.md            (a doc; `.md` is appended)
     abc.md         → abc.md            (already a doc)
     a/b/c.md       → folders a, a/b, then the doc a/b/c.md
     abc/           → the FOLDER abc    (trailing slash, in either mode)
     a/b/           → folders a and a/b
     /a/b.md        → from the VAULT ROOT rather than the context

   Why a bare name gets `.md`: a doc IS a `.md` file here — the server
   refuses any other extension on a move, and `[[links]]` resolve on the `.md`
   slug — so `notes` can only mean `notes.md`, and making the user type an
   extension the app cannot vary is ceremony. The TRAILING SLASH is what
   distinguishes the two kinds, which is the same convention every shell and
   every file dialog already uses, and it is the only override: it turns the doc
   row into a folder create, and it is a no-op on the folder row.

   Everything below is a MIRROR of a server rule, never a substitute for one:
   the same refusals are enforced in POST /api/docs, and the 409 the server
   answers is surfaced verbatim in the row's error line rather than swallowed.
   ============================================================ */

/** Is this path still in the tree, as this kind? Every vault's ROOT counts as
    an existing folder — it is where a create with no other context lands. */
function treeHas(path, kind) {
  if (kind === "doc") return state.docPaths.has(path);
  const v = vaultById(vaultOf(path));
  if (!v) return false;
  if (!relOf(path)) return true;
  let found = false;
  const walk = (nodes) =>
    nodes.forEach((n) => {
      if (n.type !== "folder") return;
      if (n.path === path) found = true;
      else walk(n.children || []);
    });
  walk(v.tree || []);
  return found;
}

/** The folder a context-free create lands in. */
function createParent() {
  const p = state.pick;
  if (p && treeHas(p.path, p.kind)) return p.kind === "folder" ? p.path : dirname(p.path);
  if (state.active && state.docPaths.has(state.active)) return dirname(state.active);
  return "";
}

/**
 * Open `path`, every folder above it AND the vault row over all of them, so a
 * row mounted there is visible. Returns whether anything that was explicitly
 * CLOSED got opened — the only reason a repaint is owed, which is all
 * `revealInTree` wanted from its own copy of this walk.
 *
 * The write stays unconditional even when nothing changed: `commitCreate` pins
 * a brand-new folder open BEFORE `loadTree`, and `indexTree` only seeds a key
 * it does not already have, so an absent key would come back closed from the
 * server.
 */
export function revealFolder(path) {
  const id = vaultOf(path);
  const prefix = vaultPrefix(id);
  let changed = state.vaultOpen.get(id) === false;
  state.vaultOpen.set(id, true);
  let acc = "";
  for (const s of relOf(path).split("/").filter(Boolean)) {
    acc = acc ? acc + "/" + s : s;
    if (state.folderOpen.get(prefix + acc) === false) changed = true;
    state.folderOpen.set(prefix + acc, true);
  }
  return changed;
}

/**
 * Parse the create input into a plan, or a refusal.
 *
 * Returns `{ ok, kind, path, error }`. Every refusal here is a MIRROR of a
 * server rule, caught before the round trip so the row can hold itself open
 * and say why; the server remains the authority.
 *
 * The parent's VAULT comes off first and goes back on last: the grammar inside
 * a vault is the grammar it always was, and the leading-`/` "from the root"
 * rule anchors at the root of the vault you are creating in — never at the
 * primary's. A create cannot address another vault, because a typed `@` is
 * refused for the same reason the server refuses it.
 */
function parseCreate(input, mode, parent) {
  const no = (error) => ({ ok: false, error });
  let raw = String(input == null ? "" : input).trim();
  if (!raw) return no("Type a name.");
  if (raw.includes("\\")) return no('A path uses "/" — "\\" is not a separator here.');
  if (raw.includes("\0")) return no("A name cannot contain a null byte.");
  /* mirror of the server's move guard (server/index.ts linkSafeTarget): a name
     carrying "]" or a line break cannot survive the [[link]] a later rename
     would splice it into, and the damage lands in OTHER people's docs */
  if (/[\]\r\n]/.test(raw)) return no('A name cannot contain "]" — a [[link]] pointing at it would not survive.');

  const fromRoot = raw.startsWith("/");
  const folder = raw.endsWith("/") || mode === "folder";
  const segs = raw.split("/").filter((s) => s !== "");
  if (!segs.length) return no(fromRoot ? "Name something under the vault root." : "Type a name.");
  for (const s of segs) {
    if (s === "." || s === "..") return no('"." and ".." are not names — the path may not leave the vault.');
    /* safePath() rejects a dot-prefixed segment outright: it would be invisible
       to the scanner, so the file would exist and never appear in any tree */
    if (s.startsWith(".")) return no("A name cannot start with “.” — dot-files are invisible to the vault index.");
    /* the address grammar's one reserved character: `@x/` is how a path names
       another VAULT, so it can never also be a name inside one */
    if (s.startsWith("@")) return no("A name cannot start with “@” — that prefix addresses a vault.");
    if (s.trim() !== s) return no("A name cannot start or end with a space.");
  }

  const prefix = vaultPrefix(vaultOf(parent));
  const base = fromRoot ? "" : relOf(parent);
  if (!folder) {
    const leaf = segs[segs.length - 1];
    segs[segs.length - 1] = withDefaultExtension(leaf);
  }
  const path = prefix + (base ? base + "/" : "") + segs.join("/");

  /* Every folder this create would have to make on the way, checked against
     the tree so an intermediate segment that is already a DOC is refused here
     rather than as an ENOTDIR out of mkdir(2). */
  const depth = folder ? segs.length : segs.length - 1;
  let acc = base;
  for (let i = 0; i < depth; i++) {
    acc = acc ? acc + "/" + segs[i] : segs[i];
    if (state.docPaths.has(prefix + acc)) return no(prefix + acc + " is a doc, not a folder.");
  }
  if (folder) {
    if (state.docPaths.has(path)) return no(path + " is a doc, not a folder.");
  } else if (treeHas(path, "folder")) {
    return no(path + " is a folder, not a doc.");
  }
  return { ok: true, kind: folder ? "folder" : "doc", path };
}

/**
 * The inline tree-row editor — ONE widget, used for create and for rename.
 *
 * The chrome and the keys are a single idiom by construction rather than by
 * comment: the `.newrow` box, the depth indent, the icon, the four attributes
 * that keep password managers out of a filename field, Enter commits, Esc
 * cancels (and says so), blur cancels on a 90ms delay so a click on the row's
 * own chrome does not eat the edit, and the 20ms focus the browser needs after
 * the tree has been rebuilt.
 *
 * `onCommit` returns false to DECLINE — create uses it for an empty name, which
 * must fall through to cancel rather than latch and leave the row stuck open.
 * It returns `"hold"` to keep the row OPEN and unsettled: the create flow uses
 * that for a refusal it wants to explain in place (a duplicate, a bad path, the
 * server's 409) instead of closing the row and throwing the typing away.
 *
 * `error` mounts a second line under the input, and only ever carries a
 * REFUSAL — there is no explanatory hint here and no narration of what a name
 * will become. The line is mounted by a refusal and UNMOUNTED by the next
 * keystroke, so a row that is not carrying one has no second line at all rather
 * than an emptied one at zero height. `busy` disables the field while a create
 * is in flight.
 */
function inlineRow(o) {
  const wrap = el("div", "newwrap");
  const row = el("div", "newrow" + (o.renaming ? " renaming" : ""));
  row.style.paddingLeft = rowPad(o.depth) + "px";
  /* the same two icon boxes an ordinary row carries, so the field starts where
     the label it is replacing started */
  row.innerHTML = '<span class="ico">' + (o.folder ? I.folder : I.file) + "</span>";
  const inp = el("input");
  if (o.value) inp.value = o.value;
  if (o.placeholder) inp.placeholder = o.placeholder;
  if (o.title) inp.title = o.title;
  inp.setAttribute("aria-label", o.label);
  inp.spellcheck = false;
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("data-1p-ignore", "");
  inp.name = "";
  if (o.busy) inp.disabled = true;
  let note = null;
  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    o.onCancel();
  };
  const commit = () => {
    if (settled) return;
    /* latch only once the commit is ACCEPTED, so a declined one can still
       cancel and a held one can still be corrected in place */
    const r = o.onCommit(inp.value.trim());
    if (r === false) return cancel();
    if (r === "hold") return;
    settled = true;
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      toast("Cancelled");
    }
  });
  if (o.onInput)
    inp.addEventListener("input", () => {
      o.onInput(inp.value.trim());
      /* the refusal described the value that produced it, so the first
         keystroke retires the LINE, not merely its text */
      if (note) {
        note.remove();
        note = null;
      }
    });
  /* Blur cancels — but only a blur that STUCK. The 90ms delay was already
     there so a click on the row's own chrome does not eat the edit; a
     right-click is the same shape (Chrome blurs the field on mousedown before
     `contextmenu` fires, and the sidebar handler puts focus straight back), so
     a field that has the caret again 90ms later is a field the user is still
     typing in. */
  inp.addEventListener("blur", () =>
    setTimeout(() => {
      if (document.activeElement === inp) return;
      /* A row that is no longer in the document was REPLACED by a re-render
         (an SSE doc-changed, or the create flow repainting its own error), not
         dismissed by the user. Cancelling on that blur is how a half-typed
         name used to vanish whenever anything else touched the vault. */
      if (!wrap.isConnected) return;
      cancel();
    }, 90)
  );
  row.appendChild(inp);
  wrap.appendChild(row);
  /* mounted only when there IS a refusal to show — an empty create row carries
     no second line at all, which is what "no helper text" means structurally */
  if (o.error !== undefined) {
    note = el("div", "newhint");
    /* under the FIELD, not under the row: the two icon boxes and their gaps */
    note.style.paddingLeft = rowPad(o.depth) + 38 + "px";
    note.textContent = o.error;
    wrap.appendChild(note);
  }
  setTimeout(() => {
    if (o.busy) return;
    inp.focus();
    if (o.select) o.select(inp);
    /* a preserved value (a refusal being corrected) keeps the caret at the end
       rather than selecting everything the user just typed */
    else if (inp.value) try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
  }, 20);
  return wrap;
}

/**
 * Open the inline create row.
 *
 * `where` names the folder to create INSIDE, and is how the sidebar context
 * menu puts the new item in the right place — right-click a folder and it is
 * that folder, right-click empty space and it is `""`, the vault root.
 *
 * Left undefined (⌥N, ⌥⇧N, the footer buttons) the context is `createParent()`
 * — the picked folder, else the picked-or-open doc's folder, else the root —
 * and it is the SAME context for both kinds. The old rule gave a new folder to
 * the vault root unconditionally, which meant ⌥⇧N inside a project could not
 * make a subfolder without a follow-up move.
 *
 * Deliberately the same entry point either way — `renderTree()` mounts ONE
 * `inlineRow` from `state.creating` and `commitCreate` is the only writer, so
 * the menu adds a way IN to the create flow rather than a second create flow.
 */
export function startCreate(kind, where) {
  state.renaming = null; // one inline editor in the tree at a time
  const parent = where != null ? where : createParent();
  /* every ancestor, not just the parent: the row mounts inside the parent's
     `.children` box, and any closed folder ABOVE it hides the input entirely */
  revealFolder(parent);
  state.creating = { kind, parent, value: "", error: null, busy: false };
  /* the inline editor mounts in the TREE, so wherever the tree is off-canvas
     (phone AND tablet — see W_DOCK) the drawer has to come out with it */
  if (isDrawer()) openNav();
  app.classList.remove("sidebar-collapsed");
  renderTree();
  /* a create deep in a long tree must not open below the fold */
  setTimeout(() => {
    const inp = $("#tree .newrow input");
    if (inp) try { inp.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }, 30);
}

/**
 * The one create transaction: create, record it on the timeline (ADR 0014),
 * open the folder it landed in, reload the tree. The inline row, a broken
 * `[[link]]` and a tool call all come through here and keep their own chrome:
 * the row answers a refusal in its error line, a tool answers with data, and
 * neither wants the other's toast. `open` opens a new doc in Raw, which every
 * human create route does.
 */
export async function mintEntry({ path, kind, markdown }, { open } = {}) {
  const type = kind === "folder" ? "folder" : "doc";
  const text = type === "folder" ? "" : String(markdown == null ? "" : markdown);
  const r = await api.createEntry({ path, type, markdown: text });
  rememberFileOp({ kind: "create", path, type, markdown: text });
  /* the intermediate folders were made server-side; open them here so the new
     entry is visible in the tree rather than buried in a collapsed subtree */
  revealFolder(type === "folder" ? path : dirname(path));
  await loadTree();
  if (open && type === "doc") {
    await openDoc(path);
    setMode("raw", { silent: true, caret: 0 });
  }
  return r;
}

/**
 * Do the create the parsed plan describes.
 *
 * The row stays OPEN and mounted for the whole round trip and is only retired
 * by success: a refusal — a duplicate the client did not predict, a path the
 * server reads differently, anything at all — comes back into the row's
 * error line with the typed path still in the field. The server's `409 exists` is the
 * authority on duplicates and is surfaced verbatim rather than swallowed into a
 * toast that opened the OTHER doc instead (which is what the old flow did, and
 * it read exactly like a create that had silently succeeded).
 */
async function commitCreate(plan) {
  const c = state.creating;
  if (!c) return;
  c.busy = true;
  c.error = null;
  renderTree();
  try {
    await mintEntry({ path: plan.path, kind: plan.kind }, { open: plan.kind !== "folder" });
  } catch (err) {
    if (state.creating !== c) return;
    c.busy = false;
    c.error =
      err && err.code === "exists"
        ? (err.message || plan.path + " already exists.") + " Pick another name."
        : (err && err.message) || "Could not create " + plan.path;
    renderTree();
    return;
  }
  /* retired AFTER the mint, not before it: the busy row is what the user looks
     at for the whole round trip, and `inlineRow` declines the caret while it is
     disabled, so the tree reload inside `mintEntry` redraws it without taking
     focus back off the doc that just opened */
  state.creating = null;
  if (plan.kind === "folder") {
    state.pick = { path: plan.path, kind: "folder" };
    renderTree();
    toast("Folder " + plan.path + " created");
    return;
  }
  renderTree();
  toast("Created " + plan.path);
}

/**
 * The broken-link create affordance. A `[[link]]` that resolves to
 * nothing renders flagged; clicking it makes the doc AT THE IMPLIED PATH and
 * opens it.
 *
 * "Implied" is literal for a qualified link (`[[notes/ideas]]` → `notes/ideas.md`)
 * and, for a bare slug, is the folder of the doc the link was written in —
 * the same default the inline "New doc" flow uses, and the one that keeps the
 * new doc where the author was already working.
 *
 * Always in the ACTIVE DOC'S VAULT, both forms: the link resolver would not
 * have looked anywhere else, so creating the doc it was looking for anywhere
 * else would leave the link just as broken.
 */
export async function createFromLink(name) {
  const t = normTarget(name);
  if (!t) return;
  const prefix = vaultPrefix(vaultOf(state.active || ""));
  const here = relOf(dirname(state.active || ""));
  const path = prefix + withDefaultExtension(t.indexOf("/") >= 0 ? t : (here ? here + "/" : "") + t);
  try {
    await mintEntry({ path, kind: "doc", markdown: "# " + t.split("/").pop() + "\n\n" }, { open: true });
    toast("Created " + path);
  } catch (err) {
    if (err && err.code === "exists") {
      await loadTree().catch(() => {});
      openDoc(path);
      return;
    }
    apiFail(err, "Could not create " + path);
  }
}

/* ============================================================
   RENAME / MOVE / DELETE — IDE parity from the sidebar

   ONE inline control does rename AND move: the row turns into a
   text input carrying the doc's full vault-relative path, with the basename
   preselected. Type over the selection and it is a rename; edit the folder part
   and it is a move; both are the same `PATCH {to}` and the same one commit.

   Drag/drop is the pointer shortcut for the subset it can express — moving an
   existing doc into an existing folder. This inline path stays the keyboard
   route and the only route that can also rename or create a destination path.

   The chrome and the keys are the inline-CREATE idiom, unchanged: same `.newrow`
   input, Enter commits, Esc cancels, blur cancels.
   ============================================================ */

function rowKeys(e, path, kind) {
  /* ⏎ RENAMES. It does not open — SPACE opens now, and nothing was lost.
     A `.row` is a <button>, so Enter and Space were the same gesture (both
     synthesise a click) and one of the two was spare. Enter is the one every
     file manager spends on rename, and spending it here is what puts the
     tree's most-used file op on the home row instead of on F2, which no
     laptop keyboard reaches without a modifier.

     `preventDefault` is load-bearing, not decoration: a <button>'s Enter
     activation is the DEFAULT ACTION of this very keydown, so without it the
     click still fires and the doc opens behind the rename row that just
     mounted. Space is left alone and keeps the native activation. */
  if (e.key === "Enter" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    startRename(path, kind);
  } else if (e.key === "F2") {
    e.preventDefault();
    startRename(path, kind);
  } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    askDelete(path, kind);
  }
}

export function startRename(path, kind) {
  state.creating = null;
  state.renaming = { path, kind };
  /* A rename started from the row menu may name an item inside a folder whose
     disclosure state changed while the menu was open. Reveal every ancestor
     before mounting the sidebar's inline editor. */
  revealFolder(kind === "folder" ? path : dirname(path));
  if (isDrawer()) openNav();
  renderTree();
}

function renameRow(n, depth) {
  const isFolder = n.type === "folder";
  return inlineRow({
    depth: depth,
    folder: isFolder,
    renaming: true,
    value: n.path,
    label: (isFolder ? "Folder" : "Doc") + " path — rename or move " + n.path,
    /* never declines — commitRename owns the empty and unchanged cases, and it
       applies the same trim, so the value arrives here already in its form */
    onCommit: (v) => {
      commitRename(n, v);
    },
    onCancel: () => {
      state.renaming = null;
      renderTree();
    },
    select: (inp) => {
      /* preselect the NAME, not the path: the common case is a rename, and the
         folder prefix is there to be edited only when the intent is a move */
      const start = n.path.lastIndexOf("/") + 1;
      const end = isFolder ? n.path.length : n.path.replace(/\.md$/i, "").length;
      try {
        inp.setSelectionRange(start, Math.max(start, end));
      } catch (e) {}
    },
  });
}

/** Where a path inside a moved subtree ends up. */
const remap = (path, from, to) =>
  path === from ? to : path && path.indexOf(from + "/") === 0 ? to + path.slice(from.length) : path;

export async function commitRename(node, value) {
  const kind = node.type === "folder" ? "folder" : "doc";
  state.renaming = null;
  let to = String(value == null ? "" : value)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  /* A bare rename keeps the doc convention; an explicit extension is exactly
     what the user typed. In particular, never turn `report.txt` into
     `report.txt.md`, and never alter the basename a drag carried across. */
  if (kind === "doc" && to) {
    to = withDefaultExtension(to);
  }
  return moveEntry(node, to);
}

/** Move whatever is at `from`, for a caller that only has a path. The tree
    says whether it is a doc or a folder, so a path it does not know is a
    `not-found` here rather than a PATCH the server has to refuse. */
export async function moveByPath(from, to) {
  const at = treeLocate(from);
  if (!at) throw new api.ApiError(404, { error: "not-found", message: "No such doc or folder: " + from });
  return moveEntry(at.list[at.index], to);
}

/** The ONE client move transaction, shared by inline rename, drag/drop and the
    inverse/forward halves of history. `noRecord` is what makes applying history
    move the existing entry between stacks instead of recursively minting one. */
async function moveEntry(node, to, opts) {
  const kind = node.type === "folder" ? "folder" : "doc";
  const from = node.path;
  /* Latched HERE, before any await: the whole move is one operation, and the
     question at the end is "is the user still where they were when they asked
     for it?". Latching later would only notice navigations that started after
     the request came back — and a click made WHILE it was in flight is exactly
     the case that must win. */
  const ours = navGate();
  if (!to || to === from) {
    renderTree();
    return false;
  }
  /* Mirror of the server's own guard, so the user hears about it before the
     round trip: `]` and line breaks break out of the `[[…]]` a rewrite would
     splice this name into, and the damage lands in OTHER people's docs. */
  if (/[\]\r\n]/.test(to)) {
    renderTree();
    toast('A name cannot contain "]" — a [[link]] pointing at it would not survive');
    return false;
  }
  /* Mirror of the server's other move guard. A vault is a repository of its
     own — moving a doc out of one is a delete there and a create here, with
     two histories to match, and the field that spells the destination is not
     the place to start that. The server refuses it too. */
  if (vaultOf(to) !== vaultOf(from)) {
    renderTree();
    toast("A move cannot cross vaults");
    return false;
  }

  /* Anything still in the buffer has to reach disk first. Not only when the
     open doc is the one moving: the server rewrites [[links]] in the moved
     doc's REFERRERS, so an untouched-looking buffer can go stale under the
     rename too, and the save that noticed used to answer the 409 by throwing
     the user's typing away. */
  const activeMoves = state.active && remap(state.active, from, to) !== state.active;
  if (state.active && state.dirty) {
    const wrote = await saveDoc(state.active, { silent: true });
    if (!wrote) {
      renderTree();
      toast("Unsaved changes in " + state.active + " could not be written — the move was not started");
      return false;
    }
  }

  try {
    const r = await api.moveDoc(from, to);
    if (!(opts && opts.noRecord)) rememberFileOp({ kind: "move", from, to, type: kind });
    /* Re-home the pane only if this move still owns navigation. If the user
       clicked another doc while the request was in flight, or the SSE `moved`
       echo already followed the doc to its new path, that newer navigation owns
       the pane — stealing it back would drop the user somewhere they left, and
       clearing state.active underneath it would blank the doc they chose. */
    const follow = activeMoves && ours();
    const next = follow && state.active ? remap(state.active, from, to) : null;
    if (follow) {
      state.docs.delete(state.active);
      state.active = null;
    }
    await loadTree();
    if (follow && next && ours()) {
      const cached = state.docs.get(next);
      if (cached) cached.loaded = false;
      /* re-homing, not navigating: the doc under the user did not change, its
         name did. A new entry would make Back return to a path that is now a
         404 (ROUTING) — the URL has to follow the doc in place. */
      await openDoc(next, { replace: true });
    }
    const n = r && r.backlinksUpdated ? r.backlinksUpdated : 0;
    toast(
      (kind === "folder" ? "Moved " : "Renamed ") +
        from +
        " → " +
        to +
        (n ? " · " + n + " link" + (n === 1 ? "" : "s") + " rewritten" : "")
    );
    /* the PATCH response, not `true`: every caller here tests `!== false`, and
       what the move actually did — the canonical path, how many `[[link]]`s
       were rewritten — is worth carrying back to whoever asked for it */
    return r;
  } catch (err) {
    renderTree();
    if (err && err.code === "exists") {
      toast(to + " already exists");
      return false;
    }
    apiFail(err, "Could not move " + from);
    return false;
  }
}

/**
 * The delete confirmation: a HEADING, the path, and the footer. Nothing else.
 *
 * The two paragraphs that used to fill the body — how the delete reaches disk,
 * and what happens to the `[[link]]`s pointing here — were read once and
 * skimmed forever after. What survives is what the reader cannot reconstruct
 * from the button they are about to press:
 *
 *   · the SCOPE, folded into the heading, because "delete this folder" and
 *     "delete this folder and the 12 docs under it" are different acts and only
 *     one of them is written on the button;
 *   · the FOOTER, which is still FORKED on whether the trash is really there.
 *     `state.trash.available` is set by a GET that answered and by nothing
 *     else, so the app never promises a trash it has not seen — "in the trash
 *     for N days" and "recoverable only from git history" are the two honest
 *     answers and this line is the last one a user reads before Delete.
 *
 * The broken-link behaviour is unchanged: a rename rewrites
 * every `[[link]]` that resolved to the doc, a delete rewrites none, because
 * the broken link is the record that something used to be there. It is simply
 * no longer restated in front of every delete — the preview flags each one
 * where it actually is.
 */
function askDelete(path, kind) {
  const n = kind === "folder" ? [...state.docPaths].filter((p) => p.indexOf(path + "/") === 0).length : 0;
  const title =
    kind !== "folder"
      ? "Delete doc"
      : n === 0
      ? "Delete folder"
      : "Delete folder and " + n + " doc" + (n === 1 ? "" : "s");
  confirmDialog({
    title: title,
    path: path,
    body: "",
    ok: "Delete",
    note: state.trash.available ? trashRetentionNote() : "Recoverable only from git history.",
    onOk: () => doDelete(path, kind),
  });
}

/* ---------- what opens NEXT when the doc under you is deleted ----------

   "Something else" was the old answer: the alphabetically first doc in the
   vault, which from anywhere below the root meant being thrown to the top of
   an unrelated folder. The right answer is the one every file manager gives —
   the NEIGHBOUR — because a delete is a step through a list, not a departure
   from it.

   The walk, and why it is a walk and not a flat index:

     1. next sibling, in tree order. A folder sibling resolves to the FIRST doc
        inside it, since that is what "the next thing" means once you descend.
     2. no next sibling → the previous one, resolved to its LAST doc for the
        mirror-image reason.
     3. the folder is now empty → climb, and ask the same two questions of the
        parent among ITS siblings. A folder that just lost its only doc is not
        a place to stay.
     4. nothing above either → null, and the caller falls back to the vault.

   Computed BEFORE the DELETE goes out, against the tree that still has the doc
   in it: after `loadTree` the node is gone and with it the only record of where
   it sat. The result is re-checked against the reloaded `docPaths` afterwards,
   because the neighbour could have been removed by the same commit (a folder
   delete) or by another device in the meantime. */

/** Where `path` sits: the sibling list holding it, its index, and the folder
    that owns that list (the VAULT ROOT key — "" for the primary — at the top).
    Entered with no `nodes`, it searches every vault in order. */
function treeLocate(path, nodes, parent) {
  if (!nodes) {
    for (const v of state.vaults) {
      const hit = treeLocate(path, v.tree || [], vaultRootKey(v.id));
      if (hit) return hit;
    }
    return null;
  }
  const list = nodes;
  for (let i = 0; i < list.length; i++) {
    if (list[i].path === path) return { list, index: i, parent: parent || "" };
  }
  for (const n of list) {
    if (n.type !== "folder") continue;
    const hit = treeLocate(path, n.children || [], n.path);
    if (hit) return hit;
  }
  return null;
}

/** First doc at or under `n`, in tree order — null for an empty folder. */
function firstDocIn(n) {
  if (n.type !== "folder") return n.path;
  for (const c of n.children || []) {
    const p = firstDocIn(c);
    if (p) return p;
  }
  return null;
}

/** Last doc at or under `n`, in tree order — the mirror of `firstDocIn`. */
function lastDocIn(n) {
  if (n.type !== "folder") return n.path;
  const kids = n.children || [];
  for (let i = kids.length - 1; i >= 0; i--) {
    const p = lastDocIn(kids[i]);
    if (p) return p;
  }
  return null;
}

/** The doc to open when `path` leaves the tree, or null if the vault has none
    left anywhere near it. Never returns anything inside `path` itself. */
function neighbourDoc(path) {
  let cur = path;
  /* the climb is bounded by the depth of the tree; the guard is against a
     malformed tree (a folder listing itself), not against ordinary data */
  for (let hops = 0; cur && hops < 64; hops++) {
    const at = treeLocate(cur);
    if (!at) return null;
    for (let i = at.index + 1; i < at.list.length; i++) {
      const p = firstDocIn(at.list[i]);
      if (p) return p;
    }
    for (let i = at.index - 1; i >= 0; i--) {
      const p = lastDocIn(at.list[i]);
      if (p) return p;
    }
    /* "" at the primary root ends the loop; a secondary vault's root key names
       nothing in any tree, so the next lookup misses and the climb stops there
       — a delete in one vault never throws the user into another one */
    cur = at.parent;
  }
  return null;
}

/* ============================================================
   FILE-OPERATION UNDO (⌘Z / ⌘⇧Z outside a text surface)

   Raw and file operations share the app-owned timeline (ADR 0014). Outside a
   text surface — the tree, the preview pane, nothing focused — the next entry
   may be a FILE operation, and that is what ⌘Z should take back. A delete
   undoes to a restore; a create undoes to a delete; a move undoes through the
   same move transaction with its paths reversed.

   EVERY ONE OF THESE ASKS FIRST. That is not the usual undo contract, and it
   is deliberate: a text undo is instant and reversible in the same keystroke,
   whereas these move a file on disk, through git, on a path some other device
   may also be looking at. The chord is also one keystroke away from a chord
   people press reflexively in an editor — the cost of a mis-fired ⌘Z here is a
   doc that vanishes, and the cost of the prompt is one Return.

   THE STACK IS BOUNDED ON PURPOSE (`history.js`'s `MAX`). It covers a working
   session, and every file entry is a claim about the vault that a sync from
   another device can quietly invalidate. The trash drawer is the durable route
   back from deletes; this is the chronological shortcut.

   A DELETE IS NOT REMEMBERED BY ITS TRASH ID. The id is resolved at undo time,
   from the newest trash entry that names the path, because between the delete
   and the ⌘Z the entry may have been restored elsewhere, purged, or aged out —
   in which case the answer is "it is not in the trash any more", not a 404
   from a stale id. */
/** Record a completed file operation on the SHARED timeline — the same list
    the text edits go on, in the order they happened, which is what lets ⌘Z
    walk back through "edited a.md, edited b.md, deleted a.md" one step at a
    time. `flushTextRun` first, so a run that is still open is ordered BEFORE
    the file operation rather than after it. */
function rememberFileOp(entry) {
  flushTextRun();
  recordHistory(entry);
}

/** The newest trash entry naming `path`, or null. `state.trash.entries` is
    kept fresh by `trash-changed` and by the refresh every delete already does;
    this re-reads the server anyway, because the whole question is whether the
    entry is still there NOW. */
async function trashEntryFor(path) {
  let entries = [];
  try {
    entries = (await api.getTrash()).entries || [];
  } catch (_) {
    entries = state.trash.entries || [];
  }
  /* newest first per the contract, so the first match is the right one */
  return entries.find((e) => e.path === path) || null;
}

/** PUT IT BACK. The trash first, always: a file that was deleted still has its
    bytes there, and re-creating it from the empty string would be a different
    file wearing the same name. Only when the trash has no entry for it — never
    deleted, already restored elsewhere, purged, aged out — does this fall back
    to creating it, and then it uses whatever markdown the history captured. */
async function putFileBack(entry) {
  const found = await trashEntryFor(entry.path);
  if (found) {
    try {
      const r = await api.restoreTrash(found.id);
      const landed = (r && r.path) || entry.path;
      await loadTree();
      refreshTrash();
      if (state.docPaths.has(landed)) {
        revealInTree(landed);
        await openDoc(landed);
      }
      toast("Restored " + landed);
      return true;
    } catch (err) {
      /* The one error the trash panel renders in place rather than as a toast;
         here there is no row to render it on, so it is a toast that names the
         way out. */
      if (err && (err.status === 409 || err.code === "exists")) {
        toast(entry.path + " is taken — rename what is there, then restore it from the trash");
        return false;
      }
      apiFail(err, "Could not restore " + entry.path);
      return false;
    }
  }
  if (entry.type === "doc" && entry.markdown == null) {
    toast(entry.path + " is no longer in the trash — nothing to restore");
    return false;
  }
  try {
    await api.createEntry({ path: entry.path, type: entry.type, markdown: entry.markdown || "" });
  } catch (err) {
    apiFail(err, "Could not create " + entry.path);
    return false;
  }
  await loadTree();
  if (state.docPaths.has(entry.path)) {
    revealInTree(entry.path);
    await openDoc(entry.path);
  }
  toast("Created " + entry.path);
  return true;
}

/** TAKE IT AWAY, through the same `doDelete` a delete the user asked for by
    name goes through — so the active-buffer guard, the neighbour walk and the
    trash refresh all behave identically. `noRecord` keeps it off the stack: it
    IS the undo, and the opposite stack is what puts it back.

    The doc's text is captured first. It goes to the trash, so the bytes are
    not lost either way, but an entry that carries them can still put the file
    back after the trash has been emptied. */
function takeFileAway(entry, done) {
  if (entry.type === "doc") {
    const doc = state.docs.get(entry.path);
    if (doc && typeof doc.markdown === "string") entry.markdown = doc.markdown;
  }
  /* `onDone` rather than a returned boolean, because a dirty active buffer
     DEFERS the delete behind the Raw exit guard: `doDelete` returns false to
     say "not now", and the user may still choose Keep editing, in which case
     nothing happened and the undo must stay on offer. Only the callback can
     tell the difference between "refused" and "not yet". */
  doDelete(entry.path, entry.type, { noRecord: true, onDone: done });
}

/** The question each direction asks, and the verb it asks for. A restore is
    CONSTRUCTIVE — it wears the safe chrome, because the destructive pattern
    (red button, warning triangle, a footer about what is lost) over a button
    that puts a file back says the opposite of what the button does. */
function fileOpPrompt(entry, restoring) {
  const noun = entry.type === "folder" ? "folder" : "doc";
  if (entry.kind === "move") {
    return { title: "Move " + noun, ok: "Move", danger: false, note: "Links that point to it will follow." };
  }
  return restoring
    ? { title: "Restore " + noun, ok: "Restore", danger: false, note: "Put back where it was, with its contents." }
    : {
        title: "Delete " + noun,
        ok: "Delete",
        danger: true,
        note: state.trash.available ? trashRetentionNote() : "Recoverable only from git history.",
      };
}

/** What the dialog says is about to happen, in the user's terms rather than
    the timeline's. Four explicit sentences instead of one assembled from the
    entry's fields: an entry can be several steps back by the time it is
    reached, so the sentence has to name the ACT, not the moment. */
function fileOpBody(entry, undoing) {
  const noun = entry.type === "folder" ? "folder" : "doc";
  if (entry.kind === "move") {
    return undoing ? "Undo — move it back to " + entry.from + "." : "Redo — move it again to " + entry.to + ".";
  }
  return entry.kind === "delete"
    ? undoing
      ? "Undo — put back the " + noun + " you deleted."
      : "Redo — delete it again."
    : undoing
    ? "Undo — remove the " + noun + " you created."
    : "Redo — create it again.";
}

/**
 * The timeline's FILE half: put this operation's subject back, or take it away
 * again, having asked first.
 *
 * Asking is the whole difference from the text half, and it is deliberate. A
 * text undo is instant and reversible by the same keystroke; this moves a file
 * on disk, through git, on a path another device may be looking at — and the
 * chord is one keystroke from one people press reflexively in an editor. The
 * cost of a mis-fired ⌘Z here is a doc that vanishes; the cost of the prompt
 * is one Return.
 *
 * Resolves false on every way out that is not the deed done — Cancel, Esc, a
 * restore blocked by something now occupying the path, a delete still behind
 * the Raw exit guard — which is what leaves the entry on the timeline, still
 * offering.
 */
export function applyFileHistory(entry, undoing) {
  if (entry.kind === "move") {
    const from = undoing ? entry.to : entry.from;
    const to = undoing ? entry.from : entry.to;
    const p = fileOpPrompt(entry, false);
    return new Promise((resolve) => {
      confirmDialog({
        title: p.title,
        path: from,
        body: fileOpBody(entry, undoing),
        ok: p.ok,
        danger: p.danger,
        note: p.note,
        onOk: () =>
          moveEntry({ path: from, type: entry.type === "folder" ? "folder" : "file" }, to, { noRecord: true }).then(
            (ok) => resolve(ok !== false)
          ),
        onCancel: () => resolve(false),
      });
    });
  }
  /* a delete undoes to a restore and redoes to a delete; a create is the
     mirror of that */
  const restoring = entry.kind === "delete" ? undoing : !undoing;
  const p = fileOpPrompt(entry, restoring);
  return new Promise((resolve) => {
    confirmDialog({
      title: p.title,
      path: entry.path,
      body: fileOpBody(entry, undoing),
      ok: p.ok,
      danger: p.danger,
      note: p.note,
      onOk: () => {
        if (restoring) putFileBack(entry).then((ok) => resolve(ok !== false));
        else takeFileAway(entry, (ok) => resolve(ok !== false));
      },
      onCancel: () => resolve(false),
    });
  });
}

export async function doDelete(path, kind, opts) {
  const affects = state.active === path || (kind === "folder" && state.active && state.active.indexOf(path + "/") === 0);
  /* Confirming a delete is also an attempt to leave the active Raw buffer.
     Ask the delete question first, then the staged-diff question: Keep editing
     cancels the removal, Save & exit puts the bytes into the retained copy,
     and Exit without saving retains exactly the last server-confirmed file. */
  if (affects && !(opts && opts.force)) {
    /* The guard defers the delete rather than performing it — so this call has
       not deleted anything, and must not be recorded as if it had. The
       deferred one records itself, and carries `onDone` with it.

       The cancel hook is what closes the loop for a caller that is AWAITING
       this delete (the undo timeline): Keep editing means the delete never
       happens, and `onDone(false)` is the only way to say so. Reporting false
       here instead — at defer time — would be wrong in the other direction: a
       user who then picks Save & exit really does delete the file, and the
       caller would have already been told it did not happen. */
    const deferred = guardRawExit(
      () => doDelete(path, kind, opts ? Object.assign({}, opts, { force: true }) : { force: true }),
      opts && opts.onDone ? () => opts.onDone(false) : null
    );
    if (!deferred) return false;
  }
  /* read while the tree still knows where this doc was — see the note above */
  const next = affects ? neighbourDoc(path) : null;
  /* captured before it goes: an entry that carries the text can put the doc
     back even after the trash has been emptied */
  const doc = kind === "doc" ? state.docs.get(path) : null;
  const markdown = doc && typeof doc.markdown === "string" ? doc.markdown : null;
  try {
    await api.deleteDoc(path);
  } catch (err) {
    apiFail(err, "Could not delete " + path);
    return false;
  }
  /* The doc's earlier TEXT entries stay on the timeline, deliberately. They
     are older than this delete, so ⌘Z always reaches the delete first and the
     file is back before any of them is applied — and dropping them is what
     made "undo, undo, undo" stop one step short of the edit it was walking
     back to. `applyTextHistory` still refuses an entry whose doc is missing,
     for the one path that can produce it: a restore the user declined. */
  if (!(opts && opts.noRecord)) rememberFileOp({ kind: "delete", path, type: kind, markdown });
  if (affects) {
    state.docs.delete(state.active);
    state.active = null;
    state.dirty = false;
  }
  await loadTree();
  if (affects) {
    /* the neighbour, re-checked against the tree that came back — then the
       vault's first doc, then nothing at all, which is the empty state */
    const target = next && state.docPaths.has(next) ? next : [...state.docPaths].sort()[0];
    /* same reasoning as a rename: the doc the entry named is gone, so replace
       it rather than leaving a Back that resolves to nothing */
    if (target) await openDoc(target, { replace: true });
  }
  /* the doc is in the trash now, so the drawer's count is stale — and this is
     the one moment the user might look at it */
  refreshTrash();
  toast("Deleted " + path);
  if (opts && opts.onDone) opts.onDone(true);
  return true;
}

/* ============================================================
   SIDEBAR CONTEXT MENU

   Right-click anywhere in the left panel. It is a WAY IN to the file ops that
   already exist — every item calls the same `startCreate` / `startRename` /
   `askDelete` the footer buttons and the row actions call, so there is exactly
   one create flow (the `inlineRow` in the tree), one rename flow and one delete
   confirm. The menu owns no file operation of its own.

   What it adds that nothing else had: PLACEMENT. `⌥N` puts a new doc beside the
   doc you are editing and a new folder at the root, which is the right default
   for a keyboard gesture and the wrong one for a pointer that is resting on a
   specific folder. Right-click a folder → inside that folder. Right-click empty
   space → the vault root. That is `startCreate(kind, where)`.

   Rules it has to keep:
     - Esc closes it, and it sits BELOW modals/palette in `dismissTop()`.
     - clicking away closes it (mousedown, capture — before any click lands).
     - it never opens off-screen: `place()` flips at the right/bottom edges and
       clamps at all four.
     - keyboard-reachable: ⇧F10 / the Menu key with focus in the sidebar, then
       ↑ ↓ Home End to move and ⏎ to choose.
     - it does NOT touch the browser's own menu anywhere else, and not even
       inside the sidebar over an <input> — the inline create/rename field lives
       in this tree and paste is the whole point of it.
   ============================================================ */

/** Where focus was when the menu opened, so closing puts it back. */
let ctxReturn = null;

/** How long a thumb has to rest on a row before it means "menu". 500ms is what
    both mobile platforms use for their own long press, so a gesture learned
    anywhere else arrives here already calibrated. */
export const LONGPRESS_MS = 500;

export const ctxOpen = () => !$("#ctxMenu").hidden;

/** What was right-clicked: a vault, a folder, a doc, or the panel itself.
    A vault ROW is the root of that vault — there is nothing to rename or
    delete, but it is a fine place to create in. */
export function ctxTarget(node) {
  const row = node && node.closest ? node.closest(".row[data-path]") : null;
  if (!row) return { kind: "root", path: "", parent: "" };
  const kind = row.dataset.kind;
  const path = row.dataset.path;
  /* the vault ID rides along: it is the only thing on a vault row that is not
     derivable from the path — the primary's root key is "" */
  if (kind === "vault") return { kind, path: "", parent: path, vault: row.dataset.vault };
  return { kind, path, parent: kind === "folder" ? path : dirname(path) };
}

/**
 * That vault's pipeline, now — the same pull, commit and push "Sync now" runs,
 * and the same route for the primary as for any other vault (the registry
 * resolves `vault` to it).
 *
 * Nothing is painted here: the sync publishes `sync-status` on its way through,
 * and `adoptVaultSync` turns that into the row's own dot. Only the outcome has
 * to be said out loud, in the wording the Settings card uses.
 */
async function syncVault(id) {
  const v = vaultById(id);
  const who = (v && v.label) || id;
  try {
    const s = await api.syncVault(id);
    toast(
      s.state === "error"
        ? who + " — sync failed · " + s.message
        : s.state === "offline"
        ? who + " — not syncing · " + s.message
        : who + " — synced · " + s.message
    );
  } catch (err) {
    apiFail(err, "Could not sync " + who);
  }
}

/** Human name for the folder a create would land in. */
const ctxWhere = (t) => (t.parent ? "in " + t.parent : "at the vault root");

function ctxItems(t) {
  const items = [];
  if (t.kind === "doc") items.push({ label: "Open", icon: I.doc, run: () => openDoc(t.path) });
  /* the one thing a vault row can be asked to DO. It lives here because the
     alternative is a trip to Settings for something that is a verb — and this
     row already carries the dot that answers "did it work". */
  if (t.kind === "vault") items.push({ label: "Sync", icon: I.sync, run: () => syncVault(t.vault) });
  items.push({ label: "New doc", hint: ctxWhere(t), icon: I.file, run: () => startCreate("doc", t.parent) });
  items.push({ label: "New folder", hint: ctxWhere(t), icon: I.folder, run: () => startCreate("folder", t.parent) });
  /* rename/move and delete already exist as row actions and as F2/Del on the
     focused row — folded in here rather than duplicated, so the menu is the
     complete set of things you can do to a row */
  if (t.kind !== "root" && t.kind !== "vault") {
    items.push({ sep: true });
    items.push({ label: "Rename / move", hint: "⏎", icon: I.pencil, run: () => startRename(t.path, t.kind) });
    items.push({ label: "Delete", hint: "Del", icon: I.trash, danger: true, run: () => askDelete(t.path, t.kind) });
  }
  return items;
}

function ctxCells(menu) {
  return $$(".menu-item", menu);
}

/**
 * Put the menu at the pointer, flipping rather than spilling.
 *
 * Measured, not guessed — and measured with `offsetWidth/offsetHeight`, NOT
 * `getBoundingClientRect()`: the menu is placed while it is still in its
 * pre-show state, which carries `transform: scale(.97)`, and a rect would come
 * back 3% small and let it spill by a few pixels at the edge. Offsets ignore
 * transforms, so this is the size the menu will settle at.
 *
 * Flip first (a right-click near the right edge opens leftwards from the
 * pointer, which is what every native menu does), then clamp — a menu taller
 * than the viewport scrolls inside itself via `max-height` and still lands
 * fully on screen.
 */
function ctxPlace(x, y) {
  const menu = $("#ctxMenu");
  const pad = 8;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = x;
  let top = y;
  if (left + w + pad > vw) left = x - w;
  if (top + h + pad > vh) top = y - h;
  menu.style.left = Math.max(pad, Math.min(left, vw - w - pad)) + "px";
  menu.style.top = Math.max(pad, Math.min(top, vh - h - pad)) + "px";
}

export function openCtx(t, x, y) {
  const menu = $("#ctxMenu");
  const was = ctxOpen() ? ctxReturn : document.activeElement;
  menu.innerHTML = "";
  menu.appendChild(
    el("div", "menu-head", esc(t.kind === "root" || t.kind === "vault" ? (t.parent ? t.parent + " root" : "Vault root") : t.path))
  );
  ctxItems(t).forEach((it) => {
    if (it.sep) return menu.appendChild(el("div", "menu-sep"));
    const b = el("button", "menu-item" + (it.danger ? " danger" : ""));
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.innerHTML =
      '<span class="ico">' +
      it.icon +
      '</span><span class="lbl">' +
      esc(it.label) +
      "</span>" +
      (it.hint ? '<span class="mhint">' + esc(it.hint) + "</span>" : "");
    /* close BEFORE running: the action may open the inline row, a confirm or a
       doc, and each of those wants the focus this menu is holding */
    b.addEventListener("click", () => {
      closeCtx(true);
      it.run();
    });
    menu.appendChild(b);
  });
  ctxReturn = was;
  /* mount → place → reveal, in that order: placing while still transparent is
     what lets the open animation run, and ctxPlace measures untransformed */
  menu.hidden = false;
  ctxPlace(x, y);
  menu.classList.add("show");
  const first = ctxCells(menu)[0];
  if (first) focusQuiet(first);
}

/** `keepFocus` = the action about to run will place focus itself. */
export function closeCtx(keepFocus) {
  const menu = $("#ctxMenu");
  if (menu.hidden) return false;
  menu.classList.remove("show");
  menu.hidden = true;
  menu.innerHTML = "";
  const back = ctxReturn;
  ctxReturn = null;
  if (!keepFocus && back && back.isConnected) focusQuiet(back);
  return true;
}

export function focusQuiet(node) {
  try {
    node.focus({ preventScroll: true });
  } catch (e) {
    node.focus();
  }
}

/** Open the menu FROM an element rather than from a pointer (⇧F10, Menu key). */
export function openCtxFrom(node) {
  const r = node.getBoundingClientRect();
  openCtx(ctxTarget(node), Math.round(r.left + 12), Math.round(r.bottom + 2));
}

export function ctxKeys(e) {
  const cells = ctxCells($("#ctxMenu"));
  if (!cells.length) return;
  const at = cells.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    focusQuiet(cells[(at + step + cells.length) % cells.length] || cells[0]);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusQuiet(cells[0]);
  } else if (e.key === "End") {
    e.preventDefault();
    focusQuiet(cells[cells.length - 1]);
  } else if (e.key === "Tab") {
    /* a menu is not a tab stop — Tab leaves it rather than cycling inside it */
    e.preventDefault();
    closeCtx();
  }
  /* Enter/Space are the button's own; Escape deliberately bubbles to the
     document handler so ONE place (dismissTop) decides what Esc dismisses */
}

/* ---------- themed confirm (same veil + modal chrome as everything else) ---------- */
