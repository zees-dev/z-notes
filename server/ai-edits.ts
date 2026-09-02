/* ============================================================
   ai-edits.ts — the pure edit engine under the AI relay.

   Everything here operates on strings and plain objects: no deps bag, no
   sqlite, no fetch, no disk. ai.ts owns the ORCHESTRATION — reading current
   doc bytes from the vault, occupancy/parent checks for `create`, the armor
   guard, retry plumbing — and calls down into this module for the parts that
   are a function of (text, edit):

     - parseEdits()      — a propose_edits payload → a validated EditSpec list
     - applyEditToText() — one EditSpec against current bytes → the post-image
     - buildDiff()       — pre/post images → the unified diff the UI renders

   The anchor machinery (research §4.4 step 3) is the load-bearing core:
   three widening passes, unique-match enforcement, and EOL re-encoding so a
   pass-2 match can never splice bare LFs into a CRLF file. Its behavior is
   contract-tested end-to-end (tests/ai.test.ts, tests/ai-e2e.test.ts).
   ============================================================ */

import { intersectsAgeFence, safePath } from "./vault.ts";

/**
 * The ops are exactly four: no `delete_doc`, no rename. The rest of
 * the propose_edits schema (ai.ts) is research §4.4 verbatim.
 */
export const OPS = new Set(["replace", "insert_after", "create", "rewrite"]);

const MAX_DIFF_LINES = 300;

/* ============================================================
   Proposal shapes
   ============================================================ */

/** The UI-facing edit list — ALSO the re-apply spec used by accept. */
export interface EditSpec {
  op: "replace" | "insert_after" | "create" | "rewrite";
  path: string;
  /** the `find` anchor; null for create/rewrite */
  anchor: string | null;
  /** the replacement / inserted / new body text */
  text: string;
  note: string | null;
}

export interface FileImage {
  path: string;
  pre: string;
  post: string;
  /** false ⇒ the proposal CREATED this doc; reverting removes it again */
  existed: boolean;
}

export interface Rejection {
  status: "rejected";
  reason: string;
  path?: string;
  occurrences?: number;
  message: string;
}

export interface ApplyOk {
  ok: true;
  files: FileImage[];
}
export interface ApplyFail {
  ok: false;
  fail: Rejection;
}

/* ============================================================
   Anchor matching (research §4.4 step 3)

   Three passes, widening: exact → line endings normalized → per-line TRAILING
   whitespace normalized. Leading indentation is NEVER normalized: it is
   semantic in markdown (list nesting, fenced-code indentation), and a fuzzy
   match that lands on a line with different indentation than the model saw is
   how you silently corrupt a document.

   Every pass reports matches in ORIGINAL coordinates, via an index map built
   alongside the normalized string.
   ============================================================ */

interface Normalized {
  text: string;
  /** map[i] = offset in the original of normalized char i; map[len] = orig len */
  map: number[];
}

function normalizeEol(src: string): Normalized {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\r" && src[i + 1] === "\n") {
      map.push(i);
      text += "\n";
      i++;
      continue;
    }
    map.push(i);
    text += src[i];
  }
  map.push(src.length);
  return { text, map };
}

function normalizeTrailingWs(src: string): Normalized {
  const eol = normalizeEol(src);
  let text = "";
  const map: number[] = [];
  const s = eol.text;
  let run = 0; // pending trailing-whitespace run, not yet emitted
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " " || c === "\t") {
      run++;
      continue;
    }
    if (c === "\n") {
      run = 0; // the run was trailing: drop it
      map.push(eol.map[i]);
      text += "\n";
      continue;
    }
    // the run was interior whitespace after all — emit it
    for (let k = run; k > 0; k--) {
      map.push(eol.map[i - k]);
      text += s[i - k];
    }
    run = 0;
    map.push(eol.map[i]);
    text += c;
  }
  map.push(src.length);
  return { text, map };
}

const needleEol = (s: string) => s.replace(/\r\n/g, "\n");
const needleTrailingWs = (s: string) => needleEol(s).replace(/[ \t]+(?=\n)/g, "").replace(/[ \t]+$/, "");

interface AnchorMatch {
  start: number;
  end: number;
  pass: 1 | 2 | 3;
}

/**
 * All occurrences of `needle` in `hay`, in original coordinates, using the
 * first pass that finds any. Overlapping occurrences are counted separately —
 * ambiguity detection must be pessimistic.
 */
