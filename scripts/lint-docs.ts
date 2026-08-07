/* ============================================================
   lint-docs.ts — mechanical enforcement of the agent-first repo shape.

   Run: `bun run lint:docs` (CI runs it in the hygiene job). Every failure
   message says how to repair it, because the reader of CI output is usually
   an agent. Checks:

     1. AGENTS.md exists and stays ≤ 100 lines (a map, not a manual)
     2. CLAUDE.md is exactly the @AGENTS.md pointer
     3. every relative link in AGENTS.md and docs/ resolves to a real file
     4. specs in docs/specs/{open,done} carry all seven template sections
     5. server/ layering is forward-only (the table below IS the law;
        docs/architecture.md restates it for humans — keep both in sync)
     6. app/ leaf modules import only leaves; no `export let` in app/
   ============================================================ */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
let failures = 0;
const fail = (file: string, msg: string, repair: string) => {
  failures++;
  console.error(`✗ ${file}: ${msg}\n  repair: ${repair}`);
};

/* ---------- 1. AGENTS.md size ---------- */
const agentsPath = join(ROOT, "AGENTS.md");
if (!existsSync(agentsPath)) {
  fail("AGENTS.md", "missing", "restore the hand-written ≤100-line map (see docs/architecture.md for content pointers); never LLM-generate it wholesale");
} else {
  const lines = readFileSync(agentsPath, "utf8").split("\n").length;
  if (lines > 100)
    fail("AGENTS.md", `${lines} lines (limit 100)`, "move knowledge into docs/ and leave a pointer; AGENTS.md is a map, not a manual");
}

/* ---------- 2. CLAUDE.md pointer ---------- */
const claudePath = join(ROOT, "CLAUDE.md");
if (!existsSync(claudePath)) {
  fail("CLAUDE.md", "missing", 'create it containing exactly one line: "@AGENTS.md"');
} else {
  const first = readFileSync(claudePath, "utf8").trim();
  if (first !== "@AGENTS.md")
    fail("CLAUDE.md", `contains ${JSON.stringify(first.slice(0, 60))}`, 'CLAUDE.md must be exactly "@AGENTS.md" — put content in AGENTS.md or docs/, not here');
}

/* ---------- helpers ---------- */
function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
const rel = (p: string) => p.slice(ROOT.length + 1);

/* ---------- 3. relative links resolve ---------- */
const linkSources = [agentsPath, ...(existsSync(join(ROOT, "docs")) ? mdFiles(join(ROOT, "docs")) : [])];
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
for (const src of linkSources) {
  if (!existsSync(src)) continue;
  const text = readFileSync(src, "utf8");
  for (const m of text.matchAll(LINK)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const dest = resolve(dirname(src), target.split("#")[0]);
    if (!existsSync(dest))
      fail(rel(src), `broken link → ${target}`, "fix the path or create the target; if the target moved, sweep every doc that cites the old path");
  }
}

/* ---------- 4. spec template sections ---------- */
const SPEC_SECTIONS = [
  "## Problem Statement",
  "## Solution",
  "## User Stories",
  "## Implementation Decisions",
  "## Testing Decisions",
  "## Out of Scope",
  "## Further Notes",
];
for (const bucket of ["open", "done"]) {
  const dir = join(ROOT, "docs", "specs", bucket);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/^\d{4}-.+\.md$/.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const s of SPEC_SECTIONS)
      if (!text.includes(s))
        fail(`docs/specs/${bucket}/${f}`, `missing section "${s}"`, "add the section (all seven are mandatory; write 'None.' rather than omitting) — template lives in .claude/skills/spec/SKILL.md");
  }
}

/* ---------- 5. server layering ---------- */
/* The law. Lower = deeper; imports must go strictly downward. */
const LAYERS: Record<string, number> = {
  vault: 0, db: 0, http: 0, sse: 0,
  settings: 1, watch: 1, "ai-edits": 1,
  trash: 2, "ai-endpoint": 2,
  git: 3, terminal: 3,
  ai: 4, docs: 4,
  index: 5,
};
const serverDir = join(ROOT, "server");
for (const f of readdirSync(serverDir)) {
  if (!f.endsWith(".ts")) continue;
  const mod = f.replace(/\.ts$/, "");
  if (!(mod in LAYERS)) {
    fail(`server/${f}`, "module not in the layer table", "assign it a layer in scripts/lint-docs.ts LAYERS and add a row to docs/architecture.md's module table — deciding the layer is part of adding a module");
    continue;
  }
  const text = readFileSync(join(serverDir, f), "utf8");
  for (const m of text.matchAll(/from "\.\/([\w-]+)(?:\.ts)?"/g)) {
    const dep = m[1];
    if (dep === "age-entry") continue; // Bun.build input, not a module
    if (!(dep in LAYERS)) continue; // caught when the dep file is scanned
    if (LAYERS[dep] >= LAYERS[mod])
      fail(
        `server/${f}`,
        `imports ./${dep} (layer ${LAYERS[dep]}) from layer ${LAYERS[mod]} — layering is forward-only`,
        "depend on a deeper module, invert with a callback/Pick-typed dep (see docs/architecture.md §DI convention), or — if the layering itself is wrong — change LAYERS here and docs/architecture.md together"
      );
  }
}

/* ---------- 6. app/ leaves + no export let ---------- */
const LEAVES = new Set(["state", "ui", "api", "armor", "entropy", "dialogs", "crypto-worker"]);
const appDir = join(ROOT, "app");
for (const f of readdirSync(appDir)) {
  if (!f.endsWith(".js")) continue;
  const mod = f.replace(/\.js$/, "");
  const text = readFileSync(join(appDir, f), "utf8");
  if (LEAVES.has(mod)) {
    for (const m of text.matchAll(/from "\.\/([\w-]+)\.js"/g)) {
      if (!LEAVES.has(m[1]))
        fail(`app/${f}`, `leaf module imports feature module ./${m[1]}.js`, "leaves stay leaves: inject the feature function from app.js (see dialogs.js wireDialogs) or move the logic");
    }
  }
  if (/^export let /m.test(text))
    fail(`app/${f}`, "`export let` live binding", "shared mutable state belongs in state.js (or the module's session object); export functions or const objects instead");
}

/* ---------- verdict ---------- */
if (failures) {
  console.error(`\nlint-docs: ${failures} failure(s).`);
  process.exit(1);
}
console.log("lint-docs: ok");
