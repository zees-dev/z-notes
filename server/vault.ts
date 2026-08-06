/* ============================================================
   vault.ts — the disk layer.

   Files on disk are the source of truth. Everything here is byte-faithful:
   what GET returns is what is on disk, what PUT receives is what is written.
   No newline normalisation, no trailing-whitespace trimming, no BOM games.

   Also holds path containment (nothing escapes the vault, nothing touches
   .znotes/), slug/title/[[link]] extraction, age-fence redaction and tree
   building.
   ============================================================ */

import { basename, dirname, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";

/* ---------- paths ---------- */

/** Vault-relative POSIX path, already percent-decoded, or null if unsafe. */
export function safePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (!input) return null;
  if (input.includes("\0") || input.includes("\\")) return null;
  const parts = input.split("/"); // a leading "/" yields an empty segment → rejected
  for (const p of parts) {
    if (!p || p === "." || p === "..") return null;
    // A dot-prefixed segment is invisible to scanDocs/scanFolders, so accepting
    // one here would mint a file the reconciler can never index (and .znotes
    // is exactly such a segment).
    if (p.startsWith(".")) return null;
  }
  return parts.join("/");
}

/**
 * Containment is checked against REAL paths, not lexical ones: a symlink inside
 * the vault (git checks them out faithfully) would otherwise hand out reads and
 * writes anywhere on the filesystem. The leaf may legitimately not exist yet, so
 * we resolve the deepest existing ancestor and re-attach the missing tail.
 */
function realContained(root: string, abs: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return false; // walked off the top without resolving
      tail.unshift(basename(cur));
      cur = parent;
      continue;
    }
    const full = tail.length ? resolve(real, ...tail) : real;
    if (full !== realRoot && !full.startsWith(realRoot + "/")) return false;
    const realZnotes = resolve(realRoot, ".znotes");
    if (full === realZnotes || full.startsWith(realZnotes + "/")) return false;
    return true;
  }
}

/** Absolute path for a vault-relative path, or null if it escapes the vault. */
export function absOf(vault: string, rel: string): string | null {
  const root = resolve(vault);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) return null;
  const znotes = resolve(root, ".znotes");
  if (abs === znotes || abs.startsWith(znotes + "/")) return null;
  if (!realContained(root, abs)) return null;
  return abs;
}

export const znotesDir = (vault: string) => resolve(vault, ".znotes");
export const dbPath = (vault: string) => resolve(vault, ".znotes", "index.db");
export const settingsPath = (vault: string) => resolve(vault, ".znotes", "settings.toml");
const identityPath = (vault: string) => resolve(vault, ".znotes", "identity.age");
const recipientPath = (vault: string) => resolve(vault, ".znotes", "vault.pub");

/** Display name for the vault. A directory literally called `vault` borrows
    its parent's name, which is what the prototype showed ("z-notes"). */
export function vaultName(vault: string): string {
  const b = basename(resolve(vault));
  return b === "vault" ? basename(dirname(resolve(vault))) : b;
}

export function vaultRoot(vault: string): string {
  const abs = resolve(vault);
  const home = process.env.HOME || "";
  return home && abs.startsWith(home + "/") ? "~" + abs.slice(home.length) : abs;
}

/* ---------- content derivation ---------- */

export const slugOf = (path: string) => basename(path).replace(/\.md$/i, "");

export function titleOf(markdown: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown || "");
  return m ? m[1].trim() : fallback;
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
function closesFence(line: string, openLine: string): boolean {
  return (RENDERER_FENCE.test(openLine) ? FENCE_CLOSE : FENCE_CLOSE_QUOTED).test(line);
}

/** True for every line the RENDERER would open a secret block on — and more. */
function isAgeOpen(line: string): boolean {
  const m = FENCE_PREFIX.exec(line);
  if (!m) return false;
  return /^age\b/i.test(line.slice(m[0].length).trim());
}

