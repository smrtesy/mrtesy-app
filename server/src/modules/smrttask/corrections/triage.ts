/**
 * Correction triage — decide what a user's correction actually IS before any of
 * it reaches the classifier prompt.
 *
 * WHY THIS EXISTS
 * A correction is free text the user wrote while looking at a wrong result. Some
 * are genuine classification rules ("a contract with no signature request is not
 * a signing task"). Most are not: they describe a CODE bug ("why is a message
 * from last week coming back today?"), a UI preference ("completed tasks should
 * show a bar, not a green stripe"), a filter rule ("stop mail to bills@…"), or a
 * rule the prompt already states. Injecting those into the prompt is worse than
 * useless — it spends cached-prefix tokens on instructions the model cannot act
 * on, and it teaches it to reason about the UI.
 *
 * Before this, every correction went into the prompt verbatim. A one-off manual
 * triage of the first 68 found only 5 that belonged there: 39 were code, 19 were
 * already covered, 2 were filter rules, 3 were unreadable. Then the next
 * correction the user wrote — a UI request about the inbox — went straight in
 * again, because nothing was tagging them.
 *
 * COST: this runs the Claude Code CLI through runOneShot, on
 * CLAUDE_CODE_OAUTH_TOKEN. That is the user's SUBSCRIPTION, not paid API tokens
 * (runner.ts deletes ANTHROPIC_API_KEY from the child env). So it can run on
 * every correction without a cost conversation. It must never run on a paid key.
 *
 * FAIL CLOSED, NEVER SILENT. Two independent guarantees:
 *   1. The classifier only injects a correction whose class is explicitly
 *      "prompt" (an ALLOW-list in ai-process, not a deny-list). A triage that
 *      fails, times out, or returns nonsense therefore changes nothing.
 *   2. Every outcome — including failure — notifies the user. So "nothing
 *      entered the prompt" can never mean "your correction vanished".
 *
 * The user approves. Triage proposes a class and, for a real rule, the exact
 * one-line wording; the correction only starts affecting classification once
 * POST /corrections/:id/decision accepts it.
 */

import { db } from "../../../db";
import { runOneShot, AUTOMATION_ACCOUNT } from "../../claude/runner";
import { notify } from "../../../lib/platform/notify";
import { validateRuleAgainstGoldenSet, type GoldenCheck } from "./golden";
import { createDiagnosisRun } from "./diagnose";

/** The verdicts triage may return. Only "prompt" ever reaches the classifier. */
export const PROMPT_CLASSES = [
  "prompt",        // a real classification rule → belongs in the prompt
  "code",          // describes a bug in the pipeline → belongs in a work item
  "ui",            // about how something looks/behaves on screen
  "filter",        // a skip/routing rule → belongs in rules_memory, not the prompt
  "covered",       // the prompt already says this
  "duplicate",     // another correction already says this
  "needs_question",// not understood well enough to act → ask the user
  "unclear",       // not actionable as written
] as const;
export type PromptClass = (typeof PROMPT_CLASSES)[number];

interface TriageVerdict {
  prompt_class: PromptClass;
  reason_he: string;
  /** One-line restatement of what the correction wants — the understanding
   *  gate made visible. Shown to the user so a misread is caught before acting. */
  understood_he?: string | null;
  /** For prompt_class="needs_question": the question to ask before classifying. */
  question_he?: string | null;
  /** For prompt_class="prompt": the exact one-line rule to inject. */
  suggested_rule_he?: string | null;
  /** For prompt_class="duplicate": the correction it repeats. */
  duplicate_of?: string | null;
}

/** How much of the source message the triage prompt gets to see. */
const SOURCE_EXCERPT_CHARS = 1200;

/**
 * One triage at a time, process-wide.
 *
 * Each run spawns a Claude Code CLI child on the API dyno. Nothing rate-limits
 * how fast a user can file corrections, so a burst of ten would have spawned ten
 * concurrent children — enough memory pressure to take the API process down, and
 * the corrections it was triaging with it. A single-slot queue keeps the cost of
 * a burst linear in TIME instead of in memory; a correction that waits is fine,
 * because the user is not waiting on it either.
 */