function findAnchor(hay: string, needle: string): { matches: AnchorMatch[]; pass: 1 | 2 | 3 } {
  if (!needle) return { matches: [], pass: 1 };

  const scan = (h: string, n: string): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    if (!n) return out;
    let from = 0;
    for (;;) {
      const at = h.indexOf(n, from);
      if (at < 0) break;
      out.push([at, at + n.length]);
      from = at + 1; // overlapping: two near-identical anchors must read as 2
      if (out.length > 8) break;
    }
    return out;
  };

  const exact = scan(hay, needle);
  if (exact.length) return { matches: exact.map(([s, e]) => ({ start: s, end: e, pass: 1 as const })), pass: 1 };

  const p2 = normalizeEol(hay);
  const m2 = scan(p2.text, needleEol(needle));
  if (m2.length) {
    return { matches: m2.map(([s, e]) => ({ start: p2.map[s], end: p2.map[e], pass: 2 as const })), pass: 2 };
  }

  const p3 = normalizeTrailingWs(hay);
  const m3 = scan(p3.text, needleTrailingWs(needle));
  if (m3.length) {
    return { matches: m3.map(([s, e]) => ({ start: p3.map[s], end: p3.map[e], pass: 3 as const })), pass: 3 };
  }
  return { matches: [], pass: 3 };
}

/** Which line ending dominates `sample`, falling back to `doc`, else LF. */
function dominantEol(sample: string, doc: string): "\r\n" | "\n" {
  const pick = (s: string): "\r\n" | "\n" | null => {
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length - crlf;
    if (!crlf && !lf) return null;
    return crlf > lf ? "\r\n" : "\n";
  };
  return pick(sample) ?? pick(doc) ?? "\n";
}

/** Re-encode `s` to `eol`. LF is the identity case — CR is only ever added. */
const toEol = (s: string, eol: "\r\n" | "\n") =>
  eol === "\r\n" ? s.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : s;

/* ============================================================
   propose_edits validation (research §4.4, parse phase)
   ============================================================ */

/**
 * Parse and normalize the tool arguments into an EditSpec list. `inVault` is
 * the one impure question — "does this path resolve inside the vault?" —
 * injected by ai.ts (vault.abs) so the parser itself stays a pure function.
 */
export function parseEdits(
  argsJson: string,
  inVault: (path: string) => boolean
): { ok: true; summary: string; edits: EditSpec[] } | ApplyFail {
  let parsed: any;
  try {
    parsed = JSON.parse(argsJson);
  } catch (err) {
    return {
      ok: false,
      fail: {
        status: "rejected",
        reason: "bad_json",
        message: `the tool arguments were not valid JSON: ${String((err as Error)?.message || err)}`,
      },
    };
  }
  const list = Array.isArray(parsed?.edits) ? parsed.edits : null;
  if (!list || !list.length) {
    return {
      ok: false,
      fail: { status: "rejected", reason: "no_edits", message: "the call carried no edits" },
    };
  }
  const edits: EditSpec[] = [];
  for (const e of list) {
    const op = String(e?.op || "");
    if (!OPS.has(op)) {
      return {
        ok: false,
        fail: {
          status: "rejected",
          reason: "bad_op",
          message: `op must be one of ${[...OPS].join(", ")} (got ${JSON.stringify(e?.op)}); this vault does not allow deleting or renaming docs`,
        },
      };
    }
    const raw = typeof e?.path === "string" ? e.path : "";
    /* safePath verbatim — no leniency, no leading-slash strip. Quietly
       rewriting `/tmp/x.md` into the vault-relative `tmp/x.md` would answer a
       request to write outside the vault by writing SOMEWHERE ELSE instead of
       refusing, and the model would never learn its path was wrong. */
    const path = safePath(raw);
    if (!path || !/\.md$/i.test(path) || !inVault(path)) {
      return {
        ok: false,
        fail: {
          status: "rejected",
          reason: "path_denied",
          path: raw,
          message: `${JSON.stringify(raw)} is not a vault-relative .md path inside the vault`,
        },
      };
    }
    const anchor = typeof e?.find === "string" ? e.find : null;
    const text =
      op === "replace"
        ? typeof e?.replace === "string"
          ? e.replace
          : null
        : typeof e?.content === "string"
          ? e.content
          : null;
    if ((op === "replace" || op === "insert_after") && !anchor) {
      return {
        ok: false,
        fail: { status: "rejected", reason: "missing_find", path, message: `${op} needs a non-empty "find" anchor` },
      };
    }
    if (text == null) {
      return {
        ok: false,
        fail: {
          status: "rejected",
          reason: "missing_text",
          path,
          message: op === "replace" ? '"replace" must be a string' : '"content" must be a string',
        },
      };
    }
    edits.push({ op: op as EditSpec["op"], path, anchor, text, note: typeof e?.note === "string" ? e.note : null });
  }
  return { ok: true, summary: String(parsed?.summary || "").trim() || "Proposed edit", edits };
}

