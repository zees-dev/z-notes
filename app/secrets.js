/* ============================================================
   secrets.js — the client half of secrets: reveal/lock, vault keyring.

   Split from the original single-file app.js along its own section markers;
   behaviour is unchanged. See that file's history for each section's full
   design rationale.
   ============================================================ */
"use strict";

import * as api from "./api.js";
/* NO entropy import here any more. This file used to enforce `MIN_BITS` in two
   places; both gates are gone (see `createIdentity`), and nothing here grades a
   passphrase. `generatePassphrase` is app.js's, beside the Generate buttons. */
import { dedentArmor, indentArmor, isArmorShape } from "./armor.js";
import { state } from "./state.js";
import { $, $$, I, activeDoc, el, esc, toast } from "./ui.js";
import { autoGrow, markDirty, saveDoc, syncModeUI, syncRawFromModel, updateMeta, viewedPath } from "./editor.js";
import { settingAt } from "./settings.js";

/* ============================================================
   SECRETS — the client half; the server never sees a passphrase or plaintext

   Everything cryptographic happens in ./crypto-worker.js. This file owns the
   UI and the document model and holds NO key material: it can ask the worker
   to decrypt one block, to encrypt one string, or to lock — and nothing else.

   `vault.state`:
     unknown  — not probed yet
     disabled — no secure context / no WebCrypto / worker or bundle failed;
                blocks render armored with a badge that explains why, and the
                rest of the app is untouched
     none     — supported, but this vault has no identity yet
     repair   — .znotes/identity.age exists but .znotes/vault.pub does not.
                Unlocking derives the recipient and rewrites the missing file;
                WITHOUT this state the vault is permanently wedged, because
                "create" 409s on the existing identity and nothing else opens
                the unlock modal
     orphan   — the MIRROR of `repair`, and the one vault.ts calls
                "unrecoverable data-loss-by-encryption": .znotes/vault.pub is
                readable but .znotes/identity.age is gone (a crash inside
                `writeVaultKeys`'s replace window, a partial checkout, a tidied
                `.znotes/`). Nothing in the app can open a block here, and the
                state has to SAY so: reported as "ready" it printed the name of
                a file that is not on disk, then answered Unlock with "no
                identity yet" and Create with `409 exists` — two contradictory
                refusals and no way out. The stashed key, if a change was
                interrupted, is `.znotes/identity.age.prev`
     ready    — identity exists (locked or unlocked)
   ============================================================ */
export const vault = {
  state: "unknown",
  /* which flavour the passphrase modal is showing: "unlock" | "create" | "change" */
  ppMode: "unlock",
  reason: "",
  recipient: null,
  /* the recipient the worker DERIVED from identity.age this session, or null.
     Only this one is known to pair with the vault's identity. */
  verified: null,
  /* latched the moment `.znotes/vault.pub` changes under a running session:
     both keyring files are tracked and pushed, so a pull — or anyone with
     write access to the remote — can move the recipient. Blocks new
     encryption until an unlock proves the new key pairs with identity.age. */
  keyringChanged: false,
  pendingRecipient: null,
  unlocked: false,
  worker: null,
  seq: 0,
  waits: new Map(),
  boot: null,
};

function disableSecrets(reason) {
  vault.state = "disabled";
  vault.reason = reason;
  if (vault.worker) {
    try {
      vault.worker.terminate();
    } catch (e) {}
    vault.worker = null;
  }
  console.warn("[z-notes] secrets disabled:", reason);
  /* the toolbar's encrypt affordance is part of "disabled" too — a live button
     that can only produce an error toast is the dead-button failure mode the
     block rendering was carefully built to avoid */
  syncModeUI();
  return vault;
}

/* ---------- [secrets] → the worker's auto-lock policy ----------
   The worker owns the timers; the server owns the numbers. This is the one
   translation between them, in ONE place so the units cannot drift. Applied at
   init and again on every settings save — an unlocked session picks a shorter
   idle timeout up on the next tick, without a reload. */
function lockPolicy() {
  return {
    idleMs: settingAt("secrets.idleLockMinutes") * 60 * 1000,
    hiddenMs: settingAt("secrets.hiddenLockMinutes") * 60 * 1000,
    hardCapMs: settingAt("secrets.sessionHours") * 60 * 60 * 1000,
  };
}

/** Seconds a copied secret may sit on the clipboard (`secrets.clipboardClearSeconds`). */
function clipboardSeconds() {
  return settingAt("secrets.clipboardClearSeconds");
}

/** Push the current policy at a worker that may not exist yet — never throws. */
export function applyLockPolicy() {
  if (!vault.worker) return Promise.resolve(null);
  return secretsCall("configure", { policy: lockPolicy() }).catch(() => null);
}

export function secretsCall(op, args) {
  return new Promise((resolve, reject) => {
    if (!vault.worker) return reject(new Error(vault.reason || "Secrets features are unavailable."));
    const id = ++vault.seq;
    /* scrypt at logN=18 is ~1s; 60s is "the worker is wedged", not "slow" */
    const t = setTimeout(() => {
      vault.waits.delete(id);
      reject(new Error("The crypto worker did not answer."));
    }, 60000);
    vault.waits.set(id, { resolve, reject, t });
    vault.worker.postMessage(Object.assign({ id, op }, args || {}));
  });
}

function settleWorker(id, ok, payload) {
  const w = vault.waits.get(id);
  if (!w) return;
  vault.waits.delete(id);
  clearTimeout(w.t);
  if (ok) w.resolve(payload);
  else {
    const e = new Error((payload && payload.message) || "Crypto worker error");
    e.code = payload && payload.code;
    w.reject(e);
  }
}

/* Written from the CURRENT `[secrets]` policy, not from a constant: a toast
   that says "idle for 15 minutes" to someone who configured two is a lie about
   the one part of the app whose whole job is being trustworthy. */
const plural = (n, unit) => n + " " + unit + (n === 1 ? "" : "s");

function lockReason(reason) {
  return {
    idle: "idle for " + plural(settingAt("secrets.idleLockMinutes"), "minute"),
    hidden: "tab hidden for " + plural(settingAt("secrets.hiddenLockMinutes"), "minute"),
    "session-expired": plural(settingAt("secrets.sessionHours"), "hour") + " session limit",
    "other-tab": "locked in another tab",
    manual: "",
    pagehide: "",
    cancelled: "unlock cancelled",
  }[reason];
}

