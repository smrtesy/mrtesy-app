import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { db } from "../../db";
import { emitEvent, notifyError } from "../../lib/platform";
import { composePrompt } from "../claude/playbooks";
import { executeRun } from "../claude/runner";
import {
  buildGenerationPrompt,
  buildRemixPrompt,
  buildOpenConversationPrompt,
  buildLinkThreadPrompt,
  DIMENSIONS,
  type Dimension,
} from "./prompt";

// UUID shape guard for thread ids the client passes to link-thread.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    .select("id, name, subject, languages, status, option_count, mode, created_at, updated_at")
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

  // Lazy poll — ONLY for auto mode (the v1 blind run): reflect the driving run's
  // terminal state. In conversation mode a single ended turn is NOT terminal (the
  // chat continues in the console and more renders can arrive), so we never flip it
  // to failed/options_ready here — it rests at 'generating' (=active) until the
  // user locks an option. `thread_id` holds the claude_threads id; the run is the
  // latest turn of that thread (a repo run must belong to a thread — runner.ts).
  if (project.mode === "auto" && project.status === "generating" && project.thread_id) {
    const { data: run, error: runErr } = await db
      .from("claude_runs")
      .select("id, error, ended_at, started_at")
      .eq("org_id", orgId)
      .eq("thread_id", project.thread_id)
      .order("created_at", { ascending: false })
      .limit(1)
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
  } else if (project.mode === "conversation" && project.status === "generating" && project.thread_id) {
    // Conversation mode never fails on a single ended turn — EXCEPT the opening
    // turn: if the latest turn errored and the project has produced NO options at
    // all, the chat never really started (e.g. the seed turn hit a runtime error),
    // and resting at 'generating' forever is indistinguishable from an active chat.
    const { data: run } = await db
      .from("claude_runs")
      .select("error, ended_at")
      .eq("org_id", orgId)
      .eq("thread_id", project.thread_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run?.ended_at && run.error) {
      const { count } = await db
        .from("smrtdesign_options")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id);
      if ((count ?? 0) === 0) {
        const { error: updErr } = await db
          .from("smrtdesign_projects")
          .update({ status: "failed" })
          .eq("id", project.id);
        if (updErr) console.error("[smrtdesign] status sync failed:", updErr.message);
        else project.status = "failed";
      }
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

/** The "post each render back to the gallery" instruction, appended to every
 *  prompt smrtDesign sends its thread. $SMRTESY_* are injected into the run env by
 *  the console's app-access layer (app-access.ts). */
function ingestCallback(projectId: string): string {
  return [
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
}

/** Get the project's driving Claude thread, creating it once if needed. A repo run
 *  MUST belong to a thread — the runner needs a stable per-thread working directory
 *  to clone the repo into and to resume the session across turns (runner.ts).
 *  `visible=false` (auto mode) archives the thread so it stays out of the /claude
 *  console list (that list filters `archived_at is null`); `visible=true`
 *  (conversation mode) leaves it visible so the user can chat in the console.
 *  Returns the thread id, or null on failure. */
async function ensureProjectThread(
  orgId: string,
  userId: string,
  projectId: string,
  currentThreadId: string | null,
  title: string,
  visible: boolean,
): Promise<string | null> {
  if (currentThreadId) {
    const { data: t } = await db
      .from("claude_threads")
      .select("id, archived_at")
      .eq("id", currentThreadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (t) {
      // Reusing an archived (auto) thread for a conversation: un-archive it so it
      // shows in the /claude console list the user is about to be sent to.
      if (visible && t.archived_at) {
        const { error: unErr } = await db.from("claude_threads").update({ archived_at: null }).eq("id", t.id);
        if (unErr) console.error("[smrtdesign] un-archive failed:", unErr.message);
      }
      return t.id; // real thread — reuse it (turns resume the same session)
    }
    // else: legacy value (a run id from before the thread fix) — make a real one
  }
  const { data: thread, error } = await db
    .from("claude_threads")
    .insert({
      org_id: orgId,
      created_by: userId,
      title,
      repo: REPO,
      archived_at: visible ? null : new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[smrtdesign] thread create failed:", error.message);
    return null;
  }
  // Fail the start if we can't link the thread to the project: otherwise thread_id
  // stays null, the poll's resolver never runs, and the project sticks at generating.
  const { error: linkErr } = await db
    .from("smrtdesign_projects")
    .update({ thread_id: thread.id })
    .eq("id", projectId);
  if (linkErr) {
    console.error("[smrtdesign] project thread link failed:", linkErr.message);
    return null;
  }
  return thread.id;
}

/** Enqueue one turn on a design thread and fire it. Composes (method + standing
 *  instructions) only on the thread's FIRST turn — later turns resume the session
 *  which already holds them (mirrors the console, threads.ts). Returns the run id,
 *  or an error string ("already generating" when a turn is live). */
async function enqueueTurn(
  orgId: string,
  userId: string,
  threadId: string,
  promptText: string,
  title: string,
): Promise<{ runId?: string; error?: string }> {
  const { data: live } = await db
    .from("claude_runs")
    .select("id")
    .eq("thread_id", threadId)
    .in("status", ["queued", "running", "waiting"])
    .limit(1);
  if (live && live.length > 0) return { error: "already generating" };

  const { count: prior } = await db
    .from("claude_runs")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);
  const turnIndex = (prior ?? 0) + 1;

  // Inherit the thread's execution settings so the runner resumes with the right
  // account token / model — critical for a LINKED console conversation that is
  // pinned to a specific account (threads.ts:735 copies these onto every turn).
  // For our own threads repo=REPO and the rest are null, so this is a no-op there.
  const { data: thread } = await db
    .from("claude_threads")
    .select("repo, model, effort, claude_account, git_branch")
    .eq("id", threadId)
    .maybeSingle();

  // First turn carries the method + standing instructions; later turns don't
  // (the resumed session still holds them) — same rule as the console.
  const prompt = turnIndex === 1 ? (await composePrompt(orgId, promptText, null)).prompt : promptText;

  const { data: run, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: userId,
      thread_id: threadId,
      turn_index: turnIndex,
      title,
      prompt,
      user_prompt: promptText,
      repo: thread?.repo ?? null,
      model: thread?.model ?? null,
      effort: thread?.effort ?? null,
      claude_account: thread?.claude_account ?? null,
      git_branch: thread?.git_branch ?? null,
      status: "queued",
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { error: "already generating" }; // turn-index race
    return { error: error.message };
  }

  void executeRun(run.id).catch((e) =>
    console.error("[smrtdesign] executeRun threw:", e instanceof Error ? e.message : e),
  );
  return { runId: run.id };
}

/** Auto mode (v1): fire a blind generation/remix run as a turn of an archived
 *  thread, then respond. Sets mode='auto' so the GET poll flips terminal state. */
async function startAutoRun(
  req: Request,
  res: Response,
  projectId: string,
  currentThreadId: string | null,
  basePrompt: string,
  title: string,
) {
  const orgId = req.org!.id;
  const threadId = await ensureProjectThread(orgId, req.user!.id, projectId, currentThreadId, title, false);
  if (!threadId) {
    await notifyError(orgId, "smrtdesign", { title: "Design run could not start", body: "thread create failed" });
    return res.status(500).json({ error: "could not start run" });
  }

  const { runId, error } = await enqueueTurn(
    orgId,
    req.user!.id,
    threadId,
    `${basePrompt}\n${ingestCallback(projectId)}`,
    title,
  );
  if (error === "already generating") return res.status(409).json({ error });
  if (error || !runId) {
    await notifyError(orgId, "smrtdesign", { title: "Design run could not start", body: error ?? "unknown" });
    return res.status(500).json({ error: "could not start run" });
  }

  await db
    .from("smrtdesign_projects")
    .update({ status: "generating", mode: "auto" })
    .eq("id", projectId);
  return res.status(202).json({ run_id: runId, status: "generating" });
}

// ─── GENERATE ────────────────────────────────────────────────
router.post("/design/projects/:id/generate", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("id, name, subject, audience, languages, option_count, thread_id")
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
  return startAutoRun(req, res, project.id, project.thread_id, prompt, `smrtDesign — ${project.name}`);
});

// ─── OPEN (interactive conversation — the primary v2 flow) ───
// Creates/reuses a VISIBLE Claude thread, posts a seeded opening turn (method +
// brief + ingest callback + "refine first, render on go"), and returns the thread
// id so the client can open /claude?thread=<id>. Renders posted from that chat
// land in this project's gallery.
router.post("/design/projects/:id/open", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("id, name, subject, audience, languages, option_count, thread_id")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  const threadId = await ensureProjectThread(
    req.org!.id,
    req.user!.id,
    project.id,
    project.thread_id,
    `smrtDesign — ${project.name}`,
    true,
  );
  if (!threadId) return res.status(500).json({ error: "could not open conversation" });

  // Seed the opening turn only if the thread has none yet — reopening an existing
  // conversation just returns its id (the chat is already going).
  const { count: prior } = await db
    .from("claude_runs")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);
  if ((prior ?? 0) === 0) {
    const opening = buildOpenConversationPrompt({
      subject: project.subject,
      audience: project.audience,
      languages: project.languages ?? ["he"],
      optionCount: project.option_count ?? 4,
    });
    const { error: turnErr } = await enqueueTurn(
      req.org!.id,
      req.user!.id,
      threadId,
      `${opening}\n${ingestCallback(project.id)}`,
      `smrtDesign — ${project.name}`,
    );
    if (turnErr && turnErr !== "already generating") {
      await notifyError(req.org!.id, "smrtdesign", { title: "Could not open design conversation", body: turnErr });
      return res.status(500).json({ error: "could not open conversation" });
    }
  }

  await db
    .from("smrtdesign_projects")
    .update({ status: "generating", mode: "conversation" })
    .eq("id", project.id);

  res.status(202).json({ thread_id: threadId, console_path: `/claude?thread=${threadId}` });
});

