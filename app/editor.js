/* ============================================================
   editor.js — the Edit lifecycle, the save pipeline, the exit guard.

   Edit is the BlockNote island (`app/block-editor.tsx`, mounted from
   `/vendor/editor.js`), the only doc surface (ADR 0039).
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { state } from "./state.js";
import { $, $$, activeDoc, apiFail, copyText, countWords, el, esc, lookupLink, toast } from "./ui.js";
import { commitRename, focusQuiet } from "./tree.js";
import { changedLineDiff, conflictDialog, orphanDialog, renderDiff } from "./dialogs.js";
import { bindSecretIds, flushSecretEdits, newSecret, releaseSecretIds, repaintSecretsUI, secretEl, vault } from "./secrets.js";
import { refreshSessionStats } from "./chat.js";
import { exitSettings, guardSettingsExit, settingAt } from "./settings.js";
import { closeNav, isDrawer, rememberLastDoc, revealInTree, routeDoc } from "./shell.js";
import { recordHistory } from "./history.js";

/* ============================================================
   EXIT GUARD — leaving a buffer that is not on disk

   The third dialog on the SAME veil chrome as the two above, and for the same
   reason they share one: every one of them asks the single question this app
   has about unsaved work — "what is in front of you is not what is on disk,
   say what happens to it" — and uses the SAME `renderDiff` rows to say what
   "not what is on disk" means. The exit rows deliberately omit the context
   used by save conflicts; the renderer and modal shell remain shared.

   What it guards is every way out of a DIRTY DOC when `editor.confirmBeforeExit`
   is on. With that preference off, the same gate writes first and proceeds
   without mounting the dialog:

     a tree click, a ⌘K pick, a [[link]], the home button
        → `openDoc`, gated for user navigations only (`replace` marks the
          programmatic re-homes — popstate catch-up, the SSE `moved` echo, an
          accepted proposal — which must never stop to ask);
     ⌘, / ⌘/ / the sidebar Settings row
        → `openSettings`;
     the browser BACK button
        → `onPop`, which is the fiddly one; see there.

   HOW IT MEETS AUTOSAVE. It does not fight it. `markDirty` arms a debounce
   (`editor.autosaveSeconds`, 10s) and `visibilitychange`/`pagehide` flush the
   buffer, so a buffer is "unsaved" only inside that window — once autosave has
   run, `diskText` and the buffer agree and there is genuinely nothing left to
   confirm, so leaving is silent. That makes this dialog INTERMITTENT by nature:
   it appears when you leave quickly after typing and not otherwise. That is the
   honest behaviour and the debounce is a product-level decision, not this guard's to
   change.
   ============================================================ */

/**
 * The rows to show, or null when there is nothing to ask about.
 *
 * Null on all four of: the settings view, no doc, no baseline (nothing ever
 * fetched this doc, so the guard cannot say what changed and must not invent
 * it), and a diff with no `+`/`-` rows — which is the "typed a character and
 * deleted it again" case, where `state.dirty` is still true but the buffer and
 * the file are byte-identical. An empty modal in front of an exit is worse than
 * none.
 *
 * `state.dirty` is deliberately NOT the test. It is a flag about keystrokes;
 * this is a byte comparison against what the server last confirmed, which is
 * the thing the dialog then draws. The two agree in the ordinary case and the
 * comparison is right in every case they do not.
 *
 * A REVEALED SECRET that was edited is dirty with no line to show for it: its
 * plaintext is not in the buffer and must never reach a diff, so it gets one
 * row that names the block and nothing else.
 */
export function exitDiff() {
  if (state.view === "settings") return null;
  const doc = activeDoc();
  if (!doc || doc.diskText == null) return null;
  const buf = String(doc.markdown || "");
  /* a refused edit lives only on the screen (`visualStale`): the guard must
     fire for it, since leaving would unmount the only copy without a word */
  if (visualStale === doc) {
    const rows = buf === doc.diskText ? [] : changedLineDiff(doc.diskText, buf);
    return [{ marker: "+", text: "An edit that cannot be written as Markdown (undo it, or discard)" }, ...rows];
  }
  if (visual?.hasDraft()) return [{ marker: "+", text: "A protected block being edited (saving keeps it)" }, ...changedLineDiff(doc.diskText, buf)];
  if (buf === doc.diskText) {
    return [...state.reveal.values()].some((e) => e.path === doc.path && e.dirty)
      ? [{ marker: "+", text: "Edited secret block (plaintext hidden)" }]
      : null;
  }
  /* This confirmation is deliberately terser than the save-conflict view:
     the request is to show ONLY what changed from the original document, not
     one unchanged context row on either side. */
  const rows = changedLineDiff(doc.diskText, buf);
  return rows.length ? rows : null;
}

/**
 * THE GATE. `true` ⇒ the caller may leave now; `false` ⇒ the dialog took over
 * and will run `proceed` itself after either the user's answer or the
 * preference-driven save lands.
 *
 * Every caller passes a `proceed` that re-issues its own action with the
 * force/replace flag set, so the answer travels back out through the same code
 * path it came in on rather than through a re-implementation of it.
 */
