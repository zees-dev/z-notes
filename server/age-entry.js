/* ============================================================
   server/age-entry.js — the ONLY thing the browser bundle contains.

   There is no frontend build step in this project — `bun --hot
   server/index.ts`, zero build. The one dependency the client genuinely cannot do
   without is `age-encryption` (typage), so the server bundles exactly this
   file with Bun.build at startup and serves the result at /vendor/age.js —
   in memory, never written to the repo.

   Keep this file a re-export and nothing else: whatever appears here is what
   ships to the crypto worker, and the worker is the plaintext jail.
   ============================================================ */

export * from "age-encryption";
