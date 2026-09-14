# Decisions — the roll-up

One page per decision, append-only; this index is the narrative thread
through them, kept out of `AGENTS.md` so the map stays a map.

The five founding specs sit in
[docs/specs/done/](../specs/done/): 0001 product, 0002 the normative HTTP/SSE contract, 0003
theming, 0004 secrets crypto, 0005 the Bun platform research. Their durable
rules are ADRs 0002–0004 — amended later by
0006 (0004's passphrase floor is advice, not a gate), 0007 (the app is
installable) and 0008 (on a phone, Back unwinds layers before it leaves).
0010 (mermaid is a committed bundle, and a fence is untrusted input) and
0011 (token counts are an estimate) came out of the dependency audit. 0012
moves 0001's save chrome (the topbar Save button and its permanent pill) to a
statusbar pip plus a topbar mark that appears only when there is something to
save; 0013 gives a collapsed caret in Raw the whole-line ⌘X/⌘C/⌘V; 0014
makes ⌘Z/⌘⇧Z ONE app-owned timeline across documents — text edits and file
operations in the order they happened, navigating to each step's doc, the
file ones behind a prompt (`app/history.js`). 0015 gives Preview the source's
line structure — one newline is one line break, one blank line one blank line
(amending 0001's soft-break and blank-multiplicity rules) — and every rendered
line its own `[data-line]`. 0016 renders external URLs as real new-tab
anchors — http(s)/mailto only; `javascript:` and the rest stay literal text.
0017 makes the vault bring-your-own — external to this repo, any directory
qualifies, and attach is the one place `git init` may run. 0018 makes vaults
plural: the primary keeps today's bare paths and all app-level state,
secondary vaults are `@id/`-prefixed stacks under the vaults home, and `@` is
a reserved path segment. 0019 makes explicit extensions literal, 0020 puts
moves on history, 0021 defines Preview's tested Markdown dialect, 0022 makes asking before a dirty Raw exit a default-on preference, 0023 folds Preview's sections without touching a byte, 0024 drags a folder with its subtree, 0025 moves the chat panel's second chord to ⌥C so ⌘C is always copy, 0026 makes sync bidirectional on the one auto-sync switch — upstream is polled, taken fast-forward-only, and "Sync" is a verb on the vault row — 0027 makes a mode switch keep the source line you were on, measured rather than multiplied, so click-to-edit does not move the document, and 0028 gives the one search box a second language — `/pattern/flags` (or `mode=regex`) is a regex, the palette's chips report which mode actually ran, and a document is rejected whole before its lines are scored. 0029 makes the proposal diff in-house: a line-level Myers diff in `server/ai-edits.ts`, bounded by a 1s deadline rather than by input size, and the `diff` package is gone. 0030 makes a file dropped on the tree a doc: there is no upload route, the drop is `POST /api/docs`, and the accepted extensions are a client-side setting, 0031 gives an agent the same doors as the hand: every UI operation is a WebMCP tool in `app/webmcp.js`, errors are data in 0002's shape, no tool touches a passphrase, and the shell carries `Origin-Agent-Cluster` and `Permissions-Policy: tools=(self)`, 0032 makes Raw a LINE EDITOR — `app/rawedit.js`, one contenteditable with one block per source line, so a heading is drawn at the heading's size and a link in the accent colour (a CSS highlight, never a node under the caret); the textarea is gone, its surface (`value`, the selection pair, `input`/`select`) is the seam `editor.js` still talks to, every edit goes through `replaceRange` or the reconcile, and `.raw` has left the 16px iOS floor, and 0033 gives the app the pinch — it steps the document's TEXT up a fixed ladder (`app/zoom.js`, one `--doc-zoom` on `<html>`) instead of letting the browser scale the layout. 0034 puts an editing bar on the soft keyboard's top edge (`app/keybar.js`) — Outdent, Indent, Undo, Redo and Done, drawn only where a keyboard is MEASURED to be covering a focused Raw editor, never taking the focus off it, every button calling the very function its missing chord calls, and 0036 makes Esc and Enter a ROUND TRIP: Raw remembers the caret it was left with, per doc, and Enter — the press nothing else has claimed, with the document showing and nothing focused — puts it back with its line where it already sits (ADR 0027, aimed at the caret's line rather than the pane's top one). 0035 makes the bare `/` resume the doc you left on — the last doc this browser opened, then `editor.homeDoc`, then the first doc — so the e2e harness clears `znotes.last-doc` before every boot unless a page asks to `resume`. 0037 makes BlockNote the doc editor: Edit replaces the rendered Preview, Source is 0032's line editor unchanged, a byte-preserving MDAST adapter (`app/markdown-source.ts`) keeps untouched source groups verbatim and protects what it cannot edit, the island is bundled by the server at boot like age, secrets stay ciphertext in the editor's model, and folds (0023), click-to-edit, Enter-resume (0036) and the committed mermaid bundle (0010's first half) retire with the renderer; the link copy button (spec 0016) lives on as a widget inside the island.
