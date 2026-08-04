/**
 * Smart School ERP — Service Worker
 * Strategy:
 *  - API/auth requests: never intercepted (they carry the session cookie).
 *  - Page navigations: network-first; PUBLIC pages fall back to the last good
 *    page, then /offline.html. Role-guarded pages (personal data) are NEVER
 *    cached — they fall straight back to /offline.html when offline.
 *  - Static assets (/icons, /manifest.json, /_next/static): stale-while-revalidate.
 *  - Cross-origin requests (Firebase Storage, etc.): untouched.
 */
const CACHE_NAME = "smart-school-erp-v1";
const STATIC_PREFIXES = ["/_next/static/", "/icons/", "/manifest.json"];

// Routes that can contain personal data — never cached by this SW.
const PRIVATE_PREFIXES = ["/admin", "/dashboard", "/teacher", "/parent", "/print", "/qr"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(["/offline.html"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API / auth endpoints.
  if (url.pathname.startsWith("/api/")) return;

  const isPrivate = PRIVATE_PREFIXES.some((p) => url.pathname.startsWith(p));

  // Page navigations — network-first with offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !isPrivate) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/__last-page__", copy));
          }
          return res;
        })
        .catch(async () => {
          if (isPrivate) return caches.match("/offline.html");
          const cached = await caches.match("/__last-page__");
          return cached || caches.match("/offline.html");
        })
    );
    return;
  }

  // Static assets — stale-while-revalidate.
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
