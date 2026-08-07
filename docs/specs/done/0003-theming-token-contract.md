# 0003 — Theming — one CSS token file per theme

> Founding document, retrofitted into the spec template when the repo adopted
> the agent-first shape (ADR 0001 era). Archived here as a completed spec:
> staleness is harmless, durable decisions live in `docs/decisions/`.

## Problem Statement

Multiple visual identities (modern / minimal / terminal) must coexist over one DOM without a build step, without layout drift between themes, and switchable live.

## Solution

A theme is ONE CSS file that sets custom properties, loaded after `themes/base.css` and swapped by replacing a `<link>` href. Two independent axes: `data-theme` picks the palette file, `data-scheme` (dark/light) picks the palette inside it. ADR [0003](../../decisions/0003-themes-are-css-token-contracts.md) records the durable rules.

## User Stories

1. As the user, I want to switch theme/scheme/density live from Settings, so that no reload or rebuild is ever needed.
2. As a theme author, I want a token reference and hard MUST-NOTs, so that a theme cannot break layout or accessibility.
3. As the app, I want `base.css` to own all structure, so that N themes never means N layouts.

## Implementation Decisions

The authoring guide and token reference, verbatim (headings demoted one level):

A theme is **one CSS file that sets custom properties**. It is loaded after
`themes/base.css` and swapped at runtime by replacing the `href` of
`<link id="theme-css">` — no reload, no rebuild, no JS.

```
themes/base.css      structure, layout, behaviour, token defaults  ← never edit per theme
themes/modern.css    Modern
themes/minimal.css   Minimal   — tokens only, zero selectors
themes/terminal.css  Terminal
```

### Adding one

1. Copy `modern.css` to `themes/<id>.css` and change the values.
2. Register it in the backend's settings metadata (the `meta.themes` list served
   by `GET /api/settings`, declared in `settings.ts`). The Settings › Theme
   control is built from that list, so the frontend needs no change at all.
3. Test with `?theme=<id>` (see below).

### Two axes

`data-theme` picks the stylesheet. `data-scheme` (`dark` | `light`, stamped on
`<html>` by app.js from the `colorScheme` setting) picks the palette inside it.
They are independent: **every theme must work in both schemes.** There is no
opting out — Terminal, whose native look is dark, ships a light variant, and
Minimal, whose native look is paper, ships a dark one.

The cascade that makes this cheap:

```
:root                        (0,1,0)   a theme's light palette
:root[data-scheme="dark"]    (0,2,0)   a dark palette, in base.css OR a theme
```

The attribute selector outranks the plain one *regardless of file order*, so
base.css's dark block would beat a theme's `:root` on its own. That is
deliberate — a theme with no dark palette still goes properly dark instead of
turning white-on-white — but it makes the coverage rule two-sided:

1. **cover every token you set to a literal colour.** Tokens defined as
   `var(--…)` aliases need no dark entry: a custom-property reference resolves
   against the element's own computed value, so redefining `--accent` re-points
   every `var(--accent)` alias with it. This is why the dark blocks are ~55
   lines and not ~140.
2. **cover every token base's dark block sets that you set as an alias.**
   `--sh-1: none` in a shadowless theme silently becomes a real shadow in the
   dark unless the theme restates it at matching specificity. `minimal.css` and
   `terminal.css` each carry a short, labelled *specificity plumbing* group for
   exactly this. Adding a token to base's dark block is a four-file change.

Terminal is laid out the other way round and is the model for any theme whose
native look is dark: `:root` holds only what both schemes share, and the palette
lives in sibling `:root[data-scheme="dark"]` / `:root[data-scheme="light"]`
blocks that declare the same keys.

`color-scheme` (the UA property that paints form controls, native scrollbars and
the canvas) belongs to base.css and the two scheme blocks — a theme never sets
it, and `index.html` resolves `data-scheme` **before the first paint** so the
boot splash never flashes the wrong ground.

### Rules

**A theme MAY**