let triageChain: Promise<void> = Promise.resolve();
function enqueueTriage(run: () => Promise<void>): Promise<void> {
  triageChain = triageChain.then(run, run);
  return triageChain;
}

/**
 * Everything the triage needs to judge a correction against REALITY rather than
 * against the correction's own wording. The user's standing instruction is that
 * a correction is checked against the real data first — what the message
 * actually said, what the classifier actually decided, what rules already
 * exist — and only then turned into a rule.
 */
async function gatherEvidence(correction: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];

  const sourceId = correction.source_message_id as string | null;
  if (sourceId) {
    const { data: msg } = await db
      .from("source_messages")
      .select("source_type, sender, sender_email, subject, body_text, raw_content, ai_classification, received_at")
      .eq("id", sourceId)
      .maybeSingle();
    if (msg) {
      const body = String(msg.raw_content ?? msg.body_text ?? "").slice(0, SOURCE_EXCERPT_CHARS);
      parts.push(
        [
          "## ההודעה האמיתית שעליה ניתן התיקון",
          `ערוץ: ${msg.source_type}`,
          `שולח: ${msg.sender ?? msg.sender_email ?? "—"}`,
          `נושא: ${msg.subject ?? "—"}`,
          `סיווג שהמערכת נתנה: ${msg.ai_classification ?? "—"}`,
          `התקבל: ${msg.received_at ?? "—"}`,
          "תוכן:",
          body || "(ריק)",
        ].join("\n"),
      );
    }
  }

  const taskId = correction.task_id as string | null;
  if (taskId) {
    const { data: task } = await db
      .from("tasks")
      .select("serial_display, title_he, description, status, task_type, due_date")
      .eq("id", taskId)
      .maybeSingle();
    if (task) {
      parts.push(
        [
          "## המשימה שנוצרה",
          `מזהה: ${task.serial_display ?? taskId}`,
          `כותרת: ${task.title_he ?? "—"}`,
          `סטטוס: ${task.status ?? "—"} (סוג: ${task.task_type ?? "—"})`,
          `תיאור: ${String(task.description ?? "—").slice(0, 600)}`,
        ].join("\n"),
      );
    }
  }

  // Rules the classifier ALREADY carries, so "covered" and "duplicate" are
  // judged against the real prompt content rather than guessed at.
  const { data: accepted } = await db
    .from("task_corrections")
    .select("id, note, context")
    .eq("user_id", correction.user_id as string)
    .eq("app_slug", "smrttask")
    .neq("id", correction.id as string)
    .order("created_at", { ascending: false })
    .limit(80);
  const alreadyRules = (accepted ?? [])
    .filter((c) => String(((c.context ?? {}) as Record<string, unknown>).prompt_class ?? "") === "prompt")
    .map((c) => `- [${c.id}] ${String(c.note ?? "").slice(0, 200)}`);
  parts.push(
    [
      "## כללים שכבר נכנסו לפרומפט (אל תכניס כלל שכבר קיים כאן)",
      alreadyRules.length > 0 ? alreadyRules.join("\n") : "(אין עדיין)",
    ].join("\n"),
  );

  // Existing skip/routing rules, so a filter request is recognised as one.
  const { data: rules } = await db
    .from("rules_memory")
    .select("trigger")
    .eq("user_id", correction.user_id as string)
    .limit(60);
  parts.push(
    [
      "## כללי סינון קיימים (rules_memory)",
      (rules ?? []).map((r) => `- ${r.trigger}`).join("\n") || "(אין)",
    ].join("\n"),
  );

  return parts.join("\n\n");
}

