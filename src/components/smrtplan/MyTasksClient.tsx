"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { TaskZones, type PlanZoneTask } from "./TaskZones";

export function MyTasksClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [tasks, setTasks] = useState<PlanZoneTask[]>([]);
  const [loading, setLoading] = useState(true);
  const today = new Date();

  const load = useCallback(async () => {
    const { tasks } = await api<{ tasks: PlanZoneTask[] }>("/api/plan/my-tasks");
    setTasks(tasks ?? []);
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

  async function complete(id: string) {
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: "archived" } : x)));
    try {
      await api(`/api/plan-tasks/${id}`, { method: "PATCH", body: { status: "archived" } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      await load();
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("my.title")}</h1>
        <p className="text-[12.5px] text-muted-foreground">{t("my.lead")}</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("my.noTasks")}
        </div>
      ) : (
        <TaskZones tasks={tasks} locale={locale} today={today} onComplete={complete} />
      )}
    </div>
  );
}