export function guardExit(proceed, onCancel) {
  const rows = exitDiff();
  if (!rows) return true;
  /* already asking — a second trigger (a chord under the open dialog, a stray
     click) must not stack a second copy or replace the pending destination */
  if (state.exitGuard) {
    if (onCancel) onCancel();
    return false;
  }
  const doc = activeDoc();
  if (!settingAt("editor.confirmBeforeExit")) {
    /* The gate stays synchronous for every caller: false means "do not leave
       yet", exactly as it does while the dialog owns the destination. Hold
       that destination in the same slot while the write is in flight, then
       replay the caller's own action only after the server confirms it. */
    const g = { path: doc.path, proceed: proceed, onCancel: onCancel || null, automatic: true };
    state.exitGuard = g;
    void saveDoc(g.path).then((ok) => {
      /* A later owner can only arise by explicit cleanup; never let this save
         retire or navigate for somebody else's pending exit. */
      if (state.exitGuard !== g) return;
      state.exitGuard = null;
      if (!ok) {
        if (g.onCancel) g.onCancel();
        return toast("Could not save " + g.path + " — your changes are still in this tab");
      }
      exitGuardProceed(g);
    });
    return false;
  }
  state.exitGuard = { path: doc.path, proceed: proceed, onCancel: onCancel || null };
  $("#xgPath").textContent = doc.path;
  $("#xgBody").textContent =
    "This is what is in the editor but not in the file. Leaving now without saving throws it away.";
  renderDiff($("#xgDiff"), rows);
  $("#xgVeil").classList.add("show");
  /* THE VEIL TAKES FOCUS, NOT A BUTTON — the same rule `orphanDialog` learned
     the hard way. This dialog is raised by the browser Back button as often
     as by a click, i.e. with the caret in the middle of a sentence, and a
     focused button is pressed by the space bar. Tab, Enter on a chosen
     button and Esc all still work; no verb is sitting under the next keystroke,
     and neither of the two that leave is one. */
  setTimeout(() => {
    const m = $("#xgVeil .modal");
    if (m && $("#xgVeil").classList.contains("show")) focusQuiet(m);
  }, 30);
  return false;
}

/** KEEP EDITING — Esc, a click on the scrim, Back. Same thing. */
export function closeExitGuard() {
  const g = state.exitGuard;
  state.exitGuard = null;
  $("#xgVeil").classList.remove("show");
  if (!g) return;
  /* back to exactly where you were: still dirty, caret in the text. The
     dialog cost a focus and nothing else. */
  visual?.focus();
  /* KEEP EDITING IS A CANCELLATION for whoever was trying to leave. Almost
     every caller passes no hook — its action simply does not happen, which is
     the whole point of the guard. The one that has to hear about it is the
     undo timeline (ADR 0014): `applyFileHistory` is awaiting a promise, and
     without this it never settles, so the entry it is holding never goes back
     on offer. */
  if (g.onCancel) g.onCancel();
}

/** Hand the pending destination back its go-ahead, once. */
function exitGuardProceed(g) {
  if (g && g.proceed) g.proceed();
}

/**
 * DISCARD — put the saved document back in the buffer, then leave.
 *
 * The revert is written into BOTH the model and the island before `proceed`
 * runs: a destination that keeps the pane (the settings page) would otherwise
 * return to discarded text that the island's next change writes back.
 *
 * A REVEAL is part of what is being discarded: its plaintext was typed against
 * text that no longer exists, so the entry goes and the block paints locked
 * again from the restored armor.
 */
export function exitGuardDiscard() {
  const g = state.exitGuard;
  /* This route LEAVES, so it is not the cancellation `closeExitGuard` reports
     — hand the hook off before closing so it cannot fire on the way through. */
  if (g) g.onCancel = null;
  closeExitGuard();
  if (!g) return;
  const doc = state.docs.get(g.path);
  if (doc && doc.diskText != null) {
    doc.markdown = doc.diskText;
    for (const [key, entry] of state.reveal) if (entry.path === g.path) state.reveal.delete(key);
    if (g.path === state.active) {
      /* the screen is the discarded text again, so whatever refused to
         serialize is gone with it and this doc may be written once more */
      visualStale = null;
      visual?.setMarkdown(doc.markdown);
      repaintSecretsUI();
      /* the debounce is armed against text that no longer exists */
      clearTimeout(dirtyT);
      state.dirty = false;
      setSaveIndicator("Saved");
      updateMeta();
    }
  }
  exitGuardProceed(g);
}

/**
 * SAVE & EXIT — the primary, and the humane default.
 *
 * The user asked for a confirmation before discarding; offering the save as the
 * button under Enter means the safe answer is also the easy one, and the
 * destructive answer stays a deliberate second choice.
 *
 * Leaving is conditional on the write LANDING. `saveDoc` returns false for an
 * orphaned doc (it raises the Recreate/Discard veil instead) and for a failed
 * PUT — walking away from either would be the silent loss this whole dialog
 * exists to stop, so the buffer stays put and says why.
 */
export async function exitGuardSave() {
  const g = state.exitGuard;
  /* Same hand-off as Discard — but held onto, because a save that FAILS
     strands the destination just as surely as Keep editing does, and that is a
     cancellation as far as whoever was leaving is concerned. */
  const cancel = g && g.onCancel;
  if (g) g.onCancel = null;
  closeExitGuard();
  if (!g) return;
  const ok = await saveDoc(g.path);
  if (!ok) {
    if (cancel) cancel();
    return toast("Could not save " + g.path + " — your changes are still in this tab");
  }
  /* A write that landed and left the buffer dirty anyway (a keystroke mid-flight,
     a reveal still waiting for the worker) has not answered the question this
     dialog asked, so it asks again rather than leaving the new text behind. */
  if (g.path === state.active && exitDiff()) {
    guardExit(g.proceed, cancel);
    return;
  }
  exitGuardProceed(g);
}

