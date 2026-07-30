"use client";

/**
 * smrtStudio — one project, three tabs (stage A of docs/studio-build-plan.md):
 * voice (the linked smrtVoice projects), image and video (the project's
 * experiment_runs). Read-only in stage A — the creation form arrives in stage
 * B, the run button in stage C (behind the cost gate).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plus } from "lucide-react";

import { api } from "@/lib/api/client";
import { PaneLink } from "@/lib/panes/nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StudioCreateForm } from "@/components/smrtstudio/StudioCreateForm";

type Project = {
  id: string;
  name_he: string;
  name_en: string;
  description_he: string;
  status: string;
};

type VoiceProject = {
  id: string;
  name: string;
  status: string;
  total_lines: number;
  completed_lines: number;
  total_cost_usd: number | string;
};

type Run = {
  id: string;
  code: string;
  model: string;
  stage: string;
  cost_usd: number | string | null;
  qc_cost_usd: number | string | null;
  output_url: string | null;
  run_status: string | null;
  error: string | null;
  qc_status: string | null;
  qc_score: number | string | null;
  qc_reason: string | null;
  qc_scores: {
    vlm?: { verdict?: string } | null;
    vlm_error?: { error?: string } | null;
  } | null;
  overridden: boolean;
  meta: { thumb_url?: string | null } | null;
  created_at: string;
};

type Detail = {
  project: Project;
  voice_projects: VoiceProject[];
  image_runs: Run[];
  video_runs: Run[];
  vlm_qc_enabled: boolean;
};

/** Quiet entry point (house compact-UI rule): a small + button; the full
 *  creation form expands only on click and collapses back to nothing. */
function CreateToggle({
  kind, projectId, onSubmitted,
}: { kind: "image" | "video"; projectId: string; onSubmitted: () => void }) {
  const t = useTranslations("studioProjects");
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      {open ? (
        <StudioCreateForm
          kind={kind}
          projectId={projectId}
          onClose={() => setOpen(false)}
          onSubmitted={onSubmitted}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1"
          onClick={() => setOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("createTitle")}
        </Button>
      )}
    </div>
  );
}

/**
 * Stage E — the QC row of one run card. Three honest states, never a blank:
 * the run's own status while it isn't done ("בהרצה…" / "נכשל"), then the QC
 * verdict — including an explicit "טרם נבדק" when no check ever ran (there is
 * no auto-worker by decision). The VLM judge is paid, so the button expands
 * into an inline cost-ack first (rule 2); a rejected verdict always carries
 * its reason and a one-click human override (rule 13: filter, not arbiter).
 */
