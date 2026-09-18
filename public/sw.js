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
const CACHE_NAME = "amar-e-school-v1";
const STATIC_PREFIXES = ["/_next/static/", "/icons/", "/manifest.json"];

// Routes that can contain personal data — never cached by this SW.
const PRIVATE_PREFIXES = ["/admin", "/dashboard", "/teacher", "/parent", "/student", "/print", "/qr"];

// PRD §7.1/§13 — FCM web push: show the notification when a push arrives.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { notification: { title: "Amar E School", body: event.data ? event.data.text() : "" } };
  }
  const n = payload.notification || {};
  event.waitUntil(
    self.registration.showNotification(n.title || "Amar E School", {
      body: n.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { link: (payload.webpush && payload.webpush.fcmOptions && payload.webpush.fcmOptions.link) || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(link);
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    })
  );
});

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