/* ============================================================
   EDITOR SHELL
   ============================================================ */
/** Size a textarea to its content: the composer and a revealed secret. */
export function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

export function updateMeta() {
  const doc = activeDoc();
  if (!doc) return;
  const md = String(doc.markdown || "");
  const n = md === "" ? 0 : md.replace(/\n$/, "").split("\n").length;
  $("#stLines").textContent = n + (n === 1 ? " line" : " lines");
  $("#stWords").textContent = countWords(md) + " words";
}

function renderCrumbs(doc) {
  $("#crumbs").innerHTML = doc.path
    .split("/")
    .map((p, i, a) =>
      i === a.length - 1
        ? '<b class="chip-mono"><button class="crumb-name" data-act="rename-active" title="Rename ' +
          esc(doc.path) +
          '" aria-label="Rename ' +
          esc(doc.path) +
          '">' +
          esc(p) +
          "</button></b>"
        : '<span class="cr-dir">' + esc(p) + "</span>"
    )
    .join('<span class="sep cr-dir">/</span>');
}

export function startHeaderRename() {
  const doc = activeDoc();
  const button = $("#crumbs .crumb-name");
  if (!doc || !button) return;
  const holder = button.parentElement;
  const input = document.createElement("input");
  input.className = "crumb-rename";
  input.setAttribute("aria-label", "Rename " + doc.path);
  const slash = doc.path.lastIndexOf("/");
  const parent = slash < 0 ? "" : doc.path.slice(0, slash + 1);
  input.value = doc.path.slice(slash + 1);
  holder.replaceChildren(input);
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      input.disabled = true;
      await commitRename({ path: doc.path, type: "file" }, parent + input.value);
    }
    if (!input.isConnected) return;
    const now = activeDoc();
    if (now) renderCrumbs(now);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    void finish(e.key === "Enter");
  });
  input.addEventListener("blur", () => void finish(true));
  focusQuiet(input);
  const stemEnd = input.value.replace(/\.md$/i, "").length;
  try {
    input.setSelectionRange(0, stemEnd);
  } catch (_) {}
}

/* ============================================================
   EDIT — the BlockNote island

   One mounted controller at a time, for one path. The island is a leaf by
   construction: it speaks markdown, lines and callbacks, and knows nothing
   about the shell — every bridge back into the app is in this section.

   LINE NUMBERS. The island counts source lines from 1 (a file's own
   numbering); `openDoc({ line })` counts from 0 and converts on the way in.
   ============================================================ */
let visual = null;
let visualPath = null;
/* THE BUFFER STOPPED FOLLOWING THE SCREEN. The island could not write the
   document back as Markdown, so `doc.markdown` is the last text that DID
   serialize — older than what the user can see. Writes for that doc are refused
   until an edit serializes again: autosaving those bytes would replace the
   visible edit with the previous ones, and say "Saved" while doing it. The DOC
   OBJECT, not its path: a rename moves the buffer, not the problem. */
let visualStale = null;
/* Mounting is asynchronous, so a second render can start before the first has
   finished importing. Only the newest generation may install itself. */
let mountGeneration = 0;
/* asked for before the island existed, applied once it mounts: a reveal
   (`{ line, anchor }`, the island's lines) and the caret */
let pendingReveal = null;
let pendingFocus = false;
let editorBundle;

/** Unmount, and hand the secret ids the island was holding back to secrets.js
    so the next mount can bind its own. Called before every re-render. */
export function destroyEditor() {
  mountGeneration++;
  pendingReveal = null;
  pendingFocus = false;
  visualStale = null;
  if (visual) {
    releaseSecretIds(visualPath, visual.getSecrets());
    visual.destroy();
  }
  visual = null;
  visualPath = null;
}

/** Whether the mounted island still holds a step of its OWN history. Undo in
    Edit is BlockNote's (ADR 0014 as amended) only for as long as this is true:
    with that history exhausted ⌘Z is the app timeline's again, so a file
    operation made from inside Edit is still undoable without leaving it. */
export function visualCanStep(redo) {
  if (!visual) return false;
  return redo ? visual.canRedo() : visual.canUndo();
}

/** Swap one block's ciphertext in the mounted island — the island half of
    `replaceArmorInDoc` (secrets.js), keyed by the block id rather than by the
    armor, because identical ciphertext can appear twice in one doc. */
export function replaceVisualSecret(path, id, ciphertext) {
  if (visualPath !== path || !visual) return null;
  return visual.replaceSecret(id, ciphertext);
}

/** Put a new secret block at the island's cursor — `newSecret`'s way in. */
export function insertVisualSecret(path, armor) {
  return visualPath === path && !!visual?.insertSecret(armor);
}

export const commitVisualDrafts = () => visual?.commitDrafts();

