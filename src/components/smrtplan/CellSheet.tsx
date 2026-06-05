"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CellStatus, EpisodeStageStatus } from "@/types/plan";

interface LinkedTask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  assigned_to_user_id: string | null;
  due_date: string | null;
}

const STATUSES: CellStatus[] = ["todo", "prog", "done"];

export function CellSheet({
  open,
  onClose,
  planId,
  episodeId,
  stageId,
  episodeName,
  stageName,
  cell,
  task,
  locale,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  planId: string;
  episodeId: string;
  stageId: string;
  episodeName: string;
  stageName: string;
  cell: EpisodeStageStatus | undefined;
  task: LinkedTask | undefined;
  locale: string;
  onChanged: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const [busy, setBusy] = useState(false);
  const status: CellStatus = cell?.status ?? "todo";

  async function setStatus(s: CellStatus) {
    setBusy(true);
    try {
      // Upsert handles cells that don't have a row yet (new streams).
      await api("/api/plan-cells", { method: "POST", body: { episode_id: episodeId, stage_id: stageId, status: s } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    setBusy(true);
    try {
      // 1. make sure the cell row exists; 2. create the task; 3. link it.
      const { cell: ensured } = await api<{ cell: EpisodeStageStatus }>("/api/plan-cells", {
        method: "POST",
        body: { episode_id: episodeId, stage_id: stageId, status },
      });
      const { task: created } = await api<{ task: { id: string } }>(`/api/plans/${planId}/tasks`, {
        method: "POST",
        body: { title_he: `${episodeName} · ${stageName}` },
      });
      await api(`/api/plan-cells/${ensured.id}`, { method: "PATCH", body: { task_id: created.id } });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {episodeName} · {stageName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[11px] font-bold text-muted-foreground">{t("cell.status")}</div>
            <div className="flex gap-1">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  disabled={busy}
                  className={cn(
                    "flex-1 rounded-md border py-2 text-[12.5px] font-medium transition-colors",
                    status === s
                      ? s === "done"
                        ? "border-status-ok bg-status-ok-bg text-status-ok"
                        : s === "prog"
                          ? "border-status-warn bg-status-warn-bg text-status-warn"
                          : "border-input bg-secondary text-foreground"
                      : "border-input bg-background text-muted-foreground hover:bg-accent",
                  )}
                >
                  {t(`matrix.cell.${s}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-bold text-muted-foreground">{t("cell.linkedTask")}</div>
            {task ? (
              <div className="rounded-lg border p-3">
                <div className="text-[13px] font-medium">{locale === "en" ? task.title : task.title_he || task.title}</div>
                <div className="mt-1 text-[11.5px] text-muted-foreground">{t("cell.openInTasks")}</div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[12px] italic text-muted-foreground">{t("cell.noTask")}</p>
                <button
                  onClick={createTask}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" /> {t("cell.createTask")}
                </button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
