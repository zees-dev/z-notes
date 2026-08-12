/* ============================================================
   theming-e2e.test.ts — the two axes of the look, measured in a real browser.

   `data-theme` picks the stylesheet, `data-scheme` picks the palette.
   Three themes × {dark, light} is six looks, and the failure mode that matters
   is not "it threw" but "it silently did nothing" — a theme whose dark block is
   missing still renders, in the light palette, and looks fine in a screenshot
   of the light one. So every assertion here is a COMPUTED colour read off a
   real element, and every one of them has to CHANGE.

   Three properties, none of which a unit test can see:

     · COVERAGE. All six combinations paint, and no theme collapses foreground
       into background in either scheme (a token that resolved to nothing).
     · LIVE. `colorScheme = "system"` follows the OS, with no reload — driven by
       CDP `Emulation.setEmulatedMedia`, which is the real signal `matchMedia`
       listens to, not a synthesised event. And pinning `dark` DETACHES that
       follower, which is the half that rots quietly.
     · NO BOOT FLASH. The scheme is resolved in <head>, before the first paint.
       Asserted by sampling `data-scheme` and the splash's background on every
       animation frame of a cold load and demanding exactly ONE distinct value.

   Density lives here too, because it is the third knob on the same surface and
   it shares the harness: the new Compact must be MEASURABLY tighter than the
   new Comfy on real rects, and the Preview/Raw container parity must still
   hold in both.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page, type CDPSession } from "puppeteer-core";
import { startServer, sleep, makeVault, SEED_VAULT, type TestServer } from "./helpers";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ensureMode as setMode,
  gotoSettings,
  launchTestBrowser,
  leaveSettings,
  newAppPage,
  onSettings as isOnSettings,
  saveSettings,
  waitSettings as waitForSettings,
} from "./browser";
import { DEFAULTS } from "../server/settings";

const THEMES = ["modern", "minimal", "terminal"] as const;
const SCHEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
type Scheme = (typeof SCHEMES)[number];

let srv: TestServer;
let browser: Browser;
let page: Page;
let cdp: CDPSession;

beforeAll(async () => {
  /* the truncation test's premise is a vault path WIDER than the sidebar.
     A laptop's mkdtemp is deep enough by accident; CI's /tmp is not — so pin
     the premise instead of inheriting it from the runner's tmpdir shape. */
  const deep = join(
    makeVault({}),
    "a-vault-path-long-enough",
    "that-the-sidebar-sub-line",
    "must-truncate-it-everywhere",
    "vault"
  );
  mkdirSync(deep, { recursive: true });
  cpSync(makeVault(SEED_VAULT), deep, { recursive: true });
  srv = await startServer({ vault: deep });
  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  cdp = await page.createCDPSession();
  await page.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
}, 90000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
});

/* ------------------------------------------------------------------
   driving the real controls
   ------------------------------------------------------------------ */

/** the OS preference, as the browser itself reports it to `matchMedia` */
async function emulateOs(scheme: Scheme | null) {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: scheme ? [{ name: "prefers-color-scheme", value: scheme }] : [],
  });
}

/* the shared settings predicate — see tests/browser.ts */
const onSettings = () => isOnSettings(page);

/* the shared pair — see tests/browser.ts. `settle: 0` because every caller
   below waits on the attribute the control it clicks actually drives, which is
   a stronger wait than any pause. */
async function openSettings() {
  if (await onSettings()) return;
  await gotoSettings(page, { settle: 0 });
}

async function closeSettings() {
  if (!(await onSettings())) return;
  await leaveSettings(page, { settle: 0 });
}

/** click a segmented control and wait for the attribute it drives */
async function pick(seg: string, value: string, attr: string, want = value) {
  await openSettings();
  const sel = `#${seg} button[data-v="${value}"]`;
  await page.waitForSelector(sel, { timeout: 8000 });
  await page.click(sel);
  await page.waitForFunction(
    (a, w) => document.documentElement.getAttribute(a as string) === w,
    { timeout: 8000 },
    attr,
    want
  );
  /* …and SAVE it. Theme, scheme and density are DRAFTS until Save now, and
     `exitSettings` deliberately reverts an unsaved appearance preview on the
     way out (an unsaved pick must not become the look of a page you are not
     on). A helper that picked and left measured the OLD look under the NEW
     name. Save is inert when the pick matches what is already stored, so the
     click is conditional rather than waited on. */
  await saveSettings(page);
  await closeSettings();
  await sleep(220); // the stylesheet swap + any transition
  const got = await page.evaluate((a) => document.documentElement.getAttribute(a as string), attr);
  expect(`${attr} after leaving Settings: ${got}`).toBe(`${attr} after leaving Settings: ${want}`);
}

