"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronLeft, Clock, EyeOff, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { createClient } from "@/lib/supabase/client";
import { useSuperAdmin } from "@/lib/api/use-super-admin";
import { TaskChecklist } from "@/components/smrttask/tasks/TaskChecklist";
import { cn } from "@/lib/utils";
import { DatePicker } from "@/components/ui/date-picker";
import type { Plan } from "@/types/plan";
import type { Task, TaskNeed, TaskHandoff } from "@/types/task";
import { parseISO, gregShort, hebDate, countdownText, urgencyFor, countWorkingDays } from "@/lib/smrtplan/dates";

type PlanTask = Pick<
  Task,
  "id" | "title" | "title_he" | "status" | "due_date" | "latest_finish" | "duration_days" | "duration_manual" | "estimated_hours" | "is_critical" | "assigned_to_user_id" | "stage_id" | "checklist"
> & { needs: TaskNeed[]; handoff: TaskHandoff[] };

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
}
interface Stage {
  id: string;
  name_he: string;
  name_en: string | null;
  sequence: number;
}
/** Stable key for the "no stage" section (tasks with no/unknown stage_id). */
const NO_STAGE = "__none__";
function memberName(m: Member): string {
  return personLabel(m);
}

function taskTitle(t: PlanTask, locale: string) {
  return locale === "en" ? t.title : t.title_he || t.title;
}

function zoneOf(t: PlanTask): "done" | "blocked" | "ready" {
  if (t.status === "archived" || t.status === "completed" || t.status === "dismissed") return "done";
  if ((t.needs ?? []).some((n) => !n.satisfied)) return "blocked";
  return "ready";
}

const countdownClasses: Record<string, string> = {
  far: "bg-status-ok-bg text-status-ok",
  soon: "bg-status-warn-bg text-status-warn",
  urgent: "bg-status-late-bg text-status-late",
};

