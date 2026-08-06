/**
 * Golden-set validation of a proposed classification rule (plan slice 2).
 *
 * A "prompt" correction proposes a one-line rule that would enter the classifier
 * prompt. Before the user is asked to approve it, we measure it against the
 * `classifier_golden_set` — the labelled corpus of real messages whose correct
 * classification is KNOWN because the user's own recorded action set it. The
 * one property that matters: a rule must not REGRESS a case the user already
 * got right ("would this rule now mislabel a message we know the answer to?").
 *
 * WHY ONE LLM CALL, NOT 206
 * The corpus is ~200 rows. Replaying the full classifier per row per correction
 * would be hundreds of subscription calls and minutes of wall-clock on the
 * single-slot triage queue — impractical on every prompt correction. Instead a
 * single one-shot judges the proposed rule against a BOUNDED, relevant sample:
 * confirmed-labelled rows, same channel first, with short body excerpts. It
 * answers the regression question well without pretending to be a full eval.
 *
 * COST: runOneShot on the subscription token, exactly like triage — no paid API.
 *
 * FAIL OPEN TO "UNKNOWN", NEVER TO "SAFE": if the check cannot run (no corpus,
 * parse failure, timeout) it returns checked=0 and the rule is neither blessed
 * nor blocked — the user still approves manually, they just do it without this
 * extra signal. It must never claim "safe" on a check that did not happen.
 */

import { db } from "../../../db";
import { runOneShot, pickHealthyAccount } from "../../claude/runner";

/** One labelled row the rule is measured against. */
interface Conflict {
  subject: string;
  expected: string;
  would_be: string;
  why: string;
}

export interface GoldenCheck {
  /** How many labelled messages the rule was actually measured against. */
  checked: number;
  /** Labelled cases the rule would now classify DIFFERENTLY from the known
   *  answer — i.e. regressions the rule introduces. Empty = clean. */
  conflicts: Conflict[];
  /** True only when a real check ran (checked > 0) and found no conflict. */
  clean: boolean;
  /** One-line Hebrew summary for the notification. */
  summary_he: string;
}

const SAMPLE_SIZE = 20;
const BODY_EXCERPT = 220;

/**
 * Measure a proposed rule against the golden set. Never throws.
 *
 * @param rule       the one-line rule text the user would approve
 * @param userId     the correction's owner (RLS-bypassing admin client, scoped by this)
 * @param sourceType the channel of the message the correction was filed on, used
 *                   to prefer same-channel labelled rows in the sample
 */
export async function validateRuleAgainstGoldenSet(
  rule: string,
  userId: string,
  sourceType: string | null,
): Promise<GoldenCheck> {
  const unknown = (summary: string): GoldenCheck => ({
    checked: 0,
    conflicts: [],
    clean: false,
    summary_he: summary,
  });

  try {
    // Confirmed, labelled, active rows only. needs_review/rejected rows and
    // NULL labels are not ground truth and an eval must skip them (per the
    // migration's own contract).
    const { data: rows, error } = await db
      .from("classifier_golden_set")
      .select("source_message_id, expected_classification, source_type, sender_email, subject")
      .eq("user_id", userId)
      .eq("review_status", "confirmed")
      .eq("is_active", true)
      .not("expected_classification", "is", null)
      .limit(200);
    if (error) {
      console.error("[corrections.golden] query failed:", error.message);
      return unknown("לא ניתן היה לבדוק מול מקרי עבר");
    }
    const all = rows ?? [];
    if (all.length === 0) return unknown("אין עדיין מקרי עבר מתויגים לבדיקה");

    // Prefer same-channel rows (a rule about SMS is best tested on SMS), then
    // fill the rest from the corpus so both labels are represented.
    const sameChannel = all.filter((r) => sourceType && r.source_type === sourceType);
    const rest = all.filter((r) => !(sourceType && r.source_type === sourceType));
    const sample = [...sameChannel, ...rest].slice(0, SAMPLE_SIZE);

    // Pull short body excerpts for the sample only — the golden set stores no
    // bodies on purpose, so read them from source_messages here.
    const ids = sample.map((r) => r.source_message_id as string);
    const { data: msgs } = await db
      .from("source_messages")
      .select("id, body_text, raw_content")
      .in("id", ids);
    const bodyById = new Map<string, string>();
    for (const m of msgs ?? []) {
      const body = String((m.raw_content ?? m.body_text ?? "") as string).slice(0, BODY_EXCERPT);
      bodyById.set(m.id as string, body);
    }

    const cases = sample.map((r, i) => {
      const body = bodyById.get(r.source_message_id as string) ?? "";
      return [
        `[${i + 1}] סיווג נכון ידוע: ${r.expected_classification}`,
        `ערוץ: ${r.source_type ?? "—"} | שולח: ${r.sender_email ?? "—"} | נושא: ${r.subject ?? "—"}`,
        `תוכן: ${body || "(ריק)"}`,
      ].join("\n");
    });

    const prompt = [
      "אתה בודק אם כלל סיווג חדש היה פוגע בהודעות שהסיווג הנכון שלהן כבר ידוע.",
      "",
      "## הכלל המוצע",
      rule,
      "",
      "## הודעות עם סיווג נכון ידוע (ground truth)",
      "לכל הודעה מצוין הסיווג הנכון. השאלה: אם המסווג היה פועל לפי הכלל המוצע,",
      "האם הוא היה מסווג את ההודעה **אחרת** מהסיווג הנכון? זו רגרסיה.",
      "",
      cases.join("\n\n"),
      "",
      "## פלט",
      "החזר JSON אחד בלבד, בלי טקסט מסביב, בלי גדרות markdown:",
      '{"conflicts":[{"subject":"<נושא>","expected":"<הסיווג הנכון>","would_be":"<מה הכלל היה גורם>","why":"<משפט קצר>"}]}',
      "רק הודעות שהכלל היה משנה את סיווגן לרעה נכנסות ל-conflicts. אם אין — החזר conflicts ריק.",
    ].join("\n");

    const raw = await runOneShot(prompt, {
      timeoutMs: 120_000,
      // Automated classification check — route to a healthy background account
      // (prefers `automation`, falls back to any configured account not over its
      // weekly limit).
      account: await pickHealthyAccount(),
    });
    if (!raw) return unknown(`נבדק מול ${sample.length} מקרים — הבדיקה לא הצליחה לרוץ`);

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return unknown(`נבדק מול ${sample.length} מקרים — תשובה לא קריאה`);
    let parsed: { conflicts?: unknown };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return unknown(`נבדק מול ${sample.length} מקרים — תשובה לא קריאה`);
    }

    const conflicts: Conflict[] = Array.isArray(parsed.conflicts)
      ? parsed.conflicts
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({
            subject: String(c.subject ?? "").slice(0, 120),
            expected: String(c.expected ?? "").slice(0, 40),
            would_be: String(c.would_be ?? "").slice(0, 40),
            why: String(c.why ?? "").slice(0, 200),
          }))
          .slice(0, 10)
      : [];

    const clean = conflicts.length === 0;
    const summary_he = clean
      ? `נבדק מול ${sample.length} מקרי עבר מתויגים — לא שובר אף אחד`
      : `⚠️ מתנגש עם ${conflicts.length} מתוך ${sample.length} מקרי עבר מתויגים`;

    return { checked: sample.length, conflicts, clean, summary_he };
  } catch (e) {
    console.error("[corrections.golden] threw:", e instanceof Error ? e.message : e);
    return unknown("שגיאה בבדיקה מול מקרי עבר");
  }
}
