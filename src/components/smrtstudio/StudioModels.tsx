"use client";

/**
 * The model catalog — two tiers in one screen.
 *
 * The shelf is the whole fal catalog, auto-indexed by kind. The deep tier is
 * the subset whose official OpenAPI schema we actually pulled, which is what
 * `verified_schema` means and why it is a filter of its own: "listed by fal"
 * and "we verified the contract" are different claims and the screen never
 * blurs them.
 *
 * Search is collapsed behind an icon per the repo's compact-UI rule — no
 * permanent toolbar sitting above the content.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X, ShieldCheck, AlertTriangle } from "lucide-react";

import { api } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ModelsResponse } from "./types";

const KINDS = ["all", "image", "video", "lipsync", "voice", "qc", "other"] as const;

export function StudioModels() {
  const t = useTranslations("smrtStudio");

  const [kind, setKind] = useState<string>("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [term, setTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** A catalog row's `kind` comes from the DB and may be a value the messages
   *  file does not know yet (a new bucket added by an indexer run). Show the
   *  raw value rather than throwing on a missing key. */
  const kindLabel = (value: string) =>
    t.has(`modelKind.${value}`) ? t(`modelKind.${value}`) : value;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind !== "all") params.set("kind", kind);
      if (verifiedOnly) params.set("verified", "1");
      if (term.trim()) params.set("q", term.trim());
      setData(await api<ModelsResponse>(`/api/studio/models?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kind, verifiedOnly, term]);

  useEffect(() => {
    const id = setTimeout(() => void load(), term ? 250 : 0);
    return () => clearTimeout(id);
  }, [load, term]);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("modelsTitle")}</h1>
          <p className="text-xs text-muted-foreground">{t("modelsSubtitle")}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {searchOpen ? (
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setTerm("");
                    setSearchOpen(false);
                  }
                }}
                placeholder={t("modelsSearchPlaceholder")}
                className="h-8 w-52 text-xs"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("close")}
                onClick={() => {
                  setTerm("");
                  setSearchOpen(false);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("modelsSearch")}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      {data && (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("modelsIndexed")}</p>
            <p className="text-lg font-semibold tabular-nums">{data.total}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("modelsVerified")}</p>
            <p className="text-lg font-semibold tabular-nums">{data.verified_total}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("modelsMatched")}</p>
            <p className="text-lg font-semibold tabular-nums">{data.matched}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={k === kind}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11.5px] transition",
              k === kind
                ? "border-primary bg-primary font-semibold text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-secondary",
            )}
          >
            {t(`modelKind.${k}`)}
            {k !== "all" && data ? ` · ${data.counts[k] ?? 0}` : ""}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setVerifiedOnly((v) => !v)}
          aria-pressed={verifiedOnly}
          className={cn(
            "ms-1 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition",
            verifiedOnly
              ? "border-primary bg-primary font-semibold text-primary-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-secondary",
          )}
        >
          <ShieldCheck className="h-3 w-3" />
          {t("modelsVerifiedOnly")}
        </button>
      </div>

      {error && (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      {loading && !data ? (
        <Skeleton className="h-64 w-full" />
      ) : !data || data.items.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-6 text-center text-xs text-muted-foreground">
          {data && data.total === 0 ? t("modelsEmptyCatalog") : t("modelsNoMatch")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-secondary/55 text-[10.5px] uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">{t("colModel")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colKind")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colVendor")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colPrice")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colVerified")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <b className="block">{m.title || m.endpoint_id}</b>
                    <code dir="ltr" className="text-[10px] text-muted-foreground">
                      {m.endpoint_id}
                    </code>
                    {m.shortlist_rank != null && (
                      <Badge variant="secondary" className="ms-1.5 align-middle">
                        #{m.shortlist_rank}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">{kindLabel(m.kind)}</td>
                  <td className="px-3 py-2">{m.vendor || "—"}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {m.price_usd != null ? `$${m.price_usd}` : "—"}
                    {m.price_unit && (
                      <span className="block text-[10px] text-muted-foreground">{m.price_unit}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {m.verified_schema ? (
                      <Badge variant="default">{t("verifiedYes")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("verifiedNo")}</Badge>
                    )}
                    {m.verified_at && (
                      <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                        {m.verified_at}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("modelsShelfNote")}</p>

      {data && data.returned < data.matched && (
        <p className="text-[11px] text-muted-foreground">
          {t("modelsTruncated", { shown: data.returned, matched: data.matched })}
        </p>
      )}
    </div>
  );
}
