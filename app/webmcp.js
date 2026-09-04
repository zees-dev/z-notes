/* ============================================================
   webmcp.js — the agent's app.js.

   app.js wires pointers and chords to the feature functions. This file wires
   tool calls to the same functions. A tool is the button pressed from
   somewhere else, not a second implementation, so a doc an agent creates
   lands on the undo timeline, opens in the pane and appears in the tree the
   way a doc a person creates does. A new UI operation is not finished until
   it has a row in the table below (ADR 0031).

   Three rules the table keeps:

     - Errors are data. A tool never throws. A failure comes back as
       `{ error, message, ...extra }`, the API's own error shape (ADR 0002),
       with the server's slug and sentence passed through as they are. The
       WebMCP draft has no settled way to carry a rejection back to the
       invoker, and a model cannot correct itself from an opaque failure.
     - The catalogue is static. Every tool is registered once, at boot. A tool
       that cannot act right now says so in its result (`terminal-locked`)
       instead of vanishing from a list the agent already read.
     - No tool opens a secret block, returns its plaintext, or asks for the
       vault's key phrase. An agent platform is a cloud, and the rule that no
       plaintext secret leaves this browser holds for it too. `lock_vault` is
       the only secrets verb, and the words the crypto path is spelled with do
       not appear in this file. `tests/webmcp.test.ts` greps for them.

   A browser with no `document.modelContext` gets one, in-page, over the same
   table (`installModelContext`), so a puppeteer- or DevTools-driven agent
   discovers and calls what Chrome's own agent would. A native
   `document.modelContext` is never replaced or wrapped.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { vaultOf } from "./ui.js";
import { pendingHistory, stepHistory } from "./history.js";
import { doDelete, loadTree, mintEntry, moveByPath } from "./tree.js";
import { ensureLoaded, flushTextRun, openDoc, replaceDocText, saveDoc, setMode, syncRaw } from "./editor.js";
import { proposalAction, sendMessageText, startNewSession, turnInFlight } from "./chat.js";
import { emptyTrash, purgeTrashEntry, refreshTrash, restoreTrashEntry, toggleTrash } from "./trash.js";
import { adoptSettings, savedValue, showSettings } from "./settings.js";
import { app, closeNav, dismissTop, isDrawer, openNav, overlayOpen, syncNow, toggleChat } from "./shell.js";
import { loadCommands, refreshTerminalStatus, runTerminal, termRunningId, terminalLock, terminalStop, terminalUnlock } from "./terminal.js";
import { lockVault, vault } from "./secrets.js";

/* ============================================================
   REFUSALS AND RESULTS
   ============================================================ */

/** A refusal this module makes itself, in the API's error shape, so an agent
    reads one vocabulary for a server's 404 and for "the terminal is locked".
    The status is inert; nothing here is on the wire. */
const deny = (error, message, extra) => new api.ApiError(409, { error, message, ...extra });

/** Wrap one tool's execute so it answers with data whatever happens. The
    extra fields of an error body (`rev` on a conflict, `count` on an
    ambiguous edit) travel with it; they are what the model corrects from. */
const attempt = (fn) => async (input, opts) => {
  try {
    return await fn(input || {}, opts || {});
  } catch (err) {
    if (err && err.name === "AbortError") return { error: "aborted", message: "Cancelled." };
    if (err && err.name === "ApiError") {
      const { error, message, ...extra } = err.body || {};
      return { error: err.code, message: err.message, ...extra };
    }
    return { error: "failed", message: (err && err.message) || String(err) };
  }
};

const str = (v) => (v == null ? "" : String(v));

/* ============================================================
   THE VOCABULARY THE SCHEMAS SHARE
   ============================================================ */

const schema = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });

const NO_INPUT = schema({});

const DOC_PATH = { type: "string", description: "Vault-qualified doc path, e.g. notes/todo.md or @work/inbox.md." };
const ENTRY_PATH = { type: "string", description: "Vault-qualified doc or folder path, e.g. notes or @work/inbox.md." };
const MARKDOWN = { type: "string", description: "Markdown source text." };
const VAULT_ID = { type: "string", description: "Vault id, e.g. vault (the primary) or work. Defaults to the primary vault." };
const REMOTE_URL = { type: "string", description: "The remote repository URL, http(s) only and without credentials in it." };
const TRASH_ID = { type: "string", description: "Trash entry id, as list_trash reports it." };
const PROPOSAL_ID = { type: "string", description: "Proposal id, as list_proposals or ask_assistant reports it." };
const COMMAND_ID = { type: "string", description: "Command record id, as list_commands reports it." };

/* ============================================================
   READING THE APP'S OWN STATE
   ============================================================ */

/** Every vault, or the one with this id. `bad-vault` for an id nobody serves. */
function vaultsOf(id) {
  if (!id) return state.vaults;
  const v = state.vaults.find((x) => x.id === id);
  if (!v) throw deny("bad-vault", "No such vault: " + id + ".");
  return [v];
}

const isPrimary = (id) => !id || id === "vault";

/** The tree node at `path`, in any vault, or null. The tree is this client's
    answer to "does that exist, and is it a folder"; asking the server would
    be asking a second authority the same question. */
