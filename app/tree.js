/* ============================================================
   tree.js — sidebar tree, create/rename/move/delete, context menu, dialogs.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, I, apiFail, clearStickyToast, dirname, el, esc, normTarget, toast } from "./ui.js";
import { cells } from "./markdown.js";
import { confirmDialog } from "./dialogs.js";
import { refreshTrash, trashRetentionNote } from "./trash.js";
import { guardRawExit, navGate, openDoc, renderDoc, saveDoc, setBaseline, setMode, setSaveIndicator } from "./editor.js";
import { app, isDrawer, openFirstDoc, openNav } from "./shell.js";

/* ============================================================
   SIDEBAR TREE
   ============================================================ */
function indexTree(nodes, seen) {
  nodes.forEach((n) => {
    if (n.type === "folder") {
      if (!state.folderOpen.has(n.path)) state.folderOpen.set(n.path, !!n.open);
      indexTree(n.children, seen);
    } else {
      seen.add(n.path);
      const prev = state.docs.get(n.path);
      state.docs.set(n.path, Object.assign({ markdown: "", rev: null, loaded: false }, prev || {}, n));
    }
  });
}

export async function loadTree() {
  const r = await api.getTree();
  state.vault = r.vault;
  state.tree = r.tree;
  /* The tree is the authoritative doc set, so the link world is rebuilt from
     it rather than accumulated: after a rename or a delete a stale slug would
     otherwise keep resolving to a path that is now a 404, and a slug that has
     just become AMBIGUOUS would keep silently resolving to whichever doc was
     indexed last. */
  const seen = new Set();
  indexTree(r.tree, seen);
  state.docPaths = seen;
  state.slugs = new Map();
  seen.forEach((p) => {
    const slug = p.split("/").pop().replace(/\.md$/i, "");
    const list = state.slugs.get(slug);
    if (list) list.push(p);
    else state.slugs.set(slug, [p]);
  });
  state.slugs.forEach((list) => list.sort());
  for (const p of [...state.docs.keys()]) if (!seen.has(p) && p !== state.active) state.docs.delete(p);
  renderTree();
  $("#vaultName").textContent = r.vault.name;
  $("#vaultSub").textContent = r.vault.root + " · " + r.vault.docCount + " docs";
}

export function renderTree() {
  const host = $("#tree");
  host.innerHTML = "";
  host.appendChild(el("div", "sec-label", "Vault"));
  const slots = new Map();
  slots.set("", { box: host, depth: 0 });

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
        slots.set(n.path, { box: kids, depth: depth + 1 });
        parent.appendChild(kids);
        n.children.forEach((c) => node(c, depth + 1, kids));
      }
      return;
    }
    if (n.type === "folder") {
      const open = state.folderOpen.get(n.path) !== false;
      const wrap = el("div", "rowwrap");
      const row = el("button", "row folder" + (open ? " open" : ""));
      row.style.paddingLeft = 8 + depth * 12 + "px";
      /* what the context menu reads off whatever was right-clicked. Uniform
         across both row kinds — `data-doc` stays on files because that is the
         selector the doc-open path and the tests already use. */
      row.dataset.path = n.path;
      row.dataset.kind = "folder";
      row.innerHTML = '<span class="ico chev">' + I.chev + '</span><span class="ico">' + I.folder + '</span><span class="lbl">' + esc(n.name) + "</span>";
      const kids = el("div", "children" + (open ? "" : " closed"));
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
      wrap.appendChild(row);
      wrap.appendChild(rowActs(n.path, "folder", n.name));
      parent.appendChild(wrap);
      parent.appendChild(kids);
      n.children.forEach((c) => node(c, depth + 1, kids));
    } else {
      const wrap = el("div", "rowwrap");
      const row = el("button", "row file" + (n.empty ? " inert" : "") + (state.active === n.path ? " active" : ""));
      row.style.paddingLeft = 14 + depth * 12 + "px";
      row.dataset.doc = n.path;
      row.dataset.path = n.path;
      row.dataset.kind = "doc";
      row.innerHTML = '<span class="ico">' + (n.hasSecrets ? I.key : I.file) + '</span><span class="lbl">' + esc(n.name) + '</span><span class="dot"></span>';
      row.addEventListener("click", () => openDoc(n.path));
      row.addEventListener("focus", () => (state.pick = { path: n.path, kind: "doc" }));
      row.addEventListener("keydown", (e) => rowKeys(e, n.path, "doc"));
      renameOnDouble(row, n.path, "doc");
      wrap.appendChild(row);
      wrap.appendChild(rowActs(n.path, "doc", n.name));
      parent.appendChild(wrap);
    }
  };
  state.tree.forEach((n) => node(n, 0, host));

  if (state.creating) {
    const c = state.creating;
    const folder = c.kind === "folder";
    const slot = slots.get(c.parent) || slots.get("");
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
}

