"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  text_clean: string;
  text_for_tts: string | null;
  directions: string[];
  status: string;
  scene_title: string | null;
  output_audio_path: string | null;
  emotion: string | null;
  error_message: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "text-muted-foreground",
  processing: "text-primary",
  completed: "text-status-ok",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

export function ScriptViewer({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

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

    // Realtime: refetch when any line in this project updates.
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtvoice_lines_${projectId}`)
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

  async function onPlay(lineId: string) {
    setPlayingId(lineId);
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/lines/${lineId}/audio-url`,
      );
      const audio = new Audio(audio_url);
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      await audio.play();
    } catch {
      setPlayingId(null);
    }
  }

  async function onRegenerate(lineId: string) {
    setRegeneratingId(lineId);
    try {
      await api(`/api/voice/lines/${lineId}/regenerate`, { method: "POST" });
      // Realtime will refresh when the line transitions through processing → completed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRegeneratingId(null);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (lines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        אין שורות עדיין. הרץ &ldquo;Parse script&rdquo; בדף הפרויקט.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">
        שורות ({lines.filter((l) => l.status === "completed").length}/{lines.length})
      </h2>
      {lines.map((line) => (
        <Card key={line.id}>
          <CardContent className="p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <div>
                {line.scene_title ? `${line.scene_title} · ` : ""}#{line.line_number}
                {line.emotion && ` · ${line.emotion}`}
                {" · "}
                <span className={STATUS_COLOR[line.status] ?? ""}>{line.status}</span>
              </div>
              <div className="flex gap-1">
                {line.output_audio_path && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onPlay(line.id)}
                    disabled={playingId === line.id}
                  >
                    {playingId === line.id ? "▶︎…" : "▶"}
                  </Button>
                )}
                {line.status === "completed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRegenerate(line.id)}
                    disabled={regeneratingId === line.id}
                  >
                    ↻
                  </Button>
                )}
              </div>
            </div>
            <div className="text-sm font-medium">{line.speaker_name}</div>
            <div className="text-sm leading-relaxed" dir="rtl">
              {line.text_for_tts ?? line.text_clean}
            </div>
            {line.directions.length > 0 && (
              <div className="text-xs text-muted-foreground" dir="rtl">
                {line.directions.map((d) => `*${d}*`).join(" ")}
              </div>
            )}
            {line.status === "failed" && line.error_message && (
              <div className="text-xs text-destructive">{line.error_message}</div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
