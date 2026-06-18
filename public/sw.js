/*
 * smrtesy service worker.
 *
 * Makes the PWA installable and gives it read-only offline support: the app
 * shell and the data that was last loaded while online stay available when the
 * device drops off the network (you can view your day on a train; you just
 * can't edit until you're back online).
 *
 * Caching strategy:
 *   - Static build assets (/_next/static, fonts, generated icons): cache-first.
 *   - Page navigations: network-first, falling back to the last cached version
 *     of that page (the app shell), then to /offline.html as a last resort.
 *   - Backend API reads (GET to a cross-origin /api/* — the Express backend):
 *     stale-while-revalidate, so the last successful response is replayed
 *     offline and refreshed in the background when online.
 *   - Auth, writes (non-GET), and everything else: straight to the network.
 *
 * Cross-user safety: cached navigations are app shells (data is fetched
 * client-side), and the runtime cache is wiped on sign-out (CLEAR_CACHE
 * message), so a shared device doesn't replay one user's data to the next.
 */
const VERSION = "v6";
const STATIC_CACHE = `smrtesy-static-${VERSION}`;
const RUNTIME_CACHE = `smrtesy-runtime-${VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];
const OFFLINE_URL = "/offline.html";

// The Express backend's origin, passed in by the registrar as ?backend=<url>
// (from NEXT_PUBLIC_BACKEND_URL). We only cache API reads from this exact
// origin, so a future third-party with an /api/ path can never be cached.
const BACKEND_ORIGIN = (() => {
  try {
    const raw = new URL(self.location.href).searchParams.get("backend");
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
})();

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
      // Drop caches from previous versions, keeping the current ones.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("smrtesy-") && !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  // Let the page tell a freshly-installed worker to take over immediately.
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  // Wipe cached pages/data on sign-out so the next user can't read them.
  if (event.data === "CLEAR_CACHE") {
    event.waitUntil(caches.delete(RUNTIME_CACHE));
  }
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
    icon: "/icons/icon-192.png",
    // Android status-bar icon: must be a monochrome transparent silhouette
    // (the OS keeps only the alpha channel and recolors it white).
    badge: "/icons/badge-96.png",
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

// Backend reads we're willing to replay offline. Restrict to the known backend
// origin when we have it (fall back to a path heuristic otherwise), and never
// cache auth endpoints.
function isCacheableApi(url) {
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth")) {
    return false;
  }
  return BACKEND_ORIGIN ? url.origin === BACKEND_ORIGIN : true;
}

// Navigations: network-first, then the cached shell for that page, then offline.
async function handleNavigation(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && fresh.type === "basic") {
      const copy = fresh.clone();
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
    }
    return fresh;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL, { ignoreSearch: true });
    return offline || Response.error();
  }
}

// Static assets: cache-first, populate on miss.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200) {
    const copy = response.clone();
    caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

// API reads: network-first, falling back to the last cached response only when
// offline. We deliberately do NOT stale-while-revalidate here — counts, lists
// and other live data must be fresh whenever there's a connection, otherwise
// the UI shows stale values (e.g. an inbox badge that no longer matches the
// list). The cache is purely an offline read-only snapshot.
async function networkFirstApi(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GETs are cacheable; writes go straight to the network.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // App-shell navigations.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Same-origin static build assets.
  if (sameOrigin && isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Backend API reads (matched by origin via isCacheableApi).
  if (isCacheableApi(url)) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // Other same-origin (non-static) and cross-origin requests are left untouched
  // and go straight to the network.
});
