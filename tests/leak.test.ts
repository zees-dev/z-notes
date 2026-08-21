/* ============================================================
   LEAK-CANARY GATE

   age armor never appears in AI relay payloads, logs, or the search index.

   The leak rule is structural: every indexer-facing read goes through
   `redact()`, so the armor inside a ```age fence must never reach sqlite, FTS,
   a /api/search response or the process's own output. There is no phase-1 AI
   relay to inspect, so the three reachable surfaces are asserted here.

   The fence is written in every shape a real vault produces — plain,
   list-indented, inside a blockquote/callout, and in a CRLF-authored file —
   because a fence the redactor cannot SEE leaks the armor, and a fence it
   cannot see the END of blanks the whole rest of the file. Both failures are
   silent, so each doc also carries a positive control: prose that must still be
   findable, including prose AFTER the block.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "puppeteer-core";
import * as age from "age-encryption";
import { dropVault, encPath, makeVault, startServer, sleep, waitUntil, type TestServer, git as gitIn } from "./helpers";
import { proposeEdits, reply, startMockUpstream, turn, type MockUpstream } from "./mock-upstream";
/* Phase 6 drives a REAL browser: vault-wide reveal means the plaintext of every
   block is live in a tab, and the only way to assert that it stays there is to
   put it there. Same harness every e2e file uses (tests/browser.ts). */
import { launchTestBrowser, pressChord, waitForApp } from "./browser";

const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_TAIL = "-----END AGE ENCRYPTED FILE-----";
const ARMOR_B64_1 = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4";
const ARMOR_B64_2 = "Zt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp";

/** every string that must never leave the vault directory */
const ARMOR_TOKENS = [ARMOR_HEAD, ARMOR_TAIL, ARMOR_B64_1, ARMOR_B64_2, "BEGIN AGE ENCRYPTED FILE"];

const armorBlock = (prefix: string, eol: string) =>
  [
    prefix + "```age",
    prefix + ARMOR_HEAD,
    prefix + ARMOR_B64_1,
    prefix + ARMOR_B64_2,
    prefix + ARMOR_TAIL,
    prefix + "```",
  ].join(eol) + eol;

/* Each doc: a marker BEFORE the block, the block, a marker AFTER it. The
   "after" markers are what catch over-redaction (a fence that never closes). */
const SEED = {
  "plain.md":
    "# Plain\n\nPLAINBEFOREMARKER prose above the block\n\n" + armorBlock("", "\n") + "\nPLAINAFTERMARKER prose below\n",
  "indented.md":
    "# Indented\n\n- INDENTEDBEFOREMARKER item\n" + armorBlock("  ", "\n") + "\nINDENTEDAFTERMARKER prose below\n",
  "quoted.md":
    "# Quoted\n\n> QUOTEDBEFOREMARKER callout\n" + armorBlock("> ", "\n") + "\nQUOTEDAFTERMARKER prose below\n",
  "crlf.md":
    "# CRLF\r\n\r\nCRLFBEFOREMARKER prose above\r\n\r\n" +
    armorBlock("", "\r\n") +
    "\r\nCRLFAFTERMARKER prose below\r\n",

  /* ---- prefixes the RENDERER accepts and the server's probe did not ----

     app/markdown.js opens a fence on /^\s*```/ and JS `\s` is far wider than the
     `[ \t>]` the server used: a no-break space, a form feed, an ideographic
     space or a BOM in front of the fence made a block that the browser paints
     as "Secret block · Locked" and offers to unlock, while `redact()` never
     saw it — so the armor went into sqlite, into FTS5 and back out of
     /api/search. Invisible characters, so nothing looks wrong. */
  "nbsp.md":
    "# NBSP\n\nNBSPBEFOREMARKER prose above\n\n" + armorBlock("\u00A0", "\n") + "\nNBSPAFTERMARKER prose below\n",
  "formfeed.md":
    "# Form feed\n\nFFBEFOREMARKER prose above\n\n" + armorBlock("\u000C", "\n") + "\nFFAFTERMARKER prose below\n",
  "ideographic.md":
    "# Ideographic\n\nIDEOBEFOREMARKER prose above\n\n" +
    armorBlock("\u3000", "\n") +
    "\nIDEOAFTERMARKER prose below\n",
  "bom.md":
    "# BOM\n\nBOMBEFOREMARKER prose above\n\n" + armorBlock("\uFEFF", "\n") + "\nBOMAFTERMARKER prose below\n",
};

const DOC_PATHS = Object.keys(SEED);

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer({ seed: SEED });
  await sleep(400); // let the boot reconcile settle before anything is read
}, 30000);

afterAll(async () => {
  if (srv) await srv.stop();
});

const contains = (hay: string, needle: string) => hay.includes(needle);

describe("leak canary", () => {
  test("every fence shape is recognised as a secret block", async () => {
    const r = await srv.get("/api/docs");
    expect(r.status).toBe(200);
    const files = flatten(r.body.tree).filter((n: any) => n.type === "file");
    for (const p of DOC_PATHS) {
      const row = files.find((f: any) => f.path === p);
      expect(`${p} hasSecrets=${row?.hasSecrets}`).toBe(`${p} hasSecrets=true`);
    }
  });

  /* A REGEX is a second way into the same index (ADR 0028), and it can ask for
     shapes a subsequence never could — "any run of base64", "every line". The
     redaction is what protects this, not the matcher, so the proof is that a
     pattern which matches EVERYTHING still comes back with only the prose. */
  test("…and a regex cannot reach it either, however greedy the pattern", async () => {
    const patterns = [
      "/AGE ENCRYPTED/",
      "/BEGIN|END/",
      "/YWdlLWVuY3J5/",
      "/[A-Za-z0-9+/=]{24,}/",
      "/-{5}/",
      "/.*/",
      "/^.*$/",
      "/\\S+/",
      "/age/i",
    ];
    for (const p of patterns) {
      const r = await srv.get("/api/search?q=" + encodeURIComponent(p) + "&limit=100");
      expect(`${p} → ${r.status} ${r.body.mode}`).toBe(`${p} → 200 regex`);
      const results = JSON.stringify(r.body.results);
      for (const token of ARMOR_TOKENS) {
        expect(`${p} leaks ${token}: ${contains(results, token)}`).toBe(`${p} leaks ${token}: false`);
      }
    }
    /* and the catch-all really did match — an empty answer would prove nothing */
    const all = await srv.get("/api/search?q=" + encodeURIComponent("/.*/") + "&limit=100");
    expect(`catch-all matched something: ${all.body.results.length > 0}`).toBe("catch-all matched something: true");
  });

  test("armor never appears in a /api/search response", async () => {
    /* query the armor itself, plus queries a user would plausibly type */
    const queries = [
      ARMOR_B64_2,
      ARMOR_B64_1.slice(0, 16),
      "BEGIN AGE",
      "ENCRYPTED",
      "age",
      "YWdlLWVuY3J5",
      "",
      "marker",
      "prose",
    ];
    for (const q of queries) {
      const r = await srv.get("/api/search?q=" + encodeURIComponent(q) + "&limit=100");
      expect(`q=${q} → ${r.status}`).toBe(`q=${q} → 200`);
      /* results only: the response echoes `query`, which is the caller's own
         string and tells us nothing about what the server stored */
      const results = JSON.stringify(r.body.results);
      for (const token of ARMOR_TOKENS) {
        expect(`q=${q} leaks ${token}: ${contains(results, token)}`).toBe(`q=${q} leaks ${token}: false`);
      }
    }
  });

  test("armor never reaches sqlite (index.db or its WAL)", async () => {
    const files = [
      join(srv.vault, ".znotes", "index.db"),
      join(srv.vault, ".znotes", "index.db-wal"),
      join(srv.vault, ".znotes", "index.db-shm"),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);

    const blob = files.map((f) => readFileSync(f).toString("latin1")).join("\n");
    for (const token of ARMOR_TOKENS) {
      expect(`${token} in sqlite: ${contains(blob, token)}`).toBe(`${token} in sqlite: false`);
    }
    /* the index really did read these docs — otherwise the assertion is vacuous */
    expect(contains(blob, "PLAINBEFOREMARKER")).toBe(true);
  });

  test("armor never reaches the process's own output", () => {
    const out = srv.stdoutLines.concat(srv.stderrLines).join("\n");
    for (const token of ARMOR_TOKENS) {
      expect(`${token} in logs: ${contains(out, token)}`).toBe(`${token} in logs: false`);
    }
  });

  /* The other half of the same bug: a fence the redactor cannot close blanks
     everything after it, so the doc silently loses its tail from search. */
  test("content around the block is still searchable, in every fence shape", async () => {
    const markers: Array<[string, string]> = [
      ["plain.md", "PLAINBEFOREMARKER"],
      ["plain.md", "PLAINAFTERMARKER"],
      ["indented.md", "INDENTEDBEFOREMARKER"],
      ["indented.md", "INDENTEDAFTERMARKER"],
      ["quoted.md", "QUOTEDBEFOREMARKER"],
      ["quoted.md", "QUOTEDAFTERMARKER"],
      ["crlf.md", "CRLFBEFOREMARKER"],
      ["crlf.md", "CRLFAFTERMARKER"],
      ["nbsp.md", "NBSPBEFOREMARKER"],
      ["nbsp.md", "NBSPAFTERMARKER"],
      ["formfeed.md", "FFBEFOREMARKER"],
      ["formfeed.md", "FFAFTERMARKER"],
      ["ideographic.md", "IDEOBEFOREMARKER"],
      ["ideographic.md", "IDEOAFTERMARKER"],
      ["bom.md", "BOMBEFOREMARKER"],
      ["bom.md", "BOMAFTERMARKER"],
    ];
    for (const [path, marker] of markers) {
      const r = await srv.get("/api/search?q=" + encodeURIComponent(marker) + "&limit=100");
      const hit = r.body.results.find((x: any) => x.path === path && x.kind === "line" && x.text.includes(marker));
      expect(`${marker} findable in ${path}: ${!!hit}`).toBe(`${marker} findable in ${path}: true`);
    }
  });

  test("the armor itself still round-trips through GET (redaction is index-side only)", async () => {
    for (const p of DOC_PATHS) {
      const r = await srv.doc(p);
      expect(r.status).toBe(200);
      expect(r.body.markdown).toBe((SEED as Record<string, string>)[p]);
      expect(r.body.hasSecrets).toBe(true);
    }
  });
});