function findNode(path, nodes) {
  for (const n of nodes || state.vaults.flatMap((v) => v.tree || [])) {
    if (n.path === path) return n;
    const hit = n.type === "folder" && findNode(path, n.children || []);
    if (hit) return hit;
  }
  return null;
}

/** Depth-first, in tree order, the order the sidebar draws. */
function flatten(nodes, out, under) {
  for (const n of nodes) {
    const folder = n.type === "folder";
    if (!under || n.path === under || n.path.indexOf(under + "/") === 0) {
      out.push(
        folder
          ? { path: n.path, type: "folder", title: n.name }
          : { path: n.path, type: "doc", title: n.title, bytes: n.bytes, mtime: n.mtime, empty: !!n.empty, hasSecrets: !!n.hasSecrets }
      );
    }
    if (folder) flatten(n.children || [], out, under);
  }
  return out;
}

/** The three panels: how to read each one and how to move it. Below the dock
    width the sidebar is a drawer (`nav-open`), above it a column that can be
    collapsed; one question, two answers. */
const PANELS = {
  sidebar: {
    open: () => (isDrawer() ? app.classList.contains("nav-open") : !app.classList.contains("sidebar-collapsed")),
    set: (want) => (isDrawer() ? (want ? openNav() : closeNav()) : app.classList.toggle("sidebar-collapsed", !want)),
  },
  assistant: { open: () => app.classList.contains("chat-open"), set: () => toggleChat() },
  trash: {
    open: () => !!state.trash.open,
    set: () => {
      if (!state.trash.available) throw deny("failed", "This vault has no trash.");
      toggleTrash();
    },
  },
};

/** The doc's text as it is right now: the buffer when the pane holds one,
    the file otherwise. Every read and read-modify-write goes through here,
    so a tool never answers with bytes the user has already typed over. */
async function docText(path) {
  if (path === state.active) syncRaw();
  return str((await ensureLoaded(path)).markdown);
}

const byteLen = (s) => new TextEncoder().encode(s).length;

/** Put the open buffer on disk before a tool navigates away from it. The
    human routes ask (`guardRawExit`); an agent has nobody to ask, and the
    answer is always the same one, saved and never discarded, so it is settled
    before any function that could raise the question runs. */
async function settleBuffer() {
  if (state.active && state.dirty) await saveDoc(state.active, { silent: true });
}

/** Dotted setting path → the nested patch the settings route takes. */
const nest = (path, value) => str(path).split(".").reduceRight((v, k) => ({ [k]: v }), value);

/* The terminal's refusals, asked before the request instead of after it. A
   locked terminal is a state the agent can fix (`unlock_terminal`), and
   saying so is worth more than a 401. Asked fresh, never off the cached
   status: a password set on the settings page after this tab booted leaves
   the boot-time answer saying the terminal is off. */
async function terminalOn() {
  const st = await refreshTerminalStatus();
  if (!st || !st.enabled) throw deny("terminal-disabled", "The terminal is switched off in Settings.");
  if (!st.configured) throw deny("terminal-disabled", "No terminal password is set, so the terminal is off.");
  return st;
}
async function terminalOpen() {
  const st = await terminalOn();
  if (!st.unlocked) throw deny("terminal-locked", "The terminal is locked. Unlock it with the terminal password.");
  return st;
}
async function terminalReady() {
  const st = await terminalOpen();
  if (state.term.busy) throw deny("terminal-busy", "A command is already running.");
  return st;
}

/**
 * One step along the app's timeline (ADR 0014). A text step is awaited. A
 * file step raises a confirmation the user has to answer, and a tool call
 * that waited on a human would hold the browser's tool queue open for as long
 * as the dialog stood, so it is started, reported, and left with the person
 * it is addressed to.
 */
async function stepTimeline(redo) {
  flushTextRun();
  const entry = pendingHistory(redo);
  if (!entry) return { applied: false, entry: null };
  const at = { kind: entry.kind, path: entry.path || entry.to || entry.from || null };
  /* the refusal ⌘Z makes under a dialog, very possibly the one the previous
     call raised: a second confirm over the first would strand its promise */
  if (overlayOpen()) return { applied: false, entry: at, confirm: "The app is already asking the user a question" };
  if (entry.kind !== "text") {
    stepHistory(redo).catch(() => {});
    return { applied: false, entry: at, confirm: "The app is asking the user to confirm" };
  }
  return { applied: !!(await stepHistory(redo)), entry: at };
}

/* ============================================================
   THE CATALOGUE — one row per operation the human UI offers.

   Names are snake_case verbs. A description says what the tool does and
   what it answers with, and every input property says the shape it expects.
   This is the entire prompt the model gets about this app. A row without
   `inputSchema` takes none, without `annotations` has none, and its `title`
   is its name with the underscores taken out.
   ============================================================ */
