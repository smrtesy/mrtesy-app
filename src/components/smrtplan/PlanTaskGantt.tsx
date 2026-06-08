"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/plan";
import type { Task, TaskNeed } from "@/types/task";
import { parseISO, isoOf, hebDay, daysBetween } from "@/lib/smrtplan/dates";
import { useTimeline, COL_PX } from "@/lib/smrtplan/timeline";
import { useGanttDrag, spanWidth } from "@/lib/smrtplan/useGanttDrag";

type GanttTask = Pick<
  Task,
  "id" | "title" | "title_he" | "status" | "due_date" | "latest_start" | "latest_finish" | "duration_days" | "is_critical"
> & { needs: TaskNeed[] };

const ROW_H = 40;
const HEADER_H = 28;
const LABEL_W = 160;
const DONE = new Set(["completed", "archived", "dismissed"]);

function taskTitle(t: GanttTask, locale: string) {
  return locale === "en" ? t.title : t.title_he || t.title;
}

/** A task's scheduled window on the timeline: [latest_start, latest_finish],
 *  falling back to its due_date as a single point. null = unscheduled (no bar). */
function windowOf(t: GanttTask): { start: string; finish: string } | null {
  const finish = t.latest_finish || t.due_date;
  if (!finish) return null;
  const start = t.latest_start || finish;
  return { start: start <= finish ? start : finish, finish };
}

