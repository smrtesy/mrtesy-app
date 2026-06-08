"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Plus, Pencil, Flag, Users, Clock } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanAccessLevel, PlanMilestone } from "@/types/plan";
import { parseISO, gregShort, hebDate, hebDay, hebMonth, gregMonthLabel, daysBetween, countdownText } from "@/lib/smrtplan/dates";
import { PlanMatrix } from "./PlanMatrix";
import { PlanEffortDetail } from "./PlanEffortDetail";
import { PlanEditDialog } from "./PlanEditDialog";
import { MilestoneEditor } from "./MilestoneEditor";
import { CapacityEditor } from "./CapacityEditor";
import { EstimatesEditor } from "./EstimatesEditor";

const DAY_MS = 86_400_000;
/** Pixels per working-day column on the timeline. The track is wider than the
 *  viewport, so the chart scrolls horizontally to reveal future dates (instead
 *  of squeezing the whole span into view). */
const COL_PX = 22;
/** Weekday numbers hidden from the board (0 = Sunday, 6 = Saturday). The board
 *  shows only Monday–Friday columns; positions compress over the hidden days. */
const HIDDEN_DOW = new Set([0, 6]);

type Health = "waiting" | "on_track" | "at_risk" | "late" | "stream";

function planTitle(p: Plan, locale: string): string {
  return locale === "en" ? p.title_en || p.title_he : p.title_he;
}

/** Interim health fallback when the engine hasn't filled plan.health yet. */
function fallbackHealth(p: Plan, today: Date): Health {
  if (p.start_date && today < parseISO(p.start_date)) return "waiting";
  if (p.kind === "stream") return "stream";
  if (!p.start_date || !p.end_date) return "on_track";
  const s = parseISO(p.start_date);
  const e = parseISO(p.end_date);
  const total = Math.max(1, daysBetween(s, e));
  const elapsed = daysBetween(s, today);
  const expected = Math.min(1, Math.max(0, elapsed / total));
  const diff = (p.effective_progress ?? p.progress ?? 0) - expected;
  if (diff >= -0.05) return "on_track";
  if (diff > -0.2) return "at_risk";
  return "late";
}