async function renderVisual(doc, host) {
  const generation = mountGeneration;
  const surface = el("div", "block-editor-host");
  surface.textContent = "Loading editor…";
  host.appendChild(surface);
  try {
    const css = $("#editor-css");
    /* `data-js` is the CONTENT-ADDRESSED entry, written into the shell by the
       server beside the hashed stylesheet href and its modulepreload — so this
       import usually resolves against a request the parser already started, and
       never pays the alias's no-cache 302. `/vendor/editor.js` is the fallback
       for a shell served before the bundle built, and for a direct hit.
       The bundle is fetched once per page and cached; a failed import must not
       be cached, or a recovered network would never get a second chance. */
    editorBundle ||= import(css?.dataset.js || "/vendor/editor.js").catch((err) => {
      editorBundle = null;
      throw err;
    });
    /* The stylesheet is a plain <link> in the head, so the only honest signals
       are its own events and the flags its inline handlers leave behind (the
       load may have finished before this code ever ran). */
    const stylesheet = new Promise((resolve, reject) => {
      if (css.dataset.failed) return reject(new Error("Editor stylesheet failed"));
      if (css.sheet || css.dataset.loaded) return resolve();
      css.addEventListener("load", resolve, { once: true });
      css.addEventListener("error", reject, { once: true });
    });
    const [{ mountEditor }] = await Promise.all([editorBundle, stylesheet]);
    if (generation !== mountGeneration || !surface.isConnected) return;
    surface.textContent = "";
    visualPath = doc.path;
    visual = mountEditor(surface, {
      markdown: doc.markdown,
      copyText,
      onChange(markdown) {
        if (generation !== mountGeneration) return;
        visualStale = null;
        doc.markdown = markdown;
        /* NOT `recordHistory`: undo inside Edit is the island's own
           (ProseMirror history, ADR 0014 as amended) — recording every
           transaction on the app timeline would give ⌘Z two owners. */
        markDirty();
        updateMeta();
      },
      /* A protected block's Markdown, replaced in place; the autosave writes
         it. No `flushSecretEdits` first: `markdown` was cut before any flush
         and would put the old armor back. A revealed, edited secret rides the
         re-render in `state.reveal`, and the save re-encrypts it. */
      onSourceEdit(markdown) {
        setDocText(doc, markdown);
        markDirty();
      },
      onDraft: markDirty,
      onNewSecret: newSecret,
      /* The document on screen is not expressible as Markdown (nesting or
         formatting the adapter cannot re-import). Saying so beats a document
         that quietly stops being written: the buffer is marked unsaved, the
         write is blocked below, and the edit is still there to undo. */
      onError(message) {
        if (generation !== mountGeneration) return;
        visualStale = doc;
        state.dirty = true;
        setSaveIndicator("Unsaved changes", "dirty");
        toast("This edit cannot be written as Markdown — " + message + ". Undo it to keep editing.");
      },
      /* The block the island draws for an ```age fence is the app's own secret
         DOM: reveal, edit, copy and lock stay where they have always been, and
         no plaintext ever enters the editor's model. `ord` is the ordinal of
         this ciphertext among the copies of itself ABOVE this block, which is
         what makes two identical fences two different blocks. */
      renderSecret({ id, ciphertext, line, indent = "" }) {
        const prefix = doc.markdown.split("\n").slice(0, line - 1).join("\n");
        const ord = prefix.split(ciphertext).length - 1;
        bindSecretIds(doc.path, ciphertext, ord, id);
        /* the block moved on from the armor a reveal was taken against (an
           edit, a re-encrypt), so that plaintext no longer describes it */
        for (const [key, entry] of state.reveal) {
          if (entry.path === doc.path && entry.ord === id && entry.armor !== ciphertext) state.reveal.delete(key);
        }
        const existing = $$("#doc .secret").find((n) => n.zSecret?.ord === id && n.zSecret.armor === ciphertext);
        return existing || secretEl(doc.path, ciphertext, indent, id);
      },
      resolveWikiLink(target) {
        return lookupLink(target).path || undefined;
      },
      /* through the app's ONE link handler (app.js), so multi-vault
         resolution, the create-on-missing branch and the exit guard all behave
         exactly as they do for a pill the user clicked */
      onWikiLink(target) {
        const link = el("a", "wl");
        link.dataset.link = target;
        host.appendChild(link);
        link.click();
        link.remove();
      },
    });
    if (pendingReveal) visual.revealLine(pendingReveal.line, pendingReveal.anchor);
    if (pendingFocus) visual.focus();
    pendingReveal = null;
    pendingFocus = false;
  } catch (err) {
    if (generation !== mountGeneration || !surface.isConnected) return;
    console.error("The visual editor could not load", err);
    /* Say why instead of leaving a blank page behind (SPEC §11). The island is
       the only doc surface, so nothing here is editable until a reload. */
    destroyEditor();
    surface.remove();
    host.appendChild(el("div", "note bad", 'The editor could not load. <button class="btn" data-act="reload">Reload</button>'));
  }
}

export function renderDoc(opts) {
  opts = opts || {};
  const doc = activeDoc();
  const host = $("#doc");
  /* before the DOM goes: the island holds secret ids and a React root, and
     both have to be handed back rather than thrown away with the innerHTML */
  destroyEditor();
  host.innerHTML = "";
  /* New secret needs a doc to land in and a vault that can encrypt */
  $("#encBtn").hidden = !doc || vault.state === "disabled";
  if (!doc) return;
  /* the island's code blocks inherit their tab width from here */
  host.style.tabSize = String(settingAt("editor.tabSize"));

  const meta = el("div", "doc-meta");
  meta.innerHTML =
    '<span class="tag">' + esc(doc.path) + "</span>" +
    "<span>" + esc(relTime(doc.mtime)) + "</span>";
  host.appendChild(meta);

  /* An empty doc is an empty editor: there is nothing to announce to somebody
     whose caret is already in the place they would type. */
  renderVisual(doc, host);

  /* the entrance animation belongs to navigation; a repaint in place must not
     translate or fade the container (amendment 11) */
  host.classList.remove("fade-in");
  if (!opts.noFade) {
    void host.offsetWidth;
    host.classList.add("fade-in");
  }

  renderCrumbs(doc);
  /* `.statusbar .path` is the one item with a shrink budget, so it is the one
     that ends up ellipsised — and with no `title` a truncated path could not be
     recovered by hover either */
  $("#stPath").textContent = doc.path;
  $("#stPath").title = doc.path;
  updateMeta();
  $$(".row.file").forEach((r) => r.classList.toggle("active", r.dataset.doc === state.active));
}

