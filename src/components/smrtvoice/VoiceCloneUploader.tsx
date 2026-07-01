"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

import { DriveFolderPicker } from "./DriveFolderPicker";

interface Props {
  characterId: string;
  hasExistingVoice: boolean;
  onCloned?: (voiceId: string) => void;
}

type Mode = "upload" | "drive";
interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
}

export function VoiceCloneUploader({ characterId, hasExistingVoice, onCloned }: Props) {
  const t = useTranslations("smrtVoice.cloneUploader");
  const [mode, setMode] = useState<Mode>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  // Drive mode state
  const [folder, setFolder] = useState("");
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Poll Resemble clone/upgrade readiness for a short window (upgrade to Ultra
  // runs async ~minutes); surface progress for ~40s then leave it in the bg.
  async function pollStatus(): Promise<string | null> {
    const READY = new Set(["ready", "completed", "active", "done", "available"]);
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (!mountedRef.current) return null;
      try {
        const { status } = await api<{ status: string | null }>(
          `/api/voice/characters/${characterId}/voice-status`,
        );
        if (status && READY.has(status.toLowerCase())) return status;
        if (mountedRef.current) {
          setProgress(t("progressTraining", { status: status ?? "training" }));
        }
      } catch {
        /* transient — keep polling */
      }
    }
    return null;
  }

  async function afterClone(status: string, voiceId: string) {
    onCloned?.(voiceId);
    if (status === "ready") {
      toast.success(t("successReady"));
    } else {
      setProgress(t("progressTraining", { status: "training" }));
      const ready = await pollStatus();
      toast.success(ready ? t("successReady") : t("successTraining"));
    }
  }

  async function onUpload() {
    if (files.length === 0) return;
    setBusy(true);
    try {
      // Upload every selected file, then build the clone from all parts.
      const paths: string[] = [];
      for (const f of files) {
        setProgress(t("progressUploading", { fileName: f.name }));
        const { upload_url, path } = await api<{ upload_url: string; path: string }>(
          `/api/voice/characters/${characterId}/sample-upload-url`,
          { method: "POST", body: { fileName: f.name } },
        );
        const uploadResp = await fetch(upload_url, {
          method: "PUT",
          headers: { "Content-Type": f.type || "audio/wav" },
          body: f,
        });
        if (!uploadResp.ok) {
          throw new Error(`Upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
        }
        paths.push(path);
      }

      setProgress(t("progressCloning"));
      const { status, character } = await api<{
        status: string;
        character: { resemble_voice_id: string };
      }>(`/api/voice/characters/${characterId}/clone`, {
        method: "POST",
        body: { sample_paths: paths },
      });
      setFiles([]);
      await afterClone(status, character.resemble_voice_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function loadDriveFiles(folderArg?: string) {
    const f = (folderArg ?? folder).trim();
    if (!f) return;
    setLoadingFiles(true);
    try {
      const { files } = await api<{ files: DriveFile[] }>("/api/voice/drive/list-audio", {
        method: "POST",
        body: { folder: f },
      });
      setDriveFiles(files);
      setSelected(new Set(files.map((f) => f.id))); // pre-select all parts
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingFiles(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onCloneFromDrive() {
    if (selected.size === 0) return;
    setBusy(true);
    setProgress(t("progressCloning"));
    try {
      const { status, character } = await api<{
        status: string;
        character: { resemble_voice_id: string };
      }>(`/api/voice/characters/${characterId}/clone-from-drive`, {
        method: "POST",
        body: { file_ids: Array.from(selected) },
      });
      await afterClone(status, character.resemble_voice_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setProgress(null);
      }
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
        {/* Source toggle */}
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "upload" ? "default" : "outline"}
            onClick={() => setMode("upload")}
            disabled={busy}
          >
            {t("fromComputer")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "drive" ? "default" : "outline"}
            onClick={() => setMode("drive")}
            disabled={busy}
          >
            {t("fromDrive")}
          </Button>
        </div>

        {mode === "upload" ? (
          <>
            <input
              type="file"
              multiple
              accept="audio/wav,audio/mpeg,audio/mp4"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              disabled={busy}
              className="block w-full text-sm file:me-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground"
            />
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {files.map((f) => f.name).join(", ")}
              </p>
            )}
            {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
            <Button onClick={onUpload} disabled={files.length === 0 || busy}>
              {busy ? t("uploading") : hasExistingVoice ? t("submitReplace") : t("submitNew")}
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("driveFolderLabel")}</label>
              <div className="flex flex-wrap gap-2">
                <DriveFolderPicker
                  onPicked={(f) => {
                    setFolder(f.url);
                    loadDriveFiles(f.id);
                  }}
                />
                <Input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  disabled={busy}
                  className="flex-1 min-w-[10rem]"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => loadDriveFiles()}
                  disabled={!folder.trim() || loadingFiles || busy}
                >
                  {loadingFiles ? t("loadingFiles") : t("loadFiles")}
                </Button>
              </div>
            </div>

            {driveFiles && driveFiles.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("noFiles")}</p>
            )}

            {driveFiles && driveFiles.length > 0 && (
              <div className="space-y-1 max-h-56 overflow-y-auto rounded-md border p-2">
                {driveFiles.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggle(f.id)}
                      disabled={busy}
                    />
                    <span className="truncate" dir="ltr">
                      {f.name}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {progress && <p className="text-xs text-muted-foreground">{progress}</p>}

            {driveFiles && driveFiles.length > 0 && (
              <Button onClick={onCloneFromDrive} disabled={selected.size === 0 || busy}>
                {busy
                  ? t("uploading")
                  : t("cloneFromDriveCount", { count: selected.size })}
              </Button>
            )}
          </>
        )}

        <p className="text-xs text-muted-foreground leading-relaxed">{t("help")}</p>
      </CardContent>
    </Card>
  );
}
