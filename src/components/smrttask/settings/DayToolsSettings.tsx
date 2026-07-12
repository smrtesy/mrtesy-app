"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { DAY_TOOLS, resolveTool } from "@/lib/smrttask/day-tools";
import { useDayTools } from "@/hooks/useDayTools";

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
          const enabled = resolveTool(state, tool.slug).enabled;
          const id = `daytool-${tool.slug}`;
          return (
            <div key={tool.slug} className="flex items-start justify-between gap-4">
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
          );
        })}
      </CardContent>
    </Card>
  );
}
