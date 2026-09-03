/* ============================================================
   webmcp.js — the agent's app.js.

   app.js wires pointers and chords to the feature functions; this file wires
   TOOL CALLS to the same functions. That symmetry is the whole design: a tool
   is not a second implementation of an operation, it is the button pressed
   from somewhere else, so a doc an agent creates lands on the undo timeline,
   opens in the pane and appears in the tree exactly as a doc a person creates
   does. A new UI operation is not finished until it has a tool here (ADR 0031).

   Three rules the table below keeps:

     - ERRORS ARE DATA. A tool never throws. Every failure comes back as
       `{ error, message, ...extra }` — the API's own error shape (ADR 0002),
       with the server's slug and sentence passed through verbatim — because
       the WebMCP draft has no settled way to carry a rejection back to the
       invoker, and an opaque failure is one the model cannot correct itself
       from.
     - THE CATALOGUE IS STATIC. Every tool is registered once, at boot. A tool
       that cannot act right now says so in its result (`terminal-locked`)
       rather than vanishing from a list the agent already read.
     - NO TOOL OPENS A SECRET BLOCK, RETURNS ITS PLAINTEXT, OR ASKS FOR THE
       VAULT'S KEY PHRASE. An agent platform is a cloud, and the rule that no
       plaintext secret leaves this browser does not bend for it. `lock_vault`
       is the only secrets verb there is, and the words the crypto path is
       spelled with do not appear in this file — `tests/webmcp.test.ts` greps
       for them.

   A browser with no `document.modelContext` gets one, in-page, over the same
   table (`installModelContext`) — so a puppeteer- or DevTools-driven agent
   discovers and calls exactly what Chrome's own agent would. A NATIVE
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

/** A refusal this module produces itself, in the API's own error shape so an
    agent reads ONE vocabulary for a server's 404 and for "the terminal is
    locked". The status is inert — nothing here is on the wire. */
const deny = (error, message, extra) => new api.ApiError(409, Object.assign({ error, message }, extra || {}));

/** Everything an error body carries beyond the two fields every error has —
    `rev` on a conflict, `count` on an ambiguous edit, `running` on a busy
    terminal. Dropping them would take the self-correction with them. */
function extrasOf(body) {
  const out = {};
  for (const k of Object.keys(body || {})) if (k !== "error" && k !== "message") out[k] = body[k];
  return out;
}

/** Wrap one tool's execute so it answers with data whatever happens. */
const attempt = (fn) => async (input, opts) => {
  try {
    return await fn(input || {}, opts || {});
  } catch (err) {
    if (err && err.name === "AbortError") return { error: "aborted", message: "Cancelled." };
    if (err && err.name === "ApiError") return Object.assign({ error: err.code, message: err.message }, extrasOf(err.body));
    return { error: "failed", message: (err && err.message) || String(err) };
  }
};

/* ============================================================
   THE VOCABULARY THE SCHEMAS SHARE
   ============================================================ */

const schema = (properties, required) =>
  Object.assign(
    { type: "object", properties: properties || {} },
    required && required.length ? { required: required } : null,
    { additionalProperties: false }
  );

const NO_INPUT = schema({});

const DOC_PATH = { type: "string", description: "Vault-qualified doc path, e.g. notes/todo.md or @work/inbox.md." };
const ENTRY_PATH = { type: "string", description: "Vault-qualified doc or folder path, e.g. notes or @work/inbox.md." };
const MARKDOWN = { type: "string", description: "Markdown source text." };
const VAULT_ID = { type: "string", description: "Vault id, e.g. vault (the primary) or work. Defaults to the primary vault." };
const TRASH_ID = { type: "string", description: "Trash entry id, as list_trash reports it." };
const PROPOSAL_ID = { type: "string", description: "Proposal id, as list_proposals or ask_assistant reports it." };
const COMMAND_ID = { type: "string", description: "Command record id, as list_commands reports it." };

/* ============================================================
   READING THE APP'S OWN STATE
   ============================================================ */

/** The tree node at `path`, in any vault, or null. The tree is this client's
    answer to "does that exist, and is it a folder" — asking the server would
    be asking a second authority the same question. */
function findNode(path, nodes) {
  for (const n of nodes || treesOf(null)) {
    if (n.path === path) return n;
    if (n.type === "folder") {
      const hit = findNode(path, n.children || []);
      if (hit) return hit;
    }
  }
  return null;
}

/** Every vault's tree, or one vault's — `bad-vault` for an id nobody serves. */
function treesOf(id) {
  if (id == null || id === "") return state.vaults.flatMap((v) => v.tree || []);
  const v = state.vaults.filter((x) => x.id === id)[0];
  if (!v) throw deny("bad-vault", "No such vault: " + id + ".");
  return v.tree || [];
}

/** Depth-first, in tree order — the order the sidebar draws, so a flat list
    still describes the shape it came from. */
