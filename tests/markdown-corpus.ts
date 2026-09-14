import { toBytes } from "./helpers";

interface Golden {
  name: string;
  why: string;
  bytes: Uint8Array;
}

const g = (name: string, why: string, content: string | Uint8Array): Golden => ({
  name,
  why,
  bytes: toBytes(content),
});

const CRLF_TEXT =
  "# CRLF document\r\n" +
  "\r\n" +
  "A file authored on Windows.\r\n" +
  "\r\n" +
  "- item one\r\n" +
  "- item two\r\n";

export const CORPUS: Golden[] = [
  g(
    "corpus/frontmatter.md",
    "YAML frontmatter must survive verbatim, including the --- fences and key order",
    "---\ntitle: Frontmatter survivor\ntags: [notes, spec]\ndate: 2026-08-01\nnested:\n  a: 1\n  b: \"two\"\n---\n\n# Body starts here\n\nText under the frontmatter.\n"
  ),
  g(
    "corpus/setext.md",
    "setext headings must not be rewritten to ATX",
    "Setext H1\n=========\n\nParagraph under an equals-underlined heading.\n\nSetext H2\n---------\n\nMore text, and a thematic break that is not a setext underline:\n\n***\n"
  ),
  g(
    "corpus/ordered-paren.md",
    "`1)` ordered-list delimiters must not be normalised to `1.`",
    "# Ordered lists\n\n1) first\n2) second\n3) third\n\nand the other flavour:\n\n1. alpha\n2. beta\n\nand a list starting at seven:\n\n7) seven\n8) eight\n"
  ),
  g(
    "corpus/hard-tabs.md",
    "hard tabs must not be expanded into spaces",
    "# Tabs\n\n\tindented with one hard tab\n\t\tindented with two hard tabs\n\n- list\n\t- nested by tab\n\ncolumn\tseparated\tby\ttabs\n\n```\n\tliteral tab inside a fence\n```\n"
  ),
  g(
    "corpus/trailing-spaces.md",
    "trailing whitespace (markdown hard line breaks) must not be trimmed",
    "# Trailing whitespace\n\nline with two trailing spaces  \nnext line after a hard break\n\nline with three trailing spaces   \nline with a trailing tab\t\n\n   \n\nthe line above is whitespace-only\n"
  ),
  g(
    "corpus/no-final-newline.md",
    "a missing final newline must not be added",
    "# No final newline\n\nThe last byte of this file is a period."
  ),
  g("corpus/crlf.md", "a Windows CRLF file must stay CRLF end to end", CRLF_TEXT),
  g(
    "corpus/blank-runs.md",
    "3+ consecutive blank lines must not be collapsed — blank-line multiplicity is preserved",
    "# Blank runs\n\nOne blank line above.\n\n\n\nThree blank lines above this paragraph.\n\n\n\n\n\nFive blank lines above this one.\n\n> quote after two blanks\n\n\nlast\n"
  ),
  g(
    "corpus/age-block.md",
    "an armored ```age fence must round-trip untouched — ciphertext is never re-encoded",
    "# Secrets\n\nEverything below is encrypted at rest.\n\n```age\n-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4...\nZt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp\n-----END AGE ENCRYPTED FILE-----\n```\n\ntrailing prose\n"
  ),
  g(
    "corpus/unicode.md",
    "emoji, ZWJ sequences, combining marks, CJK and RTL must survive byte-for-byte",
    "# Unicode 🌍\n\nemoji: 😀 🚀 ✅ 🇸🇪\nZWJ family: 👨‍👩‍👧‍👦\nskin tone: 👋🏽\ncombining: é (e + U+0301) vs é (U+00E9) — these are different byte sequences\ncjk: 日本語のテキスト・中文文本\nrtl: العربية עברית\nmath: ∀x∈ℝ, x² ≥ 0\nnbsp:[ ] zwsp:[​] nnbsp:[ ]\n"
  ),
  g(
    "corpus/bom.md",
    "a UTF-8 BOM written by an external editor must not be stripped",
    "﻿# BOM document\n\nThe first three bytes are EF BB BF.\n"
  ),
  g("corpus/empty.md", "a zero-byte file must stay zero bytes", ""),
  g("corpus/only-newline.md", "a file that is exactly one newline must stay exactly one newline", "\n"),
  g(
    "corpus/mixed-endings.md",
    "a file mixing LF and CRLF must keep each line ending exactly where it was",
    "# Mixed\r\n\r\nCRLF line\r\nLF line\nCRLF line again\r\n\nfinal LF line\n"
  ),
];
