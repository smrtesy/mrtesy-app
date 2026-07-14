"use client";

import { useEffect, useState } from "react";
import { PaneLink } from "@/lib/panes/nav";
import { useTranslations, useLocale } from "next-intl";
import { Folder, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";

/** A script belonging to a folder — the direct-open button targets its page. */
interface ScriptRow {
  id: string;
  seq: number;
  code: string;
  name: string | null;
  status: string;
}

/** v2: a project is a folder (name + letter code-prefix) holding many scripts. */
interface FolderRow {
  id: string;
  name: string;
  description: string | null;
  code_prefix: string | null;
  created_at: string;
  scripts: ScriptRow[];
}

export function ProjectsList() {
  const t = useTranslations("smrtVoice.folders");
  const locale = useLocale();
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { projects } = await api<{ projects: FolderRow[] }>("/api/voice/projects");
        if (mounted) setFolders(projects);
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

  if (error) return <div className="text-sm text-destructive">{error}</div>;
  if (folders === null) return <div className="text-sm text-muted-foreground">…</div>;

  if (folders.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-2">
          <p className="text-muted-foreground">{t("empty")}</p>
          <PaneLink href={`/${locale}/voice/projects/new`} className="text-primary underline">
            {t("createFirst")}
          </PaneLink>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {folders.map((f) => (
        <Card key={f.id} className="h-full transition-colors">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-base flex items-center gap-2 min-w-0">
              <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
              <PaneLink
                href={`/${locale}/voice/projects/${f.id}`}
                className="truncate hover:underline"
              >
                {f.name}
              </PaneLink>
            </CardTitle>
            {f.code_prefix && <Badge variant="secondary">{f.code_prefix}</Badge>}
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{f.description ?? "—"}</p>
            {f.scripts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {f.scripts.map((s) => (
                  <PaneLink
                    key={s.id}
                    href={`/${locale}/voice/scripts/${s.id}`}
                    title={s.name ?? s.code}
                    className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground hover:bg-accent transition-colors"
                  >
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    {s.code}
                  </PaneLink>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
