/**
 * Threads — the chat itself.
 *
 * A claude_runs row used to be a one-shot: ask, read the answer, and a follow-up
 * started from nothing. A thread owns the engine's session id, so every turn after
 * the first is RESUMED into it (see runner.ts) and the conversation actually
 * remembers. That single fact is what turns this screen into a chat.
 *
 *   GET    /api/claude/threads                 the list, newest activity first
 *   POST   /api/claude/threads                 open a conversation
 *   GET    /api/claude/threads/:id             the thread + every turn + events
 *   PATCH  /api/claude/threads/:id             rename, archive, change settings
 *   DELETE /api/claude/threads/:id             remove it and its turns
 *   POST   /api/claude/threads/:id/messages    send a message (one turn)
 *   POST   /api/claude/threads/:id/attachments upload a file for the next message
 *   POST   /api/claude/runs/:id/cancel         stop a turn in flight
 *
 * WHERE THE STANDING INSTRUCTIONS GO: only into the FIRST turn. The engine session
 * keeps them for every later turn, so re-sending them would waste the context
 * window on text the model already has, and would let an edit made mid-conversation
 * contradict what it was told earlier.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { executeRun, cancelRun, runOneShot } from "./runner";
import { composePrompt } from "./playbooks";
import { isValidRepo, isValidBranch } from "./github";
import { saveAttachment, removeThreadAttachments, MAX_BASE64_CHARS } from "./attachments";
import { removeThreadWorkspace, sweepWorkspaces } from "./workspace";
import { runSplitAnalysis, applySplit, runGroupAnalysis, shouldAnalyzeSplit } from "./analysis";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 200;
const MAX_MESSAGE = 20_000;
/** Turns returned for one thread. A conversation longer than this is paged by the
 *  client asking for a slice; the cap stops one huge thread from timing out. */
const TURN_PAGE = 200;
/** Events per turn. A single agentic turn can emit hundreds of tool calls. */
const EVENT_CAP = 400;

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const THREAD_COLS =
  "id, title, title_source, session_id, model, effort, repo, git_branch, playbook_id, archived_at, last_message_at, created_at";

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Housekeeping hook for stale thread directories.
 *
 * Attached to the list route rather than a timer: it runs when someone is actually
 * using the screen, needs no scheduler, and cannot fire on a container that is idle.
 * Rate-limited in memory and fire-and-forget, so it never delays the response.
 */
let lastSweep = 0;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  void sweepWorkspaces().catch(() => {});
}

// ── list / create ─────────────────────────────────────────────────────────────

router.get("/claude/threads", async (req: Request, res: Response) => {
  maybeSweep();
  const includeArchived = req.query.archived === "1";
  let q = db
    .from("claude_threads")
    .select(THREAD_COLS)
    .eq("org_id", req.org!.id)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (!includeArchived) q = q.is("archived_at", null);

  const { data, error } = await q;
  if (error) {
    console.error("[claude/threads] list failed:", error.message);
    return res.status(500).json({ error: "could not list threads" });
  }
  return res.json({ threads: data ?? [] });
});

router.post("/claude/threads", async (req: Request, res: Response) => {
  const body = req.body ?? {};

  const model = str(body.model, 64);
  if (model && !MODEL_RE.test(model)) return res.status(400).json({ error: "invalid model" });
  const effort = str(body.effort, 16);
  if (effort && !EFFORTS.has(effort)) return res.status(400).json({ error: "invalid effort" });
  const repo = str(body.repo, 200);
  if (repo && !isValidRepo(repo)) return res.status(400).json({ error: "repo must be owner/name" });
  const gitBranch = str(body.git_branch, 200);
  if (gitBranch && !isValidBranch(gitBranch)) return res.status(400).json({ error: "invalid branch" });
  const playbookId = str(body.playbook_id, 64) || null;
  if (playbookId && !UUID_RE.test(playbookId)) return res.status(400).json({ error: "invalid playbook_id" });

  const { data, error } = await db
    .from("claude_threads")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      // Empty, not "New chat": the title is written from the conversation's actual
      // content once there is content (see maybeTitle). A placeholder here would
      // become the permanent title of every thread whose titling call failed.
      title: str(body.title, MAX_TITLE),
      title_source: str(body.title, MAX_TITLE) ? "user" : "auto",
      model: model || null,
      effort: effort || null,
      repo: repo || null,
      git_branch: gitBranch || null,
      playbook_id: playbookId,
    })
    .select(THREAD_COLS)
    .single();

  if (error) {
    console.error("[claude/threads] insert failed:", error.message);
    return res.status(500).json({ error: "could not create thread" });
  }
  return res.status(201).json({ thread: data });
});

