"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Folder, FileText, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

import { ProjectStatusBadge } from "./ProjectStatusBadge";
import { CreateScriptForm } from "./CreateScriptForm";

interface FolderRow {
  id: string;
  name: string;
  description: string | null;
  code_prefix: string | null;
}

interface ScriptRow {
  id: string;
  seq: number;
  code: string;
  name: string | null;
  status: string;
  total_lines: number;
  completed_lines: number;
}

/** v2: the "project" page is a FOLDER — header + its scripts + add/delete. */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("smrtVoice.folders");
  const ts = useTranslations("smrtVoice.scripts");

  const [folder, setFolder] = useState<FolderRow | null>(null);
  const [scripts, setScripts] = useState<ScriptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ project }, { scripts }] = await Promise.all([
        api<{ project: FolderRow }>(`/api/voice/projects/${projectId}`),
        api<{ scripts: ScriptRow[] }>(`/api/voice/projects/${projectId}/scripts`),
      ]);
      setFolder(project);
      setScripts(scripts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onDelete() {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    try {
      await api(`/api/voice/projects/${projectId}`, { method: "DELETE" });
      toast.success(t("deleted"));
      router.push(`/${locale}/voice`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!folder || scripts === null) return <p className="text-sm text-muted-foreground">…</p>;

  const nextSeq = scripts.reduce((max, s) => Math.max(max, s.seq), 0) + 1;
  const nextCode = `${folder.code_prefix ?? ""}${nextSeq}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Folder className="h-5 w-5 text-muted-foreground" />
            {folder.name}
            {folder.code_prefix && <Badge variant="secondary">{folder.code_prefix}</Badge>}
          </h1>
          <p className="text-muted-foreground">{folder.description ?? "—"}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
          {t("delete")}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("scripts")}</h2>
        <CreateScriptForm projectId={projectId} nextCode={nextCode} onCreated={refresh} />
      </div>

      {scripts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noScripts")}</p>
      ) : (
        <div className="grid gap-2">
          {scripts.map((s) => (
            <Link key={s.id} href={`/${locale}/voice/scripts/${s.id}`} className="block">
              <Card className="hover:bg-accent transition-colors">
                <CardContent className="flex items-center justify-between gap-3 p-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        <span className="font-mono">{s.code}</span>
                        {s.name ? ` · ${s.name}` : ""}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {ts("lines")}: {s.completed_lines}/{s.total_lines}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ProjectStatusBadge status={s.status} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