const TOOLS = [
  {
    name: "get_app_state",
    description:
      "Report what the app is showing: the open doc, the view and mode, whether the buffer is unsaved, the event connection, sync state, every vault, the secrets and terminal state, the assistant session, which panels are open, and whether undo or redo has a step waiting. Call this first.",
    annotations: { readOnlyHint: true },
    execute: async () => {
      const s = state.sync || {};
      const term = state.term.status || {};
      const sess = state.session || {};
      return {
        activeDoc: state.active,
        view: state.view,
        settingsSection: state.settingsSection,
        mode: state.mode,
        unsaved: !!state.dirty,
        connection: state.conn,
        sync: { state: s.state || null, remote: s.remote || null },
        vaults: state.vaults.map((v) => ({ id: v.id, label: v.label, sync: (v.sync && v.sync.state) || null })),
        secrets: { state: vault.state, unlocked: !!vault.unlocked },
        terminal: { enabled: !!term.enabled, unlocked: !!term.unlocked, running: term.running || state.term.running || null },
        assistant: {
          sessionId: sess.id || null,
          model: sess.model || null,
          messages: (sess.messages || []).length,
          proposalsPending: state.proposals.filter((p) => p.state === "pending").length,
        },
        panels: Object.fromEntries(Object.entries(PANELS).map(([k, p]) => [k, p.open()])),
        undo: { canUndo: !!pendingHistory(false), canRedo: !!pendingHistory(true) },
      };
    },
  },
  {
    name: "list_vaults",
    description: "List every connected vault with its id, label, path prefix, git remote, doc count and sync state. The primary vault has the empty prefix. A secondary vault's docs are addressed as @id/path.",
    annotations: { readOnlyHint: true },
    execute: async () => {
      const r = await api.getVaults();
      return {
        vaults: (r.vaults || []).map((v) => ({ id: v.id, label: v.label, prefix: v.prefix, remote: v.remote, repo: !!v.repo, docCount: v.docCount, sync: (v.sync && v.sync.state) || null })),
      };
    },
  },
  {
    name: "list_docs",
    description: "List every doc and folder in tree order, with qualified paths, titles, sizes and modification times. Narrow it to one vault or one folder subtree. This is the map of the vault. Read it before guessing a path.",
    inputSchema: schema({
      vault: VAULT_ID,
      folder: { type: "string", description: "Qualified folder path to list, e.g. notes or @work/archive. Omit for everything." },
    }),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ vault: id, folder }) => {
      const vaults = vaultsOf(id);
      return {
        vaults: vaults.map((v) => ({ id: v.id, label: v.label, prefix: v.prefix, docCount: v.docCount })),
        docs: flatten(vaults.flatMap((v) => v.tree || []), [], folder ? str(folder).replace(/\/+$/, "") : null),
      };
    },
  },
  {
    name: "read_doc",
    description: "Read one doc's markdown with its rev, size and modification time. When it is the open doc with unsaved edits you get the buffer the user is looking at and unsaved: true. Pass the rev back to write_doc to write only if nothing moved underneath.",
    inputSchema: schema({ path: DOC_PATH }, ["path"]),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ path }) => {
      const unsaved = path === state.active && state.dirty;
      const d = unsaved ? (syncRaw(), await ensureLoaded(path)) : await api.getDoc(path);
      const markdown = str(d.markdown);
      return { path: d.path || path, title: d.title, rev: d.rev, markdown, bytes: unsaved ? byteLen(markdown) : d.bytes, mtime: d.mtime, hasSecrets: !!d.hasSecrets, unsaved };
    },
  },
  {
    name: "search_docs",
    description: "Search every vault and get scored hits with their qualified paths and matching lines. A fuzzy query matches loosely. Mode regex, or a /pattern/flags query, reads the query as a regular expression.",
    inputSchema: schema(
      {
        query: { type: "string", description: "What to look for. /pattern/flags is read as a regex whatever the mode." },
        mode: { type: "string", enum: ["fuzzy", "regex"], description: "How to read the query. Defaults to fuzzy." },
        limit: { type: "integer", description: "How many hits to return, 1-100. Defaults to 24." },
      },
      ["query"]
    ),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ query, mode, limit }) => {
      if (mode != null && mode !== "fuzzy" && mode !== "regex") throw deny("bad-mode", 'Search mode is "fuzzy" or "regex".');
      return api.search(str(query), { limit: limit || 24, mode: mode || null });
    },
  },
  {
    name: "list_trash",
    description: "List what has been deleted and can still be restored: each entry's id, path, when it was deleted and when it will be purged, plus the retention window. Reports available: false when the server has no trash.",
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      await refreshTrash();
      const t = state.trash;
      return { available: !!t.available, retentionDays: t.retentionDays, entries: t.entries };
    },
  },
  {
    name: "get_settings",
    description: "Read the whole settings document and the server's meta block, which lists the themes, densities, colour schemes, efforts and numeric bounds a value may take. Credentials come back masked. Use it to learn what set_setting accepts.",
    annotations: { readOnlyHint: true },
    execute: async () => ({ settings: state.settings, meta: state.meta }),
  },
  {
    name: "list_proposals",
    description: "List the assistant's edit proposals with their id, label, target doc and state, plus the ids on the apply stack, newest last. Only the top of the stack can be reverted.",
    annotations: { readOnlyHint: true },
    execute: async () => ({
      proposals: state.proposals.map((p) => ({ id: p.id, label: p.label, state: p.state, stackIndex: p.stackIndex, path: p.target })),
      stack: (state.stack || []).map((e) => e.id),
    }),
  },
  {
    name: "get_conversation",
    description: "Read the assistant session: its id, the model in use, and the most recent messages with their roles, text and any proposal each one carries.",
    inputSchema: schema({ limit: { type: "integer", description: "How many of the most recent messages to return. Defaults to 20." } }),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ limit }) => {
      const s = state.session || {};
      const n = Math.max(1, Number(limit) || 20);
      return {
        sessionId: s.id || null,
        model: s.model || null,
        messages: (s.messages || []).slice(-n).map((m) => ({ id: m.id, role: m.role, content: m.content, proposalId: m.proposalId || null, at: m.at })),
      };
    },
  },
  {
    name: "terminal_status",
    description: "Report whether the terminal is switched on, has a password configured, is unlocked in this tab, and what is running. These are the four facts run_command needs.",
    annotations: { readOnlyHint: true },
    execute: async () => (await refreshTerminalStatus()) || { error: "terminal-disabled", message: "This server serves no terminal." },
  },
  {
    name: "list_commands",
    description: "List the assistant's command records: what it asked to run, which message each belongs to, and whether it is waiting for approval, running, done, failed or rejected.",
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      /* the records carry command output and sit behind the password too;
         `loadCommands` paints an empty list on a 401, which as an answer
         would say "nothing queued" about a terminal that refused to say */
      await terminalOpen();
      await loadCommands();
      return { commands: state.commands.map((c) => ({ id: c.id, command: c.command, state: c.state, messageId: c.messageId })) };
    },
  },

  /* ---------- navigation ---------- */
  {
    name: "open_doc",
    description: "Open a doc in the editor pane, optionally at a line and in a given mode. The tree, the statusbar and the address bar follow. An unsaved buffer in the doc being left is saved on the way, never discarded.",
    inputSchema: schema(
      {
        path: DOC_PATH,
        mode: { type: "string", enum: ["raw", "preview"], description: "Which view to land in. Defaults to the current one." },
        line: { type: "integer", description: "1-based source line to scroll to and put the caret on." },
      },
      ["path"]
    ),
    execute: async ({ path, mode, line }) => {
      if (mode != null && mode !== "raw" && mode !== "preview") throw deny("bad-mode", 'Mode is "raw" or "preview".');
      if (!state.docPaths.has(path)) throw deny("not-found", "No such doc: " + path + ".");
      await openDoc(path, { force: true, line: line == null ? null : line });
      if (state.active !== path) throw deny("failed", "Could not open " + path + ".");
      if (mode) setMode(mode, { force: true, silent: true });
      return { path: state.active, mode: state.mode };
    },
  },
  {
    name: "set_mode",
    description: "Switch the editor pane between the rendered preview and the raw markdown source. An unsaved buffer is written first, so the switch never asks the user anything.",
    inputSchema: schema({ mode: { type: "string", enum: ["raw", "preview"], description: 'Which view to show: "raw" or "preview".' } }, ["mode"]),
    execute: async ({ mode }) => {
      if (mode !== "raw" && mode !== "preview") throw deny("bad-mode", 'Mode is "raw" or "preview".');
      if (!state.active) throw deny("no-active-doc", "No doc is open.");
      await settleBuffer();
      setMode(mode, { force: true, silent: true });
      return { mode: state.mode };
    },
  },
  {
    name: "open_settings",
    description: "Show the settings page, optionally at one of its sections: appearance, editing, trash, upload, git, secrets, ai, terminal. The doc stays open behind it. An unsaved buffer is written first.",
    inputSchema: schema({ section: { type: "string", description: "Which section to land on, e.g. ai. Omit for the top of the page." } }),
    execute: async ({ section }) => {
      await settleBuffer();
      showSettings(section || "", {});
      return { view: "settings", section: state.settingsSection };
    },
  },
  {
    name: "show_panel",
    description: "Open or close one of the three panels (the sidebar tree, the assistant, the trash drawer) and report where it ended up. Already in that state, nothing moves.",
    inputSchema: schema(
      {
        panel: { type: "string", enum: ["sidebar", "assistant", "trash"], description: "Which panel to move." },
        open: { type: "boolean", description: "true to show it, false to hide it." },
      },
      ["panel", "open"]
    ),
    execute: async ({ panel, open }) => {
      const p = PANELS[panel];
      if (!p) throw deny("bad-panel", 'Panel is "sidebar", "assistant" or "trash".');
      const want = open !== false;
      if (p.open() !== want) p.set(want);
      return { panel, open: p.open() };
    },
  },
  {
    name: "dismiss_overlay",
    description: "Close whatever floats above the app (the palette, a dialog, the context menu, an inline create row), one layer per call, as Escape does. Reports whether there was anything to dismiss.",
    execute: async () => ({ dismissed: !!dismissTop() }),
  },

  /* ---------- doc lifecycle ---------- */
  {
    name: "create_doc",
    description: "Create a doc at a path, with optional initial markdown, and open it. Missing parent folders are made on the way. Answers with the new doc's path and rev. A path already taken answers exists.",
    inputSchema: schema({ path: DOC_PATH, markdown: MARKDOWN }, ["path"]),
    execute: async ({ path, markdown }) => {
      /* opening the new doc leaves the current one, and `openDoc` would ask
         about an unsaved buffer on the way */
      await settleBuffer();
      const r = await mintEntry({ path, kind: "doc", markdown }, { open: true });
      return { path: (r && r.path) || path, rev: r && r.rev };
    },
  },
  {
    name: "create_folder",
    description: "Create a folder, making any missing parents on the way. Answers with its path. A path already taken answers exists.",
    inputSchema: schema({ path: { type: "string", description: "Qualified folder path, e.g. notes/archive or @work/inbox." } }, ["path"]),
    execute: async ({ path }) => {
      const r = await mintEntry({ path, kind: "folder" });
      return { path: (r && r.path) || path };
    },
  },
  {
    name: "write_doc",
    description: "Replace a doc's whole markdown and save it. Pass the rev you read to be refused with rev-conflict if it moved since, or omit it to overwrite. The change is one step on the app's undo timeline and the open editor repaints.",
    inputSchema: schema(
      { path: DOC_PATH, markdown: MARKDOWN, rev: { type: "string", description: "The rev read_doc gave you, to write only if nothing changed since." } },
      ["path", "markdown"]
    ),
    execute: async ({ path, markdown, rev }) => replaceDocText(path, str(markdown), rev),
  },
  {
    name: "edit_doc",
    description: "Replace exact text in a doc. find must match the file byte for byte. One occurrence is replaced and saved. Several answer ambiguous with a count unless all is true, and none answers not-found. Prefer this over write_doc for a small change.",
    inputSchema: schema(
      {
        path: DOC_PATH,
        find: { type: "string", description: "The exact text to find, including its line breaks and indentation." },
        replace: { type: "string", description: "The text to put in its place. Empty deletes the found text." },
        all: { type: "boolean", description: "true replaces every occurrence. Defaults to false." },
      },
      ["path", "find", "replace"]
    ),
    execute: async ({ path, find, replace, all }) => {
      const needle = str(find);
      if (!needle) throw deny("failed", "find must not be empty.");
      const text = await docText(path);
      const parts = text.split(needle);
      const n = parts.length - 1;
      if (!n) throw deny("not-found", "That text is not in " + path + ".");
      if (n > 1 && all !== true) throw deny("ambiguous", "That text occurs " + n + " times in " + path + ". Pass all, or find more context.", { count: n });
      const rep = str(replace);
      const next = all === true ? parts.join(rep) : text.replace(needle, () => rep);
      const r = await replaceDocText(path, next);
      return { path: r.path, rev: r.rev, replaced: all === true ? n : 1 };
    },
  },
  {
    name: "append_to_doc",
    description: "Add markdown to the end of a doc and save it. A line break is inserted first when the doc does not already end with one, so the appended text starts on its own line.",
    inputSchema: schema({ path: DOC_PATH, markdown: MARKDOWN }, ["path", "markdown"]),
    execute: async ({ path, markdown }) => {
      const text = await docText(path);
      return replaceDocText(path, text + (text && !text.endsWith("\n") ? "\n" : "") + str(markdown));
    },
  },
  {
    name: "save_doc",
    description: "Write the open buffer to disk. Defaults to the doc on screen. Answers with whether it reached the server and the rev it now has.",
    inputSchema: schema({ path: DOC_PATH }),
    execute: async ({ path }) => {
      const p = path || state.active;
      if (!p) throw deny("no-active-doc", "No doc is open.");
      const saved = await saveDoc(p);
      const doc = state.docs.get(p);
      return { path: p, saved: !!saved, rev: (doc && doc.rev) || null };
    },
  },
  {
    name: "move_doc",
    description: "Move or rename a doc or a folder, one operation, as the sidebar does it. Every [[link]] that resolved to the doc is rewritten in the same commit, and the count comes back. A folder takes its subtree with it.",
    inputSchema: schema({ from: ENTRY_PATH, to: { type: "string", description: "The new qualified path, in the SAME vault, e.g. notes/renamed.md." } }, ["from", "to"]),
    execute: async ({ from, to }) => {
      if (!findNode(from)) throw deny("not-found", "No such doc or folder: " + from + ".");
      /* `moveEntry` answers its refusals with a toast and `false`, the right
         shape for a rename field and no shape for a caller with no screen, so
         the three it can refuse are named here first. A vault is a repository,
         and a move out of one is a delete plus a create with two histories to
         match; `]` and a line break would break out of every `[[link]]` the
         rewrite splices the name into. The server refuses all three too. */
      if (vaultOf(to) !== vaultOf(from)) throw deny("bad-path", "A move cannot cross vaults.");
      if (/[\]\r\n]/.test(to)) throw deny("bad-path", 'A name cannot contain "]" or a line break.');
      if (findNode(to)) throw deny("exists", to + " already exists.");
      const r = await moveByPath(from, to);
      if (!r) throw deny("failed", "The move was refused: the unsaved buffer could not be written first.");
      return { from, to: r.path || to, backlinksUpdated: r.backlinksUpdated || 0 };
    },
  },
  {
    name: "delete_doc",
    description: "Delete a doc or a folder. Where the server keeps a trash it goes there and list_trash will show it. The pane moves to the neighbouring doc. Unsaved text in the doc being deleted is written first.",
    inputSchema: schema({ path: ENTRY_PATH }, ["path"]),
    /* consequential even with a trash: a folder takes its subtree with it,
       and on a server without a trash the git history is all that is left.
       This is the delete confirmation, delegated to the browser (ADR 0031). */
    annotations: { consequentialHint: true },
    execute: async ({ path }) => {
      const node = findNode(path);
      if (!node) throw deny("not-found", "No such doc or folder: " + path + ".");
      await settleBuffer();
      if (!(await doDelete(path, node.type === "folder" ? "folder" : "doc", { force: true }))) throw deny("failed", "Could not delete " + path + ".");
      return { path, deleted: true, trash: !!state.trash.available };
    },
  },
  {
    name: "undo",
    description: "Take back the last thing that happened in this tab, a text edit or a file operation, whichever came last, navigating to the doc it is about. A file step asks the user first and answers applied: false until they agree.",
    execute: () => stepTimeline(false),
  },
  {
    name: "redo",
    description: "Put back the last thing undo took away, navigating to the doc it is about. A file step asks the user first and answers applied: false until they agree.",
    execute: () => stepTimeline(true),
  },

  /* ---------- trash ---------- */
  {
    name: "restore_from_trash",
    description: "Put a deleted doc or folder back where it came from and open it. Answers with the path it landed at. A path that has since been taken answers exists, and the entry stays in the trash.",
    inputSchema: schema({ id: TRASH_ID }, ["id"]),
    execute: async ({ id }) => {
      await settleBuffer(); // a restore opens what it put back, which leaves the current doc
      return { id, path: (await restoreTrashEntry(id)).path };
    },
  },
  {
    name: "purge_trash",
    description: "Delete one trash entry for good. Nothing but the git history is left afterwards.",
    inputSchema: schema({ id: TRASH_ID }, ["id"]),
    annotations: { consequentialHint: true },
    execute: async ({ id }) => {
      await purgeTrashEntry(id);
      return { id, purged: true };
    },
  },
  {
    name: "empty_trash",
    description: "Delete every trash entry for good, expired or not, and report how many went. Nothing but the git history is left afterwards.",
    annotations: { consequentialHint: true },
    execute: () => emptyTrash(),
  },

  /* ---------- settings and vaults ---------- */
  {
    name: "set_setting",
    description: "Set one setting by its dotted path (theme, editor.clickToEdit, git.autoSync, ai.effort). The page repaints and settings.toml records it. Answers with the value that was stored, which may be clamped or normalised. get_settings lists what each one accepts.",
    inputSchema: schema(
      {
        path: { type: "string", description: "Dotted setting path, e.g. theme, density, editor.homeDoc, git.autoSyncSeconds." },
        value: { description: "The new value: a string, number or boolean, as that setting takes." },
      },
      ["path", "value"]
    ),
    execute: async ({ path, value }) => {
      if (!path || typeof path !== "string") throw deny("failed", "A dotted setting path is required.");
      adoptSettings(await api.patchSettings(nest(path, value)));
      return { path, value: savedValue(path) };
    },
  },
  {
    name: "sync_vault",
    description: "Run a vault's git pipeline now (take what is upstream fast-forward-only, then commit and push what is local) and answer with the sync status it ended in. Defaults to the primary vault.",
    inputSchema: schema({ vault: VAULT_ID }),
    execute: async ({ vault: id }) => {
      vaultsOf(id);
      if (!isPrimary(id)) return api.syncVault(id);
      await syncNow();
      return api.getSyncStatus();
    },
  },
  {
    name: "add_vault",
    description: "Connect another git repository as a second vault. It is cloned into the vaults home and its docs become addressable as @id/path. Without a token the primary vault's stored credential is copied. Answers with the new vault's descriptor.",
    inputSchema: schema(
      {
        url: REMOTE_URL,
        name: { type: "string", description: "What to call it in the sidebar. Defaults to the repository name." },
        token: { type: "string", description: 'Access token for this remote. Omit to copy the primary vault\'s; pass "" to attach anonymously.' },
      },
      ["url"]
    ),
    execute: async ({ url, name, token }) => {
      const r = await api.addVault({ url, name, token });
      return (r && r.vault) || r;
    },
  },
  {
    name: "set_vault_remote",
    description: "Attach a vault to a git remote, or re-point it at another one. This is what the Repository line in Settings does, including the first git init when there is no repository yet. Answers with that vault's sync status. Defaults to the primary vault.",
    inputSchema: schema({ vault: VAULT_ID, url: REMOTE_URL }, ["url"]),
    execute: async ({ vault: id, url }) => {
      vaultsOf(id);
      return isPrimary(id) ? api.attachRemote(url) : api.setVaultRemote(id, url);
    },
  },
  {
    name: "disconnect_vault",
    description: "Drop a secondary vault from the registry. Its directory and its git history stay on disk. Only this app stops serving it, and its docs leave the tree.",
    inputSchema: schema({ id: { type: "string", description: "The vault id to disconnect. The primary vault cannot be disconnected." } }, ["id"]),
    annotations: { consequentialHint: true },
    execute: async ({ id }) => {
      vaultsOf(id || "?");
      await api.removeVault(id);
      await loadTree().catch(() => {});
      return { id, disconnected: true };
    },
  },

  /* ---------- the assistant ---------- */
  {
    name: "ask_assistant",
    description: "Send a message to the vault's own AI relay and wait for the turn to finish. Answers with the reply text, the edit proposal it made (if any) and the commands it queued. Cancelling the call stops the stream.",
    inputSchema: schema({ message: { type: "string", description: "What to ask. The open doc is the relay's context." } }, ["message"]),
    annotations: { untrustedContentHint: true },
    execute: async ({ message }, opts) => {
      /* the composer's own send supersedes a reply still arriving, because
         the person typing is the person reading; an agent is not, so it waits */
      if (turnInFlight()) throw deny("assistant-busy", "The assistant is still answering. Wait for the turn to finish, or start a new session.");
      const r = await sendMessageText(str(message), { signal: opts.signal });
      if (r && r.aborted) throw deny("aborted", "Cancelled.");
      return { reply: r.reply, proposal: r.proposal, commands: r.commands };
    },
  },
  {
    name: "accept_proposal",
    description: "Apply the assistant's proposed edit to the doc and push it onto the revert stack. Answers with the proposal's new state.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    execute: ({ id }) => proposalAction(id, "accept"),
  },
  {
    name: "revert_proposal",
    description: "Take back an applied proposal, restoring the doc as it was. Only the top of the apply stack can be reverted; anything else answers not-stack-top.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    execute: ({ id }) => proposalAction(id, "revert"),
  },
  {
    name: "reject_proposal",
    description: "Dismiss a proposal the assistant made without applying it. An already applied one has to be reverted first.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    execute: ({ id }) => proposalAction(id, "reject"),
  },
  {
    name: "new_session",
    description: "Clear the assistant's context and start a fresh session. Any turn still streaming belongs to the session being left and is stopped. Answers with the new session id.",
    execute: async () => {
      /* `startNewSession` reports its failure as a toast and keeps the old
         session; the id is what says whether a new one began */
      const before = (state.session && state.session.id) || null;
      await startNewSession();
      const after = (state.session && state.session.id) || null;
      if (!after || after === before) throw deny("failed", "Could not start a new session.");
      return { sessionId: after };
    },
  },

  /* ---------- the terminal ---------- */
  {
    name: "unlock_terminal",
    description: "Unlock the terminal for this tab with the terminal password, so commands can run. Answers with the terminal status. A wrong password answers terminal-locked, and the server holds its own backoff.",
    inputSchema: schema({ password: { type: "string", description: "The terminal password, as set in Settings › Terminal." } }, ["password"]),
    execute: async ({ password }) => {
      await terminalOn();
      const st = await terminalUnlock(str(password));
      if (!st || !st.unlocked) throw deny("terminal-locked", "That terminal password was not accepted.");
      return st;
    },
  },
  {
    name: "lock_terminal",
    description: "End this tab's terminal session. Running a command needs the password again afterwards.",
    execute: async () => {
      await terminalLock();
      return { unlocked: false };
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the vault directory and wait for it to exit. Answers with the exit code or signal, how long it took, the working directory it ended in, and the tail of its output (the last 64K characters). A cancelled command answers signal cancelled with what it printed. The terminal must be unlocked first.",
    inputSchema: schema({ command: { type: "string", description: "The command line to run, e.g. git status --short." } }, ["command"]),
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute: async ({ command }) => {
      await terminalReady();
      return runTerminal(str(command), { capture: true });
    },
  },
  {
    name: "cancel_command",
    description: "Stop whatever the terminal is running, the way Ctrl+C does. Answers with whether there was anything to stop.",
    execute: async () => {
      await terminalOpen(); // `terminalStop` swallows a 401 into the console
      const was = termRunningId();
      await terminalStop();
      return { cancelled: !!was };
    },
  },
  {
    name: "approve_command",
    description: "Run a command the assistant asked to run and is waiting on, as pressing Run on its card does. Answers as run_command does. The terminal must be unlocked first.",
    inputSchema: schema({ id: COMMAND_ID }, ["id"]),
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute: async ({ id }) => {
      await terminalReady();
      await loadCommands();
      const c = state.commands.find((x) => x.id === id);
      if (!c) throw deny("not-found", "No such command: " + id + ".");
      return runTerminal(c.command, { commandId: id, byAi: true, capture: true });
    },
  },
  {
    name: "reject_command",
    description: "Refuse a command the assistant asked to run. It never runs, and the record says so.",
    inputSchema: schema({ id: COMMAND_ID }, ["id"]),
    execute: async ({ id }) => {
      await api.terminalRejectCommand(id);
      await loadCommands();
      return { id, state: "rejected" };
    },
  },

  /* ---------- secrets: the one verb there is ---------- */
  {
    name: "lock_vault",
    description: "Forget the vault's key in this tab. Any secret block open on screen closes, and opening one again asks the user for the vault's key phrase. No tool here can ask for that phrase or hand back a plaintext secret.",
    execute: async () => {
      /* `lockVault` is a no-op with no worker to lock, and "locked" about a
         keyring that cannot open here would be true and useless */
      if (vault.state === "disabled") throw deny("secrets-disabled", vault.reason || "Secrets are not available in this context.");
      await lockVault("manual");
      return { locked: true };
    },
  },
];