- set any custom property listed below, on `:root`;
- set a dark palette under `:root[data-scheme="dark"]`, and a light one under
  `:root[data-scheme="light"]` — same rule as density: the plain `:root` loses
  to base's attribute selector, so the override must use the same selector shape;
- set density overrides, but **only** under the same selectors base uses —
  `:root[data-density="comfy"]` / `:root[data-density="compact"]`. A plain
  `:root { --d-font: … }` loses to base's attribute selector and silently does
  nothing;
- add a small number of **decorative** rules scoped to
  `[data-theme="<id>"] …`, and their per-scheme twins
  `[data-theme="<id>"][data-scheme="light"] …` (both attributes are on `<html>`)
  where an ornament hard-codes a hue that does not survive the other ground —
  `terminal.css` restates exactly five. Use these
  only for ornament that cannot be a single token value — a gradient tied to a
  shadow, a `::before` glyph. Document each one at the bottom of the file, as
  `modern.css` and `terminal.css` do. `minimal.css` has none, which is the
  standard to aim for.

**A theme MUST NOT**

- change layout: no `display`, `grid-*`, `flex-*`, `position`, `width`,
  `height`, `overflow`, `order`, `z-index`, `top/left/right/bottom`;
- add or change media queries — the breakpoints belong to base;
- touch `.doc`, `.raw`, `.scroll` or `.bgap` box metrics. Preview/Raw container
  parity (amendment 11) and source-faithful blank-line spacing (amendment 13)
  are structural guarantees, not aesthetics. Change `--doc-max-w`,
  `--doc-pad-x`, `--font-doc` instead;
- style by markup structure (`.md > ul > li:nth-child…`) — that couples the
  theme to the renderer;
- reference an external font, image or URL. Zero network requests, system font
  stacks only.

### Testing

```
http://localhost:4700/                       stored theme + stored scheme
http://localhost:4700/?theme=terminal        theme override, does not persist
http://localhost:4700/?scheme=light          scheme override, does not persist
http://localhost:4700/?theme=terminal&scheme=light
```

Both overrides win over the stored setting for that page load only, both are
validated against server `meta` (never a list in the client), and an unknown id
is ignored with a console warning. Neither writes settings, so a screenshot pass
over 3 themes × 2 schemes leaves the vault exactly as it found it. Switching in
Settings › Appearance swaps the sheet / repaints live and writes
`PUT /api/settings`.

Checklist for a new theme — **all six combinations** (Compact and Comfy × dark
and light) at 1440px and 390px:

- Preview and Raw are pixel-identical containers (⌘E back and forth — only
  glyphs change);
- the doubled blank line before the quote in `z-notes-design.md` is visibly
  double;
- Compact and Comfy both readable; the statusbar stays on screen; nothing in
  `.sb-head` or the topbar is clipped at the tightest rung;
- the statusbar's **mode chip** (`#stMode`, the Preview/Raw toggle — it lives
  here, not in the topbar) still reads as one of the bar's own items and not as
  a button bolted into it: same `--muted`, same size and weight as the line
  count beside it, with the hover well (`--panel-3`) the only thing that says
  it is clickable. It is the ONLY way to reach Raw below 768px, so it must
  never be shed or clipped, in either density;
- shell, doc, sidebar, chat and statusbar all actually change ground between
  schemes — none of them stays light in the dark;
- **measured** ≥ 4.5:1 for `--text` / `--text-2` / `--muted` on the surface each
  is painted on, and for the pairs that are easy to miss because they are only
  ever seen on a tint: `--warn` on `--warn-soft` (secret FLAGGED), `--ok` on
  `--ok-soft` (secret OPEN), `--add-fg`/`--del-fg` on their diff rows,
  `--danger` on `--danger-soft`, `--btn-primary-fg` on `--btn-primary-bg`,
  `--seg-acc-fg` on `--seg-acc-bg`, `--toast-fg` on `--toast-bg`;
- the LIFO "revert #2 first" hint legible;
- fuzzy-match `<mark>` visible against the palette selection (that is
  `--mark-fg` on `--sel-bg`, not on `--panel`);
