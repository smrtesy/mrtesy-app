import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { db } from "../../db";
import { emitEvent, notifyError } from "../../lib/platform";
import { composePrompt } from "../claude/playbooks";
import { executeRun } from "../claude/runner";
import { buildGenerationPrompt, buildRemixPrompt, DIMENSIONS, type Dimension } from "./prompt";

const router = Router();

const RENDER_BUCKET = "smrtdesign-renders";
const SIGNED_TTL = 60 * 60; // 1h — the gallery re-fetches on load
const REPO = "smrtesy/mrtesy-app"; // the run clones this repo so docs/design-process.md (the method) loads
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const str = (v: unknown, max = 2000): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Attach a short-lived signed URL to each option row (renders bucket is private). */
async function withSignedUrls(
  options: Array<{ image_url: string | null; [k: string]: unknown }>,
): Promise<unknown[]> {
  return Promise.all(
    options.map(async (o) => {
      if (!o.image_url) return { ...o, image_signed_url: null };
      const { data, error } = await db.storage
        .from(RENDER_BUCKET)
        .createSignedUrl(o.image_url, SIGNED_TTL);
      if (error) console.error("[smrtdesign] signed url failed:", error.message);
      return { ...o, image_signed_url: data?.signedUrl ?? null };
    }),
  );
}

// ─── LIST PROJECTS ───────────────────────────────────────────
router.get("/design/projects", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtdesign_projects")
    .select("id, name, subject, languages, status, option_count, created_at, updated_at")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: data ?? [] });
});

// ─── CREATE PROJECT ──────────────────────────────────────────
router.post("/design/projects", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const name = str(body.name, 200);
  const subject = str(body.subject, 2000);
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!subject) return res.status(400).json({ error: "subject is required" });

  const audience = str(body.audience, 500) || null;
  const langsIn = Array.isArray(body.languages) ? body.languages : ["he"];
  const languages = langsIn.filter((l: unknown) => l === "he" || l === "en");
  const optionCount = Math.min(8, Math.max(1, Number(body.option_count) || 4));

  const { data, error } = await db
    .from("smrtdesign_projects")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      name,
      subject,
      audience,
      languages: languages.length ? languages : ["he"],
      option_count: optionCount,
      status: "draft",
    })
    .select("id, name, subject, languages, status, option_count, created_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(req.org!.id, "smrtdesign", "project.created", "project", data.id, {
    name: data.name,
  });
  res.status(201).json({ project: data });
});

// ─── GET PROJECT (options + selections; lazily syncs run status) ──
router.get("/design/projects/:id", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  // Lazy poll: if a generation/remix run is driving this project, reflect its
  // terminal state. `thread_id` holds the driving run id (see prompt.ts / schema).
  if (project.status === "generating" && project.thread_id) {
    const { data: run, error: runErr } = await db
      .from("claude_runs")
      .select("id, error, ended_at, started_at")
      .eq("org_id", orgId)
      .eq("id", project.thread_id)
      .maybeSingle();
    if (runErr) console.error("[smrtdesign] run lookup failed:", runErr.message);
    // Resolve on terminal, missing, or stale — a backend restart mid-run leaves
    // the run 'running' with no reaper, which would otherwise stick forever.
    const startedMs = run?.started_at ? Date.parse(run.started_at) : NaN;
    const stale = Number.isFinite(startedMs) && Date.now() - startedMs > 20 * 60 * 1000;
    let next: string | null = null;
    if (run?.ended_at) next = run.error ? "failed" : "options_ready";
    else if (!run || stale) next = "failed";
    if (next) {
      const { error: updErr } = await db
        .from("smrtdesign_projects")
        .update({ status: next })
        .eq("id", project.id);
      if (updErr) console.error("[smrtdesign] status sync failed:", updErr.message);
      else project.status = next;
    }
  }

  const { data: options, error: oErr } = await db
    .from("smrtdesign_options")
    .select("*")
    .eq("project_id", project.id)
    .order("round", { ascending: true })
    .order("created_at", { ascending: true });
  if (oErr) return res.status(500).json({ error: oErr.message });

  const { data: selections, error: selErr } = await db
    .from("smrtdesign_selections")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false });
  if (selErr) console.error("[smrtdesign] selections load failed:", selErr.message);

  res.json({
    project,
    options: await withSignedUrls(options ?? []),
    selections: selections ?? [],
  });
});