/** Feature-detect once, boot the worker once. Never throws. */
export function initSecrets() {
  if (vault.boot) return vault.boot;
  vault.boot = (async () => {
    if (!window.isSecureContext)
      return disableSecrets(
        "This page is not a secure context, so the browser withholds WebCrypto. Serve z-notes over HTTPS (or localhost) to unlock secret blocks."
      );
    if (!(window.crypto && window.crypto.subtle))
      return disableSecrets("crypto.subtle is unavailable in this browser, so nothing can be decrypted here.");
    if (typeof Worker === "undefined")
      return disableSecrets("Web Workers are unavailable, and all z-notes crypto runs inside one.");

    let identityPresent = false;
    try {
      /* BOTH files, always. Either one missing is a real state with its own
         recovery, and neither can be inferred from the other: a missing
         vault.pub does not mean "no vault" (writeVaultKeys documents a window
         where identity.age lands first), and a readable vault.pub does not
         mean the identity is there — asking only when the recipient was
         missing is what let the keyring line name a file nobody had looked
         for. Two GETs at boot, off the critical path either way. */
      const [r, id] = await Promise.all([api.getVaultRecipient(), api.getVaultIdentity()]);
      vault.recipient = r && r.recipient ? r.recipient : null;
      identityPresent = !!id;
    } catch (err) {
      return disableSecrets("The vault keyring could not be read: " + (err.message || err));
    }

    try {
      vault.worker = new Worker(new URL("./crypto-worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      return disableSecrets("The crypto worker could not start: " + (err.message || err));
    }
    vault.worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "event") return onWorkerEvent(m);
      settleWorker(m.id, !!m.ok, m.ok ? m.result : m.error);
    };
    vault.worker.onerror = (ev) => {
      const why = (ev && ev.message) || "the worker script failed to load";
      for (const id of [...vault.waits.keys()]) settleWorker(id, false, { code: "worker-error", message: why });
      disableSecrets("The crypto worker failed: " + why);
      repaintSecretsUI();
    };

    try {
      await secretsCall("init", { recipient: vault.recipient, policy: lockPolicy() });
    } catch (err) {
      return disableSecrets("The age bundle could not be loaded: " + (err.message || err));
    }

    vault.state = identityPresent
      ? vault.recipient
        ? "ready"
        : "repair"
      : vault.recipient
        ? "orphan"
        : "none";
    return vault;
  })();
  return vault.boot;
}

function onWorkerEvent(m) {
  if (m.event === "unlocked") {
    vault.unlocked = true;
    /* the worker only emits this after deriving the recipient from the
       unwrapped identity, so `m.recipient` is a VERIFIED one */
    if (m.verified && m.recipient) vault.verified = m.recipient;
    paintVaultChip();
    /* THE reveal trigger. Whichever door the passphrase came through — a
       block's Unlock, the topbar, Settings › Secrets, a first-run create —
       ends here, so every one of them reveals the whole document. */
    repaintSecretsUI();
  } else if (m.event === "locked") {
    onVaultLocked(m.reason || "manual");
  }
}

/** The vault locked (idle, hidden, another tab, or on purpose). Re-encrypt
    anything edited, then drop every plaintext this tab holds. */
async function onVaultLocked(reason) {
  vault.unlocked = false;
  /* Before the awaits below, not after: a decrypt already with the worker must
     not land plaintext back into a locked vault while this function is off
     re-encrypting an edit. */
  dropRevealsInFlight();
  /* Locking must CLEAR the clipboard, not merely cancel the timer that would
     have cleared it: "copy the secret, paste it, re-lock" is the most natural
     flow there is, and cancelling the clear left the plaintext on the system
     clipboard forever (research §6, "Clipboard"). */
  clearClipboardNow();
  /* THE WIPE COMES FIRST. Re-encrypting an edit is a round trip to
     the worker and then a PUT with no deadline of its own, and locking used to
     await both BEFORE clearing the screen: a wedged or suspended server left
     the decrypted plaintext sitting in an open editor indefinitely — measured
     unchanged 30s after an idle lock — which is the exact moment the screen is
     unattended. The dirty entries are snapshotted, the display goes blank
     synchronously, and the ciphertext is written from the snapshot afterwards. */
  const pending = new Map();
  for (const e of state.reveal.values()) {
    if (!e.dirty) continue;
    if (!pending.has(e.path)) pending.set(e.path, []);
    pending.get(e.path).push(e);
  }
  state.reveal.clear();
  paintVaultChip();
  repaintSecretsUI();
  const why = lockReason(reason);
  toast(why ? "Vault locked — " + why : "Vault locked");
  for (const [p, ents] of pending) {
    try {
      await flushSecretEdits(state.docs.get(p), ents);
      await saveDoc(p, { silent: true });
    } catch (e) {}
  }
}

export function repaintSecretsUI() {
  if (state.mode !== "preview") return;
  $$("#doc .secret").forEach((w) => {
    if (w.zSecret) repaintSecret(w);
  });
}

export async function lockVault(reason) {
  if (!vault.worker) return;
  try {
    await secretsCall("lock", { reason: reason || "manual" });
  } catch (e) {}
}

/* The one sentence every entry point into secrets says about `orphan`, so the
   keyring line, the unlock modal, the passphrase change and the encrypt
   gesture cannot drift into contradicting each other — which is precisely what
   this state used to do. */
const ORPHAN_WHY =
  ".znotes/identity.age is missing, so nothing here can open — or safely create — a block in this vault. " +
  "Restore it from .znotes/identity.age.prev (an interrupted passphrase change stashes the old key there), " +
  "from a backup, or from git history.";

/** Ensure the worker holds the identity, prompting for the passphrase if not.
    Resolves true when a subsequent `decrypt` can succeed. */
function ensureUnlocked() {
  return new Promise(async (resolve) => {
    await initSecrets();
    if (vault.state === "disabled") {
      toast(vault.reason);
      return resolve(false);
    }
    if (vault.state === "none") {
      askCreate();
      return resolve(false);
    }
    /* the mirror of "repair": there is no identity to unwrap, and `create`
       would 409 on the recipient that IS there — so neither modal is offered */
    if (vault.state === "orphan") {
      toast(ORPHAN_WHY);
      return resolve(false);
    }
    /* "repair" has an identity — the passphrase is the way in, not a new key */
    if (vault.unlocked) return resolve(true);
    askPass(resolve);
  });
}

export function paintVaultChip() {
  const chip = $("#stVault");
  if (chip) chip.hidden = !vault.unlocked;
  paintVaultKey();
}

/* ============================================================
   VAULT KEY — Settings › Secrets (research §5.3)

   Two things live here and nothing else: the truth about this vault's keyring,
   and the ONE key operation that is safe to run from a settings panel.

   CHANGE PASSPHRASE re-wraps the SAME age identity under a new passphrase. The
   key does not change, `vault.pub` does not change, and no block in the corpus
   is touched — which is precisely what makes it routine. The other operation
   research §5.3 names, ROTATE VAULT KEY, is a corpus-wide decrypt-and-re-encrypt
   pass and is deliberately NOT offered: a half-finished rotation is a vault
   whose blocks are encrypted to two different keys, and a settings button is
   the wrong shape for something that must either complete or roll back.

   Nothing in this flow gives the server a passphrase. `rewrap` runs in the
   crypto worker, the plaintext identity never leaves it, and what goes over the
   wire is the same thing that was already on disk: passphrase-wrapped armor.
   ============================================================ */