function flatten(nodes, out, under) {
  for (const n of nodes) {
    const folder = n.type === "folder";
    if (!under || n.path === under || n.path.indexOf(under + "/") === 0) {
      out.push(
        folder
          ? { path: n.path, type: "folder", title: n.name }
          : {
              path: n.path,
              type: "doc",
              title: n.title,
              bytes: n.bytes,
              mtime: n.mtime,
              empty: !!n.empty,
              hasSecrets: !!n.hasSecrets,
            }
      );
    }
    if (folder) flatten(n.children || [], out, under);
  }
  return out;
}

/** Is the sidebar showing? Below the dock width it is a drawer (`nav-open`),
    above it a column that can be collapsed — one question, two answers. */
const sidebarOpen = () => (isDrawer() ? app.classList.contains("nav-open") : !app.classList.contains("sidebar-collapsed"));

/** The doc's text as it is RIGHT NOW: the buffer when the pane holds one, the
    file otherwise. Every read and every read-modify-write goes through here,
    so a tool can never answer with bytes the user has already typed over. */
async function docText(path) {
  if (path === state.active) syncRaw();
  const doc = await ensureLoaded(path);
  return String(doc.markdown == null ? "" : doc.markdown);
}

const byteLen = (s) => new TextEncoder().encode(s).length;

/** Put the open buffer on disk before a tool navigates away from it. The
    human routes ask (`guardRawExit`); an agent has nobody to ask, and the
    answer the spec gives is always the same one — saved, never discarded —
    so the question is settled before any function that could raise it runs. */
async function settleBuffer() {
  if (state.active && state.dirty) await saveDoc(state.active, { silent: true });
}

/** Dotted setting path → the one-key-deep patch the settings route takes. */
function nest(path, value) {
  const parts = String(path).split(".");
  const out = {};
  let at = out;
  for (let i = 0; i < parts.length - 1; i++) at = at[parts[i]] = {};
  at[parts[parts.length - 1]] = value;
  return out;
}

/** The terminal's own three refusals, asked before the request rather than
    after it: a locked terminal is a state the agent can fix (`unlock_terminal`)
    and telling it so is worth more than a 401. */
async function terminalOpen() {
  /* ASKED FRESH, never off the cached status: a password set on the settings
     page (or by another client) after this tab booted leaves the boot-time
     answer saying the terminal is off, and refusing a command on that would be
     the app quoting yesterday's news at the agent. */
  const st = await refreshTerminalStatus();
  if (!st || !st.enabled) throw deny("terminal-disabled", "The terminal is switched off in Settings.");
  if (!st.configured) throw deny("terminal-disabled", "No terminal password is set, so the terminal is off.");
  if (!st.unlocked) throw deny("terminal-locked", "The terminal is locked. Unlock it with the terminal password.");
  return st;
}

/** …and the fourth, for the tools that START something. */
async function terminalReady() {
  const st = await terminalOpen();
  if (state.term.busy) throw deny("terminal-busy", "A command is already running.");
  return st;
}

/* ============================================================
   THE CATALOGUE — one row per operation the human UI offers.

   Names are snake_case verbs, descriptions say what the tool does and what it
   answers with, and every input property carries the shape it expects: this is
   the entire prompt the model gets about this app.
   ============================================================ */
