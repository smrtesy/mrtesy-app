"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Folder } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";

/** v2: a project is a folder (name + letter code-prefix) holding many scripts. */
interface FolderRow {
  id: string;
  name: string;
  description: string | null;
  code_prefix: string | null;
  created_at: string;
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
          <Link href={`/${locale}/voice/projects/new`} className="text-primary underline">
            {t("createFirst")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {folders.map((f) => (
        <Link key={f.id} href={`/${locale}/voice/projects/${f.id}`} className="block">
          <Card className="hover:bg-accent transition-colors h-full">
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Folder className="h-4 w-4 text-muted-foreground" />
                {f.name}
              </CardTitle>
              {f.code_prefix && <Badge variant="secondary">{f.code_prefix}</Badge>}
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {f.description ?? "—"}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
