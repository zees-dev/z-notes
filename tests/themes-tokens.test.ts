/* ============================================================
   themes-tokens.test.ts — the two rules the stylesheets state about
   themselves, checked against the stylesheets.

   Both are DOCUMENTED invariants with no enforcement, which is the shape of
   thing that is true on the day it is written and quietly false a theme later:

     1. THE DENSITY FLOORS (base.css §2, SPEC §9). base.css names the minimum a
        control, a tree row and body copy may shrink to, and every theme is
        explicitly allowed to override the tokens they are stated about — so
        the floors are a claim about all four files, not about base.css. The
        numbers in that comment had drifted to base's OWN rungs, which made it
        contradict both SPEC §9 and terminal.css shipped beside it.

     2. THE DARK-TOKEN CONTRACT (THEMES.md, base.css §1b). `:root[data-scheme=
        "dark"]` (0,2,0) outranks a theme's plain `:root` (0,1,0) regardless of
        file order, so any token a theme sets as an ALIAS that base's dark block
        also sets must be restated in the theme's own dark block — otherwise it
        silently falls back to base's generic dark value in that theme alone.
        "Adding a token to base's dark block is a four-file change", says the
        doc; nothing noticed when it was done in three.

   Read straight off the shipped CSS, in-process: no browser, no server. A
   rendered-pixel check (theming-e2e) can only see what a viewport happens to
   show, and one token in one theme in one scheme is exactly what nobody
   eyeballs.
   ============================================================ */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const THEME_DIR = join(REPO_ROOT, "app", "themes");
const THEMES = ["minimal", "modern", "terminal"] as const;

const read = (name: string) => readFileSync(join(THEME_DIR, name + ".css"), "utf8");

/** Strip comments, so a token named in prose is never mistaken for a rule. */
const decomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every `--token: value` declared under the rules whose selector matches.
 * Brace-matched rather than regexed across the whole file: a theme sets the
 * same token under several selectors and only the matching ones count.
 */
function tokensUnder(css: string, matches: (selector: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const clean = decomment(css);
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf("{", i);
    if (open < 0) break;
    const selector = clean.slice(i, open).split("}").pop()!.trim();
    let depth = 1;
    let j = open + 1;
    for (; j < clean.length && depth > 0; j++) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") depth--;
    }
    const body = clean.slice(open + 1, j - 1);
    if (matches(selector)) {
      for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out.set(m[1], m[2].trim());
    }
    i = j;
  }
  return out;
}

const isRoot = (s: string) => /^:root$/.test(s);
const isDark = (s: string) => /^:root\[data-scheme=["']dark["']\]$/.test(s);
const isDensity = (s: string, which: string) => new RegExp(`^:root\\[data-density=["']${which}["']\\]$`).test(s);

/* ============================================================
   1 · the density floors
   ============================================================ */

describe("themes — the density floors base.css states are the floors it ships", () => {
  /** The floors, read out of the comment that states them. */
  function documentedFloors(): Record<string, number> {
    const css = readFileSync(join(THEME_DIR, "base.css"), "utf8");
    const floors: Record<string, number> = {};
    for (const m of css.matchAll(/(--d-[a-z-]+)\s+≥\s*([\d.]+)px/g)) floors[m[1]] = Number(m[2]);
    return floors;
  }

  test("the comment names floors, in the tokens it is about", () => {
    const floors = documentedFloors();
    expect(`floors found: ${JSON.stringify(Object.keys(floors).sort())}`).toBe(
      'floors found: ["--d-ctl-h","--d-font","--d-row-h"]'
    );
  });

  test("every shipped theme, in BOTH rungs, is at or above every documented floor", () => {
    const floors = documentedFloors();
    const base = read("base");
    const violations: string[] = [];

    for (const theme of ["base", ...THEMES]) {
      const css = read(theme);
      for (const rung of ["comfy", "compact"] as const) {
        /* a theme overrides a rung token or inherits base's — the effective
           value is what the browser would resolve, so that is what is checked */
        const own = tokensUnder(css, (s) => isDensity(s, rung));
        const inherited = tokensUnder(base, (s) => isDensity(s, rung));
        for (const [token, floor] of Object.entries(floors)) {
          const raw = own.get(token) ?? inherited.get(token);
          if (!raw) continue;
          const px = Number(String(raw).replace(/px$/, ""));
          if (!Number.isFinite(px)) continue;
          if (px < floor) violations.push(`${theme}/${rung} ${token} = ${px}px < ${floor}px`);
        }
      }
    }
    expect(`floor violations: ${JSON.stringify(violations)}`).toBe("floor violations: []");
  });

  test("the floors are not vacuous — a shipped theme really does go below base's own rungs", () => {
    /* Otherwise "every theme clears the floors" would be satisfied by floors
       set so high that only base's numbers pass, which is what the comment
       used to say and what made it wrong. */
    const baseCompact = tokensUnder(read("base"), (s) => isDensity(s, "compact"));
    const termCompact = tokensUnder(read("terminal"), (s) => isDensity(s, "compact"));
    const tighter = ["--d-row-h", "--d-font"].filter(
      (t) => termCompact.has(t) && Number(termCompact.get(t)!.replace("px", "")) < Number(baseCompact.get(t)!.replace("px", ""))
    );
    expect(`terminal.css goes below base on: ${JSON.stringify(tighter)}`).toBe(
      'terminal.css goes below base on: ["--d-row-h","--d-font"]'
    );
  });
});

/* ============================================================
   2 · the dark-token contract
   ============================================================ */

describe("themes — every token base's dark block sets is covered in each theme's dark block", () => {
  test("no theme leaks a light-mode alias into the dark scheme", () => {
    const baseDark = tokensUnder(read("base"), isDark);
    expect(`base's dark block sets tokens: ${baseDark.size > 20}`).toBe("base's dark block sets tokens: true");

    const misses: string[] = [];
    for (const theme of THEMES) {
      const css = read(theme);
      const light = tokensUnder(css, isRoot);
      const dark = tokensUnder(css, isDark);
      for (const token of light.keys()) {
        if (!baseDark.has(token)) continue; // base has no dark opinion; the theme's :root stands
        if (dark.has(token)) continue; // restated — correct
        misses.push(`${theme}: ${token} (its :root value loses to base's dark block)`);
      }
    }
    expect(`uncovered tokens: ${JSON.stringify(misses)}`).toBe("uncovered tokens: []");
  });

  test("the check is not vacuous: the themes really do restate base's dark tokens", () => {
    const baseDark = tokensUnder(read("base"), isDark);
    for (const theme of THEMES) {
      const dark = tokensUnder(read(theme), isDark);
      const overlap = [...dark.keys()].filter((t) => baseDark.has(t)).length;
      expect(`${theme} restates base dark tokens (${overlap} > 10): ${overlap > 10}`).toBe(
        `${theme} restates base dark tokens (${overlap} > 10): true`
      );
    }
  });
});
