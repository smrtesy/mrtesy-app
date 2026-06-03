"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Download } from "lucide-react";

interface PendingCounts {
  all: number;
  general: number;
  personal: number;
}

interface ExportPayload {
  export_format: string;
  generated_at: string;
  [k: string]: unknown;
}

/**
 * Header control for the smrtTask log: exports the user's corrections as a
 * comprehensive JSON file and tracks what has already been exported.
 *
 * `refreshKey` bumps whenever the parent saves a new correction, so the
 * "pending" badge stays in sync.
 */
export function CorrectionsExportButton({ refreshKey }: { refreshKey: number }) {
  const t = useTranslations("corrections");
  const [pending, setPending] = useState<PendingCounts>({ all: 0, general: 0, personal: 0 });
  const [busy, setBusy] = useState(false);

  const fetchPending = useCallback(async () => {
    try {
      const { pending } = await api<{ pending: PendingCounts }>(
        "/api/corrections?exported=pending&limit=1",
      );
      setPending(pending ?? { all: 0, general: 0, personal: 0 });
    } catch {
      // non-fatal — leave counts as-is
    }
  }, []);

  useEffect(() => {
    fetchPending();
  }, [fetchPending, refreshKey]);

  async function runExport(scope: "all" | "general" | "personal", onlyUnexported: boolean) {
    setBusy(true);
    try {
      const { export: payload } = await api<{ export: ExportPayload }>(
        "/api/corrections/export",
        { method: "POST", body: { scope, onlyUnexported } },
      );

      const count = (payload.counts as { total?: number } | undefined)?.total ?? 0;
      if (count === 0) {
        toast.message(t("nothingToExport"));
        return;
      }

      // Client-side download — build the JSON file in memory and click an anchor.
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `smrttask-corrections-${scope}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t("exported", { count }));
      fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const hasPending = pending.all > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          title={t("exportTitle")}
        >
          <Download className="h-3.5 w-3.5" />
          {t("exportButton")}
          {hasPending && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {pending.all}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          {t("exportPendingLabel", { count: pending.all })}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={busy || !hasPending} onClick={() => runExport("all", true)}>
          {t("exportNew")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy || pending.general === 0} onClick={() => runExport("general", true)}>
          {t("exportNewGeneral", { count: pending.general })}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy || pending.personal === 0} onClick={() => runExport("personal", true)}>
          {t("exportNewPersonal", { count: pending.personal })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={() => runExport("all", false)}>
          {t("exportAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