/** A doc "has secrets" when it carries at least one ```age fence. */
export function hasSecrets(markdown: string): boolean {
  for (const line of String(markdown).split("\n")) if (isAgeOpen(line)) return true;
  return false;
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

/**
 * What an encrypted block looks like to the assistant (research §6.1). The
 * armor never leaves the disk layer: base64 would burn tokens for nothing, and
 * the placeholder tells the model in words that there is something here it can
 * neither read nor edit.
 */
export const AI_SECRET_PLACEHOLDER = "⟪secret: encrypted, not visible to the assistant⟫";

/**
 * Character ranges of every ```age fence, INCLUDING the opening and closing
 * fence lines and the newline that terminates the close. An unterminated fence
 * runs to the end of the string — exactly what `redact()` does, and the safe
 * direction: a block whose end we cannot see must still be untouchable.
 *
 * Used for two things that must agree: building the AI-facing placeholder text,
 * and rejecting any proposed edit whose span intersects ciphertext (research
 * §4.4 step 5 — a `rewrite` that dropped a placeholder into the file would
 * destroy the block).
 */
export function ageFenceRanges(markdown: string): Array<{ start: number; end: number }> {
  const text = String(markdown);
  const out: Array<{ start: number; end: number }> = [];
  let pos = 0;
  let open = -1;
  let openLine = "";
  while (pos <= text.length) {
    let nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl; // exclusive of "\n"
    const line = text.slice(pos, lineEnd);
    const next = nl < 0 ? text.length + 1 : nl + 1;
    if (open < 0) {
      if (isAgeOpen(line)) {
        open = pos;
        openLine = line;
      }
    } else if (closesFence(line, openLine)) {
      out.push({ start: open, end: Math.min(next, text.length) });
      open = -1;
    }
    pos = next;
  }
  if (open >= 0) out.push({ start: open, end: text.length });
  return out;
}

/** Does [start, end) touch any age fence? Zero-width probes count as inside. */
export function intersectsAgeFence(markdown: string, start: number, end: number): boolean {
  for (const r of ageFenceRanges(markdown)) {
    if (start < r.end && end > r.start) return true;
    if (start === end && start > r.start && start < r.end) return true;
  }
  return false;
}

/**
 * The AI-facing view of a document: every ```age fence — markers and armor
 * alike — collapsed to one placeholder line. Built on the SAME fence grammar as
 * `redact()` (and therefore as `hasSecrets()`), because a probe narrower than
 * the renderer's is the leak (see isAgeOpen above).
 *
 * Line count is NOT preserved here — unlike `redact()`, nothing downstream
 * addresses this text by line number, and the assistant is better served by a
 * short sentence than by a run of blank lines.
 */
export function redactForAi(markdown: string): string {
  const text = String(markdown);
  const ranges = ageFenceRanges(text);
  if (!ranges.length) return text;
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.start);
    out += AI_SECRET_PLACEHOLDER;
    // keep the block a line of its own when the fence ended with one
    if (text[r.end - 1] === "\n") out += "\n";
    at = r.end;
  }
  return out + text.slice(at);
}