/* ============================================================
   Applying one edit to current bytes (research §4.4 steps 3–5)
   ============================================================ */

/**
 * One EditSpec against the text it targets → the post-image, or the rejection
 * the model gets back as a tool result. `cur` is whatever ai.ts's
 * orchestration is holding for the path: on-disk bytes, or the post-image of
 * an earlier edit in the same proposal ("" for a fresh create).
 */
export function applyEditToText(cur: string, e: EditSpec): { ok: true; post: string } | ApplyFail {
  const reject = (r: Rejection): ApplyFail => ({ ok: false, fail: r });

  if (e.op === "create") {
    return { ok: true, post: e.text };
  }
  if (e.op === "rewrite") {
    // a rewrite spans the whole document, so ANY age fence in it is an
    // intersection: the model saw a placeholder and would write it back
    if (intersectsAgeFence(cur, 0, cur.length)) {
      return reject({
        status: "rejected",
        reason: "secret_intersect",
        path: e.path,
        message: `${e.path} contains an encrypted block, so it cannot be rewritten wholesale — use replace on the parts you mean to change`,
      });
    }
    return { ok: true, post: e.text };
  }

  // 3+4. anchored ops: exactly one match, three-pass
  const { matches, pass } = findAnchor(cur, e.anchor!);
  if (!matches.length) {
    return reject({
      status: "rejected",
      reason: "not_found",
      path: e.path,
      occurrences: 0,
      message: `the "find" text does not appear in ${e.path}; copy it byte-for-byte from the document`,
    });
  }
  if (matches.length > 1) {
    return reject({
      status: "rejected",
      reason: "ambiguous",
      path: e.path,
      occurrences: matches.length,
      message: `the "find" text appears ${matches.length} times in ${e.path}; include more surrounding lines so it is unique`,
    });
  }
  const m = matches[0];
  // 5. secret guard
  const span = e.op === "replace" ? [m.start, m.end] : [m.end, m.end];
  if (intersectsAgeFence(cur, span[0], span[1])) {
    return reject({
      status: "rejected",
      reason: "secret_intersect",
      path: e.path,
      message: `that span touches an encrypted block in ${e.path}; encrypted blocks cannot be edited by the assistant`,
    });
  }
  /* Pass 2 matched an LF-only needle against CRLF bytes and returns the
     span in ORIGINAL coordinates — so the span swallows the \r\n while the
     model's text is LF-only, and splicing it verbatim left bare LFs inside
     an otherwise-CRLF file. Writes are byte-faithful, and the relay's own
     instruction ("preserve the file's existing line endings") both say no:
     the server's tolerance must not defeat the rule it ships. Re-encode to
     whatever the matched span (else the document) actually uses. */
  const text = pass >= 2 ? toEol(e.text, dominantEol(cur.slice(m.start, m.end), cur)) : e.text;
  return {
    ok: true,
    post: e.op === "replace" ? cur.slice(0, m.start) + text + cur.slice(m.end) : cur.slice(0, m.end) + text + cur.slice(m.end),
  };
}

/* ============================================================
   Unified diff — the `diff` array on a proposal object
   ============================================================ */

/**
 * A line KEEPS its newline, so a proposal whose only change is the file's final
 * newline renders `-c` / `+c` instead of an empty card. `bare()` takes the
 * terminator back off where the row text is built.
 */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  const last = parts.pop()!; // "" exactly when the text ended in a newline
  const lines = parts.map((l) => l + "\n");
  if (last !== "") lines.push(last);
  return lines;
}

/** one stretch of the edit script: kind −1 gone from `pre`, +1 new in `post`, 0 common to both */
interface Run {
  kind: -1 | 0 | 1;
  count: number;
}

