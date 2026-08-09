# 0006 — The passphrase strength floor is advice, not a gate

## Status

Accepted, 2026-08-08. Supersedes the passphrase-policy row of
[spec 0004](../specs/done/0004-secrets-client-side-crypto.md) §5.4, which is an
archive of how it shipped.

## Context

`app/entropy.js` scores a passphrase with a conservative, word-aware estimate
and exports `MIN_BITS = 60`. Two places refused anything under it: creating the
vault identity (`createIdentity`) and changing its passphrase
(`changeVaultPassphrase`). The refusal was the only enforced security control
the client had, and the arithmetic behind it has not changed:
`.znotes/identity.age` is committed to git and, per research §7.3, assumed
readable by the adversary, so what protects the vault is exactly
scrypt(2^18) × the entropy of that string.

What the floor did NOT do was make anyone's vault stronger. It made the vault
owner — a single user, on their own machine, with a Generate button one click
away — argue with a modal about a passphrase only they will ever type, in an
app whose every other destructive-but-deliberate act (delete, discard a buffer,
recreate a deleted doc) is theirs to make.

## Decision

**Measure, show, do not refuse.**

- `estimateBits` is unchanged and still runs on every keystroke;
  `entropy.test.ts` still holds it to its conservative bound. `MIN_BITS` stays,
  as the line between the words *weak* and *good* in the readout.
- The only refusals left are the ones the operation cannot proceed without: an
  empty passphrase, a mismatched confirmation, a wrong current passphrase, and
  a new passphrase equal to the current one.
- A weak passphrase does not wear `bad`. That class means "this cannot be
  submitted" everywhere else in the app, and it now can be. The readout points
  at Generate instead of at a floor.
- Nothing about the crypto moves: same age v1 blocks, same scrypt logN=18, same
  re-wrap semantics, same server that never sees a passphrase (ADR 0004).

## Consequences

- A vault can be created behind `hunter2`. The estimate said so at the time, in
  the field, and the modal still says there is no recovery.
- The strength estimate is now advice with no enforcement behind it, so the
  quality of the estimate matters *less* than it did — but it stays exact,
  because it is the whole basis on which the choice is made.
- Tests changed from "the refusal writes nothing" to "the weak passphrase is
  accepted and the identity really re-wraps"
  (`vaultkey-e2e.test.ts`, `secrets-ui.test.ts`).