/** Kick a generation/remix run: compose the method-primed prompt, tell the run
 *  to POST each option back here, and fire it. Returns the run id (stored as the
 *  project's driving id in `thread_id`). */
async function startRun(
  req: Request,
  res: Response,
  projectId: string,
  basePrompt: string,
  title: string,
) {
  const orgId = req.org!.id;
  const callback = [
    ``,
    `After rendering an option and emitting its \`smrtdesign-option\` block, POST it`,
    `to smrtDesign so it appears in the gallery — one POST per option:`,
    "```bash",
    `curl -sS -X POST "$SMRTESY_API_URL/api/design/projects/${projectId}/options" \\`,
    `  -H "Authorization: Bearer $SMRTESY_API_TOKEN" -H "X-Org-Id: $SMRTESY_ORG_ID" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"anchor":"…","title":"…","spec":{…7 dimensions…},"image_base64":"<base64 of the PNG>","is_combined":false}'`,
    "```",
    `The image_base64 is the screenshot you rendered (raw base64, no data: prefix).`,
    `$SMRTESY_API_URL, $SMRTESY_API_TOKEN and $SMRTESY_ORG_ID are already in your env.`,
  ].join("\n");

  const composed = await composePrompt(orgId, `${basePrompt}\n${callback}`, null);

  const { data: run, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      title,
      prompt: composed.prompt,
      user_prompt: basePrompt,
      repo: REPO,
      status: "queued",
    })
    .select("id")
    .single();
  if (error) {
    await notifyError(orgId, "smrtdesign", { title: "Design run could not start", body: error.message });
    return res.status(500).json({ error: "could not start run" });
  }

  await db
    .from("smrtdesign_projects")
    .update({ status: "generating", thread_id: run.id })
    .eq("id", projectId);

  void executeRun(run.id).catch((e) =>
    console.error("[smrtdesign] executeRun threw:", e instanceof Error ? e.message : e),
  );
  return res.status(202).json({ run_id: run.id, status: "generating" });
}

// ─── GENERATE ────────────────────────────────────────────────
router.post("/design/projects/:id/generate", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("id, name, subject, audience, languages, option_count")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  const prompt = buildGenerationPrompt({
    subject: project.subject,
    audience: project.audience,
    languages: project.languages ?? ["he"],
    optionCount: project.option_count ?? 4,
  });
  return startRun(req, res, project.id, prompt, `smrtDesign — ${project.name}`);
});

// ─── INGEST AN OPTION (called by the generation/remix run) ───
router.post("/design/projects/:id/options", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = req.body ?? {};

  const { data: project, error: pErr } = await db
    .from("smrtdesign_projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  const anchor = str(body.anchor, 500) || null;
  const title = str(body.title, 200) || null;
  const isCombined = body.is_combined === true;
  const round = Math.min(50, Math.max(1, Number(body.round) || (isCombined ? 2 : 1)));
  const spec = body.spec && typeof body.spec === "object" ? body.spec : {};

  // Upload the render if present.
  let storagePath: string | null = null;
  const b64 = typeof body.image_base64 === "string" ? body.image_base64.replace(/^data:[^;]+;base64,/, "") : "";
  if (b64) {
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length === 0) return res.status(400).json({ error: "image is empty" });
    if (buffer.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: "image too large" });
    const optionId = crypto.randomUUID();
    storagePath = `${orgId}/${project.id}/${optionId}.png`;
    const { error: upErr } = await db.storage
      .from(RENDER_BUCKET)
      .upload(storagePath, buffer, { contentType: "image/png", upsert: false });
    if (upErr) return res.status(500).json({ error: `upload failed: ${upErr.message}` });
  }

  const { data, error } = await db
    .from("smrtdesign_options")
    .insert({
      org_id: orgId,
      project_id: project.id,
      round,
      anchor,
      title,
      spec_json: spec,
      image_url: storagePath,
      is_combined: isCombined,
    })
    .select("id, round, anchor, title, is_combined, created_at")
    .single();
  if (error) {
    if (storagePath) await db.storage.from(RENDER_BUCKET).remove([storagePath]);
    return res.status(500).json({ error: error.message });
  }

  await emitEvent(orgId, "smrtdesign", "design.generated", "option", data.id, {
    project_id: project.id,
    is_combined: isCombined,
  });
  res.status(201).json({ option: data });
});

