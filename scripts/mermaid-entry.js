/* ============================================================
   scripts/mermaid-entry.js — the ONLY thing the mermaid bundle contains.

   The twin of `server/age-entry.js`, and held to the same discipline: keep
   this file a re-export and nothing else. Whatever appears here is what ships
   to every browser that opens a doc containing a ```mermaid fence, so the
   export surface is the audit surface.

   `mermaid.default` is the whole API the app uses — `initialize`, `parse` and
   `render`. Nothing else is imported, and nothing else should be added here
   without the ADR that justifies it (docs/decisions/0010).
   ============================================================ */

export { default } from "mermaid";
