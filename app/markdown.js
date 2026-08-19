/* ============================================================
   markdown.js — the preview renderer (markdown → DOM).

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import { $, I, copyText, el, esc, hl, inline } from "./ui.js";
import { state } from "./state.js";
import { markDirty, saveDoc, updateMeta } from "./editor.js";
import { secretEl } from "./secrets.js";
import { mermaidEl } from "./mermaid.js";

/* ============================================================
   MARKDOWN → PREVIEW
   ============================================================ */
const RE_FENCE = /^\s*```/;
const RE_HEAD = /^(#{1,3})\s+(.+)$/;
const RE_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>/;
const RE_LIST = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const RE_ROW = /^\s*\|/;
const RE_ALIGN = /^\s*\|[\s:|-]+\|\s*$/;

const isBlockStart = (l) => RE_FENCE.test(l) || RE_HEAD.test(l) || RE_RULE.test(l) || RE_QUOTE.test(l) || RE_LIST.test(l) || RE_ROW.test(l);

export const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function tableEl(rows) {
  const w = el("div", "tblwrap");
  const head = cells(rows[0]);
  /* A cell is an inline-content container, like a heading or list item. Route
     it through the same escape-first renderer so supported formatting composes
     consistently without giving table text a separate HTML trust path. */
  let h = "<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
  h += rows.slice(2).map((r) => "<tr>" + cells(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("");
  h += "</tbody></table>";
  w.innerHTML = h;
  return w;
}

/* Code wraps rather than scrolls, and a wrapped line has to stay
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

function listLine(raw) {
  const m = RE_LIST.exec(raw);
  if (!m) return null;
  let indent = 0;
  for (const c of m[1]) indent = c === "\t" ? indent + (4 - (indent % 4)) : indent + 1;
  return { indent, marker: m[2], text: m[4] };
}

function listItemEl(doc, item, lineNo) {
  const t = item.text;
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
  const ordered = /^\d/.test(item.marker);
  const li = el("li", ordered ? "ord" : "bul");
  if (ordered) li.appendChild(el("span", "li-marker", esc(item.marker)));
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

/* A newline in the source is a newline in Preview (ADR 0015). The lines of a
   paragraph (and of a quote) are joined with <br>, not with a space, so the
   author's own line breaks survive into the rendered view.

   Each line is its own [data-line] span rather than a bare run of text, because
   click-to-edit reads the nearest one and under this rule a block is routinely
   many lines: without the spans, clicking the fifth line of a paragraph would
   drop the caret on its first. `.pline` is unstyled — it exists to carry the
   number.

   `inline` runs per line, which makes every inline construct line-local: a
   `**bold**` opened on one line no longer closes on the next. That is the
   honest reading now that the break is a real one, and it keeps a newline out
   of `inline`, where it would otherwise have to survive escaping and the
   attribute of a `[[link]]` pill. */
function lineSpans(lines, start) {
  return lines
    .map((l, k) => '<span class="pline" data-line="' + (start + k) + '">' + inline(l) + "</span>")
    .join("<br>");
}

export function renderPreview(doc, host) {
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
     lines were skipped just above, and EVERY one of them buys a body line-box,
     emitted as a .bgap element (ADR 0015) — a blank line in the source is a
     blank line on screen, the same way a newline is now a line break. Leading
     blanks are the one exception: nothing has been emitted for them to
     separate, so a stray newline at the top of a file does not push the
     document down. */
  const put = (node, line) => {
    if (md.firstChild && blanks > 0) {
      const sp = el("div", "bgap");
      sp.setAttribute("aria-hidden", "true");
      sp.style.height = "calc(" + blanks + " * var(--d-font) * var(--d-lh))";
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
      } else if (/^mermaid$/i.test(lang) && body.trim()) {
        /* the SECOND fence language that renders rather than prints. An empty
           one stays a code block: a diagram being typed starts as an empty
           fence, and swapping a "could not be drawn" panel in front of the
           author on the first keystroke is noise, not feedback. */
        node = mermaidEl(body);
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
      q.innerHTML = lineSpans(buf, start);
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

    if (RE_LIST.test(line)) {
      const ul = el("ul");
      const first = listLine(line);
      const stack = [{ indent: first.indent, list: ul, last: null }];
      while (i < lines.length) {
        const item = listLine(lines[i]);
        if (!item) break;
        let top = stack[stack.length - 1];
        while (stack.length > 1 && item.indent < top.indent) {
          stack.pop();
          top = stack[stack.length - 1];
        }
        if (item.indent > top.indent && top.last) {
          const nested = el("ul");
          top.last.appendChild(nested);
          top = { indent: item.indent, list: nested, last: null };
          stack.push(top);
        }
        const li = listItemEl(doc, item, i);
        li.dataset.line = i;
        top.list.appendChild(li);
        top.last = li;
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
    p.innerHTML = lineSpans(buf, start);
    put(p, start);
  }

  host.appendChild(md);
  wireFolds(doc, md);
}

/* ============================================================
   FOLDS — Preview's outline disclosure (ADR 0023)

   A POST-PASS over the finished `.md`, never a second rendering path. The flat
   block structure this file emits is load-bearing — the `.md > …` selectors,
   the per-line rects `linebreaks-e2e` measures, the children snapshot it takes
   — so nothing is wrapped in a `<section>` and no node moves. A fold only ever
   adds a class. That is the same bargain mermaid's Source toggle strikes with
   ADR 0015's "Preview is a view over the file": what is on screen changes, what
   the file says does not, and one click puts it back.

   Keys are CONTENT plus ordinal, never a line number. A line number is
   invalidated by every edit above it; "the second `## Today` in this document"
   survives a paragraph being typed three screens up, which is the whole point
   of a fold that outlives a save. It is the trick `fenceOrd` already uses to
   tell two identical armor blocks apart. Editing a heading's text drops its
   fold and the section renders open — the honest reading, and the alternative
   was writing an id into the user's file.
   ============================================================ */

