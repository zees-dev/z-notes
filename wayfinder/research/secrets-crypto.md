---
label: wayfinder:research
title: Secrets crypto design — inline encrypted blocks
ticket: ../tickets/09-research-secrets-crypto.md
researched: 2026-07-31
---

# Secrets crypto design — inline encrypted ```` ```age ```` blocks

Scope: the on-disk format, KDF, cipher, key lifecycle and leak-surface rules for
inline encrypted regions in z-notes. Everything client-side, no external
services, ciphertext committed to git, server never sees plaintext
([ticket 03](../tickets/03-secrets-model.md)).

**Headline:** don't hand-roll an armor format. Use the **age v1 file format**
(C2SP-specified, multiple interoperable implementations) inside a fenced
`age` code block, produced by the **`age-encryption` (typage)** TS library,
with an **X25519 vault key** per block and the vault identity itself wrapped
under a **passphrase + scrypt (logN=18)** keyring file. Full parameters in
[§7 Recommendation](#7-recommendation).

---

## 1. KDF: PBKDF2 (WebCrypto) vs Argon2id (WASM) vs scrypt (pure JS)

### 1.1 What the standards say (verified today)

OWASP's Password Storage Cheat Sheet currently recommends
([source](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)):

| Algorithm | OWASP parameters |
|---|---|
| Argon2id | m=47104 (46 MiB) t=1 p=1, **or** m=19456 (19 MiB) t=2 p=1 (stated minimum), m=12288 t=3 p=1, m=9216 t=4 p=1, m=7168 t=5 p=1 |
| scrypt | N=2^17 (128 MiB) r=8 p=1, or N=2^16 r=8 p=2, N=2^15 r=8 p=3, N=2^14 r=8 p=5, N=2^13 r=8 p=10 |
| PBKDF2 | **600,000** iterations for HMAC-SHA-256; 220,000 for SHA-512; 1,300,000+ for SHA-1 (legacy only) |
| bcrypt | work factor ≥ 10, 72-byte input cap |

Cross-check from a shipping password manager: Bitwarden's defaults are
**PBKDF2-SHA256 600,000** (also the enforced *minimum* as of release 2026.2.1)
and **Argon2id m=32 MiB, t=6, p=4**, with an explicit warning that Argon2id
memory above 64 MiB breaks iOS autofill
([Bitwarden KDF docs](https://bitwarden.com/help/kdf-algorithms/)). That last
point is the practical ceiling for browser/mobile clients: memory-hard KDFs are
constrained by the *client's* memory budget, not the server's.

### 1.2 Argon2id in a browser needs WASM, and the WASM options are stale

Argon2 is **not** available in WebCrypto. It appears in the WICG
["Modern Algorithms in the Web Cryptography API"](https://wicg.github.io/webcrypto-modern-algos/)
draft (Draft Community Group Report, 29 June 2026 — explicitly *not* a W3C
Standard and not on the standards track), alongside ML-KEM, ML-DSA,
ChaCha20-Poly1305, SHA-3. There is no shipping browser implementation. Treat
native Argon2 as unavailable for this project's lifetime.

So Argon2id means vendoring a WASM blob or eating pure-JS cost. Verified state
of the ecosystem (npm registry + GitHub commit history, checked 2026-07-31):

| Package | Latest | Published | Last commit | Notes |
|---|---|---|---|---|
| `hash-wasm` | 4.12.0 | 2024-11-19 | 2024-11-19 | Fastest measured Argon2id in JS-land; hand-tuned WASM; **no commits in ~20 months** |
| `argon2id` ([openpgpjs](https://github.com/openpgpjs/argon2id)) | 1.0.1 | 2023-08-03 | 2023-08-03 | RFC 9106, WASM inlined as base64, <7 KB gz, SIMD with non-SIMD fallback; **no commits in ~3 years** |
| `argon2-browser` | 1.18.0 | 2021-06-05 | — | Effectively abandoned; still 67 dependents |
| `@noble/hashes` argon2 | 2.2.0 | 2026-04-11 | active | Pure JS. Its own README: *"Argon2 can't be fast in JS, because there is no fast Uint64Array. It is suggested to use Scrypt instead. Being 5x slower than native code means brute-forcing attackers have bigger advantage."* Argon2 was **out of scope** of the Cure53 audit ([README](https://github.com/paulmillr/noble-hashes#security)) |

Also: Argon2's `p` (parallelism) parameter is a lie in a browser unless you set
up `SharedArrayBuffer` with COOP/COEP cross-origin isolation headers. Single-
threaded WASM with `p=4` costs the defender 4 lanes of *serial* work while an
attacker with real threads gets the parallelism for free. If Argon2id is ever
used here, use **p=1**.

### 1.3 Measured KDF cost in JS (noble's own benchmark suite)

From [@noble/hashes README benchmarks](https://github.com/paulmillr/noble-hashes#benchmarks):

```
pbkdf2(sha256, c: 2 ** 18)      197ms/op     (262,144 iterations, pure JS)
pbkdf2(sha512, c: 2 ** 18)      630ms/op
scrypt(n: 2 ** 18, r: 8, p: 1)  400ms/op     (256 MiB working set)
argon2id(t: 1, m: 256MB)       2881ms
```

Reading: **scrypt at N=2^18 costs ~400 ms of pure JS** — i.e. a memory-hard KDF
at *double* the OWASP-recommended memory is cheaper in JS than pure-JS PBKDF2 at
half the OWASP iteration count, and ~7× cheaper than pure-JS Argon2id. Native
WebCrypto PBKDF2 is faster than the pure-JS figure above (expect low hundreds of
ms for 600k SHA-256 on a modern desktop), but PBKDF2 is the weakest of the three
against GPU/ASIC attackers precisely because it needs no memory.

**Conclusion:** for a browser client, the ranking on *defence-per-millisecond*
is scrypt (pure JS, audited, zero WASM) > Argon2id (needs a stale WASM blob) >
PBKDF2 (native but GPU-friendly). PBKDF2's only real advantages are FIPS
alignment (irrelevant here) and zero dependencies.

---

## 2. Prior art

### 2.1 age (the format)

Spec: [C2SP `age.md`](https://github.com/C2SP/C2SP/blob/main/age.md) (canonical
home of `age-encryption.org/v1`). Relevant mechanics:

- Textual header: version line `age-encryption.org/v1`, one or more recipient
  stanzas (`-> <type> <args...>` + base64 body wrapped at 64 columns), then
  `--- <43-char base64 HMAC-SHA-256>`. **The header MAC keys off
  `HKDF-SHA-256(ikm=file key, salt="", info="header")`, so every header
  parameter — including the KDF work factor — is authenticated.** Hand-rolled
  formats routinely get this wrong.
- File key: 128 bits from the CSPRNG, per file.
- scrypt stanza: `-> scrypt <b64 16-byte salt> <logN>`; parameters
  N=2^logN, r=8, p=1, dkLen=32; salt is domain-separated with the label
  `age-encryption.org/v1/scrypt`. The wrap key encrypts the file key with
  ChaCha20-Poly1305 and an all-zero 12-byte nonce (safe: the key is unique per
  file). scrypt must be the *only* stanza in a header.
- X25519 stanza: ephemeral share + `HKDF-SHA-256(info="age-encryption.org/v1/X25519")`.
- Payload: `HKDF-SHA-256(ikm=file key, salt=16-byte nonce, info="payload")` →
  ChaCha20-Poly1305 in the **STREAM** construction, 64 KiB chunks, 11-byte
  big-endian counter + 1-byte final flag.
- Armor: strict RFC 7468 PEM, label `AGE ENCRYPTED FILE`, padded standard
  base64, 64-column lines; implementations SHOULD reject non-canonical armor.

Work-factor guardrails in real implementations: the Go `age` library defaults
to **logN=18** (comment: *"1s on a modern machine"*) and refuses to *decrypt*
above logN=22 (*"15s on a modern machine"*)
([scrypt.go](https://github.com/FiloSottile/age/blob/main/scrypt.go)); typage
defaults to 18 and hard-rejects logN>20 on decrypt
([recipients.ts](https://github.com/FiloSottile/typage/blob/main/lib/recipients.ts)).
Stay at 18 to keep both sides happy.

### 2.2 typage / `age-encryption` (the library)

[FiloSottile/typage](https://github.com/FiloSottile/typage) — TypeScript
implementation by age's author.

- npm `age-encryption` **0.3.0**, published **2025-12-29**, BSD-3-Clause,
  92.5 KB unpacked / 21 files, ESM, ES2023.
- Dependencies: `@noble/ciphers ^2.1.1`, `@noble/curves ^2.0.1`,
  `@noble/hashes ^2.0.1`, `@noble/post-quantum ^0.5.3`, `@scure/base ^2.0.0`.
  All zero-external-dependency, MIT, and audited: Cure53 audited noble-hashes
  1.0.0 (Jan 2022) and noble-ciphers/curves 1.0.0 (Sep 2024); 2.2.0 carries an
  April 2026 self-audit
  ([hashes](https://github.com/paulmillr/noble-hashes#security),
  [ciphers](https://github.com/paulmillr/noble-ciphers#security)).
  No GitHub advisories for any of them (advisory-database search, 2026-07-31).
- Explicitly supports "Node.js 20+, **Bun**, Deno, and all recent browsers" and
  uses WebCrypto when available. It even carries a Bun-specific workaround —
  Bun implements `importKey` for X25519 but not `deriveBits`
  ([oven-sh/bun#20148](https://github.com/oven-sh/bun/issues/20148)) — with an
  automatic fallback to noble, which matters if any bun-side CLI helper reuses
  the same code.
- API surface used below: `generateIdentity()`, `identityToRecipient()`,
  `new Encrypter()` (`addRecipient`, `setPassphrase`, `setScryptWorkFactor`),
  `new Decrypter()` (`addIdentity`, `addPassphrase`), `armor.encode/decode`,
  plus **`CryptoKey` identities** (`{name:"X25519"}`, `deriveBits`,
  non-extractable) and `generateHybridIdentity()` for ML-KEM768+X25519
  post-quantum hybrid keys.
- Caveat: 0.x version, single primary maintainer. Mitigated by the fact that the
  *format* is specified and implemented by `age` (Go) and `rage` (Rust) — a dead
  library never means unrecoverable data.

### 2.3 Obsidian plugins

- **Meld Encrypt** ([repo](https://github.com/meld-cp/obsidian-encrypt), v2.4.5,
  2025-07-12) — current in-place scheme (`CryptoHelper2304`, source read
  2026-07-31): WebCrypto **PBKDF2-SHA-512, 210,000 iterations**, 16-byte salt,
  16-byte IV, **AES-256-GCM**, output `iv||salt||ct` base64'd behind an inline
  `%%🔐β ` marker (a markdown comment, so it hides in preview). Notable design
  bits worth copying: an explicit **version prefix per scheme** with a
  `CryptoHelperFactory` mapping version → parameters (clean migration story),
  and a `SessionPasswordService` with configurable scope (per-file / per-folder
  / per-vault) and an auto-expire timer. Notable bits worth *not* copying:
  210k SHA-512 iterations is below OWASP's 220k for SHA-512 and far below what
  a memory-hard KDF buys; the parameters are implicit in the version prefix
  rather than authenticated; the README concedes the scheme is unaudited; and
  emoji-in-comment markers are hostile to non-Obsidian tooling.
- **Age Encrypt** ([Mr-1311/obsidian-age-encrypt](https://github.com/Mr-1311/obsidian-age-encrypt),
  updated 2025-08) — stores age PEM armor inside a fenced code block with info
  string `age`, passphrase (scrypt) recipient, decrypted content held in memory
  only, and advertises `age -d` CLI compatibility as a feature. This is almost
  exactly the shape recommended below; the difference is that it uses a
  passphrase recipient per block (see §3 for why that's the wrong choice at
  scale).
- **OpenPGP armor** — the ancestor of age's armor (BEGIN/END + base64 + CRC24).
  Worth borrowing only the idea; OpenPGP.js is 6.3.1 (2026-06-04) and LGPL-3.0+,
  which is a heavier license and a much larger attack surface for what amounts
  to symmetric passphrase encryption.

---

## 3. Why per-block passphrase KDF is the wrong default

The obvious design — every ```` ```secret ```` block carries its own salt and is
derived straight from the passphrase — has four concrete failures:

1. **Unlock cost scales with block count.** A note with 8 secret blocks costs
   8 × ~400 ms–1 s of scrypt (or 8 × 600k PBKDF2). Each block has a distinct
   salt by construction, so nothing is cacheable.
2. **Passphrase rotation rewrites the whole corpus.** Every block must be
   decrypted and re-encrypted, producing one enormous commit, requiring every
   block to be reachable and correct, and leaving no safe partial state.
3. **No write-while-locked.** Creating a new secret requires the passphrase in
   memory.
4. **Only one credential, ever.** No second recipient (hardware key, backup key,
   recovery key) without re-encrypting everything.

Wrapping a **vault key** fixes all four: blocks are encrypted to an X25519
*recipient* (public, committable, cheap — no KDF), and the corresponding
*identity* (private key) is stored once, encrypted under the passphrase with the
expensive KDF. Unlock = one scrypt run per session, regardless of how many
blocks are opened. Rotation = rewrite one ~500-byte file. Adding a hardware
key/passkey later = re-encrypt one file. And because the recipient is public, the
app can create and encrypt new secret blocks while locked.

The cost is one extra concept (a keyring file in the repo) and one extra step in
the CLI recovery recipe. Worth it.

---

## 4. Block format

### 4.1 On-disk shape

````markdown
```age
-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB0QXVkQmNwZ3ZzYnNRZDJP
WlFId3hyeFNmRS9SdUVUTkFhY1FXSno5VUFBClNOSWhEbnhoK21TaEs3SWRGdklw
OW9pdlBZbDg3SEVSQ1FZZHBvUS90YjgKLS0tIGRCVXNNWmdJS0ZkNlNZbStPZWh4
N2FBNUJZdTFxMmYwVTEzUWwvTFVNeUkKrNZnrZjMlXvoCHz0FUS/bp9129XtSV1Q
2twDjjAOwgBtBYoji9gKWgOG4w==
-----END AGE ENCRYPTED FILE-----
```
````

Rules:

- **Info string is exactly `age`.** No metadata, no hint, no label in the fence —
  fence info strings are plaintext in git and searchable. A human-readable label
  belongs in ordinary markdown *above* the block, chosen by the user.
- **Fence is three backticks at column 0.** Base64 and PEM lines can never
  contain a backtick, so the body can never break out of the fence. Armor lines
  are ≤ 64 chars, so no wrapping/formatter reflow risk.
- **No versioned header of our own.** `age-encryption.org/v1` is inside the
  armor, and any future format change is a new recipient stanza type or a new
  spec version — self-describing, and authenticated by the header MAC.
- **Prefer top-level blocks.** Inside a list item the block must carry the list's
  indentation; the lossless round-trip contract
  ([ticket 01](../tickets/01-editor-paradigm.md)) must treat the fence as a
  verbatim-preserved node including indentation.

### 4.2 Round-trip and git behaviour

- CommonMark treats fenced-code content as literal text — no escaping, no
  entity mangling, no smart quotes. This is the single safest container in
  markdown.
- **Byte-stability rule (critical):** the editor's secret-block node stores the
  *armored source string* as its source of truth, plus an optional transient
  plaintext when revealed. The serializer emits the stored armor **byte for
  byte** unless the plaintext was actually modified. Without this rule, every
  open-and-save re-encrypts (fresh file key, fresh nonces ⇒ completely different
  ciphertext) and every save produces a garbage git diff.
- **Merges:** ciphertext changes wholesale on every re-encrypt, so a line-level
  three-way merge inside an armor block always produces an undecryptable
  Frankenstein. Sync policy ([ticket 14](../tickets/14-grilling-sync-policy.md))
  must treat a conflicted secret block as **choose-a-side, never merge**, and
  the app must loudly flag any `age` fence whose body fails armor parsing or MAC
  verification.

### 4.3 CLI escape hatch

The whole point of using a standard format — recovery without the app, from vim
or a shell, which matters because notes are edited outside the app:

```sh
# one-off: unwrap the vault identity (prompts for the passphrase)
age -d .znotes/identity.age > /tmp/id.txt && chmod 600 /tmp/id.txt

# decrypt a block: paste the armor on stdin, never write plaintext to disk
age -d -i /tmp/id.txt | less

# or, no temp file at all (bash/zsh process substitution)
age -d -i <(age -d .znotes/identity.age) < block.age | less
```

---

## 5. Key lifecycle

### 5.1 Files in the repo

| Path | Contents | Committed? |
|---|---|---|
| `.znotes/vault.pub` | `age1...` recipient (X25519 public key), plaintext | yes |
| `.znotes/identity.age` | age file, **scrypt recipient, logN=18**, body = the `AGE-SECRET-KEY-1...` identity string | yes |
| `.znotes/vault.json` | key id, created-at, algorithm tag, optional list of extra recipients | yes |

Everything needed to decrypt is in the repo except the passphrase. That is the
intended property: clone + passphrase = full recovery.

### 5.2 In-memory handling

- The passphrase string is passed to scrypt and then dropped. Never stored,
  never echoed, never sent anywhere. (JS strings are immutable and cannot be
  zeroed — noble's README is blunt about this; accept it as a boundary.)
- The unwrapped identity is imported as a **non-extractable `CryptoKey`**
  (`crypto.subtle.importKey("raw", raw, {name:"X25519"}, false, ["deriveBits"])`)
  and passed to typage, which accepts `CryptoKey` identities. Raw scalar bytes
  are dropped immediately after import. Post-import, even a full main-thread
  compromise cannot exfiltrate the key material itself.
- **All crypto lives in a dedicated Web Worker.** Two wins: (a) scrypt is
  synchronous in noble/typage and would otherwise freeze the UI for ~0.5–1 s;
  (b) key material never enters the main-thread heap. The worker's message API
  is deliberately narrow: `unlock(passphrase)`, `lock()`, `decrypt(armor)`,
  `encrypt(plaintext)`, `status()`.
- **Never** `sessionStorage` / `localStorage` / `IndexedDB` for the passphrase or
  the identity. `sessionStorage` is readable by any script on the origin, is
  persisted by the browser, and survives reloads — it converts a transient XSS
  into permanent key compromise. Losing the key on reload is the correct
  trade-off for a local single-user app.
- Auto-lock defaults: **15 min idle**, plus lock on `pagehide`, plus lock after
  the tab has been hidden for 5 min, plus a hard session cap of 8 h, plus an
  explicit Lock command (and a `BroadcastChannel` message so every tab locks
  together — broadcast the *lock*, never the key).
- Locking while a revealed block has unsaved edits: re-encrypt first, then wipe.
  Never discard silently, never persist plaintext to await unlock.

### 5.3 Passphrase change and key rotation

Two distinct operations, and they must be distinct in the UI:

- **Change passphrase** (routine): re-run scrypt with a fresh 16-byte salt,
  rewrite `.znotes/identity.age`. Notes are untouched; one small commit. Old
  copies of the file in git history remain decryptable with the *old*
  passphrase — this is inherent to git and must be stated in the UI.
- **Rotate vault key** (after suspected compromise): generate a new identity,
  decrypt and re-encrypt every `age` block, rewrite `vault.pub` /
  `identity.age`. Requires a full unlock and a corpus-wide pass; the old key
  still decrypts everything in git history, so genuine compromise also means
  rotating the underlying secrets themselves. Say so explicitly.

### 5.4 Passphrase strength

scrypt at logN=18 costs an attacker roughly 1 s of CPU + 256 MiB per guess, but
that is a constant factor. Entropy carries the load: require a **generated
passphrase of ≥ 6 diceware words (~77 bits)**, offer a generator, and refuse
anything under ~60 bits of estimated entropy. age's own docs use 10-word
passphrases in examples.

---

## 6. Leak-surface audit

The one rule that kills most of the class: **plaintext exists only inside the
crypto worker and the DOM node of a block the user explicitly revealed. Every
persistence, indexing, sync and network path reads from the *stored markdown*,
which contains armor only.**

| Sink | Risk | Rule |
|---|---|---|
| **Disk / git** | plaintext committed | Serializer emits stored armor byte-for-byte; re-encrypt only on dirty plaintext (§4.2). Optional pre-commit lint: flag any `age` fence whose body isn't valid armor — that's plaintext that leaked into a secret block. |
| **Autosave** | autosave fires while a block is revealed | Autosave serializes the *document model*, whose secret nodes hold armor. Add a hard invariant + unit test: the save payload for a secret node is always `/^-----BEGIN AGE ENCRYPTED FILE-----/`. Revealed-and-edited ⇒ re-encrypt in the worker *before* the save payload is built. **Autosave sends ciphertext only.** |
| **SQLite / FTS index** | plaintext indexed, and FTS5 shadow tables + WAL + temp files keep copies | The indexer consumes the same stored markdown. Strip `age` blocks before tokenizing and index a fixed placeholder token (e.g. `⟦secret⟧`) plus the block's ordinal, so search can answer "which notes contain secrets" without content. Don't index the armor either (useless tokens, index bloat, ciphertext-at-rest in a second place). |
| **Server / bun backend** | plaintext in request bodies or logs | Structural: there is **no API endpoint that accepts plaintext**. The write endpoint takes the markdown-as-stored. Disable request-body logging on file write/read routes; don't log armor either. |
| **AI endpoint** | highest-value leak — whatever the client sends leaves the machine | Redact **client-side, at context-assembly time, on the AST**: replace each `age` block with `[encrypted secret block redacted]`. Context builders read from stored markdown, never from the rendered/revealed view — the revealed plaintext lives in the worker + one DOM node and is never a context source. There must be no "include decrypted secret" affordance at all. Defence in depth: a server-side pass-through filter on the AI proxy that refuses any payload containing `BEGIN AGE ENCRYPTED FILE` (cheap canary — the presence of armor in an AI payload means the redactor failed). |
| **AI chat history** | user pastes a secret into chat; history persists to sqlite | Out of scope here but flag to [ticket 16](../tickets/16-grilling-ai-interaction.md): chat storage must be excluded from FTS and ideally encrypted to the vault recipient too. |
| **Editor undo stack / drafts** | plaintext in a persisted draft | Undo history stays in memory (fine); **no** localStorage draft persistence or crash-recovery snapshot may include a revealed block. |
| **DOM-adjacent services** | spellcheck/autocorrect/Grammarly ship text to remote servers | On the reveal editor: `spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" data-gramm="false" data-enable-grammarly="false"`. |
| **Clipboard** | copy-secret is a real need | `navigator.clipboard.writeText` + best-effort clear after 30 s + a visible countdown. Clipboard managers are outside the boundary; say so. |
| **Raw HTML in notes** | a note containing `<script>` = XSS = key theft while unlocked | Renderer must not execute raw HTML — strict allowlist sanitization, or no raw HTML at all. This is a hard requirement, not a preference. |
| **Secure context** | `crypto.subtle` is undefined without one | `http://localhost` / `http://127.0.0.1` / `http://*.localhost` are potentially-trustworthy origins ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)); `http://192.168.x.x` is **not**. Any LAN/mobile exposure ([ticket 13](../tickets/13-grilling-exposure-auth.md)) needs real TLS (mkcert or a tunnel) or the crypto simply doesn't exist in the client. |
| **External CLI use** | user decrypts to a temp file in vim/shell | Document `age -d ... \| less`; `.gitignore` obvious plaintext scratch names; never have the app write a plaintext temp file for any reason. |

---

## 7. Recommendation

### 7.1 The scheme

**"age-in-a-fence", X25519 vault key with a passphrase-wrapped keyring.**

Encrypting a region:

1. Load `.znotes/vault.pub` (recipient — available whether or not the vault is
   unlocked).
2. `new Encrypter(); e.addRecipient(recipient); const ct = await e.encrypt(plaintext)`
3. `age.armor.encode(ct)` → drop into a ```` ```age ```` fence, replacing the
   selected region.

Decrypting: unlock once per session (scrypt over `.znotes/identity.age`), import
the identity as a non-extractable `CryptoKey`, then
`d.addIdentity(key); await d.decrypt(age.armor.decode(armor), "text")` per block
— no KDF, sub-millisecond.

### 7.2 Concrete parameters

| Parameter | Value | Fixed by |
|---|---|---|
| Library | `age-encryption` (typage) **0.3.0**, BSD-3-Clause, ESM, 92.5 KB unpacked | pin exact version + lockfile; audit noble transitive deps on upgrade |
| Format | age v1 (`age-encryption.org/v1`), strict RFC 7468 PEM armor, label `AGE ENCRYPTED FILE`, 64-col base64 | C2SP spec |
| Container | fenced code block, info string exactly `age`, three backticks, no indentation | this doc §4.1 |
| Per-block key wrap | **X25519** to the vault recipient; ephemeral share; `HKDF-SHA-256`, info `age-encryption.org/v1/X25519` | age spec |
| Per-block payload | 128-bit file key (CSPRNG) → `HKDF-SHA-256(salt=16-byte nonce, info="payload")` → **ChaCha20-Poly1305, STREAM, 64 KiB chunks** | age spec |
| Header integrity | HMAC-SHA-256 over the header, key `HKDF-SHA-256(file key, info="header")` — authenticates all parameters | age spec |
| Keyring wrap | age file with **scrypt recipient, logN=18** (N=262144, r=8, p=1, dkLen=32), 16-byte CSPRNG salt, label `age-encryption.org/v1/scrypt`, ChaCha20-Poly1305 wrap | typage default; matches Go `age` default; under both decrypt caps (typage ≤20, Go ≤22) |
| Unlock cost | ~0.4–1 s, ~256 MiB, once per session, **in a Web Worker** | measured: noble scrypt N=2^18 = 400 ms/op |
| Passphrase policy | ≥ 6 diceware words (~77 bits), generator offered, <60 bits rejected | this doc §5.4 |
| Key storage | non-extractable `CryptoKey` (X25519, `deriveBits`) inside the crypto worker; nothing in web storage | this doc §5.2 |
| Auto-lock | 15 min idle · 5 min hidden · `pagehide` · 8 h hard cap · manual lock broadcast to all tabs | this doc §5.2 |
| Optional PQ | `generateHybridIdentity()` (ML-KEM768 + X25519) as a settings flag for a repo pushed to a remote; requires age ≥ 1.3 for CLI decrypt | typage README |

### 7.3 Threat-model boundaries

**Protects against:** anyone with read access to the git repo or the remote
(GitHub, backups, a stolen laptop *while locked*), the z-notes bun server
itself, server logs, the sqlite index, and the AI provider. Offline brute force
is bounded by scrypt(2^18) × passphrase entropy.

**Does not protect against:** a compromised machine while the vault is unlocked
(keyloggers, memory scraping, malicious browser extensions reading the DOM);
XSS inside the app while unlocked (hence the no-raw-HTML requirement); anyone
who learns the passphrase; and **git history** — old ciphertext stays
decryptable by the key that made it, so rotating the vault key does not
retroactively protect anything, only rotating the underlying secrets does.

**Metadata it leaks by design:** which notes contain secrets, how many blocks,
where they sit in the document, approximately how long each plaintext is (armor
length ≈ plaintext length + ~200 bytes), and when each secret last changed
(commit history). Length hiding via padding is possible but would surface as
padding bytes in `age -d` output, breaking the clean CLI story — recommend
accepting the leak and documenting it.

### 7.4 Fallback if the dependency is rejected

If the "vetted dependencies" review
([ticket 05](../tickets/05-frontend-deps-policy.md)) rejects a 0.x library, the
zero-dependency alternative is pure WebCrypto — but implement it with the same
architecture (vault key + passphrase-wrapped keyring), only swapping primitives:

````markdown
```secret
znotes/v1 kdf=pbkdf2-sha256 i=600000 s=<b64 16B salt> n=<b64 12B iv>
<base64 ciphertext, wrapped at 76 cols>
```
````

- PBKDF2-HMAC-SHA256, **600,000** iterations (OWASP), 16-byte salt →
  AES-256-GCM, 12-byte random IV, 128-bit tag.
- **The entire header line MUST be passed as GCM `additionalData`.** Otherwise
  the iteration count and salt are unauthenticated and an attacker with repo
  write access can downgrade `i=600000` to `i=1`. This is the mistake the age
  header MAC prevents for free, and the reason to prefer age.
- Accept the losses: no CLI recovery, no memory-hard KDF, a bespoke format to
  test and version forever.

Argon2id is **not** recommended in either path: no native support and no
credible near-term standardization, both mature WASM builds unmaintained since
2023–2024, `p>1` meaningless without cross-origin isolation, and the pure-JS
implementation is both slow and outside its library's audit scope — while scrypt
at 2× the OWASP memory recommendation is already available inside an audited,
actively maintained, zero-WASM dependency the design needs anyway.

---

## 8. Open questions for downstream tickets

- **[13 exposure/auth]** LAN/mobile access requires HTTPS or the client has no
  `crypto.subtle` at all. Decide TLS strategy before promising mobile clients.
- **[14 sync policy]** Conflicted `age` block ⇒ choose-a-side UI; define where
  the discarded side goes (a `.conflict` sidecar? a git stash?).
- **[15 data model]** FTS schema needs an explicit "has secrets" boolean +
  placeholder-token strategy so search can locate notes without indexing content.
- **[16 AI interaction]** Redaction placeholder wording and whether chat history
  is itself encrypted to the vault recipient.
- **Benchmark to run during implementation:** actual scrypt(2^18) wall time in
  the target browser on the target machine (noble's 400 ms is a bench-machine
  figure); if it exceeds ~1.5 s, drop to logN=17 (128 MiB, still ≥ OWASP scrypt
  minimum) rather than switching KDF.

## Sources

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [C2SP — age v1 specification](https://github.com/C2SP/C2SP/blob/main/age.md)
- [FiloSottile/age — scrypt.go (defaults and work-factor caps)](https://github.com/FiloSottile/age/blob/main/scrypt.go)
- [FiloSottile/typage — README](https://github.com/FiloSottile/typage) and [recipients.ts](https://github.com/FiloSottile/typage/blob/main/lib/recipients.ts)
- [@noble/hashes — README, benchmarks, security/audits](https://github.com/paulmillr/noble-hashes)
- [@noble/ciphers — security/audits](https://github.com/paulmillr/noble-ciphers)
- [WICG — Modern Algorithms in the Web Cryptography API (draft, 29 Jun 2026)](https://wicg.github.io/webcrypto-modern-algos/)
- [Bitwarden — Encryption Key Derivation (KDF defaults)](https://bitwarden.com/help/kdf-algorithms/)
- [meld-cp/obsidian-encrypt — CryptoHelper2304, CryptoHelperFactory, SessionPasswordService](https://github.com/meld-cp/obsidian-encrypt)
- [Mr-1311/obsidian-age-encrypt](https://github.com/Mr-1311/obsidian-age-encrypt)
- [openpgpjs/argon2id](https://github.com/openpgpjs/argon2id) · [Daninet/hash-wasm](https://github.com/Daninet/hash-wasm) · [antelle/argon2-browser](https://github.com/antelle/argon2-browser)
- [MDN — Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) · [MDN — Crypto.subtle](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)
- [Igalia — Secure Curves in the Web Platform (X25519/Ed25519 shipping status)](https://blogs.igalia.com/jfernandez/2025/02/28/can-i-use-secure-curves-in-the-web-platform/)
- npm registry metadata for `age-encryption`, `hash-wasm`, `argon2id`, `argon2-browser`, `@noble/*` (queried 2026-07-31)
