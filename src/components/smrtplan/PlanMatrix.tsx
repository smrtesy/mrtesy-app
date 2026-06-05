"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanStageRow, PlanEpisode, EpisodeStageStatus, CellStatus } from "@/types/plan";
import { parseISO, gregShort, daysBetween } from "@/lib/smrtplan/dates";
import { CellSheet } from "./CellSheet";

interface LinkedTask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  assigned_to_user_id: string | null;
  due_date: string | null;
}

function stageName(s: PlanStageRow, locale: string) {
  return locale === "en" ? s.name_en || s.name_he : s.name_he;
}
function epName(e: PlanEpisode, locale: string) {
  return locale === "en" ? e.name_en || e.name_he : e.name_he;
}

const cellGlyph: Record<CellStatus, string> = { todo: "", prog: "∙", done: "✓" };

export function PlanMatrix({
  plan,
  locale,
  canEdit,
  today,
  onChanged,
}: {
  plan: Plan;
  locale: string;
  canEdit: boolean;
  today: Date;
  onChanged?: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [stages, setStages] = useState<PlanStageRow[]>([]);
  const [episodes, setEpisodes] = useState<PlanEpisode[]>([]);
  const [cells, setCells] = useState<Record<string, EpisodeStageStatus>>({});
  const [linkedTasks, setLinkedTasks] = useState<Record<string, LinkedTask>>({});
  const [sheet, setSheet] = useState<{ episode: PlanEpisode; stage: PlanStageRow } | null>(null);
  const [loading, setLoading] = useState(true);

  async function refetch() {
    const data = await api<{
      stages: PlanStageRow[];
      episodes: PlanEpisode[];
      cells: Record<string, EpisodeStageStatus>;
      tasks: Record<string, LinkedTask>;
    }>(`/api/plans/${plan.id}/matrix`);
    setStages(data.stages ?? []);
    setEpisodes(data.episodes ?? []);
    setCells(data.cells ?? {});
    setLinkedTasks(data.tasks ?? {});
    onChanged?.();
  }

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  const addStage = () => {
    const name = prompt(te("addStage"));
    if (name) run(() => api(`/api/plans/${plan.id}/stages`, { method: "POST", body: { name_he: name, sequence: stages.length + 1 } }));
  };
  const addEpisode = () => {
    const name = prompt(te("addEpisode"));
    if (name) run(() => api(`/api/plans/${plan.id}/episodes`, { method: "POST", body: { name_he: name, sequence: episodes.length + 1 } }));
  };
  const renameStage = (s: PlanStageRow) => {
    const name = prompt(te("name"), s.name_he);
    if (name != null) run(() => api(`/api/plan-stages/${s.id}`, { method: "PATCH", body: { name_he: name } }));
  };
  const delStage = (s: PlanStageRow) => {
    if (confirm(te("confirmDelete"))) run(() => api(`/api/plan-stages/${s.id}`, { method: "DELETE" }));
  };
  const editEpisode = (ep: PlanEpisode) => {
    const name = prompt(te("name"), ep.name_he);
    if (name == null) return;
    const due = prompt(te("due"), ep.due_date ?? "");
    run(() => api(`/api/plan-episodes/${ep.id}`, { method: "PATCH", body: { name_he: name, due_date: due || null } }));
  };
  const delEpisode = (ep: PlanEpisode) => {
    if (confirm(te("confirmDelete"))) run(() => api(`/api/plan-episodes/${ep.id}`, { method: "DELETE" }));
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{
          stages: PlanStageRow[];
          episodes: PlanEpisode[];
          cells: Record<string, EpisodeStageStatus>;
          tasks: Record<string, LinkedTask>;
        }>(`/api/plans/${plan.id}/matrix`);
        if (!alive) return;
        setStages(data.stages ?? []);
        setEpisodes(data.episodes ?? []);
        setCells(data.cells ?? {});
        setLinkedTasks(data.tasks ?? {});
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

  function currentStage(ep: PlanEpisode): string {
    for (const s of stages) {
      const c = cells[`${ep.id}:${s.id}`];
      if (!c || c.status !== "done") return stageName(s, locale);
    }
    return t("matrix.ready");
  }

  const title = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;

  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-bold">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: plan.color || "#534AB7" }} />
        {title}
        <span className="rounded bg-accent px-1.5 py-px text-[9px] font-bold text-accent-foreground">
          {t("tags.stream")}
        </span>
      </h2>
      <p className="mb-3 mt-0.5 text-[12.5px] text-muted-foreground">{t("matrix.sub")}</p>

      {canEdit && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={addEpisode} className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
            <Plus className="h-3.5 w-3.5" /> {te("addEpisode")}
          </button>
          <button onClick={addStage} className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
            <Plus className="h-3.5 w-3.5" /> {te("addStage")}
          </button>
        </div>
      )}

      {stages.length === 0 || episodes.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] italic text-muted-foreground">{t("matrix.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[12px]">
            <thead>
              <tr>
                <th className="border bg-secondary/60 p-1.5 text-start text-[11px] font-bold">
                  {t("matrix.episode")}
                </th>
                {stages.map((s) => (
                  <th key={s.id} className="border bg-secondary/60 p-1.5 text-[11px] font-bold">
                    {stageName(s, locale)}
                    {canEdit && (
                      <span className="mt-0.5 flex items-center justify-center gap-1">
                        <button onClick={() => renameStage(s)} className="text-muted-foreground hover:text-foreground" title={te("edit")}>
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button onClick={() => delStage(s)} className="text-muted-foreground hover:text-status-late" title={te("delete")}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </th>
                ))}
                <th className="border bg-secondary/60 p-1.5 text-[11px] font-bold">{t("matrix.stage")}</th>
                <th className="border bg-secondary/60 p-1.5 text-[11px] font-bold">{t("matrix.remaining")}</th>
              </tr>
            </thead>
            <tbody>
              {episodes.map((ep) => {
                const cs = currentStage(ep);
                const left = ep.due_date ? daysBetween(today, parseISO(ep.due_date)) : null;
                return (
                  <tr key={ep.id}>
                    <td className="border bg-secondary/30 p-1.5 text-start font-bold">
                      <span className="flex items-center gap-1">
                        <span className="flex-1">{epName(ep, locale)}</span>
                        {canEdit && (
                          <>
                            <button onClick={() => editEpisode(ep)} className="text-muted-foreground hover:text-foreground" title={te("edit")}>
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button onClick={() => delEpisode(ep)} className="text-muted-foreground hover:text-status-late" title={te("delete")}>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        )}
                      </span>
                      <small className="block font-normal text-[10px] text-muted-foreground">
                        {ep.family ? `${ep.family} · ` : ""}
                        {ep.due_date ? gregShort(parseISO(ep.due_date)) : ""}
                      </small>
                    </td>
                    {stages.map((s) => {
                      const cell = cells[`${ep.id}:${s.id}`];
                      const status: CellStatus = cell?.status ?? "todo";
                      const linked = cell?.task_id ? linkedTasks[cell.task_id] : undefined;
                      return (
                        <td key={s.id} className="border p-1.5 text-center">
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setSheet({ episode: ep, stage: s })}
                            className={cn(
                              "relative inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[12px]",
                              status === "done" && "bg-status-ok-bg text-status-ok",
                              status === "prog" && "bg-status-warn-bg text-status-warn",
                              status === "todo" && "bg-secondary text-muted-foreground/50",
                              canEdit && "cursor-pointer hover:ring-1 hover:ring-ring",
                            )}
                            title={linked ? (locale === "en" ? linked.title : linked.title_he || linked.title) : t(`matrix.cell.${status}`)}
                          >
                            {cellGlyph[status]}
                            {linked && (
                              <span className="absolute -end-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
                            )}
                          </button>
                        </td>
                      );
                    })}
                    <td className="border p-1.5 text-center">
                      <span className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                        {cs}
                      </span>
                    </td>
                    <td className="border p-1.5 text-center text-muted-foreground">
                      {cs === t("matrix.ready")
                        ? "—"
                        : left === null
                          ? "—"
                          : left < 0
                            ? t("matrix.passed")
                            : left}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {sheet && (
        <CellSheet
          open={!!sheet}
          onClose={() => setSheet(null)}
          planId={plan.id}
          episodeId={sheet.episode.id}
          stageId={sheet.stage.id}
          episodeName={epName(sheet.episode, locale)}
          stageName={stageName(sheet.stage, locale)}
          cell={cells[`${sheet.episode.id}:${sheet.stage.id}`]}
          task={cells[`${sheet.episode.id}:${sheet.stage.id}`]?.task_id ? linkedTasks[cells[`${sheet.episode.id}:${sheet.stage.id}`]!.task_id!] : undefined}
          locale={locale}
          onChanged={refetch}
        />
      )}
    </div>
  );
}
