"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanStageRow, PlanEpisode, EpisodeStageStatus, CellStatus } from "@/types/plan";
import { parseISO, gregShort, daysBetween } from "@/lib/smrtplan/dates";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { CellSheet } from "./CellSheet";

const fieldCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
  // null = closed; { stage: null } = add; { stage } = edit. Same for episodes.
  const [stageDialog, setStageDialog] = useState<{ stage: PlanStageRow | null } | null>(null);
  const [episodeDialog, setEpisodeDialog] = useState<{ episode: PlanEpisode | null } | null>(null);
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

  // Close the dialog only after the request succeeds — on failure the user
  // keeps their typed values (the error shows as a toast).
  const saveStage = async (values: { name_he: string; default_duration_days: number | null }, stage: PlanStageRow | null) => {
    if (stage) {
      await api(`/api/plan-stages/${stage.id}`, { method: "PATCH", body: values });
    } else {
      await api(`/api/plans/${plan.id}/stages`, { method: "POST", body: { ...values, sequence: stages.length + 1 } });
    }
    setStageDialog(null);
    await refetch();
  };
  const saveEpisode = async (values: { name_he: string; family: string | null; due_date: string | null }, episode: PlanEpisode | null) => {
    if (episode) {
      await api(`/api/plan-episodes/${episode.id}`, { method: "PATCH", body: values });
    } else {
      await api(`/api/plans/${plan.id}/episodes`, { method: "POST", body: { ...values, sequence: episodes.length + 1 } });
    }
    setEpisodeDialog(null);
    await refetch();
  };
  const delStage = (s: PlanStageRow) => {
    if (confirm(te("confirmDelete"))) run(() => api(`/api/plan-stages/${s.id}`, { method: "DELETE" }));
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

      {canEdit && (stages.length > 0 || episodes.length > 0) && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={() => setEpisodeDialog({ episode: null })} className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
            <Plus className="h-3.5 w-3.5" /> {te("addEpisode")}
          </button>
          <button onClick={() => setStageDialog({ stage: null })} className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
            <Plus className="h-3.5 w-3.5" /> {te("addStage")}
          </button>
        </div>
      )}

      {stages.length === 0 || episodes.length === 0 ? (
        <div className="rounded-lg border border-dashed py-8 text-center">
          <p className="text-[12.5px] font-medium">{t("matrix.empty")}</p>
          <p className="mx-auto mt-1 max-w-sm text-[12px] text-muted-foreground">{t("matrix.emptyHint")}</p>
          {canEdit && (
            <div className="mt-3 flex justify-center gap-2">
              {episodes.length === 0 && (
                <button onClick={() => setEpisodeDialog({ episode: null })} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90">
                  <Plus className="h-3.5 w-3.5" /> {te("addEpisode")}
                </button>
              )}
              {stages.length === 0 && (
                <button onClick={() => setStageDialog({ stage: null })} className="inline-flex items-center gap-1 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-accent">
                  <Plus className="h-3.5 w-3.5" /> {te("addStage")}
                </button>
              )}
            </div>
          )}
        </div>
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
                    {s.default_duration_days != null && (
                      <span className="ms-1 rounded bg-accent px-1 py-px text-[9px] font-medium text-muted-foreground">
                        {s.default_duration_days} {te("daysUnit")}
                      </span>
                    )}
                    {canEdit && (
                      <span className="mt-0.5 flex items-center justify-center gap-1">
                        <button onClick={() => setStageDialog({ stage: s })} className="text-muted-foreground hover:text-foreground" title={te("edit")}>
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
                            <button onClick={() => setEpisodeDialog({ episode: ep })} className="text-muted-foreground hover:text-foreground" title={te("edit")}>
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

      {stageDialog && (
        <StageDialog
          stage={stageDialog.stage}
          onClose={() => setStageDialog(null)}
          onSave={(values) => saveStage(values, stageDialog.stage)}
        />
      )}
      {episodeDialog && (
        <EpisodeDialog
          episode={episodeDialog.episode}
          onClose={() => setEpisodeDialog(null)}
          onSave={(values) => saveEpisode(values, episodeDialog.episode)}
        />
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

/** Add/edit a stage (a step every episode passes through): name + optional
 *  default duration in working days. Replaces the old chained prompt()s. */
function StageDialog({
  stage,
  onClose,
  onSave,
}: {
  stage: PlanStageRow | null;
  onClose: () => void;
  onSave: (values: { name_he: string; default_duration_days: number | null }) => Promise<void>;
}) {
  const te = useTranslations("smrtPlan.edit");
  const [name, setName] = useState(stage?.name_he ?? "");
  const [dur, setDur] = useState(stage?.default_duration_days != null ? String(stage.default_duration_days) : "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave({ name_he: name.trim(), default_duration_days: dur.trim() !== "" ? Number(dur) : null });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{stage ? te("editStage") : te("addStage")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{te("name")}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} dir="rtl" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{te("stageDefaultDur")}</span>
            <input type="number" min={0} step={0.5} className={fieldCls} value={dur}
              onChange={(e) => setDur(e.target.value)} />
          </label>
        </div>
        <DialogFooter className="mt-2 flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>{te("cancel")}</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>{te("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Add/edit an episode (a deliverable row): name + optional family + due date. */
function EpisodeDialog({
  episode,
  onClose,
  onSave,
}: {
  episode: PlanEpisode | null;
  onClose: () => void;
  onSave: (values: { name_he: string; family: string | null; due_date: string | null }) => Promise<void>;
}) {
  const te = useTranslations("smrtPlan.edit");
  const [name, setName] = useState(episode?.name_he ?? "");
  const [family, setFamily] = useState(episode?.family ?? "");
  const [due, setDue] = useState(episode?.due_date ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave({ name_he: name.trim(), family: family.trim() || null, due_date: due || null });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{episode ? te("editEpisode") : te("addEpisode")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{te("name")}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} dir="rtl" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{te("family")}</span>
              <Input value={family} onChange={(e) => setFamily(e.target.value)} dir="rtl" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{te("due")}</span>
              <DatePicker className="h-9 w-auto px-2 py-1 text-sm" value={due} onChange={setDue} />
            </label>
          </div>
        </div>
        <DialogFooter className="mt-2 flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>{te("cancel")}</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>{te("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