// ── read one, with its turns ──────────────────────────────────────────────────

router.get("/claude/threads/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });

  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select(THREAD_COLS)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (tErr) {
    console.error("[claude/threads] fetch failed:", tErr.message);
    return res.status(500).json({ error: "could not fetch thread" });
  }
  if (!thread) return res.status(404).json({ error: "thread not found" });

  const { data: runs, error: rErr } = await db
    .from("claude_runs")
    .select(
      "id, turn_index, status, user_prompt, result_summary, error, model, effort, resumed_session, moved_to_thread_id, total_cost_usd, input_tokens, output_tokens, num_turns, duration_ms, created_at, ended_at",
    )
    .eq("thread_id", thread.id)
    .order("turn_index", { ascending: true })
    .limit(TURN_PAGE);
  if (rErr) {
    console.error("[claude/threads] turns failed:", rErr.message);
    return res.status(500).json({ error: "could not fetch turns" });
  }

  const ids = (runs ?? []).map((r) => r.id);
  // One query for every turn's events instead of N: a 40-turn thread would
  // otherwise be 40 round trips before the screen can paint.
  const eventsByRun = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const { data: events, error: eErr } = await db
      .from("claude_run_events")
      .select("run_id, seq, kind, text, tool_name, created_at")
      .in("run_id", ids)
      // Ordered by run FIRST: with a global seq order, one 400-event turn consumed
      // the whole budget and an older turn came back empty — rendering a blank
      // answer for a turn that had answered perfectly well.
      .order("run_id", { ascending: true })
      .order("seq", { ascending: true })
      .limit(EVENT_CAP * ids.length);
    if (eErr) console.error("[claude/threads] events failed:", eErr.message);
    for (const ev of events ?? []) {
      const list = eventsByRun.get(ev.run_id) ?? [];
      if (list.length < EVENT_CAP) list.push(ev);
      eventsByRun.set(ev.run_id, list);
    }
  }

  const { data: attachments, error: aErr } = await db
    .from("claude_attachments")
    .select("id, run_id, filename, mime_type, size_bytes")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: true });
  if (aErr) console.error("[claude/threads] attachments failed:", aErr.message);

  // The open split proposal, if any — the banner the user acts on.
  const { data: splitProposal } = await db
    .from("claude_thread_analyses")
    .select("id, proposal, created_at")
    .eq("thread_id", thread.id)
    .eq("kind", "split")
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Child threads this one was split into — shown as links so a moved-turns fold can
  // point at where the turns went.
  const { data: children } = await db
    .from("claude_threads")
    .select("id, title")
    .eq("parent_thread_id", thread.id)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: true });

  return res.json({
    thread,
    turns: (runs ?? []).map((r) => ({
      ...r,
      events: eventsByRun.get(r.id) ?? [],
      attachments: (attachments ?? []).filter((a) => a.run_id === r.id),
    })),
    split_proposal: splitProposal ?? null,
    children: children ?? [],
  });
});

// ── update / delete ───────────────────────────────────────────────────────────

