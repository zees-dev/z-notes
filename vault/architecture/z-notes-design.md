# z-notes design

Single-user markdown notes app. Bun backend, raw/preview markdown UI, files are the source of truth — see [[event-pipeline]] for how external edits flow in.

## Decisions

- [x] Editor: raw markdown + preview modes, lossless by construction
- [x] Secrets: age-encrypted blocks (see [[cloud-keys]])
- [ ] Pick winning UI theme from prototype round 1
- [ ] Write build-ready spec

## API sketch

| Endpoint | Method | Purpose |
|---|---|---|
| /api/docs | GET | list vault tree |
| /api/docs/:path | GET/PUT | read / save markdown |
| /events | GET | SSE: files changed on disk |

```ts
Bun.serve({
  routes: {
    "/api/docs/*": docHandler,
    "/events": sseHandler,
  },
  idleTimeout: 0, // SSE would die at 10s otherwise
});
```


> Files are edited outside the app too — the watcher is just a doorbell; reconcile from disk.
