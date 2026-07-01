"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronRight, Trash2 } from "lucide-react";

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
}

export function ScriptOverview({ scriptId }: { scriptId: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("smrtVoice.scripts");

  const [script, setScript] = useState<Script | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onParse} disabled={busy} variant="secondary">
          {busy ? t("parsing") : t("parse")}
        </Button>
        <Button onClick={onGenerate} disabled={busy || !parsed}>
          {t("generate")}
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
