"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

type MyScore = { dimension: string; score: number; locked: boolean };

type QcStatus = "pending" | "pass" | "rejected";

type Run = {
  id: string;
  code: string;
  output_url: string | null;
  model: string | null;
  scene: string | null;
  variation: number | null;
  seed: number | null;
  prompt: string | null;
  qc_status: QcStatus;
  qc_score: number | null;
  qc_reason: string | null;
  qc_scores: Record<string, number>;
  overridden: boolean;
  my_scores: MyScore[];
  /** Grid keys from the server: which column (model) and which row (shot). */
  model_key: number;
  shot_key: string;
  /** The locked reference this run was anchored to (pinned for comparison). */
  reference_url: string | null;
};

type RunsResponse = { runs: Run[]; revealed: boolean };

type QcFilter = "all" | "pass" | "rejected" | "pending";

/** Dimensions to score per test. Lip-sync tests get the full rubric; everything
 *  else is a single "overall" score. Kept minimal per repo UI conventions. */
function dimensionsFor(testLabel: string | null): string[] {
  if (testLabel && testLabel.toLowerCase().includes("lipsync")) {
    return ["consistency", "motion", "quality", "lipsync"];
  }
  return ["overall"];
}

function isVideo(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/** Compact per-metric line, e.g. "dino 0.84 · clip_i 0.83". */
function formatMetrics(scores: Record<string, number> | null | undefined): string {
  if (!scores) return "";
  return Object.entries(scores)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k, v]) => `${k} ${Math.round(v * 100) / 100}`)
    .join(" · ");
}

/** Comparison-grid geometry: one column per model, sized to the image so at
 *  least five columns fit on a normal screen (5 × 232 + label ≈ 1240px). */
const COL_W = 232;

/** Row label from the server's shot_key ("s:kitchen" → "kitchen"). */
function shotLabel(shotKey: string): string {
  return shotKey.replace(/^[svdr]:/, "");
}

/** The row header is set sideways so it costs almost no width. Reading direction
 *  follows the label's own script: Latin reads bottom-to-top (vertical-rl turned
 *  180°), Hebrew reads top-to-bottom (vertical-rl as-is). */
function sidewaysClass(label: string): string {
  const hasHebrew = /[֐-׿]/.test(label);
  return hasHebrew
    ? "[writing-mode:vertical-rl] whitespace-nowrap"
    : "[writing-mode:vertical-rl] rotate-180 whitespace-nowrap";
}

