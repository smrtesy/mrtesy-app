"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { TaskZones, type PlanZoneTask } from "./TaskZones";

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
}
function memberName(m: Member) {
  return m.name || m.email || m.user_id.slice(0, 6);
}

const fieldCls =
  "rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TeamViewClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [members, setMembers] = useState<Member[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [tasks, setTasks] = useState<PlanZoneTask[]>([]);
  const [loading, setLoading] = useState(false);
  const today = new Date();

  useEffect(() => {
    api<{ members: Member[] }>("/api/org/members")
      .then((r) => {
        setMembers(r.members ?? []);
        if (r.members?.length) setUserId(r.members[0].user_id);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Error"));
  }, []);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoading(true);
    api<{ tasks: PlanZoneTask[] }>(`/api/plan/worker-tasks/${userId}`)
      .then((r) => alive && setTasks(r.tasks ?? []))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Error"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [userId]);

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
        <TaskZones tasks={tasks} locale={locale} today={today} />
      )}
    </div>
  );
}