/* ============================================================
   CREATION — context, path grammar, refusal (SPEC §5)

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

   Why a bare name gets `.md`: a doc IS a `.md` file here (SPEC §5) — the server
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

/** Is this path still in the tree, as this kind? */
function treeHas(path, kind) {
  if (!path) return kind === "folder";
  if (kind === "doc") return state.docPaths.has(path);
  let found = false;
  const walk = (nodes) =>
    nodes.forEach((n) => {
      if (n.type !== "folder") return;
      if (n.path === path) found = true;
      else walk(n.children || []);
    });
  walk(state.tree);
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
 * Open `path` and every folder above it, so a row mounted there is visible.
 * Returns whether anything that was explicitly CLOSED got opened — the only
 * reason a repaint is owed, which is all `revealInTree` wanted from its own
 * copy of this walk.
 *
 * The write stays unconditional even when nothing changed: `commitCreate` pins
 * a brand-new folder open BEFORE `loadTree`, and `indexTree` only seeds a key
 * it does not already have, so an absent key would come back closed from the
 * server.
 */
export function revealFolder(path) {
  let acc = "";
  let changed = false;
  for (const s of String(path || "").split("/").filter(Boolean)) {
    acc = acc ? acc + "/" + s : s;
    if (state.folderOpen.get(acc) === false) changed = true;
    state.folderOpen.set(acc, true);
  }
  return changed;
}

/**
 * Parse the create input into a plan, or a refusal.
 *
 * Returns `{ ok, kind, path, error }`. Every refusal here is a MIRROR of a
 * server rule, caught before the round trip so the row can hold itself open
 * and say why; the server remains the authority.
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
    if (s.trim() !== s) return no("A name cannot start or end with a space.");
  }

  const base = fromRoot ? "" : parent || "";
  if (!folder) {
    const leaf = segs[segs.length - 1];
    segs[segs.length - 1] = /\.md$/i.test(leaf) ? leaf : leaf + ".md";
  }
  const path = (base ? base + "/" : "") + segs.join("/");

  /* Every folder this create would have to make on the way, checked against
     the tree so an intermediate segment that is already a DOC is refused here
     rather than as an ENOTDIR out of mkdir(2). */
  const depth = folder ? segs.length : segs.length - 1;
  let acc = base;
  for (let i = 0; i < depth; i++) {
    acc = acc ? acc + "/" + segs[i] : segs[i];
    if (state.docPaths.has(acc)) return no(acc + " is a doc, not a folder.");
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
  row.style.paddingLeft = 10 + o.depth * 12 + "px";
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
    note.style.paddingLeft = 10 + o.depth * 12 + 24 + "px";
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
    await api.createEntry({ path: plan.path, type: plan.kind, markdown: "" });
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
  state.creating = null;
  /* the intermediate folders were made server-side; open them here so the new
     entry is visible in the tree rather than buried in a collapsed subtree */
  revealFolder(plan.kind === "folder" ? plan.path : dirname(plan.path));
  await loadTree();
  if (plan.kind === "folder") {
    state.pick = { path: plan.path, kind: "folder" };
    renderTree();
    toast("Folder " + plan.path + " created");
    return;
  }
  await openDoc(plan.path);
  setMode("raw", { silent: true, caret: 0 });
  toast("Created " + plan.path);
}

/**
 * The broken-link create affordance (SPEC §5). A `[[link]]` that resolves to
 * nothing renders flagged; clicking it makes the doc AT THE IMPLIED PATH and
 * opens it.
 *
 * "Implied" is literal for a qualified link (`[[notes/ideas]]` → `notes/ideas.md`)
 * and, for a bare slug, is the folder of the doc the link was written in —
 * the same default the inline "New doc" flow uses, and the one that keeps the
 * new doc where the author was already working.
 */
export async function createFromLink(name) {
  const t = normTarget(name);
  if (!t) return;
  const here = dirname(state.active || "");
  const path = t.indexOf("/") >= 0 ? t + ".md" : (here ? here + "/" : "") + t + ".md";
  try {
    await api.createEntry({ path, type: "doc", markdown: "# " + t.split("/").pop() + "\n\n" });
    await loadTree();
    await openDoc(path);
    setMode("raw", { silent: true });
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
   RENAME / MOVE / DELETE — IDE parity from the sidebar (SPEC §5)

   ONE inline control does rename AND move, deliberately: the row turns into a
   text input carrying the doc's full vault-relative path, with the basename
   preselected. Type over the selection and it is a rename; edit the folder part
   and it is a move; both are the same `PATCH {to}` and the same one commit.
   That is the whole reason there is no drag-and-drop here — a drag cannot be
   driven from the keyboard, cannot express "into a folder that does not exist
   yet", and would need a second, different affordance for rename anyway.

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
  /* Latched HERE, before any await: the whole move is one operation, and the
     question at the end is "is the user still where they were when they asked
     for it?". Latching later would only notice navigations that started after
     the request came back — and a click made WHILE it was in flight is exactly
     the case that must win. */
  const ours = navGate();
  let to = String(value == null ? "" : value)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!to || to === node.path) {
    renderTree();
    return;
  }
  if (kind === "doc") to = to.replace(/\.md$/i, "") + ".md";
  if (to === node.path) {
    renderTree();
    return;
  }
  /* Mirror of the server's own guard, so the user hears about it before the
     round trip: `]` and line breaks break out of the `[[…]]` a rewrite would
     splice this name into, and the damage lands in OTHER people's docs. */
  if (/[\]\r\n]/.test(to)) {
    renderTree();
    toast('A name cannot contain "]" — a [[link]] pointing at it would not survive');
    return;
  }

  /* Anything still in the buffer has to reach disk first. Not only when the
     open doc is the one moving: the server rewrites [[links]] in the moved
     doc's REFERRERS, so an untouched-looking buffer can go stale under the
     rename too, and the save that noticed used to answer the 409 by throwing
     the user's typing away. */
  const activeMoves = state.active && remap(state.active, node.path, to) !== state.active;
  if (state.active && state.dirty) {
    const wrote = await saveDoc(state.active, { silent: true });
    if (!wrote) {
      renderTree();
      toast("Unsaved changes in " + state.active + " could not be written — the move was not started");
      return;
    }
  }

  try {
    const r = await api.moveDoc(node.path, to);
    /* Re-home the pane only if this move still owns navigation. If the user
       clicked another doc while the request was in flight, or the SSE `moved`
       echo already followed the doc to its new path, that newer navigation owns
       the pane — stealing it back would drop the user somewhere they left, and
       clearing state.active underneath it would blank the doc they chose. */
    const follow = activeMoves && ours();
    const next = follow && state.active ? remap(state.active, node.path, to) : null;
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
        node.path +
        " → " +
        to +
        (n ? " · " + n + " link" + (n === 1 ? "" : "s") + " rewritten" : "")
    );
  } catch (err) {
    renderTree();
    if (err && err.code === "exists") {
      toast(to + " already exists");
      return;
    }
    apiFail(err, "Could not move " + node.path);
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
 * The broken-link behaviour is unchanged and still SPEC §5: a rename rewrites
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
    that owns that list ("" for the vault root). */
function treeLocate(path, nodes, parent) {
  const list = nodes || state.tree;
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
    cur = at.parent; // "" at the root ends the loop
  }
  return null;
}