/** The keyring status line + the state of the change-passphrase control. */
export function paintVaultKey() {
  const line = $("#keyState");
  const txt = $("#keyStateTxt");
  if (!line || !txt) return;

  const st = vault.state;
  const usable = st === "ready" || st === "repair";
  line.classList.toggle("off", st === "disabled" || st === "none" || st === "orphan");
  line.classList.toggle("locked", usable && !vault.unlocked);
  line.classList.toggle("unlocked", usable && vault.unlocked);

  const who = vault.recipient ? " · " + vault.recipient : "";
  txt.textContent =
    st === "disabled"
      ? "Secrets are unavailable here — " + (vault.reason || "no secure context.")
      : st === "none"
      ? "No vault key yet. Encrypt a selection (⌃⇧E) to create one."
      : st === "repair"
      ? ".znotes/identity.age is present but .znotes/vault.pub is missing — unlock once to rebuild it."
      : st === "orphan"
      ? ".znotes/vault.pub is present but .znotes/identity.age is MISSING — nothing here can open a block. " +
        "If a passphrase change was interrupted, the key is still in .znotes/identity.age.prev: rename it back to " +
        ".znotes/identity.age. Otherwise restore identity.age from a backup or from git history." +
        who
      : (vault.unlocked ? "Unlocked" : "Locked") +
        " · .znotes/identity.age + .znotes/vault.pub" +
        who +
        (vault.verified && vault.verified === vault.recipient ? " · verified this session" : "");

  const lockBtn = $("#keyLockBtn");
  if (lockBtn) lockBtn.hidden = !vault.unlocked;
  /* the change control needs an identity to re-wrap; there is nothing to
     change before one exists, and nothing to change if crypto is unavailable */
  const on = usable;
  ["keyCurrent", "keyNew", "keyConfirm", "keyGen", "keyChangeBtn"].forEach((id) => {
    const n = $("#" + id);
    if (n) n.disabled = !on;
  });
}

/* The markup ships the default; this is where it is remembered, captured on
   first use and before anything has overwritten it. Copying the sentence into
   this file gave the same user-facing string two homes with nothing checking
   they agreed — which the sibling `#termPwHint` proves is not hypothetical:
   its HTML and JS copies have already drifted. */
let keyHintDefault = null;

export function keyHint(text, bad) {
  const n = $("#keyPassHint");
  if (!n) return;
  if (keyHintDefault === null) keyHintDefault = n.innerHTML;
  if (!text) {
    n.innerHTML = keyHintDefault;
    n.classList.remove("bad");
    return;
  }
  n.textContent = text;
  n.classList.toggle("bad", !!bad);
}

/**
 * Change the vault passphrase.
 *
 * Current → unwrap in the worker → re-wrap the same identity under the new one
 * → `PUT /api/vault/identity {replace:true}`. The recipient written back is the
 * one the worker DERIVED from the identity it just unwrapped, never the one the
 * client happened to be holding — so a `vault.pub` that had drifted cannot be
 * laundered into the keyring by a passphrase change.
 */
/** The three passphrase fields, emptied. The settings page is a CSS route
    change and is never unmounted, so anything left in an input lives for the
    rest of the session and is one `getElementById().value` away from anything
    with script access — the same rule `closePP` states for the modal: the
    passphrase leaves the DOM the moment the thing that asked for it does. */
export function clearKeyFields() {
  clearSecretInputs(["keyCurrent", "keyNew", "keyConfirm"]);
}

/** The terminal's three secret inputs — the new password, the current one it is
    replacing, and the unlock field. Same rule and the same reason as the
    passphrase fields above: `setDraft` deliberately excludes the terminal
    password from the draft because "an unsaved secret held longer than it needs
    to be" is a cost, and a page that is never unmounted was holding it for the
    whole tab. They used to be blanked only by a SUCCESSFUL submit, so an
    abandoned password outlived leaving Settings — and was silently resubmitted
    if the user came back and pressed Change. */
export function clearTerminalSecretFields() {
  clearSecretInputs(["termNew", "termCurrent", "termPass"]);
}

function clearSecretInputs(ids) {
  ids.forEach((id) => {
    const n = $("#" + id);
    if (!n) return;
    n.value = "";
    /* a generated passphrase is shown in the clear (see the #keyGen handler);
       an empty field goes straight back to being a credential field */
    n.classList.add("masked");
  });
}

export async function changeVaultPassphrase() {
  const cur = $("#keyCurrent").value;
  const next = $("#keyNew").value;
  const confirm = $("#keyConfirm").value;
  /* every early return below leaves the fields alone ON PURPOSE: the user is
     being asked to correct what they typed, so it has to still be there. What
     must not survive is a FINISHED attempt, which is what the `finally` does. */
  if (!cur) return keyHint("Enter the current passphrase — it is what unwraps the identity.", true);
  if (!next) return keyHint("Enter the new passphrase.", true);
  if (next !== confirm) return keyHint("The two new passphrases do not match.", true);
  if (next === cur) return keyHint("That is the passphrase you already have.", true);
  /* No entropy FLOOR — see `createIdentity` for the whole reasoning. The
     estimate is still measured and still printed; it just no longer refuses. */

  const btn = $("#keyChangeBtn");
  btn.disabled = true;
  keyHint("Unwrapping and re-wrapping the identity (scrypt, ~2s)…", false);
  try {
    await initSecrets();
    const armor = await api.getVaultIdentity();
    if (!armor) {
      vault.state = vault.recipient ? "orphan" : "none";
      paintVaultKey();
      return keyHint(vault.recipient ? ORPHAN_WHY : "This vault has no identity to re-wrap.", true);
    }
    const made = await secretsCall("rewrap", { identity: armor, current: cur, next: next });
    await api.putVaultIdentity(made.identity, made.recipient, true);
    vault.recipient = made.recipient;
    vault.verified = made.recipient;
    vault.state = "ready";
    paintVaultKey();
    keyHint("");
    toast("Vault passphrase changed · the key is unchanged, so every block still decrypts");
  } catch (err) {
    keyHint(err.message || "The passphrase could not be changed", true);
  } finally {
    /* success, refusal or crash: the attempt is over, so the passphrases go.
       Only the success path used to clear them, which left a wrong passphrase
       — and the new one beside it — readable in the DOM until the tab reloaded. */
    clearKeyFields();
    btn.disabled = false;
    paintVaultKey();
  }
}

/* ---------- passphrase modal (the prototype's #ppVeil, both modes) ---------- */

let ppResolve = null;
/* Bumped every time the modal opens or closes. scrypt at logN=18 runs for ~1s
   AFTER the user can press Esc, and a dismissed modal whose security-relevant
   action completes anyway is not a dismissal — it is a delayed unlock nobody
   asked for. `doPassphraseOk` compares this across the await. */
let ppEpoch = 0;

function ppSettle(v) {
  const fn = ppResolve;
  ppResolve = null;
  if (fn) fn(v);
}

export function closePP() {
  ppEpoch++;
  $("#ppVeil").classList.remove("show");
  /* the passphrase leaves the DOM the moment the modal does */
  $("#ppInput").value = "";
  $("#ppConfirm").value = "";
  ppSettle(false);
}