/**
 * Myers' O(N·D) line diff in its linear-space form (his §4b): find the middle
 * snake of an optimal path by running the greedy search from both ends until
 * they meet, then recurse on the two halves. The textbook forward-with-trace
 * form keeps every V array it wrote, which is O(D²) memory: on 20k unrelated
 * lines a side it reaches 1.5GB inside the 1s budget, twice what the pod may
 * have (768Mi, deploy/k3s/20-deployment.yaml). This form carries two V arrays
 * and nothing else. Null once `deadline`, a `performance.now()` reading, has
 * passed.
 */
function editRuns(a: string[], b: string[], deadline: number): Run[] | null {
  const runs: Run[] = [];
  const push = (kind: -1 | 0 | 1, count: number) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };

  /* one pair of V arrays for the whole recursion: `off` is diagonal 0, and no
     sub-problem reaches further out than half its own size */
  const off = a.length + b.length + 1;
  const vf = new Int32Array(2 * off + 1);
  const vr = new Int32Array(2 * off + 1);
  let expired = false;

  /** the middle snake as [x, y, u, v]: its start and end, relative to (a0, b0) */
  const middle = (a0: number, n: number, b0: number, m: number): [number, number, number, number] => {
    const delta = n - m;
    const odd = (delta & 1) !== 0;
    vf[off + 1] = 0;
    vr[off + 1] = 0;
    const half = Math.ceil((n + m) / 2);
    for (let d = 0; d <= half; d++) {
      if (performance.now() > deadline) break;
      for (let k = -d; k <= d; k += 2) {
        /* the greedy step: extend the further-along neighbouring diagonal */
        let x = k === -d || (k !== d && vf[off + k - 1]! < vf[off + k + 1]!) ? vf[off + k + 1]! : vf[off + k - 1]! + 1;
        let y = x - k;
        const sx = x;
        const sy = y;
        while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
          x++;
          y++;
        }
        vf[off + k] = x;
        /* the reverse search is one step behind, so only diagonals it has
           already reached can be met on an odd delta */
        if (odd && delta - k >= 1 - d && delta - k <= d - 1 && x + vr[off + delta - k]! >= n) return [sx, sy, x, y];
      }
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && vr[off + k - 1]! < vr[off + k + 1]!) ? vr[off + k + 1]! : vr[off + k - 1]! + 1;
        let y = x - k;
        const sx = x;
        const sy = y;
        while (x < n && y < m && a[a0 + n - x - 1] === b[b0 + m - y - 1]) {
          x++;
          y++;
        }
        vr[off + k] = x;
        if (!odd && delta - k >= -d && delta - k <= d && x + vf[off + delta - k]! >= n) return [n - x, m - y, n - sx, m - sy];
      }
    }
    /* the two searches provably meet within `half` steps, so the loop only
       falls out of the bottom when the deadline broke it */
    expired = true;
    return [0, 0, 0, 0];
  };

  const walk = (a0: number, n: number, b0: number, m: number): void => {
    /* the shared head and tail are free, and shedding them is what keeps the
       ordinary edit, a handful of lines inside a long note, linear */
    let head = 0;
    while (head < n && head < m && a[a0 + head] === b[b0 + head]) head++;
    push(0, head);
    a0 += head;
    b0 += head;
    n -= head;
    m -= head;
    let tail = 0;
    while (tail < n && tail < m && a[a0 + n - tail - 1] === b[b0 + m - tail - 1]) tail++;
    n -= tail;
    m -= tail;
    /* with head and tail gone the two sides share neither first nor last line,
       so what is left is either one-sided or at least two edits deep, which is
       what makes both halves of the split strictly smaller than this call */
    if (n === 0 || m === 0) {
      push(-1, n);
      push(1, m);
    } else {
      const [x, y, u, v] = middle(a0, n, b0, m);
      if (expired) return;
      walk(a0, x, b0, y);
      if (expired) return;
      push(0, u - x);
      walk(a0 + u, n - u, b0 + v, m - v);
      if (expired) return;
    }
    push(0, tail);
  };

  walk(0, a.length, 0, b.length);
  return expired ? null : runs;
}

