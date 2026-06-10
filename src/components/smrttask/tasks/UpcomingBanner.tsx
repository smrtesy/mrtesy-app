"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { BellRing, CalendarClock, Clock } from "lucide-react";

interface UpcomingRow {
  id: string;
  title: string | null;
  title_he: string | null;
  due_date: string | null;
  due_time: string | null;
  reminder_at: string | null;
  task_type: string | null;
  status: string | null;
}

interface UpcomingItem {
  id: string;
  title: string;
  at: Date;
  isMeeting: boolean;
}

// How far ahead an item must be to count as "soon", and how long after its
// moment we keep showing it (so a just-now meeting doesn't vanish instantly).
const LOOKAHEAD_MS = 60 * 60 * 1000; // next hour
const GRACE_MS = 30 * 60 * 1000;     // up to 30 min past

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// The precise instant a task is "scheduled for": its reminder_at if set,
// otherwise its due_date + due_time. Null if it has no clock moment.
function scheduledMoment(row: UpcomingRow): Date | null {
  if (row.reminder_at) {
    const d = new Date(row.reminder_at);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (row.due_date && row.due_time) {
    const d = new Date(`${row.due_date}T${row.due_time}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * UpcomingBanner — a prominent, pinned indicator for tasks that have a
 * scheduled moment arriving right now or within the next hour (e.g. a meeting
 * an hour away, or a reminder firing). Far louder than a row in the suggestions
 * list: it sits at the very top of the page with an accent background and a
 * pulsing bell, so a timed task can't slip past unseen.
 *
 * Refreshes its data every minute and re-renders the countdown on the same
 * tick, so "in 42 min" stays honest.
 */
export function UpcomingBanner({ locale }: { locale: string }) {
  const t = useTranslations("upcoming");
  const supabase = createClient();
  const [items, setItems] = useState<UpcomingItem[]>([]);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setItems([]); return; }

    const now = new Date();
    const todayStr = localDateStr(now);
    // Pull the small set of candidates (anything with a reminder, plus anything
    // due today), then pick the imminent ones client-side where we can combine
    // due_date + due_time and apply the tz-correct window.
    const { data } = await supabase
      .from("tasks")
      .select("id, title, title_he, due_date, due_time, reminder_at, task_type, status")
      .eq("user_id", user.id)
      .not("status", "in", "(archived,completed,dismissed,snoozed)")
      .or(`reminder_at.not.is.null,due_date.eq.${todayStr}`)
      .limit(100);

    const t0 = Date.now();
    const next: UpcomingItem[] = (data as UpcomingRow[] | null ?? [])
      .map((row) => {
        const at = scheduledMoment(row);
        if (!at) return null;
        const delta = at.getTime() - t0;
        if (delta > LOOKAHEAD_MS || delta < -GRACE_MS) return null;
        return {
          id: row.id,
          title: (locale === "he" && row.title_he ? row.title_he : row.title) || "",
          at,
          isMeeting: row.task_type === "meeting",
        } as UpcomingItem;
      })
      .filter((x): x is UpcomingItem => x !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    setItems(next);
  }, [supabase, locale]);

  useEffect(() => {
    load();
    // Skip reloads while the tab is hidden (a background tab otherwise polls
    // around the clock); refresh immediately when the user comes back.
    const handleVisibility = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", handleVisibility);
    const id = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(id);
    };
  }, [load]);

  if (items.length === 0) return null;

  const dtFmt = locale === "he" ? "he-IL" : "en-US";

  function whenLabel(at: Date): string {
    const mins = Math.round((at.getTime() - Date.now()) / 60_000);
    if (mins <= 0) return t("now");
    return t("inMinutes", { min: mins });
  }

  return (
    <div className="rounded-lg border border-status-warn/40 bg-status-warn-bg p-3 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-warn opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-status-warn" />
        </span>
        <BellRing className="h-4 w-4 text-status-warn" />
        <h2 className="text-sm font-semibold text-status-warn">
          {t("title")} ({items.length})
        </h2>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm">
            {item.isMeeting
              ? <CalendarClock className="h-4 w-4 shrink-0 text-status-warn" />
              : <Clock className="h-4 w-4 shrink-0 text-status-warn" />}
            <span className="font-medium truncate" dir="auto">{item.title}</span>
            <span className="ms-auto shrink-0 text-xs text-muted-foreground" dir="ltr">
              {item.at.toLocaleTimeString(dtFmt, { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="shrink-0 rounded-full bg-status-warn/15 px-2 py-0.5 text-[11px] font-medium text-status-warn">
              {whenLabel(item.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
