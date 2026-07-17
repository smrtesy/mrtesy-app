"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import JSZip from "jszip";

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

// Strip characters illegal in a file/folder name; keep Hebrew/spaces so the
// character folder stays readable. Mirrors the server-side archive sanitizer.
function pathSafe(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (name ?? "").replace(/[/\\:*?"<>|\x00-\x1f]/g, "").trim();
  return clean || "ללא דמות";
}

/**
 * Bundles every completed line's audio into a single ZIP and downloads it, with
 * one subfolder per character (named by the speaker as it appears in the script
 * — same structure as the Drive archive). Zipping is done in the browser: each
 * signed URL is fetched as a blob (a plain `<a download>` on a cross-origin
 * signed URL is ignored by the browser and just opens the file instead of
 * saving it, which is why the old sequential-anchor approach failed).
 */
export function DownloadAllButton({ scriptId }: { scriptId: string }) {
  const t = useTranslations("smrtVoice.audio");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function onDownload() {
    setBusy(true);
    setProgress(0);
    try {
      const [{ lines }, { script }] = await Promise.all([
        api<{ lines: Line[] }>(`/api/voice/scripts/${scriptId}/lines`),
        api<{ script: { code: string; name: string | null } }>(
          `/api/voice/scripts/${scriptId}`,
        ),
      ]);
      const completed = lines.filter((l) => l.output_audio_path && !l.archived_at);
      if (completed.length === 0) {
        toast.error(t("noFilesToDownload"));
        return;
      }

      const namePrefix = pathSafe((script?.name || script?.code) ?? "voice");
      const zip = new JSZip();
      let files = 0;
      let skipped = 0;
      for (let i = 0; i < completed.length; i++) {
        const line = completed[i];
        // The line's "good" takes (note in the filename); falls back to the
        // single current output when none are marked — same as the per-line
        // download button.
        const { items } = await api<{
          items: { url: string; take_number: number | null; note: string | null; voice_label: string | null }[];
        }>(`/api/voice/lines/${line.id}/selection`);
        // Folder = the character (speaker); filename is prefixed with the script
        // NAME + line number (matching the Save-to-Drive archive), e.g.
        // "NM110 - 3_022.wav". pathSafe strips slashes so nothing injects an
        // extra zip subfolder.
        const speaker = pathSafe(line.speaker_name);
        const base = `${namePrefix}_${String(line.line_number).padStart(3, "0")}`;
        for (const it of items) {
          const name =
            it.take_number != null
              ? `${base}_v${it.take_number}${noteSuffix(it.voice_label)}${noteSuffix(it.note)}.wav`
              : `${base}.wav`;
          // One bad/expired signed URL must not lose the whole batch: skip it
          // and keep going, then report how many were skipped.
          try {
            const res = await fetch(it.url);
            if (!res.ok) throw new Error(`Download failed (${res.status})`);
            zip.file(`${speaker}/${name}`, await res.blob());
            files += 1;
          } catch {
            skipped += 1;
          }
        }
        // First 90% tracks fetching; the final 10% is the zip generation below.
        setProgress(Math.round(((i + 1) / completed.length) * 90));
      }

      if (files === 0) {
        toast.error(t("noFilesToDownload"));
        return;
      }

      const blob = await zip.generateAsync({ type: "blob" }, (meta) => {
        setProgress(90 + Math.round(meta.percent * 0.1));
      });
      const zipName = `${pathSafe((script?.name || script?.code) ?? "voice")}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);

      toast.success(t("filesDownloaded", { count: files }));
      if (skipped > 0) toast.warning(t("filesSkipped", { count: skipped }));
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
