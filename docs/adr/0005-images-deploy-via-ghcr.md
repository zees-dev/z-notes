# 0005 — Images deploy via ghcr.io, not side-loading

## Status

Accepted, 2026-08-07.

## Context

Releases were side-loaded: `docker save | gzip` (~126MB), `scp` to each node,
`sudo k3s ctr images import`. The nodes are Raspberry Pis **on Wi-Fi**, so
every release paid for the full image — Bun base layers included — at tens of
minutes per deploy, and the copy step failed outright whenever the laptop and
the cluster disagreed about which subnet it was on. The manifests deliberately
had no registry (`imagePullPolicy: IfNotPresent`, bare `z-notes:<tag>`),
which was the right zero-infrastructure choice for the first deploy and the
wrong steady-state one.

## Decision

Push releases to **`ghcr.io/zees-dev/z-notes`** and let the nodes pull.

- The kustomization's `images:` block is the single place that names the
  registry (`newName: ghcr.io/zees-dev/z-notes`); `20-deployment.yaml` keeps
  the bare `z-notes` name.
- The package is **private** (the repo is). Pulls authenticate with an
  `imagePullSecret` (`ghcr-creds` in the `znotes` namespace), created
  out-of-band and only *named* in the manifest — the same nothing-in-the-
  manifest-is-a-credential rule the AI key and git token follow.
- The credential is a **classic PAT** — GHCR does not reliably accept
  fine-grained tokens for registry auth. The vault owner chose ONE classic
  token (`repo` + `read:packages`) shared between image pulls and the app's
  git sync, trading least-privilege for a single thing to rotate.
- `deploy/Dockerfile` carries `org.opencontainers.image.source` so the
  package links to this repo on GitHub's side.
- Tags stay pinned and are never reused; `IfNotPresent` stays.

## Consequences

- A code-only release ships ~2MB (containerd already holds the base layers by
  digest); deploys went from tens of minutes to ~20 seconds.
- Deploys now depend on the WAN and on ghcr being up. The old side-load path
  still works as the fallback and is kept in deploy/README.md §2.
- Rotating the PAT means updating two places: the `ghcr-creds` secret and the
  app's Settings → Sync token.