const FOLD_STORE = "znotes.folds";
/* How many documents' fold state is worth remembering. This is a convenience,
   not a document: the cap keeps a years-old vault from carrying an unbounded
   blob in localStorage, and a renamed doc simply ages out rather than being
   chased through the rename. */
const FOLD_DOCS = 50;
const HEADING = /^H[123]$/;
let foldsLoaded = false;

/** The fold set for `path`, loading the whole store on first ask. */
function foldSet(path) {
  if (!foldsLoaded) {
    foldsLoaded = true;
    try {
      const stored = JSON.parse(localStorage.getItem(FOLD_STORE) || "{}");
      for (const p of Object.keys(stored)) if (Array.isArray(stored[p])) state.folds.set(p, new Set(stored[p]));
    } catch (_) {
      /* private mode, or a shape some later version wrote: an unreadable cache
         means every section renders OPEN, which is the safe direction to fail */
    }
  }
  let set = state.folds.get(path);
  if (!set) state.folds.set(path, (set = new Set()));
  return set;
}

/** Write-through. Map iteration order IS recency — the touched path is
    re-inserted last — so the cap drops the document nobody has folded in
    longest rather than an arbitrary one. */
function persistFolds(path) {
  const set = state.folds.get(path);
  state.folds.delete(path);
  if (set && set.size) state.folds.set(path, set);
  /* Every doc that has merely been OPENED has an entry here, because that is
     how it was asked what it was folded at. An empty one is not a memory of
     anything, and it must not take a slot from a document that really is
     folded — nor a line in localStorage. */
  for (const [p, s] of state.folds) if (!s.size) state.folds.delete(p);
  while (state.folds.size > FOLD_DOCS) state.folds.delete(state.folds.keys().next().value);
  const out = {};
  for (const [p, s] of state.folds) out[p] = [...s];
  try {
    localStorage.setItem(FOLD_STORE, JSON.stringify(out));
  } catch (_) {
    /* the fold survives this session in state.folds either way */
  }
}

/** a list item's OWN text, without the sub-list hanging under it */
const itemText = (li) => {
  const tx = li.querySelector(":scope > .tx");
  return ((tx ? tx.textContent : li.textContent) || "").trim();
};

function foldKey(node, ords) {
  const base = HEADING.test(node.tagName)
    ? "h" + node.tagName[1] + ":" + node.textContent.trim()
    : "li:" + itemText(node);
  const ord = ords.get(base) || 0;
  ords.set(base, ord + 1);
  return base + ":" + ord;
}

/**
 * Re-apply every fold in `set` to `md`, from scratch.
 *
 * From scratch, not incrementally: folds NEST, and the range of an outer
 * heading contains the inner one's chevron. Recomputing the whole sheet after
 * each toggle is what makes unfolding an h2 leave an h3 inside it still folded
 * — the incremental alternative is a diff between two sets of sibling ranges,
 * for a document that is a few hundred blocks long at most.
 */
function paintFolds(md, set) {
  for (const node of md.querySelectorAll("[data-fold]")) {
    const on = set.has(node.dataset.fold);
    node.classList.toggle("folded", on);
    const btn = node.querySelector(":scope > .fold");
    if (!btn) continue;
    btn.setAttribute("aria-expanded", on ? "false" : "true");
    btn.setAttribute("aria-label", (on ? "Expand " : "Collapse ") + (HEADING.test(node.tagName) ? "section" : "list"));
  }
  /* A folded heading hides its own RANGE: every following sibling up to the
     next heading of the same or higher rank. The `.bgap` spacers go with it —
     a blank line belongs to the section it sits in, and leaving them behind
     would fold a section down to a stack of empty line boxes. Each folded
     heading is applied on its own pass, so the ranges simply overlap and
     nesting composes without anyone having to model it. */
  for (const kid of md.children) kid.classList.remove("fold-hidden");
  for (const kid of md.children) {
    if (!HEADING.test(kid.tagName) || !kid.classList.contains("folded")) continue;
    const rank = +kid.tagName[1];
    for (let n = kid.nextElementSibling; n; n = n.nextElementSibling) {
      if (HEADING.test(n.tagName) && +n.tagName[1] <= rank) break;
      n.classList.add("fold-hidden");
    }
  }
}

