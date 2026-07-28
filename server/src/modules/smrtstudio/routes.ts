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
import { fetchModelSchema } from "./indexer";
import { runSweep, sweepToCompletion, SweepError } from "./sweep";
import { MODEL_RECIPES } from "./recipes";

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
/** Which fal categories live in each navigation group. Mirrors GROUP_BY_CATEGORY
 *  in indexer.ts — the two must agree, or a chip counts a category the tab does
 *  not actually contain. The derived tabs span whole groups rather than a fixed
 *  category list. */
const GROUP_CATEGORIES: Record<string, string[]> = {
  image: ["text-to-image", "image-to-image"],
  video: ["text-to-video", "image-to-video", "video-to-video", "audio-to-video"],
  audio: ["text-to-speech", "text-to-audio", "audio-to-audio", "speech-to-speech", "video-to-audio"],
  understanding: ["vision", "speech-to-text", "image-to-text", "video-to-text", "audio-to-text", "image-to-json"],
  "3d": ["image-to-3d", "text-to-3d", "3d-to-3d"],
  training: ["training"],
  tools: ["llm", "json", "text-to-json", "workflow", "unknown"],
};
const ALL_CATEGORIES = [...new Set(Object.values(GROUP_CATEGORIES).flat())];

function CATEGORIES_IN_GROUP(group: string | null): string[] {
  if (group === "audio_video") return GROUP_CATEGORIES.video;
  if (!group || group === "tools_pipeline") return ALL_CATEGORIES;
  return GROUP_CATEGORIES[group] ?? ALL_CATEGORIES;
}

const CAP_COLUMNS: Record<string, string> = {
  si: "cap_start_image",
  ei: "cap_end_image",
  pr: "cap_prompt",
  lo: "cap_lora",
};