/* ============================================================
   THE IN-PAGE `document.modelContext`

   Chrome 149 ships the real thing behind an origin trial, Chrome 146 to 148
   ship the previous shape on `navigator`, and every other browser today ships
   nothing. The catalogue is worth the same in all three, so where the API is
   absent this stands in for it: the same IDL, over the same table, same
   origin only. It is never installed over a native one.
   ============================================================ */

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

class InPageModelContext extends EventTarget {
  constructor() {
    super();
    this.tools = new Map();
    this.handler = null;
  }

  /* an event-handler attribute in the IDL: assigning replaces, and the
     listener list stays available alongside it */
  get ontoolchange() {
    return this.handler;
  }
  set ontoolchange(fn) {
    if (this.handler) this.removeEventListener("toolchange", this.handler);
    this.handler = typeof fn === "function" ? fn : null;
    if (this.handler) this.addEventListener("toolchange", this.handler);
  }

  async registerTool(tool, options) {
    const t = tool || {};
    if (!NAME_RE.test(str(t.name))) throw new DOMException("A tool name must match [A-Za-z0-9_.-]{1,128}, not " + t.name, "InvalidStateError");
    if (!t.description) throw new DOMException("A tool needs a description: " + t.name, "InvalidStateError");
    if (typeof t.execute !== "function") throw new DOMException("A tool needs an execute callback: " + t.name, "InvalidStateError");
    if (this.tools.has(t.name)) throw new DOMException("A tool is already registered as " + t.name, "InvalidStateError");
    let inputSchema = null;
    try {
      inputSchema = t.inputSchema == null ? null : JSON.parse(JSON.stringify(t.inputSchema));
    } catch (e) {
      throw new DOMException("inputSchema must be serialisable: " + t.name, "InvalidStateError");
    }
    this.tools.set(t.name, { name: t.name, title: t.title || t.name, description: t.description, inputSchema, annotations: t.annotations || {}, execute: t.execute });
    const signal = options && options.signal;
    if (signal && signal.aborted) this.unregisterTool(t.name);
    else if (signal) signal.addEventListener("abort", () => this.unregisterTool(t.name), { once: true });
    this.dispatchEvent(new Event("toolchange"));
  }

