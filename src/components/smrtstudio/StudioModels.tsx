"use client";

/**
 * The model catalog — every endpoint fal offers, and what each one can be fed.
 *
 * Navigation is three levels, because one flat list of 1,394 rows is not a
 * catalog, it is a haystack:
 *
 *   Tabs      seven groups (image / video / audio / understanding / 3d /
 *             training / tools), plus TWO that fal does not have and we derive:
 *             audio+video — a video endpoint that accepts an audio file WE
 *             upload, which fal's `audio-to-video` label finds only 19 of;
 *             and pipeline tools — the ffmpeg plumbing fal scatters across four
 *             categories, unfindable among the creative models.
 *   Chips     fal's own categories inside the current tab, then — in the
 *             audio+video tab — the TWO classification axes.
 *   Toggles   what the endpoint can actually be fed, read from its schema.
 *
 * The two axes are independent and that is the point. What our audio DOES
 * (drives the mouth / guides generation / is merely pasted on) is a different
 * question from what the model BUILDS (a whole shot / a moving character / a
 * talking head / a repainted mouth). Collapsing them is how a background-music
 * field gets mistaken for lip-sync.
 *
 * Search stays collapsed behind an icon per the repo's compact-UI rule.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";

import { api } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useOptionalPaneNav } from "@/lib/panes/nav";
import type { ModelsResponse, StudioModel } from "./types";
import { StudioModelDetail } from "./StudioModelDetail";

/** The seven groups, then the two derived tabs. Ordered the way the work flows
 *  rather than alphabetically. */
const GROUPS = ["image", "video", "audio", "understanding", "3d", "training", "tools"] as const;
const DERIVED = ["audio_video", "tools_pipeline"] as const;
const AUDIO_ROLES = ["driving", "reference", "mux"] as const;
const BUILDS = ["full_scene", "full_body", "avatar", "mouth_fix"] as const;
/** Short keys on the wire; the server maps them to columns. `ma` is >1 audio
 *  channel — two characters speaking in one shot. */
const CAPS = ["si", "ei", "pr", "lo", "ma"] as const;

type Tab = (typeof GROUPS)[number] | (typeof DERIVED)[number];

function Chip({
  active,
  disabled,
  tone,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  tone?: "driving" | "reference" | "mux";
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11.5px] transition disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-primary bg-primary font-semibold text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-secondary",
        // Semantic colour only for the audio role, and only when chosen —
        // it carries meaning, so it must not double as generic emphasis.
        active && tone === "driving" && "border-emerald-600 bg-emerald-600",
        active && tone === "reference" && "border-amber-600 bg-amber-600",
        active && tone === "mux" && "border-rose-700 bg-rose-700",
      )}
    >
      {children}
    </button>
  );
}