/** [[slug]] / [[path/slug]] targets, from redacted text (never from armor). */
export function extractLinks(markdown: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/* ============================================================
   Link resolution and rewriting (SPEC §5, ticket 15).

     [[slug]]       resolves by unique filename slug, vault-wide
     [[path/slug]]  the disambiguating form, needed on a collision

   A slug carried by two docs resolves to NEITHER: the link is ambiguous, which
   the UI renders exactly like a broken link, because "silently picks one of
   them" is the one behaviour a file-backed vault must never have.

   Everything below is PURE — it takes a doc-path list and text, and returns
   text. The disk lives in server/index.ts; that separation is what makes the
   collision algorithm testable without a vault.
   ============================================================ */

/** `./a/b.md`, `a/b`, `  a/b  ` → `a/b`. The extension is optional in a link. */
export function normalizeTarget(target: string): string {
  return String(target ?? "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "");
}

export interface LinkIndex {
  /** every doc path, exactly as it is on disk */
  paths: Set<string>;
  /** filename slug → every doc carrying it (length > 1 ⇒ collision) */
  bySlug: Map<string, string[]>;
}

export function linkIndex(paths: Iterable<string>): LinkIndex {
  const set = new Set<string>();
  const bySlug = new Map<string, string[]>();
  for (const p of paths) {
    set.add(p);
    const slug = slugOf(p);
    const list = bySlug.get(slug);
    if (list) list.push(p);
    else bySlug.set(slug, [p]);
  }
  for (const list of bySlug.values()) list.sort();
  return { paths: set, bySlug };
}

/** The doc a `[[target]]` points at, or null when it is broken OR ambiguous. */
export function resolveTarget(target: string, idx: LinkIndex): string | null {
  const t = normalizeTarget(target);
  if (!t) return null;
  if (t.includes("/")) return idx.paths.has(t + ".md") ? t + ".md" : null;
  const hits = idx.bySlug.get(t);
  return hits && hits.length === 1 ? hits[0] : null;
}

/** The SHORTEST spelling that resolves to `dest` in `idx` — bare slug when the
    slug is unique there, the path-qualified form when it is not. */
export function preferredTarget(dest: string, idx: LinkIndex): string {
  const slug = slugOf(dest);
  const hits = idx.bySlug.get(slug);
  if (hits && hits.length === 1 && hits[0] === dest) return slug;
  return dest.replace(/\.md$/i, "");
}

/* A generic code fence, using the SAME prefix class as the age probe above
   (`[\s>]*```), which is deliberately wider than the renderer's `^\s*```). A
   fence this misses is a fence whose contents get rewritten — so the probe errs
   towards seeing MORE code, never less. `~~~` is not a fence here because it is
   not one for the renderer or for `isAgeOpen` either, and three grammars that
   disagree is how ciphertext gets edited. */
const CODE_FENCE = /^[\s>]*```/;
/** A blockquote line, matching the renderer's own `RE_QUOTE`. A fence that
    carries this prefix opens a code span INSIDE the quote and nowhere else —
    the renderer never lets it fence the prose that follows the quote, so
    neither may we (an unbalanced `> ``` ` used to swallow the whole rest of the
    file and silently skip every link the user could see). */
const QUOTE_PREFIX = /^\s*>/;
/** Inline code, per line, matching the renderer's own `` `([^`]+)` ``. */
const INLINE_CODE = /`[^`\n]+`/g;
const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** One `[[link]]` occurrence: its character span and the raw target. */
export interface LinkRef {
  start: number;
  end: number;
  target: string;
}

/**
 * Every `[[link]]` that a rewrite is allowed to touch.
 *
 * NEVER returned: links inside a ```age fence (that is ciphertext — editing it
 * destroys the block), inside an ordinary code fence, or inside inline code. A
 * note that documents its own link syntax in a code block must survive a rename
 * of the doc it names, byte for byte.
 */
export function linkRefs(markdown: string): LinkRef[] {
  const text = String(markdown);
  const age = ageFenceRanges(text);
  const inAge = (at: number) => age.some((r) => at >= r.start && at < r.end);
  const out: LinkRef[] = [];
  let pos = 0;
  let fenced = false;
  let fencedQuote = false;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const next = nl < 0 ? text.length + 1 : nl + 1;
    const quoted = QUOTE_PREFIX.test(line);
    // a blockquote fence lives and dies inside its own run of `>` lines
    if (!fenced && !quoted) fencedQuote = false;
    /* A fence line — opener OR closer, age or not — is never scanned itself and
       flips the state OF ITS OWN QUOTE DEPTH. Because `isAgeOpen` is
       `CODE_FENCE` plus an info-string test, an age block toggles this state
       machine too; the explicit `inAge` guard is belt-and-braces for an
       unterminated one (and is what keeps ciphertext untouchable no matter what
       this fence bookkeeping decides). */
    if (CODE_FENCE.test(line)) {
      if (fenced) {
        // only an unquoted fence closes a top-level one, exactly as the
        // renderer's `RE_FENCE = /^\s*```/` sees it
        if (!quoted) fenced = false;
      } else if (quoted) fencedQuote = !fencedQuote;
      else fenced = true;
      pos = next;
      continue;
    }
    if (!fenced && !(quoted && fencedQuote) && !inAge(pos)) {
      const masked: Array<[number, number]> = [];
      INLINE_CODE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INLINE_CODE.exec(line))) masked.push([m.index, m.index + m[0].length]);
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(line))) {
        const s = m.index;
        const e = s + m[0].length;
        if (masked.some(([a, b]) => s < b && e > a)) continue;
        out.push({ start: pos + s, end: pos + e, target: m[1].trim() });
      }
    }
    pos = next;
  }
  return out;
}