- the AI-status and connection dots distinguishable from the statusbar at ≥ 3:1
  in both schemes;
- disabled buttons read as disabled; focus rings visible. A translucent halo
  tops out near 1.5:1 on white however much alpha it carries, so `--sh-focus`
  is a solid `--accent` ring behind a `--panel` gap, not a wash.

---


Everything below has a neutral default in `base.css`. Values are CSS, so a token
that takes a colour will also take a gradient wherever it feeds `background`.

### Surfaces

| Token | Meaning |
|---|---|
| `--bg` | page background |
| `--app-bg` | the shell's background layer — a colour or a full gradient stack |
| `--panel` | primary raised surface: editor, modals |
| `--panel-2` | subdued fill: chat pane, footers, table heads, seg track |
| `--panel-3` | deepest fill: chips, icon-button hover, hover wells |
| `--line` / `--line-2` | structural border / internal hairline |

### Ink

`--text` · `--text-2` (body copy) · `--muted` · `--muted-2` (faintest).

### Accent

`--accent` · `--accent-h` (hover/active) · `--accent-on` (ink on an accent
fill) · `--accent-soft` / `--accent-soft-2` (tints) · `--accent-ring` (focus
halo colour).

### Semantic and diff

`--ok` `--ok-soft` `--ok-bd` · `--warn` `--warn-soft` · `--danger`
`--danger-soft` · `--add-bg` `--add-fg` `--add-gutter` · `--del-bg` `--del-fg`
`--del-gutter`.

### Misc palette

`--sel-bg` `--sel-fg` (text selection) · `--scroll-thumb`
`--scroll-thumb-hover` · `--mark-fg` (fuzzy-match highlight) ·
`--code-inline-fg` `--code-inline-bg` `--code-inline-bd` · `--hover-tint`
(click-to-edit block hover) · `--scrim-bg`.

### Typography

| Token | Meaning |
|---|---|
| `--font` | UI font stack |
| `--mono` | monospace stack (Raw mode, code, paths) |
| `--font-doc` | rendered markdown body — set to `var(--mono)` for a TUI look |
| `--font-heading` | headings |
| `--font-kbd` | `<kbd>` chips |
| `--w-med` `--w-semi` `--w-bold` | the three UI weights |
| `--h1-size` `--h1-weight` `--h1-tracking` `--h1-transform` | and `--h2-*`, `--h3-*` |
| `--tracking-tight` `--tracking-wide` | |
| `--label-transform` `--label-tracking` | small caps-style labels (`uppercase` / `none`) |

### Shape, elevation, motion

`--r-sm` `--r` `--r-lg` `--r-xl` `--r-pill` — set them all to `0px` for a
terminal look. `--bd-w` `--bd-style` (`solid`/`dashed`) and the composed
`--bd` / `--bd-2`. `--sh-1`…`--sh-4` (ambient → modal) and `--sh-focus`
(the focus ring; `none` is not allowed — keyboard users need it).
`--ease`, `--dur-1` `--dur-2` `--dur-3`.

### Layout dials (safe, non-structural)

`--sidebar-w` · `--chat-w` · `--doc-max-w` (measure) · `--doc-pad-x`,
`--doc-pad-x-md`, `--doc-pad-x-sm` (per breakpoint) · `--doc-pad-bottom`.

### Region treatments

`--sidebar-bg` `--sidebar-bd` `--sidebar-blur` · `--topbar-bg` `--topbar-blur`
· `--editor-bg` · `--statusbar-bg` `--statusbar-blur` · `--chat-bg`
`--chat-bd` · `--composer-bg` · `--modal-bg` · `--veil-bg` `--veil-blur` ·
`--card-bg` · `--code-bg` `--code-bar-bg` `--code-fg` · `--tk-key` `--tk-str`
`--tk-com` `--tk-num` `--tk-fn` (syntax).

`*-blur` tokens are `backdrop-filter` values; `none` disables.

### Components

