"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  output_audio_path: string | null;
}

/**
 * Sequentially downloads each completed line as a separate file via the
 * browser. Not a ZIP — that would need server-side zipping which the spec
 * leaves for later. This is a "good enough" version that lets the editor
 * grab every clip in one click.
 */
export function DownloadAllButton({ projectId }: { projectId: string }) {
  const t = useTranslations("smrtVoice.audio");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function onDownload() {
    setBusy(true);
    setProgress(0);
    try {
      const { lines } = await api<{ lines: Line[] }>(
        `/api/voice/projects/${projectId}/lines`,
      );
      const completed = lines.filter((l) => l.output_audio_path);
      if (completed.length === 0) {
        toast.error("אין קבצים מוכנים להורדה");
        return;
      }

      for (let i = 0; i < completed.length; i++) {
        const line = completed[i];
        const { audio_url } = await api<{ audio_url: string }>(
          `/api/voice/lines/${line.id}/audio-url`,
        );
        // Anchor-click trick to download (works because audio_url is a signed URL)
        const a = document.createElement("a");
        a.href = audio_url;
        a.download = `${String(line.line_number).padStart(3, "0")}_${line.speaker_name}.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setProgress(Math.round(((i + 1) / completed.length) * 100));
        // Small delay so the browser doesn't choke on too many concurrent downloads.
        await new Promise((r) => setTimeout(r, 200));
      }
      toast.success(`${completed.length} קבצים הורדו`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  return (
    <Button onClick={onDownload} disabled={busy} size="sm">
      <Download className="w-4 h-4 me-2" />
      {busy ? `${progress}%` : t("download")}
    </Button>
  );
}
