"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

import { noteSuffix } from "./takeName";

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  output_audio_path: string | null;
  archived_at?: string | null;
}

/**
 * Sequentially downloads each completed line as a separate file via the
 * browser. Not a ZIP — that would need server-side zipping which the spec
 * leaves for later. This is a "good enough" version that lets the editor
 * grab every clip in one click.
 */
export function DownloadAllButton({ scriptId }: { scriptId: string }) {
  const t = useTranslations("smrtVoice.audio");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function onDownload() {
    setBusy(true);
    setProgress(0);
    try {
      const { lines } = await api<{ lines: Line[] }>(
        `/api/voice/scripts/${scriptId}/lines`,
      );
      const completed = lines.filter((l) => l.output_audio_path && !l.archived_at);
      if (completed.length === 0) {
        toast.error("אין קבצים מוכנים להורדה");
        return;
      }

      let files = 0;
      for (let i = 0; i < completed.length; i++) {
        const line = completed[i];
        // Download the line's "good" takes (note in the filename); falls back to
        // the single current output when none are marked — same as the per-line
        // download button.
        const { items } = await api<{
          items: { url: string; take_number: number | null; note: string | null }[];
        }>(`/api/voice/lines/${line.id}/selection`);
        const base = `${String(line.line_number).padStart(3, "0")}_${line.speaker_name}`;
        for (const it of items) {
          const name =
            it.take_number != null
              ? `${base}_v${it.take_number}${noteSuffix(it.note)}.wav`
              : `${base}.wav`;
          // Anchor-click trick to download (works because the url is signed)
          const a = document.createElement("a");
          a.href = it.url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          files += 1;
          // Small delay so the browser doesn't choke on too many concurrent downloads.
          await new Promise((r) => setTimeout(r, 200));
        }
        setProgress(Math.round(((i + 1) / completed.length) * 100));
      }
      toast.success(`${files} קבצים הורדו`);
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
