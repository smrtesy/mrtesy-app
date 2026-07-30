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

import { api, ApiError } from "@/lib/api/client";
import { PaneLink } from "@/lib/panes/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type ConsultSolution = {
  title?: string;
  changes?: Record<string, unknown> | null;
  evidence?: string;
  est_cost?: string;
  risk?: string;
  move?: string;
};

type Consultation = {
  id: string;
  run_id: string;
  run_code: string | null;
  status: string;
  problem: string;
  answer: {
    diagnosis?: string;
    solutions?: ConsultSolution[];
    rejected?: { title?: string; reason?: string }[];
  } | null;
  executed_run_ids: string[];
  created_at: string;
  answered_at: string | null;
};

type ConsultEstimate = {
  items: { index: number; title: string; endpoint_id: string; usd: number | null; basis: string }[];
  total_usd: number | null;
  unestimated: number;
};

type Detail = {
  project: Project;
  voice_projects: VoiceProject[];
  image_runs: Run[];
  video_runs: Run[];
  consultations: Consultation[];
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

/**
 * Stage F — "יש לי בעיה" on one artifact. Compact by the house rule: a quiet
 * link that expands into a one-line problem box; submitting files a
 * consultation (full provenance frozen server-side) + a smrtTask pickup task.
 */
function ConsultButton({ run, onFiled }: { run: Run; onFiled: () => void }) {
  const t = useTranslations("studioProjects");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filed, setFiled] = useState(false);
  const inFlight = useRef(false);

  // A failed run is exactly what "יש לי בעיה" exists for — the button hides
  // only while nothing has happened yet (still running / no result at all).
  if (!run.output_url && run.run_status !== "failed") return null;
  if (filed) return <div className="text-emerald-600">{t("consultFiled")}</div>;

  const send = async () => {
    const problem = text.trim();
    if (!problem || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/studio/runs/${run.id}/consult`, { method: "POST", body: { problem } });
      setFiled(true);
      setOpen(false);
      onFiled();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      {open ? (
        <div className="space-y-1">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("consultPlaceholder")}
            rows={2}
            className="w-full rounded border bg-background p-1.5 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void send()}
              className="text-primary underline disabled:opacity-50"
            >
              {busy ? t("consultSending") : t("consultSend")}
            </button>
            {!busy && (
              <button
                type="button"
                onClick={() => { setOpen(false); setText(""); }}
                className="text-muted-foreground underline"
              >
                {t("cancel")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-muted-foreground underline hover:text-foreground"
        >
          {t("consultButton")}
        </button>
      )}
      {err && <p className="text-red-600 break-words">{err}</p>}
    </div>
  );
}

/**
 * Stage F — one answered consultation: diagnosis, then the solutions as
 * CHECKBOXES → the first "אשר והרץ" click fetches the 402 estimate (nothing
 * is spent), shows per-solution + total, and only the explicit second click
 * echoes the displayed total and runs. The exact UX the user defined.
 */
function ConsultationCard({ c, onChanged }: { c: Consultation; onChanged: () => void }) {
  const t = useTranslations("studioProjects");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [estimate, setEstimate] = useState<ConsultEstimate | null>(null);
  // The selection the estimate was computed FOR — the approval echoes exactly
  // this, so a checkbox changed after the estimate can never ride an old ack.
  const [estimateFor, setEstimateFor] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);

  // A re-answer replaces the solutions array — index N now means something
  // else, so the selection and any on-screen estimate are void.
  useEffect(() => {
    setChecked(new Set());
    setEstimate(null);
    setEstimateFor([]);
  }, [c.answered_at]);

  const solutions = c.answer?.solutions ?? [];
  const statusKey =
    c.status === "open" ? "consultOpen"
    : c.status === "answered" ? "consultAnswered"
    : c.status === "executed" ? "consultExecuted" : "consultClosed";

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    // A changed selection invalidates the estimate on screen — the approval
    // is FOR a number, and the number just changed.
    setEstimate(null);
  };

  const execute = async (approve: boolean) => {
    if (inFlight.current || checked.size === 0) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    // The approval runs EXACTLY what was estimated, not the live checkboxes.
    const selection = approve ? estimateFor : [...checked].sort((a, b) => a - b);
    try {
      const resp = await api<{ results: { index: number; code?: string; error?: string }[] }>(
        `/api/studio/consultations/${c.id}/execute`,
        {
          method: "POST",
          body: approve
            ? {
                selected: selection,
                approved_selection: selection,
                cost_approved: true,
                approved_usd: estimate?.total_usd ?? null,
                accept_unestimated: true,
              }
            : { selected: selection },
        },
      );
      // Spent state must not survive a success — a second click on a stale
      // "אשר והרץ" would pay again.
      setChecked(new Set());
      setEstimate(null);
      setEstimateFor([]);
      const failed = (resp.results ?? []).filter((r) => r.error);
      if (failed.length) {
        setErr(`${t("consultPartialFail")}: ${failed.map((f) => f.error).join(" · ")}`);
      }
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        const est = (e.body as { estimate?: ConsultEstimate } | undefined)?.estimate;
        if (est) {
          setEstimate(est);
          setEstimateFor(selection);
        } else setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border p-3 text-xs space-y-2">
      <div className="flex items-center gap-2">
        {c.run_code && <span className="font-mono">{c.run_code}</span>}
        <span className="text-muted-foreground">{t(statusKey)}</span>
      </div>
      <p className="whitespace-pre-wrap">{c.problem}</p>

      {c.answer?.diagnosis && (
        <p className="whitespace-pre-wrap border-s-2 ps-2 text-muted-foreground">
          {c.answer.diagnosis}
        </p>
      )}

      {solutions.length > 0 && (
        <div className="space-y-1.5">
          {solutions.map((s, i) => (
            <label key={i} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={checked.has(i)}
                onChange={() => toggle(i)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{s.title ?? `${i + 1}`}</span>
                {s.risk && <span className="text-muted-foreground"> · {t("consultRisk")}: {s.risk}</span>}
                {s.est_cost && <span className="text-muted-foreground"> · {s.est_cost}</span>}
                {s.evidence && (
                  <span className="block text-muted-foreground">{s.evidence}</span>
                )}
              </span>
            </label>
          ))}

          {estimate && (
            <div className="rounded border bg-muted/40 p-2 space-y-0.5">
              {estimate.items.map((it) => (
                <p key={it.index} className="flex justify-between gap-2">
                  <span className="truncate">{it.title}</span>
                  <span className="shrink-0">{it.usd != null ? `$${it.usd.toFixed(3)}` : t("consultNoEstimate")}</span>
                </p>
              ))}
              <p className="flex justify-between gap-2 font-medium border-t pt-0.5">
                <span>{t("consultEstimateTotal")}</span>
                <span>
                  {estimate.total_usd != null ? `$${estimate.total_usd.toFixed(3)}` : t("consultNoEstimate")}
                  {estimate.unestimated > 0 ? ` (+${estimate.unestimated} ${t("consultNoEstimate")})` : ""}
                </span>
              </p>
            </div>
          )}

          <div className="flex gap-2">
            {estimate ? (
              <button
                type="button"
                disabled={busy || checked.size === 0}
                onClick={() => void execute(true)}
                className="text-primary underline disabled:opacity-50"
              >
                {busy ? t("consultRunning") : t("consultApproveRun")}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || checked.size === 0}
                onClick={() => void execute(false)}
                className="text-primary underline disabled:opacity-50"
              >
                {busy ? t("consultRunning") : t("consultEstimateBtn")}
              </button>
            )}
          </div>
        </div>
      )}

      {(c.answer?.rejected?.length ?? 0) > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">{t("consultRejected")}</summary>
          <ul className="ms-3 mt-1 space-y-0.5 text-muted-foreground">
            {c.answer!.rejected!.map((r, i) => (
              <li key={i}>{r.title}{r.reason ? ` — ${r.reason}` : ""}</li>
            ))}
          </ul>
        </details>
      )}

      {err && <p className="text-red-600 break-words">{err}</p>}
    </li>
  );
}

/**
 * Stage G0 — start voice work FROM the studio: a quiet + button that expands
 * into a name input and creates a smrtVoice project already linked to this
 * studio project. The full voice pipeline continues in the existing screens.
 */
function VoiceCreateToggle({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const t = useTranslations("studioProjects");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  // Required in practice: script creation hard-rejects a project without a
  // code prefix (voice routes) — omitting it here would mint dead-end
  // projects that only the old smrtVoice form could have configured.
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);

  const prefixOk = /^[A-Za-z]{1,3}$/.test(prefix.trim());

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || !prefixOk || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/studio/projects/${projectId}/voice-projects`, {
        method: "POST",
        body: { name: trimmed, code_prefix: prefix.trim().toUpperCase() },
      });
      setName("");
      setPrefix("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      {open ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") { setOpen(false); setName(""); }
            }}
            placeholder={t("voiceCreatePlaceholder")}
            className="h-8 w-56"
          />
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") { setOpen(false); setName(""); setPrefix(""); }
            }}
            placeholder={t("voiceCreatePrefixPlaceholder")}
            title={t("voiceCreatePrefixHint")}
            maxLength={3}
            className="h-8 w-20"
          />
          <Button size="sm" onClick={() => void create()} disabled={busy || !name.trim() || !prefixOk}>
            {t("create")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setOpen(false); setName(""); setPrefix(""); }}
          >
            {t("cancel")}
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t("voiceCreate")}
        </Button>
      )}
      {err && <p className="mt-1 text-xs text-red-600 break-words">{err}</p>}
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
              <ConsultButton run={r} onFiled={onChanged} />
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
          <VoiceCreateToggle projectId={projectId} onCreated={() => void load()} />
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

      {detail.consultations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t("consultTitle")}</h2>
          <ul className="space-y-2">
            {detail.consultations.map((c) => (
              <ConsultationCard key={c.id} c={c} onChanged={() => void load()} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
