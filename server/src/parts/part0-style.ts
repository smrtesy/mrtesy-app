/**
 * PART 0 — Writing Style Learning (manual-only, run once)
 *
 * Samples sent emails to build a writing style profile for Chanoch.
 * Saves result to rules_memory with trigger=writing_style_he / writing_style_en.
 * Once both exist, PART 3 uses them automatically — no need to re-run.
 */

import { db, loadRules, createRunSession, closeRunSession } from "../db";
import { simpleCall } from "../anthropic";
import { searchGmail, getMessage, extractEmailText } from "../services/gmail";

const STYLE_SYSTEM = `You analyze email writing style. Given sample sent emails, extract a concise style profile (~150 words) describing:
- Tone (formal/informal/warm)
- Sentence structure and length
- Common phrases and greetings
- How the person closes emails
- Any unique patterns

Output plain text, no JSON.`;

export async function runPart0(opts: { userId: string; language: "he" | "en" }) {
  const { userId, language } = opts;
  const sessionId = await createRunSession(userId, "part0", "style_learning");

  try {
    // Check if style already exists
    const rules = await loadRules(userId);
    const key = `writing_style_${language}`;
    if (rules.find((r) => r.trigger === key)) {
      await closeRunSession(sessionId, "completed", {}, `Style profile for ${language} already exists — skipped.`);
      return { sessionId, skipped: true };
    }

    // Search for sent emails in that language
    const query =
      language === "he"
        ? "from:chanoch@maor.org in:sent שלום"
        : "from:chanoch@maor.org in:sent Thank you";

    const messages = await searchGmail(userId, query, 10);
    if (messages.length === 0) {
      await closeRunSession(sessionId, "completed", {}, `No sent emails found for ${language}.`);
      return { sessionId, skipped: true };
    }

    // Fetch up to 8 email bodies
    const samples: string[] = [];
    for (const { id } of messages.slice(0, 8)) {
      try {
        const msg = await getMessage(userId, id);
        const { subject, body } = extractEmailText(msg as Parameters<typeof extractEmailText>[0]);
        if (body.trim().length > 50) {
          samples.push(`Subject: ${subject}\n---\n${body.slice(0, 500)}`);
        }
      } catch {
        // skip
      }
    }

    if (samples.length === 0) {
      await closeRunSession(sessionId, "partial", {}, "No email bodies extracted.");
      return { sessionId, skipped: true };
    }

    const { content } = await simpleCall(
      "sonnet",
      STYLE_SYSTEM,
      `Language: ${language}\n\nSample emails:\n\n${samples.join("\n\n===\n\n")}`,
      400,
    );

    // Save to rules_memory
    await db.from("rules_memory").upsert(
      {
        user_id: userId,
        trigger: key,
        rule_type: "style",
        category: "style",
        action: content,
        reason: `Writing style profile in ${language}, learned from ${samples.length} sent emails`,
        is_active: true,
        created_by: "claude",
        suggestion_status: "approved",
      },
      { onConflict: "user_id,trigger" },
    );

    await closeRunSession(
      sessionId,
      "completed",
      { items_processed: samples.length },
      `Style profile (${language}) learned from ${samples.length} emails.`,
    );

    return { sessionId, profile: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeRunSession(sessionId, "failed", { errors_count: 1 }, `Fatal: ${msg}`, [msg]);
    throw err;
  }
}
