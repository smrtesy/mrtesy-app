/**
 * Quick-task marathon runs.
 *
 *   POST  /marathon-runs           start a run → { run }
 *   PATCH /marathon-runs/:id       finish a run { completed_count, skipped_count } → { run, stats }
 *   GET   /marathon-runs/stats     personal records + recent history → { stats }
 *
 * A run is personal (user-scoped within the org). Records are derived, not
 * stored: best completed_count in a single run, and best pace (seconds per
 * completed task) among runs with 2+ completions.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"));

interface RunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  completed_count: number;
  skipped_count: number;
}

export interface MarathonStats {
  total_runs: number;
  total_completed: number;
  best_count: number;
  /** Seconds per completed task in the user's fastest qualifying run (2+ done). */
  best_pace_seconds: number | null;
  week_runs: number;
  week_completed: number;
}

async function computeStats(userId: string): Promise<MarathonStats> {
  const { data } = await db
    .from("marathon_runs")
    .select("id, started_at, ended_at, completed_count, skipped_count")
    .eq("user_id", userId)
    .not("ended_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(500);
  const runs = (data ?? []) as RunRow[];

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let bestCount = 0;
  let bestPace: number | null = null;
  let totalCompleted = 0;
  let weekRuns = 0;
  let weekCompleted = 0;

  for (const r of runs) {
    totalCompleted += r.completed_count;
    if (r.completed_count > bestCount) bestCount = r.completed_count;
    if (r.completed_count >= 2 && r.ended_at) {
      const secs = (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000;
      const pace = secs / r.completed_count;
      if (pace > 0 && (bestPace === null || pace < bestPace)) bestPace = pace;
    }
    if (new Date(r.started_at).getTime() >= weekAgo) {
      weekRuns++;
      weekCompleted += r.completed_count;
    }
  }

  return {
    total_runs: runs.length,
    total_completed: totalCompleted,
    best_count: bestCount,
    best_pace_seconds: bestPace === null ? null : Math.round(bestPace),
    week_runs: weekRuns,
    week_completed: weekCompleted,
  };
}

/** POST /marathon-runs — open a new run. */
router.post("/marathon-runs", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("marathon_runs")
    .insert({ user_id: req.user!.id, organization_id: req.org!.id })
    .select("id, started_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ run: data });
});

/** PATCH /marathon-runs/:id — close the run with final counters. Returns the
 *  fresh stats so the finish screen can show records without a second call. */
router.patch("/marathon-runs/:id", async (req: Request, res: Response) => {
  const completed = Number(req.body?.completed_count);
  const skipped = Number(req.body?.skipped_count);
  if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(skipped) || skipped < 0) {
    return res.status(400).json({ error: "completed_count and skipped_count must be non-negative integers" });
  }

  // Stats BEFORE this run closes, so the finish screen can compare against
  // the previous record ("you beat your old best of 6").
  const prevStats = await computeStats(req.user!.id);

  const { data, error } = await db
    .from("marathon_runs")
    .update({ ended_at: new Date().toISOString(), completed_count: completed, skipped_count: skipped })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .select("id, started_at, ended_at, completed_count, skipped_count")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "run not found" });

  const stats = await computeStats(req.user!.id);
  res.json({ run: data, stats, prev_stats: prevStats });
});

/** GET /marathon-runs/stats */
router.get("/marathon-runs/stats", async (req: Request, res: Response) => {
  res.json({ stats: await computeStats(req.user!.id) });
});

export default router;