router.get("/studio/models", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const str = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).trim() : "");
  const kind = str("kind") && str("kind") !== "all" ? str("kind") : null;
  // The seven navigation groups, plus two derived tabs that are not fal
  // categories at all: `audio_video` (a video endpoint that takes an audio file
  // we upload) and `tools` (the ffmpeg plumbing fal scatters across four
  // categories, unfindable among the creative models).
  const group = str("group") && str("group") !== "all" ? str("group") : null;
  const audioRole = str("audio");
  const build = str("build");
  const verifiedOnly = req.query.verified === "1";
  const term = str("q");
  const caps = str("caps").split(",").filter(Boolean);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 300;

  /** Every filter except the one named, so a chip can report how many results
   *  it WOULD yield rather than the size of the slice it already sits in.
   *
   * Typed through a narrow structural shape rather than a generic constrained
   * to the builder: PostgREST's own builder type is deep enough that inferring
   * it through this function tripped TS2589 ("type instantiation is excessively
   * deep"). The cast is contained here and every caller keeps its real type.
   */
  type Filterable = {
    eq: (c: string, v: unknown) => Filterable;
    gt: (c: string, v: unknown) => Filterable;
    not: (c: string, o: string, v: unknown) => Filterable;
    or: (f: string) => Filterable;
  };
  const applyFilters = <T>(builder: T, skip: string | null = null): T => {
    let out = builder as Filterable;
    if (group === "audio_video") {
      out = out.eq("group_key", "video").not("audio_input", "is", null);
    } else if (group === "tools_pipeline") {
      out = out.eq("is_pipeline_tool", true);
    } else if (group) {
      out = out.eq("group_key", group);
    }
    if (skip !== "kind" && kind) out = out.eq("kind", kind);
    if (skip !== "cat" && str("category")) out = out.eq("fal_category", str("category"));
    if (skip !== "audio" && audioRole) out = out.eq("audio_input", audioRole);
    if (skip !== "build" && build) out = out.eq("audio_build", build);
    for (const c of caps) {
      // `skip` names ONE cap to leave out — the one whose chip is being
      // counted. Dropping all of them made every chip report a number that
      // ignored the other active caps.
      if (skip === `cap:${c}`) continue;
      if (c === "ma") out = out.gt("cap_audio_channels", 1);
      else if (CAP_COLUMNS[c]) out = out.eq(CAP_COLUMNS[c], true);
    }
    if (verifiedOnly) out = out.eq("verified_schema", true);
    if (term) {
      // PostgREST parses `or=(...)` as structured text: a comma, dot, paren or
      // quote in the term would rewrite the filter rather than be matched.
      const safe = term.replace(/[,().*:"'\\]/g, "");
      if (safe) {
        out = out.or(
          `endpoint_id.ilike.%${safe}%,title.ilike.%${safe}%,vendor.ilike.%${safe}%,family.ilike.%${safe}%,summary.ilike.%${safe}%`,
        );
      }
    }
    return out as T;
  };

  let q = applyFilters(db.from("studio_models").select("*", { count: "exact" }).eq("org_id", orgId));
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

  // Tallies come from COUNT queries, never from counting rows in JS.
  //
  // They used to be computed by fetching every row and tallying client-side with
  // `.range(0, 4999)`. PostgREST caps a response at its `db-max-rows` (1000
  // here) and silently clamps a wider range, so with 1,394 models every chip
  // showed a number derived from an arbitrary first 1,000 rows — the counts
  // summed to exactly 1000 and the lip-sync chip read 0 while six models sat in
  // it. A count with `head: true` returns no rows at all, so no cap can apply.
  const KINDS = ["image", "voice", "video", "video_audio", "lipsync", "qc", "other"];
  const ROLES = ["driving", "reference", "mux"];
  const GROUPS = ["image", "video", "audio", "understanding", "3d", "training", "tools"];
  const BUILDS = ["full_scene", "full_body", "avatar", "mouth_fix"];
  const CAP_KEYS = Object.keys(CAP_COLUMNS).concat("ma");

  function baseCount() {
    return db
      .from("studio_models")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
  }
  const tally = (build: (q: ReturnType<typeof baseCount>) => ReturnType<typeof baseCount>) =>
    build(baseCount());

  // Group and tab counts are unfiltered — a tab must show the size of the tab,
  // not of the slice you are already looking at. Everything below the tabs is
  // faceted: counted with every OTHER filter applied, so a chip reading 0 means
  // "no results if you also click this", and disabling it costs nothing.
  // The tools group is a catch-all: `groupOf()` sends every UNMAPPED fal
  // category there, so its chip list cannot be a fixed array or a category fal
  // adds tomorrow is invisible and the chips stop summing to the tab. Read the
  // distinct values instead. Safe against the 1000-row cap because the tools
  // group is two dozen rows, and it is the only group whose list is open-ended.
  let toolsCategories: string[] | null = null;
  if (group === "tools") {
    const { data: tRows, error: tErr } = await db
      .from("studio_models")
      .select("fal_category")
      .eq("org_id", orgId)
      .eq("group_key", "tools")
      .limit(1000);
    if (tErr) return res.status(500).json({ error: tErr.message });
    toolsCategories = [
      ...new Set((tRows ?? []).map((r) => String((r as Row).fal_category || "unknown"))),
    ].sort();
  }
  const categoryList = toolsCategories ?? CATEGORIES_IN_GROUP(group);

  const [
    kindCounts,
    groupCounts,
    roleCounts,
    buildCounts,
    capCounts,
    categoryCountRows,
    totalRes,
    verifiedRes,
    probedRes,
    audioVideoRes,
    toolRes,
  ] = await Promise.all([
    Promise.all(KINDS.map((k) => tally((q) => q.eq("kind", k)))),
    Promise.all(GROUPS.map((g) => tally((q) => q.eq("group_key", g)))),
    Promise.all(ROLES.map((r) => tally((q) => applyFilters(q, "audio").eq("audio_input", r)))),
    Promise.all(BUILDS.map((b) => tally((q) => applyFilters(q, "build").eq("audio_build", b)))),
    Promise.all(
      CAP_KEYS.map((c) =>
        tally((q) =>
          c === "ma"
            ? applyFilters(q, `cap:${c}`).gt("cap_audio_channels", 1)
            : applyFilters(q, `cap:${c}`).eq(CAP_COLUMNS[c], true),
        ),
      ),
    ),
    // Counted per category with head-only queries, NOT by reading rows and
    // tallying. PostgREST caps a response at db-max-rows (1000) and silently
    // clamps anything wider, so a row-read tally quietly goes wrong the moment
    // a group holds more than 1000 models — the exact failure that once made
    // every chip on this screen sum to 1000. A head count returns no rows, so
    // no cap can apply.
    Promise.all(
      categoryList.map((c) => tally((q) => applyFilters(q, "cat").eq("fal_category", c))),
    ),
    tally((q) => q),
    tally((q) => q.eq("verified_schema", true)),
    tally((q) => q.eq("audio_probed", true)),
    tally((q) => q.eq("group_key", "video").not("audio_input", "is", null)),
    tally((q) => q.eq("is_pipeline_tool", true)),
  ]);

  const firstTallyError =
    kindCounts.find((r) => r.error)?.error ??
    groupCounts.find((r) => r.error)?.error ??
    roleCounts.find((r) => r.error)?.error ??
    buildCounts.find((r) => r.error)?.error ??
    capCounts.find((r) => r.error)?.error ??
    categoryCountRows.find((r) => r.error)?.error ??
    totalRes.error ??
    verifiedRes.error ??
    probedRes.error ??
    audioVideoRes.error ??
    toolRes.error;
  if (firstTallyError) return res.status(500).json({ error: firstTallyError.message });

  const byIndex = (keys: string[], rows: { count: number | null }[]) => {
    const out: Record<string, number> = {};
    keys.forEach((k, i) => {
      out[k] = rows[i].count ?? 0;
    });
    return out;
  };

  const categoryCounts = byIndex(categoryList, categoryCountRows);

  res.json({
    items: data ?? [],
    matched: count ?? (data ?? []).length,
    returned: (data ?? []).length,
    limit,
    counts: byIndex(KINDS, kindCounts),
    group_counts: byIndex(GROUPS, groupCounts),
    category_counts: categoryCounts,
    build_counts: byIndex(BUILDS, buildCounts),
    cap_counts: byIndex(CAP_KEYS, capCounts),
    total: totalRes.count ?? 0,
    verified_total: verifiedRes.count ?? 0,
    audio_counts: byIndex(ROLES, roleCounts),
    audio_probed_total: probedRes.count ?? 0,
    audio_video_total: audioVideoRes.count ?? 0,
    pipeline_tool_total: toolRes.count ?? 0,
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
 *   probe_limit  — cap the probe at N endpoints per round (default 150). The
 *                  probe skips endpoints already probed.
 *   until_done   — loop rounds until nothing is left (default true). The
 *                  catalog pass runs once; only the probe repeats.
 *   probe_audio  — false skips pass 2 entirely, and implies until_done:false.
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
  const probeLimit = Number.isFinite(rawLimit) ? rawLimit : 150;
  // One press finishes the job. The sweep grew from ~513 endpoints to ~1394,
  // and a single round covers 150 — so "press it seven more times" had quietly
  // become the interface. `complete: false` in the reply means the round cap or
  // the deadline stopped it, not that the work is done.
  // `probe_audio:false` has to win: without it in this condition the caller
  // asked to skip the probe and still got up to fifteen probe rounds.
  const runToEnd = body.until_done !== false && probeAudioFlag;

  try {
    const result = runToEnd
      ? await sweepToCompletion(orgId, { probeLimit })
      : await runSweep(orgId, { probeAudio: probeAudioFlag, probeLimit });
    res.json(result);
  } catch (e) {
    if (e instanceof SweepError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /studio/models/detail?endpoint_id=… — everything known about one model.
 *
 * Three sources, deliberately kept distinct on the way out so the screen can
 * show WHERE each claim comes from:
 *
 *   row     — our catalog record: rank, stage, price, and the audio-role
 *             classification with fal's own wording as its evidence.
 *   recipe  — the written method: when to use it, the feeding method, prompt
 *             structure, tricks and limits. Prose a human wrote.
 *   schema  — the INPUT CONTRACT, read live from fal on this request. Not cached
 *             on purpose: a stored copy of someone else's contract can go stale
 *             silently, and this program has already been burned by relying on
 *             an inferred field instead of the published one.
 *
 * The endpoint id arrives as a query parameter rather than a path segment
 * because it contains slashes ("fal-ai/kling-video/v3/pro/image-to-video").
 */
router.get("/studio/models/detail", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const endpointId = typeof req.query.endpoint_id === "string" ? req.query.endpoint_id.trim() : "";
  if (!endpointId) return res.status(400).json({ error: "endpoint_id is required" });

  const { data: row, error } = await db
    .from("studio_models")
    .select("*")
    .eq("org_id", orgId)
    .eq("endpoint_id", endpointId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: "model not in this org's catalog" });

  // The live read is allowed to fail without failing the screen: the recipe and
  // our own record are still worth showing, and `schema.available: false` says
  // plainly that the contract could not be read rather than implying no inputs.
  const schema = await fetchModelSchema(endpointId);

  res.json({
    model: row,
    recipe: MODEL_RECIPES[endpointId] ?? null,
    schema,
    /** Where to read the original, verbatim — the model page and, when a recipe
     *  exists, the file in video-lab that holds the method. */
    links: {
      fal: `https://fal.ai/models/${endpointId}`,
      schema: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpointId)}`,
      recipe: MODEL_RECIPES[endpointId]
        ? `https://github.com/smrtesy/video-lab/blob/main/${MODEL_RECIPES[endpointId].file}`
        : null,
    },
  });
});

export default router;
