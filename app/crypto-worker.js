/* ============================================================
   crypto-worker.js — the plaintext jail.

   EVERY cryptographic operation in z-notes happens here and nowhere else.
   Two reasons, both load-bearing:

     1. scrypt at logN=18 is ~0.4–1s of synchronous work. On the main thread
        that is a frozen UI on every unlock.
     2. Key material never enters the main-thread heap. The vault identity is
        imported as a NON-EXTRACTABLE CryptoKey and the raw scalar is zeroed
        immediately after; from then on even a full main-thread compromise
        cannot exfiltrate the key itself.

   The message API is deliberately narrow — unlock / lock / decrypt / encrypt /
   status (+ the vault-creation and timer bookkeeping the lifecycle needs).
   There is no "export identity", no "get passphrase", no way to ask this
   worker for anything but one block's plaintext at a time.

   HARD RULES, enforced by construction below:
     · nothing is ever written to sessionStorage / localStorage / IndexedDB
     · the passphrase is used once and dropped (JS strings cannot be zeroed —
       that is a known boundary, not an oversight)
     · BroadcastChannel carries the LOCK SIGNAL ONLY, never key material
   ============================================================ */
"use strict";

import { dedentArmor } from "./armor.js";

/* ------------------------------------------------------------------
   auto-lock policy (research §5.2 / §7.2)

   These are USER SETTINGS (`[secrets]` in settings.toml / Settings → Secrets),
   not constants: a threat model that wants five minutes and one that wants
   eight hours are both legitimate. The values below are the fallbacks used
   before the main thread has told us anything — they match the server's
   DEFAULTS.secrets — and `configure` replaces them live, mid-session, with no
   reload and no re-unlock.
   ------------------------------------------------------------------ */
const POLICY = {
  idleMs: 15 * 60 * 1000, // no user activity
  hiddenMs: 5 * 60 * 1000, // tab hidden
  hardCapMs: 8 * 60 * 60 * 1000, // session ceiling, activity or not
};
const TICK_MS = 15 * 1000; // one ticker beats three drifting timeouts
const SCRYPT_LOG_N = 18; // typage default; Go age default; ≤ both decrypt caps

/** Adopt whatever of {idleMs,hiddenMs,hardCapMs} arrived; ignore the rest.
    A nonsense value must never DISABLE the lock, so anything unusable leaves
    the current policy alone. */
function applyPolicy(cfg) {
  if (!cfg || typeof cfg !== "object") return POLICY;
  for (const k of ["idleMs", "hiddenMs", "hardCapMs"]) {
    const n = Number(cfg[k]);
    if (Number.isFinite(n) && n > 0) POLICY[k] = n;
  }
  return POLICY;
}

const LOCK_CHANNEL = "znotes-vault-lock";

/* ------------------------------------------------------------------
   state — the entire secret surface of this app
   ------------------------------------------------------------------ */
const S = {
  age: null, // the typage module namespace
  identity: null, // CryptoKey (preferred) or an AGE-SECRET-KEY-1… string
  identityKind: "", // "cryptokey" | "string"
  recipient: null, // age1… — public, safe to hold while locked
  /* The recipient DERIVED from a successfully unwrapped identity.age. This is
     the only recipient this worker has ever proven the vault can decrypt with.
     `.znotes/vault.pub` is an ordinary tracked file: a bad merge, a hand-edit,
     or anyone with push access can point it at a foreign key, and encrypting
     to a recipient whose identity we do not hold is unrecoverable, silent
     data loss plus disclosure. Once this is set it is a latch — the recipient
     may not change under us for the rest of the session. */
  verifiedRecipient: null,
  unlockedAt: 0,
  lastActivity: 0,
  hiddenSince: 0,
};

let channel = null;
try {
  channel = new BroadcastChannel(LOCK_CHANNEL);
  channel.onmessage = (ev) => {
    /* Another tab locked; follow it. Never re-broadcast — that is a loop.
       The reason is rewritten, not forwarded: from here it IS "another tab". */
    if (ev.data && ev.data.type === "lock" && S.identity) doLock("other-tab", false);
  };
} catch (e) {
  channel = null; // ancient browser: per-tab locking still works
}

/* ------------------------------------------------------------------
   the one dependency
   ------------------------------------------------------------------ */
let agePromise = null;
function loadAge() {
  if (!agePromise) {
    agePromise = import("/vendor/age.js").then((m) => {
      S.age = m;
      return m;
    });
  }
  return agePromise;
}

