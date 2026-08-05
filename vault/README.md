# Dev vault

This is the throwaway vault `bun dev` opens (`ZNOTES_VAULT=./vault`). Nothing in
it is private, and nothing in it should ever be treated as if it were.

## The age keyring is REAL

`.znotes/vault.pub` and `.znotes/identity.age` hold a genuine age v1 X25519 key
pair, wrapped with scrypt at logN=18 exactly as SPEC §6 specifies — so
`keys/cloud-keys.md` demonstrates a true end-to-end unlock rather than a mock.

The dev passphrase is, in full:

    correct horse battery staple z-notes

**Dev only.** It is written down here on purpose because this key protects
nothing but three fake AWS/Hetzner sample lines. A real vault's passphrase
exists nowhere but in your head — there is no recovery path, by design.

Recovery without the app, which is the whole point of using a standard format:

```sh
age -d -i <(age -d .znotes/identity.age) < block.age | less
```

## Byte stability

Revealing a secret block and locking it again must leave `keys/cloud-keys.md`
byte-identical (research §4.2). Re-encryption happens only when the revealed
plaintext was actually edited; anything else would rewrite the ciphertext on
every save and fill git with unreadable diffs.