export function StudioModels() {
  const t = useTranslations("smrtStudio");
  // Reserve the pane's top-inline-end corner for the floating grip so the
  // search/index controls clear it; no-op as a routed page.
  const inPane = useOptionalPaneNav() != null;

  const [tab, setTab] = useState<Tab>("audio_video");
  const [category, setCategory] = useState<string | null>(null);
  const [audioRole, setAudioRole] = useState<string | null>(null);
  const [build, setBuild] = useState<string | null>(null);
  const [caps, setCaps] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [term, setTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [openModel, setOpenModel] = useState<string | null>(null);
  /** Monotonic id of the newest request. Two filter clicks in a row put two
   *  fetches in flight, and without this the slower one can land last and paint
   *  the PREVIOUS filter's rows. */
  const reqId = useRef(0);

  const label = (ns: string, value: string) =>
    t.has(`${ns}.${value}`) ? t(`${ns}.${value}`) : value;

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ group: tab });
      if (category) params.set("category", category);
      if (audioRole) params.set("audio", audioRole);
      if (build) params.set("build", build);
      if (caps.length) params.set("caps", caps.join(","));
      if (verifiedOnly) params.set("verified", "1");
      if (term.trim()) params.set("q", term.trim());
      const res = await api<ModelsResponse>(`/api/studio/models?${params.toString()}`);
      if (mine !== reqId.current) return;
      setData(res);
    } catch (e) {
      if (mine !== reqId.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [tab, category, audioRole, build, caps, verifiedOnly, term]);

  useEffect(() => {
    const id = setTimeout(() => void load(), term ? 250 : 0);
    return () => clearTimeout(id);
  }, [load, term]);

  /** Runs the catalog sweep to completion. Free — it reads fal's catalog and
   *  schema endpoints, never an inference endpoint, so no run is billed.
   *
   *  One press finishes it. The sweep covers ~1394 endpoints at 150 schemas a
   *  round, so this used to mean pressing the button about seven times and
   *  reading a countdown; the server now loops for us. It also runs itself
   *  weekly, so this button is "refresh now", not the mechanism. */
  const runIndex = useCallback(async () => {
    setIndexing(true);
    setIndexNote(null);
    setError(null);
    try {
      const r = await api<{
        catalog_total: number;
        catalog_incomplete: boolean;
        models_written: number;
        audio_probed_total_this_run: number;
        audio_driving_found_this_run: number;
        audio_probe_remaining: number;
        complete: boolean;
        rounds: number;
      }>("/api/studio/models/index", { method: "POST", body: { probe_limit: 150 } });
      setIndexNote(
        [
          t("indexDone", {
            total: r.catalog_total,
            written: r.models_written,
            probed: r.audio_probed_total_this_run,
            driving: r.audio_driving_found_this_run,
            remaining: r.audio_probe_remaining,
          }),
          // A run that hit the deadline or the round cap is NOT a finished one,
          // and must not read like one.
          r.complete ? "" : t("indexPartial", { remaining: r.audio_probe_remaining }),
          // Nor is a catalog pass that never reached fal's own reported total —
          // the previous indexer covered 76% of fal and reported success.
          r.catalog_incomplete ? t("indexIncomplete") : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIndexing(false);
    }
  }, [load, t]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setCategory(null);
    setAudioRole(null);
    setBuild(null);
    setCaps([]);
  };

  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  /** fal's categories present in the current tab, largest first. Data, not a
   *  fixed list — a new fal category appears here without a code change. */
  const categories = useMemo(
    () =>
      Object.entries(data?.category_counts ?? {})
        // The active chip stays even at 0 — otherwise a search term that empties
        // it removes the only control that can clear it, and the filter sticks.
        .filter(([c, n]) => n > 0 || c === category)
        .sort((a, b) => b[1] - a[1]),
    [data, category],
  );

  const priceCell = (m: StudioModel) => {
    if (m.shot_estimate_usd != null) {
      return (
        <>
          <b>${m.shot_estimate_usd.toFixed(2)}</b>
          <span className="block text-[10px] text-muted-foreground">
            {m.shot_estimate_basis === "flat_per_run" ? t("priceFlat") : t("priceShot")}
          </span>
          {m.price_usd != null && (
            <span className="block text-[10px] text-muted-foreground">
              (${m.price_usd} {t("pricePer")} {m.price_unit})
            </span>
          )}
        </>
      );
    }
    if (m.price_usd != null) {
      return (
        <>
          <b>${m.price_usd}</b>
          {m.price_unit && (
            <span className="block text-[10px] text-muted-foreground">
              {t("pricePer")} {m.price_unit}
            </span>
          )}
        </>
      );
    }
    // Never a 0. 763 of fal's endpoints publish no price at all, and a zero in
    // the ledger understates the spend rather than admitting the gap.
    return (
      <span className="text-[10.5px] italic text-muted-foreground">
        {m.price_ambiguous ? t("priceTiered") : t("priceUnpublished")}
      </span>
    );
  };

  const capFlags = (m: StudioModel) => {
    const on: string[] = [];
    if (m.cap_start_image) on.push(t("capShort.si"));
    if (m.cap_end_image) on.push(t("capShort.ei"));
    if (m.cap_prompt) on.push(t("capShort.pr"));
    if (m.cap_lora) on.push(t("capShort.lo"));
    if (m.cap_audio_channels > 1) on.push(t("capShort.ma"));
    if (!on.length) return <span className="text-[10.5px] text-muted-foreground">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {on.map((c) => (
          <span
            key={c}
            className="rounded border border-primary/40 bg-primary/10 px-1 text-[10px] text-primary"
          >
            {c}
          </span>
        ))}
      </span>
    );
  };

  return (
    <div className="grid gap-4">
      <header className={cn("flex flex-wrap items-start justify-between gap-3", inPane && "pe-9")}>
        <div>
          <h1 className="text-xl font-semibold">{t("modelsTitle")}</h1>
          <p className="text-xs text-muted-foreground">{t("modelsSubtitle")}</p>
          <p className="text-[11px] text-muted-foreground">{t("modelsRowHint")}</p>
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
          <Button size="sm" variant="outline" disabled={indexing} onClick={() => void runIndex()}>
            <RefreshCw className={cn("me-1.5 h-3.5 w-3.5", indexing && "animate-spin")} />
            {indexing ? t("indexRunning") : t("indexRun")}
          </Button>
        </div>
      </header>

      {indexNote && (
        <p className="rounded-lg border-s-[3px] border-primary bg-secondary/45 px-3 py-2 text-[11.5px] leading-relaxed">
          {indexNote}
        </p>
      )}

      {data && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t("modelsIndexed"), data.total],
            [t("modelsAudioVideo"), data.audio_video_total],
            [t("modelsAudioDriving"), data.audio_counts?.driving ?? 0],
            [t("modelsMatched"), data.matched],
          ].map(([caption, value]) => (
            <div key={String(caption)} className="rounded-lg border px-3 py-2">
              <p className="text-[11px] text-muted-foreground">{caption}</p>
              <p className="text-lg font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Level 1 — the seven groups plus the two we derive. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b pb-2">
        {GROUPS.map((g) => (
          <Chip key={g} active={tab === g} onClick={() => switchTab(g)}>
            {t(`modelGroup.${g}`)}
            <span className="ms-1 tabular-nums opacity-70">{data?.group_counts?.[g] ?? 0}</span>
          </Chip>
        ))}
        {DERIVED.map((d) => (
          <Chip key={d} active={tab === d} onClick={() => switchTab(d)} title={t(`modelGroupHint.${d}`)}>
            {t(`modelGroup.${d}`)}
            <span className="ms-1 tabular-nums opacity-70">
              {d === "audio_video" ? (data?.audio_video_total ?? 0) : (data?.pipeline_tool_total ?? 0)}
            </span>
          </Chip>
        ))}
      </div>

      {/* Level 2 — fal's categories, then the two axes when they apply. */}
      <div className="grid gap-2">
        {categories.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-[6.5rem] text-[11px] text-muted-foreground">
              {t("filterCategory")}
            </span>
            {categories.map(([c, n]) => (
              <Chip
                key={c}
                active={category === c}
                disabled={n === 0 && category !== c}
                onClick={() => setCategory(category === c ? null : c)}
              >
                {label("falCategory", c)}
                <span className="ms-1 tabular-nums opacity-70">{n}</span>
              </Chip>
            ))}
          </div>
        )}

        {tab === "audio_video" && (
          <>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("axesNote")}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-[6.5rem] text-[11px] text-muted-foreground">
                {t("filterAudioAxis")}
              </span>
              {AUDIO_ROLES.map((r) => (
                <Chip
                  key={r}
                  tone={r}
                  active={audioRole === r}
                  disabled={(data?.audio_counts?.[r] ?? 0) === 0 && audioRole !== r}
                  title={t(`audioRoleHint.${r}`)}
                  onClick={() => {
                    const next = audioRole === r ? null : r;
                    setAudioRole(next);
                    // Axis 2 describes what a DRIVING model builds. A model that
                    // only pastes a track on has nothing to build, so the axis
                    // is meaningless there and is cleared rather than left
                    // filtering silently.
                    if (next && next !== "driving") setBuild(null);
                  }}
                >
                  {t(`audioRole.${r}`)}
                  <span className="ms-1 tabular-nums opacity-70">{data?.audio_counts?.[r] ?? 0}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-[6.5rem] text-[11px] text-muted-foreground">
                {t("filterBuildAxis")}
              </span>
              {BUILDS.map((b) => (
                <Chip
                  key={b}
                  active={build === b}
                  disabled={
                    (Boolean(audioRole) && audioRole !== "driving") ||
                    ((data?.build_counts?.[b] ?? 0) === 0 && build !== b)
                  }
                  title={t(`buildHint.${b}`)}
                  onClick={() => setBuild(build === b ? null : b)}
                >
                  {t(`build.${b}`)}
                  <span className="ms-1 tabular-nums opacity-70">{data?.build_counts?.[b] ?? 0}</span>
                </Chip>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-[6.5rem] text-[11px] text-muted-foreground">{t("filterCaps")}</span>
          {CAPS.map((c) => (
            <Chip
              key={c}
              active={caps.includes(c)}
              disabled={(data?.cap_counts?.[c] ?? 0) === 0 && !caps.includes(c)}
              onClick={() => toggleCap(c)}
            >
              {t(`cap.${c}`)}
              <span className="ms-1 tabular-nums opacity-70">{data?.cap_counts?.[c] ?? 0}</span>
            </Chip>
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
          {data && data.total === 0
            ? t("modelsEmptyCatalog")
            : // A half-probed catalog is empty here for a reason the operator
              // cannot guess: the audio+video tab needs the schema probe, and
              // one press covers 150 of ~1394. Say so instead of "no match",
              // which reads as "fal has nothing like this".
              data && data.audio_probed_total < data.total
              ? t("modelsProbeIncomplete", {
                  probed: data.audio_probed_total,
                  total: data.total,
                })
              : t("modelsNoMatch")}
        </p>
      ) : (
        <div
          className={cn(
            "overflow-x-auto rounded-xl border transition-opacity",
            loading && "pointer-events-none opacity-50",
          )}
          aria-busy={loading}
        >
          <table className="w-full min-w-[860px] text-xs">
            <thead className="bg-secondary/55 text-[10.5px] uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">{t("colModel")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colVendor")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colClass")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colPrice")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colCaps")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("colPublished")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setOpenModel(m.endpoint_id)}
                  aria-selected={m.endpoint_id === openModel}
                  className={cn(
                    "cursor-pointer border-t align-top hover:bg-secondary/50",
                    // A left stripe encodes the audio role in FORM as well as
                    // colour, so it survives a colour-blind reader and a
                    // grayscale print.
                    "border-s-[3px] border-s-transparent",
                    m.audio_input === "driving" && "border-s-emerald-600",
                    m.audio_input === "reference" && "border-s-amber-600",
                    m.audio_input === "mux" && "border-s-rose-700",
                    m.endpoint_id === openModel && "bg-secondary/60",
                  )}
                >
                  <td className="px-3 py-2">
                    <b className="block">{m.title || m.endpoint_id}</b>
                    <code dir="ltr" className="block text-[10px] text-muted-foreground">
                      {m.endpoint_id}
                    </code>
                    {m.family && (
                      <span className="mt-0.5 inline-block rounded border bg-secondary/60 px-1 text-[10px] text-muted-foreground">
                        {m.family}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{m.vendor || "—"}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-1">
                      {m.audio_input ? (
                        <Badge variant={m.audio_input === "driving" ? "default" : "secondary"}>
                          {t(`audioRole.${m.audio_input}`)}
                        </Badge>
                      ) : (
                        <Badge variant="outline">{label("falCategory", m.fal_category)}</Badge>
                      )}
                      {m.audio_build && (
                        <Badge variant="outline">{t(`build.${m.audio_build}`)}</Badge>
                      )}
                    </span>
                    {m.audio_classified_from === "model_purpose" && (
                      <span className="mt-1 block text-[10px] leading-snug text-muted-foreground">
                        {t("audioFromPurpose")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{priceCell(m)}</td>
                  <td className="px-3 py-2">{capFlags(m)}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {m.published_at || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openModel && (
        <StudioModelDetail endpointId={openModel} onClose={() => setOpenModel(null)} />
      )}

      <details className="rounded-lg border bg-secondary/30 px-3 py-2">
        <summary className="cursor-pointer text-[11.5px] font-semibold">
          {t("shelfMeaningTitle")}
        </summary>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("modelsShelfNote").replace(/\*\*/g, "")}
        </p>
      </details>

      {data && data.returned < data.matched && (
        <p className="text-[11px] text-muted-foreground">
          {t("modelsTruncated", { shown: data.returned, matched: data.matched })}
        </p>
      )}
    </div>
  );
}