/**
 * Can this target be written as `[[target]]` and read back unchanged?
 *
 * `rewriteLinks` splices a target between bare `[[`/`]]` with no escaping, so a
 * name carrying `]]` (or a bare `]`, or a line break) breaks OUT of the
 * delimiter: `[[x]]y]]` paints a broken pill and dumps the literal `y]]` into
 * the prose of a doc the user never opened — and because `LINK_RE` can no
 * longer see the mangled occurrence, renaming back cannot repair it. There is
 * no spelling of such a name that works, so the move that would create it is
 * refused before anything is written.
 */
export function linkSafeTarget(target: string): boolean {
  /* A bare CR survives `[[…]]` only because `linkRefs` splits on LF alone; to a
     CRLF-aware reader it is a line break like any other, and two grammars that
     disagree about where a line ends is how a link gets cut in half. */
  if (/\r/.test(target)) return false;
  const wrapped = "[[" + target + "]]";
  const refs = linkRefs(wrapped);
  return refs.length === 1 && refs[0].start === 0 && refs[0].end === wrapped.length && refs[0].target === target;
}

/**
 * Rewrite link targets. `map` receives the raw target and returns the
 * replacement, or null/undefined to leave the occurrence exactly as written —
 * including its whitespace, which is only ever discarded on a real rewrite.
 */
export function rewriteLinks(
  markdown: string,
  map: (target: string) => string | null | undefined
): { text: string; count: number } {
  const text = String(markdown);
  const refs = linkRefs(text);
  if (!refs.length) return { text, count: 0 };
  let out = "";
  let at = 0;
  let count = 0;
  for (const r of refs) {
    const next = map(r.target);
    if (next == null || next === r.target) continue;
    out += text.slice(at, r.start) + "[[" + next + "]]";
    at = r.end;
    count++;
  }
  return { text: count ? out + text.slice(at) : text, count };
}

/**
 * The heart of the move: which links have to change, and to what.
 *
 * For each occurrence, in the world BEFORE the move and the world AFTER it:
 *
 *   1. `was` = the doc this link resolved to before. Unresolvable (missing or
 *      ambiguous) ⇒ leave it alone. A move never repairs a link it did not
 *      break, and never touches an author's deliberate dead link.
 *   2. `dest` = where that doc now lives (`was` unless it moved).
 *   3. If the link, spelled exactly as it is, still resolves to `dest` AFTER,
 *      leave it alone. This is what stops a rename anywhere in the vault from
 *      rewriting every path-qualified link in it into its shortest form.
 *   4. Otherwise rewrite it to `preferredTarget(dest, after)`.
 *
 * Rules 3+4 are symmetric, which is what makes collisions work in BOTH
 * directions with no special cases:
 *
 *   - rename `a/bar.md` → `a/foo.md` while `c/foo.md` exists: `[[bar]]` no
 *     longer resolves, and bare `foo` is now ambiguous, so it becomes
 *     `[[a/foo]]`; every `[[foo]]` that meant `c/foo.md` also stopped
 *     resolving (ambiguous), so those become `[[c/foo]]` — links in docs that
 *     had nothing to do with the rename.
 *   - the inverse, rename `a/foo.md` → `a/baz.md`: `[[a/foo]]` becomes
 *     `[[baz]]`, while `[[c/foo]]` still resolves and is left untouched.
 */
export interface RewriteCandidate {
  /** the path the doc will have AFTER the move (where the text gets written) */
  path: string;
  markdown: string;
}

