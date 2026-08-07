# Specs

Work items for the `/spec` → `/implement` pipeline (see `AGENTS.md` §Workflow).

- `open/` — awaiting implementation. Written by `/spec` at the end of a
  shaping conversation; self-sufficient by contract (the implementer gets no
  other context). Transient: implementing moves the file.
- `done/` — the archive. Kept verbatim for traceability; staleness here is
  harmless because durable decisions were promoted to `docs/decisions/` when
  the spec landed.

File names are `NNNN-slug.md`, numbered across both directories. Every spec
carries the seven template sections — `bun run lint:docs` enforces this.
