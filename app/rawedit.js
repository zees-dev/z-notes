/* ============================================================
   rawedit.js — the Raw surface, as a LINE EDITOR (ADR 0032).

   A `<textarea>` has exactly one font size. Preview does not: an `h1` is
   `--h1-size`, body copy is `--d-font`, and a link is the accent colour. So
   every ⌘E and every click-to-edit resized the whole document, the one thing
   ADR 0027 could not fix: it keeps the LINE under the reader, not the line's
   size. Per-line typography is not expressible in a textarea at all, so the
   textarea is gone. What replaces it is one `contenteditable` root with one
   block element per SOURCE LINE, styled by what that line is, and links
   painted through the CSS Custom Highlight API so no inline DOM ever changes
   under the caret.

   THE SEAM IS THE TEXTAREA'S OWN VOCABULARY. This element answers to `value`,
   `selectionStart`/`selectionEnd`, `setSelectionRange`, `placeholder`, `wrap`
   and `focus`, and it fires `input`, `select`, `copy`, `cut` and `paste`, so
   editor.js keeps calling exactly what it called before: Tab, list
   continuation, the whole-line clipboard (ADR 0013), ⌘⇧E, the mode-switch
   anchoring. The one thing a textarea gave that this cannot is the browser's
   native undo stack, and ADR 0014 took ⌘Z away from the browser two releases
   ago.

   THERE ARE EXACTLY TWO WRITE PATHS, and no third:

     `replaceRange`: every edit this app makes, and every edit a cancelable
                     `beforeinput` describes IN FULL. Model first, then only
                     the line nodes that changed.
     `reconcile`:    what the browser did without asking. An IME composition,
                     an edit that arrived with no cancelable `beforeinput`, and
                     a delete the browser would not say the extent of (a
                     collapsed-caret ⌫/⌥⌫/⌘⌫ arrives here with EMPTY
                     `getTargetRanges()`, so the browser performs it with its
                     own word, line and grapheme boundaries and this reads the
                     result). Reads the DOM, believes it, and normalises the
                     shape back when it is safe to.

   If a browser quirk surfaces that neither covers, the fix belongs in the
   reconcile's normalisation, never in a special case in editor.js.
   ============================================================ */
"use strict";

import { $, trimUrlTail } from "./ui.js";

/* ============================================================
   THE TWO PURE PASSES

   Both restate rules that live in markdown.js / ui.js rather than importing
   them: this module is a LEAF of the editor, not a peer of the renderer, and
   the renderer's versions work on escaped HTML mid-emission. Keep them in step
   with the sources the citations below name.
   ============================================================ */

/* app/markdown.js's own two, verbatim. Preview renders only `#`–`###` as
   headings, so `####` is a paragraph there and body-sized here. */
const RE_FENCE = /^\s*```/;
const RE_HEAD = /^(#{1,3})\s+(.+)$/;

/**
 * Per-line kinds — `"h1"|"h2"|"h3"|"code"|""` — one per line of `text`.
 * A line that TOGGLES a fence is code too, so ``` ``` `` never grows into a
 * heading and a `# comment` inside a block stays body-sized.
 */
export function classifyLines(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text).split("\n")) {
    if (RE_FENCE.test(line)) {
      fenced = !fenced;
      out.push("code");
      continue;
    }
    if (fenced) {
      out.push("code");
      continue;
    }
    const h = RE_HEAD.exec(line);
    out.push(h ? "h" + h[1].length : "");
  }
  return out;
}

/* The four spellings ui.js `inline()` turns into an anchor or a pill, in the
   same order it runs them — each pass may only claim text no earlier one did,
   which is what its `EMITTED` alternation buys there and the `taken` list
   buys here. */
