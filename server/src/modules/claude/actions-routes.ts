/**
 * Routes for the autonomy gate (docs/claude-console/autonomy-safety-gate.md).
 *
 * Two surfaces, deliberately separated by trust level:
 *
 *  ADMIN (default export) — mounted under the module's super-admin chain in
 *  index.ts. This is the human's screen:
 *    GET  /claude/approvals              list this org's approvals
 *    POST /claude/approvals/:id/approve  approve → enqueues the apply run
 *    POST /claude/approvals/:id/reject   reject → nothing runs
 *
 *  MACHINE (named export `claudeActionM2MRouter`) — mounted in server/src/index.ts
 *  OUTSIDE the super-admin chain, gated only by the shared internal secret, exactly
 *  like /claude-session/proposal. This is how the in-app Claude (a CLI child with no
 *  JWT) asks for a destructive migration to be gated:
 *    POST /claude-action/request-approval
 *  The org is taken from the body (the runner injects the run's org id), never from a
 *  session — there is no session on this surface.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requestMigrationApproval, listApprovals, decideApproval } from "./actions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Admin surface ───────────────────────────────────────────────────────────────

const admin = Router();

admin.get("/claude/approvals", async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const approvals = await listApprovals(req.org!.id, { status });
    return res.json({ approvals });
  } catch (e) {
    console.error("[claude/approvals] list failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not list approvals" });
  }
});

async function decide(req: Request, res: Response, decision: "approve" | "reject") {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "approval not found" });
  try {
    const result = await decideApproval(req.org!.id, req.params.id, req.user!.id, decision);
    if (!result.ok) {
      // not_found → 404; already-decided → 409; everything else → 500. The status
      // string carries the terminal state so the screen can show it precisely.
      const code = result.status === "not_found" ? 404 : result.status === "error" ? 500 : 409;
      return res.status(code).json({ error: result.error ?? "could not decide", status: result.status });
    }
    return res.json(result);
  } catch (e) {
    console.error("[claude/approvals] decide failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not decide approval" });
  }
}

admin.post("/claude/approvals/:id/approve", (req, res) => decide(req, res, "approve"));
admin.post("/claude/approvals/:id/reject", (req, res) => decide(req, res, "reject"));

// ── Machine-to-machine surface ───────────────────────────────────────────────────

const m2m = Router();

/** Same shared-secret check as /claude-session/proposal. Hard-fails when no secret is
 *  configured, so an unset secret can never leave the route open. */
function checkSecret(req: Request, res: Response): boolean {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

m2m.post("/claude-action/request-approval", async (req: Request, res: Response) => {
  if (!checkSecret(req, res)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const orgId = typeof body.org_id === "string" ? body.org_id : "";
  if (!UUID_RE.test(orgId)) return res.status(400).json({ error: "valid org_id is required" });

  const sql = typeof body.sql === "string" ? body.sql : "";
  if (!sql.trim()) return res.status(400).json({ error: "sql is required" });

  try {
    const result = await requestMigrationApproval({
      orgId,
      sql,
      migrationPath: typeof body.migration_path === "string" ? body.migration_path : null,
      repo: typeof body.repo === "string" ? body.repo : null,
      gitBranch: typeof body.git_branch === "string" ? body.git_branch : null,
      affectedCount: typeof body.affected_count === "number" ? body.affected_count : null,
      sampleRows: Array.isArray(body.sample_rows) ? body.sample_rows : null,
      threadId: typeof body.thread_id === "string" ? body.thread_id : null,
      runId: typeof body.run_id === "string" ? body.run_id : null,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[claude-action] request-approval failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not process approval request" });
  }
});

export default admin;
export { m2m as claudeActionM2MRouter };
