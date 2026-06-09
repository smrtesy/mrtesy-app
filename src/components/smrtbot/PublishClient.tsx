"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Rocket, RotateCcw } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface TableDiff { added: number; removed: number; updated: number }
type Summary = Record<string, TableDiff>;
interface Batch {
  id: string;
  version: number;
  status: string;
  note: string | null;
  published_by: string | null;
  created_at: string;
  summary_json: Summary | null;
}

export function PublishClient({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [pending, setPending] = useState<Summary>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const summaryText = useCallback((s: Summary | null): string => {
    if (!s) return "";
    return Object.entries(s)
      .map(([res, d]) => {
        const parts: string[] = [];
        if (d.added) parts.push(`+${d.added}`);
        if (d.updated) parts.push(`~${d.updated}`);
        if (d.removed) parts.push(`−${d.removed}`);
        const label = t.has(`res_${res}`) ? t(`res_${res}`) : res;
        return `${label} ${parts.join(" ")}`;
      })
      .join(" · ");
  }, [t]);

  const load = useCallback(async () => {
    try {
      const { batches, pending } = await api<{ batches: Batch[]; pending: Summary }>(`/api/bot/${botId}/publish`);
      setBatches(batches);
      setPending(pending ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  async function publish() {
    if (!confirm(t("publishConfirm"))) return;
    setBusy(true);
    try {
      const { version } = await api<{ version: number }>(`/api/bot/${botId}/publish`, { method: "POST", body: { note } });
      toast.success(`${t("publishTitle")} ✓ v${version}`);
      setNote("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function rollback(b: Batch) {
    if (!confirm(t("rollbackConfirm"))) return;
    try {
      await api(`/api/bot/${botId}/publish/${b.id}/rollback`, { method: "POST" });
      toast.success(t("rollbackDone"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-2 pt-6">
          <p className="text-sm text-muted-foreground">{t("publishHint")}</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-sm font-medium">{t("publishNote")}</label>
              <Input dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button onClick={publish} disabled={busy}>
              <Rocket className="me-2 h-4 w-4" />
              {t("publishNow")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {Object.keys(pending).length > 0 && (
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">{t("publishPending")}: </span>
          <span dir="auto">{summaryText(pending)}</span>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t("publishHistory")}</h2>
        {batches === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : batches.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">{t("noItems")}</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-border first:border-t-0">
                    <td className="px-3 py-2 align-top font-mono">v{b.version}</td>
                    <td className="px-3 py-2" dir="auto">
                      {summaryText(b.summary_json) ? (
                        <div className="text-xs text-foreground">{summaryText(b.summary_json)}</div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("publishNoDiff")}</span>
                      )}
                      {b.note && <div className="text-xs text-muted-foreground">{b.note}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{b.published_by}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(b.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-end">
                      <Button variant="outline" size="sm" onClick={() => rollback(b)}>
                        <RotateCcw className="me-1 h-3.5 w-3.5" />
                        {t("rollback")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
