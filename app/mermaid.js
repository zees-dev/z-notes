/* ============================================================
   mermaid.js — ```mermaid fences become diagrams in the preview.

   THE LIBRARY IS NOT LOADED UNTIL A DIAGRAM IS ON SCREEN. The bundle is 3.3 MB
   — bigger than the rest of the app put together — so it is reached by a
   dynamic `import()` fired from the first fence that needs it, and a vault
   that never draws a diagram never pays for one. `app/vendor/mermaid.js` is a
   COMMITTED artifact (`bun scripts/build-mermaid.ts`, ADR 0010), served as an
   ordinary static file; there is still no frontend build step.

   THE THREAT MODEL, because this is the first module that renders text as
   MARKUP rather than as text. Everywhere else in the preview, doc content
   reaches the DOM through `esc()` or `.textContent`. A diagram cannot: mermaid
   emits SVG, and SVG is markup. The bytes it is emitted FROM are not
   necessarily the owner's own typing — a vault syncs over git (SPEC §7) and
   the AI relay writes docs (SPEC §8) — so a fence is treated as untrusted
   input. Three independent layers, in order:

     1. `securityLevel: "strict"` — mermaid runs its own DOMPurify pass over
        the SVG before returning it, refuses `click`/`call` directives, and
        drops HTML labels. `secure` names the keys an in-diagram
        `%%{init: …}%%` directive may NOT override, so a hostile fence cannot
        turn any of this off from inside the doc it lives in.
     2. `sanitizeSvg()` below — our own pass, on the assumption that layer 1
        has a bug someday. mermaid has shipped XSS advisories before and will
        again; this pass is what keeps that from being a z-notes advisory too.
        It is deliberately a WHITELIST of attributes, not a blacklist.
     3. `bindFunctions` is NEVER called. mermaid returns it from `render()` to
        wire up interactive callbacks; not calling it means the handlers it
        would attach do not exist, whatever the diagram asked for.

   WHAT IS DELIBERATELY NOT DONE: `securityLevel: "sandbox"` (an iframe) is
   stronger still and was rejected — it costs selectable text, inherited
   theming and correct sizing, which is most of what a diagram in a note is
   for. The three layers above are the trade taken instead.
   ============================================================ */
"use strict";

import { $, I, copyText, el, esc } from "./ui.js";

/* The diagram source each mounted block was drawn from, so a theme change can
   redraw without the preview being rebuilt. Weak: a block that leaves the DOM
   takes its entry with it. */
const SOURCE = new WeakMap();

/** `mermaid.render` needs a DOM id per call and does not care which. */
let seq = 0;

let libPromise = null;

/* ---------- theme ----------
   Diagrams follow the app's look (ADR 0003) rather than shipping a palette of
   their own. The tokens are read from the live computed style at RENDER time,
   which is the only moment all three of `data-theme`, `data-scheme` and the
   theme stylesheet are known to have settled. */
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function themeConfig() {
  const panel = token("--panel", "#ffffff");
  const text = token("--text", "#14161c");
  const line = token("--line", "#e2e3e8");
  return {
    /* "base" is the only built-in theme that takes themeVariables seriously;
       the others hardcode their own palette and ignore most of this. */
    theme: "base",
    fontFamily: token("--font-doc", "sans-serif"),
    themeVariables: {
      background: panel,
      primaryColor: token("--accent-soft", "#eceef1"),
      primaryTextColor: text,
      primaryBorderColor: line,
      secondaryColor: token("--panel-2", "#f7f7f9"),
      tertiaryColor: token("--panel-3", "#eeeff2"),
      lineColor: token("--muted-2", "#9096a3"),
      textColor: text,
      mainBkg: token("--accent-soft", "#eceef1"),
      nodeBorder: line,
      clusterBkg: token("--panel-2", "#f7f7f9"),
      clusterBorder: token("--line-2", "#ededf1"),
      titleColor: text,
      edgeLabelBackground: panel,
      errorBkgColor: token("--danger-soft", "#fdeceb"),
      errorTextColor: token("--danger", "#c42d27"),
    },
  };
}

