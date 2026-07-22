/**
 * Claude Code → smrtTask session proposals.
 *
 * POST /claude-session/proposal — machine-to-machine (x-cron-secret gated, no
 * JWT). Called by the Claude Code Stop hook (`.claude/hooks/…`) at the end of a
 * working turn in this repo. It creates — or refreshes, keyed by the session id
 * — a single smrtTask inbox item ("הצעה") that captures the chat: the topic
 * discussed, where it happened (repo / branch), a verbatim deep link back to
 * the web chat, and a proposed follow-up.
 *
 * COST MODEL (changed 2026-07): the backend NEVER calls an LLM here. The chat
 * summary is produced by the Claude Code AGENT itself (on the user's Claude
 * subscription) and passed in the request body as { topic, summary, next_step }.
 * When those are absent (e.g. the plain Stop-hook fallback), we file a minimal
 * no-AI trace instead — and, crucially, we do NOT overwrite an existing task's
 * agent-written summary with the minimal one (partial update). Zero API tokens.
 *
 * Idempotent per session: repeated calls for the same `session_id` update the
 * same task (dedup tag `claude-session:<session_id>`); a status the user changed
 * (archived/dismissed) is never overwritten.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { emitEvent } from "../../../lib/platform";

const router = Router();

const MAX_FIELD = 2000;
function clean(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_FIELD) : "";
}

/** Resolve a user by explicit id or by email (super-admin's personal automation).
 *  One bulk listUsers({ perPage: 1000 }) + local match — the exact pattern the
 *  rest of this codebase uses (admin/users, platform/members). */
async function resolveUserId(userId?: string, email?: string): Promise<string | null> {
  if (userId && typeof userId === "string" && userId.trim()) return userId.trim();
  if (!email) return null;
  const target = email.trim().toLowerCase();
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.error("[claude-session] listUsers failed:", error.message);
    return null;
  }
  const hit = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === target);
  return hit?.id ?? null;
}