function buildPrompt(note: string, evidence: string): string {
  return [
    "אתה ממיין הערה שמשתמש כתב על תוצאה שגויה במסווג ההודעות של smrtesy.",
    "המטרה: להחליט מה ההערה הזאת באמת, לפני שהיא נכנסת לפרומפט הסיווג.",
    "",
    "בדוק את ההערה מול הנתונים האמיתיים למטה — לא מול הנוסח של ההערה עצמה.",
    "",
    "## ההערה של המשתמש",
    note,
    "",
    evidence,
    "",
    "## שלב ראשון — הבנה (חובה לפני הסיווג)",
    "לפני שאתה מסווג, נסח ב-understood_he במשפט אחד מה ההערה מבקשת, במילים שלך.",
    "אם אינך מבין את ההערה מספיק כדי לפעול לפיה בביטחון — אל תנחש. החזר",
    'prompt_class="needs_question" ונסח ב-question_he שאלה קצרה אחת בעברית שתבהיר.',
    "עדיף לשאול מאשר לסווג לא נכון.",
    "",
    "## הקטגוריות",
    'prompt — כלל סיווג אמיתי שהמודל יכול לפעול לפיו ("חוזה בלי בקשה לחתום אינו משימת חתימה").',
    "code — מתאר באג בצינור: תזמון, כפילויות, הודעה שחוזרת, שדה שלא התעדכן, משימה שלא נסגרת. שינוי בפרומפט לא יתקן את זה.",
    "ui — מתאר איך משהו נראה או מתנהג על המסך (צבע, פס, מיקום, סדר תצוגה).",
    "filter — בקשה לחסום/לנתב שולח, כתובת או דומיין. מקומו ב-rules_memory ולא בפרומפט.",
    "covered — הפרומפט או הכללים הקיימים כבר אומרים את זה.",
    "duplicate — כלל שכבר נכנס לפרומפט אומר את אותו הדבר. החזר את המזהה שלו ב-duplicate_of.",
    "needs_question — לא הבנת מספיק כדי לפעול. החזר שאלה אחת ב-question_he.",
    "unclear — לא ניתן לפעול לפי הניסוח, או שאין מספיק מידע.",
    "",
    "## חוקים",
    "1. אל תסווג prompt הערה שמתארת תזמון, כפילות, סטטוס שלא השתנה או שדה שלא התעדכן — אלה code.",
    "2. אל תמציא עובדות. אם הנתונים למעלה לא תומכים בהערה, זה unclear.",
    "3. עבור prompt בלבד: כתוב ב-suggested_rule_he כלל אחד, שורה אחת, בציווי, כללי — לא מקרה פרטי ולא שם של אדם.",
    "4. שמור על כתובות וקישורים במלואם אם הם חלק מהכלל.",
    "5. תמיד מלא את understood_he, גם כשאתה שואל שאלה.",
    "",
    "החזר JSON אחד בלבד, בלי טקסט לפניו ואחריו, בלי גדרות markdown:",
    '{"understood_he":"<מה ההערה מבקשת, משפט אחד>","prompt_class":"<אחת מהקטגוריות>","reason_he":"<משפט אחד למה>","question_he":null,"suggested_rule_he":null,"duplicate_of":null}',
  ].join("\n");
}

/** Pull the JSON object out of the CLI's text reply. */
function parseVerdict(raw: string): TriageVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cls = String(parsed.prompt_class ?? "").toLowerCase() as PromptClass;
  if (!PROMPT_CLASSES.includes(cls)) return null;
  const rule = typeof parsed.suggested_rule_he === "string" ? parsed.suggested_rule_he.trim() : "";
  const understood = typeof parsed.understood_he === "string" ? parsed.understood_he.trim() : "";
  const question = typeof parsed.question_he === "string" ? parsed.question_he.trim() : "";
  return {
    prompt_class: cls,
    reason_he: String(parsed.reason_he ?? "").trim().slice(0, 600),
    understood_he: understood ? understood.slice(0, 400) : null,
    // Only meaningful for needs_question; carried verbatim so the notification
    // and the /log screen can show the exact question awaiting an answer.
    question_he: question ? question.slice(0, 400) : null,
    // A "prompt" verdict with no rule text is not usable as a rule; downgrade it
    // rather than accept a class the approval step cannot act on.
    suggested_rule_he: rule ? rule.slice(0, 400) : null,
    duplicate_of: typeof parsed.duplicate_of === "string" ? parsed.duplicate_of : null,
  };
}