const TOOLS = [
  {
    name: "get_app_state",
    title: "App state",
    description:
      "Report what the app is showing now: the open doc, the view and mode, whether the buffer is unsaved, the event connection, sync state, every vault, the secrets and terminal state, the assistant session, which panels are open, and whether undo or redo has a step waiting. Call this first to plan.",
    inputSchema: NO_INPUT,
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
        panels: { sidebar: sidebarOpen(), assistant: app.classList.contains("chat-open"), trash: !!state.trash.open },
        undo: { canUndo: !!pendingHistory(false), canRedo: !!pendingHistory(true) },
      };
    },
  },
  {
    name: "list_vaults",
    title: "List vaults",
    description: "List every connected vault with its id, label, path prefix, git remote, doc count and sync state. The primary vault has the empty prefix; a secondary vault's docs are addressed as @id/path.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => {
      const r = await api.getVaults();
      return {
        vaults: (r.vaults || []).map((v) => ({
          id: v.id,
          label: v.label,
          prefix: v.prefix,
          remote: v.remote,
          repo: !!v.repo,
          docCount: v.docCount,
          sync: (v.sync && v.sync.state) || null,
        })),
      };
    },
  },
  {
    name: "list_docs",
    title: "List docs",
    description: "List every doc and folder in tree order, with qualified paths, titles, sizes and modification times. Narrow it to one vault or one folder subtree. This is the map of the vault: read it before guessing a path.",
    inputSchema: schema({
      vault: VAULT_ID,
      folder: { type: "string", description: "Qualified folder path to list, e.g. notes or @work/archive. Omit for everything." },
    }),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ vault: id, folder }) => {
      const nodes = treesOf(id);
      const list = state.vaults.filter((v) => id == null || id === "" || v.id === id);
      return {
        vaults: list.map((v) => ({ id: v.id, label: v.label, prefix: v.prefix, docCount: v.docCount })),
        docs: flatten(nodes, [], folder ? String(folder).replace(/\/+$/, "") : null),
      };
    },
  },
  {
    name: "read_doc",
    title: "Read a doc",
    description: "Read one doc's markdown with its rev, size and modification time. When it is the open doc with unsaved edits you get the buffer the user is looking at and unsaved: true. Pass the rev back to write_doc to write only if nothing moved underneath.",
    inputSchema: schema({ path: DOC_PATH }, ["path"]),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ path }) => {
      if (path === state.active && state.dirty) {
        syncRaw();
        const doc = await ensureLoaded(path);
        const markdown = String(doc.markdown == null ? "" : doc.markdown);
        return {
          path: path,
          title: doc.title,
          rev: doc.rev,
          markdown: markdown,
          bytes: byteLen(markdown),
          mtime: doc.mtime,
          hasSecrets: !!doc.hasSecrets,
          unsaved: true,
        };
      }
      const d = await api.getDoc(path);
      return {
        path: d.path,
        title: d.title,
        rev: d.rev,
        markdown: d.markdown,
        bytes: d.bytes,
        mtime: d.mtime,
        hasSecrets: !!d.hasSecrets,
        unsaved: false,
      };
    },
  },
  {
    name: "search_docs",
    title: "Search docs",
    description: "Search every vault and get scored hits with their qualified paths and matching lines. A fuzzy query matches loosely; mode regex (or a /pattern/flags query) reads the query as a regular expression.",
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
      return api.search(String(query == null ? "" : query), { limit: limit || 24, mode: mode || null });
    },
  },
  {
    name: "list_trash",
    title: "List trash",
    description: "List what has been deleted and can still be restored: each entry's id, path, when it was deleted and when it will be purged, plus the retention window. Reports available: false on a vault whose server has no trash.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      await refreshTrash();
      const t = state.trash;
      return { available: !!t.available, retentionDays: t.retentionDays, entries: t.entries };
    },
  },
  {
    name: "get_settings",
    title: "Read settings",
    description: "Read the whole settings document and the server's meta block — the themes, densities, colour schemes, efforts and numeric bounds a value may take. Credentials come back masked. Use it to learn what set_setting will accept.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => ({ settings: state.settings, meta: state.meta }),
  },
  {
    name: "list_proposals",
    title: "List proposals",
    description: "List the assistant's edit proposals with their id, label, target doc and state, plus the ids on the apply stack, newest last. Only the top of the stack can be reverted.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => ({
      proposals: state.proposals.map((p) => ({ id: p.id, label: p.label, state: p.state, stackIndex: p.stackIndex, path: p.target })),
      stack: (state.stack || []).map((e) => e.id),
    }),
  },
  {
    name: "get_conversation",
    title: "Read the conversation",
    description: "Read the assistant session: its id, the model in use, and the most recent messages with their roles, text and any proposal each one carries.",
    inputSchema: schema({ limit: { type: "integer", description: "How many of the most recent messages to return. Defaults to 20." } }),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ limit }) => {
      const s = state.session || {};
      const msgs = s.messages || [];
      const n = limit == null ? 20 : Math.max(1, Number(limit) || 20);
      return {
        sessionId: s.id || null,
        model: s.model || null,
        messages: msgs.slice(-n).map((m) => ({ id: m.id, role: m.role, content: m.content, proposalId: m.proposalId || null, at: m.at })),
      };
    },
  },
  {
    name: "terminal_status",
    title: "Terminal status",
    description: "Report whether the terminal is switched on, has a password configured, is unlocked in this tab, and what is running — the four facts run_command needs.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => {
      const st = await refreshTerminalStatus();
      return st || { error: "terminal-disabled", message: "This server serves no terminal." };
    },
  },
  {
    name: "list_commands",
    title: "List commands",
    description: "List the assistant's command records — what it asked to run, which message it belongs to, and whether each one is waiting for approval, running, done, failed or rejected.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => {
      /* the records carry command OUTPUT and sit behind the password too;
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
    title: "Open a doc",
    description: "Open a doc in the editor pane, optionally at a line and in a given mode. The tree, the statusbar and the address bar follow. An unsaved buffer in the doc being left is saved on the way, never discarded.",
    inputSchema: schema(
      {
        path: DOC_PATH,
        mode: { type: "string", enum: ["raw", "preview"], description: "Which view to land in. Defaults to the current one." },
        line: { type: "integer", description: "1-based source line to scroll to and put the caret on." },
      },
      ["path"]
    ),
    annotations: {},
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
    title: "Switch mode",
    description: "Switch the editor pane between the rendered preview and the raw markdown source. An unsaved buffer is written first, so the switch never asks the user anything.",
    inputSchema: schema({ mode: { type: "string", enum: ["raw", "preview"], description: 'Which view to show: "raw" or "preview".' } }, ["mode"]),
    annotations: {},
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
    title: "Open settings",
    description: "Show the settings page, optionally at one of its sections: appearance, editing, trash, upload, git, secrets, ai, terminal. The doc stays open behind it. An unsaved buffer is written first.",
    inputSchema: schema({ section: { type: "string", description: "Which section to land on, e.g. ai. Omit for the top of the page." } }),
    annotations: {},
    execute: async ({ section }) => {
      await settleBuffer();
      showSettings(section || "", {});
      return { view: "settings", section: state.settingsSection };
    },
  },
  {
    name: "show_panel",
    title: "Show or hide a panel",
    description: "Open or close one of the three panels — the sidebar tree, the assistant, or the trash drawer — and report where it ended up. Already in that state, nothing moves.",
    inputSchema: schema(
      {
        panel: { type: "string", enum: ["sidebar", "assistant", "trash"], description: "Which panel to move." },
        open: { type: "boolean", description: "true to show it, false to hide it." },
      },
      ["panel", "open"]
    ),
    annotations: {},
    execute: async ({ panel, open }) => {
      const want = open !== false;
      if (panel === "sidebar") {
        if (sidebarOpen() !== want) {
          if (isDrawer()) want ? openNav() : closeNav();
          else app.classList.toggle("sidebar-collapsed", !want);
        }
        return { panel: panel, open: sidebarOpen() };
      }
      if (panel === "assistant") {
        if (app.classList.contains("chat-open") !== want) toggleChat();
        return { panel: panel, open: app.classList.contains("chat-open") };
      }
      if (panel === "trash") {
        if (!state.trash.available) throw deny("failed", "This vault has no trash.");
        if (!!state.trash.open !== want) toggleTrash();
        return { panel: panel, open: !!state.trash.open };
      }
      throw deny("bad-panel", 'Panel is "sidebar", "assistant" or "trash".');
    },
  },
  {
    name: "dismiss_overlay",
    title: "Dismiss the top layer",
    description: "Close whatever floats above the app — the palette, a dialog, the context menu, an inline create row — one layer per call, exactly as Escape does. Reports whether there was anything to dismiss.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: async () => ({ dismissed: !!dismissTop() }),
  },

  /* ---------- doc lifecycle ---------- */
  {
    name: "create_doc",
    title: "Create a doc",
    description: "Create a doc at a path, with optional initial markdown, and open it. Missing parent folders are made on the way. Answers with the new doc's path and rev; a path already taken answers exists.",
    inputSchema: schema({ path: DOC_PATH, markdown: MARKDOWN }, ["path"]),
    annotations: {},
    execute: async ({ path, markdown }) => {
      /* opening the new doc leaves the current one, and `openDoc` would ask
         about an unsaved buffer on the way — settle it first */
      await settleBuffer();
      const r = await mintEntry({ path: path, kind: "doc", markdown: markdown }, { open: true });
      return { path: (r && r.path) || path, rev: r && r.rev };
    },
  },
  {
    name: "create_folder",
    title: "Create a folder",
    description: "Create a folder, making any missing parents on the way. Answers with its path; a path already taken answers exists.",
    inputSchema: schema({ path: { type: "string", description: "Qualified folder path, e.g. notes/archive or @work/inbox." } }, ["path"]),
    annotations: {},
    execute: async ({ path }) => {
      const r = await mintEntry({ path: path, kind: "folder" });
      return { path: (r && r.path) || path };
    },
  },
  {
    name: "write_doc",
    title: "Write a doc",
    description: "Replace a doc's whole markdown and save it. Pass the rev you read to be refused with rev-conflict if it moved since; omit it to overwrite. The change is one step on the app's undo timeline and the open editor repaints.",
    inputSchema: schema(
      { path: DOC_PATH, markdown: MARKDOWN, rev: { type: "string", description: "The rev read_doc gave you, to write only if nothing changed since." } },
      ["path", "markdown"]
    ),
    annotations: {},
    execute: async ({ path, markdown, rev }) => replaceDocText(path, String(markdown == null ? "" : markdown), rev),
  },
  {
    name: "edit_doc",
    title: "Edit a doc",
    description: "Replace exact text in a doc: find must match the file byte for byte. One occurrence is replaced and saved; several answer ambiguous with a count unless all is true, and none answers not-found. Prefer this over write_doc for a small change.",
    inputSchema: schema(
      {
        path: DOC_PATH,
        find: { type: "string", description: "The exact text to find, including its line breaks and indentation." },
        replace: { type: "string", description: "The text to put in its place. Empty deletes the found text." },
        all: { type: "boolean", description: "true replaces every occurrence. Defaults to false." },
      },
      ["path", "find", "replace"]
    ),
    annotations: {},
    execute: async ({ path, find, replace, all }) => {
      const needle = String(find == null ? "" : find);
      if (!needle) throw deny("failed", "find must not be empty.");
      const text = await docText(path);
      const parts = text.split(needle);
      const n = parts.length - 1;
      if (!n) throw deny("not-found", "That text is not in " + path + ".");
      if (n > 1 && all !== true) throw deny("ambiguous", "That text occurs " + n + " times in " + path + ". Pass all, or find more context.", { count: n });
      const rep = String(replace == null ? "" : replace);
      const i = text.indexOf(needle);
      const next = all === true ? parts.join(rep) : text.slice(0, i) + rep + text.slice(i + needle.length);
      const r = await replaceDocText(path, next);
      return { path: r.path, rev: r.rev, replaced: all === true ? n : 1 };
    },
  },
  {
    name: "append_to_doc",
    title: "Append to a doc",
    description: "Add markdown to the end of a doc and save it. A line break is inserted first when the doc does not already end with one, so the appended text starts on its own line.",
    inputSchema: schema({ path: DOC_PATH, markdown: MARKDOWN }, ["path", "markdown"]),
    annotations: {},
    execute: async ({ path, markdown }) => {
      const text = await docText(path);
      const add = String(markdown == null ? "" : markdown);
      const glue = text && !text.endsWith("\n") ? "\n" : "";
      return replaceDocText(path, text + glue + add);
    },
  },
  {
    name: "save_doc",
    title: "Save a doc",
    description: "Write the open buffer to disk. Defaults to the doc on screen. Answers with whether it reached the server and the rev it now has.",
    inputSchema: schema({ path: DOC_PATH }),
    annotations: {},
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
    title: "Move or rename",
    description: "Move or rename a doc or a folder — one operation, exactly as the sidebar does it. Every [[link]] that resolved to the doc is rewritten in the same commit, and the count comes back. A folder takes its subtree with it.",
    inputSchema: schema(
      { from: ENTRY_PATH, to: { type: "string", description: "The new qualified path, in the SAME vault, e.g. notes/renamed.md." } },
      ["from", "to"]
    ),
    annotations: {},
    execute: async ({ from, to }) => {
      if (!findNode(from)) throw deny("not-found", "No such doc or folder: " + from + ".");
      /* `moveEntry` answers its refusals with a toast and `false`, which is the
         right shape for a rename field and no shape at all for a caller with
         no screen — so the three it can refuse are named HERE, in the API's
         own words, before the call. A vault is a repository, and a move out of
         one is a delete plus a create with two histories to match; `]` and a
         line break would break out of every `[[link]]` the rewrite splices the
         name into. The server refuses all three too. */
      if (vaultOf(to) !== vaultOf(from)) throw deny("bad-path", "A move cannot cross vaults.");
      if (/[\]\r\n]/.test(to)) throw deny("bad-path", 'A name cannot contain "]" or a line break.');
      if (findNode(to)) throw deny("exists", to + " already exists.");
      const r = await moveByPath(from, to);
      if (!r) throw deny("failed", "The move was refused — the unsaved buffer could not be written first.");
      return { from: from, to: r.path || to, backlinksUpdated: r.backlinksUpdated || 0 };
    },
  },
  {
    name: "delete_doc",
    title: "Delete a doc",
    description: "Delete a doc or a folder. Where the server keeps a trash it goes there and list_trash will show it; the pane moves to the neighbouring doc. Unsaved text in the doc being deleted is written first.",
    inputSchema: schema({ path: ENTRY_PATH }, ["path"]),
    /* consequential even with a trash: a folder takes its subtree with it,
       and on a server without a trash the git history is all that is left.
       This is the delete confirmation, delegated to the browser (ADR 0031). */
    annotations: { consequentialHint: true },
    execute: async ({ path }) => {
      const node = findNode(path);
      if (!node) throw deny("not-found", "No such doc or folder: " + path + ".");
      await settleBuffer();
      const gone = await doDelete(path, node.type === "folder" ? "folder" : "doc", { force: true });
      if (!gone) throw deny("failed", "Could not delete " + path + ".");
      return { path: path, deleted: true, trash: !!state.trash.available };
    },
  },
  {
    name: "undo",
    title: "Undo",
    description: "Take back the last thing that happened in this tab — a text edit or a file operation, whichever came last, navigating to the doc it is about. A file step asks the user first and answers applied: false until they agree.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: () => stepTimeline(false),
  },
  {
    name: "redo",
    title: "Redo",
    description: "Put back the last thing undo took away, navigating to the doc it is about. A file step asks the user first and answers applied: false until they agree.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: () => stepTimeline(true),
  },

  /* ---------- trash ---------- */
  {
    name: "restore_from_trash",
    title: "Restore from trash",
    description: "Put a deleted doc or folder back where it came from and open it. Answers with the path it landed at. A path that has since been taken answers exists, and the entry stays in the trash.",
    inputSchema: schema({ id: TRASH_ID }, ["id"]),
    annotations: {},
    execute: async ({ id }) => {
      /* a restore opens what it put back, and opening leaves the current doc */
      await settleBuffer();
      const r = await restoreTrashEntry(id);
      return { id: id, path: r.path };
    },
  },
  {
    name: "purge_trash",
    title: "Delete permanently",
    description: "Delete one trash entry for good. Nothing but the git history is left afterwards.",
    inputSchema: schema({ id: TRASH_ID }, ["id"]),
    annotations: { consequentialHint: true },
    execute: async ({ id }) => {
      await purgeTrashEntry(id);
      return { id: id, purged: true };
    },
  },
  {
    name: "empty_trash",
    title: "Empty the trash",
    description: "Delete every trash entry for good, expired or not, and report how many went. Nothing but the git history is left afterwards.",
    inputSchema: NO_INPUT,
    annotations: { consequentialHint: true },
    execute: async () => emptyTrash(),
  },

  /* ---------- settings and vaults ---------- */
  {
    name: "set_setting",
    title: "Change a setting",
    description: "Set one setting by its dotted path — theme, editor.clickToEdit, git.autoSync, ai.effort — and the page repaints and settings.toml records it. Answers with the value that was stored, which may be clamped or normalised. get_settings lists what each one accepts.",
    inputSchema: schema(
      {
        path: { type: "string", description: "Dotted setting path, e.g. theme, density, editor.homeDoc, git.autoSyncSeconds." },
        value: { description: "The new value: a string, number or boolean, as that setting takes." },
      },
      ["path", "value"]
    ),
    annotations: {},
    execute: async ({ path, value }) => {
      if (!path || typeof path !== "string") throw deny("failed", "A dotted setting path is required.");
      const r = await api.patchSettings(nest(path, value));
      adoptSettings(r);
      return { path: path, value: savedValue(path) };
    },
  },
  {
    name: "sync_vault",
    title: "Sync a vault",
    description: "Run a vault's git pipeline now — take what is upstream fast-forward-only, then commit and push what is local — and answer with the sync status it ended in. Defaults to the primary vault.",
    inputSchema: schema({ vault: VAULT_ID }),
    annotations: {},
    execute: async ({ vault: id }) => {
      if (id && !state.vaults.some((v) => v.id === id)) throw deny("bad-vault", "No such vault: " + id + ".");
      if (!id || id === "vault") {
        await syncNow();
        return api.getSyncStatus();
      }
      return api.syncVault(id);
    },
  },
  {
    name: "add_vault",
    title: "Add a vault",
    description: "Connect another git repository as a second vault: it is cloned into the vaults home and its docs become addressable as @id/path. Without a token the primary vault's stored credential is copied. Answers with the new vault's descriptor.",
    inputSchema: schema(
      {
        url: { type: "string", description: "The remote repository URL, http(s) only and without credentials in it." },
        name: { type: "string", description: "What to call it in the sidebar. Defaults to the repository name." },
        token: { type: "string", description: 'Access token for this remote. Omit to copy the primary vault\'s; pass "" to attach anonymously.' },
      },
      ["url"]
    ),
    annotations: {},
    execute: async ({ url, name, token }) => {
      const r = await api.addVault({ url: url, name: name, token: token });
      return (r && r.vault) || r;
    },
  },
  {
    name: "set_vault_remote",
    title: "Point a vault at a remote",
    description: "Attach a vault to a git remote, or re-point it at another one — the same operation the Repository line in Settings performs, including the first git init when there is no repository yet. Answers with that vault's sync status. Defaults to the primary vault.",
    inputSchema: schema({ vault: VAULT_ID, url: { type: "string", description: "The remote repository URL, http(s) only and without credentials in it." } }, ["url"]),
    annotations: {},
    execute: async ({ vault: id, url }) => {
      if (id && !state.vaults.some((v) => v.id === id)) throw deny("bad-vault", "No such vault: " + id + ".");
      return !id || id === "vault" ? api.attachRemote(url) : api.setVaultRemote(id, url);
    },
  },
  {
    name: "disconnect_vault",
    title: "Disconnect a vault",
    description: "Drop a secondary vault from the registry. Its directory and its git history stay on disk; only this app stops serving it, and its docs leave the tree.",
    inputSchema: schema({ id: { type: "string", description: "The vault id to disconnect. The primary vault cannot be disconnected." } }, ["id"]),
    annotations: { consequentialHint: true },
    execute: async ({ id }) => {
      if (!state.vaults.some((v) => v.id === id)) throw deny("bad-vault", "No such vault: " + id + ".");
      await api.removeVault(id);
      await loadTree().catch(() => {});
      return { id: id, disconnected: true };
    },
  },

  /* ---------- the assistant ---------- */
  {
    name: "ask_assistant",
    title: "Ask the assistant",
    description: "Send a message to the vault's own AI relay and wait for the turn to finish. Answers with the reply text, the edit proposal it made (if any) and the commands it queued. Cancelling the call stops the stream.",
    inputSchema: schema({ message: { type: "string", description: "What to ask. The open doc is the relay's context." } }, ["message"]),
    annotations: { untrustedContentHint: true },
    execute: async ({ message }, opts) => {
      /* the composer's own send supersedes a reply still arriving, because
         the person typing is the person reading; an agent is not, so it waits */
      if (turnInFlight()) throw deny("assistant-busy", "The assistant is still answering. Wait for the turn to finish, or start a new session.");
      const r = await sendMessageText(String(message == null ? "" : message), { signal: opts && opts.signal });
      if (r && r.aborted) throw deny("aborted", "Cancelled.");
      return { reply: r.reply, proposal: r.proposal, commands: r.commands };
    },
  },
  {
    name: "accept_proposal",
    title: "Accept a proposal",
    description: "Apply the assistant's proposed edit to the doc and push it onto the revert stack. Answers with the proposal's new state.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    annotations: {},
    execute: async ({ id }) => proposalAction(id, "accept"),
  },
  {
    name: "revert_proposal",
    title: "Revert a proposal",
    description: "Take back an applied proposal, restoring the doc as it was. Only the top of the apply stack can be reverted; anything else answers not-stack-top.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    annotations: {},
    execute: async ({ id }) => proposalAction(id, "revert"),
  },
  {
    name: "reject_proposal",
    title: "Reject a proposal",
    description: "Dismiss a proposal the assistant made without applying it. An already applied one has to be reverted first.",
    inputSchema: schema({ id: PROPOSAL_ID }, ["id"]),
    annotations: {},
    execute: async ({ id }) => proposalAction(id, "reject"),
  },
  {
    name: "new_session",
    title: "Start a new session",
    description: "Clear the assistant's context and start a fresh session. Any turn still streaming belongs to the session being left and is stopped. Answers with the new session id.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: async () => {
      /* `startNewSession` reports its failure as a toast and keeps the old
         session; the id is what says whether a new one actually began */
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
    title: "Unlock the terminal",
    description: "Unlock the terminal for this tab with the terminal password, so commands can run. Answers with the terminal status. A wrong password answers terminal-locked, and the server holds its own backoff.",
    inputSchema: schema({ password: { type: "string", description: "The terminal password, as set in Settings › Terminal." } }, ["password"]),
    annotations: {},
    execute: async ({ password }) => {
      const st = await refreshTerminalStatus();
      if (!st || !st.enabled) throw deny("terminal-disabled", "The terminal is switched off in Settings.");
      if (!st.configured) throw deny("terminal-disabled", "No terminal password is set, so the terminal is off.");
      const after = await terminalUnlock(String(password == null ? "" : password));
      if (!after || !after.unlocked) throw deny("terminal-locked", "That terminal password was not accepted.");
      return after;
    },
  },
  {
    name: "lock_terminal",
    title: "Lock the terminal",
    description: "End this tab's terminal session. Running a command needs the password again afterwards.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: async () => {
      await terminalLock();
      return { unlocked: false };
    },
  },
  {
    name: "run_command",
    title: "Run a command",
    description: "Run a shell command in the vault directory and wait for it to exit. Answers with the exit code or signal, how long it took, the working directory it ended in, and the tail of its output (the last 64K characters). A cancelled command answers signal cancelled with what it printed. The terminal must be unlocked first.",
    inputSchema: schema({ command: { type: "string", description: "The command line to run, e.g. git status --short." } }, ["command"]),
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute: async ({ command }) => {
      await terminalReady();
      return runTerminal(String(command == null ? "" : command), { capture: true });
    },
  },
  {
    name: "cancel_command",
    title: "Cancel the running command",
    description: "Stop whatever the terminal is running, the way Ctrl+C does. Answers with whether there was anything to stop.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: async () => {
      /* `terminalStop` swallows a 401 into the console; a locked terminal has
         to be said in the API's words */
      await terminalOpen();
      const was = termRunningId();
      await terminalStop();
      return { cancelled: !!was };
    },
  },
  {
    name: "approve_command",
    title: "Approve a queued command",
    description: "Run a command the assistant asked to run and is waiting on, exactly as pressing Run on its card does. Answers as run_command does. The terminal must be unlocked first.",
    inputSchema: schema({ id: COMMAND_ID }, ["id"]),
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute: async ({ id }) => {
      await terminalReady();
      let c = state.commands.filter((x) => x.id === id)[0];
      if (!c) {
        await loadCommands();
        c = state.commands.filter((x) => x.id === id)[0];
      }
      if (!c) throw deny("not-found", "No such command: " + id + ".");
      return runTerminal(c.command, { commandId: id, byAi: true, capture: true });
    },
  },
  {
    name: "reject_command",
    title: "Reject a queued command",
    description: "Refuse a command the assistant asked to run. It never runs, and the record says so.",
    inputSchema: schema({ id: COMMAND_ID }, ["id"]),
    annotations: {},
    execute: async ({ id }) => {
      await api.terminalRejectCommand(id);
      await loadCommands();
      return { id: id, state: "rejected" };
    },
  },

  /* ---------- secrets: the one verb there is ---------- */
  {
    name: "lock_vault",
    title: "Lock the vault keyring",
    description: "Forget the vault's key in this tab: any secret block open on screen closes, and opening one again asks the user for the vault's key phrase. No tool here can ask for that phrase or hand back a plaintext secret.",
    inputSchema: NO_INPUT,
    annotations: {},
    execute: async () => {
      /* `lockVault` is a no-op with no worker to lock; saying "locked" about
         a keyring that cannot be opened here would be true and useless */
      if (vault.state === "disabled") throw deny("secrets-disabled", vault.reason || "Secrets are not available in this context.");
      await lockVault("manual");
      return { locked: true };
    },
  },
];

