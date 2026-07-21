/**
 * Claude Code → smrtPlan auto session report.
 *
 * POST /claude-session/task-report — machine-to-machine (x-cron-secret gated,
 * no JWT), same pattern as smrtTask's claude-session.ts. Called by a Claude
 * Code Stop hook running against a task-tracking repo: it posts a lightweight
 * progress report (summary + status + session link) which we auto-attach to
 * whichever smrtPlan task the calling user currently has marked "in_progress"
 * — the caller never sends a task id, we find it — then notify the plan's
 * manager (falling back to the owner) so they see progress without polling.
 *
 * This is best-effort throughout: no task in progress → 200 with
 * attached: false (never an error — a hook's turn must never fail because
 * there happened to be nothing to attach to). notify() is itself best-effort
 * (it swallows its own insert error and just logs).
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { notify } from "../../lib/platform";

const router = Router();

const MAX_FIELD = 2000;
function clean(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "";
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

  // 5. Notify the plan's manager (falling back to the owner) — only when the
  // status or summary actually changed, and best-effort otherwise (matches
  // notify()'s own risk tolerance — it swallows its own insert error).
  if (isMeaningfulChange) {
    const { data: plan } = task.plan_id
      ? await db
          .from("smrtplan_plans")
          .select("manager_user_id, owner_user_id, title_he, title_en")
          .eq("id", task.plan_id as string)
          .maybeSingle()
      : { data: null };

    const targetUserId = (plan?.manager_user_id as string | null) ?? (plan?.owner_user_id as string | null);
    // Never notify someone about their own session — e.g. the plan owner
    // running Claude Code on their own task (they were there; a notification
    // adds noise, not information).
    if (targetUserId && targetUserId !== userId) {
      const taskTitle = (task.title_he as string) || (task.title as string) || "";
      const bodyLine = summary || "התקבל עדכון התקדמות מסשן Claude Code.";
      await notify(orgId, targetUserId, {
        app_slug: "smrtplan",
        type: "info",
        title: `עדכון התקדמות: ${taskTitle}`,
        body: `${bodyLine}\n\nסטטוס: ${STATUS_HE[status] ?? status}`,
        link: sessionUrl ?? undefined,
        entity_type: "task",
        entity_id: task.id as string,
      });
    }
  }

  res.json({ ok: true, attached: true, task_id: task.id });
});

export default router;
