/**
 * smrtStudio — the unified production-management console over the AI-video
 * program. Read-only over the management spine (the studio_* tables): stages
 * and, per stage, their plan, checklist items, challenges and outputs, plus the
 * research index and the fal model catalog.
 *
 * The overview response is assembled by grouping the child rows (items,
 * challenges, outputs) under their stage in JS, so the whole 10-stage console
 * renders from a single round trip. Fields are English-only.
 *
 * Guards: requireAuth + requireOrg + requireApp("smrtstudio") — the per-app
 * slug, same as every other tenant-scoped module.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { requireAuth, requireOrg, requireApp, requireRole, isSuperAdmin } from "../../middleware";
import { fetchModelSchema } from "./indexer";
import { runSweep, sweepToCompletion, SweepError } from "./sweep";
import { MODEL_RECIPES } from "./recipes";
import {
  estimateRunCost, falKey, newRunCode, newWebhookToken, queueSubmit, webhookUrlFor,
} from "./runner";
import {
  pollVlmJudge, submitVlmJudge, vlmJudgeEnabled, vlmJudgeModel,
  type VlmJudgeHandle,
} from "./qc";
import { emitEvent } from "../../lib/platform";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrtstudio"));

type Row = Record<string, unknown>;

/**
 * GET /studio/overview — the whole 10-stage console in one round trip. For each
 * stage (ordered by position): its plan block, its checklist items (ordered by
 * group_order then position), its challenges and its outputs, plus a
 * done/total/pct roll-up over the items — followed by the org's total model
 * count. English-only payload; every read is org-scoped.
 */
router.get("/studio/overview", async (req: Request, res: Response) => {
  const orgId = req.org!.id;

  // One round trip for the whole console. Every read is org-scoped (`db` is the
  // service-role client, so RLS does NOT filter for us — the org predicate has
  // to be explicit) and destructures its own `{ error }`, so a failure on any
  // table is surfaced rather than swallowed.
  const [
    { data: stageRows, error: stagesErr },
    { data: itemRows, error: itemsErr },
    { data: chalRows, error: chalErr },
    { data: outRows, error: outErr },
    { count: modelsCount, error: modelsErr },
  ] = await Promise.all([
    db
      .from("studio_stages")
      .select(
        "slug,position,name_en,blurb_en,hue,kind,plan_desc_en,plan_general,plan_detail,plan_verify,smrtplan_url",
      )
      .eq("org_id", orgId)
      .order("position"),
    db
      .from("studio_items")
      .select(
        "stage_slug,group_key,group_order,group_note_en,position,title_en,status,desc_en,link_url,link_label",
      )
      .eq("org_id", orgId)
      .order("group_order")
      .order("position"),
    db
      .from("studio_challenges")
      .select("stage_slug,position,title_en,solved,detail_en")
      .eq("org_id", orgId)
      .order("position"),
    db
      .from("studio_outputs")
      .select("stage_slug,position,out_kind,label_en,meta_en,link_url")
      .eq("org_id", orgId)
      .order("position"),
    db
      .from("studio_models")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
  ]);

  const error = stagesErr ?? itemsErr ?? chalErr ?? outErr ?? modelsErr;
  if (error) return res.status(500).json({ error: error.message });

  // Bucket each child table under its stage once. The queries already ordered
  // the rows (items by group_order then position; challenges and outputs by
  // position), and grouping preserves that order — so each stage's arrays come
  // out sorted without any re-sort here.
  const groupByStage = (rows: unknown[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const row = r as Row;
      const k = String(row.stage_slug);
      const arr = m.get(k);
      if (arr) arr.push(row);
      else m.set(k, [row]);
    }
    return m;
  };
  const itemsByStage = groupByStage(itemRows ?? []);
  const chalByStage = groupByStage(chalRows ?? []);
  const outByStage = groupByStage(outRows ?? []);

  const stages = (stageRows ?? []).map((sRaw) => {
    const s = sRaw as Row;
    const slug = String(s.slug);
    const items = itemsByStage.get(slug) ?? [];
    const done = items.filter((it) => it.status === "done").length;
    const now = items.filter((it) => it.status === "now").length;
    const total = items.length;
    return {
      slug,
      name: s.name_en,
      blurb: s.blurb_en,
      hue: s.hue,
      kind: s.kind,
      plan: {
        desc: s.plan_desc_en,
        general: s.plan_general,
        detail: s.plan_detail,
        verify: s.plan_verify,
        smrtplan_url: s.smrtplan_url,
      },
      items: items.map((it) => ({
        group_key: it.group_key,
        group_order: it.group_order,
        group_note: it.group_note_en,
        title: it.title_en,
        status: it.status,
        desc: it.desc_en,
        link_url: it.link_url,
        link_label: it.link_label,
      })),
      challenges: (chalByStage.get(slug) ?? []).map((c) => ({
        problem: c.title_en,
        // `solved` is the authoritative flag from the column — the client must
        // not re-derive it from whether `solution` text happens to be present,
        // or a solved-but-undocumented challenge would read as unsolved.
        solved: !!c.solved,
        solution: c.solved ? c.detail_en : null,
      })),
      outputs: (outByStage.get(slug) ?? []).map((o) => ({
        kind: o.out_kind,
        label: o.label_en,
        meta: o.meta_en,
        link_url: o.link_url,
      })),
      done,
      total,
      pct: total ? Math.round(((done + 0.5 * now) / total) * 100) : 0,
    };
  });

  res.json({ stages, models_total: modelsCount ?? 0 });
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

/**
 * Stage A (docs/studio-build-plan.md) — the unified project spine.
 *
 * The video tab is the explicit motion set — never "everything that isn't an
 * image": stage is nullable and a null must not masquerade as a video.
 */
const VIDEO_STAGES = new Set(["video", "lipsync", "produce"]);

/**
 * Drain a PostgREST query past the server's silent 1000-row page cap.
 * Produce batches can push an org's run count far past one page, and a capped
 * read here would silently shrink tab counts — no error, just missing rows.
 */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) return { rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { rows, error: null };
  }
}

