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
import { saveAttachment, MAX_BASE64_CHARS } from "./attachments";

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

// ── list / create ─────────────────────────────────────────────────────────────

router.get("/claude/threads", async (req: Request, res: Response) => {
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
      "id, turn_index, status, user_prompt, result_summary, error, model, effort, total_cost_usd, input_tokens, output_tokens, num_turns, duration_ms, created_at, ended_at",
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

  return res.json({
    thread,
    turns: (runs ?? []).map((r) => ({
      ...r,
      events: eventsByRun.get(r.id) ?? [],
      attachments: (attachments ?? []).filter((a) => a.run_id === r.id),
    })),
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
  const { error } = await db
    .from("claude_threads")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id);
  if (error) {
    console.error("[claude/threads] delete failed:", error.message);
    return res.status(500).json({ error: "could not delete thread" });
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
    .select("id, session_id, model, effort, repo, git_branch, playbook_id, title, title_source")
    .eq("id", req.params.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (tErr) {
    console.error("[claude/threads] fetch for message failed:", tErr.message);
    return res.status(500).json({ error: "could not fetch thread" });
  }
  if (!thread) return res.status(404).json({ error: "thread not found" });

  // One turn at a time. Sending while the previous turn is still running would
  // start a second process resuming the SAME session — two writers on one
  // conversation, whose interleaving is undefined.
  const { data: live, error: lErr } = await db
    .from("claude_runs")
    .select("id")
    .eq("thread_id", thread.id)
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
    .catch((e) => console.error("[claude/threads] executeRun threw:", e instanceof Error ? e.message : e));

  return res.status(201).json({ run });
});

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
  if (!signalled && run.status === "queued") {
    const { error: uErr } = await db
      .from("claude_runs")
      .update({
        status: "canceled",
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("status", "queued");
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

    const { data: turns } = await db
      .from("claude_runs")
      .select("turn_index, user_prompt, result_summary")
      .eq("thread_id", threadId)
      .order("turn_index", { ascending: true })
      .limit(12);
    const count = turns?.length ?? 0;
    if (count === 0) return;
    // Re-titled only at the checkpoints, so a long conversation doesn't spend a
    // run on a new title after every single message.
    if (!TITLE_AT_TURNS.has(count)) return;

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

export default router;