/* ============================================================
   The invariant behind all of the above, asserted directly.

   vault.ts's comment says hasSecrets() and redact() "MUST agree by
   construction" — but the construction only ever compared the server's two
   probes with each other. The reader that actually decides whether a user
   BELIEVES a block is encrypted is the renderer, and its opener is
   `/^\s*```/` (app/markdown.js RE_FENCE). A server probe narrower than that is a
   fence the browser paints as a secret and the indexer swallows whole.

   Direction matters and only one direction is a leak: the server may be WIDER
   (it then over-redacts, which costs search recall, never confidentiality).
   ============================================================ */
describe("fence grammar — the server is never narrower than the renderer", () => {
  /* the renderer's own opener, verbatim from app/markdown.js */
  const RE_FENCE = /^\s*```/;

  const PREFIXES = [
    ["", "none"],
    [" ", "space"],
    ["   ", "spaces"],
    ["\t", "tab"],
    ["\u00A0", "U+00A0 no-break space"],
    ["\u000C", "U+000C form feed"],
    ["\u000B", "U+000B vertical tab"],
    ["\u3000", "U+3000 ideographic space"],
    ["\u2003", "U+2003 em space"],
    ["\uFEFF", "U+FEFF BOM"],
    ["  \t", "mixed"],
  ] as const;

  test("every opener the renderer treats as ```age is a secret block server-side", async () => {
    const { hasSecrets } = await import("../server/vault");
    for (const [prefix, label] of PREFIXES) {
      const line = prefix + "```age";
      /* precondition: this really is a fence to the renderer */
      expect(`${label} opens a fence in the renderer: ${RE_FENCE.test(line)}`).toBe(
        `${label} opens a fence in the renderer: true`
      );
      const md = "# doc\n\n" + line + "\n" + ARMOR_HEAD + "\n" + ARMOR_B64_1 + "\n" + ARMOR_TAIL + "\n```\n";
      expect(`${label} → hasSecrets ${hasSecrets(md)}`).toBe(`${label} → hasSecrets true`);
    }
  });

  test("…and its armor is blanked by redact(), so nothing reaches sqlite or FTS", async () => {
    const { redact } = await import("../server/vault");
    for (const [prefix, label] of PREFIXES) {
      const md =
        "# doc\n\nBEFOREMARKER\n\n" +
        prefix + "```age\n" +
        prefix + ARMOR_HEAD + "\n" +
        prefix + ARMOR_B64_1 + "\n" +
        prefix + ARMOR_TAIL + "\n" +
        prefix + "```\n\nAFTERMARKER\n";
      const out = redact(md);
      for (const token of ARMOR_TOKENS) {
        expect(`${label} leaks ${token.slice(0, 18)}: ${out.includes(token)}`).toBe(
          `${label} leaks ${token.slice(0, 18)}: false`
        );
      }
      /* the fence still CLOSES — otherwise the tail of every doc disappears */
      expect(`${label} keeps its tail: ${out.includes("AFTERMARKER")}`).toBe(`${label} keeps its tail: true`);
      expect(out.split("\n").length).toBe(md.split("\n").length); // line numbers survive
    }
  });

  /* ----------------------------------------------------------------
     The OTHER half of the same parity, and the half that was missing:
     the prefix cases above all walk the text BEFORE the backticks. The
     renderer's info string is `line.replace(/^\s*```/, "").trim()`, so the
     whitespace AFTER the backticks is equally load-bearing — ``` ``` age ```
     paints a locked secret block in the browser while a probe that demanded
     `age` abut the ticks saw an ordinary paragraph. Every server probe is
     built on that one opener, so a miss meant hasSecrets=false, redact()
     leaving the armor, redactForAi() leaving the armor, and ageFenceRanges()
     empty — i.e. armor in sqlite/FTS/search AND a `rewrite` sailing past the
     secret_intersect guard to delete a real block.

     So this asserts the invariant DIRECTLY, over the renderer's own classifier:
     for every opener the renderer calls a secret block, all four probes agree.
     ---------------------------------------------------------------- */
  const OPENERS: Array<[string, string, boolean]> = [
    ["```age", "canonical", true],
    ["``` age", "one space after the ticks", true],
    ["```  age", "two spaces after the ticks", true],
    ["```\tage", "tab after the ticks", true],
    ["``` age ", "space either side", true],
    ["  ``` age", "indented, space after the ticks", true],
    ["\u00A0``` age", "U+00A0 then a space after the ticks", true],
    ["```age ", "trailing space only", true],
    /* the renderer does not open a fence after a blockquote marker; the server
       deliberately does, and being WIDER only ever over-redacts */
    ["> ``` age", "blockquoted, space after the ticks", false],
  ];

  /** the renderer's own classifier, verbatim from app/markdown.js (the lang === "age" test in renderPreview) */
  const rendererSaysSecret = (line: string) =>
    RE_FENCE.test(line) && line.replace(RE_FENCE, "").trim() === "age";

  test("the info string is parsed as the renderer parses it, not pattern-matched", async () => {
    const { hasSecrets, redact, redactForAi, ageFenceRanges, intersectsAgeFence } = await import("../server/vault");

    for (const [opener, label, rendered] of OPENERS) {
      const md = "# doc\n\nBEFOREMARKER\n\n" + opener + "\n" + ARMOR_HEAD + "\n" + ARMOR_B64_1 + "\n" + ARMOR_TAIL + "\n```\n\nAFTERMARKER\n";

      /* precondition: the browser really does paint this as "Secret · Locked" */
      expect(`${label} is a secret block to the renderer: ${rendererSaysSecret(opener)}`).toBe(
        `${label} is a secret block to the renderer: ${rendered}`
      );

      expect(`${label} → hasSecrets ${hasSecrets(md)}`).toBe(`${label} → hasSecrets true`);

      for (const token of ARMOR_TOKENS) {
        expect(`${label} → redact leaks ${token.slice(0, 18)}: ${redact(md).includes(token)}`).toBe(
          `${label} → redact leaks ${token.slice(0, 18)}: false`
        );
        expect(`${label} → redactForAi leaks ${token.slice(0, 18)}: ${redactForAi(md).includes(token)}`).toBe(
          `${label} → redactForAi leaks ${token.slice(0, 18)}: false`
        );
      }

      /* the edit guard runs off the SAME grammar: a fence it cannot see is a
         `rewrite` that silently deletes the user's ciphertext */
      expect(`${label} → ageFenceRanges found ${ageFenceRanges(md).length}`).toBe(`${label} → ageFenceRanges found 1`);
      expect(`${label} → a whole-doc rewrite intersects: ${intersectsAgeFence(md, 0, md.length)}`).toBe(
        `${label} → a whole-doc rewrite intersects: true`
      );
    }
  });

  /* ----------------------------------------------------------------
     The CLOSE probe, whose direction is INVERTED.

     For an opener, wider-than-the-renderer is the safe side. For a close it is
     the leak: a line the server accepts as the end of the fence but the
     renderer does not ENDS the redacted region early, while app.js keeps
     consuming lines into the same "Secret" block. Everything after that line
     and before the real close is painted encrypted in the browser and stored
     verbatim in files.body / files_fts — searchable, and sent to the AI, with
     the BEGIN-AGE canary sitting harmlessly in the redacted half.

     `>` is not in `\s`, so `[\s>]*` on the close was exactly that hole.
     ---------------------------------------------------------------- */
  const CLOSERS: Array<[string, string]> = [
    ["> ```", "blockquoted close"],
    [">```", "blockquoted close, no space"],
    ["  > ```", "indented blockquoted close"],
    [">> ```", "twice-blockquoted close"],
  ];

  test("a close the renderer does not honour never ends the server's redaction", async () => {
    const { redact, redactForAi, ageFenceRanges } = await import("../server/vault");
    const LEAKED = ["ZZZZLEAKEDLINE", "QQQQALSOLEAKED"];

    for (const [closer, label] of CLOSERS) {
      /* precondition: the renderer walks straight past this line — its body
         loop is `while (!RE_FENCE.test(lines[i]))` */
      expect(`${label} closes the fence in the renderer: ${RE_FENCE.test(closer)}`).toBe(
        `${label} closes the fence in the renderer: false`
      );

      const md =
        "# doc\n\n```age\n" +
        ARMOR_HEAD + "\n" +
        ARMOR_B64_1 + "\n" +
        closer + "\n" +
        LEAKED.join("\n") + "\n" +
        "```\n\nAFTERMARKER\n";

      for (const line of LEAKED) {
        expect(`${label} → redact leaks ${line}: ${redact(md).includes(line)}`).toBe(
          `${label} → redact leaks ${line}: false`
        );
        expect(`${label} → redactForAi leaks ${line}: ${redactForAi(md).includes(line)}`).toBe(
          `${label} → redactForAi leaks ${line}: false`
        );
      }
      /* one region, and it runs to the fence the renderer actually stops at */
      const ranges = ageFenceRanges(md);
      expect(`${label} → ageFenceRanges found ${ranges.length}`).toBe(`${label} → ageFenceRanges found 1`);
      const covered = md.slice(ranges[0].start, ranges[0].end);
      for (const line of LEAKED) {
        expect(`${label} → ${line} is inside the guarded range: ${covered.includes(line)}`).toBe(
          `${label} → ${line} is inside the guarded range: true`
        );
      }
      /* …and the REAL close still ends it, or every doc loses its tail */
      expect(`${label} keeps its tail: ${redact(md).includes("AFTERMARKER")}`).toBe(`${label} keeps its tail: true`);
      expect(redact(md).split("\n").length).toBe(md.split("\n").length);
    }
  });

  /* The deliberate asymmetry, pinned so the fix above is not "solved" by
     narrowing the close everywhere: a fence whose OPENER is blockquoted is one
     the renderer never opened, so nothing can be falsely painted encrypted
     after it — and its close is blockquoted too. Refusing `>` there would
     blank the rest of the file. */
  test("a blockquoted fence — invisible to the renderer — still closes on its blockquoted fence", async () => {
    const { redact } = await import("../server/vault");
    const md =
      "# doc\n\n> ```age\n> " + ARMOR_HEAD + "\n> " + ARMOR_B64_1 + "\n> " + ARMOR_TAIL + "\n> ```\n\nQUOTEDTAILMARKER\n";
    expect(`the renderer opens a fence there: ${RE_FENCE.test("> ```age")}`).toBe(
      "the renderer opens a fence there: false"
    );
    const out = redact(md);
    for (const token of ARMOR_TOKENS) {
      expect(`blockquoted armor leaks ${token.slice(0, 18)}: ${out.includes(token)}`).toBe(
        `blockquoted armor leaks ${token.slice(0, 18)}: false`
      );
    }
    expect(`the tail survives: ${out.includes("QUOTEDTAILMARKER")}`).toBe("the tail survives: true");
  });

  test("…and those lines never reach sqlite, FTS or /api/search either", async () => {
    const path = "gap-close.md";
    const LEAKED = ["ZZZZLEAKEDLINE", "QQQQALSOLEAKED"];
    const md =
      "# Gap\n\n```age\n" + ARMOR_HEAD + "\n" + ARMOR_B64_1 + "\n> ```\n" + LEAKED.join("\n") + "\n```\n\nGAPCLOSEMARKER\n";

    const w = await srv.api("POST", "/api/docs", { path, type: "doc", markdown: md });
    expect(`POST ${path} → ${w.status}`).toBe(`POST ${path} → 201`);
    await sleep(200);

    const doc = await srv.get("/api/docs/" + encPath(path));
    expect(`${path} round-trips byte-for-byte: ${doc.body.markdown === md}`).toBe(
      `${path} round-trips byte-for-byte: true`
    );

    /* results only — the response echoes `query`, which is our own string */
    const lineHits = async (needle: string) => {
      const r = await srv.get(`/api/search?q=${encodeURIComponent(needle)}&limit=100`);
      return (r.body.results as any[]).filter((x) => x.kind === "line" && x.text.includes(needle));
    };
    for (const line of LEAKED) {
      expect(`search "${line}" returns it: ${(await lineHits(line)).length > 0}`).toBe(
        `search "${line}" returns it: false`
      );
    }
    // positive control: the doc IS indexed, so "absent" means redacted
    expect(`the doc is searchable at all: ${(await lineHits("GAPCLOSEMARKER")).length > 0}`).toBe(
      "the doc is searchable at all: true"
    );
  });

  test("…and the armor of such a doc never reaches sqlite, FTS or /api/search", async () => {
    const opener = "``` age";
    const path = "gap.md";
    const md = "# Gap\n\n" + opener + "\n" + ARMOR_HEAD + "\n" + ARMOR_B64_1 + "\n" + ARMOR_TAIL + "\n```\n\nGAPAFTERMARKER\n";
    const w = await srv.api("POST", "/api/docs", { path, type: "doc", markdown: md });
    expect(`POST ${path} → ${w.status}`).toBe(`POST ${path} → 201`);
    await sleep(200);

    const doc = await srv.get("/api/docs/" + encPath(path));
    expect(`${path} round-trips byte-for-byte: ${doc.body.markdown === md}`).toBe(
      `${path} round-trips byte-for-byte: true`
    );
    expect(`${path} reports hasSecrets: ${doc.body.hasSecrets}`).toBe(`${path} reports hasSecrets: true`);

    for (const q of ["BEGIN", "AGE", "ENCRYPTED", ARMOR_B64_1.slice(0, 12)]) {
      const r = await srv.get(`/api/search?q=${encodeURIComponent(q)}&limit=100`);
      for (const token of ARMOR_TOKENS) {
        expect(`search "${q}" leaks ${token.slice(0, 18)}: ${r.text.includes(token)}`).toBe(
          `search "${q}" leaks ${token.slice(0, 18)}: false`
        );
      }
    }
  });
});

