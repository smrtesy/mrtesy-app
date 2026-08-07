/**
 * The autonomy gate's server side — the ONE red line that is not autonomous.
 *
 * Design & rationale: docs/claude-console/autonomy-safety-gate.md. In one line:
 * reversible actions (merge to main, additive migrations) the in-app Claude does
 * itself, with full shell, in its cloned checkout; the only thing routed through a
 * human is a DESTRUCTIVE migration against production, because a revert brings back
 * code, not deleted rows.
 *
 * This module holds that gate:
 *   requestMigrationApproval — the in-app Claude calls this (machine-to-machine)
 *     before it would apply a migration. The SQL is classified HERE, in code, from
 *     the SQL itself — never trusting the run's own claim that "it just adds a
 *     column" (CLAUDE.md: a model may propose; only code may confirm). Additive →
 *     the caller is told to go ahead and apply. Destructive → a pending approval row
 *     is recorded and the caller must stop and wait for a human.
 *   listApprovals / decideApproval — the screen. Approving a destructive migration
 *     enqueues a fresh run that applies it (the run carries the checkout with the
 *     migration file plus the injected Supabase access token, so the apply is its own run).
 *
 * How the apply actually runs: the run POSTs the ONE approved migration file's SQL to
 * the Supabase Management API query endpoint (`/v1/projects/{ref}/database/query`) with
 * the access token injected in runner.ts — the same endpoint the platform already uses
 * to run migrations (the Supabase MCP). It is deliberately NOT `supabase db push`: this
 * repo's local migration filenames are disjoint from the remote `schema_migrations`
 * history, so a push would fail or mass-re-run hundreds of historical (often
 * destructive) migrations. The access token is the plumbing that previously was missing
 * — a run could write a migration file but had nothing to apply it with.
 */

import { db } from "../../db";
import { executeRun } from "./runner";
import { classifyMigrationSql, type SqlClassification } from "./sqlClassify";

const MAX_SQL = 100_000;
const MAX_TITLE = 300;
/** Sample rows shown in the "what will be affected" preview — a taste, not the table. */
const MAX_SAMPLE_ROWS = 100;

export interface RequestApprovalInput {
  orgId: string;
  /** The migration's full SQL — classified here, and shown verbatim to the human. */
  sql: string;
  /** Where the migration file lives in the repo, so the apply run knows what to push. */
  migrationPath?: string | null;
  /** The repo the migration belongs to (owner/name) and the branch it was written on. */
  repo?: string | null;
  gitBranch?: string | null;
  /** Preview the caller gathered by running the equivalent SELECT in its checkout.
   *  Advisory context for the human — the classification, not this, is the gate. */
  affectedCount?: number | null;
  sampleRows?: unknown[] | null;
  /** Provenance — the conversation/turn that asked. */
  threadId?: string | null;
  runId?: string | null;
}

export type RequestApprovalResult =
  | { decision: "additive"; classification: SqlClassification }
  | { decision: "needs_approval"; approvalId: string; classification: SqlClassification };

