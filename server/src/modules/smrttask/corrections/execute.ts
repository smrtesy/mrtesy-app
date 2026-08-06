/**
 * Execution bridge (plan slice 4) — turn an APPROVED code/ui correction into a
 * real fix.
 *
 * When the user taps "אישור לתיקון" on a correction (classified `code`/`ui`)
 * whose auto-diagnosis is ready, this opens a Claude thread (server/.../claude)
 * whose turn implements the ALREADY-APPROVED diagnosis (corrections/diagnose.ts),
 * runs the repo's pre-push protocol, and — if it passes clean — merges to `main`
 * with --no-ff and pushes directly, per the repo's push & merge rules (CLAUDE.md).
 * There is no in-run approval step: the human gate is the button (the user
 * approved the diagnosis the run is handed), so nothing reaches production without
 * a click — but once clicked it runs straight through. A PR is only the fallback
 * when the session lacks push access to `main`. The other button, "המשך דיון",
 * opens an interactive thread that does NOT auto-push (see routes claude-thread).
 *
 * COST: the thread runs on the subscription token (runner.ts strips the API
 * key), like every other Claude run here — no paid API.
 *
 * KILL-SWITCH, DEFAULT ON. Nothing here reaches production without a human
 * click: the auto-diagnosis (diagnose.ts) only reads and reports, and this fix
 * run only spawns when the user taps "אישור לתיקון". So the env var is no longer
 * a safety gate — it is a plain emergency kill-switch. `SMRTTASK_CORRECTIONS_AUTOFIX`
 * defaults ON; set it to "0" to disable the whole automatic mechanism (no
 * diagnosis, no fix), which returns corrections to classify-only + "המשך דיון".
 */

import { db } from "../../../db";
import { executeRun, AUTOMATION_ACCOUNT } from "../../claude/runner";
import { maybeTitle } from "../../claude/threads";
import { composePrompt } from "../../claude/playbooks";

/** The repo autofix works against. Overridable, defaults to the app repo. */
export const AUTOFIX_REPO = process.env.SMRTTASK_AUTOFIX_REPO || "smrtesy/mrtesy-app";

/** Emergency kill-switch for the whole automatic corrections mechanism
 *  (auto-diagnosis + one-tap fix). Default ON — the human gate is the
 *  "אישור לתיקון" click, not this flag. Set `SMRTTASK_CORRECTIONS_AUTOFIX=0` to
 *  disable everything and fall back to classify-only + "המשך דיון". */
export function correctionsAutoEnabled(): boolean {
  return process.env.SMRTTASK_CORRECTIONS_AUTOFIX !== "0";
}

