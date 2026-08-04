/**
 * Deploy queue — machine-to-machine surface (phase 1 of
 * docs/claude-console/deploy-queue-plan.md).
 *
 * A server-code fix registers here instead of pushing to `main` itself; a
 * background coordinator (later phase) merges the whole `ready` batch and deploys
 * ONCE, so parallel server fixes stop restarting each other.
 *
 * Two endpoints, both x-cron-secret gated (no JWT — the caller is the console
 * run's hook / push step, which has the shared internal secret, not a user token):
 *
 *   POST /claude-deploy/register-building { thread_id, run_id?, branch?, title? }
 *     Called on a run's FIRST edit under server/**. Marks the thread's fix
 *     'building' so the coordinator holds the deploy for a fix still in flight.
 *     Fire-and-forget on the caller side; idempotent here.
 *
 *   POST /claude-deploy/mark-ready { thread_id, branch, title? }
 *     Called at push time when a run's diff touches server/**: instead of pushing
 *     to `main`, it pushes its branch and calls this, moving the fix to 'ready'.
 *     Also the fallback that catches a side-channel edit the fast hook missed —
 *     it upserts even when no 'building' row exists.
 *
 * org_id is resolved from the thread, so the caller never has to pass it. Writes
 * go through the service-role client; the table's RLS denies everyone else.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";

const router = Router();

/** Shared machine secret, required SET so an unset var can't leave the route open
 *  (same gate as /claude-session and /claude-action). */
function authed(req: Request): boolean {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  return !!expected && req.headers["x-cron-secret"] === expected;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null;
}
function text(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** A row reused from a terminal state (or a brand-new one) starts a NEW fix, so its
 *  `created_at` must be reset — the coordinator's 30-minute cap keys off the
 *  earliest `created_at`, and a stale one from a fix that finished days ago would
 *  make the new batch look ancient and deploy prematurely. A re-fire onto a live
 *  'building' row keeps its original `created_at` (same fix). */
const TERMINAL = ["done", "failed", "conflict"];
function isFreshFix(existingState: string | null | undefined): boolean {
  return !existingState || TERMINAL.includes(existingState);
}

/** The thread's org — the authoritative scope, so the caller doesn't pass org_id. */
async function orgOfThread(threadId: string): Promise<string | null> {
  const { data, error } = await db
    .from("claude_threads")
    .select("org_id")
    .eq("id", threadId)
    .maybeSingle();
  if (error) {
    console.error("[claude-deploy] thread lookup failed:", error.message);
    return null;
  }
  return data?.org_id ?? null;
}

router.post("/claude-deploy/register-building", async (req: Request, res: Response) => {
  if (!authed(req)) return res.status(403).json({ error: "Forbidden" });

  const threadId = uuid(req.body?.thread_id);
  if (!threadId) return res.status(400).json({ error: "thread_id (uuid) required" });
  const orgId = await orgOfThread(threadId);
  if (!orgId) return res.status(404).json({ error: "thread not found" });

  // Don't drag a fix that has already advanced back to 'building' — the marker on
  // the run side makes a re-fire rare, but a stale one must not un-ready a fix or
  // interrupt an in-progress deploy. Fail CLOSED on a read error: a swallowed error
  // here would skip the guard and silently un-ready a fix.
  const { data: existing, error: readErr } = await db
    .from("claude_deploy_queue")
    .select("state")
    .eq("thread_id", threadId)
    .maybeSingle();
  if (readErr) {
    console.error("[claude-deploy] register-building read failed:", readErr.message);
    return res.status(500).json({ error: "read failed" });
  }
  if (existing && ["ready", "deploying"].includes(existing.state)) {
    return res.json({ ok: true, state: existing.state, unchanged: true });
  }

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: orgId,
    thread_id: threadId,
    run_id: uuid(req.body?.run_id),
    branch: text(req.body?.branch, 300),
    title: text(req.body?.title, 200) ?? "",
    state: "building",
    error: null,
    updated_at: now,
  };
  if (isFreshFix(existing?.state)) row.created_at = now; // a new fix restarts the clock
  const { error } = await db
    .from("claude_deploy_queue")
    .upsert(row, { onConflict: "thread_id" });
  if (error) {
    console.error("[claude-deploy] register-building failed:", error.message);
    return res.status(500).json({ error: "write failed" });
  }
  return res.json({ ok: true, state: "building" });
});

router.post("/claude-deploy/mark-ready", async (req: Request, res: Response) => {
  if (!authed(req)) return res.status(403).json({ error: "Forbidden" });

  const threadId = uuid(req.body?.thread_id);
  if (!threadId) return res.status(400).json({ error: "thread_id (uuid) required" });
  const branch = text(req.body?.branch, 300);
  if (!branch) return res.status(400).json({ error: "branch required" });
  const orgId = await orgOfThread(threadId);
  if (!orgId) return res.status(404).json({ error: "thread not found" });

  // Fail CLOSED on the read, and never DOWNGRADE a fix the coordinator already
  // picked up: a retried mark-ready after 'deploying'/'done' must not drop the row
  // back to 'ready' and get it re-deployed.
  const { data: existing, error: readErr } = await db
    .from("claude_deploy_queue")
    .select("state")
    .eq("thread_id", threadId)
    .maybeSingle();
  if (readErr) {
    console.error("[claude-deploy] mark-ready read failed:", readErr.message);
    return res.status(500).json({ error: "read failed" });
  }
  if (existing && ["deploying", "done"].includes(existing.state)) {
    return res.json({ ok: true, state: existing.state, unchanged: true });
  }

  // Upsert so a side-channel edit the fast hook never saw (no 'building' row) is
  // still caught here at push time — the gate that guarantees correctness.
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: orgId,
    thread_id: threadId,
    run_id: uuid(req.body?.run_id),
    branch,
    title: text(req.body?.title, 200) ?? "",
    state: "ready",
    error: null,
    updated_at: now,
  };
  if (isFreshFix(existing?.state)) row.created_at = now; // straight-to-ready / retry after fail
  const { error } = await db
    .from("claude_deploy_queue")
    .upsert(row, { onConflict: "thread_id" });
  if (error) {
    console.error("[claude-deploy] mark-ready failed:", error.message);
    return res.status(500).json({ error: "write failed" });
  }
  return res.json({ ok: true, state: "ready" });
});

export default router;