export interface LinkRewrite {
  path: string;
  markdown: string;
  /** how many occurrences changed */
  links: number;
}

export function planLinkRewrites(
  beforeDocs: Iterable<string>,
  mapping: Map<string, string>,
  candidates: Iterable<RewriteCandidate>
): LinkRewrite[] {
  const before = [...beforeDocs];
  const idxBefore = linkIndex(before);
  const idxAfter = linkIndex(before.map((p) => mapping.get(p) ?? p));
  const out: LinkRewrite[] = [];
  for (const c of candidates) {
    const { text, count } = rewriteLinks(c.markdown, (target) => {
      const was = resolveTarget(target, idxBefore);
      if (!was) return null;
      const dest = mapping.get(was) ?? was;
      if (resolveTarget(target, idxAfter) === dest) return null;
      return preferredTarget(dest, idxAfter);
    });
    if (count) out.push({ path: c.path, markdown: text, links: count });
  }
  return out;
}

/**
 * Which of the vault's known link targets could possibly change under this
 * move. Used to narrow "read every doc in the vault" down to the docs that can
 * actually contain an affected link — the sqlite backlink graph names their
 * sources (db.ts `backlinkSources`).
 */
export function affectedTargets(
  beforeDocs: Iterable<string>,
  mapping: Map<string, string>,
  targets: Iterable<string>
): string[] {
  const before = [...beforeDocs];
  const idxBefore = linkIndex(before);
  const idxAfter = linkIndex(before.map((p) => mapping.get(p) ?? p));
  const out: string[] = [];
  for (const t of targets) {
    const was = resolveTarget(t, idxBefore);
    if (!was) continue;
    const dest = mapping.get(was) ?? was;
    if (resolveTarget(t, idxAfter) !== dest) out.push(t);
  }
  return out;
}

/** Opaque, content-derived revision: identical bytes ⇒ identical rev. */
export function revOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Cheap non-cryptographic content hash for change detection. */
export const hashOf = (text: string) => String(Bun.hash(text));

export const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/* ---------- io ---------- */

/** ignoreBOM: a leading U+FEFF is content, not an encoding marker.
    fatal: a non-UTF-8 byte must NOT decode to U+FFFD — a lossy decode would be
    written back verbatim on the first edit and destroy the original byte. */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

export interface DiskDoc {
  path: string;
  markdown: string;
  size: number;
  mtimeMs: number;
}

