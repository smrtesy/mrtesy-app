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
import { executeRun, cancelRun, runOneShot, BG_MODEL_FAST } from "./runner";
import { composePrompt } from "./playbooks";
import { isValidRepo, isValidBranch } from "./github";
import { saveAttachment, removeThreadAttachments, MAX_BASE64_CHARS, BUCKET } from "./attachments";
import { removeThreadWorkspace, sweepWorkspaces } from "./workspace";
import {
  runSplitAnalysis,
  applySplit,
  runGroupAnalysis,
  shouldAnalyzeSplit,
  runDecomposeAnalysis,
  applyDecompose,
  type DecomposePart,
} from "./analysis";

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
  "id, title, title_source, session_id, model, effort, repo, git_branch, playbook_id, claude_account, archived_at, last_message_at, created_at, handled_at, task_serial";

/** The account ids the runner knows how to route (loadAccountToken). An empty
 *  string / null means "use the default", stored as NULL. */
const ACCOUNTS = new Set(["primary", "automation"]);

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Cap on the rehydrated history, in characters — enough for a real conversation,
 *  bounded so a long thread cannot blow the engine's prompt budget. */
const MAX_HISTORY_CHARS = 12_000;

/** The shared project board, in characters. Big enough for a working note; bounded
 *  so injecting it into a turn cannot blow the prompt budget. */
const MAX_BOARD_CHARS = 20_000;

/**
 * Resolve the PROJECT ROOT of a thread — the top-most ancestor reached by walking
 * parent_thread_id up. The shared project board lives on that row.
 *
 * Bounded to 10 hops so a corrupt cycle (a child pointing back at an ancestor) can
 * never loop forever; it just stops and returns the deepest row it reached, which is
 * still a real thread. Org-scoped at every hop, so a parent pointer that crosses
 * tenants (it never should) is ignored rather than followed.
 *
 * Returns the root's id, title and board — the caller reads/writes the board there.
 */
async function resolveProjectRoot(
  threadId: string,
  orgId: string,
): Promise<{ id: string; title: string | null; project_board: string | null; project_board_updated_at: string | null } | null> {
  let currentId = threadId;
  let root: { id: string; title: string | null; parent_thread_id: string | null; project_board: string | null; project_board_updated_at: string | null } | null = null;
  for (let hop = 0; hop < 10; hop++) {
    const { data, error } = await db
      .from("claude_threads")
      .select("id, title, parent_thread_id, project_board, project_board_updated_at")
      .eq("id", currentId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) break;
    root = data;
    if (!data.parent_thread_id) break; // reached the top
    currentId = data.parent_thread_id;
  }
  if (!root) return null;
  return {
    id: root.id,
    title: root.title,
    project_board: root.project_board,
    project_board_updated_at: root.project_board_updated_at,
  };
}

/**
 * Rebuild the conversation so far from OUR database, for the case where there is no
 * engine session to resume into — the thread never got one (its first turn failed
 * before the engine ran, e.g. a missing GITHUB_TOKEN) or the transcript was lost on
 * an ephemeral host. Without this a follow-up starts a blank session that cannot see
 * what came before, so the chat reads as disconnected one-offs; with it the DB (the
 * source of truth) rehydrates the context and the conversation continues. Returns
 * null when there is nothing earlier to show.
 */
