"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Loader2, RotateCcw, Save } from "lucide-react";

// Mirrors the row shape of smrttask_system_params. id is fixed to 'smrttask'
// by the PRIMARY KEY CHECK, so we only ever update one row.
interface SystemParams {
  classification_model: string;
  summary_model: string;
  batch_size: number;
  processing_lock_minutes: number;
  calendar_past_days: number;
  calendar_future_days: number;
  body_truncate_classify: number;
  body_truncate_project: number;
  body_truncate_task: number;
}

const DEFAULTS: SystemParams = {
  classification_model: "claude-haiku-4-5-20251001",
  summary_model: "claude-sonnet-4-6",
  batch_size: 40,
  processing_lock_minutes: 10,
  calendar_past_days: 1,
  calendar_future_days: 1,
  body_truncate_classify: 2000,
  body_truncate_project: 500,
  body_truncate_task: 6000,
};

const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fastest, cheapest)" },
  { value: "claude-sonnet-4-6",         label: "Sonnet 4.6 (balanced)" },
  { value: "claude-opus-4-7",           label: "Opus 4.7 (slowest, deepest)" },
];

export default function AdminSmrtTaskParametersPage() {
  const { locale, slug } = useParams<{ locale: string; slug: string }>();
  const t = useTranslations("adminSmrttaskParameters");
  const supabase = createClient();
  const [params, setParams] = useState<SystemParams>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("smrttask_system_params")
      .select("*")
      .eq("id", "smrttask")
      .maybeSingle();
    if (error) {
      // The most common cause is RLS — non-super-admin reading 0 rows. We
      // surface that as a permissions hint so the user knows to escalate.
      toast.error(t("loadError", { message: error.message }));
    } else if (data) {
      // Guard against unknown model strings sneaking in via direct SQL: if the
      // stored value isn't one of our dropdown options, fall back to the
      // default so the Select still renders a selected item.
      const validModels = new Set(MODEL_OPTIONS.map((m) => m.value));
      const safeClassify = validModels.has(data.classification_model) ? data.classification_model : DEFAULTS.classification_model;
      const safeSummary  = validModels.has(data.summary_model)        ? data.summary_model        : DEFAULTS.summary_model;
      setParams({
        classification_model: safeClassify,
        summary_model: safeSummary,
        batch_size: data.batch_size ?? DEFAULTS.batch_size,
        processing_lock_minutes: data.processing_lock_minutes ?? DEFAULTS.processing_lock_minutes,
        calendar_past_days: data.calendar_past_days ?? DEFAULTS.calendar_past_days,
        calendar_future_days: data.calendar_future_days ?? DEFAULTS.calendar_future_days,
        body_truncate_classify: data.body_truncate_classify ?? DEFAULTS.body_truncate_classify,
        body_truncate_project: data.body_truncate_project ?? DEFAULTS.body_truncate_project,
        body_truncate_task: data.body_truncate_task ?? DEFAULTS.body_truncate_task,
      });
    }
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("smrttask_system_params")
      .update(params)
      .eq("id", "smrttask");
    if (error) toast.error(error.message);
    else toast.success(t("saved"));
    setSaving(false);
  }

  function reset() {
    setParams(DEFAULTS);
  }

  if (loading) {
    return (
      <div className="container max-w-2xl py-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {t("backToApp")}
        </Link>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {/* A. Models */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("modelsSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("classifyModelLabel")} hint={t("classifyModelHint")}>
            <Select
              value={params.classification_model}
              onValueChange={(v) => setParams((p) => ({ ...p, classification_model: v }))}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("summaryModelLabel")} hint={t("summaryModelHint")}>
            <Select
              value={params.summary_model}
              onValueChange={(v) => setParams((p) => ({ ...p, summary_model: v }))}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {/* B. Processing knobs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("processingSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("batchSizeLabel")} hint={t("batchSizeHint")}>
            <NumberInput
              value={params.batch_size}
              min={1} max={200} step={1}
              onChange={(v) => setParams((p) => ({ ...p, batch_size: v ?? DEFAULTS.batch_size }))}
            />
          </Field>
          <Field label={t("lockMinutesLabel")} hint={t("lockMinutesHint")}>
            <NumberInput
              value={params.processing_lock_minutes}
              min={1} max={60} step={1}
              onChange={(v) => setParams((p) => ({ ...p, processing_lock_minutes: v ?? DEFAULTS.processing_lock_minutes }))}
            />
          </Field>
        </CardContent>
      </Card>

      {/* C. Calendar window */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("calendarSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("calendarPastLabel")} hint={t("calendarPastHint")}>
            <NumberInput
              value={params.calendar_past_days}
              min={0} max={30} step={1}
              onChange={(v) => setParams((p) => ({ ...p, calendar_past_days: v ?? DEFAULTS.calendar_past_days }))}
            />
          </Field>
          <Field label={t("calendarFutureLabel")} hint={t("calendarFutureHint")}>
            <NumberInput
              value={params.calendar_future_days}
              min={0} max={365} step={1}
              onChange={(v) => setParams((p) => ({ ...p, calendar_future_days: v ?? DEFAULTS.calendar_future_days }))}
            />
          </Field>
        </CardContent>
      </Card>

      {/* D. Body truncation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("truncationSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("truncateClassifyLabel")} hint={t("truncateClassifyHint")}>
            <NumberInput
              value={params.body_truncate_classify}
              min={200} max={20000} step={100}
              onChange={(v) => setParams((p) => ({ ...p, body_truncate_classify: v ?? DEFAULTS.body_truncate_classify }))}
            />
          </Field>
          <Field label={t("truncateProjectLabel")} hint={t("truncateProjectHint")}>
            <NumberInput
              value={params.body_truncate_project}
              min={100} max={5000} step={50}
              onChange={(v) => setParams((p) => ({ ...p, body_truncate_project: v ?? DEFAULTS.body_truncate_project }))}
            />
          </Field>
          <Field label={t("truncateTaskLabel")} hint={t("truncateTaskHint")}>
            <NumberInput
              value={params.body_truncate_task}
              min={500} max={20000} step={100}
              onChange={(v) => setParams((p) => ({ ...p, body_truncate_task: v ?? DEFAULTS.body_truncate_task }))}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("save")}
        </Button>
        <Button onClick={reset} variant="outline" className="gap-2">
          <RotateCcw className="h-4 w-4" />
          {t("resetDefaults")}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" dir="auto">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground" dir="auto">{hint}</p>}
    </div>
  );
}

function NumberInput({
  value, onChange, min, max, step,
}: {
  value: number;
  onChange: (v: number | null) => void;
  min: number; max: number; step: number;
}) {
  return (
    <Input
      type="number"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") onChange(null);
        else {
          const n = Number(v);
          if (!Number.isNaN(n)) onChange(n);
        }
      }}
      min={min}
      max={max}
      step={step}
      className="max-w-[200px]"
    />
  );
}
