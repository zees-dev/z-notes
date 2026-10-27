/* ============================================================
   search-match.ts — shared search matching and age-fence redaction.

   Bundled into the browser: never import or use Bun or node APIs here.
   Callers redact and trim lines before matching; the server owns its line
   cache, whole-document reject and deadline.
   ============================================================ */

const REGEX_LINE_MAX = 2000;
/** two caps on one line's highlighting: how many matches are walked, and how
    many characters they may light up between them. `/./` over prose reaches
    both, and neither changes WHICH lines are hits — only how much of one is
    painted. */
const REGEX_MATCH_MAX = 64;
const REGEX_IDX_MAX = 240;
const REGEX_BASE = 30;

export function fuzzy(q: string, hay: string): { score: number; idx: number[] } | null {
  return fuzzyOn(q.toLowerCase(), hay.toLowerCase());
}

/**
 * The scorer proper, over an ALREADY-LOWERCASED needle and haystack.
 *
 * Split out because `fuzzy` lowercased its haystack on every call, and the
 * search below calls it once per line of every document in the vault on every
 * keystroke — so the whole vault was being re-lowercased, and re-allocated,
 * between one letter and the next. The caller now lowercases each body once and
 * keeps it (see `lines`).
 */
export function fuzzyOn(n: string, h: string): { score: number; idx: number[] } | null {
  if (!n) return { score: 0, idx: [] };
  const idx: number[] = [];
  let from = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    if (c === " ") {
      prev = -2;
      continue;
    }
    const at = h.indexOf(c, from);
    if (at < 0) return null;
    idx.push(at);
    if (at === prev + 1) score += 7;
    else score += 1;
    if (at === 0 || /[\s/\-_.,:|[\]()]/.test(h.charAt(at - 1))) score += 5;
    prev = at;
    from = at + 1;
  }
  if (h.indexOf(n.replace(/\s+/g, "")) >= 0) score += 22;
  /* an all-whitespace needle matches everything and indexes nothing, so there
     is no first offset to discount — `idx[0]` there made every score NaN, and
     NaN sorts nowhere */
  score -= (idx.length ? idx[0] : 0) * 0.08;
  score -= Math.max(0, h.length - 60) * 0.01;
  return { score, idx };
}

/* ---------- regex queries ----------

   A regex is written `/pattern/flags`, so it survives a URL, a bookmark and a
   curl without a second parameter to say what it is — and the palette's toggle
   is then a READING of the query as much as a control over it. `mode=regex`
   forces the reading for a pattern the user would rather not wrap.

   `g` and `y` are stripped: iteration is this file's job, and a caller-supplied
   `lastIndex` is a foot-gun in a matcher that runs over every line in a vault. */
const SLASHED = /^\/(.*)\/([a-z]*)$/s;
const FLAGS_OK = /^[imsu]*$/;

export type SearchMode = "fuzzy" | "regex";

export interface SearchQuery {
  mode: SearchMode;
  /** the pattern or the fuzzy needle — what the user meant, minus delimiters */
  term: string;
  /** non-global, for `test`; null when the pattern will not compile */
  probe: RegExp | null;
  /** the same pattern with `g`, for walking every match on a line */
  all: RegExp | null;
  /** why the pattern was refused, for the palette to say out loud */
  invalid: string | null;
}

