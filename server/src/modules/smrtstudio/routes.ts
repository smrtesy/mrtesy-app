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
import { requireAuth, requireOrg, requireApp, isSuperAdmin } from "../../middleware";
import { fetchCatalog, probeAudio, isVideoCategory } from "./indexer";

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

  // Ordered the way the work flows — characters, voices, sets, frames, motion,
  // lip-sync — not alphabetically and not by fal's taxonomy. Within a stage the
  // ranked models come first, then the rest of the shelf.
  // Curated rows first, then pipeline order within them. Putting stage_order
  // first buried the whole ranked shortlist: after a sweep there are ~570 image
  // models at stage 3, so the ranked video (7), lip-sync (8) and QC (98) models
  // fell past the page limit entirely.
  const { data, error, count } = await q
    .order("verified_schema", { ascending: false })
    .order("stage_order", { ascending: true })
    .order("shortlist_rank", { ascending: true, nullsFirst: false })
    .order("endpoint_id")
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Kind tallies over the whole catalog, independent of the current filter.
  const { data: allKinds, error: kindsErr, count: kindsCount } = await db
    .from("studio_models")
    .select("kind,verified_schema,audio_input,audio_probed", { count: "exact" })
    .eq("org_id", orgId)
    .range(0, 4999);
  if (kindsErr) return res.status(500).json({ error: kindsErr.message });

  const counts: Record<string, number> = {};
  const audioCounts: Record<string, number> = {};
  let verifiedTotal = 0;
  let probedTotal = 0;
  for (const m of allKinds ?? []) {
    const k = String((m as Row).kind);
    counts[k] = (counts[k] ?? 0) + 1;
    if ((m as Row).verified_schema === true) verifiedTotal += 1;
    if ((m as Row).audio_probed === true) probedTotal += 1;
    const role = (m as Row).audio_input;
    if (typeof role === "string") audioCounts[role] = (audioCounts[role] ?? 0) + 1;
  }

  res.json({
    items: data ?? [],
    matched: count ?? (data ?? []).length,
    returned: (data ?? []).length,
    limit,
    counts,
    // The exact count, so a capped page reports the catalog size honestly.
    total: kindsCount ?? (allKinds ?? []).length,
    tallied: (allKinds ?? []).length,
    verified_total: verifiedTotal,
    audio_counts: audioCounts,
    audio_probed_total: probedTotal,
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

/**
 * POST /studio/models/index — run the fal catalog indexer.
 *
 * FREE: reads fal's catalog and OpenAPI schema endpoints only, never an
 * inference endpoint, so no run is ever billed. That is what makes it safe to
 * re-run whenever we want to know what changed in the catalog.
 *
 * Body / query:
 *   probe_audio  — also run the audio probe over video endpoints (default true)
 *   probe_limit  — cap the probe at N endpoints this call (default 120). The
 *                  probe skips endpoints already probed, so repeated calls walk
 *                  the remaining set instead of one request outliving its own
 *                  timeout.
 *
 * Restricted to super-admins: it rewrites the shared catalog, which is a
 * platform-level action rather than per-user work.
 */
router.post("/studio/models/index", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!(await isSuperAdmin(req.user!))) {
    return res.status(403).json({ error: "super admin required" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const probeAudioFlag = body.probe_audio !== false && req.query.probe_audio !== "0";
  const rawLimit = Number(body.probe_limit ?? req.query.probe_limit);
  // Probes run through a small concurrency pool (below), so a batch of 150 is
  // ~19 sequential rounds and stays inside a normal proxy timeout. The probe is
  // resumable, so a full 513-endpoint sweep is a few presses rather than one
  // request that outlives itself.
  const probeLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 0), 400) : 150;

  // ── pass 1: the catalog ──
  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (e) {
    return res
      .status(502)
      .json({ error: `fal catalog unreachable: ${e instanceof Error ? e.message : String(e)}` });
  }

  const indexedAt = new Date().toISOString();
  // Rows already carrying a hand-written recipe keep their curated fields: the
  // catalog knows the model exists, but only we know it was schema-verified and
  // where it ranks. The upsert below therefore never touches verified_schema,
  // shortlist_rank, recipe_path, price_usd or the audio classification.
  const { data: curatedRows, error: curatedErr } = await db
    .from("studio_models")
    .select("endpoint_id")
    .eq("org_id", orgId)
    .eq("verified_schema", true);
  if (curatedErr) return res.status(500).json({ error: curatedErr.message });
  const curated = new Set((curatedRows ?? []).map((r) => String((r as Row).endpoint_id)));

  const catalogIds = new Set(catalog.models.map((m) => m.endpoint_id));
  // A curated row fal no longer lists is either renamed or withdrawn. It is
  // skipped by both write paths, so it would silently stop being refreshed —
  // reported instead of left to rot.
  const curatedMissing = [...curated].filter((id) => !catalogIds.has(id));
  const fresh = catalog.models.filter((m) => !curated.has(m.endpoint_id));
  let written = 0;
  // Chunked so one oversized statement cannot fail the whole sweep.
  for (let i = 0; i < fresh.length; i += 250) {
    const chunk = fresh
      .slice(i, i + 250)
      // `category` is the column the table shipped with; `fal_category` is the
      // one the new code reads. Both are written so neither is a dead field.
      .map((m) => ({ ...m, category: m.fal_category, org_id: orgId, indexed_at: indexedAt }));
    const { error } = await db
      .from("studio_models")
      .upsert(chunk, { onConflict: "org_id,endpoint_id" });
    if (error) return res.status(500).json({ error: `upsert failed: ${error.message}` });
    written += chunk.length;
  }
  // Curated rows still get their catalog-owned facts refreshed — deprecation and
  // hosting type change on fal's side and we want to know — without losing the
  // curation. Done one row at a time because the column set differs.
  for (const m of catalog.models.filter((x) => curated.has(x.endpoint_id))) {
    const { error } = await db
      .from("studio_models")
      // ONLY catalog-owned facts. `kind`, `stage_slug` and `stage_order` are
      // curation: six curated rows are classified `lipsync` / stage 8, and fal
      // files those same endpoints under image-to-video / video-to-video, so
      // refreshing them from the category would demote every one to motion.
      .update({
        category: m.fal_category,
        fal_category: m.fal_category,
        deprecated: m.deprecated,
        hosting_type: m.hosting_type,
        license_type: m.license_type,
        indexed_at: indexedAt,
      })
      .eq("org_id", orgId)
      .eq("endpoint_id", m.endpoint_id);
    if (error) return res.status(500).json({ error: `refresh failed: ${error.message}` });
  }

  // ── pass 2: the audio probe ──
  const videoModels = catalog.models.filter((m) => isVideoCategory(m.fal_category));
  const videoIds = videoModels.map((m) => m.endpoint_id);
  const categoryOf = new Map(videoModels.map((m) => [m.endpoint_id, m.fal_category]));

  let probed = 0;
  let driving = 0;
  let remaining = 0;
  if (probeAudioFlag && probeLimit > 0) {
    const { data: doneRows, error: doneErr } = await db
      .from("studio_models")
      .select("endpoint_id")
      .eq("org_id", orgId)
      .eq("audio_probed", true)
      .range(0, 4999);
    if (doneErr) return res.status(500).json({ error: doneErr.message });
    const alreadyProbed = new Set((doneRows ?? []).map((r) => String((r as Row).endpoint_id)));

    const todo = videoIds.filter((id) => !alreadyProbed.has(id));
    remaining = Math.max(0, todo.length - probeLimit);

    const batch = todo.slice(0, probeLimit);
    // A pool rather than a serial loop: each probe is an independent HTTPS round
    // trip, and 8 in flight turns ~150 sequential waits into ~19. Each row is
    // written as it lands, so a failure part-way leaves the rows already probed
    // marked probed — the next press continues instead of redoing them.
    const POOL = 8;
    let cursor = 0;
    let writeError: string | null = null;
    await Promise.all(
      Array.from({ length: Math.min(POOL, batch.length) }, async () => {
        while (writeError === null) {
          const i = cursor;
          cursor += 1;
          if (i >= batch.length) return;
          const id = batch[i];
          const probe = await probeAudio(id, categoryOf.get(id) ?? "");
          // A model that takes our audio as a DRIVING input is its own category:
          // it can carry the motion stage and the lip-sync stage in one call,
          // which no silent image-to-video model can do.
          const patch: Record<string, unknown> = {
            audio_probed: true,
            audio_input: probe.audio_input,
            audio_field: probe.audio_field,
            audio_note: probe.audio_note,
          };
          if (probe.audio_input === "driving") {
            patch.kind = "video_audio";
            patch.stage_slug = "motion";
            patch.stage_order = 7;
            driving += 1;
          }
          const { error } = await db
            .from("studio_models")
            .update(patch)
            .eq("org_id", orgId)
            .eq("endpoint_id", id);
          if (error) {
            writeError = error.message;
            return;
          }
          probed += 1;
        }
      }),
    );
    if (writeError) return res.status(500).json({ error: `probe write failed: ${writeError}` });
  }

  res.json({
    ok: true,
    indexed_at: indexedAt,
    catalog_total: catalog.total,
    catalog_pages: catalog.pages,
    models_seen: catalog.models.length,
    models_written: written,
    curated_preserved: curated.size,
    curated_missing_from_catalog: curatedMissing,
    video_endpoints: videoIds.length,
    audio_probed_this_call: probed,
    audio_driving_found_this_call: driving,
    audio_probe_remaining: remaining,
  });
});

export default router;