const setTheme = (t: Theme) => pick("themeSeg", t, "data-theme");
const setScheme = (s: "dark" | "light" | "system", resolved?: Scheme) =>
  pick("schemeSeg", s, "data-scheme", resolved ?? (s === "system" ? "dark" : s));
const setDensity = (d: "comfy" | "compact") => pick("densitySeg", d, "data-density");

/** Wait for the theme's stylesheet to have actually LOADED, not just been
    swapped in — a measurement taken between the two reads the previous
    theme's tokens and every colour assertion becomes a coin flip. */
async function themeSheetReady(theme: Theme) {
  await page.waitForFunction(
    (t) => {
      const link = document.getElementById("theme-css") as HTMLLinkElement | null;
      if (!link || !link.href.endsWith(`/themes/${t}.css`)) return false;
      return [...document.styleSheets].some((s) => {
        try {
          return (s.href ?? "").endsWith(`/themes/${t}.css`) && !!s.cssRules.length;
        } catch {
          return false;
        }
      });
    },
    { timeout: 10000 },
    theme
  );
}

/* ------------------------------------------------------------------
   measuring
   ------------------------------------------------------------------ */

/** The regions a scheme has to repaint, plus the ink on each. */
const PROBES: Array<[string, string]> = [
  ["shell", "#app"],
  ["doc", "#doc"],
  ["sidebar", "#sidebar"],
  ["statusbar", ".statusbar"],
  ["chat", "#chat"],
];

interface Look {
  theme: string | null;
  scheme: string | null;
  pref: string | null;
  metaScheme: string | null;
  regions: Record<string, { bg: string; fg: string }>;
}

async function look(): Promise<Look> {
  return page.evaluate((probes: Array<[string, string]>) => {
    /* the real painted colour, not `transparent` inherited from an ancestor */
    const effectiveBg = (el: Element | null): string => {
      let n: Element | null = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    };
    const regions: Record<string, { bg: string; fg: string }> = {};
    for (const [name, sel] of probes) {
      const el = document.querySelector(sel);
      regions[name] = el
        ? { bg: effectiveBg(el), fg: getComputedStyle(el).color }
        : { bg: "(missing)", fg: "(missing)" };
    }
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      scheme: document.documentElement.getAttribute("data-scheme"),
      pref: document.documentElement.getAttribute("data-scheme-pref"),
      metaScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? null,
      regions,
    };
  }, PROBES);
}