/* ------------------------------------------------------------------
   bech32 → the 32-byte X25519 scalar

   typage takes the identity as `AGE-SECRET-KEY-1…` or as a CryptoKey, and we
   want the CryptoKey (non-extractable). It does not export a bech32 decoder,
   and WebCrypto will not import a raw X25519 PRIVATE key — only PKCS#8 or JWK
   — so the scalar is unwrapped here and re-wrapped in the 16-byte PKCS#8
   prefix for `{name:"X25519"}` before import.

   BIP-173 bech32, checksum verified: a corrupted identity must fail here
   rather than produce a key that silently decrypts nothing.
   ------------------------------------------------------------------ */
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** `AGE-SECRET-KEY-1…` → Uint8Array(32). Throws on any malformation. */
function bech32ToBytes(s, wantHrp) {
  const str = String(s).trim();
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error("mixed-case identity");
  const low = str.toLowerCase();
  const sep = low.lastIndexOf("1");
  if (sep < 1 || sep + 7 > low.length) throw new Error("malformed identity");
  const hrp = low.slice(0, sep);
  if (hrp !== wantHrp) throw new Error("not an age identity");
  const data = [];
  for (const c of low.slice(sep + 1)) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error("bad character in identity");
    data.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error("identity checksum failed");
  // 5-bit groups → 8-bit bytes, dropping the 6 checksum symbols
  const payload = data.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) throw new Error("identity padding invalid");
  if (out.length !== 32) throw new Error("identity is not 32 bytes");
  return new Uint8Array(out);
}

/** RFC 8410 PKCS#8 wrapper for a raw X25519 scalar. */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

async function importIdentity(idString) {
  let raw = null;
  let pkcs8 = null;
  /* TWO try blocks, not one. A bech32/checksum failure and a missing-X25519
     failure are different events and only the second one has a safe fallback:
     collapsing them let a corrupted identity through as a raw string, where
     `identityToRecipient` then threw and the wrong-identity guard silently
     no-opped. The decoder's contract (above) is that a corrupted identity
     fails HERE. */
  try {
    raw = bech32ToBytes(idString, "age-secret-key-");
    pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
    pkcs8.set(PKCS8_PREFIX, 0);
    pkcs8.set(raw, PKCS8_PREFIX.length);
  } catch (e) {
    if (raw) raw.fill(0);
    if (pkcs8) pkcs8.fill(0);
    throw err("bad-identity", "The unwrapped vault identity is not a valid age secret key.");
  }
  try {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
    return { identity: key, kind: "cryptokey" };
  } catch (e) {
    /* Browsers without X25519 in WebCrypto (it shipped late — research §6
       "Secure context") cannot hold a non-extractable key. typage falls back
       to noble with the string form, which is still worker-jailed: strictly
       weaker than a CryptoKey, still far stronger than the main thread. */
    return { identity: String(idString).trim(), kind: "string" };
  } finally {
    if (raw) raw.fill(0);
    if (pkcs8) pkcs8.fill(0);
  }
}

/* ------------------------------------------------------------------
   lock / unlock
   ------------------------------------------------------------------ */
function doLock(reason, broadcast) {
  const was = !!S.identity;
  S.identity = null;
  S.identityKind = "";
  S.unlockedAt = 0;
  S.hiddenSince = 0;
  if (was && broadcast && channel) {
    try {
      channel.postMessage({ type: "lock", reason });
    } catch (e) {}
  }
  if (was) emit("locked", { reason });
  return was;
}

function touch() {
  S.lastActivity = Date.now();
}

setInterval(() => {
  if (!S.identity) return;
  const now = Date.now();
  if (now - S.unlockedAt >= POLICY.hardCapMs) return void doLock("session-expired", true);
  if (now - S.lastActivity >= POLICY.idleMs) return void doLock("idle", true);
  if (S.hiddenSince && now - S.hiddenSince >= POLICY.hiddenMs) return void doLock("hidden", true);
}, TICK_MS);

/* ------------------------------------------------------------------
   message plumbing
   ------------------------------------------------------------------ */
function emit(event, data) {
  self.postMessage(Object.assign({ type: "event", event }, data || {}));
}

function statusOf() {
  return {
    unlocked: !!S.identity,
    keyKind: S.identityKind || null,
    recipient: S.recipient,
    /* whether THIS recipient has been proven to pair with identity.age */
    verified: !!S.verifiedRecipient && S.verifiedRecipient === S.recipient,
    canEncrypt: !!S.recipient,
    unlockedAt: S.unlockedAt || null,
    expiresAt: S.identity ? S.unlockedAt + POLICY.hardCapMs : null,
    idleLockAt: S.identity ? S.lastActivity + POLICY.idleMs : null,
    /* echoed back so the caller can prove a settings change actually landed */
    policy: { ...POLICY },
  };
}

