/**
 * Gemini media brain — audio transcription + image OCR.
 *
 * Extracted verbatim from the WhatsApp webhook (2026-07-28) so the SMS/MMS
 * webhook runs the SAME code rather than a copy of it. The reason for the move
 * is the class of bug this repo keeps hitting: SMS was built by mirroring the
 * WhatsApp thread builder by hand, and every later fix to the WhatsApp side —
 * the high-water-mark split among them — simply never reached SMS, because a
 * "mirror" is a snapshot, not a link. One module means a prompt tweak, a
 * pricing update or a sanitizer fix lands on both channels at once.
 *
 * Nothing here is channel-specific. The only per-caller value is `component`,
 * which labels the ai_usage ledger row ("gemini.whatsapp" / "gemini.sms") so
 * /admin/usage can still attribute spend per channel.
 *
 * COST: every call here bills the user's Google account. Callers are expected
 * to apply their own guards first — a redelivery check (never transcribe the
 * same message twice) and an oversize check (AUDIO_TRANSCRIBE_MAX_BYTES).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// Loose client type: both callers hold a service-role client built by
// createAdminSupabaseClient(), which is untyped in this repo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Skip inline Gemini transcription above this raw-bytes size. Gemini caps the
 * whole inline_data request at ~20MB; base64 inflates by ~33%, so ~15MB raw is
 * the safe ceiling. Bigger recordings also overflow the transcription token
 * budget, so an inline attempt just burns money and rate-limits the next notes.
 */
export const AUDIO_TRANSCRIBE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Ceiling on a single Gemini request when the caller passes its own budget —
 * see the comment at the fetch. Deliberately well under the SMS pass budget so
 * one slow part cannot consume it all.
 */
const GEMINI_CALL_TIMEOUT_MS = 25_000;

/**
 * Ceiling when the caller passes NO budget (the WhatsApp webhook). Higher than
 * the budgeted one on purpose: a voice note near AUDIO_TRANSCRIBE_MAX_BYTES
 * legitimately takes longer than 25s to transcribe, and before this module had
 * any timeout at all its only bound was the function's own 60s ceiling. A 25s
 * abort here would turn recordings that used to transcribe fine into
 * "[אודיו - לא ניתן לתמלל כרגע]" — trading a hang we've never seen for a
 * regression on a case that works today.
 */
const NO_BUDGET_TIMEOUT_MS = 45_000;

/** Never abort a request before this — below it, nothing useful can complete. */
const GEMINI_MIN_TIMEOUT_MS = 2_000;

/** Backoff before the single 5xx retry. */
const GEMINI_RETRY_DELAY_MS = 3_000;

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

const GEMINI_PRICING: Record<
  string,
  { audioInput: number; imageInput: number; textInput: number; output: number }
> = {
  "gemini-2.5-flash":       { textInput: 0.30, audioInput: 1.00, imageInput: 0.30, output: 2.50 },
  "gemini-2.5-pro":         { textInput: 1.25, audioInput: 1.25, imageInput: 1.25, output: 10.0 },
  "gemini-3-flash-preview": { textInput: 0.50, audioInput: 1.00, imageInput: 0.50, output: 3.00 },
  "gemini-3-pro-preview":   { textInput: 1.50, audioInput: 2.50, imageInput: 1.50, output: 12.0 },
};

function estimateGeminiCostLocal(model: string, usage: GeminiUsageMetadata | undefined): number {
  if (!usage) return 0;
  const p = GEMINI_PRICING[model];
  if (!p) return 0;
  let audioTok = 0, imageTok = 0, textTok = 0;
  if (Array.isArray(usage.promptTokensDetails)) {
    for (const d of usage.promptTokensDetails) {
      const n = d.tokenCount ?? 0;
      const m = (d.modality ?? "").toUpperCase();
      if (m === "AUDIO") audioTok += n;
      else if (m === "IMAGE" || m === "VIDEO") imageTok += n;
      else textTok += n;
    }
  } else {
    textTok = usage.promptTokenCount ?? 0;
  }
  const outTok = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return (audioTok / 1_000_000) * p.audioInput +
    (imageTok / 1_000_000) * p.imageInput +
    (textTok  / 1_000_000) * p.textInput +
    (outTok   / 1_000_000) * p.output;
}

