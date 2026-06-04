"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Upload } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Field = "first_name" | "last_name" | "phone" | "email";
const FIELDS: Field[] = ["first_name", "last_name", "phone", "email"];
const NONE = "__none__";

interface Tag { id: string; name: string }
interface ImportResult { created: number; merged: number; skipped: number }

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

function autoMap(header: string): Field | null {
  const h = header.trim().toLowerCase();
  if (/first|פרטי|שם פרטי/.test(h)) return "first_name";
  if (/last|משפחה/.test(h)) return "last_name";
  if (/phone|mobile|tel|טלפון|נייד/.test(h)) return "phone";
  if (/mail|אימייל|דוא/.test(h)) return "email";
  if (h === "name" || h === "שם") return "first_name";
  return null;
}

export function CsvImportDialog({
  open,
  onOpenChange,
  tags,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tags: Tag[];
  onImported: () => void;
}) {
  const t = useTranslations("smrtCRM");

  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<Field, number | null>>({
    first_name: null, last_name: null, phone: null, email: null,
  });
  const [tagId, setTagId] = useState<string>(NONE);
  const [newTag, setNewTag] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setHeaders([]); setDataRows([]); setResult(null);
    setMapping({ first_name: null, last_name: null, phone: null, email: null });
    setTagId(NONE); setNewTag("");
  }

  async function onFile(file: File) {
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.length < 2) { toast.error(t("parseError")); return; }
      const hdr = parsed[0];
      setHeaders(hdr);
      setDataRows(parsed.slice(1));
      setResult(null);
      const next: Record<Field, number | null> = { first_name: null, last_name: null, phone: null, email: null };
      hdr.forEach((h, idx) => {
        const f = autoMap(h);
        if (f && next[f] === null) next[f] = idx;
      });
      setMapping(next);
    } catch {
      toast.error(t("parseError"));
    }
  }

  const mappedAny = useMemo(() => FIELDS.some((f) => mapping[f] !== null), [mapping]);

  async function runImport() {
    if (dataRows.length === 0 || !mappedAny) { toast.error(t("mapHint")); return; }
    setImporting(true);
    try {
      // Resolve/create the optional tag to apply.
      let applyTagId: string | undefined;
      if (newTag.trim()) {
        const existing = tags.find((t) => t.name.trim().toLowerCase() === newTag.trim().toLowerCase());
        if (existing) applyTagId = existing.id;
        else {
          const { tag } = await api<{ tag: Tag }>("/api/crm/tags", { method: "POST", body: { name: newTag.trim() } });
          applyTagId = tag.id;
        }
      } else if (tagId !== NONE) {
        applyTagId = tagId;
      }

      const rows = dataRows.map((r) => {
        const get = (f: Field) => (mapping[f] !== null ? (r[mapping[f] as number] ?? "").trim() || null : null);
        return { first_name: get("first_name"), last_name: get("last_name"), phone: get("phone"), email: get("email") };
      });

      const res = await api<ImportResult>("/api/crm/import", {
        method: "POST",
        body: { rows, tag_id: applyTagId },
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />

          {headers.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("rowsDetected", { count: dataRows.length })} · {t("mapHint")}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <label key={f} className="grid gap-1 text-sm">
                    <span className="text-muted-foreground">{t(`field_${f}` as Parameters<typeof t>[0])}</span>
                    <Select
                      value={mapping[f] === null ? NONE : String(mapping[f])}
                      onValueChange={(v) => setMapping((m) => ({ ...m, [f]: v === NONE ? null : Number(v) }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("columnNone")}</SelectItem>
                        {headers.map((h, idx) => (
                          <SelectItem key={idx} value={String(idx)}>{h || `#${idx + 1}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ))}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">{t("applyTagExisting")}</span>
                  <Select value={tagId} onValueChange={setTagId}>
                    <SelectTrigger><SelectValue placeholder={t("columnNone")} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("columnNone")}</SelectItem>
                      {tags.map((tg) => <SelectItem key={tg.id} value={tg.id}>{tg.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">{t("applyTagNew")}</span>
                  <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder={t("applyTagNewHint")} />
                </label>
              </div>
            </>
          )}

          {result && (
            <div className="rounded-md border bg-accent/40 p-3 text-sm">
              {t("importResult", { created: result.created, merged: result.merged, skipped: result.skipped })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
          <Button onClick={runImport} disabled={importing || headers.length === 0} className="gap-2">
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("runImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