function relTime(mtime) {
  if (!mtime) return "";
  const mins = Math.round((Date.now() - new Date(mtime).getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return "Edited " + mins + " min ago";
  const h = Math.round(mins / 60);
  return "Edited " + h + (h === 1 ? " hour ago" : " hours ago");
}

/**
 * THE ON-DISK TEXT, remembered beside the buffer.
 *
 * `doc.markdown` cannot answer "what is on disk?" — the island writes straight
 * into it on every change (`onChange`), so by the time anything asks, the
 * model and the buffer are the same string. `doc.diskText` is the last
 * markdown the SERVER confirmed, and it is the only thing the exit guard can
 * honestly diff against.
 *
 * Every arrival from the server and every successful write goes through here.
 * A doc with no baseline (nothing ever fetched it) is treated as CLEAN by
 * `exitDiff`, never as dirty: a guard that cannot say what changed has
 * nothing to show, and an empty modal in front of an exit is worse than no
 * modal at all.
 *
 * Named `diskText`, not `saved`: this object is `Object.assign`ed over with
 * raw `/api/docs/{path}` response bodies in five places, and a field the
 * server might one day also send would be silently clobbered by one of them.
 */
export function setBaseline(doc, text) {
  if (doc) doc.diskText = String(text == null ? doc.markdown || "" : text);
  return doc;
}

export async function ensureLoaded(path) {
  const cached = state.docs.get(path);
  if (cached && cached.loaded) return cached;
  const d = await api.getDoc(path);
  const merged = Object.assign({}, cached || {}, d, { loaded: true });
  setBaseline(merged, d.markdown);
  state.docs.set(path, merged);
  return merged;
}

/**
 * New text for a doc that no keystroke typed — an agent's write, a protected
 * block edited in place — as ONE step on the shared timeline, so ⌘Z takes it
 * back like any other edit (ADR 0014). The step starts from what the pane
 * holds, so unsaved typing is neither dropped nor folded into it, and an open
 * pane repaints where the reader was.
 */
function setDocText(doc, markdown) {
  const before = doc.markdown || "";
  doc.markdown = markdown;
  if (markdown !== before) recordHistory({ kind: "text", path: doc.path, before, after: markdown });
  if (doc.path !== state.active) return;
  const at = visual?.anchorLine();
  renderDoc({ noFade: true });
  pendingReveal = at;
}

/**
 * Replace a doc's text without a keystroke: the write half of `webmcp.js`.
 * It goes through the pipeline typing goes through rather than PUTting behind
 * the app's back (`setDocText`), and `saveDoc` writes it with its conflict,
 * orphan and re-encrypt handling intact. `rev` is optional and is checked
 * against the copy this tab holds, so a caller whose read went stale is told
 * so (`rev-conflict`) instead of overwriting.
 */
export async function replaceDocText(path, markdown, rev) {
  const doc = await ensureLoaded(path);
  if (rev != null && rev !== "" && rev !== doc.rev)
    throw new api.ApiError(409, {
      error: "rev-conflict",
      message: "This doc changed since that rev — read it again before writing.",
      rev: doc.rev,
    });
  /* an open draft is its own step, before the write — not discarded under it */
  if (visualPath === path) commitVisualDrafts();
  setDocText(doc, String(markdown == null ? "" : markdown));
  /* silent: the pane already shows the new text, and a toast about a write
     nobody in this tab asked for is the app talking to itself */
  const wrote = await saveDoc(path, { silent: true });
  if (!wrote)
    throw new api.ApiError(409, {
      error: "not-saved",
      message: "The change is in this tab but did not reach disk — " + path + " may have moved or conflicted.",
    });
  return { path, rev: doc.rev, bytes: doc.bytes };
}

/* Navigation token. openDoc awaits a save and a fetch, so two of them can be
   in flight at once — a click during the reload that follows a rename, an SSE
   `moved` echo landing after the user has already moved on. The LAST navigation
   asked for is the one that must win; an older one that finishes late has to
   drop out rather than repaint the pane and the statusbar over it. */
let navSeq = 0;

/* Where the user has asked to be, which is NOT state.active: openDoc only
   commits state.active once the fetch resolves, so for the whole width of that
   round trip state.active still names the doc being navigated AWAY from.
   Anything that reacts to a doc "being the one on screen" has to consult this
   instead, or it answers for a doc the user has already left. */
let navTarget = null;
let navPending = false;
/** the doc the user is looking at, or — mid-navigation — has asked to look at */
export function viewedPath() {
  return navPending ? navTarget : state.active;
}

/* A move re-homes the pane onto the doc's new path, from two places: the local
   action (commitRename) and the SSE `moved` echo. Both reach their openDoc only
   AFTER awaiting a tree reload, and a click can land inside that window — which
   would make a navigation the user asked for lose to one they asked for
   earlier, purely because the follow-up was slower. navSeq alone cannot see
   this: it orders by call time, and the follow-up is called last.

   So: latch the generation before the awaits, and only navigate if nothing else
   has claimed navigation since. This also de-duplicates the two paths — whoever
   re-homes first wins and the other stands down, instead of both fetching. */
export function navGate() {
  const at = navSeq;
  return () => navSeq === at;
}

export async function openDoc(path, opts) {
  if (!path) return;
  /* NAVIGATING AWAY FROM A DIRTY BUFFER asks first — a tree click,
     a ⌘K pick, a [[link]], the home button. `replace` is what the programmatic
     re-homes carry (a popstate we are catching up with, the SSE `moved` echo, an
     accepted proposal, an openDoc that is repairing the address bar), and none
     of those is a person leaving: stopping THEM to ask would strand the pane and
     the URL on different docs. `force` is the dialog's own way back in. */
  if (path !== state.active && !(opts && (opts.replace || opts.force))) {
    if (!guardExit(() => openDoc(path, Object.assign({}, opts || {}, { force: true })))) return;
  }
  /* …and the settings page's own unsaved work, on the same terms. NOT gated on
     `path !== state.active`, the way the exit guard above is: the settings page
     keeps `state.active` naming the doc it will return to, so clicking that
     very doc in the tree is a real exit from a page holding a real draft.
     `force`/`replace` mean the same thing here as there, and the two guards can
     never both fire — `exitDiff` returns null on the settings view. */
  if (!(opts && (opts.replace || opts.force))) {
    if (!guardSettingsExit(() => openDoc(path, Object.assign({}, opts || {}, { force: true })))) return;
  }
  const nav = ++navSeq;
  navTarget = path;
  navPending = true;
  /* only the newest navigation may retire the pending flag; an older one
     finishing late has already lost and must leave the newer one's claim up */
  const settle = () => {
    if (nav === navSeq) navPending = false;
  };
  if (state.dirty && state.active && state.active !== path) {
    /* the indicator is about to read "Saved" for the NEW doc — say so out loud
       if the old one did not actually reach disk */
    const wrote = await saveDoc(state.active, { silent: true });
    if (!wrote) toast("Unsaved changes in " + state.active + " could not be written — they are still in this tab");
  }
  if (nav !== navSeq) return;
  try {
    await ensureLoaded(path);
  } catch (err) {
    settle();
    apiFail(err, "Could not open " + path);
    /* the address bar may already be on the doc that did not open (a Back into
       something since deleted) — put it back on the doc still on screen */
    if (state.active) routeDoc(state.active, true);
    return;
  }
  if (nav !== navSeq) return;
  settle();
  /* plaintext lives exactly as long as the doc that holds it is on screen */
  for (const [k, e] of [...state.reveal]) if (e.path !== path) state.reveal.delete(k);
  state.active = path;
  /* …and this is where the browser will come back to when it is next handed a
     bare `/` (ADR 0035). Beside `state.active` rather than beside `routeDoc`
     because it is the same fact one shelf up: the doc that is on screen. */
  rememberLastDoc(path);
  /* Opening a doc IS a change of context, so the sidebar pick stops speaking
     for ⌥N: the open doc's folder is the context from here (`createParent`).
     Without this, opening a doc from the palette or a [[link]] would still
     create beside whatever folder was last clicked. */
  state.pick = null;
  /* A doc can arrive dirty: this tab may have been holding unsaved text for it
     already (a buffer left behind by an earlier visit, a proposal written into
     a doc that was not on screen). The baseline is the only honest answer. */
  const doc = activeDoc();
  state.dirty = doc.markdown !== doc.diskText;
  setSaveIndicator(state.dirty ? "Unsaved changes" : "Saved", state.dirty ? "dirty" : undefined);
  /* Opening a doc from the settings page IS how you leave it — the tree, ⌘K,
     a [[link]] and the home button are all navigations, and the pane shows one
     place at a time. Before routeDoc, so the entry it writes describes what is
     about to be on screen. */
  exitSettings();
  /* the URL is written HERE and nowhere else: after the doc is known to exist,
     before it is painted (see the ROUTING section) */
  routeDoc(path, opts && opts.replace);
  revealInTree(path);
  renderDoc();
  $("#scroll").scrollTop = 0;
  /* picking a doc out of a DRAWER is done with the drawer — but a sidebar
     that is a column stays exactly where it is */
  if (isDrawer()) closeNav();
  refreshSessionStats();
  /* after `renderDoc`, whose unmount clears both; the island applies them on mount */
  if (opts && opts.line != null) pendingReveal = { line: opts.line + 1 };
  pendingFocus = !!(opts && opts.focus);
}

/* ============================================================
   TEXT HISTORY — the timeline's editing half (ADR 0014)

   Typing in Edit is the island's own history. This timeline holds the text
   no keystroke typed, one entry per `setDocText`.
   ============================================================ */
/**
 * Put a document back to one side of a text entry, GOING THERE FIRST if it is
 * not the doc on screen. The navigation is the point: an undo that silently
 * rewrote a file you were not looking at would be indistinguishable from
 * nothing happening.
 */
export async function applyTextHistory(entry, undoing) {
  if (!state.docPaths.has(entry.path)) {
    toast(entry.path + " is not in the vault — undo its deletion first");
    return false;
  }
  /* Unsaved work in the doc being left behind is written, not thrown away and
     not turned into a modal: this chord is supposed to be seamless, and the
     buffer it is leaving is the user's. */
  if (state.active && state.active !== entry.path && state.dirty) await saveDoc(state.active, { silent: true });
  if (state.active !== entry.path) await openDoc(entry.path, { force: true });
  const doc = state.docs.get(entry.path);
  if (!doc) return false;
  doc.markdown = undoing ? entry.before : entry.after;
  renderDoc();
  /* An undo is an edit like any other: the buffer now differs from the file,
     so it is dirty and the ordinary save path takes it from here. */
  markDirty();
  return true;
}

/* ============================================================
   SAVE
   ============================================================ */
let dirtyT, flashT, markT;

/** How long "it just saved" stays on screen. ONE constant for both marks: the
    statusbar pip's green blink and the topbar tick are the same beat seen in
    two places, and two timings would show as one outlasting the other. */
const SAVE_FLASH_MS = 1700;

/* THE TOPBAR MARK — up only while it has news.

   `dirty` (amber dot) while the buffer diverges from the file; `saved` (green
   tick, one pop) when a write lands, held for the same beat as the pip's blink
   and then faded out; nothing at all otherwise. `leaving` runs the fade before
   the classes come off, so the mark exits rather than being cut.

   Its own timer, not `flashT`: the pip's flash and this one end at the same
   moment but do different things, and sharing a handle made whichever ran
   second cancel the first's cleanup. */
function topMark(kind) {
  const m = $("#tbSave");
  if (!m) return;
  clearTimeout(markT);
  m.classList.remove("dirty", "saved", "leaving");
  if (kind === "dirty") return void m.classList.add("dirty");
  if (kind !== "saved") return;
  m.classList.add("saved");
  markT = setTimeout(() => {
    m.classList.add("leaving");
    markT = setTimeout(() => m.classList.remove("saved", "leaving"), 340);
  }, SAVE_FLASH_MS);
}

/* The indicator is a statusbar PIP now — one 6px dot, no words on screen — so
   the state has to reach the pointer and the screen reader by other routes:
   `#saveTxt` still carries it as (clipped) text for assistive tech and for the
   tests, and the title carries it for a hover. Everything else about this
   function is unchanged: `dirty`/`flash` are still the two classes, and
   `#saveTxt`'s textContent is still the contract. */
function saveState(txt) {
  const t = $("#saveTxt");
  /* Write only on a real transition. `markDirty` runs on EVERY keystroke, and
     an aria-live region re-announces text that is merely re-assigned — the
     unguarded version read "Unsaved changes" aloud once per character. */
  if (t.textContent === txt) return;
  t.textContent = txt;
  $("#saveInd").title = txt + " — click (or ⌘S) to save now";
}

export function setSaveIndicator(txt, cls) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  if (cls) ind.classList.add(cls);
  saveState(txt);
  /* Every route into this function that is NOT "the buffer went dirty" is a
     document arriving clean — opened, discarded back to its baseline, or
     written by a silent save. None of them is news, so the topbar says
     nothing. */
  topMark(cls === "dirty" ? "dirty" : "none");
}

export function markDirty() {
  state.dirty = true;
  setSaveIndicator("Unsaved changes", "dirty");
  clearTimeout(dirtyT);
  const secs = settingAt("editor.autosaveSeconds");
  /* the path is latched HERE, not read when the timer fires: a doc renamed from
     another device inside the debounce window would otherwise autosave whatever
     happened to be active by then */
  const path = state.active;
  dirtyT = setTimeout(() => saveDoc(path, { auto: true }), Math.max(600, secs * 1000));
}

function flashSave(txt) {
  const ind = $("#saveInd");
  ind.classList.remove("dirty", "flash");
  saveState(txt);
  void ind.offsetWidth;
  ind.classList.add("flash");
  topMark("saved");
  clearTimeout(flashT);
  flashT = setTimeout(() => {
    ind.classList.remove("flash");
    if (!state.dirty) saveState("Saved");
  }, SAVE_FLASH_MS);
}

/* One save at a time per DOC, keyed by the doc object rather than by its path.

   A rename from another device moves the buffer to a new path while a save is
   in flight (`onDocChanged` retargets the same object, shell.js), and a queue
   keyed by the old string would let the follow-up write to a path that no
   longer exists — or, worse, race a second queue under the new one.

   `flushSecretEdits` re-encrypts a dirty reveal and only clears its `dirty`
   flag AFTER the worker round-trip, so two overlapping saves both saw the same
   dirty entry, both re-encrypted it, and the loser's `replaceArmorInDoc` missed
   because the winner had already swapped the armor. That surfaced as a false
   "reload before saving" alarm — advice that, in a dirty buffer, destroys work.
   ⌘S is bound on the document, on the toolbar and on a 10s timer, so overlap is
   ordinary. At most one follow-up is queued: later keystrokes still get written,
   without a stampede of PUTs. */
const saveInflight = new Map(); // doc object → { p, queued }

export function saveDoc(path, opts) {
  path = path || state.active;
  const doc = path ? state.docs.get(path) : null;
  if (!doc) return Promise.resolve(false);
  const cur = saveInflight.get(doc);
  if (cur) {
    if (cur.queued) return cur.queued;
    cur.queued = cur.p.then(() => {
      if (saveInflight.get(doc) === cur) saveInflight.delete(doc);
      /* `doc.path`, not `path`: the follow-up writes wherever the doc is by then */
      return saveDoc(doc.path, opts);
    });
    return cur.queued;
  }
  const rec = { queued: null };
  rec.p = doSaveDoc(doc, opts).finally(() => {
    if (saveInflight.get(doc) === rec && !rec.queued) saveInflight.delete(doc);
  });
  saveInflight.set(doc, rec);
  return rec.p;
}

/** @returns {Promise<boolean>} whether the document actually reached the server */
async function doSaveDoc(doc, opts) {
  opts = opts || {};
  const path = doc.path;
  /* `visualStale`: these bytes are older than the screen, so there is nothing
     here that may be written. The notice went up when it happened. */
  if (visualStale === doc) {
    if (!opts.quiet) toast("Not saved — this doc has an edit that cannot be written as Markdown");
    return false;
  }
  /* THE leak gate (research §6 "Autosave"): the payload is built
     from doc.markdown, which holds armor only. A block that was revealed but
     not edited contributes its original bytes; a block that WAS edited is
     turned back into ciphertext here, before a single byte is serialized.
     There is no path from this function to a plaintext request body. */
  try {
    /* An open draft is an unsaved edit: a save applies it before the flush (whose
       armor its splice would undo); an autosave waits rather than remount the island. */
    if (visualPath === doc.path && visual?.hasDraft()) {
      if (opts.auto) return markDirty(), false;
      commitVisualDrafts();
    }
    await flushSecretEdits(doc);
  } catch (err) {
    return false;
  }
  /* An external move can complete while the worker re-encrypts a dirty secret —
     start again at the path this doc now has rather than PUTting to the old one. */
  if (doc.path !== path) return doSaveDoc(doc, opts);
  clearTimeout(dirtyT);
  /* THE ORPHAN GATE. This buffer's file left the vault while it was dirty (see
     the `removed` branch in `connect`), so there is nothing to PUT to — and a
     save that quietly does nothing is exactly the failure the retention was
     added to stop. Ask, with both real answers on the table, and never guess:
     recreating a doc somebody deliberately deleted on another device would be
     the same kind of silent decision in the other direction. */
  if (doc.orphaned) {
    /* an unloading or backgrounded page has nowhere to put a question; the
       buffer and the sticky notice both stay, which is the honest outcome.
       `focus` is false for an AUTOSAVE — see orphanDialog: the veil must not
       take the caret out from under someone who is still typing. */
    if (!opts.quiet) orphanDialog(path, { focus: !opts.auto });
    return false;
  }
  state.saving.add(path);
  /* the exact bytes this PUT carries, latched BEFORE the await: a keystroke
     that lands mid-flight moves `doc.markdown` on, and recording that as the
     baseline would call the buffer clean over text the server never saw */
  const sent = doc.markdown;
  try {
    const r = await api.putDoc(path, sent, doc.rev, opts.keepalive ? { keepalive: true } : null);
    doc.rev = r.rev;
    doc.mtime = r.mtime;
    doc.bytes = r.bytes;
    setBaseline(doc, sent);
    if (path === state.active) {
      /* WHAT THE SERVER TOOK IS NOT NECESSARILY WHAT IS IN FRONT OF THE USER: a
         keystroke that landed mid-flight, or a reveal still holding an unsaved
         edit, leaves the buffer dirty over text that did reach disk. Saying
         "Saved" there would be the lie the exit guard then acts on. */
      state.dirty = doc.markdown !== sent || [...state.reveal.values()].some((e) => e.path === path && e.dirty);
      if (state.dirty) markDirty();
      else if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
      /* A SILENT save still may not leave the indicator lying. `silent` has
         always meant "no flash, no toast"; it never meant "go on reading Unsaved
         changes over text that is now on disk". */
      else setSaveIndicator("Saved");
    } else if (!opts.silent) flashSave(opts.auto ? "Autosaved" : "Saved");
    if (!opts.auto && !opts.silent) toast(state.sync && state.sync.remote ? "Saved to disk · " + state.sync.remote : "Saved to disk");
    refreshSessionStats();
    return true;
  } catch (err) {
    /* …and the same move can land while the PUT is in flight: the write failed
       against a path this doc has left, so it is reissued rather than reported. */
    if (doc.path !== path) return doSaveDoc(doc, opts);
    /* A PUT to a doc that is not there. The `doc-changed` that would have told
       us can be lost (the stream was down, the tab was frozen) or simply not
       have arrived yet, so the 404 is the SECOND way into the orphan state and
       has to reach the same dialog — otherwise the gap between "deleted" and
       "we heard about it" is a window where the save fails with a toast and the
       text has no route back to disk. */
    if (err && err.status === 404) {
      doc.orphaned = true;
      if (!opts.quiet) orphanDialog(path, { focus: !opts.auto });
      return false;
    }
    /* the unload flush cannot show anything to anybody — never log from it */
    if (opts.quiet) return false;
    if (err && err.code === "rev-conflict") {
      const mine = doc.markdown;
      const disk = err.body && typeof err.body.markdown === "string" ? err.body.markdown : null;
      /* buffer dirty ⇒ the banner, never a silent overwrite. `state.dirty`
         tracks the ACTIVE doc only, so a background buffer whose text differs
         from disk counts as dirty too — that is exactly the case phase 5
         introduced, where a rename rewrote a [[link]] in a doc the user was
         typing in but had not saved. */
      const dirty = (path === state.active && state.dirty) || (disk != null && disk !== mine);
      if (dirty) {
        if (disk != null) conflictDialog(path, disk, mine);
        else toast("This doc changed on disk — your unsaved text was kept");
        return false;
      }
      toast("This doc changed on disk — reloading");
      const fresh = await api.getDoc(path).catch(() => null);
      if (fresh) {
        // setBaseline like every other adopt: skipping it left diskText naming
        // the pre-conflict bytes, and the exit guard then offered to
        // "discard" text that was already on disk
        state.docs.set(path, setBaseline(Object.assign({}, doc, fresh, { loaded: true }), fresh.markdown));
        if (path === state.active) renderDoc();
      }
    } else apiFail(err, "Save failed");
    return false;
  } finally {
    state.saving.delete(path);
  }
}