interface FixContext {
  note: string;
  understood_he?: string | null;
  reason_he?: string | null;
  serial?: string | null;
  task_title?: string | null;
  msg_subject?: string | null;
  msg_sender?: string | null;
  // The approved diagnosis (from the auto-diagnosis run, corrections/diagnose.ts).
  // Injected so the fix run implements the plan the user already approved instead
  // of re-investigating from scratch. Null when no diagnosis is available.
  diagnosis_problem_he?: string | null;
  diagnosis_fix_he?: string | null;
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
    // The user approved THIS diagnosis by tapping "אישור לתיקון" — implement it,
    // don't re-diagnose. The approval already happened at the button.
    ctx.diagnosis_problem_he || ctx.diagnosis_fix_he
      ? `\n## האבחון שאושר (יישם אותו — אל תחקור מחדש מאפס)\n` +
        (ctx.diagnosis_problem_he ? `הבעיה: ${ctx.diagnosis_problem_he}\n` : "") +
        (ctx.diagnosis_fix_he ? `הפתרון שאושר: ${ctx.diagnosis_fix_he}` : "")
      : "",
    "",
    "## מה לעשות — בדיוק",
    "המשתמש כבר אישר את התיקון (לחץ \"אישור לתיקון\"). אין צורך לעצור לאישור נוסף — ישם, בדוק, ודחוף.",
    "1. ישם את התיקון המינימלי לפי האבחון שאושר. אל תשנה יותר מהנדרש.",
    "2. הרץ את פרוטוקול קדם-הדחיפה של הריפו לפי CLAUDE.md (build + greps + סקירה עצמית) עד שהוא עובר נקי.",
    `3. **רק אם ה-pre-push עבר נקי** — עבוד על ענף (למשל ${branchHint}), מזג ל-main עם \`--no-ff\` ודחוף ל-main ישירות לפי כללי הדחיפה ומיזוג ב-CLAUDE.md, ואז דחוף גם את הענף. אם ה-build/הסקירה נכשלו — עצור, אל תדחוף כלום, ודווח בדיוק מה נכשל.`,
    "4. אם אין לך הרשאת דחיפה ל-main — fallback: דחוף את הענף ופתח PR, ודווח את שמו המדויק.",
    "5. אחרי הדחיפה ל-main אמת שהפרודקשן התקדם (`/api/deploy-info`), ודווח בעברית פשוטה מה עלה לאוויר — התנהגות, לא diff.",
    "6. אם תוך כדי התיקון מתברר שהוא מסוכן/רחב הרבה מעבר לאבחון — עצור, אל תדחוף כלום, והסבר מה השתנה בהערכה.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The "המשך דיון" prompt: an interactive thread that presents the problem and the
 *  proposed fix, then ASKS how to proceed — and touches no code and pushes nothing
 *  until the user explicitly directs it. Deliberately NOT buildFixMessage. */
function buildDiscussMessage(cls: "code" | "ui", ctx: FixContext): string {
  const kind = cls === "ui" ? "בקשת ממשק (איך משהו נראה/מתנהג על המסך)" : "באג בקוד (לוגיקה/צינור)";
  return [
    "שיחת ליווי על תיקון ממנגנון מיון-התיקונים של smrtesy. המשתמש בחר **להמשיך בדיון** — הוא לא אישר תיקון אוטומטי.",
    `סיווג: ${kind}.`,
    "",
    "## מה המשתמש רצה",
    ctx.understood_he || ctx.note,
    "",
    "## ההערה המקורית של המשתמש (מילה במילה)",
    ctx.note,
    ctx.reason_he ? `\n## מה המיון מצא\n${ctx.reason_he}` : "",
    ctx.diagnosis_problem_he || ctx.diagnosis_fix_he
      ? `\n## האבחון שכבר נעשה\n` +
        (ctx.diagnosis_problem_he ? `הבעיה: ${ctx.diagnosis_problem_he}\n` : "") +
        (ctx.diagnosis_fix_he ? `הפתרון שהוצע: ${ctx.diagnosis_fix_he}` : "")
      : "",
    // WHICH task/message this is about — without this block the thread's TITLE
    // carried the serial but the message body never did, so Claude opened the
    // discussion not knowing which task it concerned. Mirrors buildFixMessage.
    "",
    "## הקשר",
    `משימה: ${ctx.serial ?? "—"} — ${ctx.task_title ?? "—"}`,
    ctx.msg_subject ? `הודעת מקור: ${ctx.msg_sender ?? "—"} · ${ctx.msg_subject}` : "",
    "",
    "## מה לעשות",
    "1. הצג בקצרה, בעברית פשוטה, את הבעיה כפי שאתה מבין אותה ואת מה שהיית מציע לתקן (אם יש אבחון למעלה — הישען עליו).",
    "2. **שאל את המשתמש איך הוא רוצה להמשיך. אל תשנה שום קובץ ואל תדחוף כלום עד שהוא יורה לך במפורש מה לעשות.**",
    "3. כשהמשתמש יורה מה לעשות — פעל לפי בקשתו. אם וכאשר תגיעו לדחיפה, בצע אותה לפי כללי הדחיפה ומיזוג ב-CLAUDE.md (pre-push נקי → main).",
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
  opts: { force?: boolean; mode?: "fix" | "discuss" } = {},
): Promise<string | null> {
  // The auto-on-approval path is gated by the flag; a user who explicitly taps
  // "המשך דיון" is initiating it themselves (like opening Claude on a task), so
  // `force` bypasses the flag for that human-driven case only.
  if (!opts.force && !correctionsAutoEnabled()) return null;
  // "discuss" mode = the user tapped "המשך דיון": an interactive thread that asks
  // how to proceed and does NOT auto-push. "fix" mode (default) = "אישור לתיקון":
  // implement the approved diagnosis and push to main. The two must never share a
  // prompt — that is how "discuss" silently became a production-push path before.
  const mode: "fix" | "discuss" = opts.mode ?? "fix";
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
        // The task this fix thread belongs to — the rail leads the title with it
        // and the auto-titler preserves it instead of writing "תיקון אוטומטי".
        task_serial: fixCtx.serial ?? null,
        repo: AUTOFIX_REPO,
        git_branch: null, // clone the default branch; the run creates its own fix branch
      })
      .select("id")
      .single();
    if (tErr || !thread) {
      console.error("[corrections.execute] thread insert failed:", tErr?.message);
      return null;
    }

    const message = mode === "discuss" ? buildDiscussMessage(cls, fixCtx) : buildFixMessage(cls, fixCtx);
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
        // Automated classification fix — the background `automation` account, so it
        // stays off the primary account's usage window. executeRun lets that account
        // BORROW a healthy account's token when it is over its weekly limit (see
        // effectiveAccount there), so the run still lands during an automation-account
        // outage while the row stays tagged "automation".
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