function trim(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * The in-app Claude calls this before applying a migration. Returns whether it may
 * proceed autonomously (additive) or must wait for a human (destructive).
 *
 * Fail-closed everywhere: an empty/oversized SQL, or a classification that finds
 * nothing provably additive, is treated as needing approval rather than waved
 * through.
 */
export async function requestMigrationApproval(
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  const sql = trim(input.sql, MAX_SQL);
  const classification = classifyMigrationSql(sql);

  if (classification.additive) {
    // Reversible — the caller applies it itself. Nothing recorded here; an additive
    // migration is not an event the human needs to see.
    return { decision: "additive", classification };
  }

  // Destructive → record a pending card for a human. The title is a plain-Hebrew
  // consequence line built from what the classifier actually found, not from the
  // run's description of its own change.
  const reasonList = classification.reasons.length
    ? classification.reasons.join("; ")
    : "פעולה שלא אומתה כתוספתית";
  const countPart =
    typeof input.affectedCount === "number" && Number.isFinite(input.affectedCount)
      ? ` — ישפיע על ${input.affectedCount} שורות`
      : "";
  const title = trim(`מיגרציה הרסנית: ${reasonList}${countPart}`, MAX_TITLE);

  const sample = Array.isArray(input.sampleRows) ? input.sampleRows.slice(0, MAX_SAMPLE_ROWS) : [];

  // A card MUST carry its thread_id: it is what links the card back to the
  // conversation that raised it (the in-thread card + the panel pointer), and —
  // crucially — what lets the approved apply run inherit a stable working
  // directory (a repo run with no thread fails "must belong to a thread",
  // runner.ts). A run that forgot to pass thread_id but did pass run_id is not
  // lost: the run itself knows its thread, so derive it from claude_runs rather
  // than recording a null and breaking both.
  let threadId = input.threadId ?? null;
  if (!threadId && input.runId) {
    const { data: runRow, error: runErr } = await db
      .from("claude_runs")
      .select("thread_id")
      .eq("id", input.runId)
      .maybeSingle();
    if (runErr) {
      console.error("[claude/actions] thread_id derive from run failed:", runErr.message);
    } else if (runRow?.thread_id) {
      threadId = runRow.thread_id;
    }
  }

  const { data, error } = await db
    .from("claude_action_approvals")
    .insert({
      org_id: input.orgId,
      kind: "migration",
      status: "pending",
      title,
      payload: {
        sql,
        migration_path: input.migrationPath ?? null,
        repo: input.repo ?? null,
        git_branch: input.gitBranch ?? null,
        classification,
        affected_count: input.affectedCount ?? null,
        sample_rows: sample,
      },
      thread_id: threadId,
      run_id: input.runId ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`could not record approval: ${error?.message ?? "no row returned"}`);
  }

  return { decision: "needs_approval", approvalId: data.id, classification };
}

export async function listApprovals(orgId: string, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let q = db
    .from("claude_action_approvals")
    .select("id, kind, status, title, payload, thread_id, run_id, decided_by, decided_at, result, created_at, updated_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw new Error(`could not list approvals: ${error.message}`);
  return data ?? [];
}

export interface DecideResult {
  ok: boolean;
  status: string;
  /** When an approval is applied, the run enqueued to carry it out. */
  applyRunId?: string;
  error?: string;
}

/**
 * A human's decision on a pending approval.
 *
 * reject → recorded, nothing runs.
 * approve → enqueue a fresh run that applies the migration by POSTing the one approved
 *   file's SQL to the Supabase Management API query endpoint, and record its id on the
 *   approval so the screen can follow it.
 *
 * Guarded so only a PENDING row can be decided: a double-click, or two admins acting
 * at once, cannot enqueue the apply twice or overturn a decision already made. The
 * status transition itself is the lock — the update is conditioned on status='pending'
 * and reports honestly when it matched nothing.
 */
export async function decideApproval(
  orgId: string,
  approvalId: string,
  userId: string,
  decision: "approve" | "reject",
): Promise<DecideResult> {
  const { data: row, error: loadErr } = await db
    .from("claude_action_approvals")
    .select("id, status, payload, thread_id")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (loadErr) return { ok: false, status: "error", error: loadErr.message };
  if (!row) return { ok: false, status: "not_found", error: "approval not found" };
  if (row.status !== "pending") {
    // Already decided — report the terminal state rather than acting again.
    return { ok: false, status: row.status, error: "approval is no longer pending" };
  }

  if (decision === "reject") {
    const { error } = await db
      .from("claude_action_approvals")
      .update({
        status: "rejected",
        decided_by: userId,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", approvalId)
      .eq("status", "pending"); // lock: only from pending
    if (error) return { ok: false, status: "error", error: error.message };
    return { ok: true, status: "rejected" };
  }

  // approve → enqueue the apply run. The prompt names the exact migration file and
  // forbids re-deciding the destructiveness (the human already did): its only job is
  // to run the push and report. The internal APPLY marker keeps this prompt from
  // being mistaken for an ordinary chat turn.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const migrationPath = typeof payload.migration_path === "string" ? payload.migration_path : null;
  const repo = typeof payload.repo === "string" ? payload.repo : null;
  const gitBranch = typeof payload.git_branch === "string" ? payload.git_branch : null;

  if (!migrationPath || !repo) {
    // Can't safely apply without knowing which file in which repo. Fail the approval
    // loudly instead of enqueuing a run that has nothing to push.
    const { error } = await db
      .from("claude_action_approvals")
      .update({
        status: "failed",
        decided_by: userId,
        decided_at: new Date().toISOString(),
        result: { error: "approval is missing migration_path or repo — cannot apply" },
        updated_at: new Date().toISOString(),
      })
      .eq("id", approvalId)
      .eq("status", "pending");
    if (error) return { ok: false, status: "error", error: error.message };
    return { ok: false, status: "failed", error: "missing migration_path or repo" };
  }

  const applyPrompt =
    `[APPLY-APPROVED-MIGRATION]\n` +
    `אישור אנושי התקבל להחלת המיגרציה ההרסנית הבאה. הרץ אותה עכשיו — אל תסווג ` +
    `מחדש ואל תשאל שוב; האדם כבר אישר את ה-SQL עצמו.\n\n` +
    `1. ודא שאתה על הענף \`${gitBranch ?? "main"}\` ושהקובץ \`${migrationPath}\` קיים.\n` +
    `2. החל **רק את ה-SQL של הקובץ הזה** על הפרודקשן דרך ה-Management API ` +
    `(SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_ID כבר מוזרקים). השתמש ב-heredoc כדי ` +
    `להימנע מבריחת-תווים ידנית של ה-SQL:\n` +
    "   ```\n" +
    "   curl -sS -X POST \"https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/database/query\" \\\n" +
    "     -H \"Authorization: Bearer $SUPABASE_ACCESS_TOKEN\" -H \"content-type: application/json\" \\\n" +
    "     --data-binary @- <<'JSON'\n" +
    "   {\"query\": <ה-SQL המלא של הקובץ, כמחרוזת JSON חוקית>}\n" +
    "   JSON\n" +
    "   ```\n" +
    `   **אל תריץ \`supabase db push\`** — הוא היה מריץ מחדש מיגרציות ישנות. קובץ בודד בלבד.\n` +
    `3. אם ההחלה נכשלה — דווח את השגיאה המלאה ואל תנסה לתקן את ה-DB ידנית.\n` +
    `approval_id: ${approvalId}`;

  const { data: runRow, error: runErr } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: userId,
      title: `החלת מיגרציה מאושרת`,
      prompt: applyPrompt,
      user_prompt: applyPrompt,
      repo,
      git_branch: gitBranch,
      // A repo run needs a thread for its stable working directory (runner.ts:
      // "must belong to a thread"). Inherit the approval's thread so the apply
      // runs in the same checkout that wrote the migration file.
      thread_id: row.thread_id ?? null,
      status: "queued",
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return { ok: false, status: "error", error: runErr?.message ?? "could not enqueue apply run" };
  }

  const { error: updErr } = await db
    .from("claude_action_approvals")
    .update({
      status: "approved",
      decided_by: userId,
      decided_at: new Date().toISOString(),
      result: { apply_run_id: runRow.id },
      updated_at: new Date().toISOString(),
    })
    .eq("id", approvalId)
    .eq("status", "pending");
  if (updErr) {
    // The run row exists but we couldn't mark the approval — surface it rather than
    // leaving a silent inconsistency. The apply has NOT been fired yet.
    return { ok: false, status: "error", error: updErr.message };
  }

  // Fire the apply run, same fire-and-forget contract as the launch route.
  void executeRun(runRow.id).catch((e) =>
    console.error("[claude/actions] apply executeRun threw:", e instanceof Error ? e.message : e),
  );

  return { ok: true, status: "approved", applyRunId: runRow.id };
}
