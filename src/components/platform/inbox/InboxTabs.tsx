"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { SuggestionTabs } from "@/components/smrttask/suggestions/SuggestionTabs";
import { NotificationsList } from "@/components/platform/inbox/NotificationsList";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { todayISO } from "@/lib/workdays";

interface Props {
  locale: string;
  hasSmrtTask: boolean;
}

export interface InboxCounts {
  messages: number;
  scheduled: number;
  projects: number;
  dismissed: number;
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
  const [counts, setCounts] = useState<InboxCounts>({ messages: 0, scheduled: 0, projects: 0, dismissed: 0, notifications: 0 });

  const fetchCounts = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [messagesRes, scheduledRes, datedRes, recurringRes, projectsRes, dismissedRes, notifRes] = await Promise.all([
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "inbox").eq("manually_verified", false).not("source_message_id", "is", null),
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "snoozed").not("snoozed_until", "is", null)
        // Recurring tasks are counted in their own section below — exclude here
        // to match the scheduled window's display (one task, one section).
        .is("recurrence_rule", null),
      // Future-dated active tasks — the "scheduled by date" track. Counted into
      // the scheduled badge alongside snoozed rows. Verified only, so an
      // unverified dated suggestion (still in the Messages tab) isn't double-counted.
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("manually_verified", true)
        .not("due_date", "is", null).gt("due_date", todayISO())
        .in("status", ["inbox", "in_progress"])
        .is("recurrence_rule", null),
      // Recurring active tasks — the recurring section of the scheduled window.
      // Verified only: an unverified recurring suggestion still lives in the
      // Messages tab, so counting it here too would double-count it.
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("manually_verified", true)
        .not("recurrence_rule", "is", null)
        .in("status", ["inbox", "in_progress", "snoozed"]),
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("task_type", "project_suggestion").eq("status", "inbox"),
      supabase.from("tasks").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "dismissed"),
      supabase.from("notifications").select("*", { count: "exact", head: true })
        .eq("user_id", user.id).eq("is_read", false)
        // inbox_digest is push-only — keep it out of the tab badge. Keep NULLs.
        .or("entity_type.is.null,entity_type.neq.inbox_digest"),
    ]);

    setCounts({
      messages:      messagesRes.count  ?? 0,
      scheduled:     (scheduledRes.count ?? 0) + (datedRes.count ?? 0) + (recurringRes.count ?? 0),
      projects:      projectsRes.count  ?? 0,
      dismissed:     dismissedRes.count ?? 0,
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
