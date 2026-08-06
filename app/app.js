/* ============================================================
   app.js — the whole z-notes interaction model.

   Hard rule: this file contains NO document content, NO vault data, NO
   settings defaults and NO network calls. Everything comes from api.js, which
   speaks the contract in prototypes/app/API.md (normative, SPEC §3). Swap what
   serves that contract and nothing here changes.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { estimateBits, generatePassphrase, MIN_BITS } from "./entropy.js";
import { dedentArmor, indentArmor, isArmorShape } from "./armor.js";

/* ============================================================
   ICONS
   ============================================================ */
const I = {
  chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  key: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="8" cy="13" r="4"/><path d="m11 11 8-8M17 5l2 2M15 7l2 2"/></svg>',
  check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  link: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9.5 14.5 14.5 9.5"/><path d="M12.5 6.5 14 5a4.2 4.2 0 0 1 6 6l-1.5 1.5M11.5 17.5 10 19a4.2 4.2 0 0 1-6-6l1.5-1.5"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  unlock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.8"/></svg>',
  copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  note: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h4"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>',
  tick: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  undo: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h11a5 5 0 0 1 0 10h-4"/><path d="m7 6-4 4 4 4"/></svg>',
  doc: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  pencil: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/><path d="m14.5 6.5 3.5 3.5"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5h4v2M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7"/></svg>',
  /* a broken [[link]]: the chain, snapped. Click it to create the doc. */
  linkbroken:
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12.5 6.5 14 5a4.2 4.2 0 0 1 6 6l-1.5 1.5M11.5 17.5 10 19a4.2 4.2 0 0 1-6-6l1.5-1.5"/><path d="M4 4l16 16" stroke-width="2"/></svg>',
  alert:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 21 20H3z"/><path d="M12 10v4M12 17.2v.1"/></svg>',
};

/* ============================================================
   STATE — caches of what the server said, never a source of truth
   ============================================================ */
const state = {
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
  settingsSection: "", // the `/settings/<section>` the address bar carries, if any
  mode: "preview",
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
     outside its own DOM node (SPEC §6, research §6). Keyed by armor, not by
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
  conflict: null, // { path, disk, mine } — the open save-conflict banner (SPEC §5)
  /* { path, proceed } — the open exit guard and the way out it is holding back
     (SPEC §4). Non-null is what stops a second trigger stacking a second copy. */
  exitGuard: null,
  events: null,
  epoch: null, // vault epoch from the last `hello` — see resyncAfterGap()
  /* The sidebar row the user last touched — { path, kind } — and the ONLY
     thing that makes ⌘N context-aware (see `createParent`). Set by a click or
     a focus on a tree row, cleared by `openDoc` so that opening a doc hands the
     context back to `state.active`. Never trusted blind: `createParent`
     re-checks it against the current tree, because a rename or a delete can
     retire the row underneath it. */
  pick: null,
  /* Terminal (SPEC §13). `status` is the SERVER's verdict, never inferred here;
     `commands` are the assistant's command records. The unlock token is not in
     this object and never will be — it lives in api.js alone. */
  term: { status: null, running: null, busy: false, history: [], hist: -1, draft: "", printed: new Set() },
  commands: [],
};

/* ============================================================
   TINY HELPERS
   ============================================================ */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
/* quotes are escaped too: half the call sites interpolate into an attribute
   (data-link, title, …) and a doc is allowed to contain any byte at all */
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const dirname = (p) => (p.indexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/")));

let toastT;
/**
 * `opts.sticky` keeps the notice up until something dismisses it.
 *
 * Reserved for the one class of message where 1.9 seconds is a lie: the ground
 * moved under an UNSAVED buffer (the doc was deleted elsewhere, or moved). The
 * user may be mid-sentence, may be looking at the keyboard, may be in another
 * window — and the next thing they do, ⌘S, will now behave differently. A
 * notice about that has to still be there when they look up.
 *
 * Deliberately NOT extended to "Reloaded from disk": SPEC §5 fixes that one as
 * a blip, and it describes something that already finished harmlessly.
 */
function toast(msg, opts) {
  const sticky = !!(opts && opts.sticky);
  $("#toastTxt").textContent = msg;
  const t = $("#toast");
  t.classList.toggle("sticky", sticky);
  t.classList.add("show");
  const glyph = t.querySelector(".ok");
  if (glyph) glyph.textContent = sticky ? "!" : "✓";
  clearTimeout(toastT);
  if (!sticky) toastT = setTimeout(() => t.classList.remove("show"), 1900);
}

/** Take a sticky notice down — on a click, or once the thing it warned about
    has been dealt with. A no-op for the ordinary self-expiring kind. */
function clearStickyToast() {
  const t = $("#toast");
  if (!t || !t.classList.contains("sticky")) return;
  t.classList.remove("show", "sticky");
}

function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(() => {});
    else {
      const ta = el("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  } catch (e) {}
  toast("Copied to clipboard");
}

function apiFail(err, what) {
  if (err && err.name === "AbortError") return;
  console.error(what, err);
  toast((err && err.message) || what || "Request failed");
}

/* the inverse of esc(), for the one place that has to look at escaped text
   again — &amp; LAST or "&amp;lt;" would decode twice */
const unesc = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/* ---------- [[link]] resolution (SPEC §5) ----------

   The client's rule is the SERVER's rule, restated: `[[slug]]` resolves by
   unique filename slug vault-wide, `[[path/slug]]` is the disambiguating form,
   and a slug carried by two docs resolves to NEITHER. Rendering an ambiguous
   link as if it pointed somewhere would be the one behaviour a file-backed
   vault must never have, so it is flagged exactly like a missing one. */
const normTarget = (t) =>
  String(t == null ? "" : t)
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "");

/** → { state: "ok" | "ambiguous" | "missing", path, candidates } */
function lookupLink(target) {
  const t = normTarget(target);
  if (!t) return { state: "missing", path: null, candidates: [] };
  if (t.indexOf("/") >= 0) {
    const p = t + ".md";
    return state.docPaths.has(p)
      ? { state: "ok", path: p, candidates: [p] }
      : { state: "missing", path: null, candidates: [] };
  }
  const hits = state.slugs.get(t) || [];
  if (hits.length === 1) return { state: "ok", path: hits[0], candidates: hits };
  if (hits.length > 1) return { state: "ambiguous", path: null, candidates: hits };
  return { state: "missing", path: null, candidates: [] };
}

/* inline markdown: `code`, **bold**, *em*, [[wikilink]] — used for docs AND
   for assistant messages, which arrive as markdown, never as HTML */
function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (m, c) => '<code class="ic">' + c + "</code>");
  /* bold/em carry the same code-span alternation the wikilink pass below does,
     and for the same reason: `h` already contains the emitted <code> spans, so
     a bare .replace would render `**bold**` INSIDE backticks — text the fence
     promises stays literal. Skip the spans; style everything else. */
  const CODE_SPAN = /(<code class="ic">[\s\S]*?<\/code>)/;
  h = h.replace(new RegExp(CODE_SPAN.source + "|\\*\\*([^*]+)\\*\\*", "g"), (m, code, b) =>
    code ? code : "<strong>" + b + "</strong>"
  );
  h = h.replace(new RegExp(CODE_SPAN.source + "|(^|[\\s(])\\*([^*\\n]+)\\*", "g"), (m, code, pre, e) =>
    code ? code : pre + "<em>" + e + "</em>"
  );
  /* `h` is already escaped, so `name` must not be escaped a second time.
     The alternation carries the already-emitted inline-code spans so a
     `[[link]]` written inside backticks stays literal text — which is exactly
     what the server promises too: it never rewrites a link inside code, so the
     renderer must never turn one into a pill that could go stale. */
  h = h.replace(/(<code class="ic">[\s\S]*?<\/code>)|\[\[([^\]]+)\]\]/g, (m, code, name) => {
    if (code) return code;
    const hit = lookupLink(unesc(name));
    if (hit.state === "ok") {
      return '<a class="wl" data-link="' + name + '" title="Open ' + name + '">' + I.link + name + "</a>";
    }
    const why =
      hit.state === "ambiguous"
        ? "Ambiguous — " + hit.candidates.length + " docs share this name; qualify it as [[folder/name]]"
        : "No doc named " + name + " — click to create it";
    return (
      '<a class="wl broken" data-link="' +
      name +
      '" data-broken="' +
      hit.state +
      '" title="' +
      esc(why) +
      '">' +
      I.linkbroken +
      name +
      "</a>"
    );
  });
  return h;
}

/* toy js/ts highlighter for fenced js|ts blocks — pattern-based only, so it
   knows nothing about any particular document's contents */
/* One pass, one regex: successive .replace() calls would re-scan the markup
   they just emitted (a `class` keyword inside class="tk-str" and so on). */