/** rgb(a) string → [r,g,b]; relative luminance per WCAG */
function rgb(c: string): [number, number, number] {
  const m = c.match(/-?[\d.]+/g);
  if (!m || m.length < 3) throw new Error(`not a colour: ${c}`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
function luminance(c: string): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ============================================================
   1. COVERAGE — six looks, all real
   ============================================================ */

describe("theming — every theme × scheme actually repaints", () => {
  const seen: Record<string, Look> = {};

  test("all three themes paint a distinct dark and light palette", async () => {
    for (const theme of THEMES) {
      await setTheme(theme);
      await themeSheetReady(theme);
      for (const scheme of SCHEMES) {
        await setScheme(scheme);
        const l = await look();
        seen[`${theme}/${scheme}`] = l;

        expect(`${theme}/${scheme} data-theme`).toBe(`${l.theme}/${scheme} data-theme`);
        expect(`${theme}/${scheme} data-scheme`).toBe(`${theme}/${l.scheme} data-scheme`);
        /* the <meta> the UA paints scrollbars and form controls from must agree
           with the attribute the CSS keys off, or the chrome is the other look */
        expect(`${theme}/${scheme} meta color-scheme: ${l.metaScheme}`).toBe(
          `${theme}/${scheme} meta color-scheme: ${scheme}`
        );

        for (const [name] of PROBES) {
          const { bg, fg } = l.regions[name];
          expect(`${theme}/${scheme} ${name} painted: ${bg !== "(missing)"}`).toBe(
            `${theme}/${scheme} ${name} painted: true`
          );
          /* a token that resolved to nothing lands here: ink the same colour as
             the paper renders as a blank region, and screenshots do not catch it */
          const ratio = contrast(fg, bg);
          expect(`${theme}/${scheme} ${name} fg/bg contrast ${ratio.toFixed(2)} ≥ 3: ${ratio >= 3}`).toBe(
            `${theme}/${scheme} ${name} fg/bg contrast ${ratio.toFixed(2)} ≥ 3: true`
          );
        }
      }

      /* THE POINT: dark is not light. Every region has to move, in every theme
         — a theme whose dark block was never written renders happily in the
         light palette and only this assertion notices. */
      const d = seen[`${theme}/dark`];
      const li = seen[`${theme}/light`];
      for (const [name] of PROBES) {
        expect(`${theme} ${name} bg changed between schemes: ${d.regions[name].bg !== li.regions[name].bg}`).toBe(
          `${theme} ${name} bg changed between schemes: true`
        );
      }
      /* and it moved in the right DIRECTION — "different" would also be
         satisfied by two mid-greys, or by the two palettes being swapped */
      const dl = luminance(d.regions.shell.bg);
      const ll = luminance(li.regions.shell.bg);
      expect(`${theme} dark shell (${dl.toFixed(3)}) is darker than light (${ll.toFixed(3)}): ${dl < ll}`).toBe(
        `${theme} dark shell (${dl.toFixed(3)}) is darker than light (${ll.toFixed(3)}): true`
      );
      expect(`${theme} dark shell is genuinely dark: ${dl < 0.2}`).toBe(`${theme} dark shell is genuinely dark: true`);
      expect(`${theme} light shell is genuinely light: ${ll > 0.6}`).toBe(
        `${theme} light shell is genuinely light: true`
      );
    }
  }, 180000);

  test("the three themes are three DIFFERENT looks, in both schemes", async () => {
    /* otherwise the sweep above could pass with one stylesheet doing all the
       work and the other two never loading */
    for (const scheme of SCHEMES) {
      const shells = THEMES.map((t) => seen[`${t}/${scheme}`].regions.shell.bg);
      expect(`${scheme} distinct shell backgrounds: ${new Set(shells).size}`).toBe(
        `${scheme} distinct shell backgrounds: ${THEMES.length}`
      );
    }
  }, 30000);
});

/* ============================================================
   2. LIVE — "system" follows the OS, and a pin does not
   ============================================================ */

describe("theming — `system` follows the OS without a reload", () => {
  test("an emulated OS flip repaints in place, both ways, with the preference unchanged", async () => {
    await setTheme("minimal");
    await themeSheetReady("minimal");
    await emulateOs("light");
    await setScheme("system", "light");

    const before = await look();
    expect(`pref: ${before.pref}`).toBe("pref: system");
    expect(`resolved with OS=light: ${before.scheme}`).toBe("resolved with OS=light: light");

    /* the marker proves NO RELOAD: a navigation would take it with it */
    await page.evaluate(() => ((window as any).__noReload = "same-document"));

    await emulateOs("dark");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-scheme") === "dark", {
      timeout: 8000,
    });
    const dark = await look();
    expect(`survived the flip without a reload: ${await page.evaluate(() => (window as any).__noReload)}`).toBe(
      "survived the flip without a reload: same-document"
    );
    expect(`preference is still system: ${dark.pref}`).toBe("preference is still system: system");
    expect(`meta followed: ${dark.metaScheme}`).toBe("meta followed: dark");
    expect(`the shell really repainted: ${dark.regions.shell.bg !== before.regions.shell.bg}`).toBe(
      "the shell really repainted: true"
    );

    /* and back — a one-way follower is a listener that ran once */
    await emulateOs("light");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-scheme") === "light", {
      timeout: 8000,
    });
    const backToLight = await look();
    expect(`round-tripped to the same light shell: ${backToLight.regions.shell.bg === before.regions.shell.bg}`).toBe(
      "round-tripped to the same light shell: true"
    );
    expect(`still the same document: ${await page.evaluate(() => (window as any).__noReload)}`).toBe(
      "still the same document: same-document"
    );
  }, 90000);

  test("pinning a scheme DETACHES the follower — the OS no longer moves it", async () => {
    await emulateOs("light");
    await setScheme("system", "light");
    await setScheme("dark");
    const pinned = await look();
    expect(`pref: ${pinned.pref}`).toBe("pref: dark");

    await emulateOs("light");
    await sleep(400);
    const still = await look();
    expect(`pinned dark survived an OS flip to light: ${still.scheme}`).toBe(
      "pinned dark survived an OS flip to light: dark"
    );
    expect(`the shell did not repaint: ${still.regions.shell.bg === pinned.regions.shell.bg}`).toBe(
      "the shell did not repaint: true"
    );

    /* …and returning to `system` re-attaches it, rather than leaving a dead
       control that only works once per page */
    await setScheme("system", "light");
    await emulateOs("dark");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-scheme") === "dark", {
      timeout: 8000,
    });
    expect(`the follower came back: ${(await look()).scheme}`).toBe("the follower came back: dark");
    await emulateOs(null);
  }, 90000);
});

/* ============================================================
   3. NO BOOT FLASH
   ============================================================ */

