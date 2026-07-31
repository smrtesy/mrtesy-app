/**
 * Auto-diagnosis for a triaged code/ui correction.
 *
 * When triage classifies a correction as `code`/`ui`, this spawns a console run
 * (server/src/modules/claude, on the subscription — zero paid API tokens) that
 * investigates the repo and reports, in plain Hebrew, the problem it found and
 * the fix it proposes. The run is READ-ONLY: it must not change code or push —
 * it only POSTs its structured verdict back to
 * `POST /api/corrections/:id/diagnosis` (internal-secret gated). The result lands
 * on `context.diagnosis` and drives the correction card's two buttons.
 *
 * Because the run only reads and reports, it needs no human gate. The human gate
 * is the "אישור לתיקון" button on the card, which spawns the FIX run
 * (`execute.ts`, which implements THIS diagnosis and pushes to main).
 *
 * Failure is surfaced, never silent: if the run errors or never POSTs within the
 * timeout, `jobs.ts` flips `context.diagnosis.status` to `failed` and the card
 * shows "האבחון לא הצליח לרוץ" — so no correction disappears quietly.
 *
 * COST: subscription token only (runner strips the API key), like triage/autofix.
 * Master kill-switch: `correctionsAutoEnabled()` (default ON) — off returns to the
 * classify-only + "המשך דיון" behaviour and spawns nothing.
 */

import { db } from "../../../db";
import { executeRun, AUTOMATION_ACCOUNT } from "../../claude/runner";
import { maybeTitle } from "../../claude/threads";
import { composePrompt } from "../../claude/playbooks";
import { AUTOFIX_REPO, correctionsAutoEnabled } from "./execute";

/** How long a diagnosis may stay `running` before jobs.ts calls it `failed`. */
export const DIAGNOSIS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (user decision)

export interface DiagnoseContext {
  note: string;
  understood_he?: string | null;
  reason_he?: string | null;
  serial?: string | null;
  task_title?: string | null;
  msg_subject?: string | null;
  msg_sender?: string | null;
}

/** The read-only diagnosis prompt. Investigate, report, POST back — never edit
 *  or push. The correction id is baked into the callback URL. */