const CLASS_LABEL_HE: Record<PromptClass, string> = {
  prompt: "כלל סיווג",
  code: "באג בקוד",
  ui: "בקשת ממשק",
  filter: "כלל סינון",
  covered: "כבר מכוסה",
  duplicate: "כפילות",
  needs_question: "יש שאלה",
  unclear: "לא ברור",
};

/**
 * Triage one correction and notify the user with the verdict.
 *
 * Never throws: the caller is the correction-create request, and a triage
 * failure must not fail the user's correction. Every exit path notifies.
 */
async function runTriage(correctionId: string): Promise<void> {
  try {
    const { data: correction, error } = await db
      .from("task_corrections")
      .select("*")
      .eq("id", correctionId)
      .maybeSingle();
    if (error || !correction) {
      console.error("[corrections.triage] correction not found:", correctionId, error?.message);
      return;
    }

    const note = String(correction.note ?? "").trim();
    const userId = correction.user_id as string;
    const orgId = correction.organization_id as string;

    const evidence = await gatherEvidence(correction as Record<string, unknown>);
    const raw = await runOneShot(buildPrompt(note, evidence), {
      timeoutMs: 120_000,
      // Automated classification check — route to the second subscription account.
      account: AUTOMATION_ACCOUNT,
    });
    const verdict = raw ? parseVerdict(raw) : null;

    // Two downgrades that keep the approval step honest: a "prompt" verdict with
    // no rule text cannot be approved as a rule, and a "needs_question" verdict
    // with no actual question cannot be answered. Both become "unclear" rather
    // than a class the next step cannot act on.
    const effective: TriageVerdict = verdict
      ? verdict.prompt_class === "prompt" && !verdict.suggested_rule_he
        ? { ...verdict, prompt_class: "unclear", reason_he: verdict.reason_he || "סווג ככלל אך לא נוסח כלל" }
        : verdict.prompt_class === "needs_question" && !verdict.question_he
          ? { ...verdict, prompt_class: "unclear", reason_he: verdict.reason_he || "סומן כשאלה אך לא נוסחה שאלה" }
          : verdict
      : {
          prompt_class: "unclear",
          reason_he: raw
            ? "המיון האוטומטי החזיר תשובה שלא ניתן לפרסר"
            : "המיון האוטומטי לא הצליח לרוץ",
          understood_he: null,
          question_he: null,
          suggested_rule_he: null,
          duplicate_of: null,
        };

    // Distinguish "the model judged this unclear" from "the triage never ran".
    // Only the latter deserves a retry: an infra blip is not a verdict, and
    // without this marker such a correction was PARKED forever — it carried a
    // real triage block so the sweep skipped it, and approving an "unclear" row
    // cannot make it a rule (the allow-list needs class "prompt"). So the
    // "never silent" guarantee held, but the correction could never become
    // anything. The retry is bounded, because a correction that fails three
    // times is failing for a reason a fourth attempt will not fix.
    const failed = verdict === null;
    const prevTriage = (((correction.context ?? {}) as Record<string, unknown>).triage ?? {}) as
      Record<string, unknown>;
    const attempts = Number(prevTriage.attempts ?? 0) + 1;

    // Slice 2 — measure a proposed rule against the golden set before the user
    // is asked to approve it. Only for a real prompt rule; every other class
    // skips it. The result informs the user (a conflict is a warning, not an
    // auto-reject — the user still decides), so it never blocks the notification.
    let goldenCheck: GoldenCheck | null = null;
    if (effective.prompt_class === "prompt" && effective.suggested_rule_he) {
      let srcType: string | null = null;
      if (correction.source_message_id) {
        const { data: sm } = await db
          .from("source_messages")
          .select("source_type")
          .eq("id", correction.source_message_id as string)
          .maybeSingle();
        srcType = (sm?.source_type as string | null) ?? null;
      }
      goldenCheck = await validateRuleAgainstGoldenSet(effective.suggested_rule_he, userId, srcType);
    }

    const context = {
      ...((correction.context ?? {}) as Record<string, unknown>),
      prompt_class: effective.prompt_class,
      triage: {
        at: new Date().toISOString(),
        by: "claude-code-oneshot",
        reason_he: effective.reason_he,
        understood_he: effective.understood_he ?? null,
        question_he: effective.question_he ?? null,
        suggested_rule_he: effective.suggested_rule_he,
        duplicate_of: effective.duplicate_of,
        golden_check: goldenCheck,
        failed,
        attempts,
        // Nothing affects classification until the user approves. The classifier
        // reads prompt_class, and its allow-list also requires approved=true for
        // the "prompt" class, so a verdict alone changes no behaviour.
        approved: false,
      },
    };

    const { error: updErr } = await db
      .from("task_corrections")
      .update({ context, updated_at: new Date().toISOString() })
      .eq("id", correctionId);
    if (updErr) console.error("[corrections.triage] update failed:", updErr.message);

    // Auto-diagnosis (option B): for a fixable class, spawn a READ-ONLY console
    // run that investigates the code and writes problem+fix onto context.diagnosis
    // (diagnose.ts). Fire-and-forget, on the subscription — zero paid tokens — and
    // it never blocks or fails triage. The kill-switch lives in createDiagnosisRun.
    if (effective.prompt_class === "code" || effective.prompt_class === "ui") {
      void createDiagnosisRun(correctionId, effective.prompt_class, orgId, userId, {
        note,
        understood_he: effective.understood_he ?? null,
        reason_he: effective.reason_he ?? null,
        serial: null,
      }).catch((e) =>
        console.error("[corrections.triage] diagnosis enqueue threw:", e instanceof Error ? e.message : e),
      );
    }

    // The notification IS the mechanism that keeps a fail-closed pipeline from
    // being a silent one. It carries the verdict, the reason, and — for a real
    // rule — the exact wording awaiting approval, so the user decides from the
    // inbox without opening anything.
    const label = CLASS_LABEL_HE[effective.prompt_class];

    // Lead the title with the task's serial (e.g. "T1740"), the way the
    // cross-party detector's title already does. Without it the inbox showed a
    // bare "תיקון מיון: …" with no hint of WHICH task the correction came from.
    // A correction with no task (scope-general feedback) gets no prefix rather
    // than a fake serial.
    let serialPrefix = "";
    if (correction.task_id) {
      const { data: task } = await db
        .from("tasks")
        .select("serial_display")
        .eq("id", correction.task_id as string)
        .maybeSingle();
      const serial = (task?.serial_display as string | null) ?? null;
      if (serial) serialPrefix = `${serial} · `;
    }

    // A step-by-step report the user can read at a glance, not a code diff (the
    // user does not read code — see docs/corrections-triage-v2-plan.md). Status
    // in the title says where it stands; the body walks understood → classified
    // → what happens next.
    const isQuestion = effective.prompt_class === "needs_question";
    const isPromptRule = effective.prompt_class === "prompt" && !!effective.suggested_rule_he;
    const status = isQuestion ? "יש שאלה" : isPromptRule ? "ממתין לאישור" : "בדק ומצא";

    const bodyLines: string[] = [`התיקון שלך: ${note.slice(0, 160)}`];
    if (isQuestion) {
      bodyLines.push("בדקתי, ויש לי שאלה כדי להבין בדיוק:");
      bodyLines.push(`❓ ${effective.question_he}`);
      bodyLines.push("ענה ואמשיך מכאן.");
    } else {
      if (effective.understood_he) bodyLines.push(`✓ הבנתי: ${effective.understood_he}`);
      bodyLines.push(`✓ סיווג: ${label} — ${effective.reason_he}`);
      if (isPromptRule) {
        bodyLines.push(`✓ הכלל המוצע: ${effective.suggested_rule_he}`);
        // Slice 2 — show the golden-set result so the user approves with the
        // regression signal in hand. A conflict is a warning, not a block.
        if (goldenCheck && goldenCheck.checked > 0) {
          bodyLines.push(goldenCheck.clean ? `✓ ${goldenCheck.summary_he}` : goldenCheck.summary_he);
        }
        bodyLines.push("ממתין לאישור שלך כדי להיכנס לפרומפט הסיווג.");
      } else if (effective.prompt_class === "code" || effective.prompt_class === "ui") {
        bodyLines.push("לא כלל סיווג — צריך תיקון קוד/ממשק. לא נכנס לפרומפט.");
      } else {
        bodyLines.push("לא נכנס לפרומפט הסיווג.");
      }
    }

    await notify(orgId, userId, {
      app_slug: "smrttask",
      // A question needs the user; a proposed rule needs approval; a diagnosis
      // is informational.
      type: isQuestion || isPromptRule ? "action_required" : "info",
      title: `${serialPrefix}תיקון מיון · ${status}`,
      body: bodyLines.join("\n"),
      link: "/log",
      entity_type: "task_correction",
      entity_id: correctionId,
    });
  } catch (e) {
    // Last resort: the correction stays untriaged, which by the allow-list means
    // it does not reach the prompt. Loud in the log, never fatal to the request.
    console.error("[corrections.triage] threw:", e instanceof Error ? e.message : e);
  }
}