describe("theming — the scheme is resolved before the first paint", () => {
  /**
   * A cold load with a recorder installed at document-start. It samples the
   * resolved scheme and the splash's own background on EVERY animation frame,
   * so a one-frame flash of the wrong palette — the whole failure mode — is
   * caught. Anything less (a single read after load) sees only the end state,
   * which is correct in the buggy build too.
   */
  async function coldLoad(opts: {
    osScheme: Scheme;
    pref: "system" | "dark" | "light";
    profile: "cold" | "returning";
    theme?: Theme;
    density?: "comfy" | "compact";
  }) {
    const fresh = await newAppPage(browser);
    const freshCdp = await fresh.createCDPSession();
    await freshCdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: opts.osScheme }],
    });

    /* "cold" means a browser that has genuinely never run this app: the
       pre-paint cache is wiped at document-start, BEFORE the <head> resolver
       reads it. Without this the pages share an origin and every load after the
       first is a returning one, which is the easy case. */
    if (opts.profile === "cold") {
      await fresh.evaluateOnNewDocument(() => {
        try {
          localStorage.removeItem("znotes.scheme");
          localStorage.removeItem("znotes.theme");
          localStorage.removeItem("znotes.density");
        } catch {}
      });
    }

    await fresh.evaluateOnNewDocument(() => {
      const w = window as any;
      w.__schemes = [];
      w.__themes = [];
      w.__densities = [];
      w.__bootBg = [];
      w.__frames = 0;
      const tick = () => {
        w.__frames++;
        const root = document.documentElement;
        if (root) {
          const s = root.getAttribute("data-scheme");
          if (s && w.__schemes[w.__schemes.length - 1] !== s) w.__schemes.push(s);
          /* the other two axes of the look, sampled the same way: `data-theme`
             (and the stylesheet it names) and `data-density` */
          const t =
            root.getAttribute("data-theme") +
            "|" +
            ((document.getElementById("theme-css") as HTMLLinkElement | null)?.getAttribute("href") ?? "");
          if (w.__themes[w.__themes.length - 1] !== t) w.__themes.push(t);
          const dn = root.getAttribute("data-density");
          if (dn && w.__densities[w.__densities.length - 1] !== dn) w.__densities.push(dn);
          /* ALWAYS the splash element, never "the splash until it hides and
             then the root": switching targets mid-recording invents a
             transition that never happened on screen. Its computed style stays
             resolvable after it is hidden, so one series covers the whole load. */
          /* only frames the user could have SEEN: the head stylesheets are
             render-blocking, so until the theme <link> has a parsed sheet the
             document has not painted — a computed value read in that window is
             a frame that never reached the screen, and counting it invents a
             flash slow machines never showed. */
          const themeLink = document.getElementById("theme-css") as HTMLLinkElement | null;
          if (themeLink?.sheet) {
            const boot = document.getElementById("boot");
            const bg = getComputedStyle(boot ?? root).backgroundColor;
            if (bg && w.__lastBg !== bg) {
              w.__lastBg = bg;
              w.__bootBg.push(`${bg} @frame ${w.__frames}`);
            }
          }
        }
        if (w.__frames < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /* `?scheme=` is a boot-time override, so the preference under test is set
       the honest way: through the server, before the load being measured. */
    await srv.api("PUT", "/api/settings", {
      colorScheme: opts.pref,
      theme: opts.theme ?? "minimal",
      density: opts.density ?? DEFAULTS.density,
    });

    await fresh.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
    await fresh.waitForSelector("#app:not([hidden])", { timeout: 20000 });
    await fresh.waitForFunction(() => (window as any).__frames >= 60, { timeout: 15000 });

    const out = await fresh.evaluate(() => ({
      schemes: (window as any).__schemes as string[],
      themes: (window as any).__themes as string[],
      densities: (window as any).__densities as string[],
      bgs: (window as any).__bootBg as string[],
      frames: (window as any).__frames as number,
      final: document.documentElement.getAttribute("data-scheme"),
      finalTheme: document.documentElement.getAttribute("data-theme"),
      finalDensity: document.documentElement.getAttribute("data-density"),
      pref: document.documentElement.getAttribute("data-scheme-pref"),
    }));
    await fresh.close();
    return out;
  }

  const CASES: Array<{ osScheme: Scheme; pref: "system" | "dark" | "light"; want: Scheme }> = [
    { osScheme: "dark", pref: "system", want: "dark" },
    { osScheme: "light", pref: "system", want: "light" },
    /* the setting DISAGREES with the OS — the case a naive "just ask
       matchMedia" resolver gets wrong, and the reason the cache exists */
    { osScheme: "light", pref: "dark", want: "dark" },
    { osScheme: "dark", pref: "light", want: "light" },
  ];

  for (const c of CASES) {
    test(`pref=${c.pref} on an OS that prefers ${c.osScheme} boots into ${c.want} without flashing`, async () => {
      /* FIRST, a COLD profile — never run this app, so nothing local to read.
         `system` is STILL flash-free, because matchMedia answers synchronously
         and is the whole of the answer. A pinned scheme lives on the server and
         cannot be known before the network, so it is allowed exactly one
         repaint — and no more, which is what pins the bound. */
      const cold = await coldLoad({ ...c, profile: "cold" });
      expect(`cold: sampled real frames: ${cold.frames >= 60}`).toBe("cold: sampled real frames: true");
      expect(`cold: settled on: ${cold.final}`).toBe(`cold: settled on: ${c.want}`);
      if (c.pref === "system") {
        expect(`cold + system: distinct data-scheme values: ${JSON.stringify(cold.schemes)}`).toBe(
          `cold + system: distinct data-scheme values: ${JSON.stringify([c.want])}`
        );
        expect(`cold + system: distinct splash backgrounds: ${cold.bgs.length}`).toBe(
          "cold + system: distinct splash backgrounds: 1"
        );
      } else {
        expect(
          `cold + pinned: at most one repaint (${cold.schemes.length}): ${cold.schemes.length <= 2}`
        ).toBe(`cold + pinned: at most one repaint (${cold.schemes.length}): true`);
        expect(`cold + pinned: ends on the right one: ${cold.schemes[cold.schemes.length - 1]}`).toBe(
          `cold + pinned: ends on the right one: ${c.want}`
        );
      }

      /* THEN the same browser again — the state every load after the first is
         in. This one must never flash, whatever the preference, and it is the
         assertion that fails if the cache stores the RESOLVED scheme instead of
         the preference: under `system` a cached "light" would beat a live
         matchMedia that now says dark, and the app would snap a frame later. */
      const warm = await coldLoad({ ...c, profile: "returning" });
      expect(`returning: sampled real frames: ${warm.frames >= 60}`).toBe("returning: sampled real frames: true");
      expect(`returning: settled on: ${warm.final}`).toBe(`returning: settled on: ${c.want}`);
      expect(`returning: preference: ${warm.pref}`).toBe(`returning: preference: ${c.pref}`);
      expect(`returning: distinct data-scheme values: ${JSON.stringify(warm.schemes)}`).toBe(
        `returning: distinct data-scheme values: ${JSON.stringify([c.want])}`
      );
      expect(`returning: distinct splash backgrounds: ${warm.bgs.length}`).toBe(
        "returning: distinct splash backgrounds: 1"
      );
    }, 120000);
  }

  test("the THEME and the DENSITY are resolved before the first paint too", async () => {
    /* The head resolver used to cover the scheme axis only, so `<html
       data-theme="minimal" data-density="comfy">` and the hard-coded
       ./themes/minimal.css were the first paint on EVERY load — a returning
       profile included — and the real look arrived over the network ~20ms
       later: measured as a repaint from minimal|comfy to terminal|compact on a
       warm profile, on every single load. Same cache discipline as the scheme,
       same honest bound: one repaint on a profile that has never run the app,
       none afterwards. */
    const opts = { osScheme: "dark" as Scheme, pref: "dark" as const, theme: "terminal" as Theme, density: "compact" as const };

    const cold = await coldLoad({ ...opts, profile: "cold" });
    expect(`cold: settled on: ${cold.finalTheme}/${cold.finalDensity}`).toBe("cold: settled on: terminal/compact");
    expect(`cold: at most one theme repaint (${JSON.stringify(cold.themes)}): ${cold.themes.length <= 2}`).toBe(
      `cold: at most one theme repaint (${JSON.stringify(cold.themes)}): true`
    );

    /* the load that matters: a browser that has run this app before knows the
       answer without asking, so there is exactly ONE value all the way down */
    const warm = await coldLoad({ ...opts, profile: "returning" });
    expect(`returning: sampled real frames: ${warm.frames >= 60}`).toBe("returning: sampled real frames: true");
    expect(`returning: distinct themes: ${JSON.stringify(warm.themes)}`).toBe(
      'returning: distinct themes: ["terminal|./themes/terminal.css"]'
    );
    expect(`returning: distinct densities: ${JSON.stringify(warm.densities)}`).toBe(
      'returning: distinct densities: ["compact"]'
    );
    expect(`returning: distinct splash backgrounds: ${warm.bgs.length}`).toBe(
      "returning: distinct splash backgrounds: 1"
    );

    /* and back to the defaults for whatever runs next */
    await srv.api("PUT", "/api/settings", {
      theme: DEFAULTS.theme,
      density: DEFAULTS.density,
      colorScheme: DEFAULTS.colorScheme,
    });
  }, 120000);

  test("the shipped default is what index.html's pre-paint guess assumes", async () => {
    /* the <head> resolver hard-codes no theme — it inherits <html data-theme>,
       which the settings suite pins to DEFAULTS.theme. Restated here because
       this file's whole premise is "the first paint is already correct".

       WAITED FOR, not sampled: the defaults are restored with a `PUT` and this
       page learns about it over `settings-changed`, so reading the attribute
       on the next line raced an SSE round trip that had not landed yet (seen
       failing under a loaded machine with "compact"). The PUT is issued HERE,
       not inherited from the previous test — a failure there must not cascade
       into this one. The timeout still fails on a value that never arrives, so
       the assertion is unchanged in what it can catch. */
    await srv.api("PUT", "/api/settings", {
      theme: DEFAULTS.theme,
      density: DEFAULTS.density,
      colorScheme: DEFAULTS.colorScheme,
    });
    await page.waitForFunction(
      (want) => document.documentElement.getAttribute("data-density") === want,
      { timeout: 8000 },
      DEFAULTS.density
    );
    const boot = await page.evaluate(() => ({
      density: document.documentElement.getAttribute("data-density"),
    }));
    expect(`boot density guess: ${boot.density}`).toBe(`boot density guess: ${DEFAULTS.density}`);
    await srv.api("PUT", "/api/settings", { colorScheme: DEFAULTS.colorScheme, theme: DEFAULTS.theme });
  }, 30000);
});

/* ============================================================
   4. DENSITY — the rescale is real, and parity survived it
   ============================================================ */

/** Rects and computed sizes a density change must actually move. */
async function measureDensity() {
  return page.evaluate(() => {
    const num = (v: string) => Math.round(parseFloat(v) * 100) / 100;
    const root = getComputedStyle(document.documentElement);
    const rowEl = document.querySelector("#tree .row");
    const doc = document.getElementById("doc")!;
    const topbar = document.querySelector(".topbar");
    const statusbar = document.querySelector(".statusbar");
    /* was `#modeSeg button` — the Raw|Preview segmented control, which no
       longer exists (the mode is statusbar text now). The assertion it fed was
       "a topbar CONTROL rescales with --d-ctl-h", and the topbar icon buttons
       are sized by exactly that token, so the substance is unchanged. */
    /* the first one that is actually painted: the topbar carries both a
       `.only-mobile` and a `.no-mobile` icon button and one of them is always
       display:none, which would measure 0 and pass a "got tighter" test by
       accident. */
    const ctl = [...document.querySelectorAll(".topbar .iconbtn")].find((b) => b.getBoundingClientRect().height > 0) || null;
    return {
      density: document.documentElement.getAttribute("data-density"),
      /* the tokens themselves */
      font: num(root.getPropertyValue("--d-font")),
      rowH: num(root.getPropertyValue("--d-row-h")),
      docPad: num(root.getPropertyValue("--d-doc-pad")),
      ctlH: num(root.getPropertyValue("--d-ctl-h")),
      /* …and the real geometry they are supposed to drive */
      rowRect: rowEl ? Math.round(rowEl.getBoundingClientRect().height * 100) / 100 : 0,
      docPadTop: num(getComputedStyle(doc).paddingTop),
      docPadLeft: num(getComputedStyle(doc).paddingLeft),
      docFont: num(getComputedStyle(doc).fontSize),
      topbarRect: topbar ? Math.round(topbar.getBoundingClientRect().height * 100) / 100 : 0,
      statusRect: statusbar ? Math.round(statusbar.getBoundingClientRect().height * 100) / 100 : 0,
      ctlRect: ctl ? Math.round(ctl.getBoundingClientRect().height * 100) / 100 : 0,
    };
  });
}

const PARITY_PROPS = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginLeft",
  "marginRight",
  "maxWidth",
  "borderTopWidth",
  "borderLeftWidth",
  "backgroundColor",
  "boxSizing",
] as const;

