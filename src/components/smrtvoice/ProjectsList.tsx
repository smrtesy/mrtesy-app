"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { api, ApiError } from "@/lib/api/client";
import { ProjectStatusBadge } from "./ProjectStatusBadge";

interface Project {
  id: string;
  name: string;
  description: string | null;
  language: "he" | "en";
  status: string;
  total_lines: number;
  completed_lines: number;
  created_at: string;
}

export function ProjectsList() {
  const t = useTranslations("smrtVoice");
  const locale = useLocale();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>("/api/voice/projects");
        if (mounted) setProjects(projects);
      } catch (err) {
        if (!mounted) return;
        if (err instanceof ApiError && err.status === 403) {
          setError("smrtVoice is not enabled for this organization");
        } else {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>;
  }

  if (projects === null) {
    return <div className="text-sm text-muted-foreground">…</div>;
  }

  if (projects.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-2">
          <p className="text-muted-foreground">{t("projects.empty")}</p>
          <Link
            href={`/${locale}/voice/projects/new`}
            className="text-primary underline"
          >
            {t("projects.createFirst")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/${locale}/voice/projects/${p.id}`}
          className="block"
        >
          <Card className="hover:bg-accent transition-colors">
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
              <CardTitle className="text-base">{p.name}</CardTitle>
              <ProjectStatusBadge status={p.status} />
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {p.description ?? "—"}
              <div className="mt-2 text-xs">
                {p.completed_lines}/{p.total_lines}
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
