"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

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

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { lines } = await api<{ lines: Line[] }>(
          `/api/voice/projects/${projectId}/lines`,
        );
        if (mounted) setLines(lines.filter((l) => l.output_audio_path));
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [projectId]);

  async function onPlay(lineId: string) {
    const { audio_url } = await api<{ audio_url: string }>(
      `/api/voice/lines/${lineId}/audio-url`,
    );
    window.open(audio_url, "_blank", "noopener,noreferrer");
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        lines.map((line) => (
          <Card key={line.id}>
            <CardContent className="p-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-muted-foreground">
                  #{line.line_number} · {line.speaker_name}
                  {line.output_duration_seconds
                    ? ` · ${line.output_duration_seconds.toFixed(1)}s`
                    : ""}
                </div>
                <div className="text-sm">{line.text_clean}</div>
              </div>
              <Button size="sm" onClick={() => onPlay(line.id)}>
                ▶
              </Button>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
