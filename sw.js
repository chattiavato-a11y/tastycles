const CACHE_VERSION = "gabo-static-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/css/main.css",
  "/css/adapt_screens.css",
  "/app.js",
  "/worker_files/client.worker.js",
  "/worker_files/worker.config.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

function isCacheableStaticAsset(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return false;

  if (url.pathname === "/" || url.pathname === "/index.html") return true;

  return /\.(?:css|js|json|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isCacheableStaticAsset(request)) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkFetch;
    })
  );
});
