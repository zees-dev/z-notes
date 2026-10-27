/* ============================================================
   sw.js — the app-shell service worker (ADR 0041).

   Generated per build: server/frontend.ts bundles this file with the build id
   and the release's URL list defined in, so a new release is a byte-different
   /sw.js and the browser installs it beside the old one. It holds exactly one
   release in `znotes-<build>` and serves the shell and every asset from it,
   which is what makes a reopen (and a reopen with no network) start without a
   round trip.

   It never touches /api, /events or /healthz: the replica owns offline data,
   and a cached API answer would be a second, unowned copy of the vault. A new
   worker waits until the page's "Reload" prompt posts `skip-waiting`, so an
   open page keeps loading ITS build's lazy chunks from its own cache and an
   unsaved buffer is never reloaded under the user.
   ============================================================ */
/* global __ZNOTES_BUILD__, __ZNOTES_PRECACHE__ */
const BUILD = __ZNOTES_BUILD__, PRECACHE = __ZNOTES_PRECACHE__, CACHE = "znotes-" + BUILD;

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await Promise.all(
          PRECACHE.map(async (url) => {
            const res = await fetch(url, { cache: "no-cache" });
            if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
            /* a deploy landed mid-install: this worker's assets are gone from
               the server, so give up and let the next update check retry */
            if (url === "/" && !(await res.clone().text()).includes(`<meta name="znotes-build" content="${BUILD}">`))
              throw new Error("the shell belongs to another build");
            await cache.put(url, res);
          })
        );
      } catch (err) {
        await caches.delete(CACHE);
        throw err;
      }
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("znotes-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});

const fromCache = async (key, req) => (await (await caches.open(CACHE)).match(key)) || fetch(req);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (req.mode === "navigate") {
    if (/^\/(?:api|events|healthz|assets|sw\.js)(?:\/|$)/.test(path)) return;
    e.respondWith(fromCache("/", req));
  } else if (path.startsWith("/assets/") || path === "/manifest.json" || path.startsWith("/themes/") || path.startsWith("/icons/")) {
    e.respondWith(fromCache(path, req));
  }
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "skip-waiting") self.skipWaiting();
});
