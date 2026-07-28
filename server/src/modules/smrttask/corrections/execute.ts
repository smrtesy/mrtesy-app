/**
 * Execution bridge (plan slice 4) — turn an APPROVED code/ui correction into a
 * real fix.
 *
 * When the user approves a correction classified `code` or `ui`, this opens a
 * Claude thread (server/src/modules/claude) whose first turn instructs the
 * engine to implement the fix, run the repo's pre-push protocol, and open a PR —
 * NOT merge it. The user then reviews the plain-Hebrew PR body and the Vercel
 * preview and merges. Nothing reaches production without that human merge.
 *
 * COST: the thread runs on the subscription token (runner.ts strips the API
 * key), like every other Claude run here — no paid API.
 *
 * DARK BY DEFAULT. Auto-spawning a coding agent from a user tap is powerful, and
 * it cannot be validated end-to-end from a sandbox (no live clone+implement+PR).
 * So it is gated behind SMRTTASK_CORRECTIONS_AUTOFIX=1. Off (the default),
 * approving a code/ui correction changes nothing in production — it is simply
 * acknowledged, exactly as before. Turn it on only after a controlled live test.
 */

import { db } from "../../../db";
import { executeRun } from "../../claude/runner";
import { composePrompt } from "../../claude/playbooks";

/** The repo autofix works against. Overridable, defaults to the app repo. */
const AUTOFIX_REPO = process.env.SMRTTASK_AUTOFIX_REPO || "smrtesy/mrtesy-app";

/** Master switch. Off unless explicitly enabled, so the merged code is inert in
 *  production until a human has validated one live run. */
export function autofixEnabled(): boolean {
  return process.env.SMRTTASK_CORRECTIONS_AUTOFIX === "1";
}

interface FixContext {
  note: string;
  understood_he?: string | null;
  reason_he?: string | null;
  serial?: string | null;
  task_title?: string | null;
  msg_subject?: string | null;
  msg_sender?: string | null;
}

function buildFixMessage(cls: "code" | "ui", ctx: FixContext): string {
  const branchHint = `claude/autofix-${(ctx.serial || "correction").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  const kind = cls === "ui" ? "בקשת ממשק (איך משהו נראה/מתנהג על המסך)" : "באג בקוד (לוגיקה/צינור)";
  return [
    "משימת תיקון אוטומטית ממנגנון מיון-התיקונים של smrtesy.",
    `סיווג: ${kind}.`,
    "",
    "## מה המשתמש רצה",
    ctx.understood_he || ctx.note,
    "",
    "## ההערה המקורית של המשתמש (מילה במילה)",
    ctx.note,
    ctx.reason_he ? `\n## מה המיון מצא\n${ctx.reason_he}` : "",
    "",
    "## הקשר",
    `משימה: ${ctx.serial ?? "—"} — ${ctx.task_title ?? "—"}`,
    ctx.msg_subject ? `הודעת מקור: ${ctx.msg_sender ?? "—"} · ${ctx.msg_subject}` : "",
    "",
    "## מה לעשות — בדיוק",
    "1. אתר את מקור הבעיה בקוד וישם את התיקון המינימלי. אל תשנה יותר מהנדרש.",
    "2. הרץ את פרוטוקול קדם-הדחיפה של הריפו לפי CLAUDE.md (build + greps + סקירה עצמית). אל תדחוף אם ה-build נכשל.",
    `3. צור ענף חדש (למשל ${branchHint}), דחוף אותו, ופתח PR. **אל תמזג ל-main ואל תדחוף ל-main ישירות** — המשתמש בודק תצוגה מקדימה וממזג בעצמו.`,
    "4. בגוף ה-PR כתוב בעברית פשוטה מה השתנה ולמה — המשתמש לא קורא קוד, אז תאר את ההתנהגות, לא את ה-diff.",
    "5. אם אינך מצליח לפתוח PR, דחוף את הענף ודווח את שמו המדויק בתשובתך.",
    "6. אם אינך מבין מה לתקן או שהתיקון מסוכן/רחב מדי — עצור, אל תדחוף כלום, והסבר מה חסר.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Open a fix thread for an approved code/ui correction. Returns the thread id,
 * or null if autofix is disabled or the thread could not be created. Never
 * throws — a failure here must not fail the user's approval.
 */
export async function createFixThread(
  correctionId: string,
  cls: "code" | "ui",
  orgId: string,
  userId: string,
  fixCtx: FixContext,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  // The auto-on-approval path is gated by the flag; a user who explicitly taps
  // "continue with Claude" is initiating it themselves (like opening Claude on a
  // task), so `force` bypasses the flag for that human-driven case only.
  if (!opts.force && !autofixEnabled()) return null;
  try {
    const title = `תיקון אוטומטי: ${fixCtx.serial ?? ""} ${fixCtx.note}`.trim().slice(0, 120);

    const { data: thread, error: tErr } = await db
      .from("claude_threads")
      .insert({
        org_id: orgId,
        created_by: userId,
        title,
        title_source: "auto",
        repo: AUTOFIX_REPO,
        git_branch: null, // clone the default branch; the run creates its own fix branch
      })
      .select("id")
      .single();
    if (tErr || !thread) {
      console.error("[corrections.execute] thread insert failed:", tErr?.message);
      return null;
    }

    const message = buildFixMessage(cls, fixCtx);
    const composed = await composePrompt(orgId, message, null);

    const { data: run, error: rErr } = await db
      .from("claude_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        thread_id: thread.id,
        turn_index: 1,
        title: `autofix ${fixCtx.serial ?? correctionId}`.slice(0, 80),
        prompt: composed.prompt,
        user_prompt: message,
        repo: AUTOFIX_REPO,
        status: "queued",
      })
      .select("id")
      .single();
    if (rErr || !run) {
      console.error("[corrections.execute] run insert failed:", rErr?.message);
      return thread.id; // the thread exists; the user can send the message by hand
    }

    void executeRun(run.id).catch((e) =>
      console.error("[corrections.execute] executeRun threw:", e instanceof Error ? e.message : e),
    );

    return thread.id;
  } catch (e) {
    console.error("[corrections.execute] threw:", e instanceof Error ? e.message : e);
    return null;
  }
}