/**
 * GET /studio/projects — the org's projects with per-tab counts (voice
 * projects, image runs, video runs), newest first. `?status=archived` lists
 * the archive; default is active.
 */
router.get("/studio/projects", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const status = req.query.status === "archived" ? "archived" : "active";
  const [projects, voice, runs] = await Promise.all([
    db.from("studio_projects").select("*")
      .eq("org_id", orgId).eq("status", status)
      .order("created_at", { ascending: false }),
    pageAll<Row>((from, to) =>
      db.from("smrtvoice_projects").select("id, studio_project_id")
        .eq("org_id", orgId).order("id").range(from, to)),
    pageAll<Row>((from, to) =>
      db.from("experiment_runs").select("id, studio_project_id, stage")
        .eq("org_id", orgId).order("id").range(from, to)),
  ]);
  const err = projects.error || voice.error || runs.error;
  if (err) return res.status(500).json({ error: err.message });

  const voiceCount = new Map<string, number>();
  for (const v of voice.rows) {
    if (!v.studio_project_id) continue;
    const key = v.studio_project_id as string;
    voiceCount.set(key, (voiceCount.get(key) ?? 0) + 1);
  }
  const runCount = new Map<string, { image: number; video: number }>();
  for (const r of runs.rows) {
    if (!r.studio_project_id) continue;
    const key = r.studio_project_id as string;
    const c = runCount.get(key) ?? { image: 0, video: 0 };
    if (r.stage === "image") c.image += 1;
    else if (VIDEO_STAGES.has(r.stage as string)) c.video += 1;
    runCount.set(key, c);
  }
  res.json({
    projects: (projects.data ?? []).map((p: Row) => ({
      ...p,
      counts: {
        voice: voiceCount.get(p.id as string) ?? 0,
        image: runCount.get(p.id as string)?.image ?? 0,
        video: runCount.get(p.id as string)?.video ?? 0,
      },
    })),
  });
});

/** POST /studio/projects — create a project. Body: { name_he, name_en? }. */
router.post("/studio/projects", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const nameHe = typeof req.body?.name_he === "string" ? req.body.name_he.trim() : "";
  if (!nameHe) return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db.from("studio_projects").insert({
    org_id: orgId,
    created_by: req.user!.id,
    name_he: nameHe,
    name_en: typeof req.body?.name_en === "string" ? req.body.name_en.trim() : "",
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ project: data });
});

/**
 * GET /studio/projects/:id — one project with its three tabs' content:
 * linked voice projects, and the project's runs split image/video (the run
 * cards reuse the fields the scoring grid already renders).
 */
router.get("/studio/projects/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const id = req.params.id;
  const [project, voice, runs, consults] = await Promise.all([
    db.from("studio_projects").select("*")
      .eq("org_id", orgId).eq("id", id).maybeSingle(),
    db.from("smrtvoice_projects")
      .select("id, name, status, total_lines, completed_lines, total_cost_usd, updated_at")
      .eq("org_id", orgId).eq("studio_project_id", id)
      .order("updated_at", { ascending: false }),
    pageAll<Row>((from, to) =>
      db.from("experiment_runs")
        .select("id, code, model, method, stage, prompt, seed, cost_usd, output_url, run_status, error, qc_status, qc_score, qc_reason, qc_scores, qc_cost_usd, overridden, meta, created_at")
        .eq("org_id", orgId).eq("studio_project_id", id)
        .order("created_at", { ascending: false }).range(from, to)),
    pageAll<Row>((from, to) =>
      db.from("studio_consultations")
        .select("id, run_id, status, problem, answer, executed_run_ids, created_at, answered_at")
        .eq("org_id", orgId).eq("studio_project_id", id)
        .order("created_at", { ascending: false }).range(from, to)),
  ]);
  const err = project.error || voice.error || runs.error || consults.error;
  if (err) return res.status(500).json({ error: err.message });
  if (!project.data) return res.status(404).json({ error: "project not found" });
  // The card only needs the run's display code, not another query.
  const codeById = new Map(runs.rows.map((r: Row) => [r.id as string, r.code as string]));
  res.json({
    project: project.data,
    voice_projects: voice.data ?? [],
    image_runs: runs.rows.filter((r: Row) => r.stage === "image"),
    video_runs: runs.rows.filter((r: Row) => VIDEO_STAGES.has(r.stage as string)),
    consultations: consults.rows.map((c: Row) => ({
      ...c,
      run_code: codeById.get(c.run_id as string) ?? null,
    })),
    // Stage E: the VLM judge is opt-in on the backend (explicit flag) — the
    // client hides the button entirely when it cannot possibly run.
    vlm_qc_enabled: vlmJudgeEnabled() && Boolean(falKey()),
  });
});

/**
 * Stage B (docs/studio-build-plan.md) — the deterministic recommendation
 * layer behind the creation form. No LLM call, no cost: candidates come from
 * the indexed catalog (studio_models), the written method from MODEL_RECIPES
 * (synced from video-lab), and the input fields from fal's live OpenAPI
 * schema — "written method here, live contract there".
 *
 * GET /studio/recommendation?kind=image|video|lipsync|voice
 * Returns ranked candidates and the recommended model expanded with its
 * recipe and live schema. No winner-*.json exists yet in video-lab, so the
 * ranking is shortlist_rank (nulls last) with recipe-holders preferred —
 * `basis` says so explicitly instead of pretending a winner was locked.
 */
const RECOMMEND_KINDS = new Set(["image", "video", "lipsync", "voice"]);

