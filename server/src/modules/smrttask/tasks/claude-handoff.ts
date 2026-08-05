/**
 * Task → Claude handoff.
 *
 * When the user taps "עבודה עם קלוד" on a task, this opens a NEW thread in the
 * built-in Claude console (server/src/modules/claude) — NOT the external
 * claude.ai — seeded with the task's context, and runs its first turn. Claude
 * works the task and, when done, offers (via an on-screen smrt-ask block) to mark
 * it completed, closing the loop through the app API with the per-run user token
 * the runner injects (app-access.ts, keyed on created_by).
 *
 * Runs on the subscription (runner strips the paid API key) — ZERO paid API
 * tokens. Mirrors corrections/execute.ts `createFixThread`, minus the code/push
 * machinery: a task handoff is a general work chat, not an auto-push fix.
 *
 * It opens on the org's PRIMARY repo (same default as any new console chat) for a
 * concrete reason: `run.repo` is what flips the runner to `bypassPermissions`
 * (runner.ts ~1144). Without it a `-p` run gets the CLI's default permission mode,
 * where an un-answerable prompt silently DENIES all shell — so the loop-closing
 * `curl PATCH /api/tasks/:id` would never run. The repo also loads CLAUDE.md (the
 * org's standing instructions) automatically. When the org has no repo configured
 * (primaryRepoForOrg → null) the thread still opens, but shell is unavailable, so
 * Claude can work the task and report yet cannot self-close it.
 */

import { db } from "../../../db";
import { executeRun, AUTOMATION_ACCOUNT } from "../../claude/runner";
import { maybeTitle, primaryRepoForOrg } from "../../claude/threads";
import { composePrompt } from "../../claude/playbooks";

/**
 * The Claude account the user last worked on in the console, so a task chat opens
 * on the same one they were just using (their explicit account choice carries over
 * — the user's request, 2026-08-04). NULL (never switched) resolves to the primary
 * account in the runner. Automation threads (autofix/diagnosis) are excluded — they
 * carry the automation account and are not the user's own choice; a NULL account is
 * kept, since "never switched" IS a valid last-used state (default account).
 */
async function lastUsedAccount(orgId: string, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("claude_threads")
    .select("claude_account")
    .eq("org_id", orgId)
    .eq("created_by", userId)
    .or(`claude_account.is.null,claude_account.neq.${AUTOMATION_ACCOUNT}`)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[tasks.claude-handoff] lastUsedAccount lookup failed:", error.message);
    return null; // fall back to the default account — never fail the handoff
  }
  return (data?.claude_account as string | null) ?? null;
}

export interface TaskHandoffContext {
  id: string;
  serial: string | null;
  title: string;
  description: string | null;
  /** Verbatim deep links from the task (materials, Drive docs, source message). */
  urls: string[];
}

/** The seeded first-turn prompt. Guides Claude to understand the task, ask before
 *  any state-changing action, and — when done — offer to mark the task completed.
 *  URLs are emitted verbatim (CLAUDE.md "preserve deep links"). */