/**
 * One step along the app's timeline (ADR 0014).
 *
 * A TEXT step is instant and is awaited. A FILE step is not: every one of them
 * raises a confirmation the USER has to answer, and a tool call that sat
 * waiting on a human would hold the agent — and the browser's tool queue —
 * open for as long as the dialog stood. So it is started, said out loud, and
 * left with the person it is addressed to.
 */
async function stepTimeline(redo) {
  flushTextRun();
  const entry = pendingHistory(redo);
  if (!entry) return { applied: false, entry: null };
  const at = { kind: entry.kind, path: entry.path || entry.to || entry.from || null };
  /* the same refusal ⌘Z makes under a dialog: stepping while a question is up
     — very possibly the one the previous call raised — would stack a second
     confirm over the first and strand its promise */
  if (overlayOpen()) return { applied: false, entry: at, confirm: "The app is already asking the user a question" };
  if (entry.kind !== "text") {
    stepHistory(redo).catch(() => {});
    return { applied: false, entry: at, confirm: "The app is asking the user to confirm" };
  }
  return { applied: !!(await stepHistory(redo)), entry: at };
}

/* ============================================================
   THE IN-PAGE `document.modelContext`

   Chrome 149 ships the real thing behind an origin trial; Chrome 146–148 ships
   the previous shape on `navigator`; every other browser today ships nothing.
   The catalogue is worth exactly as much in all three, so where the API is
   absent this stands in for it — the same IDL, over the same table, same
   origin only. It is never installed over a native one.
   ============================================================ */

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