function openPP(mode) {
  ppEpoch++;
  vault.ppMode = mode;
  const create = mode === "create";
  $("#ppTitle").textContent = create ? "Create vault identity" : "Unlock secret block";
  $("#ppPath").textContent = create ? ".znotes/identity.age" : vault.recipient || "age identity";
  $("#ppSub").textContent = create
    ? "a new age key pair, wrapped under this passphrase"
    : "unwraps .znotes/identity.age · scrypt";
  $("#ppInput").value = "";
  $("#ppConfirm").value = "";
  $("#ppConfirmRow").hidden = !create;
  $("#ppGen").hidden = !create;
  $("#ppOkTxt").textContent = create ? "Create" : "Unlock";
  $("#ppHint").textContent = create
    ? "Generate one, or type your own. There is no recovery: lose it and the blocks stay encrypted forever."
    : "Decrypted in the crypto worker; never sent to the server.";
  $("#ppHint").className = "note";
  $("#ppVeil").classList.add("show");
  setTimeout(() => $("#ppInput").focus(), 120);
}

function askPass(resolve) {
  ppSettle(false);
  ppResolve = resolve || null;
  openPP("unlock");
}

function askCreate() {
  ppSettle(false);
  openPP("create");
}

/* estimateBits / WORDS / generatePassphrase live in ./entropy.js — the
   generator is security-critical and needs its own unit tests. */

export async function doPassphraseOk() {
  const pass = $("#ppInput").value;
  if (vault.ppMode === "create") return createIdentity(pass, $("#ppConfirm").value);
  if (!pass) {
    ppHint("Enter the vault passphrase.", true);
    return;
  }
  const btn = $("#ppOk");
  btn.disabled = true;
  const epoch = ppEpoch;
  ppHint("Deriving the key (scrypt, ~1s)…", false);
  try {
    const armor = await api.getVaultIdentity();
    if (!armor) {
      /* "no identity yet" is only true when there is no keyring at all. With a
         recipient still on disk this is `orphan`, and saying "yet" sent the
         user to a Create that the server 409s. */
      vault.state = vault.recipient ? "orphan" : "none";
      paintVaultKey();
      ppHint(vault.recipient ? ORPHAN_WHY : "This vault has no identity yet.", true);
      return;
    }
    if (vault.keyringChanged && vault.pendingRecipient) {
      /* a legitimate rotation pulls a NEW identity.age beside the new
         vault.pub, so verify the fetched identity against the CLAIMED
         recipient. The worker refuses this outright if it already verified a
         different one — a substitution mid-session is not a rotation. */
      try {
        await secretsCall("setRecipient", { recipient: vault.pendingRecipient });
      } catch (e) {
        ppHint(e.message || "The vault recipient changed — reload before unlocking.", true);
        return;
      }
    }
    const st = await secretsCall("unlock", { identity: armor, passphrase: pass });
    /* Esc (or any other dismissal) during the derive means CANCELLED. The
       worker now holds the key, so undoing it takes an explicit lock — merely
       skipping the UI update would leave a silently unlocked vault. */
    if (epoch !== ppEpoch) {
      await lockVault("cancelled");
      return;
    }
    $("#ppVeil").classList.remove("show");
    $("#ppInput").value = "";
    vault.unlocked = true;
    if (st && st.recipient && st.verified) {
      vault.verified = st.recipient;
      /* the unwrapped identity DERIVED this recipient, so the file that
         claimed it is confirmed and encryption may resume */
      if (vault.keyringChanged && st.recipient === vault.pendingRecipient) {
        vault.recipient = st.recipient;
        vault.keyringChanged = false;
        vault.pendingRecipient = null;
        toast("Keyring confirmed: .znotes/vault.pub matches this vault's identity");
      }
    }
    /* "repair": identity.age was there, vault.pub was not. The worker derived
       the real recipient from the identity it just unwrapped — write it back
       so the vault stops being a dead end (and so encrypt works again). */
    if (st && st.recipient && !vault.recipient) await repairRecipient(armor, st.recipient);
    paintVaultChip();
    /* the blocks are NOT repainted here: the worker's `unlocked` event already
       did it (onWorkerEvent), and that is the one trigger every unlock door
       shares. A second one here would be a second reveal path. */
    toast("Vault unlocked");
    ppSettle(true);
  } catch (err) {
    ppHint(err.message || "Unlock failed", true);
    $("#ppInput").select();
  } finally {
    btn.disabled = false;
  }
}

export function ppHint(text, bad) {
  const n = $("#ppHint");
  n.textContent = text;
  n.className = bad ? "note bad" : "note";
}

/**
 * Rewrite a missing `.znotes/vault.pub` from the recipient the worker derived
 * out of the identity it just unwrapped. `replace:true` is safe here and only
 * here: the identity we are re-declaring is byte-for-byte the one already on
 * disk, and the recipient is derived from it rather than taken on trust.
 */
async function repairRecipient(identityArmor, recipient) {
  try {
    await api.putVaultIdentity(identityArmor.trim(), recipient, true);
    vault.recipient = recipient;
    vault.state = "ready";
    toast("Rebuilt .znotes/vault.pub from the vault identity");
  } catch (err) {
    toast("The vault recipient could not be rebuilt: " + (err.message || err));
  }
}

/**
 * THE ENTROPY FLOOR IS GONE, AND SO IS THE GRADE.
 *
 * It used to refuse anything under `MIN_BITS`, here and in
 * `changeVaultPassphrase`. Both refusals are gone, and so is the live readout
 * that replaced them: a meter that grades every keystroke and settles on "weak"
 * states a requirement whether or not it enforces one. The only things this app
 * blocks on are an EMPTY passphrase (there is nothing to wrap the identity
 * with) and a mismatched confirmation (the user cannot have meant both).
 *
 * The arithmetic behind the old floor has NOT changed, which is why this is a
 * product decision and not a security claim: `.znotes/identity.age` is
 * COMMITTED and, per research §7.3, assumed readable by the adversary, so what
 * protects it is exactly scrypt(2^18) × the entropy of this string. A weak
 * passphrase is a weak vault. Generate is one click away and still produces the
 * strong answer; the choice is simply the vault owner's to make, which is the
 * same rule the rest of this app follows about destructive-but-deliberate acts.
 * `entropy.js` keeps the estimator and its unit tests either way.
 *
 * (ADR 0006 records this: the passphrase floor is advice, not a gate.)
 */
async function createIdentity(pass, confirm) {
  if (!pass) {
    ppHint("Enter a passphrase, or press Generate.", true);
    return;
  }
  if (pass !== confirm) {
    ppHint("The two passphrases do not match.", true);
    return;
  }
  const btn = $("#ppOk");
  btn.disabled = true;
  ppHint("Generating the key and wrapping it (scrypt, ~1s)…", false);
  try {
    const made = await secretsCall("generate", { passphrase: pass });
    await api.putVaultIdentity(made.identity, made.recipient, false);
    vault.recipient = made.recipient;
    vault.verified = made.recipient; // derived from the identity we just made
    vault.state = "ready";
    await secretsCall("setRecipient", { recipient: made.recipient });
    $("#ppVeil").classList.remove("show");
    $("#ppInput").value = "";
    $("#ppConfirm").value = "";
    repaintSecretsUI();
    toast("Vault identity created · " + made.recipient.slice(0, 16) + "…");
  } catch (err) {
    ppHint(
      err.code === "exists"
        ? "This vault already has an identity — unlock it with its passphrase instead of creating a new one."
        : err.message || "Could not create the identity",
      true
    );
  } finally {
    btn.disabled = false;
  }
}

