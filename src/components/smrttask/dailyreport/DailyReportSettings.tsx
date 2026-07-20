"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api/client";
import { useDayTool } from "@/hooks/useDayTools";
import { useDayTools } from "@/hooks/useDayTools";
import type { DailyReportItem } from "@/types/daily-report";

/**
 * The daily-report tool's config editor (revealed under its toggle in
 * DayToolsSettings). Lets the user define report questions + per-answer scores,
 * pick the period + delivery hour, and generate a report on demand. Compact by
 * default (docs/day-tools-plan.md UI principle) — one card, grows on add.
 */
export function DailyReportSettings() {
  const t = useTranslations("dailyReport");
  const { config } = useDayTool("dailyreport");
  const { setToolConfig } = useDayTools();

  const [items, setItems] = useState<DailyReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const period = typeof config.period === "string" ? config.period : "weekly";
  const reportHour = typeof config.report_hour === "number" ? config.report_hour : 8;

  useEffect(() => {
    let alive = true;
    api<{ items: DailyReportItem[] }>("/api/daily-report/config")
      .then((res) => {
        if (alive) setItems(res.items ?? []);
      })
      .catch(() => {
        if (alive) toast.error(t("loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  // ── item/option editing (local state until Save) ──────────────────────────
  const addItem = () =>
    setItems((prev) => [...prev, { label: "", options: [{ label: "", score: null }] }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const setItemLabel = (i: number, label: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, label } : it)));

  const addOption = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, options: [...it.options, { label: "", score: null }] } : it)),
    );
  const removeOption = (i: number, j: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, options: it.options.filter((_, oIdx) => oIdx !== j) } : it,
      ),
    );
  const setOptionLabel = (i: number, j: number, label: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, options: it.options.map((o, oIdx) => (oIdx === j ? { ...o, label } : o)) }
          : it,
      ),
    );
  const setOptionScore = (i: number, j: number, raw: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? {
              ...it,
              options: it.options.map((o, oIdx) =>
                oIdx === j ? { ...o, score: raw.trim() === "" ? null : Number(raw) } : o,
              ),
            }
          : it,
      ),
    );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload = {
        items: items
          .map((it) => ({
            id: it.id,
            label: it.label.trim(),
            options: it.options
              .map((o) => ({ id: o.id, label: o.label.trim(), score: o.score }))
              .filter((o) => o.label),
          }))
          .filter((it) => it.label),
      };
      await api("/api/daily-report/config", { method: "PUT", body: payload });
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [items, t]);

  const generateNow = useCallback(async () => {
    setGenerating(true);
    try {
      await api("/api/daily-report/generate", { method: "POST", body: { period } });
      toast.success(t("generatedToInbox"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("generateError"));
    } finally {
      setGenerating(false);
    }
  }, [period, t]);

  const saveToolConfig = (patch: Record<string, unknown>) =>
    setToolConfig("dailyreport", patch).catch(() => toast.error(t("saveError")));

  if (loading) {
    return (
      <div className="ms-1 flex items-center gap-2 border-s ps-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div className="ms-1 space-y-4 border-s ps-3">
      {/* Questions */}
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={item.id ?? `new-${i}`} className="space-y-2 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <Input
                value={item.label}
                placeholder={t("questionPlaceholder")}
                dir="auto"
                className="h-8 text-sm"
                onChange={(e) => setItemLabel(i, e.target.value)}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground"
                aria-label={t("removeQuestion")}
                onClick={() => removeItem(i)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-1.5 ps-2">
              {item.options.map((opt, j) => (
                <div key={opt.id ?? `new-${j}`} className="flex items-center gap-2">
                  <Input
                    value={opt.label}
                    placeholder={t("answerPlaceholder")}
                    dir="auto"
                    className="h-7 flex-1 text-sm"
                    onChange={(e) => setOptionLabel(i, j, e.target.value)}
                  />
                  <Input
                    value={opt.score ?? ""}
                    placeholder={t("scorePlaceholder")}
                    type="number"
                    inputMode="numeric"
                    className="h-7 w-20 text-sm"
                    aria-label={t("scoreLabel")}
                    onChange={(e) => setOptionScore(i, j, e.target.value)}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground"
                    aria-label={t("removeAnswer")}
                    onClick={() => removeOption(i, j)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => addOption(i)}
              >
                <Plus className="h-3.5 w-3.5" /> {t("addAnswer")}
              </Button>
            </div>
          </div>
        ))}

        <Button type="button" size="sm" variant="outline" className="gap-1 text-xs" onClick={addItem}>
          <Plus className="h-3.5 w-3.5" /> {t("addQuestion")}
        </Button>
      </div>

      {/* Period + delivery hour */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("periodLabel")}</span>
          <Select value={period} onValueChange={(v) => saveToolConfig({ period: v })}>
            <SelectTrigger className="h-8 w-32 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">{t("periodWeekly")}</SelectItem>
              <SelectItem value="monthly">{t("periodMonthly")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("hourLabel")}</span>
          <Input
            type="number"
            min={0}
            max={23}
            value={reportHour}
            className="h-8 w-20 text-sm"
            aria-label={t("hourLabel")}
            onChange={(e) => {
              const n = Math.max(0, Math.min(23, Number(e.target.value) || 0));
              saveToolConfig({ report_hour: n });
            }}
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground" dir="auto">
        {period === "monthly" ? t("deliveryNoteMonthly") : t("deliveryNoteWeekly")}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={saving} className="gap-1 text-xs">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("saveQuestions")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={generateNow}
          disabled={generating}
          className="gap-1 text-xs"
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {t("generateNow")}
        </Button>
      </div>
    </div>
  );
}
