"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FileSpreadsheet, Search, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export interface DriveSheet {
  id: string;
  name: string;
  webViewLink?: string;
  modifiedTime?: string;
}

/**
 * In-app Google Drive picker for spreadsheets. Mirrors the Drive folder
 * picker (DriveFolderManager): a searchable dialog backed by
 * GET /api/me/drive/files (which uses the user's google_drive OAuth token).
 * Single-select — picking a sheet calls onPick and closes.
 */
export function DriveSheetPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (sheet: DriveSheet) => void;
}) {
  const t = useTranslations("smrtCRM");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriveSheet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = q.trim()
        ? `/api/me/drive/files?q=${encodeURIComponent(q.trim())}&limit=50`
        : "/api/me/drive/files?limit=50";
      const r = await api<{ files: DriveSheet[] }>(url, { noOrg: true });
      setResults(r.files);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(t("sheetErrorNotConnected"));
      } else if (e instanceof ApiError && e.status !== 401) {
        toast.error((e as Error).message);
      }
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    search("");
  }, [open, search]);

  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => search(query), 250);
    return () => clearTimeout(h);
  }, [query, open, search]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("drivePickerTitle")}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("driveSearchPlaceholder")}
            className="ps-9"
            autoFocus
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-status-warn/30 bg-status-warn-bg p-3 text-sm text-status-warn">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="max-h-[300px] overflow-y-auto space-y-1">
          {loading ? (
            <div className="py-6 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {error ? "" : t("driveNoResults")}
            </p>
          ) : (
            results.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onPick(f)}
                className="flex items-center gap-2 w-full rounded-md p-2 text-start text-sm transition-colors hover:bg-accent"
              >
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate" dir="auto">{f.name}</span>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
