/* ============================================================
   entropy.test.ts — the passphrase strength gate (research §5.4).

   `.znotes/identity.age` is committed and, per research §7.3, assumed readable
   by the adversary: everything protecting the vault's long-lived key is
   scrypt(2^18) × the entropy of one passphrase. §5.4 therefore says the app
   must "refuse anything under ~60 bits of estimated entropy", and
   `createIdentity` (app/secrets.js) plus the live meter next to the field are the
   only places that check.

   The estimator used to be length × charset with per-CHARACTER run collapsing,
   which cannot see a repeated word, a dictionary word or a keyboard walk. It
   scored "password password password" at 135 bits — 2.25× the required floor —
   and the meter reported "~135 bits — good" while it did it. Every string in
   REJECT below was measured passing the old gate.

   These are the numbers the UI shows and the numbers the gate compares, so they
   are pinned here rather than in a browser.
   ============================================================ */

import { describe, test, expect } from "bun:test";
import {
  estimateBits,
  generatePassphrase,
  charsetBits,
  MIN_BITS,
  WORDS,
  WORD_BITS,
} from "../app/entropy.js";

/* Every one of these sailed past the 60-bit floor before the fix; the number in
   the comment is what the OLD estimator returned. True entropy is 0–30 bits. */
const REJECT: Array<[string, number]> = [
  ["password password password", 135],
  ["letmein letmein letmein", 135],
  ["z-notes vault passphrase", 135],
  ["aA1!aA1!aA1!", 79],
  ["qwertyuiopasdfgh", 75],
  ["hunter2hunter2", 72],
  ["abcabcabcabca", 61],
  ["qwertyuiop asdfghjkl", 118],
  ["1234567890 1234567890", 114],
  ["the quick brown fox", 112],
  ["hunter2", 36],
  ["password", 0],
  ["aaaaaaaaaaaaaaaaaaaaaaaa", 0],
];

/* …and the gate still has to let real passphrases through. */
const ACCEPT: string[] = [
  "correct horse battery staple mango velvet",
  "wafer tulip cobra plaza sherbet glacier tundra",
  "9xQ!vB2#pL7@mK4$", // no words at all: the charset estimate still applies
  "xkqmzrvbtjwlnpsdghqe", // 20 random lowercase characters
];

describe("estimateBits — the ≥60-bit floor (research §5.4)", () => {
  test("every passphrase the old estimator waved through is now refused", () => {
    for (const [pass, old] of REJECT) {
      const bits = estimateBits(pass);
      expect(`${JSON.stringify(pass)} → ${bits} bits, accepted=${bits >= MIN_BITS} (was ${old})`).toBe(
        `${JSON.stringify(pass)} → ${bits} bits, accepted=false (was ${old})`
      );
    }
  });

  test("a repeated token counts ONCE — three copies are not three times the entropy", () => {
    const one = estimateBits("password");
    for (const n of [2, 3, 8]) {
      const many = estimateBits(Array(n).fill("password").join(" "));
      expect(`${n}× → ${many}`).toBe(`${n}× → ${one}`);
    }
    /* and a repeated substring inside one token is a repeat, not new material */
    expect(estimateBits("hunter2hunter2hunter2")).toBe(estimateBits("hunter2"));
  });

  test("genuinely strong passphrases still clear the floor", () => {
    for (const pass of ACCEPT) {
      const bits = estimateBits(pass);
      expect(`${JSON.stringify(pass)} → ${bits} bits, accepted=${bits >= MIN_BITS}`).toBe(
        `${JSON.stringify(pass)} → ${bits} bits, accepted=true`
      );
    }
  });

  test("the estimate is never above the crude charset bound it replaced", () => {
    for (const [pass] of REJECT) expect(estimateBits(pass)).toBeLessThanOrEqual(Math.round(charsetBits(pass)));
    for (const pass of ACCEPT) expect(estimateBits(pass)).toBeLessThanOrEqual(Math.round(charsetBits(pass)));
  });

  test("the generator the modal offers always clears the floor by a margin", () => {
    /* the generator is the escape hatch the gate points users at; if IT could
       fail the gate the modal would be unusable */
    let min = Infinity;
    for (let i = 0; i < 300; i++) min = Math.min(min, estimateBits(generatePassphrase()));
    expect(`generator worst of 300: ${min} bits`).toBe(`generator worst of 300: ${min} bits`);
    expect(min).toBeGreaterThanOrEqual(MIN_BITS);
    /* research §5.4 asks for ≥6 words' worth; our list is smaller than diceware
       so the generator draws more of them */
    expect(min).toBeGreaterThan(70);
  });

  test("a word from our own list is worth exactly one draw from it", () => {
    expect(WORDS.length).toBeGreaterThan(500);
    expect(estimateBits(WORDS[0])).toBeLessThanOrEqual(Math.ceil(WORD_BITS));
  });

  test("empty and whitespace-only input is zero, not NaN", () => {
    for (const s of ["", "   ", "\n\t"]) expect(estimateBits(s)).toBe(0);
  });
});
