/* ============================================================
   webmcp-e2e.test.ts — the agent's door, driven the way an agent drives it
   (ADR 0031).

   A real browser, the real backend, the real vault on disk. Every tool here is
   called the way the spec promises one is called — `document.modelContext`,
   `getTools()`, `executeTool()` — and the JSON STRING that comes back is parsed
   in the test, because that string is the contract: the browser serialises a
   tool's return value and hands the agent text.

   Chromium 145 has no native `document.modelContext`, which is the point: the
   module installs an in-page one over the same table, so this suite is also the
   proof that a puppeteer-, Playwright- or DevTools-driven agent gets the same
   catalogue and the same results a Chrome 149 agent would. Two of the tests
   step outside that: one hands the page a RECORDING `document.modelContext`
   before any app code runs and proves the app registered there and never
   replaced it; the other launches a second browser with
   `--enable-features=WebMCP`, where Chromium exposes the older
   `navigator.modelContext` shape, and proves the app finds that too.

   Everything else is measured where it lands — bytes on disk, the statusbar,
   the address bar, `settings.toml` — never in the tool's own answer alone. A
   tool that reported success while writing nothing would pass a test that only
   read its result.
   ============================================================ */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type Browser, type Page } from "puppeteer-core";
import {
  encPath,
  readVaultText,
  sleep,
  startServer,
  vaultHas,
  waitUntil,
  type SeedMap,
  type TestServer,
} from "./helpers";
import { reply, startMockUpstream, type MockUpstream } from "./mock-upstream";
import { launchTestBrowser, newAppPage, waitForApp } from "./browser";

/* ------------------------------------------------------------------
   the catalogue, written out — this list IS the spec's table
   ------------------------------------------------------------------ */

const CATALOGUE = [
  "accept_proposal",
  "add_vault",
  "append_to_doc",
  "approve_command",
  "ask_assistant",
  "cancel_command",
  "create_doc",
  "create_folder",
  "delete_doc",
  "disconnect_vault",
  "dismiss_overlay",
  "edit_doc",
  "empty_trash",
  "get_app_state",
  "get_conversation",
  "get_settings",
  "list_commands",
  "list_docs",
  "list_proposals",
  "list_trash",
  "list_vaults",
  "lock_terminal",
  "lock_vault",
  "move_doc",
  "new_session",
  "open_doc",
  "open_settings",
  "purge_trash",
  "read_doc",
  "redo",
  "reject_command",
  "reject_proposal",
  "restore_from_trash",
  "revert_proposal",
  "run_command",
  "save_doc",
  "search_docs",
  "set_mode",
  "set_setting",
  "set_vault_remote",
  "show_panel",
  "sync_vault",
  "terminal_status",
  "undo",
  "unlock_terminal",
  "write_doc",
];

/** the reads — a browser may run these without asking the user */
const READ_ONLY = [
  "get_app_state",
  "get_conversation",
  "get_settings",
  "list_commands",
  "list_docs",
  "list_proposals",
  "list_trash",
  "list_vaults",
  "read_doc",
  "search_docs",
  "terminal_status",
];

/** the irreversible — a confirming browser asks the user first */
const CONSEQUENTIAL = ["approve_command", "delete_doc", "disconnect_vault", "empty_trash", "purge_trash", "run_command"];

/** the WebMCP spec's own rule for a tool name */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/* ------------------------------------------------------------------
   fixtures
   ------------------------------------------------------------------ */

const ANCHOR = "notes/anchor.md";
const ANCHOR_MD = "# Anchor\n\nAGENTDOOR one\n\nAGENTDOOR two\n";
const MADE = "agent/made.md";
const MADE_MD = "# Made\n\nby a tool\n";
const MOVED = "agent/moved.md";

const TERMINAL_PASSWORD = "WEBMCP-pw-3d91ff";

const SEED: SeedMap = {
  "inbox.md": "# Inbox\n\nnothing yet\n",
  [ANCHOR]: ANCHOR_MD,
  "notes/dup.md": "# Dup\n\nthe name a create cannot take\n",
};

