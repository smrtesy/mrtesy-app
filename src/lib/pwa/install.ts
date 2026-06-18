"use client";

import { useEffect, useState } from "react";

/**
 * Shared PWA-install state.
 *
 * `beforeinstallprompt` fires exactly once per page load, so we capture it in
 * module scope behind a tiny pub/sub instead of letting each component race
 * its own listener. Both the install banner and the home-page install button
 * read from here, so they stay in sync (and a successful install hides both).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function ensureInit() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("beforeinstallprompt", (e) => {
    // Stop Chrome's default mini-infobar so we can surface our own UI.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes this non-standard flag when launched from the home screen.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

export interface PwaInstallState {
  /** True once Chrome/Android has offered installation (we can prompt natively). */
  canPrompt: boolean;
  /** iOS Safari, where install is manual via Share → Add to Home Screen. */
  ios: boolean;
  /** Already running as an installed app — nothing to offer. */
  standalone: boolean;
  /** Replays the captured native prompt; returns the user's choice. */
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
}

export function usePwaInstall(): PwaInstallState {
  // All three flags depend on `window`, so they're kept in state and only
  // populated inside the effect. The first render (server and client) sees
  // the all-false default, which keeps hydration in sync; the real values
  // land right after mount and whenever the shared store changes.
  const [state, setState] = useState({
    canPrompt: false,
    ios: false,
    standalone: false,
  });

  useEffect(() => {
    ensureInit();
    const sync = () =>
      setState({
        canPrompt: deferredPrompt !== null,
        ios: isIos(),
        standalone: isStandalone(),
      });
    listeners.add(sync);
    // Run once now to catch an event that fired before this component mounted.
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const promptInstall = async () => {
    if (!deferredPrompt) return "unavailable" as const;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    // The event can only be used once.
    deferredPrompt = null;
    notify();
    return outcome;
  };

  return { ...state, promptInstall };
}
