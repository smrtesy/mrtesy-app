/**
 * smrtInfo — machine-to-machine batch extraction (x-cron-secret gated, no JWT).
 *
 * Used for the initial data-population of the information center: a separate
 * runner (e.g. a Claude Code data-population session) pages through the user's
 * source_messages history and calls this to run Sonnet fact-extraction in
 * batches. Caller-driven paging keeps the endpoint stateless:
 *   - pass explicit `source_message_ids`, OR
 *   - omit them and page with `{ limit, before }` (before = a created_at cursor;
 *     the response returns `nextBefore` = the oldest created_at processed).
 *
 * Auth model mirrors /sync/run-scheduled: a shared secret lets the runner act
 * for any user without a JWT. Mounted BEFORE the auth-guarded routers.
 */

import { Router, type Request, type Response } from "express";
import { db } from "../../db";
import { extractAndStore } from "./extract";

const router = Router();

const MAX_BATCH = 50;

interface MsgRow {
  id: string;
  raw_content: string | null;
  body_text: string | null;
  subject: string | null;
  sender: string | null;
  source_type: string | null;
  source_url: string | null;
  created_at: string | null;
}

const MSG_COLS =
  "id, raw_content, body_text, subject, sender, source_type, source_url, created_at";

router.post("/info/extract/batch", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) return res.status(400).json({ error: "user_id required" });

  // Resolve the user's primary org + smrtinfo entitlement (mirrors run-scheduled).
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: "user has no org" });
  const orgId = (membership as { org_id: string }).org_id;

  const { data: app } = await db.from("apps").select("id").eq("slug", "smrtinfo").maybeSingle();
  const { data: entitled } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("app_id", (app as { id?: string } | null)?.id ?? "")
    .maybeSingle();
  if (!entitled) return res.status(403).json({ error: "smrtinfo not enabled for user's org" });

  // Gather the messages to process.
  let rows: MsgRow[] = [];
  const rawIds = Array.isArray(body.source_message_ids) ? body.source_message_ids : null;
  const ids = rawIds
    ? rawIds.filter((x): x is string => typeof x === "string").slice(0, MAX_BATCH)
    : null;

  if (ids && ids.length) {
    const { data, error } = await db
      .from("source_messages")
      .select(MSG_COLS)
      .eq("user_id", userId)
      .in("id", ids);
    if (error) return res.status(500).json({ error: error.message });
    rows = (data as MsgRow[]) ?? [];
  } else {
    const limit = Math.min(Number(body.limit) || 20, MAX_BATCH);
    let q = db
      .from("source_messages")
      .select(MSG_COLS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (typeof body.before === "string" && body.before) q = q.lt("created_at", body.before);
    // Lower bound (exclusive) — lets a runner partition the history into
    // non-overlapping created_at windows and process them in parallel.
    if (typeof body.after === "string" && body.after) q = q.gt("created_at", body.after);
    // Skip non-substantive messages (spam / skipped / superseded old versions)
    // so the initial population doesn't spend Sonnet calls on noise. Pass
    // skip_noise:false to process everything.
    if (body.skip_noise !== false) {
      q = q.not("ai_classification", "in", "(spam,skip,skipped,superseded,self_chat_thread_skip)");
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    rows = (data as MsgRow[]) ?? [];
  }

  const totals = {
    messages: rows.length,
    factsStored: 0,
    factsSuperseded: 0,
    secretSuggestions: 0,
    dropped: 0,
    costUsd: 0,
  };
  let nextBefore: string | null = null;

  for (const m of rows) {
    if (m.created_at) nextBefore = m.created_at; // rows are created_at DESC → last = oldest
    const r = await extractAndStore(orgId, userId, {
      sourceMessageId: m.id,
      sourceType: m.source_type,
      sourceUrl: m.source_url,
      subject: m.subject,
      sender: m.sender,
      content: m.raw_content || m.body_text || "",
    });
    totals.factsStored += r.factsStored;
    totals.factsSuperseded += r.factsSuperseded;
    totals.secretSuggestions += r.secretSuggestions;
    totals.dropped += r.dropped;
    totals.costUsd += r.costUsd;
  }

  res.json({ ...totals, nextBefore });
});

export default router;