let srv: TestServer;
let mock: MockUpstream;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  mock = await startMockUpstream();
  srv = await startServer({ seed: SEED });

  /* the assistant tool needs a relay to talk to, and auto-sync off keeps a
     background git pass out of every other test's timing */
  const put = await srv.api("PUT", "/api/settings", {
    ai: { baseUrl: mock.baseUrl, apiKey: "sk-webmcp-key", model: "gpt-5", effort: "high" },
    git: { autoSyncSeconds: 600 },
    /* an undo only marks the buffer dirty and leaves the write to the
       autosave; at the default 10 s that is a race the disk poll below loses
       under load, at 1 s it is a measurement */
    editor: { autosaveSeconds: 1 },
  });
  expect(`PUT /api/settings → ${put.status}`).toBe("PUT /api/settings → 200");
  await sleep(300);
  mock.reset();

  browser = await launchTestBrowser();
  page = await newAppPage(browser);
  await boot(page);
}, 120000);

afterAll(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) await srv.stop();
  if (mock) await mock.stop();
});

/* ------------------------------------------------------------------
   driving tools
   ------------------------------------------------------------------ */

/** load the app and wait until the catalogue is really registered */
async function boot(p: Page) {
  await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
  await waitForApp(p);
  await p.waitForFunction(() => document.querySelectorAll("#tree .row.file").length > 0, { timeout: 20000 });
  await waitForTools(p);
}

/** `registerTool` is awaited per tool, so booted is not the same as registered */
function waitForTools(p: Page, want = CATALOGUE.length) {
  return p.waitForFunction(
    async (n: number) => {
      const mc = (document as any).modelContext;
      if (!mc || typeof mc.getTools !== "function") return false;
      return (await mc.getTools()).length >= n;
    },
    { timeout: 25000 },
    want
  );
}

interface ToolShape {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: any;
  annotations?: Record<string, boolean>;
}

const listTools = (p: Page = page): Promise<ToolShape[]> =>
  p.evaluate(async () => {
    const list = await (document as any).modelContext.getTools();
    return list.map((t: any) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations || {},
    }));
  });

/**
 * Call a tool the way the browser's agent does: find the `RegisteredTool` in
 * `getTools()` and hand it back to `executeTool`, which resolves to a JSON
 * STRING. The parse is the test's, deliberately — an agent gets text.
 */
async function call(name: string, input: Record<string, unknown> = {}, p: Page = page): Promise<any> {
  const json = await p.evaluate(
    async (n: string, arg: any) => {
      const mc = (document as any).modelContext;
      const list = await mc.getTools();
      const tool = list.find((t: any) => t.name === n);
      if (!tool) throw new Error("no such tool: " + n);
      return await mc.executeTool(tool, arg);
    },
    name,
    input
  );
  return JSON.parse(json as string);
}

const onDisk = (rel: string) => readVaultText(srv.vault, rel);

/** the write is the tool's, the save is the app's — poll rather than guess */
const waitDisk = (rel: string, want: string) =>
  waitUntil(() => vaultHas(srv.vault, rel) && onDisk(rel) === want, {
    timeout: 15000,
    label: `${rel} to hold ${JSON.stringify(want.slice(0, 40))}`,
  });

const appClass = (cls: string, p: Page = page) =>
  p.evaluate((c: string) => document.getElementById("app")!.classList.contains(c), cls);

/* ------------------------------------------------------------------
   1 — the catalogue
   ------------------------------------------------------------------ */

describe("the catalogue an agent discovers", () => {
  test("is exactly the tools the app promises, each legally shaped", async () => {
    const tools = await listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(CATALOGUE);

    const illegal = tools.filter((t) => !TOOL_NAME.test(t.name)).map((t) => t.name);
    expect(`names the browser would refuse: ${JSON.stringify(illegal)}`).toBe(
      "names the browser would refuse: []"
    );

    /* Chrome's own guidance, and a hard cap: a description over 500 chars is
       budget spent on every turn for the life of the session */
    const badDesc = tools
      .filter((t) => !t.description || t.description.length < 1 || t.description.length > 500)
      .map((t) => t.name);
    expect(`descriptions outside 1–500 chars: ${JSON.stringify(badDesc)}`).toBe(
      "descriptions outside 1–500 chars: []"
    );

    const badSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object").map((t) => t.name);
    expect(`schemas that are not objects: ${JSON.stringify(badSchema)}`).toBe("schemas that are not objects: []");

    /* the hints are what a mediating browser reads to decide whether to ask */
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);

    const consequential = tools
      .filter((t) => t.annotations?.consequentialHint === true)
      .map((t) => t.name)
      .sort();
    expect(consequential).toEqual(CONSEQUENTIAL);
  }, 60000);
});

