"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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
  prompt: string | null;
  qc_status: QcStatus;
  qc_score: number | null;
  qc_reason: string | null;
  qc_scores: Record<string, number>;
  overridden: boolean;
  my_scores: MyScore[];
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

/** Compact per-metric line, e.g. "face 0.62 · lip 7.1". Numbers trimmed to at
 *  most 2 decimals; non-numbers skipped. */
function formatMetrics(scores: Record<string, number> | null | undefined): string {
  if (!scores) return "";
  return Object.entries(scores)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k, v]) => `${k} ${Math.round(v * 100) / 100}`)
    .join(" · ");
}

const PROMPT_PREVIEW = 120;

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
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
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
    let alive = true;
    setLoading(true);
    load()
      .catch((e) => alive && toast.error(e instanceof Error ? e.message : t("loadError")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load, t]);

  const filteredRuns = useMemo(
    () => (qcFilter === "all" ? runs : runs.filter((r) => r.qc_status === qcFilter)),
    [runs, qcFilter],
  );

  function scoreFor(run: Run, dimension: string): number | null {
    const hit = run.my_scores.find((s) => s.dimension === dimension);
    return hit ? hit.score : null;
  }

  async function setScore(run: Run, dimension: string, score: number) {
    // Optimistic: reflect the click immediately.
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
    // Optimistic.
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-56 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRuns.map((run) => {
            const metrics = formatMetrics(run.qc_scores);
            const promptOpen = !!expandedPrompts[run.id];
            const prompt = run.prompt ?? "";
            const promptLong = prompt.length > PROMPT_PREVIEW;
            const rejected = run.qc_status === "rejected";
            return (
              <div
                key={run.id}
                className={`flex flex-col gap-2 rounded-lg border bg-card p-3 ${
                  rejected && !run.overridden ? "border-red-300 dark:border-red-900/60" : ""
                } ${run.overridden ? "ring-1 ring-amber-400/70" : ""}`}
              >
                {run.output_url ? (
                  isVideo(run.output_url) ? (
                    <video
                      controls
                      src={run.output_url}
                      className="aspect-video w-full rounded-md bg-black object-contain"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={run.output_url}
                      alt={run.code}
                      className="aspect-video w-full rounded-md bg-muted object-contain"
                    />
                  )
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-[12px] text-muted-foreground">
                    —
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[13px] font-semibold">{run.code}</span>
                  <span className="text-[11.5px] text-muted-foreground">
                    {t("model")}: {revealed ? run.model ?? "—" : t("hidden")}
                  </span>
                </div>

                {/* QC row: status badge + score + optional override mark */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
                      run.qc_status === "pass"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : run.qc_status === "rejected"
                          ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t(`qc.${run.qc_status}`)}
                  </span>
                  {run.qc_score != null ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t("qcScore")}: {Math.round(run.qc_score * 100) / 100}
                    </span>
                  ) : null}
                  {run.overridden ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      {t("overriddenBadge")}
                    </span>
                  ) : null}
                </div>

                {metrics ? (
                  <div className="text-[11px] text-muted-foreground">
                    {t("metrics")}: {metrics}
                  </div>
                ) : null}

                {rejected && run.qc_reason ? (
                  <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-800 dark:bg-red-950/40 dark:text-red-300">
                    {t("qcReason")}: {run.qc_reason}
                  </div>
                ) : null}

                {/* Prompt — always visible, muted, collapsible */}
                {prompt ? (
                  <div className="text-[11px] text-muted-foreground">
                    <span className="font-medium">{t("prompt")}: </span>
                    <span className="whitespace-pre-wrap break-words">
                      {promptOpen || !promptLong ? prompt : `${prompt.slice(0, PROMPT_PREVIEW)}…`}
                    </span>
                    {promptLong ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedPrompts((p) => ({ ...p, [run.id]: !promptOpen }))
                        }
                        className="ml-1 text-primary underline-offset-2 hover:underline"
                      >
                        {promptOpen ? t("promptLess") : t("promptMore")}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  {dimensions.map((dim) => {
                    const current = scoreFor(run, dim);
                    return (
                      <div key={dim} className="flex items-center gap-2">
                        {dimensions.length > 1 ? (
                          <span className="w-20 shrink-0 text-[11.5px] text-muted-foreground">
                            {t(`dim.${dim}`)}
                          </span>
                        ) : null}
                        <div className="flex gap-1">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => void setScore(run, dim, n)}
                              className={`h-7 w-7 rounded-md border text-[12px] font-medium transition ${
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

                {/* Override control — only on rejected runs */}
                {rejected ? (
                  <button
                    type="button"
                    onClick={() => void toggleOverride(run)}
                    className={`mt-0.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition ${
                      run.overridden
                        ? "border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300"
                        : "border-input bg-background hover:bg-accent"
                    }`}
                  >
                    {run.overridden ? t("overridden") : t("override")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
