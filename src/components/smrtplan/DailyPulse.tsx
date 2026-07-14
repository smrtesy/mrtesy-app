"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Activity, ChevronDown, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface PulseDay {
  date: string;
  workday: boolean;
  done: boolean;
  debriefed: boolean;
  is_today: boolean;
}
interface PulseAssignee {
  user_id: string;
  display_name: string | null;
  daily_minutes: number | null;
  workdays: number[] | null;
  streak_missed: number;
  days: PulseDay[];
}

/**
 * Manager "daily pulse" for a plan (debrief-enforcement brief §2): per performer,
 * which of the recent days they did/missed their focus task, against their own
 * work week. Compact + collapsed by default (CLAUDE.md minimal-UI rule): a quiet
 * icon toggle that fetches on first open. Planner-only (endpoint is requireFull).
 */
export function DailyPulse({
  planId,
  locale,
  memberMap,
}: {
  planId: string;
  locale: string;
  memberMap: Map<string, string>;
}) {
  const t = useTranslations("smrtPlan.pulse");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [assignees, setAssignees] = useState<PulseAssignee[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { assignees } = await api<{ assignees: PulseAssignee[] }>(`/api/plan/${planId}/pulse`);
      setAssignees(assignees ?? []);
      setLoaded(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [planId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) void load();
  }

  const Chevron = locale === "he" ? ChevronLeft : ChevronDown;
  const name = (a: PulseAssignee) => memberMap.get(a.user_id) || a.display_name || a.user_id.slice(0, 8);

  return (
    <div className="mb-3">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-accent"
        title={t("title")}
      >
        <Activity className="h-3.5 w-3.5" />
        {t("title")}
        <Chevron className={cn("h-3.5 w-3.5 transition-transform", open && locale !== "he" && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-2 rounded-md border bg-card p-2.5">
          {loading ? (
            <div className="h-10 animate-pulse rounded bg-muted" />
          ) : assignees.length === 0 ? (
            <p className="py-2 text-center text-[12px] italic text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="space-y-2.5">
              {assignees.map((a) => (
                <div key={a.user_id} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-[12px] font-medium" dir="auto">{name(a)}</span>
                  {a.streak_missed > 0 && (
                    <span className="shrink-0 rounded bg-status-late-bg px-1.5 py-px text-[10px] font-bold text-status-late">
                      {t("streak", { n: a.streak_missed })}
                    </span>
                  )}
                  <div className="flex flex-1 flex-row-reverse justify-end gap-0.5" dir="ltr">
                    {/* days come newest-first; row-reverse renders oldest→newest left→right */}
                    {a.days.map((d) => (
                      <span
                        key={d.date}
                        title={`${d.date}${d.done ? " ✓" : d.is_today ? "" : d.workday ? " ✗" : ""}${d.debriefed ? " · " + t("debriefed") : ""}`}
                        className={cn(
                          "relative h-4 w-4 rounded-sm",
                          // Today, still open and not yet done → neutral (not a miss yet).
                          !d.workday ? "bg-muted" : d.done ? "bg-status-ok" : d.is_today ? "bg-muted ring-1 ring-primary" : "bg-status-late/70",
                        )}
                      >
                        {d.debriefed && <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-card" />}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <p className="pt-1 text-[10.5px] text-muted-foreground">{t("legend")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
