/**
 * Deploy queue — machine-to-machine surface (phase 1 of
 * docs/claude-console/deploy-queue-plan.md).
 *
 * A server-code fix registers here instead of pushing to `main` itself; a
 * background coordinator (later phase) merges the whole `ready` batch and deploys
 * ONCE, so parallel server fixes stop restarting each other.
 *
 * x-cron-secret gated (no JWT — the caller is the console run's push step, which has
 * the shared internal secret, not a user token):
 *
 *   POST /claude-deploy/mark-ready { thread_id, branch, title? }
 *     Called at push time when a run's diff touches server/**: instead of pushing
 *     to `main`, ship.sh pushes its branch and calls this, moving the fix to 'ready'.
 *     The coordinator then batch-merges every 'ready' fix in one redeploy.
 *
 *   POST /claude-deploy/mark-shipped { thread_id, sha, surface?, branch? }
 *     ship.sh's DIRECT path (frontend/docs push straight to main) — arms the
 *     ship-status dot without going through the queue.
 *
 * (An earlier `register-building` endpoint that pre-marked a fix 'building' was
 * removed: nothing ever called it, and the coordinator's active-run gate already
 * holds the batch while any run — including one mid-build — is live, so a separate
 * 'building' queue state was redundant.)
 *
 * org_id is resolved from the thread, so the caller never has to pass it. Writes
 * go through the service-role client; the table's RLS denies everyone else.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { markThreadShipped, type ShipSurface } from "./ship-status";

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
 *  `created_at` must be reset — the coordinator's MAX_WAIT_MS hard cap keys off the
 *  earliest `created_at`, and a stale one from a fix that finished days ago would
 *  make the new batch look ancient and deploy prematurely. A re-fire onto a still
 *  -pending 'ready'/'deploying' row keeps its original `created_at` (same fix). */
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

  // Upsert (onConflict thread_id): a repeat ship of the same thread's fix reuses its
  // row; a brand-new fix creates one. This push-time call is the sole entry into the
  // queue — the gate that guarantees a server change is batched, not pushed to main.
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
  // Resting yellow dot on the thread: pushed a branch, waiting for the coordinator
  // to batch-merge it to main. The coordinator overwrites this to 'main_building'
  // once it actually merges + pushes. `notOverLive` so a retried mark-ready can't drag
  // an already-merged thread's green/building dot back to yellow. Best-effort.
  await markThreadShipped(threadId, { state: "pushed_branch", branch }, { notOverLive: true });
  return res.json({ ok: true, state: "ready" });
});

/**
 * POST /claude-deploy/mark-shipped { thread_id, sha, surface?, branch? }
 *   Called by ship.sh's DIRECT path — the frontend/docs push that goes straight to
 *   main (no server change, so it bypasses the queue). Arms the ship-status watcher
 *   with 'main_building' + the pushed SHA, so the rail dot goes green only once the
 *   production build for that SHA is confirmed live. x-cron-secret gated like the
 *   others. Best-effort: a failure here costs only the dot, never the deploy.
 */
router.post("/claude-deploy/mark-shipped", async (req: Request, res: Response) => {
  if (!authed(req)) return res.status(403).json({ error: "Forbidden" });

  const threadId = uuid(req.body?.thread_id);
  if (!threadId) return res.status(400).json({ error: "thread_id (uuid) required" });
  const sha = text(req.body?.sha, 64);
  if (!sha) return res.status(400).json({ error: "sha required" });
  const orgId = await orgOfThread(threadId);
  if (!orgId) return res.status(404).json({ error: "thread not found" });

  const surface: ShipSurface = req.body?.surface === "railway" ? "railway" : "vercel";
  await markThreadShipped(threadId, {
    state: "main_building",
    sha,
    surface,
    branch: text(req.body?.branch, 300),
  });
  return res.json({ ok: true, state: "main_building" });
});

export default router;
