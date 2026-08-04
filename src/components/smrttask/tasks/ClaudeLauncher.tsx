"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, Copy, Check } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { useOpenTab } from "@/components/platform/layout/OpenTabLink";
import { toast } from "sonner";
import type { Task } from "@/types/task";

/**
 * "Work with Claude" launcher — a quiet Bot icon in the task-detail action row
 * that expands (compact, collapsed-by-default) to:
 *   1. open a NEW chat in the BUILT-IN Claude console (server/src/modules/claude),
 *      seeded with the task's context, and mark the task "in progress with Claude"
 *      (status → in_progress + claude_thread_id) so the user can move on;
 *   2. copy the task's context (serial, title, description, verbatim links) — a
 *      manual escape hatch;
 *   3. clear the waiting flag once the user marks Claude finished.
 *
 * Claude works the task in-app and, when done, offers to mark it completed — so the
 * loop closes without the user leaving the app. Runs on the subscription (zero paid
 * API tokens).
 */

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
  const openTab = useOpenTab();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const waiting = !!task.claude_waiting_since;

  async function openInClaude() {
    setOpening(true);
    // Opening the task's existing chat again (re-open) — no need to spawn a new one.
    if (waiting && task.claude_thread_id) {
      openTab(`/${locale}/claude?thread=${task.claude_thread_id}`, t("tabLabel"));
      setOpen(false);
      setOpening(false);
      return;
    }
    // Handing a task to Claude IS starting it — the server advances a not-yet-started
    // task to in_progress; mirror that in the optimistic snapshot so the open detail
    // reflects it before the refetch lands.
    const advance = task.status === "inbox" || task.status === "snoozed";
    const since = new Date().toISOString();
    try {
      const { thread_id } = await api<{ thread_id: string }>(`/api/tasks/${task.id}/claude-thread`, {
        method: "POST",
      });
      onOptimistic?.({
        claude_waiting_since: since,
        claude_thread_id: thread_id,
        ...(advance ? { status: "in_progress" } : {}),
      });
      openTab(`/${locale}/claude?thread=${thread_id}`, t("tabLabel"));
      toast.success(t("dispatched"));
      setOpen(false);
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setOpening(false);
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
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { claude_waiting_since: null, claude_thread_id: null },
      });
      onOptimistic?.({ claude_waiting_since: null, claude_thread_id: null });
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

        <Button
          size="sm"
          className="w-full justify-center gap-1.5"
          onClick={openInClaude}
          disabled={opening}
        >
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

        <p className="text-[11px] leading-snug text-muted-foreground">{t("consoleHint")}</p>
      </PopoverContent>
    </Popover>
  );
}
