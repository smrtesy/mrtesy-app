"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronRight, Trash2, Loader2, Check, Circle, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { ProjectStatusBadge } from "./ProjectStatusBadge";
import { ScriptCasting } from "./ScriptCasting";
import { AudioLineList } from "./AudioLineList";
import { RecordingUploader } from "./RecordingUploader";

interface Script {
  id: string;
  project_id: string;
  code: string;
  name: string | null;
  status: string;
  language: "he" | "en";
  google_doc_url: string | null;
  google_doc_id: string | null;
  google_doc_tab_title: string | null;
  generation_mode: "sts" | "tts";
  input_recording_path: string | null;
  total_lines: number;
  completed_lines: number;
  failed_lines: number;
  total_cost_usd: number;
  stage: string | null;
  stage_current: number;
  stage_total: number;
}

// The generation pipeline, in order. The worker writes `stage` on the script
// row as it advances, so the UI can show exactly where a run is.
const STAGE_ORDER = ["fetching", "parsing", "preprocessing", "generating"] as const;

// Each pipeline stage owns a non-overlapping band of the 0–100% progress bar, so
// the bar reflects progress across the WHOLE run instead of resetting per stage.
// Reaching a stage sets the bar to that stage's floor; within the stage it fills
// by the stage's own current/total. Generating (the real synthesis) owns the
// largest band. Bands are ordered, so the bar only ever climbs.
const STAGE_BANDS: Record<string, [number, number]> = {
  fetching: [0, 4],
  parsing: [4, 8],
  preprocessing: [8, 35],
  generating: [35, 100],
};

