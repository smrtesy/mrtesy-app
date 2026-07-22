/**
 * Claude Code → smrtPlan auto session report.
 *
 * POST /claude-session/task-report — machine-to-machine (x-cron-secret gated,
 * no JWT), same pattern as smrtTask's claude-session.ts. Called by a Claude
 * Code Stop hook running against a task-tracking repo: it posts a lightweight
 * progress report (summary + status + session link) which we auto-attach to
 * whichever smrtPlan task the calling user currently has marked "in_progress"
 * — the caller never sends a task id, we find it — then file a smrtTask
 * PROPOSAL in the plan's manager's inbox (falling back to the owner) so they
 * see progress without polling. The proposal is deduped to ONE per (worker,
 * New-York day) via claude_manager_proposals, so a busy day is one refreshing
 * item, not a flood.
 *
 * This is best-effort throughout: no task in progress → 200 with
 * attached: false (never an error — a hook's turn must never fail because
 * there happened to be nothing to attach to). The manager-proposal step
 * (fileManagerProposal) is likewise best-effort — it swallows its own errors
 * and never fails the turn.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";

const router = Router();

const MAX_FIELD = 2000;
function clean(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "";
}

/** Today's date in America/New_York (YYYY-MM-DD) — the user is NY-based, so the
 *  per-day dedup window follows NY days, not UTC (see CLAUDE.md timezone rule). */
function nyDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * File (or refresh) a smrtTask proposal in the MANAGER's inbox summarizing a
 * worker's progress report. Deduped to ONE proposal per (worker, NY-day) via the
 * claude_manager_proposals unique constraint — refreshes the same task all day,
 * and the constraint makes concurrent sessions race-proof. Best-effort: a hook's
 * turn must never fail because of this, so every step swallows its own error.
 */
async function fileManagerProposal(params: {
  orgId: string;
  managerUserId: string;
  workerEmail: string;
  day: string;
  title: string;
  description: string;
  sessionUrl: string | null;
}): Promise<void> {
  const { orgId, managerUserId, workerEmail, day, title, description, sessionUrl } = params;
  const actionLinks = sessionUrl
    ? [{ label: "פתח את הצ'אט ב-Claude Code", url: sessionUrl }]
    : [];
  const dedupTag = `claude-worker-day:${workerEmail}:${day}`;

  const taskPatch = {
    title,
    title_he: title,
    description,
    action_links: actionLinks,
    updated_at: new Date().toISOString(),
  };

  // 1. Existing manager proposal for this (worker, day)? → refresh it.
  const { data: map } = await db
    .from("claude_manager_proposals")
    .select("task_id")
    .eq("org_id", orgId)
    .eq("manager_user_id", managerUserId)
    .eq("worker_email", workerEmail)
    .eq("ny_date", day)
    .maybeSingle();
  if (map?.task_id) {
    await db.from("tasks").update(taskPatch).eq("id", map.task_id as string);
    return;
  }

  // 2. Create the proposal task for the manager.
  const { data: created, error: insErr } = await db
    .from("tasks")
    .insert({
      user_id: managerUserId,
      organization_id: orgId,
      task_type: "followup",
      status: "inbox",
      priority: "low",
      manually_verified: false,
      title,
      title_he: title,
      description,
      action_links: actionLinks,
      tags: ["via-claude-session", "worker-report", dedupTag],
      ai_model_used: null,
    })
    .select("id")
    .single();
  if (insErr || !created) return; // best-effort

  // 3. Claim the dedup slot. A unique-violation (23505) means a concurrent
  //    session beat us to it — reuse the winner's task and drop our duplicate.
  //    For ANY OTHER error (e.g. the dedup table not migrated yet, or a transient
  //    failure) we KEEP the proposal we just created — deleting it would file
  //    nothing at all. So only reconcile on a genuine, resolvable duplicate.
  const { error: mapErr } = await db.from("claude_manager_proposals").insert({
    org_id: orgId,
    manager_user_id: managerUserId,
    worker_email: workerEmail,
    ny_date: day,
    task_id: created.id,
  });
  if (mapErr && (mapErr as { code?: string }).code === "23505") {
    const { data: winner } = await db
      .from("claude_manager_proposals")
      .select("task_id")
      .eq("org_id", orgId)
      .eq("manager_user_id", managerUserId)
      .eq("worker_email", workerEmail)
      .eq("ny_date", day)
      .maybeSingle();
    if (winner?.task_id && winner.task_id !== created.id) {
      await db.from("tasks").delete().eq("id", created.id);
      await db.from("tasks").update(taskPatch).eq("id", winner.task_id as string);
    }
  }
}

const VALID_STATUSES = new Set(["in_progress", "blocked", "done"]);
const STATUS_HE: Record<string, string> = {
  in_progress: "בתהליך",
  blocked: "חסום",
  done: "הושלם",
};

/** Resolve a user by explicit id or by email — identical logic to
 *  smrttask/routes/claude-session.ts's resolveUserId (duplicated here; this
 *  codebase has no shared-utils layer for this small helper). */
async function resolveUserId(userId?: string, email?: string): Promise<string | null> {
  if (userId && typeof userId === "string" && userId.trim()) return userId.trim();
  if (!email) return null;
  const target = email.trim().toLowerCase();
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.error("[session-report] listUsers failed:", error.message);
    return null;
  }
  const hit = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === target);
  return hit?.id ?? null;
}

