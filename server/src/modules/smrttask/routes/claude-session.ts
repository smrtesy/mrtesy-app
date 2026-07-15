/**
 * Claude Code → smrtTask session proposals.
 *
 * POST /claude-session/proposal — machine-to-machine (x-cron-secret gated, no
 * JWT). Called by the Claude Code Stop hook (`.claude/hooks/…`) at the end of a
 * working turn in this repo. It creates — or refreshes, keyed by the session id
 * — a single smrtTask inbox item ("הצעה") that captures the chat: the topic
 * discussed, where it happened (repo / branch), a verbatim deep link back to
 * the web chat, and a proposed follow-up so the discussion/action can be closed.
 *
 * Idempotent per session: the hook fires on every Stop, so repeated calls for
 * the same `session_id` update the same task instead of piling up duplicates.
 * The dedup key is the tag `claude-session:<session_id>`; we never resurrect a
 * task the user has since archived/dismissed — only its content is refreshed.
 *
 * Auth model mirrors /sync/run-scheduled: a shared CRON_SECRET lets the hook
 * file a proposal for a specific user (resolved by email or id) without a JWT.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { simpleCall, parseJsonResponse, MODELS } from "../../../anthropic";
import { emitEvent } from "../../../lib/platform";

const router = Router();

/** Cap the transcript we summarize so a long chat can't blow up the Haiku bill. */
const MAX_TRANSCRIPT_CHARS = 24_000;

interface SessionSummary {
  /** Short Hebrew topic — becomes the task title. */
  topic: string;
  /** 1–3 Hebrew sentences describing what was discussed/done. */
  summary: string;
  /** The proposed next step to close the discussion/action (Hebrew). */
  next_step: string;
}

const SUMMARY_SYSTEM = `אתה מסכם שיחת עבודה שהתנהלה ב-Claude Code (כלי פיתוח קוד) לכדי "הצעה" קצרה במערכת משימות.
קלט: תמליל שיחה בין מפתח ל-Claude (ייתכן בפורמט JSONL — התעלם ממטא-דאטה, קרא את התוכן).
פלט: JSON בלבד, ללא טקסט נוסף, במבנה:
{"topic": "...", "summary": "...", "next_step": "..."}
כללים:
- הכול בעברית, קצר וענייני. topic = עד 8 מילים. summary = 1-3 משפטים. next_step = משפט אחד עם הפעולה המוצעת להשלמת הדיון/המשימה.
- שמר כל קישור (URL) שמופיע בשיחה מילה-במילה (verbatim), כולל פרמטרים — אל תקצר ל-domain.
- אם השיחה טריוויאלית או ריקה, החזר topic="שיחת Claude Code" ו-next_step קצר בהתאם.`;

async function summarizeTranscript(
  transcript: string,
  userId: string,
): Promise<SessionSummary> {
  const fallback: SessionSummary = {
    topic: "שיחת Claude Code",
    summary: "התנהלה שיחת עבודה ב-Claude Code על מאגר mrtesy-app.",
    next_step: "לעבור על מה שנעשה ולהחליט אם נדרש המשך.",
  };
  const trimmed = transcript.trim();
  if (!trimmed) return fallback;

  // Keep the tail — the end of a chat holds the conclusions/next steps.
  const clipped =
    trimmed.length > MAX_TRANSCRIPT_CHARS ? trimmed.slice(-MAX_TRANSCRIPT_CHARS) : trimmed;

  try {
    const { content } = await simpleCall(
      "haiku",
      SUMMARY_SYSTEM,
      clipped,
      512,
      { component: "server.claude-session", userId },
    );
    const parsed = parseJsonResponse<SessionSummary>(content);
    if (parsed && typeof parsed.topic === "string" && parsed.topic.trim()) {
      return {
        topic: parsed.topic.trim().slice(0, 120),
        summary: (parsed.summary ?? "").trim(),
        next_step: (parsed.next_step ?? "").trim(),
      };
    }
  } catch (e) {
    console.error("[claude-session] summarize failed:", (e as Error).message);
  }
  return fallback;
}

/** Resolve a user by explicit id or by email (super-admin's personal automation). */
async function resolveUserId(userId?: string, email?: string): Promise<string | null> {
  if (userId && typeof userId === "string") return userId;
  if (!email) return null;
  const target = email.trim().toLowerCase();
  // Scan the auth user list in bounded pages — this is a small, single-tenant
  // deployment, so a few pages of 200 covers it without an auth-schema RPC.
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) return null; // last page, no match
  }
  return null;
}

router.post("/claude-session/proposal", async (req: Request, res: Response) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body ?? {};
  const sessionId: string | undefined =
    typeof body.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : undefined;
  if (!sessionId) return res.status(400).json({ error: "session_id is required" });

  const sessionUrl: string | null =
    typeof body.session_url === "string" && body.session_url.trim() ? body.session_url.trim() : null;
  const gitBranch: string | null =
    typeof body.git_branch === "string" && body.git_branch.trim() ? body.git_branch.trim() : null;
  const repo: string =
    typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : "mrtesy-app";
  const transcript: string = typeof body.transcript === "string" ? body.transcript : "";

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

  // 2. Summarize the chat.
  const s = await summarizeTranscript(transcript, userId);

  const whereLine = gitBranch ? `${repo} · ענף ${gitBranch}` : repo;
  const descriptionParts = [
    s.summary,
    s.next_step ? `המשך מוצע: ${s.next_step}` : "",
    `היכן: ${whereLine}`,
  ].filter(Boolean);
  const description = descriptionParts.join("\n\n");

  // Deep link back to the chat — verbatim, per the product's "preserve deep
  // links" principle. Surfaced as a one-click action nugget, not buried in text.
  const actionLinks = sessionUrl
    ? [{ label: "פתח את הצ'אט ב-Claude Code", url: sessionUrl }]
    : [];

  const dedupTag = `claude-session:${sessionId}`;

  // 3. Upsert by the dedup tag. Refresh content only; never touch a status the
  // user changed (archived/dismissed proposals stay put).
  const { data: existing } = await db
    .from("tasks")
    .select("id, status")
    .eq("organization_id", orgId)
    .contains("tags", [dedupTag])
    .maybeSingle();

  if (existing) {
    const { data: updated, error } = await db
      .from("tasks")
      .update({
        title: s.topic,
        title_he: s.topic,
        description,
        action_links: actionLinks,
        updated_at: new Date().toISOString(),
      })
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
      title: s.topic,
      title_he: s.topic,
      description,
      action_links: actionLinks,
      tags: ["via-claude-session", dedupTag],
      ai_model_used: MODELS.haiku,
    })
    .select("id")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(orgId, "smrttask", "task.created", "task", created.id, {
    title: s.topic,
    priority: "low",
    source: "claude-session",
  });

  res.status(201).json({ ok: true, task_id: created.id, action: "created" });
});

export default router;
