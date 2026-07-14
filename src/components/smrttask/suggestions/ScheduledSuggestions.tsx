"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Pause, Trash2, BellRing, Pencil, CalendarClock, Repeat } from "lucide-react";
import { toast } from "sonner";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { TaskDetail } from "@/components/smrttask/tasks/TaskDetail";
import { todayISO } from "@/lib/workdays";
import type { Task } from "@/types/task";

interface ReminderRow {
  id: string;
  remind_at: string | null;
  recurrence_rule: string | null;
  message: string | null;
  message_he: string | null;
  title_he: string | null;
  tasks: { title: string | null; title_he: string | null } | { title: string | null; title_he: string | null }[] | null;
}

interface SnoozedTaskRow {
  id: string;
  title: string | null;
  title_he: string | null;
  snoozed_until: string | null;
  priority: string | null;
  manually_verified: boolean | null;
}

interface DatedTaskRow {
  id: string;
  title: string | null;
  title_he: string | null;
  due_date: string | null;
  due_time: string | null;
  priority: string | null;
  task_type: string | null;
  manually_verified: boolean | null;
}

interface RecurringTaskRow {
  id: string;
  title: string | null;
  title_he: string | null;
  due_date: string | null;
  due_time: string | null;
  recurrence_rule: string | null;
  recurrence_until: string | null;
  priority: string | null;
  task_type: string | null;
  status: string | null;
}

/** Compact cadence label key (under the `manualTask` namespace) for a rule. */
function recurrenceSummaryKey(rule: string | null | undefined): string {
  if (!rule) return "recurrenceNone";
  if (rule.includes("FREQ=DAILY")) return "recurrenceDaily";
  if (rule.includes("FREQ=WEEKLY")) return "recurrenceWeekly";
  if (rule.includes("FREQ=MONTHLY") || rule.includes("FREQ=HEBREW_MONTHLY")) return "recurrenceMonthly";
  if (rule.includes("FREQ=HEBREW_YEARLY")) return "recurrenceHebrew";
  if (rule.includes("FREQ=YEARLY")) return "recurrenceYearly";
  return "recurrenceNone";
}

