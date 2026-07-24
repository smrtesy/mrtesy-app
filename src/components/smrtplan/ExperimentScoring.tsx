"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** 480px webp copies for the grid; the lightbox always opens the original. */
  thumb_url: string | null;
  reference_thumb_url: string | null;
};

type RunsResponse = { runs: Run[]; revealed: boolean };

type QcFilter = "all" | "pass" | "rejected" | "pending";

/** What to score, per test. A still-image panel is scored on CONSISTENCY ALONE
 *  (user decision, 7/2026): is this the same character as the reference — where
 *  a gross defect (same face, six fingers) is NOT consistent. "Doesn't look AI"
 *  and style fidelity are deliberately NOT scored here: they are set by the
 *  reference image itself, a step that belongs to real production, not to
 *  picking a model. Video adds motion/quality; lip-sync adds its own. */
function dimensionsFor(testLabel: string | null): string[] {
  const label = (testLabel ?? "").toLowerCase();
  if (label.includes("lipsync")) return ["consistency", "motion", "quality", "lipsync"];
  if (label.includes("video") || label.includes("test-b")) return ["consistency", "motion", "quality"];
  return ["consistency"];
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

/** Comparison-grid geometry. The column width is DERIVED from the space the grid
 *  actually gets (see useColumnWidth): reference + every model column must fit
 *  without horizontal scrolling whenever they can — a fixed width meant that in a
 *  half-width desktop pane only three of six columns were reachable. */
const ROW_LABEL_W = 32;
const COL_GAP = 8;
/** Below this a column is too small to judge a character in; the grid scrolls
 *  sideways instead of shrinking further (the reference column stays pinned). */
const COL_W_MIN = 132;
/** Above this the images stop gaining useful detail and just cost scrolling. */
const COL_W_MAX = 260;
/** Fallback for the first paint, before the container has been measured. */
const COL_W_DEFAULT = 200;
/** Height of the pinned model-name strip. The grid scrolls under it, so every
 *  other sticky element (the row labels) has to start below it. */
const HEADER_H = 26;
/** Room the page chrome above the grid needs (title, hint, filter row) before
 *  the grid takes the rest. The grid is its own scroll box — that is what keeps
 *  the model names and the pose labels on screen while scrolling. */
const CHROME_H = 200;

/** Fit `columns` image columns into the measured container width. */
function useColumnWidth(columns: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [colW, setColW] = useState(COL_W_DEFAULT);

  useEffect(() => {
    const el = ref.current;
    if (!el || columns < 1) return;
    const measure = () => {
      const avail = el.clientWidth - ROW_LABEL_W - COL_GAP * columns;
      const fit = Math.floor(avail / columns);
      setColW(Math.max(COL_W_MIN, Math.min(COL_W_MAX, fit)));
    };
    measure();
    // The grid lives inside a resizable desktop pane, so the width changes
    // without a window resize — observe the element, not the window.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [columns]);

  return { ref, colW };
}

/** Grid source: the pre-built 480px webp when we have one, else the original.
 *  61 originals are ~130 MB, which is why the page crawled and most images never
 *  appeared on a phone; the webp copies are ~15 KB each (~1 MB for the whole
 *  grid). Storage image transformation is NOT enabled on this project — asking
 *  /render/image/sign/ for width=240 returns the full-size bytes — so the
 *  thumbnails are produced when the run is uploaded, not on the fly.
 *  The lightbox always opens `output_url`, the original. */
function gridSrc(run: Run): string {
  return run.thumb_url ?? run.output_url ?? "";
}

/** Readable column header. The stored value is an endpoint path
 *  ("fal-ai/flux-pro/kontext/max") — unreadable on a phone. Display only: the
 *  run keeps its exact endpoint id, shown in the expanded panel. */
const MODEL_NAMES: Record<string, string> = {
  "fal-ai/nano-banana-pro": "Nano Banana Pro",
  "fal-ai/nano-banana-2/edit": "Nano Banana 2",
  "fal-ai/flux-pro/kontext/max": "FLUX Kontext max",
  "bytedance/seedream/v5/pro/edit": "Seedream 5 Pro",
  "fal-ai/qwen-image-edit": "Qwen Image Edit",
};
function modelName(model: string | null): string {
  if (!model) return "—";
  if (MODEL_NAMES[model]) return MODEL_NAMES[model];
  const parts = model.split("/").filter((x) => x && x !== "edit" && x !== "fal-ai");
  return parts.slice(-2).join(" ") || model;
}

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
    const rowMap = new Map<
      string,
      { cells: Map<number, Run[]>; reference: string | null; referenceThumb: string | null }
    >();
    for (const r of filteredRuns) {
      if (!rowMap.has(r.shot_key))
        rowMap.set(r.shot_key, { cells: new Map(), reference: null, referenceThumb: null });
      const row = rowMap.get(r.shot_key)!;
      const list = row.cells.get(r.model_key);
      if (list) list.push(r);
      else row.cells.set(r.model_key, [r]);
      if (!row.reference && r.reference_url) row.reference = r.reference_url;
      if (!row.referenceThumb && r.reference_thumb_url) row.referenceThumb = r.reference_thumb_url;
    }
    const rows = [...rowMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true }),
    );
    // Column header: the model name — nothing is hidden (rule 9).
    const nameFor = (key: number) =>
      filteredRuns.find((r) => r.model_key === key)?.model ?? null;
    return { cols, rows, nameFor };
  }, [filteredRuns]);

  // Reference column + one per model, all fitted into the width the grid has.
  const { ref: gridRef, colW } = useColumnWidth(grid.cols.length + 1);

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
            <div key={i} className="h-80 flex-1 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : grid.rows.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        // Comparison grid: one column per model, one row per shot — so a single
        // row shows the same pose from every model, side by side.
        // The grid is its OWN scroll box, in both axes: that is what makes the
        // model-name strip stay at the top and the pose column stay at the side
        // while scrolling (sticky resolves against the nearest scroll container,
        // so with the page doing the scrolling the headers just scrolled away).
        <div
          ref={gridRef}
          className="overflow-auto overscroll-contain pb-2"
          style={{ maxHeight: `calc(100dvh - ${CHROME_H}px)` }}
        >
          <div
            className="grid gap-y-4"
            style={{
              columnGap: COL_GAP,
              gridTemplateColumns: `${ROW_LABEL_W}px repeat(${grid.cols.length + 1}, ${colW}px)`,
            }}
          >
            {/* header: row-label gutter + pinned reference + model columns. The
                gutter and the reference are sticky on BOTH axes, so the corner
                stays put no matter which way the grid is scrolled. */}
            <div
              className="sticky top-0 z-40 bg-background"
              style={{ insetInlineStart: 0, height: HEADER_H }}
            />
            <div
              className="sticky top-0 z-30 border-b bg-background text-center text-[12px] font-semibold leading-[18px] text-primary"
              style={{ insetInlineStart: ROW_LABEL_W, height: HEADER_H }}
            >
              {t("reference")}
            </div>
            {grid.cols.map((key) => (
              <div
                key={key}
                className="sticky top-0 z-20 truncate border-b bg-background text-center text-[12px] font-semibold leading-[18px]"
                style={{ height: HEADER_H }}
                title={grid.nameFor(key) ?? undefined}  /* exact endpoint id on hover */
              >
                {modelName(grid.nameFor(key))}
              </div>
            ))}

            {grid.rows.map(([rowKey, row]) => (
              <div key={rowKey} className="contents">
                {/* row label — the character and the pose/mood this row is. Sticky
                    on both axes: it stays at the side through sideways scrolling
                    and stays on screen (just under the header strip) for as long as
                    its row is. */}
                <div
                  className="sticky z-20 flex items-start justify-center bg-background text-[11.5px] font-semibold tracking-wide text-foreground/80"
                  style={{ insetInlineStart: 0, top: HEADER_H }}
                >
                  <span className={sidewaysClass(shotLabel(rowKey))} title={shotLabel(rowKey)}>
                    {shotLabel(rowKey)}
                  </span>
                </div>

                {/* pinned original — always beside the outputs, for comparison.
                    Sticky so it survives sideways scrolling on a narrow pane. */}
                <div
                  className="sticky z-10 self-start rounded-lg border-2 border-primary/40 bg-card p-1.5"
                  style={{ insetInlineStart: ROW_LABEL_W }}
                >
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
                        src={row.referenceThumb ?? row.reference}
                        alt={t("reference")}
                        loading="lazy"
                        decoding="async"
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
                              src={gridSrc(run)}
                              alt={run.code}
                              loading="lazy"
                              decoding="async"
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
                              <span className="w-14 shrink-0 truncate text-[10px] font-medium text-muted-foreground">
                                {t(`dim.${dim}`)}
                              </span>
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
                            {t("model")}: <span className="font-mono">{run.model ?? "—"}</span>
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
