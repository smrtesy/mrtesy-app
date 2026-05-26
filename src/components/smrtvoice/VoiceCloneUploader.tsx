"use client";

import { useState } from "react";
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
  const [file, setFile] = useState<File | null>(null);
  const [voiceType, setVoiceType] = useState<VoiceType>("pro");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    setProgress("מקבל URL להעלאה…");
    try {
      // 1. Ask smrtesy for a signed upload URL.
      const { upload_url, path } = await api<{
        upload_url: string;
        path: string;
      }>(`/api/voice/characters/${characterId}/sample-upload-url`, {
        method: "POST",
        body: { fileName: file.name },
      });

      // 2. Upload the file directly to Supabase Storage (bypasses our backend).
      setProgress(`מעלה ${file.name}…`);
      const uploadResp = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "audio/wav" },
        body: file,
      });
      if (!uploadResp.ok) {
        throw new Error(`Upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
      }

      // 3. Tell smrtesy to forward this sample to voice-engine → Resemble.
      setProgress("יוצר קלון ברזמבל…");
      const { status, character } = await api<{
        status: string;
        character: { resemble_voice_id: string };
      }>(`/api/voice/characters/${characterId}/clone`, {
        method: "POST",
        body: { sample_path: path, voice_type: voiceType },
      });

      toast.success(
        status === "ready" ? "הקלון מוכן!" : "הקלון בתהליך אימון (ידע אותך כשמוכן)",
      );
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
          {hasExistingVoice ? "החלף קלון קול" : "יצירת קלון קול"}
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
          <label className="text-xs text-muted-foreground">סוג קלון</label>
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={voiceType}
            onChange={(e) => setVoiceType(e.target.value as VoiceType)}
            disabled={busy}
          >
            <option value="pro">Pro — איכות גבוהה, ~כמה דקות אימון</option>
            <option value="rapid">Rapid — מיידי, איכות נמוכה יותר</option>
          </select>
        </div>

        {progress && <p className="text-xs text-muted-foreground">{progress}</p>}

        <Button onClick={onUpload} disabled={!file || busy}>
          {busy ? "מעלה…" : hasExistingVoice ? "החלף" : "צור קלון"}
        </Button>

        <p className="text-xs text-muted-foreground leading-relaxed">
          העלה הקלטה של 30–60 שניות באיכות נקייה (בלי רעש רקע, בלי מוזיקה).
          רזמבל ילמד את הקול ומחזיר voice_id שמשמש לייצור.
        </p>
      </CardContent>
    </Card>
  );
}