router.patch("/claude/threads/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const body = req.body ?? {};
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.title !== undefined) {
    const title = str(body.title, MAX_TITLE);
    if (!title) return res.status(400).json({ error: "title cannot be empty" });
    patch.title = title;
    // A title the user typed is theirs. Marking the source is what stops the
    // automatic titling from ever overwriting it.
    patch.title_source = "user";
  }
  if (body.archived !== undefined) {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }
  if (body.model !== undefined) {
    const model = str(body.model, 64);
    if (model && !MODEL_RE.test(model)) return res.status(400).json({ error: "invalid model" });
    patch.model = model || null;
  }
  if (body.effort !== undefined) {
    const effort = str(body.effort, 16);
    if (effort && !EFFORTS.has(effort)) return res.status(400).json({ error: "invalid effort" });
    patch.effort = effort || null;
  }
  if (body.repo !== undefined) {
    const repo = str(body.repo, 200);
    if (repo && !isValidRepo(repo)) return res.status(400).json({ error: "repo must be owner/name" });
    patch.repo = repo || null;
  }
  if (body.git_branch !== undefined) {
    const b = str(body.git_branch, 200);
    if (b && !isValidBranch(b)) return res.status(400).json({ error: "invalid branch" });
    patch.git_branch = b || null;
  }
  if (body.playbook_id !== undefined) {
    const p = str(body.playbook_id, 64) || null;
    if (p && !UUID_RE.test(p)) return res.status(400).json({ error: "invalid playbook_id" });
    patch.playbook_id = p;
  }

  const { data, error } = await db
    .from("claude_threads")
    .update(patch)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select(THREAD_COLS)
    .maybeSingle();
  if (error) {
    console.error("[claude/threads] update failed:", error.message);
    return res.status(500).json({ error: "could not update thread" });
  }
  if (!data) return res.status(404).json({ error: "thread not found" });
  return res.json({ thread: data });
});

router.delete("/claude/threads/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });

  // Ownership first: the storage and disk cleanup below are not row-scoped, so they
  // must never run for an id belonging to another tenant.
  const { data: owned, error: oErr } = await db
    .from("claude_threads")
    .select("id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (oErr) return res.status(500).json({ error: "could not verify thread" });
  if (!owned) return res.status(404).json({ error: "thread not found" });

  // Bytes BEFORE rows: the rows are what name the objects, so deleting them first
  // would orphan every file in the bucket with nothing left pointing at it.
  await removeThreadAttachments(owned.id);

  const { error } = await db
    .from("claude_threads")
    .delete()
    .eq("id", owned.id)
    .eq("org_id", req.org!.id);
  if (error) {
    console.error("[claude/threads] delete failed:", error.message);
    return res.status(500).json({ error: "could not delete thread" });
  }

  // The conversation's working directory — a checkout and any downloaded files —
  // UNLESS a fork child still borrows it (workspace_thread_id points here). Removing
  // it out from under an active fork child would delete the engine session that
  // child resumes, silently erasing its memory. The dir is left for the borrower;
  // it is swept once nothing points at it and it goes stale.
  const { data: borrowers } = await db
    .from("claude_threads")
    .select("id")
    .eq("workspace_thread_id", owned.id)
    .limit(1);
  if (!borrowers || borrowers.length === 0) {
    await removeThreadWorkspace(owned.id);
  }
  return res.json({ ok: true });
});

// ── attachments ───────────────────────────────────────────────────────────────