/**
 * Read a platform-wide app config value. Tries app_secrets first (Vault for
 * secrets, value_text for plain), falls back to the named env var. No
 * in-memory cache: Vercel serverless functions cold-start frequently and an
 * in-process cache would be inconsistent — each invocation reads ~3 values.
 */
async function getAppSecret(
  db: Db,
  appSlug: string,
  key: string,
  envFallback?: string,
): Promise<string | null> {
  const { data: app } = await db.from("apps").select("id").eq("slug", appSlug).maybeSingle();
  if (app) {
    const { data: row } = await db
      .from("app_secrets")
      .select("is_secret, value_text, value_secret_id")
      .eq("app_id", app.id)
      .eq("key", key)
      .maybeSingle();
    if (row) {
      if (row.is_secret && row.value_secret_id) {
        const { data: plaintext } = await db.rpc("vault_read_secret", {
          secret_id: row.value_secret_id,
        });
        if (typeof plaintext === "string") return plaintext;
      } else if (!row.is_secret) {
        return (row.value_text as string | null) ?? null;
      }
    }
  }
  if (envFallback) return process.env[envFallback] ?? null;
  return null;
}

async function callGemini(
  db: Db,
  prompt: string,
  base64Data: string,
  mimeType: string,
  component: string,
  budgetMs?: number,
): Promise<string> {
  const apiKey = await getAppSecret(db, "smrttask", "GEMINI_API_KEY", "GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model =
    (await getAppSecret(db, "smrttask", "GEMINI_MODEL", "GEMINI_MODEL")) ??
    "gemini-3-flash-preview";
  const thinkingLevel =
    (await getAppSecret(db, "smrttask", "GEMINI_THINKING_LEVEL", "GEMINI_THINKING_LEVEL")) ??
    "low";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel },
    },
  };

  // Per-call timeout. Without one a hung Gemini connection runs the whole
  // serverless function past its maxDuration, so it dies before writing
  // anything — and the webhook's caller (Meta, or the SMS gateway) redelivers
  // and pays for the same analysis again, potentially forever.
  //
  // `budgetMs` makes a caller's own deadline AUTHORITATIVE rather than advisory.
  // Checking a deadline only BEFORE starting a call is not enough: with a 25s
  // ceiling plus a 3s backoff plus a 25s retry, one call can take 53s, so a part
  // that starts just inside a 40s budget can finish past 90s and take the
  // function down with it. Bounding every attempt (and the retry decision) by
  // the time actually left means the pass can never outrun the budget.
  // There is ALWAYS a deadline — a caller's budget when given, else
  // NO_BUDGET_TIMEOUT_MS. Leaving the no-budget path deadline-free would put its
  // total back at 45s + 3s backoff + 45s retry = 93s on a slow 5xx, past the
  // 60s function ceiling. With a deadline, `sleep + attempt <= timeLeft` holds by
  // construction, so the whole call — retry included — fits the budget.
  const totalBudget = budgetMs ?? NO_BUDGET_TIMEOUT_MS;
  const ceiling = budgetMs === undefined ? NO_BUDGET_TIMEOUT_MS : GEMINI_CALL_TIMEOUT_MS;
  const deadline = Date.now() + totalBudget;
  const timeLeft = () => deadline - Date.now();
  const attemptTimeout = () => Math.max(GEMINI_MIN_TIMEOUT_MS, Math.min(ceiling, timeLeft()));

  const fetchOnce = async () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(attemptTimeout()),
    });

  let res = await fetchOnce();
  // Retry a 5xx only if the backoff AND a meaningful second attempt still fit.
  if (
    !res.ok && res.status >= 500 && res.status < 600 &&
    timeLeft() > GEMINI_RETRY_DELAY_MS + GEMINI_MIN_TIMEOUT_MS
  ) {
    await new Promise((r) => setTimeout(r, GEMINI_RETRY_DELAY_MS));
    res = await fetchOnce();
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as GeminiResponse;

  // Log usage to ai_usage ledger (best-effort).
  try {
    const usage = data.usageMetadata;
    const { error: usageInsertError } = await db.from("ai_usage").insert({
      provider: "google",
      component,
      model,
      input_tokens: usage?.promptTokenCount ?? 0,
      // Thinking tokens bill as output and ARE priced in below, so they belong
      // in this column too — logging candidates alone made the per-call cost
      // look impossible to derive from the tokens shown in /admin/usage.
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cost_usd: estimateGeminiCostLocal(model, usage),
    });
    if (usageInsertError) {
      console.error(`[${component}] ai_usage insert failed:`, usageInsertError.message);
    }
  } catch { /* never block the caller */ }

  const candidate = data.candidates?.[0];
  if (!candidate) return "[Gemini: אין תגובה]";
  if (candidate.finishReason === "SAFETY") return '[Gemini: תוכן נחסם ע"י מסנני בטיחות]';
  if (candidate.finishReason === "RECITATION") return "[Gemini: נחסם בגלל ציטוט ידוע]";

  const text = candidate.content?.parts
    ?.filter((p) => p.text)
    .map((p) => p.text)
    .join("\n");
  return text ?? "[Gemini החזיר תגובה ריקה]";
}