export function parseSearch(q: string, forced?: string | null): SearchQuery {
  /* The slash form only claims a query whose tail is REAL flags. `/etc/hosts`
     and `/usr/bin` are paths people search for, not patterns with a flag set
     called "hosts" — reading them as regex made ordinary text unsearchable and
     answered with a complaint about a flag the user never typed. */
  const m = SLASHED.exec(q);
  const slashed = !!m && FLAGS_OK.test(m[2].replace(/[gy]/g, ""));
  /* `mode=fuzzy` is the other way out: it takes a query at its word even when
     it is shaped like a pattern, which is what the palette's fuzzy chip sends
     so that clicking it never has to rewrite what you typed. */
  if (forced === "fuzzy" || (forced !== "regex" && !slashed)) {
    return { mode: "fuzzy", term: q, probe: null, all: null, invalid: null };
  }
  const src = slashed ? m![1] : q;
  const flags = slashed ? m![2].replace(/[gy]/g, "") : "";
  if (!src) return { mode: "regex", term: "", probe: null, all: null, invalid: null };
  try {
    /* `m` ALWAYS: this searches a vault line by line, so `^` and `$` mean the
       ends of a line — which is both what a person means by them here and what
       makes the whole-body pre-check below agree with the per-line pass. Without
       it `/^WARN/` pre-rejected every document whose FIRST line was not WARN,
       and found nothing anywhere. */
    return {
      mode: "regex",
      term: src,
      probe: new RegExp(src, flags.includes("m") ? flags : flags + "m"),
      all: new RegExp(src, (flags.includes("m") ? flags : flags + "m") + "g"),
      invalid: null,
    };
  } catch (err) {
    /* a half-typed pattern is the NORMAL state of a box being typed into, so
       this is a result the palette can render, never an error it must toast */
    return { mode: "regex", term: src, probe: null, all: null, invalid: cleanRegexError(err) };
  }
}

function cleanRegexError(err: unknown): string {
  const raw = String((err as Error)?.message || err);
  return raw.replace(/^Invalid regular expression:?\s*/i, "").replace(/^\/.*\/[a-z]*:\s*/, "") || "invalid pattern";
}

/** Every match on one line, as the character offsets the clients highlight —
    capped, because `.` over a long line is a legal thing to ask for and a
    highlight per character is not worth serialising. */
function regexIdx(re: RegExp, text: string): number[] | null {
  re.lastIndex = 0;
  const idx: number[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < REGEX_MATCH_MAX) {
    for (let i = m.index; i < m.index + m[0].length && idx.length < REGEX_IDX_MAX; i++) idx.push(i);
    /* a zero-length match (`x*`, a lone anchor) never advances lastIndex */
    if (m[0].length === 0) re.lastIndex++;
    if (idx.length >= REGEX_IDX_MAX) break;
  }
  return idx.length ? idx : null;
}

/** A regex hit has no subsequence score to earn, so rank by where and how much
    it matched: earlier and denser first, long lines discounted the same way
    `fuzzyOn` discounts them, so the two modes sort alike. */
function regexScore(idx: number[], text: string): number {
  return REGEX_BASE + Math.min(idx.length, 24) * 0.5 - idx[0] * 0.08 - Math.max(0, text.length - 60) * 0.01;
}