/* ---------- re-encryption (the only path that rewrites armor) ---------- */

/* indentArmor / dedentArmor / isArmorShape live in ./armor.js — the write path
   and the read path have to agree byte for byte about what a fence body is. */

/** Where the `ord`-th copy of `armor` starts in `md`, or -1. The armor is ~200
    bytes of ciphertext, so a content match is a stronger identifier than a line
    number — which drifts the moment anything above the block changes — but it
    is NOT a unique one: copy a fence to make a staging/prod pair and the
    document holds the same bytes twice. The ordinal is the rest of the
    identity (see `revealKey`). */
function armorOffset(md, armor, ord) {
  let at = md.indexOf(armor);
  for (let n = ord || 0; n > 0 && at >= 0; n--) at = md.indexOf(armor, at + armor.length);
  return at;
}

/** Swap ONE block's armor inside the markdown: the `ord`-th copy, not simply
    the first one `indexOf` lands on. Matching on content alone rewrote the
    wrong fence whenever a document held the same ciphertext twice — the edit
    landed on the other block and that block's own content was destroyed, both
    silently, under a "Saved to disk" toast.
    @returns the offset the swap happened at, or -1 if the block is gone. */
function replaceArmorInDoc(doc, oldArmor, newArmor, ord) {
  const at = armorOffset(doc.markdown, oldArmor, ord);
  if (at < 0) return -1;
  doc.markdown = doc.markdown.slice(0, at) + newArmor + doc.markdown.slice(at + oldArmor.length);
  return at;
}

/** Rebuild this path's reveal keys from the entries themselves. An armor swap
    moves a block's identity (new armor, and the copies after it move up one
    place), and `state.reveal` is keyed by that identity. */
function rekeyReveals(path) {
  const ents = [];
  for (const [k, e] of state.reveal) {
    if (e.path !== path) continue;
    ents.push(e);
    state.reveal.delete(k);
  }
  for (const e of ents) state.reveal.set(revealKey(path, e.armor, e.ord), e);
}

/**
 * Turn every EDITED revealed block back into armor, in the document model,
 * before anything can serialize it. Unedited reveals are not touched: their
 * armor goes out byte for byte (research §4.2).
 *
 * `entries` is the lock path's snapshot: locking wipes `state.reveal` FIRST
 * (the screen must go blank before the network) and hands the dirty
 * entries here afterwards. Entries that are no longer in the map are flushed
 * into the document and into the live nodes, but never put back into it — a
 * locked vault holds no plaintext.
 */
export async function flushSecretEdits(doc, entries) {
  if (!doc) return;
  const dirty = [];
  if (entries) {
    for (const e of entries) if (e && e.dirty && e.path === doc.path) dirty.push(e);
  } else {
    for (const e of state.reveal.values()) if (e.path === doc.path && e.dirty) dirty.push(e);
  }
  if (!dirty.length) return;
  for (const e of dirty) {
    const prev = e.armor;
    const prevOrd = e.ord || 0;
    /* what we are ENCRYPTING, snapshotted before the await: anything typed
       during the worker round-trip is not in this ciphertext, and clearing
       `dirty` for it would drop the keystrokes on the floor */
    const sent = e.plain;
    let out;
    try {
      out = await secretsCall("encrypt", { plaintext: sent });
    } catch (err) {
      toast("Could not re-encrypt a secret block — nothing was saved");
      throw err;
    }
    const next = indentArmor(out.armor, e.indent);
    const at = replaceArmorInDoc(doc, prev, next, prevOrd);
    if (at < 0) {
      /* The block is simply GONE from the document — deleted in Raw, replaced
         by a proposal, overwritten from disk. That is an ordinary thing to do,
         and the old behaviour (throw, and let saveDoc swallow it) wedged every
         subsequent save of this doc for the rest of the session and then lost
         the buffer on the next navigation. Drop the orphan and keep going. */
      state.reveal.delete(revealKey(doc.path, prev, prevOrd));
      toast("A revealed secret block is no longer in this document — its edit could not be re-attached");
      continue;
    }
    /* which copy of the NEW armor this is (age is nondeterministic, so this is
       0 — asked rather than assumed) */
    let nextOrd = 0;
    for (let hit = doc.markdown.indexOf(next); hit >= 0 && hit < at; hit = doc.markdown.indexOf(next, hit + next.length)) nextOrd++;
    /* every later copy of `prev` just moved up one place */
    const seen = new Set(state.reveal.values());
    for (const o of dirty) seen.add(o);
    for (const o of seen) {
      if (o !== e && o.path === doc.path && o.armor === prev && (o.ord || 0) > prevOrd) o.ord = (o.ord || 0) - 1;
    }
    /* the live node keeps its identity across the swap, so an open editor is
       not yanked out from under the cursor mid-autosave — and ONLY that node:
       retargeting every node with matching armor handed the untouched twin the
       edited block's new ciphertext */
    $$("#doc .secret").forEach((w) => {
      const c = w.zSecret;
      if (!c || c.path !== doc.path || c.armor !== prev) return;
      if ((c.ord || 0) === prevOrd) {
        c.armor = next;
        c.ord = nextOrd;
      } else if ((c.ord || 0) > prevOrd) c.ord = (c.ord || 0) - 1;
    });
    e.armor = next;
    e.ord = nextOrd;
    /* only clean if the plaintext is still the one we just encrypted */
    e.dirty = e.plain !== sent;
    rekeyReveals(doc.path);
  }
  updateMeta();
  /* the model moved under the Raw textarea — push it back, or the next
     syncRaw() writes the pre-flush armor over what was just saved */
  syncRawFromModel(doc);
}

/* ---------- encrypt a selection (works while LOCKED) ---------- */

/**
 * Re-read `.znotes/vault.pub` and refuse to encrypt to a recipient that has
 * moved under us.
 *
 * Encrypting is the one secrets operation that works while LOCKED (the
 * recipient is public), which also means it is the one operation that
 * never touches the unlock-time check that the recipient pairs with
 * `.znotes/identity.age`. Both keyring files are tracked and pushed,
 * so an ordinary `pull --rebase`, a hand-edit, or anyone with write access to
 * the remote can swap `vault.pub` for a foreign key — after which every new
 * secret is encrypted to a key this vault cannot decrypt and the attacker can.
 * That is silent, permanent data loss plus disclosure, so it blocks.
 */
async function recipientDrifted() {
  let fresh = null;
  try {
    const r = await api.getVaultRecipient();
    fresh = r && r.recipient ? r.recipient : null;
  } catch (e) {
    return false; // offline / 500 is not evidence of a swap
  }
  if (fresh && vault.recipient && fresh !== vault.recipient) {
    /* Do NOT adopt it. The new key is a claim, not a fact, until an identity
       we can unwrap derives it. Latched, so a second ⌘⇧E cannot slip past a
       one-shot warning. */
    vault.keyringChanged = true;
    vault.pendingRecipient = fresh;
  }
  if (!vault.keyringChanged) return false;
  toast(
    "Keyring changed: .znotes/vault.pub is now " +
      (vault.pendingRecipient || "a different key") +
      ". Nothing was encrypted — unlock the vault to confirm this key belongs to it."
  );
  return true;
}