router.get("/studio/recommendation", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const kind = String(req.query.kind ?? "");
  if (!RECOMMEND_KINDS.has(kind)) {
    return res.status(400).json({ error: "kind must be one of image|video|lipsync|voice" });
  }
  const { data, error } = await db.from("studio_models")
    .select("endpoint_id, title, category, vendor, price_usd, price_unit, price_note, shortlist_rank, verified_schema, recipe_path, flags")
    .eq("org_id", orgId).eq("kind", kind).eq("deprecated", false)
    .order("shortlist_rank", { ascending: true, nullsFirst: false })
    .order("endpoint_id")
    .limit(24);
  if (error) return res.status(500).json({ error: error.message });

  const rows: Row[] = (data ?? []).map((m: Row) => ({
    ...m,
    has_recipe: Boolean(MODEL_RECIPES[m.endpoint_id as string]),
  }));
  // Recipe-holders first within equal footing: a model whose method we wrote
  // down beats a bare catalog row at the same rank.
  rows.sort((a: Row, b: Row) => {
    const ra = (a.shortlist_rank as number | null) ?? Number.MAX_SAFE_INTEGER;
    const rb = (b.shortlist_rank as number | null) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return Number(b.has_recipe) - Number(a.has_recipe);
  });
  const candidates = rows.slice(0, 8);
  const top = candidates.find((m: Row) => m.has_recipe) ?? candidates[0];
  if (!top) {
    return res.json({ kind, basis: "empty_catalog", candidates: [], recommended: null });
  }

  // fetchModelSchema never throws — a fal failure comes back as
  // { available: false } (indexer.ts:742). Surface that explicitly so the
  // form degrades to prompt-only loudly, not behind a null error.
  const schema = await fetchModelSchema(top.endpoint_id as string);
  const schemaError =
    (schema as { available?: boolean }).available === false
      ? "fal schema unavailable for this endpoint"
      : null;
  res.json({
    kind,
    // A CODE, not prose — the client maps it to an i18n string. Values:
    // "shortlist_rank" (no locked winner yet) | future: "locked_winner".
    basis: "shortlist_rank",
    candidates,
    recommended: {
      endpoint_id: top.endpoint_id,
      recipe: MODEL_RECIPES[top.endpoint_id as string] ?? null,
      schema,
      schema_error: schemaError,
    },
  });
});

/**
 * Stage C (docs/studio-build-plan.md) — running from the screen, behind the
 * minimal cost gate (rule 2 embodied): the client first asks for an estimate,
 * shows it, and the submit is refused without `cost_approved: true`.
 *
 * POST /studio/runs/estimate  { endpoint_id, args } → { usd, basis }
 * POST /studio/runs           { studio_project_id, endpoint_id, prompt, args,
 *                               cost_approved } → { run }
 */
router.post("/studio/runs/estimate", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const endpointId = String(req.body?.endpoint_id ?? "");
  const { data: model, error } = await db.from("studio_models")
    .select("endpoint_id, price_usd, price_unit, kind")
    .eq("org_id", orgId).eq("endpoint_id", endpointId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!model) return res.status(404).json({ error: "endpoint not in the org catalog" });
  const est = estimateRunCost(model, (req.body?.args as Record<string, unknown>) ?? {});
  res.json({ endpoint_id: endpointId, ...est, fal_key_configured: Boolean(falKey()) });
});

router.post("/studio/runs", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!falKey()) {
    return res.status(503).json({ error: "FAL_KEY is not configured on the backend" });
  }
  const projectId = String(req.body?.studio_project_id ?? "");
  const endpointId = String(req.body?.endpoint_id ?? "");
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  const args = ((req.body?.args as Record<string, unknown>) ?? {});

  const [project, model] = await Promise.all([
    db.from("studio_projects").select("id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    db.from("studio_models").select("endpoint_id, kind, price_usd, price_unit")
      .eq("org_id", orgId).eq("endpoint_id", endpointId).maybeSingle(),
  ]);
  if (project.error || model.error) {
    return res.status(500).json({ error: (project.error || model.error)!.message });
  }
  if (!project.data) return res.status(404).json({ error: "project not found" });
  if (!model.data) return res.status(404).json({ error: "endpoint not in the org catalog" });

  // The cost gate. An unestimable price (tokens/megapixels) still requires the
  // ack — the client shows "cannot be estimated up front" and the user
  // approves running on real billing.
  const est = estimateRunCost(model.data, args);
  // The approval is FOR A NUMBER, not a blank cheque: the client echoes back
  // the estimate it displayed (approved_usd), and any drift — args edited
  // after the 402, price changed — re-gates with a fresh estimate instead of
  // spending an amount the user never saw.
  const approvedUsd = req.body?.approved_usd as number | null | undefined;
  const approvalMatches =
    approvedUsd !== undefined &&
    ((est.usd == null && approvedUsd == null) ||
      (est.usd != null && typeof approvedUsd === "number" &&
        Math.abs(est.usd - approvedUsd) < 0.0005));
  if (req.body?.cost_approved !== true || !approvalMatches) {
    return res.status(402).json({ error: "cost approval required", estimate: est });
  }

  const code = newRunCode();
  const token = newWebhookToken();
  const input: Record<string, unknown> = { ...args };
  if (prompt) input.prompt = prompt;

  const { data: run, error: insErr } = await db.from("experiment_runs").insert({
    org_id: orgId,
    studio_project_id: projectId,
    stage: model.data.kind === "image" ? "image" : model.data.kind === "voice" ? "voice" : "video",
    test_label: "studio-ui",
    code,
    model: endpointId,
    endpoint_id: endpointId,
    method: "studio creation form",
    prompt: prompt || null,
    seed: typeof args.seed === "number" ? args.seed : null,
    input_args: input,
    run_status: "pending",
    cost_usd: est.usd,
    meta: { kind: model.data.kind, webhook_token: token, cost_basis: est.basis, params: input },
  }).select("*").single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  try {
    const { request_id } = await queueSubmit(endpointId, input, webhookUrlFor(run.id, token));
    const { error: upErr } = await db.from("experiment_runs")
      .update({ fal_request_id: request_id, run_status: "submitted" })
      .eq("id", run.id);
    if (upErr) console.error(`[studio] run ${code} request-id update:`, upErr.message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("experiment_runs")
      .update({ run_status: "failed", error: msg }).eq("id", run.id);
    return res.status(502).json({ error: `fal submit failed: ${msg}` });
  }
  res.status(201).json({ run: { id: run.id, code, run_status: "submitted", estimate: est } });
});