router.post("/claude-session/proposal", async (req: Request, res: Response) => {
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
  const gitBranch = clean(body.git_branch) || null;
  const repo = clean(body.repo) || "mrtesy-app";

  // Claude ACCOUNT identity that ran the chat — shown on the proposal so we know
  // who filed it. Distinct from the resolved platform user (user_id/user_email),
  // which may be an override used only for account lookup.
  const claudeUserEmail = clean(body.claude_user_email) || null;
  const claudeUserName = clean(body.claude_user_name) || null;
  const claudeAccountLabel = claudeUserEmail
    ? claudeUserName && claudeUserName !== claudeUserEmail
      ? `${claudeUserName} (${claudeUserEmail})`
      : claudeUserEmail
    : null;

  // Agent-provided summary (made on the Claude subscription). No LLM here.
  const topic = clean(body.topic);
  const summary = clean(body.summary);
  const nextStep = clean(body.next_step);
  const hasSummary = Boolean(topic || summary);

  // 1. Resolve the target user + their primary org (mirrors /sync/run-scheduled).
  const userId = await resolveUserId(
    typeof body.user_id === "string" ? body.user_id : undefined,
    typeof body.user_email === "string" ? body.user_email : undefined,
  );
  if (!userId) return res.status(404).json({ error: "user not found" });

  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: "user has no org" });
  const orgId = membership.org_id as string;

  const { data: app } = await db.from("apps").select("id").eq("slug", "smrttask").maybeSingle();
  const { data: entitled } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("app_id", app?.id ?? "")
    .maybeSingle();
  if (!entitled) return res.status(403).json({ error: "smrttask not enabled for user's org" });

  // 2. Build the proposal content from the agent-provided fields (no LLM).
  const whereLine = gitBranch ? `${repo} · ענף ${gitBranch}` : repo;
  const title = topic || "שיחת Claude Code";
  const description = [
    summary || (hasSummary ? "" : "התנהלה שיחת עבודה ב-Claude Code."),
    nextStep ? `המשך מוצע: ${nextStep}` : "",
    `היכן: ${whereLine}`,
    claudeAccountLabel ? `חשבון Claude: ${claudeAccountLabel}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Deep link back to the chat — verbatim (product "preserve deep links" rule).
  const actionLinks = sessionUrl
    ? [{ label: "פתח את הצ'אט ב-Claude Code", url: sessionUrl }]
    : [];

  const dedupTag = `claude-session:${sessionId}`;

  // 3. Upsert by the dedup tag. Reuse the earliest matching row; .limit(1) so a
  // transient race can't error out maybeSingle().
  const { data: existing, error: findErr } = await db
    .from("tasks")
    .select("id, status")
    .eq("organization_id", orgId)
    .contains("tags", [dedupTag])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });

  if (existing) {
    // Partial update: only refresh the summary when THIS call actually carries
    // one — so a minimal Stop-hook fallback never clobbers the agent's richer
    // summary from an earlier call this session. Always refresh the deep link.
    const patch: Record<string, unknown> = {
      action_links: actionLinks,
      updated_at: new Date().toISOString(),
    };
    if (hasSummary) {
      patch.title = title;
      patch.title_he = title;
      patch.description = description;
    }
    const { data: updated, error } = await db
      .from("tasks")
      .update(patch)
      .eq("organization_id", orgId)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, task_id: updated.id, action: "updated" });
  }

  const { data: created, error } = await db
    .from("tasks")
    .insert({
      user_id: userId,
      organization_id: orgId,
      task_type: "followup",
      status: "inbox",
      priority: "low",
      manually_verified: false, // AI-generated suggestion, awaits the user's review
      title,
      title_he: title,
      description,
      action_links: actionLinks,
      tags: ["via-claude-session", dedupTag],
      ai_model_used: null, // summary produced by the Claude Code agent, not an API call
    })
    .select("id")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(orgId, "smrttask", "task.created", "task", created.id, {
    title,
    priority: "low",
    source: "claude-session",
  });

  res.status(201).json({ ok: true, task_id: created.id, action: "created" });
});

/** Resolve the primary org for a user (earliest membership). */
async function primaryOrgId(userId: string): Promise<string | null> {
  const { data } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

/**
 * GET /claude-session/known-workers — the "what is your smrtTask email?" list a
 * shared Claude Code account shows at session start. Anchored to the MANAGER's
 * org (the list is shared across that org's workers), so the caller passes the
 * manager identity (manager_id / manager_email). Returns [] on any miss — the
 * hook must never fail because the list is empty or the manager is unresolved.
 */
router.get("/claude-session/known-workers", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const managerId = await resolveUserId(
    typeof req.query.manager_id === "string" ? req.query.manager_id : undefined,
    typeof req.query.manager_email === "string" ? req.query.manager_email : undefined,
  );
  if (!managerId) return res.json({ ok: true, workers: [] });
  const orgId = await primaryOrgId(managerId);
  if (!orgId) return res.json({ ok: true, workers: [] });

  const { data, error } = await db
    .from("claude_known_workers")
    .select("email, label")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, workers: data ?? [] });
});

/**
 * POST /claude-session/known-workers — save a newly-entered worker email to the
 * manager's org list so it appears next time. Idempotent: the (org_id, email)
 * unique constraint means re-adding the same email is a no-op.
 * Body: { manager_id?, manager_email?, email, label? }.
 */
router.post("/claude-session/known-workers", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body ?? {};
  const email = clean(body.email).toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });
  const label = clean(body.label) || null;

  const managerId = await resolveUserId(
    typeof body.manager_id === "string" ? body.manager_id : undefined,
    typeof body.manager_email === "string" ? body.manager_email : undefined,
  );
  if (!managerId) return res.status(404).json({ error: "manager not found" });
  const orgId = await primaryOrgId(managerId);
  if (!orgId) return res.status(403).json({ error: "manager has no org" });

  const { error } = await db
    .from("claude_known_workers")
    .upsert({ org_id: orgId, email, label }, { onConflict: "org_id,email" });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

export default router;