router.post("/claude/threads/:id/attachments", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const { filename, mime_type, base64 } = (req.body ?? {}) as {
    filename?: string;
    mime_type?: string;
    base64?: string;
  };
  if (!base64 || typeof base64 !== "string") return res.status(400).json({ error: "base64 is required" });
  if (base64.length > MAX_BASE64_CHARS) return res.status(413).json({ error: "file is too large" });

  // Ownership is checked before anything is stored: an id from another tenant must
  // not be able to drop bytes into our bucket.
  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: "could not verify thread" });
  if (!thread) return res.status(404).json({ error: "thread not found" });

  try {
    const attachment = await saveAttachment({
      orgId: req.org!.id,
      threadId: thread.id,
      userId: req.user!.id,
      filename: str(filename, 200) || "file",
      mimeType: str(mime_type, 200) || null,
      base64,
    });
    return res.status(201).json({ attachment });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── send a message ────────────────────────────────────────────────────────────

router.post("/claude/threads/:id/messages", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const orgId = req.org!.id;
  const body = req.body ?? {};

  const message = str(body.message, MAX_MESSAGE);
  const attachmentIds: string[] = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((v: unknown) => typeof v === "string" && UUID_RE.test(v)).slice(0, 20)
    : [];
  // A message with only attachments is legitimate ("look at this") — but a turn
  // with neither text nor files has nothing to say.
  if (!message && attachmentIds.length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id, session_id, model, effort, repo, git_branch, playbook_id, title, title_source, workspace_thread_id")
    .eq("id", req.params.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (tErr) {
    console.error("[claude/threads] fetch for message failed:", tErr.message);
    return res.status(500).json({ error: "could not fetch thread" });
  }
  if (!thread) return res.status(404).json({ error: "thread not found" });

  // One turn at a time — but across the whole WORKSPACE group, not just this thread.
  // A fork child shares its parent's directory, so a parent turn and a child turn
  // running at once would be two `claude` processes in one project dir: racing
  // session writes and file edits. Serialize on the shared workspace id.
  const workspaceId = thread.workspace_thread_id ?? thread.id;
  const { data: workspacePeers } = await db
    .from("claude_threads")
    .select("id")
    .eq("org_id", orgId)
    .or(`id.eq.${workspaceId},workspace_thread_id.eq.${workspaceId}`);
  const peerIds = (workspacePeers ?? []).map((p) => p.id);
  const liveScope = peerIds.length > 0 ? peerIds : [thread.id];
  const { data: live, error: lErr } = await db
    .from("claude_runs")
    .select("id")
    .in("thread_id", liveScope)
    .in("status", ["queued", "running"])
    .limit(1);
  if (lErr) return res.status(500).json({ error: "could not check thread state" });
  if (live && live.length > 0) {
    return res.status(409).json({ error: "a turn is still running", run_id: live[0].id });
  }

  const { count: prior, error: cErr } = await db
    .from("claude_runs")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", thread.id);
  if (cErr) return res.status(500).json({ error: "could not count turns" });
  const turnIndex = (prior ?? 0) + 1;

  // First turn carries the standing instructions and the working method; later
  // turns don't, because the resumed session still holds them.
  const isFirst = !thread.session_id;
  const composed = isFirst
    ? await composePrompt(orgId, message || "(ראה את הקבצים המצורפים)", thread.playbook_id)
    : { prompt: message || "(ראה את הקבצים המצורפים)", playbook: null };

  const { data: run, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      thread_id: thread.id,
      turn_index: turnIndex,
      title: (message || "attachment").slice(0, 80),
      prompt: composed.prompt,
      user_prompt: message,
      playbook_id: isFirst ? thread.playbook_id : null,
      model: thread.model,
      effort: thread.effort,
      repo: thread.repo,
      git_branch: thread.git_branch,
      status: "queued",
    })
    .select("id, turn_index, status, user_prompt, created_at")
    .single();

  if (error) {
    // 23505 on uniq_claude_runs_thread_turn: another request won the race for this
    // turn index. The check above is advisory; THIS is what actually prevents two
    // engine processes resuming the same session.
    if (error.code === "23505") {
      return res.status(409).json({ error: "a turn is still running" });
    }
    console.error("[claude/threads] turn insert failed:", error.message);
    return res.status(500).json({ error: "could not send message" });
  }

  // Link the uploads to this turn — scoped to the thread, so an id from another
  // conversation cannot be attached here.
  if (attachmentIds.length > 0) {
    const { error: aErr } = await db
      .from("claude_attachments")
      .update({ run_id: run.id })
      .in("id", attachmentIds)
      .eq("thread_id", thread.id)
      .is("run_id", null);
    if (aErr) console.error("[claude/threads] attachment link failed:", aErr.message);
  }

  void executeRun(run.id)
    .then(() => maybeTitle(thread.id, orgId))
    .then(() => maybeAutoSplit(thread.id, orgId))
    .catch((e) => console.error("[claude/threads] executeRun threw:", e instanceof Error ? e.message : e));

  return res.status(201).json({ run });
});

/**
 * The split gate (plan §5), run after a turn completes — the moment the thread just
 * grew, which is the only time a new split could exist. Layer 1 is a cheap SQL check
 * (enough turns, grown enough since last analysis); only if it passes does the model
 * run in runSplitAnalysis. A thread you are not growing is never reconsidered.
 *
 * Never throws into the caller: a failed analysis must not fail the turn that
 * triggered it.
 */
async function maybeAutoSplit(threadId: string, orgId: string): Promise<void> {
  try {
    const { count } = await db
      .from("claude_runs")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", threadId)
      .is("moved_to_thread_id", null);
    const { data: thread } = await db
      .from("claude_threads")
      .select("analyzed_turn_count")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread) return;
    if (!shouldAnalyzeSplit(count ?? 0, thread.analyzed_turn_count ?? 0)) return;
    await runSplitAnalysis(threadId, orgId, null);
  } catch (e) {
    console.error("[claude/threads] auto-split failed:", e instanceof Error ? e.message : e);
  }
}