/** Line-level Myers diff → hunks of rows (`"+text"`, `"-text"`, `" text"`), or null past the deadline. */
function lineHunks(pre: string, post: string, context: number, deadlineMs: number): string[][] | null {
  const a = splitLines(pre);
  const b = splitLines(post);
  const runs = editRuns(a, b, performance.now() + deadlineMs);
  if (!runs) return null;

  /* a row is DISPLAY text, so the terminator that made the comparison honest
     comes off, the same way buildDiff drops the CR */
  const bare = (l: string) => (l.endsWith("\n") ? l.slice(0, -1) : l);

  const hunks: string[][] = [];
  let rows: string[] | null = null; // the open hunk
  let lead: string[] = []; // the tail of the last common stretch, context for the next one
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < runs.length; ) {
    const run = runs[i]!;
    if (run.kind === 0) {
      const common = a.slice(ai, ai + run.count);
      ai += run.count;
      bi += run.count;
      i++;
      if (rows) {
        /* a gap two contexts wide or less would print as context twice over,
           so it stays inside the hunk; a wider one, or the end, closes it */
        if (common.length <= context * 2 && i < runs.length) {
          for (const l of common) rows.push(" " + bare(l));
        } else {
          for (const l of common.slice(0, context)) rows.push(" " + bare(l));
          hunks.push(rows);
          rows = null;
        }
      }
      lead = common.slice(common.length - context);
      continue;
    }
    /* one change region, however the path threaded it: every line it drops,
       then every line it adds, the order a unified diff reads in */
    const gone: string[] = [];
    const fresh: string[] = [];
    for (; i < runs.length && runs[i]!.kind !== 0; i++) {
      const r = runs[i]!;
      if (r.kind === -1) {
        for (const l of a.slice(ai, ai + r.count)) gone.push(l);
        ai += r.count;
      } else {
        for (const l of b.slice(bi, bi + r.count)) fresh.push(l);
        bi += r.count;
      }
    }
    if (!rows) rows = lead.map((l) => " " + bare(l));
    for (const l of gone) rows.push("-" + bare(l));
    for (const l of fresh) rows.push("+" + bare(l));
  }
  if (rows) hunks.push(rows);
  return hunks;
}

export function buildDiff(files: FileImage[]): { diff: Array<{ marker: string; text: string }>; added: number; removed: number } {
  const diff: Array<{ marker: string; text: string }> = [];
  let added = 0;
  let removed = 0;
  /* EVERY row goes through here: per-file headers and the un-renderable-diff
     note are rows too, so an ungated one grows a truncated multi-file diff by
     one row per remaining file. `added`/`removed` stay whole-proposal totals
     and are counted outside the cap. */
  const push = (marker: string, text: string) => {
    if (diff.length < MAX_DIFF_LINES) diff.push({ marker, text });
  };
  for (const f of files) {
    if (files.length > 1) push(" ", `— ${f.path} —`);
    /* THE DEADLINE IS LOAD-BEARING. Myers is O(N·D), and its worst case here
       is an ordinary request: a `rewrite` of a long note, whose two sides
       share almost no lines. Measured, unbounded: 10k lines/side = 0.6s, 20k
       = 2.4s, 40k = 13.1s, and there is one replica ever
       (deploy/k3s/20-deployment.yaml). Bounded at 1s the same input bails in
       ~1s inside 100MB of RSS, and the user gets a proposal with no rendered
       diff instead of a dead app. */
    const hunks = lineHunks(f.pre, f.post, 2, 1000);
    if (!hunks) {
      /* The diff is a VIEW of the proposal, never the proposal itself — the
         edits are already applied to `f.post` and are what Accept writes. So a
         diff that cannot be computed in time costs the preview, not the edit,
         and saying so beats a silent empty hunk list. */
      push(" ", `— ${f.path}: diff too large to render; the edit itself is unaffected —`);
      continue;
    }
    for (const h of hunks) {
      for (const line of h) {
        const marker = line[0] === "+" || line[0] === "-" ? line[0] : " ";
        if (marker === "+") added++;
        if (marker === "-") removed++;
        // a CRLF doc yields rows ending in a literal CR, which the diff card
        // renders raw — the row is display text, not bytes
        push(marker, line.slice(1).replace(/\r$/, ""));
      }
    }
  }
  // the one row allowed past the cap: it fires at most once, and only to say
  // the cap was hit
  if (diff.length >= MAX_DIFF_LINES) diff.push({ marker: " ", text: "… diff truncated" });
  return { diff, added, removed };
}
