# 0003 — A theme is one CSS custom-property file; structure belongs to base.css

**Status:** accepted · 2026-08-01 (recorded 2026-08-07 at retrofit)

## Context

Three visual identities share one DOM with no build step; themes must switch
live and must not fork layout.

## Decision

- A theme is exactly one file in `app/themes/` that sets custom properties on
  `:root` (+ per-scheme/density blocks at the same selector shapes base uses).
  Swapping = replacing the `#theme-css` link href.
- Two independent axes on `<html>`: `data-theme` (which file) ×
  `data-scheme` (dark/light). Every theme must work in both schemes.
- Themes MUST NOT touch layout, media queries, or `.doc`/`.raw` box metrics,
  and may not reference any external resource. Full rules + token reference:
  [specs/done/0003-theming-token-contract.md](../specs/done/0003-theming-token-contract.md).

## Consequences

Adding a theme is one CSS file + one settings-metadata entry; the frontend
needs no change. `themes-tokens.test.ts` and `theming-e2e.test.ts` enforce the
discipline; a token added to `base.css` must be added to the token reference
in the same change.