function QcCell({ run, vlmEnabled, onChanged }: { run: Run; vlmEnabled: boolean; onChanged: () => void }) {
  const t = useTranslations("studioProjects");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (run.run_status === "failed") {
    return <div className="text-red-600" title={run.error ?? undefined}>{t("runFailed")}</div>;
  }
  if (run.run_status === "pending" || run.run_status === "submitted") {
    return <div className="text-muted-foreground">{t("runInProgress")}</div>;
  }

  const judge = async () => {
    // Ref guard on top of `busy`: two clicks in the same frame both see
    // busy=false before React re-renders — the ref closes that window, so a
    // PAID check can never be fired twice from one card.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/studio/runs/${run.id}/qc-vlm`, {
        method: "POST",
        body: { cost_approved: true },
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setConfirming(false);
    }
  };

  const override = async (status: "pass" | "rejected") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/studio/runs/${run.id}/qc`, { method: "PATCH", body: { status } });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const score = run.qc_score == null ? null : Math.round(Number(run.qc_score) * 100);
  // The rubric's whole point is that borderline ≠ pass — it stays a distinct
  // amber state even though the status column can only say pass/rejected.
  const borderline = run.qc_scores?.vlm?.verdict === "borderline";
  const judgeable = vlmEnabled && Boolean(run.output_url);
  const lastError = run.qc_scores?.vlm_error?.error;

  return (
    <div className="space-y-1">
      {run.qc_status === "pass" ? (
        <div
          className={borderline && !run.overridden ? "text-amber-600" : "text-emerald-600"}
          title={run.qc_reason ?? undefined}
        >
          {borderline && !run.overridden ? t("qcBorderline") : t("qcPass")}
          {score != null && !run.overridden ? ` · ${score}%` : ""}
          {run.overridden ? ` · ${t("qcManual")}` : ""}
        </div>
      ) : run.qc_status === "rejected" ? (
        <div className="flex items-center gap-1.5">
          <span className="text-red-600" title={run.qc_reason ?? undefined}>
            {t("qcRejected")}
            {run.overridden ? ` · ${t("qcManual")}` : ""}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void override("pass")}
            className="text-primary underline disabled:opacity-50"
          >
            {t("qcOverridePass")}
          </button>
        </div>
      ) : confirming ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">{t("qcVlmConfirm")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void judge()}
              className="text-primary underline disabled:opacity-50"
            >
              {busy ? t("qcVlmRunning") : t("qcVlmGo")}
            </button>
            {!busy && (
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-muted-foreground underline"
              >
                {t("cancel")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{t("qcNotChecked")}</span>
          {lastError && (
            <span className="text-amber-600" title={lastError}>{t("qcVlmFailed")}</span>
          )}
          {judgeable && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-primary underline"
            >
              {t("qcRunVlm")}
            </button>
          )}
        </div>
      )}
      {err && <p className="text-red-600 break-words">{err}</p>}
    </div>
  );
}

function RunGrid({ runs, empty, vlmEnabled, onChanged }: {
  runs: Run[]; empty: string; vlmEnabled: boolean; onChanged: () => void;
}) {
  const t = useTranslations("studioProjects");
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{empty}</p>;
  }
  return (
    <ul className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4">
      {runs.map((r) => {
        const thumb = r.meta?.thumb_url || (r.stage === "image" ? r.output_url : null);
        return (
          <li key={r.id} className="rounded-lg border overflow-hidden">
            <a href={r.output_url ?? undefined} target="_blank" rel="noreferrer" className="block">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt={r.code} className="aspect-video w-full object-cover bg-muted" loading="lazy" />
              ) : (
                <div className="aspect-video w-full bg-muted flex items-center justify-center text-xs text-muted-foreground">
                  {r.stage}
                </div>
              )}
            </a>
            <div className="p-2 text-xs space-y-0.5">
              <div className="font-mono">{r.code}</div>
              <div className="truncate text-muted-foreground" title={r.model}>{r.model}</div>
              <div className="text-muted-foreground">
                {r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(3)}` : t("costPending")}
                {Number(r.qc_cost_usd) > 0 &&
                  ` ${t("qcCostSuffix", { usd: `$${Number(r.qc_cost_usd).toFixed(3)}` })}`}
              </div>
              <QcCell run={r} vlmEnabled={vlmEnabled} onChanged={onChanged} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function StudioProject({ projectId }: { projectId: string }) {
  const t = useTranslations("studioProjects");
  const locale = useLocale();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Detail>(`/api/studio/projects/${projectId}`);
      setDetail(data);
      // A stale error from a failed refetch must not shadow a screen that
      // just loaded fine.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (!detail) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { project, voice_projects, image_runs, video_runs } = detail;
  const name = locale === "en" && project.name_en ? project.name_en : project.name_he;
  // Real recorded money, split by engine — fal (image+video runs) vs the
  // voice engine (Resemble) — because they bill on different accounts.
  const falUsd = [...image_runs, ...video_runs]
    .reduce((sum, r) =>
      sum + (r.cost_usd == null ? 0 : Number(r.cost_usd) || 0)
          + (r.qc_cost_usd == null ? 0 : Number(r.qc_cost_usd) || 0), 0);
  const voiceUsd = voice_projects
    .reduce((sum, v) => sum + (Number(v.total_cost_usd) || 0), 0);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">{name}</h1>
        <span className="text-xs text-muted-foreground">
          {t("projectCost", { fal: `$${falUsd.toFixed(2)}`, voice: `$${voiceUsd.toFixed(2)}` })}
        </span>
      </div>

      <Tabs defaultValue="voice">
        <TabsList>
          <TabsTrigger value="voice">{t("tabVoice")} ({voice_projects.length})</TabsTrigger>
          <TabsTrigger value="image">{t("tabImage")} ({image_runs.length})</TabsTrigger>
          <TabsTrigger value="video">{t("tabVideo")} ({video_runs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="voice">
          {voice_projects.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("voiceEmpty")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {voice_projects.map((v) => (
                <li key={v.id}>
                  <PaneLink
                    href={`/${locale}/voice/projects/${v.id}`}
                    className="flex items-center justify-between gap-3 p-3 hover:bg-accent/50 transition-colors"
                  >
                    <span className="truncate font-medium">{v.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {v.completed_lines}/{v.total_lines} · ${Number(v.total_cost_usd).toFixed(2)} · {v.status}
                    </span>
                  </PaneLink>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="image">
          <CreateToggle kind="image" projectId={projectId} onSubmitted={() => void load()} />
          <RunGrid
            runs={image_runs}
            empty={t("imageEmpty")}
            vlmEnabled={detail.vlm_qc_enabled}
            onChanged={() => void load()}
          />
        </TabsContent>

        <TabsContent value="video">
          <CreateToggle kind="video" projectId={projectId} onSubmitted={() => void load()} />
          <RunGrid
            runs={video_runs}
            empty={t("videoEmpty")}
            vlmEnabled={detail.vlm_qc_enabled}
            onChanged={() => void load()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
