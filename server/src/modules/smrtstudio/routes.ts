/**
 * smrtStudio — the unified production-management layer over the AI-video program.
 *
 * Read-only over the management spine (studio_*) joined with the production
 * data that already exists (experiment_runs, experiment_scores, smrtvoice_*).
 * The spine holds stages, gates, challenges, the research index, the model
 * catalog and the investment ledger; the counts and costs are always computed
 * live from the production tables, never denormalized — so a number on screen
 * can never drift from the runs it claims to summarize.
 *
 * Every response carries both languages (`*_he` / `*_en`) so the operator
 * console and the investor page render from one payload.
 *
 * Guards: requireAuth + requireOrg + requireApp("smrtstudio") — the per-app
 * slug, same as every other tenant-scoped module.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrtstudio"));

type Row = Record<string, unknown>;

/** Which pipeline stage a production row belongs to. `experiment_runs.stage`
 *  is written by the video-lab harness with the coarse kind ('image', 'video',
 *  …); the studio pipeline is finer, so map rather than assume. A run whose
 *  stage we do not recognize is still counted — under its own key — so nothing
 *  ever silently disappears from the totals. */
const RUN_STAGE_TO_SLUG: Record<string, string> = {
  image: "chars",
  char: "chars",
  chars: "chars",
  sets: "sets",
  frame: "frames",
  frames: "frames",
  video: "motion",
  motion: "motion",
  lipsync: "lipsync",
  assembly: "assembly",
};

function slugForRun(r: Row): string {
  const label = String(r.test_label ?? "").toLowerCase();
  // test_label is the more specific signal when present (e.g. 'char-sheet').
  if (label.startsWith("char")) return "chars";
  if (label.startsWith("set")) return "sets";
  if (label.startsWith("frame")) return "frames";
  if (label.startsWith("lipsync")) return "lipsync";
  const stage = String(r.stage ?? "").toLowerCase();
  return RUN_STAGE_TO_SLUG[stage] ?? (stage || "unknown");
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /studio/overview — everything the main screen needs in one round trip:
 * stages with their two-axis state, gates (with a done/total progress pair),
 * challenges split expected-vs-hit, and live output counts per stage.
 */
router.get("/studio/overview", async (req: Request, res: Response) => {
  const orgId = req.org!.id;

  const [stagesQ, gatesQ, chalQ, runsQ, scoresQ, takesQ] = await Promise.all([
    db.from("studio_stages").select("*").eq("org_id", orgId).order("position"),
    db.from("studio_gates").select("*").eq("org_id", orgId).order("position"),
    db.from("studio_challenges").select("*").eq("org_id", orgId).order("position"),
    db
      .from("experiment_runs")
      .select("id,stage,test_label,model,cost_usd,qc_status,created_at")
      .eq("org_id", orgId),
    db.from("experiment_scores").select("id,run_id").eq("org_id", orgId),
    // Org-scoped like every other read here — `db` is the service-role client,
    // so RLS does NOT filter for us and the org predicate has to be explicit.
    // `count: exact` with an explicit range means a truncated page is detected
    // rather than silently under-reporting the take totals.
    db
      .from("smrtvoice_line_takes")
      .select("id,approved,cost_usd", { count: "exact" })
      .eq("org_id", orgId)
      .range(0, 9999),
  ]);

  const firstError =
    stagesQ.error ?? gatesQ.error ?? chalQ.error ?? runsQ.error ?? scoresQ.error;
  if (firstError) return res.status(500).json({ error: firstError.message });
  // A voice failure degrades the voice counts rather than failing the screen.
  const takes = takesQ.error ? [] : (takesQ.data ?? []);
  const takesTotal = takesQ.error ? 0 : (takesQ.count ?? takes.length);
  const takesTruncated = takes.length < takesTotal;

  const stages = stagesQ.data ?? [];
  const gates = gatesQ.data ?? [];
  const challenges = chalQ.data ?? [];
  const runs = runsQ.data ?? [];
  const scoredRunIds = new Set((scoresQ.data ?? []).map((s) => String(s.run_id)));

  // Live per-stage production facts.
  const perStage = new Map<
    string,
    { outputs: number; cost: number; missing_cost: number; scored: number; models: Set<string> }
  >();
  for (const r of runs) {
    const slug = slugForRun(r as Row);
    const cur =
      perStage.get(slug) ??
      { outputs: 0, cost: 0, missing_cost: 0, scored: 0, models: new Set<string>() };
    cur.outputs += 1;
    cur.cost += num((r as Row).cost_usd);
    if ((r as Row).cost_usd == null) cur.missing_cost += 1;
    if (scoredRunIds.has(String((r as Row).id))) cur.scored += 1;
    const m = String((r as Row).model ?? "");
    if (m) cur.models.add(m);
    perStage.set(slug, cur);
  }

  const approvedTakes = takes.filter((t) => (t as Row).approved === true).length;
  const voiceCost = takes.reduce((a, t) => a + num((t as Row).cost_usd), 0);
  const voiceMissingCost = takes.filter((t) => (t as Row).cost_usd == null).length;
  if (takesTotal) {
    const cur =
      perStage.get("voice") ??
      { outputs: 0, cost: 0, missing_cost: 0, scored: 0, models: new Set<string>() };
    // `outputs` uses the exact count so the headline is right even if the page
    // was truncated; the derived figures below describe the rows we actually read.
    cur.outputs += takesTotal;
    cur.scored += approvedTakes;
    cur.cost += voiceCost;
    cur.missing_cost += voiceMissingCost;
    perStage.set("voice", cur);
  }

  const payload = stages.map((s) => {
    const slug = String((s as Row).slug);
    const g = gates.filter((x) => String((x as Row).stage_slug) === slug);
    const done = g.filter((x) => (x as Row).done === true).length;
    const live = perStage.get(slug);
    return {
      ...s,
      gates: g,
      gates_done: done,
      gates_total: g.length,
      progress_pct: g.length ? Math.round((done / g.length) * 100) : 0,
      challenges_expected: challenges.filter(
        (c) => String((c as Row).stage_slug) === slug && (c as Row).kind === "expected",
      ),
      challenges_hit: challenges.filter(
        (c) => String((c as Row).stage_slug) === slug && (c as Row).kind === "hit",
      ),
      outputs: live?.outputs ?? 0,
      scored: live?.scored ?? 0,
      cost_usd: Number((live?.cost ?? 0).toFixed(4)),
      runs_missing_cost: live?.missing_cost ?? 0,
      models_run: live ? [...live.models].sort() : [],
    };
  });

  res.json({
    stages: payload,
    totals: {
      runs: runs.length,
      // Scoped to experiment_runs so it stays comparable to `runs`. The voice
      // gap is reported on its own line rather than folded in, which would make
      // "missing" larger than the run count it appears to describe.
      runs_missing_cost: runs.filter((r) => (r as Row).cost_usd == null).length,
      voice_missing_cost: voiceMissingCost,
      recorded_cost_usd: Number(
        (runs.reduce((a, r) => a + num((r as Row).cost_usd), 0) + voiceCost).toFixed(4),
      ),
      scores: scoredRunIds.size,
      voice_takes: takesTotal,
      voice_approved: approvedTakes,
      /** True when the take page was capped: the counts above stay exact, but
       *  `recorded_cost_usd` then covers only the rows actually read. The
       *  console renders a "partial records" marker off this. */
      voice_cost_partial: takesTruncated,
      stages_locked: stages.filter((s) => (s as Row).decision_state === "locked").length,
      stages_total: stages.length,
    },
  });
});

/**
 * GET /studio/research?stage=  — the research index. `stage` accepts a stage
 * slug, 'cross', or nothing (everything). Counts per stage always describe the
 * FULL index, not the filtered slice, so the filter chips do not lie.
 */
router.get("/studio/research", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const stage = typeof req.query.stage === "string" ? req.query.stage : null;

  const { data, error } = await db
    .from("studio_research")
    .select("*")
    .eq("org_id", orgId)
    .order("stage_slug")
    .order("position");
  if (error) return res.status(500).json({ error: error.message });

  const all = data ?? [];
  const counts: Record<string, number> = {};
  for (const r of all) {
    const k = String((r as Row).stage_slug);
    counts[k] = (counts[k] ?? 0) + 1;
  }

  res.json({
    items: stage ? all.filter((r) => String((r as Row).stage_slug) === stage) : all,
    counts,
    total: all.length,
  });
});