/**
 * The hardened configuration, in one place so it can be read as a whole.
 *
 * Every key here is a SAFETY key or a look key; there are no behaviour
 * preferences mixed in, deliberately, so that a future "make the arrows
 * curvier" edit cannot quietly land next to `securityLevel`.
 */
function config() {
  return Object.assign(
    {
      /* nothing auto-runs: every render in this app is one this module asked
         for, against one element it owns */
      startOnLoad: false,
      /* THE load-bearing one. Anything below "strict" re-enables HTML labels
         and click handlers. */
      securityLevel: "strict",
      /* belt and braces — "strict" already implies this, and a future mermaid
         default flip must not silently re-enable foreignObject labels */
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
      /* THE KEYS AN IN-DIAGRAM DIRECTIVE MAY NOT OVERRIDE — and the reason this
         list is long. A fence can carry configuration two ways, YAML
         frontmatter and `%%{init: …}%%`, and mermaid's `sanitize()` REPLACES
         this array rather than extending it. Drop a name and it is unlocked:
         omitting `securityLevel` would let a hostile diagram turn off its own
         sanitizer from inside the doc.

         The first six are mermaid's own defaults, re-listed because supplying
         the key at all discards them. The rest are ours:

           htmlLabels    — the one that matters. mermaid does NOT lock it, and
                           `flowchart.htmlLabels` flattens to this same bare
                           name, so both channels can flip labels back to real
                           HTML in a <foreignObject> — which is the surface
                           behind essentially every mermaid XSS ever reported
                           against an embedder.
           dompurifyConfig — would let a diagram relax label sanitisation with
                           `{ADD_TAGS:['script']}`. Blocked today only because
                           it has no default; locked so it stays blocked.
           themeCSS, fontFamily, altFontFamily, theme, layout, look
                         — all feed the CSS pipeline, which is the class behind
                           CVE-2022-31108, CVE-2026-41148/41159 and
                           CVE-2026-50159. */
      secure: [
        "secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges",
        "htmlLabels", "dompurifyConfig", "themeCSS", "fontFamily", "altFontFamily", "theme", "layout", "look",
      ],
      /* DoS bounds, tighter than mermaid's 50000/500 defaults because a note is
         not a dashboard. A doc is a file on disk that git sync or the AI relay
         may have written, so "the user would not do that" is not an argument.
         NOTE these are the real guard: `securityLevel` does nothing about the
         infinite-loop advisories, and `maxEdges` is only enforced for
         flowcharts — `maxTextSize` is what covers every other diagram type. */
      maxTextSize: 20000,
      maxEdges: 200,
      /* mermaid's own error graphic injects itself into document.body and
         leaves an orphan node behind on failure. Set, it throws instead and
         cleans up, which lets paint() own the error surface. */
      suppressErrorRendering: true,
    },
    themeConfig()
  );
}

/**
 * Load and initialise the library, once per page.
 *
 * The promise is cached including its REJECTION: a bundle that is not there
 * (a half-deployed image, a stripped `app/vendor/`) must degrade every fence
 * to its source text rather than firing a 3 MB request per diagram per
 * repaint.
 */
function lib() {
  if (!libPromise) {
    libPromise = import("/vendor/mermaid.js").then((m) => {
      const mermaid = m.default;
      mermaid.initialize(config());
      return mermaid;
    });
  }
  return libPromise;
}

/* ---------- layer 2: our own sanitizer ----------

   A WHITELIST, and short on purpose. Everything mermaid legitimately emits for
   a diagram is geometry, text, and presentation; nothing it emits needs to
   navigate, fetch, or script. Anything outside the list is dropped rather than
   rewritten — there is no "clean it up and keep it" path, because that is
   where sanitizer bugs live.

   `DOMParser` is what makes this safe to do at all: it builds an inert
   document. Scripts in it do not run, `<img onerror>` does not fire, and
   external references are not fetched. The tree is only adopted into the live
   document AFTER the walk below has been through it. */
const ALLOWED_TAGS = new Set([
  "svg", "g", "defs", "style", "marker", "path", "line", "polyline", "polygon", "rect", "circle",
  "ellipse", "text", "tspan", "textpath", "title", "desc", "tref", "use", "symbol", "clippath",
  "lineargradient", "radialgradient", "stop", "pattern", "mask", "filter", "fegaussianblur",
  "fedropshadow", "feoffset", "feblend", "feflood", "fecomposite", "femerge", "femergenode", "switch",
]);

