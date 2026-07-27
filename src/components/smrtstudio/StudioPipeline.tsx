"use client";

/**
 * The pipeline — the centrepiece of both smrtStudio screens.
 *
 * Ten stage tiles, each with a bar that fills by how many of the gates that
 * stage must pass are already done. Selecting a tile opens the full detail:
 * the gates themselves, the difficulties split into expected-versus-actually-hit
 * (solved ones marked, with the line explaining how), the research that belongs
 * to the stage, and the stage's outputs.
 *
 * Rendered identically on the operator console and the investor page; the only
 * difference is the language the parent passes in.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Challenge, ResearchItem, Stage } from "./types";
import { pick } from "./types";

type Props = {
  stages: Stage[];
  research: ResearchItem[];
  locale: string;
  /** Slug of the initially selected stage; defaults to the furthest-along one. */
  initialSlug?: string;
};

function barColor(hue: number): string {
  return `hsl(${hue} 62% 45%)`;
}

function ChallengeList({
  items,
  locale,
  emptyText,
  solvedPrefix,
}: {
  items: Challenge[];
  locale: string;
  emptyText: string;
  solvedPrefix: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground leading-relaxed">{emptyText}</p>;
  }
  return (
    <ul className="grid gap-2">
      {items.map((c) => (
        <li key={c.id} className="grid grid-cols-[14px_1fr] gap-2 items-start">
          <span
            className={cn(
              "mt-0.5 grid h-3.5 w-3.5 place-items-center rounded border text-[8px] font-bold",
              c.solved
                ? "border-[hsl(var(--status-ok))] bg-[hsl(var(--status-ok))] text-white"
                : "border-border text-transparent",
            )}
            aria-hidden
          >
            <Check className="h-2.5 w-2.5" />
          </span>
          <span className="text-xs leading-relaxed">
            <b className={cn("font-semibold", c.solved && "text-muted-foreground font-medium")}>
              {pick(locale, c.title_he, c.title_en)}
            </b>
            {pick(locale, c.detail_he, c.detail_en) && (
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {c.solved ? `${solvedPrefix} ` : ""}
                {pick(locale, c.detail_he, c.detail_en)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StudioPipeline({ stages, research, locale, initialSlug }: Props) {
  const t = useTranslations("smrtStudio");

  const defaultSlug = useMemo(() => {
    if (initialSlug && stages.some((s) => s.slug === initialSlug)) return initialSlug;
    const withWork = [...stages].sort((a, b) => b.outputs - a.outputs)[0];
    return withWork?.slug ?? stages[0]?.slug ?? "";
  }, [initialSlug, stages]);

  const [selected, setSelected] = useState(defaultSlug);
  const stage = stages.find((s) => s.slug === selected) ?? stages[0];

  const stageResearch = useMemo(
    () => research.filter((r) => r.stage_slug === stage?.slug),
    [research, stage?.slug],
  );

  if (!stage) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => setSelected(s.slug)}
            aria-pressed={s.slug === selected}
            className={cn(
              "relative rounded-xl border bg-card px-2 py-3 text-center transition",
              "hover:-translate-y-px hover:border-primary/45",
              s.slug === selected ? "border-primary ring-[3px] ring-primary/12" : "border-border",
            )}
          >
            <span className="absolute start-2.5 top-2 text-[9.5px] font-bold tabular-nums text-muted-foreground">
              {String(s.position).padStart(2, "0")}
            </span>
            <span className="mt-1 block text-xs font-semibold leading-tight">
              {pick(locale, s.name_he, s.name_en)}
            </span>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full transition-[width]"
                style={{ width: `${s.progress_pct}%`, background: barColor(s.hue) }}
              />
            </span>
            <span className="mt-1.5 block text-[10px] tabular-nums text-muted-foreground">
              {t("gatesOf", { done: s.gates_done, total: s.gates_total })}
            </span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-secondary/55 px-3 py-2.5">
          <div>
            <b className="text-sm">
              {String(stage.position).padStart(2, "0")} · {pick(locale, stage.name_he, stage.name_en)}
            </b>
            <p className="text-[11.5px] text-muted-foreground">
              {pick(locale, stage.blurb_he, stage.blurb_en)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{t(`activity.${stage.activity}`)}</Badge>
            <Badge variant={stage.decision_state === "none" ? "outline" : "default"}>
              {t("decisionLabel", { state: t(`decision.${stage.decision_state}`) })}
            </Badge>
          </div>
        </div>

        <div className="grid gap-3 p-3">
          <section className="rounded-lg border bg-card">
            <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-bold">
              <span>{t("gatesTitle")}</span>
              <span className="font-semibold text-muted-foreground">
                {t("gatesOf", { done: stage.gates_done, total: stage.gates_total })}
              </span>
            </header>
            <ul className="grid gap-2 p-3">
              {stage.gates.map((g) => (
                <li key={g.id} className="grid grid-cols-[14px_1fr] items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 grid h-3.5 w-3.5 place-items-center rounded border",
                      g.done
                        ? "border-[hsl(var(--status-ok))] bg-[hsl(var(--status-ok))] text-white"
                        : "border-border text-transparent",
                    )}
                    aria-hidden
                  >
                    <Check className="h-2.5 w-2.5" />
                  </span>
                  <span className={cn("text-xs leading-relaxed", g.done && "text-muted-foreground")}>
                    {pick(locale, g.label_he, g.label_en)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-lg border bg-card">
              <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-bold">
                <span>{t("challengesExpected")}</span>
                <span className="font-semibold text-muted-foreground">
                  {t("solvedOf", {
                    done: stage.challenges_expected.filter((c) => c.solved).length,
                    total: stage.challenges_expected.length,
                  })}
                </span>
              </header>
              <div className="p-3">
                <ChallengeList
                  items={stage.challenges_expected}
                  locale={locale}
                  emptyText={t("noChallengesMapped")}
                  solvedPrefix={t("solvedPrefix")}
                />
              </div>
            </section>

            <section className="rounded-lg border bg-card">
              <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-bold">
                <span>{t("challengesHit")}</span>
                <span className="font-semibold text-muted-foreground">
                  {t("solvedOf", {
                    done: stage.challenges_hit.filter((c) => c.solved).length,
                    total: stage.challenges_hit.length,
                  })}
                </span>
              </header>
              <div className="p-3">
                <ChallengeList
                  items={stage.challenges_hit}
                  locale={locale}
                  emptyText={t("noChallengesHit")}
                  solvedPrefix={t("solvedPrefix")}
                />
              </div>
            </section>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-lg border bg-card">
              <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-bold">
                <span>{t("stageResearch")}</span>
                <span className="font-semibold text-muted-foreground">{stageResearch.length}</span>
              </header>
              <div className="grid gap-2.5 p-3">
                {stageResearch.length === 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("noResearch")}</p>
                ) : (
                  stageResearch.map((r) => (
                    <div key={r.id} className="border-s-2 border-primary/45 ps-2.5">
                      <b className="block text-xs">{pick(locale, r.title_he, r.title_en)}</b>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                        {pick(locale, r.decides_he, r.decides_en)}
                      </span>
                      <code
                        dir="ltr"
                        className="mt-1 inline-block rounded bg-secondary px-1.5 py-0.5 text-[9.5px] text-muted-foreground"
                      >
                        {r.sources}
                      </code>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border bg-card">
              <header className="border-b px-3 py-2 text-[11px] font-bold">{t("stageOutputs")}</header>
              <dl className="grid p-3">
                {[
                  [t("outOutputs"), String(stage.outputs)],
                  [t("outScored"), String(stage.scored)],
                  [t("outModels"), String(stage.models_run.length)],
                  [t("outCost"), `$${stage.cost_usd.toFixed(2)}`],
                  [t("outMissingCost"), String(stage.runs_missing_cost)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-2 border-b border-dashed py-1.5 text-xs last:border-b-0"
                  >
                    <dt>{label}</dt>
                    <dd className="font-semibold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>

          <p className="rounded-lg border bg-secondary/40 px-3 py-2 text-xs leading-relaxed">
            {pick(locale, stage.note_he, stage.note_en)}
          </p>
        </div>
      </div>
    </div>
  );
}