class InPageModelContext extends EventTarget {
  constructor() {
    super();
    this.tools = new Map();
    let handler = null;
    /* `ontoolchange` is an event-handler ATTRIBUTE in the IDL: assigning
       replaces, and the listener list stays available alongside it. */
    Object.defineProperty(this, "ontoolchange", {
      enumerable: true,
      get: () => handler,
      set: (fn) => {
        if (handler) this.removeEventListener("toolchange", handler);
        handler = typeof fn === "function" ? fn : null;
        if (handler) this.addEventListener("toolchange", handler);
      },
    });
  }

  async registerTool(tool, options) {
    const t = tool || {};
    if (!NAME_RE.test(String(t.name || ""))) throw new DOMException("A tool name must match [A-Za-z0-9_.-]{1,128}, not " + t.name, "InvalidStateError");
    if (!t.description) throw new DOMException("A tool needs a description: " + t.name, "InvalidStateError");
    if (typeof t.execute !== "function") throw new DOMException("A tool needs an execute callback: " + t.name, "InvalidStateError");
    if (this.tools.has(t.name)) throw new DOMException("A tool is already registered as " + t.name, "InvalidStateError");
    let schema_ = null;
    try {
      schema_ = t.inputSchema == null ? null : JSON.parse(JSON.stringify(t.inputSchema));
    } catch (e) {
      throw new DOMException("inputSchema must be serialisable: " + t.name, "InvalidStateError");
    }
    const entry = { name: t.name, title: t.title || t.name, description: t.description, inputSchema: schema_, annotations: t.annotations || {}, execute: t.execute };
    this.tools.set(entry.name, entry);
    const signal = options && options.signal;
    if (signal) {
      if (signal.aborted) this.unregisterTool(entry.name);
      else signal.addEventListener("abort", () => this.unregisterTool(entry.name), { once: true });
    }
    this.dispatchEvent(new Event("toolchange"));
  }

