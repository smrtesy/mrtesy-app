"use client";

/**
 * Mounts the global client-error catcher (src/lib/error-capture.ts) once in the
 * (app) layout and renders nothing.
 *
 * Two responsibilities that need React context (which the plain capture lib does
 * not have):
 *   1. Tell the capture lib whether the user is a super-admin, so an uncaught
 *      error's toast may carry a "debug in Claude" action (/claude is admin-gated).
 *   2. Handle that action's OPEN_CLAUDE_DEBUG_EVENT: compose the diagnostic seed
 *      and navigate to /claude via the router — an SPA push, not the hard reload a
 *      non-React module would be stuck with.
 *
 * API errors need no work here: their toast is archived by SystemMessagesRecorder
 * (which attaches the stashed detail), and the bell's own button launches Claude.
 * This component is only the window-level net + the toast-action navigator.
 */

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { APP_BRANCH, APP_REPO, deliverInspectSeed } from "@/components/claude/ClaudeInspector";
import {
  OPEN_CLAUDE_DEBUG_EVENT,
  installGlobalErrorCatcher,
  setDebugAffordance,
  type OpenClaudeDebugDetail,
} from "@/lib/error-capture";
import { composeDebugSeed } from "@/lib/error-seed";
import type { SystemMessageEntry } from "@/lib/system-messages";

/** Entry time in New York (CLAUDE.md: all user-facing times are America/New_York). */
function nyTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function ClientErrorCatcher({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("systemMessages");
  const locale = useLocale();
  const router = useRouter();

  // Install the window-level catcher once.
  useEffect(() => installGlobalErrorCatcher(), []);

  // Keep the capture lib's admin flag in sync.
  useEffect(() => setDebugAffordance(isAdmin), [isAdmin]);

  // The toast action fires this; compose the seed and open Claude.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenClaudeDebugDetail>).detail;
      if (!d) return;
      const at = new Date().toISOString();
      const entry: SystemMessageEntry = {
        id: `${Date.now()}`,
        type: "error",
        text: d.text,
        path: d.path,
        at,
        detail: d.detail,
      };
      const seed = composeDebugSeed(entry, t, nyTime(at, locale), navigator.userAgent);
      deliverInspectSeed({ text: seed, repo: APP_REPO, branch: APP_BRANCH });
      router.push(`/${locale}/claude`);
    };
    window.addEventListener(OPEN_CLAUDE_DEBUG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CLAUDE_DEBUG_EVENT, onOpen);
  }, [t, locale, router]);

  return null;
}
