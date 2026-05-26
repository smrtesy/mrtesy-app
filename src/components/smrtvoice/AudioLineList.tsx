"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { DownloadAllButton } from "./DownloadAllButton";

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  text_clean: string;
  output_audio_path: string | null;
  output_duration_seconds: number | null;
  status: string;
}

export function AudioLineList({ projectId }: { projectId: string }) {
  const t = useTranslations("smrtVoice.audio");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const fetchLines = useCallback(async () => {
    try {
      const { lines } = await api<{ lines: Line[] }>(
        `/api/voice/projects/${projectId}/lines`,
      );
      setLines(lines.filter((l) => l.output_audio_path));
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

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        {lines.length > 0 && <DownloadAllButton projectId={projectId} />}
      </div>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        lines.map((line) => (
          <Card key={line.id}>
            <CardContent className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">
                  #{line.line_number} · {line.speaker_name}
                  {line.output_duration_seconds
                    ? ` · ${line.output_duration_seconds.toFixed(1)}s`
                    : ""}
                </div>
                <div className="text-sm truncate" dir="rtl">
                  {line.text_clean}
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => onPlay(line.id)}
                disabled={playingId === line.id}
              >
                {playingId === line.id ? "▶︎…" : "▶"}
              </Button>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
