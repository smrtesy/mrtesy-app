"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SuggestionTabs } from "@/components/smrttask/suggestions/SuggestionTabs";
import { NotificationsList } from "@/components/platform/inbox/NotificationsList";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

interface Props {
  locale: string;
  hasSmrtTask: boolean;
}

export interface InboxCounts {
  messages: number;
  scheduled: number;
  projects: number;
  notifications: number;
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ms-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function InboxTabs({ locale, hasSmrtTask }: Props) {
  const t = useTranslations("inbox");
  const supabase = createClient();
  const [tab, setTab] = useState<"suggestions" | "notifications">(
    hasSmrtTask ? "suggestions" : "notifications",
  );
  const [counts, setCounts] = useState<InboxCounts>({ messages: 0, scheduled: 0, projects: 0, notifications: 0 });

  const fetchCounts = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [messagesRes, scheduledRes, projectsRes, notifRes] = await Promise.all([
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "inbox").eq("manually_verified", false).not("source_message_id", "is", null),
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "snoozed").not("snoozed_until", "is", null),
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("task_type", "project_suggestion").eq("status", "inbox"),
      supabase.from("notifications").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("is_read", false),
    ]);

    setCounts({
      messages:      messagesRes.count  ?? 0,
      scheduled:     scheduledRes.count ?? 0,
      projects:      projectsRes.count  ?? 0,
      notifications: notifRes.count     ?? 0,
    });
  }, [supabase]);

  useEffect(() => { fetchCounts(); }, [fetchCounts]);

  const totalSuggestions = counts.messages + counts.scheduled + counts.projects;

  return (
    <div className="space-y-4">
      {hasSmrtTask && (
        <div className="flex gap-1 border-b">
          <button
            onClick={() => setTab("suggestions")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center",
              tab === "suggestions"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("tabSuggestions")}
            <CountBadge count={totalSuggestions} />
          </button>
          <button
            onClick={() => setTab("notifications")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center",
              tab === "notifications"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("tabNotifications")}
            <CountBadge count={counts.notifications} />
          </button>
        </div>
      )}

      {tab === "suggestions" && hasSmrtTask && (
        <SuggestionTabs locale={locale} counts={counts} onCountsChange={fetchCounts} />
      )}

      {tab === "notifications" && (
        <NotificationsList />
      )}
    </div>
  );
}
