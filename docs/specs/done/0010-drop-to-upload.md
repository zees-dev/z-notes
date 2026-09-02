# 0010 — Drop a file on the tree to upload it

## Problem Statement

The only way a file gets into a vault from outside the app is git or the
filesystem. The sidebar tree already has a complete drag-and-drop model for
moving entries *within* a vault (`app/tree.js` lines 95–247: `dropPlan`,
`wireDragSource`, `wireDropTarget`, the 600 ms hover-to-expand `dwell`, the
`drop-target` / `drop-blocked` row classes in `app/themes/base.css` 633–641),
but a file dragged in from the desktop is ignored — worse, a drop that misses
the tree makes the browser navigate to the file.

There is no upload route and none is needed: ADR 0019 already makes any
visible, extension-bearing, UTF-8 file a doc, and `POST /api/docs` with
`{ path, type: "doc", markdown }` (`server/docs.ts` `DocStore.create`, line
163) creates one, refusing duplicates with `409 exists` and unsafe names with
`400 bad-path`. Uploading is a client gesture over an existing contract.

## Solution

**Dropping files from the OS onto a tree row uploads them into the folder that
row means, using the move gesture's own hover mechanics; which extensions are
accepted is a setting.**

- The target rule is `dropPlan`'s: a doc row means its parent folder, a folder
  row means itself, a vault row means that vault's root.
- Hovering paints `drop-target` on the row and arms the same `dwell` timer, so
  a closed folder opens under the pointer exactly as it does for a move.
- On drop, each file whose extension is in `settings.upload.extensions` and
  whose bytes are valid UTF-8 is created with `api.createEntry` at
  `<folder>/<file name>`, recorded on the undo timeline like an inline create
  (ADR 0014), and the tree reloads. Everything else is refused with a toast
  that names the file and the reason. There is no upload button, dialog or
  progress UI.
- A new settings group **Upload** with one text field, *Accepted file types*,
  backed by `settings.upload.extensions` — a comma-separated string, default
  `"md, html, txt, log"`, healed on read and on `PUT` to lowercase,
  dot-less, de-duplicated tokens.
- A drop anywhere else in the app is swallowed (no navigation) and shows the
  no-drop cursor.

## User Stories

1. As a user, I drag `notes.md` from Finder onto the folder row `projects`
   and it appears as `projects/notes.md` with its bytes intact (CRLF, no
   trailing newline, BOM — whatever it had).
2. As a user, I drop a file on a doc row and it lands beside that doc, in its
   folder.
3. As a user, I drop a file on a vault row and it lands at that vault's root,
   including a secondary `@id/` vault.
4. As a user, I hover a closed folder while dragging a file and it opens after
   the same dwell as a move, so I can reach a subfolder that was not on screen.
5. As a user, I drop three files at once; all three are created, one toast
   summarises ("Uploaded 3 files to projects").
6. As a user, I drop `photo.png` and it is refused with a toast naming the
   file and the accepted types; nothing is written; a `.md` in the same drop
   still uploads.
7. As a user, I drop a file whose name already exists there and I get the
   server's `409 exists` message in a toast; nothing is overwritten.
8. As a user, I drop a `.txt` that is not UTF-8 (a Latin-1 file) and it is
   refused as "not UTF-8 text"; nothing is written.
9. As a user, I drop a file larger than the server's body cap (8 MiB) and it
   is refused client-side with a size toast, not a raw 413.
