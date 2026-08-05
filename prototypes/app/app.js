/* ============================================================
   app.js — the whole z-notes interaction model.

   Hard rule: this file contains NO document content, NO vault data, NO
   settings defaults and NO network calls. Everything comes from api.js, which
   speaks the contract in API.md. Swap the mock service worker for the real bun
   backend and nothing here changes.
   ============================================================ */
"use strict";

import * as api from "./api.js";

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
};

/* ============================================================
   STATE — caches of what the server said, never a source of truth
   ============================================================ */
const state = {
  vault: null,
  tree: [],
  docs: new Map(), // path → { …meta, markdown, rev, loaded }
  slugs: new Map(), // slug → path
  folderOpen: new Map(), // path → bool (survives tree refetches)
  active: null,
  mode: "preview",
  dirty: false,
  saving: new Set(), // paths with a PUT in flight
  settings: null,
  meta: null,
  session: null,
  proposals: [],
  stack: [],
  secretOpen: new Map(), // path → plaintext (memory only, from /api/secrets/unlock)
  sync: null,
  conn: "connecting",
  creating: null,
  events: null,
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
function toast(msg) {
  $("#toastTxt").textContent = msg;
  const t = $("#toast");
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 1900);
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

/* inline markdown: `code`, **bold**, *em*, [[wikilink]] — used for docs AND
   for assistant messages, which arrive as markdown, never as HTML */
function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (m, c) => '<code class="ic">' + c + "</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  /* `h` is already escaped, so `name` must not be escaped a second time */
  h = h.replace(/\[\[([^\]]+)\]\]/g, (m, name) => '<a class="wl" data-link="' + name + '" title="Open ' + name + '">' + I.link + name + "</a>");
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
function indexTree(nodes) {
  nodes.forEach((n) => {
    if (n.type === "folder") {
      if (!state.folderOpen.has(n.path)) state.folderOpen.set(n.path, !!n.open);
      indexTree(n.children);
    } else {
      const prev = state.docs.get(n.path);
      state.docs.set(n.path, Object.assign({ markdown: "", rev: null, loaded: false }, prev || {}, n));
      if (n.slug) state.slugs.set(n.slug, n.path);
    }
  });
}

async function loadTree() {
  const r = await api.getTree();
  state.vault = r.vault;
  state.tree = r.tree;
  indexTree(r.tree);
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

  const node = (n, depth, parent) => {
    if (n.type === "folder") {
      const open = state.folderOpen.get(n.path) !== false;
      const row = el("button", "row folder" + (open ? " open" : ""));
      row.style.paddingLeft = 8 + depth * 12 + "px";
      row.innerHTML = '<span class="ico chev">' + I.chev + '</span><span class="ico">' + I.folder + '</span><span class="lbl">' + esc(n.name) + "</span>";
      const kids = el("div", "children" + (open ? "" : " closed"));
      slots.set(n.path, { box: kids, depth: depth + 1 });
      row.addEventListener("click", () => {
        const now = !(state.folderOpen.get(n.path) !== false);
        state.folderOpen.set(n.path, now);
        row.classList.toggle("open", now);
        kids.classList.toggle("closed", !now);
      });
      parent.appendChild(row);
      parent.appendChild(kids);
      n.children.forEach((c) => node(c, depth + 1, kids));
    } else {
      const row = el("button", "row file" + (n.empty ? " inert" : "") + (state.active === n.path ? " active" : ""));
      row.style.paddingLeft = 14 + depth * 12 + "px";
      row.dataset.doc = n.path;
      row.innerHTML = '<span class="ico">' + (n.hasSecrets ? I.key : I.file) + '</span><span class="lbl">' + esc(n.name) + '</span><span class="dot"></span>';
      row.addEventListener("click", () => openDoc(n.path));
      parent.appendChild(row);
    }
  };
  state.tree.forEach((n) => node(n, 0, host));

  if (state.creating) {
    const slot = slots.get(state.creating.parent) || slots.get("");
    const row = el("div", "newrow");
    row.style.paddingLeft = 10 + slot.depth * 12 + "px";
    row.innerHTML = '<span class="ico">' + (state.creating.kind === "folder" ? I.folder : I.file) + "</span>";
    const inp = el("input");
    inp.placeholder = state.creating.kind === "folder" ? "folder name" : "name.md";
    inp.setAttribute("aria-label", state.creating.kind === "folder" ? "New folder name" : "New doc name");
    inp.spellcheck = false;
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("data-1p-ignore", "");
    inp.name = "";
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      state.creating = null;
      renderTree();
    };
    const commit = () => {
      if (settled) return;
      const v = inp.value.trim();
      if (!v) return cancel();
      settled = true;
      commitCreate(v);
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
    inp.addEventListener("blur", () => setTimeout(cancel, 90));
    row.appendChild(inp);
    slot.box.appendChild(row);
    setTimeout(() => inp.focus(), 20);
  }
}