// ── cancel ────────────────────────────────────────────────────────────────────

router.post("/claude/runs/:id/cancel", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "run not found" });

  const { data: run, error } = await db
    .from("claude_runs")
    .select("id, status")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "could not fetch run" });
  if (!run) return res.status(404).json({ error: "run not found" });

  const signalled = cancelRun(run.id);

  // A queued run that never reached a process still has to leave the live states,
  // or the screen would poll it forever. The runner's own finish() writes the
  // terminal row when a signalled child exits, so only the un-started case is
  // written here.
  if (!signalled && (run.status === "queued" || run.status === "running")) {
    // 'running' matters as much as 'queued': a backend restart mid-turn leaves the
    // row running with no process behind it, and that row keeps the screen polling
    // forever and the composer disabled — the thread becomes unusable. Nothing else
    // will ever write it, because the process that would have is gone.
    const { error: uErr } = await db
      .from("claude_runs")
      .update({
        status: "canceled",
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .in("status", ["queued", "running"]);
    if (uErr) console.error("[claude/runs] cancel update failed:", uErr.message);
  }

  return res.json({ ok: true, signalled });
});

// ── the real title ────────────────────────────────────────────────────────────

/** Turn counts at which the title is (re)written. The subject of a conversation
 *  sharpens as it goes, and one guess from the opening line is usually wrong. */
const TITLE_AT_TURNS = new Set([1, 4, 12]);

/**
 * Give the thread a title that describes what it is ABOUT.
 *
 * Not the first line of the first message — "תבדוק לי משהו" is not a subject. A
 * short run on the subscription reads the turns and answers with a real title.
 *
 * Never touches a title the user typed (`title_source = 'user'`), and never fails
 * a turn: any problem leaves the existing title alone.
 */
