"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, Copy, Check } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import type { Task } from "@/types/task";

/**
 * "Work with Claude" launcher — a quiet Bot icon in the task-detail action row
 * that expands (compact, collapsed-by-default) to:
 *   1. open claude.ai/code in a popup window beside the app (claude.ai blocks
 *      in-page iframes via X-Frame-Options, so a separate window is the closest
 *      the browser allows), marking the task "waiting on Claude" so the user can
 *      move on to other work;
 *   2. copy the task's context (serial, title, description, verbatim links) to
 *      paste into Claude;
 *   3. clear the flag once the user sees Claude finished.
 *
 * Completion is signalled by claude.ai's own browser notifications — this panel
 * nudges the user to enable them so they don't have to babysit the Claude window.
 */

// Module-level so a re-open reuses the same window across detail mounts, instead
// of spawning a fresh (and reloaded) Claude tab each time.
let claudeWindow: Window | null = null;

const CLAUDE_CODE_URL = "https://claude.ai/code";

/** Build the paste-ready context. URLs are emitted verbatim (deep links), never
 *  paraphrased down to a domain — see CLAUDE.md "preserve deep links". */
function buildContext(task: Task, locale: string): string {
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const lines: string[] = [`${task.serial_display}: ${title}`];
  if (task.description?.trim()) {
    lines.push("", task.description.trim());
  }

  const urls: string[] = [];
  const push = (u?: string | null) => {
    const v = (u ?? "").trim();
    if (v && !urls.includes(v)) urls.push(v);
  };
  for (const m of task.task_materials ?? []) push(m.url);
  for (const d of task.linked_drive_docs ?? []) push(d.url);
  push(task.source_messages?.source_url);

  if (urls.length) {
    lines.push("", locale === "he" ? "קישורים:" : "Links:", ...urls);
  }
  return lines.join("\n");
}

export function ClaudeLauncher({
  task,
  locale,
  onUpdate,
  onOptimistic,
}: {
  task: Task;
  locale: string;
  /** Refresh the parent list/detail after the waiting flag changes. */
  onUpdate: () => void;
  /** Merge a field change into the caller's local snapshot so the open detail
   *  reflects the new waiting state immediately (before any refetch lands). */
  onOptimistic?: (patch: Partial<Task>) => void;
}) {
  const t = useTranslations("claude");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const waiting = !!task.claude_waiting_since;

  function openClaude() {
    // window.open MUST run synchronously inside the click (a later call, after an
    // await, loses the user gesture and gets blocked as a popup). PATCH after.
    if (claudeWindow && !claudeWindow.closed) {
      claudeWindow.focus();
    } else {
      const w = 1000;
      const h = Math.min((typeof screen !== "undefined" ? screen.availHeight : 900) - 40, 900);
      const left = Math.max(0, window.screenX + window.outerWidth - w);
      const top = window.screenY + 40;
      // No `noopener`: we deliberately keep the returned reference so a later
      // click focuses the existing Claude window instead of reloading a new one.
      claudeWindow = window.open(
        CLAUDE_CODE_URL,
        "smrtesy-claude",
        `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
      );
    }
    setOpen(false);

    if (!waiting) {
      const since = new Date().toISOString();
      onOptimistic?.({ claude_waiting_since: since });
      api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { claude_waiting_since: since },
      })
        .then(() => {
          toast.success(t("dispatched"));
          onUpdate();
        })
        .catch((e) => {
          // Roll back the optimistic flag so the open detail doesn't show a
          // "waiting" state the DB never persisted.
          onOptimistic?.({ claude_waiting_since: null });
          toast.error(e instanceof Error ? e.message : "Error");
        });
    }
  }

  async function copyContext() {
    try {
      await navigator.clipboard.writeText(buildContext(task, locale));
      toast.success(t("contextCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  async function markDone() {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { claude_waiting_since: null } });
      onOptimistic?.({ claude_waiting_since: null });
      toast.success(t("markedDone"));
      setOpen(false);
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const waitingSince = task.claude_waiting_since
    ? new Date(task.claude_waiting_since).toLocaleString(locale === "he" ? "he-IL" : undefined, {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : "";

  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={t("launcherLabel")}
          color="primary"
          aria-pressed={waiting}
          className={waiting ? "text-primary" : undefined}
        >
          <Bot className={waiting ? "fill-current" : undefined} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" dir={dir} className="w-64 p-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Bot className="h-4 w-4 text-primary" />
          {t("title")}
        </div>

        <Button size="sm" className="w-full justify-center gap-1.5" onClick={openClaude}>
          <Bot className="h-4 w-4" />
          {waiting ? t("openAgain") : t("open")}
        </Button>

        <Button size="sm" variant="outline" className="w-full justify-center gap-1.5" onClick={copyContext}>
          <Copy className="h-4 w-4" />
          {t("copyContext")}
        </Button>

        {waiting && (
          <div className="space-y-1.5 rounded-md bg-primary/5 p-2">
            <p className="text-[11px] text-primary">{t("waitingSince", { time: waitingSince })}</p>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-center gap-1.5 text-status-ok hover:text-status-ok"
              disabled={busy}
              onClick={markDone}
            >
              <Check className="h-4 w-4" />
              {t("markDone")}
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-snug text-muted-foreground">{t("notifyHint")}</p>
        <p className="text-[10px] leading-snug text-muted-foreground/70">{t("openHint")}</p>
      </PopoverContent>
    </Popover>
  );
}
