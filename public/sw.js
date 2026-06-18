/*
 * smrtesy service worker.
 *
 * A service worker with a fetch handler is one of the hard requirements for
 * Chrome/Android to treat the site as installable (alongside the manifest and
 * icons), and it's what lets the installed app show something other than a
 * dead browser-error page when the device is offline.
 *
 * Strategy, deliberately conservative so we never serve one user's
 * authenticated HTML to another tab:
 *   - Static build assets (/_next/static, fonts, generated icons): cache-first.
 *   - Page navigations: network-first, falling back to /offline.html only when
 *     the network is unreachable. We never cache the HTML itself.
 *   - Everything else (API calls, auth, POSTs, cross-origin): straight to the
 *     network, untouched.
 */
const VERSION = "v2";
const STATIC_CACHE = `smrtesy-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll([OFFLINE_URL])),
  );
  // Activate this worker as soon as it finishes installing.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("smrtesy-") && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// Let the page tell a freshly-installed worker to take over immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// ── Web Push ────────────────────────────────────────────────────────────────
// The server (web-push, VAPID) sends a JSON payload; we surface it as an OS
// notification. Payload shape comes from server/src/lib/platform/push.ts.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "smrtesy", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "smrtesy";
  const options = {
    body: data.body || "",
    icon: "/api/icon?size=192",
    badge: "/api/icon?size=192&purpose=maskable",
    // Same tag collapses repeat alerts for one entity into a single banner.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.link || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing window (and navigate it) or open a new one on tap.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* cross-origin or unsupported — leave the focused tab as-is */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname === "/api/icon" ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|svg|gif|webp|ico)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GETs are cacheable; let writes and same-origin checks go through.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never touch cross-origin requests or API data (except the icon endpoint).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/icon") return;

  // App-shell navigations: try the network, fall back to the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL, { ignoreSearch: true }).then(
          (cached) => cached || Response.error(),
        ),
      ),
    );
    return;
  }

  // Static assets: serve from cache first, populate the cache on miss.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only cache successful, basic/cors responses.
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
