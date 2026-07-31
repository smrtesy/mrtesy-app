"use client";

/**
 * Records every sonner toast into the system-messages archive (the bell in the
 * sidebar). Mounted once next to <Toaster> in the locale layout; renders nothing.
 *
 * Why observe sonner instead of wrapping `toast`: ~50 call sites import
 * `toast` from "sonner" directly. `useSonner()` subscribes to the same store
 * the <Toaster> renders from, so every message is captured with zero changes
 * at the call sites — including future ones that won't know this archive exists.
 *
 * What is recorded: toasts whose title is a plain string (every
 * toast.error/success/info/warning/message call in this repo passes an i18n'd
 * string). Skipped: JSX/custom toasts (the undo countdown toast — an action
 * window, not a system message) and "loading" states.
 */

import { useEffect, useRef } from "react";
import { useSonner } from "sonner";
import {
  recordSystemMessage,
  type SystemMessageType,
} from "@/lib/system-messages";

const RECORDED_TYPES: Record<string, SystemMessageType> = {
  error: "error",
  warning: "warning",
  success: "success",
  info: "info",
  // Plain toast("…") arrives as normal/default — still a system message.
  normal: "info",
  default: "info",
};

export function SystemMessagesRecorder() {
  const { toasts } = useSonner();
  // Toast ids already archived this page-load; useSonner re-emits the active
  // list on every change, so without this each update would duplicate entries.
  const seenRef = useRef<Set<string | number>>(new Set());

  useEffect(() => {
    for (const t of toasts) {
      if (seenRef.current.has(t.id)) continue;
      seenRef.current.add(t.id);
      if (typeof t.title !== "string" || !t.title.trim()) continue;
      const type = RECORDED_TYPES[t.type ?? "default"];
      if (!type) continue;
      recordSystemMessage({
        id: `${t.id}-${Date.now()}`,
        type,
        text: t.title,
        path: `${window.location.pathname}${window.location.search}`,
        at: new Date().toISOString(),
      });
    }
  }, [toasts]);

  return null;
}