function buildDiagnoseMessage(correctionId: string, cls: "code" | "ui", ctx: DiagnoseContext): string {
  const kind = cls === "ui" ? "בקשת ממשק (איך משהו נראה/מתנהג על המסך)" : "באג בקוד (לוגיקה/צינור)";
  return [
    "משימת **אבחון בלבד** ממנגנון מיון-התיקונים של smrtesy. אתה חוקר ומדווח — **אינך משנה קוד ואינך דוחף כלום.**",
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
    "1. שכפל/קרא את הריפו וחקור את מקור הבעיה בקוד. **אל תשנה שום קובץ ואל תדחוף כלום** — זו ריצת אבחון בלבד.",
    "2. נסח שני דברים בעברית פשוטה (לאדם שלא קורא קוד — תאר התנהגות, לא diff):",
    "   - **problem_he** — הבעיה כפי שהבנת אותה, משפט-שניים.",
    "   - **fix_he** — הפתרון שאתה מציע: מה ישתנה, באיזה קובץ, ולמה. ספציפי אך קצר.",
    "3. הערך **risk** (`low`/`med`/`high`) ורשום את **files** (הקבצים שהתיקון ייגע בהם).",
    "4. **פרסם את האבחון בחזרה** (זה הפלט היחיד — לא הודעת צ'אט):",
    "   ```",
    `   curl -sS -X POST "$SMRTESY_BACKEND_URL/api/corrections/jobs/diagnosis/${correctionId}" \\`,
    '     -H "content-type: application/json" -H "x-cron-secret: $SMRTBOT_INTERNAL_SECRET" \\',
    "     -d '{\"run_id\":\"'\"$CLAUDE_RUN_ID\"'\",\"problem_he\":\"<...>\",\"fix_he\":\"<...>\",\"risk\":\"<low|med|high>\",\"files\":[\"<path>\"]}'",
    "   ```",
    "5. אם ה-POST הצליח (`\"ok\":true`) — סיימת. אם נכשל, נסה שוב פעם אחת; אם עדיין נכשל, דווח בתשובתך את ה-JSON המדויק שניסית לפרסם, כדי שלא ילך לאיבוד.",
    "6. אם אינך מצליח לאתר את הבעיה או שהיא רחבה/עמומה מכדי לאבחן — פרסם בכל זאת עם `problem_he` שמסביר מה לא ברור ו-`fix_he:\"\"`, כדי שההתראה תראה שנחקר ולא נמצא פתרון חד.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Spawn the auto-diagnosis run for a triaged code/ui correction. Marks
 * `context.diagnosis.status='running'` (with the run/thread ids so the failure
 * sweep can find a stuck run) and fires the console run. Returns the run id, or
 * null if the feature is off or the run could not be created. Never throws — a
 * failure here must not break triage.
 */
export async function createDiagnosisRun(
  correctionId: string,
  cls: "code" | "ui",
  orgId: string,
  userId: string,
  ctx: DiagnoseContext,
): Promise<string | null> {
  if (!correctionsAutoEnabled()) return null;
  try {
    const title = `אבחון ${ctx.serial ?? ""}`.trim().slice(0, 60) || "אבחון תיקון";

    const { data: thread, error: tErr } = await db
      .from("claude_threads")
      .insert({
        org_id: orgId,
        created_by: userId,
        title,
        title_source: "auto",
        repo: AUTOFIX_REPO,
        git_branch: null, // clone the default branch; a diagnosis never branches
      })
      .select("id")
      .single();
    if (tErr || !thread) {
      console.error("[corrections.diagnose] thread insert failed:", tErr?.message);
      return null;
    }

    const message = buildDiagnoseMessage(correctionId, cls, ctx);
    const composed = await composePrompt(orgId, message, null);

    const { data: run, error: rErr } = await db
      .from("claude_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        thread_id: thread.id,
        turn_index: 1,
        title: `diagnosis ${ctx.serial ?? correctionId}`.slice(0, 80),
        prompt: composed.prompt,
        user_prompt: message,
        repo: AUTOFIX_REPO,
        // Automated read-only run — second subscription account, like triage.
        claude_account: AUTOMATION_ACCOUNT,
        status: "queued",
      })
      .select("id")
      .single();
    if (rErr || !run) {
      console.error("[corrections.diagnose] run insert failed:", rErr?.message);
      return null;
    }

    // Mark the correction as diagnosing BEFORE the run starts, so the card can
    // show "מאבחן…" and the failure sweep has a row + started_at to time out.
    await markDiagnosisRunning(correctionId, run.id, thread.id);

    void executeRun(run.id)
      .then(() => maybeTitle(thread.id, orgId))
      .catch((e) =>
        console.error("[corrections.diagnose] executeRun threw:", e instanceof Error ? e.message : e),
      );

    return run.id;
  } catch (e) {
    console.error("[corrections.diagnose] threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Set `context.diagnosis` to the running state (merge-preserving). */
async function markDiagnosisRunning(correctionId: string, runId: string, threadId: string): Promise<void> {
  const { data: row } = await db
    .from("task_corrections")
    .select("context")
    .eq("id", correctionId)
    .maybeSingle();
  const prev = ((row?.context ?? {}) as Record<string, unknown>) || {};
  const context = {
    ...prev,
    diagnosis: {
      status: "running",
      run_id: runId,
      thread_id: threadId,
      started_at: new Date().toISOString(),
    },
  };
  const { error } = await db
    .from("task_corrections")
    .update({ context, updated_at: new Date().toISOString() })
    .eq("id", correctionId);
  if (error) console.error("[corrections.diagnose] mark-running failed:", error.message);
}
