"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { DayToolsSettings } from "@/components/smrttask/settings/DayToolsSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, RotateCcw, Save } from "lucide-react";

interface ParamsRow {
  smrttask_classifier_model: string | null;
  smrttask_rule_threshold: number | null;
  smrttask_project_match_threshold: number | null;
  smrttask_project_cluster_threshold: number | null;
  smrttask_batch_size: number | null;
  whatsapp_lookback_hours: number | null;
  daily_ai_budget_usd: number | null;
}

const DEFAULTS: ParamsRow = {
  smrttask_classifier_model: null,        // null = sonnet (the system default)
  smrttask_rule_threshold: 0.7,
  smrttask_project_match_threshold: 0.7,
  smrttask_project_cluster_threshold: 0.65,
  smrttask_batch_size: 5,
  whatsapp_lookback_hours: 48,
  daily_ai_budget_usd: 10,
};

const MODELS = ["haiku", "sonnet", "opus"] as const;

export default function SettingsParametersPage() {
  const t = useTranslations("settingsParameters");
  const { appSlug } = useParams() as { appSlug: string };
  const supabase = createClient();
  const [params, setParams] = useState<ParamsRow>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("user_settings")
      .select("smrttask_classifier_model, smrttask_rule_threshold, smrttask_project_match_threshold, smrttask_project_cluster_threshold, smrttask_batch_size, whatsapp_lookback_hours, daily_ai_budget_usd")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) setParams({ ...DEFAULTS, ...data });
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const { error } = await supabase
      .from("user_settings")
      .upsert(
        { user_id: user.id, ...params },
        { onConflict: "user_id" },
      );

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
    <div className="container max-w-2xl py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      {appSlug === "smrttask" && <DayToolsSettings />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("budgetSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("dailyBudgetLabel")} hint={t("dailyBudgetHint")}>
            <NumberInput
              value={params.daily_ai_budget_usd}
              defaultValue={DEFAULTS.daily_ai_budget_usd}
              min={0.1} max={100} step={0.5}
              onChange={(v) => setParams((p) => ({ ...p, daily_ai_budget_usd: v }))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("classifierSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("modelLabel")} hint={t("modelHint")}>
            <Select
              value={params.smrttask_classifier_model ?? "default"}
              onValueChange={(v) => setParams((p) => ({ ...p, smrttask_classifier_model: v === "default" ? null : v }))}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("modelDefault")}</SelectItem>
                {MODELS.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("ruleThresholdLabel")} hint={t("ruleThresholdHint")}>
            <NumberInput
              value={params.smrttask_rule_threshold}
              defaultValue={DEFAULTS.smrttask_rule_threshold}
              min={0} max={1} step={0.05}
              onChange={(v) => setParams((p) => ({ ...p, smrttask_rule_threshold: v }))}
            />
          </Field>

          <Field label={t("projectMatchThresholdLabel")} hint={t("projectMatchThresholdHint")}>
            <NumberInput
              value={params.smrttask_project_match_threshold}
              defaultValue={DEFAULTS.smrttask_project_match_threshold}
              min={0} max={1} step={0.05}
              onChange={(v) => setParams((p) => ({ ...p, smrttask_project_match_threshold: v }))}
            />
          </Field>

          <Field label={t("projectClusterThresholdLabel")} hint={t("projectClusterThresholdHint")}>
            <NumberInput
              value={params.smrttask_project_cluster_threshold}
              defaultValue={DEFAULTS.smrttask_project_cluster_threshold}
              min={0} max={1} step={0.05}
              onChange={(v) => setParams((p) => ({ ...p, smrttask_project_cluster_threshold: v }))}
            />
          </Field>

          <Field label={t("batchSizeLabel")} hint={t("batchSizeHint")}>
            <NumberInput
              value={params.smrttask_batch_size}
              defaultValue={DEFAULTS.smrttask_batch_size}
              min={1} max={50} step={1}
              onChange={(v) => setParams((p) => ({ ...p, smrttask_batch_size: v }))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("whatsappSectionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("whatsappLookbackLabel")} hint={t("whatsappLookbackHint")}>
            <NumberInput
              value={params.whatsapp_lookback_hours}
              defaultValue={DEFAULTS.whatsapp_lookback_hours}
              min={1} max={720} step={1}
              onChange={(v) => setParams((p) => ({ ...p, whatsapp_lookback_hours: v }))}
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
  value,
  defaultValue,
  onChange,
  min, max, step,
}: {
  value: number | null;
  defaultValue: number | null;
  onChange: (v: number | null) => void;
  min: number; max: number; step: number;
}) {
  const display = value ?? defaultValue ?? "";
  return (
    <Input
      type="number"
      value={display}
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