async function buildHistoryPreamble(threadId: string, beforeTurn: number): Promise<string | null> {
  if (beforeTurn <= 1) return null;
  const { data, error } = await db
    .from("claude_runs")
    .select("turn_index, user_prompt, result_summary")
    .eq("thread_id", threadId)
    .lt("turn_index", beforeTurn)
    .order("turn_index", { ascending: true })
    .limit(60);
  if (error) {
    console.error("[claude/threads] history fetch failed:", error.message);
    return null;
  }
  const lines: string[] = [];
  for (const r of data ?? []) {
    if (r.user_prompt?.trim()) lines.push(`משתמש: ${r.user_prompt.trim()}`);
    if (r.result_summary?.trim()) lines.push(`קלוד: ${r.result_summary.trim()}`);
  }
  if (lines.length === 0) return null;
  let text = lines.join("\n\n");
  // Keep the MOST RECENT history when over budget: the tail is what the next turn
  // most needs, and a leading "…" marks that earlier turns were dropped.
  if (text.length > MAX_HISTORY_CHARS) text = `…\n\n${text.slice(-MAX_HISTORY_CHARS)}`;
  return `# ההיסטוריה של השיחה עד כה\n\n${text}`;
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

/**
 * The org's primary repo — the one a new chat auto-connects to.
 *
 * Derived from the org's own active playbooks (claude_playbooks.repo), never a
 * hardcoded name, so it stays correct per tenant: the most-referenced repo wins,
 * which for a typical org is the platform repo. Null when the org configured none —
 * then a new chat simply has no repo, exactly as before.
 */
async function primaryRepoForOrg(orgId: string): Promise<string | null> {
  const { data, error } = await db
    .from("claude_playbooks")
    .select("repo")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .not("repo", "is", null);
  if (error || !data || data.length === 0) return null;
  const freq = new Map<string, number>();
  for (const row of data) {
    const r = (row.repo ?? "").trim();
    if (r && isValidRepo(r)) freq.set(r, (freq.get(r) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [r, n] of freq) {
    if (n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
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

  // Enrich each thread with the rail's live status dot: `live` when it has a
  // non-terminal run (a turn executing/queued right now → the pulsing green dot),
  // and `last_status` = the newest run's status (done/failed/…) for the resting
  // colour. Two queries: live runs are always few (only non-terminal), so that one
  // is unbounded; the status scan is capped, and a thread past the cap just shows a
  // neutral dot rather than a wrong one.
  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const liveSet = new Set<string>();
  const lastStatus = new Map<string, string>();
  if (ids.length > 0) {
    const { data: liveRows, error: lErr } = await db
      .from("claude_runs")
      .select("thread_id")
      .in("thread_id", ids)
      .in("status", ["running", "queued", "waiting"]);
    if (lErr) console.error("[claude/threads] live status failed:", lErr.message);
    for (const r of liveRows ?? []) if (r.thread_id) liveSet.add(r.thread_id);

    const { data: statusRows, error: sErr } = await db
      .from("claude_runs")
      .select("thread_id, status, turn_index")
      .in("thread_id", ids)
      .order("thread_id", { ascending: true })
      .order("turn_index", { ascending: false })
      .limit(5000);
    if (sErr) console.error("[claude/threads] run status failed:", sErr.message);
    // Ordered turn_index DESC, so the FIRST row seen for a thread is its newest run.
    for (const r of statusRows ?? []) {
      if (r.thread_id && !lastStatus.has(r.thread_id)) lastStatus.set(r.thread_id, r.status);
    }
  }
  const threads = rows.map((r) => ({
    ...r,
    live: liveSet.has(r.id),
    last_status: lastStatus.get(r.id) ?? null,
  }));
  return res.json({ threads });
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
  const account = str(body.claude_account, 32);
  if (account && !ACCOUNTS.has(account)) return res.status(400).json({ error: "invalid claude_account" });

  // Auto-connect the repo: when the caller didn't pick one, default to the org's
  // primary repo so the workspace has real code from turn one — the backend clones
  // it (ensureClone), NOT Claude via a shell command that a headless run can't
  // approve. `null` when the org has no repos, which just leaves the workspace bare.
  const finalRepo = repo || (await primaryRepoForOrg(req.org!.id));

  // Fall back to the org's chosen defaults (claude_instructions.default_model /
  // default_effort) when this create didn't specify one, so "every new chat opens
  // on <model> / <effort>" holds no matter which client created it. A null default
  // (never set) leaves the column null: the composer then shows the app's built-in
  // default and the runner treats effort as engine-chosen. Fetched only when at
  // least one field is missing, so a fully-specified create skips the round trip.
  let effModel = model;
  let effEffort = effort;
  if (!effModel || !effEffort) {
    const { data: defaults, error: defErr } = await db
      .from("claude_instructions")
      .select("default_model, default_effort")
      .eq("org_id", req.org!.id)
      .maybeSingle();
    // Non-fatal: a lookup failure just means this chat opens on the app default
    // instead of the org's — but log it, don't swallow it.
    if (defErr) console.error("[claude/threads] default model/effort fetch failed:", defErr.message);
    if (!effModel && defaults?.default_model) effModel = defaults.default_model;
    if (!effEffort && defaults?.default_effort) effEffort = defaults.default_effort;
  }

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
      model: effModel || null,
      effort: effEffort || null,
      repo: finalRepo || null,
      git_branch: gitBranch || null,
      playbook_id: playbookId,
      claude_account: account || null,
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

/**
 * In-process cache for signed attachment URLs. A signature is valid for
 * SIGN_TTL_S; re-minting one per image per screen load was pure waste (and while
 * a turn was live, the old full-thread poll re-minted every image every ~900ms).
 * Entries are reused while they still have ≥10 minutes of validity — plenty for
 * one render — and the map is cleared wholesale past a size bound rather than
 * LRU-managed: it re-fills for pennies.
 */
const SIGN_TTL_S = 3600;
const signedUrlCache = new Map<string, { url: string; expiresAtMs: number }>();
async function signedUrlFor(storagePath: string): Promise<string | null> {
  const hit = signedUrlCache.get(storagePath);
  if (hit && hit.expiresAtMs - Date.now() > 10 * 60 * 1000) return hit.url;
  const { data: signed, error: sErr } = await db.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGN_TTL_S);
  if (sErr || !signed?.signedUrl) {
    if (sErr) console.error("[claude/threads] sign failed:", sErr.message);
    return null;
  }
  if (signedUrlCache.size > 500) signedUrlCache.clear();
  signedUrlCache.set(storagePath, {
    url: signed.signedUrl,
    expiresAtMs: Date.now() + SIGN_TTL_S * 1000,
  });
  return signed.signedUrl;
}

/**
 * GET /claude/threads/:id/live?run=<runId>&after=<seq> — the light poll a live
 * screen runs on (~1s cadence) instead of refetching the whole conversation.
 *
 * Returns only what changes while a turn executes:
 *   runs    every non-terminal run of the thread PLUS the run named by `run`
 *           whatever its status — so the poll that watched a turn finish sees
 *           its terminal state (and result_summary/usage) in the same response
 *           and knows to do one full reload for the canonical view.
 *   events  the named run's events with seq > `after` — the increment only.
 *
 * This is what decouples poll cost from conversation length: the old full-thread
 * poll ran ~9 queries and returned every turn + every event every 900ms, growing
 * linearly with the thread. This route is two small indexed queries, constant.
 */
router.get("/claude/threads/:id/live", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const runId = typeof req.query.run === "string" && UUID_RE.test(req.query.run) ? req.query.run : null;
  const after = Math.max(0, Number(req.query.after) || 0);

  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: "could not fetch thread" });
  if (!thread) return res.status(404).json({ error: "thread not found" });

  const RUN_COLS =
    "id, turn_index, status, error, result_summary, resumed_session, model, input_tokens, output_tokens, duration_ms, created_at, started_at, updated_at, ended_at, resume_attempts";
  let q = db.from("claude_runs").select(RUN_COLS).eq("thread_id", thread.id);
  q = runId
    ? q.or(`status.in.(queued,running,waiting),id.eq.${runId}`)
    : q.in("status", ["queued", "running", "waiting"]);
  const { data: runs, error: rErr } = await q.order("turn_index", { ascending: true }).limit(50);
  if (rErr) return res.status(500).json({ error: "could not fetch runs" });

  let events: unknown[] = [];
  // Events only for a run the runs query PROVED belongs to this thread (and this
  // org, via the thread check above) — a bare run uuid from the query string must
  // never read another tenant's stream.
  const ownedRun = runId && (runs ?? []).some((r) => r.id === runId);
  if (ownedRun) {
    const { data: evs, error: eErr } = await db
      .from("claude_run_events")
      .select("seq, kind, text, tool_name, created_at")
      .eq("run_id", runId)
      .gt("seq", after)
      .order("seq", { ascending: true })
      .limit(EVENT_CAP);
    if (eErr) console.error("[claude/threads] live events failed:", eErr.message);
    events = evs ?? [];
  }

  return res.json({ runs: runs ?? [], events });
});

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
      "id, turn_index, status, user_prompt, result_summary, error, model, effort, resumed_session, moved_to_thread_id, total_cost_usd, input_tokens, output_tokens, num_turns, duration_ms, created_at, started_at, updated_at, ended_at, resume_attempts",
    )
    .eq("thread_id", thread.id)
    .order("turn_index", { ascending: true })
    .limit(TURN_PAGE);
  if (rErr) {
    console.error("[claude/threads] turns failed:", rErr.message);
    return res.status(500).json({ error: "could not fetch turns" });
  }

  // Self-heal the queue: a waiting turn with nothing live ahead of it means the
  // dispatch was lost (backend restart between finish and dispatch). Fire it now,
  // fire-and-forget — the poll that made this request will see it running.
  const rows = runs ?? [];
  if (
    rows.some((r) => r.status === "waiting") &&
    !rows.some((r) => r.status === "queued" || r.status === "running")
  ) {
    void dispatchNextWaiting(thread.id, req.org!.id);
  }

  const ids = (runs ?? []).map((r) => r.id);
  // One query for every turn's events instead of N: a 40-turn thread would
  // otherwise be 40 round trips before the screen can paint.
  const eventsByRun = new Map<string, { run_id: string; seq: number; kind: string; text: string | null; tool_name: string | null; created_at: string }[]>();
  if (ids.length > 0) {
    const { data: events, error: eErr } = await db
      .from("claude_run_events")
      .select("run_id, seq, kind, text, tool_name, created_at")
      .in("run_id", ids)
      // Ordered by run FIRST: with a global seq order, one 400-event turn consumed
      // the whole budget and an older turn came back empty — rendering a blank
      // answer for a turn that had answered perfectly well.
      .order("run_id", { ascending: true })
      // seq DESC so the per-run cap keeps the NEWEST events. With ASC, a turn
      // past the cap froze its "what is happening now" line at event #400 while
      // the run kept going — the newest events are what the screen needs.
      .order("seq", { ascending: false })
      .limit(EVENT_CAP * ids.length);
    if (eErr) console.error("[claude/threads] events failed:", eErr.message);
    for (const ev of events ?? []) {
      const list = eventsByRun.get(ev.run_id) ?? [];
      if (list.length < EVENT_CAP) list.push(ev);
      eventsByRun.set(ev.run_id, list);
    }
    // Collected newest-first; the screen renders oldest-first.
    for (const list of eventsByRun.values()) list.reverse();
  }

  const { data: attachments, error: aErr } = await db
    .from("claude_attachments")
    .select("id, run_id, filename, mime_type, size_bytes, source, storage_path")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: true });
  if (aErr) console.error("[claude/threads] attachments failed:", aErr.message);

  // Run-produced screenshots render as inline images, which needs a fetchable
  // URL — the bucket is private, so mint short-lived signed URLs here rather
  // than exposing a public path. Only for images the RUN produced: user uploads
  // stay filename chips and never need a URL. Best-effort per file (a failed
  // signature downgrades that one image to a chip, not the whole screen).
  // Cached in-process (signedUrlCache): the URL is valid for an hour, so
  // re-signing every image on every screen load was N Storage round trips for
  // an answer we already had.
  const signedByPath = new Map<string, string>();
  await Promise.all(
    (attachments ?? [])
      .filter((a) => a.source === "run" && (a.mime_type ?? "").startsWith("image/"))
      .map(async (a) => {
        const url = await signedUrlFor(a.storage_path);
        if (url) signedByPath.set(a.storage_path, url);
      }),
  );
  const attachmentPayload = (attachments ?? []).map((a) => ({
    id: a.id,
    run_id: a.run_id,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    source: a.source,
    signed_url: signedByPath.get(a.storage_path) ?? null,
  }));

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

  // Child threads (from a split OR a decomposition) — shown as links so a moved-turns
  // fold can point where turns went, and so a project's parts are reachable.
  const { data: children } = await db
    .from("claude_threads")
    .select("id, title")
    .eq("parent_thread_id", thread.id)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: true });

  // The parent, if this thread is a child — so the UI can offer "back to the plan".
  // parent_thread_id is not in THREAD_COLS, so read it here.
  const { data: lineage } = await db
    .from("claude_threads")
    .select("parent_thread_id")
    .eq("id", thread.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  let parent: { id: string; title: string } | null = null;
  if (lineage?.parent_thread_id) {
    const { data: p } = await db
      .from("claude_threads")
      .select("id, title")
      .eq("id", lineage.parent_thread_id)
      .eq("org_id", req.org!.id)
      .maybeSingle();
    if (p) parent = { id: p.id, title: p.title };
  }

  return res.json({
    thread,
    turns: (runs ?? []).map((r) => ({
      ...r,
      events: eventsByRun.get(r.id) ?? [],
      attachments: attachmentPayload.filter((a) => a.run_id === r.id),
    })),
    split_proposal: splitProposal ?? null,
    children: children ?? [],
    parent,
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
  if (body.handled !== undefined) {
    // The rail's green-check "I'm done with this session" mark. A handled thread
    // dims and sorts to the bottom of the rail (client-side); un-checking clears it.
    patch.handled_at = body.handled ? new Date().toISOString() : null;
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
  if (body.claude_account !== undefined) {
    const account = str(body.claude_account, 32);
    if (account && !ACCOUNTS.has(account)) return res.status(400).json({ error: "invalid claude_account" });
    // Empty → NULL, which loadAccountToken reads as the primary account.
    patch.claude_account = account || null;
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

/**
 * A RUN posts a file back into its own turn — the browser helper's screenshot
 * upload ("here is what the screen actually shows"). Authenticated with the
 * run's minted user session, so the same superadmin gate as every /claude route
 * applies; ownership is then pinned to the exact run: it must belong to this
 * org, be created by this user, and still be running — a finished run must not
 * be able to grow new content after its reply was rendered.
 */
router.post("/claude/runs/:id/attachments", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "run not found" });
  const { filename, mime_type, base64 } = (req.body ?? {}) as {
    filename?: string;
    mime_type?: string;
    base64?: string;
  };
  if (!base64 || typeof base64 !== "string") return res.status(400).json({ error: "base64 is required" });
  if (base64.length > MAX_BASE64_CHARS) return res.status(413).json({ error: "file is too large" });

  const { data: run, error: rErr } = await db
    .from("claude_runs")
    .select("id, thread_id, status, created_by")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: "could not verify run" });
  if (!run || run.created_by !== req.user!.id) return res.status(404).json({ error: "run not found" });
  if (!run.thread_id) return res.status(400).json({ error: "run has no thread" });
  if (run.status !== "running") return res.status(409).json({ error: "run is not running" });

  try {
    const attachment = await saveAttachment({
      orgId: req.org!.id,
      threadId: run.thread_id,
      userId: req.user!.id,
      filename: str(filename, 200) || "screenshot.png",
      mimeType: str(mime_type, 200) || null,
      base64,
      runId: run.id,
      source: "run",
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
    .select("id, session_id, model, effort, repo, git_branch, playbook_id, claude_account, title, title_source, workspace_thread_id")
    .eq("id", req.params.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (tErr) {
    console.error("[claude/threads] fetch for message failed:", tErr.message);
    return res.status(500).json({ error: "could not fetch thread" });
  }
  if (!thread) return res.status(404).json({ error: "thread not found" });

  // One ENGINE PROCESS at a time — across the whole WORKSPACE group, not just this
  // thread. A fork child shares its parent's directory, so a parent turn and a
  // child turn running at once would be two `claude` processes in one project dir:
  // racing session writes and file edits. Serialize on the shared workspace id.
  //
  // But a live turn no longer REFUSES a new message (the old 409): the message is
  // accepted as a 'waiting' turn that sits in line and runs the moment the live
  // turn finishes — typing while Claude works, like Claude Code.
  // 'waiting' counts as live here on purpose: after a backend restart a waiting
  // turn can briefly have nothing executing ahead of it, and a new message that
  // ran immediately would jump the line — the older turn would then resume a
  // session that already contains the newer exchange, out of order.
  const liveScope = await workspaceScope(thread.id, thread.workspace_thread_id, orgId);
  const { data: live, error: lErr } = await db
    .from("claude_runs")
    .select("id")
    .in("thread_id", liveScope)
    .in("status", ["queued", "running", "waiting"])
    .limit(1);
  if (lErr) return res.status(500).json({ error: "could not check thread state" });
  const hasLive = Boolean(live && live.length > 0);

  const { count: prior, error: cErr } = await db
    .from("claude_runs")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", thread.id);
  if (cErr) return res.status(500).json({ error: "could not count turns" });
  const turnIndex = (prior ?? 0) + 1;

  // First turn carries the standing instructions and the working method; later
  // turns don't, because the resumed session still holds them. A turn queued
  // BEHIND a live one is never "first": by the time it runs, the live turn will
  // have created the session it resumes into.
  const isFirst = !thread.session_id && !hasLive;
  const composed = isFirst
    ? await composePrompt(orgId, message || "(ראה את הקבצים המצורפים)", thread.playbook_id)
    : { prompt: message || "(ראה את הקבצים המצורפים)", playbook: null };

  // No engine session to resume, yet the thread already has turns — the first turn
  // failed before a session was created (a missing token, say), so `isFirst` is true
  // on what is really turn N. Rehydrate the earlier exchange from the DB so this
  // fresh session still knows what was said, instead of answering as if the chat
  // just began. (A normal follow-up resumes its session and skips this entirely.)
  if (isFirst && turnIndex > 1) {
    const history = await buildHistoryPreamble(thread.id, turnIndex);
    if (history) composed.prompt = `${history}\n\n---\n\n${composed.prompt}`;
  }

  // On-demand shared board: the user chose to attach the project board to THIS turn
  // (the deliberate "read the board" action — never automatic, per the user's design
  // choice). Resolve the project root and prepend its board to the prompt for this
  // turn only. A thread not in a project, or a project with no board yet, is a no-op.
  if (body.include_board === true) {
    const root = await resolveProjectRoot(thread.id, orgId);
    const board = root?.project_board?.trim();
    if (board) {
      const clipped = board.length > MAX_BOARD_CHARS ? board.slice(0, MAX_BOARD_CHARS) : board;
      composed.prompt =
        `# לוח הפרויקט המשותף (המצב הנוכחי של שאר החלקים)\n\n${clipped}\n\n---\n\n${composed.prompt}`;
    }
  }

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
      // The account this conversation runs on — the header switcher writes it onto
      // the thread; here it rides onto each turn so the runner picks the right token.
      claude_account: thread.claude_account,
      status: hasLive ? "waiting" : "queued",
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
    // 23514: the status CHECK does not know 'waiting' yet — the migration
    // (20260729150000) has not been applied. Degrade to the old behavior instead
    // of failing with an opaque 500.
    if (error.code === "23514" && hasLive) {
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

  // A waiting turn is NOT executed here — the dispatcher promotes it when the live
  // turn finishes. Executing it now would be two engine processes in one workspace.
  if (!hasLive) {
    void executeRun(run.id)
      .then(() => dispatchNextWaiting(thread.id, orgId))
      .then(() => maybeTitle(thread.id, orgId))
      .then(() => maybeAutoSplit(thread.id, orgId))
      .catch((e) => console.error("[claude/threads] executeRun threw:", e instanceof Error ? e.message : e));
  }

  return res.status(201).json({ run });
});

/** Resolve the ids of every thread sharing this thread's workspace directory (the
 *  thread itself, its workspace owner, and any fork children borrowing it). */
async function workspaceScope(
  threadId: string,
  workspaceThreadId: string | null,
  orgId: string,
): Promise<string[]> {
  const workspaceId = workspaceThreadId ?? threadId;
  const { data: peers } = await db
    .from("claude_threads")
    .select("id")
    .eq("org_id", orgId)
    .or(`id.eq.${workspaceId},workspace_thread_id.eq.${workspaceId}`);
  const ids = (peers ?? []).map((p) => p.id);
  return ids.length > 0 ? ids : [threadId];
}

/**
 * Promote and execute the next 'waiting' turn of this thread's workspace group.
 *
 * Runs after every finished turn (and as a self-heal from the thread GET, for the
 * case where the backend restarted between the finish and the dispatch). The
 * guarded update (status='waiting' → 'queued') is what makes concurrent dispatchers
 * safe: only one caller wins the claim, the rest see nothing to do. Chains itself,
 * so a queue of three messages drains one by one.
 *
 * Never throws into the caller — a dispatch failure must not fail the turn that
 * triggered it; the self-heal picks the queue up on the next screen load.
 */
export async function dispatchNextWaiting(threadId: string, orgId: string): Promise<void> {
  try {
    const { data: thread } = await db
      .from("claude_threads")
      .select("id, workspace_thread_id")
      .eq("id", threadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!thread) return;
    const scope = await workspaceScope(thread.id, thread.workspace_thread_id, orgId);

    // Still busy? Another turn (possibly of a sibling thread) is live — its own
    // completion will dispatch.
    const { data: live } = await db
      .from("claude_runs")
      .select("id")
      .in("thread_id", scope)
      .in("status", ["queued", "running"])
      .limit(1);
    if (live && live.length > 0) return;

    // Oldest waiting turn across the group, by arrival time.
    const { data: next } = await db
      .from("claude_runs")
      .select("id, thread_id, turn_index, user_prompt, prompt, created_at")
      .in("thread_id", scope)
      .eq("status", "waiting")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!next) return;

    // The claim. Guarded on status so two dispatchers cannot both execute IT.
    const { data: claimed, error: cErr } = await db
      .from("claude_runs")
      .update({ status: "queued", updated_at: new Date().toISOString() })
      .eq("id", next.id)
      .eq("status", "waiting")
      .select("id")
      .maybeSingle();
    if (cErr) return;
    if (!claimed) {
      // Lost the row (canceled, or another dispatcher took it) — the queue may
      // still hold more; try the next one instead of abandoning the line.
      await dispatchNextWaiting(threadId, orgId);
      return;
    }

    // The claim protects the ROW; the invariant is "≤1 live per group". Re-check
    // now that we hold it: a concurrent dispatcher or sender can have gone live in
    // the gap between our live check and the claim. Survival is by AGE — the older
    // run proceeds, the newer one steps back in line — so when two dispatchers
    // each claim a turn, both apply the same rule and exactly one survives (a
    // genuinely running turn is always older than a fresh claim, so it always wins).
    const { data: rivals } = await db
      .from("claude_runs")
      .select("id, created_at")
      .in("thread_id", scope)
      .in("status", ["queued", "running"])
      .neq("id", next.id);
    const olderRival = (rivals ?? []).some(
      (r) =>
        r.created_at < next.created_at ||
        (r.created_at === next.created_at && r.id < next.id),
    );
    if (olderRival) {
      // Guarded on 'queued' so a cancel that landed meanwhile is not resurrected.
      await db
        .from("claude_runs")
        .update({ status: "waiting", updated_at: new Date().toISOString() })
        .eq("id", next.id)
        .eq("status", "queued");
      return;
    }

    // The turn was composed assuming the run ahead of it would create the engine
    // session (isFirst=false at insert). If that run died sessionless (spawn
    // failure, missing token, Stop) THIS is really the thread's first engine turn
    // — recompose so the standing instructions and the environment preamble ride
    // along instead of being silently lost. The stored prompt (message + any
    // board attach) becomes the task text, and the DB history rehydrates what the
    // dead turn(s) said.
    const { data: tRow } = await db
      .from("claude_threads")
      .select("session_id, playbook_id")
      .eq("id", next.thread_id)
      .maybeSingle();
    if (tRow && !tRow.session_id) {
      const base = next.prompt?.trim() || next.user_prompt?.trim() || "(ראה את הקבצים המצורפים)";
      const composed = await composePrompt(orgId, base, tRow.playbook_id);
      let promptText = composed.prompt;
      if (next.turn_index > 1) {
        const history = await buildHistoryPreamble(next.thread_id, next.turn_index);
        if (history) promptText = `${history}\n\n---\n\n${promptText}`;
      }
      const { error: pErr } = await db
        .from("claude_runs")
        .update({ prompt: promptText, playbook_id: tRow.playbook_id })
        .eq("id", next.id);
      if (pErr) console.error("[claude/threads] recompose failed:", pErr.message);
    }

    await executeRun(next.id);
    await maybeTitle(next.thread_id, orgId).catch(() => {});
    await maybeAutoSplit(next.thread_id, orgId);
    // Keep draining until the queue is empty.
    await dispatchNextWaiting(next.thread_id, orgId);
  } catch (e) {
    console.error("[claude/threads] dispatch failed:", e instanceof Error ? e.message : e);
  }
}

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

  // A queued/waiting run that never reached a process still has to leave the live
  // states, or the screen would poll it forever. The runner's own finish() writes
  // the terminal row when a signalled child exits, so only the un-started case is
  // written here. 'waiting' is the remove-from-queue case; 'running' matters as
  // much as 'queued': a backend restart mid-turn leaves the row running with no
  // process behind it, and that row keeps the screen polling forever — nothing
  // else will ever write it, because the process that would have is gone.
  if (!signalled && (run.status === "queued" || run.status === "running" || run.status === "waiting")) {
    const { error: uErr } = await db
      .from("claude_runs")
      .update({
        status: "canceled",
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .in("status", ["queued", "running", "waiting"]);
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
      .select("id, title, title_source, task_serial")
      .eq("id", threadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!thread || thread.title_source === "user") return;
    const serial = (thread.task_serial ?? "").trim();

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
      "- אל תכתוב תחיליות-מטא כמו 'תיקון אוטומטי', 'משימה', 'שיחה על' — רק על מה זה עוסק בפועל.",
      ...(serial
        ? [`- אל תכתוב את המזהה '${serial}' בכותרת — הוא מתווסף אוטומטית בהתחלה.`]
        : []),
      "- החזר את הכותרת בלבד — שום דבר אחר.",
      "",
      transcript,
    ].join("\n");

    // Trivial/mechanical (a ≤6-word title) → fast model. Never a judgment.
    const raw = await runOneShot(prompt, {
      timeoutMs: 60_000,
      model: BG_MODEL_FAST,
      label: "thread-title",
    });
    if (!raw) return;
    // First line only, quotes stripped: a model that adds a sentence of
    // explanation must not turn that into the thread's name.
    let title = raw.split("\n")[0].replace(/^["'«»\s]+|["'«».\s]+$/g, "").slice(0, MAX_TITLE);
    if (!title) return;
    // Code-enforced, not just prompt-requested (a prompt line reduces but never
    // removes): strip a "תיקון אוטומטי" meta prefix the model may still emit, then
    // lead with the task serial when the thread has one — so a task thread's title
    // always starts with its ID (e.g. "T1699 · …") and never with "תיקון אוטומטי".
    title = title.replace(/^\s*תיקון\s+אוטומטי\s*[:\-–—.]*\s*/u, "").trim();
    if (serial) {
      const esc = serial.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Drop the serial if the model echoed it despite the rule, so it isn't doubled.
      // Looped, not a single replace, so even a title that echoed it more than once
      // ("T1699 T1699 …") is fully stripped before the one clean prefix is added.
      const lead = new RegExp(`^\\s*${esc}\\s*[·:\\-–—]*\\s*`, "u");
      while (lead.test(title)) title = title.replace(lead, "").trim();
      title = (title ? `${serial} · ${title}` : serial).slice(0, MAX_TITLE);
    }
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

// ── decompose (forward: plan → parts) ───────────────────────────────────────────

/**
 * POST /claude/threads/:id/analyze-decompose — the "פרק לחלקים" button.
 *
 * Reads the plan conversation and proposes parts to spin into child chats. A
 * subscription run (no paid API tokens); deliberate, not automatic.
 */
router.post("/claude/threads/:id/analyze-decompose", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  if (!(await ownThread(req.params.id, req.org!.id))) {
    return res.status(404).json({ error: "thread not found" });
  }
  try {
    const analysis = await runDecomposeAnalysis(req.params.id, req.org!.id, req.user!.id);
    return res.json({ analysis: analysis ?? null, decompose: Boolean(analysis) });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /claude/threads/:id/decompose — apply an approved decomposition.
 *
 * Body: { analysis_id?, parts: [{ title, scope }] }. The parts are what the user
 * approved (possibly edited), so the briefing each child starts with is exactly what
 * the user read. Nothing is moved off the plan chat.
 */
router.post("/claude/threads/:id/decompose", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  if (!(await ownThread(req.params.id, req.org!.id))) {
    return res.status(404).json({ error: "thread not found" });
  }
  const body = req.body ?? {};
  const rawParts = Array.isArray(body.parts) ? body.parts : [];
  const parts: DecomposePart[] = rawParts
    .map((p: Record<string, unknown>) => ({
      title: str(p?.title, 200),
      scope: typeof p?.scope === "string" ? p.scope.slice(0, 8000) : "",
    }))
    .filter((p: DecomposePart) => p.title);
  if (parts.length === 0) return res.status(400).json({ error: "no valid parts" });

  const analysisId = str(body.analysis_id, 64) || null;
  if (analysisId && !UUID_RE.test(analysisId)) return res.status(400).json({ error: "invalid analysis_id" });

  try {
    const { children } = await applyDecompose({
      parentThreadId: req.params.id,
      orgId: req.org!.id,
      userId: req.user!.id,
      analysisId,
      parts,
    });

    // Seed the shared board once — on the project ROOT (the top ancestor), and only
    // if it has no board yet, so a re-run or a second decomposition never clobbers an
    // existing board. Best-effort: a failure here just means the board starts empty.
    if (children.length > 0) {
      const root = await resolveProjectRoot(req.params.id, req.org!.id);
      if (root && !root.project_board?.trim()) {
        const seededBoard = [
          `# לוח הפרויקט: ${root.title?.trim() || "ללא כותרת"}`,
          "",
          "## חלקים",
          ...children.map((c) => `- **${c.title}** — (טרם התחיל)`),
          "",
          "## החלטות משותפות",
          "_(כל חלק רושם כאן החלטות שנוגעות לאחרים)_",
        ].join("\n");
        const now = new Date().toISOString();
        const { error: bErr } = await db
          .from("claude_threads")
          .update({ project_board: seededBoard, project_board_updated_at: now, updated_at: now })
          .eq("id", root.id)
          .eq("org_id", req.org!.id);
        if (bErr) console.error("[claude/threads] board seed failed:", bErr.message);
      }
    }

    return res.status(201).json({ children });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /claude/threads/:id/children — open a child chat under this one by hand.
 *
 * The "צ'אט-ילד חדש" button: the user names it, and it is linked to this thread as its
 * parent. It inherits the parent's model/effort/repo/branch/playbook and gets a light
 * briefing so it knows it is part of the project and that a shared board exists.
 */
router.post("/claude/threads/:id/children", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const orgId = req.org!.id;
  const { data: parent, error: pErr } = await db
    .from("claude_threads")
    .select("id, title, model, effort, repo, git_branch, playbook_id, claude_account")
    .eq("id", req.params.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (pErr) return res.status(500).json({ error: "could not fetch thread" });
  if (!parent) return res.status(404).json({ error: "thread not found" });

  const title = str(req.body?.title, MAX_TITLE);
  const briefing = [
    `אתה חלק מפרויקט שהתחיל בשיחה "${parent.title?.trim() || "ללא כותרת"}".`,
    "יש לפרויקט לוח משותף שבו כל חלק רושם החלטות והתקדמות; הוא נטען אליך רק כשהמשתמש מבקש במפורש.",
  ].join("\n");

  const { data: child, error } = await db
    .from("claude_threads")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      title,
      title_source: title ? "user" : "auto",
      model: parent.model,
      effort: parent.effort,
      repo: parent.repo,
      git_branch: parent.git_branch,
      playbook_id: parent.playbook_id,
      claude_account: parent.claude_account,
      parent_thread_id: parent.id,
      seed_context: briefing,
    })
    .select(THREAD_COLS)
    .single();
  if (error) {
    console.error("[claude/threads] child insert failed:", error.message);
    return res.status(500).json({ error: "could not create child" });
  }
  return res.status(201).json({ thread: child });
});

// ── shared project board ─────────────────────────────────────────────────────────

/** GET /claude/threads/:id/board — the shared board, resolved to the project root. */
router.get("/claude/threads/:id/board", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const root = await resolveProjectRoot(req.params.id, req.org!.id);
  if (!root) return res.status(404).json({ error: "thread not found" });
  return res.json({
    root_thread_id: root.id,
    root_title: root.title,
    body: root.project_board ?? "",
    updated_at: root.project_board_updated_at,
  });
});

/** PUT /claude/threads/:id/board — write the shared board (on the project root). */
router.put("/claude/threads/:id/board", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const orgId = req.org!.id;
  const root = await resolveProjectRoot(req.params.id, orgId);
  if (!root) return res.status(404).json({ error: "thread not found" });

  const boardBody = typeof req.body?.body === "string" ? req.body.body.slice(0, MAX_BOARD_CHARS) : "";
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("claude_threads")
    .update({ project_board: boardBody, project_board_updated_at: now, updated_at: now })
    .eq("id", root.id)
    .eq("org_id", orgId)
    .select("project_board, project_board_updated_at")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "thread not found" });
  return res.json({ body: data.project_board ?? "", updated_at: data.project_board_updated_at });
});

/**
 * POST /claude/threads/:id/board/summarize — append a summary of THIS chat to the
 * shared board. A subscription run (no paid API tokens): it reads this thread's turns
 * and writes a short "what this part decided / where it stands" entry, appended under
 * the board so the other parts can read it on demand.
 */
router.post("/claude/threads/:id/board/summarize", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "thread not found" });
  const orgId = req.org!.id;

  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id, title")
    .eq("id", req.params.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: "could not fetch thread" });
  if (!thread) return res.status(404).json({ error: "thread not found" });

  const root = await resolveProjectRoot(req.params.id, orgId);
  if (!root) return res.status(404).json({ error: "thread not found" });

  const { data: turns } = await db
    .from("claude_runs")
    .select("turn_index, user_prompt, result_summary")
    .eq("thread_id", thread.id)
    .order("turn_index", { ascending: true })
    .limit(40);
  const transcript = (turns ?? [])
    .map((t) => `## תור ${t.turn_index}\nמשתמש: ${(t.user_prompt ?? "").slice(0, 800)}\nקלוד: ${(t.result_summary ?? "").slice(0, 800)}`)
    .join("\n\n");
  if (!transcript.trim()) return res.status(400).json({ error: "nothing to summarize yet" });

  const prompt = [
    "להלן תמליל של שיחה שהיא חלק מפרויקט גדול יותר.",
    "כתוב סיכום קצר (2-5 שורות) של מה שהחלק הזה החליט ואיפה הוא עומד, כדי שחלקים אחרים",
    "בפרויקט ידעו את המצב. עברית, ענייני, בלי הקדמה.",
    "- שמור על קישורים (URL) כלשונם.",
    "- בלי טקסט חופשי מיותר — רק הסיכום.",
    "",
    transcript,
  ].join("\n");

  let summary = "";
  try {
    // Trivial/mechanical (a 2-5 line status summary) → fast model. Never a judgment.
    const raw = await runOneShot(prompt, {
      timeoutMs: 90_000,
      model: BG_MODEL_FAST,
      label: "board-summary",
    });
    summary = (raw ?? "").trim();
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
  if (!summary) return res.status(502).json({ error: "no summary produced" });

  // Append under a dated, titled heading so the board reads as a log the other parts
  // can scan. New York time per CLAUDE.md.
  const stamp = new Date().toLocaleString("he-IL", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const entry = `\n\n### ${thread.title?.trim() || "חלק"} — ${stamp}\n${summary}`;
  const existing = root.project_board ?? "";
  const next = `${existing}${entry}`.slice(0, MAX_BOARD_CHARS);
  const now = new Date().toISOString();
  const { error: uErr } = await db
    .from("claude_threads")
    .update({ project_board: next, project_board_updated_at: now, updated_at: now })
    .eq("id", root.id)
    .eq("org_id", orgId);
  if (uErr) return res.status(500).json({ error: uErr.message });
  return res.json({ body: next, updated_at: now, appended: summary });
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
