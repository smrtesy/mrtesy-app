/**
 * Gemini API wrapper — used by the WhatsApp webhook to transcribe audio
 * messages and OCR images. Modeled after `anthropic.ts` so the call sites
 * stay consistent across the codebase.
 *
 * We use Gemini (not Claude) for audio/image inputs because Anthropic models
 * don't accept audio, and Gemini Flash gives us cheap, accurate Hebrew
 * transcription with multi-speaker handling — same model and prompts the
 * existing Apps Script uses, so behavior is identical post-migration.
 *
 * The API key + model + thinking level all come from `app_secrets` for the
 * smrttask app (admin UI). Env vars (GEMINI_API_KEY etc.) serve as fallback
 * during the transition window.
 */

import { getAppSecret } from "./db";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiCallOptions {
  /** Prompt text shown to the model. */
  prompt: string;
  /** Inline media bytes (already base64-encoded). */
  base64Data: string;
  /** Mime type of the media, e.g. "audio/ogg" or "image/jpeg". */
  mimeType: string;
  /** Optional override for the model id. */
  model?: string;
  /** Optional override for thinkingLevel (low/medium/high). */
  thinkingLevel?: string;
  /** Output token cap. */
  maxOutputTokens?: number;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

/**
 * Call Gemini with a single inline media blob and return the text output.
 * Throws on HTTP/API errors. Returns a safety placeholder string if Gemini
 * blocks the response — that way callers get something parseable rather
 * than crashing on missing text.
 */
export async function callGemini(opts: GeminiCallOptions): Promise<string> {
  const apiKey = await getAppSecret("smrttask", "GEMINI_API_KEY", "GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model =
    opts.model ??
    (await getAppSecret("smrttask", "GEMINI_MODEL", "GEMINI_MODEL")) ??
    "gemini-3-flash-preview";

  const thinkingLevel =
    opts.thinkingLevel ??
    (await getAppSecret("smrttask", "GEMINI_THINKING_LEVEL", "GEMINI_THINKING_LEVEL")) ??
    "low";

  const url = `${GEMINI_API_BASE}/${model}:generateContent`;

  const body = {
    contents: [
      {
        parts: [
          { text: opts.prompt },
          { inline_data: { mime_type: opts.mimeType, data: opts.base64Data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      thinkingConfig: { thinkingLevel },
    },
  };

  // Single retry on transient 5xx (Gemini regularly returns 503 "model
  // currently experiencing high demand" — a short backoff usually clears it).
  // We don't loop forever: webhook responses must stay quick and a failed
  // OCR/transcription falls back to a placeholder upstream rather than
  // blocking the message.
  const fetchOnce = async () =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

  let res = await fetchOnce();
  if (!res.ok && res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetchOnce();
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as GeminiResponse;
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

/**
 * Transcribe a WhatsApp voice/audio message. Prompt is identical to the
 * Apps Script that's been running in production — multi-language detection,
 * speaker labels, no hallucination on unclear audio.
 */
export async function transcribeAudio(base64Data: string, mimeType: string): Promise<string> {
  const prompt =
    "תמלל במדויק את הקובץ הקולי. כללים:\n" +
    "1. זהה את השפה המקורית (עברית/אנגלית/יידיש/אחר) ותמלל באותה שפה\n" +
    "2. שמור על סימני פיסוק ופסקאות טבעיות\n" +
    '3. אם יש כמה דוברים - סמן אותם כ"דובר 1", "דובר 2" וכו\'\n' +
    "4. אם יש רקע לא ברור - ציין [לא ברור] ולא תמציא\n" +
    "5. החזר רק את התמלול עצמו, ללא הקדמות או הערות מטא";

  return callGemini({ prompt, base64Data, mimeType: mimeType || "audio/ogg" });
}

/**
 * OCR + description for an inbound image. Matches the Apps Script prompt
 * so behavior post-migration is the same: extract text first, fall back
 * to a 1-2 sentence visual description if there's nothing textual.
 */
export async function performImageOcr(base64Data: string, mimeType: string): Promise<string> {
  const prompt =
    "נתח את התמונה:\n" +
    "1. אם יש טקסט - חלץ אותו במלואו ובדיוק, שמור על מבנה (שורות/פסקאות)\n" +
    "2. אם יש כמה שפות - תמלל כל אחת בשפתה המקורית\n" +
    "3. אם אין טקסט או שהוא מינימלי - תן תיאור תמציתי (1-2 משפטים) של התמונה\n" +
    "4. אם זה צילום מסך של שיחה/מסמך - שמור על פורמט מובן\n" +
    "5. החזר רק את התוצאה, ללא הקדמות";

  return callGemini({ prompt, base64Data, mimeType: mimeType || "image/jpeg" });
}
