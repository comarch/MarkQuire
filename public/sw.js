// MarkQuire offline shell service worker.
//
// Strategy: hashed build assets are cache-first (they never change),
// everything else same-origin is network-first with a runtime cache
// fallback so the app opens without a network. Google API hosts and any
// cross-origin request are never cached: Drive traffic must hit the live
// API, and opaque responses would bloat storage without offline value.

const SHELL_CACHE = "markquire-shell-v1";
const RUNTIME_CACHE = "markquire-runtime-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/", "/index.html"])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Service worker and Drive state must never come from cache.
  if (url.pathname === "/sw.js") return;

  // Hashed build assets: cache-first, they are immutable per deploy.
  if (url.pathname.startsWith("/assets/")) {
    let fromCache = false;
    const responsePromise = caches.match(request).then((cached) => {
      if (cached) {
        fromCache = true;
        return cached;
      }
      return fetch(request);
    });
    event.respondWith(responsePromise);
    event.waitUntil(
      responsePromise
        .then((response) => {
          if (fromCache || !response.ok) return;
          const copy = response.clone();
          return caches
            .open(SHELL_CACHE)
            .then((cache) => cache.put(request, copy));
        })
        .catch(() => {}),
    );
    return;
  }

  // Everything else same-origin: network-first, cache fallback.
  let fromNetwork = false;
  const responsePromise = fetch(request)
    .then((response) => {
      fromNetwork = true;
      return response;
    })
    .catch(() => caches.match(request));
  event.respondWith(responsePromise);
  event.waitUntil(
    responsePromise
      .then((response) => {
        if (!fromNetwork || !response?.ok) return;
        const copy = response.clone();
        return caches
          .open(RUNTIME_CACHE)
          .then((cache) => cache.put(request, copy));
      })
      .catch(() => {}),
  );
});
