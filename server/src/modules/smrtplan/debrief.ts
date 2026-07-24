/**
 * Mandatory completion debrief for research tasks (docs/project-planning-protocol
 * §5 "שלב ו — יומן ניסויים ופלייבוק").
 *
 * A task with tasks.requires_debrief = true CANNOT be marked complete until a
 * valid task_debriefs row exists. Enforcement is at the API layer — shared by
 * ALL three completion paths (PATCH /plan-tasks/:id/done, the generic PATCH
 * /plan-tasks/:id status-flip, and smrtTask POST /tasks/:id/complete) — so a
 * research task cannot be closed even via a direct API call (acceptance #1).
 *
 * The three fixed debrief questions (q_worked_best / q_trick / q_surprise) are
 * the canonical playbook questions and must stay identical to the protocol
 * document. The scoring/session evidence is required per where the experiment ran.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db";

export type ConductedIn = "claude" | "external" | "both" | "no_experiment";

export interface DebriefInput {
  conducted_in?: unknown;
  claude_scored_confirmed?: unknown;
  claude_session_link?: unknown;
  claude_scores?: unknown;
  external_tool?: unknown;
  external_steps?: unknown;
  external_results?: unknown;
  external_scores?: unknown;
  no_experiment_reason?: unknown;
  deliverable_path?: unknown;
  consumer_check_confirmed?: unknown;
  consumer_check_note?: unknown;
  q_worked_best?: unknown;
  q_trick?: unknown;
  q_surprise?: unknown;
}

interface NormalizedDebrief {
  conducted_in: ConductedIn;
  answers: Record<string, string | boolean>;
}

const CONDUCTED_IN = new Set<ConductedIn>(["claude", "external", "both", "no_experiment"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Validate + normalize a debrief payload. Pure (no I/O). Returns the normalized
 * debrief or a 422-worthy error message naming the missing field. The three fixed
 * questions are always required; the evidence fields are required per branch.
 */
export function validateDebrief(input: DebriefInput | null | undefined): { ok: true; value: NormalizedDebrief } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "debrief is required to complete a research task" };
  const conducted = str(input.conducted_in) as ConductedIn;
  if (!CONDUCTED_IN.has(conducted)) {
    return { ok: false, error: "debrief.conducted_in must be one of claude|external|both|no_experiment" };
  }

  const answers: Record<string, string | boolean> = { conducted_in: conducted };

  // Branch: ran in Claude (or both) → scoring confirmation + session evidence.
  if (conducted === "claude" || conducted === "both") {
    if (input.claude_scored_confirmed !== true) {
      return { ok: false, error: "debrief.claude_scored_confirmed must be confirmed (each result was scored by the rubric)" };
    }
    const link = str(input.claude_session_link);
    if (!link) return { ok: false, error: "debrief.claude_session_link is required" };
    const scores = str(input.claude_scores);
    if (!scores) return { ok: false, error: "debrief.claude_scores is required (paste the score table or a link)" };
    answers.claude_scored_confirmed = true;
    answers.claude_session_link = link;
    answers.claude_scores = scores;
  }

  // Branch: ran in an external tool (or both) → tool + steps + results + scores.
  if (conducted === "external" || conducted === "both") {
    const tool = str(input.external_tool);
    if (!tool) return { ok: false, error: "debrief.external_tool is required" };
    const steps = str(input.external_steps);
    if (!steps) return { ok: false, error: "debrief.external_steps is required (settings/prompts verbatim)" };
    const results = str(input.external_results);
    if (!results) return { ok: false, error: "debrief.external_results is required" };
    const scores = str(input.external_scores);
    if (!scores) return { ok: false, error: "debrief.external_scores is required (score each result by the rubric)" };
    answers.external_tool = tool;
    answers.external_steps = steps;
    answers.external_results = results;
    answers.external_scores = scores;
  }

  // Branch: no experiment ran → a reason is mandatory.
  if (conducted === "no_experiment") {
    const reason = str(input.no_experiment_reason);
    if (!reason) return { ok: false, error: "debrief.no_experiment_reason is required when no experiment was run" };
    answers.no_experiment_reason = reason;
  }

  // Deliverable contract + consumer check (protocol §16.20/§16.21) — always
  // required, in every branch: a research task is not "done" until its
  // deliverable sits at the exact contract path AND the consuming task/skill
  // was opened and verified to act on it without guessing. This is the
  // system-level layer of the enforcement (works even when the repo hooks
  // don't run). Root cause: a research task once "completed" with its report
  // never saved where the next task read from.
  const deliverable = str(input.deliverable_path);
  if (!deliverable) {
    return { ok: false, error: "debrief.deliverable_path is required (the exact contract path / link where the deliverable was saved)" };
  }
  if (input.consumer_check_confirmed !== true) {
    return { ok: false, error: "debrief.consumer_check_confirmed must be confirmed (the consuming task/skill was opened and acts on the deliverable without guessing)" };
  }
  const consumerNote = str(input.consumer_check_note);
  if (!consumerNote) {
    return { ok: false, error: "debrief.consumer_check_note is required (who the consumer is and what was verified)" };
  }
  answers.deliverable_path = deliverable;
  answers.consumer_check_confirmed = true;
  answers.consumer_check_note = consumerNote;

  // The three fixed playbook questions — always required.
  const workedBest = str(input.q_worked_best);
  if (!workedBest) return { ok: false, error: "debrief.q_worked_best is required" };
  const trick = str(input.q_trick);
  if (!trick) return { ok: false, error: "debrief.q_trick is required" };
  const surprise = str(input.q_surprise);
  if (!surprise) return { ok: false, error: "debrief.q_surprise is required" };
  answers.q_worked_best = workedBest;
  answers.q_trick = trick;
  answers.q_surprise = surprise;

  return { ok: true, value: { conducted_in: conducted, answers } };
}