  unregisterTool(name) {
    if (this.tools.delete(name)) this.dispatchEvent(new Event("toolchange"));
  }

  async getTools() {
    return [...this.tools.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({ execute, ...t }) => {
        const out = { ...structuredClone(t), origin: location.origin };
        /* non-enumerable on purpose: `window` is part of the IDL, and a
           RegisteredTool that carried it enumerably could not be serialised
           by the automation drivers this polyfill exists for */
        Object.defineProperty(out, "window", { value: window, enumerable: false });
        return out;
      });
  }

  /** By name, as the native one does: what `getTools()` hands back is a copy,
      and a caller passing that copy back in must still be understood. */
  async executeTool(tool, inputObject, options) {
    const name = typeof tool === "string" ? tool : str(tool && tool.name);
    const t = this.tools.get(name);
    if (!t) throw new DOMException("No such tool: " + name, "UnknownError");
    let input = {};
    try {
      input = inputObject == null ? {} : JSON.parse(JSON.stringify(inputObject));
    } catch (e) {
      throw new DOMException("Tool input must be JSON: " + name, "DataCloneError");
    }
    const result = await t.execute(input, { signal: options && options.signal });
    return JSON.stringify(result === undefined ? null : result);
  }
}

function installModelContext() {
  const mc = new InPageModelContext();
  Object.defineProperty(document, "modelContext", { value: mc, configurable: true, enumerable: false });
  return mc;
}

