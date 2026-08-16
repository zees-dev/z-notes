# 0019 — An explicit file extension is literal

## Status

Accepted, 2026-08-16. Amends the doc definition in
[the product spec](../specs/done/0001-z-notes-v1.md) §5, the tracked-set rule in
[ADR 0017](0017-the-vault-is-bring-your-own.md), and the doc-path rules in the
[HTTP contract](../specs/done/0002-http-api-v0.md).

## Context

Creation had two independent normalizers. The sidebar appended `.md` unless a
name already ended in `.md`, and `DocStore.create` did the same again at the
API boundary. `report.txt` therefore became `report.txt.md`. Removing only
those two suffixes would have been worse: the vault scanner and every doc
operation accepted only `.md`, so the file would be written and then disappear
from the tree, fail its own create response, stay out of search and sync, and
answer 404 when opened.

The vault may be an existing project repository (ADR 0017), where explicit
text-file extensions carry real meaning. A side registry of which files the app
created would contradict files-on-disk as the source of truth and make a fresh
clone see a different vault.

## Decision

**A bare doc name defaults to `.md`; an explicit extension is literal.**

- Extension detection is on the leaf only. `notes` becomes `notes.md`;
  `notes.md`, `notes.txt`, `notes.markdown` and `notes.tar.gz` stay exact. A dot
  in a parent folder does not count. The browser and API apply the same rule.
- A **doc** is now any visible, extension-bearing file whose bytes are valid
  UTF-8. Those files appear in the tree and index and use the existing
  `markdown` JSON field and Raw/Preview surfaces. Preview still applies the
  app's Markdown dialect; the filename does not select a different renderer.
- Dot-prefixed and `@`-prefixed segments remain hidden/reserved. Extensionless
  files and non-UTF-8 files remain opaque payload: they are not readable through
  the doc API, searchable, or sent to the AI relay.
- Folder move, delete and restore continue carrying every file byte-for-byte,
  including opaque payload. Their `moved[]` and doc-change hints list only the
  editable UTF-8 docs that entered or left the index.
- The tracked set follows the same source-of-truth rule: every visible,
  extension-bearing UTF-8 doc plus the committed `.znotes` metadata. A tracked
  text deletion remains managed even though its bytes are no longer on disk;
  binary, extensionless and hidden project payload stays outside app sync.
- A path-qualified wiki-link with an explicit extension resolves that exact
  path. A qualified bare target still defaults to `.md`; bare slug resolution
  remains unique-vault-wide and includes the extension in the slug when it is
  not `.md`. `./` is the exact qualifier for a root path: when `report.txt` and
  `report.txt.md` collide as the same bare slug, `[[./report.txt]]` and
  `[[./report.txt.md]]` name the two docs without ambiguity. Link rewrites use
  that spelling when a root-level collision requires it.

## Consequences

- An explicitly named text file is first-class through create, GET/PUT, tree,
  reconcile, search, backlinks, move, trash/restore and git sync. There is no
  half-created invisible state.
- Bringing an existing repository as a vault exposes all of its visible,
  extension-bearing UTF-8 files to the doc index and AI read context. The
  hidden/non-UTF-8/extensionless boundary is therefore security-relevant and
  stays covered by reconcile and sync tests.
- The API field remains `markdown` for compatibility. It names the editor
  source string, not a promise that the filename ends in `.md`.
- AI-authored create/edit operations remain intentionally `.md`-scoped. This
  decision broadens what the human can view and edit; it does not broaden the
  assistant's mutation surface.
