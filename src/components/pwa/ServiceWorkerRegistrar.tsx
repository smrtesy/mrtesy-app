"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that makes the app installable and gives it an
 * offline fallback. Mounted once in the root layout. Registration is deferred
 * to `load` so it never competes with the first paint, and a new worker is
 * told to take over immediately so updates don't get stuck behind old tabs.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    // Skip in dev — the SW would cache stale Next.js HMR assets.
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    const register = () => {
      // Pass the backend origin so the SW only offline-caches API reads from
      // our own backend (never some future third-party with an /api/ path).
      // The query is part of the registered script URL, so it survives SW
      // restarts. Scope stays "/" regardless of the query string.
      const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
      const swUrl = `/sw.js?backend=${encodeURIComponent(backend)}`;
      navigator.serviceWorker
        .register(swUrl, { scope: "/" })
        .then((registration) => {
          // When an updated worker installs, activate it right away.
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (
                installing.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                installing.postMessage("SKIP_WAITING");
              }
            });
          });
        })
        .catch(() => {
          /* registration failures are non-fatal — the app still works online */
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
