---
id: 9
title: Research — secrets crypto design (inline encrypted blocks)
label: wayfinder:research
status: closed
assignee: research-subagent (fired 2026-07-31)
blocked-by: []
---

## Question

Design options for the inline encrypted ```secret block scheme, all client-side, no external services:

- KDF: WebCrypto PBKDF2 (iterations?) vs vendored Argon2id WASM — tradeoffs for a passphrase-derived key.
- Cipher/format: AES-256-GCM via WebCrypto; armored block format (versioned header, salt, nonce, base64 body) that survives markdown round-trips and git merges.
- Key lifecycle: passphrase held in memory vs sessionStorage; auto-lock timeout; passphrase change/re-encrypt story.
- **Leak surface audit** — this is the critical part: plaintext must never reach the sqlite search index, server logs, git, autosave payloads (does autosave send ciphertext only?), or the AI endpoint (redaction: secret blocks must be stripped/masked from any context sent to the model).
- Prior art worth borrowing: age, OpenPGP armor, Obsidian encryption plugins.

End with one recommended scheme (concrete: KDF params, cipher, block format) and its threat-model boundaries. Findings file: `wayfinder/research/secrets-crypto.md`

## Resolution

Recommended scheme: **"age-in-a-fence"** — the standard age v1 format (C2SP-specified) in PEM armor inside a fenced code block with info string exactly `age`, produced by the `age-encryption` (typage) TS library, rather than a hand-rolled armor format. Each block is encrypted to an **X25519 vault recipient** (`.znotes/vault.pub`, committed) using a fresh 128-bit file key with ChaCha20-Poly1305/STREAM; the vault *identity* is stored once in `.znotes/identity.age`, wrapped under the passphrase with **scrypt logN=18 (N=262144, r=8, p=1)** — the age/typage default, roughly 400 ms and 256 MiB per guess. That indirection means one KDF run per session instead of per block, passphrase rotation rewrites a single ~500-byte file instead of the whole corpus, and new secret blocks can be written while locked. Argon2id was rejected: no native WebCrypto support (only a non-normative WICG draft), both mature WASM builds unmaintained since 2023–2024, `p>1` meaningless without cross-origin isolation, and the pure-JS build is slow and outside its library's audit scope — while scrypt at 2× OWASP's memory recommendation ships inside audited noble dependencies with no WASM blob. The leak-surface rule is structural: plaintext exists only inside a dedicated crypto Web Worker (key held as a non-extractable `CryptoKey`, nothing in sessionStorage) and the DOM node of a revealed block, while autosave, the sqlite/FTS indexer, the server API and the AI context builder all read from the stored markdown, which contains armor only — plus AST-level client-side redaction and a `BEGIN AGE ENCRYPTED FILE` canary filter on the AI proxy.

**Key risk:** the dependency is `age-encryption` 0.x (0.3.0, Dec 2025, single primary maintainer), so API churn on upgrade is likely — mitigated by the fact that the *format* is spec'd and independently implemented by `age` (Go) and `rage` (Rust), so data stays recoverable via `age -d -i <(age -d .znotes/identity.age)` even if the library dies. Secondary risks: git history keeps old ciphertext decryptable by the key that made it (rotating the vault key protects nothing retroactively), and `crypto.subtle` requires a secure context, so any LAN/mobile exposure needs real TLS or the client cannot decrypt at all.

Full findings, comparisons, parameter tables and the zero-dependency PBKDF2/AES-GCM fallback: [../research/secrets-crypto.md](../research/secrets-crypto.md)