/** A path hit and the top two line hits, using already-trimmed, redacted lines. */
export function matchDoc(path: string, trimmedLines: string[], lowLines: string[], sq: SearchQuery): SearchHit[] {
  const name = path.split("/").pop()!;
  if (!sq.term) return [{ kind: "doc", path, name, text: path, matches: [], score: 0 }];
  if (sq.mode === "regex" && !sq.all) return [];
  const out: SearchHit[] = [];
  const needle = sq.mode === "fuzzy" ? sq.term.toLowerCase() : "";
  if (sq.mode === "regex") {
    const pm = regexIdx(sq.all!, path);
    if (pm) out.push({ kind: "doc", path, name, text: path, matches: pm, score: 12 + REGEX_BASE });
  } else {
    const nm = fuzzyOn(needle, path.toLowerCase());
    if (nm) out.push({ kind: "doc", path, name, text: path, matches: nm.idx, score: nm.score + 12 });
  }
  const hits: SearchHit[] = [];
  for (let i = 0; i < trimmedLines.length; i++) {
    const text = trimmedLines[i];
    if (!text || text.length < 2) continue;
    if (sq.mode === "regex") {
      const r = regexIdx(sq.all!, text.length > REGEX_LINE_MAX ? text.slice(0, REGEX_LINE_MAX) : text);
      if (r) hits.push({ kind: "line", path, name, line: i, text, matches: r, score: regexScore(r, text) });
    } else {
      const r = fuzzyOn(needle, lowLines[i]);
      if (r) hits.push({ kind: "line", path, name, line: i, text, matches: r.idx, score: r.score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return out.concat(hits.slice(0, 2));
}

export interface SearchHit {
  kind: "doc" | "line";
  path: string;
  name: string;
  line?: number;
  text: string;
  matches: number[];
  score: number;
}

/* Both fence probes tolerate leading whitespace (the OPEN probe blockquote
   markers too — see the close probe for why it must NOT) and a trailing CR,
   because the lines they are fed come from a plain split("\n") over
   byte-faithful text that may be CRLF.
   hasSecrets() and redact() MUST agree by construction: a fence one of them
   cannot see is either armor leaking into the index or the whole tail of the
   file being blanked.

   The prefix class is `[\s>]`, not `[ \t>]`, because the RENDERER's is `\s`
   (app/app.js RE_FENCE = /^\s*```/) and `\s` is much wider: U+00A0, U+000C,
   U+3000 and a leading BOM all open a secret block in the browser. A server
   probe NARROWER than the client's means the client paints "encrypted" over a
   fence whose armor `redact()` never blanked — straight into sqlite, FTS5 and
   /api/search. Being wider is safe (it only over-redacts); being narrower is
   the leak.

   The gap AFTER the ticks is the same story and was the same bug: the renderer
   reads the info string as `line.replace(/^\s*```/, "").trim()` and compares it
   to "age", so ``` ``` age ``` (any whitespace between ticks and word) paints a
   locked secret block. A regex demanding `age` abut the ticks never saw it. So
   the opener is PARSED, not pattern-matched: strip the fence, trim, and accept
   anything whose first word is `age` — case-insensitively, and even with a
   trailing info string (``` ```age js ```), both of which the renderer treats as
   ordinary code. Wider in those two directions is deliberate. */
const FENCE_PREFIX = /^[\s>]*```/;
/* The CLOSE probe is the mirror image and the direction is INVERTED: a close
   the server honours but the renderer does not ENDS the redacted region early,
   while the browser keeps painting "encrypted" over the lines that follow —
   straight into sqlite, FTS5 and /api/search. So a close may never be WIDER
   than the renderer's, and `>` is not in `\s`: a `> ``` ` line inside an
   ordinary ```age fence used to close the server's region while app.js read
   right past it into the same secret block.

   But a fence whose OPENER is blockquoted is one the renderer never opened at
   all — it exists only because the server's opener is deliberately wider — and
   its close is blockquoted too. Refusing `>` there would blank the rest of the
   file for no gain, so the close probe is chosen by the opener: renderer-
   visible fences get renderer parity, server-only fences keep the wide close.
   An unterminated fence still runs to EOF, which is what app.js does too. */
const RENDERER_FENCE = /^\s*```/; // app/app.js RE_FENCE, verbatim
const FENCE_CLOSE = /^\s*```[ \t]*\r?$/;
const FENCE_CLOSE_QUOTED = /^[\s>]*```[ \t]*\r?$/;

/** Does `line` end a fence that was opened by `openLine`? */
export function closesFence(line: string, openLine: string): boolean {
  return (RENDERER_FENCE.test(openLine) ? FENCE_CLOSE : FENCE_CLOSE_QUOTED).test(line);
}

/** True for every line the RENDERER would open a secret block on — and more. */
export function isAgeOpen(line: string): boolean {
  const m = FENCE_PREFIX.exec(line);
  if (!m) return false;
  return /^age\b/i.test(line.slice(m[0].length).trim());
}

/**
 * Blank out the *bodies* of ```age fences, keeping the line count identical so
 * search line numbers still address the real file. The armor (and therefore the
 * `BEGIN AGE ENCRYPTED FILE` canary) never reaches sqlite, FTS or search output.
 */
export function redact(markdown: string): string {
  const lines = String(markdown).split("\n");
  let openLine: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (openLine === null) {
      if (isAgeOpen(lines[i])) openLine = lines[i];
      continue;
    }
    if (closesFence(lines[i], openLine)) {
      openLine = null;
      continue;
    }
    lines[i] = "";
  }
  return lines.join("\n");
}
