"use client";

/**
 * smrtStudio — one project, three tabs (stage A of docs/studio-build-plan.md):
 * voice (the linked smrtVoice projects), image and video (the project's
 * experiment_runs). Read-only in stage A — the creation form arrives in stage
 * B, the run button in stage C (behind the cost gate).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, ExternalLink, Plus, Zap } from "lucide-react";

import { api, ApiError } from "@/lib/api/client";
import { PaneLink } from "@/lib/panes/nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StudioCreateForm } from "@/components/smrtstudio/StudioCreateForm";
import { AudioLineList } from "@/components/smrtvoice/AudioLineList";
import { CreateScriptForm } from "@/components/smrtvoice/CreateScriptForm";
import { ScriptOverview } from "@/components/smrtvoice/ScriptOverview";

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
  code_prefix: string | null;
  status: string;
  total_lines: number;
  completed_lines: number;
  total_cost_usd: number | string;
};

// One script inside a voice project (folder). Same shape ProjectOverview uses
// (src/components/smrtvoice/ProjectOverview.tsx) so the unified takes view can
// list scripts and open each one's AudioLineList inline.
type ScriptRow = {
  id: string;
  seq: number;
  code: string;
  name: string | null;
  status: string;
  total_lines: number;
  completed_lines: number;
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
type Voice = { uuid: string; name?: string; display_name?: string | null };

/**
 * Stage 1 (docs/studio-quick-line-plan.md) — the fast path to a single voice
 * line, right in the main voice tab: pick/create a project, pick a voice from
 * your list, pick a model (default), type text, Run. No Google Doc, no visible
 * "script". Posts to /voice/quick-line and shows the produced take with the
 * standard AudioLineList tools (play / star / download / regenerate).
 */
