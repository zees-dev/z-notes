# Prototype round 1 — shared brief

Six self-contained HTML mockups of the z-notes app, one per theme. **Every prototype demonstrates the exact same features over the exact same dummy content** — only the aesthetic differs. This is what makes them comparable.

Constraints (hard):

- One file per theme: `prototypes/NN-slug.html`. Fully self-contained — all CSS/JS inline, **zero external requests** (no CDNs, no web fonts, no remote images). System font stacks only (mono stacks welcome where the theme wants them).
- Static mockup with light interactivity via vanilla JS — no frameworks, no build. It fakes the backend; nothing persists.
- Mobile responsive: at <768px the sidebar collapses behind a hamburger and the AI chat becomes a drawer/sheet. Test both layouts.
- Desktop layout: three regions — sidebar (folder tree), editor, AI chat panel (collapsible).

## Required interactive behaviors

1. **Sidebar folder tree** with nesting and disclosure toggles, matching the dummy vault below; active doc highlighted. Clicking a doc navigates (swaps editor content in JS). "+ new doc / new folder" affordances may be inert.
2. **Markdown editor with two modes** *(amended 2026-07-31 — replaces the earlier Notion-blocks requirement; no drag handles, no slash menu, no block hover chrome)*:
   - **Preview** (default): the doc rendered as clean readable markdown — h1–h3, paragraphs, bullet + task lists (checkboxes toggleable), code blocks, tables, quotes, dividers.
   - **Raw**: the doc's exact markdown source in a monospace editing surface (textarea or contenteditable pre). Edits made in Raw appear in Preview when switching back.
   - Toggle via a clearly visible segmented control in the editor header (`Preview | Raw`) **and** `⌘E` / `Ctrl+E`. Mode switch should feel instant.
3. **Doc links**: in Preview, `[[event-pipeline]]`-style links render as pills/links; clicking navigates to that doc (same JS navigation as sidebar). In Raw they stay plain `[[text]]`.
4. **Secret block** (in `keys/cloud-keys.md`): in Preview, the locked state shows a padlock, a LOCKED badge, an "Unlock" button and a **masked body carrying no ciphertext at all** (SPEC §6 — not the armor, not its header, not a byte count); clicking Unlock opens a passphrase prompt (any input accepted) and **unlocks the vault**, which reveals the plaintext of *every* block in this doc and in any doc opened afterwards, with lock-again (locks the vault) + copy buttons. Both states must be reachable. In Raw, the fenced armored block appears as plain text — that is the only place the armor is shown.
5. **AI chat panel**: a short conversation (dummy content below) ending in a **proposed edit** rendered as a diff card (red removed / green added lines) with **Accept** and **Reject** buttons. Accept visibly applies the change to the open doc's content (reflected in both Preview and Raw) and swaps the card to "Applied ✓ — Revert"; Revert restores. Reject dismisses. Include model/effort indicator (`gpt-5.6-sol · high`).
6. **Settings view** (modal or route, opened from a gear): Appearance — theme (System/Dark/Light segmented control), density (Compact/Comfy); Editing — autosave interval (default 10s); Git sync — GitHub token (masked), branch (`main`), auto-sync toggle, sync status line ("✓ synced 2 min ago · origin/main"); AI — base URL, API key (masked), model (`gpt-5.6-sol`), reasoning effort (low/medium/high, high selected). Controls should visually toggle; only **density must actually work** (Compact/Comfy adjusts spacing app-wide via CSS variables).
7. **Save affordances** in the header/statusbar: autosave indicator ("Saved · just now"), a manual save button, and a `⌘S` hint. Wire ⌘/Ctrl+S to flash the indicator.
8. If the theme has both dark and light potential, pick the one that best sells the aesthetic — the theme setting control itself may be inert.

## Dummy vault (identical in all six)

Tree shown in sidebar (● = navigable with real content, ○ = inert):

```
z-notes/
├── inbox.md                    ○
├── architecture/
│   ├── z-notes-design.md       ● (default open)
│   └── event-pipeline.md       ●
├── projects/
│   ├── side-projects.md        ●
│   └── homelab.md              ○
├── keys/
│   └── cloud-keys.md           ●
└── journal/
    └── 2026-07-31.md           ○
```

### architecture/z-notes-design.md (default open)

# z-notes design

Single-user markdown notes app. Bun backend, raw/preview markdown UI, files are the source of truth — see [[event-pipeline]] for how external edits flow in.