/* ------------------------------------------------------------------
   2 / 3 — where the app registers
   ------------------------------------------------------------------ */

describe("registration finds the browser's own door first", () => {
  test("a native document.modelContext is used and never replaced", async () => {
    const p = await newAppPage(browser, {
      beforeLoad: () => {
        /* the shape a Chrome 149 page sees, reduced to what registration
           touches — and marked, so the test can prove THIS object survived */
        const registered: any[] = [];
        (window as any).__mcpTools = registered;
        const double = {
          __double: true,
          registerTool(tool: any) {
            registered.push(tool);
            return Promise.resolve();
          },
          getTools() {
            return Promise.resolve(registered.slice());
          },
          executeTool() {
            return Promise.resolve("null");
          },
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return true;
          },
        };
        Object.defineProperty(document, "modelContext", { value: double, configurable: true });
      },
    });
    try {
      await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
      await waitForApp(p);
      await p.waitForFunction(
        (n: number) => ((window as any).__mcpTools || []).length >= n,
        { timeout: 25000 },
        CATALOGUE.length
      );

      const seen = await p.evaluate(() => ({
        names: ((window as any).__mcpTools as any[]).map((t) => t.name).sort(),
        stillTheDouble: (document as any).modelContext.__double === true,
      }));
      expect(seen.names).toEqual(CATALOGUE);
      expect(`the page's own modelContext survived: ${seen.stillTheDouble}`).toBe(
        "the page's own modelContext survived: true"
      );
    } finally {
      await p.close().catch(() => {});
    }
  }, 90000);

  test("Chromium's navigator.modelContext is the second door, and the in-page one still lists them", async () => {
    /* the previous shape of the API, which is what this suite's Chromium
       exposes behind the flag: `navigator.modelContext.registerTool`, no
       `getTools`/`executeTool`. The app registers there AND installs its own
       `document.modelContext` over the same table, so an automation driver
       sees the catalogue either way. */
    const flagged = await launchTestBrowser(undefined, { args: ["--enable-features=WebMCP"] });
    const errors: string[] = [];
    try {
      const p = await newAppPage(flagged, {
        onPageError: (m) => errors.push(m),
        beforeLoad: () => {
          const nav = (navigator as any).modelContext;
          (window as any).__navSeen = !!(nav && typeof nav.registerTool === "function");
          (window as any).__navCount = 0;
          if (!nav || typeof nav.registerTool !== "function") return;
          const original = nav.registerTool.bind(nav);
          nav.registerTool = (...args: any[]) => {
            (window as any).__navCount++;
            return original(...args);
          };
        },
      });
      try {
        await p.goto(srv.base + "/", { waitUntil: "domcontentloaded" });
        await waitForApp(p);

        /* Whether the flag exposes that door is a fact about the BROWSER BINARY
           (docs/style.md: never assert one of those and call it a fact about
           the app). Chrome for Testing 145 does; a later Chromium moves to
           `document.modelContext` and exposes nothing here. So the native half
           is measured where it exists and SAID OUT LOUD where it does not —
           the polyfill half below is asserted either way. */
        const sawNative = await p.evaluate(() => (window as any).__navSeen === true);
        if (sawNative) {
          await p.waitForFunction(
            (n: number) => (window as any).__navCount >= n,
            { timeout: 25000 },
            CATALOGUE.length
          );
          expect(`registrations on navigator.modelContext: ${await p.evaluate(() => (window as any).__navCount)}`).toBe(
            `registrations on navigator.modelContext: ${CATALOGUE.length}`
          );
        } else {
          console.warn(
            "[webmcp-e2e] this Chromium exposes no navigator.modelContext under --enable-features=WebMCP — the second door was not measured"
          );
        }

        /* the in-page door lists the same table, so nothing has to choose */
        await waitForTools(p);
        const names = (await listTools(p)).map((t) => t.name).sort();
        expect(names).toEqual(CATALOGUE);

        expect(`uncaught page errors: ${JSON.stringify(errors)}`).toBe("uncaught page errors: []");
      } finally {
        await p.close().catch(() => {});
      }
    } finally {
      await flagged.close().catch(() => {});
    }
  }, 120000);
});

