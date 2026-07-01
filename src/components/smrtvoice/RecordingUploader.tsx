"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Props {
  scriptId: string;
  existingPath: string | null;
  onUploaded?: (path: string) => void;
}

/**
 * Uploads the editor's full recording for STS mode. voice-engine will
 * silence-split it into per-line segments during the orchestrator run.
 */
export function RecordingUploader({ scriptId, existingPath, onUploaded }: Props) {
  const t = useTranslations("smrtVoice.recordingUploader");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    try {
      setProgress(t("progressGettingUrl"));
      const { upload_url, path } = await api<{
        upload_url: string;
        path: string;
      }>(`/api/voice/scripts/${scriptId}/upload-url`, {
        method: "POST",
        body: { fileName: file.name },
      });

      setProgress(t("progressUploading", { fileName: file.name }));
      const resp = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "audio/wav" },
        body: file,
      });
      if (!resp.ok) {
        throw new Error(`Upload failed: ${resp.status} ${await resp.text()}`);
      }

      await api(`/api/voice/scripts/${scriptId}`, {
        method: "PATCH",
        body: { input_recording_path: path },
      });

      toast.success(t("success"));
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
          {existingPath ? t("titleReplace") : t("titleNew")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {existingPath && (
          <p className="text-xs text-muted-foreground break-all">
            {t("existingLabel", { path: existingPath })}
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
          {busy ? t("uploading") : existingPath ? t("submitReplace") : t("submitNew")}
        </Button>
        <p className="text-xs text-muted-foreground leading-relaxed">{t("help")}</p>
      </CardContent>
    </Card>
  );
}
