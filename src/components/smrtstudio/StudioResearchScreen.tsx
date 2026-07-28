"use client";

/**
 * The research centre as a screen of its own — the same list the console
 * embeds, given room to breathe plus the scope numbers that say how wide the
 * survey actually went.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { StudioResearchList } from "./StudioResearchList";
import type { StudioOverview, ResearchResponse } from "./types";

export function StudioResearchScreen() {
  const t = useTranslations("smrtStudio");
  const locale = useLocale();

  const [research, setResearch] = useState<ResearchResponse | null>(null);
  const [overview, setOverview] = useState<StudioOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, o] = await Promise.all([
        api<ResearchResponse>("/api/studio/research"),
        api<StudioOverview>("/api/studio/overview"),
      ]);
      setResearch(r);
      setOverview(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !research) return <Skeleton className="h-96 w-full" />;

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4" />
          {t("loadFailed")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          <RefreshCw className="me-1.5 h-3.5 w-3.5" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-xl font-semibold">{t("researchTitle")}</h1>
        <p className="text-xs text-muted-foreground">{t("researchHint")}</p>
      </header>

      <div className="rounded-xl border bg-card p-3">
        <StudioResearchList
          items={research?.items ?? []}
          counts={research?.counts ?? {}}
          stages={overview?.stages ?? []}
          locale={locale}
        />
      </div>
    </div>
  );
}
