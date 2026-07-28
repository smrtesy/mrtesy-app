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
import { fetchCatalog, probeAudio, isVideoCategory, fetchModelSchema } from "./indexer";
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

  // Pass 1 rebuilt `kind` from fal's category, which UNDOES what pass 2 decided
  // on an earlier sweep: an endpoint filed by fal as `image-to-video` but probed
  // as audio-driven goes back to plain `video`, and pass 2 then skips it because
  // it is already probed. The result was a `video_audio` count that shrank every
  // time the sweep ran. Re-assert the probe's verdict for shelf rows before pass
  // 2 begins — the probe is the stronger evidence, and this is self-healing.
  const { error: reassertErr } = await db
    .from("studio_models")
    .update({ kind: "video_audio", stage_slug: "motion", stage_order: 7 })
    .eq("org_id", orgId)
    .eq("verified_schema", false)
    .eq("audio_input", "driving")
    .neq("kind", "video_audio");
  if (reassertErr) return res.status(500).json({ error: `re-assert failed: ${reassertErr.message}` });

  // ── pass 2: the audio probe ──
  // Every model, not only the video ones. The probe used to cover the ~513
  // video endpoints because it was looking for audio inputs alone. It now also
  // reads the capability flags — takes a start image, an end image, a prompt, a
  // trained LoRA — and those are the filters the catalog screen is built on, so
  // an unprobed row is a row that silently disappears from every filter.
  const videoModels = catalog.models.filter((m) => isVideoCategory(m.fal_category));
  const probeIds = catalog.models.map((m) => m.endpoint_id);
  const categoryOf = new Map(catalog.models.map((m) => [m.endpoint_id, m.fal_category]));
  const purposeOf = new Map(catalog.models.map((m) => [m.endpoint_id, m.summary]));

  let probed = 0;
  let driving = 0;
  let remaining = 0;
  if (probeAudioFlag && probeLimit > 0) {
    // Paged in 1000-row chunks, NOT one `.range(0, 4999)`. PostgREST's
    // db-max-rows is 1000 and it clamps a wider range silently. That was
    // harmless while only the ~513 video endpoints were ever probed, but the
    // probe now covers all ~1394: from roughly the seventh press onward the
    // "already done" set would hold only 1000 of them, so `todo` floored at
    // ~394, `remaining` froze at ~244 and never reached 0, and every further
    // press re-probed 150 endpoints that were already done — a sweep that
    // could never finish and kept telling the operator to press again.
    const alreadyProbed = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pageErr } = await db
        .from("studio_models")
        .select("endpoint_id")
        .eq("org_id", orgId)
        .eq("audio_probed", true)
        .order("endpoint_id")
        .range(from, from + PAGE - 1);
      if (pageErr) return res.status(500).json({ error: pageErr.message });
      for (const r of page ?? []) alreadyProbed.add(String((r as Row).endpoint_id));
      if (!page || page.length < PAGE) break;
    }

    const todo = probeIds.filter((id) => !alreadyProbed.has(id));
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
          const probe = await probeAudio(id, categoryOf.get(id) ?? "", purposeOf.get(id) ?? "");
          // A model that takes our audio as a DRIVING input is its own category:
          // it can carry the motion stage and the lip-sync stage in one call,
          // which no silent image-to-video model can do.
          const patch: Record<string, unknown> = {
            audio_probed: true,
            audio_input: probe.audio_input,
            audio_field: probe.audio_field,
            audio_note: probe.audio_note,
            audio_build: probe.audio_build,
            audio_classified_from: probe.audio_classified_from,
            schema_available: probe.schema_available,
            input_field_count: probe.input_field_count,
            cap_prompt: probe.cap_prompt,
            cap_negative_prompt: probe.cap_negative_prompt,
            cap_start_image: probe.cap_start_image,
            cap_end_image: probe.cap_end_image,
            cap_video_input: probe.cap_video_input,
            cap_lora: probe.cap_lora,
            cap_seed: probe.cap_seed,
            cap_audio_channels: probe.cap_audio_channels,
          };
          if (probe.audio_input === "driving") {
            driving += 1;
            // Re-file only SHELF rows. A curated row keeps the category a human
            // gave it: the six lip-sync models are audio-driven by nature, and
            // moving them to `video_audio`/motion emptied the lip-sync category
            // and lost the stage they actually belong to. Being audio-driven is
            // recorded in `audio_input` either way — that is the fact; `kind` is
            // the judgement, and the judgement stays human.
            if (!curated.has(id)) {
              patch.kind = "video_audio";
              patch.stage_slug = "motion";
              patch.stage_order = 7;
            }
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
    catalog_sweeps: catalog.sweeps,
    // True when the convergent sweep still could not reach fal's own reported
    // total. Surfaced rather than swallowed: the previous single-pass sweep
    // indexed 76% of the catalog and reported success.
    catalog_incomplete: catalog.incomplete,
    models_seen: catalog.models.length,
    models_written: written,
    curated_preserved: curated.size,
    curated_missing_from_catalog: curatedMissing,
    video_endpoints: videoModels.length,
    audio_probed_this_call: probed,
    audio_driving_found_this_call: driving,
    audio_probe_remaining: remaining,
  });
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
