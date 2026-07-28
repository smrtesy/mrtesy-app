"use client";

/**
 * One model, in full.
 *
 * The screen is organised by WHERE each claim comes from, because that is the
 * distinction the program runs on:
 *
 *   Our record  — rank, stage, price, and the audio-role verdict with fal's own
 *                 wording printed beside it as the evidence.
 *   The method  — the written recipe: when to use it, how to feed it, prompt
 *                 structure, tricks and limits.
 *   The settings — every input field, read LIVE from fal's official schema on
 *                 this request. Never a stored copy, so it cannot go stale.
 *
 * Enum fields are called out rather than buried: `duration` being a closed set
 * per model is exactly why the pipeline plans an intent and derives the cut per
 * tool instead of assuming one clip length everywhere.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ExternalLink, X } from "lucide-react";

import { api } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { StudioModel } from "./types";

type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enum: string[] | null;
  default: string | null;
};

type Detail = {
  model: StudioModel;
  recipe: {
    file: string;
    title: string;
    note: string;
    sections: { heading: string; body: string }[];
  } | null;
  schema: { endpoint_id: string; available: boolean; fields: SchemaField[] };
  links: { fal: string; schema: string; recipe: string | null };
};

export function StudioModelDetail({
  endpointId,
  onClose,
}: {
  endpointId: string;
  onClose: () => void;
}) {
  const t = useTranslations("smrtStudio");
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api<Detail>(
          `/api/studio/models/detail?endpoint_id=${encodeURIComponent(endpointId)}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [endpointId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b bg-secondary/45 px-3 py-2.5">
        <div className="min-w-0">
          <b className="text-sm">{data?.model.title || endpointId}</b>
          <code dir="ltr" className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
            {endpointId}
          </code>
        </div>
        <Button size="sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      <div className="p-3">
        {loading && !data ? (
          <Skeleton className="h-48 w-full" />
        ) : error ? (
          <p className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : !data ? null : (
          <div className="grid gap-3">
            {/* ── our record ── */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [t("detailStage"), data.model.stage_slug ? t(`stageName.${data.model.stage_slug}`) : "—"],
                [t("detailKind"), t.has(`modelKind.${data.model.kind}`) ? t(`modelKind.${data.model.kind}`) : data.model.kind],
                [t("detailRank"), data.model.shortlist_rank != null ? `#${data.model.shortlist_rank}` : "—"],
                [t("detailHosting"), data.model.hosting_type || "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border px-3 py-2">
                  <p className="text-[10.5px] text-muted-foreground">{label}</p>
                  <p className="text-xs font-semibold">{value}</p>
                </div>
              ))}
            </div>

            {/* The audio verdict, with fal's wording as its evidence. A claim
                this decision-relevant is never shown without its source. */}
            {data.model.audio_input && (
              <div className="rounded-lg border-s-[3px] border-primary bg-secondary/40 px-3 py-2.5">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                  {t("detailAudioVerdict")}
                  <Badge variant={data.model.audio_input === "driving" ? "default" : "secondary"}>
                    {t(`audioRole.${data.model.audio_input}`)}
                  </Badge>
                </p>
                {data.model.audio_note && (
                  <p dir="ltr" className="mt-1.5 text-start text-[11px] leading-relaxed text-muted-foreground">
                    <code className="rounded bg-secondary px-1 py-0.5">{data.model.audio_field}</code>{" "}
                    {data.model.audio_note}
                  </p>
                )}
                <p className="mt-1.5 text-[10.5px] text-muted-foreground">{t("detailAudioEvidence")}</p>
              </div>
            )}

            {data.model.price_note && (
              <div className="rounded-lg border px-3 py-2">
                <p className="mb-1 text-[10.5px] font-semibold text-muted-foreground">
                  {t("detailPricing")}
                </p>
                <p dir="ltr" className="text-start text-[11px] leading-relaxed">
                  {data.model.price_note}
                </p>
              </div>
            )}

            {/* ── the settings: live from fal ── */}
            <div className="rounded-lg border">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <span className="text-[11px] font-bold">{t("detailSettings")}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {data.schema.available
                    ? t("detailSettingsLive", { n: data.schema.fields.length })
                    : t("detailSettingsUnavailable")}
                </span>
              </header>
              {data.schema.available && data.schema.fields.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[540px] text-xs" dir="ltr">
                    <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-1.5 text-start font-semibold">{t("colField")}</th>
                        <th className="px-3 py-1.5 text-start font-semibold">{t("colType")}</th>
                        <th className="px-3 py-1.5 text-start font-semibold">{t("colDefault")}</th>
                        <th className="px-3 py-1.5 text-start font-semibold">{t("colMeaning")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.schema.fields.map((f) => (
                        <tr key={f.name} className="border-t align-top">
                          <td className="px-3 py-1.5">
                            <code className={cn("text-[11px]", f.required && "font-bold")}>
                              {f.name}
                            </code>
                            {f.required && <span className="ms-1 text-destructive">*</span>}
                          </td>
                          <td className="px-3 py-1.5 text-[10.5px] text-muted-foreground">
                            {f.type || "—"}
                            {/* A closed set is the single most decision-relevant
                                fact about a field — surfaced, not hidden. */}
                            {f.enum && (
                              <span className="mt-0.5 block">
                                {f.enum.map((v) => (
                                  <Badge key={v} variant="outline" className="me-1 text-[9.5px]">
                                    {v}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-[10.5px] text-muted-foreground">
                            {f.default !== null ? (
                              <code className="break-all">{f.default}</code>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
                            {f.description || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-3 py-3 text-[11.5px] text-muted-foreground">
                  {t("detailSettingsUnavailableLong")}
                </p>
              )}
            </div>

            {/* ── the method ── */}
            {data.recipe ? (
              <div className="rounded-lg border">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="text-[11px] font-bold">{t("detailMethod")}</span>
                  {data.recipe.note && (
                    <span className="text-[10.5px] text-muted-foreground">{data.recipe.note}</span>
                  )}
                </header>
                <div className="grid gap-3 p-3">
                  {data.recipe.sections.map((sec) => (
                    <div key={sec.heading}>
                      <p className="text-[11.5px] font-semibold">{sec.heading}</p>
                      <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted-foreground">
                        {sec.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="rounded-lg border bg-secondary/30 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {t("detailNoRecipe")}
              </p>
            )}

            {/* ── the originals, verbatim ── */}
            <div className="flex flex-wrap gap-2">
              {[
                [t("linkFal"), data.links.fal],
                [t("linkSchema"), data.links.schema],
                ...(data.links.recipe ? [[t("linkRecipe"), data.links.recipe]] : []),
              ].map(([label, href]) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] hover:bg-secondary"
                >
                  {label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
