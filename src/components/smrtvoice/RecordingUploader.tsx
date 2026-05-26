"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Props {
  projectId: string;
  existingPath: string | null;
  onUploaded?: (path: string) => void;
}

/**
 * Uploads the editor's full recording for STS mode. voice-engine will
 * silence-split it into per-line segments during the orchestrator run.
 */
export function RecordingUploader({ projectId, existingPath, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    try {
      setProgress("מקבל URL להעלאה…");
      const { upload_url, path } = await api<{
        upload_url: string;
        path: string;
      }>(`/api/voice/projects/${projectId}/upload-url`, {
        method: "POST",
        body: { fileName: file.name },
      });

      setProgress(`מעלה ${file.name}…`);
      const resp = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "audio/wav" },
        body: file,
      });
      if (!resp.ok) {
        throw new Error(`Upload failed: ${resp.status} ${await resp.text()}`);
      }

      // Persist the path on the project so /generate can pick it up.
      await api(`/api/voice/projects/${projectId}`, {
        method: "PATCH",
        body: { input_recording_path: path },
      });

      toast.success("הקלטה הועלתה");
      onUploaded?.(path);
      setFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {existingPath ? "החלף הקלטת עורך" : "העלה הקלטת עורך (STS)"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {existingPath && (
          <p className="text-xs text-muted-foreground break-all">
            קיים: {existingPath}
          </p>
        )}
        <input
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp4"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:me-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground"
        />
        {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
        <Button onClick={onUpload} disabled={!file || busy}>
          {busy ? "מעלה…" : existingPath ? "החלף" : "העלה"}
        </Button>
        <p className="text-xs text-muted-foreground leading-relaxed">
          קובץ WAV/MP3 של ההקלטה המלאה. voice-engine יחתוך אותה לפי שתיקות
          ויתאים לכל שורה את הקטע המתאים.
        </p>
      </CardContent>
    </Card>
  );
}