/**
 * Stage E (docs/studio-build-plan.md) — the VLM judge, behind the explicit
 * STUDIO_VLM_JUDGE flag, and the human override that always trumps it.
 *
 * POST /studio/runs/:id/qc-vlm { cost_approved } — judge one finished
 * artifact with a broken-down rubric. Token-priced, so the 402 estimate is an
 * honest null; the REAL billed cost from the response is recorded in
 * qc_cost_usd either way — including when the judge's answer fails to parse,
 * because the tokens were spent either way.
 *
 * Money-safety shape (review findings 1+2, 2026-07-30):
 *   1. CLAIM a slot in qc_scores.vlm_pending with a guarded update — two
 *      concurrent clicks cannot both submit (the loser gets 409);
 *   2. submit, then IMMEDIATELY persist the fal request id into the claim —
 *      from that point the spend is reconcilable no matter what dies;
 *   3. poll; on deadline leave the pending record and tell the user to click
 *      again — the retry RESUMES the same request, it never pays twice;
 *   4. settle from a FRESH read of qc_cost_usd/qc_scores, clearing the claim.
 */
type VlmPendingRecord = Partial<VlmJudgeHandle> & { at?: string };

router.post("/studio/runs/:id/qc-vlm", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!vlmJudgeEnabled()) {
    return res.status(503).json({ error: "STUDIO_VLM_JUDGE is not enabled on the backend" });
  }
  if (!falKey()) {
    return res.status(503).json({ error: "FAL_KEY is not configured on the backend" });
  }
  const { data: run, error } = await db.from("experiment_runs")
    .select("id, code, stage, prompt, output_url, run_status, qc_status, qc_scores, input_args")
    .eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "run not found" });

  const kind = run.stage === "image" ? "image"
    : VIDEO_STAGES.has(run.stage as string) ? "video" : null;
  if (!kind) return res.status(409).json({ error: "only image/video artifacts can be judged" });
  // Judgeable = there is an output to look at, and the run is not still in
  // flight / failed. Legacy harness rows (run_status NULL) qualify — their
  // fal-hosted URL may have expired, in which case the judge fails loudly.
  const rs = (run.run_status as string | null) ?? null;
  if (!run.output_url || rs === "pending" || rs === "submitted" || rs === "failed") {
    return res.status(409).json({ error: "run has no finished output to judge" });
  }
  // The tier-0 principle scaled to the studio: never pay to judge a known
  // non-starter. A human override (back to pass) re-opens judging.
  if (run.qc_status === "rejected") {
    return res.status(409).json({ error: "run is already rejected — override it first if you disagree" });
  }
  if (req.body?.cost_approved !== true) {
    return res.status(402).json({
      error: "cost approval required",
      estimate: { usd: null, basis: "per_token" },
      judge_model: vlmJudgeModel(),
    });
  }

  const scores = ((run.qc_scores as Row | null) ?? {}) as Row;
  const pendingRaw = scores.vlm_pending as VlmPendingRecord | undefined;
  const pendingAgeMs = pendingRaw?.at ? Date.now() - Date.parse(pendingRaw.at) : Infinity;
  // A claim that never got its request id and is old is a crash leftover —
  // ignore it. One WITH a request id stays valid forever (the money is out).
  const pending: VlmPendingRecord | null =
    pendingRaw && (pendingRaw.request_id || pendingAgeMs < 10 * 60_000) ? pendingRaw : null;

  let handle: VlmJudgeHandle;
  if (pending?.request_id && pending.endpoint_id && pending.model && pending.criteria) {
    // Resume the already-paid request — no new submit, no new charge.
    handle = pending as VlmJudgeHandle;
  } else if (pending) {
    return res.status(409).json({ error: "a judge request is already being submitted for this run" });
  } else {
    // Claim the slot BEFORE submitting, guarded on the slot being free, so a
    // double-click cannot submit (and pay) twice. `select` makes the win
    // visible: zero rows back = lost the race.
    const claimAt = new Date().toISOString();
    const claimScores = { ...scores, vlm_pending: { at: claimAt } };
    let claimQuery = db.from("experiment_runs").update({ qc_scores: claimScores })
      .eq("id", run.id);
    claimQuery = pendingRaw
      ? claimQuery.eq("qc_scores->vlm_pending->>at", pendingRaw.at ?? "")
      : claimQuery.is("qc_scores->vlm_pending", null);
    const { data: claimed, error: claimErr } = await claimQuery.select("id");
    if (claimErr) return res.status(500).json({ error: claimErr.message });
    if (!claimed?.length) {
      return res.status(409).json({ error: "a judge request is already running for this run" });
    }

    // Reference for the identity criterion: the run's own input image (i2v /
    // edit), when it was given by URL. Absent → identity is left out of the
    // rubric rather than scored against nothing.
    const args = (run.input_args as Row | null) ?? {};
    const referenceUrl =
      typeof args.image_url === "string" ? args.image_url
      : Array.isArray(args.image_urls) && typeof args.image_urls[0] === "string"
        ? args.image_urls[0] : null;

    try {
      handle = await submitVlmJudge({
        kind,
        outputUrl: run.output_url as string,
        prompt: (run.prompt as string | null) ?? null,
        referenceUrl,
      });
    } catch (e) {
      // Submit failed → nothing was billed. Release the claim by REMOVING
      // the key — writing `vlm_pending: null` would leave a JSON null, which
      // the `is null` claim guard (SQL NULL) never matches, locking the run
      // out of judging forever.
      const released = { ...scores } as Row;
      delete released.vlm_pending;
      const { error: relErr } = await db.from("experiment_runs")
        .update({ qc_scores: released }).eq("id", run.id);
      if (relErr) console.error(`[studio-qc] ${run.code} claim release:`, relErr.message);
      return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
    // Money is now committed on fal's side — persist the request id FIRST,
    // so a crash/timeout from here on leaves a reconcilable record.
    const { error: pendErr } = await db.from("experiment_runs")
      .update({ qc_scores: { ...scores, vlm_pending: { ...handle, at: claimAt } } })
      .eq("id", run.id);
    if (pendErr) console.error(`[studio-qc] ${run.code} pending record:`, pendErr.message);
  }

  const verdict = await pollVlmJudge(handle);
  if (verdict.ok === "in_progress") {
    // The request is still running (and already paid). The pending record
    // stays; the next click resumes it for free.
    return res.status(504).json({
      error: "the judge is still running — try again in a minute; the same request will be picked up without paying again",
    });
  }

  // Settle from a FRESH read — the claim serializes judges, but overrides
  // and webhooks may have touched the row while we polled.
  const { data: fresh, error: freshErr } = await db.from("experiment_runs")
    .select("qc_scores, qc_cost_usd").eq("id", run.id).maybeSingle();
  if (freshErr || !fresh) {
    console.error(`[studio-qc] ${run.code} fresh read failed:`, freshErr?.message);
    return res.status(500).json({ error: "settle read failed — the check is recorded in vlm_pending" });
  }
  const freshScores = { ...((fresh.qc_scores as Row | null) ?? {}) } as Row;
  delete freshScores.vlm_pending;
  const spentBefore = fresh.qc_cost_usd == null ? 0 : Number(fresh.qc_cost_usd);
  const qcCost = Math.round((spentBefore + (verdict.cost ?? 0)) * 1e6) / 1e6;
  const at = new Date().toISOString();

  if (!verdict.ok) {
    const qcScores = {
      ...freshScores,
      vlm_error: {
        model: verdict.model,
        error: verdict.error,
        request_id: handle.request_id,
        cost_usd: verdict.cost,
        // usage.cost is required by the schema, so null here means the money
        // went out but the amount is unknown — flagged, never silently zero.
        cost_unknown: verdict.cost == null,
        at,
      },
    };
    const { error: upErr } = await db.from("experiment_runs")
      .update({ qc_scores: qcScores, qc_cost_usd: qcCost })
      .eq("id", run.id);
    if (upErr) console.error(`[studio-qc] ${run.code} failure record:`, upErr.message);
    return res.status(502).json({ error: `judge answer unusable: ${verdict.error}`, cost_usd: verdict.cost });
  }

  const qcScores = {
    ...freshScores,
    vlm: {
      model: verdict.model,
      verdict: verdict.verdict,
      criteria: verdict.criteria,
      summary: verdict.summary,
      request_id: handle.request_id,
      cost_usd: verdict.cost,
      cost_unknown: verdict.cost == null,
      at,
    },
  };
  const { error: upErr } = await db.from("experiment_runs").update({
    qc_status: verdict.verdict === "fail" ? "rejected" : "pass",
    qc_score: verdict.overall,
    qc_reason: verdict.summary || null,
    qc_scores: qcScores,
    qc_cost_usd: qcCost,
  }).eq("id", run.id);
  if (upErr) return res.status(500).json({ error: upErr.message });

  res.json({
    qc_status: verdict.verdict === "fail" ? "rejected" : "pass",
    qc_score: verdict.overall,
    verdict: verdict.verdict,
    criteria: verdict.criteria,
    summary: verdict.summary,
    cost_usd: verdict.cost,
    judge_model: verdict.model,
  });
});