/* ------------------------------------------------------------------
   4 — the doc lifecycle, measured on disk
   ------------------------------------------------------------------ */

describe("the doc tools move real bytes", () => {
  test("create, edit, undo, append, read, move, delete, restore", async () => {
    const created = await call("create_doc", { path: MADE, markdown: MADE_MD });
    expect(`create_doc → ${created.path}, rev is a string: ${typeof created.rev === "string"}`).toBe(
      `create_doc → ${MADE}, rev is a string: true`
    );
    await waitDisk(MADE, MADE_MD);

    const edited = await call("edit_doc", { path: MADE, find: "by a tool", replace: "by an agent" });
    expect(`edit_doc replaced: ${edited.replaced}`).toBe("edit_doc replaced: 1");
    const AFTER_EDIT = MADE_MD.replace("by a tool", "by an agent");
    await waitDisk(MADE, AFTER_EDIT);

    /* a text edit is a TEXT step on the one app-owned timeline (ADR 0014), so
       it steps back with no prompt and no confirmation to answer */
    const undone = await call("undo");
    expect(`undo applied: ${undone.applied}, confirm: ${undone.confirm ?? "(none)"}`).toBe(
      "undo applied: true, confirm: (none)"
    );
    await waitDisk(MADE, MADE_MD);

    await call("edit_doc", { path: MADE, find: "by a tool", replace: "by an agent" });
    await waitDisk(MADE, AFTER_EDIT);

    const appended = await call("append_to_doc", { path: MADE, markdown: "appended by the agent\n" });
    const AFTER_APPEND = AFTER_EDIT + "appended by the agent\n";
    expect(`append_to_doc bytes: ${appended.bytes === AFTER_APPEND.length}`).toBe("append_to_doc bytes: true");
    await waitDisk(MADE, AFTER_APPEND);

    const read = await call("read_doc", { path: MADE });
    expect(`read_doc markdown matches disk: ${read.markdown === AFTER_APPEND}`).toBe(
      "read_doc markdown matches disk: true"
    );
    expect(`read_doc unsaved: ${read.unsaved}, rev is a string: ${typeof read.rev === "string"}`).toBe(
      "read_doc unsaved: false, rev is a string: true"
    );

    const moved = await call("move_doc", { from: MADE, to: MOVED });
    expect(`move_doc → ${moved.to}`).toBe(`move_doc → ${MOVED}`);
    await waitDisk(MOVED, AFTER_APPEND);
    await waitUntil(() => !vaultHas(srv.vault, MADE), { timeout: 10000, label: "the old path to be gone" });

    const deleted = await call("delete_doc", { path: MOVED });
    expect(`delete_doc deleted: ${deleted.deleted}`).toBe("delete_doc deleted: true");
    await waitUntil(() => !vaultHas(srv.vault, MOVED), { timeout: 10000, label: "the deleted doc to leave disk" });

    const trash = await waitUntil(
      async () => {
        const t = await call("list_trash");
        return t.entries?.some((e: any) => e.path === MOVED) ? t : null;
      },
      { timeout: 15000, label: "the trash to list the deleted doc" }
    );
    const entry = trash.entries.find((e: any) => e.path === MOVED);

    const restored = await call("restore_from_trash", { id: entry.id });
    expect(`restore_from_trash → ${restored.path}`).toBe(`restore_from_trash → ${MOVED}`);
    await waitDisk(MOVED, AFTER_APPEND);
  }, 120000);
});

/* ------------------------------------------------------------------
   5 — errors are data
   ------------------------------------------------------------------ */