export async function readDoc(vault: string, rel: string): Promise<DiskDoc | null> {
  const abs = absOf(vault, rel);
  if (!abs) return null;
  const file = Bun.file(abs);
  let st;
  try {
    st = await file.stat();
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  // NOT file.text(): Bun strips a leading UTF-8 BOM, which would break the
  // lossless round-trip for files that legitimately start with one.
  let markdown: string;
  try {
    markdown = UTF8.decode(await file.bytes());
  } catch {
    // not UTF-8 → not an editable doc. Refusing it keeps the bytes on disk
    // intact; serving it would round-trip U+FFFD back over the original.
    return null;
  }
  return { path: rel, markdown, size: st.size, mtimeMs: st.mtimeMs };
}

/** The stat half of readDoc alone — for the reconciler's cheap gate, which
    must not pay for a read+decode of a doc it is about to skip. */
export async function statDoc(vault: string, rel: string): Promise<{ size: number; mtimeMs: number } | null> {
  const abs = absOf(vault, rel);
  if (!abs) return null;
  try {
    const st = await Bun.file(abs).stat();
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

export async function exists(vault: string, rel: string): Promise<"file" | "dir" | null> {
  const abs = absOf(vault, rel);
  if (!abs) return null;
  try {
    const st = await Bun.file(abs).stat();
    return st.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** The ancestor segment of `target` that is a FILE rather than a folder, or
    null when the way is clear. `mkdir -p` through a file throws ENOTDIR out of
    a route; naming the real problem beats surfacing an errno. Shared by
    POST /api/docs, the move, and the trash restore. */
export async function blockedByFile(vault: string, target: string): Promise<string | null> {
  const segs = target.split("/");
  let acc = "";
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? acc + "/" + segs[i] : segs[i];
    if ((await exists(vault, acc)) === "file") return acc;
  }
  return null;
}

/**
 * Atomic write: temp file inside .znotes/tmp (same filesystem) then rename into
 * place, so a reconcile triggered mid-write can never read half a file.
 */
export async function writeDocAtomic(vault: string, rel: string, text: string): Promise<DiskDoc> {
  const abs = absOf(vault, rel);
  if (!abs) throw new Error("bad-path");
  await mkdir(dirname(abs), { recursive: true });
  const tmpDir = resolve(znotesDir(vault), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = resolve(tmpDir, `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await Bun.write(tmp, text);
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const st = await Bun.file(abs).stat();
  return { path: rel, markdown: text, size: st.size, mtimeMs: st.mtimeMs };
}

/* ============================================================
   Vault keyring — `.znotes/identity.age` + `.znotes/vault.pub` (SPEC §6).

   The server is a dumb courier here: it stores and serves two opaque strings
   and validates their SHAPE only. It never derives a key, never decrypts, and
   never sees a passphrase — all of that lives in the browser's crypto worker
   (research/secrets-crypto.md §5.2).
   ============================================================ */

export const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
export const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

/**
 * The dash-free core of the header — the one string that must never leave this
 * process (SPEC §6/§11), and what the AI relay's canary greps for so a fence
 * with the dashes mangled still trips it.
 *
 * It lives HERE, next to the constants it is derived from, because it is now
 * checked in three places (the relay's canary, the relay's proposal validator,
 * and the terminal before a command transcript is made durable) and a second
 * copy of the literal is exactly how one of them drifts.
 */
export const ARMOR_CANARY = "BEGIN AGE ENCRYPTED FILE";

/** Strict-enough armor shape check: header, footer, and nothing but base64
    between them. Deliberately NOT a parse — a body this server cannot decode
    is still the user's data, and rejecting it would lock them out. */
export function isArmor(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3) return false;
  if (lines[0].trim() !== ARMOR_BEGIN) return false;
  if (lines[lines.length - 1].trim() !== ARMOR_END) return false;
  for (const l of lines.slice(1, -1)) {
    if (!/^[A-Za-z0-9+/=]*$/.test(l.trim())) return false;
  }
  return true;
}

/** `age1…` bech32 recipient (charset excludes 1, b, i, o). */
export function isRecipient(s: unknown): s is string {
  return typeof s === "string" && /^age1[02-9ac-hj-np-z]{20,120}$/.test(s.trim());
}

export interface VaultKeys {
  identity: string | null;
  recipient: string | null;
}

export async function readVaultKeys(vault: string): Promise<VaultKeys> {
  const read = async (abs: string) => {
    const f = Bun.file(abs);
    if (!(await f.exists())) return null;
    const t = (await f.text()).trim();
    return t || null;
  };
  return {
    identity: await read(identityPath(vault)),
    recipient: await read(recipientPath(vault)),
  };
}

/** Where a replaced identity waits until the new pair is fully on disk. */
export const PREV_IDENTITY = "identity.age.prev";

/**
 * Write both keyring files. Each rename is atomic; the pair is not, so a crash
 * between them can leave a new identity with the old recipient — which is why
 * the identity lands FIRST: a recipient without its identity is unrecoverable
 * data-loss-by-encryption, while an identity without a recipient is a state the
 * UI can repair (unlock derives the recipient and rewrites vault.pub). Both
 * temps are written before either rename, so the only failure window is the
 * rename syscall itself.
 *
 * Ordering alone is not enough on REPLACE, though: identity-first plus a crash
 * leaves a new identity beside the old recipient, and the old identity — the
 * only key that can read every existing block — would be gone. So a replaced
 * identity is moved aside first and only deleted once the new pair is complete.
 * No window destroys a key: every intermediate state is recoverable.
 */
export async function writeVaultKeys(vault: string, identity: string, recipient: string): Promise<void> {
  const dir = znotesDir(vault);
  await mkdir(dir, { recursive: true });
  const tmpDir = resolve(dir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpId = resolve(tmpDir, `identity-${stamp}.tmp`);
  const tmpPub = resolve(tmpDir, `pub-${stamp}.tmp`);
  const prev = resolve(dir, PREV_IDENTITY);
  const idText = identity.trim() + "\n";
  const pubText = recipient.trim() + "\n";
  let stashed = false;
  try {
    await Bun.write(tmpId, idText);
    await Bun.write(tmpPub, pubText);
    const existing = await Bun.file(identityPath(vault)).exists();
    if (existing && (await Bun.file(identityPath(vault)).text()).trim() !== idText.trim()) {
      await rename(identityPath(vault), prev);
      stashed = true;
    }
    await rename(tmpId, identityPath(vault));
    await rename(tmpPub, recipientPath(vault));
    if (stashed) await rm(prev, { force: true }).catch(() => {});
  } finally {
    await rm(tmpId, { force: true }).catch(() => {});
    await rm(tmpPub, { force: true }).catch(() => {});
  }
}

export async function makeFolder(vault: string, rel: string): Promise<void> {
  const abs = absOf(vault, rel);
  if (!abs) throw new Error("bad-path");
  await mkdir(abs, { recursive: true });
}

/**
 * The folders a create at `rel` would have to MAKE, outermost first.
 *
 * `POST /api/docs` creates parent folders implicitly (API.md), which means a
 * failed create can leave a tree of directories nobody asked for behind — the
 * `mkdir -p` succeeds and the write that justified it does not. Naming them up
 * front is what makes `pruneEmptyFolders` a real rollback rather than a guess.
 *
 * `includeSelf` distinguishes the two callers: a folder create wants the leaf
 * counted, a doc create stops at the leaf's parent.
 */
export async function missingFolders(vault: string, rel: string, includeSelf: boolean): Promise<string[]> {
  const segs = rel.split("/");
  const depth = includeSelf ? segs.length : segs.length - 1;
  const out: string[] = [];
  let acc = "";
  for (let i = 0; i < depth; i++) {
    acc = acc ? acc + "/" + segs[i] : segs[i];
    if (!(await exists(vault, acc))) out.push(acc);
  }
  return out;
}

/**
 * Undo the implicit folders of a create that then failed — deepest first, and
 * with `rmdir` semantics: a folder that has ANYTHING in it survives. That is
 * the whole safety argument. A concurrent create that landed inside one of
 * these keeps its folder, and nothing that was on disk before the failed create
 * can be removed by it.
 */
export async function pruneEmptyFolders(vault: string, rels: string[]): Promise<void> {
  for (let i = rels.length - 1; i >= 0; i--) {
    const abs = absOf(vault, rels[i]);
    if (!abs) continue;
    try {
      await rmdir(abs);
    } catch {
      return; // non-empty (or already gone): everything above it stays too
    }
  }
}

/* ---------- move / delete primitives (SPEC §3 delta 2, phase 5) ---------- */

/**
 * Same file, two spellings? macOS is case- and normalisation-insensitive, so
 * `notes/Foo.md` and `notes/foo.md` are one inode — and a rename between them
 * is legal and must NOT be refused as "target exists". Compared by inode, not
 * by string, because that is the only question the filesystem actually answers.
 */
export function sameNode(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Rename a doc or a whole folder subtree. One `rename(2)`: the bytes are never
 * re-written, so a move is byte-faithful by construction and a subtree carries
 * along whatever non-`.md` files it holds.
 *
 * Returns the topmost directory `mkdir -p` had to create (node's own return
 * value), so a caller rolling the move back can remove the empty scaffolding it
 * left behind instead of parking a stray folder in the tree.
 */
export async function moveNode(vault: string, from: string, to: string): Promise<{ created: string | null }> {
  const src = absOf(vault, from);
  const dst = absOf(vault, to);
  if (!src || !dst) throw new Error("bad-path");
  const created = (await mkdir(dirname(dst), { recursive: true })) ?? null;
  await rename(src, dst);
  return { created: created || null };
}

/** Delete a doc, or a folder and everything under it. */
export async function removeNode(vault: string, rel: string): Promise<void> {
  const abs = absOf(vault, rel);
  if (!abs) throw new Error("bad-path");
  await rm(abs, { recursive: true, force: true });
}

/** Every .md under the vault, vault-relative, excluding dot-directories. */
export async function scanDocs(vault: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.md");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: resolve(vault), onlyFiles: true, dot: false })) {
    const p = rel.split(/[\\/]/).join("/");
    if (p.split("/").some((seg) => seg.startsWith("."))) continue;
    out.push(p);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Every FILE under `rel`, vault-relative, `.md` or not, excluding
 * dot-directories.
 *
 * `moveNode`/`removeNode` are one `rename(2)` / one `rm -r`, so a folder op
 * carries its whole subtree — including the `.png` beside the note. `scanDocs`
 * cannot see those, and neither can the git pipeline's bulk `stage()`, so a
 * folder op that named only its `.md` children left the attachment deleted in
 * the worktree and alive in HEAD, permanently, with no in-app way to clear it.
 * The commit pathspec is built from this instead.
 */
export async function scanTree(vault: string, rel: string): Promise<string[]> {
  const root = resolve(vault);
  const base = absOf(vault, rel);
  if (!base) return [];
  const out: string[] = [];
  const walk = async (r: string) => {
    let entries;
    try {
      entries = await readdir(resolve(root, r), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = `${r}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(rel);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Every directory under the vault, vault-relative, excluding dot-directories.
    Folders exist on disk, so an empty one survives a database rebuild. */
export async function scanFolders(vault: string): Promise<string[]> {
  const root = resolve(vault);
  const out: string[] = [];
  const walk = async (rel: string) => {
    const entries = await readdir(rel ? resolve(root, rel) : root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      out.push(p);
      await walk(p);
    }
  };
  await walk("");
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/* ---------- tree ---------- */

export interface FileMeta {
  type: "file";
  path: string;
  name: string;
  title: string;
  slug: string;
  bytes: number;
  mtime: string;
  empty: boolean;
  hasSecrets: boolean;
}

export interface FolderNode {
  type: "folder";
  path: string;
  name: string;
  open: boolean;
  children: TreeNode[];
}

export type TreeNode = FileMeta | FolderNode;

/**
 * Folders first, then files, each alphabetical — a deterministic order the
 * client can rely on. `open` comes from sqlite and is advisory.
 */
export function buildTree(
  files: FileMeta[],
  folderOpen: Map<string, boolean>,
  folderPaths: string[] = []
): TreeNode[] {
  const rootFiles: FileMeta[] = [];
  const folders = new Map<string, { node: FolderNode; files: FileMeta[] }>();

  const ensureFolder = (path: string): FolderNode => {
    const found = folders.get(path);
    if (found) return found.node;
    const node: FolderNode = {
      type: "folder",
      path,
      name: basename(path),
      open: folderOpen.get(path) !== false,
      children: [],
    };
    folders.set(path, { node, files: [] });
    const parent = dirname(path);
    if (parent && parent !== ".") ensureFolder(parent);
    return node;
  };

  for (const f of files) {
    const parent = dirname(f.path);
    if (!parent || parent === ".") rootFiles.push(f);
    else {
      ensureFolder(parent);
      folders.get(parent)!.files.push(f);
    }
  }
  for (const p of folderPaths) if (p) ensureFolder(p);

  const childFolders = (parent: string) =>
    [...folders.keys()]
      .filter((p) => (parent ? dirname(p) === parent : !p.includes("/")))
      .sort((a, b) => a.localeCompare(b));

  const assemble = (parent: string): TreeNode[] => {
    const dirs = childFolders(parent).map((p) => {
      const entry = folders.get(p)!;
      entry.node.children = assemble(p);
      return entry.node;
    });
    const own = (parent ? folders.get(parent)!.files : rootFiles).slice().sort((a, b) => a.path.localeCompare(b.path));
    return [...dirs, ...own];
  };

  return assemble("");
}