| Group | Tokens |
|---|---|
| tree rows | `--row-hover-bg` `--row-active-bg` `--row-active-fg` `--row-active-sh` `--row-marker-w` `--row-marker-bg` |
| buttons | `--btn-bg` `--btn-fg` `--btn-bd` `--btn-sh` `--btn-hover-bg` and `--btn-primary-*` |
| inputs | `--input-bg` `--input-bd` `--input-fg` |
| segmented | `--seg-track-bg` `--seg-on-bg` `--seg-on-fg` `--seg-on-sh` `--seg-acc-bg` `--seg-acc-fg` |
| kbd | `--kbd-bg` `--kbd-fg` `--kbd-bd` `--kbd-bd-bottom-w` `--kbd-radius` |
| checkboxes | `--cb-size` `--cb-radius` `--cb-bg` `--cb-bd` `--cb-on-bg` `--cb-on-bd` `--cb-mark` `--task-done-fg` `--task-done-decoration` |
| bullets | `--bullet-size` `--bullet-radius` `--bullet-bg` |
| quotes | `--quote-bd-w` `--quote-bd` `--quote-style` `--quote-fg` |
| wiki-links | `--wl-bg` `--wl-bg-hover` `--wl-fg` `--wl-ring` `--wl-radius` `--wl-weight` `--wl-icon-opacity` |
| secrets/tables | `--secret-bg` `--secret-open-bd` `--table-head-bg` `--divider-bg` |
| chat | `--bubble-user-bg` `--bubble-user-fg` `--bubble-user-radius` and `--bubble-ai-*` |
| toast/status | `--toast-bg` `--toast-fg` `--toast-ok` `--conn-ok` `--conn-down` |
| vault mark | `--vault-mark-bg` `--vault-mark-fg` `--vault-mark-radius` `--vault-mark-sh` |

### Density scale

Set under `:root[data-density="comfy"]` and `:root[data-density="compact"]`.
Comfy is the default and is already dense; Compact is tighter still.

The scale was rescaled down one rung: what used to be Compact **is** Comfy now,
and Compact is a new rung below it. Floors, so that "dense" never becomes
"broken" — `--d-ctl-h` ≥ 22px, `--d-row-h` ≥ 17px, and `--d-font` no lower than
12.4px for a proportional theme (10.9px for a mono one, where a 10pt terminal is
the point). Two couplings to respect:

- `.sb-head` is exactly `--d-topbar` tall and holds two stacked lines of type.
  Everything in it scales off `--d-ctl-h` / `--d-font` rather than being a
  constant that happens to fit, but take `--d-topbar` much below
  `--d-ctl-h + 8px` and the vault name will clip anyway;
- `--d-doc-pad` must DIFFER between the two rungs. `tests/e2e.test.ts` asserts
  that above the mobile breakpoint, as proof that the Preview/Raw parity
  equalities either side of it are not comparing two identical constants.

`--d-font` `--d-lh` · `--d-blk-gap` `--d-list-gap` `--d-sec-gap` ·
`--d-row-h` `--d-row-gap` `--d-pane-pad` · `--d-topbar` `--d-status`
`--d-ctl-h` · `--d-doc-pad` · `--d-msg-gap` `--d-msg-pad` ·
`--d-raw-fs` `--d-raw-lh` · `--d-cell-pad` `--d-pre-pad` `--d-pre-lh`.

`--d-font` and `--d-lh` are load-bearing beyond text size: the blank-line
spacer height is `((n − 1) × --d-font × --d-lh)`, so Preview's extra-blank-line
rhythm tracks whatever the theme sets. Keep `--d-raw-lh` close to `--d-lh` or
Raw and Preview will drift apart vertically.

## Testing Decisions

`tests/themes-tokens.test.ts` parses the stylesheets for token discipline; `tests/theming-e2e.test.ts` boots every theme×scheme in Chromium and measures contrast. The checklist under Implementation Decisions is the manual gate for a new theme.

## Out of Scope

Per-theme layout changes, external fonts/images (zero network requests), user-authored themes uploaded at runtime.

## Further Notes

The token reference at the end is the contract's living half — grow it in the same change that adds a token to `base.css`.