  unregisterTool(name) {
    if (!this.tools.delete(name)) return;
    this.dispatchEvent(new Event("toolchange"));
  }

  async getTools() {
    return [...this.tools.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => {
        const out = {
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema == null ? null : structuredClone(t.inputSchema),
          annotations: structuredClone(t.annotations),
          origin: location.origin,
        };
        /* non-enumerable on purpose: `window` is part of the IDL, and a
           RegisteredTool that carries it enumerably cannot be serialised by
           the very automation drivers this polyfill exists for. */
        Object.defineProperty(out, "window", { value: window, enumerable: false });
        return out;
      });
  }

  /** BY NAME, exactly as the native one does — what `getTools()` hands back is
      a copy, and a caller passing that copy back in must still be understood. */
  async executeTool(tool, inputObject, options) {
    const name = typeof tool === "string" ? tool : (tool && tool.name) || "";
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

/**
 * Publish the catalogue, once, at the end of boot.
 *
 * In order: the current API (`document.modelContext`), else the Chrome 146–148
 * shape (`navigator.modelContext`, same tool dictionary), else the in-page one.
 * A registration that is refused is a `console.warn` and nothing else — the
 * human UI must never report an agent-facing failure, and a browser that
 * declines every tool must still be a notes app.
 */
export async function registerWebMcpTools() {
  let polyfill = null;
  let native = null;
  try {
    native =
      document.modelContext ||
      (navigator.modelContext && typeof navigator.modelContext.registerTool === "function" ? navigator.modelContext : null);
    if (!document.modelContext) polyfill = installModelContext();
  } catch (err) {
    console.warn("[webmcp] no model context", err);
    return;
  }
  const target = native || document.modelContext;
  for (const t of TOOLS) {
    const tool = {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      execute: attempt(t.execute),
    };
    try {
      await target.registerTool(tool);
    } catch (err) {
      console.warn("[webmcp] " + t.name, err);
    }
    /* the native door may be write-only (the `navigator` shape has no
       `getTools`), so the in-page one lists the same tools rather than an
       empty catalogue */
    if (polyfill && target !== polyfill) await polyfill.registerTool(tool).catch(() => {});
  }
}