// ─── LINK an existing console conversation to this project (option A) ───
router.post("/design/projects/:id/link-thread", requireAuth, requireOrg, requireApp("smrtdesign"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const threadId = str(req.body?.thread_id, 64);
  if (!UUID_RE.test(threadId)) return res.status(400).json({ error: "invalid thread_id" });

  const { data: project, error } = await db
    .from("smrtdesign_projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!project) return res.status(404).json({ error: "project not found" });

  // The thread must belong to this org — never link across tenants.
  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id")
    .eq("id", threadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!thread) return res.status(404).json({ error: "thread not found" });

  const { error: updErr } = await db
    .from("smrtdesign_projects")
    .update({ thread_id: threadId, status: "generating", mode: "conversation" })
    .eq("id", project.id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Tell the linked conversation to post its future renders here.
  const { error: turnErr } = await enqueueTurn(
    orgId,
    req.user!.id,
    threadId,
    `${buildLinkThreadPrompt()}\n${ingestCallback(project.id)}`,
    "smrtDesign — link",
  );
  if (turnErr && turnErr !== "already generating") {
    return res.status(500).json({ error: turnErr });
  }
  res.status(202).json({ thread_id: threadId, console_path: `/claude?thread=${threadId}` });
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
    .select("id, name, thread_id")
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
  // startAutoRun posts the combined option (is_combined=true) into the gallery.
  void selection; // selection row created; combined_option_id linkage is a v2+ enhancement
  return startAutoRun(req, res, project.id, project.thread_id, prompt, `smrtDesign remix — ${project.name}`);
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
