/* ============================================================
   markdown.js — the preview renderer (markdown → DOM).

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import { $, I, copyText, el, esc, hl, inline } from "./ui.js";
import { markDirty, saveDoc, updateMeta } from "./editor.js";
import { secretEl } from "./secrets.js";

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

export const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

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
