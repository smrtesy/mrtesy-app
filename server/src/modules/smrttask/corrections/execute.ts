/**
 * Execution bridge (plan slice 4) — turn an APPROVED code/ui correction into a
 * real fix.
 *
 * When the user approves a correction classified `code` or `ui`, this opens a
 * Claude thread (server/src/modules/claude) whose first turn instructs the
 * engine to FIRST present, in plain Hebrew, the problem as it understands it and
 * the fix it proposes, then STOP for the user's approval. Only after the user
 * approves that plan does it implement the fix, run the repo's pre-push protocol,
 * and — if that passes clean — merge to `main` with --no-ff and push directly,
 * per the repo's push & merge rules (CLAUDE.md). The human gate is the up-front
 * approval of the plan, not a review of the finished PR (a PR is only the
 * fallback when the session lacks push access to `main`).
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
import { executeRun, AUTOMATION_ACCOUNT } from "../../claude/runner";
import { maybeTitle } from "../../claude/threads";
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
    "1. אתר את מקור הבעיה בקוד והבן את התיקון המינימלי הנדרש. **בשלב הזה אל תשנה עדיין כלום.**",
    "2. **קודם הצג למשתמש** (בעברית פשוטה): את **הבעיה כפי שאתה מבין אותה**, ואת **הפתרון שאתה מציע** — מה תשנה, באיזה קובץ, ולמה. תאר התנהגות, לא diff.",
    "3. **עצור וחכה לאישור המפורש של המשתמש.** אל תיגע בקוד ואל תדחוף כלום לפני שאישר. אם התיקון מסוכן/רחב מדי או שאינך מבין מה לתקן — אמור זאת כאן, ואל תמשיך.",
    `4. **רק אחרי שהמשתמש אישר** — עבוד על ענף (למשל ${branchHint}), ישם את התיקון המינימלי, והרץ את פרוטוקול קדם-הדחיפה של הריפו לפי CLAUDE.md (build + greps + סקירה עצמית) עד שהוא עובר נקי.`,
    "5. **רק אם ה-pre-push עבר נקי** — מזג את הענף ל-main עם `--no-ff` ודחוף ל-main ישירות לפי כללי הדחיפה ומיזוג ב-CLAUDE.md, ואז דחוף גם את הענף. אם ה-build/הסקירה נכשלו — עצור, אל תדחוף כלום, ודווח מה נכשל. אם אין הרשאת דחיפה ל-main — fallback: דחוף את הענף ופתח PR.",
    "6. אחרי הדחיפה ל-main אמת שהפרודקשן התקדם (`/api/deploy-info`), ודווח בעברית פשוטה מה עלה לאוויר.",
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
    // Concise initial title, no "אוטומטי" — the user initiated this by tapping,
    // it is not an automatic run. maybeTitle below replaces it with a title drawn
    // from the actual conversation once the run has content.
    const title = ([fixCtx.serial, fixCtx.note].filter(Boolean).join(" · ") || "תיקון").slice(0, 60);

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
        // Automated classification fix — runs on the second subscription account so
        // it stays off the primary account's usage window (falls back to primary
        // when that account isn't configured).
        claude_account: AUTOMATION_ACCOUNT,
        status: "queued",
      })
      .select("id")
      .single();
    if (rErr || !run) {
      console.error("[corrections.execute] run insert failed:", rErr?.message);
      return thread.id; // the thread exists; the user can send the message by hand
    }

    void executeRun(run.id)
      // Re-title from the conversation once it has content, exactly like a
      // normal thread — so the header reads as a concise summary, not the note.
      .then(() => maybeTitle(thread.id, orgId))
      .catch((e) =>
        console.error("[corrections.execute] executeRun threw:", e instanceof Error ? e.message : e),
      );

    return thread.id;
  } catch (e) {
    console.error("[corrections.execute] threw:", e instanceof Error ? e.message : e);
    return null;
  }
}
