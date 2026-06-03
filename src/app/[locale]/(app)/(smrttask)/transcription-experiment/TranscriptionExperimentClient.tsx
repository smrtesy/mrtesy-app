"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Play, RotateCcw, Equal } from "lucide-react";
import { toast } from "sonner";

interface ExperimentRow {
  id: string;
  wamid: string;
  chat_id: string | null;
  audio_received_at: string | null;
  model_a: string;
  thinking_a: string | null;
  transcript_a: string | null;
  cost_a_usd: number | null;
  latency_a_ms: number | null;
  error_a: string | null;
  model_b: string;
  thinking_b: string | null;
  transcript_b: string | null;
  cost_b_usd: number | null;
  latency_b_ms: number | null;
  error_b: string | null;
  source: string;
  whatsapp_message: {
    media_url: string | null;
    from_name: string | null;
    from_phone: string | null;
    received_at: string | null;
  } | null;
}

interface ExperimentConfig {
  enabled: boolean;
  armA: { model: string; thinkingLevel: string };
  armB: { model: string; thinkingLevel: string };
}

interface Stats {
  total: number;
  pending: number;
  verdicts: { a: number; b: number; tie: number; skip: number };
  arm_a: {
    model: string | null;
    runs: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    avg_latency_ms: number | null;
    errors: number;
  };
  arm_b: {
    model: string | null;
    runs: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    avg_latency_ms: number | null;
    errors: number;
  };
}

