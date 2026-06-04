"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Clock, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/plan";
import type { Task, TaskNeed, TaskHandoff } from "@/types/task";
import { parseISO, gregShort, hebDate, countdownText, urgencyFor } from "@/lib/smrtplan/dates";

type PlanTask = Pick<
  Task,
  "id" | "title" | "title_he" | "status" | "due_date" | "latest_finish" | "duration_days" | "is_critical"
> & { needs: TaskNeed[]; handoff: TaskHandoff[] };

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
  onChanged,
}: {
  plan: Plan;
  locale: string;
  today: Date;
  canEdit?: boolean;
  onChanged?: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refetch = useCallback(async () => {
    const data = await api<{ tasks: PlanTask[] }>(`/api/plans/${plan.id}/tasks`);
    setTasks(data.tasks ?? []);
  }, [plan.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{ tasks: PlanTask[] }>(`/api/plans/${plan.id}/tasks`);
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

  async function afterMutation() {
    await refetch();
    onChanged?.();
  }

  const title = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;
  const progress = plan.effective_progress ?? plan.progress ?? 0;

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: plan.color || "#534AB7" }} />
            {title}
          </h2>
          <p className="mb-3 mt-0.5 text-[12.5px] text-muted-foreground">
            {plan.goal ? `${plan.goal} · ` : ""}
            {plan.start_date && plan.end_date
              ? `${gregShort(parseISO(plan.start_date))}–${gregShort(parseISO(plan.end_date))} · `
              : ""}
            {Math.round(progress * 100)}%
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" /> {te("addTask")}
          </button>
        )}
      </div>

      {adding && canEdit && (
        <NewTaskRow planId={plan.id} te={te} onDone={async () => { setAdding(false); await afterMutation(); }} />
      )}

      {tasks.length === 0 && !adding ? (
        <p className="py-6 text-center text-[12.5px] italic text-muted-foreground">{t("effort.empty")}</p>
      ) : (
        <div className="divide-y">
          {tasks.map((task) =>
            editingId === task.id && canEdit ? (
              <EditTaskRow
                key={task.id}
                task={task}
                otherTasks={tasks.filter((x) => x.id !== task.id)}
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
                canEdit={canEdit}
                onEdit={() => setEditingId(task.id)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  locale,
  today,
  t,
  canEdit,
  onEdit,
}: {
  task: PlanTask;
  locale: string;
  today: Date;
  t: ReturnType<typeof useTranslations>;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const zone = zoneOf(task);
  const due = task.latest_finish || task.due_date;
  const urg = urgencyFor(due, today);
  const waiting = (task.needs ?? []).filter((n) => !n.satisfied);
  return (
    <div className="py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded border text-[11px]",
            zone === "done" && "border-status-ok bg-status-ok text-white",
            zone === "blocked" && "border-dashed border-muted-foreground/40 text-transparent",
            zone === "ready" && "border-muted-foreground/40",
          )}
        >
          {zone === "done" ? "✓" : ""}
        </span>
        <span className={cn("flex-1 text-[13px]", zone === "done" && "text-muted-foreground line-through")}>
          {taskTitle(task, locale)}
          {task.is_critical && (
            <span className="ms-2 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
              {t("tags.critical")}
            </span>
          )}
        </span>
        {due && zone !== "done" && (
          <span
            className={cn(
              "whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold",
              urg ? countdownClasses[urg] : "bg-secondary text-muted-foreground",
            )}
          >
            {countdownText(due, t, today)} · {gregShort(parseISO(due))} · {hebDate(parseISO(due))}
          </span>
        )}
        {canEdit && (
          <button onClick={onEdit} className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {zone === "blocked" && waiting.length > 0 && (
        <div className="ms-7 mt-1.5 space-y-1">
          <div className="text-[11px] font-bold text-muted-foreground">{t("effort.needs")}</div>
          {(task.needs ?? []).map((n) => (
            <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
              <span
                className={cn(
                  "flex h-[16px] w-[16px] items-center justify-center rounded text-[10px] text-white",
                  n.satisfied ? "bg-status-ok" : "bg-status-warn",
                )}
              >
                {n.satisfied ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
              </span>
              <span>{n.title}</span>
              <span className="ms-auto text-[11px] text-muted-foreground">
                {n.satisfied ? t("effort.arrived") : t("effort.waiting")}
              </span>
            </div>
          ))}
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
  te,
  onDone,
}: {
  planId: string;
  te: ReturnType<typeof useTranslations>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [dur, setDur] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api(`/api/plans/${planId}/tasks`, {
        method: "POST",
        body: { title_he: title.trim(), due_date: due || null, duration_days: dur ? Number(dur) : null },
      });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="my-2 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
      <input className={`${fieldCls} flex-1`} placeholder={te("taskTitle")} value={title}
        onChange={(e) => setTitle(e.target.value)} dir="rtl" autoFocus />
      <input type="date" className={fieldCls} value={due} onChange={(e) => setDue(e.target.value)} title={te("due")} />
      <input type="number" min={1} className={`${fieldCls} w-20`} placeholder={te("duration")} value={dur}
        onChange={(e) => setDur(e.target.value)} />
      <button onClick={save} disabled={busy || !title.trim()}
        className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50">
        {te("save")}
      </button>
    </div>
  );
}

function EditTaskRow({
  task,
  otherTasks,
  te,
  onClose,
  onChanged,
}: {
  task: PlanTask;
  otherTasks: PlanTask[];
  te: ReturnType<typeof useTranslations>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(task.title_he || task.title);
  const [due, setDue] = useState(task.due_date ?? "");
  const [dur, setDur] = useState(task.duration_days != null ? String(task.duration_days) : "");
  const [status, setStatus] = useState(task.status);
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/plan-tasks/${task.id}`, {
        method: "PATCH",
        body: {
          title_he: title.trim(),
          title: title.trim(),
          due_date: due || null,
          duration_days: dur ? Number(dur) : null,
          status,
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
    try {
      await api("/api/plan-dependencies", {
        method: "POST",
        body: { from_type: "task", from_id: task.id, to_type: "task", to_id: provider },
      });
      setProvider("");
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
        <input type="date" className={fieldCls} value={due} onChange={(e) => setDue(e.target.value)} title={te("due")} />
        <input type="number" min={1} className={`${fieldCls} w-16`} placeholder={te("duration")} value={dur}
          onChange={(e) => setDur(e.target.value)} />
        <select className={fieldCls} value={status} onChange={(e) => setStatus(e.target.value as PlanTask["status"])}>
          <option value="inbox">{te("statusInbox")}</option>
          <option value="in_progress">{te("statusInProgress")}</option>
          <option value="archived">{te("statusDone")}</option>
        </select>
      </div>

      {/* needs editor */}
      <div className="space-y-1">
        <div className="text-[11px] font-bold text-muted-foreground">{te("needs")}</div>
        {(task.needs ?? []).map((n) => (
          <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
            <span>{n.title}</span>
            <button onClick={() => removeNeed(n.dependency_id)}
              className="rounded p-0.5 text-muted-foreground hover:bg-status-late/10 hover:text-status-late">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <select className={`${fieldCls} flex-1`} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">{te("pickTask")}</option>
            {otherTasks.map((o) => (
              <option key={o.id} value={o.id}>{o.title_he || o.title}</option>
            ))}
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
