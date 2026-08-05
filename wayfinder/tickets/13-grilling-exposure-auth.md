---
id: 13
title: Grilling — exposure & auth model
label: wayfinder:grilling
status: closed
assignee: z + fable (grilling 2026-08-01)
blocked-by: []
---

## Question

Where does the app listen and who can reach it? Localhost only, or LAN-reachable (mobile responsiveness suggests phone use — from where?)? If beyond localhost: password/PIN gate? TLS or trusted-network assumption? Does the secrets passphrase double as the app gate or stay separate? Also: should the server refuse to start outside the repo directory, and is there any multi-device story (two browsers open at once)?

## Resolution

**Deployment: local k3s cluster.** The app runs as a pod with **automatic certificate generation** so it serves HTTPS (secure context for WebCrypto); **Tailscale** provides remote access from outside the network. **Graceful degradation is required**: if WebCrypto is unavailable (non-secure context), the app keeps working with secrets features disabled — secret blocks stay locked/armored, everything else functions. **No app-level auth**: the cluster + tailnet are the perimeter; the secrets passphrase remains the only in-app credential (it protects the vault identity, not the app). Multi-device is inherent (any browser on the tailnet); the doc-rev/SSE reconciliation model covers concurrent viewers.

Decided with z, 2026-08-01.
