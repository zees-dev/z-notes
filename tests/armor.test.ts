/* ============================================================
   armor.test.ts — the client's view of an ```age fence body (app/armor.js).

   Two findings live in this file, and both are asymmetries between the WRITE
   path and the READ path:

     1. `indentArmor` re-applied a list item's indentation on re-encrypt
        (research §4.1: "Inside a list item the block must carry the list's
        indentation"), but the read path handed the indented text straight to
        `age.armor.decode`, which rejects leading whitespace. An indented block
        could be written and never read back — the app told the user their
        intact, `age -d`-decryptable data was corrupt.

     2. Nothing checked that a ```age fence body was armor at all, so a
        hand-written fence around a live credential rendered as
        "Secret block · age · x25519 · encrypted / Locked" and was then
        committed and pushed under that badge. Research §4.2/§6: "flag any age
        fence whose body isn't valid armor — that's plaintext that leaked into
        a secret block."

   `isArmorShape` is deliberately the client twin of vault.ts `isArmor`, so both
   are checked against the same corpus here.
   ============================================================ */

import { describe, test, expect } from "bun:test";
import * as age from "age-encryption";
import { dedentArmor, indentArmor, isArmorShape, ARMOR_BEGIN, ARMOR_END } from "../app/armor.js";
import { isArmor } from "../vault";

const REAL = [ARMOR_BEGIN, "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4", "Zt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp", ARMOR_END].join("\n");

describe("dedentArmor — the read path undoes what indentArmor did", () => {
  test("round-trips every prefix a fence can legitimately carry", () => {
    for (const indent of ["", "  ", "    ", "\t", "> ", "  > "]) {
      const indented = indentArmor(REAL, indent);
      if (indent) expect(indented.split("\n")[0].startsWith(indent)).toBe(true);
      expect(`indent=${JSON.stringify(indent)} → ${dedentArmor(indented)}`).toBe(
        `indent=${JSON.stringify(indent)} → ${REAL}`
      );
    }
  });

  test("a REAL age block indented into a list item still decrypts (research §4.1)", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const e = new age.Encrypter();
    e.addRecipient(recipient);
    const armor = age.armor.encode(await e.encrypt("LISTITEMSECRET=yes\n")).trimEnd();

    /* exactly what renderPreview captures for
         - an item with a secret:
           ```age
           …
           ``` */
    const inList = indentArmor(armor, "  ");

    /* the pre-fix behaviour: the indented bytes went to the decoder verbatim */
    expect(() => age.armor.decode(inList + "\n")).toThrow();

    const d = new age.Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(age.armor.decode(dedentArmor(inList) + "\n"), "text")).toBe("LISTITEMSECRET=yes\n");
  }, 20000);

  test("leaves an unindented block byte-identical (byte stability, research §4.2)", () => {
    expect(dedentArmor(REAL)).toBe(REAL);
  });
});

describe("isArmorShape — an ```age fence is not evidence of encryption", () => {
  test("accepts real armor, indented or not", () => {
    for (const indent of ["", "  ", "\t", "> "]) expect(isArmorShape(indentArmor(REAL, indent))).toBe(true);
    expect(isArmorShape(REAL + "\n")).toBe(true);
  });

  test("rejects the plaintext that ends up in hand-written fences", () => {
    const notArmor = [
      "AWS_ACCESS_KEY_ID=AKIAPLAINTEXTLEAK",
      "AWS_ACCESS_KEY_ID=AKIAPLAINTEXTLEAK\nAWS_SECRET_ACCESS_KEY=hunter2",
      "",
      "   ",
      "-----BEGIN AGE ENCRYPTED FILE-----", // header only
      ARMOR_BEGIN + "\nnot base64 at all!\n" + ARMOR_END, // merge Frankenstein
      ARMOR_BEGIN + "\nYWdl\n", // no footer: a truncated block
      "-----BEGIN PGP MESSAGE-----\nYWdl\n-----END PGP MESSAGE-----",
    ];
    for (const body of notArmor) {
      expect(`${JSON.stringify(body.slice(0, 40))} → ${isArmorShape(body)}`).toBe(
        `${JSON.stringify(body.slice(0, 40))} → false`
      );
    }
  });

  test("agrees with the server's isArmor on unindented bodies", () => {
    const corpus = [
      REAL,
      REAL + "\n",
      "AWS_ACCESS_KEY_ID=AKIAPLAINTEXTLEAK",
      ARMOR_BEGIN + "\nnot base64 at all!\n" + ARMOR_END,
      "",
    ];
    for (const body of corpus) {
      expect(`${JSON.stringify(body.slice(0, 30))}: client=${isArmorShape(body)}`).toBe(
        `${JSON.stringify(body.slice(0, 30))}: client=${isArmor(body)}`
      );
    }
  });

  test("non-strings never throw and are never armor", () => {
    for (const v of [null, undefined, 12, {}, []]) expect(isArmorShape(v as any)).toBe(false);
  });
});
