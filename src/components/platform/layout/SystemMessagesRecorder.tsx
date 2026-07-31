"use client";

/**
 * Records every sonner toast into the system-messages archive (the bell in the
 * sidebar). Mounted once inside TabsWorkspaceProvider in the (app) layout;
 * renders nothing.
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
 *
 * The recorded page: panes deliberately never change the top URL, so in the
 * top window the ACTIVE TAB's href is the screen the user was on — not
 * window.location (which stays on whatever route the workspace was entered
 * from). Inside an iframe pane this component runs in the pane's own document,
 * where window.location IS the pane's URL. The internal `?embed=1` flag is
 * stripped so archived links reopen cleanly.
 */

import { useEffect, useRef } from "react";
import { useSonner } from "sonner";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
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

/** pathname?search with the internal `embed` pane flag removed. */
function cleanPath(pathname: string, search: string): string {
  const q = new URLSearchParams(search);
  q.delete("embed");
  const qs = q.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function SystemMessagesRecorder() {
  const { toasts } = useSonner();
  const workspace = useOptionalTabsWorkspace();
  // Toast ids already archived this page-load; useSonner re-emits the active
  // list on every change, so without this each update would duplicate entries.
  const seenRef = useRef<Set<string | number>>(new Set());

  // Read via a ref so tab switches don't re-run the toast effect below.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    const currentPath = (): string => {
      // Iframe pane: this document's own URL names the screen exactly.
      const embedded = typeof window !== "undefined" && window.self !== window.top;
      if (!embedded) {
        const ws = workspaceRef.current;
        const active = ws?.activeId ? ws.tabs.find((t) => t.id === ws.activeId)?.href : null;
        if (active) {
          const [p, s = ""] = active.split("?");
          return cleanPath(p, s);
        }
      }
      return cleanPath(window.location.pathname, window.location.search);
    };

    for (const t of toasts) {
      if (seenRef.current.has(t.id)) continue;
      if (typeof t.title !== "string" || !t.title.trim()) continue;
      const type = RECORDED_TYPES[t.type ?? "default"];
      if (!type) continue;
      // Marked seen only once actually recorded, so a toast updated in place
      // (loading → error via the same id) is archived when it becomes recordable.
      seenRef.current.add(t.id);
      recordSystemMessage({
        id: `${t.id}-${Date.now()}`,
        type,
        text: t.title,
        path: currentPath(),
        at: new Date().toISOString(),
      });
    }
  }, [toasts]);

  return null;
}
