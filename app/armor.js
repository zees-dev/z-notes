/* ============================================================
   armor.js — the shape of an age block, shared by every reader of one.

   Three tiny pure functions, in their own module for one reason: the write
   path and the read path MUST agree about what an ```age fence body is. They
   did not. `indentArmor` re-applied a list item's indentation on re-encrypt
   (research §4.1, "Inside a list item the block must carry the list's
   indentation") while the read path handed the indented text straight to
   `age.armor.decode`, which rejects leading whitespace — so an indented block
   could be written but never read back.

   `isArmorShape` is the client-side twin of vault.ts `isArmor`: deliberately
   NOT a parse. It answers one question — "could this plausibly be age armor?"
   — so the renderer can stop certifying a plaintext credential inside an
   ```age fence as "encrypted" (research §4.2 / §6, "flag any age fence whose
   body isn't valid armor — that's plaintext that leaked into a secret block").
   ============================================================ */
"use strict";

export const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
export const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

/** The prefixes a fence can legitimately carry: list indentation and quotes.
    Identical to vault.ts's fence probes, on purpose. */
const PREFIX = /^[ \t>]+/;

/**
 * Strip list/blockquote prefixes off every armor line. The document keeps the
 * indented bytes (they are the block's identity and its byte-stability
 * contract); only the copy handed to the decoder is dedented.
 */
export function dedentArmor(text) {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .map((l) => l.replace(PREFIX, ""))
    .join("\n");
}

/** Re-apply an indent to freshly produced armor (the inverse of dedentArmor). */
export function indentArmor(armor, indent) {
  const body = String(armor).replace(/\n+$/, "");
  return indent ? body.split("\n").map((l) => indent + l).join("\n") : body;
}

/**
 * Header, footer, and nothing but base64 between them — after dedenting.
 * A body that fails this is NOT ciphertext, and the UI must say so instead of
 * painting a "Locked / encrypted" badge over it.
 */
export function isArmorShape(text) {
  if (typeof text !== "string") return false;
  const lines = dedentArmor(text).trim().split(/\r?\n/);
  if (lines.length < 3) return false;
  if (lines[0].trim() !== ARMOR_BEGIN) return false;
  if (lines[lines.length - 1].trim() !== ARMOR_END) return false;
  for (const l of lines.slice(1, -1)) {
    if (!/^[A-Za-z0-9+/=]*$/.test(l.trim())) return false;
  }
  return true;
}