/**
 * PATCH /studio/runs/:id/qc { status: pass|rejected, reason? } — the human
 * override. Always available (rule 13: the QC is a filter, never the arbiter
 * — it mis-judges stylized characters and Hebrew). The machine's verdict and
 * reasons stay in qc_scores untouched; `overridden` marks who decided.
 */
router.patch("/studio/runs/:id/qc", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const status = req.body?.status;
  if (status !== "pass" && status !== "rejected") {
    return res.status(400).json({ error: "status must be pass|rejected" });
  }
  const { data: run, error } = await db.from("experiment_runs")
    .select("id, qc_scores")
    .eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "run not found" });

  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
  const qcScores = {
    ...((run.qc_scores as Row | null) ?? {}),
    human_override: {
      status,
      reason,
      by: req.user!.id,
      at: new Date().toISOString(),
    },
  };
  // qc_reason follows the HUMAN decision — leaving the machine's rejection
  // text on an overridden-to-pass card reads as a contradiction. The machine
  // verdict survives verbatim in qc_scores.vlm.
  const { error: upErr } = await db.from("experiment_runs")
    .update({ qc_status: status, overridden: true, qc_scores: qcScores, qc_reason: reason })
    .eq("id", run.id);
  if (upErr) return res.status(500).json({ error: upErr.message });
  res.json({ qc_status: status, overridden: true });
});

/**
 * Stage D (docs/studio-build-plan.md) — the real-money surface.
 *
 * GET /studio/billing — fal credit balance (live, via FAL_ADMIN_KEY) + spend
 * roll-ups from the ledger. Money is manager information (rule 10; review
 * finding 9): gated requireRole(owner|admin) on top of the app chain — a
 * plain member gets 403, and the chip in the UI simply doesn't render.
 * Degrades loudly: no FAL_ADMIN_KEY → balance null + balance_error
 * "not_configured", never a silent zero.
 */