/** The container AND the text origin inside it — the same two clauses
    tests/e2e.test.ts measures, because a theme is exactly where a rule that
    moves the text without moving the container would come from. */
async function docContainer() {
  return page.evaluate((props: readonly string[]) => {
    const d = document.getElementById("doc") as HTMLElement;
    const cs = getComputedStyle(d);
    const style: Record<string, string> = {};
    for (const p of props) style[p] = (cs as any)[p];
    const r = d.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 100) / 100;

    const raw = d.querySelector("#rawArea") as HTMLElement | null;
    let first: Element | null = raw;
    if (!first) {
      const meta = d.querySelector(".doc-meta");
      first = meta ? meta.nextElementSibling : d.firstElementChild;
      while (first && first.firstElementChild) first = first.firstElementChild;
    }
    let text: { x: number; y: number } | null = null;
    if (first) {
      const tr = first.getBoundingClientRect();
      const ts = getComputedStyle(first);
      text = { x: round(tr.x + parseFloat(ts.paddingLeft || "0")), y: round(tr.y + parseFloat(ts.paddingTop || "0")) };
    }
    return { style, rect: { x: round(r.x), width: round(r.width), top: round(r.top) }, text };
  }, PARITY_PROPS as unknown as string[]);
}

/* the shared toggle — see tests/browser.ts. `settle` is load-bearing HERE and
   nowhere else: every caller in this file measures COMPUTED STYLE straight
   afterwards, and the stylesheet swap is not done when the class is. */