export function PlanTaskGantt({
  plan,
  locale,
  canEdit,
  onChanged,
}: {
  plan: Plan;
  locale: string;
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const [tasks, setTasks] = useState<GanttTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const refetch = useCallback(async () => {
    const data = await api<{ tasks: GanttTask[] }>(`/api/plans/${plan.id}/tasks`);
    setTasks(data.tasks ?? []);
  }, [plan.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{ tasks: GanttTask[] }>(`/api/plans/${plan.id}/tasks`);
        if (alive) setTasks(data.tasks ?? []);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [plan.id]);

  // Timeline bounds from the tasks' scheduled windows (fallback today..+30).
  const { t0, totalDays } = useMemo(() => {
    const dates: string[] = [];
    for (const task of tasks) {
      const w = windowOf(task);
      if (w) dates.push(w.start, w.finish);
    }
    if (!dates.length) {
      const now = new Date();
      return { t0: now, totalDays: 30 };
    }
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    const start = parseISO(min);
    return { t0: start, totalDays: Math.max(10, daysBetween(start, parseISO(max)) + 5) };
  }, [tasks]);

  const tl = useTimeline(t0, totalDays);
  const { cols, dateAt, offsetOf, xOf, trackWidth, colPos } = tl;

  async function afterMutation() {
    await refetch();
    onChanged?.();
  }

  // Drag/resize a task bar → pin its due_date (finish) + manual duration. The
  // engine reruns on the PATCH and reflows everything downstream.
  const commitBar = useCallback(
    async (id: string, startOff: number, endOff: number) => {
      const finishOff = Math.max(startOff, endOff);
      // Inclusive working-day span: duration so the engine lands latest_start back
      // on the dropped start column (latest_start = finish − (duration−1) days).
      const durCols = Math.max(1, colPos(finishOff) - colPos(startOff) + 1);
      const due_date = isoOf(dateAt(finishOff));
      const latest_start = isoOf(dateAt(Math.min(startOff, finishOff)));
      const before = tasks;
      // Optimistic: move the whole window now (windowOf reads latest_start/finish)
      // so the bar lands where dropped instead of snapping back until refetch.
      setTasks((ts) =>
        ts.map((x) => (x.id === id ? { ...x, due_date, latest_finish: due_date, latest_start, duration_days: durCols } : x)),
      );
      try {
        await api(`/api/plan-tasks/${id}`, {
          method: "PATCH",
          body: { due_date, duration_days: durCols, duration_manual: true },
        });
        await refetch();
        onChanged?.();
      } catch (e) {
        setTasks(before);
        toast.error(e instanceof Error ? e.message : "Error");
      }
    },
    [dateAt, colPos, tasks, refetch, onChanged],
  );

  const drag = useGanttDrag(tl, locale, trackRef, commitBar);

  // Click-to-connect: pick a provider (the task that must finish first), then a
  // consumer → create the dependency (drawing the arrow). from = consumer/needs,
  // to = provider, matching the smrtplan_dependencies direction.
  async function connectTo(consumerId: string) {
    const providerId = connectFrom;
    setConnectFrom(null);
    if (!providerId || providerId === consumerId) return;
    if (tasks.find((x) => x.id === consumerId)?.needs.some((n) => n.task_id === providerId)) {
      toast.error(t("gantt.depExists"));
      return;
    }
    try {
      await api("/api/plan-dependencies", {
        method: "POST",
        body: { from_type: "task", from_id: consumerId, to_type: "task", to_id: providerId },
      });
      await afterMutation();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function removeDep(depId: string) {
    try {
      await api(`/api/plan-dependencies/${depId}`, { method: "DELETE" });
      await afterMutation();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  // Row index per task id (for arrow y-coordinates).
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    tasks.forEach((task, i) => m.set(task.id, i));
    return m;
  }, [tasks]);

  // SVG draws in PHYSICAL coordinates, so fold the inline position to a left-x
  // (in RTL the timeline grows leftward). y = row center under the bar lane.
  const physX = useCallback((inline: number) => (locale === "he" ? trackWidth - inline : inline), [locale, trackWidth]);
  const rowCenter = (i: number) => i * ROW_H + ROW_H / 2;

  // Dependency arrows: provider.finish → consumer.start. Each consumer task's
  // needs carry its providers; both must be scheduled to draw the edge.
  const arrows = useMemo(() => {
    const out: { id: string; d: string; critical: boolean }[] = [];
    const winById = new Map<string, { start: string; finish: string } | null>();
    for (const task of tasks) winById.set(task.id, windowOf(task));
    for (const consumer of tasks) {
      const cw = winById.get(consumer.id);
      const ci = rowIndex.get(consumer.id);
      if (!cw || ci == null) continue;
      for (const n of consumer.needs ?? []) {
        if (!n.task_id) continue;
        const pw = winById.get(n.task_id);
        const pi = rowIndex.get(n.task_id);
        if (!pw || pi == null) continue;
        const fromInline = colPos(offsetOf(pw.finish)) * COL_PX; // provider finish edge
        const toInline = colPos(offsetOf(cw.start)) * COL_PX; // consumer start edge
        const x1 = physX(fromInline);
        const x2 = physX(toInline);
        const y1 = rowCenter(pi);
        const y2 = rowCenter(ci);
        const midX = (x1 + x2) / 2;
        out.push({
          id: n.dependency_id,
          d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
          critical: !n.satisfied,
        });
      }
    }
    return out;
  }, [tasks, rowIndex, colPos, offsetOf, physX]);

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;
  if (tasks.length === 0) return <p className="py-6 text-center text-[12.5px] italic text-muted-foreground">{t("effort.empty")}</p>;

  const bodyH = tasks.length * ROW_H;

  return (
    <div>
      {canEdit && (
        <div className="mb-2 text-[11.5px] text-muted-foreground">
          {connectFrom ? <span className="font-medium text-primary">{t("gantt.connecting")}</span> : t("gantt.connectHint")}
        </div>
      )}
      <div className="flex overflow-hidden rounded-lg border">
        {/* fixed task-label column */}
        <div className="flex-shrink-0 border-e" style={{ width: LABEL_W }}>
          <div className="border-b bg-secondary/60" style={{ height: HEADER_H }} />
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-1 border-b px-2 text-[12px]"
              style={{ height: ROW_H }}
              title={taskTitle(task, locale)}
            >
              <span className={cn("flex-1 truncate", DONE.has(task.status) && "text-muted-foreground line-through")}>
                {taskTitle(task, locale)}
              </span>
              {canEdit && (
                <button
                  onClick={() => setConnectFrom((cur) => (cur === task.id ? null : task.id))}
                  title={t("gantt.connectHint")}
                  className={cn(
                    "flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                    connectFrom === task.id && "bg-primary text-primary-foreground",
                  )}
                >
                  <Link2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* scrollable track */}
        <div className="flex-1 overflow-x-auto">
          <div ref={trackRef} className="relative" style={{ width: trackWidth, height: HEADER_H + bodyH }}>
            {/* day strip */}
            <div className="relative border-b bg-secondary/60" style={{ height: HEADER_H }}>
              {cols.map((o, i) => {
                const d = dateAt(o);
                const weekStart = d.getDay() === 1;
                return (
                  <div
                    key={o}
                    className="absolute top-0 flex h-full flex-col items-center justify-center border-e text-[9px] text-muted-foreground"
                    style={{
                      insetInlineStart: i * COL_PX,
                      width: COL_PX,
                      ...(weekStart && i !== 0
                        ? { borderInlineStartWidth: 2, borderInlineStartStyle: "solid", borderInlineStartColor: "hsl(var(--foreground) / 0.2)" }
                        : {}),
                    }}
                  >
                    <span>{hebDay(d)}</span>
                    <span>{d.getDate()}</span>
                  </div>
                );
              })}
            </div>

            {/* arrow overlay (physical coords) */}
            <svg
              className="pointer-events-none absolute z-[5]"
              style={{ insetInlineStart: 0, top: HEADER_H, width: trackWidth, height: bodyH }}
              width={trackWidth}
              height={bodyH}
            >
              <defs>
                <marker id="smrtplan-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="hsl(var(--muted-foreground))" />
                </marker>
                <marker id="smrtplan-arrow-wait" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="hsl(var(--status-warn))" />
                </marker>
              </defs>
              {arrows.map((a) => (
                <path
                  key={a.id}
                  d={a.d}
                  fill="none"
                  stroke={a.critical ? "hsl(var(--status-warn))" : "hsl(var(--muted-foreground))"}
                  strokeWidth={1.5}
                  strokeDasharray={a.critical ? "4 3" : undefined}
                  markerEnd={`url(#${a.critical ? "smrtplan-arrow-wait" : "smrtplan-arrow"})`}
                />
              ))}
            </svg>

            {/* task rows + bars */}
            <div className="absolute inset-x-0" style={{ top: HEADER_H }}>
              {tasks.map((task) => {
                const w = windowOf(task);
                const pv = drag.preview?.id === task.id ? drag.preview : null;
                const isDone = DONE.has(task.status);
                const color = task.is_critical ? "hsl(var(--status-late))" : "hsl(var(--primary))";
                return (
                  <div
                    key={task.id}
                    className="relative border-b"
                    style={{ height: ROW_H }}
                    onClick={() => { if (connectFrom) connectTo(task.id); }}
                  >
                    {w || pv ? (
                      <div
                        className={cn(
                          "absolute top-1.5 flex h-7 items-center rounded-md border px-1.5 text-[10px]",
                          isDone && "opacity-50",
                          canEdit && !connectFrom && "cursor-grab active:cursor-grabbing",
                          connectFrom && "cursor-pointer",
                        )}
                        style={{
                          insetInlineStart: pv ? pv.startCol * COL_PX : xOf(offsetOf(w!.start)),
                          // Exclusive span (edge-to-edge), matching the drag preview + the
                          // plan board, so there's no width pop on grab. The committed
                          // duration is inclusive (durCols, +1) so the engine reflows it back.
                          width: pv ? spanWidth(pv.startCol, pv.endCol) : spanWidth(colPos(offsetOf(w!.start)), colPos(offsetOf(w!.finish))),
                          background: color + "22",
                          borderColor: color + "88",
                        }}
                        onPointerDown={
                          canEdit && !connectFrom && w
                            ? (ev) => drag.onPointerDown(ev, task.id, offsetOf(w.start), offsetOf(w.finish), "move")
                            : undefined
                        }
                      >
                        {canEdit && !connectFrom && w && (
                          <>
                            <span
                              className="absolute inset-y-0 start-0 z-[2] w-1.5 cursor-ew-resize bg-primary/50"
                              onPointerDown={(ev) => drag.onPointerDown(ev, task.id, offsetOf(w.start), offsetOf(w.finish), "resize-start")}
                            />
                            <span
                              className="absolute inset-y-0 end-0 z-[2] w-1.5 cursor-ew-resize bg-primary/50"
                              onPointerDown={(ev) => drag.onPointerDown(ev, task.id, offsetOf(w.start), offsetOf(w.finish), "resize-end")}
                            />
                          </>
                        )}
                      </div>
                    ) : (
                      <span className="absolute inset-y-0 start-2 flex items-center text-[10px] italic text-muted-foreground">
                        {t("gantt.unscheduled")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* dependency list — remove an arrow (the click-to-connect inverse) */}
      {canEdit && arrows.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tasks.flatMap((task) =>
            (task.needs ?? []).map((n) => (
              <span key={n.dependency_id} className="inline-flex items-center gap-1 rounded-full border bg-secondary/60 px-2 py-0.5 text-[10.5px]">
                <span className="text-muted-foreground">{n.title}</span>
                <span aria-hidden>→</span>
                <span>{taskTitle(task, locale)}</span>
                <button onClick={() => removeDep(n.dependency_id)} className="rounded text-muted-foreground hover:text-status-late">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )),
          )}
        </div>
      )}
    </div>
  );
}
