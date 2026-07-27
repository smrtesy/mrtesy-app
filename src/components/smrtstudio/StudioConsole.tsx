"use client";

/**
 * smrtStudio — the operator console.
 *
 * One screen with everything the operator needs to plan, build and run the
 * program day to day: what is waiting right now, the pipeline with every
 * stage's gates and difficulties, the research centre, and the honest cost
 * picture including what is missing from it.
 *
 * Every number is computed live from the production tables by
 * /api/studio/overview — nothing on this screen is denormalized or hand-kept.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { api } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PaneLink } from "@/lib/panes/nav";

import { StudioPipeline } from "./StudioPipeline";
import { StudioResearchList } from "./StudioResearchList";
import type { Overview, ResearchResponse } from "./types";

export function StudioConsole() {
  const t = useTranslations("smrtStudio");
  const locale = useLocale();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [research, setResearch] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, r] = await Promise.all([
        api<Overview>("/api/studio/overview"),
        api<ResearchResponse>("/api/studio/research"),
      ]);
      setOverview(o);
      setResearch(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

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

  if (!overview) return null;

  const { totals } = overview;
  const unscored = totals.runs - totals.scores;
  const unapprovedTakes = totals.voice_takes - totals.voice_approved;

  const waiting: { n: number; title: string; sub: string }[] = [];
  if (unscored > 0) {
    waiting.push({ n: unscored, title: t("waitScore"), sub: t("waitScoreSub") });
  }
  if (unapprovedTakes > 0) {
    waiting.push({
      n: unapprovedTakes,
      title: t("waitTakes"),
      sub: t("waitTakesSub", { total: totals.voice_takes, approved: totals.voice_approved }),
    });
  }
  const missingCost = totals.runs_missing_cost + totals.voice_missing_cost;
  // A capped take page means the recorded sum covers only part of the rows —
  // say so rather than presenting a partial total as complete.
  const costPartial = missingCost > 0 || totals.voice_cost_partial;
  if (missingCost > 0) {
    waiting.push({ n: missingCost, title: t("waitCost"), sub: t("waitCostSub") });
  }

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PaneLink
            href="/studio/models"
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            {t("navModels")}
          </PaneLink>
          <PaneLink
            href="/studio/research"
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            {t("navResearch")}
          </PaneLink>
          <PaneLink
            href="/studio/investor"
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            {t("navInvestor")}
          </PaneLink>
          <Button size="sm" variant="ghost" onClick={() => void load()} aria-label={t("retry")}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {waiting.length > 0 && (
        <section className="rounded-xl border bg-card p-3">
          <h2 className="mb-2 text-sm font-semibold">{t("waitingTitle")}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {waiting.map((w) => (
              <div key={w.title} className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
                <span className="text-lg font-bold tabular-nums leading-none">{w.n}</span>
                <span>
                  <b className="block text-xs">{w.title}</b>
                  <span className="text-[11px] text-muted-foreground">{w.sub}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">{t("pipelineTitle")}</h2>
            <p className="text-[11px] text-muted-foreground">{t("pipelineHint")}</p>
          </div>
          <Badge variant="outline">
            {t("lockedOf", { done: totals.stages_locked, total: totals.stages_total })}
          </Badge>
        </header>
        <div className="p-3">
          <StudioPipeline
            stages={overview.stages}
            research={research?.items ?? []}
            locale={locale}
          />
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">{t("researchTitle")}</h2>
            <p className="text-[11px] text-muted-foreground">{t("researchHint")}</p>
          </div>
          <Badge variant="secondary">{t("researchCount", { n: research?.total ?? 0 })}</Badge>
        </header>
        <div className="p-3">
          <StudioResearchList
            items={research?.items ?? []}
            counts={research?.counts ?? {}}
            stages={overview.stages}
            locale={locale}
          />
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">{t("costTitle")}</h2>
          {costPartial && <Badge variant="outline">{t("costPartial")}</Badge>}
        </header>
        <div className="p-3">
          <dl className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border px-3 py-2">
              <dt className="text-[11px] text-muted-foreground">{t("costRecorded")}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                ${totals.recorded_cost_usd.toFixed(2)}
              </dd>
            </div>
            <div className="rounded-lg border px-3 py-2">
              <dt className="text-[11px] text-muted-foreground">{t("costRuns")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{totals.runs}</dd>
            </div>
            <div className="rounded-lg border px-3 py-2">
              <dt className="text-[11px] text-muted-foreground">{t("costMissing")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{missingCost}</dd>
            </div>
          </dl>
          {costPartial && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              {t("costNote")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