async function doDelete(path, kind, opts) {
  const affects = state.active === path || (kind === "folder" && state.active && state.active.indexOf(path + "/") === 0);
  /* Confirming a delete is also an attempt to leave the active Raw buffer.
     Ask the delete question first, then the staged-diff question: Keep editing
     cancels the removal, Save & exit puts the bytes into the retained copy,
     and Exit without saving retains exactly the last server-confirmed file. */
  if (affects && !(opts && opts.force)) {
    if (!guardRawExit(() => doDelete(path, kind, { force: true }))) return;
  }
  /* read while the tree still knows where this doc was — see the note above */
  const next = affects ? neighbourDoc(path) : null;
  try {
    await api.deleteDoc(path);
  } catch (err) {
    apiFail(err, "Could not delete " + path);
    return;
  }
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

/** What was right-clicked: a folder, a doc, or the panel itself. */
export function ctxTarget(node) {
  const row = node && node.closest ? node.closest(".row[data-path]") : null;
  if (!row) return { kind: "root", path: "", parent: "" };
  const kind = row.dataset.kind;
  const path = row.dataset.path;
  return { kind, path, parent: kind === "folder" ? path : dirname(path) };
}

/** Human name for the folder a create would land in. */
const ctxWhere = (t) => (t.parent ? "in " + t.parent : "at the vault root");

function ctxItems(t) {
  const items = [];
  if (t.kind === "doc") items.push({ label: "Open", icon: I.doc, run: () => openDoc(t.path) });
  items.push({ label: "New doc", hint: ctxWhere(t), icon: I.file, run: () => startCreate("doc", t.parent) });
  items.push({ label: "New folder", hint: ctxWhere(t), icon: I.folder, run: () => startCreate("folder", t.parent) });
  /* rename/move and delete already exist as row actions and as F2/Del on the
     focused row — folded in here rather than duplicated, so the menu is the
     complete set of things you can do to a row */
  if (t.kind !== "root") {
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
  menu.appendChild(el("div", "menu-head", esc(t.kind === "root" ? "Vault root" : t.path)));
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