/**
 * Queue a triage. The public entry point — callers never spawn a CLI child
 * directly, so the single-slot queue above is impossible to bypass.
 */
export function triageCorrection(correctionId: string): Promise<void> {
  return enqueueTriage(() => runTriage(correctionId));
}

/**
 * Pick up corrections that never got a verdict and triage them.
 *
 * The create path fires triage without awaiting it, which is right — the user
 * should not wait tens of seconds for a 201. But it means a redeploy or a crash
 * inside the run window loses that triage with nothing to notice: the correction
 * sits with no class, the allow-list keeps it out of the prompt, and no
 * notification ever arrives. That is precisely the silent loss this design
 * claims to prevent, so the claim needs a sweep behind it rather than an
 * assumption that the process stays up.
 *
 * Runs oldest-first and bounded, because it shares the one-slot queue with live
 * corrections and must never starve them.
 */
export const MAX_TRIAGE_ATTEMPTS = 3;

export async function sweepUntriagedCorrections(limit = 5): Promise<number> {
  const bound = Math.max(1, Math.min(limit, 25));

  // Two separate queries rather than one nested PostgREST or(): the conditions
  // are structurally different (a missing verdict vs a failed one), and an
  // and-group inside or() is exactly the kind of filter string that silently
  // matches the wrong set. Cheap, and each half is readable on its own.
  const { data: failedRows, error: failedErr } = await db
    .from("task_corrections")
    .select("id, context")
    .eq("app_slug", "smrttask")
    .eq("context->triage->>failed", "true")
    .order("created_at", { ascending: true })
    .limit(bound);
  if (failedErr) console.error("[corrections.triage] sweep(failed) query:", failedErr.message);
  const retryIds = (failedRows ?? [])
    .filter((r) => {
      const tri = (((r.context ?? {}) as Record<string, unknown>).triage ?? {}) as Record<string, unknown>;
      return Number(tri.attempts ?? 0) < MAX_TRIAGE_ATTEMPTS;
    })
    .map((r) => r.id as string);

  const { data, error } = await db
    .from("task_corrections")
    .select("id")
    .eq("app_slug", "smrttask")
    .is("context->triage", null)
    // AND no class either. "No triage block" alone is not "untriaged": 68 rows
    // carry a prompt_class from the one-off manual triage and have no triage
    // block, and ai-process deliberately reads a MISSING block as approved so
    // those hand-classified rules keep working. Sweeping on the block alone
    // would re-triage all 68 — overwriting their class, stamping
    // approved:false, and so REMOVING the five rules currently live in the
    // classifier prompt, plus a notification per ancient correction on every
    // run. Requiring both leaves exactly the genuinely-unjudged rows.
    .is("context->prompt_class", null)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 25)));
  if (error) {
    console.error("[corrections.triage] sweep query failed:", error.message);
    return 0;
  }
  // Never-triaged rows first: a correction with no verdict at all has a user
  // waiting on a notification, while a retry already got one.
  const ids = [...new Set([...(data ?? []).map((r) => r.id as string), ...retryIds])].slice(0, bound);
  for (const id of ids) await triageCorrection(id);
  if (ids.length > 0) {
    console.log(
      `[corrections.triage] swept ${ids.length} correction(s) ` +
      `(${retryIds.length} retry of a failed run)`,
    );
  }
  return ids.length;
}