export function ExperimentScoring({
  planId,
  testLabel,
}: {
  planId: string | null;
  testLabel: string | null;
}) {
  const t = useTranslations("experiments");
  const [runs, setRuns] = useState<Run[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [qcFilter, setQcFilter] = useState<QcFilter>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<Run | null>(null);
  const dimensions = dimensionsFor(testLabel);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (planId) params.set("plan_id", planId);
    if (testLabel) params.set("test_label", testLabel);
    const r = await api<RunsResponse>(`/api/experiments/runs?${params.toString()}`);
    setRuns(r.runs ?? []);
    setRevealed(!!r.revealed);
  }, [planId, testLabel]);

  useEffect(() => {
    if (!planId) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    load()
      .catch((e) => alive && toast.error(e instanceof Error ? e.message : t("loadError")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load, t, planId]);

  // Esc closes the lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const filteredRuns = useMemo(
    () => (qcFilter === "all" ? runs : runs.filter((r) => r.qc_status === qcFilter)),
    [runs, qcFilter],
  );

  /** Pivot the flat run list into the comparison grid: a stable column per
   *  model, a row per shot, and the run that sits in each cell. */
  const grid = useMemo(() => {
    // Columns: one per model, keyed by the server's stable model_key.
    const cols = [...new Set(filteredRuns.map((r) => r.model_key))].sort((a, b) => a - b);
    // A cell holds a LIST: a model can have several runs for the same shot —
    // repeats (task 7 runs 3 per combination) or a re-run. Never drop one.
    const rowMap = new Map<string, { cells: Map<number, Run[]>; reference: string | null }>();
    for (const r of filteredRuns) {
      if (!rowMap.has(r.shot_key)) rowMap.set(r.shot_key, { cells: new Map(), reference: null });
      const row = rowMap.get(r.shot_key)!;
      const list = row.cells.get(r.model_key);
      if (list) list.push(r);
      else row.cells.set(r.model_key, [r]);
      if (!row.reference && r.reference_url) row.reference = r.reference_url;
    }
    const rows = [...rowMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true }),
    );
    // Column header: the model name — nothing is hidden (rule 9).
    const nameFor = (key: number) =>
      filteredRuns.find((r) => r.model_key === key)?.model ?? null;
    return { cols, rows, nameFor };
  }, [filteredRuns]);

  function scoreFor(run: Run, dimension: string): number | null {
    const hit = run.my_scores.find((s) => s.dimension === dimension);
    return hit ? hit.score : null;
  }

  async function setScore(run: Run, dimension: string, score: number) {
    setRuns((prev) =>
      prev.map((r) => {
        if (r.id !== run.id) return r;
        const others = r.my_scores.filter((s) => s.dimension !== dimension);
        return { ...r, my_scores: [...others, { dimension, score, locked: false }] };
      }),
    );
    try {
      await api("/api/experiments/scores", {
        method: "POST",
        body: { run_id: run.id, dimension, score },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("saveError"));
      await load();
    }
  }

  async function toggleOverride(run: Run) {
    const next = !run.overridden;
    setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, overridden: next } : r)));
    try {
      await api("/api/experiments/override", {
        method: "POST",
        body: { run_id: run.id, overridden: next },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("saveError"));
      await load();
    }
  }

  async function reveal() {
    if (!testLabel) return;
    try {
      await api("/api/experiments/reveal", {
        method: "POST",
        body: { plan_id: planId ?? undefined, test_label: testLabel },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("saveError"));
    }
  }

  const filters: QcFilter[] = ["all", "pass", "rejected", "pending"];

  // The screen belongs to a plan: without one there is nothing to compare.
  if (!planId) {
    return (
      <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] text-muted-foreground">
        {t("needPlan")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t("title")}</h1>
          <p className="text-[12.5px] text-muted-foreground">{t("lead")}</p>
        </div>
        {testLabel ? (
          revealed ? (
            <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-[12px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              {t("revealed")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void reveal()}
              className="shrink-0 rounded-md border border-input bg-background px-3 py-1.5 text-[13px] font-medium hover:bg-accent"
            >
              {t("reveal")}
            </button>
          )
        ) : null}
      </div>

      {/* QC filter — compact segmented control */}
      <div className="inline-flex rounded-md border border-input bg-background p-0.5 text-[12px]">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setQcFilter(f)}
            className={`rounded px-2.5 py-1 font-medium transition ${
              qcFilter === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {t(`filter.${f}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-80 animate-pulse rounded-lg bg-muted" style={{ width: COL_W }} />
          ))}
        </div>
      ) : grid.rows.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        // Comparison grid: one column per model, one row per shot — so a single
        // row shows the same pose from every model, side by side.
        <div className="overflow-x-auto pb-2">
          <div
            className="grid gap-x-2 gap-y-4"
            style={{
              gridTemplateColumns: `40px ${COL_W}px repeat(${grid.cols.length}, ${COL_W}px)`,
            }}
          >
            {/* header: row-label gutter + pinned reference + model columns */}
            <div className="sticky top-0 z-20 bg-background" />
            <div className="sticky top-0 z-20 border-b bg-background pb-1.5 text-center text-[12px] font-semibold text-primary">
              {t("reference")}
            </div>
            {grid.cols.map((key) => (
              <div
                key={key}
                className="sticky top-0 z-10 truncate border-b bg-background pb-1.5 text-center text-[12px] font-semibold"
                title={grid.nameFor(key) ?? undefined}
              >
                {grid.nameFor(key) ?? "—"}
              </div>
            ))}

            {grid.rows.map(([rowKey, row]) => (
              <div key={rowKey} className="contents">
                {/* row label — which shot this row is */}
                <div className="flex items-start justify-center pt-1 text-[11.5px] font-semibold tracking-wide text-foreground/80">
                  <span className={sidewaysClass(shotLabel(rowKey))} title={shotLabel(rowKey)}>
                    {shotLabel(rowKey)}
                  </span>
                </div>

                {/* pinned original — always beside the outputs, for comparison */}
                <div className="rounded-lg border-2 border-primary/40 bg-card p-1.5">
                  {row.reference ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLightbox({
                          ...((row.cells.values().next().value as Run[])[0] as Run),
                          output_url: row.reference,
                          code: t("reference"),
                        })
                      }
                      className="block w-full"
                      aria-label={t("zoom")}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={row.reference}
                        alt={t("reference")}
                        className="aspect-[2/3] w-full cursor-zoom-in rounded-md bg-muted object-cover"
                      />
                    </button>
                  ) : (
                    <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-muted px-2 text-center text-[11px] text-muted-foreground">
                      {t("noReference")}
                    </div>
                  )}
                  <div className="mt-1 truncate px-0.5 text-[12px] font-semibold text-primary">
                    {t("reference")}
                  </div>
                </div>

                {grid.cols.map((m) => {
                  const list = row.cells.get(m) ?? [];
                  if (!list.length) {
                    return (
                      <div
                        key={m}
                        className="flex aspect-[2/3] items-center justify-center rounded-md bg-muted/50 text-[11px] text-muted-foreground"
                      >
                        —
                      </div>
                    );
                  }
                  return (
                    <div key={m} className="flex flex-col gap-2">
                      {list.map((run) => {
                  const isOpen = !!open[run.id];
                  const rejected = run.qc_status === "rejected";
                  const metrics = formatMetrics(run.qc_scores);
                  return (
                    <div
                      key={run.id}
                      className={`flex flex-col rounded-lg border bg-card p-1.5 ${
                        rejected && !run.overridden ? "border-red-300 dark:border-red-900/60" : ""
                      } ${run.overridden ? "ring-1 ring-amber-400/70" : ""}`}
                    >
                      {/* media — click opens it big in a lightbox */}
                      {run.output_url ? (
                        isVideo(run.output_url) ? (
                          <video
                            controls
                            src={run.output_url}
                            className="aspect-[2/3] w-full rounded-md bg-black object-contain"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setLightbox(run)}
                            className="group relative block w-full"
                            aria-label={t("zoom")}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={run.output_url}
                              alt={run.code}
                              className="aspect-[2/3] w-full cursor-zoom-in rounded-md bg-muted object-cover transition group-hover:opacity-90"
                            />
                          </button>
                        )
                      ) : (
                        <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-muted text-[12px] text-muted-foreground">
                          —
                        </div>
                      )}

                      {/* the ONE always-visible line: id + expander */}
                      <button
                        type="button"
                        onClick={() => setOpen((p) => ({ ...p, [run.id]: !isOpen }))}
                        className="mt-1 flex w-full items-center justify-between gap-1 rounded px-0.5 py-0.5 text-start hover:bg-accent"
                        aria-expanded={isOpen}
                      >
                        <span className="font-mono text-[12px] font-semibold">{run.code}</span>
                        <span className="flex items-center gap-1">
                          {rejected ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500" title={t("qc.rejected")} />
                          ) : null}
                          <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                              isOpen ? "rotate-180" : ""
                            }`}
                          />
                        </span>
                      </button>

                      {/* scoring stays visible — it is the point of the screen */}
                      <div className="mt-0.5 space-y-1">
                        {dimensions.map((dim) => {
                          const current = scoreFor(run, dim);
                          return (
                            <div key={dim} className="flex items-center gap-1">
                              {dimensions.length > 1 ? (
                                <span className="w-14 shrink-0 truncate text-[10px] text-muted-foreground">
                                  {t(`dim.${dim}`)}
                                </span>
                              ) : null}
                              <div className="flex flex-1 gap-0.5">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() => void setScore(run, dim, n)}
                                    className={`h-6 flex-1 rounded border text-[11px] font-medium transition ${
                                      current === n
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-input bg-background hover:bg-accent"
                                    }`}
                                    aria-label={`${t("scoreLabel")} ${n}`}
                                  >
                                    {n}
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* everything else lives behind the expander */}
                      {isOpen ? (
                        <div className="mt-1.5 space-y-1 border-t pt-1.5 text-[10.5px]">
                          <div className="flex flex-wrap items-center gap-1">
                            <span
                              className={`rounded px-1 py-0.5 font-semibold ${
                                run.qc_status === "pass"
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                                  : rejected
                                    ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                                    : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {t(`qc.${run.qc_status}`)}
                            </span>
                            {run.qc_score != null ? (
                              <span className="text-muted-foreground">
                                {t("qcScore")} {Math.round(run.qc_score * 100) / 100}
                              </span>
                            ) : null}
                            {run.overridden ? (
                              <span className="rounded bg-amber-100 px-1 py-0.5 font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                {t("overriddenBadge")}
                              </span>
                            ) : null}
                          </div>

                          {metrics ? (
                            <div className="break-words text-muted-foreground">
                              {t("metrics")}: {metrics}
                            </div>
                          ) : null}

                          {rejected && run.qc_reason ? (
                            <div className="rounded bg-red-50 px-1.5 py-1 text-red-800 dark:bg-red-950/40 dark:text-red-300">
                              {t("qcReason")}: {run.qc_reason}
                            </div>
                          ) : null}

                          <div className="text-muted-foreground">
                            {t("model")}: {run.model ?? "—"}
                          </div>

                          {run.seed != null ? (
                            <div className="text-muted-foreground">
                              <span className="font-medium">{t("seed")}: </span>
                              <span className="font-mono">{run.seed}</span>
                            </div>
                          ) : null}

                          {run.prompt ? (
                            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                              <span className="font-medium">{t("prompt")}: </span>
                              {run.prompt}
                            </div>
                          ) : null}

                          {rejected ? (
                            <button
                              type="button"
                              onClick={() => void toggleOverride(run)}
                              className={`w-full rounded border px-1.5 py-1 font-medium transition ${
                                run.overridden
                                  ? "border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300"
                                  : "border-input bg-background hover:bg-accent"
                              }`}
                            >
                              {run.overridden ? t("overridden") : t("override")}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox — full-screen look at one output */}
      {lightbox?.output_url ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label={t("close")}
            className="absolute end-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.output_url}
            alt={lightbox.code}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain"
          />
          <span className="absolute bottom-4 start-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 font-mono text-[12px] text-white">
            {lightbox.code}
          </span>
        </div>
      ) : null}
    </div>
  );
}
