"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

interface ParamsRow {
  id: string;
  classification_model: string;
  summary_model: string;
  batch_size: number;
  processing_lock_minutes: number;
  calendar_past_days: number;
  calendar_future_days: number;
  body_truncate_classify: number;
  body_truncate_project: number;
  body_truncate_task: number;
  updated_at: string | null;
  updated_by: string | null;
}

const NUMERIC_FIELDS = [
  "batch_size",
  "processing_lock_minutes",
  "calendar_past_days",
  "calendar_future_days",
  "body_truncate_classify",
  "body_truncate_project",
  "body_truncate_task",
] as const;

export default function AdminAppParametersPage() {
  const t = useTranslations("adminParameters");
  const { locale, slug } = useParams<{ locale: string; slug: string }>();

  const [row, setRow] = useState<ParamsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Partial<ParamsRow>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ParamsRow>(`/api/admin/apps/${slug}/parameters`);
      setRow(data);
      setDraft(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!row) return;
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(draft) as (keyof ParamsRow)[]) {
      if (draft[k] !== row[k]) body[k] = draft[k];
    }
    if (Object.keys(body).length === 0) {
      toast.message(t("noChanges"));
      return;
    }
    setSaving(true);
    try {
      const updated = await api<ParamsRow>(`/api/admin/apps/${slug}/parameters`, {
        method: "PATCH",
        body,
      });
      setRow(updated);
      setDraft(updated);
      toast.success(t("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function setField<K extends keyof ParamsRow>(key: K, value: ParamsRow[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {slug}
        </Link>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      )}

      {!loading && row && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("modelsTitle")}</CardTitle>
              <CardDescription>{t("modelsDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="classification_model">{t("classificationModel")}</label>
                <Input
                  id="classification_model"
                  value={draft.classification_model ?? ""}
                  onChange={(e) => setField("classification_model", e.target.value)}
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="summary_model">{t("summaryModel")}</label>
                <Input
                  id="summary_model"
                  value={draft.summary_model ?? ""}
                  onChange={(e) => setField("summary_model", e.target.value)}
                  dir="ltr"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("limitsTitle")}</CardTitle>
              <CardDescription>{t("limitsDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {NUMERIC_FIELDS.map((field) => (
                <div key={field} className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor={field}>{t(field)}</label>
                  <Input
                    id={field}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={String(draft[field] ?? "")}
                    onChange={(e) => setField(field, Number(e.target.value) as ParamsRow[typeof field])}
                    dir="ltr"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {row.updated_at
                ? t("lastUpdated", {
                    when: new Date(row.updated_at).toLocaleString(),
                    who: row.updated_by ?? "—",
                  })
                : t("neverUpdated")}
            </p>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t("save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