const ensureMode = (want: "raw" | "preview") => setMode(page, want, { settle: 140 });

describe("density — the rescale is measurable, in every theme", () => {
  test("Compact is tighter than Comfy on REAL rects, not just on tokens", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.click(`#tree .row.file[data-doc="architecture/event-pipeline.md"]`);
    await sleep(300);

    for (const theme of THEMES) {
      await setTheme(theme);
      await themeSheetReady(theme);

      await setDensity("comfy");
      await sleep(420); // .doc transitions its padding
      const comfy = await measureDensity();
      await setDensity("compact");
      await sleep(420);
      const compact = await measureDensity();

      expect(`${theme} comfy read as: ${comfy.density}`).toBe(`${theme} comfy read as: comfy`);
      expect(`${theme} compact read as: ${compact.density}`).toBe(`${theme} compact read as: compact`);

      /* every knob moves DOWN. Named individually so a failure says which one
         the rescale forgot rather than "the object differed". */
      const tighter: Array<[string, number, number]> = [
        ["--d-font", compact.font, comfy.font],
        ["--d-row-h", compact.rowH, comfy.rowH],
        ["--d-doc-pad", compact.docPad, comfy.docPad],
        ["--d-ctl-h", compact.ctlH, comfy.ctlH],
        ["tree row height", compact.rowRect, comfy.rowRect],
        ["doc padding-top", compact.docPadTop, comfy.docPadTop],
        ["doc font-size", compact.docFont, comfy.docFont],
        ["topbar height", compact.topbarRect, comfy.topbarRect],
        ["statusbar height", compact.statusRect, comfy.statusRect],
        ["topbar control height", compact.ctlRect, comfy.ctlRect],
      ];
      for (const [what, tight, loose] of tighter) {
        expect(`${theme} ${what}: compact ${tight} < comfy ${loose}`).toBe(
          `${theme} ${what}: compact ${tight} < comfy ${loose === tight ? "SAME" : loose}`
        );
        expect(`${theme} ${what} got tighter: ${tight < loose}`).toBe(`${theme} ${what} got tighter: true`);
      }

      /* …but not to the point of being unusable. The rescale pushed a rung
         further down than the shipped Compact used to be, and these are the
         floors that stopped it from becoming a novelty. */
      expect(`${theme} compact rows stay clickable (${compact.rowRect}px ≥ 17): ${compact.rowRect >= 17}`).toBe(
        `${theme} compact rows stay clickable (${compact.rowRect}px ≥ 17): true`
      );
      expect(`${theme} compact controls stay hittable (${compact.ctlH}px ≥ 22): ${compact.ctlH >= 22}`).toBe(
        `${theme} compact controls stay hittable (${compact.ctlH}px ≥ 22): true`
      );
      expect(`${theme} compact body copy stays readable (${compact.font}px ≥ 10.5): ${compact.font >= 10.5}`).toBe(
        `${theme} compact body copy stays readable (${compact.font}px ≥ 10.5): true`
      );

      /* The doc's HORIZONTAL padding is a breakpoint knob, not a density one —
         it sets the measure. Pinned so a future rescale that starts squeezing
         the column sideways has to say so out loud. */
      expect(`${theme} doc side padding is density-independent: ${compact.docPadLeft === comfy.docPadLeft}`).toBe(
        `${theme} doc side padding is density-independent: true`
      );
    }
  }, 240000);

  test("the vault block TRUNCATES a long path instead of overflowing the sidebar", async () => {
    /* Regression. `.vault-name` / `.vault-sub` are <span>s inside the .vault
       <button>, and `overflow`/`text-overflow` are inert on a non-replaced
       INLINE box — so the ellipsis they were given did nothing: the sub-line
       laid out at its full text width (measured 394px inside a 251px sidebar),
       was clipped square by `.sidebar { overflow: hidden }`, and the user saw a
       silently amputated path. The vault under test lives in a deep temp
       directory, so the path really is longer than the sidebar. */
    for (const theme of THEMES) {
      await setTheme(theme);
      await themeSheetReady(theme);
      for (const density of ["comfy", "compact"] as const) {
        await setDensity(density);
        await sleep(260);
        const m = await page.evaluate(() => {
          const sub = document.getElementById("vaultSub") as HTMLElement;
          const name = document.getElementById("vaultName") as HTMLElement;
          const head = document.querySelector("#sidebar .sb-head") as HTMLElement;
          const side = document.getElementById("sidebar") as HTMLElement;
          return {
            text: sub.textContent ?? "",
            /* a real ellipsis needs a box narrower than the text AND a box that
               is actually a block — `clientWidth` is 0 on an inline one */
            subClient: sub.clientWidth,
            subScroll: sub.scrollWidth,
            subDisplay: getComputedStyle(sub).display,
            nameDisplay: getComputedStyle(name).display,
            subRight: Math.round(sub.getBoundingClientRect().right),
            sidebarRight: Math.round(side.getBoundingClientRect().right),
            headOverflowsX: head.scrollWidth > head.clientWidth + 1,
            headOverflowsY: head.scrollHeight > head.clientHeight + 1,
          };
        });
        const at = `${theme}/${density}`;
        expect(`${at} the path is long enough to matter: ${m.subScroll > m.subClient}`).toBe(
          `${at} the path is long enough to matter: true`
        );
        expect(`${at} the sub-line is a block box: ${m.subDisplay} / ${m.nameDisplay}`).toBe(
          `${at} the sub-line is a block box: block / block`
        );
        expect(`${at} the sub-line stays inside the sidebar: ${m.subRight <= m.sidebarRight}`).toBe(
          `${at} the sub-line stays inside the sidebar: true`
        );
        expect(`${at} the header overflows: x=${m.headOverflowsX} y=${m.headOverflowsY}`).toBe(
          `${at} the header overflows: x=false y=false`
        );
      }
    }
  }, 180000);

  test("Preview/Raw parity survives the rescale, in every theme × density × breakpoint", async () => {
    /* the parity gate in e2e.test.ts runs on the default theme only. The
       rescale touched all three stylesheets, and a theme that re-states a
       density token in only one of the two modes breaks parity in that theme
       alone — invisible to a gate that never switches themes.

       The narrow breakpoint is here because the meta line above the document is
       where the two modes differ in CONTENT (the mode note is longer in Raw):
       in a mono theme at 720px it used to wrap to a second line in Raw only,
       which moved the first line of the document 13px down on ⌘E while `#doc`
       itself never moved — the exact blind spot the text-origin measurement
       above was added for. */
    for (const [width, height] of [
      [1440, 900],
      [720, 900],
    ] as Array<[number, number]>) {
      await page.setViewport({ width, height });
      await sleep(220);
      for (const theme of THEMES) {
        await setTheme(theme);
        await themeSheetReady(theme);
        for (const density of ["comfy", "compact"] as const) {
          await setDensity(density);
          await sleep(420);
          const at = `${theme}/${density}/${width}px`;

          await ensureMode("preview");
          const preview = await docContainer();
          await ensureMode("raw");
          const raw = await docContainer();
          await ensureMode("preview");

          expect({ at, ...raw.style }).toEqual({ at, ...preview.style });
          expect(raw.rect.x).toBeCloseTo(preview.rect.x, 1);
          expect(raw.rect.width).toBeCloseTo(preview.rect.width, 1);
          expect(raw.rect.top).toBeCloseTo(preview.rect.top, 1);
          expect(
            `${at} ⌘E moves the text by dx=${(raw.text!.x - preview.text!.x).toFixed(2)} dy=${(
              raw.text!.y - preview.text!.y
            ).toFixed(2)}`
          ).toBe(`${at} ⌘E moves the text by dx=0.00 dy=0.00`);
        }
      }
    }
    await page.setViewport({ width: 1440, height: 900 });
  }, 300000);

  test("nothing clips or overflows at the tightest setting, in either scheme", async () => {
    /* The rescale shrank `--d-topbar` under content that was sized in hard
       pixels — the sidebar's vault block clipped in all three themes before it
       was made to scale. Measured rather than eyeballed, and in both schemes
       because a dark twin can restate a size. */
    for (const theme of THEMES) {
      await setTheme(theme);
      await themeSheetReady(theme);
      await setDensity("compact");
      for (const scheme of SCHEMES) {
        await setScheme(scheme);
        await sleep(260);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          const containers = ["#sidebar .sb-head", ".topbar", ".statusbar"];
          for (const sel of containers) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) continue;
            /* +1px of slack: sub-pixel layout rounds against us at some zooms */
            if (el.scrollHeight > el.clientHeight + 1) out.push(`${sel} clips vertically`);
            if (el.scrollWidth > el.clientWidth + 1) out.push(`${sel} clips horizontally`);
          }
          if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push("the page scrolls horizontally");
          const sb = document.querySelector(".statusbar");
          if (sb && sb.getBoundingClientRect().bottom > window.innerHeight + 1) out.push("the statusbar is off screen");
          return out;
        });
        expect(`${theme}/${scheme} compact overflow: ${JSON.stringify(bad)}`).toBe(
          `${theme}/${scheme} compact overflow: []`
        );
      }
    }
  }, 240000);
});
