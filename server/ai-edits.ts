/* ============================================================
   ai-edits.ts — the pure edit engine under the AI relay (SPEC §8).

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

import { structuredPatch } from "diff";
import { intersectsAgeFence, safePath } from "./vault.ts";

/**
 * SPEC §8 restricts the ops to four: no `delete_doc`, no rename. The rest of
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
     an otherwise-CRLF file. SPEC §1 (byte-faithful) and the relay's own
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
   Unified diff (API.md § Proposal object)
   ============================================================ */

export function buildDiff(files: FileImage[]): { diff: Array<{ marker: string; text: string }>; added: number; removed: number } {
  const diff: Array<{ marker: string; text: string }> = [];
  let added = 0;
  let removed = 0;
  for (const f of files) {
    if (files.length > 1) diff.push({ marker: " ", text: `— ${f.path} —` });
    /* THE TIMEOUT IS LOAD-BEARING, not tidiness. Myers is O(N·D), and `f.post`
       is a post-image the MODEL wrote — a `rewrite` of a long note is a
       perfectly ordinary request whose two sides share almost no lines, which
       is the worst case. Measured, unbounded: 4k lines/side = 3.4s, 10k lines
       = 19.9s. There is one replica, ever (deploy/k3s/20-deployment.yaml), so
       that is the whole server stopped, on a request nobody meant as an
       attack. Bounded at 1s the same input bails in ~1s and the user gets a
       proposal with no rendered diff instead of a dead app.

       Passing `timeout` switches jsdiff to its abortable overload: the return
       type becomes `| undefined`, which is what forces the branch below. */
    const patch = structuredPatch(f.path, f.path, f.pre, f.post, "", "", { context: 2, timeout: 1000 });
    if (!patch) {
      /* The diff is a VIEW of the proposal, never the proposal itself — the
         edits are already applied to `f.post` and are what Accept writes. So a
         diff that cannot be computed in time costs the preview, not the edit,
         and saying so beats a silent empty hunk list. */
      diff.push({ marker: " ", text: `— ${f.path}: diff too large to render; the edit itself is unaffected —` });
      continue;
    }
    for (const h of patch.hunks) {
      for (const line of h.lines) {
        if (line.startsWith("\\")) continue; // "\ No newline at end of file"
        const marker = line[0] === "+" || line[0] === "-" ? line[0] : " ";
        if (marker === "+") added++;
        if (marker === "-") removed++;
        // a CRLF doc yields rows ending in a literal CR, which the diff card
        // renders raw — the row is display text, not bytes
        if (diff.length < MAX_DIFF_LINES) diff.push({ marker, text: line.slice(1).replace(/\r$/, "") });
      }
    }
  }
  if (diff.length >= MAX_DIFF_LINES) diff.push({ marker: " ", text: "… diff truncated" });
  return { diff, added, removed };
}
