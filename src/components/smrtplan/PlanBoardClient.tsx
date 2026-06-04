"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Plus, Pencil, Flag } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanAccessLevel, PlanMilestone } from "@/types/plan";
import { parseISO, gregShort, hebDate, daysBetween } from "@/lib/smrtplan/dates";
import { PlanMatrix } from "./PlanMatrix";
import { PlanEffortDetail } from "./PlanEffortDetail";
import { PlanEditDialog } from "./PlanEditDialog";
import { MilestoneEditor } from "./MilestoneEditor";

const DAY_MS = 86_400_000;
/** Pixels per day on the timeline. The track is wider than the viewport, so the
 *  chart scrolls horizontally to reveal future dates (instead of squeezing the
 *  whole span into view). */
const DAY_PX = 16;

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

  const dateAt = (off: number) => new Date(t0.getTime() + off * DAY_MS);
  const pxOf = (off: number) => off * DAY_PX;
  const offsetOf = (iso: string) => daysBetween(t0, parseISO(iso));
  // "Today" is the real today (the projection slider was removed — health comes
  // from the engine's latest dates, not from sliding a frozen-progress clock).
  const today = useMemo(() => new Date(), []);
  const todayOff = daysBetween(t0, today);
  const todayInView = todayOff >= 0 && todayOff <= totalDays;
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
        <div className="flex overflow-hidden rounded-xl border bg-card">
          {/* fixed label column (stays while the timeline scrolls) */}
          <div className="w-[168px] flex-shrink-0 border-e">
            {milestones.length > 0 && (
              <div className="flex h-7 items-center border-b bg-secondary/40 px-3 text-[11px] font-medium text-muted-foreground">
                {t("board.milestones")}
              </div>
            )}
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
            <div style={{ width: trackWidth }}>
              {/* milestone label lane — pills live here so they never stack on the rows */}
              {milestones.length > 0 && (
                <div className="relative h-7 border-b bg-secondary/40">
                  {milestones.map((m) => (
                    <div
                      key={m.id}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold"
                      style={{
                        insetInlineStart: pxOf(offsetOf(m.milestone_date)),
                        color: lineColor(m),
                        background: "hsl(var(--card))",
                        border: `1px solid ${lineColor(m)}`,
                      }}
                      title={mLabel(m)}
                    >
                      {mLabel(m)}
                    </div>
                  ))}
                </div>
              )}
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
                {todayInView && (
                  <div
                    className="absolute inset-y-0 z-[5] w-0.5 bg-foreground"
                    style={{ insetInlineStart: pxOf(todayOff) }}
                  />
                )}
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
                        {/* milestone lines: global + this row's own */}
                        {[...globalMilestones, ...(milestonesByPlan.get(p.id) ?? [])].map((m) => (
                          <div
                            key={m.id}
                            className="pointer-events-none absolute inset-y-0 z-[4] border-e border-dashed"
                            style={{
                              insetInlineStart: pxOf(offsetOf(m.milestone_date)),
                              borderColor: lineColor(m),
                            }}
                          />
                        ))}
                        {/* today line */}
                        {todayInView && (
                          <div
                            className="absolute inset-y-0 z-[5] w-px bg-foreground/70"
                            style={{ insetInlineStart: pxOf(todayOff) }}
                          />
                        )}
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
