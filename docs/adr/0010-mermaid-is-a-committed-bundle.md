# 0010 — Mermaid ships as a committed bundle, hardened as untrusted input

## Status

Accepted, 2026-08-09. First exception to the dependency rule in
[ADR 0001](0001-flat-files-are-the-module-surfaces.md)'s spirit and the
"zero runtime deps" line in AGENTS.md; sits beside
[ADR 0004](0004-secrets-are-client-side-age.md), whose `/vendor/age.js`
machinery this deliberately does **not** reuse.

## Context

The preview had no way to draw a diagram. Mermaid is the canonical answer —
it defines the syntax, so "support mermaid diagrams" and "use mermaid" are the
same sentence. Two things stood in the way.

**Cost.** Mermaid bundles to 3.33 MB of browser JS, and its package plus tree
is 181 MB in `node_modules` (63 MB → 244 MB measured). The existing
`/vendor/age.js` route bundles a dependency with `Bun.build` at boot, which
requires the dependency at *runtime* — and `deploy/Dockerfile` therefore ships
`node_modules` into the image. Reusing that machinery would have grown the
deployed image by 181 MB for a library only ever executed in a browser.

**Trust.** A `` ```mermaid `` fence is the first place in this app where doc
content becomes *markup* rather than text; everywhere else the preview goes
through `esc()` or `.textContent`. Doc content is not necessarily the owner's
typing: a vault syncs over git (SPEC §7) and the AI relay writes docs
(SPEC §8). Mermaid has shipped XSS advisories every year it has existed —
16 GHSAs, five of them fixed in 11.16.1 itself. An audit of the library
established that every advisory against an *embedder* came from one of two
configuration mistakes, and that mermaid does **not** lock `htmlLabels`
against override from inside a diagram.

## Decision

**Mermaid is a devDependency and the bundle is committed.**
`bun scripts/build-mermaid.ts` bundles `scripts/mermaid-entry.js` into
`app/vendor/mermaid.js`, which is checked in and served as an ordinary static
file. This is a *generator*, not a build step — the same standing
`scripts/make-icons.ts` has for `app/icons/*.png`. The production image is
unchanged (verified: 63 MB, no mermaid), boot is untouched, and the frontend
still has no build step. `age-encryption` keeps the boot-bundle route instead,
because building it in-process is what lets `tests/secrets.test.ts` prove the
server's module graph never contains it.

The library is loaded by dynamic `import()` from the first fence that needs it,
so a vault with no diagrams never fetches 3.33 MB.

**A fence is treated as untrusted input,** in three independent layers:

1. `securityLevel: "strict"` plus `htmlLabels: false` at both the root and
   `flowchart` paths, and a **fourteen-key `secure` list**. Mermaid's `secure`
   array *replaces* its default rather than extending it, so the six defaults
   are re-listed; the additions are `htmlLabels` (settable from inside a
   diagram by both the YAML-frontmatter and `%%{init}%%` channels, and the
   surface behind essentially every embedder XSS), `dompurifyConfig`, and the
   five keys feeding the CSS pipeline behind CVE-2022-31108,
   CVE-2026-41148/41159 and CVE-2026-50159.
2. `sanitizeSvg()` in `app/mermaid.js` — our own pass over mermaid's output, a
   whitelist of tags and attributes, on the assumption that layer 1 has a bug
   someday. `<style>` content is kept (the palette rides on it) but stripped of
   `@import` and off-origin `url()`, which is exfiltration rather than script.
3. `bindFunctions` is never called, so the interactive handlers a diagram can
   ask for are never attached.

`maxTextSize` and `maxEdges` are tightened to 20000/200. These are the real DoS
guard: `securityLevel` does nothing about the infinite-loop advisories, and
`maxEdges` is only enforced for flowcharts.

`securityLevel: "sandbox"` (an iframe) is stronger and was rejected: it costs
selectable text, inherited theming and correct sizing, which is most of what a
diagram in a note is for.

## Consequences

- The production image does not grow. Local `node_modules` does.
- The artifact and the pinned version can drift, because nothing at runtime
  rebuilds it. `tests/mermaid.test.ts` fails the build when
  `app/vendor/mermaid.js`'s banner and `package.json` disagree — bumping
  mermaid without regenerating is the one new way to be wrong, and it is
  caught.
- Mermaid is pinned **exactly**, never a caret: the committed artifact is built
  from one version, and a range makes "which mermaid is in the browser"
  unanswerable. Given 9 advisories in 2026 alone, regeneration is a routine to
  run, not a one-off.
- `tests/mermaid-e2e.test.ts` fires the attacks rather than asserting on config
  shape: directive and frontmatter downgrades, `click call`, `click href
  javascript:`, `dompurifyConfig` relaxation and CSS injection all run against
  a real browser with `window.__pwned` armed before app code.
- Diagrams follow the app's theme (ADR 0003) by reading the CSS tokens at
  render time, and a `MutationObserver` in `app/mermaid.js` redraws them when
  `data-theme`/`data-scheme` change. That observer lives in the module with the
  problem; `settings.js` does not learn about diagrams.
- **Still open: there is no Content-Security-Policy.** Two independent audits
  named it the highest-leverage remaining mitigation — it would convert any
  future sanitizer bypass, here or in `/vendor/age.js`, from an exploit into a
  blocked console error. It is not free (`app/index.html` inlines two scripts,
  which need hashes or a nonce) and is deliberately left to its own change.