export async function encryptSelection() {
  await initSecrets();
  if (vault.state === "disabled") return toast(vault.reason);
  if (vault.state === "none") return askCreate();
  /* the recipient alone is enough to ENCRYPT, which is exactly the trap: every
     block written here would be one nobody can ever open again (vault.ts:
     "unrecoverable data-loss-by-encryption") */
  if (vault.state === "orphan") return toast(ORPHAN_WHY);
  if (vault.state === "repair") {
    /* no recipient on disk: unlocking derives it from the identity and repairs
       the keyring, which is also what makes encryption possible again */
    if (!(await ensureUnlocked())) return;
  }
  if (state.mode !== "raw") return toast("Switch to Raw (⌘E) to encrypt a selection");
  const ta = $("#rawArea");
  const doc = activeDoc();
  if (!ta || !doc) return;
  let from = ta.selectionStart;
  let to = ta.selectionEnd;
  if (from === to) return toast("Select the text to encrypt first");
  /* expand to whole lines: the fence must start at column 0 (research §4.1) */
  const v = ta.value;
  while (from > 0 && v[from - 1] !== "\n") from--;
  while (to < v.length && v[to] !== "\n") to++;
  const plain = v.slice(from, to);
  if (!plain.trim()) return toast("Select the text to encrypt first");
  if (await recipientDrifted()) return;
  try {
    const r = await secretsCall("encrypt", { plaintext: plain });
    const fence = "```age\n" + indentArmor(r.armor, "") + "\n```";
    ta.value = v.slice(0, from) + fence + v.slice(to);
    doc.markdown = ta.value;
    ta.selectionStart = ta.selectionEnd = from + fence.length;
    autoGrow(ta);
    markDirty();
    updateMeta();
    /* the WHOLE recipient, never a prefix: a substituted key differs somewhere,
       and a 16-character prefix is exactly where a swap hides */
    const to_ = r.recipient || vault.recipient || "the vault key";
    toast(r.verified ? "Encrypted to verified key " + to_ : "Encrypted to " + to_ + " (unverified — unlock the vault to confirm it)");
  } catch (err) {
    toast(err.message || "Encryption failed");
  }
}

/* ---------- secret block ----------

   The block's source of truth is the ARMOR in doc.markdown. Revealing adds an
   entry to state.reveal and rewrites this one node; it never touches the
   document model. Locking again — or saving — emits the stored armor byte for
   byte unless the plaintext was actually edited (research §4.2, byte
   stability: without that rule every open-and-save produces a fresh file key,
   fresh nonces, and a garbage git diff).

   REVEAL IS VAULT-WIDE, NOT PER BLOCK. The vault has exactly two states and
   the whole app reads the same one: while the worker holds no identity every
   age block is a locked chip showing NOTHING of its ciphertext; the moment it
   holds one, every block in the doc on screen — and in every doc opened after
   — decrypts to plaintext with no further clicks. The per-block Unlock button
   is the ENTRY POINT into that single state, not a per-block permission: a
   passphrase already given is not asked for again, block by block, and a doc
   of eight secrets is not eight clicks. Locking (manual, idle, tab-hidden,
   the hard session cap, or another tab) reverses it everywhere at once. */

/* A block is identified by its ciphertext AND by which copy of it this is.
   Ciphertext alone is not an identity: two identical fences in one document
   (copy a block to make a staging/prod pair) shared one reveal entry, one
   editor state and one re-encrypt target, so editing either one rewrote the
   first fence and destroyed the other's content. `ord` is 0 for the ordinary
   case — every armor in a document is unique — and counts copies otherwise. */
const revealKey = (path, armor, ord) => path + "\0" + (ord || 0) + "\0" + armor;

/* Blocks whose armor FAILED to decrypt, keyed the same way as state.reveal.
   A MAC failure is an integrity alarm (research §4.2: "a line-level three-way
   merge inside an armor block always produces an undecryptable Frankenstein …
   the app must loudly flag" it) — a toast that fades in two seconds while the
   badge keeps saying "Locked / encrypted" is not a flag. Entries live until the
   armor itself changes, because the key IS the armor. */
const secretFailures = new Map();

/* Decrypts IN FLIGHT, keyed exactly the way `state.reveal` is. Every render
   path asks for a reveal (renderDoc, repaintSecret, an SSE reconcile, ⌘E back
   into Preview), so the ask has to be idempotent: one worker round trip per
   block, no matter how many times the block is painted while it is running. */
const revealing = new Set();

/* Bumped by every lock. A decrypt started before the lock cannot be recalled —
   the worker will answer, and it must answer into nothing rather than putting
   plaintext back on screen a beat after the vault closed. */
let revealEpoch = 0;

/** Cancel every in-flight reveal: their answers belong to a vault that is now
    locked. Called from the one place that locks (onVaultLocked). */
function dropRevealsInFlight() {
  revealEpoch++;
  revealing.clear();
}

const secretNote = (text) => {
  const n = el("div", "secret-note");
  n.textContent = text;
  return n;
};

/* How many blanks a masked body draws. A CONSTANT, deliberately: a mask whose
   width or line count tracked the armor would be a readout of the payload —
   the size of a secret is data about the secret. */
const MASK_CELLS = 14;

/**
 * What a block shows INSTEAD of its ciphertext, whether it is locked, awaiting
 * its decrypt, or flagged.
 *
 * A locked block used to render the armor — first inline, then behind a
 * disclosure. Both were wrong for the same reason: several hundred bytes of
 * base64 in the middle of a document READ as an exposed secret, whatever the
 * badge above them said, and a disclosure spanning the doc width in a pane
 * that invites you to click a line is one stray click from the same wall. So
 * the block shows nothing of itself at all — no armor, no header line, no byte
 * or line count. Raw mode (⌘E) is the honest way to see the source, and it is
 * the only one.
 *
 * There are no text nodes in here, so neither `innerText` nor `textContent`
 * can carry a byte of the block, and it is `aria-hidden` because it says
 * nothing the bar above it has not already said out loud.
 */
function maskedBody(pending) {
  const m = el("div", "secret-mask" + (pending ? " pending" : ""));
  m.setAttribute("aria-hidden", "true");
  m.title = pending ? "Decrypting…" : "Ciphertext hidden — press ⌘E for the raw source";
  for (let i = 0; i < MASK_CELLS; i++) m.appendChild(el("i"));
  return m;
}

/**
 * Start this block's decrypt if the vault is open and nothing has answered for
 * it yet. Synchronous up to the worker call, so the render that asked can see
 * its own pending state in `revealing` and paint "Unlocking…" straight away
 * rather than painting a locked chip that flips a few milliseconds later.
 */
