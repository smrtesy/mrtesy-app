"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { DAY_TOOLS, resolveTool } from "@/lib/smrttask/day-tools";
import { useDayTools } from "@/hooks/useDayTools";
import { WorkClockInsights } from "@/components/smrttask/workclock/WorkClockInsights";

/**
 * "כלי היום" settings section — one quiet toggle row per day-tool. Per-tool
 * config (quotas etc.) reveals only when the tool is on and is added by each
 * tool in its own phase; phase 1 ships the toggles.
 */
export function DayToolsSettings() {
  const t = useTranslations("dayTools");
  const { state, loading, setToolConfig } = useDayTools();

  async function toggle(slug: (typeof DAY_TOOLS)[number]["slug"], enabled: boolean) {
    try {
      await setToolConfig(slug, { enabled });
    } catch {
      toast.error(t("saveError"));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("sectionTitle")}</CardTitle>
        <p className="text-sm text-muted-foreground" dir="auto">{t("sectionSubtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {DAY_TOOLS.map((tool) => {
          const cfg = resolveTool(state, tool.slug);
          const enabled = cfg.enabled;
          const id = `daytool-${tool.slug}`;
          return (
            <div key={tool.slug} className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <label htmlFor={id} className="text-sm font-medium" dir="auto">{t(`${tool.slug}.title`)}</label>
                  <p className="text-xs text-muted-foreground" dir="auto">{t(`${tool.slug}.desc`)}</p>
                </div>
                <Switch
                  id={id}
                  checked={enabled}
                  disabled={loading}
                  onCheckedChange={(v) => toggle(tool.slug, v)}
                  aria-label={t(`${tool.slug}.title`)}
                />
              </div>

              {/* Per-tool config, revealed only when the tool is on. Each tool's
                  config grows in its own phase; workclock ships the morning-offer
                  toggle first (the rest of its settings arrive with the phases
                  that make them do something). */}
              {tool.slug === "workclock" && enabled && (
                <div className="ms-1 space-y-3 border-s ps-3">
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor="workclock-offer" className="text-xs text-muted-foreground" dir="auto">
                      {t("workclock.offerDaily")}
                    </label>
                    <Switch
                      id="workclock-offer"
                      checked={cfg.offer_daily !== false}
                      disabled={loading}
                      onCheckedChange={(v) => setToolConfig("workclock", { offer_daily: v }).catch(() => toast.error(t("saveError")))}
                      aria-label={t("workclock.offerDaily")}
                    />
                  </div>
                  <WorkClockInsights />
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
