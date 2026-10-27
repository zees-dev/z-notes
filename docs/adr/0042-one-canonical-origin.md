# 0042 — One canonical origin

## Status

Accepted, 2026-10-28. Implements
[spec 0024](../specs/done/0024-built-installable-offline-app.md). Enables
[ADR 0041](0041-the-app-works-offline.md).

## Context

The app was served at `https://znotes.k3s.lan` with a certificate from the
cluster's private CA (`K3s Local CA`), which no device trusts by default.
Measured on 2026-10-27: Chrome refuses to register a service worker on an origin
with a certificate error, even after "Proceed"; it writes nothing to its HTTP
disk cache there; it refuses to install the app; and its click-through lasts one
week, while cert-manager rotates the key at day 60. So the warning returned and
offline could not work at the root.

Storage is also per origin: a device that holds unsent edits holds them for one
origin only.

## Decision

- **The canonical origin is `https://znotes.tailb95e62.ts.net`**, served by the
  Tailscale Kubernetes operator (`deploy/k3s/60-tailscale-ingress.yaml`) with a
  publicly trusted Let's Encrypt certificate. Nothing is installed on a device.
  Service-worker registration, app install and the HTTP cache all require that.
- **`ZNOTES_ORIGIN` names it.** The shell carries it in `meta[name=znotes-origin]`.
  The service worker and the replica run only on that origin; unset, any origin
  is canonical (dev, tests, plain docker).
- **`https://znotes.k3s.lan` stays as the LAN break-glass.** The app works there,
  online, with no worker and no replica, and shows a sticky notice once per
  session: "z-notes lives at <origin> — open it there to use it offline." Its
  plain-HTTP router still redirects to its own https, not to the canonical
  origin: the old name must keep working on a device without Tailscale, and a
  permanent cross-host redirect is cached past any change of mind.
- **Ship the switch before any device holds an outbox.** The old origin holds
  only view preferences in localStorage, so moving costs nothing; later it would
  strand unsent edits.

## Consequences

- The Tailscale app must be connected for the canonical name to resolve (one VPN
  slot on Android), and on Android Private DNS must not be a strict hostname. An
  installed app still opens offline from its cache; `znotes.k3s.lan` remains
  reachable on the LAN.
- The name is in two places that change together: the Ingress and
  `ZNOTES_ORIGIN`.
- The perimeter argument is unchanged: the tailnet is the auth boundary; no
  Funnel, no public domain.
- Not done: a public domain, DNS-01, installing the K3s CA on devices.
