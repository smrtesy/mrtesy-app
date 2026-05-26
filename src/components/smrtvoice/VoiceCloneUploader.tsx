"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Props {
  characterId: string;
  hasExistingVoice: boolean;
  onCloned?: (voiceId: string) => void;
}

type VoiceType = "rapid" | "pro";

export function VoiceCloneUploader({ characterId, hasExistingVoice, onCloned }: Props) {
  const t = useTranslations("smrtVoice.cloneUploader");
  const [file, setFile] = useState<File | null>(null);
  const [voiceType, setVoiceType] = useState<VoiceType>("pro");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    setProgress(t("progressGettingUrl"));
    try {
      const { upload_url, path } = await api<{
        upload_url: string;
        path: string;
      }>(`/api/voice/characters/${characterId}/sample-upload-url`, {
        method: "POST",
        body: { fileName: file.name },
      });

      setProgress(t("progressUploading", { fileName: file.name }));
      const uploadResp = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "audio/wav" },
        body: file,
      });
      if (!uploadResp.ok) {
        throw new Error(`Upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
      }

      setProgress(t("progressCloning"));
      const { status, character } = await api<{
        status: string;
        character: { resemble_voice_id: string };
      }>(`/api/voice/characters/${characterId}/clone`, {
        method: "POST",
        body: { sample_path: path, voice_type: voiceType },
      });

      toast.success(status === "ready" ? t("successReady") : t("successTraining"));
      onCloned?.(character.resemble_voice_id);
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
          {hasExistingVoice ? t("titleReplace") : t("titleNew")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <input
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp4"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:me-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground"
        />

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("voiceTypeLabel")}</label>
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={voiceType}
            onChange={(e) => setVoiceType(e.target.value as VoiceType)}
            disabled={busy}
          >
            <option value="pro">{t("voiceTypePro")}</option>
            <option value="rapid">{t("voiceTypeRapid")}</option>
          </select>
        </div>

        {progress && <p className="text-xs text-muted-foreground">{progress}</p>}

        <Button onClick={onUpload} disabled={!file || busy}>
          {busy ? t("uploading") : hasExistingVoice ? t("submitReplace") : t("submitNew")}
        </Button>

        <p className="text-xs text-muted-foreground leading-relaxed">{t("help")}</p>
      </CardContent>
    </Card>
  );
}