const fieldCls =
  "rounded-md border border-input bg-background px-2 py-1 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PlanEffortDetail({
  plan,
  locale,
  today,
  canEdit = false,
  stages = [],
  onChanged,
}: {
  plan: Plan;
  locale: string;
  today: Date;
  canEdit?: boolean;
  stages?: Stage[];
  onChanged?: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // `adding` carries the stage the new task belongs to (null = no stage).
  const [adding, setAdding] = useState<{ stageId: string | null } | null>(null);
  // Stage sections start collapsed — the user sees the stage overview first and
  // opens a stage to reveal its tasks.
  const [openStages, setOpenStages] = useState<Set<string>>(new Set());
  // A task we jumped to from a "to start I need" link — briefly ringed.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Done tasks are filtered out of the list by default; a toggle reveals them.
  const [hideDone, setHideDone] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const { isSuperAdmin } = useSuperAdmin();

  useEffect(() => {
    let alive = true;
    createClient().auth.getUser().then((r: { data: { user: { id: string } | null } }) => { if (alive) setMyId(r.data.user?.id ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Smooth-scroll to (and momentarily ring) a task jumped to from a needs link.
  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`plantask-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightId(null), 1800);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const memberMap = new Map(members.map((m) => [m.user_id, memberName(m)]));

  const refetch = useCallback(async () => {
    const data = await api<{ tasks: PlanTask[] }>(`/api/plans/${plan.id}/tasks`);
    setTasks(data.tasks ?? []);
  }, [plan.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const [data, mem] = await Promise.all([
          api<{ tasks: PlanTask[] }>(`/api/plans/${plan.id}/tasks`),
          api<{ members: Member[] }>("/api/org/members").catch(() => ({ members: [] as Member[] })),
        ]);
        if (!alive) return;
        setTasks(data.tasks ?? []);
        setMembers(mem.members ?? []);
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

  // Roster "load": holidays power the available-work-days denominator.
  useEffect(() => {
    if (plan.kind !== "roster") return;
    let alive = true;
    api<{ holidays: { blocked_date: string }[] }>("/api/plans/holidays")
      .then((d) => { if (alive) setHolidays(new Set((d.holidays ?? []).map((h) => h.blocked_date))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [plan.kind]);

  // Load gauge: sum of the person's open task-days vs working days available in
  // the window (today → their last due/finish), minus weekends + holidays.
  const rosterLoad = useMemo(() => {
    if (plan.kind !== "roster") return null;
    const open = tasks.filter((tk) => zoneOf(tk) !== "done");
    if (open.length === 0) return null;
    let busy = 0;
    let end = today;
    for (const tk of open) {
      busy += tk.duration_days != null ? Number(tk.duration_days) : 1;
      const f = tk.due_date || tk.latest_finish;
      if (f) { const d = parseISO(f); if (d > end) end = d; }
    }
    const available = countWorkingDays(today, end, holidays);
    return { busy, available, overloaded: busy > available };
  }, [plan.kind, tasks, holidays, today]);

  async function afterMutation() {
    await refetch();
    onChanged?.();
  }

  // Inline field edit from a row (assignee / due) — both can reschedule, so we
  // refetch after the PATCH to pull fresh engine dates.
  async function patchTask(task: PlanTask, body: Record<string, unknown>) {
    try {
      await api(`/api/plan-tasks/${task.id}`, { method: "PATCH", body });
      await afterMutation();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  const toggleSection = (key: string) =>
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Mark complete / reopen — allowed for the assignee + super-admin (not only
  // full-access planners). The server enforces the same rule.
  const canComplete = (task: PlanTask) => canEdit || isSuperAdmin || (myId != null && task.assigned_to_user_id === myId);
  async function toggleDone(task: PlanTask) {
    const reopening = zoneOf(task) === "done";
    try {
      await api(`/api/plan-tasks/${task.id}/done`, { method: "PATCH", body: { done: !reopening } });
      await afterMutation();
      if (reopening) void notifyReopen(task.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  // Reopening doesn't silently re-block dependents that were already released —
  // it tells the user what kept running and offers a one-click re-block of the
  // consumers that haven't started yet (the human decides, the engine doesn't).
  async function notifyReopen(taskId: string) {
    try {
      const { dependents } = await api<{ dependents: { id: string }[] }>(`/api/plan-tasks/${taskId}/released-dependents`);
      if (!dependents || dependents.length === 0) return;
      toast.warning(t("effort.reopenReleased", { n: dependents.length }), {
        duration: 10000,
        action: {
          label: t("effort.reblockAction"),
          onClick: async () => {
            try {
              const { reblocked } = await api<{ reblocked: number }>(`/api/plan-tasks/${taskId}/reblock`, { method: "POST" });
              toast.success(t("effort.reblocked", { n: reblocked }));
              await afterMutation();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Error");
            }
          },
        },
      });
    } catch {
      /* informational only — never block the reopen itself */
    }
  }

  const title = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;
  const progress = plan.effective_progress ?? plan.progress ?? 0;

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;

  // Group the list by stage only for a real (non-roster) plan that has stages —
  // a roster aggregates tasks across plans, so its tasks' stages aren't this
  // plan's, and a plan with no stages stays a plain flat list.
  const hasStages = plan.kind !== "roster" && stages.length > 0;
  const sortedStages = [...stages].sort((a, b) => a.sequence - b.sequence);
  const stageIdSet = new Set(stages.map((s) => s.id));
  const noStageTasks = tasks.filter((tk) => !tk.stage_id || !stageIdSet.has(tk.stage_id));
  const stageName = (s: Stage) => (locale === "en" ? s.name_en || s.name_he : s.name_he);

  // Jump from a "to start I need" link to the provider task in this same list:
  // open its stage section (if collapsed) and scroll/ring it. No-op when the
  // dependency lives in another plan (not present in this list).
  const jumpToTask = (taskId: string | null) => {
    if (!taskId) return;
    const target = tasks.find((tk) => tk.id === taskId);
    if (!target) return;
    if (hasStages) {
      const key = target.stage_id && stageIdSet.has(target.stage_id) ? target.stage_id : NO_STAGE;
      setOpenStages((prev) => new Set(prev).add(key));
    }
    setHighlightId(taskId);
  };

  const renderRow = (task: PlanTask) =>
    editingId === task.id && canEdit ? (
      <EditTaskRow
        key={task.id}
        task={task}
        planId={plan.id}
        members={members}
        te={te}
        onClose={() => setEditingId(null)}
        onChanged={afterMutation}
      />
    ) : (
      <TaskRow
        key={task.id}
        task={task}
        locale={locale}
        today={today}
        t={t}
        te={te}
        canEdit={canEdit}
        members={members}
        memberMap={memberMap}
        canComplete={canComplete(task)}
        onToggleDone={() => toggleDone(task)}
        assignee={task.assigned_to_user_id ? memberMap.get(task.assigned_to_user_id) ?? null : null}
        onEdit={() => setEditingId(task.id)}
        onPatch={(body) => patchTask(task, body)}
        onJumpToTask={jumpToTask}
        domId={`plantask-${task.id}`}
        highlighted={highlightId === task.id}
      />
    );

  // One collapsible stage section: header (name · progress · "+ task") + the
  // tasks under it, revealed only when the section is open.
  const renderSection = (sectionKey: string, stageId: string | null, name: string, sectionTasks: PlanTask[]) => {
    const open = openStages.has(sectionKey);
    const total = sectionTasks.length;
    const doneCount = sectionTasks.filter((tk) => zoneOf(tk) === "done").length;
    // The header count/progress reflects ALL tasks; the body hides done ones
    // when the filter is on, so a stage still shows "3/5 done" while listing
    // only the open work.
    const visibleTasks = hideDone ? sectionTasks.filter((tk) => zoneOf(tk) !== "done") : sectionTasks;
    const isAdding = canEdit && adding?.stageId === stageId;
    return (
      <div key={sectionKey}>
        <div className="flex cursor-pointer items-center gap-2 py-2.5" onClick={() => toggleSection(sectionKey)}>
          {open ? (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronLeft className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
          <span className={cn("flex-1 text-[13px] font-bold", stageId === null && "italic text-muted-foreground")}>{name}</span>
          {total > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-16 overflow-hidden rounded bg-secondary">
                <span className="block h-full rounded bg-status-ok" style={{ width: `${(doneCount / total) * 100}%` }} />
              </span>
              <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{doneCount}/{total}</span>
            </span>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setAdding({ stageId }); setOpenStages((prev) => new Set(prev).add(sectionKey)); }}
              className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              title={te("addTask")}
            >
              <Plus className="h-3 w-3" /> {te("addTask")}
            </button>
          )}
        </div>
        {open && (
          <div className="ms-2 border-s ps-3">
            {isAdding && (
              <NewTaskRow planId={plan.id} stageId={stageId} members={members} te={te} onDone={async () => { setAdding(null); await afterMutation(); }} />
            )}
            {visibleTasks.length === 0 && !isAdding ? (
              <p className="py-2 text-[12px] text-muted-foreground">
                {sectionTasks.length > 0 ? t("effort.allDone") : t("effort.empty")}
              </p>
            ) : (
              <div className="divide-y">{visibleTasks.map(renderRow)}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: plan.color || "#534AB7" }} />
            {title}
          </h2>
          <p className="mb-1 mt-0.5 text-[12.5px] text-muted-foreground">
            {plan.goal ? `${plan.goal} · ` : ""}
            {plan.start_date && plan.end_date
              ? `${gregShort(parseISO(plan.start_date))}–${gregShort(parseISO(plan.end_date))} · `
              : ""}
            {Math.round(progress * 100)}%
          </p>
          {plan.kind === "roster" && (
            <p className="mb-1.5 text-[11.5px] italic text-muted-foreground">{t("effort.rosterNote")}</p>
          )}
          {rosterLoad && (
            <div
              className={cn(
                "mb-3 inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-[11.5px] font-medium",
                rosterLoad.overloaded ? "bg-status-late-bg text-status-late" : "bg-status-ok-bg text-status-ok",
              )}
            >
              <span>
                {t("effort.load")}: {rosterLoad.busy} {t("effort.taskDays")} / {rosterLoad.available} {t("effort.workDays")}
              </span>
              {rosterLoad.overloaded && (
                <span className="rounded bg-status-late px-1.5 py-px text-[9px] font-bold text-white">
                  {t("effort.overloaded")}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {tasks.length > 0 && (
            <button
              onClick={() => setHideDone((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                hideDone ? "border-primary bg-primary/10 text-primary" : "bg-card text-muted-foreground hover:bg-accent",
              )}
            >
              <EyeOff className="h-3.5 w-3.5" /> {t("table.hideDone")}
            </button>
          )}
          {canEdit && plan.kind !== "roster" && !hasStages && (
            <button
              onClick={() => setAdding((v) => (v ? null : { stageId: null }))}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" /> {te("addTask")}
            </button>
          )}
        </div>
      </div>

      {hasStages ? (
        <div className="divide-y">
          {sortedStages.map((s) =>
            renderSection(s.id, s.id, stageName(s), tasks.filter((tk) => tk.stage_id === s.id)),
          )}
          {(noStageTasks.length > 0 || adding?.stageId === null) &&
            renderSection(NO_STAGE, null, t("effort.noStage"), noStageTasks)}
        </div>
      ) : tasks.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed py-8 text-center">
          <p className="text-[12.5px] font-medium">{t("effort.empty")}</p>
          {canEdit && plan.kind !== "roster" && (
            <button
              onClick={() => setAdding({ stageId: null })}
              className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" /> {te("addTask")}
            </button>
          )}
        </div>
      ) : (
        <>
          {adding && canEdit && (
            <NewTaskRow planId={plan.id} stageId={adding.stageId} members={members} te={te} onDone={async () => { setAdding(null); await afterMutation(); }} />
          )}
          <div className="divide-y">{(hideDone ? tasks.filter((tk) => zoneOf(tk) !== "done") : tasks).map(renderRow)}</div>
        </>
      )}
    </div>
  );
}

function TaskRow({
  task,
  locale,
  today,
  t,
  te,
  canEdit,
  members,
  memberMap,
  canComplete,
  onToggleDone,
  assignee,
  onEdit,
  onPatch,
  onJumpToTask,
  domId,
  highlighted,
}: {
  task: PlanTask;
  locale: string;
  today: Date;
  t: ReturnType<typeof useTranslations>;
  te: ReturnType<typeof useTranslations>;
  canEdit: boolean;
  members: Member[];
  memberMap: Map<string, string>;
  canComplete: boolean;
  onToggleDone: () => void;
  assignee: string | null;
  onEdit: () => void;
  onPatch: (body: Record<string, unknown>) => void;
  onJumpToTask: (taskId: string | null) => void;
  domId: string;
  highlighted: boolean;
}) {
  const zone = zoneOf(task);
  // Inline edits straight from the row: click the assignee → a select, click the
  // date → a date picker. Clicking anywhere else on the row opens the full editor.
  const [editAssignee, setEditAssignee] = useState(false);
  const [editDue, setEditDue] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  // The row shows the SET deadline (due_date). The engine's computed
  // latest_finish only shows as a constraint hint when it's earlier (e.g. a
  // worker-leave pulls it in).
  const deadline = task.due_date || task.latest_finish || null;
  const constraint =
    task.latest_finish && task.due_date && task.latest_finish < task.due_date ? task.latest_finish : null;
  const urg = urgencyFor(deadline, today);
  const waiting = (task.needs ?? []).filter((n) => !n.satisfied);
  // Capability providers drive a "based on" (green, done+available) / "waiting"
  // (red, flipped unavailable) badge on the row.
  const capNeeds = (task.needs ?? []).filter((n) => n.provider_kind === "plan");
  return (
    <div
      id={domId}
      className={cn("scroll-mt-24 rounded-md px-1 py-2.5 transition-colors", highlighted && "bg-primary/5 ring-2 ring-primary/60")}
    >
      <div
        className={cn("flex items-center gap-2.5", canEdit && "cursor-pointer")}
        onClick={canEdit ? onEdit : undefined}
        title={canEdit ? te("edit") : undefined}
      >
        <button
          type="button"
          disabled={!canComplete}
          onClick={canComplete ? (e) => { stop(e); onToggleDone(); } : undefined}
          title={zone === "done" ? t("effort.reopen") : t("effort.markDone")}
          className={cn(
            "flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded border text-[11px]",
            zone === "done" && "border-status-ok bg-status-ok text-white",
            zone === "blocked" && "border-dashed border-muted-foreground/40 text-transparent",
            zone === "ready" && "border-muted-foreground/40",
            canComplete ? "cursor-pointer hover:border-status-ok" : "cursor-default",
          )}
        >
          {zone === "done" ? "✓" : ""}
        </button>
        <span className={cn("flex-1 text-[13px]", zone === "done" && "text-muted-foreground line-through")}>
          {taskTitle(task, locale)}
          {task.is_critical && (
            <span className="ms-2 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
              {t("tags.critical")}
            </span>
          )}
          {capNeeds.map((n) =>
            n.satisfied ? (
              <span key={n.dependency_id} className="ms-2 rounded bg-status-ok-bg px-1.5 py-px text-[9px] font-bold text-status-ok">
                ✓ {t("effort.basedOn")} {n.title}
              </span>
            ) : n.unavailable ? (
              <span key={n.dependency_id} className="ms-2 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                ⛔ {t("effort.waitingCap")} {n.title}
              </span>
            ) : null,
          )}
          {/* a released input whose provider has since been reopened — warn, don't block */}
          {(task.needs ?? []).filter((n) => n.provider_reopened).map((n) => (
            <span key={`ro-${n.dependency_id}`} className="ms-2 rounded bg-status-warn-bg px-1.5 py-px text-[9px] font-bold text-status-warn" title={n.title}>
              ⚠ {t("effort.inputReopened")}: {n.title}
            </span>
          ))}
        </span>
        {task.duration_days != null && (
          <span
            className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={
              task.duration_manual
                ? t("edit.durManual")
                : task.estimated_hours
                  ? `${task.estimated_hours}${t("edit.hoursUnit")}`
                  : t("edit.durEstimated")
            }
          >
            {task.duration_days} {t("edit.daysUnit")} ·{" "}
            {task.duration_manual
              ? t("edit.durManual")
              : task.estimated_hours
                ? `~${task.estimated_hours}${t("edit.hoursUnit")}`
                : t("edit.durEstimated")}
          </span>
        )}
        {canEdit && editAssignee ? (
          <select
            autoFocus
            value={task.assigned_to_user_id ?? ""}
            onClick={stop}
            onChange={(e) => { onPatch({ assigned_to_user_id: e.target.value || null }); setEditAssignee(false); }}
            onBlur={() => setEditAssignee(false)}
            className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">{te("unassigned")}</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>
            ))}
          </select>
        ) : canEdit ? (
          <button
            type="button"
            onClick={(e) => { stop(e); setEditAssignee(true); }}
            className={cn(
              "whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium hover:ring-1 hover:ring-ring",
              assignee ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground/70",
            )}
            title={te("assignee")}
          >
            {assignee ?? te("unassigned")}
          </button>
        ) : assignee ? (
          <span className="whitespace-nowrap rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
            {assignee}
          </span>
        ) : null}
        {canEdit && editDue ? (
          <div onClick={stop}>
            <DatePicker
              autoOpen
              value={task.due_date ?? ""}
              onChange={(v) => { onPatch({ due_date: v || null }); setEditDue(false); }}
              onClose={() => setEditDue(false)}
              className="h-7 w-auto px-1.5 py-0.5 text-[11px]"
            />
          </div>
        ) : deadline && zone !== "done" ? (
          <button
            type="button"
            disabled={!canEdit}
            onClick={canEdit ? (e) => { stop(e); setEditDue(true); } : undefined}
            className={cn(
              "whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold",
              urg ? countdownClasses[urg] : "bg-secondary text-muted-foreground",
              canEdit && "hover:ring-1 hover:ring-ring",
            )}
            title={constraint ? `${t("effort.constraint")}: ${gregShort(parseISO(constraint))}` : te("due")}
          >
            {countdownText(deadline, t, today)} · {gregShort(parseISO(deadline))} · {hebDate(parseISO(deadline))}
            {constraint && <span className="ms-1 text-status-late">⚠ {gregShort(parseISO(constraint))}</span>}
          </button>
        ) : canEdit && zone !== "done" ? (
          <button
            type="button"
            onClick={(e) => { stop(e); setEditDue(true); }}
            className="whitespace-nowrap rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground/70 hover:ring-1 hover:ring-ring"
            title={te("due")}
          >
            {te("due")}
          </button>
        ) : null}
      </div>

      {zone === "blocked" && waiting.length > 0 && (
        <div className="ms-7 mt-1.5 space-y-1">
          <div className="text-[11px] font-bold text-muted-foreground">{t("effort.needs")}</div>
          {(task.needs ?? []).map((n) => {
            const needAssignee = n.assignee_user_id ? memberMap.get(n.assignee_user_id) ?? null : null;
            return (
              <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
                <span
                  className={cn(
                    "flex h-[16px] w-[16px] items-center justify-center rounded text-[10px] text-white",
                    n.satisfied ? "bg-status-ok" : "bg-status-warn",
                  )}
                >
                  {n.satisfied ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                </span>
                {n.task_id ? (
                  <button type="button" onClick={() => onJumpToTask(n.task_id)} className="text-start hover:underline">
                    {n.title}
                  </button>
                ) : (
                  <span>{n.title}</span>
                )}
                {needAssignee && (
                  <span className="whitespace-nowrap rounded bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground">
                    {needAssignee}
                  </span>
                )}
                <span className="ms-auto text-[11px] text-muted-foreground">
                  {n.satisfied ? t("effort.arrived") : t("effort.waiting")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {(task.handoff ?? []).length > 0 && zone !== "done" && (
        <div className="ms-7 mt-1 flex items-center gap-1.5 text-[12px] text-foreground/70">
          <ArrowRight className="h-3.5 w-3.5 text-status-ok" />
          <span className="text-[11px] font-bold text-muted-foreground">{t("effort.handoff")}:</span>
          {(task.handoff ?? []).map((h) => h.title).join(" · ")}
        </div>
      )}
    </div>
  );
}

function NewTaskRow({
  planId,
  stageId = null,
  members,
  te,
  onDone,
}: {
  planId: string;
  stageId?: string | null;
  members: Member[];
  te: ReturnType<typeof useTranslations>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [dur, setDur] = useState("");
  const [status, setStatus] = useState("inbox");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api(`/api/plans/${planId}/tasks`, {
        method: "POST",
        body: {
          title_he: title.trim(),
          due_date: due || null,
          duration_days: dur ? Number(dur) : null,
          status,
          assigned_to_user_id: assignee || null,
          stage_id: stageId,
        },
      });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }
  // One-step create: set every core setting here — no save-then-reopen.
  // (Dependencies are added after creation, since they reference this task's id.)
  return (
    <div className="my-2 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
      <input className={`${fieldCls} flex-1`} placeholder={te("taskTitle")} value={title}
        onChange={(e) => setTitle(e.target.value)} dir="rtl" autoFocus />
      <select className={fieldCls} value={assignee} onChange={(e) => setAssignee(e.target.value)} title={te("assignee")}>
        <option value="">{te("unassigned")}</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>
        ))}
      </select>
      <select className={fieldCls} value={status} onChange={(e) => setStatus(e.target.value)} title={te("statusInbox")}>
        <option value="inbox">{te("statusInbox")}</option>
        <option value="in_progress">{te("statusInProgress")}</option>
        <option value="archived">{te("statusDone")}</option>
      </select>
      <DatePicker className="h-8 w-auto px-2 py-1 text-[12.5px]" value={due} onChange={setDue} />
      <input type="number" min={0} step={0.5} className={`${fieldCls} w-40`} placeholder={te("durationDays")} value={dur}
        onChange={(e) => setDur(e.target.value)} title={te("durationDays")} />
      <button onClick={save} disabled={busy || !title.trim()}
        className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50">
        {te("save")}
      </button>
    </div>
  );
}

interface DepCandidate {
  id: string;
  title: string;
  title_he: string | null;
  plan_id: string;
  plan_title_he: string | null;
  plan_title_en: string | null;
}

function EditTaskRow({
  task,
  planId,
  members,
  te,
  onClose,
  onChanged,
}: {
  task: PlanTask;
  planId: string;
  members: Member[];
  te: ReturnType<typeof useTranslations>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(task.title_he || task.title);
  const [due, setDue] = useState(task.due_date ?? "");
  // dur is the MANUAL override only — blank means "let the engine compute it".
  const [dur, setDur] = useState(task.duration_manual && task.duration_days != null ? String(task.duration_days) : "");
  const [status, setStatus] = useState(task.status);
  const [assignee, setAssignee] = useState(task.assigned_to_user_id ?? "");
  // Dependency picker value is typed: "task:<id>" or "plan:<id>" (a capability).
  const [provider, setProvider] = useState("");
  const [candTasks, setCandTasks] = useState<DepCandidate[]>([]);
  const [candCaps, setCandCaps] = useState<{ id: string; title_he: string; title_en: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ tasks: DepCandidate[]; capabilities: { id: string; title_he: string; title_en: string | null }[] }>(
      `/api/plans/${planId}/dep-candidates`,
    )
      .then((d) => {
        if (!alive) return;
        setCandTasks((d.tasks ?? []).filter((x) => x.id !== task.id));
        setCandCaps(d.capabilities ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [planId, task.id]);

  const samePlanTasks = candTasks.filter((x) => x.plan_id === planId);
  const otherPlanTasks = candTasks.filter((x) => x.plan_id !== planId);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/plan-tasks/${task.id}`, {
        method: "PATCH",
        body: {
          title_he: title.trim(),
          title: title.trim(),
          due_date: due || null,
          // a filled manual duration pins it; otherwise the engine owns it.
          duration_days: dur ? Number(dur) : null,
          duration_manual: !!dur,
          status,
          assigned_to_user_id: assignee || null,
        },
      });
      onClose();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    if (!confirm(te("confirmDelete"))) return;
    setBusy(true);
    try {
      await api(`/api/plan-tasks/${task.id}`, { method: "DELETE" });
      onClose();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }
  async function addNeed() {
    if (!provider) return;
    const sep = provider.indexOf(":");
    const kind = provider.slice(0, sep); // "task" | "plan"
    const id = provider.slice(sep + 1);
    try {
      await api("/api/plan-dependencies", {
        method: "POST",
        body: { from_type: "task", from_id: task.id, to_type: kind, to_id: id },
      });
      setProvider("");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }
  async function setLag(depId: string, lag: number) {
    try {
      await api(`/api/plan-dependencies/${depId}`, { method: "PATCH", body: { lag_days: lag } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }
  async function removeNeed(depId: string) {
    try {
      await api(`/api/plan-dependencies/${depId}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  return (
    <div className="my-2 space-y-2 rounded-lg border bg-secondary/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${fieldCls} flex-1`} value={title} onChange={(e) => setTitle(e.target.value)} dir="rtl" />
        <DatePicker className="h-8 w-auto px-2 py-1 text-[12.5px]" value={due} onChange={setDue} />
        <select className={fieldCls} value={status} onChange={(e) => setStatus(e.target.value as PlanTask["status"])}>
          <option value="inbox">{te("statusInbox")}</option>
          <option value="in_progress">{te("statusInProgress")}</option>
          <option value="archived">{te("statusDone")}</option>
        </select>
        <select className={fieldCls} value={assignee} onChange={(e) => setAssignee(e.target.value)} title={te("assignee")}>
          <option value="">{te("unassigned")}</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>
          ))}
        </select>
      </div>

      {/* duration in working days */}
      <div className="flex flex-wrap items-center gap-2">
        <input type="number" min={0} step={0.5} className={`${fieldCls} w-40`} placeholder={te("durationDays")}
          value={dur} onChange={(e) => setDur(e.target.value)} title={te("durationDays")} />
      </div>

      {/* subtasks (checklist) — same editor as the regular tasks desk; persists
          on the shared tasks row, so adds/edits/toggles stick immediately */}
      <TaskChecklist taskId={task.id} items={task.checklist ?? []} onChange={onChanged} />

      {/* needs editor */}
      <div className="space-y-1">
        <div className="text-[11px] font-bold text-muted-foreground">{te("needs")}</div>
        {(task.needs ?? []).map((n) => (
          <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
            <span className="flex-1">{n.title}</span>
            <label className="flex items-center gap-1 whitespace-nowrap text-[10.5px] text-muted-foreground">
              <input
                type="number"
                min={0}
                defaultValue={n.lag_days ?? 0}
                onBlur={(e) => {
                  const v = Math.max(0, parseInt(e.target.value, 10) || 0);
                  if (v !== (n.lag_days ?? 0)) setLag(n.dependency_id, v);
                }}
                className="w-12 rounded border border-input bg-background px-1 py-0.5 text-end"
              />
              {te("lagDays")}
            </label>
            <button onClick={() => removeNeed(n.dependency_id)}
              className="rounded p-0.5 text-muted-foreground hover:bg-status-late/10 hover:text-status-late">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <select className={`${fieldCls} flex-1`} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">{te("pickTask")}</option>
            {samePlanTasks.length > 0 && (
              <optgroup label={te("samePlan")}>
                {samePlanTasks.map((o) => (
                  <option key={o.id} value={`task:${o.id}`}>{o.title_he || o.title}</option>
                ))}
              </optgroup>
            )}
            {otherPlanTasks.length > 0 && (
              <optgroup label={te("otherPlans")}>
                {otherPlanTasks.map((o) => (
                  <option key={o.id} value={`task:${o.id}`}>
                    {(o.title_he || o.title)}{o.plan_title_he ? ` · ${o.plan_title_he}` : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {candCaps.length > 0 && (
              <optgroup label={te("capabilities")}>
                {candCaps.map((c) => (
                  <option key={c.id} value={`plan:${c.id}`}>{c.title_he}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button onClick={addNeed} disabled={!provider}
            className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[12px] hover:bg-accent disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> {te("addNeed")}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button onClick={del} disabled={busy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-status-late hover:bg-status-late/10">
          <Trash2 className="h-3.5 w-3.5" /> {te("delete")}
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} disabled={busy}
            className="rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-accent">
            {te("cancel")}
          </button>
          <button onClick={save} disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50">
            {te("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
