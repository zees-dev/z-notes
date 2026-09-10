# 0004 — Secrets are age v1 blocks, encrypted and decrypted only in the browser

**Status:** accepted · 2026-07-31 (recorded 2026-08-07 at retrofit)

## Context

Notes carry credentials, are committed to git, and pass through a server, an
index, an AI relay and a remote — none of which may ever see plaintext.
Hand-rolled crypto was ruled out.

## Decision

- Inline secrets are fenced ```age blocks holding **age v1** armor
  (C2SP-specified), produced by the `age-encryption` (typage) library in the
  browser's crypto worker — the plaintext jail.
- One X25519 **vault key** encrypts blocks; the identity itself is
  passphrase-wrapped with **scrypt logN=18** and committed as the keyring
  (`.znotes/identity.age` + `vault.pub`).
- The server handles ciphertext only: shape validation, no key derivation, no
  passphrase, ever. Structurally enforced: nothing in `server/` may import
  `age-encryption` (`tests/secrets.test.ts` asserts it on the source).
- Everything indexed, searched, or sent upstream is **redacted** first; the
  armor canary in the AI relay refuses any payload where redaction failed.

Full design + research: [specs/done/0004-secrets-client-side-crypto.md](../specs/done/0004-secrets-client-side-crypto.md).

## Consequences

Secrets only function in a secure context (HTTPS/localhost) — over plain HTTP
they degrade to locked-with-badge. Changing KDF parameters or format requires
a new spec + migration; losing the passphrase loses the secrets, by design.
