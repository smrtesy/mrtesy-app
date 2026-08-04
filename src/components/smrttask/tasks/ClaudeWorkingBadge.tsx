"use client";

import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

/**
 * "בתהליך עם קלוד" badge — shown on a task that the user handed to the built-in
 * Claude console (POST /tasks/:id/claude-thread sets `claude_thread_id`). Clicking
 * it opens that exact thread in a new tab (imperative deep link). Renders nothing
 * when no Claude chat is active, so it's a pure no-op on ordinary tasks.
 */
export function ClaudeWorkingBadge({
  task,
  locale,
  className,
}: {
  task: Pick<Task, "claude_thread_id">;
  locale: string;
  className?: string;
}) {
  const t = useTranslations("claude");
  if (!task.claude_thread_id) return null;
  return (
    <OpenTabLink
      href={`/${locale}/claude?thread=${task.claude_thread_id}`}
      label={t("tabLabel")}
      title={t("workingBadge")}
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20",
        className,
      )}
    >
      <Bot className="h-3 w-3 shrink-0" />
      {t("workingBadge")}
    </OpenTabLink>
  );
}