router.post("/claude-session/task-report", async (req: Request, res: Response) => {
  // Shared machine-to-machine secret (SMRTBOT_INTERNAL_SECRET / CRON_SECRET).
  // Require it SET so an unset var can't leave the route open.
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body ?? {};
  const sessionId = clean(body.session_id);
  if (!sessionId) return res.status(400).json({ error: "session_id is required" });

  const sessionUrl = clean(body.session_url) || null;
  const summary = clean(body.summary);
  const status = VALID_STATUSES.has(body.status) ? (body.status as string) : "in_progress";

  // Worker identity (for the manager proposal + its per-day dedup) and the Claude
  // account that ran the chat (shown on the proposal, like smrtTask's claude-session).
  const workerEmail = clean(body.user_email).toLowerCase();
  const claudeUserEmail = clean(body.claude_user_email) || null;
  const claudeUserName = clean(body.claude_user_name) || null;
  const claudeAccountLabel = claudeUserEmail
    ? claudeUserName && claudeUserName !== claudeUserEmail
      ? `${claudeUserName} (${claudeUserEmail})`
      : claudeUserEmail
    : null;

  // 1. Resolve the target user + their primary org + smrtplan entitlement.
  const userId = await resolveUserId(
    typeof body.user_id === "string" ? body.user_id : undefined,
    typeof body.user_email === "string" ? body.user_email : undefined,
  );
  if (!userId) return res.status(404).json({ error: "user not found" });

  const { data: membership, error: memErr } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (memErr) return res.status(500).json({ error: memErr.message });
  if (!membership) return res.status(403).json({ error: "user has no org" });
  const orgId = membership.org_id as string;

  const { data: app, error: appErr } = await db.from("apps").select("id").eq("slug", "smrtplan").maybeSingle();
  if (appErr) return res.status(500).json({ error: appErr.message });
  const { data: entitled, error: entErr } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("app_id", app?.id ?? "")
    .maybeSingle();
  if (entErr) return res.status(500).json({ error: entErr.message });
  if (!entitled) return res.status(403).json({ error: "smrtplan not enabled for user's org" });

  // 2. Find the user's current in-progress plan task (best-effort — no task id
  // is sent, we find it). No match is NOT an error: the hook fires on every
  // turn-end whether or not the user happens to have a plan task in progress.
  const { data: task, error: findErr } = await db
    .from("tasks")
    .select("id, title, title_he, plan_id")
    .eq("organization_id", orgId)
    .eq("assigned_to_user_id", userId)
    .eq("status", "in_progress")
    .not("plan_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!task) return res.json({ ok: true, attached: false });

  // 3. Read any existing row for this (task_id, session_id) FIRST, so we can
  // tell whether this call actually changes anything — a long session's Stop
  // hook fires on every turn-cycle (up to twice: the agent's own post, then a
  // generic safety-net fallback), and re-notifying the manager on every one of
  // those with no new information would flood their inbox with near-duplicates.
  const { data: existing, error: existingErr } = await db
    .from("task_session_reports")
    .select("status, summary")
    .eq("task_id", task.id as string)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (existingErr) return res.status(500).json({ error: existingErr.message });
  const isMeaningfulChange =
    !existing || existing.status !== status || (existing.summary as string) !== summary;

  // 4. Upsert the report, keyed by (task_id, session_id) — a session refreshes
  // its own row as the agent keeps working, never duplicates.
  const { error: upsertErr } = await db.from("task_session_reports").upsert(
    {
      org_id: orgId,
      task_id: task.id,
      user_id: userId,
      session_id: sessionId,
      session_url: sessionUrl,
      summary,
      status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "task_id,session_id" },
  );
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  // 5. File a smrtTask PROPOSAL in the plan manager's inbox (falling back to the
  // owner) — only when the status or summary actually changed. Deduped to one
  // proposal per (worker, NY-day). Best-effort: never fails the hook's turn.
  let managerProposalFiled = false;
  if (isMeaningfulChange) {
    const { data: plan } = task.plan_id
      ? await db
          .from("smrtplan_plans")
          .select("manager_user_id, owner_user_id, title_he, title_en")
          .eq("id", task.plan_id as string)
          .maybeSingle()
      : { data: null };

    const targetUserId = (plan?.manager_user_id as string | null) ?? (plan?.owner_user_id as string | null);
    // Never file a proposal to someone about their OWN session — e.g. the plan
    // owner running Claude Code on their own task (they were there). This is also
    // what keeps the manager's combination flow from proposing to itself.
    if (targetUserId && targetUserId !== userId) {
      const taskTitle = (task.title_he as string) || (task.title as string) || "";
      const workerKey = workerEmail || userId;
      const title = `עדכון התקדמות מ${workerEmail || "עובד"}: ${taskTitle}`;
      const description = [
        summary || "התקבל עדכון התקדמות מסשן Claude Code.",
        `סטטוס: ${STATUS_HE[status] ?? status}`,
        workerEmail ? `עובד: ${workerEmail}` : "",
        claudeAccountLabel ? `חשבון Claude: ${claudeAccountLabel}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      await fileManagerProposal({
        orgId,
        managerUserId: targetUserId,
        workerEmail: workerKey,
        day: nyDate(),
        title,
        description,
        sessionUrl,
      });
      managerProposalFiled = true;
    }
  }

  res.json({ ok: true, attached: true, task_id: task.id, manager_proposal: managerProposalFiled });
});

export default router;