function startCreate(kind) {
  const parent = kind === "doc" ? dirname(state.active || "") : "";
  if (parent) state.folderOpen.set(parent, true);
  state.creating = { kind, parent };
  if (window.innerWidth < 768) openNav();
  renderTree();
}

async function commitCreate(name) {
  const { kind, parent } = state.creating;
  state.creating = null;
  const path = (parent ? parent + "/" : "") + (kind === "folder" ? name : name.replace(/\.md$/i, "") + ".md");
  try {
    await api.createEntry({ path, type: kind === "folder" ? "folder" : "doc", markdown: "" });
    await loadTree();
    if (kind === "folder") {
      toast("Folder “" + name + "” created");
      return;
    }
    await openDoc(path);
    setMode("raw", { silent: true, caret: 0 });
    toast("Created " + path);
  } catch (err) {
    renderTree();
    if (err && err.code === "exists") {
      toast("That already exists");
      if (kind === "doc") openDoc(path);
      return;
    }
    apiFail(err, "Could not create " + path);
  }
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

function codeEl(lang, src) {
  const w = el("div", "code");
  const bar = el("div", "code-bar", '<span class="dots"><i></i><i></i><i></i></span><span class="lang">' + esc(lang || "text") + "</span>");
  const copy = el("button", "btn sm", I.copy + " Copy");
  copy.style.marginLeft = "auto";
  copy.addEventListener("click", () => copyText(src));
  bar.appendChild(copy);
  const pre = el("pre");
  pre.innerHTML = "<code>" + (/^(ts|tsx|js|jsx|javascript|typescript)$/i.test(lang || "") ? hl(src) : esc(src)) + "</code>";
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
      put(lang === "age" ? secretEl(doc, buf.join("\n")) : codeEl(lang, buf.join("\n")), start);
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

/* ---------- secret block ---------- */
function secretEl(doc, cipher) {
  const plain = state.secretOpen.get(doc.path);
  const locked = plain == null;
  const w = el("div", "secret" + (locked ? "" : " open"));
  const bar = el("div", "secret-bar");
  bar.innerHTML =
    '<span class="secret-ico">' + (locked ? I.lock : I.unlock) + "</span>" +
    '<span style="min-width:0"><span class="secret-t">Secret block</span>' +
    '<span class="secret-s" style="display:block">age · x25519 · ' + (locked ? "encrypted" : "decrypted in memory") + "</span></span>";
  const badge = el("span", "badge " + (locked ? "lock" : "unlock"), locked ? "Locked" : "Unlocked");
  badge.style.marginLeft = "auto";
  bar.appendChild(badge);

  if (locked) {
    const btn = el("button", "btn sm primary", I.unlock + " Unlock");
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", () => askPass(doc.path));
    bar.appendChild(btn);
  } else {
    const copy = el("button", "btn sm", I.copy + " Copy");
    copy.style.marginLeft = "8px";
    copy.addEventListener("click", () => copyText(plain));
    const lock = el("button", "btn sm", I.lock + " Lock");
    lock.addEventListener("click", () => {
      state.secretOpen.delete(doc.path);
      renderDoc();
      toast("Secret block re-locked");
    });
    bar.appendChild(copy);
    bar.appendChild(lock);
  }

  const body = el("div", "secret-body");
  const pre = el("pre");
  if (locked) pre.textContent = cipher;
  else
    pre.innerHTML = plain
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return i > 0 ? "<b>" + esc(line.slice(0, i)) + "</b>=" + esc(line.slice(i + 1)) : esc(line);
      })
      .join("\n");
  body.appendChild(pre);
  w.appendChild(bar);
  w.appendChild(body);
  return w;
}