function autoReveal(path, armor, indent, ord) {
  const key = revealKey(path, armor, ord);
  if (state.reveal.has(key) || secretFailures.has(key) || revealing.has(key)) return;
  const epoch = revealEpoch;
  revealing.add(key);
  /* Both halves of "this answer still counts": the block is no longer pending,
     and the vault this decrypt was started under is still the open one. A lock
     has already emptied the set, so the delete finds nothing and the epoch
     says why. */
  const settle = () => {
    revealing.delete(key);
    return epoch === revealEpoch;
  };
  /* the DOCUMENT keeps the indented armor (that is the block's identity and
     its byte-stability contract); the decoder gets it dedented */
  secretsCall("decrypt", { armor: dedentArmor(armor) }).then(
    (r) => {
      if (!settle()) return;
      /* plaintext lives exactly as long as the doc that holds it is on screen:
         a decrypt that lands after the user has navigated away has nowhere
         legitimate to be kept, and nothing to repaint. Coming back re-asks. */
      if (path !== viewedPath()) return;
      state.reveal.set(key, { path, armor, indent: indent || "", ord: ord || 0, plain: r.plaintext, dirty: false });
      repaintSecretsAt(path, armor, ord);
    },
    (err) => {
      /* EVERY failure is recorded, classified or not. An unrecognised code —
         the worker's `undecryptable` fallthrough, or a wedge timeout, which
         carries no code at all — used to write nothing, and the repaint below
         then re-entered `secretEl` → `autoReveal` for a key that was in no map
         at all: an unbounded hot retry loop (measured: ~11k decrypts/second)
         with the block stuck on "Unlocking" forever, no Retry button and no
         integrity alarm. The record is what makes the loop impossible — it is
         the guard `autoReveal` bails on. */
      if (!settle()) return;
      /* One bad block is one bad block. It keeps its own flagged, sticky
         classification and every other block in the doc reveals regardless —
         a merged-to-death block must not hold the rest of the file hostage. */
      const st = FAIL_STATES[(err && err.code) || ""] || FAIL_STATES.unknown;
      secretFailures.set(key, st);
      repaintSecretsAt(path, armor, ord);
      /* the block itself carries the verdict from here on; the toast is for
         the integrity alarms only, and the failure is sticky so it fires once */
      toast((err && err.message) || "Decryption failed");
    }
  );
}

export function secretEl(docPath, armor, indent, ord) {
  const key = revealKey(docPath, armor, ord);
  const entry = state.reveal.get(key);
  const open = !!entry;
  const off = vault.state === "disabled";
  /* the keyring is there but the private half is not: the block IS encrypted
     and there is no way to open it, so it must not offer one */
  const orphan = vault.state === "orphan";
  /* the fence says `age`; the body decides whether that is TRUE. An unparseable
     body is plaintext sitting in a block the UI would otherwise certify as
     encrypted — and gitSync would then commit it under that badge. */
  const bad = !open && !isArmorShape(armor);
  const failed = !open && !bad ? secretFailures.get(key) || null : null;
  /* The vault is open and this block has not answered yet. Asked for HERE, in
     the one function every render path funnels through, so a block cannot be
     painted into existence without its reveal being under way — and because
     `autoReveal` registers synchronously, this paint already knows about it
     and goes straight to "Unlocking…" instead of showing a locked chip that
     flips a frame later. */
  if (!open && !bad && !failed && vault.unlocked) autoReveal(docPath, armor, indent, ord);
  const pending = !open && !bad && !failed && revealing.has(key);
  const w = el("div", "secret" + (open ? " open" : "") + (pending ? " revealing" : "") + (bad || failed ? " flagged" : ""));
  w.zSecret = { path: docPath, armor, indent: indent || "", ord: ord || 0 };

  const sub = open
    ? "decrypted in memory"
    : bad
      ? "NOT ENCRYPTED — this fence body is not age armor"
      : failed
        ? failed.subtitle
        : pending
          ? "decrypting…"
          : off
            ? "unavailable here"
            : orphan
              ? "encrypted — .znotes/identity.age is missing"
              : "encrypted";
  const bar = el("div", "secret-bar");
  bar.innerHTML =
    '<span class="secret-ico">' + (open || pending ? I.unlock : I.lock) + "</span>" +
    '<span style="min-width:0"><span class="secret-t">Secret block</span>' +
    '<span class="secret-s" style="display:block">age · x25519 · ' +
    esc(sub) +
    "</span></span>";
  const badge = el(
    "span",
    "badge " + (open ? "unlock" : bad || failed || off ? "warn" : "lock"),
    open ? "Unlocked" : bad ? "Not encrypted" : failed ? failed.badge : pending ? "Unlocking" : "Locked"
  );
  badge.style.marginLeft = "auto";
  bar.appendChild(badge);

  if (open) {
    const copy = el("button", "btn sm", I.copy + " Copy");
    copy.style.marginLeft = "8px";
    copy.addEventListener("click", () => copySecret(copy, entry.plain));
    /* Locking is VAULT-WIDE, and the button says so in its title. A per-block
       re-lock cannot exist beside vault-wide reveal: the vault would still be
       open, so the very next paint would decrypt the block straight back. */
    const lock = el("button", "btn sm", I.lock + " Lock");
    lock.title = "Lock the vault — every secret block re-locks";
    lock.addEventListener("click", () => lockVault("manual"));
    bar.appendChild(copy);
    bar.appendChild(lock);
  } else if (!off && !bad && !orphan && !pending) {
    /* "repair" has an identity on disk — the passphrase opens it; only "none"
       is a vault that genuinely has no key yet */
    const needsVault = vault.state === "none";
    const btn = el("button", "btn sm primary", (needsVault ? I.key : I.unlock) + (needsVault ? " Create vault identity" : failed ? " Retry unlock" : " Unlock"));
    btn.style.marginLeft = "8px";
    btn.title = failed ? "Try this block again" : "Unlock the vault — every secret block reveals";
    btn.addEventListener("click", () => (needsVault ? askCreate() : unlockAndReveal(w)));
    bar.appendChild(btn);
  }

  const body = el("div", "secret-body");
  if (open) {
    /* Every attribute here is a leak the research table names: spellcheck,
       autocorrect and Grammarly all ship what you type to somebody else's
       server (research §6, "DOM-adjacent services"). */
    const ta = el("textarea", "secret-edit");
    ta.value = entry.plain;
    ta.spellcheck = false;
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("data-gramm", "false");
    ta.setAttribute("data-enable-grammarly", "false");
    ta.setAttribute("aria-label", "Decrypted secret · " + docPath);
    ta.addEventListener("input", () => {
      entry.plain = ta.value;
      entry.dirty = true; // ⇒ and ONLY now may this block be re-encrypted
      autoGrow(ta);
      markDirty();
    });
    body.appendChild(ta);
    setTimeout(() => autoGrow(ta), 0);
  } else if (bad) {
    /* NOT armor: whatever is in this fence is plaintext on disk, in git and on
       GitHub. Showing it in full IS the warning — collapsing it behind a
       disclosure would hide the very bytes the note says are exposed. */
    const pre = el("pre");
    pre.textContent = armor;
    body.appendChild(pre);
    body.appendChild(
      secretNote(
        "This ```age fence does not contain age armor, so nothing here is encrypted — " +
          "the text above is stored, committed and pushed exactly as you see it. " +
          "Encrypt it with ⌘⇧E in Raw mode, or remove the fence."
      )
    );
  } else {
    /* Locked (or waiting on its decrypt): NO CIPHERTEXT AT ALL — see
       `maskedBody`. This is a RENDERING change only. `w.zSecret.armor` still
       holds the fence body verbatim, which is what save writes back, so an
       unedited reveal→lock→save is still byte-identical
       (tests/secrets-e2e.test.ts). */
    body.appendChild(maskedBody(pending));
    const note = failed
      ? failed.note
      : off
        ? vault.reason || "Secrets features are unavailable in this browser context."
        : orphan
          ? ORPHAN_WHY
          : "";
    if (note) body.appendChild(secretNote(note));
  }
  w.appendChild(bar);
  w.appendChild(body);
  return w;
}