/* ============================================================
   PHASE 3 — the same gate against a REAL age block.

   Everything above uses a hand-written armor lookalike, which is the right
   fixture for "can the redactor SEE the fence". It cannot answer the other
   half of the rule — plaintext never in any server-bound request — because
   there is no plaintext behind it.

   So: generate a vault identity, encrypt a canary string to it, and then look
   for that canary in every place the design says it can never be. The armor is
   the positive control throughout — it must be present in the note on disk and
   in the git object store, and absent from the index and from search, which is
   what makes "the canary is absent" mean something.
   ============================================================ */

const PT_CANARY = "PLAINTEXTCANARYWHICHMUSTNEVERESCAPE";
const REAL_PLAINTEXT = `AWS_SECRET_ACCESS_KEY=${PT_CANARY}\nregion=euwest\n`;


async function gitMust(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitIn(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** every regular file under `dir` as latin1 text, vault-relative path first */
function walkVault(dir: string): Array<[string, string]> {
  const glob = new Bun.Glob("**/*");
  const out: Array<[string, string]> = [];
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    out.push([rel, readFileSync(abs).toString("latin1")]);
  }
  return out;
}

describe("leak canary — a real age block (phase 3)", () => {
  const DOC = "keys/real.md";
  let vault = "";
  let real: TestServer;
  let identity = "";
  let realArmor = "";
  let docMd = "";

  beforeAll(async () => {
    identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const e = new age.Encrypter();
    e.addRecipient(recipient);
    realArmor = age.armor.encode(await e.encrypt(REAL_PLAINTEXT)).trimEnd();

    docMd =
      "# Real keys\n\nREALBEFOREMARKER prose above\n\n```age\n" +
      realArmor +
      "\n```\n\nREALAFTERMARKER prose below\n";

    vault = makeVault({
      "inbox.md": "# Inbox\n\nnothing yet\n",
      [DOC]: docMd,
      ".znotes/vault.pub": recipient + "\n",
      ".znotes/identity.age": realArmor, // shape-valid armor; nothing decrypts it here
    });

    /* a real repo, so the git object store is a surface we can inspect */
    await gitMust(vault, "init", "-b", "main");
    await gitMust(vault, "config", "user.name", "z-notes test");
    await gitMust(vault, "config", "user.email", "test@z-notes.invalid");
    await gitMust(vault, "config", "commit.gpgsign", "false");

    real = await startServer({ vault });
    await sleep(400);
  }, 60000);

  afterAll(async () => {
    if (real) await real.stop();
    if (vault) dropVault(vault);
  });

  test("the fixture is sound: the armor is on disk and really decrypts to the canary", async () => {
    expect(readFileSync(join(vault, DOC), "utf8")).toBe(docMd);
    expect(realArmor.startsWith(ARMOR_HEAD)).toBe(true);
    expect(realArmor.includes(PT_CANARY)).toBe(false);

    const d = new age.Decrypter();
    d.addIdentity(identity);
    const out = await d.decrypt(age.armor.decode(realArmor + "\n"), "text");
    expect(out).toBe(REAL_PLAINTEXT);

    const tree = await real.get("/api/docs");
    const row = flatten(tree.body.tree).find((n: any) => n.path === DOC);
    expect(row?.hasSecrets).toBe(true);
  }, 20000);

  test("neither the real armor nor the plaintext reaches /api/search", async () => {
    const queries = ["", "canary", "PLAINTEXTCANARY", "AWS", "region", "BEGIN AGE", "marker", "prose", "age"];
    for (const q of queries) {
      const r = await real.get("/api/search?q=" + encodeURIComponent(q) + "&limit=100");
      expect(`q=${q} → ${r.status}`).toBe(`q=${q} → 200`);
      const results = JSON.stringify(r.body.results);
      for (const token of [PT_CANARY, "AWS_SECRET_ACCESS_KEY", realArmor.split("\n")[1], ARMOR_HEAD]) {
        const label = `q=${q} / ${String(token).slice(0, 18)}`;
        expect(`${label}: ${contains(results, String(token))}`).toBe(`${label}: false`);
      }
    }
    /* positive control: the prose on both sides of the block is still indexed */
    for (const marker of ["REALBEFOREMARKER", "REALAFTERMARKER"]) {
      const r = await real.get("/api/search?q=" + marker + "&limit=100");
      const hit = r.body.results.find((x: any) => x.path === DOC && String(x.text ?? "").includes(marker));
      expect(`${marker} findable: ${!!hit}`).toBe(`${marker} findable: true`);
    }
  }, 30000);

  test("neither the armor nor the plaintext reaches sqlite", () => {
    const files = [
      join(vault, ".znotes", "index.db"),
      join(vault, ".znotes", "index.db-wal"),
      join(vault, ".znotes", "index.db-shm"),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);

    const blob = files.map((f) => readFileSync(f).toString("latin1")).join("\n");
    for (const token of [PT_CANARY, "AWS_SECRET_ACCESS_KEY", ARMOR_HEAD, realArmor.split("\n")[1]]) {
      const label = `${String(token).slice(0, 18)} in sqlite`;
      expect(`${label}: ${contains(blob, String(token))}`).toBe(`${label}: false`);
    }
    expect(contains(blob, "REALBEFOREMARKER")).toBe(true); // the doc really was indexed
  });

  test("the plaintext canary is in NO file under the vault — the armor is", () => {
    const files = walkVault(vault);
    expect(files.length).toBeGreaterThan(2);

    let sawArmor = 0;
    for (const [rel, bytes] of files) {
      expect(`${rel} carries the plaintext: ${contains(bytes, PT_CANARY)}`).toBe(
        `${rel} carries the plaintext: false`
      );
      if (contains(bytes, ARMOR_HEAD)) sawArmor++;
    }
    /* the note and the keyring file both hold armor — if the walk found none,
       the loop above proved nothing */
    expect(sawArmor).toBeGreaterThanOrEqual(2);
  });

  test("nothing the server printed carries the armor or the plaintext", () => {
    const out = real.stdoutLines.concat(real.stderrLines).join("\n");
    for (const token of [PT_CANARY, "AWS_SECRET_ACCESS_KEY", ARMOR_HEAD, "BEGIN AGE ENCRYPTED FILE"]) {
      const label = `${token.slice(0, 20)} in server output`;
      expect(`${label}: ${contains(out, token)}`).toBe(`${label}: false`);
    }
    expect(out.length).toBeGreaterThan(0); // the server did say something
  });

  test("after a sync, the git object store holds the armor and never the plaintext", async () => {
    const sync = await real.api("POST", "/api/sync/now", {});
    expect(sync.status).toBe(200);

    const tracked = (await gitMust(vault, "ls-files")).split("\n").map((s) => s.trim());
    expect(tracked).toContain(DOC);

    /* --batch decompresses every object, so this really reads the blobs */
    const objects = await gitMust(vault, "cat-file", "--batch-all-objects", "--batch");
    expect(objects.length).toBeGreaterThan(100);
    expect(contains(objects, ARMOR_HEAD)).toBe(true); // positive control
    expect(contains(objects, "REALBEFOREMARKER")).toBe(true); // …and the prose
    expect(contains(objects, PT_CANARY)).toBe(false);
    expect(contains(objects, "AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(contains(objects, identity)).toBe(false);
  }, 60000);

  test("the AI session surface never returns a secret's contents", async () => {
    /* nothing the client can reach may return, echo or store a secret's
       contents — asserted here without an upstream; the relay itself is the
       phase-4 describe below. */
    const sess = await real.get("/api/ai/sessions/current");
    expect(sess.status).toBe(200);
    expect(contains(sess.text, PT_CANARY)).toBe(false);
    expect(contains(sess.text, ARMOR_HEAD)).toBe(false);

    const props = await real.get("/api/ai/proposals");
    expect(props.status).toBe(200);
    expect(contains(props.text, PT_CANARY)).toBe(false);
    expect(contains(props.text, ARMOR_HEAD)).toBe(false);
  }, 30000);
});

/* ============================================================
   PHASE 4 — THE AI LEAK GATE: age armor never appears in AI relay payloads,
   and plaintext never in any server-bound request.

   Phase 3 could only assert the absence of a relay. Now there is one, and the
   only surface that settles the question is the set of request bodies the
   UPSTREAM actually received — recorded verbatim by tests/mock-upstream.ts.

   Three distinct claims, each with its own failure mode:

     1. Assembly redacts. A normal turn over a doc with a real age block sends
        the ⟪secret …⟫ placeholder and neither the armor nor the plaintext
        behind it. (The placeholder is a positive control: "sent nothing at
        all" would pass an absence-only test.)
     2. The canary is belt-and-braces. A doc carrying armor the fence grammar
        cannot see — bare armor, no ```age fence — must STILL never reach the
        upstream: the relay refuses the payload outright. This is
        the one check that does not depend on the redactor being right.
     3. Nothing comes back in. An upstream that ECHOES armor inside a
        propose_edits call gets it rejected: no proposal, no write, and no
        armor in the proposal rows sqlite keeps.
   ============================================================ */

const ECHO_MARKER = "RUNITzBFQ0hPTUFSS0VSMDA5OQ=="; // unique to the sabotage payload
const DECOY_PLAINTEXT = "DECOYPLAINTEXTNEVERINDEXED";

describe("leak canary — the AI relay (phase 4)", () => {
  const DOC = "keys/ai-real.md";
  const NEIGHBOUR = "notes/links-to-keys.md";
  const BARE = "keys/bare-armor.md";
  const TARGET = "notes/ai-target.md";
  const TARGET_MD = "# Target\n\na plain line the assistant may edit\n";

  let vault = "";
  let srv: TestServer;
  let mock: MockUpstream;
  let identity = "";
  let realArmor = "";
  let bareArmor = "";
  let docMd = "";

  beforeAll(async () => {
    identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const enc = (plaintext: string) => {
      const e = new age.Encrypter();
      e.addRecipient(recipient);
      return e.encrypt(plaintext).then((b) => age.armor.encode(b).trimEnd());
    };
    realArmor = await enc(REAL_PLAINTEXT);
    bareArmor = await enc(DECOY_PLAINTEXT + "\n");

    docMd =
      "# Real keys\n\nAIBEFOREMARKER prose above\n\n```age\n" + realArmor + "\n```\n\nAIAFTERMARKER prose below\n";

    vault = makeVault({
      "inbox.md": "# Inbox\n\nnothing yet\n",
      [DOC]: docMd,
      [NEIGHBOUR]: "# Neighbour\n\nLinks to [[ai-real]] so depth-1 assembly pulls it in.\n",
      [TARGET]: TARGET_MD,
      ".znotes/vault.pub": recipient + "\n",
      ".znotes/identity.age": realArmor,
    });

    mock = await startMockUpstream();
    srv = await startServer({ vault });
    const put = await srv.api("PUT", "/api/settings", {
      ai: { baseUrl: mock.baseUrl, apiKey: "sk-leakgate-key", model: "gpt-5", effort: "high" },
      git: { autoSyncSeconds: 600 },
    });
    expect(put.status).toBe(200);
    await sleep(400);
    mock.reset();
  }, 60000);

  afterAll(async () => {
    if (srv) await srv.stop();
    if (mock) await mock.stop();
    if (vault) dropVault(vault);
  });

  const armorTokens = () => [
    ARMOR_HEAD,
    ARMOR_TAIL,
    "BEGIN AGE ENCRYPTED FILE",
    realArmor.split("\n")[1],
    realArmor.split("\n")[2] ?? realArmor.split("\n")[1],
    bareArmor.split("\n")[1],
  ];

  test("the fixture is sound: the armor decrypts to the canary and the vault reports a secret", async () => {
    expect(realArmor.startsWith(ARMOR_HEAD)).toBe(true);
    expect(contains(realArmor, PT_CANARY)).toBe(false);
    const d = new age.Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(age.armor.decode(realArmor + "\n"), "text")).toBe(REAL_PLAINTEXT);

    const tree = await srv.get("/api/docs");
    const row = flatten(tree.body.tree).find((n: any) => n.path === DOC);
    expect(`${DOC} hasSecrets: ${row?.hasSecrets}`).toBe(`${DOC} hasSecrets: true`);
  }, 30000);

  test("a turn over the secret doc sends the placeholder — never the armor, never the plaintext", async () => {
    mock.script(reply.text("There is one encrypted block in that note; I cannot read it."));
    const s = await turn(srv, { content: "summarise my keys note", docPath: DOC });
    expect(`the turn completed: ${s.closed}`).toBe("the turn completed: true");

    const req = mock.streamed()[0];
    expect(`the relay called upstream: ${!!req}`).toBe("the relay called upstream: true");

    /* positive control first: the doc really was assembled */
    expect(`the doc's prose was sent: ${req.strings.includes("AIBEFOREMARKER")}`).toBe(
      "the doc's prose was sent: true"
    );
    expect(`the tail after the block was sent: ${req.strings.includes("AIAFTERMARKER")}`).toBe(
      "the tail after the block was sent: true"
    );
    /* …and the block became a placeholder rather than silence (research §6.1) */
    expect(`the ⟪secret⟫ placeholder was sent: ${req.strings.includes("⟪secret")}`).toBe(
      "the ⟪secret⟫ placeholder was sent: true"
    );

    for (const token of [...armorTokens(), PT_CANARY, "AWS_SECRET_ACCESS_KEY", identity]) {
      const label = `upstream body carries ${String(token).slice(0, 22)}`;
      expect(`${label}: ${req.bodyText.includes(String(token)) || req.strings.includes(String(token))}`).toBe(
        `${label}: false`
      );
    }
  }, 40000);

  test("neither a vault-wide question nor a neighbouring doc drags the armor in", async () => {
    mock.script(reply.text("Nothing found."), reply.text("Nothing found either."));
    await turn(srv, { content: "search my whole vault for anything encrypted or secret", docPath: TARGET });
    await turn(srv, { content: "what does the neighbour note link to?", docPath: NEIGHBOUR });

    expect(mock.streamed().length).toBeGreaterThanOrEqual(2);
    for (const token of [...armorTokens(), PT_CANARY, "AWS_SECRET_ACCESS_KEY"]) {
      expect(`any request carries ${String(token).slice(0, 22)}: ${mock.sawText(String(token))}`).toBe(
        `any request carries ${String(token).slice(0, 22)}: false`
      );
    }
  }, 40000);

  /* ---- 2. nothing comes back in ----
     (run before the bare-armor sabotage below, so this turn is guaranteed to
     reach the upstream at all rather than being refused for another reason) */
  test("an upstream that ECHOES armor into propose_edits is rejected — no proposal, no write, no sqlite row", async () => {
    const before = readFileSync(join(vault, TARGET), "utf8");
    const poisoned = "```age\n" + ARMOR_HEAD + "\n" + ECHO_MARKER + "\n" + ARMOR_TAIL + "\n```\n";

    const sabotage = () =>
      proposeEdits("smuggle a block back in", {
        op: "replace",
        path: TARGET,
        find: "a plain line the assistant may edit",
        replace: poisoned,
      });
    const mark = mock.mark();
    mock.script(sabotage(), sabotage(), sabotage());
    mock.setDefault(sabotage());

    const s = await turn(srv, { content: "reword that plain line", docPath: TARGET });

    /* the sabotage really was delivered — otherwise nothing below is a test */
    expect(`the upstream was reached: ${mock.streamed(mark).length >= 1}`).toBe("the upstream was reached: true");

    expect(`a proposal was made from echoed armor: ${s.done()?.proposal ?? null}`).toBe(
      "a proposal was made from echoed armor: null"
    );
    expect(`${TARGET} was written: ${readFileSync(join(vault, TARGET), "utf8") !== before}`).toBe(
      `${TARGET} was written: false`
    );

    const props = await srv.get("/api/ai/proposals");
    expect(props.status).toBe(200);
    for (const token of [ARMOR_HEAD, ARMOR_TAIL, ECHO_MARKER]) {
      expect(`GET /api/ai/proposals carries ${token.slice(0, 22)}: ${contains(props.text, token)}`).toBe(
        `GET /api/ai/proposals carries ${token.slice(0, 22)}: false`
      );
    }
    /* the echoed block is never replayed back out either */
    expect(`upstream got the echo back: ${mock.sawText(ECHO_MARKER)}`).toBe("upstream got the echo back: false");
  }, 40000);

  /* ---- 3. the belt-and-braces canary ---- */
  test("armor the fence grammar cannot see is REFUSED, not sent", async () => {
    /* no ```age fence anywhere: the structural redactor has nothing to key on,
       so only the payload canary can stop this */
    const created = await srv.api("POST", "/api/docs", {
      path: BARE,
      type: "doc",
      markdown: "# Bare\n\nBAREBEFOREMARKER\n\n" + bareArmor + "\n\nBAREAFTERMARKER\n",
    });
    expect(`create ${BARE} → ${created.status}`).toBe(`create ${BARE} → 201`);
    await sleep(500);

    mock.setDefault(reply.text("should never be reached with armor in the payload"));
    const s = await turn(srv, { content: "what is in the bare note?", docPath: BARE });

    /* whatever it did — refuse the turn or redact harder — the wire is clean */
    for (const token of [ARMOR_HEAD, ARMOR_TAIL, "BEGIN AGE ENCRYPTED FILE", bareArmor.split("\n")[1]]) {
      expect(`upstream saw ${token.slice(0, 22)}: ${mock.sawText(token)}`).toBe(
        `upstream saw ${token.slice(0, 22)}: false`
      );
    }
    /* and it did not hang: the client got an answer or an error, and the
       stream closed either way */
    expect(`the stream terminated: ${s.closed}`).toBe("the stream terminated: true");
    expect(`the client heard something: ${s.errors().length > 0 || !!s.done()}`).toBe(
      "the client heard something: true"
    );
  }, 40000);


  test("sqlite holds no plaintext, no real armor and no rejected edit body", () => {
    const files = [
      join(vault, ".znotes", "index.db"),
      join(vault, ".znotes", "index.db-wal"),
      join(vault, ".znotes", "index.db-shm"),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    const blob = files.map((f) => readFileSync(f).toString("latin1")).join("\n");

    for (const token of [PT_CANARY, "AWS_SECRET_ACCESS_KEY", realArmor.split("\n")[1], ECHO_MARKER]) {
      expect(`${String(token).slice(0, 22)} in sqlite: ${contains(blob, String(token))}`).toBe(
        `${String(token).slice(0, 22)} in sqlite: false`
      );
    }
    /* the docs really were indexed — otherwise the loop above proved nothing */
    expect(contains(blob, "AIBEFOREMARKER")).toBe(true);
  });

  test("nothing the relay printed carries the armor or the plaintext", () => {
    const out = srv.stdoutLines.concat(srv.stderrLines).join("\n");
    for (const token of [PT_CANARY, "AWS_SECRET_ACCESS_KEY", realArmor.split("\n")[1], identity]) {
      const label = `${String(token).slice(0, 22)} in server output`;
      expect(`${label}: ${contains(out, String(token))}`).toBe(`${label}: false`);
    }
    expect(out.length).toBeGreaterThan(0);
  });
});

/* ============================================================
   PHASE 5 — THE TERMINAL: the leak canary over the command runner.

   The command runner is the most direct route from arbitrary vault bytes into
   the model's context that this app has: the model chooses a shell line, the
   output is PERSISTED, and every later turn replays the last few records into
   the assembled context. `cat` of a note with an age block — the exact thing
   the terminal is advertised for — therefore has to be checked here and not
   only in terminal.test.ts, which knows nothing about armor.

   Two failures, one input:

     1. the leak. Armor in a command transcript is armor in sqlite (the same
        file the gate greps above) and armor in an AI payload.
     2. the wedge. The relay's canary refuses any payload carrying armor, and
        the command records are replayed into EVERY assembled context — so ONE
        armored transcript used to end the assistant permanently, in every
        session including brand-new ones, with no recovery short of deleting
        index.db. The turn AFTER the command is what proves that is gone.
   ============================================================ */

describe("leak canary — the terminal runner (phase 5)", () => {
  const DOC = "keys/terminal-real.md";
  const PASSWORD = "TERMLEAK-pw-31c4a9f2";

  let vault = "";
  let tsrv: TestServer;
  let tmock: MockUpstream;
  let identity = "";
  let armor = "";
  let token = "";

  const armorTokens = () => [ARMOR_HEAD, ARMOR_TAIL, "BEGIN AGE ENCRYPTED FILE", ...armor.split("\n").slice(1, 3)];

  const auth = () => ({ headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const e = new age.Encrypter();
    e.addRecipient(recipient);
    armor = age.armor.encode(await e.encrypt(REAL_PLAINTEXT)).trimEnd();

    vault = makeVault({
      "inbox.md": "# Inbox\n\nTERMINBOXMARKER — an ordinary note\n",
      [DOC]: "# Real keys\n\nTERMBEFOREMARKER prose\n\n```age\n" + armor + "\n```\n\nTERMAFTERMARKER prose\n",
    });

    tmock = await startMockUpstream();
    tsrv = await startServer({ vault });
    const put = await tsrv.api("PUT", "/api/settings", {
      ai: { baseUrl: tmock.baseUrl, apiKey: "sk-termleak-key", model: "gpt-5", effort: "high" },
      git: { autoSyncSeconds: 600 },
      terminal: { allowAiAutoRun: false },
    });
    expect(`PUT /api/settings → ${put.status}`).toBe("PUT /api/settings → 200");
    const pw = await tsrv.api("POST", "/api/terminal/password", { password: PASSWORD });
    expect(`set terminal password → ${pw.status}`).toBe("set terminal password → 200");
    const un = await tsrv.api("POST", "/api/terminal/unlock", { password: PASSWORD });
    expect(`unlock → ${un.status}`).toBe("unlock → 200");
    token = un.body.token;
    await sleep(400);
    tmock.reset();
  }, 60000);

  afterAll(async () => {
    if (tsrv) await tsrv.stop();
    if (tmock) await tmock.stop();
    if (vault) dropVault(vault);
  });

  /** read an SSE body to the end and hand back every byte of it */
  async function drain(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let raw = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
    return raw;
  }

  test("the fixture is sound: the armor is real and the doc reports a secret", async () => {
    expect(armor.startsWith(ARMOR_HEAD)).toBe(true);
    const d = new age.Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(age.armor.decode(armor + "\n"), "text")).toBe(REAL_PLAINTEXT);
    const tree = await tsrv.get("/api/docs");
    const row = flatten(tree.body.tree).find((n: any) => n.path === DOC);
    expect(`${DOC} hasSecrets: ${row?.hasSecrets}`).toBe(`${DOC} hasSecrets: true`);
  }, 30000);

  test("a command the USER approves may print armor to the user — and to nobody else", async () => {
    const mark = tmock.mark();
    /* exactly ONE reply: with the shipped default the turn STOPS at the tool
       call, so a second scripted reply would sit in the shared queue and answer
       the next turn instead */
    tmock.script(reply.tool({ command: `cat ${DOC}`, why: "read the keys note" }, { name: "run_command" }));
    await turn(tsrv, { content: "show me my keys note through the terminal" });

    const list = await tsrv.api("GET", "/api/terminal/commands", undefined, auth());
    expect(`one command is waiting: ${list.body.commands.length} / ${list.body.commands[0]?.state}`).toBe(
      "one command is waiting: 1 / pending"
    );
    const rec = list.body.commands[0];

    /* the user presses Run. THEIR stream is their own file — this is the
       positive control that the command really ran and really printed it. */
    const ran = await drain(
      await fetch(tsrv.url(`/api/terminal/commands/${rec.id}/run`), {
        method: "POST",
        headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
      })
    );
    expect(`the user saw the armor in their own scrollback: ${ran.includes(ARMOR_HEAD)}`).toBe(
      "the user saw the armor in their own scrollback: true"
    );

    /* …and the RECORD, which is durable and replayed into every later model
       context, carries a withheld marker instead */
    const after = await tsrv.api("GET", "/api/terminal/commands", undefined, auth());
    const done = after.body.commands[0];
    expect(`state / exit: ${done.state} / ${done.exitCode}`).toBe("state / exit: done / 0");
    expect(`the record says it was withheld: ${/withheld/.test(String(done.output))}`).toBe(
      "the record says it was withheld: true"
    );
    for (const t of armorTokens()) {
      expect(`the record carries ${t.slice(0, 22)}: ${contains(String(done.output), t)}`).toBe(
        `the record carries ${t.slice(0, 22)}: false`
      );
    }
    /* nothing armored went upstream during any of this */
    for (const t of [...armorTokens(), PT_CANARY]) {
      expect(`upstream saw ${String(t).slice(0, 22)}: ${tmock.sawText(String(t), mark)}`).toBe(
        `upstream saw ${String(t).slice(0, 22)}: false`
      );
    }
  }, 60000);

  test("the NEXT turn still works — one armored command does not end the assistant", async () => {
    /* The whole point. `commandContext()` replays the last six records into
       every assembled context, and the canary refuses any payload with armor in
       it — so an armored transcript used to make every later turn fail before
       the request was even built, in this session and in every new one. */
    const mark = tmock.mark();
    tmock.script(reply.text("Your inbox has one note."));
    const s = await turn(tsrv, { content: "what is in my inbox?" });

    expect(`the relay called upstream: ${tmock.streamed(mark).length}`).toBe("the relay called upstream: 1");
    expect(`errors: ${JSON.stringify(s.errors().map((e: any) => e.code ?? e.message ?? e))}`).toBe("errors: []");
    expect(`the turn produced an answer: ${!!s.done()}`).toBe("the turn produced an answer: true");

    /* the command block really is in the context — otherwise "it did not wedge"
       would be satisfied by not sending the records at all */
    const sent = tmock.streamed(mark)[0];
    expect(`the context replays the command: ${sent.strings.includes(`cat ${DOC}`)}`).toBe(
      "the context replays the command: true"
    );
    expect(`…with the output withheld: ${/withheld/.test(sent.strings)}`).toBe("…with the output withheld: true");

    /* and a BRAND NEW session — the state a user reaches for when something
       looks stuck — is not poisoned either */
    const fresh = await tsrv.api("POST", "/api/ai/sessions", {});
    expect(`new session → ${fresh.status}`).toBe("new session → 201");
    const mark2 = tmock.mark();
    tmock.script(reply.text("Still here."));
    const s2 = await turn(tsrv, { content: "hello again" });
    expect(`the new session reached upstream: ${tmock.streamed(mark2).length}`).toBe(
      "the new session reached upstream: 1"
    );
    expect(`new-session errors: ${JSON.stringify(s2.errors().map((e: any) => e.code ?? e))}`).toBe(
      "new-session errors: []"
    );
  }, 60000);

  test("auto-run sends the tool result in-turn — still without the armor", async () => {
    const on = await tsrv.api("PUT", "/api/settings", { terminal: { allowAiAutoRun: true } });
    expect(`allowAiAutoRun → ${on.status}`).toBe("allowAiAutoRun → 200");

    const mark = tmock.mark();
    tmock.script(
      reply.tool({ command: `cat ${DOC}`, why: "read it myself" }, { name: "run_command" }),
      reply.text("I could not read the encrypted part.")
    );
    await turn(tsrv, { content: "read my keys note yourself" });

    expect(`the tool result went upstream: ${tmock.streamed(mark).length}`).toBe("the tool result went upstream: 2");
    expect(`the model was told it ran: ${tmock.sawText('"status":"ran"', mark)}`).toBe(
      "the model was told it ran: true"
    );
    for (const t of [...armorTokens(), PT_CANARY]) {
      expect(`upstream saw ${String(t).slice(0, 22)}: ${tmock.sawText(String(t), mark)}`).toBe(
        `upstream saw ${String(t).slice(0, 22)}: false`
      );
    }
  }, 60000);

  test("no armor reached sqlite through the command records, and none was printed", async () => {
    const files = [
      join(vault, ".znotes", "index.db"),
      join(vault, ".znotes", "index.db-wal"),
      join(vault, ".znotes", "index.db-shm"),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    const blob = files.map((f) => readFileSync(f).toString("latin1")).join("\n");
    for (const t of [...armorTokens(), PT_CANARY, "AWS_SECRET_ACCESS_KEY"]) {
      expect(`${String(t).slice(0, 22)} in sqlite: ${contains(blob, String(t))}`).toBe(
        `${String(t).slice(0, 22)} in sqlite: false`
      );
    }
    /* the records really are in there — otherwise the loop proved nothing */
    expect(`the command rows exist: ${contains(blob, "cat " + DOC)}`).toBe("the command rows exist: true");

    const out = tsrv.stdoutLines.concat(tsrv.stderrLines).join("\n");
    for (const t of [...armorTokens(), PT_CANARY]) {
      expect(`${String(t).slice(0, 22)} in the server log: ${contains(out, String(t))}`).toBe(
        `${String(t).slice(0, 22)} in the server log: false`
      );
    }
  }, 30000);
});

function flatten(nodes: any[]): any[] {
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list ?? []) {
      out.push(n);
      if (n.type === "folder") walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/* ============================================================
   PHASE 6 — THE LEAK CANARY WITH THE VAULT OPEN

   Every canary above runs against a vault nobody has unlocked: the plaintext
   exists only inside an armor blob on disk, so "the canary is nowhere" is a
   claim about a string that was never in memory in the first place.

   Unlocking is VAULT-WIDE now. One passphrase and every block in every doc the
   user visits is decrypted and painted into the document — which means the
   plaintext really is live, in a browser, in the same tab that autosaves the
   file, feeds the search index and talks to the AI relay. That is the state the
   leak rule has to survive, and the only honest way to assert it is to reach it:
   a real Chromium, the real worker, the real passphrase.

   The positive control is the whole point of the setup: the first test proves
   the canary IS on screen. Every assertion after it says that this is the ONLY
   place it ever got to — not sqlite, not FTS, not /api/search, not an upstream
   payload, not the server's own output, and not one request the browser sent.
   ============================================================ */

describe("leak canary — the vault is OPEN and every block is revealed (phase 6)", () => {
  const DOC = "keys/revealed.md";
  const PASS = "correct horse battery staple mango velvet";
  /* the SECOND canary: what the user types INTO a revealed block. It exists
     only in the DOM and in the worker, and the only thing that may ever leave
     the tab carrying it is fresh armor. */
  const EDIT_CANARY = "EDITEDINTOTHEREVEALCANARY";

  let vault = "";
  let bsrv: TestServer;
  let mock: MockUpstream;
  let browser: Browser;
  let page: Page;
  let identity = "";
  let wrapped = "";
  let realArmor = "";
  let docMd = "";

  /** every non-GET request the BROWSER made, body included */
  const sent: Array<{ method: string; url: string; body: string }> = [];

  beforeAll(async () => {
    identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const w = new age.Encrypter();
    w.setPassphrase(PASS);
    w.setScryptWorkFactor(18);
    wrapped = age.armor.encode(await w.encrypt(identity));

    const e = new age.Encrypter();
    e.addRecipient(recipient);
    realArmor = age.armor.encode(await e.encrypt(REAL_PLAINTEXT)).trimEnd();

    docMd =
      "# Revealed keys\n\nREVEALEDBEFOREMARKER prose above\n\n```age\n" +
      realArmor +
      "\n```\n\nREVEALEDAFTERMARKER prose below\n";

    vault = makeVault({
      "inbox.md": "# Inbox\n\nnothing yet\n",
      [DOC]: docMd,
      ".znotes/identity.age": wrapped,
      ".znotes/vault.pub": recipient + "\n",
    });

    mock = await startMockUpstream();
    bsrv = await startServer({ vault });
    const put = await bsrv.api("PUT", "/api/settings", {
      ai: { baseUrl: mock.baseUrl, apiKey: "sk-revealgate-key", model: "gpt-5", effort: "high" },
      editor: { autosaveSeconds: 1 },
      git: { autoSyncSeconds: 600 },
    });
    expect(put.status).toBe(200);
    await sleep(400);
    mock.reset();

    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on("request", (req) => {
      const m = req.method().toUpperCase();
      if (m === "GET" || m === "HEAD") return;
      sent.push({ method: m, url: req.url(), body: req.postData() ?? "" });
    });
    await page.goto(bsrv.base + "/", { waitUntil: "domcontentloaded" });
    await waitForApp(page, 25000);
  }, 120000);

  afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    if (bsrv) await bsrv.stop();
    if (mock) await mock.stop();
    if (vault) dropVault(vault);
  });

  const tokens = () => [
    ARMOR_HEAD,
    ARMOR_TAIL,
    "BEGIN AGE ENCRYPTED FILE",
    realArmor.split("\n")[1],
    realArmor.split("\n")[2] ?? realArmor.split("\n")[1],
  ];

  /** the canaries that exist only as plaintext, and may never be anywhere */
  const plaintexts = () => [PT_CANARY, "AWS_SECRET_ACCESS_KEY", EDIT_CANARY, PASS, identity, "AGE-SECRET-KEY"];

  const sqliteBlob = () => {
    const files = [
      join(vault, ".znotes", "index.db"),
      join(vault, ".znotes", "index.db-wal"),
      join(vault, ".znotes", "index.db-shm"),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    return files.map((f) => readFileSync(f).toString("latin1")).join("\n");
  };

  test("the vault really opens, and the canary really is on screen (the positive control)", async () => {
    await page.click(`#tree .row.file[data-doc="${DOC}"]`);
    await page.waitForFunction((p) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, DOC);

    /* one Unlock, one passphrase — and the whole vault opens */
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".secret button")].find((n) => /unlock/i.test(n.textContent ?? ""));
      if (!b) return false;
      (b as HTMLButtonElement).click();
      return true;
    });
    expect(`the block offered an Unlock: ${clicked}`).toBe("the block offered an Unlock: true");

    await page.waitForFunction(() => document.getElementById("ppVeil")!.classList.contains("show"), { timeout: 15000 });
    await page.evaluate(() => {
      const i = document.getElementById("ppInput") as HTMLInputElement;
      i.value = "";
      i.focus();
    });
    await page.keyboard.type(PASS);
    await page.click('#ppVeil [data-act="pp-ok"]');
    await page.waitForFunction(() => !!document.querySelector(".secret.open"), { timeout: 60000 });

    /* THE POSITIVE CONTROL: without this, every absence below is satisfied by a
       vault that simply never opened */
    const shown = await page.evaluate(
      () => (document.querySelector(".secret.open textarea") as HTMLTextAreaElement | null)?.value ?? ""
    );
    expect(`the plaintext is live in the DOM: ${shown.includes(PT_CANARY)}`).toBe(
      "the plaintext is live in the DOM: true"
    );
    /* …and the ciphertext is NOT, which is the other half of the rule */
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    expect(`the armor is on screen too: ${html.includes(ARMOR_HEAD)}`).toBe("the armor is on screen too: false");
  }, 120000);

  test("a save with every block revealed writes armor — and sqlite never sees the canary", async () => {
    /* the file is re-read and re-indexed by this write, which is the moment the
       indexer would swallow a plaintext if the client had sent one */
    await pressChord(page, "KeyS");
    await sleep(1200);

    const onDisk = readFileSync(join(vault, DOC), "utf8");
    expect(`the file still holds its armor: ${onDisk.includes(realArmor)}`).toBe(
      "the file still holds its armor: true"
    );
    expect(`the file grew a plaintext: ${onDisk.includes(PT_CANARY)}`).toBe("the file grew a plaintext: false");
    expect(`nothing else moved: ${onDisk === docMd}`).toBe("nothing else moved: true");

    const blob = sqliteBlob();
    for (const t of [...plaintexts(), ...tokens()]) {
      expect(`${String(t).slice(0, 22)} in sqlite: ${contains(blob, String(t))}`).toBe(
        `${String(t).slice(0, 22)} in sqlite: false`
      );
    }
    /* the doc really is indexed — otherwise the loop above proves nothing */
    expect(contains(blob, "REVEALEDBEFOREMARKER")).toBe(true);
  }, 60000);

  test("the search index answers about the prose and knows nothing of the plaintext", async () => {
    for (const q of ["", "canary", PT_CANARY, "AWS", "SECRET", "region", "euwest", "BEGIN AGE", "revealed"]) {
      const r = await bsrv.get("/api/search?q=" + encodeURIComponent(q) + "&limit=100");
      expect(`q=${q} → ${r.status}`).toBe(`q=${q} → 200`);
      const results = JSON.stringify(r.body.results);
      for (const t of [...plaintexts(), ...tokens()]) {
        const label = `q=${q} / ${String(t).slice(0, 18)}`;
        expect(`${label}: ${contains(results, String(t))}`).toBe(`${label}: false`);
      }
    }
    /* positive controls: the prose on both sides of the block is still findable */
    for (const marker of ["REVEALEDBEFOREMARKER", "REVEALEDAFTERMARKER"]) {
      const r = await bsrv.get("/api/search?q=" + marker + "&limit=100");
      const hit = r.body.results.find((x: any) => x.path === DOC && String(x.text ?? "").includes(marker));
      expect(`${marker} findable: ${!!hit}`).toBe(`${marker} findable: true`);
    }
  }, 60000);

  test("a turn over the revealed doc sends the placeholder — the relay reads STORED markdown", async () => {
    mock.script(reply.text("There is one encrypted block in that note; I cannot read it."));
    const s = await turn(bsrv, { content: "summarise my revealed keys note", docPath: DOC });
    expect(`the turn completed: ${s.closed}`).toBe("the turn completed: true");

    const req = mock.streamed()[0];
    expect(`the relay called upstream: ${!!req}`).toBe("the relay called upstream: true");
    /* positive controls: the doc really was assembled, block replaced by a
       placeholder rather than by silence */
    expect(`the prose was sent: ${req.strings.includes("REVEALEDBEFOREMARKER")}`).toBe("the prose was sent: true");
    expect(`the ⟪secret⟫ placeholder was sent: ${req.strings.includes("⟪secret")}`).toBe(
      "the ⟪secret⟫ placeholder was sent: true"
    );

    for (const t of [...plaintexts(), ...tokens()]) {
      const label = `upstream body carries ${String(t).slice(0, 22)}`;
      expect(`${label}: ${req.bodyText.includes(String(t)) || req.strings.includes(String(t))}`).toBe(
        `${label}: false`
      );
    }
  }, 60000);

  test("editing a revealed block re-encrypts: the typed canary never leaves the tab", async () => {
    /* the one thing that is allowed to change the file while the vault is open,
       and the only thing that may carry the typed plaintext anywhere is FRESH
       ARMOR that decrypts to it */
    await page.evaluate(() => {
      const ta = document.querySelector(".secret.open textarea") as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await page.keyboard.type("\n" + EDIT_CANARY + "=yes\n");

    const armorNow = await waitUntil(
      () => {
        const t = readFileSync(join(vault, DOC), "utf8");
        const m = t.match(/```age\n([\s\S]*?)\n```/);
        const body = m ? m[1] : "";
        return body && body !== realArmor ? body : null;
      },
      { timeout: 20000, label: "the autosave to write re-encrypted armor" }
    );

    /* it really is the edit, and it really is encrypted */
    const d = new age.Decrypter();
    d.addIdentity(identity);
    const round = await d.decrypt(age.armor.decode(armorNow + "\n"), "text");
    expect(`the new armor decrypts to the edit: ${round.includes(EDIT_CANARY)}`).toBe(
      "the new armor decrypts to the edit: true"
    );

    const onDisk = readFileSync(join(vault, DOC), "utf8");
    expect(`the typed canary is on disk in the clear: ${contains(onDisk, EDIT_CANARY)}`).toBe(
      "the typed canary is on disk in the clear: false"
    );

    await sleep(1200); // let the write settle through the indexer
    const blob = sqliteBlob();
    for (const t of plaintexts()) {
      expect(`${String(t).slice(0, 22)} in sqlite after the edit: ${contains(blob, String(t))}`).toBe(
        `${String(t).slice(0, 22)} in sqlite after the edit: false`
      );
    }
    const search = await bsrv.get("/api/search?q=" + EDIT_CANARY + "&limit=100");
    expect(`the typed canary is searchable: ${contains(JSON.stringify(search.body.results), EDIT_CANARY)}`).toBe(
      "the typed canary is searchable: false"
    );
  }, 90000);

  test("not one request the BROWSER sent carried a plaintext, at any point", () => {
    expect(sent.length).toBeGreaterThan(0);
    /* the armor is expected in these bodies — that is the contract. The
       plaintexts are not, and this is the surface the whole model rests on:
       the tab holds them and the wire never does. */
    expect(`some PUT carried armor: ${sent.some((r) => r.body.includes("BEGIN AGE ENCRYPTED FILE"))}`).toBe(
      "some PUT carried armor: true"
    );
    for (const r of sent) {
      const where = `${r.method} ${new URL(r.url).pathname}`;
      for (const t of plaintexts()) {
        const label = `${where} / ${String(t).slice(0, 20)}`;
        expect(`${label}: ${(r.body + r.url).includes(String(t)) ? "LEAKED" : "clean"}`).toBe(`${label}: clean`);
      }
    }
  }, 30000);

  test("nothing the server printed carries the armor or any plaintext", () => {
    const out = bsrv.stdoutLines.concat(bsrv.stderrLines).join("\n");
    expect(out.length).toBeGreaterThan(0); // the server did say something
    for (const t of [...plaintexts(), ...tokens()]) {
      expect(`${String(t).slice(0, 22)} in the server log: ${contains(out, String(t))}`).toBe(
        `${String(t).slice(0, 22)} in the server log: false`
      );
    }
  }, 30000);

  test("no file under the vault holds a plaintext — the armor is the only copy", () => {
    const files = walkVault(vault);
    expect(files.length).toBeGreaterThan(2);
    let sawArmor = 0;
    for (const [rel, bytes] of files) {
      for (const t of [PT_CANARY, EDIT_CANARY, PASS, identity]) {
        expect(`${rel} carries ${String(t).slice(0, 18)}: ${contains(bytes, String(t))}`).toBe(
          `${rel} carries ${String(t).slice(0, 18)}: false`
        );
      }
      if (contains(bytes, ARMOR_HEAD)) sawArmor++;
    }
    /* the note and the wrapped identity both hold armor — if the walk found
       none, the loop above proved nothing */
    expect(sawArmor).toBeGreaterThanOrEqual(2);
  }, 30000);
});