let pendingSecret = null;
function askPass(path) {
  pendingSecret = path;
  $("#ppPath").textContent = path;
  $("#ppInput").value = "";
  $("#ppVeil").classList.add("show");
  setTimeout(() => $("#ppInput").focus(), 120);
}
async function doUnlock() {
  const path = pendingSecret;
  const pass = $("#ppInput").value;
  $("#ppVeil").classList.remove("show");
  pendingSecret = null;
  if (!path) return;
  try {
    const r = await api.unlockSecret(path, pass || " ");
    state.secretOpen.set(path, r.plaintext);
    if (state.active === path) renderDoc();
    toast("Secret block decrypted");
  } catch (err) {
    apiFail(err, "Unlock failed");
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
  ta.spellcheck = false;
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "off");
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
  $("#stPath").textContent = doc.path;
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

async function ensureLoaded(path) {
  const cached = state.docs.get(path);
  if (cached && cached.loaded) return cached;
  const d = await api.getDoc(path);
  const merged = Object.assign({}, cached || {}, d, { loaded: true });
  state.docs.set(path, merged);
  if (d.slug) state.slugs.set(d.slug, path);
  return merged;
}

async function openDoc(path, opts) {
  if (!path) return;
  syncRaw();
  if (state.dirty && state.active && state.active !== path) await saveDoc(state.active, { silent: true });
  try {
    await ensureLoaded(path);
  } catch (err) {
    apiFail(err, "Could not open " + path);
    return;
  }
  state.active = path;
  state.dirty = false;
  setSaveIndicator("Saved");
  renderDoc();
  $("#scroll").scrollTop = 0;
  if (window.innerWidth < 768) closeNav();
  refreshSessionStats();
  if (opts && opts.line != null) revealLine(opts.line);
}

/* ============================================================
   PREVIEW ⇄ RAW
   ============================================================ */
function syncModeSeg() {
  $$("#modeSeg button").forEach((btn) => {
    const on = btn.dataset.v === state.mode;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
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
  syncRaw();
  const sc = $("#scroll");
  const keep = sc ? sc.scrollTop : 0;
  state.mode = m;
  syncModeSeg();
  renderDoc({ noFade: true });
  if (sc) sc.scrollTop = Math.max(0, Math.min(keep, sc.scrollHeight - sc.clientHeight));
  if (m === "raw") {
    if (window.innerWidth >= 768 || opts.caret != null) focusRaw(opts);
  }
  if (!opts.silent) toast(m === "raw" ? "Raw markdown" : "Rendered preview");
}

/* ---------- click a rendered line → edit that line in Raw ---------- */
let downPt = null;
let downInRaw = false;

function previewClickToEdit(e) {
  if (state.mode !== "preview") return;
  if (state.settings && state.settings.editor && state.settings.editor.clickToEdit === false) return;
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
  const secs = (state.settings && state.settings.editor && state.settings.editor.autosaveSeconds) || 10;
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

async function saveDoc(path, opts) {
  opts = opts || {};
  path = path || state.active;
  const doc = state.docs.get(path);
  if (!doc) return;
  if (path === state.active) syncRaw();
  clearTimeout(dirtyT);
  state.saving.add(path);
  try {
    const r = await api.putDoc(path, doc.markdown, doc.rev, opts.keepalive ? { keepalive: true } : null);
    doc.rev = r.rev;
    doc.mtime = r.mtime;
    doc.bytes = r.bytes;
    if (path === state.active) state.dirty = false;
    if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
    if (!opts.auto && !opts.silent) toast(state.sync && state.sync.remote ? "Saved to disk · " + state.sync.remote : "Saved to disk");
    refreshSessionStats();
  } catch (err) {
    /* the unload flush cannot show anything to anybody — never log from it */
    if (opts.quiet) return;
    if (err && err.code === "rev-conflict") {
      toast("This doc changed on disk — reloading");
      const fresh = await api.getDoc(path).catch(() => null);
      if (fresh) {
        state.docs.set(path, Object.assign({}, doc, fresh, { loaded: true }));
        if (path === state.active) renderDoc();
      }
    } else apiFail(err, "Save failed");
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
    wrap.style.animationDelay = Math.min(idx * 22, 220) + "ms";
    wrap.appendChild(el("div", "who", m.role === "user" ? "You" : s.model));
    const bubble = el("div", "bubble");
    bubble.innerHTML = inline(m.content);
    wrap.appendChild(bubble);
    if (m.proposalId) {
      const p = proposalById(m.proposalId);
      if (p) wrap.appendChild(p.state === "rejected" ? dismissedCard(p) : diffCard(p));
    }
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
  p.diff.forEach((d) => {
    const line = el("div", "dl " + (d.marker === "+" ? "add" : d.marker === "-" ? "del" : "ctx"));
    line.innerHTML = '<span class="g">' + (d.marker === " " ? "" : d.marker) + '</span><span class="t">' + esc(d.text) + "</span>";
    body.appendChild(line);
  });
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

function absorbProposalResult(r) {
  if (r.proposal) {
    const i = state.proposals.findIndex((p) => p.id === r.proposal.id);
    if (i >= 0) state.proposals[i] = r.proposal;
    else state.proposals.push(r.proposal);
  }
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
    state.docs.set(r.doc.path, Object.assign({}, prev, r.doc, { loaded: true }));
  }
}

async function acceptProposal(id) {
  syncRaw();
  if (state.dirty) await saveDoc(state.active, { silent: true });
  try {
    const r = await api.acceptProposal(id);
    absorbProposalResult(r);
    if (r.doc && state.active !== r.doc.path) await openDoc(r.doc.path);
    else renderDoc();
    refreshCards();
    renderStack();
    refreshSessionStats();
    toast("Applied #" + r.proposal.stackIndex + " · " + r.proposal.label);
    const sc = $("#scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  } catch (err) {
    apiFail(err, "Accept failed");
  }
}

async function revertProposal(id) {
  syncRaw();
  if (state.dirty) await saveDoc(state.active, { silent: true });
  try {
    const n = state.stack.length;
    const r = await api.revertProposal(id);
    absorbProposalResult(r);
    if (r.doc && state.active !== r.doc.path) await openDoc(r.doc.path);
    else renderDoc();
    refreshCards();
    renderStack();
    refreshSessionStats();
    toast("Reverted #" + n + " · " + r.proposal.label);
  } catch (err) {
    if (err && err.code === "not-stack-top") {
      toast(err.message);
      return;
    }
    apiFail(err, "Revert failed");
  }
}

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
    state.session = await api.newSession();
    closeSess();
    renderChat();
    toast("Context cleared · new session");
  } catch (err) {
    apiFail(err, "Could not start a session");
  }
}

async function sendMessage() {
  const ta = $("#composer");
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  try {
    const r = await api.sendMessage(text, state.active);
    r.messages.forEach((m) => state.session.messages.push(m));
    if (r.session) {
      state.session.messageCount = r.session.messageCount;
      state.session.tokensEstimated = r.session.tokensEstimated;
    }
    if (r.proposal) {
      const i = state.proposals.findIndex((p) => p.id === r.proposal.id);
      if (i >= 0) state.proposals[i] = r.proposal;
      else state.proposals.push(r.proposal);
    }
    renderChat();
  } catch (err) {
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

function applyTheme(id) {
  const link = $("#theme-css");
  const href = "./themes/" + id + ".css";
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  document.documentElement.setAttribute("data-theme", id);
  markSeg($("#themeSeg"), id);
}

function applyDensity(id) {
  document.documentElement.setAttribute("data-density", id);
  markSeg($("#densitySeg"), id);
  const ta = $("#rawArea");
  if (ta) autoGrow(ta);
}

function paintSettings() {
  const s = state.settings,
    m = state.meta;
  buildSeg($("#themeSeg"), m.themes, s.theme);
  buildSeg($("#densitySeg"), m.densities, s.density);
  buildSeg($("#schemeSeg"), m.colorSchemes.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), s.colorScheme);
  buildSeg($("#effortSeg"), m.efforts.map((x) => ({ id: x, label: x[0].toUpperCase() + x.slice(1) })), s.ai.effort);
  $("#autosaveInp").value = s.editor.autosaveSeconds;
  $("#gitToken").value = s.git.tokenMasked;
  $("#gitBranch").value = s.git.branch;
  $("#aiBase").value = s.ai.baseUrl;
  $("#aiKey").value = s.ai.apiKeyMasked;
  $("#aiModel").value = s.ai.model;
  $("[data-sw='editor.losslessRoundTrip']").classList.toggle("on", !!s.editor.losslessRoundTrip);
  $("[data-sw='editor.clickToEdit']").classList.toggle("on", !!s.editor.clickToEdit);
  $("[data-sw='git.autoSync']").classList.toggle("on", !!s.git.autoSync);
}

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
   SYNC + CONNECTION
   ============================================================ */
function paintSync(s) {
  state.sync = s;
  $("#stSyncTxt").textContent = s.message.replace(" · " + s.remote, "");
  const el_ = $("#stSync");
  el_.classList.toggle("ok", s.state === "synced");
  el_.classList.toggle("warn", s.state !== "synced");
  el_.title = s.message;
  $("#stBranch").lastElementChild.textContent = s.branch;
  const line = $("#syncLineTxt");
  if (line) line.textContent = s.message;
}

function paintConn(st) {
  state.conn = st;
  const c = $("#stConn");
  const txt = $("#stConnTxt");
  c.classList.toggle("down", st !== "open");
  txt.textContent = st === "open" ? "connected" : st === "connecting" ? "reconnecting…" : "offline";
  c.title = "SSE /events · " + txt.textContent;
}

function blipConn() {
  const c = $("#stConn");
  if (c.classList.contains("down")) return;
  c.classList.add("blip");
  setTimeout(() => c.classList.remove("blip"), 900);
}

/* EventSource retries on its own for ordinary drops, but a stream that dies
   mid-flight (backend restart, worker killed) can leave it CLOSED for good.
   Own the recovery so the dot never lies about being permanently offline. */
let reconnectT = null;
let reconnectWait = 0;

function connect() {
  clearTimeout(reconnectT);
  reconnectT = null;
  if (state.events) {
    const prev = state.events;
    state.events = null; /* a close we asked for must not schedule a retry */
    prev.close();
  }
  paintConn("connecting");
  state.events = api.connectEvents({
    onState: (st) => {
      paintConn(st);
      if (st === "open") reconnectWait = 0;
      else if (st === "closed" && state.events) {
        reconnectWait = Math.min(15000, (reconnectWait || 1000) * 2);
        clearTimeout(reconnectT);
        reconnectT = setTimeout(connect, reconnectWait);
      }
    },
    onHeartbeat: blipConn,
    onSyncStatus: paintSync,
    onDocChanged: async (d) => {
      if (!d) return;
      blipConn();
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
        state.docs.set(d.path, Object.assign({}, cached || {}, fresh, { loaded: true }));
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
  return isOpen("#palVeil") || isOpen("#scVeil") || isOpen("#ppVeil") || isOpen("#settingsVeil") || $("#sessPop").classList.contains("show") || !!state.creating;
}

function dismissTop() {
  if (isOpen("#palVeil")) {
    closePal();
    return true;
  }
  if (isOpen("#scVeil")) {
    $("#scVeil").classList.remove("show");
    return true;
  }
  if (isOpen("#ppVeil")) {
    $("#ppVeil").classList.remove("show");
    pendingSecret = null;
    return true;
  }
  if (isOpen("#settingsVeil")) {
    $("#settingsVeil").classList.remove("show");
    return true;
  }
  if ($("#sessPop").classList.contains("show")) {
    closeSess();
    return true;
  }
  if (state.creating) {
    state.creating = null;
    renderTree();
    return true;
  }
  const ta = $("#rawArea");
  if (ta && document.activeElement === ta) {
    ta.blur();
    return true;
  }
  if (window.innerWidth < 768) {
    if (app.classList.contains("nav-open")) {
      closeNav();
      return true;
    }
    if (app.classList.contains("chat-open")) {
      toggleChat();
      return true;
    }
  }
  return false;
}

/* ============================================================
   PANELS / MOBILE
   ============================================================ */
const app = $("#app");
function openNav() {
  app.classList.add("nav-open");
  $("#scrim").classList.add("show");
}
function closeNav() {
  app.classList.remove("nav-open");
  syncScrim();
}
function toggleChat() {
  app.classList.toggle("chat-open");
  $("#chatBtn").classList.toggle("on", app.classList.contains("chat-open"));
  syncScrim();
}
function syncScrim() {
  const mobile = window.innerWidth < 768;
  const need = mobile && (app.classList.contains("nav-open") || app.classList.contains("chat-open"));
  $("#scrim").classList.toggle("show", need);
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest(".wl") : null;
    if (link) {
      e.preventDefault();
      const target = state.slugs.get(link.dataset.link);
      if (target) openDoc(target);
      else toast("No doc named “" + link.dataset.link + "”");
      return;
    }

    const act = e.target.closest ? e.target.closest("[data-act]") : null;
    if (act) {
      const a = act.dataset.act;
      if (a === "save") saveDoc(state.active);
      if (a === "settings") $("#settingsVeil").classList.add("show");
      if (a === "close-settings") $("#settingsVeil").classList.remove("show");
      if (a === "toggle-chat") toggleChat();
      if (a === "toggle-sidebar") app.classList.toggle("sidebar-collapsed");
      if (a === "nav-open") openNav();
      if (a === "nav-close") closeNav();
      if (a === "pp-cancel") {
        $("#ppVeil").classList.remove("show");
        pendingSecret = null;
      }
      if (a === "pp-ok") doUnlock();
      if (a === "palette") openPal();
      if (a === "shortcuts") $("#scVeil").classList.add("show");
      if (a === "close-shortcuts") $("#scVeil").classList.remove("show");
      if (a === "new-doc") startCreate("doc");
      if (a === "new-folder") startCreate("folder");
      if (a === "sess") ($("#sessPop").classList.contains("show") ? closeSess() : openSess());
      if (a === "close-sess") closeSess();
      if (a === "new-session") startNewSession();
      if (a === "send") sendMessage();
      return;
    }

    if ($("#sessPop").classList.contains("show") && !e.target.closest("#sessPop")) closeSess();
  });

  /* two disjoint editor click zones (amendments 2 + 12) */
  $("#scroll").addEventListener("pointerdown", (e) => {
    downPt = { x: e.clientX, y: e.clientY };
    downInRaw = !!(e.target && e.target.closest && e.target.closest(".raw"));
  });
  $("#doc").addEventListener("click", previewClickToEdit);
  $("#scroll").addEventListener("click", paneClickToPreview);

  $$(".veil").forEach((v) =>
    v.addEventListener("mousedown", (e) => {
      if (e.target === v) {
        v.classList.remove("show");
        pendingSecret = null;
      }
    })
  );
  $("#scrim").addEventListener("click", () => {
    closeNav();
    if (window.innerWidth < 768 && app.classList.contains("chat-open")) toggleChat();
  });
  $("#ppInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doUnlock();
    }
  });

  /* segmented controls */
  $$(".seg").forEach((seg) => {
    seg.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const kind = seg.dataset.seg;
      const v = btn.dataset.v;
      if (kind === "mode") {
        setMode(v);
        return;
      }
      markSeg(seg, v);
      if (kind === "theme") {
        applyTheme(v);
        toast("Theme: " + v);
        await pushSettings({ theme: v });
      } else if (kind === "density") {
        applyDensity(v);
        toast("Density: " + v);
        await pushSettings({ density: v });
      } else if (kind === "colorScheme") {
        await pushSettings({ colorScheme: v });
      } else if (kind === "effort") {
        const s = await pushSettings({ ai: { effort: v } });
        if (s && state.session) {
          state.session.effort = s.ai.effort;
          updateSessionUI();
        }
      }
    });
  });

  $$("[data-sw]").forEach((sw) =>
    sw.addEventListener("click", async () => {
      sw.classList.toggle("on");
      const on = sw.classList.contains("on");
      const [grp, key] = sw.dataset.sw.split(".");
      const patch = {};
      patch[grp] = {};
      patch[grp][key] = on;
      await pushSettings(patch);
    })
  );

  const bindInput = (sel, apply) => {
    const n = $(sel);
    n.addEventListener("change", () => apply(n.value));
  };
  bindInput("#autosaveInp", (v) => pushSettings({ editor: { autosaveSeconds: Math.max(1, parseInt(v, 10) || 10) } }));
  bindInput("#gitBranch", (v) => pushSettings({ git: { branch: v } }));
  bindInput("#gitToken", (v) => pushSettings({ git: { tokenMasked: v } }));
  bindInput("#aiBase", (v) => pushSettings({ ai: { baseUrl: v } }));
  bindInput("#aiKey", (v) => pushSettings({ ai: { apiKeyMasked: v } }));
  bindInput("#aiModel", (v) =>
    pushSettings({ ai: { model: v } }).then((s) => {
      if (s && state.session) {
        state.session.model = s.ai.model;
        updateSessionUI();
      }
    })
  );

  $$("input[type=password]").forEach((inp) => {
    if (inp.id === "ppInput") return;
    inp.addEventListener("focus", () => (inp.type = "text"));
    inp.addEventListener("blur", () => (inp.type = "password"));
  });

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
  $("#composer").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (dismissTop()) e.preventDefault();
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
      saveDoc(state.active);
      return;
    }
    if (mod && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      setMode(state.mode === "raw" ? "preview" : "raw");
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      $("#settingsVeil").classList.add("show");
      return;
    }
    if (mod && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      toggleChat();
      return;
    }
    if (mod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      app.classList.toggle("sidebar-collapsed");
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
    if (window.innerWidth >= 768) app.classList.remove("nav-open");
    syncScrim();
    const ta = $("#rawArea");
    if (ta) autoGrow(ta);
  });

  window.addEventListener("pagehide", () => {
    if (state.dirty && state.active) {
      syncRaw();
      saveDoc(state.active, { silent: true, quiet: true, keepalive: true });
    }
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

  const urlTheme = new URLSearchParams(location.search).get("theme");
  const themeOk = urlTheme && s.meta.themes.some((t) => t.id === urlTheme);
  applyTheme(themeOk ? urlTheme : state.settings.theme);
  applyDensity(state.settings.density);
  if (urlTheme && !themeOk) console.warn("[z-notes] unknown ?theme=" + urlTheme);

  const [, , sync] = await Promise.all([loadTree(), loadSession(), api.getSyncStatus(), loadProposals()]);
  paintSync(sync);

  const first = firstRealDoc(state.tree) || (state.tree[0] && state.tree[0].path);
  wire();
  syncModeSeg();
  await openDoc(first);
  renderChat();

  if (window.innerWidth < 768) {
    app.classList.remove("chat-open");
    $("#chatBtn").classList.remove("on");
  }
  syncScrim();
  connect();
}

function firstRealDoc(nodes) {
  for (const n of nodes) {
    if (n.type === "folder") {
      const f = firstRealDoc(n.children);
      if (f) return f;
    } else if (!n.empty) return n.path;
  }
  return null;
}