router.get("/studio/billing",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const orgId = req.org!.id;

    let balance: { current_balance: number; currency: string } | null = null;
    let balanceError: string | null = null;
    const adminKey = process.env.FAL_ADMIN_KEY || "";
    if (!adminKey) {
      balanceError = "not_configured";
    } else {
      try {
        const r = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
          headers: { Authorization: `Key ${adminKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { credits?: { current_balance: number; currency: string } };
        balance = j?.credits ?? null;
        if (!balance) balanceError = "no_credits_field";
      } catch (e) {
        balanceError = e instanceof Error ? e.message : String(e);
      }
    }

    // "This month" is the user's month — America/New_York (the repo's TZ
    // rule), not UTC: on the evening of the 31st in NY a UTC boundary would
    // already show ~$0. NY midnight on the 1st is 04:00 or 05:00 UTC (DST);
    // probe which offset puts NY at hour 0.
    const nyNow = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit",
    }).formatToParts(new Date());
    const nyYear = Number(nyNow.find((p) => p.type === "year")?.value);
    const nyMonth = Number(nyNow.find((p) => p.type === "month")?.value);
    let monthStart = new Date(Date.UTC(nyYear, nyMonth - 1, 1, 4));
    const hourInNy = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", hour12: false,
    }).format(monthStart);
    if (hourInNy !== "00") monthStart = new Date(Date.UTC(nyYear, nyMonth - 1, 1, 5));
    const runs = await pageAll<Row>((from, to) =>
      db.from("experiment_runs").select("studio_project_id, cost_usd, qc_cost_usd, created_at")
        .eq("org_id", orgId).order("id").range(from, to));
    if (runs.error) return res.status(500).json({ error: runs.error.message });

    let totalUsd = 0;
    let monthUsd = 0;
    const perProject = new Map<string, number>();
    for (const r of runs.rows) {
      // QC judge checks (stage E) are billed by fal exactly like the run
      // itself — a spend report that hides them under-reports real money.
      const gen = r.cost_usd == null ? 0 : Number(r.cost_usd);
      const qc = r.qc_cost_usd == null ? 0 : Number(r.qc_cost_usd);
      const c = (Number.isFinite(gen) ? gen : 0) + (Number.isFinite(qc) ? qc : 0);
      if (!c) continue;
      totalUsd += c;
      if (typeof r.created_at === "string" && r.created_at >= monthStart.toISOString()) monthUsd += c;
      if (r.studio_project_id) {
        const k = r.studio_project_id as string;
        perProject.set(k, (perProject.get(k) ?? 0) + c);
      }
    }
    res.json({
      balance,
      balance_error: balanceError,
      fal_total_usd: Math.round(totalUsd * 1000) / 1000,
      fal_month_usd: Math.round(monthUsd * 1000) / 1000,
      per_project_fal_usd: Object.fromEntries(
        [...perProject].map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
      ),
      top_up_url: "https://fal.ai/dashboard/billing",
    });
  });

/**
 * Stage F (docs/studio-build-plan.md) — the consultation pipeline.
 *
 * POST /studio/runs/:id/consult { problem } — "יש לי בעיה" on an artifact.
 * Freezes the run's FULL provenance into the consultation payload (the
 * expert-agent contract: a problem question arrives attached to its artifact
 * — provenance is read, never asked for) and files a smrtTask task for
 * pickup by a manual /expert session (v1 decision: no auto-lifter).
 */
router.post("/studio/runs/:id/consult", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const problem = typeof req.body?.problem === "string" ? req.body.problem.trim() : "";
  if (!problem) return res.status(400).json({ error: "problem is required" });

  const { data: run, error } = await db.from("experiment_runs")
    .select("id, code, stage, model, method, endpoint_id, prompt, seed, input_args, output_url, run_status, qc_status, qc_score, qc_reason, qc_scores, cost_usd, qc_cost_usd, derived_from, recipe_source, studio_project_id, meta, created_at")
    .eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "run not found" });
  if (!run.studio_project_id) {
    return res.status(409).json({ error: "run is not linked to a studio project" });
  }

  // The provenance snapshot — everything the expert needs to diagnose without
  // asking. meta is reduced to storage_paths (tokens stay out of the payload).
  const meta = (run.meta as Row | null) ?? {};
  const payload: Row = {
    code: run.code, stage: run.stage, model: run.model, method: run.method,
    endpoint_id: run.endpoint_id, prompt: run.prompt, seed: run.seed,
    input_args: run.input_args, output_url: run.output_url,
    run_status: run.run_status, qc_status: run.qc_status, qc_score: run.qc_score,
    qc_reason: run.qc_reason, qc_scores: run.qc_scores,
    cost_usd: run.cost_usd, qc_cost_usd: run.qc_cost_usd,
    derived_from: run.derived_from, recipe_source: run.recipe_source,
    storage_paths: meta.storage_paths ?? null, run_created_at: run.created_at,
  };

  const { data: consult, error: insErr } = await db.from("studio_consultations").insert({
    org_id: orgId,
    studio_project_id: run.studio_project_id,
    run_id: run.id,
    created_by: req.user!.id,
    problem,
    payload,
  }).select("id").single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  // The pickup task. Best-effort: the consultation row is the source of
  // truth; a task failure is reported but does not undo the filing.
  const appBase = (process.env.SMRTESY_APP_URL || "https://app.smrtesy.com").replace(/\/$/, "");
  const projectUrl = `${appBase}/he/studio/projects/${run.studio_project_id}`;
  const title = `התייעצות מומחה: בעיה בתוצר ${run.code}`;
  const description = [
    problem,
    `תוצר: ${run.code} · ${run.model}`,
    `מזהה התייעצות: ${consult.id}`,
    "הרמה: פתח סשן מומחה (‎/expert ברפו video-lab) עם מזהה ההתייעצות — הפרובננס המלא שמור על ההתייעצות. תשובת המומחה נכתבת דרך POST ‎/api/studio/jobs/consult-answer והפתרונות מוצגים לאישור במסך הפרויקט.",
  ].join("\n\n");
  const { data: task, error: taskErr } = await db.from("tasks").insert({
    user_id: req.user!.id,
    organization_id: orgId,
    task_type: "followup",
    status: "inbox",
    priority: "medium",
    manually_verified: true, // the user typed this problem themselves
    title,
    title_he: title,
    description,
    action_links: [{ label: "פתח את הפרויקט בסטודיו", url: projectUrl }],
    tags: ["studio-consult", `studio-consult:${consult.id}`],
    ai_model_used: null,
  }).select("id").single();
  if (taskErr) {
    console.error(`[studio-consult] task filing failed for ${consult.id}:`, taskErr.message);
  } else {
    const { error: linkErr } = await db.from("studio_consultations")
      .update({ task_id: task.id }).eq("id", consult.id);
    if (linkErr) console.error(`[studio-consult] task link failed:`, linkErr.message);
    await emitEvent(orgId, "smrtstudio", "consultation.created", "task", task.id, {
      run_code: run.code, consultation_id: consult.id,
    });
  }

  res.status(201).json({ consultation_id: consult.id, task_id: task?.id ?? null });
});

/** One solution in the expert's answer contract. `changes` is what executing
 *  it actually alters relative to the original run. */
type ConsultSolution = {
  title?: unknown;
  changes?: { endpoint_id?: unknown; args?: unknown; prompt?: unknown } | null;
  evidence?: unknown;
  est_cost?: unknown;
  risk?: unknown;
  move?: unknown;
};

/**
 * POST /studio/consultations/:id/execute { selected: number[], cost_approved,
 * approved_usd } — run the chosen solutions, behind the SAME cost gate as
 * /studio/runs: the first call (without cost_approved) answers 402 with a
 * per-solution estimate + total; the confirm echoes the total it displayed.
 * Every executed solution is a NEW run with derived_from = the consulted run.
 */
router.post("/studio/consultations/:id/execute", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!falKey()) {
    return res.status(503).json({ error: "FAL_KEY is not configured on the backend" });
  }
  const { data: consult, error } = await db.from("studio_consultations")
    .select("*").eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!consult) return res.status(404).json({ error: "consultation not found" });
  if (consult.status !== "answered" && consult.status !== "executed") {
    return res.status(409).json({ error: "consultation has no answer to execute yet" });
  }

  const solutions = ((consult.answer as Row | null)?.solutions ?? []) as ConsultSolution[];
  const selectedRaw = req.body?.selected;
  const selected: number[] = Array.isArray(selectedRaw)
    ? [...new Set(selectedRaw.map(Number))].filter((n) => Number.isInteger(n)) : [];
  if (!selected.length) return res.status(400).json({ error: "selected[] is required" });
  if (selected.some((i) => i < 0 || i >= solutions.length)) {
    return res.status(400).json({ error: "selected index out of range" });
  }

  const payload = (consult.payload as Row | null) ?? {};
  // Resolve each chosen solution to a concrete submit plan + estimate.
  const plans: {
    index: number; title: string; endpoint_id: string;
    input: Record<string, unknown>; model: Row | null;
    est: { usd: number | null; basis: string };
  }[] = [];
  for (const index of selected) {
    const sol = solutions[index];
    const changes = (sol.changes ?? {}) as Row;
    const endpointId = typeof changes.endpoint_id === "string" && changes.endpoint_id
      ? changes.endpoint_id
      : typeof payload.endpoint_id === "string" && payload.endpoint_id
        ? payload.endpoint_id
        : typeof payload.model === "string" ? payload.model : "";
    if (!endpointId) {
      return res.status(400).json({ error: `solution ${index} has no endpoint to run` });
    }
    const baseArgs = (payload.input_args as Record<string, unknown> | null) ?? {};
    const patch = (typeof changes.args === "object" && changes.args && !Array.isArray(changes.args)
      ? changes.args : {}) as Record<string, unknown>;
    const input: Record<string, unknown> = { ...baseArgs, ...patch };
    const prompt = typeof changes.prompt === "string" ? changes.prompt
      : typeof payload.prompt === "string" ? payload.prompt : "";
    if (prompt) input.prompt = prompt;

    const { data: model, error: mErr } = await db.from("studio_models")
      .select("endpoint_id, kind, price_usd, price_unit")
      .eq("org_id", orgId).eq("endpoint_id", endpointId).maybeSingle();
    if (mErr) return res.status(500).json({ error: mErr.message });
    // Off-catalog = unpriceable AND unvetted — refuse outright, exactly like
    // /studio/runs does. An expert answer travels through a machine channel;
    // the catalog check is the code-side veto on a bad endpoint string.
    if (!model) {
      return res.status(400).json({ error: `solution ${index}: endpoint ${endpointId} is not in the org catalog` });
    }
    plans.push({
      index,
      title: typeof sol.title === "string" ? sol.title : `פתרון ${index + 1}`,
      endpoint_id: endpointId, input, model: model as Row,
      est: estimateRunCost(model, input),
    });
  }

  const estimable = plans.filter((p) => p.est.usd != null);
  const unestimated = plans.length - estimable.length;
  const totalUsd = estimable.length
    ? Math.round(estimable.reduce((s, p) => s + (p.est.usd as number), 0) * 1000) / 1000
    : null;
  const estimateBody = {
    items: plans.map((p) => ({ index: p.index, title: p.title, endpoint_id: p.endpoint_id, ...p.est })),
    total_usd: totalUsd,
    unestimated,
  };
  // Same approval contract as /studio/runs, twice over: the ack is FOR the
  // number shown AND for the exact selection it was shown for — a matching
  // total on a different selection re-gates. Token-priced items in the batch
  // additionally require an explicit accept_unestimated (the client shows
  // them as "cannot estimate" line by line).
  const approvedUsd = req.body?.approved_usd as number | null | undefined;
  const approvedSelection = Array.isArray(req.body?.approved_selection)
    ? [...new Set((req.body.approved_selection as unknown[]).map(Number))].sort((a, b) => a - b)
    : null;
  const selectionMatches =
    approvedSelection != null &&
    JSON.stringify(approvedSelection) === JSON.stringify([...selected].sort((a, b) => a - b));
  const totalMatches =
    approvedUsd !== undefined &&
    ((totalUsd == null && approvedUsd == null) ||
      (totalUsd != null && typeof approvedUsd === "number" &&
        Math.abs(totalUsd - approvedUsd) < 0.0005));
  const unestimatedAcked = unestimated === 0 || req.body?.accept_unestimated === true;
  if (req.body?.cost_approved !== true || !totalMatches || !selectionMatches || !unestimatedAcked) {
    return res.status(402).json({ error: "cost approval required", estimate: estimateBody });
  }

  // Claim slot (the qc-vlm pattern): flip answered/executed → executing with
  // a conditional update, so two concurrent approvals cannot both submit and
  // pay. A crash leaves 'executing' — reclaimable after 10 minutes.
  const staleClaim = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: claimed, error: claimErr } = await db.from("studio_consultations")
    .update({ status: "executing", updated_at: new Date().toISOString() })
    .eq("id", consult.id)
    .or(`status.in.(answered,executed),and(status.eq.executing,updated_at.lt.${staleClaim})`)
    .select("id");
  if (claimErr) return res.status(500).json({ error: claimErr.message });
  if (!claimed?.length) {
    return res.status(409).json({ error: "an execution is already running for this consultation" });
  }

  // Submit each plan as a new run. One failure does not abort the batch —
  // it is recorded as a failed run and reported per item.
  const results: { index: number; run_id?: string; code?: string; error?: string }[] = [];
  const newRunIds: string[] = [];
  for (const plan of plans) {
    const kind = (plan.model?.kind as string) ?? payload.stage ?? "video";
    const code = newRunCode();
    const token = newWebhookToken();
    const { data: newRun, error: runErr } = await db.from("experiment_runs").insert({
      org_id: orgId,
      studio_project_id: consult.studio_project_id,
      stage: kind === "image" ? "image" : kind === "voice" ? "voice" : "video",
      test_label: "studio-consult",
      code,
      model: plan.endpoint_id,
      endpoint_id: plan.endpoint_id,
      method: `expert consultation fix: ${plan.title}`,
      prompt: typeof plan.input.prompt === "string" ? plan.input.prompt : null,
      seed: typeof plan.input.seed === "number" ? plan.input.seed : null,
      input_args: plan.input,
      run_status: "pending",
      derived_from: consult.run_id,
      cost_usd: plan.est.usd,
      meta: {
        kind, webhook_token: token, cost_basis: plan.est.basis, params: plan.input,
        consultation_id: consult.id, solution_index: plan.index, solution_title: plan.title,
      },
    }).select("id").single();
    if (runErr) {
      results.push({ index: plan.index, error: runErr.message });
      continue;
    }
    try {
      const { request_id } = await queueSubmit(plan.endpoint_id, plan.input, webhookUrlFor(newRun.id, token));
      const { error: upErr } = await db.from("experiment_runs")
        .update({ fal_request_id: request_id, run_status: "submitted" })
        .eq("id", newRun.id);
      if (upErr) console.error(`[studio-consult] ${code} request-id update:`, upErr.message);
      results.push({ index: plan.index, run_id: newRun.id, code });
      newRunIds.push(newRun.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("experiment_runs")
        .update({ run_status: "failed", error: msg }).eq("id", newRun.id);
      results.push({ index: plan.index, run_id: newRun.id, code, error: `fal submit failed: ${msg}` });
    }
  }

  // Release the claim: 'executed' when anything ran; back to the pre-claim
  // status when nothing did, so a fully-failed batch stays retryable.
  const prior = Array.isArray(consult.executed_run_ids) ? consult.executed_run_ids : [];
  const { error: exErr } = await db.from("studio_consultations").update({
    status: newRunIds.length ? "executed" : consult.status,
    executed_run_ids: [...prior, ...newRunIds],
    updated_at: new Date().toISOString(),
  }).eq("id", consult.id);
  if (exErr) console.error(`[studio-consult] ${consult.id} executed update:`, exErr.message);

  res.status(newRunIds.length ? 201 : 502).json({ results, executed: newRunIds.length });
});

/**
 * Stage G0 (docs/studio-build-plan.md) — voice creation FROM the studio.
 *
 * POST /studio/projects/:id/voice-projects { name, code_prefix? } — creates a
 * smrtVoice project already linked (studio_project_id) to this studio
 * project, so voice work starts from the voice tab without ever visiting the
 * smrtVoice app. The full pipeline (scripts → lines → takes, the approval
 * flow, voice-engine) continues in the existing screens — absorbed, not
 * rebuilt. Free: creating a project runs nothing paid.
 */
const VOICE_PREFIX_RE = /^[A-Z]{1,3}$/; // mirrors smrtvoice/routes.ts PREFIX_RE
router.post("/studio/projects/:id/voice-projects", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  const prefix = (req.body?.code_prefix ?? "").toString().trim().toUpperCase() || null;
  if (prefix && !VOICE_PREFIX_RE.test(prefix)) {
    return res.status(400).json({ error: "Invalid code prefix — use 1-3 letters (e.g. BR)" });
  }

  const { data: project, error: pErr } = await db.from("studio_projects")
    .select("id").eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  // Stage G: the voice screens are guarded by the same smrtstudio entitlement
  // as this route (the absorption flipped the voice router's requireApp), so
  // reaching here already proves the org can open what gets created.
  const { data, error } = await db.from("smrtvoice_projects").insert({
    org_id: orgId,
    created_by: req.user!.id,
    name,
    description: typeof req.body?.description === "string" ? req.body.description : null,
    code_prefix: prefix,
    language: "he",
    status: "draft",
    studio_project_id: project.id,
  }).select("id, name").single();
  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: prefix
          ? `A project with prefix "${prefix}" already exists`
          : "A conflicting voice project already exists",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  await emitEvent(orgId, "smrtvoice", "project.created", "project", data.id, { name: data.name });
  res.status(201).json({ voice_project: data });
});

/** PATCH /studio/projects/:id — rename / describe / archive. */
router.patch("/studio/projects/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const patch: Row = {};
  for (const key of ["name_he", "name_en", "description_he", "description_en"]) {
    if (typeof req.body?.[key] === "string") patch[key] = req.body[key].trim();
  }
  // A project must keep a Hebrew name — an all-whitespace rename is dropped,
  // not written as "".
  if (patch.name_he === "") delete patch.name_he;
  if (req.body?.status === "active" || req.body?.status === "archived") {
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }
  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("studio_projects").update(patch)
    .eq("org_id", orgId).eq("id", req.params.id)
    .select("*").maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "project not found" });
  res.json({ project: data });
});

export default router;
