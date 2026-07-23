"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

type MyScore = { dimension: string; score: number; locked: boolean };

type Run = {
  id: string;
  code: string;
  output_url: string | null;
  model: string | null;
  scene: string | null;
  variation: number | null;
  my_scores: MyScore[];
};

type RunsResponse = { runs: Run[]; revealed: boolean };

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

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-56 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((run) => (
            <div key={run.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