/* ============================================================
   REGISTRATION
   ============================================================ */

const titleOf = (name) => name[0].toUpperCase() + name.slice(1).replace(/_/g, " ");

/**
 * Publish the catalogue, once, at the end of boot. In order: the current API
 * (`document.modelContext`), else the Chrome 146 to 148 shape
 * (`navigator.modelContext`, same tool dictionary), else the in-page one. A
 * refused registration is a `console.warn` and nothing else. The human UI
 * must never report an agent-facing failure, and a browser that declines
 * every tool is still a notes app.
 */
export async function registerWebMcpTools() {
  const nav = navigator.modelContext;
  const native = document.modelContext || (nav && typeof nav.registerTool === "function" ? nav : null);
  const polyfill = document.modelContext ? null : installModelContext();
  const target = native || polyfill;
  for (const t of TOOLS) {
    const tool = { title: titleOf(t.name), inputSchema: NO_INPUT, annotations: {}, ...t, execute: attempt(t.execute) };
    try {
      await target.registerTool(tool);
    } catch (err) {
      console.warn("[webmcp] " + t.name, err);
    }
    /* the native door may be write-only (the `navigator` shape has no
       `getTools`), so the in-page one lists the same tools */
    if (polyfill && target !== polyfill) await polyfill.registerTool(tool).catch(() => {});
  }
}
