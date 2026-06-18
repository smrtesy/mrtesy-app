"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api/client";

/**
 * Client-side Web Push: permission, subscription, and the enable/disable flow,
 * all driven from inside smrtesy. The VAPID public key is fetched from the
 * backend (never hardcoded), the subscription is created against the active
 * service worker, then registered with the server so notify() can reach it.
 */

// VAPID keys are URL-safe base64; PushManager wants a raw Uint8Array. It must
// be backed by a (non-shared) ArrayBuffer to satisfy BufferSource under the
// TS 5.7+ generic typed-array lib, so allocate the buffer explicitly.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type PushPermission = "default" | "granted" | "denied" | "unsupported";

export interface PushState {
  supported: boolean;
  permission: PushPermission;
  subscribed: boolean;
  busy: boolean;
  /** True when the backend has no VAPID keys configured. */
  unavailable: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
}

export function usePushNotifications(): PushState {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<PushPermission>("unsupported");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Reflect the current OS/browser permission and existing subscription.
  useEffect(() => {
    if (!pushSupported()) return;
    setSupported(true);
    setPermission(Notification.permission as PushPermission);

    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {
        /* SW not ready (e.g. dev where it isn't registered) — leave as false */
      });
  }, []);

  const enable = useCallback(async () => {
    if (!pushSupported() || busy) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm as PushPermission);
      if (perm !== "granted") return;

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        let publicKey: string;
        try {
          ({ publicKey } = await api<{ publicKey: string }>(
            "/api/me/push/public-key",
            { noOrg: true },
          ));
        } catch (e) {
          // Backend has no VAPID keys configured yet.
          if (e instanceof ApiError && e.status === 503) setUnavailable(true);
          throw e;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      await api("/api/me/push/subscribe", {
        method: "POST",
        noOrg: true,
        body: sub.toJSON(),
      });
      setSubscribed(true);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const disable = useCallback(async () => {
    if (!pushSupported() || busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Tell the server first so a failed local unsubscribe doesn't strand
        // the row; then drop the browser subscription.
        await api("/api/me/push/unsubscribe", {
          method: "POST",
          noOrg: true,
          body: { endpoint: sub.endpoint },
        }).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const sendTest = useCallback(async () => {
    await api("/api/me/push/test", { method: "POST", noOrg: true, body: {} });
  }, []);

  return { supported, permission, subscribed, busy, unavailable, enable, disable, sendTest };
}