10. As a user, I drop a folder from Finder and it is refused ("folders cannot
    be uploaded"); files in the same drop still upload.
11. As a user, I press ⌘Z after an upload and the app asks before deleting
    the uploaded doc, exactly as after an inline create.
12. As a user, I miss the tree and drop on the editor; nothing happens and
    the tab does not navigate away.
13. As a user, I open Settings › Upload, change the field to `md, txt`, save,
    and `.log` drops are now refused; reloading shows `md, txt`.
14. As a user, I hand-write `extensions = " .MD, Txt,,md "` in
    `settings.toml`; the server heals it to `"md, txt"` and serves that.
15. As an API client, I `PUT /api/settings` with `{ "upload": 5 }` and get
    `400 bad-upload`; with `{ "upload": { "extensions": 5 } }` I get
    `400 bad-extensions`.
16. As a user, the internal move gesture (doc → folder, cross-vault refusal,
    folder-into-itself refusal) is untouched.

## Implementation Decisions

**Server — `server/settings.ts`.**
- `DEFAULTS` (line 102) gains `upload: { extensions: "md, html, txt, log" }`
  after `trash`.
- `SECTION_ORDER` (line 1226) gains `"upload"` after `"trash"`.
  `SECTION_DOC` gains `upload: "Files dropped onto the sidebar tree."`;
  `KEY_DOC["upload.extensions"] = 'Comma-separated extensions a dropped file may have. Anything else is refused before it is sent.'`.
- A pure, exported `normalizeExtensions(raw: string): string` — split on
  commas and whitespace, trim, strip leading dots, lowercase, keep tokens
  matching `/^[a-z0-9]{1,16}$/`, de-duplicate preserving order, join with
  `", "`. `""` is legal and means nothing may be uploaded.
- `private healUpload(): boolean`, called where `healTerminal()` is called
  (find the call at the heal site; imitate `healTerminal` at line 774): a
  non-object `upload` → default; a non-string `extensions` → default with a
  stderr line; a string → `normalizeExtensions` (touched if it changed).
- `PUT` validation, where `bad-terminal` / `bad-shell` are raised (find
  `"bad-terminal"` and `"bad-shell"` in the file): `upload` present and not a
  plain object → `bad-upload`; `upload.extensions` present and not a string
  → `bad-extensions`; a string is normalised on the way in and the response
  carries what was stored (the same rule as number clamping).
- Credentials, `META`, `NUMBERS`, `BOOLEANS` are untouched.

**Contract — `docs/specs/done/0002-http-api-v0.md`.**
- The settings object example (lines ~505–520) gains
  `"upload": { "extensions": "md, html, txt, log" }` after `"trash"`.
- The *Real backend, additive* paragraphs (~556–580) gain one:
  `settings.upload.extensions` is a comma-separated list, healed as above;
  the server does NOT gate `POST /api/docs` by it — it is the client's
  drop filter (ADR 0019 already defines what a doc is).
- The error table (~719–731) gains `bad-upload` (upload present but not an
  object) and `bad-extensions` (`upload.extensions` not a string).
- `GET /settings/{section}` (~1662): the section list gains `upload`.

**Client — settings.**
- `app/index.html`: a new `<section class="grp" id="settingsGrp-upload">`
  right after `#settingsGrp-trash` (line 416–429), same markup as the trash
  group: a `.grp-t` title "Upload" with a small inline SVG, one `.field` with
  `<div class="lab"><b>Accepted file types</b><span>Drop files from your desktop onto a folder in the sidebar. Comma-separated extensions.</span></div>`
  and `<div class="ctl"><input class="inp mono" id="uploadExt" data-draft="upload.extensions" aria-label="Accepted file types" placeholder="md, html, txt, log"></div>`.
  Add `upload` to the settings rail wherever the other seven sections are
  listed in the markup (search `settingsGrp-` and the rail's `data-`
  attributes near line 315–360).
- `app/shell.js:751`: `SETTINGS_SECTIONS` gains `"upload"` after `"trash"`.
- `app/settings.js`: nothing beyond what `data-draft` already provides
  (`paintDraftFields`, `draftPatch`); verify a save round-trips the field.

**Client — the drop (`app/tree.js`).**
- A module-level helper `const externalFiles = (e) => !dragged && !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");`.
- `wireDropTarget` (line 188): in `paint`, when `externalFiles(e)`, compute the
  destination folder with the same rule as `dropPlan` (a small
  `dropFolder(target, kind)` extracted from `dropPlan`'s first four lines so
  both use it), `e.preventDefault()`, `dropEffect = "copy"`, add
  `drop-target`, arm `dwell` if the row has closed `kids`, and return. In the
  `drop` handler, when `externalFiles(e)`: `e.preventDefault()`,
  `e.stopPropagation()`, `clearDropMarks()`, then
  `uploadFiles(Array.from(e.dataTransfer.files), Array.from(e.dataTransfer.items || []), folder)`.
  `dragleave` already clears the row's classes and dwell; nothing new.
- `async function uploadFiles(files, items, folder)`:
  - `accepted` = the set from `state.settings.upload.extensions` via the same
    normalisation as the server (a tiny client copy of `normalizeExtensions`;
    `settingAt`/`state.settings` is how the tree reads settings today — check
    `import`s at lines 10–18 and use what `settings.js` exports, else read
    `state.settings`).
  - Per file, in order: `items[i].webkitGetAsEntry?.()?.isDirectory` →
    refuse "folders cannot be uploaded"; extension = name after the last
    `.`, lowercased, and a name with no `.` or an extension not in `accepted`
    → refuse naming the accepted list; `file.size > 8 * 1024 * 1024` → refuse
    by size; `new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())`
    throwing → refuse "not UTF-8 text"; else
    `api.createEntry({ path: folder ? folder + "/" + file.name : file.name, type: "doc", markdown: text })`
    — `folder` here is the vault-qualified path the row carries (the same
    `prefix + rel` shape `dropPlan` builds), so secondary vaults work —
    on success `rememberFileOp({ kind: "create", path, type: "doc", markdown: text })`
    (imitating `commitCreate`, line 861), on `ApiError` collect
    `err.message`.
  - After the loop: `revealFolder(folder)` (as `commitCreate` does),
    `await loadTree()`, then one toast: `Uploaded N file(s) to <folder or vault name>`
    when N > 0, followed (in the same toast, joined by " · ", or a second
    toast if the first is sticky) by each refusal `name: reason`. If a single
    file was uploaded, `openDoc(path)` it, as the inline create does.
- `app/app.js` (boot wiring block) or `app/shell.js`: `window.addEventListener("dragover", e => { if (externalFiles-like check on types) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } })`
  and `window.addEventListener("drop", e => e.preventDefault())` — registered
  in the bubbling phase so a tree row's `stopPropagation()` keeps its own
  drop. Export the tiny predicate from `ui.js` if two modules need it.
- CSS: no new rules; `drop-target` already exists. If the copy cursor is
  wanted, `.row.drop-target` is unchanged — the browser draws the copy badge
  from `dropEffect`.

**ADR.** `docs/decisions/0030-a-dropped-file-is-a-doc.md` — the next free ADR number (0029 is taken by spec 0009; verify with `ls docs/decisions` and use the next free one if that has moved) — format as 0025:
Decision — there is no upload route; a dropped file is `POST /api/docs`, the
accepted-extension list is a client-side setting, and the server's definition
of a doc stays ADR 0019's. Consequence — a name the server would refuse
(`]`, line breaks, a hidden or `@` segment) is refused by the server's
existing guards, and the client shows that message. Register it in the
`AGENTS.md` ADR sentence list (≤ 100 lines).

## Testing Decisions

Two seams: the HTTP seam for the setting, the browser seam for the gesture.

- `tests/settings.test.ts` (prior art for everything here): the settable-key
  sweep (line ~255–310) gains `upload.extensions`; the "no Settings control"
  parity gate (line ~118–135) passes by virtue of `data-draft`. Add: heal of
  `extensions = " .MD, Txt,,md "` → `"md, txt"`; `PUT { upload: 5 }` →
  `400 bad-upload`; `PUT { upload: { extensions: 5 } }` → `400 bad-extensions`;
  `PUT { upload: { extensions: "LOG, .log, html" } }` → response carries
  `"log, html"` and `settings.toml` has `extensions = "log, html"` under
  `[upload]`. Import `normalizeExtensions` directly for a two-line unit case.
- `tests/upload-e2e.test.ts` (new; harness from `tests/browser.ts`, server from
  `tests/helpers.ts`; imitate `tests/ux-e2e.test.ts:784–806` for building a
  `DataTransfer` inside `page.evaluate`, and `tests/fileops-e2e.test.ts` for
  seeding a vault with a folder and asserting on disk). Two tests:
  1. Build `dt.items.add(new File(["# hi\r\nno newline"], "note.md", { type: "text/markdown" }))`,
     dispatch `new DragEvent("dragenter"/"dragover", { dataTransfer: dt, bubbles: true, cancelable: true })`
     on a CLOSED folder row → expect `drop-target` on the row; wait > 600 ms →
     the row has class `open`; dispatch `drop` → wait until the tree shows
     `folder/note.md`; read the file from the vault directory and assert the
     bytes are exactly `# hi\r\nno newline`; assert the toast text.
  2. A drop of `photo.png` + `dup.md` (pre-seeded) + `ok.md` on the vault row
     → only `ok.md` is created at the root; the toast names `photo.png` and
     `dup.md` with their reasons. Then `PUT /api/settings { upload: { extensions: "md" } }`
     through the page (or the API) and a `.txt` drop is refused.
- Gates + `bun run lint:docs`; full `bun test` at the end.

## Out of Scope

- Server-side gating of `POST /api/docs` by the extension list (the sidebar's
  inline create legitimately makes `report.txt`; ADR 0019 rules).
- An upload button, a file picker, a modal, progress bars, drag overlays
  beyond the existing `drop-target` row class.
- Dropping onto the editor/preview pane (to insert or open).
- Binary files, images, non-UTF-8 text, directories (all refused).
- Renaming on conflict (`note (2).md`); the server's `409` is the answer.
- Paste-to-upload, mobile/touch drops, the drawer layout's drop zones.
- Changing what a doc is, how Preview renders `.html`/`.log` (the Markdown
  dialect applies to every doc; ADR 0019/0021), search, sync, or the AI relay.
- Any change to the move gesture's behaviour or its tests.

## Further Notes

- `state.folds`, `renderTree()` and the "written in place" expansion rule in
  `wireDropTarget`'s comment apply unchanged: never `renderTree()` during a
  hover — Chromium cancels the drag.
- External drags never fire `dragend` in this document; marks are cleared on
  `drop` and by each row's `dragleave`.
- `tests/api.test.ts` has NUL bytes; sweeps use `grep -a`.
- `AGENTS.md` is at 99 lines; add ADR text to the existing sentence list, not
  as new lines.