describe("a tool never throws — every refusal is a named result", () => {
  test("the API's own slugs come through verbatim, and the wrappers' own are named", async () => {
    const missing = await call("read_doc", { path: "nowhere/at-all.md" });
    expect(`read_doc unknown → ${missing.error}, message: ${typeof missing.message === "string"}`).toBe(
      "read_doc unknown → not-found, message: true"
    );

    const dup = await call("create_doc", { path: "notes/dup.md", markdown: "# no\n" });
    expect(`create_doc duplicate → ${dup.error}`).toBe("create_doc duplicate → exists");

    /* AGENTDOOR is in the seed twice deliberately: an exact find that matches
       more than once is the one edit a model must not guess at */
    const ambiguous = await call("edit_doc", { path: ANCHOR, find: "AGENTDOOR", replace: "x" });
    expect(`edit_doc ambiguous → ${ambiguous.error}, count ${ambiguous.count}`).toBe(
      "edit_doc ambiguous → ambiguous, count 2"
    );
    expect(`the doc is untouched: ${onDisk(ANCHOR) === ANCHOR_MD}`).toBe("the doc is untouched: true");

    const absent = await call("edit_doc", { path: ANCHOR, find: "NOT IN THE DOC", replace: "x" });
    expect(`edit_doc absent → ${absent.error}`).toBe("edit_doc absent → not-found");

    const stale = await call("write_doc", { path: ANCHOR, markdown: "# clobbered\n", rev: "not-the-rev" });
    expect(`write_doc stale rev → ${stale.error}`).toBe("write_doc stale rev → rev-conflict");
    expect(`the doc survived the conflict: ${onDisk(ANCHOR) === ANCHOR_MD}`).toBe(
      "the doc survived the conflict: true"
    );

    /* VERBATIM is the rule (ADR 0031): the settings route's own slug for a theme
       nobody serves is `unknown-theme` (0002 § PUT /api/settings), and a wrapper
       that tidied it into a `bad-*` of its own would hand the model a word no
       other client of this API has ever seen */
    const badTheme = await call("set_setting", { path: "theme", value: "no-such-theme" });
    expect(`set_setting bad theme → ${badTheme.error}`).toBe("set_setting bad theme → unknown-theme");

    /* no password has been set yet, so the terminal is not a door at all */
    const locked = await call("run_command", { command: "echo hi" });
    expect(
      `run_command while locked → ${["terminal-locked", "terminal-disabled"].includes(locked.error)} (${locked.error})`
    ).toBe("run_command while locked → true (" + locked.error + ")");
  }, 90000);
});

/* ------------------------------------------------------------------
   6 — the human UI follows the agent
   ------------------------------------------------------------------ */

describe("the UI is where the tool left it", () => {
  test("open_doc, set_mode, show_panel and open_settings all move the visible app", async () => {
    const opened = await call("open_doc", { path: ANCHOR, mode: "preview" });
    expect(`open_doc → ${opened.path}`).toBe(`open_doc → ${ANCHOR}`);
    await page.waitForFunction((p: string) => document.getElementById("stPath")!.textContent === p, { timeout: 10000 }, ANCHOR);
    expect(`the address bar followed: ${await page.evaluate(() => location.pathname)}`).toBe(
      `the address bar followed: /d/${encPath(ANCHOR)}`
    );

    await call("set_mode", { mode: "raw" });
    await page.waitForFunction(() => document.getElementById("doc")!.classList.contains("raw-mode"), {
      timeout: 10000,
    });

    let state = await call("get_app_state");
    expect(`get_app_state: ${state.activeDoc} in ${state.mode}, unsaved ${state.unsaved}`).toBe(
      `get_app_state: ${ANCHOR} in raw, unsaved false`
    );

    await call("show_panel", { panel: "assistant", open: false });
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 10000,
    });
    expect(`get_app_state sees the panel closed: ${(await call("get_app_state")).panels.assistant}`).toBe(
      "get_app_state sees the panel closed: false"
    );

    await call("show_panel", { panel: "assistant", open: true });
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("chat-open"), {
      timeout: 10000,
    });
    expect(`the assistant is open: ${await appClass("chat-open")}`).toBe("the assistant is open: true");

    const settings = await call("open_settings", { section: "ai" });
    expect(`open_settings → ${settings.view}/${settings.section}`).toBe("open_settings → settings/ai");
    await page.waitForFunction(() => document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 10000,
    });
    state = await call("get_app_state");
    expect(`get_app_state view: ${state.view}, section ${state.settingsSection}`).toBe(
      "get_app_state view: settings, section ai"
    );

    /* back onto a document, so the tests after this one start where they think */
    await call("open_doc", { path: ANCHOR });
    await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("route-settings"), {
      timeout: 10000,
    });
  }, 90000);
});

/* ------------------------------------------------------------------
   7 — settings
   ------------------------------------------------------------------ */