const RE_CODE_SPAN = /`[^`\n]+`/g;
const RE_WIKI = /\[\[[^\]\n]+\]\]/g;
const RE_MD_LINK = /(!?)\[[^\]\n]+\]\(((?:\([^()\s]*\)|[^()\s])+)\)/g;
const RE_ANGLE = /<https?:\/\/[^\s>]+>/g;
const RE_BARE = /https?:\/\/[^\s<]+/g;
const RE_SCHEME = /^(https?:\/\/|mailto:)/i;

/**
 * The link ranges over `text`, as `[{start, end}]` offsets into it.
 *
 * Never inside an inline code span and never inside a fence, because Preview
 * does not link there either — the promise a fence makes is that what is in it
 * is literal, and a highlight that disagreed would be the renderer lying about
 * the file.
 */
export function linkRanges(text) {
  const src = String(text);
  const kinds = classifyLines(src);
  const out = [];
  let base = 0;
  src.split("\n").forEach((line, i) => {
    if (kinds[i] !== "code") scanLine(line, base, out);
    base += line.length + 1;
  });
  return out.sort((a, b) => a.start - b.start);
}

function scanLine(line, base, out) {
  const taken = [];
  const free = (a, b) => !taken.some((r) => a < r.end && b > r.start);
  const claim = (a, b) => {
    taken.push({ start: a, end: b });
    out.push({ start: base + a, end: base + b });
  };
  /* opaque to every pass below, and never a link itself */
  for (const m of line.matchAll(RE_CODE_SPAN)) taken.push({ start: m.index, end: m.index + m[0].length });

  for (const m of line.matchAll(RE_WIKI)) if (free(m.index, m.index + m[0].length)) claim(m.index, m.index + m[0].length);
  for (const m of line.matchAll(RE_MD_LINK)) {
    /* `!` is image syntax the renderer does not speak, and only http(s)/mailto
       ever becomes a link — a `javascript:` spelling stays literal text
       (ADR 0016) */
    if (m[1] || !RE_SCHEME.test(m[2])) continue;
    if (free(m.index, m.index + m[0].length)) claim(m.index, m.index + m[0].length);
  }
  for (const m of line.matchAll(RE_ANGLE)) if (free(m.index, m.index + m[0].length)) claim(m.index, m.index + m[0].length);
  for (const m of line.matchAll(RE_BARE)) {
    /* a bare URL drags its sentence along; the renderer peels the same tail */
    const end = m.index + trimUrlTail(m[0]).length;
    if (end > m.index && free(m.index, end)) claim(m.index, end);
  }
}

/* ============================================================
   THE EDITOR
   ============================================================ */

const BLOCKISH = /^(DIV|P|LI|BLOCKQUOTE|PRE|H[1-6])$/;

/* The composition is the IME's, start to finish: cancelling any of these takes
   the candidate window away mid-word, and on some Android keyboards the word
   with it. The reconcile picks the result up from the DOM instead. */
const COMPOSITION_INPUTS = new Set([
  "insertCompositionText",
  "deleteCompositionText",
  "insertFromComposition",
  "deleteByComposition",
]);

/** Text this module wrote is `insertText`-shaped; everything else names the
    `beforeinput` that asked for it, so a listener can tell them apart. */
const NEWLINE_INPUTS = new Set(["insertParagraph", "insertLineBreak"]);
const TEXT_INPUTS = new Set(["insertText", "insertReplacementText", "insertTranspose"]);
const DATA_INPUTS = new Set(["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank"]);
const DELETE_INPUTS = new Set([
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteEntireSoftLine",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteByCut",
  "deleteByDrag",
  "deleteContent",
]);

/** The edits that are only ever performed here when the browser SAYS what they
    apply to. Each one moves or replaces text somewhere other than the
    selection — a dictation or autocorrect swap over the word behind the caret,
    a transposition, a drag that lands where the pointer is and lifts from
    where it started — so a fallback to the selection would insert the text
    without removing the text it replaces. */
const NEEDS_TARGET = new Set(["insertReplacementText", "insertTranspose", "insertFromDrop", "deleteByDrag"]);

/**
 * Build the Raw surface. Returns the root element, augmented with the
 * textarea-shaped surface described at the top of this file.
 */
export function createRawEditor() {
  const root = document.createElement("div");
  root.className = "raw";
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  /* `plaintext-only` is what keeps a phone keyboard, a dictation engine and a
     drag-and-drop from inventing markup. An older Firefox rejects the value
     outright and is then not editable at all, so fall back to `true`: this
     module intercepts every input itself, so the buffer is plain text either
     way — the browser simply stops helping. */
  root.setAttribute("contenteditable", "plaintext-only");
  if (root.contentEditable !== "plaintext-only") root.setAttribute("contenteditable", "true");

  /* ---------- the model ----------
     `lines` is the truth, `text` and `starts` are its two derived indexes.
     Kept together so a keystroke costs one join and one scan of a document,
     not one per question asked about it. */
  let lines = [""];
  let text = "";
  let starts = [0];
  let selCache = { start: 0, end: 0, direction: "none" };

  function remodel(next) {
    lines = next.length ? next : [""];
    text = lines.join("\n");
    starts = new Array(lines.length);
    for (let i = 0, at = 0; i < lines.length; i++) {
      starts[i] = at;
      at += lines[i].length + 1;
    }
    root.classList.toggle("is-empty", text === "");
  }

  const clampPos = (n) => Math.max(0, Math.min(Number(n) || 0, text.length));

  function lineForOffset(pos) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /* ---------- the DOM this module writes ---------- */

  function makeLine(line, kind) {
    const d = document.createElement("div");
    d.className = kind ? "ln " + kind : "ln";
    /* one text node, or one <br> — an empty block has no line box without it */
    d.appendChild(line ? document.createTextNode(line) : document.createElement("br"));
    return d;
  }

  /** Fence state can flip BELOW an edit, so kinds are re-derived for the whole
      document — but only a `className` that actually changed is written. */
  function paintKinds(kinds) {
    const nodes = root.children;
    for (let i = 0; i < nodes.length && i < kinds.length; i++) {
      const want = kinds[i] ? "ln " + kinds[i] : "ln";
      if (nodes[i].className !== want) nodes[i].className = want;
    }
  }

  function renderAll() {
    const kinds = classifyLines(text);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) frag.appendChild(makeLine(lines[i], kinds[i]));
    root.replaceChildren(frag);
  }

  /* ---------- reading the DOM ----------

     ONE reader, used by the selection getters and by the reconcile. It returns
     the text the DOM currently spells, the offset of every text node in it,
     and whether the shape is the canonical one above. Anything else — a bare
     text node the browser dropped between two lines, a `<br>` in the middle of
     one, a nested block from an edit it performed itself — still READS
     correctly and marks the shape dirty, which is what makes the reconcile a
     normaliser rather than a list of special cases. */
  function readDom() {
    const parts = [];
    const at = new Map();
    let len = 0;
    let tail = "\n";
    let clean = true;
    const push = (s) => {
      if (!s) return;
      parts.push(s);
      len += s.length;
      tail = s[s.length - 1];
    };
    const emit = (node, isLast) => {
      if (node.nodeType === 3) {
        /* A "\n" INSIDE a text node is a line the DOM does not have a node
           for: the model would then hold more lines than there are `.ln`
           children and every index-based path — `domAt`, `paintKinds`,
           `replaceRange`, `boxAt` — would be off by one from there down. It
           reads correctly; it is simply not the canonical shape, and saying so
           is what sends it through the normalisation. (WebKit writes one for a
           line break inside a `white-space: pre-wrap` host.) */
        if (node.data.includes("\n")) clean = false;
        at.set(node, len);
        push(node.data);
        return;
      }
      if (node.nodeName === "BR") {
        /* the placeholder a browser leaves at the end of an empty block is not
           a line break; one with text after it is */
        if (!isLast) push("\n");
        return;
      }
      clean = false;
      at.set(node, len);
      if (BLOCKISH.test(node.nodeName) && tail !== "\n") push("\n");
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) emit(kids[i], i === kids.length - 1);
    };

    const kids = root.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (i) push("\n");
      if (node.nodeType === 1 && node.classList.contains("ln")) {
        at.set(node, len);
        const c = node.childNodes;
        if (!(c.length === 1 && (c[0].nodeType === 3 || c[0].nodeName === "BR"))) clean = false;
        for (let k = 0; k < c.length; k++) emit(c[k], k === c.length - 1);
      } else {
        clean = false;
        emit(node, true);
      }
    }
    return { text: parts.join(""), at, clean };
  }

  /** The first (or last) text node inside `node`, or null — a `<br>`-only line
      has none, which is the case the element fallback below exists for. */
  function edgeText(node, last) {
    if (node.nodeType === 3) return node;
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const t = edgeText(kids[last ? kids.length - 1 - i : i], last);
      if (t) return t;
    }
    return null;
  }

  /** A selection endpoint, as an offset into what `walk` read. */
  function endpoint(walk, node, off) {
    if (!node || !root.contains(node)) return null;
    if (node.nodeType === 3) {
      const base = walk.at.get(node);
      return base == null ? null : base + Math.min(off, node.data.length);
    }
    /* an element endpoint addresses a CHILD INDEX: take the first text node at
       or after it, else the end of the last one before it, else the element */
    const kids = node.childNodes;
    for (let i = off; i < kids.length; i++) {
      const t = edgeText(kids[i], false);
      if (t && walk.at.has(t)) return walk.at.get(t);
      if (walk.at.has(kids[i])) return walk.at.get(kids[i]);
    }
    for (let i = Math.min(off, kids.length) - 1; i >= 0; i--) {
      const t = edgeText(kids[i], true);
      if (t && walk.at.has(t)) return walk.at.get(t) + t.data.length;
      /* an EMPTY line has no text node, and its start is also its end — the
         case a caret parked on the trailing blank line of a file lands in */
      if (walk.at.has(kids[i])) return walk.at.get(kids[i]);
    }
    const own = walk.at.get(node);
    return own == null ? null : own;
  }

  /** The live selection as offsets, or null when it is not inside the root. */
  function readSelection(walk) {
    const s = document.getSelection();
    if (!s || !s.rangeCount) return null;
    /* containment first: `selectionchange` is a DOCUMENT event and fires for
       every selection on the page, and walking this editor to answer a
       question about the sidebar would be the whole cost for none of the value */
    if (!root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null;
    const w = walk || readDom();
    const a = endpoint(w, s.anchorNode, s.anchorOffset);
    const f = endpoint(w, s.focusNode, s.focusOffset);
    if (a == null || f == null) return null;
    return {
      start: Math.min(a, f),
      end: Math.max(a, f),
      direction: a === f ? "none" : a < f ? "forward" : "backward",
    };
  }

  /** A model offset as a (node, offset) pair in the canonical DOM. */
  function domAt(pos) {
    const i = lineForOffset(pos);
    const ln = root.children[i];
    if (!ln) return { node: root, offset: root.childNodes.length };
    let col = pos - starts[i];
    for (const k of ln.childNodes) {
      if (k.nodeType !== 3) continue;
      if (col <= k.data.length) return { node: k, offset: col };
      col -= k.data.length;
    }
    return { node: ln, offset: 0 }; // an empty line: before its <br>
  }

  /**
   * Put the document selection where the offsets say — but only when this
   * editor already owns it. A textarea remembers its selection while unfocused
   * and setting one does not steal focus; there is only ONE document
   * selection, so the equivalent promise here is not to take it from whoever
   * has it. Unfocused callers still update the cache the getters read.
   */
  function applySelection(a, b, direction) {
    selCache = { start: a, end: b, direction: a === b ? "none" : direction || "forward" };
    const sel = document.getSelection();
    if (!sel) return;
    const owns = document.activeElement === root || (sel.anchorNode && root.contains(sel.anchorNode));
    if (!owns) return;
    const p = domAt(a);
    const q = domAt(b);
    try {
      if (direction === "backward") sel.setBaseAndExtent(q.node, q.offset, p.node, p.offset);
      else sel.setBaseAndExtent(p.node, p.offset, q.node, q.offset);
    } catch (_) {}
  }

  /* ---------- link highlights ----------
     One Highlight under one fixed name, replaced on every render — never
     accumulated, and never inline DOM: a `<span>` around a URL would be a node
     appearing and disappearing under the caret while somebody types into it,
     which is exactly how an editor loses an IME composition. */
  const canHighlight = () => typeof window !== "undefined" && !!window.Highlight && !!(window.CSS && CSS.highlights);
  let hlFrame = 0;

  function paintLinks() {
    hlFrame = 0;
    if (!canHighlight() || !root.isConnected) return;
    const ranges = [];
    for (const { start, end } of linkRanges(text)) {
      const a = domAt(start);
      const b = domAt(end);
      const r = document.createRange();
      try {
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        ranges.push(r);
      } catch (_) {}
    }
    if (ranges.length) CSS.highlights.set("raw-link", new Highlight(...ranges));
    else CSS.highlights.delete("raw-link");
  }

  /* a burst of keystrokes repaints once */
  function scheduleLinks() {
    if (!canHighlight() || hlFrame) return;
    hlFrame = requestAnimationFrame(paintLinks);
  }

  /* ---------- write path 1: every edit this app makes ---------- */

  /**
   * Replace `[a, b)` with `insert`, leaving the caret after it.
   *
   * Only the line nodes the edit spans are rebuilt. Every other `.ln` keeps
   * its identity, which is what keeps the browser's own caret, IME state and
   * scroll anchoring from moving when a document is edited near its end.
   */
  function replaceRange(a, b, insert, inputType, data) {
    a = clampPos(a);
    b = clampPos(b);
    if (a > b) [a, b] = [b, a];
    insert = insert == null ? "" : String(insert);
    if (a === b && !insert) return;

    const first = lineForOffset(a);
    const last = lineForOffset(b);
    const head = lines[first].slice(0, a - starts[first]);
    const tail = lines[last].slice(b - starts[last]);
    const mid = (head + insert + tail).split("\n");
    remodel(lines.slice(0, first).concat(mid, lines.slice(last + 1)));

    const kinds = classifyLines(text);
    const made = mid.map((line, k) => makeLine(line, kinds[first + k]));
    const stale = [];
    for (let i = first; i <= last; i++) if (root.children[i]) stale.push(root.children[i]);
    if (stale.length) {
      stale[0].replaceWith(...made);
      for (let i = 1; i < stale.length; i++) stale[i].remove();
    } else {
      root.append(...made);
    }
    paintKinds(kinds);

    const caret = a + insert.length;
    applySelection(caret, caret, "none");
    scheduleLinks();
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: data == null ? null : data }));
  }

  /* ---------- write path 2: what the browser did without asking ---------- */

  /**
   * Believe the DOM, then put it back in shape.
   *
   * During a composition the nodes are the IME's — touching them drops the
   * candidate window and, on some Android keyboards, the whole word. So a
   * composing reconcile moves the MODEL, the line classes and the highlights
   * and nothing else; `compositionend` runs the same pass with normalisation
   * allowed.
   */
  function reconcile(composing) {
    const walk = readDom();
    const normalise = !walk.clean && !composing;
    /* read the selection against the shape that is about to be replaced */
    const sel = normalise ? readSelection(walk) : null;
    remodel(walk.text.split("\n"));
    if (normalise) {
      renderAll();
      if (sel) applySelection(sel.start, sel.end, sel.direction);
    } else if (lines.length === root.children.length) {
      /* `paintKinds` addresses lines BY INDEX, so it is only meaningful while
         the DOM has one child per line. A composition can leave it holding
         fewer (a text node carrying its own "\n"); painting then writes each
         class onto the wrong node. The `compositionend` pass normalises the
         shape and paints it right — nothing is lost by waiting for it. */
      paintKinds(classifyLines(text));
    }
    scheduleLinks();
  }

  /* ---------- input ---------- */

  /** What the browser says the edit applies to — a drop lands where the
      pointer is, not where the caret is — falling back to the selection. */
  function targetOf(e) {
    const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : null;
    const r = ranges && ranges[0];
    if (r) {
      const walk = readDom();
      const a = endpoint(walk, r.startContainer, r.startOffset);
      const b = endpoint(walk, r.endContainer, r.endOffset);
      if (a != null && b != null) return { start: Math.min(a, b), end: Math.max(a, b), given: true };
    }
    const s = readSelection() || selCache;
    return { start: s.start, end: s.end, given: false };
  }

  const plainOf = (e) => (e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");

  root.addEventListener("beforeinput", (e) => {
    const t = e.inputType;
    /* the composition is the browser's; the reconcile picks it up on `input` */
    if (e.isComposing || COMPOSITION_INPUTS.has(t)) return;
    /* A `beforeinput` that cannot be cancelled is an ANNOUNCEMENT, not a
       request: the browser is going to do it whatever this says, and the
       reconcile is what picks the result up. Acting on it here as well would
       apply the same edit twice. */
    if (!e.cancelable) return;

    if (t === "historyUndo" || t === "historyRedo") {
      /* An iOS keyboard's undo key, shake-to-undo, the Edit menu: the app owns
         the timeline (ADR 0014), so these are the host's to answer rather than
         the browser's to perform. `renderRaw` says what is on the other end. */
      e.preventDefault();
      if (typeof root.onHistory === "function") root.onHistory(t === "historyRedo");
      return;
    }

    /* MEASURED FIRST, cancelled second. Chromium hands a `plaintext-only` host
       EMPTY `getTargetRanges()` for every `delete*` — ⌫, ⌥⌫, ⌥⌦ and ⌘⌫ all
       arrive with none — and the extent of those is exactly what this module
       cannot re-derive: one code point back from the caret turns ⌥⌫ into a
       single character and splits a grapheme cluster (a ZWJ family, a flag
       pair, a combining mark) down the middle. So when the browser will not say
       WHERE, it keeps the edit: it knows its own word, line and cluster
       boundaries, and the trusted `input` that follows runs the reconcile,
       which reads the result and normalises the shape if it needs to.
       NEEDS_TARGET is the same rule for a different reason — those four
       replace or move text that is NOT the selection, so acting on the
       selection would insert without ever removing. */
    const at = targetOf(e);
    if (!at.given && (NEEDS_TARGET.has(t) || (DELETE_INPUTS.has(t) && at.start === at.end))) return;

    e.preventDefault();

    if (TEXT_INPUTS.has(t) || DATA_INPUTS.has(t)) {
      const insert = plainOf(e);
      if (insert) replaceRange(at.start, at.end, insert, t, insert);
      else if (at.end > at.start) replaceRange(at.start, at.end, "", t, null);
      return;
    }
    if (NEWLINE_INPUTS.has(t)) return replaceRange(at.start, at.end, "\n", t, null);
    if (DELETE_INPUTS.has(t)) {
      if (at.end > at.start) replaceRange(at.start, at.end, "", t, null);
      return;
    }
    /* `format*` and the rest: markdown has no bold button — the source says so */
  });

  root.addEventListener("input", (e) => {
    /* Ours carry the model already. An UNTRUSTED input is the app (or a test)
       saying "I set `.value`, tell the listeners" — also already in the model.
       What is left is what the browser did on its own. */
    if (!e.isTrusted) return;
    reconcile(!!e.isComposing);
  });
  root.addEventListener("compositionend", () => reconcile(false));

  /* ---------- clipboard ----------

     The browser's own serialisation of a block-per-line DOM is not the file:
     it invents and drops newlines at the edges and cannot see a trailing empty
     line at all. The model can. Propagation is deliberately NOT stopped —
     `renderRaw` listens for the same two events to retire the whole-line
     clipboard (ADR 0013). */
  function clip(e, cutting) {
    const s = readSelection();
    if (!s || s.start === s.end || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text.slice(s.start, s.end));
    e.preventDefault();
    if (cutting) replaceRange(s.start, s.end, "", "deleteByCut", null);
  }
  root.addEventListener("copy", (e) => clip(e, false));
  root.addEventListener("cut", (e) => clip(e, true));

  /* A textarea fires `select`; `renderRaw` listens for it to keep the caret
     above the soft keyboard. `selectionchange` is a DOCUMENT event, so it
     retires itself once this editor has been rendered away. */
  function onSelectionChange() {
    if (!root.isConnected) {
      document.removeEventListener("selectionchange", onSelectionChange);
      return;
    }
    const s = readSelection();
    if (!s) return;
    selCache = s;
    root.dispatchEvent(new Event("select", { bubbles: true }));
  }
  document.addEventListener("selectionchange", onSelectionChange);

  /* ---------- the surface ---------- */

  Object.defineProperties(root, {
    value: {
      get: () => text,
      set(next) {
        /* the scroll container is the pane's, not this element's, and rebuilding
           every line under it must not move the reader */
        const sc = $("#scroll");
        const keep = sc ? sc.scrollTop : 0;
        remodel(String(next == null ? "" : next).split("\n"));
        renderAll();
        if (sc) sc.scrollTop = keep;
        /* textarea semantics: the caret goes to the end and callers that care
           set it afterwards */
        applySelection(text.length, text.length, "none");
        scheduleLinks();
      },
    },
    selectionStart: {
      get: () => (readSelection() || selCache).start,
      set(v) {
        const s = readSelection() || selCache;
        const a = clampPos(v);
        applySelection(a, Math.max(a, s.end), "forward");
      },
    },
    selectionEnd: {
      get: () => (readSelection() || selCache).end,
      set(v) {
        const s = readSelection() || selCache;
        const b = clampPos(v);
        applySelection(Math.min(s.start, b), b, "forward");
      },
    },
    selectionDirection: { get: () => (readSelection() || selCache).direction },
    setSelectionRange: {
      value(a, b, direction) {
        a = clampPos(a);
        b = clampPos(b);
        applySelection(Math.min(a, b), Math.max(a, b), direction);
      },
    },
    replaceRange: {
      value(a, b, insert) {
        replaceRange(a, b, insert, insert ? "insertText" : "deleteContentBackward", insert || null);
      },
    },
    /** Where an offset physically IS, in viewport coordinates. ADR 0027's
        "measured, never multiplied" now measures the real DOM instead of a
        mirror of it — a heading line is taller than a body line, and no mirror
        of a single typography could have said so. */
    boxAt: {
      value(offset) {
        const pos = clampPos(offset);
        const p = domAt(pos);
        const r = document.createRange();
        const pick = () => {
          for (const x of r.getClientRects()) if (x.height) return x;
          const b = r.getBoundingClientRect();
          return b.height ? b : null;
        };
        let rect = null;
        if (p.node.nodeType === 3) {
          r.setStart(p.node, p.offset);
          r.collapse(true);
          rect = pick();
          /* the end of a soft-wrapped row has no box of its own; the character
             before it does, and it is on the row the reader means */
          if (!rect && p.offset > 0) {
            r.setStart(p.node, p.offset - 1);
            r.setEnd(p.node, p.offset);
            rect = pick();
          }
          if (!rect && p.offset < p.node.data.length) {
            r.setStart(p.node, p.offset);
            r.setEnd(p.node, p.offset + 1);
            rect = pick();
          }
        }
        if (rect) return { top: rect.top, bottom: rect.bottom };
        const line = root.children[lineForOffset(pos)] || root;
        const lr = line.getBoundingClientRect();
        return { top: lr.top, bottom: lr.bottom };
      },
    },
    placeholder: {
      get: () => root.getAttribute("data-placeholder") || "",
      set(v) {
        root.setAttribute("data-placeholder", v == null ? "" : String(v));
      },
    },
    wrap: {
      get: () => (root.classList.contains("no-wrap") ? "off" : "soft"),
      set(v) {
        root.classList.toggle("no-wrap", v === "off");
      },
    },
  });

  remodel([""]);
  renderAll();
  return root;
}
