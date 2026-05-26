"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { ProjectStatusBadge } from "./ProjectStatusBadge";
import { RecordingUploader } from "./RecordingUploader";

interface Project {
  id: string;
  name: string;
  description: string | null;
  language: "he" | "en";
  status: string;
  google_doc_url: string | null;
  total_lines: number;
  completed_lines: number;
  failed_lines: number;
  total_cost_usd: number;
  generation_mode: "sts" | "tts";
  input_recording_path: string | null;
}

export function ProjectOverview({ projectId }: { projectId: string }) {
  const locale = useLocale();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function refresh() {
      try {
        const { project } = await api<{ project: Project }>(`/api/voice/projects/${projectId}`);
        if (mounted) setProject(project);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      }
    }

    refresh();

    // Realtime: refetch on any row update for this project. Cheap and reliable —
    // the row is small. Lines come in separately on the script page.
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtvoice_project_${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "smrtvoice_projects",
          filter: `id=eq.${projectId}`,
        },
        () => {
          if (mounted) refresh();
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  async function onParse() {
    setBusy(true);
    try {
      await api(`/api/voice/projects/${projectId}/parse`, { method: "POST" });
      const { project } = await api<{ project: Project }>(`/api/voice/projects/${projectId}`);
      setProject(project);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    setBusy(true);
    try {
      await api(`/api/voice/projects/${projectId}/generate`, { method: "POST" });
      const { project } = await api<{ project: Project }>(`/api/voice/projects/${projectId}`);
      setProject(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!project) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-muted-foreground">{project.description ?? "—"}</p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stats</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Lines" value={`${project.completed_lines}/${project.total_lines}`} />
          <Stat label="Failed" value={String(project.failed_lines)} />
          <Stat label="Cost" value={`$${project.total_cost_usd.toFixed(2)}`} />
          <Stat label="Mode" value={project.generation_mode.toUpperCase()} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onParse} disabled={busy} variant="secondary">
          Parse script
        </Button>
        <Button onClick={onGenerate} disabled={busy || project.status !== "parsed"}>
          Generate audio
        </Button>
        <Link href={`/${locale}/voice/projects/${projectId}/script`}>
          <Button variant="outline">Script</Button>
        </Link>
        <Link href={`/${locale}/voice/projects/${projectId}/audio`}>
          <Button variant="outline">Audio</Button>
        </Link>
        {project.google_doc_url && (
          <a href={project.google_doc_url} target="_blank" rel="noreferrer">
            <Button variant="ghost">Google Doc ↗</Button>
          </a>
        )}
      </div>

      {project.generation_mode === "sts" && (
        <RecordingUploader
          projectId={projectId}
          existingPath={project.input_recording_path}
          onUploaded={() => {
            // Realtime channel will trigger refresh; nothing else needed.
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