describe("set_setting reaches the page and the file", () => {
  test("a theme change repaints the app and lands in settings.toml", async () => {
    const set = await call("set_setting", { path: "theme", value: "terminal" });
    expect(`set_setting → ${set.path} = ${set.value}`).toBe("set_setting → theme = terminal");

    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "terminal", {
      timeout: 10000,
    });

    await waitUntil(() => /^theme = "terminal"$/m.test(onDisk(".znotes/settings.toml")), {
      timeout: 10000,
      label: "settings.toml to hold the theme",
    });

    const settings = await call("get_settings");
    expect(`get_settings agrees: ${settings.settings.theme}`).toBe("get_settings agrees: terminal");
  }, 60000);
});

/* ------------------------------------------------------------------
   8 — search
   ------------------------------------------------------------------ */

describe("search_docs hands back the server's own answer", () => {
  test("a fuzzy query finds the seeded doc and a regex says it ran as one", async () => {
    const fuzzy = await call("search_docs", { query: "anchor" });
    expect(`fuzzy mode: ${fuzzy.mode}`).toBe("fuzzy mode: fuzzy");
    expect(`fuzzy found the doc: ${fuzzy.results.some((r: any) => r.path === ANCHOR)}`).toBe(
      "fuzzy found the doc: true"
    );

    const rx = await call("search_docs", { query: "AGENTDOOR (one|two)", mode: "regex" });
    expect(`regex mode: ${rx.mode}`).toBe("regex mode: regex");
    expect(`regex found the lines: ${rx.results.some((r: any) => r.path === ANCHOR)}`).toBe(
      "regex found the lines: true"
    );
  }, 60000);
});

/* ------------------------------------------------------------------
   9 — the assistant
   ------------------------------------------------------------------ */

describe("ask_assistant is the composer without the composer", () => {
  test("the reply comes back as data and the human's draft is untouched", async () => {
    await call("show_panel", { panel: "assistant", open: true });
    await page.evaluate(() => {
      const c = document.getElementById("composer") as HTMLTextAreaElement | null;
      if (c) c.value = "a half-typed human question";
    });

    mock.script(reply.text("the mock answered the agent"));
    const answered = await call("ask_assistant", { message: "hi" });

    expect(`ask_assistant reply: ${String(answered.reply ?? "").includes("the mock answered the agent")}`).toBe(
      "ask_assistant reply: true"
    );
    expect(`no proposal was made: ${answered.proposal === null || answered.proposal === undefined}`).toBe(
      "no proposal was made: true"
    );

    /* the tool takes its text as an argument; the human's half-typed line is
       not the agent's to send, and not the agent's to clear */
    const draft = await page.evaluate(
      () => (document.getElementById("composer") as HTMLTextAreaElement | null)?.value ?? "(no composer)"
    );
    expect(`the composer is untouched: ${draft}`).toBe("the composer is untouched: a half-typed human question");
  }, 90000);
});

/* ------------------------------------------------------------------
   10 — the terminal
   ------------------------------------------------------------------ */

describe("the terminal tools stand behind the terminal's own gates", () => {
  test("unlock, run, and lock — each refusal named", async () => {
    /* the password is set through the API, exactly as terminal.test.ts's
       `armed()` preamble does: setting the FIRST password is free by design */
    const set = await srv.api("POST", "/api/terminal/password", { password: TERMINAL_PASSWORD });
    expect(`set password → ${set.status}`).toBe("set password → 200");

    const unlocked = await call("unlock_terminal", { password: TERMINAL_PASSWORD });
    expect(`unlock_terminal → unlocked ${unlocked.unlocked}, error ${unlocked.error ?? "(none)"}`).toBe(
      "unlock_terminal → unlocked true, error (none)"
    );

    const ran = await call("run_command", { command: "echo hi" });
    expect(`run_command exit ${ran.code}, output carries hi: ${String(ran.output ?? "").includes("hi")}`).toBe(
      "run_command exit 0, output carries hi: true"
    );

    const status = await call("terminal_status");
    expect(`terminal_status unlocked: ${status.unlocked}`).toBe("terminal_status unlocked: true");

    const relocked = await call("lock_terminal");
    expect(`lock_terminal → unlocked ${relocked.unlocked}`).toBe("lock_terminal → unlocked false");

    const refused = await call("run_command", { command: "echo hi" });
    expect(`run_command after lock → ${refused.error}`).toBe("run_command after lock → terminal-locked");
  }, 120000);
});
