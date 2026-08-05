---
id: 3
title: Secrets model
label: wayfinder:grilling
status: closed
assignee: z
blocked-by: []
---

## Question

How should private keys/secrets inside notes be protected, given: no external services, no data leakage, and everything committable to the git repo?

## Resolution

**Inline encrypted blocks.** A region marked secret is encrypted client-side (WebCrypto, passphrase-derived key) into an armored ```` ```secret ```` block inside the markdown. Ciphertext is what's saved to disk and committed; the server and git never see plaintext. The UI offers click-to-decrypt with the passphrase held in memory/sessionStorage.

Exact KDF/cipher/armor format and leak-surface handling (search index, sqlite caches, AI context redaction) are delegated to the [secrets crypto research ticket](09-research-secrets-crypto.md).

Decided with z during charting, 2026-07-31.