/**
 * GET /studio/models?kind=&verified=&q=  — the model catalog.
 * `verified=1` narrows to entries whose OpenAPI schema we actually pulled;
 * everything else is the auto-indexed shelf. Capped so a 1,394-row catalog
 * cannot blow up a response.
 */
router.get("/studio/models", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const kind = typeof req.query.kind === "string" && req.query.kind !== "all" ? req.query.kind : null;
  const verifiedOnly = req.query.verified === "1";
  const term = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

  let q = db.from("studio_models").select("*", { count: "exact" }).eq("org_id", orgId);
  if (kind) q = q.eq("kind", kind);
  if (verifiedOnly) q = q.eq("verified_schema", true);
  if (term) {
    // PostgREST parses `or=(...)` as structured text: a comma, dot, paren or
    // quote in the term would rewrite the filter rather than be matched. Strip
    // them — this is a search box, not a query language.
    const safe = term.replace(/[,().*:"'\\]/g, "");
    if (safe) {
      q = q.or(`endpoint_id.ilike.%${safe}%,title.ilike.%${safe}%,vendor.ilike.%${safe}%`);
    }
  }

  const { data, error, count } = await q
    .order("verified_schema", { ascending: false })
    .order("shortlist_rank", { ascending: true, nullsFirst: false })
    .order("endpoint_id")
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Kind tallies over the whole catalog, independent of the current filter.
  const { data: allKinds, error: kindsErr } = await db
    .from("studio_models")
    .select("kind,verified_schema")
    .eq("org_id", orgId);
  if (kindsErr) return res.status(500).json({ error: kindsErr.message });

  const counts: Record<string, number> = {};
  let verifiedTotal = 0;
  for (const m of allKinds ?? []) {
    const k = String((m as Row).kind);
    counts[k] = (counts[k] ?? 0) + 1;
    if ((m as Row).verified_schema === true) verifiedTotal += 1;
  }

  res.json({
    items: data ?? [],
    matched: count ?? (data ?? []).length,
    returned: (data ?? []).length,
    limit,
    counts,
    total: (allKinds ?? []).length,
    verified_total: verifiedTotal,
  });
});

/** GET /studio/investment — the hours/value ledger behind the investor page. */
router.get("/studio/investment", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data, error } = await db
    .from("studio_investment")
    .select("*")
    .eq("org_id", orgId)
    .order("position");
  if (error) return res.status(500).json({ error: error.message });

  const rows = data ?? [];
  const work = rows.filter((r) => (r as Row).kind === "work");
  res.json({
    items: rows,
    total_hours: work.reduce((a, r) => a + num((r as Row).hours), 0),
    total_work_usd: Number(work.reduce((a, r) => a + num((r as Row).value_usd), 0).toFixed(2)),
    total_direct_usd: Number(
      rows
        .filter((r) => (r as Row).kind === "direct")
        .reduce((a, r) => a + num((r as Row).value_usd), 0)
        .toFixed(2),
    ),
  });
});

export default router;
