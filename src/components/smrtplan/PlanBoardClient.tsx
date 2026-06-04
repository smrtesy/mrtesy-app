"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanAccessLevel } from "@/types/plan";
import { parseISO, gregShort, hebDate, daysBetween } from "@/lib/smrtplan/dates";
import { PlanMatrix } from "./PlanMatrix";
import { PlanEffortDetail } from "./PlanEffortDetail";

const DAY_MS = 86_400_000;
/** Pixels per day on the timeline. The track is wider than the viewport, so the
 *  chart scrolls horizontally to reveal future dates (instead of squeezing the
 *  whole span into view). */
const DAY_PX = 16;

type Health = "waiting" | "on_track" | "at_risk" | "late" | "stream";

function planTitle(p: Plan, locale: string): string {
  return locale === "en" ? p.title_en || p.title_he : p.title_he;
}

/** Path-free interim health, computed against the chosen "today" (like the prototype). */
function computeHealth(p: Plan, today: Date): Health {
  // A plan that hasn't started yet (start date still in the future) is "waiting".
  if (p.start_date && today < parseISO(p.start_date)) return "waiting";
  if (p.kind === "stream") return "stream";
  if (!p.start_date || !p.end_date) return "on_track";
  const s = parseISO(p.start_date);
  const e = parseISO(p.end_date);
  const total = Math.max(1, daysBetween(s, e));
  const elapsed = daysBetween(s, today);
  const expected = Math.min(1, Math.max(0, elapsed / total));
  const progress = p.effective_progress ?? p.progress ?? 0;
  const diff = progress - expected;
  if (diff >= -0.05) return "on_track";
  if (diff > -0.2) return "at_risk";
  return "late";
}

const healthColor: Record<Health, string> = {
  waiting: "hsl(var(--muted-foreground))",
  on_track: "hsl(var(--status-ok))",
  at_risk: "hsl(var(--status-warn))",
  late: "hsl(var(--status-late))",
  stream: "hsl(var(--primary))",
};