const HL_RE = /("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)|(\/\/[^\n]*)|\b(const|let|var|function|return|await|async|import|export|from|new|class|extends|type|interface|enum|if|else|for|while|try|catch|throw|typeof|instanceof|null|undefined|true|false)\b|\b([A-Z][A-Za-z0-9_$]*)(?=[.(])|\b(\d+(?:\.\d+)?[a-z]*)\b/g;

function hl(src) {
  const s = String(src);
  let out = "";
  let last = 0;
  s.replace(HL_RE, (m, str, com, kw, fn, num, off) => {
    out += esc(s.slice(last, off));
    const cls = str ? "tk-str" : com ? "tk-com" : kw ? "tk-key" : fn ? "tk-fn" : "tk-num";
    out += '<span class="' + cls + '">' + esc(m) + "</span>";
    last = off + m.length;
    return m;
  });
  return out + esc(s.slice(last));
}

const activeDoc = () => state.docs.get(state.active);

function countWords(md) {
  return String(md || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#>*`|[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

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

async function loadTree() {
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

function renderTree() {
  const host = $("#tree");
  host.innerHTML = "";
  host.appendChild(el("div", "sec-label", "Vault"));
  const slots = new Map();
  slots.set("", { box: host, depth: 0 });

  /* Rename / delete affordances. They live BESIDE the row, never inside it:
     `.row` is a <button> and a button inside a button is not a thing. Both are
     tabindex=-1 — the row itself is the tab stop, and F2 / Delete on the
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

   THE CONTEXT. ⌘N (doc) and ⇧⌘N (folder) create RELATIVE to whatever the user
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
function revealFolder(path) {
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
  /* mirror of the server's move guard (server.ts linkSafeTarget): a name
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
 * Left undefined (⌘N, ⇧⌘N, the footer buttons) the context is `createParent()`
 * — the picked folder, else the picked-or-open doc's folder, else the root —
 * and it is the SAME context for both kinds. The old rule gave a new folder to
 * the vault root unconditionally, which meant ⇧⌘N inside a project could not
 * make a subfolder without a follow-up move.
 *
 * Deliberately the same entry point either way — `renderTree()` mounts ONE
 * `inlineRow` from `state.creating` and `commitCreate` is the only writer, so
 * the menu adds a way IN to the create flow rather than a second create flow.
 */
function startCreate(kind, where) {
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
async function createFromLink(name) {
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
  if (e.key === "F2") {
    e.preventDefault();
    startRename(path, kind);
  } else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    askDelete(path, kind);
  }
}

function startRename(path, kind) {
  state.creating = null;
  state.renaming = { path, kind };
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

async function commitRename(node, value) {
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
 * The delete confirmation.
 *
 * The copy is FORKED on whether the trash is actually there. It used to promise
 * "Recoverable only from git history", which stopped being true the moment a
 * trash existed — but it is still true of a server that has no trash route, and
 * this dialog is the last thing a user reads before pressing Delete. So the
 * sentence follows `state.trash.available`, which is set by a GET that answered
 * and by nothing else: the app never promises a trash it has not seen.
 *
 * The BROKEN-LINK warning stays either way. That is SPEC §5 on purpose — a
 * rename rewrites every `[[link]]` that resolved to the doc, a delete rewrites
 * none, because the broken link is the record that something used to be there.
 * With a trash behind it the sentence gains an end: the links come back when
 * the doc does, so the damage is now as reversible as the delete is.
 */
function askDelete(path, kind) {
  const inSubtree = kind === "folder" ? [...state.docPaths].filter((p) => p.indexOf(path + "/") === 0) : [];
  const what =
    kind === "folder"
      ? "This folder and everything inside it (" + inSubtree.length + " doc" + (inSubtree.length === 1 ? "" : "s") + ")"
      : "This doc";
  const trashed = state.trash.available;
  const detail = trashed
    ? what + " goes to the trash, in one commit — restore it from the sidebar."
    : what + " is removed from disk in one commit.";
  const links = trashed
    ? " Any [[link]] pointing here is left BROKEN until it is restored — flagged in the preview, never silently rewritten."
    : " Any [[link]] pointing here is left BROKEN — flagged in the preview, never silently rewritten.";
  confirmDialog({
    title: "Delete " + (kind === "folder" ? "folder" : "doc"),
    path: path,
    body: detail + links,
    ok: "Delete",
    note: trashed ? trashRetentionNote() : "Recoverable only from git history.",
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
function trashRetentionNote() {
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
function adoptTrash(r) {
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

async function refreshTrash() {
  /* A folder delete announces one `doc-changed` PER DOC, so this is called in
     bursts. Dropping the extras would be wrong — the last event is the one that
     describes the finished state — so a call that arrives mid-flight is
     remembered and run once at the end instead of N times over. */
  if (state.trash.loading) {
    trashAgain = true;
    return;
  }
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
    if (trashAgain) {
      trashAgain = false;
      refreshTrash();
    }
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
function toggleTrash() {
  const t = state.trash;
  if (!t.available) return;
  t.open = !t.open;
  t.rowErr.clear();
  paintTrash();
  if (t.open) refreshTrash();
}

async function restoreFromTrash(e) {
  const t = state.trash;
  if (t.busy.has(e.id)) return;
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
      return;
    }
    paintTrashList();
    apiFail(err, "Could not restore " + e.path);
    return;
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
}

function askPurgeEntry(e) {
  confirmDialog({
    title: "Delete permanently",
    path: e.path,
    body:
      "This removes " +
      (e.kind === "folder" ? "the folder and everything in it" : "the doc") +
      " from the trash for good. There is no restore after this, and no undo.",
    ok: "Delete for good",
    note: "The git history is what is left.",
    onOk: () => purgeEntry(e),
  });
}

async function purgeEntry(e) {
  const t = state.trash;
  if (t.busy.has(e.id)) return;
  t.busy.add(e.id);
  t.rowErr.delete(e.id);
  paintTrashList();
  try {
    await api.purgeTrashEntry(e.id);
  } catch (err) {
    t.busy.delete(e.id);
    paintTrashList();
    apiFail(err, "Could not delete " + e.path);
    return;
  }
  t.busy.delete(e.id);
  await refreshTrash();
  toast("Deleted " + e.path + " for good");
}

function askEmptyTrash() {
  const n = state.trash.entries.length;
  confirmDialog({
    title: "Empty trash",
    path: n + " item" + (n === 1 ? "" : "s"),
    body: "Every deleted doc in here is removed for good, including the ones that still had days to run. There is no restore after this, and no undo.",
    ok: "Empty trash",
    note: "The git history is what is left.",
    onOk: emptyTrash,
  });
}

async function emptyTrash() {
  try {
    /* `{ all: true }` — the sweep the SERVER runs on its own drops only what is
       already expired, and this is the user saying they meant all of it */
    const r = await api.purgeTrash({ all: true });
    await refreshTrash();
    const n = r && typeof r.purged === "number" ? r.purged : 0;
    toast(n ? "Deleted " + n + " item" + (n === 1 ? "" : "s") + " for good" : "Trash emptied");
  } catch (err) {
    await refreshTrash();
    apiFail(err, "Could not empty the trash");
  }
}

/* ============================================================
   SIDEBAR CONTEXT MENU

   Right-click anywhere in the left panel. It is a WAY IN to the file ops that
   already exist — every item calls the same `startCreate` / `startRename` /
   `askDelete` the footer buttons and the row actions call, so there is exactly
   one create flow (the `inlineRow` in the tree), one rename flow and one delete
   confirm. The menu owns no file operation of its own.

   What it adds that nothing else had: PLACEMENT. `⌘N` puts a new doc beside the
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
const LONGPRESS_MS = 500;

const ctxOpen = () => !$("#ctxMenu").hidden;

/** What was right-clicked: a folder, a doc, or the panel itself. */
function ctxTarget(node) {
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
    items.push({ label: "Rename / move", hint: "F2", icon: I.pencil, run: () => startRename(t.path, t.kind) });
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

function openCtx(t, x, y) {
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
function closeCtx(keepFocus) {
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

function focusQuiet(node) {
  try {
    node.focus({ preventScroll: true });
  } catch (e) {
    node.focus();
  }
}

/** Open the menu FROM an element rather than from a pointer (⇧F10, Menu key). */
function openCtxFrom(node) {
  const r = node.getBoundingClientRect();
  openCtx(ctxTarget(node), Math.round(r.left + 12), Math.round(r.bottom + 2));
}

function ctxKeys(e) {
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

function confirmDialog(opts) {
  /* `onCancel` is optional and fires on EVERY way out that is not OK — the
      Cancel button, Esc, a click on the veil, Back. A caller that must land
      somewhere either way (goHome: the button is never inert) needs the
      dismissal, not just the confirmation. */
  state.confirming = { onOk: opts.onOk, onCancel: opts.onCancel || null };
  $("#cfTitle").textContent = opts.title;
  $("#cfPath").textContent = opts.path;
  $("#cfBody").textContent = opts.body;
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

function closeConfirm() {
  const fn = state.confirming && state.confirming.onCancel;
  state.confirming = null;
  $("#cfVeil").classList.remove("show");
  if (fn) fn();
}

/* deliberately NOT closeConfirm(): taking the record first is what keeps the OK
   path from also firing the cancel callback on its way out */
function confirmOk() {
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
function conflictDialog(path, diskText, mineText) {
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
function orphanDialog(path, opts) {
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

function closeConflict() {
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
async function conflictRecreate() {
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
    await loadTree().catch(() => {});
    clearStickyToast();
    toast("Recreated " + c.path);
  } catch (err) {
    /* still orphaned, still dirty, notice still up — nothing was lost by
       failing, which is the only property that matters here */
    apiFail(err, "Could not recreate " + c.path);
  }
}

/** DISCARD — let the deletion stand, on the user's say-so and nobody else's. */
async function conflictDiscardOrphan() {
  const c = state.conflict;
  closeConflict();
  if (!c) return;
  state.docs.delete(c.path);
  clearStickyToast();
  if (c.path !== state.active) return toast("Discarded the buffer for " + c.path);
  state.active = null;
  state.dirty = false;
  await loadTree().catch(() => {});
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
function renderDiff(box, rows) {
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
function changedLineDiff(disk, mine) {
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
async function conflictTakeDisk() {
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
async function conflictKeepMine() {
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
function rawExitDiff() {
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
function guardRawExit(proceed) {
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

/** KEEP EDITING — Esc, the button, a click on the scrim, Back. Same thing. */
function closeExitGuard() {
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
function exitGuardDiscard() {
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
async function exitGuardSave() {
  const g = state.exitGuard;
  closeExitGuard();
  if (!g) return;
  const ok = await saveDoc(g.path);
  if (!ok) return toast("Could not save " + g.path + " — your changes are still in this tab");
  exitGuardProceed(g);
}

/* ============================================================
   MARKDOWN → PREVIEW
   ============================================================ */
const RE_FENCE = /^\s*```/;
const RE_HEAD = /^(#{1,3})\s+(.+)$/;
const RE_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>/;
const RE_LI = /^\s*[-*+]\s+/;
const RE_ROW = /^\s*\|/;
const RE_ALIGN = /^\s*\|[\s:|-]+\|\s*$/;

const isBlockStart = (l) => RE_FENCE.test(l) || RE_HEAD.test(l) || RE_RULE.test(l) || RE_QUOTE.test(l) || RE_LI.test(l) || RE_ROW.test(l);

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function tableEl(rows) {
  const w = el("div", "tblwrap");
  const head = cells(rows[0]);
  let h = "<table><thead><tr>" + head.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>";
  h += rows.slice(2).map((r) => "<tr>" + cells(r).map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("");
  h += "</tbody></table>";
  w.innerHTML = h;
  return w;
}

/* Code wraps rather than scrolls (SPEC §4), and a wrapped line has to stay
   distinguishable from a real one — so each SOURCE line is its own block box
   carrying a hanging indent (`.cline` in base.css), and the continuations of a
   long line sit one step in from the lines around them.

   Two properties this must not lose:
     - the highlighter is line-local by construction (HL_RE excludes `\n` in
       every alternative), so highlighting each line on its own is byte-for-byte
       what highlighting the whole block produced;
     - the trailing "\n" stays INSIDE each line's span, so `pre.textContent` is
       still the source verbatim. Blocks that merely stack would join the lines
       and a DOM-side reader (or a selection copy on a browser that trusts the
       text rather than the layout) would silently lose every newline. A
       preserved newline at the end of a block box costs no extra line box —
       measured, not assumed. */
function codeEl(lang, src) {
  const w = el("div", "code");
  const bar = el("div", "code-bar", '<span class="lang">' + esc(lang || "text") + "</span>");
  const copy = el("button", "btn sm", I.copy + " Copy");
  copy.style.marginLeft = "auto";
  copy.addEventListener("click", () => copyText(src));
  bar.appendChild(copy);
  const pre = el("pre");
  const paint = /^(ts|tsx|js|jsx|javascript|typescript)$/i.test(lang || "") ? hl : esc;
  const lines = String(src).split("\n");
  pre.innerHTML =
    "<code>" +
    lines.map((l, i) => '<span class="cline">' + paint(l) + (i < lines.length - 1 ? "\n" : "") + "</span>").join("") +
    "</code>";
  w.appendChild(bar);
  w.appendChild(pre);
  return w;
}

function listItemEl(doc, raw, lineNo) {
  const t = raw.replace(RE_LI, "");
  const box = /^\[([ xX])\]\s*/.exec(t);
  if (box) {
    const done = box[1].toLowerCase() === "x";
    const li = el("li", "task" + (done ? " done" : ""));
    const cb = el("button", "cb", I.check);
    cb.title = "Toggle task";
    cb.setAttribute("aria-pressed", done ? "true" : "false");
    cb.addEventListener("click", () => toggleTask(doc, lineNo, li));
    const sp = el("span", "tx");
    sp.innerHTML = inline(t.slice(box[0].length));
    li.appendChild(cb);
    li.appendChild(sp);
    return li;
  }
  const li = el("li", "bul");
  const sp = el("span", "tx");
  sp.innerHTML = inline(t);
  li.appendChild(sp);
  return li;
}

/* rewrite one source line, flip the box in place, then persist it */
function toggleTask(doc, lineNo, li) {
  const lines = doc.markdown.split("\n");
  const l = lines[lineNo];
  if (l == null) return;
  const wasDone = /^\s*[-*+]\s+\[[xX]\]/.test(l);
  lines[lineNo] = wasDone ? l.replace(/\[[xX]\]/, "[ ]") : l.replace(/\[ \]/, "[x]");
  doc.markdown = lines.join("\n");
  li.classList.toggle("done", !wasDone);
  const cb = $(".cb", li);
  if (cb) cb.setAttribute("aria-pressed", !wasDone ? "true" : "false");
  markDirty();
  updateMeta();
  saveDoc(doc.path); /* a tick is a decision, not typing — write it now */
}

function renderPreview(doc, host) {
  const md = el("div", "md editable");
  const lines = doc.markdown.split("\n");
  let i = 0;
  let blanks = 0;
  /* how many copies of each armor body have been rendered already: two
     identical fences are two separate blocks, and their ordinal is what tells
     them apart everywhere downstream (`revealKey`, `replaceArmorInDoc`) */
  const fenceOrd = new Map();

  /* every top-level block remembers the source line it came from — that
     mapping is what click-to-edit rides on. `blanks` is how many blank source
     lines were skipped just above; the first is the ordinary block separator
     and is already paid for by the CSS block gap, each further one buys a body
     line-box, emitted as a .bgap element so the source's rhythm survives. */
  const put = (node, line) => {
    if (md.firstChild && blanks > 1) {
      const sp = el("div", "bgap");
      sp.setAttribute("aria-hidden", "true");
      sp.style.height = "calc(" + (blanks - 1) + " * var(--d-font) * var(--d-lh))";
      md.appendChild(sp);
    }
    blanks = 0;
    node.dataset.line = line;
    md.appendChild(node);
    return node;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      blanks++;
      i++;
      continue;
    }
    const start = i;

    if (RE_FENCE.test(line)) {
      const lang = line.replace(RE_FENCE, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      const body = buf.join("\n");
      let node;
      if (lang === "age") {
        const ord = fenceOrd.get(body) || 0;
        fenceOrd.set(body, ord + 1);
        node = secretEl(doc.path, body, (/^[ \t>]*/.exec(line) || [""])[0], ord);
      } else node = codeEl(lang, body);
      put(node, start);
      continue;
    }

    const h = RE_HEAD.exec(line);
    if (h) {
      const n = el("h" + h[1].length);
      n.innerHTML = inline(h[2].trim());
      put(n, start);
      i++;
      continue;
    }

    if (RE_RULE.test(line)) {
      put(el("div", "divider"), start);
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const q = el("blockquote");
      q.innerHTML = inline(buf.join(" "));
      put(q, start);
      continue;
    }

    if (RE_ROW.test(line) && i + 1 < lines.length && RE_ALIGN.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && RE_ROW.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      put(tableEl(rows), start);
      continue;
    }

    if (RE_LI.test(line)) {
      const ul = el("ul");
      while (i < lines.length && RE_LI.test(lines[i])) {
        const li = listItemEl(doc, lines[i], i);
        li.dataset.line = i;
        ul.appendChild(li);
        i++;
      }
      put(ul, start);
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    const p = el("p");
    p.innerHTML = inline(buf.join(" "));
    put(p, start);
  }

  host.appendChild(md);
}

/* ============================================================
   SECRETS — the client half of SPEC §6

   Everything cryptographic happens in ./crypto-worker.js. This file owns the
   UI and the document model and holds NO key material: it can ask the worker
   to decrypt one block, to encrypt one string, or to lock — and nothing else.

   `vault.state`:
     unknown  — not probed yet
     disabled — no secure context / no WebCrypto / worker or bundle failed;
                blocks render armored with a badge that explains why (SPEC §6
                degradation), and the rest of the app is untouched
     none     — supported, but this vault has no identity yet
     repair   — .znotes/identity.age exists but .znotes/vault.pub does not.
                Unlocking derives the recipient and rewrites the missing file;
                WITHOUT this state the vault is permanently wedged, because
                "create" 409s on the existing identity and nothing else opens
                the unlock modal
     orphan   — the MIRROR of `repair`, and the one vault.ts calls
                "unrecoverable data-loss-by-encryption": .znotes/vault.pub is
                readable but .znotes/identity.age is gone (a crash inside
                `writeVaultKeys`'s replace window, a partial checkout, a tidied
                `.znotes/`). Nothing in the app can open a block here, and the
                state has to SAY so: reported as "ready" it printed the name of
                a file that is not on disk, then answered Unlock with "no
                identity yet" and Create with `409 exists` — two contradictory
                refusals and no way out. The stashed key, if a change was
                interrupted, is `.znotes/identity.age.prev`
     ready    — identity exists (locked or unlocked)
   ============================================================ */
const vault = {
  state: "unknown",
  reason: "",
  recipient: null,
  /* the recipient the worker DERIVED from identity.age this session, or null.
     Only this one is known to pair with the vault's identity. */
  verified: null,
  /* latched the moment `.znotes/vault.pub` changes under a running session:
     both keyring files are tracked and pushed, so a pull — or anyone with
     write access to the remote — can move the recipient. Blocks new
     encryption until an unlock proves the new key pairs with identity.age. */
  keyringChanged: false,
  pendingRecipient: null,
  unlocked: false,
  worker: null,
  seq: 0,
  waits: new Map(),
  boot: null,
};

function disableSecrets(reason) {
  vault.state = "disabled";
  vault.reason = reason;
  if (vault.worker) {
    try {
      vault.worker.terminate();
    } catch (e) {}
    vault.worker = null;
  }
  console.warn("[z-notes] secrets disabled:", reason);
  /* the toolbar's encrypt affordance is part of "disabled" too — a live button
     that can only produce an error toast is the dead-button failure mode the
     block rendering was carefully built to avoid (SPEC §6) */
  syncModeUI();
  return vault;
}

/* ---------- [secrets] → the worker's auto-lock policy ----------
   The worker owns the timers; the server owns the numbers. This is the one
   translation between them, in ONE place so the units cannot drift. Applied at
   init and again on every settings save — an unlocked session picks a shorter
   idle timeout up on the next tick, without a reload. */
function lockPolicy() {
  return {
    idleMs: settingAt("secrets.idleLockMinutes") * 60 * 1000,
    hiddenMs: settingAt("secrets.hiddenLockMinutes") * 60 * 1000,
    hardCapMs: settingAt("secrets.sessionHours") * 60 * 60 * 1000,
  };
}

/** Seconds a copied secret may sit on the clipboard (`secrets.clipboardClearSeconds`). */
function clipboardSeconds() {
  return settingAt("secrets.clipboardClearSeconds");
}

/** Push the current policy at a worker that may not exist yet — never throws. */
function applyLockPolicy() {
  if (!vault.worker) return Promise.resolve(null);
  return secretsCall("configure", { policy: lockPolicy() }).catch(() => null);
}

function secretsCall(op, args) {
  return new Promise((resolve, reject) => {
    if (!vault.worker) return reject(new Error(vault.reason || "Secrets features are unavailable."));
    const id = ++vault.seq;
    /* scrypt at logN=18 is ~1s; 60s is "the worker is wedged", not "slow" */
    const t = setTimeout(() => {
      vault.waits.delete(id);
      reject(new Error("The crypto worker did not answer."));
    }, 60000);
    vault.waits.set(id, { resolve, reject, t });
    vault.worker.postMessage(Object.assign({ id, op }, args || {}));
  });
}

function settleWorker(id, ok, payload) {
  const w = vault.waits.get(id);
  if (!w) return;
  vault.waits.delete(id);
  clearTimeout(w.t);
  if (ok) w.resolve(payload);
  else {
    const e = new Error((payload && payload.message) || "Crypto worker error");
    e.code = payload && payload.code;
    w.reject(e);
  }
}

/* Written from the CURRENT `[secrets]` policy, not from a constant: a toast
   that says "idle for 15 minutes" to someone who configured two is a lie about
   the one part of the app whose whole job is being trustworthy. */
const plural = (n, unit) => n + " " + unit + (n === 1 ? "" : "s");

function lockReason(reason) {
  return {
    idle: "idle for " + plural(settingAt("secrets.idleLockMinutes"), "minute"),
    hidden: "tab hidden for " + plural(settingAt("secrets.hiddenLockMinutes"), "minute"),
    "session-expired": plural(settingAt("secrets.sessionHours"), "hour") + " session limit",
    "other-tab": "locked in another tab",
    manual: "",
    pagehide: "",
    cancelled: "unlock cancelled",
  }[reason];
}

/** Feature-detect once, boot the worker once. Never throws. */
function initSecrets() {
  if (vault.boot) return vault.boot;
  vault.boot = (async () => {
    if (!window.isSecureContext)
      return disableSecrets(
        "This page is not a secure context, so the browser withholds WebCrypto. Serve z-notes over HTTPS (or localhost) to unlock secret blocks."
      );
    if (!(window.crypto && window.crypto.subtle))
      return disableSecrets("crypto.subtle is unavailable in this browser, so nothing can be decrypted here.");
    if (typeof Worker === "undefined")
      return disableSecrets("Web Workers are unavailable, and all z-notes crypto runs inside one.");

    let identityPresent = false;
    try {
      /* BOTH files, always. Either one missing is a real state with its own
         recovery, and neither can be inferred from the other: a missing
         vault.pub does not mean "no vault" (writeVaultKeys documents a window
         where identity.age lands first), and a readable vault.pub does not
         mean the identity is there — asking only when the recipient was
         missing is what let the keyring line name a file nobody had looked
         for. Two GETs at boot, off the critical path either way. */
      const [r, id] = await Promise.all([api.getVaultRecipient(), api.getVaultIdentity()]);
      vault.recipient = r && r.recipient ? r.recipient : null;
      identityPresent = !!id;
    } catch (err) {
      return disableSecrets("The vault keyring could not be read: " + (err.message || err));
    }

    try {
      vault.worker = new Worker(new URL("./crypto-worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      return disableSecrets("The crypto worker could not start: " + (err.message || err));
    }
    vault.worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "event") return onWorkerEvent(m);
      settleWorker(m.id, !!m.ok, m.ok ? m.result : m.error);
    };
    vault.worker.onerror = (ev) => {
      const why = (ev && ev.message) || "the worker script failed to load";
      for (const id of [...vault.waits.keys()]) settleWorker(id, false, { code: "worker-error", message: why });
      disableSecrets("The crypto worker failed: " + why);
      repaintSecretsUI();
    };

    try {
      await secretsCall("init", { recipient: vault.recipient, policy: lockPolicy() });
    } catch (err) {
      return disableSecrets("The age bundle could not be loaded: " + (err.message || err));
    }

    vault.state = identityPresent
      ? vault.recipient
        ? "ready"
        : "repair"
      : vault.recipient
        ? "orphan"
        : "none";
    return vault;
  })();
  return vault.boot;
}

function onWorkerEvent(m) {
  if (m.event === "unlocked") {
    vault.unlocked = true;
    /* the worker only emits this after deriving the recipient from the
       unwrapped identity, so `m.recipient` is a VERIFIED one */
    if (m.verified && m.recipient) vault.verified = m.recipient;
    paintVaultChip();
    /* THE reveal trigger. Whichever door the passphrase came through — a
       block's Unlock, the topbar, Settings › Secrets, a first-run create —
       ends here, so every one of them reveals the whole document. */
    repaintSecretsUI();
  } else if (m.event === "locked") {
    onVaultLocked(m.reason || "manual");
  }
}

/** The vault locked (idle, hidden, another tab, or on purpose). Re-encrypt
    anything edited, then drop every plaintext this tab holds. */
async function onVaultLocked(reason) {
  vault.unlocked = false;
  /* Before the awaits below, not after: a decrypt already with the worker must
     not land plaintext back into a locked vault while this function is off
     re-encrypting an edit. */
  dropRevealsInFlight();
  /* Locking must CLEAR the clipboard, not merely cancel the timer that would
     have cleared it: "copy the secret, paste it, re-lock" is the most natural
     flow there is, and cancelling the clear left the plaintext on the system
     clipboard forever (research §6, "Clipboard"). */
  clearClipboardNow();
  /* THE WIPE COMES FIRST (SPEC §84). Re-encrypting an edit is a round trip to
     the worker and then a PUT with no deadline of its own, and locking used to
     await both BEFORE clearing the screen: a wedged or suspended server left
     the decrypted plaintext sitting in an open editor indefinitely — measured
     unchanged 30s after an idle lock — which is the exact moment the screen is
     unattended. The dirty entries are snapshotted, the display goes blank
     synchronously, and the ciphertext is written from the snapshot afterwards. */
  const pending = new Map();
  for (const e of state.reveal.values()) {
    if (!e.dirty) continue;
    if (!pending.has(e.path)) pending.set(e.path, []);
    pending.get(e.path).push(e);
  }
  state.reveal.clear();
  paintVaultChip();
  repaintSecretsUI();
  const why = lockReason(reason);
  toast(why ? "Vault locked — " + why : "Vault locked");
  for (const [p, ents] of pending) {
    try {
      await flushSecretEdits(state.docs.get(p), ents);
      await saveDoc(p, { silent: true });
    } catch (e) {}
  }
}

function repaintSecretsUI() {
  if (state.mode !== "preview") return;
  $$("#doc .secret").forEach((w) => {
    if (w.zSecret) repaintSecret(w);
  });
}

async function lockVault(reason) {
  if (!vault.worker) return;
  try {
    await secretsCall("lock", { reason: reason || "manual" });
  } catch (e) {}
}

/* The one sentence every entry point into secrets says about `orphan`, so the
   keyring line, the unlock modal, the passphrase change and the encrypt
   gesture cannot drift into contradicting each other — which is precisely what
   this state used to do. */
const ORPHAN_WHY =
  ".znotes/identity.age is missing, so nothing here can open — or safely create — a block in this vault. " +
  "Restore it from .znotes/identity.age.prev (an interrupted passphrase change stashes the old key there), " +
  "from a backup, or from git history.";

/** Ensure the worker holds the identity, prompting for the passphrase if not.
    Resolves true when a subsequent `decrypt` can succeed. */
function ensureUnlocked() {
  return new Promise(async (resolve) => {
    await initSecrets();
    if (vault.state === "disabled") {
      toast(vault.reason);
      return resolve(false);
    }
    if (vault.state === "none") {
      askCreate();
      return resolve(false);
    }
    /* the mirror of "repair": there is no identity to unwrap, and `create`
       would 409 on the recipient that IS there — so neither modal is offered */
    if (vault.state === "orphan") {
      toast(ORPHAN_WHY);
      return resolve(false);
    }
    /* "repair" has an identity — the passphrase is the way in, not a new key */
    if (vault.unlocked) return resolve(true);
    askPass(resolve);
  });
}

function paintVaultChip() {
  const chip = $("#stVault");
  if (chip) chip.hidden = !vault.unlocked;
  paintVaultKey();
}

/* ============================================================
   VAULT KEY — Settings › Secrets (SPEC §6, research §5.3)

   Two things live here and nothing else: the truth about this vault's keyring,
   and the ONE key operation that is safe to run from a settings panel.

   CHANGE PASSPHRASE re-wraps the SAME age identity under a new passphrase. The
   key does not change, `vault.pub` does not change, and no block in the corpus
   is touched — which is precisely what makes it routine. The other operation
   research §5.3 names, ROTATE VAULT KEY, is a corpus-wide decrypt-and-re-encrypt
   pass and is deliberately NOT offered: a half-finished rotation is a vault
   whose blocks are encrypted to two different keys, and a settings button is
   the wrong shape for something that must either complete or roll back.

   Nothing in this flow gives the server a passphrase. `rewrap` runs in the
   crypto worker, the plaintext identity never leaves it, and what goes over the
   wire is the same thing that was already on disk: passphrase-wrapped armor.
   ============================================================ */

/** The keyring status line + the state of the change-passphrase control. */
function paintVaultKey() {
  const line = $("#keyState");
  const txt = $("#keyStateTxt");
  if (!line || !txt) return;

  const st = vault.state;
  const usable = st === "ready" || st === "repair";
  line.classList.toggle("off", st === "disabled" || st === "none" || st === "orphan");
  line.classList.toggle("locked", usable && !vault.unlocked);
  line.classList.toggle("unlocked", usable && vault.unlocked);

  const who = vault.recipient ? " · " + vault.recipient : "";
  txt.textContent =
    st === "disabled"
      ? "Secrets are unavailable here — " + (vault.reason || "no secure context.")
      : st === "none"
      ? "No vault key yet. Encrypt a selection (⌃⇧E) to create one."
      : st === "repair"
      ? ".znotes/identity.age is present but .znotes/vault.pub is missing — unlock once to rebuild it."
      : st === "orphan"
      ? ".znotes/vault.pub is present but .znotes/identity.age is MISSING — nothing here can open a block. " +
        "If a passphrase change was interrupted, the key is still in .znotes/identity.age.prev: rename it back to " +
        ".znotes/identity.age. Otherwise restore identity.age from a backup or from git history." +
        who
      : (vault.unlocked ? "Unlocked" : "Locked") +
        " · .znotes/identity.age + .znotes/vault.pub" +
        who +
        (vault.verified && vault.verified === vault.recipient ? " · verified this session" : "");

  const lockBtn = $("#keyLockBtn");
  if (lockBtn) lockBtn.hidden = !vault.unlocked;
  /* the change control needs an identity to re-wrap; there is nothing to
     change before one exists, and nothing to change if crypto is unavailable */
  const on = usable;
  ["keyCurrent", "keyNew", "keyConfirm", "keyGen", "keyChangeBtn"].forEach((id) => {
    const n = $("#" + id);
    if (n) n.disabled = !on;
  });
}

/* The markup ships the default; this is where it is remembered, captured on
   first use and before anything has overwritten it. Copying the sentence into
   this file gave the same user-facing string two homes with nothing checking
   they agreed — which the sibling `#termPwHint` proves is not hypothetical:
   its HTML and JS copies have already drifted. */
let keyHintDefault = null;

function keyHint(text, bad) {
  const n = $("#keyPassHint");
  if (!n) return;
  if (keyHintDefault === null) keyHintDefault = n.innerHTML;
  if (!text) {
    n.innerHTML = keyHintDefault;
    n.classList.remove("bad");
    return;
  }
  n.textContent = text;
  n.classList.toggle("bad", !!bad);
}

/**
 * Change the vault passphrase.
 *
 * Current → unwrap in the worker → re-wrap the same identity under the new one
 * → `PUT /api/vault/identity {replace:true}`. The recipient written back is the
 * one the worker DERIVED from the identity it just unwrapped, never the one the
 * client happened to be holding — so a `vault.pub` that had drifted cannot be
 * laundered into the keyring by a passphrase change.
 */
/** The three passphrase fields, emptied. The settings page is a CSS route
    change and is never unmounted, so anything left in an input lives for the
    rest of the session and is one `getElementById().value` away from anything
    with script access — the same rule `closePP` states for the modal: the
    passphrase leaves the DOM the moment the thing that asked for it does. */
function clearKeyFields() {
  clearSecretInputs(["keyCurrent", "keyNew", "keyConfirm"]);
}

/** The terminal's three secret inputs — the new password, the current one it is
    replacing, and the unlock field. Same rule and the same reason as the
    passphrase fields above: `setDraft` deliberately excludes the terminal
    password from the draft because "an unsaved secret held longer than it needs
    to be" is a cost, and a page that is never unmounted was holding it for the
    whole tab. They used to be blanked only by a SUCCESSFUL submit, so an
    abandoned password outlived leaving Settings — and was silently resubmitted
    if the user came back and pressed Change. */
function clearTerminalSecretFields() {
  clearSecretInputs(["termNew", "termCurrent", "termPass"]);
}

function clearSecretInputs(ids) {
  ids.forEach((id) => {
    const n = $("#" + id);
    if (!n) return;
    n.value = "";
    /* a generated passphrase is shown in the clear (see the #keyGen handler);
       an empty field goes straight back to being a credential field */
    n.classList.add("masked");
  });
}

async function changeVaultPassphrase() {
  const cur = $("#keyCurrent").value;
  const next = $("#keyNew").value;
  const confirm = $("#keyConfirm").value;
  /* every early return below leaves the fields alone ON PURPOSE: the user is
     being asked to correct what they typed, so it has to still be there. What
     must not survive is a FINISHED attempt, which is what the `finally` does. */
  if (!cur) return keyHint("Enter the current passphrase — it is what unwraps the identity.", true);
  if (!next) return keyHint("Enter the new passphrase.", true);
  if (next !== confirm) return keyHint("The two new passphrases do not match.", true);
  if (next === cur) return keyHint("That is the passphrase you already have.", true);
  /* the same floor `createIdentity` enforces — a change is not a way around it */
  const bits = estimateBits(next);
  if (bits < MIN_BITS)
    return keyHint(
      "Too weak (~" + bits + " bits). Use Generate, or a longer passphrase — " + MIN_BITS + " bits minimum.",
      true
    );

  const btn = $("#keyChangeBtn");
  btn.disabled = true;
  keyHint("Unwrapping and re-wrapping the identity (scrypt, ~2s)…", false);
  try {
    await initSecrets();
    const armor = await api.getVaultIdentity();
    if (!armor) {
      vault.state = vault.recipient ? "orphan" : "none";
      paintVaultKey();
      return keyHint(vault.recipient ? ORPHAN_WHY : "This vault has no identity to re-wrap.", true);
    }
    const made = await secretsCall("rewrap", { identity: armor, current: cur, next: next });
    await api.putVaultIdentity(made.identity, made.recipient, true);
    vault.recipient = made.recipient;
    vault.verified = made.recipient;
    vault.state = "ready";
    paintVaultKey();
    keyHint("");
    toast("Vault passphrase changed · the key is unchanged, so every block still decrypts");
  } catch (err) {
    keyHint(err.message || "The passphrase could not be changed", true);
  } finally {
    /* success, refusal or crash: the attempt is over, so the passphrases go.
       Only the success path used to clear them, which left a wrong passphrase
       — and the new one beside it — readable in the DOM until the tab reloaded. */
    clearKeyFields();
    btn.disabled = false;
    paintVaultKey();
  }
}

/* ---------- passphrase modal (the prototype's #ppVeil, both modes) ---------- */

let ppMode = "unlock";
let ppResolve = null;
/* Bumped every time the modal opens or closes. scrypt at logN=18 runs for ~1s
   AFTER the user can press Esc, and a dismissed modal whose security-relevant
   action completes anyway is not a dismissal — it is a delayed unlock nobody
   asked for. `doPassphraseOk` compares this across the await. */
let ppEpoch = 0;

function ppSettle(v) {
  const fn = ppResolve;
  ppResolve = null;
  if (fn) fn(v);
}

function closePP() {
  ppEpoch++;
  $("#ppVeil").classList.remove("show");
  /* the passphrase leaves the DOM the moment the modal does */
  $("#ppInput").value = "";
  $("#ppConfirm").value = "";
  ppSettle(false);
}

function openPP(mode) {
  ppEpoch++;
  ppMode = mode;
  const create = mode === "create";
  $("#ppTitle").textContent = create ? "Create vault identity" : "Unlock secret block";
  $("#ppPath").textContent = create ? ".znotes/identity.age" : vault.recipient || "age identity";
  $("#ppSub").textContent = create
    ? "a new age key pair, wrapped under this passphrase"
    : "unwraps .znotes/identity.age · scrypt";
  $("#ppInput").value = "";
  $("#ppConfirm").value = "";
  $("#ppConfirmRow").hidden = !create;
  $("#ppGen").hidden = !create;
  $("#ppOkTxt").textContent = create ? "Create" : "Unlock";
  $("#ppHint").textContent = create
    ? "Generate one, or type at least 60 bits' worth. There is no recovery: lose it and the blocks stay encrypted forever."
    : "Decrypted in the crypto worker; never sent to the server.";
  $("#ppHint").className = "note";
  $("#ppVeil").classList.add("show");
  setTimeout(() => $("#ppInput").focus(), 120);
}

function askPass(resolve) {
  ppSettle(false);
  ppResolve = resolve || null;
  openPP("unlock");
}

function askCreate() {
  ppSettle(false);
  openPP("create");
}

/* estimateBits / WORDS / generatePassphrase now live in ./entropy.js — the
   gate they implement is security-critical and needs its own unit tests. */

async function doPassphraseOk() {
  const pass = $("#ppInput").value;
  if (ppMode === "create") return createIdentity(pass, $("#ppConfirm").value);
  if (!pass) {
    ppHint("Enter the vault passphrase.", true);
    return;
  }
  const btn = $("#ppOk");
  btn.disabled = true;
  const epoch = ppEpoch;
  ppHint("Deriving the key (scrypt, ~1s)…", false);
  try {
    const armor = await api.getVaultIdentity();
    if (!armor) {
      /* "no identity yet" is only true when there is no keyring at all. With a
         recipient still on disk this is `orphan`, and saying "yet" sent the
         user to a Create that the server 409s. */
      vault.state = vault.recipient ? "orphan" : "none";
      paintVaultKey();
      ppHint(vault.recipient ? ORPHAN_WHY : "This vault has no identity yet.", true);
      return;
    }
    if (vault.keyringChanged && vault.pendingRecipient) {
      /* a legitimate rotation pulls a NEW identity.age beside the new
         vault.pub, so verify the fetched identity against the CLAIMED
         recipient. The worker refuses this outright if it already verified a
         different one — a substitution mid-session is not a rotation. */
      try {
        await secretsCall("setRecipient", { recipient: vault.pendingRecipient });
      } catch (e) {
        ppHint(e.message || "The vault recipient changed — reload before unlocking.", true);
        return;
      }
    }
    const st = await secretsCall("unlock", { identity: armor, passphrase: pass });
    /* Esc (or any other dismissal) during the derive means CANCELLED. The
       worker now holds the key, so undoing it takes an explicit lock — merely
       skipping the UI update would leave a silently unlocked vault. */
    if (epoch !== ppEpoch) {
      await lockVault("cancelled");
      return;
    }
    $("#ppVeil").classList.remove("show");
    $("#ppInput").value = "";
    vault.unlocked = true;
    if (st && st.recipient && st.verified) {
      vault.verified = st.recipient;
      /* the unwrapped identity DERIVED this recipient, so the file that
         claimed it is confirmed and encryption may resume */
      if (vault.keyringChanged && st.recipient === vault.pendingRecipient) {
        vault.recipient = st.recipient;
        vault.keyringChanged = false;
        vault.pendingRecipient = null;
        toast("Keyring confirmed: .znotes/vault.pub matches this vault's identity");
      }
    }
    /* "repair": identity.age was there, vault.pub was not. The worker derived
       the real recipient from the identity it just unwrapped — write it back
       so the vault stops being a dead end (and so encrypt works again). */
    if (st && st.recipient && !vault.recipient) await repairRecipient(armor, st.recipient);
    paintVaultChip();
    /* the blocks are NOT repainted here: the worker's `unlocked` event already
       did it (onWorkerEvent), and that is the one trigger every unlock door
       shares. A second one here would be a second reveal path. */
    toast("Vault unlocked");
    ppSettle(true);
  } catch (err) {
    ppHint(err.message || "Unlock failed", true);
    $("#ppInput").select();
  } finally {
    btn.disabled = false;
  }
}

function ppHint(text, bad) {
  const n = $("#ppHint");
  n.textContent = text;
  n.className = bad ? "note bad" : "note";
}

/**
 * Rewrite a missing `.znotes/vault.pub` from the recipient the worker derived
 * out of the identity it just unwrapped. `replace:true` is safe here and only
 * here: the identity we are re-declaring is byte-for-byte the one already on
 * disk, and the recipient is derived from it rather than taken on trust.
 */
async function repairRecipient(identityArmor, recipient) {
  try {
    await api.putVaultIdentity(identityArmor.trim(), recipient, true);
    vault.recipient = recipient;
    vault.state = "ready";
    toast("Rebuilt .znotes/vault.pub from the vault identity");
  } catch (err) {
    toast("The vault recipient could not be rebuilt: " + (err.message || err));
  }
}

async function createIdentity(pass, confirm) {
  const bits = estimateBits(pass);
  if (!pass || bits < MIN_BITS) {
    ppHint("Too weak (~" + bits + " bits). Use the generator or a longer passphrase — " + MIN_BITS + " bits minimum.", true);
    return;
  }
  if (pass !== confirm) {
    ppHint("The two passphrases do not match.", true);
    return;
  }
  const btn = $("#ppOk");
  btn.disabled = true;
  ppHint("Generating the key and wrapping it (scrypt, ~1s)…", false);
  try {
    const made = await secretsCall("generate", { passphrase: pass });
    await api.putVaultIdentity(made.identity, made.recipient, false);
    vault.recipient = made.recipient;
    vault.verified = made.recipient; // derived from the identity we just made
    vault.state = "ready";
    await secretsCall("setRecipient", { recipient: made.recipient });
    $("#ppVeil").classList.remove("show");
    $("#ppInput").value = "";
    $("#ppConfirm").value = "";
    repaintSecretsUI();
    toast("Vault identity created · " + made.recipient.slice(0, 16) + "…");
  } catch (err) {
    ppHint(
      err.code === "exists"
        ? "This vault already has an identity — unlock it with its passphrase instead of creating a new one."
        : err.message || "Could not create the identity",
      true
    );
  } finally {
    btn.disabled = false;
  }
}

/* ---------- re-encryption (the only path that rewrites armor) ---------- */

/* indentArmor / dedentArmor / isArmorShape live in ./armor.js — the write path
   and the read path have to agree byte for byte about what a fence body is. */

/** Where the `ord`-th copy of `armor` starts in `md`, or -1. The armor is ~200
    bytes of ciphertext, so a content match is a stronger identifier than a line
    number — which drifts the moment anything above the block changes — but it
    is NOT a unique one: copy a fence to make a staging/prod pair and the
    document holds the same bytes twice. The ordinal is the rest of the
    identity (see `revealKey`). */
function armorOffset(md, armor, ord) {
  let at = md.indexOf(armor);
  for (let n = ord || 0; n > 0 && at >= 0; n--) at = md.indexOf(armor, at + armor.length);
  return at;
}

/** Swap ONE block's armor inside the markdown: the `ord`-th copy, not simply
    the first one `indexOf` lands on. Matching on content alone rewrote the
    wrong fence whenever a document held the same ciphertext twice — the edit
    landed on the other block and that block's own content was destroyed, both
    silently, under a "Saved to disk" toast.
    @returns the offset the swap happened at, or -1 if the block is gone. */
function replaceArmorInDoc(doc, oldArmor, newArmor, ord) {
  const at = armorOffset(doc.markdown, oldArmor, ord);
  if (at < 0) return -1;
  doc.markdown = doc.markdown.slice(0, at) + newArmor + doc.markdown.slice(at + oldArmor.length);
  return at;
}

/** Rebuild this path's reveal keys from the entries themselves. An armor swap
    moves a block's identity (new armor, and the copies after it move up one
    place), and `state.reveal` is keyed by that identity. */
function rekeyReveals(path) {
  const ents = [];
  for (const [k, e] of state.reveal) {
    if (e.path !== path) continue;
    ents.push(e);
    state.reveal.delete(k);
  }
  for (const e of ents) state.reveal.set(revealKey(path, e.armor, e.ord), e);
}

/**
 * Turn every EDITED revealed block back into armor, in the document model,
 * before anything can serialize it. Unedited reveals are not touched: their
 * armor goes out byte for byte (research §4.2).
 *
 * `entries` is the lock path's snapshot: locking wipes `state.reveal` FIRST
 * (the screen must go blank before the network, SPEC §84) and hands the dirty
 * entries here afterwards. Entries that are no longer in the map are flushed
 * into the document and into the live nodes, but never put back into it — a
 * locked vault holds no plaintext.
 */
async function flushSecretEdits(doc, entries) {
  if (!doc) return;
  const dirty = [];
  if (entries) {
    for (const e of entries) if (e && e.dirty && e.path === doc.path) dirty.push(e);
  } else {
    for (const e of state.reveal.values()) if (e.path === doc.path && e.dirty) dirty.push(e);
  }
  if (!dirty.length) return;
  for (const e of dirty) {
    const prev = e.armor;
    const prevOrd = e.ord || 0;
    /* what we are ENCRYPTING, snapshotted before the await: anything typed
       during the worker round-trip is not in this ciphertext, and clearing
       `dirty` for it would drop the keystrokes on the floor */
    const sent = e.plain;
    let out;
    try {
      out = await secretsCall("encrypt", { plaintext: sent });
    } catch (err) {
      toast("Could not re-encrypt a secret block — nothing was saved");
      throw err;
    }
    const next = indentArmor(out.armor, e.indent);
    const at = replaceArmorInDoc(doc, prev, next, prevOrd);
    if (at < 0) {
      /* The block is simply GONE from the document — deleted in Raw, replaced
         by a proposal, overwritten from disk. That is an ordinary thing to do,
         and the old behaviour (throw, and let saveDoc swallow it) wedged every
         subsequent save of this doc for the rest of the session and then lost
         the buffer on the next navigation. Drop the orphan and keep going. */
      state.reveal.delete(revealKey(doc.path, prev, prevOrd));
      toast("A revealed secret block is no longer in this document — its edit could not be re-attached");
      continue;
    }
    /* which copy of the NEW armor this is (age is nondeterministic, so this is
       0 — asked rather than assumed) */
    let nextOrd = 0;
    for (let hit = doc.markdown.indexOf(next); hit >= 0 && hit < at; hit = doc.markdown.indexOf(next, hit + next.length)) nextOrd++;
    /* every later copy of `prev` just moved up one place */
    const seen = new Set(state.reveal.values());
    for (const o of dirty) seen.add(o);
    for (const o of seen) {
      if (o !== e && o.path === doc.path && o.armor === prev && (o.ord || 0) > prevOrd) o.ord = (o.ord || 0) - 1;
    }
    /* the live node keeps its identity across the swap, so an open editor is
       not yanked out from under the cursor mid-autosave — and ONLY that node:
       retargeting every node with matching armor handed the untouched twin the
       edited block's new ciphertext */
    $$("#doc .secret").forEach((w) => {
      const c = w.zSecret;
      if (!c || c.path !== doc.path || c.armor !== prev) return;
      if ((c.ord || 0) === prevOrd) {
        c.armor = next;
        c.ord = nextOrd;
      } else if ((c.ord || 0) > prevOrd) c.ord = (c.ord || 0) - 1;
    });
    e.armor = next;
    e.ord = nextOrd;
    /* only clean if the plaintext is still the one we just encrypted */
    e.dirty = e.plain !== sent;
    rekeyReveals(doc.path);
  }
  updateMeta();
  /* the model moved under the Raw textarea — push it back, or the next
     syncRaw() writes the pre-flush armor over what was just saved */
  syncRawFromModel(doc);
}

/* ---------- encrypt a selection (works while LOCKED) ---------- */

/**
 * Re-read `.znotes/vault.pub` and refuse to encrypt to a recipient that has
 * moved under us.
 *
 * Encrypting is the one secrets operation that works while LOCKED (SPEC §6 —
 * the recipient is public), which also means it is the one operation that
 * never touches the unlock-time check that the recipient pairs with
 * `.znotes/identity.age`. Both keyring files are tracked and pushed (SPEC §7),
 * so an ordinary `pull --rebase`, a hand-edit, or anyone with write access to
 * the remote can swap `vault.pub` for a foreign key — after which every new
 * secret is encrypted to a key this vault cannot decrypt and the attacker can.
 * That is silent, permanent data loss plus disclosure, so it blocks.
 */
async function recipientDrifted() {
  let fresh = null;
  try {
    const r = await api.getVaultRecipient();
    fresh = r && r.recipient ? r.recipient : null;
  } catch (e) {
    return false; // offline / 500 is not evidence of a swap
  }
  if (fresh && vault.recipient && fresh !== vault.recipient) {
    /* Do NOT adopt it. The new key is a claim, not a fact, until an identity
       we can unwrap derives it. Latched, so a second ⌘⇧E cannot slip past a
       one-shot warning. */
    vault.keyringChanged = true;
    vault.pendingRecipient = fresh;
  }
  if (!vault.keyringChanged) return false;
  toast(
    "Keyring changed: .znotes/vault.pub is now " +
      (vault.pendingRecipient || "a different key") +
      ". Nothing was encrypted — unlock the vault to confirm this key belongs to it."
  );
  return true;
}

async function encryptSelection() {
  await initSecrets();
  if (vault.state === "disabled") return toast(vault.reason);
  if (vault.state === "none") return askCreate();
  /* the recipient alone is enough to ENCRYPT, which is exactly the trap: every
     block written here would be one nobody can ever open again (vault.ts:
     "unrecoverable data-loss-by-encryption") */
  if (vault.state === "orphan") return toast(ORPHAN_WHY);
  if (vault.state === "repair") {
    /* no recipient on disk: unlocking derives it from the identity and repairs
       the keyring, which is also what makes encryption possible again */
    if (!(await ensureUnlocked())) return;
  }
  if (state.mode !== "raw") return toast("Switch to Raw (⌘E) to encrypt a selection");
  const ta = $("#rawArea");
  const doc = activeDoc();
  if (!ta || !doc) return;
  let from = ta.selectionStart;
  let to = ta.selectionEnd;
  if (from === to) return toast("Select the text to encrypt first");
  /* expand to whole lines: the fence must start at column 0 (research §4.1) */
  const v = ta.value;
  while (from > 0 && v[from - 1] !== "\n") from--;
  while (to < v.length && v[to] !== "\n") to++;
  const plain = v.slice(from, to);
  if (!plain.trim()) return toast("Select the text to encrypt first");
  if (await recipientDrifted()) return;
  try {
    const r = await secretsCall("encrypt", { plaintext: plain });
    const fence = "```age\n" + indentArmor(r.armor, "") + "\n```";
    ta.value = v.slice(0, from) + fence + v.slice(to);
    doc.markdown = ta.value;
    ta.selectionStart = ta.selectionEnd = from + fence.length;
    autoGrow(ta);
    markDirty();
    updateMeta();
    /* the WHOLE recipient, never a prefix: a substituted key differs somewhere,
       and a 16-character prefix is exactly where a swap hides */
    const to_ = r.recipient || vault.recipient || "the vault key";
    toast(r.verified ? "Encrypted to verified key " + to_ : "Encrypted to " + to_ + " (unverified — unlock the vault to confirm it)");
  } catch (err) {
    toast(err.message || "Encryption failed");
  }
}

/* ---------- secret block (SPEC §6) ----------

   The block's source of truth is the ARMOR in doc.markdown. Revealing adds an
   entry to state.reveal and rewrites this one node; it never touches the
   document model. Locking again — or saving — emits the stored armor byte for
   byte unless the plaintext was actually edited (research §4.2, byte
   stability: without that rule every open-and-save produces a fresh file key,
   fresh nonces, and a garbage git diff).

   REVEAL IS VAULT-WIDE, NOT PER BLOCK. The vault has exactly two states and
   the whole app reads the same one: while the worker holds no identity every
   age block is a locked chip showing NOTHING of its ciphertext; the moment it
   holds one, every block in the doc on screen — and in every doc opened after
   — decrypts to plaintext with no further clicks. The per-block Unlock button
   is the ENTRY POINT into that single state, not a per-block permission: a
   passphrase already given is not asked for again, block by block, and a doc
   of eight secrets is not eight clicks. Locking (manual, idle, tab-hidden,
   the hard session cap, or another tab) reverses it everywhere at once. */

/* A block is identified by its ciphertext AND by which copy of it this is.
   Ciphertext alone is not an identity: two identical fences in one document
   (copy a block to make a staging/prod pair) shared one reveal entry, one
   editor state and one re-encrypt target, so editing either one rewrote the
   first fence and destroyed the other's content. `ord` is 0 for the ordinary
   case — every armor in a document is unique — and counts copies otherwise. */
const revealKey = (path, armor, ord) => path + "\0" + (ord || 0) + "\0" + armor;

/* Blocks whose armor FAILED to decrypt, keyed the same way as state.reveal.
   A MAC failure is an integrity alarm (research §4.2: "a line-level three-way
   merge inside an armor block always produces an undecryptable Frankenstein …
   the app must loudly flag" it) — a toast that fades in two seconds while the
   badge keeps saying "Locked / encrypted" is not a flag. Entries live until the
   armor itself changes, because the key IS the armor. */
const secretFailures = new Map();

/* Decrypts IN FLIGHT, keyed exactly the way `state.reveal` is. Every render
   path asks for a reveal (renderDoc, repaintSecret, an SSE reconcile, ⌘E back
   into Preview), so the ask has to be idempotent: one worker round trip per
   block, no matter how many times the block is painted while it is running. */
const revealing = new Set();

/* Bumped by every lock. A decrypt started before the lock cannot be recalled —
   the worker will answer, and it must answer into nothing rather than putting
   plaintext back on screen a beat after the vault closed. */
let revealEpoch = 0;

/** Cancel every in-flight reveal: their answers belong to a vault that is now
    locked. Called from the one place that locks (onVaultLocked). */
function dropRevealsInFlight() {
  revealEpoch++;
  revealing.clear();
}

const secretNote = (text) => {
  const n = el("div", "secret-note");
  n.textContent = text;
  return n;
};

/* How many blanks a masked body draws. A CONSTANT, deliberately: a mask whose
   width or line count tracked the armor would be a readout of the payload —
   the size of a secret is data about the secret. */
const MASK_CELLS = 14;

/**
 * What a block shows INSTEAD of its ciphertext, whether it is locked, awaiting
 * its decrypt, or flagged.
 *
 * A locked block used to render the armor — first inline, then behind a
 * disclosure. Both were wrong for the same reason: several hundred bytes of
 * base64 in the middle of a document READ as an exposed secret, whatever the
 * badge above them said, and a disclosure spanning the doc width in a pane
 * that invites you to click a line is one stray click from the same wall. So
 * the block shows nothing of itself at all — no armor, no header line, no byte
 * or line count. Raw mode (⌘E) is the honest way to see the source, and it is
 * the only one.
 *
 * There are no text nodes in here, so neither `innerText` nor `textContent`
 * can carry a byte of the block, and it is `aria-hidden` because it says
 * nothing the bar above it has not already said out loud.
 */
function maskedBody(pending) {
  const m = el("div", "secret-mask" + (pending ? " pending" : ""));
  m.setAttribute("aria-hidden", "true");
  m.title = pending ? "Decrypting…" : "Ciphertext hidden — press ⌘E for the raw source";
  for (let i = 0; i < MASK_CELLS; i++) m.appendChild(el("i"));
  return m;
}

/**
 * Start this block's decrypt if the vault is open and nothing has answered for
 * it yet. Synchronous up to the worker call, so the render that asked can see
 * its own pending state in `revealing` and paint "Unlocking…" straight away
 * rather than painting a locked chip that flips a few milliseconds later.
 */
function autoReveal(path, armor, indent, ord) {
  const key = revealKey(path, armor, ord);
  if (state.reveal.has(key) || secretFailures.has(key) || revealing.has(key)) return;
  const epoch = revealEpoch;
  revealing.add(key);
  /* Both halves of "this answer still counts": the block is no longer pending,
     and the vault this decrypt was started under is still the open one. A lock
     has already emptied the set, so the delete finds nothing and the epoch
     says why. */
  const settle = () => {
    revealing.delete(key);
    return epoch === revealEpoch;
  };
  /* the DOCUMENT keeps the indented armor (that is the block's identity and
     its byte-stability contract); the decoder gets it dedented */
  secretsCall("decrypt", { armor: dedentArmor(armor) }).then(
    (r) => {
      if (!settle()) return;
      /* plaintext lives exactly as long as the doc that holds it is on screen:
         a decrypt that lands after the user has navigated away has nowhere
         legitimate to be kept, and nothing to repaint. Coming back re-asks. */
      if (path !== viewedPath()) return;
      state.reveal.set(key, { path, armor, indent: indent || "", ord: ord || 0, plain: r.plaintext, dirty: false });
      repaintSecretsAt(path, armor, ord);
    },
    (err) => {
      /* EVERY failure is recorded, classified or not. An unrecognised code —
         the worker's `undecryptable` fallthrough, or a wedge timeout, which
         carries no code at all — used to write nothing, and the repaint below
         then re-entered `secretEl` → `autoReveal` for a key that was in no map
         at all: an unbounded hot retry loop (measured: ~11k decrypts/second)
         with the block stuck on "Unlocking" forever, no Retry button and no
         integrity alarm. The record is what makes the loop impossible — it is
         the guard `autoReveal` bails on. */
      if (!settle()) return;
      /* One bad block is one bad block. It keeps its own flagged, sticky
         classification and every other block in the doc reveals regardless —
         a merged-to-death block must not hold the rest of the file hostage. */
      const st = FAIL_STATES[(err && err.code) || ""] || FAIL_STATES.unknown;
      secretFailures.set(key, st);
      repaintSecretsAt(path, armor, ord);
      /* the block itself carries the verdict from here on; the toast is for
         the integrity alarms only, and the failure is sticky so it fires once */
      toast((err && err.message) || "Decryption failed");
    }
  );
}

function secretEl(docPath, armor, indent, ord) {
  const key = revealKey(docPath, armor, ord);
  const entry = state.reveal.get(key);
  const open = !!entry;
  const off = vault.state === "disabled";
  /* the keyring is there but the private half is not: the block IS encrypted
     and there is no way to open it, so it must not offer one */
  const orphan = vault.state === "orphan";
  /* the fence says `age`; the body decides whether that is TRUE. An unparseable
     body is plaintext sitting in a block the UI would otherwise certify as
     encrypted — and gitSync would then commit it under that badge. */
  const bad = !open && !isArmorShape(armor);
  const failed = !open && !bad ? secretFailures.get(key) || null : null;
  /* The vault is open and this block has not answered yet. Asked for HERE, in
     the one function every render path funnels through, so a block cannot be
     painted into existence without its reveal being under way — and because
     `autoReveal` registers synchronously, this paint already knows about it
     and goes straight to "Unlocking…" instead of showing a locked chip that
     flips a frame later. */
  if (!open && !bad && !failed && vault.unlocked) autoReveal(docPath, armor, indent, ord);
  const pending = !open && !bad && !failed && revealing.has(key);
  const w = el("div", "secret" + (open ? " open" : "") + (pending ? " revealing" : "") + (bad || failed ? " flagged" : ""));
  w.zSecret = { path: docPath, armor, indent: indent || "", ord: ord || 0 };

  const sub = open
    ? "decrypted in memory"
    : bad
      ? "NOT ENCRYPTED — this fence body is not age armor"
      : failed
        ? failed.subtitle
        : pending
          ? "decrypting…"
          : off
            ? "unavailable here"
            : orphan
              ? "encrypted — .znotes/identity.age is missing"
              : "encrypted";
  const bar = el("div", "secret-bar");
  bar.innerHTML =
    '<span class="secret-ico">' + (open || pending ? I.unlock : I.lock) + "</span>" +
    '<span style="min-width:0"><span class="secret-t">Secret block</span>' +
    '<span class="secret-s" style="display:block">age · x25519 · ' +
    esc(sub) +
    "</span></span>";
  const badge = el(
    "span",
    "badge " + (open ? "unlock" : bad || failed || off ? "warn" : "lock"),
    open ? "Unlocked" : bad ? "Not encrypted" : failed ? failed.badge : pending ? "Unlocking" : "Locked"
  );
  badge.style.marginLeft = "auto";
  bar.appendChild(badge);

  if (open) {
    const copy = el("button", "btn sm", I.copy + " Copy");
    copy.style.marginLeft = "8px";
    copy.addEventListener("click", () => copySecret(copy, entry.plain));
    /* Locking is VAULT-WIDE, and the button says so in its title. A per-block
       re-lock cannot exist beside vault-wide reveal: the vault would still be
       open, so the very next paint would decrypt the block straight back. */
    const lock = el("button", "btn sm", I.lock + " Lock");
    lock.title = "Lock the vault — every secret block re-locks";
    lock.addEventListener("click", () => lockVault("manual"));
    bar.appendChild(copy);
    bar.appendChild(lock);
  } else if (!off && !bad && !orphan && !pending) {
    /* "repair" has an identity on disk — the passphrase opens it; only "none"
       is a vault that genuinely has no key yet */
    const needsVault = vault.state === "none";
    const btn = el("button", "btn sm primary", (needsVault ? I.key : I.unlock) + (needsVault ? " Create vault identity" : failed ? " Retry unlock" : " Unlock"));
    btn.style.marginLeft = "8px";
    btn.title = failed ? "Try this block again" : "Unlock the vault — every secret block reveals";
    btn.addEventListener("click", () => (needsVault ? askCreate() : unlockAndReveal(w)));
    bar.appendChild(btn);
  }

  const body = el("div", "secret-body");
  if (open) {
    /* Every attribute here is a leak the research table names: spellcheck,
       autocorrect and Grammarly all ship what you type to somebody else's
       server (research §6, "DOM-adjacent services"). */
    const ta = el("textarea", "secret-edit");
    ta.value = entry.plain;
    ta.spellcheck = false;
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("data-gramm", "false");
    ta.setAttribute("data-enable-grammarly", "false");
    ta.setAttribute("aria-label", "Decrypted secret · " + docPath);
    ta.addEventListener("input", () => {
      entry.plain = ta.value;
      entry.dirty = true; // ⇒ and ONLY now may this block be re-encrypted
      autoGrow(ta);
      markDirty();
    });
    body.appendChild(ta);
    setTimeout(() => autoGrow(ta), 0);
  } else if (bad) {
    /* NOT armor: whatever is in this fence is plaintext on disk, in git and on
       GitHub. Showing it in full IS the warning — collapsing it behind a
       disclosure would hide the very bytes the note says are exposed. */
    const pre = el("pre");
    pre.textContent = armor;
    body.appendChild(pre);
    body.appendChild(
      secretNote(
        "This ```age fence does not contain age armor, so nothing here is encrypted — " +
          "the text above is stored, committed and pushed exactly as you see it. " +
          "Encrypt it with ⌘⇧E in Raw mode, or remove the fence."
      )
    );
  } else {
    /* Locked (or waiting on its decrypt): NO CIPHERTEXT AT ALL — see
       `maskedBody`. This is a RENDERING change only. `w.zSecret.armor` still
       holds the fence body verbatim, which is what save writes back, so an
       unedited reveal→lock→save is still byte-identical
       (tests/secrets-e2e.test.ts). */
    body.appendChild(maskedBody(pending));
    const note = failed
      ? failed.note
      : off
        ? vault.reason || "Secrets features are unavailable in this browser context."
        : orphan
          ? ORPHAN_WHY
          : "";
    if (note) body.appendChild(secretNote(note));
  }
  w.appendChild(bar);
  w.appendChild(body);
  return w;
}

/** The live node(s) for ONE block. The same armor can legitimately appear more
    than once in a document, and those copies are separate blocks: each has its
    own reveal entry, its own editor and its own re-encrypt target, so the
    ordinal is part of the match. */
function secretNodesFor(path, armor, ord) {
  const n = ord || 0;
  return $$("#doc .secret").filter(
    (x) => x.zSecret && x.zSecret.path === path && x.zSecret.armor === armor && (x.zSecret.ord || 0) === n
  );
}

/** Re-render one block in place; the reveal map is keyed by armor, so this is
    all the state a repaint needs. */
function repaintSecret(w) {
  /* An await can outlive the node it started on — a full repaint (unlock,
     external change) replaces every `.secret` while a decrypt is in flight, and
     `replaceWith` on a detached node writes into nothing. The armor identifies
     the block, so re-find the live one. */
  let node = w;
  if (!node.isConnected && w.zSecret) node = secretNodesFor(w.zSecret.path, w.zSecret.armor, w.zSecret.ord)[0] || w;
  const c = node.zSecret;
  const n = secretEl(c.path, c.armor, c.indent, c.ord);
  if (node.dataset.line != null) n.dataset.line = node.dataset.line;
  node.replaceWith(n);
  return n;
}

/** Repaint a block identified by its CONTENT — what an async decrypt has,
    since the node it was started from may have been replaced (or the doc left)
    while the worker was working. A block that is no longer on screen simply
    has nothing to repaint, which is the correct no-op. */
function repaintSecretsAt(path, armor, ord) {
  secretNodesFor(path, armor, ord).forEach(repaintSecret);
}

/* How each decrypt failure is left ON the block, not just in a toast. */
const FAIL_STATES = {
  tampered: {
    badge: "Integrity check failed",
    subtitle: "MODIFIED after encryption — MAC verification failed",
    note:
      "This block's ciphertext no longer matches its authentication tag: something edited the bytes " +
      "inside the armor (a line-level git merge is the usual culprit — research §4.2). " +
      "The vault key is fine, so re-entering the passphrase or rotating the key will not help. " +
      "Recover the block from git history, or from a copy that still verifies.",
  },
  truncated: {
    badge: "Integrity check failed",
    subtitle: "INCOMPLETE — part of the ciphertext is missing",
    note:
      "Part of this block's armor is gone, so the ciphertext cannot be authenticated. " +
      "The vault key is fine. Recover the full block from git history.",
  },
  "bad-armor": {
    badge: "Corrupt armor",
    subtitle: "the armor itself does not parse",
    note: "This block's armor is malformed — it was probably merged or hand-edited. Recover it from git history.",
  },
  "no-matching-identity": {
    badge: "Wrong key",
    subtitle: "encrypted to a different age recipient",
    note:
      "This block was encrypted to a recipient that is not this vault's key. It is intact — it just needs " +
      "the identity it was encrypted to.",
  },
  /* The catch-all, and the reason `secretFailures` is written unconditionally.
     The worker classifies what it recognises and emits `undecryptable` for
     everything else (a damaged stanza line, bad padding), and a wedged worker
     rejects with no code at all. Those are still failures: without a record
     the block was re-asked by every repaint, forever. */
  unknown: {
    badge: "Could not decrypt",
    subtitle: "the decrypt failed for an unrecognised reason",
    note:
      "This block did not decrypt and the failure does not match any of the known kinds — the armor is " +
      "damaged in a way age could not classify, or the crypto worker did not answer. " +
      "Retry unlock asks again; if it keeps failing, recover the block from git history.",
  },
};

/**
 * The block's Unlock button: the ENTRY POINT into the vault-wide open state,
 * not a per-block permission. It opens the vault (passphrase modal if the
 * worker has no identity yet) and then lets the ordinary repaint reveal every
 * block, this one included — there is exactly one reveal path and this is not
 * a second one.
 *
 * On a FAILED block it is "Retry unlock": drop the sticky classification so
 * the repaint asks the worker again rather than re-showing the old verdict.
 */
async function unlockAndReveal(w) {
  const c = w.zSecret;
  if (secretFailures.delete(revealKey(c.path, c.armor, c.ord))) repaintSecret(w);
  const ok = await ensureUnlocked();
  if (!ok) return;
  /* An already-open vault emits no `unlocked` event, so this is what carries a
     retry. After a real unlock it is the second repaint behind the one
     `onWorkerEvent` already did, and idempotence makes it free. */
  repaintSecretsUI();
}

/* ---------- clipboard, with the timed clear the research table demands ----------
   The delay is `secrets.clipboardClearSeconds` (30s by default), read at COPY
   time so a change in Settings applies to the very next copy.

   Two separate concerns, and conflating them was the bug: `clipT` is the
   COUNTDOWN, `clipArmed` is the promise that the clipboard will be cleared.
   Stopping the countdown must never silently retire the promise — locking is
   precisely when the plaintext should leave the clipboard, not when the clear
   should be abandoned. */
let clipT = null;
let clipArmed = false;

function stopClipboardCountdown() {
  if (clipT) clearInterval(clipT);
  clipT = null;
}

/** Perform the pending clear NOW (lock, re-lock, or a fresh copy superseding). */
function clearClipboardNow(quiet) {
  stopClipboardCountdown();
  if (!clipArmed) return;
  clipArmed = false;
  /* best effort only — a clipboard manager is outside this boundary and the
     browser may refuse a write while the tab is unfocused */
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText("").then(() => {
      if (!quiet) toast("Clipboard cleared");
    }, () => {});
}

function copySecret(btn, text) {
  stopClipboardCountdown();
  clipArmed = false; // this write supersedes the previous one
  const done = () => {
    clipArmed = true;
    let left = clipboardSeconds();
    const paint = () => (btn.innerHTML = I.copy + " Clears in " + left + "s");
    paint();
    clipT = setInterval(() => {
      left -= 1;
      if (left > 0) return paint();
      btn.innerHTML = I.copy + " Copy";
      clearClipboardNow();
    }, 1000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => toast("The browser refused clipboard access"));
  } else {
    toast("Clipboard is unavailable in this context");
  }
}

/* ============================================================
   RAW MODE
   ============================================================ */
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
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
  ta.placeholder = "# " + doc.title + "\n\nThis note is empty — write markdown here.";
  ta.addEventListener("input", () => {
    doc.markdown = ta.value;
    autoGrow(ta);
    markDirty();
    updateMeta();
  });
  host.appendChild(ta);
  autoGrow(ta);
}

/* pull pending textarea edits into the cache before anything re-renders */
function syncRaw() {
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
function syncRawFromModel(doc) {
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
function updateMeta() {
  const doc = activeDoc();
  if (!doc) return;
  const md = String(doc.markdown || "");
  const n = md === "" ? 0 : md.replace(/\n$/, "").split("\n").length;
  $("#stLines").textContent = n + (n === 1 ? " line" : " lines");
  $("#stWords").textContent = countWords(md) + " words";
}

function renderDoc(opts) {
  opts = opts || {};
  const doc = activeDoc();
  const host = $("#doc");
  host.innerHTML = "";
  if (!doc) return;
  host.classList.toggle("raw-mode", state.mode === "raw");

  const meta = el("div", "doc-meta");
  meta.innerHTML =
    '<span class="tag">' + esc(doc.path) + "</span>" +
    "<span>" + esc(relTime(doc.mtime)) + "</span>" +
    '<span class="mode-note">' + (state.mode === "raw" ? "raw source · click outside to preview" : "preview · click a line to edit") + "</span>";
  host.appendChild(meta);

  if (state.mode === "raw") renderRaw(doc, host);
  else if (!String(doc.markdown).trim()) {
    const e = el("div", "empty-doc");
    e.innerHTML = '<div class="ring">' + I.note + "</div><h3>" + esc(doc.title) + "</h3>" + "<p>This note is empty. Switch to <b>Raw</b> (<kbd>⌘E</kbd>) to write markdown.</p>";
    host.appendChild(e);
  } else renderPreview(doc, host);

  /* the entrance animation belongs to navigation; a mode switch must not
     translate or fade the container (amendment 11) */
  host.classList.remove("fade-in");
  if (!opts.noFade) {
    void host.offsetWidth;
    host.classList.add("fade-in");
  }

  $("#crumbs").innerHTML = doc.path
    .split("/")
    .map((p, i, a) => (i === a.length - 1 ? '<b class="chip-mono">' + esc(p) + "</b>" : '<span class="cr-dir">' + esc(p) + "</span>"))
    .join('<span class="sep cr-dir">/</span>');
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
function setBaseline(doc, text) {
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
function viewedPath() {
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
function navGate() {
  const at = navSeq;
  return () => navSeq === at;
}

async function openDoc(path, opts) {
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
function syncModeUI() {
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

function setMode(m, opts) {
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
  }
  if (!opts.silent) toast(m === "raw" ? "Raw markdown" : "Rendered preview");
}

/* ---------- click a rendered line → edit that line in Raw ---------- */
let downPt = null;
let downInRaw = false;

function previewClickToEdit(e) {
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

function paneClickToPreview(e) {
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

function setSaveIndicator(txt, cls) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  if (cls) ind.classList.add(cls);
  $("#saveTxt").textContent = txt;
}

function markDirty() {
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

function saveDoc(path, opts) {
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

/* ============================================================
   AI CHAT
   ============================================================ */
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const proposalById = (id) => state.proposals.filter((p) => p.id === id)[0];

function updateSessionUI() {
  const s = state.session;
  if (!s) return;
  /* the relay strips parameters the endpoint rejects rather than failing the
     turn (research §7.4) — but a pluggable-endpoint app must never degrade
     SILENTLY, so every downgrade shows up on the model chip */
  const chip = $(".model-chip");
  if (chip) {
    const d = s.degraded || [];
    chip.classList.toggle("degraded", d.length > 0);
    chip.title = d.length ? "Endpoint downgraded — " + d.map((x) => x.message).join(" · ") : "";
  }
  $("#sessCount").textContent = s.messageCount;
  $("#sessCountWord").textContent = s.messageCount === 1 ? "msg" : "msgs";
  $("#sessTok").textContent = fmtTok(s.tokensEstimated);
  $("#popMsgs").textContent = s.messageCount + (s.messageCount === 1 ? " message" : " messages");
  $("#popTok").textContent = "~" + fmtTok(s.tokensEstimated) + " tokens";
  $("#sessId").textContent = s.id;
  $("#popModel").textContent = s.model + " · " + s.effort;
  $("#modelName").textContent = s.model;
  $("#modelEffort").textContent = s.effort;
  const mins = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
  $("#popStart").textContent = mins < 1 ? "just now" : mins + " min ago";
  const pct = Math.min(100, (s.tokensEstimated / s.contextWindow) * 100);
  $("#ctxFill").style.width = Math.max(1.5, pct).toFixed(1) + "%";
  $("#ctxPct").textContent = (pct < 0.1 ? "<0.1" : pct.toFixed(1)) + "% of " + Math.round(s.contextWindow / 1000) + "k";
}

let statsT;
function refreshSessionStats() {
  clearTimeout(statsT);
  statsT = setTimeout(async () => {
    try {
      const s = await api.getSession();
      if (state.session) {
        state.session.messageCount = s.messageCount;
        state.session.tokensEstimated = s.tokensEstimated;
      }
      updateSessionUI();
    } catch (e) {}
  }, 250);
}

function renderChat() {
  const host = $("#msgs");
  host.innerHTML = "";
  const s = state.session;
  if (!s) return;
  s.messages.forEach((m, idx) => {
    if (m.kind === "divider") {
      host.appendChild(el("div", "ctx-div", esc(m.content)));
      return;
    }
    const wrap = el("div", "msg " + (m.role === "user" ? "user" : "ai"));
    wrap.dataset.msg = m.id;
    wrap.style.animationDelay = Math.min(idx * 22, 220) + "ms";
    wrap.appendChild(el("div", "who", m.role === "user" ? "You" : s.model));
    /* the "thinking" affordance: reasoning summary deltas, which arrive long
       before the first token of prose does */
    if (m._streaming) {
      const think = el("div", "think");
      think.appendChild(el("span", "dots", "<i></i><i></i><i></i>"));
      const tx = el("span", "tx");
      tx.textContent = m._think || "Thinking…";
      think.appendChild(tx);
      wrap.appendChild(think);
    }
    const bubble = el("div", "bubble");
    bubble.innerHTML = inline(m.content);
    if (m._streaming && !m.content) bubble.hidden = true;
    wrap.appendChild(bubble);
    if (m.proposalId) {
      const p = proposalById(m.proposalId);
      if (p) wrap.appendChild(p.state === "rejected" ? dismissedCard(p) : diffCard(p));
    }
    /* Commands the assistant asked for in this message. Rendered here, under
       the prose that explains them, for the same reason a diff card is: the
       exact thing that would happen must be visible next to the reason. */
    state.commands.filter((c) => c.messageId === m.id).forEach((c) => wrap.appendChild(commandCard(c)));
    host.appendChild(wrap);
  });
  host.scrollTop = host.scrollHeight;
  renderStack();
  updateSessionUI();
}

function diffCard(p) {
  const card = el("div", "diffcard");
  card.dataset.prop = p.id;
  if (p.state === "applied") card.classList.add("applied");
  const head = el("div", "diff-head");
  head.innerHTML =
    I.doc + '<span class="f">' + esc(p.target) + "</span>" +
    '<span class="diff-stat"><span class="p">+' + p.stats.added + '</span><span class="m">−' + p.stats.removed + "</span></span>";
  const body = el("div", "diff-body");
  renderDiff(body, p.diff);
  const foot = el("div", "diff-foot");
  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);
  fillFoot(p, foot);
  return card;
}

function dismissedCard(p) {
  return el(
    "div",
    "dismissed",
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Suggestion dismissed · <span style="font-family:var(--mono);font-size:11px">' + esc(p.label) + "</span>"
  );
}

function fillFoot(p, foot) {
  foot.innerHTML = "";
  if (p.state !== "applied") {
    const acc = el("button", "btn primary sm", I.tick + " Accept");
    acc.addEventListener("click", () => acceptProposal(p.id));
    const rej = el("button", "btn sm", "Reject");
    rej.addEventListener("click", () => rejectProposal(p.id));
    const note = el("span", "note");
    note.style.marginLeft = "auto";
    note.textContent = p.summary;
    foot.appendChild(acc);
    foot.appendChild(rej);
    foot.appendChild(note);
    return;
  }
  const ok = el("span", "applied-note", I.tick + " Applied #" + p.stackIndex);
  const rev = el("button", "btn sm", I.undo + " Revert");
  if (p.revertable) {
    rev.style.marginLeft = "auto";
    rev.title = "Undo this change";
    rev.addEventListener("click", () => revertProposal(p.id));
    foot.appendChild(ok);
    foot.appendChild(rev);
    return;
  }
  rev.disabled = true;
  rev.title = "revert #" + state.stack.length + " first";
  const hint = el("span", "stack-hint", "revert #" + state.stack.length + " first");
  foot.appendChild(ok);
  foot.appendChild(hint);
  foot.appendChild(rev);
}

function refreshCards() {
  $$(".diffcard").forEach((card) => {
    const p = proposalById(card.dataset.prop);
    if (!p) return;
    card.classList.toggle("applied", p.state === "applied");
    const foot = $(".diff-foot", card);
    if (foot) fillFoot(p, foot);
  });
}

function renderStack() {
  const box = $("#stack"),
    list = $("#stackList"),
    msgs = $("#msgs");
  const pinned = msgs && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
  list.innerHTML = "";
  $("#stackCnt").textContent = state.stack.length;
  box.hidden = state.stack.length === 0;
  state.stack
    .slice()
    .reverse()
    .forEach((entry) => {
      const row = el("div", "stack-row" + (entry.revertable ? " top" : ""));
      row.innerHTML = '<span class="n">#' + entry.index + '</span><span class="lbl">' + esc(entry.label) + "</span>";
      const rev = el("button", "btn sm", "Revert");
      if (entry.revertable) {
        rev.title = "Undo change #" + entry.index;
        rev.addEventListener("click", () => revertProposal(entry.id));
      } else {
        rev.disabled = true;
        rev.title = "revert #" + state.stack.length + " first";
      }
      row.appendChild(rev);
      list.appendChild(row);
    });
  if (pinned && msgs) msgs.scrollTop = msgs.scrollHeight;
}

/** the one place a proposal enters or is refreshed in `state.proposals` */
function upsertProposal(p) {
  const i = state.proposals.findIndex((x) => x.id === p.id);
  if (i >= 0) state.proposals[i] = p;
  else state.proposals.push(p);
}

function absorbProposalResult(r) {
  if (r.proposal) upsertProposal(r.proposal);
  if (r.stack) state.stack = r.stack;
  /* the server is the authority on revertability — re-read it for every card */
  if (r.stack) {
    const top = r.stack.length ? r.stack[r.stack.length - 1].id : null;
    state.proposals.forEach((p) => {
      p.revertable = p.state === "applied" && p.id === top;
      const e = r.stack.filter((x) => x.id === p.id)[0];
      p.stackIndex = e ? e.index : p.state === "applied" ? p.stackIndex : null;
    });
  }
  if (r.doc) {
    const prev = state.docs.get(r.doc.path) || {};
    // setBaseline like every other adopt: an accept/revert rewrote the file on
    // disk, and a stale diskText made the Raw-exit guard diff against bytes
    // that no longer exist
    state.docs.set(r.doc.path, setBaseline(Object.assign({}, prev, r.doc, { loaded: true }), r.doc.markdown));
  }
}

/**
 * Accept and revert are the same nine steps in the same order — flush the
 * buffer, call, absorb, re-home or repaint, refresh the cards/stack/stats,
 * say so — so they are one function. Writing them twice meant a routing
 * decision they are supposed to SHARE (does `openDoc` push an entry? does a
 * dirty buffer save first?) lived in two places, free to drift.
 *
 * Only four things differ, and all four are here: which call, whether the
 * index in the toast comes from the reply or from the pre-call stack depth
 * (revert nulls `stackIndex`), the verb, and the scroll. The `not-stack-top`
 * branch is shared and inert for accept — LIFO is the SERVER's rule and only
 * `AI.revert()` can answer with that code.
 */
async function applyProposal(id, undo) {
  syncRaw();
  if (state.dirty) await saveDoc(state.active, { silent: true });
  try {
    const n = state.stack.length;
    const r = await (undo ? api.revertProposal(id) : api.acceptProposal(id));
    absorbProposalResult(r);
    if (r.doc && state.active !== r.doc.path) await openDoc(r.doc.path);
    else renderDoc();
    refreshCards();
    renderStack();
    refreshSessionStats();
    toast((undo ? "Reverted #" + n : "Applied #" + r.proposal.stackIndex) + " · " + r.proposal.label);
    if (!undo) {
      const sc = $("#scroll");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  } catch (err) {
    if (err && err.code === "not-stack-top") {
      toast(err.message);
      return;
    }
    apiFail(err, (undo ? "Revert" : "Accept") + " failed");
  }
}

const acceptProposal = (id) => applyProposal(id, false);
const revertProposal = (id) => applyProposal(id, true);

async function rejectProposal(id) {
  try {
    const r = await api.rejectProposal(id);
    absorbProposalResult(r);
    const card = $('.diffcard[data-prop="' + id + '"]');
    if (card) {
      card.style.opacity = "0";
      card.style.transform = "translateY(-4px)";
      setTimeout(() => card.replaceWith(dismissedCard(r.proposal)), 200);
    } else renderChat();
    toast("Suggestion dismissed");
  } catch (err) {
    if (err && err.code === "applied") {
      toast("Revert it first");
      return;
    }
    apiFail(err, "Reject failed");
  }
}

async function loadProposals() {
  const r = await api.listProposals();
  state.proposals = r.proposals;
  state.stack = r.stack;
}

async function loadSession() {
  state.session = await api.getSession();
}

async function startNewSession() {
  try {
    // a turn still streaming belongs to the session being thrown away
    abortStream();
    state.session = await api.newSession();
    closeSess();
    renderChat();
    toast("Context cleared · new session");
  } catch (err) {
    apiFail(err, "Could not start a session");
  }
}

/* ---------------- streaming turn ----------------

   POST /api/ai/messages streams (SPEC §3 delta 4). Deltas paint into the live
   bubble; the terminal `done` event carries exactly the JSON the non-streaming
   contract returned, and it goes through `absorbTurn` — the same code the blob
   reply used — so the proposal card, the stack and the session stats have one
   completion path, not two. */

let streamCtl = null;
let tmpSeq = 0;

function abortStream() {
  if (!streamCtl) return;
  const c = streamCtl;
  streamCtl = null;
  c.abort(); // → fetch cancelled → server cancels its stream → upstream aborted
}

/** The completion path. Identical to what the non-streaming reply did. */
function absorbTurn(r) {
  const s = state.session;
  if (!r || !s) return;
  (r.messages || []).forEach((m) => s.messages.push(m));
  if (r.session) {
    s.messageCount = r.session.messageCount;
    s.tokensEstimated = r.session.tokensEstimated;
    s.degraded = r.session.degraded || null;
  }
  if (r.proposal) upsertProposal(r.proposal);
  /* The records only learn which message they belong under once the turn's
     prose has an id, so the authoritative copy arrives here, on `done`. */
  (r.commands || []).forEach(upsertCommand);
  renderChat();
}

async function sendMessage() {
  const ta = $("#composer");
  const text = ta.value.trim();
  if (!text) return;
  const s = state.session;
  if (!s) return;
  ta.value = "";
  autoGrow(ta); // …and shrinks back: a sent prompt must not leave its own hole
  abortStream(); // a new message supersedes whatever is still arriving

  const uid = "tmp" + ++tmpSeq;
  const at = new Date().toISOString();
  const tmpUser = { id: uid + "u", role: "user", content: text, at };
  const tmpAi = { id: uid + "a", role: "assistant", content: "", proposalId: null, at, _streaming: true, _think: "" };
  s.messages.push(tmpUser, tmpAi);
  renderChat();

  const ctl = new AbortController();
  streamCtl = ctl;
  let acc = "";
  let think = "";
  let raf = 0;

  /* one paint per frame, not one per delta: a fast stream would otherwise
     re-parse inline markdown hundreds of times a second */
  const paint = () => {
    raf = 0;
    tmpAi.content = acc;
    tmpAi._think = think;
    const wrap = $('.msg[data-msg="' + uid + 'a"]');
    if (!wrap) return;
    const bubble = $(".bubble", wrap);
    if (bubble) {
      bubble.hidden = !acc;
      bubble.innerHTML = inline(acc);
    }
    const tx = $(".think .tx", wrap);
    if (tx) tx.textContent = think ? think.slice(-160) : acc ? "Writing…" : "Thinking…";
    const host = $("#msgs");
    if (host) host.scrollTop = host.scrollHeight;
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const drop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    s.messages = s.messages.filter((m) => m.id !== tmpUser.id && m.id !== tmpAi.id);
  };

  try {
    const r = await api.sendMessageStream(text, state.active, {
      signal: ctl.signal,
      onText: (d) => {
        acc += d.delta;
        schedule();
      },
      onReasoning: (d) => {
        think = (think + d.delta).replace(/\s+/g, " ").slice(-400);
        schedule();
      },
      onToolArgs: () => {
        think = "Drafting edits…";
        schedule();
      },
      /* A run_command record, arriving mid-turn: queued for approval, or (when
         the user has switched auto-run on) already run. Absorbed as it lands so
         the card is there the instant the turn's prose is. */
      onCommand: (c) => {
        upsertCommand(c);
        think = c && c.state === "pending" ? "Asking to run a command…" : "Running a command…";
        schedule();
      },
      onError: (e) => toast((e && e.message) || "The assistant hit an error"),
    });
    if (streamCtl === ctl) streamCtl = null;
    drop();
    absorbTurn(r);
  } catch (err) {
    if (streamCtl === ctl) streamCtl = null;
    /* An abort is the user's own doing (new message, new session) — not a
       fault. But the SERVER keeps the aborted turn: the user message was
       persisted before the stream opened and runTurn's abort branch keeps the
       streamed partial as the assistant reply. Dropping both here left the
       thread missing a turn the backend holds — invisible now, back on reload,
       and replayed upstream as two consecutive user messages. Keep the same
       two messages the server kept. */
    if (err && err.name === "AbortError") {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      tmpAi.content = acc;
      tmpAi._streaming = false;
      tmpAi._think = "";
      // the server keeps the partial only when something streamed; mirror it
      if (!acc) s.messages = s.messages.filter((m) => m.id !== tmpAi.id);
      renderChat();
      return;
    }
    drop();
    renderChat();
    apiFail(err, "Message failed");
  }
}

/* ============================================================
   ⌘K PALETTE — server-side fuzzy search
   ============================================================ */
let palResults = [],
  palSel = 0,
  palAbort = null,
  palT = null;

function markUp(text, idx, window_) {
  let start = 0,
    str = text;
  if (window_ && text.length > window_ && idx.length) {
    start = Math.max(0, idx[0] - 18);
    str = text.slice(start, start + window_);
  }
  const set = {};
  idx.forEach((i) => (set[i - start] = true));
  let out = "";
  for (let i = 0; i < str.length; i++) out += set[i] ? "<mark>" + esc(str[i]) + "</mark>" : esc(str[i]);
  return (start > 0 ? "…" : "") + out + (start + str.length < text.length ? "…" : "");
}

function renderPal() {
  const list = $("#palList");
  list.innerHTML = "";
  $("#palCount").textContent = palResults.length ? palResults.length + " result" + (palResults.length > 1 ? "s" : "") : "";
  if (!palResults.length) {
    list.appendChild(el("div", "pal-empty", "No docs or lines match that."));
    return;
  }
  palResults.forEach((r, i) => {
    const b = el("button", "pal-item" + (i === palSel ? " sel" : ""));
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === palSel ? "true" : "false");
    const ico = r.kind === "doc" ? I.file : I.search;
    let html =
      '<span class="pico">' + ico + '</span><span class="col">' +
      '<span class="nm">' + esc(r.name) +
      '<span class="pth">' + (r.kind === "doc" ? markUp(r.text, r.matches, 0) : esc(r.path)) + "</span></span>";
    if (r.kind === "line") html += '<span class="sn">' + markUp(r.text, r.matches, 96) + "</span>";
    html += "</span>";
    if (r.kind === "line") html += '<span class="ln">L' + (r.line + 1) + "</span>";
    b.innerHTML = html;
    b.addEventListener("click", () => palOpen(i));
    b.addEventListener("mousemove", () => {
      if (palSel === i) return;
      palSel = i;
      $$(".pal-item", list).forEach((x, j) => x.classList.toggle("sel", j === i));
    });
    list.appendChild(b);
  });
}

async function palQuery(q) {
  if (palAbort) palAbort.abort();
  palAbort = new AbortController();
  try {
    const r = await api.search(q, { signal: palAbort.signal });
    palResults = r.results;
    palSel = 0;
    renderPal();
    $("#palList").scrollTop = 0;
  } catch (err) {
    if (err && err.name === "AbortError") return;
    apiFail(err, "Search failed");
  }
}

function palMove(d) {
  if (!palResults.length) return;
  palSel = (palSel + d + palResults.length) % palResults.length;
  renderPal();
  const sel = $(".pal-item.sel");
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}

function palOpen(i) {
  const r = palResults[i == null ? palSel : i];
  if (!r) return;
  closePal();
  openDoc(r.path, r.kind === "line" ? { line: r.line } : null);
}

function openPal() {
  if (isOpen("#palVeil")) return;
  $("#palVeil").classList.add("show");
  const inp = $("#palInput");
  inp.value = "";
  palQuery("");
  setTimeout(() => inp.focus(), 40);
}
function closePal() {
  $("#palVeil").classList.remove("show");
  const inp = $("#palInput");
  if (inp && document.activeElement === inp) inp.blur();
}

/* ============================================================
   SETTINGS
   ============================================================ */
function buildSeg(host, items, current) {
  host.innerHTML = "";
  items.forEach((it) => {
    const b = el("button", it.id === current ? "on acc" : "", esc(it.label));
    b.dataset.v = it.id;
    host.appendChild(b);
  });
}
function markSeg(host, value) {
  $$("button", host).forEach((b) => {
    b.classList.toggle("on", b.dataset.v === value);
    b.classList.toggle("acc", b.dataset.v === value);
  });
}

/* The pre-paint caches index.html reads. Same contract as `znotes.scheme`
   (see the comment there): a cache of what was last APPLIED, never a setting
   and never a default, rewritten on every apply so the server always wins.
   Without them the shell booted `minimal`/`comfy` and repainted into the real
   theme ~20ms later — on every single load, warm profile included, which is
   the exact failure the scheme resolver was written to avoid. */
function cacheLook(key, value) {
  try {
    localStorage.setItem("znotes." + key, value);
  } catch (e) {
    /* private mode / storage disabled: the cache is an optimisation, not a
       dependency — the apply itself already happened */
  }
}

function applyTheme(id, { cache = true } = {}) {
  const link = $("#theme-css");
  const href = "./themes/" + id + ".css";
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  document.documentElement.setAttribute("data-theme", id);
  /* cache:false for the ?theme= override — the cache predicts the NEXT boot,
     and the next boot uses the stored setting, not this URL */
  if (cache) cacheLook("theme", id);
  markSeg($("#themeSeg"), id);
}

function applyDensity(id, { cache = true } = {}) {
  document.documentElement.setAttribute("data-density", id);
  /* cache:false while PREVIEWING an unsaved pick — see applyLook() */
  if (cache) cacheLook("density", id);
  markSeg($("#densitySeg"), id);
  const ta = $("#rawArea");
  if (ta) autoGrow(ta);
}

/* ---------- colour scheme ----------
   The second axis of the look: `data-theme` picks the stylesheet, `data-scheme`
   picks the palette inside it (base.css §1b). Three things have to move
   together or the page ends up half-dark:

     data-scheme       what every theme's palette keys off
     color-scheme      the UA half — form controls, native scrollbars, and the
                       canvas the page paints on. CSS carries it too (base.css
                       sets the property), but the <meta> is what the browser
                       reads before any stylesheet has loaded.
     znotes.scheme     the pre-paint cache index.html reads. NOT a stored
                       setting and not a default — see the comment there. The
                       server's value overwrites it on every apply, so a stale
                       cache costs one repaint at boot and nothing else.

   What the cache stores is the PREFERENCE ("system" | "dark" | "light"), not
   the scheme it resolved to. Caching the resolved value looks equivalent and is
   not: under `system` — the shipped default — it pins the palette the app
   happened to end on, so an OS that flipped while the app was closed boots into
   the stale one and snaps a frame later. The preference lets the <head> resolve
   the same way this function does, and `matchMedia` is synchronous and needs no
   network, so `system` is flash-free even on a profile that has never run the
   app. A pinned dark/light still costs one repaint on that very first load —
   there is no pre-network way to know a server-side setting — and none after.

   `system` is the only value that needs a listener: it is not a look, it is a
   subscription, and an OS that flips at sunset has to repaint a session that
   has been open since morning. The listener is attached while the setting is
   `system` and removed the moment it is not, so pinning dark cannot leave a
   stray follower behind. */
const schemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let osSchemeListener = null;

function applyColorScheme(pref, { cache = true } = {}) {
  const resolved = pref === "system" ? (schemeMedia.matches ? "dark" : "light") : pref;
  const root = document.documentElement;
  root.setAttribute("data-scheme", resolved);
  /* the preference itself, for anything that needs to know WHY it is dark */
  root.setAttribute("data-scheme-pref", pref);
  const meta = $('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", resolved);
  try {
    /* the PREFERENCE, not `resolved` — see the header comment.
       cache:false for the ?scheme= override — the cache exists to predict the
       NEXT boot, and the next boot will use the stored setting, not this URL */
    if (cache) localStorage.setItem("znotes.scheme", pref);
  } catch {
    /* private mode / storage disabled: the cache is an optimisation, not a
       dependency — everything above already happened */
  }
  markSeg($("#schemeSeg"), pref);

  if (pref === "system" && !osSchemeListener) {
    /* cache:false: the OS flipping is not a decision the user made here, so it
       must not promote a merely PREVIEWED `system` into the pre-paint cache.
       When `system` really is the stored value the cache already says so. */
    osSchemeListener = () => applyColorScheme("system", { cache: false });
    schemeMedia.addEventListener("change", osSchemeListener);
  } else if (pref !== "system" && osSchemeListener) {
    schemeMedia.removeEventListener("change", osSchemeListener);
    osSchemeListener = null;
  }
}

/* ---------- numeric settings, entirely server-declared ----------
   `meta.numbers` carries {min,max,step,unit} per dotted path, so the bounds,
   the snap and the unit label all come from the backend — exactly as the theme
   list drives the theme control. Adding a numeric setting is a settings.ts +
   markup change; there is nothing to hard-code here. */

/**
 * The ONE reader for a dotted settings path — see the hard rule at the top of
 * this file ("NO settings defaults").
 *
 * Deliberately unguarded. `start()` awaits `api.getSettings()` and assigns
 * `state.settings` before wire(), initSecrets() or any render, and index.html
 * leaves the app hidden if that throws — which is why start() itself reads
 * `state.settings.theme` with no guard either. The values are guaranteed
 * present and in range: settings.ts healSections() restores a missing group
 * wholesale and healNumbers/coerceNumber clamps every NUMBERS path on load AND
 * on PUT. The `|| fallback` guards that used to sit at five call sites were
 * unreachable, and each carried its own stale copy of a server default.
 */
function settingAt(path) {
  const [group, key] = path.split(".");
  const section = state.settings[group];
  return section ? section[key] : undefined;
}

function numberSpec(path) {
  return (state.meta && state.meta.numbers && state.meta.numbers[path]) || null;
}

/** Clamp + snap the way settings.ts does, so the field never shows a value the
    server would silently rewrite. */
function coerceNumberSetting(path, raw) {
  const spec = numberSpec(path);
  const n = Number(raw);
  if (!spec) return Number.isFinite(n) ? n : null;
  if (!Number.isFinite(n) || n <= 0) return null; // let the server's default win
  const clamped = Math.min(spec.max, Math.max(spec.min, n));
  return Math.min(spec.max, spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step);
}

function paintNumbers() {
  $$("[data-num]").forEach((inp) => {
    const path = inp.dataset.num;
    const spec = numberSpec(path);
    if (spec) {
      /* deliberately NOT type=number: no theme styles a spin button, and three
         stylesheets' worth of new chrome is a poor trade for a stepper. The
         bounds are enforced by coerceNumberSetting on the way out and by
         settings.ts on the way in; `title` is how they are discoverable. */
      inp.setAttribute("inputmode", "numeric");
      inp.title = `${spec.min}–${spec.max} ${spec.unit}` + (spec.step > 1 ? `, in steps of ${spec.step}` : "");
      const unit = inp.parentNode && $(".unit", inp.parentNode);
      if (unit) unit.textContent = spec.unit;
    }
    /* the DRAFT, not the stored value — a repaint (arriving back on the page, a
       terminal status refresh) must not silently undo an edit the user made */
    const v = draftValue(path);
    if (v != null) inp.value = v;
  });
}

/** Every free-text draft field and every switch, painted from the DRAFT and
    addressed by the attribute in the markup — like `paintNumbers` above, and
    for the same reason: this table used to be written out at the binding, here,
    again in `paintTerminal` (which owned the other half of these very controls
    — the four switches were split 2/2 with nothing tying the halves together)
    and a fourth time in the §11 parity gate. Called from BOTH painters, because
    both are real entry points. `!!` rather than `!== false`: settings.ts
    materialises every boolean, so the served object always carries one. */
function paintDraftFields() {
  $$("[data-draft]").forEach((n) => {
    const v = draftValue(n.dataset.draft);
    n.value = v == null ? "" : v;
  });
  $$("[data-sw]").forEach((sw) => sw.classList.toggle("on", !!draftValue(sw.dataset.sw)));
}

function paintSettings() {
  const s = state.settings,
    m = state.meta;
  buildSeg($("#themeSeg"), m.themes, draftValue("theme"));
  buildSeg($("#densitySeg"), m.densities, draftValue("density"));
  buildSeg($("#schemeSeg"), m.colorSchemes.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), draftValue("colorScheme"));
  buildSeg($("#effortSeg"), m.efforts.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), draftValue("ai.effort"));
  paintNumbers();
  /* the placeholder is `meta.homeDocDefault`, not a literal here: the client
     hard-codes no default, the same rule the theme list and meta.numbers follow */
  $("#homeDoc").placeholder = m.homeDocDefault || "";
  paintDraftFields();
  paintHome();
  paintTerminal();
  /* the two CREDENTIAL fields are not draft state — they are painted from the
     server's mask, because the server's mask is all there is to paint */
  $("#gitToken").value = s.git.tokenMasked;
  $("#aiKey").value = s.ai.apiKeyMasked;
  paintSaveState();
  /* one call: paintAiStatus owns the chip AND (via paintEndpoint) the Settings
     note, so the two surfaces are painted from a single signal and cannot drift */
  paintAiStatus((m.ai && m.ai.status) || null);
}

/* ============================================================
   AI ENDPOINT STATUS — the statusbar item

   Truthful by construction: every field here is server-derived from real
   signals (`meta.ai.status`, see ai.ts) — the capability probe, the outcome of
   the last relay turn, and an on-demand re-probe when the item is clicked.
   Nothing is inferred in the browser and nothing is assumed; before any signal
   exists the state is `unknown` and the item says so rather than showing green.

   Updates arrive over the SAME /events stream the git chip uses (`ai-status`),
   pushed when the status actually changes. No timer, no polling.
   ============================================================ */
const AI_STATE_CLASSES = ["ok", "degraded", "unreachable", "unconfigured", "pending"];

function paintAiStatus(st) {
  const el_ = $("#stAi");
  if (!el_) return;
  state.aiStatus = st || null;
  const txt = $("#stAiTxt");
  const cls = !st ? "pending" : st.state === "unknown" ? "pending" : st.state;
  AI_STATE_CLASSES.forEach((c) => el_.classList.toggle(c, c === cls));

  if (!st) {
    txt.textContent = "AI —";
    el_.title = "AI endpoint · status unknown";
    return;
  }
  /* the model and the effort ACTUALLY in use — `st.effort` is post-ladder, so a
     silent downgrade to a weaker effort shows up here rather than hiding behind
     the value in Settings */
  txt.textContent = st.state === "unconfigured" ? "AI not configured" : st.model + " · " + st.effort;
  const head =
    st.state === "ok"
      ? "AI endpoint reachable"
      : st.state === "degraded"
      ? "AI endpoint degraded"
      : st.state === "unreachable"
      ? "AI endpoint unreachable"
      : st.state === "unconfigured"
      ? "AI not configured"
      : "AI endpoint not checked yet";
  const when = st.checkedAt ? " (checked " + new Date(st.checkedAt).toLocaleTimeString() + ")" : "";
  el_.title = head + when + "\n" + (st.message || "") + "\nClick to re-check and open AI settings.";
  // the Settings › AI note says the same thing; repaint it from the same signal
  paintEndpoint();
}

/* Click = a REAL check, not a repaint: POST /api/ai/status re-probes the
   configured endpoint server-side and answers with the fresh verdict. Settings
   opens either way — a broken endpoint is exactly when you want the fields. */
async function checkAiEndpoint() {
  const el_ = $("#stAi");
  openSettings("ai");
  if (!el_) return;
  el_.classList.add("busy");
  try {
    const r = await api.checkAiStatus();
    /* take the fresher capability block FIRST, then repaint once: paintAiStatus
       is the only thing that repaints AI-derived UI, and painting before this
       assignment would render the note from the meta we just superseded */
    if (r && r.ai && state.meta) state.meta.ai = r.ai;
    if (r && r.status) paintAiStatus(r.status);
  } catch (err) {
    /* the check itself failing is a same-origin problem, not an endpoint
       verdict — never let it repaint the dot into a lie */
    apiFail(err, "Could not check the AI endpoint");
  } finally {
    el_.classList.remove("busy");
  }
}

/**
 * THE way Settings opens — ⌘, the sidebar row, the AI statusbar chip, the
 * assistant's Run/Show-output buttons all come through here, so there is one
 * place that knows what opening Settings means. It is now a NAVIGATION: it
 * pushes `/settings` (or `/settings/<section>`) and paints the page. Nothing
 * else in this file shows the settings view without going through it.
 *
 * `section` is optional; with it the page scrolls to that group and flashes it,
 * which is the whole point of arriving from a statusbar item — and it is in the
 * URL, so the same arrival is a link somebody else can follow.
 */
function openSettings(section) {
  /* Settings is a NAVIGATION, so it leaves the document behind exactly as a
     tree click does — and an unsaved Raw buffer gets the same question (SPEC
     §4). `showSettings` is deliberately NOT guarded: boot and popstate paint the
     page from an entry that already exists, and a dialog in front of either
     would be arguing with the address bar. */
  if (!guardRawExit(() => showSettings(section, {}))) return;
  showSettings(section, {});
}

/**
 * Paint the settings page. Separate from `openSettings` for exactly one reason:
 * a `popstate` and boot must show the page WITHOUT writing history (the entry
 * they are reacting to already exists), and that is the only difference.
 *
 * `opts.route === false` skips the history write; `opts.replace` reuses the
 * current entry instead of stacking one.
 */
function showSettings(section, opts) {
  const o = opts || {};
  const sec = SETTINGS_SECTIONS.includes(String(section || "")) ? String(section) : "";
  /* the doc keeps its unsaved text either way, but the buffer must reach
     `state.docs` before the textarea leaves the DOM */
  if (state.view !== "settings") syncRaw();
  state.view = "settings";
  state.settingsSection = sec;
  app.classList.add("route-settings");
  if (o.route !== false) routeSettings(sec, o.replace);
  paintSettingsRoute();
  /* Re-entry re-shows the draft the last visit left behind, preview included:
     leaving does not discard (see exitSettings), so arriving must not pretend
     it did. Guarded, so a clean page repaints nothing — the controls are
     already right, and `?theme=` deep-linked straight at /settings must survive
     arriving here. */
  if (settingsDirty()) {
    paintSettings();
    applyLook(draftedLook(), { preview: true });
  }
  paintSaveState();
  /* The keyring line is the one row in this panel that is not a stored setting
     — it is live state (is there an identity, is it unlocked, which recipient),
     so it is repainted from the worker every time the page is shown rather than
     inherited from whatever the last paint happened to leave behind. */
  initSecrets().then(paintVaultKey, paintVaultKey);
  /* Settings is part of the PANE now, and two things can be lying across that
     pane when you arrive: the sidebar drawer (below W_DOCK) and the assistant,
     which is an overlay or a sheet at anything below W_TRIPANE. A modal used to
     float over both; a page cannot, so each is stood down at the width where it
     would actually be covering the page you just navigated to. Collapsing the
     chat keeps its draft — `toggleChat` is a CSS collapse, not an unmount — and
     it is `persist: false`, because a detour through Settings is not the user
     deciding they are done with the assistant. */
  if (isDrawer()) closeNav();
  if (!isTriPane() && app.classList.contains("chat-open")) toggleChat({ persist: false });
  const body = $("#settingsBody");
  const target = sec && $("#settingsGrp-" + sec);
  if (!target) {
    if (body) body.scrollTop = 0;
    return;
  }
  requestAnimationFrame(() => {
    try {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) {
      target.scrollIntoView();
    }
    target.classList.add("focused");
    setTimeout(() => target.classList.remove("focused"), 1600);
  });
}

/** the settings page's own chrome: which section is current, and the sidebar
    row that says "you are here" */
function paintSettingsRoute() {
  const on = state.view === "settings";
  const link = $("#settingsLink");
  if (link) {
    link.classList.toggle("on", on);
    link.setAttribute("aria-current", on ? "page" : "false");
  }
  $$("#settingsNav button").forEach((b) => {
    const cur = on && b.dataset.sec === state.settingsSection;
    b.classList.toggle("on", cur);
    /* the rail scrolls sideways on a phone, where `/settings/terminal` would
       otherwise arrive with its own tab off the right edge */
    if (cur) {
      try {
        b.scrollIntoView({ inline: "nearest", block: "nearest" });
      } catch (e) {
        /* pre-options scrollIntoView would scroll the whole page — skip it */
      }
    }
  });
  const view = $("#settingsView");
  if (view) view.setAttribute("aria-hidden", on ? "false" : "true");
}

/**
 * Stop showing the settings page. PAINT ONLY — it writes no history, because
 * every way out of Settings is already a navigation that owns its own entry:
 * Back (the entry under it), a tree click or ⌘K pick (`openDoc` pushes), or the
 * Back button (which spends the entry the arrival pushed).
 */
function exitSettings() {
  if (state.view !== "settings") return;
  /* the page stays mounted, so leaving it is the only "close" it has: anything
     typed into a secret field — the vault passphrases OR the terminal's
     password and unlock inputs — must not outlive the visit */
  clearKeyFields();
  clearTerminalSecretFields();
  /* ---------- LEAVING WITH AN UNSAVED DRAFT ----------
     KEEP the draft, REVERT the preview, and SAY SO. The three exits from this
     page are browser Back, a tree/⌘K navigation and the header's Back button,
     and they all land here — but only one of them is a button we could have put
     a modal in front of. A confirm on a browser Back means catching a popstate
     that has already happened and pushing the entry back, which is how a page
     ends up fighting the history stack; and auto-reverting would be exactly the
     silent discard of edits the user believes they made. So nothing is thrown
     away: the draft survives, the toast says it survived, and re-entry (⌘, /
     ⌘/ / the sidebar row / a deep link) paints it again with Save still lit.

     The one thing that does NOT survive is the appearance PREVIEW. A theme is
     the whole app's look, and an unsaved pick must not become the look of a
     page the user is not even on — the preview is a tool for judging a theme
     while you are choosing it, not a half-applied setting. It comes back the
     moment Settings does.

     A reload IS a discard, because the draft is in memory — `beforeunload`
     (wired in `wire()`) is what makes that one loud instead of silent. */
  applyLook(draftedLook(), { preview: false });
  if (settingsDirty()) {
    const n = Object.keys(settingsDraft).length;
    toast(n + " settings change" + (n === 1 ? "" : "s") + " still unsaved — reopen Settings to Save or Discard");
  }
  state.view = "doc";
  state.settingsSection = "";
  app.classList.remove("route-settings");
  paintSettingsRoute();
  /* the pane is showing the doc again; a raw buffer that was mid-edit when
     Settings took over must be re-measured for the textarea's height */
  const ta = $("#rawArea");
  if (ta) autoGrow(ta);
}

/**
 * The Back button, and the only place that decides how leaving Settings meets
 * the history stack. It spends an entry that already exists whenever one does,
 * so a doc → Settings → Back round trip leaves the stack exactly as it found
 * it and FORWARD still gets you back to Settings — `settingsExit` says which
 * side of this entry that entry is on. Only when there is neither (a deep
 * link, a reload: Settings IS the entry the browser handed us) does leaving
 * navigate to the doc the pane kept and let that push.
 *
 * The `canPopBack` re-check is belt and braces: `history.back()` from the
 * bottom of our own stack does not leave Settings, it leaves the APP.
 */
function leaveSettings() {
  if (state.view !== "settings") return;
  if (settingsExit === "back" && canPopBack(history.state)) {
    history.back();
    return;
  }
  if (settingsExit === "forward") {
    history.forward();
    return;
  }
  const path = state.active || homeTarget();
  exitSettings();
  if (path) openDoc(path);
}

/* `meta.ai` is server-declared capability: what the probe found at settings-save
   and every parameter the relay permanently gave up (research §7). Surfaced
   because an app whose whole premise is a pluggable endpoint must never degrade
   without saying so.

   Painted only from paintAiStatus, off `state.meta.ai` — whoever has fresher
   meta assigns it there first, so there is one place this is read from. */
function paintEndpoint() {
  const field = $("#aiEndpointField"),
    note = $("#aiEndpointNote");
  if (!field || !note) return;
  const cur = (state.meta && state.meta.ai) || null;
  if (!cur) {
    field.hidden = true;
    return;
  }
  const p = cur.probe;
  const bits = [];
  if (p && p.probedAt) {
    bits.push(p.responses ? "✓ /responses" : "✗ /responses");
    bits.push(p.toolsWithReasoning ? "✓ tools + reasoning" : "✗ tools + reasoning");
    if (p.error) bits.push(String(p.error).slice(0, 160));
  } else if (p) {
    bits.push("not probed yet");
  }
  const d = cur.degraded || [];
  let html = bits.length ? '<span class="mono">' + bits.map(esc).join(" · ") + "</span>" : "";
  if (d.length) {
    html +=
      (html ? "<br>" : "") +
      '<b style="color:var(--warn,#b26b00)">Degraded:</b> ' +
      d.map((x) => esc(x.message)).join("; ");
  }
  /* The derived status is the same sentence the statusbar's tooltip carries, so
     the two surfaces can never disagree — and it is present even before the
     first probe has landed, which is when "the field is simply blank" was most
     confusing. */
  const st = state.aiStatus || cur.status || null;
  if (st) {
    html =
      '<b class="ep-' +
      esc(st.state) +
      '">' +
      esc(st.state === "ok" ? "Reachable" : st.state[0].toUpperCase() + st.state.slice(1)) +
      "</b> — " +
      esc(st.message) +
      (html ? "<br>" + html : "");
  }
  note.innerHTML = html;
  field.hidden = !html;
}

/**
 * The IMMEDIATE write — one PUT, applied now.
 *
 * After the draft model below, this is no longer how a *setting* is changed:
 * it is how an OPERATION is performed. The two callers left are the credential
 * fields (the GitHub token and the AI key), and they are deliberately not
 * draft state — see the line drawn above `settingsDraft`.
 */
async function pushSettings(patch) {
  try {
    const r = await api.patchSettings(patch);
    state.settings = r.settings;
    state.meta = r.meta;
    return r.settings;
  } catch (err) {
    apiFail(err, "Could not save settings");
    return null;
  }
}

/* ============================================================
   SETTINGS DRAFT — the buffered model behind the Save button

   Every control on this page used to PUT on its own keystroke, which meant a
   Save button would have had nothing left to save and a Cancel nothing left to
   undo. Settings is now a FORM: a control writes a local draft, Save writes the
   draft to the server in one PUT, and "no diff" and "nothing to do" are the
   same state — which is exactly what the Save button's `disabled` reads.

   The draft is a flat map of DOTTED PATH → pending value, never a copy of the
   settings object. Two consequences, both load-bearing:

     · the diff is the map itself. Setting a control back to the value the
       server has DELETES the entry, so flip-and-flip-back returns the button
       to disabled without a deep comparison anywhere;
     · the PUT carries exactly the keys that moved. Nothing re-sends a value the
       user never touched, so two tabs editing different sections cannot clobber
       each other, and `bad-model` can only ever be raised by a model the user
       actually typed.

   ---------- WHAT IS *NOT* DRAFT STATE ----------

   The line is "is this a value with a diff, or a thing that happens?" — and it
   is drawn at the API boundary, not at the visual one:

     · CREDENTIALS (`#gitToken`, `#aiKey`). They are write-only: the server
       serves a MASK, so the field's "current value" is not the value. There is
       nothing to diff against, an unsaved secret sitting in a draft is a secret
       held longer than it needs to be, and a Discard that silently reverted a
       key rotation would be a security surprise. They PUT on change, as before.
     · The TERMINAL PASSWORD (`#termNew`/`#termCurrent`/Set/Change) — same
       reasoning, plus the server hashes it: there is no value to come back.
     · The VAULT PASSPHRASE flow (Generate / Change / Lock). It never touches
       settings at all — it re-wraps `identity.age` in the crypto worker.
     · Every BUTTON that performs an action: unlock, lock, sync now, run a
       command, clear the console, re-probe the AI endpoint. A verb is not a
       setting; none of them has a "before" to revert to.

   All of those keep working exactly as they did, mid-draft, and none of them
   dirties the Save button.
   ============================================================ */

/** dotted path → pending value. Empty object ⟺ no diff ⟺ Save disabled. */
let settingsDraft = Object.create(null);

/** The value the SERVER has, for any path — including the three top-level ones
    (`theme`, `density`, `colorScheme`) that `settingAt` cannot address. */
function savedValue(path) {
  const i = path.indexOf(".");
  return i < 0 ? state.settings[path] : settingAt(path);
}

/** …and the value the CONTROL should be showing: the draft if it has one. */
function draftValue(path) {
  return path in settingsDraft ? settingsDraft[path] : savedValue(path);
}

const settingsDirty = () => Object.keys(settingsDraft).length > 0;

/**
 * Flush the numeric field the caret is sitting in into the draft.
 *
 * The nine `[data-num]` controls record on `change` alone, because the clamp
 * and the step-snap rewrite `value` and doing that on every keystroke would
 * fight the typing. `change` fires on blur or Enter — and `⌘S` is neither, so
 * a field typed into and saved without leaving first had an EMPTY draft: the
 * save returned at its dirty guard with `preventDefault` already spent, the
 * pill said nothing was pending, and `beforeunload` stayed silent too. Every
 * other exit (clicking Save, a tree click, Escape) blurs first and was fine,
 * which is why only the chord lost the edit.
 *
 * Dispatching the control's own `change` rather than duplicating the coercion
 * keeps one implementation of the clamp/snap.
 */
function commitFocusedNumber() {
  const n = document.activeElement;
  if (!n || !n.matches || !n.matches("[data-num]")) return;
  n.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Record a control's new value — or, if it is the value the server already has,
 * un-record it. That second half is the whole diff: it is what makes flipping a
 * switch and flipping it back leave the page as clean as it started.
 */
function setDraft(path, value) {
  if (value === savedValue(path)) delete settingsDraft[path];
  else settingsDraft[path] = value;
  clearSettingsError();
  paintSaveState();
}

/** the flat draft, re-nested into the one-level patch PUT /api/settings takes */
function draftPatch() {
  const patch = {};
  Object.keys(settingsDraft).forEach((path) => {
    const i = path.indexOf(".");
    if (i < 0) {
      patch[path] = settingsDraft[path];
      return;
    }
    const group = path.slice(0, i);
    if (!patch[group]) patch[group] = {};
    patch[group][path.slice(i + 1)] = settingsDraft[path];
  });
  return patch;
}

function paintSaveState() {
  const btn = $("#settingsSave");
  if (!btn) return;
  const n = Object.keys(settingsDraft).length;
  btn.disabled = n === 0;
  const dis = $("#settingsDiscard");
  if (dis) dis.hidden = n === 0;
  const pill = $("#settingsDirty");
  if (pill) {
    pill.hidden = n === 0;
    pill.textContent = n + " unsaved change" + (n === 1 ? "" : "s");
  }
}

/* The server answers a bad value with a TYPED code, and most of those codes
   name exactly one control. Map them, so the message lands under the field the
   user has to fix rather than in a toast that says "somewhere on this page". */
const SETTINGS_ERROR_FIELDS = {
  "unknown-theme": "#themeSeg",
  "unknown-density": "#densitySeg",
  "unknown-color-scheme": "#schemeSeg",
  "bad-effort": "#effortSeg",
  "bad-model": "#aiModel",
  "bad-base-url": "#aiBase",
  "bad-ai": "#aiBase",
  "bad-branch": "#gitBranch",
  "bad-git": "#gitBranch",
  "bad-home-doc": "#homeDoc",
  "bad-editor": "#homeDoc",
  "bad-shell": "#termShell",
  "bad-startupcwd": "#termCwd",
  "bad-terminal": "#termShell",
  "bad-auto-sync": "[data-sw='git.autoSync']",
  "bad-auto-sync-seconds": "[data-num='git.autoSyncSeconds']",
  "bad-retention-days": "[data-num='trash.retentionDays']",
};

function clearSettingsError() {
  const box = $("#settingsErr");
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
  $$(".field.bad").forEach((f) => f.classList.remove("bad"));
  /* park it back in the head: one element, so it can never be orphaned inside a
     field whose error has been fixed */
  const head = $("#settingsView .sv-head");
  if (head && box.parentNode !== head.parentNode) head.parentNode.insertBefore(box, head.nextSibling);
}

/** Show a failed save where it happened, and leave the draft DIRTY — a value
    the server refused has not been saved, and the button must keep saying so. */
function showSettingsError(err) {
  const box = $("#settingsErr");
  if (!box) return;
  clearSettingsError();
  const code = (err && err.code) || "save-failed";
  const msg = (err && err.message) || "Could not save settings";
  box.textContent = msg + " (" + code + ")";
  box.hidden = false;
  const sel = SETTINGS_ERROR_FIELDS[code];
  const ctl = sel && $(sel);
  const field = ctl && ctl.closest(".field");
  if (field) {
    field.classList.add("bad");
    field.appendChild(box);
    try {
      field.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      field.scrollIntoView();
    }
  }
  toast(msg);
}

/**
 * THE save. One PUT carrying exactly the keys that moved; on success the draft
 * becomes the new baseline (the server's answer IS the baseline — it clamps,
 * trims and snaps) and the button goes disabled again.
 */
async function saveSettings() {
  commitFocusedNumber();
  if (!settingsDirty()) return;
  const btn = $("#settingsSave");
  const paths = Object.keys(settingsDraft);
  const patch = draftPatch();
  if (btn) {
    btn.classList.add("busy");
    btn.disabled = true;
  }
  try {
    const r = await api.patchSettings(patch);
    state.settings = r.settings;
    state.meta = r.meta;
    settingsDraft = Object.create(null);
    clearSettingsError();
    /* repaint every control from the SERVER's answer, never from the draft: an
       out-of-range number comes back clamped and an untrimmed path trimmed, and
       a field must never keep a value that was not stored */
    paintSettings();
    applySavedSettings(paths);
    paintSaveState();
    toast("Settings saved");
  } catch (err) {
    /* a 0/network failure has no typed code, and `showSettingsError` says so
       rather than blaming a field */
    showSettingsError(err);
    paintSaveState();
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

/**
 * Live-apply, on SAVE. Every consumer that used to be poked by an individual
 * control's own PUT is poked here instead, from the stored values — so "no
 * restart" is still true, it just now happens once per Save rather than once
 * per keystroke.
 */
function applySavedSettings(paths) {
  const s = state.settings;
  // theme / density / colour scheme — re-applied WITH the pre-paint cache now
  applyLook(paths.filter((p) => LOOK_PATHS.indexOf(p) >= 0), { preview: false });
  applyLockPolicy(); // the crypto worker's idle / hidden / session clocks
  paintHome(); // editor.homeDoc — the vault button's target and title
  if (state.session) {
    state.session.effort = s.ai.effort;
    state.session.model = s.ai.model;
    updateSessionUI();
  }
  /* `terminal.enabled` / `shell` / `startupCwd` change what the SERVER will
     accept, not just what is stored — re-read the verdict rather than assume */
  if (paths.some((p) => p.indexOf("terminal.") === 0)) refreshTerminalStatus();
  if (paths.some((p) => p.indexOf("trash.") === 0)) refreshTrash();
}

/* ---------- settings that arrived from somewhere else ----------

   Every dotted path a settings payload addresses. The shape is fixed at one
   level (scalars at the top, scalar leaves in a group), which is the same shape
   `draftPatch` builds and `savedValue` reads — so this walk cannot disagree
   with them about what a path is. */
function settingPaths(s) {
  const out = [];
  Object.keys(s || {}).forEach((k) => {
    const v = s[k];
    if (v && typeof v === "object" && !Array.isArray(v)) Object.keys(v).forEach((k2) => out.push(k + "." + k2));
    else out.push(k);
  });
  return out;
}

const valueAt = (s, path) => {
  const i = path.indexOf(".");
  if (i < 0) return s ? s[path] : undefined;
  const g = s ? s[path.slice(0, i)] : null;
  return g ? g[path.slice(i + 1)] : undefined;
};

/** The paths whose STORED value actually moved between two payloads. */
function changedSettingPaths(before, after) {
  const seen = Object.create(null);
  const all = [];
  settingPaths(before)
    .concat(settingPaths(after))
    .forEach((p) => {
      if (seen[p]) return;
      seen[p] = true;
      all.push(p);
    });
  return all.filter((p) => valueAt(before, p) !== valueAt(after, p));
}

/**
 * ADOPT A SETTINGS PAYLOAD THIS CLIENT DID NOT WRITE.
 *
 * Settings are vault state, and a tab left open all day used to be the last
 * place to hear about them: they were read at boot and essentially never again,
 * so a theme, a home doc or an auto-lock policy changed on the phone left the
 * desktop painting AND ENFORCING the old one indefinitely, silently.
 *
 * The load-bearing part is the DIFF. The obvious implementation — re-apply
 * every appearance axis that is not currently drafted — reintroduces exactly
 * the regression recorded above `draftedLook()`: it stamps the stored theme
 * over a `?theme=` / `?scheme=` URL override, which is a this-page-load-only
 * look that is deliberately not a setting at all. Applying only the paths whose
 * saved value MOVED leaves an untouched axis untouched, so the override
 * survives — and it makes the saving client's own echo a no-op for free, since
 * `saveSettings` has already assigned the same values by the time this lands.
 */
function adoptSettings(payload) {
  if (!payload || !payload.settings) return;
  /* …and an axis this page load was PINNED to by `?theme=` / `?scheme=` is not
     the vault's to move — see `urlPinnedLook`. */
  const changed = changedSettingPaths(state.settings, payload.settings).filter((p) => urlPinnedLook.indexOf(p) < 0);
  state.settings = payload.settings;
  if (payload.meta) state.meta = payload.meta;
  /* A LIVE DRAFT OUTRANKS AN INCOMING SAVE **ON THE PATHS IT ACTUALLY HOLDS**,
     because those are this user's own pending answer to the same question and
     they are looking at them. It does not outrank anything else: the guard used
     to be the GLOBAL `settingsDirty()`, so one unsaved density click made the
     tab permanently deaf to every incoming change — theme, auto-lock policy,
     terminal verdict — and `exitSettings` deliberately KEEPS a draft past the
     visit, so "permanently" was literal. Worse, the miss was unrepairable: Save
     applies only the paths THIS client drafted and Discard only the drafted
     look axes, so neither one ever reached the adopted path.

     Controls repaint either way — `paintSettings` reads `draftValue`, so a
     drafted field keeps the draft and every other field picks up the new stored
     value. */
  if (settingsDirty()) {
    /* …and the draft is re-diffed against the new baseline, or a field whose
       drafted value is now also the SAVED value would keep claiming to be an
       unsaved change. "Empty object ⟺ no diff" is the invariant this whole
       page rests on. Re-diffed FIRST, so a path the incoming save absorbed is
       no longer drafted and falls through to be applied below — otherwise a
       draft that emptied itself here left the app wearing the old value with
       neither Save nor Discard left to press. */
    Object.keys(settingsDraft).forEach((p) => {
      if (settingsDraft[p] === savedValue(p)) delete settingsDraft[p];
    });
    paintSettings();
    paintSaveState();
    const free = changed.filter((p) => !(p in settingsDraft));
    if (free.length) applySavedSettings(free);
    return;
  }
  if (!changed.length) return;
  paintSettings();
  applySavedSettings(changed);
}

/** Throw the draft away and put every control back on the stored value —
    including ENFORCING it. Discard used to re-apply only the drafted appearance
    axes, so a remote change that collided with a drafted auto-lock policy or
    terminal field was painted and never applied; `applySavedSettings` over the
    same drafted paths is the one call that covers every consumer, and it hands
    `applyLook` exactly the drafted look axes it was handed before. */
function discardSettingsDraft() {
  if (!settingsDirty()) return;
  const paths = Object.keys(settingsDraft);
  const n = paths.length;
  settingsDraft = Object.create(null);
  clearSettingsError();
  paintSettings();
  applySavedSettings(paths);
  paintSaveState();
  toast("Discarded " + n + " unsaved change" + (n === 1 ? "" : "s"));
}

/**
 * APPEARANCE IS THE ONE GROUP THAT PREVIEWS.
 *
 * You cannot judge a theme, a density or a colour scheme from a label — the
 * only way to pick one is to look at the app wearing it. So these three paint
 * the moment they are clicked, while still being ordinary draft entries that
 * only Save persists.
 *
 * `preview` decides ONE further thing: whether the pre-paint localStorage cache
 * is written. That cache predicts the NEXT boot, and the next boot uses the
 * SAVED value — so a preview must never touch it, or leaving without saving
 * would leave the shell booting into a theme that was never stored and snapping
 * out of it a frame later. Leaving the page, saving and discarding all re-apply
 * with `preview: false`, which is what restores both the look and the cache.
 */
const LOOK_APPLIERS = { theme: applyTheme, density: applyDensity, colorScheme: applyColorScheme };
const LOOK_PATHS = Object.keys(LOOK_APPLIERS);

/** The appearance axes that are actually DRAFTED — read before any caller
    clears the draft. An axis nobody touched needs neither previewing nor
    restoring, and re-applying it anyway would stamp the stored value over the
    `?theme=` / `?scheme=` override, which is this-page-load-only and is
    deliberately not a setting at all: previewing a density used to snap the
    whole app out of a URL-previewed theme on the very first click. */
const draftedLook = () => LOOK_PATHS.filter((p) => p in settingsDraft);

/**
 * THE APPEARANCE AXES THIS PAGE LOAD WAS PINNED TO BY THE URL.
 *
 * `?theme=` / `?scheme=` are a look-at-it override for ONE page load that is
 * deliberately not a setting at all (SPEC §9). The moved-paths diff in
 * `adoptSettings` protects an axis a remote save left alone; it cannot protect
 * the pinned axis when the remote save moves THAT one. MEASURED: a page opened
 * at `/?theme=terminal` over a stored `modern` booted pinned as intended and
 * then flipped to `minimal` — cache and all — the moment another device saved a
 * theme, so a kiosk, demo or screenshot tab silently changed appearance
 * mid-session. `start()` records the axes it honoured here and the adopt path
 * skips them.
 *
 * The pin is SPENT by this client applying the axis on purpose (a Save, a
 * Discard, leaving the page with a drafted look) — that is the user answering
 * the question the URL pre-answered, and a pin that outlived it would make the
 * tab permanently deaf to that axis instead.
 */
let urlPinnedLook = [];
const pinLookFromUrl = (axes) => (urlPinnedLook = axes);

/** `axes` is the list to (re-)apply — the drafted ones on the way in and out of
    the page, the SAVED ones after a Save, when the draft is already gone. */
function applyLook(axes, { preview }) {
  const at = preview ? draftValue : savedValue;
  const cache = !preview;
  for (const p of axes) {
    if (!preview) urlPinnedLook = urlPinnedLook.filter((a) => a !== p);
    LOOK_APPLIERS[p](at(p), { cache });
  }
}

/* ============================================================
   SYNC + CONNECTION
   ============================================================ */
function paintSync(s) {
  state.sync = s;
  $("#stSyncTxt").textContent = s.message.replace(" · " + s.remote, "");
  const el_ = $("#stSync");
  el_.classList.toggle("ok", s.state === "synced");
  el_.classList.toggle("warn", s.state !== "synced");
  el_.title = s.message + " · click to sync now";
  $("#stBranch").lastElementChild.textContent = s.branch;
  const line = $("#syncLineTxt");
  if (line) line.textContent = s.message;
}

/* Statusbar chip → POST /api/sync/now. The status arrives twice: once as the
   response here, and once (or more) as `sync-status` on /events while the
   pipeline moves through syncing → synced|error. Both go through paintSync, so
   a client that never sees the response still ends up painted correctly. */
async function syncNow() {
  const chip = $("#stSync");
  chip.classList.add("busy");
  toast("Syncing…");
  try {
    const s = await api.syncNow();
    paintSync(s);
    toast(
      s.state === "error"
        ? "Sync failed — " + s.message
        : s.state === "offline"
        ? "Not syncing — " + s.message
        : "Synced · " + s.message
    );
  } catch (err) {
    apiFail(err, "Could not sync");
  } finally {
    chip.classList.remove("busy");
  }
}

/**
 * How long a stream may say nothing before we stop believing it.
 *
 * 2.5× the server's 20s heartbeat, not 1.5×. Two heartbeats can be lost to
 * ordinary scheduling jitter (a busy event loop, a throttled tab waking up)
 * without the connection being dead, and the threshold has to survive
 * HEARTBEAT_MS being raised server-side without the chip starting to flap —
 * at 1.5× a 40s server heartbeat would put the dot in permanent alarm against a
 * perfectly healthy stream. The cost of the wider window is that a black hole
 * is noticed at ~50s instead of ~30s, which is the right trade: a false
 * "reconnecting…" teaches the user to ignore the chip, and a chip nobody reads
 * is worth nothing at any threshold.
 */
const CONN_STALE_MS = 50_000;
/** How often we ask. Cheap: one subtraction and, at most, one repaint. */
const CONN_WATCH_MS = 5_000;

/** Milliseconds since this stream last carried anything, or Infinity if there
    is no stream to ask. */
function connSilence() {
  const h = state.events;
  return h && h.lastFrame ? Date.now() - h.lastFrame : Infinity;
}

/**
 * THE DOT TELLS THE TRUTH ABOUT WHAT IT KNOWS, WHICH IS LESS THAN IT USED TO
 * CLAIM.
 *
 * It used to be painted straight from the EventSource's state, and an open
 * socket that has gone silent reports state "open" indefinitely (see the note
 * over `connectEvents`) — so "connected" was an assertion about the network
 * that this client had no way to make. Now "connected" means BOTH that the
 * handle is open AND that we have heard from the server recently enough for
 * that to still be worth something; the middle state gets its own word rather
 * than being rounded up to health or down to a reconnect that is not happening
 * yet.
 *
 * `st` is the handle's own state change when there is one; called with nothing
 * (from the watchdog) it repaints from the clock alone.
 */
function paintConn(st) {
  if (st) state.conn = st;
  const c = $("#stConn");
  const txt = $("#stConnTxt");
  const quiet = connSilence() > CONN_STALE_MS;
  const live = state.conn === "open" && !quiet;
  c.classList.toggle("down", !live);
  txt.textContent = live
    ? "connected"
    : state.conn === "open"
    ? "no signal"
    : state.conn === "connecting"
    ? "reconnecting…"
    : "offline";
  c.title =
    "SSE /events · " +
    txt.textContent +
    (state.conn === "open" && quiet ? " — the stream is open but has said nothing for " + Math.round(connSilence() / 1000) + "s" : "");
}

function blipConn() {
  const c = $("#stConn");
  if (c.classList.contains("down")) return;
  c.classList.add("blip");
  setTimeout(() => c.classList.remove("blip"), 900);
}

/**
 * THE WATCHDOG.
 *
 * The server heartbeats every 20s and the client used to answer it with a
 * 900ms CSS blink and nothing else — a liveness signal that was decorative.
 * A stream can stop delivering without ever closing (a NAT rebind drops the
 * flow; both ends still believe they have a socket), and the epoch gap-check
 * that recovers the content lives in `onHello`, so it can only run on a NEW
 * connection. Nothing was making a new connection. MEASURED: 75s of a stale
 * document under a chip reading "connected".
 *
 * Silence past the threshold therefore reconnects, and the existing
 * hello → epoch → resyncAfterGap path does the rest.
 *
 * NEVER gated on a liveness probe first. The obvious `fetch("/healthz")` was
 * MEASURED inside the same black hole: it hung for ~15s (the connect timeout,
 * because the new socket goes to the same dead path) and pushed recovery from
 * 48s to 63s — a check that makes the thing it checks for last longer. The
 * reconnect IS the probe; it either finds a live server or fails and hands the
 * existing backoff its answer.
 *
 * A STUCK RECONNECT IS THE SAME BLACK HOLE, one step further in. The watchdog
 * used to refuse anything that was not `open`, on the theory that `connecting`
 * was owned by the backoff below — it is not: the backoff only arms on
 * `closed`. An EventSource whose request went into the hole sits at readyState
 * 0 forever, `onerror` never fires, so it never reaches `closed` and never
 * re-arms anything. MEASURED against a TCP proxy reproducing a NAT rebind:
 * exactly ONE `GET /events` was issued and the chip read "reconnecting…" for
 * minutes over a superseded document, INCLUDING after the network was fully
 * healed — the same stale document as before, under a different lie. Chrome
 * makes it near-certain by reusing a pooled keep-alive socket, which after a
 * rebind is dead too. So `connecting` is watched as well, from the attempt's
 * own `lastFrame` stamp (seeded at construction in api.js), and every
 * watchdog-initiated retry walks the same backoff rather than storming a
 * genuinely dead network with an attempt per 5s.
 */
let connWatchT = null;
/* One tick of grace, so the middle state can actually be SEEN. `paintConn` and
   `connect` in the same task are one frame: the chip went straight from
   "connected" to "reconnecting…" and "no signal" — the word SPEC §9 promises an
   open-but-silent stream — was written and never rendered. The cost is 5s of
   later recovery on a path that has already been silent for 50. */
let connQuietSeen = false;

function checkConn() {
  paintConn();
  const h = state.events;
  if (!h) return;
  const quiet = connSilence() > CONN_STALE_MS;
  if (h.state === "open") {
    if (!quiet) {
      connQuietSeen = false;
      return;
    }
    if (!connQuietSeen) {
      connQuietSeen = true; // this tick paints "no signal"; the next one acts
      return;
    }
    connQuietSeen = false;
    reconnectSoon();
  } else if (h.state === "connecting" && quiet) {
    /* the attempt itself went into the hole — nothing will ever close it */
    reconnectSoon();
  }
}

function startConnWatch() {
  if (connWatchT) return;
  connWatchT = setInterval(checkConn, CONN_WATCH_MS);
}

/* EventSource retries on its own for ordinary drops, but a stream that dies
   mid-flight (backend restart, worker killed) can leave it CLOSED for good.
   Own the recovery so the dot never lies about being permanently offline. */
let reconnectT = null;
let reconnectWait = 0;

/** The 1→2→4→15s walk, shared by both things that ask for a retry: a stream
    that CLOSED, and the watchdog noticing one that never will. A retry already
    scheduled is left alone — the watchdog ticks every 5s and must not restart
    the wait it is waiting on. */
function reconnectSoon() {
  if (reconnectT) return;
  reconnectWait = Math.min(15000, (reconnectWait || 1000) * 2);
  reconnectT = setTimeout(connect, reconnectWait);
}

function connect() {
  startConnWatch();
  clearTimeout(reconnectT);
  reconnectT = null;
  connQuietSeen = false;
  if (state.events) {
    const prev = state.events;
    state.events = null; /* a close we asked for must not schedule a retry */
    prev.close();
  }
  paintConn("connecting");
  state.events = api.connectEvents({
    onState: (st) => {
      paintConn(st);
      if (st === "open") {
        reconnectWait = 0;
        /* The stream keeps no backlog, so an `ai-status` pushed while we were
           away (or before this client existed — the boot probe finishes in the
           first second) is simply gone. Re-read it once per CONNECTION, which
           is not a timer: a stable session reads it exactly once. */
        api.getAiStatus().then(
          (r) => r && r.status && paintAiStatus(r.status),
          () => {}
        );
        /* Same reasoning, same block: a `settings-changed` pushed while this
           client was disconnected is gone, and settings do NOT move the vault
           epoch — so `resyncAfterGap` (which only runs on an epoch change) can
           never cover them. That is the whole reason this sits here and not
           there: put beside the tree re-read it would be dead code. */
        api.getSettings().then(adoptSettings, () => {});
      } else if (st === "closed" && state.events) {
        reconnectSoon();
      }
    },
    /* The blink is the decoration; the repaint is the point. A stream that has
       just spoken after a silent stretch has to be able to earn "connected"
       back before the next 5s watchdog tick, and `blipConn` refuses to blink at
       all while the chip is `.down` — so the repaint has to come first. */
    onHeartbeat: () => {
      paintConn();
      blipConn();
    },
    onSyncStatus: paintSync,
    /* pushed by the relay whenever the endpoint's real status changes — a
       finished probe, a turn that failed, a rung the ladder took. The statusbar
       item therefore never polls and never guesses. */
    onAiStatus: paintAiStatus,
    /* Settings saved by ANOTHER client (or another tab of this one). Masked
       already — see the note on this event in api.js. */
    onSettingsChanged: adoptSettings,
    /* The whole server list, not a mutation hint. A permanent purge has no
       doc-changed frame, so this is the only way an already-open drawer on a
       second client can remove the row promptly. */
    onTrashChanged: adoptTrash,
    /* A terminal command record changed state — a NOTIFICATION carrying an id
       and nothing else, because this stream is not behind the terminal
       password. The content comes back over the bearer-gated route, and only
       if this tab is actually unlocked; a locked tab learns nothing. */
    onTerminalCommand: () => {
      if (api.terminalHasToken()) loadCommands().then(renderChat);
    },
    /* The stream keeps no backlog, so anything that happened while we were
       disconnected is invisible. The server's vault epoch changes on every
       announced change: a different epoch than the one we last saw means we
       missed something and must re-read rather than keep showing stale text. */
    onHello: (d) => {
      const e = d && d.epoch;
      if (e == null) return;
      const missed = state.epoch != null && e !== state.epoch;
      state.epoch = e;
      if (missed) resyncAfterGap();
    },
    onDocChanged: async (d) => {
      if (!d) return;
      blipConn();
      /* A move arrives as a PAIR: the old path with removed+`to`, the new path
         with `from` (API.md § Events). The old half carries everything needed
         to follow the doc, so the new half only has to refresh the tree — which
         is what makes a second client converge with no manual reload. */
      if (d.reason === "moved") {
        if (!d.removed) {
          await loadTree().catch(() => {});
          return;
        }
        /* Follow the move only if the moved doc is still the one the user is on.
           A `moved` echo can land more than a second late (the watcher's own
           reconcile re-reports a move the API already announced), by which time
           the user may have clicked something else — following then would yank
           the pane back to a doc they have left. viewedPath() counts a click
           whose fetch is still in flight, which state.active cannot. */
        const wasActive = d.path === viewedPath();
        const cached = state.docs.get(d.path);
        state.docs.delete(d.path);
        if (wasActive && d.to) {
          state.active = d.to;
          if (state.dirty) {
            /* never clobber typing: keep the buffer, just retarget it. The next
               save is an ordinary write to the new path. */
            if (cached) state.docs.set(d.to, Object.assign({}, cached, { path: d.to, name: d.to.split("/").pop() }));
            await loadTree().catch(() => {});
            /* the buffer stays put but its address changed — the one place a
               re-home cannot go through openDoc, so the URL is followed here */
            routeDoc(d.to, true);
            renderDoc({ noFade: true });
            /* sticky for the same reason the deleted half is: the doc under an
               unsaved buffer changed address, and the user has to be able to
               still be reading that when they look back at the screen */
            toast("Moved to " + d.to + " — your unsaved changes are still here", { sticky: true });
            return;
          }
          const ours = navGate();
          state.active = null;
          await loadTree().catch(() => {});
          if (!ours()) return; // the user (or the local move) already navigated
          const next = state.docs.get(d.to);
          if (next) next.loaded = false;
          await openDoc(d.to, { replace: true }).catch(() => {});
          toast("Moved to " + d.to);
          return;
        }
        await loadTree().catch(() => {});
        return;
      }
      /* THE DELETED HALF, and the one that used to throw work away.
         `moved` above already says it in a comment — "never clobber typing:
         keep the buffer, just retarget it" — and this branch was the
         uncommented omission of the same rule: it dropped the cache entry
         unconditionally, and `doSaveDoc` opens with `if (!doc) return false`,
         so the next ⌘S issued NO request, raised NO veil and showed NO toast
         while the indicator went on reading "Unsaved changes" forever.
         MEASURED: ~1000 characters, gone with a 1.9s notice as their only
         trace.

         So a DIRTY buffer survives the doc leaving the vault. It becomes an
         ORPHAN: still on screen, still editable, but with no file behind it —
         which `doSaveDoc` turns into an explicit Recreate-or-Discard rather
         than a silent no-op. This fires on any external removal too (a git
         pull, an `rm`), which is exactly when the buffer is the only copy left.

         Scoped to DIRTY, deliberately: a clean orphan is a cache entry whose
         every byte is also in git, and keeping those around would leave the
         tree and the cache disagreeing for no benefit. */
      if (d.removed) {
        const cached = state.docs.get(d.path);
        const keep = !!cached && d.path === state.active && state.dirty;
        if (keep) cached.orphaned = true;
        else state.docs.delete(d.path);
        loadTree().catch(() => {});
        /* something left the vault — from this tab, another tab, or an `rm`.
           Only a delete through the app puts it in the trash, but only the
           trash itself knows that, so ask rather than assume either way. */
        if (state.trash.available) refreshTrash();
        if (d.path === state.active) {
          const how = d.path + (d.reason === "deleted" ? " was deleted" : " was deleted on disk");
          if (keep) toast(how + " — your unsaved text is still here. Save to recreate it.", { sticky: true });
          else toast(how);
        }
        return;
      }
      const cached = state.docs.get(d.path);
      if (cached && cached.rev === d.rev) return; // our own echo
      if (state.saving.has(d.path)) return; // a write of ours is in flight
      if (d.path === state.active && state.dirty) return; // never clobber typing
      if (d.reason === "created") {
        loadTree().catch(() => {});
        return;
      }
      try {
        const fresh = await api.getDoc(d.path);
        state.docs.set(d.path, setBaseline(Object.assign({}, cached || {}, fresh, { loaded: true }), fresh.markdown));
        if (d.path === state.active) {
          const sc = $("#scroll");
          const keep = sc ? sc.scrollTop : 0;
          renderDoc({ noFade: true });
          if (sc) sc.scrollTop = Math.min(keep, sc.scrollHeight - sc.clientHeight);
          if (d.reason === "external") toast("Reloaded from disk");
        }
      } catch (e) {}
    },
  });
}

/* Re-read everything we cannot know is still current after a stream gap. A
   dirty buffer is never touched — the next save raises the conflict banner. */
async function resyncAfterGap() {
  await loadTree().catch(() => {});
  const path = state.active;
  if (!path || state.dirty || state.saving.has(path)) return;
  try {
    const fresh = await api.getDoc(path);
    const cached = state.docs.get(path);
    if (cached && cached.rev === fresh.rev) return;
    state.docs.set(path, setBaseline(Object.assign({}, cached || {}, fresh, { loaded: true }), fresh.markdown));
    renderDoc({ noFade: true });
    toast("Reloaded from disk");
  } catch (e) {}
}

/* ---------- the page's own lifecycle: flush on the way out, heal on the way in ----------

   `pagehide` used to be the ONLY flush, and iOS does not reliably fire it when
   a backgrounded tab is discarded — the OS freezes the page at
   `visibilitychange` and may never run another line of it. `markDirty` is a
   plain `setTimeout` at editor.autosaveSeconds, and a frozen page runs no
   timers, so up to ten seconds of typing had no path to disk at all. MEASURED:
   after visibilitychange→hidden the canary text was not in the file; after
   pagehide it was.

   So `hidden` now runs exactly what `pagehide` runs. Deliberately NOT by
   lowering editor.autosaveSeconds: SPEC §4 fixes it at 10, and a shorter timer
   would be both a worse fix (it still cannot run while frozen) and pointless
   once the flush happens at the boundary itself.

   `leaving` is the difference between the two callers, and it is `quiet` that
   turns on it: a page on its way out has nowhere to put a question, so an
   orphaned buffer keeps its sticky notice and says nothing. A page that is
   coming BACK does have somewhere — that is the one moment the veil is worth
   raising — and it is also the moment a failure has somebody to report to.
   (`keepalive` rides along with it because only an unloading request needs to
   outlive its document; api.js already drops it for a body over the budget.) */
function flushBuffer(opts) {
  if (!state.dirty || !state.active) return;
  syncRaw();
  const leaving = !!(opts && opts.leaving);
  saveDoc(state.active, { silent: true, quiet: leaving, keepalive: leaving });
}

/** …and the mirror: a page coming back has missed everything the stream carried
    while it was away, because the stream keeps no backlog. Reconnect first (the
    `hello` → epoch check is what NOTICES a gap), then re-read what we cannot
    know is still current. Both are safe on a page that missed nothing:
    `resyncAfterGap` compares revs and `connect` is idempotent. */
function healAfterGap() {
  if (!state.events || state.events.state !== "open") connect();
  /* …and RETRY THE WRITE, which nothing else here does. `doSaveDoc` clears
     `dirtyT` before it attempts the PUT and only `markDirty` re-arms it, so a
     save that failed while the network was down is the LAST attempt: the timer
     is gone and `resyncAfterGap` returns immediately on a dirty buffer by
     design. MEASURED: after the network came back the chip read "connected"
     beside an indicator reading "Unsaved changes", and the text was still not
     on disk 7.5× the debounce later — it took another keystroke. `flushBuffer`
     no-ops on a clean buffer, so this costs nothing on the ordinary path. */
  flushBuffer();
  resyncAfterGap().catch(() => {});
}

/* ============================================================
   OVERLAYS / ESC
   ============================================================ */
const isOpen = (sel) => {
  const n = $(sel);
  return !!n && n.classList.contains("show");
};
function openSess() {
  $("#sessPop").classList.add("show");
  $("#sessChip").setAttribute("aria-expanded", "true");
  updateSessionUI();
}
function closeSess() {
  $("#sessPop").classList.remove("show");
  $("#sessChip").setAttribute("aria-expanded", "false");
}
function overlayOpen() {
  return VEILS.some(isOpen) || $("#sessPop").classList.contains("show") || !!state.creating || !!state.renaming;
}

/* The veils, most-modal first. Same order dismissTop() unwinds them in.
   The confirm sits above settings (it can be raised from a row behind it) and
   below the palette. */
/* Settings is NOT here any more: it is a page at `/settings`, not an overlay,
   so Esc has nothing of its to dismiss and `dismissTop()` unwinds exactly the
   layers that really float above the app. */
/* The exit guard is LAST, one layer above the editor it guards and below every
   other modal: Esc with the palette (or a confirm, or the conflict banner) open
   over it must close that first, and only the Esc that reaches the bottom of the
   modal stack is the one that means "Keep editing". */
const VEILS = ["#palVeil", "#scVeil", "#ppVeil", "#cxVeil", "#cfVeil", "#xgVeil"];
const hide = (sel) => $(sel).classList.remove("show");
/* veils whose close is more than hiding the node; the rest fall back to hide */
const CLOSERS = {
  "#palVeil": closePal,
  "#ppVeil": closePP,
  "#cxVeil": closeConflict,
  "#cfVeil": closeConfirm,
  "#xgVeil": closeExitGuard,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside the open modal.
 *
 * Without this, Tab out of the passphrase modal landed in `#palInput` — the ⌘K
 * search box, which is hidden but still in the tab order (a `.veil` is hidden
 * with opacity, never `display`/`visibility`) and which fires
 * `GET /api/search?q=…` on every keystroke. The masked field simply stopped
 * accepting characters, which is exactly the moment a user retypes the whole
 * passphrase — into a server-bound URL. SPEC §11: "plaintext never in any
 * server-bound request". The CSS now makes hidden veils untabbable as well;
 * this keeps focus off the DOCUMENT (`#rawArea` is a textarea that gets saved
 * to disk and pushed to git).
 */
function trapTab(e) {
  /* the palette drives its own Tab (it moves the result cursor) — never fight
     a handler that has already claimed the key */
  if (e.defaultPrevented) return;
  const sel = VEILS.filter(isOpen)[0];
  if (!sel) return;
  const veil = $(sel);
  const nodes = $$(FOCUSABLE, veil).filter((n) => !n.hidden && n.offsetParent !== null && !n.closest("[hidden]"));
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const a = document.activeElement;
  if (!veil.contains(a)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && a === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && a === last) {
    e.preventDefault();
    first.focus();
  }
}

function dismissTop() {
  for (const sel of VEILS) {
    if (!isOpen(sel)) continue;
    (CLOSERS[sel] || hide)(sel);
    return true;
  }
  /* popovers, below every modal: a confirm raised FROM the context menu must
     take the first Esc, and it does — the menu is already closed by then */
  if (closeCtx()) return true;
  if ($("#sessPop").classList.contains("show")) {
    closeSess();
    return true;
  }
  if (state.creating) {
    state.creating = null;
    renderTree();
    return true;
  }
  if (state.renaming) {
    state.renaming = null;
    renderTree();
    return true;
  }
  /**
   * THE EDITOR LAYER — Esc leaves Raw (SPEC §4).
   *
   * It used to only BLUR the textarea, which is a state nothing else in this
   * app can see: the mode chip still read "Raw", the caret was simply gone, and
   * the second Esc closed the chat panel. Esc now does what the user means by
   * it — go back to reading — and the mode it lands in is Preview.
   *
   * With a buffer that does not match the file, `setMode` stops at the exit
   * guard instead and this Esc raises the diff. Either way Esc was consumed by
   * the editor, so the layers below it (the drawer, the chat panel) do not also
   * get it — which is the same ordering the blur had.
   *
   * Scoped to focus that BELONGS to the editor. Esc with the caret in a sidebar
   * filter, the terminal line or a settings field is that surface's Esc, and
   * every one of those either handles it first or falls through to the layers
   * below exactly as before.
   */
  const ta = $("#rawArea");
  const at = document.activeElement;
  if (ta && state.view !== "settings" && state.mode === "raw" && (at === ta || at === document.body || at === null)) {
    setMode("preview", { silent: true });
    return true;
  }
  if (isDrawer() && app.classList.contains("nav-open")) {
    closeNav();
    return true;
  }
  /**
   * THE BOTTOM LAYER: the chat panel, at every width (it used to be dismissed
   * only in the mobile sheet). Deliberately last, so every rule above still
   * holds — a modal, the palette, the context menu, the session popover, an
   * inline tree editor and Raw-to-Preview each take Esc first, and only
   * once nothing else is up does Esc close the panel.
   *
   * The DRAFT IS NEVER LOST. `toggleChat` collapses a grid column above
   * W_TRIPANE and slides an overlay off-canvas below it; either way #composer
   * and its value stay in the DOM, so reopening shows the half-typed message
   * exactly as it was. And Esc *inside* the composer never reaches this — the
   * composer's own handler blurs it first (see wire()), so Esc mid-sentence
   * costs a focus, not a panel; the second press lands here.
   */
  if (app.classList.contains("chat-open")) {
    toggleChat();
    return true;
  }
  return false;
}

/* ============================================================
   ROUTING — one URL per PLACE the pane can be

   Two shapes, one stack:

     `/d/<vault-relative path, each segment percent-encoded>` — the open doc,
     e.g. `/d/architecture/event-pipeline.md`. The doc path stays a real path so
     the URL is readable and copy-pasteable, and the `/d/` prefix is what makes
     it collision-free forever: `/api/*`, `/events`, `/vendor/*`, `/healthz` and
     every file under app/ live on other first segments, so no vault path can
     ever shadow a route.

     `/settings`, `/settings/<section>` — the settings page. It is the pane's
     other content, not an overlay, so it is a real address: deep-linkable,
     reloadable, and Back from it returns to the doc you were reading. The
     section is in the URL because "open Settings AT the AI group" is exactly
     what the statusbar chip does, and that should be a link anyone can send.

   The server answers both prefixes with the SPA shell.

   MODE (preview ⇄ raw) is deliberately NOT in the URL and creates no entry: it
   is how you are looking at the doc, not which doc you are looking at. Five
   ⌘E presses then Back must land on the previous DOC. A settings SECTION is
   the same kind of thing one level down — it is where you are on a page, so it
   REPLACES the entry: six rail clicks then Back leaves Settings, it does not
   walk you back through six scroll positions.

   There are exactly three writers — `routeDoc`, called only from `openDoc` (the
   single navigation funnel), `routeSettings`, called only from `showSettings`
   (the single settings funnel), and `routeVeil`, driven by one MutationObserver
   over the veils. Nothing else in this file touches `history`.
   ============================================================ */

/* the SAME encoder `/api/docs/{path}` uses — a doc URL and the request that
   fetches that doc must agree segment for segment, so there is one rule.

   The query survives the rewrite. Before routing existed the URL never changed,
   so `?theme=terminal` — an affordance Settings › Theme advertises in so many
   words — lasted the life of the tab and across reloads. Boot ends in a
   replaceState, so dropping it here meant the theme lived exactly one page load
   and the URL could no longer be reloaded or shared. */
const docUrl = (p) => "/d/" + api.encPath(p) + location.search;

/** the doc named by the address bar, or null when we are on the bare shell */
function urlDoc() {
  const m = /^\/d\/(.+)$/.exec(location.pathname);
  if (!m) return null;
  try {
    return m[1].split("/").map(decodeURIComponent).join("/");
  } catch (e) {
    return null;
  }
}

/* The settings page's address. The section list is here and nowhere else: an
   unknown one (a typo, a link from a future version) degrades to the top of the
   page rather than 404ing or flashing a section that does not exist. It is the
   same list the rail in index.html carries, and `#settingsGrp-<section>` is
   what both resolve to. */
const SETTINGS_SECTIONS = ["appearance", "editing", "trash", "git", "secrets", "ai", "terminal"];
/* `location.search` rides along for the same reason `docUrl` keeps it:
   `?theme=terminal` must survive every rewrite or it lasts one page load. */
const settingsUrl = (sec) => "/settings" + (sec ? "/" + encodeURIComponent(sec) : "") + location.search;

/** `{ section }` when the address bar names the settings page, else null */
function urlSettings() {
  const m = /^\/settings(?:\/([^/]*))?\/?$/.exec(location.pathname);
  if (!m) return null;
  let sec = "";
  try {
    sec = m[1] ? decodeURIComponent(m[1]) : "";
  } catch (e) {
    sec = "";
  }
  return { section: SETTINGS_SECTIONS.includes(sec) ? sec : "" };
}

/* Entries carry a monotonic `i` purely so a popstate can tell BACK from
   FORWARD — the DOM gives no other way to know which way the user went, and
   `i === 1` is additionally what `canPopBack` reads (see there). Boot seeds
   `histSeq` from the entry the browser handed us, so a reload in the MIDDLE of
   the stack cannot mint numbers this stack has already spent. */
let histSeq = 0;
let histAt = 0;

/**
 * Is there an app entry UNDER the one we are standing on?
 *
 * Boot numbers the entry the browser handed us 1 (`routeDoc` replaces it, and
 * a replace keeps its `i`), so everything above it was PUSHED onto an app
 * entry and everything at it is the bottom of our stack. Below entry 1 is
 * either nothing or another site: `history.back()` there takes the tab out of
 * the app entirely, dropping an unlocked vault, the terminal session and every
 * revealed block with it.
 */
const canPopBack = (st) => (((st && st.i) || 0) > 1);

/**
 * How the Back button leaves the settings entry we are STANDING ON — a
 * property of that entry, never of the last arrival, which is why every
 * arrival writes it (a popstate included; inheriting it is what let Back walk
 * off the bottom of the stack):
 *
 *   "back"    an app entry sits directly under this one — we pushed onto it,
 *             or we walked FORWARD onto this one from it;
 *   "forward" we walked BACK onto this entry, so the entry we came from is
 *             still ahead and spending it truncates nothing;
 *   "open"    neither: this is the entry the browser handed us (deep link,
 *             reload), so leaving has to navigate and let that push.
 *
 * Only `leaveSettings` reads it.
 */
let settingsExit = "open";

/**
 * Record the doc on screen. Called from openDoc AFTER the fetch resolved, so a
 * navigation that 404s never leaves an entry behind.
 *
 * Reuses the current entry instead of stacking a new one when: the caller says
 * so (`replace` — a rename/delete re-home, or a popstate we are just catching
 * up with, where an entry already exists and Back must not return to a path
 * that no longer resolves), the doc is already the one this entry names
 * (re-clicking the open doc), or the entry is the marker an overlay pushed (a
 * ⌘K pick closes the palette and navigates in one gesture — one entry, not two).
 */
function routeDoc(path, replace) {
  const cur = history.state || {};
  /* …but ONLY when the navigation actually closed the overlay. ⌘K is not
     blocked while Settings is up, and `closePal()` closes only the palette, so
     a ⌘K pick over Settings navigated with Settings still open and marker-less.
     The same shape is reachable without a gesture, from anything that re-homes
     the pane while an overlay is up (the SSE `moved` echo, accept/revert
     Proposal — all `openDoc(…, {replace: true})`). The next BACK then hit
     `onPop`'s dismissal branch on an entry the browser had ALREADY traversed
     away from, leaving the URL naming one doc and the pane showing another for
     the rest of the session. Keep the marker; only its URL follows the pane. */
  if (cur.z === "veil" && VEILS.some(isOpen)) {
    history.replaceState({ z: "veil", i: cur.i }, "", docUrl(path));
    return;
  }
  const reuse = !!replace || cur.z === "veil" || (cur.z === "doc" && cur.path === path);
  const st = { z: "doc", path: path, i: reuse && cur.i != null ? cur.i : ++histSeq };
  histAt = st.i;
  history[reuse ? "replaceState" : "pushState"](st, "", docUrl(path));
}

/**
 * Record the settings page. Called only from `showSettings`, the twin of
 * `routeDoc` and deliberately the same shape:
 *
 *   - an overlay's marker is recycled, never stacked on (⌘K works over the
 *     settings page exactly as it works over a doc, and a pick that navigates
 *     costs one entry);
 *   - arriving from a doc PUSHES, so Back returns to the doc and Forward comes
 *     back here — the whole point of the move;
 *   - arriving when we are already here REPLACES, so the section rail and the
 *     statusbar chip rewrite the address instead of stacking scroll positions.
 */
function routeSettings(section, replace) {
  const cur = history.state || {};
  if (cur.z === "veil" && VEILS.some(isOpen)) {
    /* a marker is always PUSHED, so an app entry sits under this one */
    settingsExit = "back";
    history.replaceState({ z: "veil", i: cur.i }, "", settingsUrl(section));
    return;
  }
  const reuse = !!replace || cur.z === "veil" || cur.z === "settings";
  const st = { z: "settings", section: section || "", i: reuse && cur.i != null ? cur.i : ++histSeq };
  histAt = st.i;
  /* `settingsExit` is about the ARRIVAL, so a rail click — which replaces the
     settings entry we are already standing on — must not rewrite what the
     arrival recorded. Everything else does: a push lands on the entry we came
     from, a recycled overlay marker was itself pushed over one, and replacing
     the entry the browser handed us leaves nothing underneath at all. */
  if (!reuse || cur.z === "veil") settingsExit = "back";
  else if (cur.z !== "settings") settingsExit = "open";
  history[reuse ? "replaceState" : "pushState"](st, "", settingsUrl(section));
}

/**
 * An open overlay owns one history entry, so Back dismisses it instead of
 * leaving the doc. This is the whole mechanism: opening pushes a marker,
 * closing does nothing at all. A marker the user walks back through is spent
 * on `dismissTop()`; a marker its overlay outlived (Esc closed it) is skipped
 * in `onPop`; a marker a navigation lands on is recycled by `routeDoc`. No
 * timers, no in-flight traversal to cancel, no ordering to get wrong.
 */
function routeVeil() {
  if (!VEILS.some(isOpen)) return;
  if ((history.state || {}).z === "veil") return;
  /* pushing truncates whatever was ahead, so a settings entry that meant to
     leave by spending a FORWARD entry no longer has one to spend */
  if (settingsExit === "forward") settingsExit = "open";
  histAt = ++histSeq;
  history.pushState({ z: "veil", i: histAt }, "", location.href);
}

/**
 * The traversal the exit guard is putting back, or null.
 *
 * A popstate is an announcement, not a request: by the time we hear about a
 * Back it has already happened, so the only way to hold it is to UNDO it with
 * a `history.forward()` and re-issue it if the user says leave.
 *
 * The dialog is raised on the popstate that lands us back where we were, NOT
 * on the one we intercepted — that ordering is load-bearing. Opening any veil
 * makes `routeVeil` push a marker entry, and a push TRUNCATES everything ahead
 * of it: raising the dialog first would destroy the forward entry the very next
 * line was about to spend.
 */
let guardPop = null;

function onPop(e) {
  const st = e.state || {};
  if (guardPop) {
    const g = guardPop;
    guardPop = null;
    histAt = st.i || 0;
    /* we are standing where the user was again; now ask */
    guardRawExit(g.replay);
    return;
  }
  const back = (st.i || 0) < histAt;
  /**
   * BROWSER BACK OUT OF A DIRTY RAW BUFFER (SPEC §4).
   *
   * Only BACK, and only when the traversal really leaves: a pop that lands on
   * the entry directly under a marker with nothing below it changes nothing on
   * screen, and a dialog in front of a no-op is noise. FORWARD is deliberately
   * left alone — it is not a way anyone leaves an edit, and holding it would
   * mean pushing the guard's marker over the entry it was trying to reach.
   *
   * A veil already up owns this press (the branch below dismisses it), so the
   * guard never competes with the dismissal — including with ITSELF: Back with
   * this dialog open is Keep editing, exactly as Esc is.
   */
  const noop = st.z === "doc" && st.path === viewedPath() && !canPopBack(st);
  if (back && !noop && !VEILS.some(isOpen) && rawExitDiff()) {
    /* histAt deliberately NOT moved: we are about to be put back on the entry
       it already names, and the forward() below is what lands us there */
    guardPop = { replay: () => history.back() };
    history.forward();
    return;
  }
  histAt = st.i || 0;
  /* Back with a modal up closes the modal. We have landed on the doc entry
     under the marker — the same doc — so there is nothing else to do, and a
     stacked overlay (confirm over settings) re-arms the marker for the next
     press rather than stranding the app one Back from navigating out. */
  if (VEILS.some(isOpen)) {
    dismissTop();
    /* The entry under a marker names the PLACE that was on screen when the
       marker was pushed. If the pane has moved since — a ⌘K pick over the
       settings page, a `moved` echo, an accepted proposal that re-homed the doc
       — that is no longer what is on screen, and leaving it would strand the
       URL on a different note for reload, for copy-link and for every later
       BACK/FORWARD. */
    if (state.view === "settings") {
      if (st.z !== "settings") routeSettings(state.settingsSection, true);
    } else {
      const shown = viewedPath();
      if (shown && st.path !== shown) routeDoc(shown, true);
    }
    routeVeil();
    return;
  }
  /* Walking INTO a settings entry: paint the page, write nothing — the entry we
     are reacting to is the entry. Section included, so Back/Forward through
     `/settings/ai` lands on the AI group and not merely on the page.
     …unless the page is already this exact page, which is the settings twin of
     the doc case below: the entry directly under a marker names the same place,
     so spend nothing on it and keep going the way the user asked. */
  if (st.z === "settings") {
    /* How Back leaves is decided by the entry we LAND on, never by the last
       arrival: walking back means the entry we came from is still ahead, and
       walking forward means the one we came from is still underneath. */
    settingsExit = back ? "forward" : "back";
    if (state.view === "settings") {
      /* Two settings entries can only ever be ADJACENT because an overlay
         marker over the page was recycled into one — the rail replaces, so a
         section change never stacks. Same page either way: repaint whatever
         section this entry names (so the address and the pane still agree in
         the FORWARD direction) and otherwise spend nothing here, keeping going
         the way the user asked. */
      if ((st.section || "") !== state.settingsSection) showSettings(st.section, { route: false });
      if (back && canPopBack(st)) history.back();
      return;
    }
    showSettings(st.section, { route: false });
    return;
  }
  /* A marker its overlay outlived. Its URL names wherever the pane was when the
     marker was pushed — which, since Settings became a place, is not always
     where the pane is now (⌘, over an open overlay re-homes the marker onto
     `/settings`, and Back out of it leaves the marker ahead of you). Put the URL
     back on what is really on screen before walking past it, so a FORWARD onto
     a spent marker can never leave the address bar describing another page. */
  if (st.z === "veil") {
    if (state.view === "settings") routeSettings(state.settingsSection, true);
    else {
      const here = viewedPath();
      if (here) routeDoc(here, true);
    }
    if (back) history.back();
    return;
  }
  /* Walking OUT of it. The doc never moved while Settings was up, so the entry
     under it names the doc still in `state.active` — which is precisely the
     shape the skip below exists to eat. Leaving must not be skipped, or one
     Back would sail past the doc it was supposed to return to. */
  const leaving = state.view === "settings";
  if (leaving) exitSettings();
  /* The entry directly under a marker: the only way two neighbouring entries
     name the same doc. Spend nothing on it — keep going the way the user asked.
     (Markers themselves were handled above.) */
  if (!leaving && st.z === "doc" && st.path === viewedPath()) {
    if (back && canPopBack(st)) history.back();
    return;
  }
  const path = st.path || urlDoc();
  if (path && path !== viewedPath()) openDoc(path, { replace: true });
}

/** a deep-linked doc must be visible in the tree, not buried in a closed folder
    — the doc's ancestors are exactly `revealFolder(dirname(path))` */
function revealInTree(path) {
  if (revealFolder(dirname(path))) renderTree();
}

/* ============================================================
   HOME — the vault button (SPEC §9)

   Which doc is `editor.homeDoc`, a real setting: Settings › Editing, the
   `[editor] homeDoc` key in settings.toml, and `meta.homeDocDefault` so the
   field's placeholder comes from the server like every other option list. Live:
   changing it repaints the button's title/aria immediately, no reload.

   It is a NAVIGATION, not a view change — `openDoc` is the single funnel and it
   pushes a history entry, so Back returns to wherever you came from.
   ============================================================ */

/**
 * The configured home doc, normalised to a doc path. `""` means "no home doc
 * configured", which falls back to the first doc rather than doing nothing.
 * `home = "index"` and `home = "index.md"` are the same doc, the same rule
 * `commitCreate` applies to a typed name.
 */
function homeTarget() {
  const raw = String(settingAt("editor.homeDoc") || "").trim();
  if (!raw) return "";
  return /\.md$/i.test(raw) ? raw : raw + ".md";
}

/** Say where the button goes, in the tooltip and to a screen reader. */
function paintHome() {
  const btn = $("#homeBtn");
  if (!btn) return;
  const p = homeTarget();
  const label = "Home — open " + (p || "the first doc in this vault");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

/** Whatever is first in the tree — never a folder path (see findDoc). */
function openFirstDoc() {
  const first = findDoc(state.tree, (n) => !n.empty) || findDoc(state.tree, () => true);
  if (first) return openDoc(first);
  toast("This vault has no docs yet");
}

/**
 * A missing home doc is a MISCONFIGURATION, not a dead end.
 *
 * Falling back silently would hide the fact that the setting names nothing, and
 * refusing outright would leave the button inert — so it does what a broken
 * `[[link]]` already does in this app (SPEC §5): says what is wrong and offers
 * to create it. Cancel is not a dead end either; it opens the first doc, so the
 * button always lands somewhere.
 */
function goHome() {
  const p = homeTarget();
  if (!p) return openFirstDoc();
  if (state.docPaths.has(p)) return openDoc(p);
  confirmDialog({
    title: "Home doc does not exist",
    path: p,
    body:
      "Settings › Editing › Home doc names a doc this vault does not have. Create it now, or cancel to open the first doc instead.",
    ok: "Create it",
    /* a create is not a delete: no warning glyph, no red button, and a footer
       that says what actually happens */
    danger: false,
    note: "Creates the file and opens it.",
    onOk: () => createHome(p),
    onCancel: () => openFirstDoc(),
  });
}

async function createHome(path) {
  try {
    await api.createEntry({ path, type: "doc", markdown: "# " + path.split("/").pop().replace(/\.md$/i, "") + "\n\n" });
    await loadTree();
    await openDoc(path);
    toast("Created " + path);
  } catch (err) {
    /* it appeared under us (another tab, an external edit, a pulled commit) —
       that is the outcome we wanted, so open it rather than reporting a clash */
    if (err && err.code === "exists") {
      await loadTree().catch(() => {});
      return openDoc(path);
    }
    apiFail(err, "Could not create " + path);
  }
}

/* ============================================================
   PANELS / MOBILE
   ============================================================ */
const app = $("#app");

/* ------------------------------------------------------------------
   THE ONE RESPONSIVE AXIS

   Width, and nothing else. There is deliberately no `pointer: coarse` anywhere
   in this app: an iPad with a keyboard and an iPad without one present the
   same layout problem, and a second axis answers it twice — differently.

   These three numbers are the SAME three base.css §11 is written in, and the
   comment there derives them (widest sidebar 262px + a 520px measure floor +
   the document's gutters + widest chat 352px). If one moves, both move.

     W_SHEET   768   below: sidebar drawer + chat BOTTOM SHEET, no ⌘ chords
     W_DOCK   1024   below: the sidebar is a DRAWER, not a column
     W_TRIPANE 1280  at or above: the chat is a COLUMN, not an overlay
   ------------------------------------------------------------------ */
const W_SHEET = 768;
const W_DOCK = 1024;
const W_TRIPANE = 1280;
/** Phone: the chat is a bottom sheet and there is no hardware keyboard to assume. */
const isSheet = () => window.innerWidth < W_SHEET;
/** Phone or tablet: the sidebar is off-canvas, so `nav-open` means something. */
const isDrawer = () => window.innerWidth < W_DOCK;
/** The chat takes width from the document rather than covering it. */
const isTriPane = () => window.innerWidth >= W_TRIPANE;

function openNav() {
  app.classList.add("nav-open");
  syncScrim();
}
function closeNav() {
  app.classList.remove("nav-open");
  syncScrim();
}

/**
 * Show/hide the assistant.
 *
 * `open` is a PREFERENCE, not a layout: above W_TRIPANE the class drives a grid
 * column, below it the same class drives a fixed overlay (base.css §11), and
 * either way the panel stays in the DOM — which is what preserves the draft.
 *
 * `persist:false` is for the collapses the APP performs on the user's behalf —
 * arriving at Settings on a phone, where the sheet would cover the page it just
 * navigated to. Recording that as "the user closed the assistant" would mean a
 * detour through Settings silently changed a layout choice.
 */
function toggleChat(opts) {
  app.classList.toggle("chat-open");
  const open = app.classList.contains("chat-open");
  $("#chatBtn").classList.toggle("on", open);
  $("#chatBtn").setAttribute("aria-expanded", open ? "true" : "false");
  /* the panel collapses (to a zero-width grid column, or off-canvas) but stays
     in the DOM — so focus must not be left sitting inside something the user
     can no longer see */
  if (!open) {
    const c = $("#composer");
    if (c && document.activeElement === c) c.blur();
  }
  if (!opts || opts.persist !== false) cacheLook("chat", open ? "open" : "closed");
  syncScrim();
}

/**
 * The assistant's open/closed state at boot.
 *
 * It is REMEMBERED now. It was not before, and the cost was measured: the shell
 * ships `class="app chat-open"`, so every reload at a tablet width re-entered
 * the three-pane grid and handed the document a 172px column — you could close
 * it, and the next load undid that. A remembered `closed` is now honoured at
 * every width.
 *
 * With nothing remembered the default is open only where the chat is a COLUMN.
 * Below W_TRIPANE `chat-open` means an overlay lying across the document, and
 * a first run should not begin behind one.
 */
function initChatOpen() {
  let stored = null;
  try {
    stored = localStorage.getItem("znotes.chat");
  } catch (e) {
    /* private mode: fall through to the width default */
  }
  let open = stored === "open" || stored === "closed" ? stored === "open" : isTriPane();
  /* the phone's sheet is a layer, and a layer is never what you arrive behind */
  if (isSheet()) open = false;
  app.classList.toggle("chat-open", open);
  $("#chatBtn").classList.toggle("on", open);
  $("#chatBtn").setAttribute("aria-expanded", open ? "true" : "false");
  syncScrim();
}

/**
 * The scrim belongs to the SIDEBAR DRAWER and to nothing else.
 *
 * It used to cover the document whenever the chat sheet was up, and measured at
 * 390x844 that meant 204px of visible document answering `elementFromPoint`
 * with #scrim: unreadable, unscrollable, and dismissing the sheet was the only
 * thing a tap could do. The assistant is a panel you consult ALONGSIDE a
 * document; the drawer is a menu you are inside of, and only that is modal.
 */
function syncScrim() {
  const need = isDrawer() && app.classList.contains("nav-open");
  $("#scrim").classList.toggle("show", need);
}

/**
 * THE SOFT KEYBOARD, published as one CSS length.
 *
 * `visualViewport` is the only thing that reports how much of the layout
 * viewport an on-screen keyboard is covering; without it the composer sits
 * underneath the keyboard it just raised. One listener, one custom property,
 * and a clean no-op where the API is absent (it is not in the headless shell,
 * where the overlap is 0 in any case).
 *
 * `--kb` is applied to the SHARED `.doc` container and to the chat panel — and
 * never to #rawArea. A mobile-only inset on the raw textarea is precisely the
 * mode-parity break the SPEC §11 gate exists to catch, and the gate could not
 * catch this one: headless there is no keyboard, so `--kb` is always 0 there.
 */
function wireVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const publish = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", Math.round(overlap) + "px");
  };
  vv.addEventListener("resize", publish);
  publish();
}

/* ============================================================
   TERMINAL (SPEC §13)

   A password-locked streaming command runner, living in its own Settings
   section. Three things this file is careful about:

     1. THE TOKEN IS NOT HERE. api.js holds it; this module only ever learns
        booleans (`status.unlocked`, `status.ready`) from the server. There is
        no variable in app.js that could leak it into a note, a URL or a log.
     2. NOTHING IS INFERRED. Every lock/unlock/enabled/cwd fact painted below
        came from `GET /api/terminal/status` or from a command's own `exit`
        event. The panel never decides it is probably unlocked.
     3. IT SAYS WHAT IT CANNOT DO. There is no PTY, so the banner names the
        programs that cannot work here rather than letting one hang.
   ============================================================ */

/* Terminal-flavoured ANSI is noise without a renderer, so it is STRIPPED
   rather than painted: a real emulator is exactly the thing this cannot be
   (no PTY), and half-rendering colour codes would be a lie about that. CSI
   and OSC sequences, the two-byte escapes, and the C0 control bytes that
   are not tab/newline all go; a carriage return becomes a newline, so a
   progress bar reads as successive lines instead of one mangled one. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "").replace(/\r\n?/g, "\n");

/* …and stripping is per STREAM, not per chunk.
   `stripAnsi` is a stateless regex over whatever string it is handed, but
   stdout arrives as arbitrary pipe reads: an escape that straddles a chunk
   boundary is two halves, neither of which matches. The lone ESC at the end of
   chunk one was eaten as a C0 byte and `[31m` at the head of chunk two was
   then printed as literal text — "half-rendered", which is the one thing
   SPEC §13 says this does not do. An OSC split the same way leaks its whole
   payload (a window title) into the scrollback.

   So a per-stream stripper holds back a trailing FRAGMENT — an unfinished
   escape, or a lone CR that may yet turn out to be the CR of a CRLF — and
   prepends it to the next chunk. The hold-back is capped: a program that emits
   a bare ESC and then megabytes of text must not buffer forever, and printing
   the fragment is the honest fallback. */
const ANSI_PENDING_RE = /(?:\x1b\][^\x07\x1b]*|\x1b\[[0-9;?]*[ -\/]*|\x1b|\r)$/;
const ANSI_PENDING_MAX = 64;

function ansiStream() {
  let pending = "";
  return {
    feed(text) {
      const all = pending + String(text);
      const m = ANSI_PENDING_RE.exec(all);
      if (m && all.length - m.index <= ANSI_PENDING_MAX) {
        pending = m[0];
        return stripAnsi(all.slice(0, m.index));
      }
      pending = "";
      return stripAnsi(all);
    },
    /* the command ended: whatever is still held back is all there will ever be */
    flush() {
      const rest = pending;
      pending = "";
      return rest ? stripAnsi(rest) : "";
    },
  };
}

/** One stripper per stream, reset when a command starts and when the pane is
    cleared — a fragment from a finished command is not a prefix of the next. */
let termAnsi = { out: ansiStream(), err: ansiStream() };
function termAnsiReset() {
  termAnsi = { out: ansiStream(), err: ansiStream() };
}
function termAnsiFlush() {
  for (const cls of ["out", "err"]) {
    const rest = termAnsi[cls].flush();
    if (rest) termPut(rest, cls);
  }
}

/**
 * The cwd, shortened for the one-line bar: inside the vault it is shown
 * relative to it, elsewhere the head is elided. The full path is always the
 * title, so nothing is ever only half-true.
 */
function paintCwd(cwd) {
  const bar = $("#termCwdLine");
  if (!bar || !cwd) return;
  const root = state.term.status && state.term.status.vaultRoot;
  let shown = cwd;
  if (root && (cwd === root || cwd.indexOf(root + "/") === 0)) shown = "«vault»" + cwd.slice(root.length);
  if (shown.length > 56) shown = "…" + shown.slice(-55);
  bar.textContent = shown;
  bar.title = cwd;
}

/** Put already-stripped text into the pane. The one DOM writer. */
function termPut(text, cls) {
  const out = $("#termOut");
  if (!out) return;
  const empty = $(".empty", out);
  if (empty) empty.remove();
  const pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const node = el("span", "l" + (cls ? " " + cls : ""));
  node.textContent = text;
  out.appendChild(node);
  if (pinned) out.scrollTop = out.scrollHeight;
}

/** Scrollback lines are appended, never re-rendered — output can be long.
    For COMPLETE strings (a prompt echo, a notice, a replayed record). */
function termWrite(text, cls) {
  termPut(stripAnsi(text), cls);
}

/* stdout and stderr arrive as arbitrary chunks, not lines, so consecutive
   chunks of the same stream are merged into the trailing node rather than each
   becoming its own block — otherwise a progress line would stack vertically.
   Chunks go through the per-stream stripper, which is what makes an escape
   split across two of them still an escape. */
function termAppend(text, cls) {
  const out = $("#termOut");
  if (!out) return;
  const stream = termAnsi[cls];
  const clean = stream ? stream.feed(text) : stripAnsi(text);
  if (!clean) return;
  const last = out.lastElementChild;
  if (last && last.className === "l " + cls) {
    const pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    last.textContent += clean;
    if (pinned) out.scrollTop = out.scrollHeight;
    return;
  }
  termPut(clean, cls);
}

function termClear() {
  const out = $("#termOut");
  if (!out) return;
  termAnsiReset();
  out.innerHTML = "";
  out.appendChild(el("div", "empty", esc("Nothing yet. Type a command below.")));
}

/** Repaint everything the terminal section shows, from `state.term.status`. */
function paintTerminal() {
  const st = state.term.status;
  const s = state.settings.terminal || {};
  const line = $("#termState");
  const txt = $("#termStateTxt");
  if (!line || !txt) return;

  const enabled = st ? st.enabled : s.enabled !== false;
  const configured = st ? st.configured : !!s.passwordSet;
  const unlocked = !!(st && st.unlocked);

  line.classList.toggle("off", !enabled || !configured);
  line.classList.toggle("locked", enabled && configured && !unlocked);
  line.classList.toggle("unlocked", unlocked);
  txt.textContent = !enabled
    ? "Disabled — the Enable terminal switch is off."
    : !configured
    ? "Disabled — no terminal password is set, so nothing can run."
    : unlocked
    ? "Unlocked" + (st && st.expiresInMs != null ? " · re-locks after " + Math.round(st.expiresInMs / 60000) + " min idle" : "")
    : "Locked — enter the terminal password to run commands.";

  $("#termLockBtn").hidden = !unlocked;
  $("#termUnlockField").hidden = !(enabled && configured && !unlocked);
  $("#termConsole").hidden = !unlocked;

  /* The password field says which of the two jobs it is doing, and asks for
     the current password only when there is one to ask for. */
  $("#termPwLab").textContent = configured ? "Change terminal password" : "Terminal password";
  $("#termPwHint").textContent = configured
    ? "Leave the new password empty to remove it — that disables the terminal."
    : "Set one to enable the terminal. Independent of your vault passphrase; the server only stores a scrypt hash.";
  $("#termPwBtn").textContent = configured ? "Change" : "Set";
  $("#termCurrent").hidden = !configured || unlocked;

  /* the four SETTINGS on this panel are draft state, and this function is also
     called by every terminal STATUS refresh (unlock, lock, set password) — so
     it must repaint them from the draft or an action would quietly revert an
     edit the user is still holding */
  paintDraftFields();

  if (st) {
    paintCwd(st.cwd);
    $("#termNote").textContent = st.ptyNote;
  }
  paintTermStop();
  refreshCommandCards();
}

/**
 * What is running, according to the SERVER — with this tab's own in-flight
 * command as the fast path.
 *
 * The Stop button used to be gated on `state.term.running`, which is only ever
 * set by this tab's own `runTerminal`. Anything else — a second tab, or a
 * command the assistant auto-ran — left the console in a dead end: typing was
 * refused with "cancel it first (Ctrl+C)", and Ctrl+C was a documented no-op in
 * exactly that state, so the only ways out were the other tab or the 30-minute
 * wall clock. The server publishes the truth in `status.running`; this reads it.
 */
const termRunningId = () => state.term.running || (state.term.status && state.term.status.running) || null;

function paintTermStop() {
  const btn = $("#termStopBtn");
  if (btn) btn.hidden = !termRunningId();
}

async function refreshTerminalStatus() {
  try {
    state.term.status = await api.getTerminalStatus();
  } catch (err) {
    state.term.status = null;
  }
  paintTerminal();
  return state.term.status;
}

async function terminalUnlock() {
  const inp = $("#termPass");
  const pass = inp.value;
  if (!pass) return toast("Enter the terminal password");
  try {
    state.term.status = await api.terminalUnlock(pass);
    inp.value = "";
    termClear();
    termWrite("Terminal unlocked. " + (state.term.status ? state.term.status.ptyNote : ""), "sys");
    paintTerminal();
    await loadCommands();
    $("#termInput").focus();
  } catch (err) {
    /* The server's own words: it deliberately answers the same way whether or
       not a password is set, and carries the backoff when there is one. */
    inp.value = "";
    toast(err.message || "Wrong terminal password");
    await refreshTerminalStatus();
  }
}

async function terminalLock(why) {
  await api.terminalLock();
  state.term.status = await api.getTerminalStatus().catch(() => null);
  paintTerminal();
  toast(why ? "Terminal locked — " + why : "Terminal locked");
}

function terminalSavePassword() {
  const configured = !!(state.term.status && state.term.status.configured);
  /* Clearing is destructive in the sense that matters — it disables the
     terminal and drops every session — so it goes through the same confirm
     dialog every other irreversible action uses (VEILS puts it above Settings,
     so Esc still unwinds in the right order). */
  if (configured && !$("#termNew").value) {
    confirmDialog({
      title: "Remove the terminal password?",
      path: "Settings › Terminal",
      body: "The terminal is disabled without one, every unlocked session ends, and the assistant loses the run_command tool.",
      ok: "Remove",
      /* the hash lives in .znotes/index.db, which SPEC §7 keeps out of git —
         so the delete dialog's "recoverable from git history" is false here */
      note: "The stored hash is in .znotes/index.db, which git never sees — set a new one to re-enable it.",
      onOk: () => doSaveTerminalPassword(),
    });
    return;
  }
  doSaveTerminalPassword();
}

async function doSaveTerminalPassword() {
  const next = $("#termNew").value;
  const current = $("#termCurrent").value;
  try {
    const r = await api.terminalSetPassword(next, current);
    state.term.status = r.status;
    $("#termNew").value = "";
    $("#termCurrent").value = "";
    /* the settings object carries `passwordSet`, and it has just moved */
    const fresh = await api.getSettings();
    state.settings = fresh.settings;
    state.meta = fresh.meta;
    paintTerminal();
    toast(r.configured ? "Terminal password saved" : "Terminal password removed");
  } catch (err) {
    apiFail(err, "Could not save the terminal password");
  }
}

/**
 * Run one command and stream it into the scrollback.
 *
 * Shared by the prompt and by the Run button on an assistant's command card,
 * so an AI-run command lands in exactly the same place, in the same shape,
 * with the same output, as one the user typed. That is not decoration: it is
 * the guarantee that there is no path by which the assistant runs something
 * the user cannot see.
 */
async function runTerminal(command, opts) {
  const o = opts || {};
  if (state.term.busy) return toast("A command is already running — press Stop or Ctrl+C");
  state.term.busy = true;
  state.term.running = null;
  /* Streamed live below, so `echoCommand` must not replay it from the record
     when the notification for the same id comes back around. */
  if (o.commandId) state.term.printed.add(o.commandId);
  termWrite((o.byAi ? "[assistant] " : "") + "$ " + command, "cmd");
  termAnsiReset();
  $("#termStopBtn").hidden = false;
  const handlers = {
    onStart: (d) => {
      state.term.running = d.id;
      if (state.term.status) state.term.status.running = d.id;
    },
    onStdout: (d) => termAppend(d.chunk, "out"),
    onStderr: (d) => termAppend(d.chunk, "err"),
    onNotice: (d) => termWrite("— " + d.message, "sys"),
    onError: (d) => termWrite("— " + d.message, "err"),
  };
  let exit = null;
  try {
    exit = o.commandId ? await api.terminalRunCommand(o.commandId, handlers) : await api.terminalExec(command, handlers);
  } catch (err) {
    termWrite("— " + (err.message || "The command could not be started"), "err");
    /* 409 busy: something IS running, just not ours — take the id the refusal
       carries so the Stop the message tells the user to press is on screen. */
    if (err.status === 409 && err.body && err.body.running) {
      if (state.term.status) state.term.status.running = err.body.running;
      else await refreshTerminalStatus();
    }
    if (err.status === 401 || err.status === 403 || err.status === 409) {
      state.term.status = await api.getTerminalStatus().catch(() => state.term.status);
      /* and PAINT it: a 401 means the session died (idle lock, another tab's
         lock) — updating the state while leaving the unlocked console on
         screen kept an input field wired to a terminal that will refuse it */
      paintTerminal();
    }
  } finally {
    termAnsiFlush();
    const mine = state.term.running;
    state.term.busy = false;
    state.term.running = null;
    /* clear the server-side echo only if it still names OUR command: a 409 put
       somebody else's id there, and that one is still running */
    if (state.term.status && mine && state.term.status.running === mine) state.term.status.running = null;
    paintTermStop();
  }
  if (exit) {
    const ok = exit.code === 0;
    termWrite(
      "— exit " + (exit.signal ? exit.signal : exit.code) + " · " + exit.ms + "ms" + (exit.cwd ? " · " + exit.cwd : ""),
      ok ? "ok" : "err"
    );
    if (state.term.status) state.term.status.cwd = exit.cwd;
    paintCwd(exit.cwd);
  }
  if (o.commandId) await loadCommands();
  return exit;
}

function submitTerminal() {
  const inp = $("#termInput");
  const cmd = inp.value;
  if (!cmd.trim()) return;
  inp.value = "";
  const h = state.term.history;
  if (h[h.length - 1] !== cmd) h.push(cmd);
  if (h.length > 200) h.shift();
  state.term.hist = -1;
  state.term.draft = "";
  /* A command already running means this line is an ANSWER to it (a y/N, a
     commit message, a here-doc) — the only way to type into a child without a
     TTY. Echoed as sent, never as a new command. */
  if (state.term.busy) {
    termWrite("> " + cmd, "sys");
    /* addressed to the command THIS tab is streaming: the server refuses the
       write outright if that is no longer what is running, rather than putting
       the line — a `y/N`, a commit message, a passphrase — into something else */
    api.terminalStdin(cmd + "\n", false, state.term.running).catch((err) => termWrite("— " + err.message, "err"));
    return;
  }
  runTerminal(cmd, {});
}

/** ↑/↓ walk the history; the in-progress line is kept as `draft` at index -1. */
function terminalHistory(dir) {
  const inp = $("#termInput");
  const h = state.term.history;
  if (!h.length) return;
  if (state.term.hist === -1) {
    if (dir < 0) return; // already at the newest
    state.term.draft = inp.value;
    state.term.hist = h.length - 1;
  } else {
    const next = state.term.hist + (dir < 0 ? 1 : -1);
    if (next >= h.length) {
      state.term.hist = -1;
      inp.value = state.term.draft;
      return;
    }
    state.term.hist = Math.max(0, next);
  }
  inp.value = h[state.term.hist];
  requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
}

/**
 * Cancel whatever is running — including a command this tab did not start.
 *
 * `id` is passed when we know it, so a cancel can never reach past the command
 * it was aimed at; when only the server knows, its id is used. Nothing running
 * at all is said out loud rather than silently ignored.
 */
async function terminalStop() {
  const id = termRunningId();
  if (!id) {
    await refreshTerminalStatus();
    if (!termRunningId()) return toast("Nothing is running");
  }
  termWrite("— cancelling…", "sys");
  try {
    const r = await api.terminalCancel(termRunningId());
    if (r && r.cancelled === false) termWrite("— nothing was running", "sys");
  } catch (err) {
    termWrite("— " + err.message, "err");
  }
  /* the truth after the fact, not an assumption: a cancel that reached nothing
     must not leave a Stop button implying it did */
  if (!state.term.busy) await refreshTerminalStatus();
}

/* ---------- assistant command records ---------- */

async function loadCommands() {
  try {
    const r = await api.terminalCommands(40);
    state.commands = (r && r.commands) || [];
  } catch (err) {
    /* Locked: the records are behind the terminal password too, because they
       carry command OUTPUT. An empty list is the honest state to paint. */
    state.commands = [];
  }
  state.commands.forEach(echoCommand);
  refreshCommandCards();
  return state.commands;
}

/**
 * "Every AI-run command is visible in the terminal scrollback", enforced here
 * rather than left to whichever path happened to run it.
 *
 * A command the user approved streamed into the scrollback as it ran (the Run
 * button goes through `runTerminal`, which marks it printed). One the assistant
 * AUTO-RAN did not — that happened server-side, inside the model turn — so it
 * is replayed here from its record the moment this tab learns about it. Either
 * way the user ends up looking at the same thing.
 */
function echoCommand(c) {
  if (!c || c.source !== "ai") return;
  if (c.state !== "done" && c.state !== "failed") return;
  if (state.term.printed.has(c.id)) return;
  state.term.printed.add(c.id);
  termWrite("[assistant] $ " + c.command, "cmd");
  if (c.output) termWrite(c.output, c.exitCode === 0 ? "out" : "err");
  termWrite(
    "— " + (c.state === "failed" ? "did not run" : "exit " + (c.exitCode == null ? "?" : c.exitCode)) +
      (c.truncated ? " · output truncated" : ""),
    c.exitCode === 0 ? "ok" : "err"
  );
}

const commandById = (id) => state.commands.filter((c) => c.id === id)[0] || null;

/** The one place a command record enters or is refreshed in `state.commands`. */
function upsertCommand(c) {
  if (!c || !c.id) return;
  const i = state.commands.findIndex((x) => x.id === c.id);
  if (i >= 0) state.commands[i] = Object.assign({}, state.commands[i], c);
  else state.commands.push(c);
  echoCommand(state.commands[i >= 0 ? i : state.commands.length - 1]);
}

/**
 * The approval card — deliberately the diff card's shape, because it makes the
 * same promise: the exact thing that will happen is on screen, and nothing
 * happens until you press a button.
 */
/* The card builds this and `refreshCommandCards` repaints it; the two copies
   were byte-identical, so a new lifecycle state meant editing both or watching
   the card and its repaint disagree. */
const cmdStateLabel = (c) =>
  c.state === "pending"
    ? "waiting for you"
    : c.state === "running"
    ? "running…"
    : c.state === "rejected"
    ? "rejected"
    : c.state === "failed"
    ? "failed"
    : "exit " + (c.exitCode == null ? "?" : c.exitCode);

function commandCard(c) {
  const card = el("div", "cmdcard");
  card.dataset.cmd = c.id;
  if (c.state === "done") card.classList.add(c.exitCode === 0 ? "ran" : "failed");
  if (c.state === "failed") card.classList.add("failed");
  if (c.state === "rejected") card.classList.add("rejected");

  const head = el("div", "cmd-head");
  head.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg> Terminal command' +
    '<span class="st">' +
    esc(cmdStateLabel(c)) +
    "</span>";
  const body = el("div", "cmd-body");
  body.textContent = "$ " + c.command;
  card.appendChild(head);
  card.appendChild(body);
  if (c.why) {
    const why = el("div", "cmd-why");
    why.textContent = c.why;
    card.appendChild(why);
  }
  const foot = el("div", "cmd-foot");
  fillCommandFoot(c, foot);
  card.appendChild(foot);
  return card;
}

function fillCommandFoot(c, foot) {
  foot.innerHTML = "";
  const ready = !!(state.term.status && state.term.status.ready);
  if (c.state === "pending") {
    const run = el("button", "btn primary sm", I.tick + " Run");
    run.disabled = !ready || state.term.busy;
    run.title = ready ? "Run this command and show its output" : "Unlock the terminal first (Settings → Terminal)";
    run.addEventListener("click", async () => {
      /* NOT openSettings(): that call is a GATED navigation — with a dirty Raw
         buffer it raises the exit guard and paints nothing, and this handler
         used to run the command anyway, streaming its output into a page the
         user was never shown. Running the command is the decision the click
         made; the navigation is only so the output is visible, so it must not
         be re-blocked. showSettings is the ungated painter boot/popstate use. */
      showSettings("terminal", {});
      await runTerminal(c.command, { commandId: c.id, byAi: true });
    });
    const rej = el("button", "btn sm", "Reject");
    rej.addEventListener("click", async () => {
      try {
        const r = await api.terminalRejectCommand(c.id);
        upsertCommand(r.command);
        refreshCommandCards();
      } catch (err) {
        apiFail(err, "Could not reject the command");
      }
    });
    foot.appendChild(run);
    foot.appendChild(rej);
    const note = el("span", "note");
    note.textContent = ready ? "Nothing runs until you press Run." : "The terminal is locked.";
    foot.appendChild(note);
    return;
  }
  const note = el("span", "note");
  note.style.marginLeft = "0";
  note.textContent =
    c.state === "rejected"
      ? "You rejected this command; it never ran."
      : c.state === "running"
      ? "Running — output is in Settings → Terminal."
      : "Output is in Settings → Terminal." + (c.truncated ? " (truncated)" : "");
  foot.appendChild(note);
  if (c.state === "done" || c.state === "failed") {
    const show = el("button", "btn sm", "Show output");
    show.style.marginLeft = "auto";
    show.addEventListener("click", () => {
      openSettings("terminal");
      /* already in the scrollback (echoCommand ran when the record arrived) —
         this scrolls to it rather than printing a second copy */
      const out = $("#termOut");
      if (out) out.scrollTop = out.scrollHeight;
    });
    foot.appendChild(show);
  }
}

function refreshCommandCards() {
  $$(".cmdcard").forEach((card) => {
    const c = commandById(card.dataset.cmd);
    if (!c) return;
    card.classList.toggle("ran", c.state === "done" && c.exitCode === 0);
    card.classList.toggle("failed", c.state === "failed" || (c.state === "done" && c.exitCode !== 0));
    card.classList.toggle("rejected", c.state === "rejected");
    const st = $(".cmd-head .st", card);
    if (st) st.textContent = cmdStateLabel(c);
    const foot = $(".cmd-foot", card);
    if (foot) fillCommandFoot(c, foot);
  });
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest(".wl") : null;
    if (link) {
      e.preventDefault();
      const name = link.dataset.link;
      const hit = lookupLink(name);
      if (hit.state === "ok") openDoc(hit.path);
      /* Ambiguous is NOT missing: creating a third doc with that name would
         make it worse. Say which docs collide and let the author qualify it. */ else if (hit.state === "ambiguous")
        toast("“" + name + "” is ambiguous — " + hit.candidates.join(", ") + ". Write [[folder/name]].");
      else createFromLink(name);
      return;
    }

    const act = e.target.closest ? e.target.closest("[data-act]") : null;
    if (act) {
      const a = act.dataset.act;
      if (a === "save") saveDoc(state.active);
      if (a === "settings") openSettings();
      if (a === "ai-status") checkAiEndpoint();
      if (a === "close-settings") leaveSettings();
      if (a === "save-settings") saveSettings();
      if (a === "discard-settings") discardSettingsDraft();
      if (a === "toggle-chat") toggleChat();
      if (a === "toggle-sidebar") app.classList.toggle("sidebar-collapsed");
      /* the statusbar mode chip — the topbar segmented control's replacement.
         Silent: the chip you just clicked already shows the outcome, and a
         toast on top of it would be the app reading its own statusbar back. */
      if (a === "toggle-mode") setMode(state.mode === "raw" ? "preview" : "raw", { silent: true });
      if (a === "nav-open") openNav();
      if (a === "nav-close") closeNav();
      if (a === "pp-cancel") closePP();
      if (a === "pp-ok") doPassphraseOk();
      if (a === "pp-generate") {
        const p = generatePassphrase();
        $("#ppInput").value = p;
        $("#ppConfirm").value = p;
        /* measured with estimateBits like the Settings handler — the two
           Generate buttons must report the same strength for the same
           generator, and re-deriving the arithmetic here was how they split */
        ppHint("Generated · ~" + estimateBits(p) + " bits. Write it down now — there is no recovery.", false);
      }
      if (a === "encrypt-selection") encryptSelection();
      if (a === "lock-vault") lockVault("manual");
      if (a === "palette") openPal();
      if (a === "shortcuts") $("#scVeil").classList.add("show");
      if (a === "close-shortcuts") hide("#scVeil");
      if (a === "new-doc") startCreate("doc");
      if (a === "new-folder") startCreate("folder");
      if (a === "trash") toggleTrash();
      if (a === "home") goHome();
      if (a === "cf-cancel") closeConfirm();
      if (a === "cf-ok") confirmOk();
      if (a === "cx-take-disk") conflictTakeDisk();
      if (a === "cx-keep-mine") conflictKeepMine();
      if (a === "cx-recreate") conflictRecreate();
      if (a === "cx-discard") conflictDiscardOrphan();
      if (a === "xg-keep") closeExitGuard();
      if (a === "xg-discard") exitGuardDiscard();
      if (a === "xg-save") exitGuardSave();
      if (a === "sess") ($("#sessPop").classList.contains("show") ? closeSess() : openSess());
      if (a === "close-sess") closeSess();
      if (a === "new-session") startNewSession();
      if (a === "send") sendMessage();
      return;
    }

    if ($("#sessPop").classList.contains("show") && !e.target.closest("#sessPop")) closeSess();
  });

  /* ---------- sidebar context menu ---------- */

  $("#sidebar").addEventListener("contextmenu", (e) => {
    /* NEVER take the browser's menu off a text field. The inline create/rename
       input lives inside this tree, and cut/copy/paste/undo on a filename is
       exactly what the native menu is for. Same for a real link. */
    if (e.target.closest && e.target.closest("input, textarea, [contenteditable=true], a[href]")) return;
    e.preventDefault();
    /* An inline create/rename is UNSAVED WORK, and opening the menu destroys
       it: `openCtx` focuses the menu's first item, the field blurs, and the
       blur handler cancels the edit — silently, unlike Esc, which says so. A
       right-click is a request for a menu, not a click-away, so it waits. */
    if (state.creating || state.renaming) {
      const inp = $("#tree .newrow input");
      if (inp) inp.focus();
      toast("Finish the name first — Enter to save, Esc to cancel");
      return;
    }
    /* the Menu key fires `contextmenu` too, with coordinates the UA picks —
       anchor to the row in that case so the menu never lands at (0,0) */
    const kbd = !e.clientX && !e.clientY;
    if (kbd) openCtxFrom(e.target.closest(".row[data-path]") || $("#tree"));
    else openCtx(ctxTarget(e.target), e.clientX, e.clientY);
  });

  /* ---------- …and the same menu from a THUMB ----------
     `contextmenu` is a right-click, and a phone has no right button. The only
     other route to Rename and Delete was `.rowacts`, which is revealed by
     `:hover` / `:focus-within` — and on a phone tapping a FILE row runs
     `openDoc`, which closes the drawer (isDrawer → closeNav), taking the row
     and its actions off-canvas; reopening the drawer moves focus to the Menu
     button, so the reveal is lost again. MEASURED at 390x844 with touch
     emulation: an unbreakable loop in which a file could be created but never
     renamed, moved or deleted. (Folders escaped it — their row toggles
     disclosure and does not close the drawer.)

     So the long press opens the same menu the right-click does, from the same
     `ctxTarget` — one menu, one set of rules, not a second touch-only surface.
     The trailing tap is the whole difficulty: a touch that is not consumed by
     `contextmenu` still produces compat `mousedown` → `click` at liftoff, and
     the capture-phase click-away below would close the menu on the very
     gesture that opened it, then the row's own click would open the doc.
     `lpUntil` is that one gesture's suppression window, spent by the click it
     was opened for or expiring on its own. */
  let lpT = null;
  let lpRow = null;
  let lpAt = null;
  let lpUntil = 0;
  const lpCancel = () => {
    clearTimeout(lpT);
    lpT = null;
    lpRow = null;
  };
  $("#sidebar").addEventListener("pointerdown", (e) => {
    /* a mouse has the right button, and a secondary/eraser button is not a
       press-and-hold */
    if (e.pointerType === "mouse" || e.button > 0) return;
    if (!e.target.closest) return;
    /* the row actions and the inline name field keep their own gestures */
    if (e.target.closest("input, textarea, [contenteditable=true], a[href], .rowact")) return;
    const row = e.target.closest(".row[data-path]");
    if (!row) return;
    lpRow = row;
    lpAt = { x: e.clientX, y: e.clientY };
    clearTimeout(lpT);
    lpT = setTimeout(() => {
      lpT = null;
      const row2 = lpRow;
      lpRow = null;
      if (!row2 || !row2.isConnected) return;
      /* same rule the right-click keeps: an inline create/rename is unsaved
         work and the menu would blur it away silently */
      if (state.creating || state.renaming) return;
      lpUntil = Date.now() + 1200;
      openCtx(ctxTarget(row2), lpAt.x, lpAt.y);
    }, LONGPRESS_MS);
  });
  $("#sidebar").addEventListener("pointermove", (e) => {
    if (!lpT || !lpAt) return;
    /* a scroll that started on a row is a scroll, not a press */
    if (Math.abs(e.clientX - lpAt.x) > 10 || Math.abs(e.clientY - lpAt.y) > 10) lpCancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((n) => $("#sidebar").addEventListener(n, lpCancel));

  /* right-clicking the menu itself is not a request for the browser's menu */
  $("#ctxMenu").addEventListener("contextmenu", (e) => e.preventDefault());
  $("#ctxMenu").addEventListener("keydown", ctxKeys);

  /* the liftoff of the press that OPENED the menu, swallowed before it can
     close the menu again and open the doc underneath it */
  $("#sidebar").addEventListener(
    "click",
    (e) => {
      if (Date.now() >= lpUntil) return;
      lpUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  /* click-away, on MOUSEDOWN and in CAPTURE: the menu must be gone before the
     click it belongs to reaches anything underneath it */
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!ctxOpen()) return;
      if (Date.now() < lpUntil) return; // …except the press that just opened it
      if (e.target.closest && e.target.closest("#ctxMenu")) return;
      closeCtx(true); // the click is going somewhere; do not yank focus back
    },
    true
  );
  /* anything that moves the anchor out from under it closes it. Resize and a
     tree scroll hand focus BACK to the row (the user is still here); a window
     blur does not, because yanking focus while the window is losing it is how
     you fight the browser. */
  window.addEventListener("resize", () => closeCtx());
  $("#tree").addEventListener("scroll", () => {
    lpCancel();
    closeCtx();
  });
  window.addEventListener("blur", () => closeCtx(true));

  /* two disjoint editor click zones (amendments 2 + 12) */
  $("#scroll").addEventListener("pointerdown", (e) => {
    downPt = { x: e.clientX, y: e.clientY };
    downInRaw = !!(e.target && e.target.closest && e.target.closest(".raw"));
  });
  $("#doc").addEventListener("click", previewClickToEdit);
  $("#scroll").addEventListener("click", paneClickToPreview);

  /* backdrop click = dismiss, through the SAME closer table dismissTop uses.
     The if-chain this replaces was a second copy of that table, and it had
     already drifted: #palVeil fell through to the bare class-toggle, so a
     backdrop click closed the palette without closePal's focus release. Every
     veil with teardown beyond hiding must be in CLOSERS, and now there is one
     place that says so. A click on the exit guard's scrim is Keep editing —
     the least destructive answer, which is what closeExitGuard does. */
  $$(".veil").forEach((v) =>
    v.addEventListener("mousedown", (e) => {
      if (e.target !== v) return;
      const close = CLOSERS["#" + v.id];
      if (close) close();
      else v.classList.remove("show");
    })
  );
  /* The scrim is the DRAWER's click-away and nothing else now (see syncScrim):
     the assistant no longer raises one, so there is no longer a layer between
     the reader and the document they are asking about. */
  $("#scrim").addEventListener("click", closeNav);
  ["#ppInput", "#ppConfirm"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      doPassphraseOk();
    })
  );
  $("#ppInput").addEventListener("input", () => {
    if (ppMode !== "create") return;
    const bits = estimateBits($("#ppInput").value);
    ppHint("~" + bits + " bits" + (bits < 60 ? " — too weak, 60 minimum" : " — good"), bits < 60);
  });

  /* segmented controls */
  $$(".seg").forEach((seg) => {
    seg.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const kind = seg.dataset.seg;
      const v = btn.dataset.v;
      /* `kind === "mode"` used to be handled here. The editor mode is no longer
         a segmented control — it is the statusbar chip, wired through the
         `toggle-mode` data-act like every other statusbar affordance. */
      markSeg(seg, v);
      /* Appearance PREVIEWS live and persists on Save — you cannot judge a
         theme from its name. Everything else is draft-only. */
      if (kind === "theme" || kind === "density" || kind === "colorScheme") {
        setDraft(kind, v);
        applyLook(draftedLook(), { preview: true });
      } else if (kind === "effort") {
        setDraft("ai.effort", v);
      }
    });
  });

  /* The settings page's section rail. It goes through `openSettings` like every
     other way in, so there is still exactly one function that knows what
     showing Settings means — and the click writes `/settings/<section>` into
     the address bar, which is the link it is advertising. */
  $$("#settingsNav button").forEach((b) =>
    b.addEventListener("click", () => openSettings(b.dataset.sec))
  );

  $$("[data-sw]").forEach((sw) =>
    sw.addEventListener("click", () => {
      sw.classList.toggle("on");
      setDraft(sw.dataset.sw, sw.classList.contains("on"));
    })
  );

  /** an immediate, non-draft field — see the credential note above setDraft */
  const bindInput = (sel, apply) => {
    const n = $(sel);
    n.addEventListener("change", () => apply(n.value));
  };
  /* Every free-text DRAFT field, bound once, path from the markup — the shape
     `[data-num]` and `[data-sw]` already use. `input` so the Save button lights
     the moment you type, `change` so a paste or an autofill that skips `input`
     is caught too. `paintDraftFields` says why the path lives in the markup. */
  $$("[data-draft]").forEach((n) => {
    const rec = () => setDraft(n.dataset.draft, n.value);
    n.addEventListener("input", rec);
    n.addEventListener("change", rec);
  });
  /* every numeric setting, bound once, bounds and units from `meta.numbers`.
     The clamp/snap that used to be done by the server's answer is done HERE
     now: a draft has no round trip until Save, and a field that showed 9999
     until then would be lying about what Save is going to store. `null` means
     "not a usable number" — the draft entry is dropped and the field goes back
     to the stored value, which is what the empty-patch round trip used to do. */
  $$("[data-num]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const path = inp.dataset.num;
      const v = coerceNumberSetting(path, inp.value);
      if (v == null) {
        delete settingsDraft[path];
        inp.value = savedValue(path);
        clearSettingsError();
        paintSaveState();
        return;
      }
      inp.value = v;
      setDraft(path, v);
    })
  );
  /* ---------- vault key (SPEC §6) ---------- */
  $("#keyLockBtn").addEventListener("click", () => lockVault("manual"));
  $("#keyChangeBtn").addEventListener("click", changeVaultPassphrase);
  $("#keyGen").addEventListener("click", () => {
    const p = generatePassphrase();
    const nw = $("#keyNew");
    nw.value = p;
    $("#keyConfirm").value = p;
    /* UNMASK it. The field is `.masked` (`-webkit-text-security: disc`) and
       there is no reveal control anywhere in the panel, so "write it down NOW"
       was printed over a column of dots: a user who followed it literally, saw
       nothing and pressed Change had locked their vault with a string nothing
       can produce again (SPEC §6 — there is no recovery path by design). This
       is the one moment the passphrase is MEANT to be legible; typing anything
       into the field masks it again, and it leaves the DOM entirely on success
       or on leaving the page (`clearKeyFields`). */
    nw.classList.remove("masked");
    keyHint(
      "Generated · ~" +
        estimateBits(p) +
        " bits, shown above and selected. Write it down or copy it (⌘C) NOW — nothing here can show it to you again.",
      false
    );
    nw.focus();
    nw.select();
  });
  /* the generated value is legible only while it IS the generated value */
  $("#keyNew").addEventListener("input", () => $("#keyNew").classList.add("masked"));
  ["#keyCurrent", "#keyNew", "#keyConfirm"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      changeVaultPassphrase();
    })
  );
  /* ---------- terminal (SPEC §13) ---------- */
  $("#termUnlockBtn").addEventListener("click", terminalUnlock);
  $("#termPass").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    terminalUnlock();
  });
  $("#termLockBtn").addEventListener("click", () => terminalLock());
  $("#termPwBtn").addEventListener("click", terminalSavePassword);
  ["#termNew", "#termCurrent"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      terminalSavePassword();
    })
  );
  $("#termClearBtn").addEventListener("click", termClear);
  $("#termStopBtn").addEventListener("click", terminalStop);
  $("#termInput").addEventListener("keydown", (e) => {
    /* the terminal owns its own keys: ⌘K/⌘S/⌘E must not fire from a shell
       prompt, and Esc must close Settings exactly as it does everywhere else */
    if (e.key === "Escape") return;
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submitTerminal();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      terminalHistory(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      terminalHistory(-1);
    } else if ((e.key === "c" || e.key === "C") && e.ctrlKey) {
      /* Ctrl+C with a selection is COPY, everywhere, and taking that away from
         a pane full of text you want to copy would be its own bug. */
      if (String(window.getSelection() || "")) return;
      e.preventDefault();
      /* the same condition the Stop button uses — Ctrl+C is that button's
         keyboard twin, and an error line that says "cancel it first (Ctrl+C)"
         has to be telling the truth */
      if (termRunningId()) terminalStop();
      else $("#termInput").value = "";
    } else if ((e.key === "d" || e.key === "D") && e.ctrlKey) {
      e.preventDefault();
      if (!state.term.busy) return;
      termWrite("— EOF", "sys");
      api.terminalStdin("", true, state.term.running).catch(() => {});
    } else if ((e.key === "l" || e.key === "L") && e.ctrlKey) {
      e.preventDefault();
      termClear();
    }
  });
  /* THE TWO CREDENTIALS, and the only settings controls that still write
     immediately. They are write-only — the server serves a mask, so there is no
     "current value" to diff a draft against, and an unsaved secret parked in
     one is a secret held for no reason. See the note above `settingsDraft`. */
  bindInput("#gitToken", (v) => pushSettings({ git: { tokenMasked: v } }));
  bindInput("#aiKey", (v) => pushSettings({ ai: { apiKeyMasked: v } }));

  /* palette */
  $("#palInput").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(palT);
    palT = setTimeout(() => palQuery(q), 90);
  });
  $("#palInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      palMove(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      palMove(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      palOpen();
    } else if (e.key === "Escape") {
      if (!isOpen("#palVeil")) return;
      e.preventDefault();
      e.stopPropagation();
      closePal();
    } else if (e.key === "Tab") {
      e.preventDefault();
      palMove(e.shiftKey ? -1 : 1);
    }
  });

  /* composer */
  /* THE COMPOSER GROWS, like every other textarea in this app.
     `autoGrow` was wired to #rawArea and .secret-edit only, so the composer's
     `max-height: 110px` was unreachable text and the field was a fixed two-row
     box. Harmless while ⇧⏎ was the only way to make a newline; not harmless
     once bare ⏎ became one below W_SHEET and the hint beside Send started
     inviting a multi-line prompt. MEASURED at 390x844: a 12-line prompt left
     the textarea at 53.6px against a scrollHeight of 302px, with 208px of empty
     `.msgs` directly above it. */
  $("#composer").addEventListener("input", (e) => autoGrow(e.currentTarget));
  $("#composer").addEventListener("keydown", (e) => {
    e.stopPropagation();
    /**
     * ENTER SENDS — EXCEPT BELOW W_SHEET, WHERE IT MAKES A NEWLINE.
     *
     * A phone's on-screen keyboard has no Shift to hold, so `⇧⏎ newline` named
     * an escape hatch the device cannot produce: every Enter sent, and a
     * multi-line prompt was literally impossible to type. Below the sheet
     * breakpoint Enter is therefore an ordinary newline and the Send button
     * (44px there, and the hint beside it says so) is the only way to send.
     *
     * Gated on WIDTH and not on `pointer: coarse`, deliberately: an iPad with a
     * keyboard attached is coarse-pointered and would have had Enter-to-send
     * taken away from it for no reason. Width is the one axis this app has.
     */
    if (e.key === "Enter" && !e.shiftKey && !isSheet()) {
      e.preventDefault();
      sendMessage();
      return;
    }
    /**
     * Esc while typing costs the FOCUS, not the panel.
     *
     * The panel is dismissible with Esc like every other layer, but a message
     * being composed is the one place where taking the panel on the first press
     * would be hostile: the gesture that means "get out of this field" would
     * also close the surface the field is on. So the first Esc blurs — the
     * draft is on screen and the caret is out — and the second, now landing on
     * the document, closes the panel via dismissTop().
     *
     * Either way nothing is lost: closing the panel is a CSS collapse, so the
     * text is still in this textarea when the panel comes back.
     */
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.blur();
    }
  });

  /* sync chip: "Sync now" — commit + push immediately instead of waiting out
     the debounce. The server is single-flight, so a second click during a run
     just joins it. */
  /* the chip is a <span> in the statusbar markup and index.html is out of scope
     for this phase — one property is cheaper than a stylesheet fork */
  $("#stSync").style.cursor = "pointer";
  $("#stSync").addEventListener("click", () => {
    if (state.sync && state.sync.state === "syncing") {
      toast("Already syncing…");
      return;
    }
    syncNow();
  });

  /* connection dot: force a reconnect */
  $("#stConn").addEventListener("click", () => {
    toast("Reconnecting to /events…");
    connect();
  });

  const typing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  };

  /* Is there anything on screen that ⌘C would actually copy? A collapsed range
     is what you get from merely clicking into text, and `toString()` catches
     the case where a range spans only element boundaries and carries no text.
     Cheap enough to run on a keystroke, and it is the whole guard: get this
     wrong in the permissive direction and ⌘C stops copying. */
  const hasSelection = () => {
    const s = window.getSelection ? window.getSelection() : null;
    return !!s && !s.isCollapsed && String(s).length > 0;
  };

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (dismissTop()) e.preventDefault();
      return;
    }
    if (e.key === "Tab") return trapTab(e);
    /* ⇧F10 / the Menu key — the keyboard equivalent of the right-click, and the
       reason the menu is not a pointer-only affordance. Scoped to the sidebar:
       elsewhere both keys keep whatever the browser does with them. */
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      const here = document.activeElement;
      const row = here && here.closest ? here.closest("#sidebar .row[data-path]") : null;
      const inSidebar = here && here.closest && here.closest("#sidebar");
      if (!row && !inSidebar) return;
      e.preventDefault();
      openCtxFrom(row || $("#tree"));
      return;
    }
    if (mod && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P")) {
      if (e.key.toLowerCase() === "p" && e.shiftKey) return;
      e.preventDefault();
      openPal();
      return;
    }
    if (mod && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      /* ⌘S means "save what is in front of me". On the settings page that is
         the settings draft — there is no document there to save, and the
         topbar's Save button is hidden for exactly the same reason. */
      if (state.view === "settings") saveSettings();
      else saveDoc(state.active);
      return;
    }
    /* ⌘⇧E before ⌘E: with shift held, e.key is already "E", so the mode
       toggle would otherwise swallow the encrypt shortcut */
    if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      encryptSelection();
      return;
    }
    if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      if (vault.unlocked) lockVault("manual");
      else toast("The vault is already locked");
      return;
    }
    if (mod && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      setMode(state.mode === "raw" ? "preview" : "raw");
      return;
    }
    /* Settings answers to BOTH chords. ⌘/ is the conventional one and what the
       sidebar row now prints; ⌘, is the platform one and years of muscle memory
       — dropping it to "clean up" would be a regression with no upside. Both
       land on the same routed page (openSettings), not a modal. */
    if (mod && (e.key === "," || e.key === "/")) {
      e.preventDefault();
      openSettings();
      return;
    }
    /* ⌘C IS COPY. It reaches the chat toggle only when the copy it would
       shadow is provably a no-op: nothing selected anywhere on the page, and
       focus outside every text surface (raw editor, composer, palette, settings
       fields, the terminal line — `typing()` covers all of them by tag, and the
       terminal input additionally stops this listener from ever seeing its
       keys). In every other case we return WITHOUT preventDefault, so the
       browser's own copy runs untouched. Shift/Alt variants are left alone too:
       ⌘⇧C and ⌥⌘C belong to the browser.
       Note `mod` is `metaKey || ctrlKey`, which is deliberate — Ctrl+C is copy
       on Linux/Windows, so the same guard is exactly right there. The
       terminal's own Ctrl+C cancel lives on #termInput and stops propagation,
       and would be behind `typing()` regardless. */
    if (mod && (e.key === "c" || e.key === "C") && !e.shiftKey && !e.altKey) {
      if (typing() || hasSelection()) return;
      e.preventDefault();
      toggleChat();
      return;
    }
    if (mod && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      toggleChat();
      return;
    }
    if (mod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      /* One chord, one meaning — "show me the tree / put it away" — and two
         mechanisms, because below W_DOCK there is no sidebar COLUMN to collapse
         (base.css §11 makes it a drawer). Toggling `sidebar-collapsed` there
         changed a class nothing reads and the chord silently did nothing. */
      if (isDrawer()) app.classList.contains("nav-open") ? closeNav() : openNav();
      else app.classList.toggle("sidebar-collapsed");
      return;
    }
    if (mod && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      startCreate(e.shiftKey ? "folder" : "doc");
      return;
    }
    if (e.key === "?" && !typing() && !mod) {
      e.preventDefault();
      $("#scVeil").classList.add("show");
      return;
    }
  });

  window.addEventListener("resize", () => {
    /* W_DOCK, not W_SHEET: `nav-open` is meaningful for the whole drawer band.
       Dropping it at 768 stranded a tablet's open drawer as dead state — the
       CSS still had the sidebar off-canvas, and the class that brings it back
       had just been removed underneath it. */
    if (!isDrawer()) app.classList.remove("nav-open");
    syncScrim();
    const ta = $("#rawArea");
    if (ta) autoGrow(ta);
  });

  /* ---------- routing (see the ROUTING section) ----------
     A veil is opened from a dozen places — a data-act, a chord, a click-away,
     a passphrase prompt raised from inside the crypto worker. Watching the
     class the veils already carry catches every one of them without a single
     history call at any of those sites, and keeps Esc exactly as it was. */
  window.addEventListener("popstate", onPop);
  const veilObs = new MutationObserver(routeVeil);
  VEILS.forEach((sel) => veilObs.observe($(sel), { attributes: true, attributeFilter: ["class"] }));

  /* ---------- auto-lock inputs (research §5.2) ----------
     The worker owns the clocks; the main thread only reports what the worker
     cannot see. Activity is throttled to once a minute — this is a keepalive,
     not a telemetry stream. */
  let lastPing = 0;
  const ping = () => {
    if (!vault.unlocked) return;
    const now = Date.now();
    if (now - lastPing < 60000) return;
    lastPing = now;
    secretsCall("activity").catch(() => {});
  };
  document.addEventListener("keydown", ping, true);
  document.addEventListener("pointerdown", ping, true);
  document.addEventListener("visibilitychange", () => {
    /* BEFORE the worker gate below, deliberately. Flushing the buffer and
       healing the stream have nothing to do with the crypto worker, and putting
       them after `if (!vault.worker) return` made both dead code in every
       session where the vault was never touched — which is most of them. */
    if (document.visibilityState === "hidden") flushBuffer({ leaving: true });
    else healAfterGap();
    if (!vault.worker) return;
    secretsCall("visibility", { hidden: document.visibilityState === "hidden" }).catch(() => {});
  });

  /* Coming back from a dead network is the same event as coming back from a
     background tab: whatever the stream carried while we were away is gone. */
  window.addEventListener("online", healAfterGap);

  /* A sticky notice is the only toast that can be clicked (base.css keeps the
     rest click-through), and clicking it is how it goes away. */
  $("#toast").addEventListener("click", clearStickyToast);

  /* The settings draft lives in memory, so a reload or a closed tab is the one
     way it can be lost. `exitSettings` keeps it across every in-app exit and
     says so; this is the same promise kept at the one boundary the app does not
     own. Deliberately NOT extended to the document buffer: that one is flushed
     with `keepalive` below, so it survives rather than needing a warning. */
  window.addEventListener("beforeunload", (e) => {
    /* same reason as in `saveSettings`: a reload with the caret still in a
       numeric field must not be the one exit that calls the page clean */
    commitFocusedNumber();
    if (!settingsDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  window.addEventListener("pagehide", () => {
    flushBuffer({ leaving: true });
    /* the key dies with the page either way; asking explicitly also tells
       every other tab to lock (research §5.2) */
    lockVault("pagehide");
    /* Same courtesy for the terminal: the bearer dies with the page regardless
       (it was never persisted), but telling the server means the session is
       gone there too rather than sitting out its idle timeout. */
    api.terminalLock().catch(() => {});
  });
}

/* ============================================================
   BOOT
   ============================================================ */
export async function start() {
  /* settings first: they decide the theme, and a wrong theme flashing is worse
     than 40ms of a blank shell */
  const s = await api.getSettings();
  state.settings = s.settings;
  state.meta = s.meta;
  paintSettings();

  const q = new URLSearchParams(location.search);
  const urlTheme = q.get("theme");
  const themeOk = urlTheme && s.meta.themes.some((t) => t.id === urlTheme);
  applyTheme(themeOk ? urlTheme : state.settings.theme, { cache: !themeOk });
  applyDensity(state.settings.density);
  /* ?scheme= is the twin of ?theme=: a look-at-it override for this page load
     only, validated against meta (never a hard-coded list here) and never
     persisted. Neither one writes settings, so a screenshot pass over
     3 themes × 2 schemes leaves the vault exactly as it found it. */
  const urlScheme = q.get("scheme");
  const schemeOk = urlScheme && s.meta.colorSchemes.includes(urlScheme);
  applyColorScheme(schemeOk ? urlScheme : state.settings.colorScheme, { cache: !schemeOk });
  if (urlTheme && !themeOk) console.warn("[z-notes] unknown ?theme=" + urlTheme);
  if (urlScheme && !schemeOk) console.warn("[z-notes] unknown ?scheme=" + urlScheme);
  /* remember the pin, so a settings-changed from another device cannot stamp
     the stored value over an axis THIS URL asked for (see `urlPinnedLook`) */
  pinLookFromUrl([themeOk ? "theme" : null, schemeOk ? "colorScheme" : null].filter(Boolean));

  const [, , sync] = await Promise.all([loadTree(), loadSession(), api.getSyncStatus(), loadProposals()]);
  paintSync(sync);

  /* A deep link or a reload names the doc to open; the tree we just loaded is
     what says whether it still exists, so an unknown or deleted path costs one
     toast and falls back instead of booting into an empty shell.

     never state.tree[0]: the tree lists folders before root-level files, so in
     a vault where every doc is empty that would hand openDoc a FOLDER path */
  const wanted = urlDoc();
  /* read BEFORE openDoc: it replaces the address bar with the doc's URL, so
     asking `location` afterwards asks about a URL this boot just wrote */
  const wantSettings = urlSettings();
  const first =
    (wanted && state.docPaths.has(wanted) && wanted) ||
    findDoc(state.tree, (n) => !n.empty) ||
    findDoc(state.tree, () => true);
  wire();
  syncModeUI();
  /* A reload lands on an entry a PREVIOUS page load numbered, and `i` is what
     tells Back from Forward and the bottom of our stack from the middle of it.
     Carry the sequence on from that number, or the next push would mint one
     this stack has already used. */
  histSeq = histAt = (history.state || {}).i || 0;
  /* replace: the entry the browser gave us IS this doc's entry — pushing would
     leave a bare-shell entry underneath that Back could fall into */
  await openDoc(first, { replace: true });
  if (wanted && wanted !== first) toast("No such doc: " + wanted);
  /* A deep link (or a reload) straight to `/settings`. The doc opens FIRST and
     stays open behind the page, so Back and every tree click have somewhere
     real to go — the pane is never a settings page with nothing under it.
     `replace` for the same reason openDoc replaces: the entry the browser
     handed us is this page's entry, and one address must not become two. */
  if (wantSettings) showSettings(wantSettings.section, { replace: true });
  renderChat();

  /* the remembered assistant state, and the width rules that override it */
  initChatOpen();
  wireVisualViewport();
  connect();

  /* The terminal's real state, off the critical path for the same reason the
     secrets probe is: a terminal that is disabled, locked or unreachable
     changes nothing about editing notes. A fresh page load is always LOCKED —
     the token was never persisted — so this is a read of capability, not of a
     session we might still have. */
  termClear();
  refreshTerminalStatus();

  /* The trash, on the same terms: the sidebar block stays unmounted until this
     answers, and what it answers with is also what the DELETE DIALOG is allowed
     to promise (askDelete reads `state.trash.available`). Off the critical path
     because a vault with no trash route edits exactly the same. */
  refreshTrash();

  /* Secrets probe last and off the critical path: whether it succeeds or is
     disabled, everything above already works (SPEC §6 degradation). */
  initSecrets().then(() => {
    paintVaultChip();
    repaintSecretsUI();
  });
}

/** First leaf `ok` accepts, folders descended into — never a folder path. One
    traversal rule, so the two preferences below cannot drift out of step. */
function findDoc(nodes, ok) {
  for (const n of nodes) {
    const hit = n.type === "folder" ? findDoc(n.children, ok) : ok(n) ? n.path : null;
    if (hit) return hit;
  }
  return null;
}
