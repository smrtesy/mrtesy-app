"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { useOrgMembers, type OrgMember } from "@/hooks/useOrgMembers";
import { TaskZones, type PlanZoneTask } from "./TaskZones";
import { TaskDetailDialog } from "./TaskDetailDialog";
import { DebriefDialog, type DebriefPayload } from "@/components/smrttask/tasks/DebriefDialog";

type Member = OrgMember;
function memberName(m: Member) {
  return personLabel(m);
}

const fieldCls =
  "rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TeamViewClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const { members } = useOrgMembers();
  const [userId, setUserId] = useState<string>("");
  const [tasks, setTasks] = useState<PlanZoneTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [debriefTask, setDebriefTask] = useState<PlanZoneTask | null>(null);
  const today = new Date();

  // Default the worker picker to the first member once the roster arrives.
  useEffect(() => {
    if (members.length) setUserId((cur) => cur || members[0].user_id);
  }, [members]);

  useEffect(() => {
    api<{ access_level: string }>("/api/plans/access")
      .then((r) => setCanEdit(r.access_level === "full"))
      .catch(() => setCanEdit(false));
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    const { tasks } = await api<{ tasks: PlanZoneTask[] }>(`/api/plan/worker-tasks/${userId}`);
    setTasks(tasks ?? []);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoading(true);
    load()
      .catch((e) => alive && toast.error(e instanceof Error ? e.message : "Error"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [userId, load]);

  // ✓ / un-✓ — the server allows the assignee, full access, or super-admin.
  async function toggle(id: string, done: boolean, debrief?: DebriefPayload) {
    if (done && !debrief) {
      const tk = tasks.find((x) => x.id === id);
      if (tk?.requires_debrief) { setDebriefTask(tk); return; }
    }
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: done ? "completed" : "inbox" } : x)));
    try {
      await api(`/api/plan-tasks/${id}/done`, { method: "PATCH", body: { done, ...(debrief ? { debrief } : {}) } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      await load();
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("team.title")}</h1>
        <p className="text-[12.5px] text-muted-foreground">{t("team.lead")}</p>
      </div>

      <label className="flex items-center gap-2 text-[13px] font-medium">
        {t("team.worker")}:
        <select className={fieldCls} value={userId} onChange={(e) => setUserId(e.target.value)}>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>
          ))}
        </select>
      </label>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("team.empty")}
        </div>
      ) : (
        <TaskZones
          tasks={tasks}
          locale={locale}
          today={today}
          onToggle={toggle}
          onOpen={(tk) => setOpenTaskId(tk.id)}
        />
      )}

      <TaskDetailDialog
        taskId={openTaskId}
        open={!!openTaskId}
        onClose={() => setOpenTaskId(null)}
        locale={locale}
        canEdit={canEdit}
        onChanged={() => void load()}
      />

      <DebriefDialog
        open={!!debriefTask}
        taskTitle={debriefTask ? (locale === "en" ? debriefTask.title : debriefTask.title_he || debriefTask.title) : ""}
        onClose={() => setDebriefTask(null)}
        onConfirm={(debrief) => {
          const tk = debriefTask;
          setDebriefTask(null);
          if (tk) void toggle(tk.id, true, debrief);
        }}
      />
    </div>
  );
}
