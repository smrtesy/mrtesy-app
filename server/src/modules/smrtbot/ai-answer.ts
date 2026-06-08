/**
 * smrtBot — optional AI answering for free-text questions.
 *
 * When a visitor's message matches no FAQ entry, the engine can fall back to an
 * LLM grounded in the bot's knowledge base — but only if the bot owner enabled
 * it (ai_enabled) and picked a model (ai_model). Models + keys are the
 * platform's, configured centrally in smrtesy:
 *   - claude-haiku / claude-sonnet / claude-opus → Anthropic (ANTHROPIC_API_KEY)
 *   - gemini                                     → Gemini (GEMINI_API_KEY/MODEL)
 * Never uses a per-bot key.
 */
import { db } from "../../db";
import { simpleCall, type ModelKey } from "../../anthropic";
import { generateText } from "../../gemini";

export interface KbEntry {
  question_pattern: string;
  keywords: string | null;
  answer: string;
}

/** Read a single per-bot setting value from smrtbot_settings. */
export async function getBotSetting(botId: string, key: string): Promise<string | null> {
  const { data } = await db
    .from("smrtbot_settings")
    .select("value")
    .eq("bot_id", botId)
    .eq("key", key)
    .maybeSingle();
  return (data?.value as string | null) ?? null;
}

const CLAUDE_MODELS: Record<string, ModelKey> = {
  "claude-haiku": "haiku",
  "claude-sonnet": "sonnet",
  "claude-opus": "opus",
};

function isOn(v: string | null): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "true" || s === "on" || s === "1" || s === "yes";
}

/** Returns an AI answer, or null when AI is disabled / errored. Grounded in the
 *  bot's knowledge base; replies in Hebrew and preserves any URLs verbatim. */
export async function aiAnswer(botId: string, question: string, kb: KbEntry[]): Promise<string | null> {
  if (!isOn(await getBotSetting(botId, "ai_enabled"))) return null;
  const model = (await getBotSetting(botId, "ai_model")) || "claude-haiku";

  const kbText = kb
    .slice(0, 80)
    .map((k) => `• ${k.question_pattern}\n  ${k.answer}`)
    .join("\n")
    .slice(0, 6000);

  const system =
    "אתה עוזר שירות של בוט וואטסאפ. ענה בעברית, קצר, חם וברור. בסס את התשובה אך ורק על המידע שלהלן. " +
    "אם אין במידע תשובה מתאימה — אמור בנימוס שתעביר את השאלה לנציג אנושי, בלי להמציא. " +
    "שמר כל קישור (URL) בדיוק כפי שהוא מופיע, ללא קיצור.\n\n=== מאגר הידע ===\n" +
    (kbText || "(ריק)");

  try {
    if (model === "gemini") {
      const txt = await generateText(`${system}\n\n=== שאלת המשתמש ===\n${question}\n\nתשובה:`, {
        maxOutputTokens: 600,
      });
      return txt.trim() || null;
    }
    const mk = CLAUDE_MODELS[model] ?? "haiku";
    const { content } = await simpleCall(mk, system, `שאלת המשתמש: ${question}`, 600);
    return content.trim() || null;
  } catch (e) {
    console.error("[smrtbot/ai-answer]", e instanceof Error ? e.message : String(e));
    return null;
  }
}
