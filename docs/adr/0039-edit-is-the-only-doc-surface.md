# 0039 — Edit is the only doc surface

## Status

Accepted, 2026-09-29. Implements
[spec 0023](../specs/done/0023-edit-is-the-only-doc-surface.md).

Supersedes: [ADR 0013](0013-a-collapsed-caret-makes-x-and-c-take-the-line.md)
(the whole-line clipboard);
[ADR 0027](0027-a-mode-switch-keeps-the-line-you-were-on.md) (there is no mode
switch; the island's measured anchor stays, as the way a re-render keeps the
reader's block where it sat); [ADR 0032](0032-raw-is-a-line-editor.md) (the
line editor); [ADR 0034](0034-the-soft-keyboard-carries-an-editing-bar.md)
(the keybar; Edit's own phone toolbar is untouched); and
[ADR 0036](0036-esc-and-enter-are-a-round-trip.md) (the Esc half ADR 0037 left
standing).

Amends: [ADR 0037](0037-blocknote-edits-docs-markdown-stays-the-file.md) (its
Source bullet, the "Edit source" door and the bundle fallback; the persisted
`preview`/`raw` ids are gone);
[ADR 0038](0038-assets-are-compressed-and-cached-for-a-month.md) (a failed
bundle no longer degrades to Source);
[ADR 0014](0014-file-operations-undo-but-they-ask.md) (the app timeline holds
file operations, agent writes and protected-block edits);
[ADR 0022](0022-asking-before-leaving-edits-is-a-preference.md) (the guard is
Edit's); [ADR 0012](0012-save-state-is-a-statusbar-pip.md) (no mode chip);
[ADR 0008](0008-back-unwinds-layers-on-a-phone.md) (Back has no Source layer);
[ADR 0031](0031-the-agent-gets-the-same-doors.md) (`set_mode` and
`indent_lines` are gone, and `open_doc`/`get_app_state` carry no `mode`); and
[ADR 0033](0033-text-size-is-a-pinch-ladder.md) (the "Raw and Preview at one
size" consequence is moot).

## Context

ADR 0037 made BlockNote the doc editor and kept ADR 0032's line editor beside
it as **Source**: a second surface with its own soft-keyboard bar, statusbar
mode chip, Wrap toggle, ⌘E and ⌥Z, whole-line clipboard, list continuation and
mode anchoring, and a `state.mode === "raw"` branch wherever the shell touched
the doc. The user considers Source a legacy view. Removing it is about fewer
lines and fewer files, with every other behaviour kept.

Four things worked only through Source: creating a secret (encrypt-selection
refused anywhere else), editing a protected block (its "Edit source" door
switched surfaces), the fallback when the editor bundle failed to load, and
the recovery advice when an edit could not be serialised. Each gets the
smallest replacement that keeps the behaviour, not a second editor.

## Decision

- **Edit is the only surface of the open doc.** `app/rawedit.js`,
  `app/keybar.js`, the mode chip, Wrap, ⌘E, ⌥Z and every raw branch in the
  shell, settings, WebMCP tools, CSS and tests are deleted; `state.mode` does
  not exist. ⌘E reaches BlockNote, which spends it on inline code. The exit
  guard stays, as Edit's (`guardExit`).
- **A new secret has one path.** `newSecret()` in `app/secrets.js` runs
  encrypt-selection's vault checks unchanged (disabled, not created,
  orphaned, needing repair, recipient drift), asks for the plaintext in the
  confirm dialog's one text field (`#cfField`), encrypts it in the worker and
  inserts a secret block at the cursor (the island's `insertSecret`). The
  slash menu's "Secret", the topbar lock (`#encBtn` → `new-secret`) and ⌘⇧E
  all call it. Every way the dialog closes empties the field, so the
  plaintext is in the page only while the dialog is up and never in the file,
  `doc.markdown`, the editor model, a request or the clipboard. It stays a
  human gesture: no tool creates a secret (ADR 0031).
- **A protected block is edited in place.** Its "Edit" button swaps the
  block's view for a textarea holding exactly that block's Markdown, secrets
  as ciphertext; a revealed secret inside it keeps its pending change until
  the next save re-encrypts it, and a ⌘Z past that save restores the old
  armor, as Source's undo did. A draft with changed text is an unsaved edit:
  every save (⌘S, leaving, the unload flush) applies it first, as Done would,
  and autosave waits while a draft is open. Leaving with a draft open asks
  first (the exit guard's "A protected block being edited" row), and a save
  applies every open draft; an untouched one just closes. Done
  (⌘Enter) splices the text into the block's byte range and reloads the island
  from the result (`onSourceEdit`), as one text entry on the app timeline: ⌘Z
  restores the previous bytes, and a block that became ordinary Markdown comes
  back as ordinary blocks. Cancel (Esc) changes nothing. Either way every byte
  outside the block is untouched.
- **A failed editor load says so.** The pane shows "The editor could not
  load." and a Reload button, and nothing in it is editable. A bundle that
  failed to build still answers 503 (ADR 0038).
- **An edit the adapter cannot serialise asks to be undone:** "This edit
  cannot be written as Markdown — <message>. Undo it to keep editing."
- **A new doc opens in Edit with the caret in it**, ready to type, as it
  opened in Source before.

## Consequences

- Net deletion is the reason, and it is measured with
  `git ls-files app server tests | xargs wc -l | tail -1` and the tracked file
  count: 111 files and 76,370 lines before, 105 files and 71,992 lines after
  (−6 files, −4,378 lines; 986 insertions, 5,364 deletions).
- Gone and not replaced: word wrap, Source's Tab/⇧Tab, list and quote
  continuation, the whole-line clipboard, the keybar, Esc and Back leaving
  Source, and encrypting an existing selection — a secret's text is typed into
  its dialog now.
- No surface in the app types exact bytes into an ordinary block any more.
  Edit writes an edited group through the adapter (ADR 0037), escaping
  included, in `notes.md` and ADR 0019's `notes.txt` alike; the file on disk,
  `write_doc` and any other editor stay byte-exact.
- The tab-width setting reads "Tab width in code blocks"; its key and range
  are unchanged. `--d-raw-fs`/`--d-raw-lh` keep their names: they are theme
  contract (ADR 0003), and the terminal scrollback reads them.
- Known edge left alone: if one protected block holds the same ciphertext twice
  and a save re-encrypts one copy while that block's draft is open, Done
  rewrites both copies. Source's undo had the same shape.
- Old browsers keep a stray `znotes.wrap` key. It is harmless and not
  migrated.
- Tests whose subject was Source were removed, not ported. Where Source was
  only the vehicle, a case now types through the island or writes through the
  API, and keeps its assertion about the real subject.
