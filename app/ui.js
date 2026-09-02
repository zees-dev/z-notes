/* ============================================================
   ui.js — icons + tiny DOM/text helpers shared by every panel.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import { state } from "./state.js";

/* ============================================================
   ICONS
   ============================================================ */
export const I = {
  chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  /* a vault: the repo box, with the branch that makes it one */
  vault:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9h17"/><circle cx="9" cy="12.8" r="1.4"/><circle cx="15" cy="12.8" r="1.4"/><path d="M9 14.2v2.3M15 14.2a2.3 2.3 0 0 1-2.3 2.3H9"/></svg>',
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
  /* sync: the round trip, both arrows — this vault takes what upstream has and
     gives back what it has, and the glyph has to say both or it reads as push */
  sync: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/></svg>',
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
   TINY HELPERS
   ============================================================ */
export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
/** "low" → "Low" — the one label rule every enum control shares. */
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
/* quotes are escaped too: half the call sites interpolate into an attribute
   (data-link, title, …) and a doc is allowed to contain any byte at all */
export const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
export const dirname = (p) => (p.indexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/")));
/** A suffix belongs to the leaf, not to a dotted parent folder. */
export const hasFileExtension = (path) => {
  const leaf = String(path == null ? "" : path).split("/").pop();
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1;
};
/** Bare names are Markdown by default; an explicit extension is literal. */
export const withDefaultExtension = (path) => (hasFileExtension(path) ? path : path + ".md");

/* ---------- vault addressing ----------

   One grammar, restated client-side: a doc in a SECONDARY vault is `@<id>/<rel>`
   everywhere above the API — the tree, `state.docPaths`, `/d/` URLs, SSE frames
   — and the PRIMARY vault's docs are bare paths, exactly as they have always
   been. `@<id>` with no remainder is a vault's ROOT: the key the tree's slot map
   and the create/rename context use for "the root of that vault".

   These are the only place in the app that takes a prefix apart; nothing above
   them should do it by hand. */
const VAULT_AT = /^@([a-z0-9][a-z0-9-]*)(?:\/|$)/;

/** Which vault a qualified path belongs to. An unqualified path is the primary. */
export const vaultOf = (path) => {
  const m = VAULT_AT.exec(String(path == null ? "" : path));
  return m ? m[1] : "vault";
};

/** The vault-relative remainder — what the server's own stack sees. */
export const relOf = (path) => {
  const s = String(path == null ? "" : path);
  const m = VAULT_AT.exec(s);
  return m ? s.slice(m[0].length) : s;
};

/** What every path in that vault starts with: "" for the primary, "@id/" else. */
export const vaultPrefix = (id) => (!id || id === "vault" ? "" : "@" + id + "/");

/** A vault's root, as a PATH rather than a prefix: "" for the primary, "@id". */
export const vaultRootKey = (id) => (!id || id === "vault" ? "" : "@" + id);

/** The class a vault's status dot wears, from its last `sync-status`. One rule
    for the two surfaces that draw one — the tree row and the Settings block —
    which are painted from two different bodies and must not disagree. */
export const syncDotClass = (s) =>
  s && s.state === "synced" ? "sync-ok" : s && s.state === "syncing" ? "sync-busy" : "sync-warn";

/** Every vault's tree, in order — the client's whole doc world, which the
    neighbour walk and "the first doc" have to cross now that there is more
    than one of them. */
export const vaultTrees = () => state.vaults.map((v) => v.tree || []);

/** `types` is the half of a DataTransfer readable during a drag, while `files`
    fills in on `drop` alone. The tree accepts such a drag as an upload
    (ADR 0030); everywhere else swallows it. */
export const dragHasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

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
 * Deliberately NOT extended to "Reloaded from disk": that one is fixed as a
 * blip, and it describes something that already finished harmlessly.
 */
export function toast(msg, opts) {
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
export function clearStickyToast() {
  const t = $("#toast");
  if (!t || !t.classList.contains("sticky")) return;
  t.classList.remove("show", "sticky");
}

/** Put text on the system clipboard. The app's ONLY clipboard writer — the
    async API where it exists, the select-and-execCommand shim where it does
    not, and best-effort either way (a clipboard manager is outside this
    boundary; see secrets.js).

    `quiet` suppresses the confirmation toast, for the callers where the
    clipboard is not the point of the gesture: a whole-line ⌘X/⌘C in Raw is an
    EDIT, taken twenty times a minute, and a toast on each one would narrate
    the editing rather than confirm anything. The copy BUTTONS keep the toast —
    there the clipboard is the entire outcome, and nothing else on screen
    changes to show it happened. */
export function copyText(t, opts) {
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
  if (!(opts && opts.quiet)) toast("Copied to clipboard");
}

export function apiFail(err, what) {
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

/* ---------- [[link]] resolution ----------

   The client's rule is the SERVER's rule, restated: `[[slug]]` resolves by
   unique filename slug vault-wide, `[[path/slug]]` is the disambiguating form,
   and a slug carried by two docs resolves to NEITHER. Rendering an ambiguous
   link as if it pointed somewhere would be the one behaviour a file-backed
   vault must never have, so it is flagged exactly like a missing one.

   RESOLUTION NEVER CROSSES VAULTS. A vault's contents are portable — the same
   directory may be somebody else's primary vault — so a `[[slug]]` written in
   it can only mean a doc in it. The same slug in two vaults is two docs, not a
   collision, and neither is reachable from the other. */
export const normTarget = (t) =>
  String(t == null ? "" : t)
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

/** stand-in for a vault with no slugs yet, so the lookup below stays one
    expression rather than a null check */
const EMPTY_SLUGS = new Map();

/**
 * → { state: "ok" | "ambiguous" | "missing", path, candidates }
 *
 * `vaultId` is the vault of the doc being RENDERED — the one the link was
 * written in. It defaults to the active doc's vault, which is the right answer
 * for both surfaces that render `[[links]]`: the editor's own preview, and the
 * assistant's messages (which are about the doc you are looking at). Every
 * `path` that comes back is qualified, so `openDoc`, hrefs and `/d/` URLs take
 * it verbatim.
 */
export function lookupLink(target, vaultId) {
  const vault = vaultId || vaultOf(state.active || "");
  const raw = String(target == null ? "" : target).trim();
  const t = normTarget(target);
  if (!t) return { state: "missing", path: null, candidates: [] };
  const qualified = raw.startsWith("./") || raw.startsWith("/") || t.indexOf("/") >= 0;
  if (qualified) {
    const exact = vaultPrefix(vault) + t;
    const p = state.docPaths.has(exact)
      ? exact
      : hasFileExtension(t)
        ? null
        : vaultPrefix(vault) + t + ".md";
    return p && state.docPaths.has(p)
      ? { state: "ok", path: p, candidates: [p] }
      : { state: "missing", path: null, candidates: [] };
  }
  /* A bare `[[foo.md]]` keeps the original Markdown ergonomics; other explicit
     extensions are part of the slug (`[[foo.txt]]`). */
  const slug = t.replace(/\.md$/i, "");
  const hits = (state.slugs.get(vault) || EMPTY_SLUGS).get(slug) || [];
  if (hits.length === 1) return { state: "ok", path: hits[0], candidates: hits };
  if (hits.length > 1) return { state: "ambiguous", path: null, candidates: hits };
  return { state: "missing", path: null, candidates: [] };
}

/* inline markdown: `code`, **bold**, *em*, ~~strike~~, [[wikilink]] — used for
   docs AND for assistant messages, which arrive as markdown, never as HTML */
export function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (m, c) => '<code class="ic">' + c + "</code>");
  /* bold/em carry the same code-span alternation the wikilink pass below does,
     and for the same reason: `h` already contains the emitted <code> spans, so
     a bare .replace would render `**bold**` INSIDE backticks — text the fence
     promises stays literal. Skip the spans; style everything else. */
  const CODE_SPAN = /(<code class="ic">[\s\S]*?<\/code>)/;
  const combined = (pattern, outer, flags = "g") => {
    h = h.replace(new RegExp(CODE_SPAN.source + "|" + pattern, flags), (m, code, pre, body) => {
      if (code) return code;
      const inner = outer === "strong" ? "em" : "strong";
      return pre + "<" + outer + "><" + inner + ">" + body + "</" + inner + "></" + outer + ">";
    });
  };
  /* Strong + emphasis has several ordinary Markdown spellings. Handle the
     complete delimiter runs before either individual pass can consume their
     middle, and keep underscore runs out of identifiers (`some___name___`). */
  combined("(^|[^*])\\*\\*\\*(?=\\S)([^*\\n]*?\\S)\\*\\*\\*(?!\\*)", "em");
  combined("(^|[^\\p{L}\\p{N}_])___(?=\\S)([^_\\n]*?\\S)___(?![\\p{L}\\p{N}_])", "em", "gu");
  combined("(^|[^*])\\*\\*_(?=\\S)([^_\\n]*?\\S)_\\*\\*(?!\\*)", "strong");
  combined("(^|[^\\p{L}\\p{N}_])__\\*(?=\\S)([^*\\n]*?\\S)\\*__(?![\\p{L}\\p{N}_])", "strong", "gu");
  combined("(^|[^*])\\*__(?=\\S)([^_\\n]*?\\S)__\\*(?!\\*)", "em");
  combined("(^|[^\\p{L}\\p{N}_])_\\*\\*(?=\\S)([^*\\n]*?\\S)\\*\\*_(?![\\p{L}\\p{N}_])", "em", "gu");
  h = h.replace(new RegExp(CODE_SPAN.source + "|\\*\\*([^*]+)\\*\\*", "g"), (m, code, b) =>
    code ? code : "<strong>" + b + "</strong>"
  );
  /* `~` joins the opening boundary so strike may wrap emphasis symmetrically:
     `~~*em*~~` must compose just as `*~~strike~~*` does. */
  h = h.replace(new RegExp(CODE_SPAN.source + "|(^|[\\s(~])\\*([^*\\n]+)\\*", "g"), (m, code, pre, e) =>
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
  /* ---------- external links (ADR 0016) ----------
     Three spellings, three passes, one order: `[text](url)`, then `<url>`,
     then the bare URL — each later pass must not re-link what an earlier one
     already emitted, so all three carry the code spans AND the anchors already
     in `h` (wikilink pills included) in their alternation. `h` is escaped, so
     quotes cannot break out of href; the one attack that survives escaping is
     the scheme itself, which is why only http(s) and mailto ever become an
     anchor — a `javascript:` link stays the literal text the author typed. */
  const EMITTED = '(<code class="ic">[\\s\\S]*?<\\/code>|<a [^>]*>[\\s\\S]*?<\\/a>)';
  h = h.replace(
    new RegExp(EMITTED + "|(!?)\\[([^\\]\\n]+)\\]\\(((?:\\([^()\\s]*\\)|[^()\\s])+)\\)", "g"),
    /* `!` is image syntax this renderer does not speak — the whole spelling
       stays literal rather than half-rendering as "!" + a link */
    (m, done, bang, text, url) =>
      done ? done : !bang && /^(https?:\/\/|mailto:)/i.test(url) ? extLink(url, strikeInline(text)) : m
  );
  h = h.replace(new RegExp(EMITTED + "|&lt;(https?:\\/\\/[^\\s]+?)&gt;", "g"), (m, done, url) =>
    done ? done : extLink(url, url)
  );
  h = h.replace(new RegExp(EMITTED + "|(https?:\\/\\/[^\\s<]+)", "g"), (m, done, url) => {
    if (done) return done;
    const cut = trimUrlTail(url);
    return extLink(cut, cut) + url.slice(cut.length);
  });
  /* Strike runs after links so a delimiter-looking URL can never be rewritten
     before it reaches an href. Markdown-link LABELS are handled as they are
     emitted above; the final pass treats every complete code span and anchor as
     opaque. That preserves both useful compositions — `[~~label~~](url)` and
     `~~[label](url)~~` — without interpreting delimiter-looking text inside a
     bare URL, or letting a `~~` in an href/title mutate generated markup.

     `inline()` is called once per source line (markdown.js / ADR 0015), so the
     pattern cannot close a delimiter across lines. A space immediately inside
     either delimiter keeps the spelling literal, matching the delimiter rule
     rather than turning accidental prose tildes into markup. */
  return strikeInline(h);
}

function strikeInline(h) {
  const marker = "\uE000";
  /* Make the fixed token prefix impossible to forge from doc text in ONE pass:
     every literal marker becomes marker+L, while generated tokens are
     marker+digits+semicolon. The final replacement reverses this exactly. */
  const source = String(h).replaceAll(marker, marker + "L");
  return strikeProtected(source, marker).replaceAll(marker + "L", marker);
}

function strikeProtected(source, marker) {
  /* Delimiters OUTSIDE a protected node may legitimately wrap it, so merely
     skipping nodes as regex alternatives is not enough: the lazy strike match
     can start before one and close on `~~` inside its code text or href. Hold
     complete code/anchor nodes and emitted tags behind collision-free indexed
     tokens, match only the visible remainder, then restore them in one pass. */
  const held = [];
  const protectedNodes = /<code class="ic">[\s\S]*?<\/code>|<a [^>]*>[\s\S]*?<\/a>|<(strong|em)>([\s\S]*?)<\/\1>|<[^>]+>/g;
  let safe = source.replace(protectedNodes, (matched, format, body) => {
    /* Formatting nodes are boundaries AND containers: parse their visible
       body recursively before holding the complete node. This makes
       `**~~strike~~**` work, while an invalid crossing such as
       `~~**x~~ y**` cannot borrow its closing delimiter from inside <strong>
       and produce misnested DOM. */
    const node = format ? "<" + format + ">" + strikeProtected(body, marker) + "</" + format + ">" : matched;
    const index = held.push(node) - 1;
    return marker + index + ";";
  });
  safe = safe.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return safe.replace(new RegExp(marker + "(\\d+);", "g"), (token, index) => held[Number(index)] ?? token);
}

const extLink = (href, label) =>
  '<a class="xl" href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";

/* A bare URL in prose drags its sentence along: "see https://x.dev/a)." has
   matched up to the dot. Trailing punctuation is peeled off — entities first,
   since the text is escaped and a quote arrives five characters wide — and a
   `)` only when the URL does not own it (a Wikipedia "…_(disambiguation)" keeps
   its close-paren because the URL also carries the open). */
function trimUrlTail(u) {
  for (;;) {
    const ent = /&(amp|lt|gt|quot|#39);$/.exec(u);
    if (ent) {
      u = u.slice(0, -ent[0].length);
      continue;
    }
    const c = u[u.length - 1];
    if (".,;:!?".indexOf(c) >= 0 || c === "]") {
      u = u.slice(0, -1);
      continue;
    }
    if (c === ")" && u.split("(").length < u.split(")").length) {
      u = u.slice(0, -1);
      continue;
    }
    return u;
  }
}

/* toy js/ts highlighter for fenced js|ts blocks — pattern-based only, so it
   knows nothing about any particular document's contents */
/* One pass, one regex: successive .replace() calls would re-scan the markup
   they just emitted (a `class` keyword inside class="tk-str" and so on). */
const HL_RE = /("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)|(\/\/[^\n]*)|\b(const|let|var|function|return|await|async|import|export|from|new|class|extends|type|interface|enum|if|else|for|while|try|catch|throw|typeof|instanceof|null|undefined|true|false)\b|\b([A-Z][A-Za-z0-9_$]*)(?=[.(])|\b(\d+(?:\.\d+)?[a-z]*)\b/g;

export function hl(src) {
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

export const activeDoc = () => state.docs.get(state.active);

export function countWords(md) {
  return String(md || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#>*`|[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}