function toggleFold(doc, md, node) {
  const set = foldSet(doc.path);
  const key = node.dataset.fold;
  if (set.has(key)) set.delete(key);
  else set.add(key);
  persistFolds(doc.path);
  /* repainted in place rather than re-rendered — the same way a tree folder
     opens. A rebuild here would cost the scroll position, every revealed
     secret and every drawn diagram, to change one class */
  paintFolds(md, set);
}

/**
 * Hang a chevron on every h1–h3 and every list item that has a sub-list, then
 * apply whatever this document was left folded at.
 *
 * The button is EMPTY and carries no icon element. It overlays its owner
 * exactly (`inset: 0` in base.css) and draws itself entirely in pseudo-
 * elements out in the gutter — because the blocks here are measured by code
 * that descends `firstElementChild` looking for the document's first text box
 * (the Preview/Raw origin parity in `tests/e2e.test.ts` and `theming-e2e`),
 * and an icon child would be what that walk found. An empty overlay is a box
 * identical to the one it is standing in front of, so the walk lands where it
 * always landed.
 *
 * Being a <button> also puts it outside click-to-edit's reach —
 * `previewClickToEdit` skips buttons — so the chevron folds without the pane
 * flipping to Raw underneath it, while the text beside it still opens Raw:
 * only the gutter pad takes a pointer at all.
 */
function wireFolds(doc, md) {
  const ords = new Map();
  for (const node of md.querySelectorAll("h1, h2, h3, li")) {
    if (node.tagName === "LI" && !node.querySelector(":scope > ul")) continue;
    node.dataset.fold = foldKey(node, ords);
    const btn = el("button", "fold");
    btn.type = "button";
    /* every chevron sits on ONE SPINE in the page gutter (see base.css). CSS
       knows the width of a list indent but not how many of them stand between
       this item and the margin — that count is the one number it needs. */
    let depth = 0;
    for (let p = node.parentElement; p && p !== md; p = p.parentElement) if (p.tagName === "UL") depth++;
    if (depth > 1) btn.style.setProperty("--fold-depth", depth - 1);
    btn.addEventListener("click", () => toggleFold(doc, md, node));
    node.appendChild(btn);
  }
  paintFolds(md, foldSet(doc.path));
}

/** the block `revealLine` would scroll to — the last [data-line] at or above
    `lineNo`. Restated here because a line inside a folded range has to be
    found by the same rule that is about to look for it. */
function blockForLine(md, lineNo) {
  let best = null;
  for (const b of md.querySelectorAll("[data-line]")) {
    const l = parseInt(b.dataset.line, 10);
    if (l <= lineNo && (!best || l >= parseInt(best.dataset.line, 10))) best = b;
  }
  return best;
}

/** what has to be unfolded for `node` to be on screen, or null if nothing has */
function foldHiding(md, node) {
  const range = node.closest(".fold-hidden");
  if (range) {
    /* A folded heading above the hidden block covers it only if its range
       actually REACHES it: any heading in between of the same or higher rank
       ended that range already. So the walk keeps the best rank seen so far,
       and only a folded heading that outranks everything it reaches past is
       the hider — without this, a jump would unfold every folded section it
       merely passed on the way up, and persist the damage. An outer fold over
       the true hider surfaces on the next pass. */
    let best = 4; /* one past h3 — nothing outranked yet */
    for (let p = range.previousElementSibling; p; p = p.previousElementSibling) {
      if (!HEADING.test(p.tagName)) continue;
      const rank = +p.tagName[1];
      if (rank < best && p.classList.contains("folded")) return p;
      if (rank < best) best = rank;
    }
    return null;
  }
  for (let p = node.parentElement; p && p !== md; p = p.parentElement)
    if (p.tagName === "LI" && p.classList.contains("folded")) return p;
  return null;
}

/**
 * Unfold whatever is hiding source line `lineNo`, so a jump-to-line can land on
 * it. The analogue of `revealFolder` force-opening a row's ancestors: someone
 * asked to be taken to a line, and a fold is the app's own view state — not an
 * answer to that request.
 */
export function ensureLineVisible(doc, lineNo) {
  const md = $("#doc .md");
  if (!md || !doc) return;
  /* bounded rather than `while (true)`: each pass unfolds exactly one thing and
     the nesting is finite, but a loop that repaints the DOM does not get to
     depend on that being true of a document it has never seen */
  for (let pass = 0; pass < 64; pass++) {
    const target = blockForLine(md, lineNo);
    if (!target) return;
    const hider = foldHiding(md, target);
    if (!hider) return;
    const set = foldSet(doc.path);
    set.delete(hider.dataset.fold);
    persistFolds(doc.path);
    paintFolds(md, set);
  }
}
