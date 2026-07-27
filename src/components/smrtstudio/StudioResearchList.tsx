"use client";

/**
 * The research centre — every research artifact in one list, filterable by
 * stage. The filter chips always show counts over the FULL index, not the
 * filtered slice, so switching a filter can never make the totals look
 * different from what is actually on the shelf.
 *
 * `sources` is printed verbatim (LTR, monospace) so a reader can open exactly
 * the file that holds the finding — the deep-link principle applied to files.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { ResearchItem, Stage } from "./types";
import { pick } from "./types";

type Props = {
  items: ResearchItem[];
  counts: Record<string, number>;
  stages: Stage[];
  locale: string;
};

const CROSS = "cross";

export function StudioResearchList({ items, counts, stages, locale }: Props) {
  const t = useTranslations("smrtStudio");
  const [filter, setFilter] = useState<string>("all");

  const stageName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stages) {
      m.set(s.slug, `${String(s.position).padStart(2, "0")} ${pick(locale, s.name_he, s.name_en)}`);
    }
    m.set(CROSS, t("crossStage"));
    return m;
  }, [stages, locale, t]);

  const chips = useMemo(() => {
    const ordered = [...stages.map((s) => s.slug), CROSS].filter((slug) => (counts[slug] ?? 0) > 0);
    return ["all", ...ordered];
  }, [stages, counts]);

  const shown = filter === "all" ? items : items.filter((r) => r.stage_slug === filter);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((slug) => (
          <button
            key={slug}
            type="button"
            onClick={() => setFilter(slug)}
            aria-pressed={slug === filter}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11.5px] transition",
              slug === filter
                ? "border-primary bg-primary font-semibold text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-secondary",
            )}
          >
            {slug === "all" ? t("filterAll") : stageName.get(slug) ?? slug} ·{" "}
            {slug === "all" ? items.length : counts[slug] ?? 0}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noResearch")}</p>
      ) : (
        <ul className="grid">
          {shown.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[1fr_auto] items-start gap-2.5 border-b border-dashed py-2.5 last:border-b-0"
            >
              <div>
                <b className="block text-[12.5px]">{pick(locale, r.title_he, r.title_en)}</b>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                  {pick(locale, r.decides_he, r.decides_en)}
                </span>
                <code
                  dir="ltr"
                  className="mt-1 inline-block rounded bg-secondary px-1.5 py-0.5 text-[9.5px] text-muted-foreground"
                >
                  {r.repo} · {r.sources}
                </code>
              </div>
              <div className="text-end text-[10.5px] tabular-nums text-muted-foreground">
                <span className="block">{stageName.get(r.stage_slug) ?? r.stage_slug}</span>
                {r.verified_at && <span className="block">{r.verified_at}</span>}
                <span className="block">{t(`researchStatus.${r.status}`)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