function QuickVoiceLine({
  voiceProjectId,
  onCreated,
}: {
  // The voice container this quick line belongs to (one of the studio
  // project's containers, passed down by VoiceContainer).
  voiceProjectId: string;
  onCreated: () => void;
}) {
  const t = useTranslations("studioProjects");
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesErr, setVoicesErr] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resultScriptId, setResultScriptId] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ voices: Voice[] }>("/api/voice/resemble/voices");
        if (cancelled) return;
        setVoices(data.voices ?? []);
        setVoiceId((prev) => prev || data.voices?.[0]?.uuid || "");
      } catch (e) {
        if (!cancelled) setVoicesErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canRun = !!voiceId && !!text.trim() && !submitting;

  const run = async () => {
    if (inFlight.current || !canRun) return;
    inFlight.current = true;
    setSubmitting(true);
    setErr(null);
    setResultScriptId(null);
    try {
      const voice = voices?.find((v) => v.uuid === voiceId);
      const voiceLabel = voice?.display_name || voice?.name || "";
      const res = await api<{ script_id: string }>("/api/voice/quick-line", {
        method: "POST",
        body: { project_id: voiceProjectId, voice_id: voiceId, voice_label: voiceLabel, model, text: text.trim() },
      });
      setResultScriptId(res.script_id);
      setText("");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Zap className="h-4 w-4" /> {t("quickLineTitle")}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          aria-label={t("quickLineVoice")}
          disabled={!voices}
        >
          {!voices && <option value="">…</option>}
          {(voices ?? []).map((v) => (
            <option key={v.uuid} value={v.uuid}>
              {v.display_name || v.name || v.uuid}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label={t("quickLineModel")}
        >
          <option value="">{t("quickLineModelDefault")}</option>
          <option value="resemble-ultra">resemble-ultra</option>
          <option value="chatterbox">chatterbox</option>
          <option value="chatterbox-turbo">chatterbox-turbo</option>
        </select>
      </div>
      <textarea
        className="w-full rounded-md border bg-background px-2 py-1 text-sm"
        rows={2}
        placeholder={t("quickLineTextPlaceholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {voicesErr && <p className="text-xs text-destructive">{voicesErr}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void run()} disabled={!canRun}>
          {submitting ? t("quickLineRunning") : t("quickLineRun")}
        </Button>
      </div>
      {resultScriptId && (
        <div className="pt-2">
          <AudioLineList scriptId={resultScriptId} />
        </div>
      )}
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

/**
 * One voice container (folder) inside a studio project: its quick-line +
 * Doc→parse creation forms and its scripts, each opening its AudioLineList
 * inline. Casting/generation for Doc scripts still opens the full voice screen.
 */
function VoiceContainer({ container, onChanged }: {
  container: { id: string; name: string; code_prefix: string | null };
  onChanged: () => void;
}) {
  const t = useTranslations("studioProjects");
  const locale = useLocale();
  const [scripts, setScripts] = useState<ScriptRow[] | null>(null);
  const [scriptsErr, setScriptsErr] = useState<string | null>(null);
  const [openScriptId, setOpenScriptId] = useState<string | null>(null);

  const loadScripts = useCallback(async () => {
    setScriptsErr(null);
    try {
      const { scripts: rows } = await api<{ scripts: ScriptRow[] }>(`/api/voice/projects/${container.id}/scripts`);
      setScripts(rows ?? []);
    } catch (e) {
      setScriptsErr(e instanceof Error ? e.message : String(e));
    }
  }, [container.id]);

  useEffect(() => { void loadScripts(); }, [loadScripts]);

  const nextSeq = (scripts ?? []).reduce((max, s) => Math.max(max, s.seq), 0) + 1;
  const nextCode = `${container.code_prefix ?? ""}${nextSeq}`;
  const refresh = () => { void loadScripts(); onChanged(); };

  return (
    <div className="space-y-3">
      {/* Full production hub for this project — connect a script (Doc→parse),
          voice casting, generation. The embedded tab is the fast path; the
          full screen holds the complete production workflow. */}
      <PaneLink
        href={`/${locale}/voice/projects/${container.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t("voiceOpenFullProject")}
      </PaneLink>

      <QuickVoiceLine voiceProjectId={container.id} onCreated={refresh} />

      {/* Doc→parse. Gated on loaded scripts so nextCode reflects the real prefix. */}
      {scripts !== null && (
        <CreateScriptForm projectId={container.id} nextCode={nextCode} onCreated={refresh} />
      )}

      {scriptsErr && <p className="text-xs text-destructive">{scriptsErr}</p>}
      {scripts === null && !scriptsErr && <p className="text-xs text-muted-foreground">…</p>}
      {scripts !== null && scripts.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">{t("voiceScriptsEmpty")}</p>
      )}

      {(scripts ?? []).map((s) => {
        const label = s.name === "__quick__" ? t("quickScriptLabel") : (s.name || s.code);
        const isOpen = openScriptId === s.id;
        return (
          <div key={s.id} className="rounded-md border">
            <div className="flex items-center justify-between gap-3 p-2">
              <button
                type="button"
                onClick={() => setOpenScriptId(isOpen ? null : s.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-start text-sm"
                aria-expanded={isOpen}
              >
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                <span className="font-mono text-xs">{s.code}</span>
                <span className="truncate">{label}</span>
              </button>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span>{s.completed_lines}/{s.total_lines} · {s.status}</span>
                <PaneLink href={`/${locale}/voice/scripts/${s.id}`} className="underline hover:text-foreground">
                  {t("voiceScriptOpenFull")}
                </PaneLink>
              </span>
            </div>
            {isOpen && (
              <div className="border-t p-3">
                {/* Breadcrumb: where you are (container › script), and one
                    click back to the script list — the hierarchy anchor the
                    embedded surface otherwise lacks when deep in a script. */}
                <div className="mb-3 flex items-center gap-1 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setOpenScriptId(null)}
                    className="hover:text-foreground hover:underline"
                  >
                    {container.name}
                  </button>
                  <ChevronRight className="h-3 w-3" />
                  <span className="font-mono text-foreground">{s.code}</span>
                </div>
                {/* The full production surface for the script, inline: model +
                    LLM-emotion selects (auto = the per-model system default),
                    parse, generate/stop, casting, and the takes — the same
                    ScriptOverview the standalone screen renders, header hidden. */}
                <ScriptOverview scriptId={s.id} embedded />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The voice tab of a studio project. A studio project may hold MORE THAN ONE
 * voice container (legacy projects grouped their work into separate folders —
 * e.g. Hebrew vs English). Show ALL of the project's containers, each with its
 * scripts, so nothing is hidden. When a project has no container yet, ensure
 * the single hidden default (POST .../voice-project) and reload. Container
 * headers appear only when there are 2+ — a fresh single-container project
 * still reads as "the project is the only unit" (docs/studio-hierarchy-plan.md).
 */
function VoiceTab({ containers, studioProjectId, onChanged }: {
  containers: VoiceProject[];
  studioProjectId: string;
  onChanged: () => void;
}) {
  const t = useTranslations("studioProjects");
  const locale = useLocale();
  const [ensureErr, setEnsureErr] = useState<string | null>(null);
  // Fire the ensure-POST at most once per mount. Without this, `onChanged`'s
  // changing identity (an inline arrow in the parent) re-runs the effect while
  // the first POST is still in flight, and since there is no unique index on
  // (org_id, studio_project_id) two POSTs race into two hidden containers
  // (StrictMode reproduces this on mount). The ref makes it idempotent.
  const ensured = useRef(false);

  // Only ensure a default container when the project truly has none yet.
  useEffect(() => {
    if (containers.length > 0 || ensured.current) return;
    ensured.current = true;
    let cancelled = false;
    (async () => {
      try {
        await api(`/api/studio/projects/${studioProjectId}/voice-project`, { method: "POST" });
        if (!cancelled) onChanged();
      } catch (e) {
        if (!cancelled) { ensured.current = false; setEnsureErr(e instanceof Error ? e.message : String(e)); }
      }
    })();
    return () => { cancelled = true; };
  }, [containers.length, studioProjectId, onChanged]);

  if (ensureErr) return <p className="text-sm text-destructive">{ensureErr}</p>;
  if (containers.length === 0) return <p className="text-sm text-muted-foreground py-4">…</p>;

  const showHeaders = containers.length > 1;

  // Voice-wide tools that used to live in the standalone voice nav (dropped
  // when the tab was embedded): general settings, the voice library, the
  // character list, insights. Each screen still lives at its deep URL.
  const tools: { href: string; label: string }[] = [
    { href: `/${locale}/settings/apps/smrtstudio`, label: t("voiceToolsSettings") },
    { href: `/${locale}/voice/library`, label: t("voiceToolsLibrary") },
    { href: `/${locale}/voice/characters`, label: t("voiceToolsCharacters") },
    { href: `/${locale}/voice/insights`, label: t("voiceToolsInsights") },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {tools.map((tool) => (
          <PaneLink key={tool.href} href={tool.href} className="text-muted-foreground hover:text-foreground hover:underline">
            {tool.label}
          </PaneLink>
        ))}
      </div>

      {containers.map((c) => (
        <div key={c.id} className={showHeaders ? "space-y-2" : ""}>
          {showHeaders && (
            <h3 className="text-sm font-semibold text-muted-foreground">{c.name}</h3>
          )}
          <VoiceContainer
            container={{ id: c.id, name: c.name, code_prefix: c.code_prefix }}
            onChanged={onChanged}
          />
        </div>
      ))}
    </div>
  );
}

export function StudioProject({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
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
  // Voice-tab count = takes across the project's voice container(s), since the
  // container itself is hidden — the number of voice lines is what's meaningful.
  const voiceTakes = voice_projects.reduce((sum, v) => sum + (Number(v.total_lines) || 0), 0);

  return (
    <div className={embedded ? "space-y-4" : "mx-auto w-full max-w-5xl p-4 space-y-4"}>
      {/* When embedded in the production surface, the project selector already
          names the project + shows the balance, so the standalone header is
          suppressed to avoid a duplicate title. */}
      {!embedded && (
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">{name}</h1>
          <span className="text-xs text-muted-foreground">
            {t("projectCost", { fal: `$${falUsd.toFixed(2)}`, voice: `$${voiceUsd.toFixed(2)}` })}
          </span>
        </div>
      )}

      <Tabs defaultValue="voice">
        <TabsList>
          <TabsTrigger value="voice">{t("tabVoice")} ({voiceTakes})</TabsTrigger>
          <TabsTrigger value="image">{t("tabImage")} ({image_runs.length})</TabsTrigger>
          <TabsTrigger value="video">{t("tabVideo")} ({video_runs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="voice">
          <VoiceTab
            containers={voice_projects}
            studioProjectId={projectId}
            onChanged={() => void load()}
          />
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
