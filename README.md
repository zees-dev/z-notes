# z-notes

A single-user markdown notes app where **files on disk are the source of
truth** and the app is just a view over them. Edit in the app, edit in your
editor, edit over ssh — it's all the same vault, and the app reconciles.

One [Bun](https://bun.sh) process serves everything: a no-build vanilla-JS
frontend, a JSON + SSE API, client-side encrypted secrets, git sync, an AI
edit relay and a gated terminal.

## What it does

- **Markdown vault** — a directory of `.md` files, watched and indexed into
  sqlite. Deleting the index loses nothing; the files are the truth.
- **Editor + preview** that keep the source's line structure, live-updated
  across every open browser via SSE. Mermaid diagrams render from a committed,
  sandboxed bundle — a fence is treated as untrusted input.
- **Secrets** — `age`-encrypted blocks inside your notes, encrypted and
  decrypted **in the browser**. The server never sees a passphrase or a
  plaintext secret; the test suite enforces it.
- **Git sync** — the vault is (or becomes) its own git repository, syncing to
  any remote you give it. The vault is bring-your-own: any directory
  qualifies, and the app can attach it to a remote on first boot.
- **AI edits** — a relay to any OpenAI-compatible endpoint, with
  propose/review/revert semantics. The relay has no route to rename or delete
  a file, by construction.
- **Installable** — a PWA with proper icons, launch screen and phone-shaped
  back-button behavior.
- **One process, one replica** — sqlite + fs.watch + a git working tree.
  Deliberately not a multi-tenant system.

## Run it

```sh
bun install
bun run dev          # http://localhost:4700, vault at ./vault
```

Point it at your real notes with `ZNOTES_VAULT`:

```sh
ZNOTES_VAULT="$HOME/notes" bun run start
```

`http://localhost` is a trustworthy origin, so secrets work with no TLS
anywhere. Reaching the same process over a LAN IP is an insecure context —
the app still runs, but secret blocks stay armored until you give it HTTPS
(see `deploy/`).

## Deploy it

`deploy/` has a production Dockerfile and k3s manifests with TLS via
cert-manager, plus the reasoning behind every knob —
[deploy/README.md](deploy/README.md) is the runbook.

## Development

```sh
bun test             # full suite (~12 min: real servers + headless Chromium)
bun run gates        # the six acceptance gates (~70 s) — run before commits
bun run lint:docs    # docs/link/layering enforcement
```

The repo is documentation-heavy on purpose: [AGENTS.md](AGENTS.md) is the map,
[docs/architecture.md](docs/architecture.md) the module structure,
[docs/decisions/](docs/decisions/) the ADRs, and [docs/specs/](docs/specs/)
the specs that drove each change — including
[the normative HTTP/SSE contract](docs/specs/done/0002-http-api-v0.md).

There is exactly one runtime dependency, `age-encryption`. There is no
frontend build step. Adding a dependency is an ADR-sized decision.

## License

[MIT](LICENSE)