export function ScheduledSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const tManual = useTranslations("manualTask");
  const supabase = createClient();
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [snoozed, setSnoozed] = useState<SnoozedTaskRow[]>([]);
  const [dated, setDated] = useState<DatedTaskRow[]>([]);
  const [recurring, setRecurring] = useState<RecurringTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Show the skeleton only on the first load. Later refetches (triggered by the
  // open editor's onUpdate) must NOT swap the tree for a skeleton — that would
  // unmount the TaskDetail dialog mid-edit.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  // Full-editor state — opening any card fetches the complete task and shows
  // the same TaskDetail dialog used on the tasks page, so every field
  // (title, description, size, due date, recurrence, checklist…) is editable.
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      // Reminders come from the existing /api/reminders endpoint. Snoozed
      // tasks/suggestions come straight from supabase: a snoozed row is a
      // hidden inbox item that will re-surface at snoozed_until. The worker
      // (reminders-check edge function) flips status back to "inbox" when
      // the time arrives. We show ALL snoozed rows here — both unverified
      // suggestions and verified approved tasks — since this is the only
      // tab where the user can see them.
      const [remindersResp, { data: { user } }] = await Promise.all([
        api<{ reminders: ReminderRow[] }>("/api/reminders?active=true&limit=30").catch((e) => {
          if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
          return { reminders: [] };
        }),
        supabase.auth.getUser(),
      ]);

      setReminders(remindersResp.reminders ?? []);

      if (user) {
        const { data: snoozedRows } = await supabase
          .from("tasks")
          .select("id, title, title_he, snoozed_until, priority, manually_verified")
          .eq("user_id", user.id)
          .eq("status", "snoozed")
          .not("snoozed_until", "is", null)
          // Recurring tasks get their own section below — keep them out of here
          // so each task appears in exactly one place.
          .is("recurrence_rule", null)
          // Order by WHEN it was snoozed (status_changed_at), freshest first —
          // the user scans "what did I just push off", not "what wakes first".
          .order("status_changed_at", { ascending: false })
          .limit(200);
        setSnoozed((snoozedRows as SnoozedTaskRow[] | null) ?? []);

        // Dated but not snoozed — the daily method's "scheduled" track. Anything
        // with a FUTURE due date sits here and floats into "היום" on its day
        // (a due-today/overdue task already shows on the Today screen). Snoozed
        // rows are excluded here since they render in their own section above.
        const { data: datedRows } = await supabase
          .from("tasks")
          .select("id, title, title_he, due_date, due_time, priority, task_type, manually_verified")
          .eq("user_id", user.id)
          .eq("manually_verified", true)
          .not("due_date", "is", null)
          .gt("due_date", todayISO())
          .in("status", ["inbox", "in_progress"])
          // Recurring tasks render in their own section — exclude here.
          .is("recurrence_rule", null)
          .order("due_date", { ascending: true })
          .limit(200);
        setDated((datedRows as DatedTaskRow[] | null) ?? []);

        // Recurring tasks — the "organized place" to review every repeating
        // task and open it for a full edit. We show the one live instance per
        // series (completed instances are history; completing spawns the next),
        // ordered by the next due date.
        const { data: recurringRows } = await supabase
          .from("tasks")
          .select("id, title, title_he, due_date, due_time, recurrence_rule, recurrence_until, priority, task_type, status")
          .eq("user_id", user.id)
          // Verified only — an unverified recurring suggestion still lives in
          // the Messages tab; showing it here too would duplicate it.
          .eq("manually_verified", true)
          .not("recurrence_rule", "is", null)
          .in("status", ["inbox", "in_progress", "snoozed"])
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(200);
        setRecurring((recurringRows as RecurringTaskRow[] | null) ?? []);
      } else {
        setSnoozed([]);
        setDated([]);
        setRecurring([]);
      }
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [supabase]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function handlePause(id: string) {
    try {
      await api(`/api/reminders/${id}`, { method: "PATCH", body: { is_active: false } });
      toast.success(t("paused"));
      fetchAll();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/api/reminders/${id}`, { method: "DELETE" });
      toast.success(t("removed"));
      fetchAll();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // "Wake up now" — flip the snoozed task back into the inbox immediately,
  // so the user can re-act on it. The reminders-check worker does this
  // automatically when snoozed_until arrives; this is the manual override.
  async function handleUnsnooze(taskId: string) {
    try {
      const { error } = await supabase
        .from("tasks")
        .update({ status: "inbox", snoozed_until: null })
        .eq("id", taskId);
      if (error) throw new Error(error.message);
      toast.success(t("unsnoozed"));
      fetchAll();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Open any scheduled card in the full task editor. We only hold slim rows
  // here (a few columns), so fetch the complete task first, then open the
  // shared TaskDetail dialog — the same one the tasks page uses.
  const openTask = useCallback(async (taskId: string) => {
    try {
      const { task } = await api<{ task: Task }>(`/api/tasks/${taskId}`);
      setSelectedTask(task);
      setDetailOpen(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  async function handleTaskDelete(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      toast.success(tTasks("actions.delete"));
      setDetailOpen(false);
      setSelectedTask(null);
      fetchAll();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleReschedule(untilIso: string) {
    if (!rescheduleTaskId) return;
    try {
      await api(`/api/tasks/${rescheduleTaskId}/snooze`, {
        method: "POST",
        body: { until: untilIso },
      });
      toast.success(tTasks("actions.snooze"));
      setRescheduleTaskId(null);
      fetchAll();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading && !loadedOnce) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  if (reminders.length === 0 && snoozed.length === 0 && dated.length === 0 && recurring.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Clock className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noScheduled")}</p>
      </div>
    );
  }

  const dtFmt = locale === "he" ? "he-IL" : "en-US";

  return (
    <div className="space-y-6">
      {recurring.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("recurringSection")} ({recurring.length})
          </h3>
          <div className="space-y-3">
            {recurring.map((task) => {
              const title = (locale === "he" && task.title_he ? task.title_he : task.title) || "";
              const nextLabel = task.due_date
                ? new Date(`${task.due_date}T${task.due_time || "00:00"}:00`).toLocaleDateString(dtFmt, {
                    day: "numeric", month: "short", ...(task.due_time ? { hour: "2-digit", minute: "2-digit" } : {}),
                  })
                : "";
              const untilLabel = task.recurrence_until
                ? new Date(`${task.recurrence_until}T00:00:00`).toLocaleDateString(dtFmt, {
                    day: "numeric", month: "short", year: "numeric",
                  })
                : "";
              return (
                <Card key={task.id} className="transition-colors hover:bg-accent/50">
                  <CardContent className="p-0">
                    <button
                      type="button"
                      onClick={() => openTask(task.id)}
                      className="flex w-full items-start gap-2 p-4 text-start"
                      title={t("editDetails")}
                      aria-label={t("editDetails")}
                    >
                      <div className="mt-1 rounded-full bg-primary/10 p-1.5 shrink-0">
                        <Repeat className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant="secondary" className="text-[10px]">
                            {tManual(recurrenceSummaryKey(task.recurrence_rule))}
                          </Badge>
                          {nextLabel && <Badge variant="outline" className="text-[10px]">{nextLabel}</Badge>}
                          <Badge variant="outline" className="text-[10px]">
                            {task.recurrence_until ? t("untilLabel", { when: untilLabel }) : t("noEndDate")}
                          </Badge>
                          {task.task_type === "meeting" && (
                            <Badge variant="secondary" className="text-[10px]">{t("kindEvent")}</Badge>
                          )}
                          {task.priority && (
                            <Badge variant="secondary" className="text-[10px]">{tTasks(`priority.${task.priority}`)}</Badge>
                          )}
                        </div>
                      </div>
                      <Pencil className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {dated.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("datedSection")} ({dated.length})
          </h3>
          <div className="space-y-3">
            {dated.map((task) => {
              const title = (locale === "he" && task.title_he ? task.title_he : task.title) || "";
              const whenLabel = task.due_date
                ? new Date(`${task.due_date}T${task.due_time || "00:00"}:00`).toLocaleDateString(dtFmt, {
                    day: "numeric", month: "short", ...(task.due_time ? { hour: "2-digit", minute: "2-digit" } : {}),
                  })
                : "";
              return (
                <Card key={task.id} className="transition-colors hover:bg-accent/50">
                  <CardContent className="p-0">
                    <button
                      type="button"
                      onClick={() => openTask(task.id)}
                      className="flex w-full items-start gap-2 p-4 text-start"
                      title={t("editDetails")}
                      aria-label={t("editDetails")}
                    >
                      <div className="mt-1 rounded-full bg-primary/10 p-1.5 shrink-0">
                        <CalendarClock className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{whenLabel}</Badge>
                          {task.task_type === "meeting" && (
                            <Badge variant="secondary" className="text-[10px]">{t("kindEvent")}</Badge>
                          )}
                          {task.priority && (
                            <Badge variant="secondary" className="text-[10px]">{tTasks(`priority.${task.priority}`)}</Badge>
                          )}
                        </div>
                      </div>
                      <Pencil className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {snoozed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("snoozedSection")} ({snoozed.length})
          </h3>
          <div className="space-y-3">
            {snoozed.map((task) => {
              const title = (locale === "he" && task.title_he ? task.title_he : task.title) || "";
              const whenLabel = task.snoozed_until
                ? new Date(task.snoozed_until).toLocaleString(dtFmt)
                : "";
              return (
                <Card key={task.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => openTask(task.id)}
                        className="flex items-start gap-2 flex-1 min-w-0 text-start"
                        title={t("editDetails")}
                        aria-label={t("editDetails")}
                      >
                        <div className="mt-1 rounded-full bg-status-warn-bg p-1.5 shrink-0">
                          <Clock className="h-3.5 w-3.5 text-status-warn" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge variant="outline" className="text-[10px]">
                              {t("snoozedUntil", { when: whenLabel })}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px]">
                              {task.manually_verified ? t("kindTask") : t("kindSuggestion")}
                            </Badge>
                            {task.priority && (
                              <Badge variant="secondary" className="text-[10px]">
                                {tTasks(`priority.${task.priority}`)}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          onClick={() => setRescheduleTaskId(task.id)}
                          title={t("reschedule")}
                          aria-label={t("reschedule")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-status-warn hover:bg-status-warn-bg"
                          onClick={() => handleUnsnooze(task.id)}
                          title={t("unsnooze")}
                          aria-label={t("unsnooze")}
                        >
                          <BellRing className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {reminders.length > 0 && (
        <section className="space-y-2">
          {snoozed.length > 0 && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("remindersSection")} ({reminders.length})
            </h3>
          )}
          <div className="space-y-3">
            {reminders.map((reminder) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const task = reminder.tasks as any;
              const title = locale === "he"
                ? (reminder.title_he || task?.title_he || reminder.message_he || reminder.message)
                : (task?.title || reminder.message);
              const remindAt = reminder.remind_at ? new Date(reminder.remind_at as string) : null;
              const isPast = remindAt && remindAt < new Date();

              return (
                <Card key={reminder.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                        <div className="flex items-center gap-2 mt-1">
                          {remindAt && (
                            <Badge variant={isPast ? "destructive" : "outline"} className="text-[10px]">
                              {remindAt.toLocaleString(dtFmt)}
                            </Badge>
                          )}
                          {reminder.recurrence_rule && (
                            <Badge variant="secondary" className="text-[10px]">{t("recurring")}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 min-h-[48px] min-w-[48px]"
                          onClick={() => handlePause(reminder.id as string)}
                        >
                          <Pause className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-status-late"
                          onClick={() => handleDelete(reminder.id as string)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <SnoozeDialog
        open={!!rescheduleTaskId}
        onClose={() => setRescheduleTaskId(null)}
        onConfirm={handleReschedule}
      />

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          locale={locale}
          open={detailOpen}
          onClose={() => { setDetailOpen(false); setSelectedTask(null); }}
          onUpdate={fetchAll}
          onDelete={handleTaskDelete}
        />
      )}
    </div>
  );
}
