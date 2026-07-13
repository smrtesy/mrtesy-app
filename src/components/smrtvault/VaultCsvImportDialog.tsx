"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface ImportResult { imported: number; skipped: number }
interface ImportRow { label: string; username: string | null; url: string | null; password: string }

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 *  escaped quotes ("") and newlines inside quotes. No dependency. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Find a column index by any of the given header aliases (Chrome uses
 *  name,url,username,password,note; other managers vary). */
function colIndex(header: string[], aliases: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const a of aliases) {
    const idx = lower.indexOf(a);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function VaultCsvImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: () => void;
}) {
  const t = useTranslations("smrtVault");

  const [rows, setRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setRows([]);
    setResult(null);
  }

  async function onFile(file: File) {
    try {
      const text = await file.text();
      const grid = parseCsv(text);
      if (grid.length < 2) { toast.error(t("importParseError")); return; }
      const header = grid[0];
      const iName = colIndex(header, ["name", "title", "account"]);
      const iUrl = colIndex(header, ["url", "website", "login_uri"]);
      const iUser = colIndex(header, ["username", "login_username", "user", "email"]);
      const iPass = colIndex(header, ["password", "login_password", "pass"]);
      if (iPass === -1) { toast.error(t("importNoPasswordColumn")); return; }

      const parsed: ImportRow[] = grid.slice(1).map((r) => {
        const label = (iName !== -1 ? r[iName] : "")?.trim()
          || (iUrl !== -1 ? r[iUrl] : "")?.trim()
          || t("importUnnamed");
        return {
          label,
          username: iUser !== -1 ? (r[iUser] ?? "").trim() || null : null,
          url: iUrl !== -1 ? (r[iUrl] ?? "").trim() || null : null,
          password: iPass !== -1 ? (r[iPass] ?? "") : "",
        };
      }).filter((row) => row.password);

      if (parsed.length === 0) { toast.error(t("importNoRows")); return; }
      setRows(parsed);
      setResult(null);
      toast.success(t("importRowsDetected", { count: parsed.length }));
    } catch {
      toast.error(t("importParseError"));
    }
  }

  async function runImport() {
    if (rows.length === 0) return;
    setImporting(true);
    try {
      const res = await api<ImportResult>("/api/vault/credentials/import", {
        method: "POST",
        body: { rows },
      });
      setResult(res);
      toast.success(t("importDone"));
      onImported();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border bg-accent/40 p-3 text-sm text-muted-foreground">
            {t("importHelp")}
          </div>

          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />

          {rows.length > 0 && !result && (
            <p className="text-sm text-muted-foreground">
              {t("importRowsDetected", { count: rows.length })}
            </p>
          )}

          {result && (
            <div className="rounded-md border bg-accent/40 p-3 text-sm">
              {t("importResult", { imported: result.imported, skipped: result.skipped })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
          <Button onClick={runImport} disabled={importing || rows.length === 0} className="gap-2">
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {t("runImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
