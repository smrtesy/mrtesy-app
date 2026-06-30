"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Play,
  Square,
  RefreshCw,
  Settings2,
  RotateCcw,
  X,
  FolderUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { DownloadAllButton } from "./DownloadAllButton";

interface Tag {
  tag: string;
  type?: string;
  source?: string;
}

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  text_clean: string;
  text_for_tts: string | null;
  tts_body: string | null;
  tags: Tag[] | null;
  emotion: string | null;
  emotion_source: "script" | "llm" | "none" | null;
  resemble_request: Record<string, unknown> | null;
  output_audio_path: string | null;
  output_duration_seconds: number | null;
  status: string;
  redo_requested: boolean;
  redo_reason: string | null;
  redo_instructions: string | null;
}

export function AudioLineList({ projectId }: { projectId: string }) {
  const t = useTranslations("smrtVoice");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [redoOpenId, setRedoOpenId] = useState<string | null>(null);
  const [redoReason, setRedoReason] = useState("");
  const [redoInstructions, setRedoInstructions] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // Line numbers from the most recent re-run, so the user can "play the new ones".
  const [newLineNumbers, setNewLineNumbers] = useState<number[]>([]);

  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef(false);
  // Resolver of the in-flight playOne promise, so stop can unblock the loop.
  const resolveRef = useRef<(() => void) | null>(null);

  const fetchLines = useCallback(async () => {
    try {
      const { lines } = await api<{ lines: Line[] }>(
        `/api/voice/projects/${projectId}/lines`,
      );
      setLines(lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [projectId]);

  useEffect(() => {
    fetchLines();
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtvoice_audio_${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "smrtvoice_lines",
          filter: `project_id=eq.${projectId}`,
        },
        () => fetchLines(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchLines, projectId]);

  const rendered = (lines ?? []).filter((l) => l.output_audio_path);
  const redoCount = (lines ?? []).filter((l) => l.redo_requested).length;

  async function playOne(line: Line): Promise<void> {
    if (!line.output_audio_path) return;
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/lines/${line.id}/audio-url`,
      );
      await new Promise<void>((resolve) => {
        resolveRef.current = resolve;
        const audio = new Audio(audio_url);
        currentAudioRef.current = audio;
        setPlayingId(line.id);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
    } catch {
      /* skip a failed line and continue */
    } finally {
      resolveRef.current = null;
      setPlayingId(null);
    }
  }

  async function playSequence(items: Line[]) {
    const playable = items.filter((l) => l.output_audio_path);
    if (playable.length === 0) return;
    cancelRef.current = false;
    setPlayingAll(true);
    for (const line of playable) {
      if (cancelRef.current) break;
      await playOne(line);
    }
    setPlayingAll(false);
    currentAudioRef.current = null;
  }

  function stopPlayback() {
    cancelRef.current = true;
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    // Unblock the awaiting playOne promise so the sequence loop exits now.
    resolveRef.current?.();
    resolveRef.current = null;
    setPlayingAll(false);
    setPlayingId(null);
  }

  async function markRedo(lineId: string) {
    try {
      await api(`/api/voice/lines/${lineId}/redo`, {
        method: "POST",
        body: { reason: redoReason, instructions: redoInstructions },
      });
      setRedoOpenId(null);
      setRedoReason("");
      setRedoInstructions("");
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function clearRedo(lineId: string) {
    try {
      await api(`/api/voice/lines/${lineId}/redo`, { method: "DELETE" });
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function rerunRedos() {
    setRerunning(true);
    try {
      const { line_numbers } = await api<{ line_numbers: number[] }>(
        `/api/voice/projects/${projectId}/regenerate-redos`,
        { method: "POST" },
      );
      setNewLineNumbers(line_numbers ?? []);
      toast.success(t("studio.redoQueued", { count: line_numbers?.length ?? 0 }));
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRerunning(false);
    }
  }

  async function saveToDrive() {
    setArchiving(true);
    try {
      const { folder_url, uploaded, skipped } = await api<{
        folder_url: string | null;
        uploaded: number;
        skipped: number;
      }>(`/api/voice/projects/${projectId}/archive`, { method: "POST" });
      toast.success(
        t("studio.savedToDrive", { uploaded, skipped: skipped ?? 0 }),
        folder_url ? { action: { label: t("studio.openFolder"), onClick: () => window.open(folder_url, "_blank") } } : undefined,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setArchiving(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;

  // Only offer "play new" for re-rendered lines that have actually finished —
  // a re-queued line keeps its OLD audio (status flips to processing) until the
  // job completes, so gating on completed avoids replaying the stale take.
  const newOnes = rendered.filter(
    (l) => newLineNumbers.includes(l.line_number) && l.status === "completed",
  );

  return (
    <div className="space-y-3">
      {/* Header with quiet icon actions (compact by design). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("audio.title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {rendered.length > 0 &&
            (playingAll ? (
              <Button size="sm" variant="outline" onClick={stopPlayback}>
                <Square className="h-4 w-4 me-1" /> {t("studio.stop")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => playSequence(rendered)}>
                <Play className="h-4 w-4 me-1" /> {t("studio.playAll")}
              </Button>
            ))}
          {newOnes.length > 0 && !playingAll && (
            <Button size="sm" variant="outline" onClick={() => playSequence(newOnes)}>
              <Play className="h-4 w-4 me-1" /> {t("studio.playNew", { count: newOnes.length })}
            </Button>
          )}
          {redoCount > 0 && (
            <Button size="sm" variant="secondary" onClick={rerunRedos} disabled={rerunning}>
              <RefreshCw className={`h-4 w-4 me-1 ${rerunning ? "animate-spin" : ""}`} />
              {t("studio.rerunRedos", { count: redoCount })}
            </Button>
          )}
          {rendered.length > 0 && <DownloadAllButton projectId={projectId} />}
          {rendered.length > 0 && (
            <Button size="sm" onClick={saveToDrive} disabled={archiving}>
              <FolderUp className="h-4 w-4 me-1" />
              {archiving ? t("studio.saving") : t("studio.saveToDrive")}
            </Button>
          )}
        </div>
      </div>

      {rendered.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        rendered.map((line) => {
          const req = line.resemble_request ?? {};
          const sentBody = (req.body as string | undefined) ?? line.tts_body ?? line.text_for_tts ?? "";
          const model = (req.model as string | undefined) ?? null;
          const expanded = expandedId === line.id;
          return (
            <Card key={line.id} className={line.redo_requested ? "border-amber-400" : undefined}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                      <span>#{line.line_number} · {line.speaker_name}</span>
                      {line.output_duration_seconds ? (
                        <span>· {line.output_duration_seconds.toFixed(1)}s</span>
                      ) : null}
                      {line.emotion && line.emotion !== "neutral" && (
                        <span className="inline-flex items-center gap-1">
                          · {line.emotion}
                          <SourceBadge source={line.emotion_source} t={t} />
                        </span>
                      )}
                      {line.redo_requested && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                          {t("studio.needsRedo")}
                        </span>
                      )}
                    </div>
                    <div className="text-sm truncate" dir="rtl">{line.text_clean}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.settings")}
                      onClick={() => setExpandedId(expanded ? null : line.id)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.markRedo")}
                      onClick={() => {
                        setRedoOpenId(redoOpenId === line.id ? null : line.id);
                        setRedoReason(line.redo_reason ?? "");
                        setRedoInstructions(line.redo_instructions ?? "");
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      onClick={() => playOne(line)}
                      disabled={playingId === line.id || playingAll}
                      title={t("studio.play")}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Settings transparency — exactly what was sent to Resemble. */}
                {expanded && (
                  <div className="rounded-md bg-muted/50 p-2 text-xs space-y-1.5" dir="rtl">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                      {model && <span>{t("studio.model")}: <code className="text-foreground">{model}</code></span>}
                      {req.sample_rate ? <span>{t("studio.sampleRate")}: {String(req.sample_rate)}</span> : null}
                      {req.mode ? <span>{t("studio.mode")}: {String(req.mode)}</span> : null}
                    </div>
                    {(line.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground">{t("studio.tags")}:</span>
                        {(line.tags ?? []).map((tag, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded bg-background border px-1.5 py-0.5">
                            <code>{tag.tag}</code>
                            <SourceBadge source={tag.source} t={t} />
                          </span>
                        ))}
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">{t("studio.sentBody")}:</span>
                      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background border p-2 text-foreground" dir="rtl">{sentBody}</pre>
                    </div>
                  </div>
                )}

                {/* Mark-for-redo form. */}
                {redoOpenId === line.id && (
                  <div className="rounded-md border p-2 space-y-2" dir="rtl">
                    <Textarea
                      value={redoReason}
                      onChange={(e) => setRedoReason(e.target.value)}
                      placeholder={t("studio.redoReasonPlaceholder")}
                      rows={2}
                    />
                    <Textarea
                      value={redoInstructions}
                      onChange={(e) => setRedoInstructions(e.target.value)}
                      placeholder={t("studio.redoInstructionsPlaceholder")}
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => markRedo(line.id)}>
                        {t("studio.redoSubmit")}
                      </Button>
                      {line.redo_requested && (
                        <Button size="sm" variant="ghost" onClick={() => clearRedo(line.id)}>
                          <X className="h-4 w-4 me-1" /> {t("studio.clearRedo")}
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setRedoOpenId(null)}>
                        {t("studio.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

function SourceBadge({
  source,
  t,
}: {
  source?: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!source || source === "none") return null;
  const isScript = source === "script";
  return (
    <span
      className={`rounded px-1 py-0.5 text-[10px] ${
        isScript ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
      }`}
    >
      {isScript ? t("studio.sourceScript") : t("studio.sourceLlm")}
    </span>
  );
}