/** A compact, human-readable summary of the debrief for the task timeline. */
function debriefSummary(d: NormalizedDebrief): string {
  const a = d.answers;
  const lines = [
    `תחקיר סגירה (${d.conducted_in})`,
    a.deliverable_path ? `תוצר בנתיב-החוזה: ${a.deliverable_path}` : "",
    a.consumer_check_note ? `בדיקת-צרכן: ${a.consumer_check_note}` : "",
    a.q_worked_best ? `מה עבד הכי טוב: ${a.q_worked_best}` : "",
    a.q_trick ? `הטריק/ההגדרה שעשו את ההבדל: ${a.q_trick}` : "",
    a.q_surprise ? `מה הפתיע לרעה: ${a.q_surprise}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface DebriefBlock {
  status: number;
  error: string;
}

/**
 * Enforce the debrief on a completion attempt. Called BEFORE the status write, so
 * the ordering guarantees "no completion without a saved debrief":
 *   - task not found / not requires_debrief → returns null (proceed normally).
 *   - a debrief already exists for the task → returns null (idempotent: a reopen
 *     then re-complete does not demand a second debrief).
 *   - requires_debrief and no debrief yet → validates body.debrief; invalid →
 *     returns { status: 422, error }; valid → inserts task_debriefs AND appends a
 *     visible `debrief` update to the task, then returns null so completion runs.
 *
 * Returns a DebriefBlock to reject with, or null to proceed.
 */
export async function enforceDebriefOnComplete(
  orgId: string,
  taskId: string,
  uid: string,
  body: Record<string, unknown> | undefined,
): Promise<DebriefBlock | null> {
  const { data: task, error } = await db
    .from("tasks")
    .select("id, requires_debrief, updates")
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .maybeSingle();
  // On a read error, don't block completion on a transient DB hiccup — but do log.
  if (error) {
    console.error("[smrtplan.debrief] task read failed:", error.message);
    return null;
  }
  if (!task || task.requires_debrief !== true) return null;

  // Idempotency: an existing valid debrief unlocks completion (reopen → re-close).
  const { data: existing } = await db
    .from("task_debriefs")
    .select("id")
    .eq("org_id", orgId)
    .eq("task_id", taskId)
    .limit(1);
  if (Array.isArray(existing) && existing.length > 0) return null;

  const rawDebrief = (body ?? {}).debrief as DebriefInput | undefined;
  const v = validateDebrief(rawDebrief);
  if (!v.ok) return { status: 422, error: v.error };

  const { error: insErr } = await db.from("task_debriefs").insert({
    org_id: orgId,
    task_id: taskId,
    user_id: uid,
    conducted_in: v.value.conducted_in,
    answers: v.value.answers,
  });
  if (insErr) {
    console.error("[smrtplan.debrief] insert failed:", insErr.message);
    return { status: 500, error: "failed to save debrief" };
  }

  // Also record the debrief as a visible task update (same shape as the manual
  // update / decision-propagation entries) so the manager sees it on the timeline
  // and it can later feed the playbook. Best-effort: the debrief is already saved,
  // so a timeline-append hiccup must not block completion.
  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    created_at: now,
    type: "debrief",
    actor: "user",
    actor_user_id: uid,
    content: debriefSummary(v.value),
  };
  const next = [...(((task.updates as unknown[]) ?? [])), entry];
  const { error: updErr } = await db
    .from("tasks")
    .update({ updates: next, has_unread_update: true, updated_at: now })
    .eq("organization_id", orgId)
    .eq("id", taskId);
  if (updErr) console.error("[smrtplan.debrief] timeline append failed:", updErr.message);

  return null;
}