export function PlanBoardClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<PlanAccessLevel>("lite");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [todayOffset, setTodayOffset] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ plans }, { access_level }] = await Promise.all([
          api<{ plans: Plan[] }>("/api/plans/board"),
          api<{ access_level: PlanAccessLevel }>("/api/plans/access"),
        ]);
        if (!alive) return;
        setPlans(plans ?? []);
        setAccess(access_level ?? "lite");
        if (plans?.length) setSelectedId((cur) => cur ?? plans[0].id);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Timeline bounds from the data (fallback: today .. +90d).
  const { t0, totalDays } = useMemo(() => {
    const starts = plans.map((p) => p.start_date).filter(Boolean) as string[];
    const ends = plans.map((p) => p.end_date).filter(Boolean) as string[];
    if (!starts.length) {
      const now = new Date();
      return { t0: now, totalDays: 90 };
    }
    const minS = starts.reduce((a, b) => (a < b ? a : b));
    const maxE = (ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : minS);
    const start = parseISO(minS);
    const end = parseISO(maxE);
    return { t0: start, totalDays: Math.max(14, daysBetween(start, end) + 7) };
  }, [plans]);

  // Default "today" marker to the real today clamped into the window.
  useEffect(() => {
    const real = daysBetween(t0, new Date());
    setTodayOffset(Math.min(totalDays, Math.max(0, real)));
  }, [t0, totalDays]);

  const dateAt = (off: number) => new Date(t0.getTime() + off * DAY_MS);
  const pxOf = (off: number) => off * DAY_PX;
  const offsetOf = (iso: string) => daysBetween(t0, parseISO(iso));
  const today = dateAt(todayOffset);
  const trackWidth = totalDays * DAY_PX;

  // Group plans by group_label, preserving first-seen order.
  const groups = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans) {
      const key = p.group_label || "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()];
  }, [plans]);

  // Week gridlines.
  const weeks = useMemo(() => {
    const out: number[] = [];
    for (let o = 0; o < totalDays; o += 7) out.push(o);
    return out;
  }, [totalDays]);

  const selected = plans.find((p) => p.id === selectedId) ?? null;

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div>
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <p className="text-[12.5px] text-muted-foreground">{t("lead")}</p>
      </div>

      {access === "lite" && (
        <div className="rounded-lg border bg-secondary px-3 py-2 text-[12px] text-muted-foreground">
          {t("liteNotice")}
        </div>
      )}

      {/* controls */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-3">
        <label className="whitespace-nowrap text-[13px] font-medium">{t("today")}:</label>
        <input
          type="range"
          min={0}
          max={totalDays}
          value={todayOffset}
          onChange={(e) => setTodayOffset(Number(e.target.value))}
          className="min-w-[150px] flex-1 accent-primary"
        />
        <span className="whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-[13px] font-bold text-accent-foreground">
          {gregShort(today)} · {hebDate(today)}
        </span>
        <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
          <LegendDot color="hsl(var(--muted-foreground))" label={t("legend.waiting")} />
          <LegendDot color="hsl(var(--status-ok))" label={t("legend.onTrack")} />
          <LegendDot color="hsl(var(--status-warn))" label={t("legend.atRisk")} />
          <LegendDot color="hsl(var(--status-late))" label={t("legend.late")} />
        </div>
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center">
          <p className="text-sm font-medium">{t("board.empty")}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{t("board.emptyHint")}</p>
        </div>
      ) : (
        <div className="flex overflow-hidden rounded-xl border bg-card">
          {/* fixed label column (stays while the timeline scrolls) */}
          <div className="w-[168px] flex-shrink-0 border-e">
            <div className="flex h-12 items-center border-b bg-secondary/60 px-3 text-[12px] font-bold text-muted-foreground">
              {t("title")}
            </div>
            {groups.map(([label, rows]) => (
              <div key={label}>
                <div className="flex h-[30px] items-center bg-secondary px-3 text-[12px] font-bold text-foreground/80">
                  {label}
                </div>
                {rows.map((p) => {
                  const h = computeHealth(p, today);
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      className={cn(
                        "flex h-[52px] w-full flex-col justify-center gap-1 overflow-hidden border-b px-3 text-start transition-colors hover:bg-accent/40",
                        selectedId === p.id && "bg-accent/60",
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-bold" title={planTitle(p, locale)}>
                        <span className="truncate">{planTitle(p, locale)}</span>
                        {p.is_critical && (
                          <span className="shrink-0 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                            {t("tags.critical")}
                          </span>
                        )}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] font-medium"
                        style={{ color: healthColor[h] }}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: healthColor[h] }} />
                        {t(`health.${h}`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* scrollable timeline */}
          <div className="flex-1 overflow-x-auto">
            <div style={{ width: trackWidth }}>
              {/* week strip */}
              <div className="relative h-12 border-b bg-secondary/60">
                {weeks.map((o) => (
                  <div
                    key={o}
                    className="absolute top-0 flex h-full flex-col items-center justify-center gap-0.5 border-e"
                    style={{ insetInlineStart: pxOf(o), width: 7 * DAY_PX }}
                  >
                    <span className="whitespace-nowrap text-[10.5px] font-medium">{gregShort(dateAt(o))}</span>
                    <span className="whitespace-nowrap text-[9.5px] text-muted-foreground">{hebDate(dateAt(o))}</span>
                  </div>
                ))}
                <div
                  className="absolute inset-y-0 z-[5] w-0.5 bg-foreground"
                  style={{ insetInlineStart: pxOf(todayOffset) }}
                />
              </div>

              {groups.map(([label, rows]) => (
                <div key={label}>
                  <div className="h-[30px] border-b bg-secondary" />
                  {rows.map((p) => {
                    const s = p.start_date ? offsetOf(p.start_date) : 0;
                    const e = p.end_date ? offsetOf(p.end_date) : s + 7;
                    const span = Math.max(1, e - s);
                    const progress = p.effective_progress ?? p.progress ?? 0;
                    const isStream = p.kind === "stream";
                    return (
                      <button
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "relative block h-[52px] w-full border-b transition-colors hover:bg-accent/30",
                          selectedId === p.id && "bg-accent/40",
                        )}
                      >
                        <div
                          className={cn(
                            "absolute top-2.5 h-8 overflow-hidden rounded-md border",
                            isStream && "border-dashed",
                          )}
                          style={{
                            insetInlineStart: pxOf(s),
                            width: pxOf(span),
                            background: (p.color || "#534AB7") + "1f",
                            borderColor: (p.color || "#534AB7") + (isStream ? "99" : "55"),
                          }}
                        >
                          {!isStream && (
                            <div
                              className="absolute inset-y-0 start-0 h-full"
                              style={{ width: `${progress * 100}%`, background: (p.color || "#534AB7") + "44" }}
                            />
                          )}
                        </div>
                        <div
                          className="pointer-events-none absolute top-[22px] flex h-[18px] items-center whitespace-nowrap px-2 text-[11px] font-medium"
                          style={{ insetInlineStart: pxOf(s), color: p.color || "#534AB7" }}
                        >
                          {isStream
                            ? p.goal || ""
                            : `${p.goal || ""}${p.goal ? "  ·  " : ""}${Math.round(progress * 100)}%`}
                        </div>
                        {/* today line */}
                        <div
                          className="absolute inset-y-0 z-[5] w-px bg-foreground/70"
                          style={{ insetInlineStart: pxOf(todayOffset) }}
                        />
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* detail */}
      {selected && (
        <div className="rounded-xl border bg-card p-4">
          {selected.kind === "stream" ? (
            <PlanMatrix plan={selected} locale={locale} canEdit={access === "full"} today={today} />
          ) : (
            <PlanEffortDetail plan={selected} locale={locale} today={today} />
          )}
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