/**
 * Adopt a recipient handed in from the main thread. Once a real unlock has
 * PROVEN which recipient this vault's identity pairs with, that answer latches:
 * a later `vault.pub` claiming something else is a keyring substitution, not a
 * configuration change, and the only safe response is to refuse it loudly.
 */
function adoptRecipient(next) {
  if (S.verifiedRecipient && next && next !== S.verifiedRecipient)
    throw err(
      "recipient-changed",
      "The vault recipient changed after this session verified it against .znotes/identity.age. " +
        "Reload and unlock again before encrypting anything new."
    );
  S.recipient = next || null;
}

const OPS = {
  async init(msg) {
    if (!self.crypto || !self.crypto.subtle) throw err("no-subtle", "WebCrypto is unavailable in this context.");
    await loadAge();
    if (typeof msg.recipient === "string" && msg.recipient) adoptRecipient(msg.recipient);
    applyPolicy(msg.policy);
    touch();
    return Object.assign({ ready: true }, statusOf());
  },

  /**
   * Live auto-lock policy from `[secrets]`. Takes effect on the very next tick
   * — including for an ALREADY UNLOCKED session, which is the point: shortening
   * the idle timeout is a security decision and must not wait for a reload.
   */
  async configure(msg) {
    applyPolicy(msg && msg.policy);
    return statusOf();
  },

  async setRecipient(msg) {
    adoptRecipient(typeof msg.recipient === "string" && msg.recipient ? msg.recipient : null);
    return statusOf();
  },

  /* The passphrase arrives, is spent on scrypt, and is never referenced
     again — not stored, not echoed back, not sent anywhere. */
  async unlock(msg) {
    const age = await loadAge();
    if (typeof msg.identity !== "string" || !msg.identity.trim())
      throw err("no-identity", "This vault has no age identity yet.");
    if (typeof msg.passphrase !== "string" || !msg.passphrase) throw err("no-passphrase", "Enter the passphrase.");

    let idString;
    try {
      const d = new age.Decrypter();
      d.addPassphrase(msg.passphrase);
      idString = (await d.decrypt(age.armor.decode(msg.identity), "text")).trim();
    } catch (e) {
      throw err("bad-passphrase", "That passphrase does not unwrap this vault identity.");
    }

    const imported = await importIdentity(idString);
    idString = null;

    /* Prove the unwrapped key is THIS vault's key before declaring success.
       Without it a stale identity.age would unlock cleanly and then fail to
       decrypt every block with an unexplained "no matching identity".

       A THROW here is a failed verification, never "no opinion": the previous
       empty catch turned an unparseable identity into a silent success. */
    let derived = null;
    try {
      derived = await age.identityToRecipient(imported.identity);
    } catch (e) {
      throw err(
        "bad-identity",
        "The unwrapped vault identity is not a usable age key — no recipient could be derived from it."
      );
    }
    if (S.recipient && derived !== S.recipient)
      throw err("wrong-identity", "This identity does not match the vault recipient in .znotes/vault.pub.");

    /* From here on this session knows, by derivation, which recipient the
       vault can actually decrypt. Encryption is bound to it (see `encrypt`),
       and a `vault.pub` that later disagrees is rejected by adoptRecipient. */
    S.verifiedRecipient = derived;
    /* An identity with no recipient on disk is repairable, not fatal: hand the
       derived one back so the caller can rewrite .znotes/vault.pub. */
    if (!S.recipient) S.recipient = derived;

    S.identity = imported.identity;
    S.identityKind = imported.kind;
    S.unlockedAt = Date.now();
    S.hiddenSince = 0;
    touch();
    emit("unlocked", statusOf());
    return statusOf();
  },

  async lock(msg) {
    const was = doLock((msg && msg.reason) || "manual", true);
    return Object.assign({ was }, statusOf());
  },

  async status() {
    return statusOf();
  },

  /** armor → plaintext. The ONLY way plaintext ever leaves this worker. */
  async decrypt(msg) {
    const age = await loadAge();
    if (!S.identity) throw err("locked", "The vault is locked.");
    if (typeof msg.armor !== "string") throw err("bad-armor", "Nothing to decrypt.");
    touch();
    let bytes;
    try {
      /* a fence inside a list item carries the list's indentation (research
         §4.1) — the document keeps those bytes, the decoder must not see them */
      bytes = age.armor.decode(dedentArmor(msg.armor));
    } catch (e) {
      throw err("bad-armor", "This block is not valid age armor — it may have been merged or hand-edited.");
    }
    try {
      const d = new age.Decrypter();
      d.addIdentity(S.identity);
      return { plaintext: await d.decrypt(bytes, "text") };
    } catch (e) {
      throw classifyDecryptError(e);
    }
  },

  /** plaintext → armor. Works while LOCKED: the recipient is public (§3). */
  async encrypt(msg) {
    const age = await loadAge();
    if (!S.recipient) throw err("no-recipient", "This vault has no age recipient yet.");
    /* Belt and braces for the latch in adoptRecipient: nothing may ever be
       encrypted to a key this session has proven the vault cannot decrypt. */
    if (S.verifiedRecipient && S.recipient !== S.verifiedRecipient)
      throw err(
        "recipient-changed",
        "Refusing to encrypt: .znotes/vault.pub no longer matches the identity this session unlocked."
      );
    if (typeof msg.plaintext !== "string") throw err("bad-plaintext", "Nothing to encrypt.");
    touch();
    const e = new age.Encrypter();
    e.addRecipient(S.recipient);
    return {
      armor: age.armor.encode(await e.encrypt(msg.plaintext)),
      /* the caller SHOWS these: a recipient nobody has verified is a recipient
         nobody has checked against .znotes/identity.age */
      recipient: S.recipient,
      verified: S.recipient === S.verifiedRecipient,
    };
  },

  /** First-run vault creation: identity + recipient, wrapped under scrypt. */
  async generate(msg) {
    const age = await loadAge();
    if (typeof msg.passphrase !== "string" || !msg.passphrase) throw err("no-passphrase", "Enter a passphrase.");
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const e = new age.Encrypter();
    e.setPassphrase(msg.passphrase);
    e.setScryptWorkFactor(SCRYPT_LOG_N);
    const wrapped = age.armor.encode(await e.encrypt(identity));
    /* we derived this recipient from the identity we just made: verified by
       construction, and the latch protects it from here on */
    S.verifiedRecipient = recipient;
    S.recipient = recipient;
    /* the caller PUTs this to the server, so the plaintext identity string
       must NOT go with it — only the wrapped armor and the public recipient */
    return { identity: wrapped, recipient };
  },

  /**
   * Change the PASSPHRASE without changing the KEY (research §5.3, the
   * "routine" of the two operations there).
   *
   * Unwrap `.znotes/identity.age` with the current passphrase, re-wrap the very
   * same age identity under a new one with a fresh scrypt salt at logN=18, and
   * hand back the new armor. The vault key is untouched, so `vault.pub` is
   * unchanged and every block already in the corpus still decrypts — which is
   * exactly why this can be a settings action while ROTATION cannot.
   *
   * It stays inside the "no export identity" rule the header sets out: armor
   * goes in, armor comes out, and the unwrapped `AGE-SECRET-KEY-1…` exists only
   * as a local in this function. The two passphrases are spent and dropped like
   * every other one — neither is stored, echoed, or sent anywhere.
   *
   * Deliberately does NOT unlock the session. Proving you know the passphrase
   * is not the same as asking for a decrypt window, and a settings edit that
   * silently hands one out is a policy change nobody requested.
   */
  async rewrap(msg) {
    const age = await loadAge();
    if (typeof msg.identity !== "string" || !msg.identity.trim())
      throw err("no-identity", "This vault has no age identity to re-wrap.");
    if (typeof msg.current !== "string" || !msg.current) throw err("no-passphrase", "Enter the current passphrase.");
    if (typeof msg.next !== "string" || !msg.next) throw err("no-passphrase", "Enter the new passphrase.");
    if (msg.current === msg.next) throw err("same-passphrase", "The new passphrase is the same as the current one.");

    let idString = null;
    try {
      const d = new age.Decrypter();
      d.addPassphrase(msg.current);
      idString = (await d.decrypt(age.armor.decode(msg.identity), "text")).trim();
    } catch (e) {
      throw err("bad-passphrase", "That passphrase does not unwrap this vault identity.");
    }

    let recipient = null;
    try {
      recipient = await age.identityToRecipient(idString);
    } catch (e) {
      idString = null;
      throw err("bad-identity", "The unwrapped vault identity is not a usable age key — refusing to re-wrap it.");
    }
    /* The re-wrapped file must pair with the recipient this vault encrypts to.
       If it does not, the identity we just unwrapped is not this vault's key
       and writing it back would replace a working keyring with a dead one. */
    if (S.recipient && recipient !== S.recipient) {
      idString = null;
      throw err("wrong-identity", "This identity does not match the vault recipient in .znotes/vault.pub.");
    }

    let wrapped;
    try {
      const e = new age.Encrypter();
      e.setPassphrase(msg.next);
      e.setScryptWorkFactor(SCRYPT_LOG_N);
      wrapped = age.armor.encode(await e.encrypt(idString));
    } finally {
      idString = null;
    }

    /* Verified by derivation from an identity we successfully unwrapped — the
       same standard `unlock` uses, and it latches the same way. */
    S.verifiedRecipient = recipient;
    if (!S.recipient) S.recipient = recipient;
    return { identity: wrapped, recipient };
  },

  /** Main thread reports user activity; the idle clock lives here. */
  async activity() {
    touch();
    return { ok: true };
  },

  async visibility(msg) {
    if (msg.hidden) S.hiddenSince = S.hiddenSince || Date.now();
    else {
      S.hiddenSince = 0;
      touch();
    }
    return statusOf();
  },
};

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * A decrypt can fail for reasons that mean very different things, and typage
 * distinguishes them perfectly well — the old code threw all of them away
 * behind "This block was not encrypted to this vault key."
 *
 *   · "invalid tag"                              → STREAM/ChaCha20-Poly1305 MAC
 *                                                  failure: the ciphertext was
 *                                                  MODIFIED (research §4.2's
 *                                                  merge Frankenstein)
 *   · "ciphertext expected length bigger than…"  → the payload is truncated
 *   · "invalid version" / "non-ASCII byte in     → the age header itself is
 *     header" / "Unknown letter" / "invalid        mangled: still corruption,
 *     stanza"                                      never a key problem
 *   · "no identity matched…" / "unrecognized…"   → genuinely the wrong key
 *
 * Telling a user their key is wrong when the real event is an integrity
 * failure sends them to re-enter the passphrase or rotate the vault key —
 * neither of which helps, and one of which is destructive.
 */