// ─── REMIX (pick-from-each → combined) ───────────────────────
router.post("/design/projects/:id/remix", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = req.body ?? {};
  const picksIn = body.picks && typeof body.picks === "object" ? body.picks : {};

  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  // Resolve the picked source options and build { label -> spec } + { dim -> label }.
  const optionIds = [...new Set(Object.values(picksIn).filter((v): v is string => typeof v === "string"))];
  if (optionIds.length === 0) return res.status(400).json({ error: "picks are required" });

  const { data: sourceOptions, error: sErr } = await db
    .from("smrtdesign_options")
    .select("id, title, anchor, spec_json")
    .eq("project_id", project.id)
    .in("id", optionIds);
  if (sErr) return res.status(500).json({ error: sErr.message });

  const labelOf = (id: string): string => {
    const o = (sourceOptions ?? []).find((x) => x.id === id);
    return o?.title || o?.anchor || id;
  };
  const sources: Record<string, Record<string, unknown>> = {};
  for (const o of sourceOptions ?? []) sources[o.title || o.anchor || o.id] = o.spec_json ?? {};
  const picks: Partial<Record<Dimension, string>> = {};
  for (const d of DIMENSIONS) {
    const pick = picksIn[d];
    if (typeof pick === "string") picks[d] = labelOf(pick);
  }

  // Record the selection (combined_option_id filled once the run posts it back).
  const { data: selection, error: selInsErr } = await db
    .from("smrtdesign_selections")
    .insert({ org_id: orgId, project_id: project.id, created_by: req.user!.id, picks_json: picksIn })
    .select("id")
    .single();
  if (selInsErr) console.error("[smrtdesign] selection insert failed:", selInsErr.message);

  const prompt = buildRemixPrompt({ picks, sources });
  // startRun sets status=generating; the run posts the combined option (is_combined=true).
  void selection; // selection row created; combined_option_id linkage is a v2+ enhancement
  return startRun(req, res, project.id, prompt, `smrtDesign remix — ${project.name}`);
});

// ─── LOCK an option as the project's chosen design ───────────
router.post("/design/options/:id/lock", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: option, error } = await db
    .from("smrtdesign_options")
    .select("id, project_id, spec_json")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!option) return res.status(404).json({ error: "option not found" });

  // Unlock siblings, lock this one, and set the project's locked brief.
  const { error: unlockErr } = await db
    .from("smrtdesign_options")
    .update({ is_locked: false })
    .eq("project_id", option.project_id);
  if (unlockErr) return res.status(500).json({ error: unlockErr.message });

  const { error: lockErr } = await db
    .from("smrtdesign_options")
    .update({ is_locked: true })
    .eq("id", option.id);
  if (lockErr) return res.status(500).json({ error: lockErr.message });

  const { error: projErr } = await db
    .from("smrtdesign_projects")
    .update({ status: "locked", brief_json: option.spec_json ?? {} })
    .eq("id", option.project_id);
  if (projErr) return res.status(500).json({ error: projErr.message });

  await emitEvent(orgId, "smrtdesign", "design.locked", "option", option.id, {
    project_id: option.project_id,
  });
  res.json({ ok: true });
});

export default router;
