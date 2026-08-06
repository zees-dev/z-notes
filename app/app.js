/* ============================================================
   app.js — boot + event wiring: the composition root.

   Hard rule (inherited from the single-file era, and still true of every
   module in this directory): NO document content, NO vault data, NO settings
   defaults and NO network calls outside api.js, which speaks the contract in
   docs/API.md (normative, SPEC §3). Swap what serves that contract
   and nothing here changes.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
import { estimateBits, generatePassphrase } from "./entropy.js";
import { state } from "./state.js";
import { $, $$, clearStickyToast, lookupLink, toast } from "./ui.js";
import { LONGPRESS_MS, closeCtx, createFromLink, ctxKeys, ctxOpen, ctxTarget, loadTree, openCtx, openCtxFrom, startCreate } from "./tree.js";
import { closeConfirm, confirmOk, conflictDiscardOrphan, conflictKeepMine, conflictRecreate, conflictTakeDisk, wireDialogs } from "./dialogs.js";
import { refreshTrash, toggleTrash } from "./trash.js";
import { autoGrow, closeExitGuard, exitGuardDiscard, exitGuardSave, openDoc, paneClickToPreview, previewClickToEdit, saveDoc, setMode, syncModeUI, trackScrollPointerDown, renderDoc, setBaseline, setSaveIndicator } from "./editor.js";
import { changeVaultPassphrase, closePP, doPassphraseOk, encryptSelection, initSecrets, keyHint, lockVault, paintVaultChip, ppHint, repaintSecretsUI, secretsCall, vault } from "./secrets.js";
import { closePal, loadProposals, loadSession, openPal, palInputChanged, palMove, palOpen, renderChat, sendMessage, startNewSession } from "./chat.js";
import { applyColorScheme, applyDensity, applyLook, applyTheme, checkAiEndpoint, clearSettingsError, coerceNumberSetting, commitFocusedNumber, discardSettingsDraft, draftedLook, leaveSettings, markSeg, openSettings, paintSaveState, paintSettings, pinLookFromUrl, pushSettings, saveSettings, savedValue, setDraft, settingsDirty, clearDraft, showSettings } from "./settings.js";
import { CLOSERS, VEILS, app, closeNav, closeSess, connect, dismissTop, flushBuffer, goHome, healAfterGap, hide, initChatOpen, isDrawer, isOpen, isSheet, onPop, openNav, openSess, paintSync, routeVeil, seedHistory, syncNow, syncScrim, toggleChat, trapTab, urlDoc, urlSettings, wireVisualViewport, openFirstDoc } from "./shell.js";
import { refreshTerminalStatus, submitTerminal, termClear, termRunningId, termWrite, terminalHistory, terminalLock, terminalSavePassword, terminalStop, terminalUnlock } from "./terminal.js";

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest(".wl") : null;
    if (link) {
      e.preventDefault();
      const name = link.dataset.link;
      const hit = lookupLink(name);
      if (hit.state === "ok") openDoc(hit.path);
      /* Ambiguous is NOT missing: creating a third doc with that name would
         make it worse. Say which docs collide and let the author qualify it. */ else if (hit.state === "ambiguous")
        toast("“" + name + "” is ambiguous — " + hit.candidates.join(", ") + ". Write [[folder/name]].");
      else createFromLink(name);
      return;
    }

    const act = e.target.closest ? e.target.closest("[data-act]") : null;
    if (act) {
      const a = act.dataset.act;
      if (a === "save") saveDoc(state.active);
      if (a === "settings") openSettings();
      if (a === "ai-status") checkAiEndpoint();
      if (a === "close-settings") leaveSettings();
      if (a === "save-settings") saveSettings();
      if (a === "discard-settings") discardSettingsDraft();
      if (a === "toggle-chat") toggleChat();
      if (a === "toggle-sidebar") app.classList.toggle("sidebar-collapsed");
      /* the statusbar mode chip — the topbar segmented control's replacement.
         Silent: the chip you just clicked already shows the outcome, and a
         toast on top of it would be the app reading its own statusbar back. */
      if (a === "toggle-mode") setMode(state.mode === "raw" ? "preview" : "raw", { silent: true });
      if (a === "nav-open") openNav();
      if (a === "nav-close") closeNav();
      if (a === "pp-cancel") closePP();
      if (a === "pp-ok") doPassphraseOk();
      if (a === "pp-generate") {
        const p = generatePassphrase();
        $("#ppInput").value = p;
        $("#ppConfirm").value = p;
        /* measured with estimateBits like the Settings handler — the two
           Generate buttons must report the same strength for the same
           generator, and re-deriving the arithmetic here was how they split */
        ppHint("Generated · ~" + estimateBits(p) + " bits. Write it down now — there is no recovery.", false);
      }
      if (a === "encrypt-selection") encryptSelection();
      if (a === "lock-vault") lockVault("manual");
      if (a === "palette") openPal();
      if (a === "shortcuts") $("#scVeil").classList.add("show");
      if (a === "close-shortcuts") hide("#scVeil");
      if (a === "new-doc") startCreate("doc");
      if (a === "new-folder") startCreate("folder");
      if (a === "trash") toggleTrash();
      if (a === "home") goHome();
      if (a === "cf-cancel") closeConfirm();
      if (a === "cf-ok") confirmOk();
      if (a === "cx-take-disk") conflictTakeDisk();
      if (a === "cx-keep-mine") conflictKeepMine();
      if (a === "cx-recreate") conflictRecreate();
      if (a === "cx-discard") conflictDiscardOrphan();
      if (a === "xg-keep") closeExitGuard();
      if (a === "xg-discard") exitGuardDiscard();
      if (a === "xg-save") exitGuardSave();
      if (a === "sess") ($("#sessPop").classList.contains("show") ? closeSess() : openSess());
      if (a === "close-sess") closeSess();
      if (a === "new-session") startNewSession();
      if (a === "send") sendMessage();
      return;
    }

    if ($("#sessPop").classList.contains("show") && !e.target.closest("#sessPop")) closeSess();
  });

  /* ---------- sidebar context menu ---------- */

  $("#sidebar").addEventListener("contextmenu", (e) => {
    /* NEVER take the browser's menu off a text field. The inline create/rename
       input lives inside this tree, and cut/copy/paste/undo on a filename is
       exactly what the native menu is for. Same for a real link. */
    if (e.target.closest && e.target.closest("input, textarea, [contenteditable=true], a[href]")) return;
    e.preventDefault();
    /* An inline create/rename is UNSAVED WORK, and opening the menu destroys
       it: `openCtx` focuses the menu's first item, the field blurs, and the
       blur handler cancels the edit — silently, unlike Esc, which says so. A
       right-click is a request for a menu, not a click-away, so it waits. */
    if (state.creating || state.renaming) {
      const inp = $("#tree .newrow input");
      if (inp) inp.focus();
      toast("Finish the name first — Enter to save, Esc to cancel");
      return;
    }
    /* the Menu key fires `contextmenu` too, with coordinates the UA picks —
       anchor to the row in that case so the menu never lands at (0,0) */
    const kbd = !e.clientX && !e.clientY;
    if (kbd) openCtxFrom(e.target.closest(".row[data-path]") || $("#tree"));
    else openCtx(ctxTarget(e.target), e.clientX, e.clientY);
  });

  /* ---------- …and the same menu from a THUMB ----------
     `contextmenu` is a right-click, and a phone has no right button. The only
     other route to Rename and Delete was `.rowacts`, which is revealed by
     `:hover` / `:focus-within` — and on a phone tapping a FILE row runs
     `openDoc`, which closes the drawer (isDrawer → closeNav), taking the row
     and its actions off-canvas; reopening the drawer moves focus to the Menu
     button, so the reveal is lost again. MEASURED at 390x844 with touch
     emulation: an unbreakable loop in which a file could be created but never
     renamed, moved or deleted. (Folders escaped it — their row toggles
     disclosure and does not close the drawer.)

     So the long press opens the same menu the right-click does, from the same
     `ctxTarget` — one menu, one set of rules, not a second touch-only surface.
     The trailing tap is the whole difficulty: a touch that is not consumed by
     `contextmenu` still produces compat `mousedown` → `click` at liftoff, and
     the capture-phase click-away below would close the menu on the very
     gesture that opened it, then the row's own click would open the doc.
     `lpUntil` is that one gesture's suppression window, spent by the click it
     was opened for or expiring on its own. */
  let lpT = null;
  let lpRow = null;
  let lpAt = null;
  let lpUntil = 0;
  const lpCancel = () => {
    clearTimeout(lpT);
    lpT = null;
    lpRow = null;
  };
  $("#sidebar").addEventListener("pointerdown", (e) => {
    /* a mouse has the right button, and a secondary/eraser button is not a
       press-and-hold */
    if (e.pointerType === "mouse" || e.button > 0) return;
    if (!e.target.closest) return;
    /* the row actions and the inline name field keep their own gestures */
    if (e.target.closest("input, textarea, [contenteditable=true], a[href], .rowact")) return;
    const row = e.target.closest(".row[data-path]");
    if (!row) return;
    lpRow = row;
    lpAt = { x: e.clientX, y: e.clientY };
    clearTimeout(lpT);
    lpT = setTimeout(() => {
      lpT = null;
      const row2 = lpRow;
      lpRow = null;
      if (!row2 || !row2.isConnected) return;
      /* same rule the right-click keeps: an inline create/rename is unsaved
         work and the menu would blur it away silently */
      if (state.creating || state.renaming) return;
      lpUntil = Date.now() + 1200;
      openCtx(ctxTarget(row2), lpAt.x, lpAt.y);
    }, LONGPRESS_MS);
  });
  $("#sidebar").addEventListener("pointermove", (e) => {
    if (!lpT || !lpAt) return;
    /* a scroll that started on a row is a scroll, not a press */
    if (Math.abs(e.clientX - lpAt.x) > 10 || Math.abs(e.clientY - lpAt.y) > 10) lpCancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((n) => $("#sidebar").addEventListener(n, lpCancel));

  /* right-clicking the menu itself is not a request for the browser's menu */
  $("#ctxMenu").addEventListener("contextmenu", (e) => e.preventDefault());
  $("#ctxMenu").addEventListener("keydown", ctxKeys);

  /* the liftoff of the press that OPENED the menu, swallowed before it can
     close the menu again and open the doc underneath it */
  $("#sidebar").addEventListener(
    "click",
    (e) => {
      if (Date.now() >= lpUntil) return;
      lpUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  /* click-away, on MOUSEDOWN and in CAPTURE: the menu must be gone before the
     click it belongs to reaches anything underneath it */
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!ctxOpen()) return;
      if (Date.now() < lpUntil) return; // …except the press that just opened it
      if (e.target.closest && e.target.closest("#ctxMenu")) return;
      closeCtx(true); // the click is going somewhere; do not yank focus back
    },
    true
  );
  /* anything that moves the anchor out from under it closes it. Resize and a
     tree scroll hand focus BACK to the row (the user is still here); a window
     blur does not, because yanking focus while the window is losing it is how
     you fight the browser. */
  window.addEventListener("resize", () => closeCtx());
  $("#tree").addEventListener("scroll", () => {
    lpCancel();
    closeCtx();
  });
  window.addEventListener("blur", () => closeCtx(true));

  /* two disjoint editor click zones (amendments 2 + 12) */
  $("#scroll").addEventListener("pointerdown", trackScrollPointerDown);
  $("#doc").addEventListener("click", previewClickToEdit);
  $("#scroll").addEventListener("click", paneClickToPreview);

  /* backdrop click = dismiss, through the SAME closer table dismissTop uses.
     The if-chain this replaces was a second copy of that table, and it had
     already drifted: #palVeil fell through to the bare class-toggle, so a
     backdrop click closed the palette without closePal's focus release. Every
     veil with teardown beyond hiding must be in CLOSERS, and now there is one
     place that says so. A click on the exit guard's scrim is Keep editing —
     the least destructive answer, which is what closeExitGuard does. */
  $$(".veil").forEach((v) =>
    v.addEventListener("mousedown", (e) => {
      if (e.target !== v) return;
      const close = CLOSERS["#" + v.id];
      if (close) close();
      else v.classList.remove("show");
    })
  );
  /* The scrim is the DRAWER's click-away and nothing else now (see syncScrim):
     the assistant no longer raises one, so there is no longer a layer between
     the reader and the document they are asking about. */
  $("#scrim").addEventListener("click", closeNav);
  ["#ppInput", "#ppConfirm"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      doPassphraseOk();
    })
  );
  $("#ppInput").addEventListener("input", () => {
    if (vault.ppMode !== "create") return;
    const bits = estimateBits($("#ppInput").value);
    ppHint("~" + bits + " bits" + (bits < 60 ? " — too weak, 60 minimum" : " — good"), bits < 60);
  });

  /* segmented controls */
  $$(".seg").forEach((seg) => {
    seg.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const kind = seg.dataset.seg;
      const v = btn.dataset.v;
      /* `kind === "mode"` used to be handled here. The editor mode is no longer
         a segmented control — it is the statusbar chip, wired through the
         `toggle-mode` data-act like every other statusbar affordance. */
      markSeg(seg, v);
      /* Appearance PREVIEWS live and persists on Save — you cannot judge a
         theme from its name. Everything else is draft-only. */
      if (kind === "theme" || kind === "density" || kind === "colorScheme") {
        setDraft(kind, v);
        applyLook(draftedLook(), { preview: true });
      } else if (kind === "effort") {
        setDraft("ai.effort", v);
      }
    });
  });

  /* The settings page's section rail. It goes through `openSettings` like every
     other way in, so there is still exactly one function that knows what
     showing Settings means — and the click writes `/settings/<section>` into
     the address bar, which is the link it is advertising. */
  $$("#settingsNav button").forEach((b) =>
    b.addEventListener("click", () => openSettings(b.dataset.sec))
  );

  $$("[data-sw]").forEach((sw) =>
    sw.addEventListener("click", () => {
      sw.classList.toggle("on");
      setDraft(sw.dataset.sw, sw.classList.contains("on"));
    })
  );

  /** an immediate, non-draft field — see the credential note above setDraft */
  const bindInput = (sel, apply) => {
    const n = $(sel);
    n.addEventListener("change", () => apply(n.value));
  };
  /* Every free-text DRAFT field, bound once, path from the markup — the shape
     `[data-num]` and `[data-sw]` already use. `input` so the Save button lights
     the moment you type, `change` so a paste or an autofill that skips `input`
     is caught too. `paintDraftFields` says why the path lives in the markup. */
  $$("[data-draft]").forEach((n) => {
    const rec = () => setDraft(n.dataset.draft, n.value);
    n.addEventListener("input", rec);
    n.addEventListener("change", rec);
  });
  /* every numeric setting, bound once, bounds and units from `meta.numbers`.
     The clamp/snap that used to be done by the server's answer is done HERE
     now: a draft has no round trip until Save, and a field that showed 9999
     until then would be lying about what Save is going to store. `null` means
     "not a usable number" — the draft entry is dropped and the field goes back
     to the stored value, which is what the empty-patch round trip used to do. */
  $$("[data-num]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const path = inp.dataset.num;
      const v = coerceNumberSetting(path, inp.value);
      if (v == null) {
        clearDraft(path);
        inp.value = savedValue(path);
        clearSettingsError();
        paintSaveState();
        return;
      }
      inp.value = v;
      setDraft(path, v);
    })
  );
  /* ---------- vault key (SPEC §6) ---------- */
  $("#keyLockBtn").addEventListener("click", () => lockVault("manual"));
  $("#keyChangeBtn").addEventListener("click", changeVaultPassphrase);
  $("#keyGen").addEventListener("click", () => {
    const p = generatePassphrase();
    const nw = $("#keyNew");
    nw.value = p;
    $("#keyConfirm").value = p;
    /* UNMASK it. The field is `.masked` (`-webkit-text-security: disc`) and
       there is no reveal control anywhere in the panel, so "write it down NOW"
       was printed over a column of dots: a user who followed it literally, saw
       nothing and pressed Change had locked their vault with a string nothing
       can produce again (SPEC §6 — there is no recovery path by design). This
       is the one moment the passphrase is MEANT to be legible; typing anything
       into the field masks it again, and it leaves the DOM entirely on success
       or on leaving the page (`clearKeyFields`). */
    nw.classList.remove("masked");
    keyHint(
      "Generated · ~" +
        estimateBits(p) +
        " bits, shown above and selected. Write it down or copy it (⌘C) NOW — nothing here can show it to you again.",
      false
    );
    nw.focus();
    nw.select();
  });
  /* the generated value is legible only while it IS the generated value */
  $("#keyNew").addEventListener("input", () => $("#keyNew").classList.add("masked"));
  ["#keyCurrent", "#keyNew", "#keyConfirm"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      changeVaultPassphrase();
    })
  );
  /* ---------- terminal (SPEC §13) ---------- */
  $("#termUnlockBtn").addEventListener("click", terminalUnlock);
  $("#termPass").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    terminalUnlock();
  });
  $("#termLockBtn").addEventListener("click", () => terminalLock());
  $("#termPwBtn").addEventListener("click", terminalSavePassword);
  ["#termNew", "#termCurrent"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      terminalSavePassword();
    })
  );
  $("#termClearBtn").addEventListener("click", termClear);
  $("#termStopBtn").addEventListener("click", terminalStop);
  $("#termInput").addEventListener("keydown", (e) => {
    /* the terminal owns its own keys: ⌘K/⌘S/⌘E must not fire from a shell
       prompt, and Esc must close Settings exactly as it does everywhere else */
    if (e.key === "Escape") return;
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submitTerminal();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      terminalHistory(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      terminalHistory(-1);
    } else if ((e.key === "c" || e.key === "C") && e.ctrlKey) {
      /* Ctrl+C with a selection is COPY, everywhere, and taking that away from
         a pane full of text you want to copy would be its own bug. */
      if (String(window.getSelection() || "")) return;
      e.preventDefault();
      /* the same condition the Stop button uses — Ctrl+C is that button's
         keyboard twin, and an error line that says "cancel it first (Ctrl+C)"
         has to be telling the truth */
      if (termRunningId()) terminalStop();
      else $("#termInput").value = "";
    } else if ((e.key === "d" || e.key === "D") && e.ctrlKey) {
      e.preventDefault();
      if (!state.term.busy) return;
      termWrite("— EOF", "sys");
      api.terminalStdin("", true, state.term.running).catch(() => {});
    } else if ((e.key === "l" || e.key === "L") && e.ctrlKey) {
      e.preventDefault();
      termClear();
    }
  });
  /* THE TWO CREDENTIALS, and the only settings controls that still write
     immediately. They are write-only — the server serves a mask, so there is no
     "current value" to diff a draft against, and an unsaved secret parked in
     one is a secret held for no reason. See the note above `settingsDraft`. */
  bindInput("#gitToken", (v) => pushSettings({ git: { tokenMasked: v } }));
  bindInput("#aiKey", (v) => pushSettings({ ai: { apiKeyMasked: v } }));

  /* palette */
  $("#palInput").addEventListener("input", palInputChanged);
  $("#palInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      palMove(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      palMove(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      palOpen();
    } else if (e.key === "Escape") {
      if (!isOpen("#palVeil")) return;
      e.preventDefault();
      e.stopPropagation();
      closePal();
    } else if (e.key === "Tab") {
      e.preventDefault();
      palMove(e.shiftKey ? -1 : 1);
    }
  });

  /* composer */
  /* THE COMPOSER GROWS, like every other textarea in this app.
     `autoGrow` was wired to #rawArea and .secret-edit only, so the composer's
     `max-height: 110px` was unreachable text and the field was a fixed two-row
     box. Harmless while ⇧⏎ was the only way to make a newline; not harmless
     once bare ⏎ became one below W_SHEET and the hint beside Send started
     inviting a multi-line prompt. MEASURED at 390x844: a 12-line prompt left
     the textarea at 53.6px against a scrollHeight of 302px, with 208px of empty
     `.msgs` directly above it. */
  $("#composer").addEventListener("input", (e) => autoGrow(e.currentTarget));
  $("#composer").addEventListener("keydown", (e) => {
    e.stopPropagation();
    /**
     * ENTER SENDS — EXCEPT BELOW W_SHEET, WHERE IT MAKES A NEWLINE.
     *
     * A phone's on-screen keyboard has no Shift to hold, so `⇧⏎ newline` named
     * an escape hatch the device cannot produce: every Enter sent, and a
     * multi-line prompt was literally impossible to type. Below the sheet
     * breakpoint Enter is therefore an ordinary newline and the Send button
     * (44px there, and the hint beside it says so) is the only way to send.
     *
     * Gated on WIDTH and not on `pointer: coarse`, deliberately: an iPad with a
     * keyboard attached is coarse-pointered and would have had Enter-to-send
     * taken away from it for no reason. Width is the one axis this app has.
     */
    if (e.key === "Enter" && !e.shiftKey && !isSheet()) {
      e.preventDefault();
      sendMessage();
      return;
    }
    /**
     * Esc while typing costs the FOCUS, not the panel.
     *
     * The panel is dismissible with Esc like every other layer, but a message
     * being composed is the one place where taking the panel on the first press
     * would be hostile: the gesture that means "get out of this field" would
     * also close the surface the field is on. So the first Esc blurs — the
     * draft is on screen and the caret is out — and the second, now landing on
     * the document, closes the panel via dismissTop().
     *
     * Either way nothing is lost: closing the panel is a CSS collapse, so the
     * text is still in this textarea when the panel comes back.
     */
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.blur();
    }
  });

  /* sync chip: "Sync now" — commit + push immediately instead of waiting out
     the debounce. The server is single-flight, so a second click during a run
     just joins it. */
  /* the chip is a <span> in the statusbar markup and index.html is out of scope
     for this phase — one property is cheaper than a stylesheet fork */
  $("#stSync").style.cursor = "pointer";
  $("#stSync").addEventListener("click", () => {
    if (state.sync && state.sync.state === "syncing") {
      toast("Already syncing…");
      return;
    }
    syncNow();
  });

  /* connection dot: force a reconnect */
  $("#stConn").addEventListener("click", () => {
    toast("Reconnecting to /events…");
    connect();
  });

  const typing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  };

  /* Is there anything on screen that ⌘C would actually copy? A collapsed range
     is what you get from merely clicking into text, and `toString()` catches
     the case where a range spans only element boundaries and carries no text.
     Cheap enough to run on a keystroke, and it is the whole guard: get this
     wrong in the permissive direction and ⌘C stops copying. */
  const hasSelection = () => {
    const s = window.getSelection ? window.getSelection() : null;
    return !!s && !s.isCollapsed && String(s).length > 0;
  };

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (dismissTop()) e.preventDefault();
      return;
    }
    if (e.key === "Tab") return trapTab(e);
    /* ⇧F10 / the Menu key — the keyboard equivalent of the right-click, and the
       reason the menu is not a pointer-only affordance. Scoped to the sidebar:
       elsewhere both keys keep whatever the browser does with them. */
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      const here = document.activeElement;
      const row = here && here.closest ? here.closest("#sidebar .row[data-path]") : null;
      const inSidebar = here && here.closest && here.closest("#sidebar");
      if (!row && !inSidebar) return;
      e.preventDefault();
      openCtxFrom(row || $("#tree"));
      return;
    }
    if (mod && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P")) {
      if (e.key.toLowerCase() === "p" && e.shiftKey) return;
      e.preventDefault();
      openPal();
      return;
    }
    if (mod && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      /* ⌘S means "save what is in front of me". On the settings page that is
         the settings draft — there is no document there to save, and the
         topbar's Save button is hidden for exactly the same reason. */
      if (state.view === "settings") saveSettings();
      else saveDoc(state.active);
      return;
    }
    /* ⌘⇧E before ⌘E: with shift held, e.key is already "E", so the mode
       toggle would otherwise swallow the encrypt shortcut */
    if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      encryptSelection();
      return;
    }
    if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      if (vault.unlocked) lockVault("manual");
      else toast("The vault is already locked");
      return;
    }
    if (mod && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      setMode(state.mode === "raw" ? "preview" : "raw");
      return;
    }
    /* Settings answers to BOTH chords. ⌘/ is the conventional one and what the
       sidebar row now prints; ⌘, is the platform one and years of muscle memory
       — dropping it to "clean up" would be a regression with no upside. Both
       land on the same routed page (openSettings), not a modal. */
    if (mod && (e.key === "," || e.key === "/")) {
      e.preventDefault();
      openSettings();
      return;
    }
    /* ⌘C IS COPY. It reaches the chat toggle only when the copy it would
       shadow is provably a no-op: nothing selected anywhere on the page, and
       focus outside every text surface (raw editor, composer, palette, settings
       fields, the terminal line — `typing()` covers all of them by tag, and the
       terminal input additionally stops this listener from ever seeing its
       keys). In every other case we return WITHOUT preventDefault, so the
       browser's own copy runs untouched. Shift/Alt variants are left alone too:
       ⌘⇧C and ⌥⌘C belong to the browser.
       Note `mod` is `metaKey || ctrlKey`, which is deliberate — Ctrl+C is copy
       on Linux/Windows, so the same guard is exactly right there. The
       terminal's own Ctrl+C cancel lives on #termInput and stops propagation,
       and would be behind `typing()` regardless. */
    if (mod && (e.key === "c" || e.key === "C") && !e.shiftKey && !e.altKey) {
      if (typing() || hasSelection()) return;
      e.preventDefault();
      toggleChat();
      return;
    }
    if (mod && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      toggleChat();
      return;
    }
    if (mod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      /* One chord, one meaning — "show me the tree / put it away" — and two
         mechanisms, because below W_DOCK there is no sidebar COLUMN to collapse
         (base.css §11 makes it a drawer). Toggling `sidebar-collapsed` there
         changed a class nothing reads and the chord silently did nothing. */
      if (isDrawer()) app.classList.contains("nav-open") ? closeNav() : openNav();
      else app.classList.toggle("sidebar-collapsed");
      return;
    }
    if (mod && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      startCreate(e.shiftKey ? "folder" : "doc");
      return;
    }
    if (e.key === "?" && !typing() && !mod) {
      e.preventDefault();
      $("#scVeil").classList.add("show");
      return;
    }
  });

  window.addEventListener("resize", () => {
    /* W_DOCK, not W_SHEET: `nav-open` is meaningful for the whole drawer band.
       Dropping it at 768 stranded a tablet's open drawer as dead state — the
       CSS still had the sidebar off-canvas, and the class that brings it back
       had just been removed underneath it. */
    if (!isDrawer()) app.classList.remove("nav-open");
    syncScrim();
    const ta = $("#rawArea");
    if (ta) autoGrow(ta);
  });

  /* ---------- routing (see the ROUTING section) ----------
     A veil is opened from a dozen places — a data-act, a chord, a click-away,
     a passphrase prompt raised from inside the crypto worker. Watching the
     class the veils already carry catches every one of them without a single
     history call at any of those sites, and keeps Esc exactly as it was. */
  window.addEventListener("popstate", onPop);
  const veilObs = new MutationObserver(routeVeil);
  VEILS.forEach((sel) => veilObs.observe($(sel), { attributes: true, attributeFilter: ["class"] }));

  /* ---------- auto-lock inputs (research §5.2) ----------
     The worker owns the clocks; the main thread only reports what the worker
     cannot see. Activity is throttled to once a minute — this is a keepalive,
     not a telemetry stream. */
  let lastPing = 0;
  const ping = () => {
    if (!vault.unlocked) return;
    const now = Date.now();
    if (now - lastPing < 60000) return;
    lastPing = now;
    secretsCall("activity").catch(() => {});
  };
  document.addEventListener("keydown", ping, true);
  document.addEventListener("pointerdown", ping, true);
  document.addEventListener("visibilitychange", () => {
    /* BEFORE the worker gate below, deliberately. Flushing the buffer and
       healing the stream have nothing to do with the crypto worker, and putting
       them after `if (!vault.worker) return` made both dead code in every
       session where the vault was never touched — which is most of them. */
    if (document.visibilityState === "hidden") flushBuffer({ leaving: true });
    else healAfterGap();
    if (!vault.worker) return;
    secretsCall("visibility", { hidden: document.visibilityState === "hidden" }).catch(() => {});
  });

  /* Coming back from a dead network is the same event as coming back from a
     background tab: whatever the stream carried while we were away is gone. */
  window.addEventListener("online", healAfterGap);

  /* A sticky notice is the only toast that can be clicked (base.css keeps the
     rest click-through), and clicking it is how it goes away. */
  $("#toast").addEventListener("click", clearStickyToast);

  /* The settings draft lives in memory, so a reload or a closed tab is the one
     way it can be lost. `exitSettings` keeps it across every in-app exit and
     says so; this is the same promise kept at the one boundary the app does not
     own. Deliberately NOT extended to the document buffer: that one is flushed
     with `keepalive` below, so it survives rather than needing a warning. */
  window.addEventListener("beforeunload", (e) => {
    /* same reason as in `saveSettings`: a reload with the caret still in a
       numeric field must not be the one exit that calls the page clean */
    commitFocusedNumber();
    if (!settingsDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  window.addEventListener("pagehide", () => {
    flushBuffer({ leaving: true });
    /* the key dies with the page either way; asking explicitly also tells
       every other tab to lock (research §5.2) */
    lockVault("pagehide");
    /* Same courtesy for the terminal: the bearer dies with the page regardless
       (it was never persisted), but telling the server means the session is
       gone there too rather than sitting out its idle timeout. */
    api.terminalLock().catch(() => {});
  });
}

/* ============================================================
   BOOT
   ============================================================ */
export async function start() {
  wireDialogs({ refreshTree: loadTree, renderDoc, saveDoc, setBaseline, setSaveIndicator, app, openFirstDoc });
  /* settings first: they decide the theme, and a wrong theme flashing is worse
     than 40ms of a blank shell */
  const s = await api.getSettings();
  state.settings = s.settings;
  state.meta = s.meta;
  paintSettings();

  const q = new URLSearchParams(location.search);
  const urlTheme = q.get("theme");
  const themeOk = urlTheme && s.meta.themes.some((t) => t.id === urlTheme);
  applyTheme(themeOk ? urlTheme : state.settings.theme, { cache: !themeOk });
  applyDensity(state.settings.density);
  /* ?scheme= is the twin of ?theme=: a look-at-it override for this page load
     only, validated against meta (never a hard-coded list here) and never
     persisted. Neither one writes settings, so a screenshot pass over
     3 themes × 2 schemes leaves the vault exactly as it found it. */
  const urlScheme = q.get("scheme");
  const schemeOk = urlScheme && s.meta.colorSchemes.includes(urlScheme);
  applyColorScheme(schemeOk ? urlScheme : state.settings.colorScheme, { cache: !schemeOk });
  if (urlTheme && !themeOk) console.warn("[z-notes] unknown ?theme=" + urlTheme);
  if (urlScheme && !schemeOk) console.warn("[z-notes] unknown ?scheme=" + urlScheme);
  /* remember the pin, so a settings-changed from another device cannot stamp
     the stored value over an axis THIS URL asked for (see `urlPinnedLook`) */
  pinLookFromUrl([themeOk ? "theme" : null, schemeOk ? "colorScheme" : null].filter(Boolean));

  const [, , sync] = await Promise.all([loadTree(), loadSession(), api.getSyncStatus(), loadProposals()]);
  paintSync(sync);

  /* A deep link or a reload names the doc to open; the tree we just loaded is
     what says whether it still exists, so an unknown or deleted path costs one
     toast and falls back instead of booting into an empty shell.

     never state.tree[0]: the tree lists folders before root-level files, so in
     a vault where every doc is empty that would hand openDoc a FOLDER path */
  const wanted = urlDoc();
  /* read BEFORE openDoc: it replaces the address bar with the doc's URL, so
     asking `location` afterwards asks about a URL this boot just wrote */
  const wantSettings = urlSettings();
  const first =
    (wanted && state.docPaths.has(wanted) && wanted) ||
    findDoc(state.tree, (n) => !n.empty) ||
    findDoc(state.tree, () => true);
  wire();
  syncModeUI();
  seedHistory();
  /* replace: the entry the browser gave us IS this doc's entry — pushing would
     leave a bare-shell entry underneath that Back could fall into */
  await openDoc(first, { replace: true });
  if (wanted && wanted !== first) toast("No such doc: " + wanted);
  /* A deep link (or a reload) straight to `/settings`. The doc opens FIRST and
     stays open behind the page, so Back and every tree click have somewhere
     real to go — the pane is never a settings page with nothing under it.
     `replace` for the same reason openDoc replaces: the entry the browser
     handed us is this page's entry, and one address must not become two. */
  if (wantSettings) showSettings(wantSettings.section, { replace: true });
  renderChat();

  /* the remembered assistant state, and the width rules that override it */
  initChatOpen();
  wireVisualViewport();
  connect();

  /* The terminal's real state, off the critical path for the same reason the
     secrets probe is: a terminal that is disabled, locked or unreachable
     changes nothing about editing notes. A fresh page load is always LOCKED —
     the token was never persisted — so this is a read of capability, not of a
     session we might still have. */
  termClear();
  refreshTerminalStatus();

  /* The trash, on the same terms: the sidebar block stays unmounted until this
     answers, and what it answers with is also what the DELETE DIALOG is allowed
     to promise (askDelete reads `state.trash.available`). Off the critical path
     because a vault with no trash route edits exactly the same. */
  refreshTrash();

  /* Secrets probe last and off the critical path: whether it succeeds or is
     disabled, everything above already works (SPEC §6 degradation). */
  initSecrets().then(() => {
    paintVaultChip();
    repaintSecretsUI();
  });
}

/** First leaf `ok` accepts, folders descended into — never a folder path. One
    traversal rule, so the two preferences below cannot drift out of step. */
export function findDoc(nodes, ok) {
  for (const n of nodes) {
    const hit = n.type === "folder" ? findDoc(n.children, ok) : ok(n) ? n.path : null;
    if (hit) return hit;
  }
  return null;
}
