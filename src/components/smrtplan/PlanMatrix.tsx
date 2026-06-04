"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanStageRow, PlanEpisode, EpisodeStageStatus, CellStatus } from "@/types/plan";
import { parseISO, gregShort, daysBetween } from "@/lib/smrtplan/dates";

function stageName(s: PlanStageRow, locale: string) {
  return locale === "en" ? s.name_en || s.name_he : s.name_he;
}
function epName(e: PlanEpisode, locale: string) {
  return locale === "en" ? e.name_en || e.name_he : e.name_he;
}

const NEXT: Record<CellStatus, CellStatus> = { todo: "prog", prog: "done", done: "todo" };
const cellGlyph: Record<CellStatus, string> = { todo: "", prog: "∙", done: "✓" };

export function PlanMatrix({
  plan,
  locale,
  canEdit,
  today,
}: {
  plan: Plan;
  locale: string;
  canEdit: boolean;
  today: Date;
}) {
  const t = useTranslations("smrtPlan");
  const [stages, setStages] = useState<PlanStageRow[]>([]);
  const [episodes, setEpisodes] = useState<PlanEpisode[]>([]);
  const [cells, setCells] = useState<Record<string, EpisodeStageStatus>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{
          stages: PlanStageRow[];
          episodes: PlanEpisode[];
          cells: Record<string, EpisodeStageStatus>;
        }>(`/api/plans/${plan.id}/matrix`);
        if (!alive) return;
        setStages(data.stages ?? []);
        setEpisodes(data.episodes ?? []);
        setCells(data.cells ?? {});
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

  async function cycleCell(cell: EpisodeStageStatus) {
    if (!canEdit) return;
    const next = NEXT[cell.status];
    const key = `${cell.episode_id}:${cell.stage_id}`;
    setCells((prev) => ({ ...prev, [key]: { ...cell, status: next } }));
    try {
      await api(`/api/plan-cells/${cell.id}`, { method: "PATCH", body: { status: next } });
    } catch (e) {
      setCells((prev) => ({ ...prev, [key]: cell })); // revert
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

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
                      {epName(ep, locale)}
                      <small className="block font-normal text-[10px] text-muted-foreground">
                        {ep.family ? `${ep.family} · ` : ""}
                        {ep.due_date ? gregShort(parseISO(ep.due_date)) : ""}
                      </small>
                    </td>
                    {stages.map((s) => {
                      const cell = cells[`${ep.id}:${s.id}`];
                      const status: CellStatus = cell?.status ?? "todo";
                      return (
                        <td key={s.id} className="border p-1.5 text-center">
                          <button
                            type="button"
                            disabled={!canEdit || !cell}
                            onClick={() => cell && cycleCell(cell)}
                            className={cn(
                              "inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[12px]",
                              status === "done" && "bg-status-ok-bg text-status-ok",
                              status === "prog" && "bg-status-warn-bg text-status-warn",
                              status === "todo" && "bg-secondary text-muted-foreground/50",
                              canEdit && cell && "cursor-pointer hover:ring-1 hover:ring-ring",
                            )}
                            title={t(`matrix.cell.${status}`)}
                          >
                            {cellGlyph[status]}
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
    </div>
  );
}