const TRANSCRIPTION_PROMPT =
  "החזר אך ורק את תוכן הדיבור עצמו, מילה במילה. אסור להוסיף ולו מילה אחת משלך.\n" +
  "• המילה הראשונה והמילה האחרונה בפלט חייבות להיות מתוך הדיבור עצמו.\n" +
  "• בלי שום משפט פתיחה (\"הנה התמלול\", \"בטח, הנה...\", \"להלן התמלול:\") ובלי שום משפט סיום (\"מקווה שעזרתי\", \"זהו\", \"בהצלחה\").\n" +
  "• בלי כותרות, בלי סוגריים מטא (כגון [תמלול אודיו]), ובלי markdown fences (```).\n" +
  "• בלי תוויות דובר כמו \"דובר 1:\", \"דובר 2:\" אלא אם יש באמת כמה דוברים שונים בקובץ.\n" +
  "\n" +
  "חוקי תמלול:\n" +
  "• זהה את שפת הדיבור (עברית/אנגלית/יידיש/אחר) ותמלל באותה שפה — אל תתרגם.\n" +
  "• שמור על סימני פיסוק ופסקאות טבעיות.\n" +
  "• אם יש קטע לא ברור — כתוב [לא ברור]. אסור להמציא.\n" +
  "\n" +
  "הפלט שלך נכנס ישירות לצ'אט של המשתמש כאילו הוא הקליד אותו בעצמו.";

// Blind transcription mis-hears words the conversation would have disambiguated
// — "share"→"show" flipped the meaning of a real voice note (T1997), and a
// surname heard once as "Simon" once as "Chaim" split one caller into two.
// Feeding the recent chat text as ACOUSTIC context lets Gemini resolve an
// ambiguous word/name by what the thread is actually about. Guardrails are
// explicit so context helps decoding without letting the model rewrite clear
// speech or bleed context text into the transcript. Empty context → the plain
// prompt, unchanged (SMS path and any caller that passes none).
function buildTranscriptionPrompt(context?: string): string {
  const ctx = (context ?? "").trim();
  if (!ctx) return TRANSCRIPTION_PROMPT;
  return (
    TRANSCRIPTION_PROMPT +
    "\n\n--- הקשר השיחה (עזר-פענוח בלבד, לא חלק מהאודיו) ---\n" +
    "להלן ההודעות האחרונות בשיחה שבתוכה נאמרה ההקלטה. השתמש בהן אך ורק כדי " +
    "לפענח נכון מילים, שמות ומונחים שנשמעים מעורפלים באודיו (שם פרטי, שם ארגון, " +
    "מונח מקצועי, מילה שיכולה להישמע בשתי צורות).\n" +
    "אזהרות מחייבות:\n" +
    "• אל תשנה מילה שנאמרה ברור באודיו רק מפני שהיא לא מתאימה להקשר.\n" +
    "• אל תעתיק, תוסיף או תשלב טקסט מההקשר לתוך התמלול — התמלול הוא של האודיו בלבד.\n" +
    "• אם קטע לא ברור וההקשר לא עוזר — כתוב [לא ברור]. אל תמציא.\n" +
    ctx
  );
}