/* `style` is allowed because mermaid's palette rides on it and CSS in an SVG
   cannot execute script in any browser this app supports. `href`/`xlink:href`
   are NOT allowed at all — a diagram has nowhere legitimate to point. */
const ALLOWED_ATTR = /^(id|class|style|transform|d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|viewbox|points|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|stroke-opacity|stroke-miterlimit|opacity|font|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|alignment-baseline|baseline-shift|letter-spacing|word-spacing|marker-start|marker-mid|marker-end|orient|refx|refy|markerwidth|markerheight|markerunits|patternunits|patterncontentunits|gradientunits|gradienttransform|offset|stop-color|stop-opacity|spreadmethod|fx|fy|clip-path|clip-rule|clippathunits|mask|maskunits|maskcontentunits|filter|filterunits|primitiveunits|in|in2|result|stddeviation|dx|dy|flood-color|flood-opacity|preserveaspectratio|xmlns|version|role|aria-roledescription|aria-label|aria-labelledby|space)$/;

/**
 * The one place markup is allowed to carry a payload we cannot whitelist away:
 * the CSS inside mermaid's `<style>` block, which is where its palette lives
 * and therefore cannot simply be dropped.
 *
 * CSS cannot execute script in any browser this app supports, so the risk is
 * not XSS — it is EXFILTRATION. `@import url(https://…)` and `url(https://…)`
 * are both requests to somewhere else, and a request is enough to leak the
 * fact and shape of a doc. Off-origin references are cut; a `url(#gradient)`
 * fragment, which is how SVG actually refers to its own defs, is kept.
 */
function scrubCss(text) {
  return String(text)
    .replace(/@import[^;}]*;?/gi, "")
    /* A FUNCTION, not a cleverer pattern. Two attempts at doing this with a
       lookahead both got it wrong the same way: `['"]?` is optional, so the
       engine backtracks to matching zero characters and the `(?!#)` test then
       reads the QUOTE instead of the character after it — quietly turning
       `url("#arrowhead")` into `none` and erasing every marker and gradient
       mermaid refers to. Unwrapping the value first and asking one plain
       question about it has no such reading. */
    .replace(/url\(([^)]*)\)/gi, (whole, inner) => {
      const v = String(inner).trim().replace(/^['"]|['"]$/g, "").trim();
      return v.startsWith("#") ? whole : "none";
    });
}

/**
 * Turn mermaid's SVG string into a node tree that is safe to adopt.
 * Returns null when the string does not parse as SVG at all.
 */
function sanitizeSvg(svgText) {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = parsed.documentElement;
  /* a parse error comes back AS a document whose root is <parsererror> */
  if (!root || root.nodeName === "parsererror" || root.nodeName.toLowerCase() !== "svg") return null;

  const walk = (node) => {
    /* childNodes is live — iterate a copy, since the walk removes from it */
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove(); // comments, CDATA, processing instructions
        continue;
      }
      if (!ALLOWED_TAGS.has(child.nodeName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        /* localName, not name: `xlink:href` must not sneak through on the
           strength of its local part matching something benign */
        if (!ALLOWED_ATTR.test(attr.localName.toLowerCase())) child.removeAttributeNode(attr);
      }
      if (child.nodeName.toLowerCase() === "style") {
        child.textContent = scrubCss(child.textContent);
        continue; /* its children are text; the walk has nothing to do there */
      }
      walk(child);
    }
  };
  /* the root's own attributes get the same treatment as everyone else's */
  for (const attr of [...root.attributes]) {
    if (!ALLOWED_ATTR.test(attr.localName.toLowerCase())) root.removeAttributeNode(attr);
  }
  walk(root);
  return document.importNode(root, true);
}

/* ---------- rendering ---------- */

/**
 * Draw `src` into `block`, replacing whatever is there.
 *
 * Every failure path lands in the same place: the error line, plus the source
 * verbatim. A diagram that will not compile is the ordinary state of a diagram
 * being WRITTEN, so this is a normal view and not an exception — losing the
 * text the author is mid-way through would be the actual bug.
 */