function classifyDecryptError(e) {
  const m = String((e && e.message) || e);
  if (/no identity matched|unrecognized identity/i.test(m))
    return err("no-matching-identity", "This block was not encrypted to this vault key.");
  if (/invalid tag/i.test(m))
    return err(
      "tampered",
      "Integrity check FAILED: this block's ciphertext was modified after it was encrypted " +
        "(a line-level git merge or a hand-edit inside the armor). The vault key is fine — the block is not."
    );
  if (/tagLength|expected length|too short|truncat/i.test(m))
    return err(
      "truncated",
      "Integrity check FAILED: this block's ciphertext is incomplete — part of the armor is missing."
    );
  /* Chromium detail: typage reads the payload with `new Response(stream).text()`
     (age-encryption/dist/io.js), and when the STREAM errors mid-read the browser
     replaces the underlying reason with a bare TypeError "Failed to fetch".
     Getting that far means the armor parsed, the header parsed and an identity
     MATCHED — the only thing left to fail is the STREAM's authentication tag.
     So this shape is an integrity failure by construction, whatever the engine
     chose to call it. (Bun and Firefox surface "invalid tag" directly, which the
     branch above catches.) */
  if (/failed to fetch|network error|error while reading|stream/i.test(m))
    return err(
      "tampered",
      "Integrity check FAILED: this block's ciphertext did not authenticate — it was modified or truncated " +
        "after it was encrypted (a line-level git merge or a hand-edit inside the armor). " +
        "The vault key is fine — the block is not."
    );
  if (/invalid version|non-ascii|unknown letter|invalid stanza|invalid header|malformed|invalid mac/i.test(m))
    return err(
      "bad-armor",
      "This block's age header is malformed — it may have been merged or hand-edited. The vault key is fine."
    );
  return err("undecryptable", "This block could not be decrypted: " + m);
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, op } = msg;
  const fn = OPS[op];
  if (!fn) {
    self.postMessage({ id, ok: false, error: { code: "bad-op", message: "Unknown operation: " + op } });
    return;
  }
  try {
    const result = await fn(msg);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      error: { code: e && e.code ? e.code : "worker-error", message: String((e && e.message) || e) },
    });
  }
};

self.onerror = () => {
  // a crash must not leave a key alive in a wedged worker
  doLock("worker-error", true);
};