export function TranscriptionExperimentClient() {
  const t = useTranslations("transcriptionExperiment");
  const [config, setConfig] = useState<ExperimentConfig | null>(null);
  const [pending, setPending] = useState<ExperimentRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfillDays, setBackfillDays] = useState(7);
  const [backfilling, setBackfilling] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p, s] = await Promise.all([
        api<{ config: ExperimentConfig }>("/api/transcription-experiment/config"),
        api<{ experiments: ExperimentRow[] }>("/api/transcription-experiment/pending"),
        api<Stats>("/api/transcription-experiment/stats"),
      ]);
      setConfig(c.config);
      setPending(p.experiments);
      setStats(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function submitVerdict(id: string, verdict: "a" | "b" | "tie" | "skip") {
    try {
      await api(`/api/transcription-experiment/${id}/verdict`, {
        method: "POST",
        body: { verdict },
      });
      setPending((rows) => rows.filter((r) => r.id !== id));
      // Refresh stats in the background
      api<Stats>("/api/transcription-experiment/stats").then(setStats).catch(() => {});
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function triggerBackfill() {
    setBackfilling(true);
    try {
      const r = await api<{ queued: number; days: number; skipped_already_done?: number }>(
        "/api/transcription-experiment/backfill",
        { method: "POST", body: { days: backfillDays } },
      );
      toast.success(t("backfillQueued", { count: r.queued, days: r.days }));
      // Poll the pending list a few times so the user sees rows appear.
      let attempts = 0;
      const interval = setInterval(() => {
        reload();
        if (++attempts >= 6) clearInterval(interval);
      }, 5000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBackfilling(false);
    }
  }

  if (loading && !stats) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Config bar */}
      {config && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t("experimentStatus")}:</span>
              <Badge variant={config.enabled ? "default" : "outline"}>
                {config.enabled ? t("enabled") : t("disabled")}
              </Badge>
              {!config.enabled && (
                <span className="text-xs text-muted-foreground" dir="auto">
                  {t("howToEnable")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded border p-2">
                <div className="font-medium mb-0.5">A</div>
                <div className="text-muted-foreground">{config.armA.model} · thinking={config.armA.thinkingLevel}</div>
              </div>
              <div className="rounded border p-2">
                <div className="font-medium mb-0.5">B</div>
                <div className="text-muted-foreground">{config.armB.model} · thinking={config.armB.thinkingLevel}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats bar */}
      {stats && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-baseline gap-4 flex-wrap">
              <h2 className="text-sm font-medium">{t("stats")}</h2>
              <span className="text-xs text-muted-foreground">
                {t("totalRuns")}: {stats.total} · {t("pending")}: {stats.pending}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <ArmStatsCard label="A" arm={stats.arm_a} verdictWins={stats.verdicts.a} totalDecided={stats.verdicts.a + stats.verdicts.b + stats.verdicts.tie} t={t} />
              <ArmStatsCard label="B" arm={stats.arm_b} verdictWins={stats.verdicts.b} totalDecided={stats.verdicts.a + stats.verdicts.b + stats.verdicts.tie} t={t} />
            </div>
            {stats.verdicts.tie > 0 && (
              <div className="text-xs text-muted-foreground">
                {t("ties")}: {stats.verdicts.tie} · {t("skipped")}: {stats.verdicts.skip}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Backfill controls */}
      <Card>
        <CardContent className="p-4 flex items-end gap-2">
          <div className="flex-1">
            <label className="text-xs font-medium">{t("backfillDays")}</label>
            <Input
              type="number"
              min={1}
              max={30}
              value={backfillDays}
              onChange={(e) => setBackfillDays(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            />
          </div>
          <Button onClick={triggerBackfill} disabled={backfilling} className="gap-1 min-h-[42px]">
            {backfilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {t("triggerBackfill")}
          </Button>
        </CardContent>
      </Card>

      {/* Pending experiments */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">
          {t("toReview")} ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">{t("nothingPending")}</p>
        ) : (
          pending.map((row) => (
            <ExperimentCard key={row.id} row={row} onVerdict={submitVerdict} />
          ))
        )}
      </div>
    </div>
  );
}

function ArmStatsCard({
  label,
  arm,
  verdictWins,
  totalDecided,
  t,
}: {
  label: string;
  arm: Stats["arm_a"];
  verdictWins: number;
  totalDecided: number;
  t: ReturnType<typeof useTranslations>;
}) {
  const winRate = totalDecided > 0 ? Math.round((verdictWins / totalDecided) * 100) : null;
  return (
    <div className="rounded border p-3 space-y-1">
      <div className="font-medium">{label} — {arm.model ?? "?"}</div>
      <div className="text-muted-foreground">
        {t("wins")}: {verdictWins}{winRate != null ? ` (${winRate}%)` : ""}
      </div>
      <div className="text-muted-foreground">
        {t("totalCost")}: ${arm.total_cost_usd.toFixed(4)}
        {arm.runs > 0 && <> · {t("perMessage")}: ${arm.avg_cost_usd.toFixed(4)}</>}
      </div>
      {arm.avg_latency_ms != null && (
        <div className="text-muted-foreground">
          {t("avgLatency")}: {(arm.avg_latency_ms / 1000).toFixed(1)}s
        </div>
      )}
      {arm.errors > 0 && (
        <div className="text-status-late">{t("errors")}: {arm.errors}</div>
      )}
    </div>
  );
}

function ExperimentCard({
  row,
  onVerdict,
}: {
  row: ExperimentRow;
  onVerdict: (id: string, verdict: "a" | "b" | "tie" | "skip") => void;
}) {
  const t = useTranslations("transcriptionExperiment");
  const storagePath = row.whatsapp_message?.media_url ?? null;
  const sender = row.whatsapp_message?.from_name || row.whatsapp_message?.from_phone || row.chat_id || "?";
  const when = row.audio_received_at ? new Date(row.audio_received_at).toLocaleString() : "";

  // The `media_url` stored on whatsapp_messages is a storage path inside
  // the private `whatsapp-media` bucket — we ask the backend to sign it
  // on demand (the same flow ThreadView uses for images). Deferred until
  // the user clicks play so we don't burn signed-URL quota on every row.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);

  async function loadAudio() {
    if (!storagePath || audioUrl) return;
    setLoadingAudio(true);
    try {
      const { url } = await api<{ url: string }>(
        `/api/whatsapp/media?path=${encodeURIComponent(storagePath)}`,
      );
      setAudioUrl(url);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingAudio(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <Badge variant="outline">{row.source}</Badge>
          <span className="font-medium" dir="auto">{sender}</span>
          <span className="text-muted-foreground">{when}</span>
        </div>

        {/* Audio player — lazily fetches a signed URL on first interaction */}
        {storagePath ? (
          audioUrl ? (
            <audio src={audioUrl} controls autoPlay className="w-full h-10" preload="auto" />
          ) : (
            <Button size="sm" variant="outline" onClick={loadAudio} disabled={loadingAudio} className="gap-1">
              {loadingAudio ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {t("playAudio")}
            </Button>
          )
        ) : (
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Play className="h-3 w-3" /> {t("noAudio")}
          </div>
        )}

        {/* Two transcripts side-by-side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TranscriptColumn
            label="A"
            model={row.model_a}
            thinking={row.thinking_a}
            transcript={row.transcript_a}
            cost={row.cost_a_usd}
            latencyMs={row.latency_a_ms}
            error={row.error_a}
          />
          <TranscriptColumn
            label="B"
            model={row.model_b}
            thinking={row.thinking_b}
            transcript={row.transcript_b}
            cost={row.cost_b_usd}
            latencyMs={row.latency_b_ms}
            error={row.error_b}
          />
        </div>

        {/* Verdict buttons */}
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => onVerdict(row.id, "a")} className="flex-1">
            {t("aBetter")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onVerdict(row.id, "tie")} className="gap-1">
            <Equal className="h-3 w-3" />
            {t("tie")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onVerdict(row.id, "b")} className="flex-1">
            {t("bBetter")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onVerdict(row.id, "skip")}>
            {t("skip")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TranscriptColumn({
  label,
  model,
  thinking,
  transcript,
  cost,
  latencyMs,
  error,
}: {
  label: string;
  model: string;
  thinking: string | null;
  transcript: string | null;
  cost: number | null;
  latencyMs: number | null;
  error: string | null;
}) {
  return (
    <div className="rounded border p-3 space-y-2 bg-muted/30">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="default">{label}</Badge>
        <span className="text-muted-foreground">
          {model}{thinking ? ` · ${thinking}` : ""}
        </span>
      </div>
      {error ? (
        <p className="text-xs text-status-late whitespace-pre-wrap" dir="auto">{error}</p>
      ) : (
        <p className="text-sm whitespace-pre-wrap" dir="auto">{transcript ?? "—"}</p>
      )}
      <div className="text-[10px] text-muted-foreground">
        {cost != null && <>${cost.toFixed(4)} · </>}
        {latencyMs != null && <>{(latencyMs / 1000).toFixed(1)}s</>}
      </div>
    </div>
  );
}