## Decisions
- [x] Editor: raw markdown + preview modes, lossless by construction
- [x] Secrets: age-encrypted blocks (see [[cloud-keys]])
- [ ] Pick winning UI theme from prototype round 1
- [ ] Write build-ready spec

## API sketch

| Endpoint | Method | Purpose |
|---|---|---|
| /api/docs | GET | list vault tree |
| /api/docs/:path | GET/PUT | read / save markdown |
| /events | GET | SSE: files changed on disk |

```ts
Bun.serve({
  routes: {
    "/api/docs/*": docHandler,
    "/events": sseHandler,
  },
  idleTimeout: 0, // SSE would die at 10s otherwise
});
```


> Files are edited outside the app too — the watcher is just a doorbell; reconcile from disk.

*(note: the two blank lines above the quote are intentional — they are the round-4 spacing test case)*

### architecture/event-pipeline.md

# Event pipeline

fs.watch on macOS lies: eventType is always "rename" and atomic saves name only the temp file.

- [x] Debounce 120ms
- [x] Reconcile: Glob → stat → hash → sqlite
- [ ] Push change to open editors via SSE

Related: [[z-notes-design]]

### projects/side-projects.md

# Side projects

Active: **z-notes** (this app — [[z-notes-design]]), homelab overhaul, a tiny CLI for age-encrypted dotfiles.

- [ ] z-notes: review prototype round 1
- [ ] homelab: move DNS off the NAS

### keys/cloud-keys.md

# Cloud keys

Personal AWS + Hetzner credentials. Everything below is encrypted at rest and in git.

⛔ SECRET BLOCK HERE — locked state:

```age
-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBxSzl4...
Zt2wPmVFJk3XN8LQvR5tYcAeD7hHnUuBsWgO1iM4E6f9rTKp
-----END AGE ENCRYPTED FILE-----
```

Unlocked reveals:

```
AWS_ACCESS_KEY_ID=AKIA2E4EXAMPLE7XQ
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
HETZNER_API_TOKEN=hz-prod-9f3kx…
```

### AI chat (identical dummy conversation)

- **user**: summarize open tasks across my vault
- **assistant**: You have 6 open tasks: 2 in z-notes design (pick winning theme, write spec), 1 in event-pipeline (SSE push), 2 in side-projects, 1 in inbox. Want me to add a rollup section to z-notes-design?
- **user**: yes, add it
- **assistant**: *(proposed edit — diff card)* Add to `architecture/z-notes-design.md`:
  ```diff
  + ## Open tasks rollup
  + - [ ] Pick winning UI theme ([[z-notes-design]])
  + - [ ] Write build-ready spec ([[z-notes-design]])
  + - [ ] SSE push to open editors ([[event-pipeline]])
  ```

## Themes

| File | Theme | Direction |
|---|---|---|
| 01-modern.html | Modern | Crisp SaaS-grade: clean neutrals, one confident accent, subtle shadows/rounded corners, polished micro-interactions |
| 02-minimal.html | Minimalistic | Almost no chrome: generous whitespace, hairline dividers, monochrome + one muted accent, typography does the work |
| 03-cyberpunk.html | Cyberpunk/futuristic | Dark, neon glows (cyan/magenta), scanline/grid motifs, terminal energy but still readable for long-form notes |
| 04-terminal.html | Terminal/TUI | Monospace everything, box-drawing borders, visible keybind hints, feels like a beautiful TUI in the browser |
| 05-glass.html | Glassmorphism dark | Deep dark backdrop, frosted translucent panels (backdrop-filter), soft glow accents, floating layers |
| 06-notion-warm.html | Notion warm/paper | Warm off-white paper, soft serif-ish headings feel, gentle grays, hover-reveal chrome, calm and bookish |

---

# Round 2 amendments (2026-07-31)

Applies **only** to the three surviving themes: `01-modern.html`, `02-minimal.html`, `04-terminal.html`. The other three are retired unchanged.