function buildHandoffMessage(ctx: TaskHandoffContext): string {
  const lines: string[] = [
    "משימה שהמשתמש העביר אליך לעבודה מתוך smrtTask (מסך המשימות).",
    "",
    "## המשימה",
    `${ctx.serial ? ctx.serial + ": " : ""}${ctx.title}`,
  ];
  if (ctx.description?.trim()) {
    lines.push("", "## פרטים", ctx.description.trim());
  }
  if (ctx.urls.length) {
    lines.push("", "## קישורים (מדויקים — אל תקצר לדומיין)", ...ctx.urls);
  }
  lines.push(
    "",
    "## איך לעבוד על המשימה",
    "1. הצג בעברית פשוטה, במשפט-שניים, מה אתה מבין שצריך לעשות במשימה.",
    "2. אם המשימה דורשת פעולה שמשנה משהו (שליחת מייל, כתיבה/מחיקה בנתונים, דחיפת קוד) — הצג תוכנית קצרה ושאל לפני ביצוע. פעולות קריאה/מחקר — בצע.",
    "3. עבוד על המשימה עד הסוף.",
    "",
    "## סגירת המשימה — חשוב",
    "כשתסיים לעבוד על המשימה, הצג בלוק בחירה אינטראקטיבי `smrt-ask` שבו השאלה \"לסמן את המשימה כהושלמה?\" ושתי אפשרויות: \"כן, סמן כהושלמה\" ו\"לא, השאר פתוחה\".",
    "אם המשתמש יבחר לסמן כהושלמה — סגור את המשימה דרך ה-API של הפלטפורמה (הכתובת והטוקן מוזרקים לך בסביבה). זהו מסלול הסגירה הרשמי — הוא מסמן completed_at ורושם את הפעולה:",
    "```",
    `curl -sS -X POST "$SMRTESY_API_URL/api/tasks/${ctx.id}/complete" \\`,
    `  -H "Authorization: Bearer $SMRTESY_API_TOKEN" -H "X-Org-Id: $SMRTESY_ORG_ID" \\`,
    `  -H "content-type: application/json"`,
    "```",
    "ודא שהתשובה תקינה (לא שגיאה — אם חזרה שגיאה שהמשימה דורשת תחקיר/debrief, אמור זאת למשתמש ואל תכריח סגירה). כשהצליח, אשר למשתמש בעברית שהמשימה סומנה כהושלמה. אם המשתמש בחר להשאיר פתוחה — אל תיגע בסטטוס.",
    "אם אינך יכול להריץ את ה-curl (למשל ה-shell אינו זמין בשיחה זו) — אל תתעקש; אמור למשתמש שלא הצלחת לסמן אוטומטית ושיסמן ידנית בכפתור \"הושלם\" על המשימה.",
  );
  return lines.join("\n");
}

/**
 * Open a Claude console thread for a task and run its first turn. Returns the
 * thread id, or null if the thread could not be created. Never throws — a failure
 * here must not fail the user's tap.
 */
export async function createTaskThread(
  orgId: string,
  userId: string,
  ctx: TaskHandoffContext,
): Promise<string | null> {
  try {
    // Concise initial title; maybeTitle rewrites it from the conversation once the
    // run has content (mirrors createFixThread).
    const title = ([ctx.serial, ctx.title].filter(Boolean).join(" · ") || "משימה").slice(0, 60);

    // Same default as a new console chat — and required for shell/curl (see header).
    const repo = await primaryRepoForOrg(orgId);
    // Open on whichever account the user was last using (their request, 2026-08-04).
    const account = await lastUsedAccount(orgId, userId);

    const { data: thread, error: tErr } = await db
      .from("claude_threads")
      .insert({
        org_id: orgId,
        created_by: userId,
        title,
        title_source: "auto",
        // The task this thread belongs to — the rail leads the title with it and
        // the auto-titler preserves it.
        task_serial: ctx.serial ?? null,
        repo,
        git_branch: null, // clone the default branch
        claude_account: account,
      })
      .select("id")
      .single();
    if (tErr || !thread) {
      console.error("[tasks.claude-handoff] thread insert failed:", tErr?.message);
      return null;
    }

    const message = buildHandoffMessage(ctx);
    const composed = await composePrompt(orgId, message, null);

    const { data: run, error: rErr } = await db
      .from("claude_runs")
      .insert({
        org_id: orgId,
        created_by: userId,
        thread_id: thread.id,
        turn_index: 1,
        title: `task ${ctx.serial ?? ctx.id}`.slice(0, 80),
        prompt: composed.prompt,
        user_prompt: message,
        // run.repo is what flips the runner to bypassPermissions (full shell) — must
        // match the thread's repo so the loop-closing curl can run (see header).
        repo,
        // loadAccountToken(run.claude_account) picks the token — carry the account
        // here too so the first turn actually runs on the user's last-used account.
        claude_account: account,
        status: "queued",
      })
      .select("id")
      .single();
    if (rErr || !run) {
      console.error("[tasks.claude-handoff] run insert failed:", rErr?.message);
      return thread.id; // the thread exists; the user can send the message by hand
    }

    void executeRun(run.id)
      // Re-title from the conversation once it has content, like a normal thread.
      .then(() => maybeTitle(thread.id, orgId))
      .catch((e) =>
        console.error("[tasks.claude-handoff] executeRun threw:", e instanceof Error ? e.message : e),
      );

    return thread.id;
  } catch (e) {
    console.error("[tasks.claude-handoff] threw:", e instanceof Error ? e.message : e);
    return null;
  }
}