/** The live node(s) for ONE block. The same armor can legitimately appear more
    than once in a document, and those copies are separate blocks: each has its
    own reveal entry, its own editor and its own re-encrypt target, so the
    ordinal is part of the match. */
function secretNodesFor(path, armor, ord) {
  const n = ord || 0;
  return $$("#doc .secret").filter(
    (x) => x.zSecret && x.zSecret.path === path && x.zSecret.armor === armor && (x.zSecret.ord || 0) === n
  );
}

/** Re-render one block in place; the reveal map is keyed by armor, so this is
    all the state a repaint needs. */
function repaintSecret(w) {
  /* An await can outlive the node it started on — a full repaint (unlock,
     external change) replaces every `.secret` while a decrypt is in flight, and
     `replaceWith` on a detached node writes into nothing. The armor identifies
     the block, so re-find the live one. */
  let node = w;
  if (!node.isConnected && w.zSecret) node = secretNodesFor(w.zSecret.path, w.zSecret.armor, w.zSecret.ord)[0] || w;
  const c = node.zSecret;
  const n = secretEl(c.path, c.armor, c.indent, c.ord);
  if (node.dataset.line != null) n.dataset.line = node.dataset.line;
  node.replaceWith(n);
  return n;
}

/** Repaint a block identified by its CONTENT — what an async decrypt has,
    since the node it was started from may have been replaced (or the doc left)
    while the worker was working. A block that is no longer on screen simply
    has nothing to repaint, which is the correct no-op. */
function repaintSecretsAt(path, armor, ord) {
  secretNodesFor(path, armor, ord).forEach(repaintSecret);
}

/* How each decrypt failure is left ON the block, not just in a toast. */
const FAIL_STATES = {
  tampered: {
    badge: "Integrity check failed",
    subtitle: "MODIFIED after encryption — MAC verification failed",
    note:
      "This block's ciphertext no longer matches its authentication tag: something edited the bytes " +
      "inside the armor (a line-level git merge is the usual culprit — research §4.2). " +
      "The vault key is fine, so re-entering the passphrase or rotating the key will not help. " +
      "Recover the block from git history, or from a copy that still verifies.",
  },
  truncated: {
    badge: "Integrity check failed",
    subtitle: "INCOMPLETE — part of the ciphertext is missing",
    note:
      "Part of this block's armor is gone, so the ciphertext cannot be authenticated. " +
      "The vault key is fine. Recover the full block from git history.",
  },
  "bad-armor": {
    badge: "Corrupt armor",
    subtitle: "the armor itself does not parse",
    note: "This block's armor is malformed — it was probably merged or hand-edited. Recover it from git history.",
  },
  "no-matching-identity": {
    badge: "Wrong key",
    subtitle: "encrypted to a different age recipient",
    note:
      "This block was encrypted to a recipient that is not this vault's key. It is intact — it just needs " +
      "the identity it was encrypted to.",
  },
  /* The catch-all, and the reason `secretFailures` is written unconditionally.
     The worker classifies what it recognises and emits `undecryptable` for
     everything else (a damaged stanza line, bad padding), and a wedged worker
     rejects with no code at all. Those are still failures: without a record
     the block was re-asked by every repaint, forever. */
  unknown: {
    badge: "Could not decrypt",
    subtitle: "the decrypt failed for an unrecognised reason",
    note:
      "This block did not decrypt and the failure does not match any of the known kinds — the armor is " +
      "damaged in a way age could not classify, or the crypto worker did not answer. " +
      "Retry unlock asks again; if it keeps failing, recover the block from git history.",
  },
};

/**
 * The block's Unlock button: the ENTRY POINT into the vault-wide open state,
 * not a per-block permission. It opens the vault (passphrase modal if the
 * worker has no identity yet) and then lets the ordinary repaint reveal every
 * block, this one included — there is exactly one reveal path and this is not
 * a second one.
 *
 * On a FAILED block it is "Retry unlock": drop the sticky classification so
 * the repaint asks the worker again rather than re-showing the old verdict.
 */
async function unlockAndReveal(w) {
  const c = w.zSecret;
  if (secretFailures.delete(revealKey(c.path, c.armor, c.ord))) repaintSecret(w);
  const ok = await ensureUnlocked();
  if (!ok) return;
  /* An already-open vault emits no `unlocked` event, so this is what carries a
     retry. After a real unlock it is the second repaint behind the one
     `onWorkerEvent` already did, and idempotence makes it free. */
  repaintSecretsUI();
}

/* ---------- clipboard, with the timed clear the research table demands ----------
   The delay is `secrets.clipboardClearSeconds` (30s by default), read at COPY
   time so a change in Settings applies to the very next copy.

   Two separate concerns, and conflating them was the bug: `clipT` is the
   COUNTDOWN, `clipArmed` is the promise that the clipboard will be cleared.
   Stopping the countdown must never silently retire the promise — locking is
   precisely when the plaintext should leave the clipboard, not when the clear
   should be abandoned. */
let clipT = null;
let clipArmed = false;

function stopClipboardCountdown() {
  if (clipT) clearInterval(clipT);
  clipT = null;
}

/** Perform the pending clear NOW (lock, re-lock, or a fresh copy superseding). */
function clearClipboardNow(quiet) {
  stopClipboardCountdown();
  if (!clipArmed) return;
  clipArmed = false;
  /* best effort only — a clipboard manager is outside this boundary and the
     browser may refuse a write while the tab is unfocused */
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText("").then(() => {
      if (!quiet) toast("Clipboard cleared");
    }, () => {});
}

function copySecret(btn, text) {
  stopClipboardCountdown();
  clipArmed = false; // this write supersedes the previous one
  const done = () => {
    clipArmed = true;
    let left = clipboardSeconds();
    const paint = () => (btn.innerHTML = I.copy + " Clears in " + left + "s");
    paint();
    clipT = setInterval(() => {
      left -= 1;
      if (left > 0) return paint();
      btn.innerHTML = I.copy + " Copy";
      clearClipboardNow();
    }, 1000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => toast("The browser refused clipboard access"));
  } else {
    toast("Clipboard is unavailable in this context");
  }
}