export function ScriptOverview({ scriptId }: { scriptId: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("smrtVoice.scripts");

  const [script, setScript] = useState<Script | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Opt-in: apply each character's style baseline (slow/soft/…) on top of the
  // per-line emotion tags. Off by default — deep tag stacks destabilize the
  // TTS engine (spurious words / line restarts).
  const [applyBaseline, setApplyBaseline] = useState(false);
  // Self-heal a script left stuck in queued/processing by a dropped completion
  // webhook: poll the engine once per mount. The endpoint is a no-op if the
  // job is genuinely still running.
  const syncTriedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { script } = await api<{ script: Script }>(`/api/voice/scripts/${scriptId}`);
      setScript(script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [scriptId]);

  useEffect(() => {
    refresh();
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtvoice_script_${scriptId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "smrtvoice_scripts", filter: `id=eq.${scriptId}` },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refresh, scriptId]);

  useEffect(() => {
    if (syncTriedRef.current || !script) return;
    if (script.status !== "queued" && script.status !== "processing") return;
    syncTriedRef.current = true;
    (async () => {
      try {
        const { reconciled } = await api<{ reconciled: boolean }>(
          `/api/voice/scripts/${scriptId}/sync`,
          { method: "POST" },
        );
        if (reconciled) refresh();
      } catch {
        /* best-effort self-heal; realtime remains the primary path */
      }
    })();
  }, [script, scriptId, refresh]);

  async function onParse() {
    setBusy(true);
    try {
      await api(`/api/voice/scripts/${scriptId}/parse`, { method: "POST" });
      await refresh();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    setBusy(true);
    try {
      await api(`/api/voice/scripts/${scriptId}/generate`, {
        method: "POST",
        body: { apply_style_baseline: applyBaseline },
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    setStopping(true);
    try {
      await api(`/api/voice/scripts/${scriptId}/cancel`, { method: "POST" });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStopping(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    try {
      const projectId = script?.project_id;
      await api(`/api/voice/scripts/${scriptId}`, { method: "DELETE" });
      toast.success(t("deleted"));
      router.push(`/${locale}/voice/projects/${projectId ?? ""}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
      setBusy(false);
    }
  }

  async function onLanguageChange(language: "he" | "en") {
    if (!script || language === script.language) return;
    // Optimistic: reflect immediately, roll back on failure.
    const prev = script.language;
    setScript({ ...script, language });
    try {
      await api(`/api/voice/scripts/${scriptId}`, { method: "PATCH", body: { language } });
    } catch (err) {
      setScript((s) => (s ? { ...s, language: prev } : s));
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!script) return <p className="text-sm text-muted-foreground">…</p>;

  const parsed = script.status !== "draft";
  const generating = script.status === "queued" || script.status === "processing";

  return (
    <div className="space-y-6">
      {/* Breadcrumb + header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href={`/${locale}/voice/projects/${script.project_id}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            <ChevronRight className="h-3 w-3 rotate-180" />
            {t("backToFolder")}
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="font-mono">{script.code}</span>
            {script.name ? <span className="text-muted-foreground">· {script.name}</span> : null}
          </h1>
          {script.google_doc_tab_title ? (
            <p className="text-xs text-muted-foreground">
              {t("readingFromTab", { tab: script.google_doc_tab_title })}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* Script language — gates which pronunciation-lexicon entries apply
              (a 'he' entry fires only on Hebrew scripts, 'en' only on English). */}
          <select
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={script.language}
            onChange={(e) => onLanguageChange(e.target.value as "he" | "en")}
            disabled={busy || generating}
            title={t("languageHint")}
            aria-label={t("languageLabel")}
          >
            <option value="he">{t("languageHe")}</option>
            <option value="en">{t("languageEn")}</option>
          </select>
          <ProjectStatusBadge status={script.status} />
          <Button variant="ghost" size="icon" onClick={onDelete} disabled={busy} title={t("delete")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("stats")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label={t("lines")} value={`${script.completed_lines}/${script.total_lines}`} />
          <Stat label={t("failed")} value={String(script.failed_lines)} />
          <Stat label={t("cost")} value={`$${(script.total_cost_usd ?? 0).toFixed(2)}`} />
          <Stat label={t("mode")} value={script.generation_mode.toUpperCase()} />
        </CardContent>
      </Card>

      {/* Generation progress — live via the script realtime subscription.
          The worker writes stage + counts directly to the script row, so this
          reflects the real phase (fetch → parse → preprocess → generate) even
          when webhooks aren't reaching us. */}
      {generating && <GenerationProgress script={script} t={t} />}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onParse} disabled={busy || generating} variant="secondary">
          {busy ? t("parsing") : t("parse")}
        </Button>
        <Button onClick={onGenerate} disabled={busy || !parsed || generating}>
          {generating ? (
            <>
              <Loader2 className="h-4 w-4 me-1 animate-spin" />
              {t("generating")}
            </>
          ) : (
            t("generate")
          )}
        </Button>
        {generating && (
          <Button variant="destructive" onClick={onStop} disabled={stopping}>
            {stopping ? (
              <>
                <Loader2 className="h-4 w-4 me-1 animate-spin" />
                {t("stopping")}
              </>
            ) : (
              <>
                <Square className="h-4 w-4 me-1" />
                {t("stop")}
              </>
            )}
          </Button>
        )}
        {script.google_doc_url && (
          <a href={script.google_doc_url} target="_blank" rel="noreferrer" className="ms-auto">
            <Button variant="ghost">{t("openDoc")}</Button>
          </a>
        )}
      </div>

      {/* Opt-in: apply the character style baseline. Off by default — deep tag
          stacks destabilize the TTS engine (spurious words / line restarts). */}
      {parsed && (
        <label
          className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none"
          title={t("useBaselineHint")}
        >
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={applyBaseline}
            onChange={(e) => setApplyBaseline(e.target.checked)}
            disabled={busy || generating}
          />
          {t("useBaseline")}
        </label>
      )}

      {/* STS input recording */}
      {script.generation_mode === "sts" && (
        <RecordingUploader scriptId={scriptId} existingPath={script.input_recording_path} />
      )}

      {/* Casting — only meaningful once parsed */}
      {parsed ? (
        <ScriptCasting scriptId={scriptId} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("parseFirst")}</p>
      )}

      {/* Generated audio */}
      <AudioLineList scriptId={scriptId} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function GenerationProgress({
  script,
  t,
}: {
  script: Script;
  t: ReturnType<typeof useTranslations>;
}) {
  // A redo (regenerate a few lines) doesn't fetch/parse/preprocess, so it gets
  // its own single-line indicator rather than the full pipeline stepper.
  const isRegen = script.stage === "regenerating";
  // Before the worker picks the job up (or between webhook-less state changes)
  // the stage is null — treat that as "queued".
  const queued = !isRegen && (script.status === "queued" || !script.stage);
  const activeIndex = script.stage
    ? STAGE_ORDER.indexOf(script.stage as (typeof STAGE_ORDER)[number])
    : -1;
  const hasCounts = script.stage_total > 0;

  // The bar reflects progress across the WHOLE run, not just the current stage.
  // `stage_current/stage_total` is stage-local, so the near-instant fetch/parse
  // stages (1-of-1) used to slam the bar to full before any audio existed, then
  // it snapped back each time the next stage reset the denominator. STAGE_BANDS
  // (module scope) maps each stage to its slice of the bar; within its band the
  // bar fills by the stage's own current/total, so the bar only ever climbs.
  const stageFrac = hasCounts
    ? Math.min(1, script.stage_current / script.stage_total)
    : 0;
  let pct: number | null;
  if (queued) {
    // No work started yet → indeterminate pulse (pct === null).
    pct = null;
  } else if (isRegen) {
    // A redo has no pipeline; show its own line count directly, 0–100%.
    pct = hasCounts
      ? Math.min(100, Math.round((script.stage_current / script.stage_total) * 100))
      : null;
  } else if (!hasCounts) {
    // Pre-count stages (fetching/parsing report no total) → indeterminate
    // pulse, so the bar reads as "working" rather than frozen near 0%. The
    // determinate band bar takes over once a stage has something to measure.
    pct = null;
  } else {
    const band = script.stage ? STAGE_BANDS[script.stage] : undefined;
    pct = band ? Math.round(band[0] + (band[1] - band[0]) * stageFrac) : null;
  }

  return (
    <div className="rounded-md border p-3 space-y-3">
      {/* Stepper — full pipeline only (a redo shows just the line + bar below) */}
      {!isRegen && (
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {STAGE_ORDER.map((s, i) => {
          const state = queued
            ? "pending"
            : i < activeIndex
              ? "done"
              : i === activeIndex
                ? "active"
                : "pending";
          return (
            <li key={s} className="flex items-center gap-1.5">
              {state === "done" ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : state === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
              )}
              <span
                className={
                  state === "active"
                    ? "font-medium text-foreground"
                    : state === "done"
                      ? "text-foreground"
                      : "text-muted-foreground"
                }
              >
                {t(`stages.${s}`)}
              </span>
            </li>
          );
        })}
      </ol>
      )}

      {/* Current line + count */}
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        {queued ? (
          <span className="font-medium">{t("queuedBanner")}</span>
        ) : (
          <>
            <span className="font-medium">{t(`stages.${script.stage}`)}</span>
            {hasCounts && (
              <span className="text-muted-foreground">
                {script.stage_current}/{script.stage_total}
              </span>
            )}
          </>
        )}
      </div>

      {/* Bar — determinate when we have counts, indeterminate otherwise */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-primary transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
