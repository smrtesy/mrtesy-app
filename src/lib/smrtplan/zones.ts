/**
 * Shared ready / blocked / done zone logic for smrtPlan tasks.
 *
 * Lifted out of TaskZones.tsx (docs/smrtplan-focus-integration.md §5) so the
 * client board, the daily focus block, and the server's focus-stage endpoint
 * all compute "the current stage" (the first ready task) the same way — no
 * drift between what the UI shows and what the timer runs.
 */

import type { TaskNeed, TaskHandoff } from "@/types/task";

/** The minimal task shape the zone logic needs. The plan board attaches
 *  needs/handoff at runtime (attachNeedsHandoff on the server). */
export interface PlanZoneTask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  assigned_to_user_id: string | null;
  due_date: string | null;
  latest_finish: string | null;
  is_critical: boolean | null;
  plan_title_he: string | null;
  plan_title_en: string | null;
  stage_name_he?: string | null;
  stage_name_en?: string | null;
  needs: TaskNeed[];
  handoff: TaskHandoff[];
}

export type Zone = "ready" | "blocked" | "done";

/** The date a task must actually meet — the earlier of its own due date and the
 *  engine's latest_finish (an external constraint can pull it in). */
export function effectiveDeadline(t: Pick<PlanZoneTask, "due_date" | "latest_finish">): string | null {
  if (t.due_date && t.latest_finish) return t.due_date < t.latest_finish ? t.due_date : t.latest_finish;
  return t.due_date || t.latest_finish || null;
}

/** Urgency order: earliest effective deadline first (overdue floats to the
 *  top), undated last; critical wins a tie. */
export function byUrgency(a: PlanZoneTask, b: PlanZoneTask): number {
  const da = effectiveDeadline(a);
  const db = effectiveDeadline(b);
  if (da && db) {
    if (da !== db) return da < db ? -1 : 1;
  } else if (da) return -1;
  else if (db) return 1;
  if (!!a.is_critical !== !!b.is_critical) return a.is_critical ? -1 : 1;
  return 0;
}

/** done (terminal status) → blocked (an unmet dependency) → ready. */
export function zoneOf(t: Pick<PlanZoneTask, "status" | "needs">): Zone {
  if (t.status === "archived" || t.status === "completed" || t.status === "dismissed") return "done";
  if ((t.needs ?? []).some((n) => !n.satisfied)) return "blocked";
  return "ready";
}

/** The current stage: the first ready task in urgency order (null when none).
 *  Shared by GET /plan/:id/focus-stage and the focus block. */
export function currentStage(tasks: PlanZoneTask[]): PlanZoneTask | null {
  return tasks.filter((t) => zoneOf(t) === "ready").sort(byUrgency)[0] ?? null;
}
