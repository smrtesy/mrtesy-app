"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Check, Circle } from "lucide-react";

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
// Clone lifecycle phases surfaced to the user.
type Phase = "idle" | "uploading" | "processing" | "training" | "ready";
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

  // Progress model.
  const [phase, setPhase] = useState<Phase>("idle");
  const [flow, setFlow] = useState<Mode>("upload"); // which flow started the run
  const [uploaded, setUploaded] = useState(0); // files uploaded so far
  const [trainStatus, setTrainStatus] = useState<string | null>(null);
  const [bgNote, setBgNote] = useState(false);
  const running = phase === "uploading" || phase === "processing" || phase === "training";

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

  // Poll Resemble clone/upgrade readiness. Upgrade to Ultra runs async
  // (~minutes); poll for ~3 min while the page is open, then leave it in the bg
  // (the character page reflects readiness on its next focus/refresh).
  async function pollStatus(): Promise<string | null> {
    const READY = new Set(["ready", "completed", "active", "done", "available"]);
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 6000));
      if (!mountedRef.current) return null;
      try {
        const { status } = await api<{ status: string | null }>(
          `/api/voice/characters/${characterId}/voice-status`,
        );
        if (status && READY.has(status.toLowerCase())) return status;
        if (mountedRef.current) setTrainStatus(status ?? "training");
      } catch {
        /* transient — keep polling */
      }
    }
    return null;
  }

  async function afterClone(status: string, voiceId: string) {
    onCloned?.(voiceId);
    // Our side is done — the clone now exists and Resemble is training/upgrading.
    // Clear the pickers so the card resets; the progress panel shows "training".
    setFiles([]);
    setDriveFiles(null);
    setSelected(new Set());
    setFolder("");
    if (status === "ready") {
      setPhase("ready");
      toast.success(t("successReady"));
      return;
    }
    setPhase("training");
    setTrainStatus("training");
    const ready = await pollStatus();
    if (!mountedRef.current) return;
    if (ready) {
      setPhase("ready");
      toast.success(t("successReady"));
    } else {
      setBgNote(true);
      toast.success(t("successTraining"));
    }
  }

  function resetProgress() {
    setUploaded(0);
    setTrainStatus(null);
    setBgNote(false);
  }

  async function onUpload() {
    if (files.length === 0) return;
    setFlow("upload");
    resetProgress();
    setPhase("uploading");
    try {
      // Upload every selected file, then build the clone from all parts.
      const paths: string[] = [];
      for (const f of files) {
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
        if (mountedRef.current) setUploaded((n) => n + 1);
      }

      setPhase("processing");
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
      if (mountedRef.current) setPhase("idle");
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
    setFlow("drive");
    resetProgress();
    setPhase("processing"); // upload happens server-side for the Drive flow
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
      if (mountedRef.current) setPhase("idle");
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
            disabled={running}
          >
            {t("fromComputer")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "drive" ? "default" : "outline"}
            onClick={() => setMode("drive")}
            disabled={running}
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
              disabled={running}
              className="block w-full text-sm file:me-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground"
            />
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {files.map((f) => f.name).join(", ")}
              </p>
            )}
            <Button onClick={onUpload} disabled={files.length === 0 || running}>
              {running ? t("uploading") : hasExistingVoice ? t("submitReplace") : t("submitNew")}
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
                  disabled={running}
                  className="flex-1 min-w-[10rem]"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => loadDriveFiles()}
                  disabled={!folder.trim() || loadingFiles || running}
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
                      disabled={running}
                    />
                    <span className="truncate" dir="ltr">
                      {f.name}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {driveFiles && driveFiles.length > 0 && (
              <Button onClick={onCloneFromDrive} disabled={selected.size === 0 || running}>
                {running
                  ? t("uploading")
                  : t("cloneFromDriveCount", { count: selected.size })}
              </Button>
            )}
          </>
        )}

        {/* Clone progress indicator */}
        {phase !== "idle" && (
          <div className="rounded-md border p-3 space-y-2">
            {(flow === "upload"
              ? (["uploading", "processing", "training", "ready"] as Phase[])
              : (["processing", "training", "ready"] as Phase[])
            ).map((step) => {
              const order: Phase[] = ["idle", "uploading", "processing", "training", "ready"];
              const cur = order.indexOf(phase);
              const idx = order.indexOf(step);
              const done = idx < cur;
              const active = idx === cur;
              const label =
                step === "uploading"
                  ? `${t("stepUpload")}${flow === "upload" && files.length ? ` (${uploaded}/${files.length})` : ""}`
                  : step === "processing"
                    ? t("stepProcess")
                    : step === "training"
                      ? t("stepTrain")
                      : t("stepReady");
              return (
                <div key={step} className="flex items-center gap-2 text-sm">
                  {done ? (
                    <Check className="h-4 w-4 text-status-ok" />
                  ) : active ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
                  )}
                  <span className={done ? "text-muted-foreground" : active ? "font-medium" : "text-muted-foreground/60"}>
                    {label}
                  </span>
                  {step === "training" && active && trainStatus && (
                    <span className="text-xs text-muted-foreground">· {trainStatus}</span>
                  )}
                </div>
              );
            })}
            {bgNote && <p className="text-xs text-muted-foreground">{t("bgNote")}</p>}
          </div>
        )}

        <p className="text-xs text-muted-foreground leading-relaxed">{t("help")}</p>
      </CardContent>
    </Card>
  );
}