export function sanitizeTranscript(text: string): string {
  let out = text.trim();

  if (/^```/.test(out)) {
    out = out.replace(/^```[a-zA-Z0-9]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  out = out.replace(/^\[\s*תמלול(?:\s+אודיו)?\s*\]\s*\n*/u, "");

  const HE_META = "תמלול|תרגום|טקסט|פלט|תוצאה|תיאור|פיענוח|קובץ\\s+קולי|הקלטה";
  const EN_META = "transcript(?:ion)?|ocr|text|output|result|translation|description|audio|recording";
  const preamblePatterns: RegExp[] = [
    new RegExp(`^(?:הנה|להלן|בטח[,!:]?\\s*הנה)[^\\n]{0,80}(?:${HE_META})[^\\n]{0,40}:\\s*\\n+`, "iu"),
    new RegExp(`^(?:here(?:'s| is| are|\\s+you\\s+go)|sure[,!:]?\\s*here|below(?:\\s+is)?)[^\\n]{0,80}(?:${EN_META})[^\\n]{0,40}:\\s*\\n+`, "i"),
    new RegExp(`^the\\s+(?:${EN_META})\\s+(?:is|reads|follows)[^\\n]{0,40}:?\\s*\\n+`, "i"),
    /^\*\*[^\n*]{1,80}\*\*\s*\n+/,
    new RegExp(`^(?:${HE_META}|${EN_META})\\s*[:：]\\s*\\n+`, "i"),
  ];
  for (const re of preamblePatterns) {
    const next = out.replace(re, "");
    if (next.length < out.length) { out = next; break; }
  }

  out = out.replace(
    /\n+(hope this helps[^\n]*|let me know if[^\n]*|מקווה שזה עוזר[^\n]*|מקווה שעזרתי[^\n]*|אם יש לך עוד שאלות[^\n]*|אני כאן[^\n]*|בהצלחה[!.]?)\s*$/i,
    "",
  );

  if (/^דובר\s*1\s*[:：]/u.test(out) && !/דובר\s*2\s*[:：]/u.test(out)) {
    out = out.replace(/^דובר\s*1\s*[:：]\s*/u, "");
  }

  return out.trim();
}

export async function transcribeAudio(
  db: Db,
  base64Data: string,
  mimeType: string,
  component: string,
  budgetMs?: number,
  context?: string,
): Promise<string> {
  const raw = await callGemini(
    db,
    buildTranscriptionPrompt(context),
    base64Data,
    mimeType || "audio/ogg",
    component,
    budgetMs,
  );
  return sanitizeTranscript(raw);
}

export async function performImageOcr(
  db: Db,
  base64Data: string,
  mimeType: string,
  component: string,
  budgetMs?: number,
): Promise<string> {
  const prompt =
    "נתח את התמונה:\n" +
    "1. אם יש טקסט - חלץ אותו במלואו ובדיוק, שמור על מבנה (שורות/פסקאות)\n" +
    "2. אם יש כמה שפות - תמלל כל אחת בשפתה המקורית\n" +
    "3. אם אין טקסט או שהוא מינימלי - תן תיאור תמציתי (1-2 משפטים) של התמונה\n" +
    "4. אם זה צילום מסך של שיחה/מסמך - שמור על פורמט מובן\n" +
    "5. החזר רק את התוצאה, ללא הקדמות";
  return callGemini(db, prompt, base64Data, mimeType || "image/jpeg", component, budgetMs);
}