/** Engine-based health from the backend, falling back to the interim rule. */
function healthOf(p: Plan, today: Date): Health {
  return (p.health as Health | undefined) ?? fallbackHealth(p, today);
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
  const [milestones, setMilestones] = useState<PlanMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [access, setAccess] = useState<PlanAccessLevel>("lite");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorPlan, setEditorPlan] = useState<Plan | null>(null);
  const [milestonesOpen, setMilestonesOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [estimatesOpen, setEstimatesOpen] = useState(false);
  const [mobileTimeline, setMobileTimeline] = useState(false);
  const canEdit = access === "full";

  const load = useCallback(async () => {
    const [{ plans }, { access_level }, { milestones }] = await Promise.all([
      api<{ plans: Plan[] }>("/api/plans/board"),
      api<{ access_level: PlanAccessLevel }>("/api/plans/access"),
      api<{ milestones: PlanMilestone[] }>("/api/plans/milestones"),
    ]);
    setPlans(plans ?? []);
    setAccess(access_level ?? "lite");
    setMilestones(milestones ?? []);
    if (plans?.length) setSelectedId((cur) => cur ?? plans[0].id);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load();
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // Let the board use the full main width (and grow with the window) instead of
  // the global 896px reading cap — see globals.css [data-content-wide].
  useEffect(() => {
    document.body.setAttribute("data-content-wide", "true");
    return () => document.body.removeAttribute("data-content-wide");
  }, []);

  async function recompute() {
    setRecomputing(true);
    try {
      await api("/api/plans/recompute", { method: "POST" });
      await load();
      toast.success(t("recomputed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setRecomputing(false);
    }
  }

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

  const dateAt = useCallback((off: number) => new Date(t0.getTime() + off * DAY_MS), [t0]);
  /** Percentage position (for the responsive mobile sparkline that fits its container). */
  const pctOf = (off: number) => `${Math.min(100, Math.max(0, (off / totalDays) * 100))}%`;
  const offsetOf = (iso: string) => daysBetween(t0, parseISO(iso));
  // "Today" is the real today (the projection slider was removed — health comes
  // from the engine's latest dates, not from sliding a frozen-progress clock).
  const today = useMemo(() => new Date(), []);
  const todayOff = daysBetween(t0, today);
  const todayInView = todayOff >= 0 && todayOff <= totalDays;
  // translateX is PHYSICAL (doesn't mirror in RTL), so center a date-anchored
  // element direction-aware: shift left in LTR, right in RTL, to sit over its x.
  const centerTx = locale === "he" ? "translateX(50%)" : "translateX(-50%)";

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

  // Visible working-day columns: every day in the window except hidden weekdays
  // (Saturday + Sunday). `cols[i]` is the day-offset (from t0) of column i.
  const cols = useMemo(() => {
    const out: number[] = [];
    for (let o = 0; o <= totalDays; o++) {
      if (!HIDDEN_DOW.has(new Date(t0.getTime() + o * DAY_MS).getDay())) out.push(o);
    }
    return out;
  }, [t0, totalDays]);

  // Pixel x for a day-offset = (number of visible columns before it) × COL_PX.
  // A hidden weekend date lands on the boundary just before the next column.
  const colPos = useCallback(
    (off: number) => {
      let lo = 0;
      let hi = cols.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cols[mid] < off) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [cols],
  );
  const xOf = useCallback((off: number) => colPos(off) * COL_PX, [colPos]);
  const trackWidth = cols.length * COL_PX;

  // Month band segments — a new segment starts whenever the Gregorian OR the
  // Hebrew month changes, so both calendars are tracked on one slim row.
  const monthSegments = useMemo(() => {
    const segs: { start: number; end: number; label: string }[] = [];
    cols.forEach((o, i) => {
      const d = new Date(t0.getTime() + o * DAY_MS);
      const label = `${gregMonthLabel(d, locale)} · ${hebMonth(d)}`;
      const last = segs[segs.length - 1];
      if (last && last.label === label) last.end = i + 1;
      else segs.push({ start: i, end: i + 1, label });
    });
    return segs;
  }, [cols, t0, locale]);

  // Milestones split into global (cross every row) and per-plan.
  const { globalMilestones, milestonesByPlan } = useMemo(() => {
    const globalMilestones: PlanMilestone[] = [];
    const milestonesByPlan = new Map<string, PlanMilestone[]>();
    for (const m of milestones) {
      if (!m.plan_id) globalMilestones.push(m);
      else {
        if (!milestonesByPlan.has(m.plan_id)) milestonesByPlan.set(m.plan_id, []);
        milestonesByPlan.get(m.plan_id)!.push(m);
      }
    }
    return { globalMilestones, milestonesByPlan };
  }, [milestones]);
  const lineColor = (m: PlanMilestone) => m.color || "hsl(var(--muted-foreground))";
  const mLabel = (m: PlanMilestone) => (locale === "en" ? m.label_en || m.label_he : m.label_he);

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
        <span className="whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-[13px] font-bold text-accent-foreground">
          {t("today")}: {gregShort(today)} · {hebDate(today)}
        </span>
        <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
          <LegendDot color="hsl(var(--muted-foreground))" label={t("legend.waiting")} />
          <LegendDot color="hsl(var(--status-ok))" label={t("legend.onTrack")} />
          <LegendDot color="hsl(var(--status-warn))" label={t("legend.atRisk")} />
          <LegendDot color="hsl(var(--status-late))" label={t("legend.late")} />
        </div>
        {canEdit && (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <ControlButton onClick={() => { setEditorPlan(null); setEditorOpen(true); }}>
              <Plus className="h-3.5 w-3.5" /> {t("edit.newPlan")}
            </ControlButton>
            <ControlButton onClick={() => setMilestonesOpen(true)}>
              <Flag className="h-3.5 w-3.5" /> {t("edit.editMilestones")}
            </ControlButton>
            <ControlButton onClick={() => setCapacityOpen(true)}>
              <Users className="h-3.5 w-3.5" /> {t("capacity.button")}
            </ControlButton>
            <ControlButton onClick={() => setEstimatesOpen(true)}>
              <Clock className="h-3.5 w-3.5" /> {t("estimates.button")}
            </ControlButton>
            <ControlButton onClick={recompute} disabled={recomputing}>
              <RefreshCw className={cn("h-3.5 w-3.5", recomputing && "animate-spin")} />
              {recomputing ? t("recomputing") : t("recompute")}
            </ControlButton>
          </div>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center">
          <p className="text-sm font-medium">{t("board.empty")}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{t("board.emptyHint")}</p>
        </div>
      ) : (
        <>
        {/* mobile view toggle — list (default) vs the scrollable timeline */}
        <div className="flex gap-1 rounded-lg border bg-card p-1 md:hidden">
          {([["list", false], ["timeline", true]] as const).map(([key, on]) => (
            <button
              key={key}
              onClick={() => setMobileTimeline(on)}
              className={cn(
                "flex-1 rounded-md py-1.5 text-[12.5px] font-medium transition-colors",
                mobileTimeline === on ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {t(`view.${key}`)}
            </button>
          ))}
        </div>

        {/* mobile card list — comfortable on a phone, no horizontal scroll */}
        {!mobileTimeline && (
          <div className="space-y-4 md:hidden">
            {groups.map(([label, rows]) => (
              <div key={label}>
                <p className="mb-1.5 px-1 text-[12px] font-bold text-foreground/80">{label}</p>
                <div className="space-y-2">
                  {rows.map((p) => {
                    const h = healthOf(p, today);
                    const s = p.start_date ? offsetOf(p.start_date) : 0;
                    const e = p.end_date ? offsetOf(p.end_date) : s + 7;
                    const span = Math.max(1, e - s);
                    const progress = p.effective_progress ?? p.progress ?? 0;
                    const due = p.end_date;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "block w-full rounded-xl border bg-card p-3 text-start",
                          selectedId === p.id && "ring-2 ring-primary/40",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: healthColor[h] }} />
                          <span className="flex-1 truncate text-[14px] font-bold">{planTitle(p, locale)}</span>
                          {p.is_critical && (
                            <span className="rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                              {t("tags.critical")}
                            </span>
                          )}
                          <span className="whitespace-nowrap text-[10.5px] font-medium" style={{ color: healthColor[h] }}>
                            {t(`health.${h}`)}
                          </span>
                        </div>
                        {p.kind !== "stream" && (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-secondary">
                            <div className="h-full rounded" style={{ width: `${progress * 100}%`, background: p.color || "#534AB7" }} />
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
                          <span className="truncate">{p.goal}</span>
                          {due && (
                            <span className="whitespace-nowrap">
                              {countdownText(due, t, today)} · {gregShort(parseISO(due))} · {hebDate(parseISO(due))}
                            </span>
                          )}
                        </div>
                        {/* mini timeline sparkline: plan span + milestone ticks + today */}
                        <div className="relative mt-2 h-2 w-full overflow-hidden rounded bg-secondary/60">
                          <div
                            className="absolute inset-y-0 rounded"
                            style={{ insetInlineStart: pctOf(s), width: pctOf(span), background: (p.color || "#534AB7") + "88" }}
                          />
                          {[...globalMilestones, ...(milestonesByPlan.get(p.id) ?? [])].map((m) => (
                            <div
                              key={m.id}
                              className="absolute inset-y-0 w-0.5"
                              style={{ insetInlineStart: pctOf(offsetOf(m.milestone_date)), background: m.color || "hsl(var(--muted-foreground))" }}
                              title={locale === "en" ? m.label_en || m.label_he : m.label_he}
                            />
                          ))}
                          {todayInView && (
                            <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ insetInlineStart: pctOf(todayOff) }} />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          className={cn(
            mobileTimeline ? "flex" : "hidden",
            "overflow-hidden rounded-xl border bg-card md:flex",
          )}
        >
          {/* fixed label column (stays while the timeline scrolls) */}
          <div className="w-[168px] flex-shrink-0 border-e">
            {milestones.length > 0 && (
              <div className="flex h-8 items-center border-b bg-secondary/40 px-3 text-[11px] font-medium text-muted-foreground">
                {t("board.milestones")}
              </div>
            )}
            <div className="h-5 border-b bg-secondary/40" />
            <div className="flex h-12 items-center border-b bg-secondary/60 px-3 text-[12px] font-bold text-muted-foreground">
              {t("title")}
            </div>
            {groups.map(([label, rows]) => (
              <div key={label}>
                <div className="flex h-[30px] items-center bg-secondary px-3 text-[12px] font-bold text-foreground/80">
                  {label}
                </div>
                {rows.map((p) => {
                  const h = healthOf(p, today);
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
            <div className="relative" style={{ width: trackWidth }}>
              {/* today column — a translucent grey wash over the whole day,
                  transparent enough to read the bars and labels underneath. */}
              {todayInView && (
                <div
                  className="pointer-events-none absolute bottom-0 z-[7]"
                  style={{
                    insetInlineStart: xOf(todayOff),
                    width: COL_PX,
                    // Start at the day-strip (date row), below the milestone lane
                    // (h-8 = 32px, only when present) + month band (h-5 = 20px),
                    // so the wash doesn't rise into the header.
                    top: (milestones.length > 0 ? 32 : 0) + 20,
                    background: "rgba(115,115,115,0.15)",
                  }}
                />
              )}
              {/* milestone label lane — pills centered on their date, each on a
                  short stem so it's clear exactly when it happens (no stacking). */}
              {milestones.length > 0 && (
                <div className="relative h-8 border-b bg-secondary/40">
                  {milestones.map((m) => {
                    const x = xOf(offsetOf(m.milestone_date));
                    return (
                      <div key={m.id}>
                        <div
                          className="absolute top-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold"
                          style={{
                            insetInlineStart: x,
                            transform: centerTx,
                            color: lineColor(m),
                            background: "hsl(var(--card))",
                            border: `1px solid ${lineColor(m)}`,
                          }}
                          title={mLabel(m)}
                        >
                          {mLabel(m)}
                        </div>
                        {/* stem anchoring the pill to the exact date */}
                        <div
                          className="absolute bottom-0 h-2 w-0"
                          style={{ insetInlineStart: x, borderInlineStart: `2px solid ${lineColor(m)}` }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              {/* month band — Gregorian + Hebrew month; a new segment (with a
                  divider) marks every point where either month changes. */}
              <div className="relative h-5 border-b bg-secondary/40">
                {monthSegments.map((seg) => {
                  const width = (seg.end - seg.start) * COL_PX;
                  return (
                    <div
                      key={seg.start}
                      className="absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[10px] font-semibold text-muted-foreground"
                      style={{
                        insetInlineStart: seg.start * COL_PX,
                        width,
                        borderInlineStart: seg.start !== 0 ? "2px solid hsl(var(--foreground) / 0.3)" : undefined,
                      }}
                    >
                      {width >= 52 ? seg.label : ""}
                    </div>
                  );
                })}
              </div>
              {/* day strip — one column per working day; Hebrew date on top,
                  Gregorian (day only) below. Thin line between days, a stronger
                  separator before each new week (Monday). */}
              <div className="relative h-12 border-b bg-secondary/60">
                {cols.map((o, i) => {
                  const d = dateAt(o);
                  const weekStart = d.getDay() === 1; // Monday — first working day of the week
                  return (
                    <div
                      key={o}
                      className={cn(
                        "absolute top-0 flex h-full flex-col items-center justify-center gap-0.5 border-e",
                        weekStart && i !== 0 && "border-s-2",
                      )}
                      style={{ insetInlineStart: i * COL_PX, width: COL_PX }}
                    >
                      <span className="whitespace-nowrap text-[10.5px] font-medium">{hebDay(d)}</span>
                      <span className="whitespace-nowrap text-[9.5px] text-muted-foreground">{d.getDate()}</span>
                    </div>
                  );
                })}
                {/* milestone date markers — a solid colored bar pinpointing the date.
                    Anchored by borderInlineStart at x (same as the stem & row lines)
                    so the whole column lines up exactly in both RTL and LTR. */}
                {milestones.map((m) => (
                  <div
                    key={m.id}
                    className="absolute inset-y-0 z-[3] w-0 opacity-70"
                    style={{ insetInlineStart: xOf(offsetOf(m.milestone_date)), borderInlineStart: `2px solid ${lineColor(m)}` }}
                  />
                ))}
              </div>

              {groups.map(([label, rows]) => (
                <div key={label}>
                  <div className="h-[30px] border-b bg-secondary" />
                  {rows.map((p) => {
                    const s = p.start_date ? offsetOf(p.start_date) : 0;
                    const e = p.end_date ? offsetOf(p.end_date) : s + 7;
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
                            insetInlineStart: xOf(s),
                            width: Math.max(COL_PX, xOf(e) - xOf(s)),
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
                          style={{ insetInlineStart: xOf(s), color: p.color || "#534AB7" }}
                        >
                          {isStream
                            ? p.goal || ""
                            : `${p.goal || ""}${p.goal ? "  ·  " : ""}${Math.round(progress * 100)}%`}
                        </div>
                        {/* milestone lines: global + this row's own */}
                        {[...globalMilestones, ...(milestonesByPlan.get(p.id) ?? [])].map((m) => (
                          <div
                            key={m.id}
                            className="pointer-events-none absolute inset-y-0 z-[4] w-0 opacity-40"
                            style={{
                              insetInlineStart: xOf(offsetOf(m.milestone_date)),
                              borderInlineStart: `2px dashed ${lineColor(m)}`,
                            }}
                          />
                        ))}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
        </>
      )}

      {/* detail */}
      {selected && (
        <div className="rounded-xl border bg-card p-4">
          {canEdit && (
            <div className="mb-2 flex justify-end">
              <ControlButton onClick={() => { setEditorPlan(selected); setEditorOpen(true); }}>
                <Pencil className="h-3.5 w-3.5" /> {t("edit.editPlan")}
              </ControlButton>
            </div>
          )}
          {selected.kind === "stream" ? (
            <PlanMatrix plan={selected} locale={locale} canEdit={canEdit} today={today} onChanged={load} />
          ) : (
            <PlanEffortDetail plan={selected} locale={locale} today={today} canEdit={canEdit} onChanged={load} />
          )}
        </div>
      )}

      <PlanEditDialog plan={editorPlan} open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={load} />
      <MilestoneEditor
        milestones={milestones}
        plans={plans}
        locale={locale}
        open={milestonesOpen}
        onClose={() => setMilestonesOpen(false)}
        onChanged={load}
      />
      <CapacityEditor open={capacityOpen} onClose={() => setCapacityOpen(false)} />
      <EstimatesEditor open={estimatesOpen} onClose={() => setEstimatesOpen(false)} />
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      {children}
    </button>
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
