# Event pipeline

fs.watch on macOS lies: eventType is always "rename" and atomic saves name only the temp file.

- [x] Debounce 120ms
- [x] Reconcile: Glob → stat → hash → sqlite
- [ ] Push change to open editors via SSE

Related: [[z-notes-design]]