export async function maybeTitle(threadId: string, orgId: string): Promise<void> {
  try {
    const { data: thread } = await db
      .from("claude_threads")
      .select("id, title, title_source")
      .eq("id", threadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!thread || thread.title_source === "user") return;

    // The REAL turn count, not the length of the capped slice below: with
    // `.limit(12)` the length saturates at 12, so TITLE_AT_TURNS.has(12) stayed
    // true forever and every later message spawned another titling run.
    const { count: total } = await db
      .from("claude_runs")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", threadId);
    const count = total ?? 0;
    if (count === 0) return;
    if (!TITLE_AT_TURNS.has(count)) return;

    const { data: turns } = await db
      .from("claude_runs")
      .select("turn_index, user_prompt, result_summary")
      .eq("thread_id", threadId)
      .order("turn_index", { ascending: true })
      .limit(12);
    const transcript = (turns ?? [])
      .map((t) => {
        const q = (t.user_prompt ?? "").slice(0, 600);
        const a = (t.result_summary ?? "").slice(0, 600);
        return `## תור ${t.turn_index}\nמשתמש: ${q}\nקלוד: ${a}`;
      })
      .join("\n\n");

    const prompt = [
      "להלן תמליל של שיחה. כתוב לה כותרת אמיתית שמתארת במה השיחה עוסקת.",
      "",
      "חוקים:",
      "- עברית.",
      "- עד 6 מילים.",
      "- על התוכן, לא על הצורה. למשל 'החלפת ספק הסמס ל-Twilio', ולא 'שאלה על סמס'.",
      "- בלי מירכאות, בלי נקודה בסוף, בלי הקדמה.",
      "- החזר את הכותרת בלבד — שום דבר אחר.",
      "",
      transcript,
    ].join("\n");

    const raw = await runOneShot(prompt, { timeoutMs: 60_000 });
    if (!raw) return;
    // First line only, quotes stripped: a model that adds a sentence of
    // explanation must not turn that into the thread's name.
    const title = raw.split("\n")[0].replace(/^["'«»\s]+|["'«».\s]+$/g, "").slice(0, MAX_TITLE);
    if (!title) return;

    const { error } = await db
      .from("claude_threads")
      .update({ title, title_source: "auto", updated_at: new Date().toISOString() })
      .eq("id", threadId)
      // Re-checked at write time: the user may have named the thread while the
      // titling run was in flight, and their name wins.
      .eq("title_source", "auto");
    if (error) console.error("[claude/threads] title update failed:", error.message);
  } catch (e) {
    console.error("[claude/threads] title failed:", e instanceof Error ? e.message : e);
  }
}

// ── split ───────────────────────────────────────────────────────────────────

/** Confirm a thread belongs to this org; returns its id or null. */
async function ownThread(id: string, orgId: string): Promise<boolean> {
  const { data } = await db
    .from("claude_threads")
    .select("id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * POST /claude/threads/:id/analyze-split — the "פצל" button (decision §8.2).
 *
 * Runs the analysis now and returns the proposal. This IS a subscription run, but
 * not a paid-API one, so it needs no cost gate; it does spend a little usage window,
 * which is why it is a deliberate button, not automatic on every open.
 */
router.post("/claude/threads/:id/analyze-split", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  if (!(await ownThread(req.params.id, req.org!.id))) {
    return res.status(404).json({ error: "thread not found" });
  }
  try {
    const analysis = await runSplitAnalysis(req.params.id, req.org!.id, req.user!.id);
    // null = the model found nothing worth splitting. A real answer, not an error.
    return res.json({ analysis: analysis ?? null, split: Boolean(analysis) });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /claude/threads/:id/split — apply an approved split.
 *
 * Body: { analysis_id?, selections: [{ title, turn_indexes, handover, method }] }.
 * The selections are what the USER approved (possibly edited), not the raw proposal
 * — the client sends back exactly what it showed, so the handover text the user read
 * is the handover that ships.
 */
router.post("/claude/threads/:id/split", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  if (!(await ownThread(req.params.id, req.org!.id))) {
    return res.status(404).json({ error: "thread not found" });
  }
  const body = req.body ?? {};
  const rawSelections = Array.isArray(body.selections) ? body.selections : [];
  const selections = rawSelections
    .map((s: Record<string, unknown>) => ({
      title: str(s?.title, 200),
      handover: typeof s?.handover === "string" ? s.handover.slice(0, 8000) : "",
      method: s?.method === "fork" ? ("fork" as const) : ("summary" as const),
      turn_indexes: Array.isArray(s?.turn_indexes)
        ? (s.turn_indexes as unknown[]).map((n) => Number(n)).filter((n) => Number.isInteger(n))
        : [],
    }))
    .filter((s: { title: string; turn_indexes: number[] }) => s.title && s.turn_indexes.length > 0);

  if (selections.length === 0) return res.status(400).json({ error: "no valid selections" });

  const analysisId = str(body.analysis_id, 64) || null;
  if (analysisId && !UUID_RE.test(analysisId)) return res.status(400).json({ error: "invalid analysis_id" });

  try {
    const { children } = await applySplit({
      parentThreadId: req.params.id,
      orgId: req.org!.id,
      userId: req.user!.id,
      analysisId,
      selections,
    });
    return res.status(201).json({ children });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** POST /claude/analyses/:id/dismiss — reject a split proposal so it stops showing. */
router.post("/claude/analyses/:id/dismiss", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
  const { data, error } = await db
    .from("claude_thread_analyses")
    .update({ status: "dismissed", decided_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .eq("status", "proposed")
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "not found" });
  return res.json({ ok: true });
});

// ── topics (grouping) ─────────────────────────────────────────────────────────

/** GET /claude/topics — topics with the threads under each, for the grouped list. */
router.get("/claude/topics", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: topics, error } = await db
    .from("claude_topics")
    .select("id, title, title_source")
    .eq("org_id", orgId)
    .order("title", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: links, error: lErr } = await db
    .from("claude_thread_topics")
    .select("thread_id, topic_id, assigned_by, confidence");
  if (lErr) return res.status(500).json({ error: lErr.message });

  // links is not org-scoped by column, so intersect with THIS org's topics — a
  // topic id from another org can't leak a thread id in.
  const topicIds = new Set((topics ?? []).map((t) => t.id));
  const byTopic = new Map<string, { thread_id: string; assigned_by: string }[]>();
  for (const l of links ?? []) {
    if (!topicIds.has(l.topic_id)) continue;
    const arr = byTopic.get(l.topic_id) ?? [];
    arr.push({ thread_id: l.thread_id, assigned_by: l.assigned_by });
    byTopic.set(l.topic_id, arr);
  }

  return res.json({
    topics: (topics ?? []).map((t) => ({ ...t, threads: byTopic.get(t.id) ?? [] })),
  });
});

/** POST /claude/topics/regroup — the "אגד עכשיו" button; also the daily job's call. */
router.post("/claude/topics/regroup", async (req: Request, res: Response) => {
  try {
    const result = await runGroupAnalysis(req.org!.id, req.user!.id);
    return res.json(result);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * PATCH /claude/threads/:id/topics — user assigns or removes a topic by name.
 *
 * Body: { add?: string, remove_topic_id?: string }. A user assignment is marked
 * assigned_by='user', which the automatic grouping run never overrides.
 */
router.patch("/claude/threads/:id/topics", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const orgId = req.org!.id;
  if (!(await ownThread(req.params.id, orgId))) return res.status(404).json({ error: "thread not found" });

  const add = str(req.body?.add, 200);
  const removeTopicId = str(req.body?.remove_topic_id, 64) || null;

  if (add) {
    const { data: topic, error: tErr } = await db
      .from("claude_topics")
      .upsert({ org_id: orgId, title: add, title_source: "user" }, { onConflict: "org_id,title" })
      .select("id")
      .single();
    if (tErr) return res.status(500).json({ error: tErr.message });
    const { error: aErr } = await db
      .from("claude_thread_topics")
      .upsert(
        { thread_id: req.params.id, topic_id: topic.id, confidence: 1, assigned_by: "user" },
        { onConflict: "thread_id,topic_id" },
      );
    if (aErr) return res.status(500).json({ error: aErr.message });
  }

  if (removeTopicId && UUID_RE.test(removeTopicId)) {
    const { error: dErr } = await db
      .from("claude_thread_topics")
      .delete()
      .eq("thread_id", req.params.id)
      .eq("topic_id", removeTopicId);
    if (dErr) return res.status(500).json({ error: dErr.message });
  }

  return res.json({ ok: true });
});

export default router;
