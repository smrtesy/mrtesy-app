"use client";

/**
 * The system-messages bell — sits in the sidebar footer next to the
 * SystemStatusStrip dots. One quiet icon (compact-UI rule: no permanent
 * chrome); clicking opens a popover listing every system message / error
 * toast the user was shown (recorded by SystemMessagesRecorder), newest
 * first, each with a deep link back to the screen it appeared on.
 *
 * No read/unread state — explicit user decision (2026-07): this is a plain
 * "come back to it later" archive, not an inbox.
 *
 * Error entries get a "send to Claude" button (admins only — /claude is
 * admin-gated): it composes a diagnostic seed with the full details and
 * delivers it through the inspect-seed contract (deliverInspectSeed), so it
 * lands in the Claude composer as a draft exactly like a marked component.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlertCircle, AlertTriangle, Bell, Bot, CheckCircle2, ExternalLink, Info, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  APP_BRANCH,
  APP_REPO,
  deliverInspectSeed,
} from "@/components/claude/ClaudeInspector";
import { composeDebugSeed } from "@/lib/error-seed";
import {
  SYSTEM_MESSAGES_EVENT,
  clearSystemMessages,
  readSystemMessages,
  type SystemMessageEntry,
  type SystemMessageType,
} from "@/lib/system-messages";
import { useTabsWorkspace } from "@/contexts/TabsWorkspaceContext";

const TYPE_ICON: Record<SystemMessageType, ReactNode> = {
  error: <AlertCircle className="size-3.5 shrink-0 text-destructive" />,
  warning: <AlertTriangle className="size-3.5 shrink-0 text-status-warn" />,
  success: <CheckCircle2 className="size-3.5 shrink-0 text-status-ok" />,
  info: <Info className="size-3.5 shrink-0 text-muted-foreground" />,
};

/** Message time in New York (CLAUDE.md: all user-facing times are America/New_York). */
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

export function SystemMessagesBell({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("systemMessages");
  const locale = useLocale();
  const router = useRouter();
  const { openTab } = useTabsWorkspace();
  const [entries, setEntries] = useState<SystemMessageEntry[]>([]);

  // Cold read on mount + live refresh: the recorder in THIS document dispatches
  // SYSTEM_MESSAGES_EVENT after every write; toasts inside iframe panes write
  // from their own document, which reaches us as the cross-document "storage"
  // event instead.
  useEffect(() => {
    const refresh = () => setEntries(readSystemMessages());
    refresh();
    window.addEventListener(SYSTEM_MESSAGES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SYSTEM_MESSAGES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  /** Compose the diagnostic seed and land it in the Claude composer as a draft.
   *  Uses the shared builder so the rich detail (endpoint/status/body/stack) and
   *  the "screenshot the screen first" instruction match the global catcher. */
  const sendToClaude = useCallback(
    (entry: SystemMessageEntry) => {
      const seed = composeDebugSeed(entry, t, nyTime(entry.at, locale), navigator.userAgent);
      deliverInspectSeed({ text: seed, repo: APP_REPO, branch: APP_BRANCH });
      router.push(`/${locale}/claude`);
    },
    [locale, router, t],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("bell")}
          title={t("bell")}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold">{t("title")}</span>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={clearSystemMessages}
              aria-label={t("clear")}
              title={t("clear")}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>

        {entries.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {entries.map((e) => (
              <li key={e.id} className="flex gap-2 border-b px-3 py-2 text-xs last:border-b-0">
                <span className="mt-0.5">{TYPE_ICON[e.type] ?? TYPE_ICON.info}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words" dir="auto">{e.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span className="tabular-nums" title="America/New_York">
                      {nyTime(e.at, locale)} NY
                    </span>
                    <button
                      type="button"
                      onClick={() => openTab(e.path, t("pageTab"))}
                      title={e.path}
                      className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate" dir="ltr">{e.path}</span>
                    </button>
                    {isAdmin && e.type === "error" && (
                      <button
                        type="button"
                        onClick={() => sendToClaude(e)}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Bot className="size-3 shrink-0" />
                        {t("sendToClaude")}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