async function paint(block, src) {
  const body = $(".mmd-body", block);
  if (!body) return;
  const fail = (msg) => {
    block.classList.add("bad");
    body.innerHTML = "";
    body.appendChild(el("div", "mmd-err", esc(msg)));
    const pre = el("pre", "mmd-src");
    pre.textContent = src;
    body.appendChild(pre);
  };
  let mermaid;
  try {
    mermaid = await lib();
  } catch (e) {
    return fail("The mermaid bundle could not be loaded — showing the source instead.");
  }
  /* the block may have been replaced by a repaint while the 3 MB import was in
     flight; drawing into a detached node would be invisible work */
  if (!block.isConnected) return;
  try {
    /* `bindFunctions` is the second return value and is deliberately dropped —
       see the header. Destructuring only `svg` is how that is enforced. */
    const { svg } = await mermaid.render("mmd-" + ++seq, src);
    if (!block.isConnected) return;
    const node = sanitizeSvg(svg);
    if (!node) return fail("The diagram rendered to something that is not SVG — refusing to show it.");
    block.classList.remove("bad");
    body.innerHTML = "";
    body.appendChild(node);
  } catch (err) {
    fail(String((err && (err.str || err.message)) || err || "This diagram could not be drawn."));
  }
}

/**
 * The preview node for one ```mermaid fence.
 *
 * Mounted EMPTY and filled asynchronously, because the library import is
 * async and the preview is built synchronously. The header bar is the code
 * block's bar (`codeEl` in markdown.js) so that a diagram reads as the same
 * kind of object a fence always was — with one extra control, Source, since
 * the one thing a rendered diagram cannot show you is what you typed.
 */
export function mermaidEl(src) {
  /* self-arming, so a vault with no diagrams never installs the observer and
     app.js needs no boot wiring for a feature most docs do not use */
  watchThemeForDiagrams();
  const w = el("div", "code mmd");
  const bar = el("div", "code-bar", '<span class="lang">mermaid</span>');

  const srcBtn = el("button", "btn sm", "Source");
  srcBtn.type = "button";
  srcBtn.style.marginLeft = "auto";
  srcBtn.setAttribute("aria-pressed", "false");
  srcBtn.addEventListener("click", () => {
    const showing = w.classList.toggle("show-src");
    srcBtn.setAttribute("aria-pressed", showing ? "true" : "false");
  });

  const copy = el("button", "btn sm", I.copy + " Copy");
  copy.addEventListener("click", () => copyText(src));

  bar.appendChild(srcBtn);
  bar.appendChild(copy);

  const body = el("div", "mmd-body");
  /* the source is always in the DOM, revealed by `.show-src` rather than built
     on demand — it is also what a text selection over the block should copy */
  const pre = el("pre", "mmd-text");
  pre.textContent = src;

  w.appendChild(bar);
  w.appendChild(body);
  w.appendChild(pre);
  SOURCE.set(w, src);
  paint(w, src);
  return w;
}

/* ---------- theme changes ----------

   A diagram bakes its palette into the SVG at render time, so a theme switch
   leaves every mounted one wearing the old colours. Nothing else in the
   preview has this problem, so nothing else has a hook for it — which is why
   the observer lives HERE rather than in settings.js: the module with the
   problem owns the fix, and settings.js does not learn about diagrams.

   Watching the attributes rather than subscribing to `applyTheme` also catches
   the paths that never go through the settings page at all: the `?theme=`
   override, the boot-time cached apply, and the OS flipping to dark under a
   `system` scheme. */
let observing = false;

function watchThemeForDiagrams() {
  if (observing) return;
  observing = true;
  let pending = 0;
  const obs = new MutationObserver(() => {
    /* the theme stylesheet is swapped by href and lands a frame or two later;
       redrawing before it does would read the OLD tokens back out */
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const blocks = [...document.querySelectorAll(".mmd")].filter((b) => SOURCE.has(b));
      if (!blocks.length) return;
      try {
        (await lib()).initialize(config());
      } catch (e) {
        return; /* no library, nothing drawn, nothing to redraw */
      }
      for (const b of blocks) paint(b, SOURCE.get(b));
    }, 60);
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-scheme"] });
}
