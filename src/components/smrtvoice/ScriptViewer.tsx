"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  text_clean: string;
  directions: string[];
  status: string;
  scene_title: string | null;
}

export function ScriptViewer({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { lines } = await api<{ lines: Line[] }>(
          `/api/voice/projects/${projectId}/lines`,
        );
        if (mounted) setLines(lines);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [projectId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">No lines yet. Parse the script first.</p>;
  }

  return (
    <div className="space-y-2">
      {lines.map((line) => (
        <Card key={line.id}>
          <CardContent className="p-3 space-y-1">
            <div className="text-xs text-muted-foreground">
              {line.scene_title ? `${line.scene_title} · ` : ""}#{line.line_number} · {line.status}
            </div>
            <div className="text-sm font-medium">{line.speaker_name}</div>
            <div className="text-sm leading-relaxed">{line.text_clean}</div>
            {line.directions.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {line.directions.map((d) => `*${d}*`).join(" ")}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
