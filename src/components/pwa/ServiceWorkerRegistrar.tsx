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
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
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
