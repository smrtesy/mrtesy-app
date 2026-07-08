"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronRight, Trash2, Loader2, Check, Circle } from "lucide-react";

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
  google_doc_url: string | null;
  google_doc_id: string | null;
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

export function ScriptOverview({ scriptId }: { scriptId: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("smrtVoice.scripts");

  const [script, setScript] = useState<Script | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      await api(`/api/voice/scripts/${scriptId}/generate`, { method: "POST" });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
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
        </div>
        <div className="flex items-center gap-2">
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
        {script.google_doc_url && (
          <a href={script.google_doc_url} target="_blank" rel="noreferrer" className="ms-auto">
            <Button variant="ghost">{t("openDoc")}</Button>
          </a>
        )}
      </div>

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
  const pct = hasCounts
    ? Math.min(100, Math.round((script.stage_current / script.stage_total) * 100))
    : null;

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