1. **Density**: rename the current Compact values to **Comfy** and make it the **default**; add a new **Compact** that is tighter still (smaller block gaps, row heights, paddings, slightly smaller body font). Two modes remain: Compact | Comfy — but the whole app now defaults denser.
2. **Click-to-edit**: clicking anywhere on the doc body in Preview switches to Raw with the textarea focused, placing the caret on the line corresponding to the clicked element (approximate mapping is fine). Exceptions that must NOT enter Raw: task checkboxes (toggle in place), `[[doc-link]]` pills (navigate), secret-block controls (unlock/lock/copy), code copy buttons, text selection drags.
3. **Checkboxes**: clicking a checkbox in Preview toggles it (rewriting its source line) — never enters Raw.
4. **Sidebar create**: "+ new doc" and "+ new folder" actually work — inline name input (or minimal prompt UI matching the theme), item appears in the tree (in-memory only); a new doc opens empty in Raw mode. Esc cancels the input.
5. **Chat sessions**: chat header shows current session details — message count in context and an estimated token count — and offers: a scrollable history (enough dummy messages to scroll), and a **New session** / reset-context action that clears the thread (with a subtle "context cleared" divider or fresh state). Long-running doc-modifying chats are the norm, so this matters.
6. **Change stack (LIFO revert)**: the dummy conversation now produces **two** sequential accepted-able proposals (the tasks rollup, then a second small edit — e.g. appending "- [ ] Ship prototype round 2" to the rollup). Each accepted change pushes onto a visible stack (e.g. "Applied #1", "Applied #2" chips/cards). Only the **top** of the stack is revertible: older cards' Revert buttons are disabled (with a hint like "revert #2 first") until newer ones are reverted. Reverting restores exact prior content.
7. **Fuzzy search**: ⌘K (and/or ⌘P) opens a search palette that fuzzy-matches across **all docs** — file names and content lines (subsequence matching, highlighted matched chars, show doc path + matching line snippet). ↑/↓ + Enter opens the doc; Esc closes.
8. **Statusbar** (all three themes): bottom bar with — current doc line count, sync status ("✓ synced 2 min ago · origin/main"), a couple of key shortcut hints, and a **connection indicator** (● connected / ○ disconnected, as if a WebSocket to the backend; static "connected" is fine, a fake blip is a nice touch).
9. **Esc everywhere**: Esc dismisses any open modal/palette/popover (settings, passphrase, search, chat details, sidebar inputs). Keyboard shortcuts for most things; add a small shortcuts reference (e.g. `?` opens a shortcut overlay, or list them in settings) — at minimum: ⌘E raw/preview, ⌘S save, ⌘K search, Esc dismiss.
10. **Bug fix (01-modern only)**: switching to Raw mode shifts the entire UI upward — diagnose and fix (suspect: textarea autofocus scrolling the page or layout height change). Mode switching must not scroll or reflow the app shell.

---

# Round 3 amendments (2026-07-31)

Applies to `01-modern.html`, `02-minimal.html`, `04-terminal.html`.

11. **Mode visual parity**: switching Preview ↔ Raw must feel like *the text changing in place*, not a component swap. The doc container — borders, background, padding, margins, max-width, corner radius, shadows, scroll container — must be pixel-identical in both modes; only the content within it changes (rendered markdown ↔ monospace source). Style the Raw surface (textarea or pre) to be visually chromeless inside that same container: no distinct border, no different inset, no width jump. Monospace font for Raw is expected; container chrome differences are not. Preserve scroll position across the switch as closely as content allows.
12. **Click-outside returns to Preview**: while in Raw, clicking the editor pane's whitespace *outside* the doc content area (margins/gutter around the doc container) switches back to Preview — the symmetric complement of click-to-edit. Must NOT trigger on: clicks inside the Raw surface, any button/control/statusbar/topbar, text-selection drags ending outside, or while a modal/palette is open. Blur alone must not trigger it (keyboard focus moves shouldn't flip modes).

---

# Round 4 amendments (2026-08-01)

Applies to `01-modern.html`, `02-minimal.html`, `04-terminal.html`.

13. **Source-faithful vertical spacing in Preview**: the preview renderer must preserve blank-line multiplicity between blocks instead of collapsing it into one uniform block gap. Rule: one blank line (or none, where markdown allows adjacent blocks) = the standard block gap; each **additional** consecutive blank line adds one extra line-height of vertical space (use the body line-height so it visually matches what Raw shows). Example that must hold (now in the dummy doc): the ```ts fence in z-notes-design.md is followed by **two** blank lines then the `>` quote — Preview must show a clearly doubled gap there, roughly matching the Raw view's rhythm. Applies between any block types; blank lines *inside* code fences are already literal and unaffected. Mode-switch scroll behavior and container parity (amendments 11–12) must not regress.
