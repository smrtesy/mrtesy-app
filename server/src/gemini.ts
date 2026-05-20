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

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Per-model pricing per 1M tokens (USD). Updated to May 2026 published rates.
 * Caller falls back to "unknown" pricing if model not listed — cost will read
 * 0 but the experiment is still useful for quality comparison.
 */
interface ModelPricing {
  textInput: number;
  audioInput: number;
  imageInput: number;
  output: number;       // thinking tokens billed at output rate
}
const PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash":          { textInput: 0.30, audioInput: 1.00,  imageInput: 0.30, output: 2.50 },
  "gemini-2.5-pro":            { textInput: 1.25, audioInput: 1.25,  imageInput: 1.25, output: 10.0 },
  "gemini-3-flash-preview":    { textInput: 0.50, audioInput: 1.00,  imageInput: 0.50, output: 3.00 },
  "gemini-3-pro-preview":      { textInput: 1.50, audioInput: 2.50,  imageInput: 1.50, output: 12.0 },
};

const warnedMissingPricing = new Set<string>();
function estimateGeminiCost(model: string, usage: GeminiUsageMetadata | undefined): number {
  if (!usage) return 0;
  const pricing = PRICING[model];
  if (!pricing) {
    if (!warnedMissingPricing.has(model)) {
      console.warn(`[gemini] no pricing entry for model "${model}" — cost will read 0. Update PRICING table.`);
      warnedMissingPricing.add(model);
    }
    return 0;
  }

  // Per-modality split when available, else attribute everything to text.
  let audioTokens = 0;
  let imageTokens = 0;
  let textTokens  = 0;
  if (Array.isArray(usage.promptTokensDetails)) {
    for (const d of usage.promptTokensDetails) {
      const n = d.tokenCount ?? 0;
      const m = (d.modality ?? "").toUpperCase();
      if (m === "AUDIO") audioTokens += n;
      else if (m === "IMAGE" || m === "VIDEO") imageTokens += n;
      else textTokens += n;
    }
  } else {
    textTokens = usage.promptTokenCount ?? 0;
  }

  // Thinking tokens are billed at the output rate (Gemini convention).
  const outTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

  return (
    (audioTokens / 1_000_000) * pricing.audioInput +
    (imageTokens / 1_000_000) * pricing.imageInput +
    (textTokens  / 1_000_000) * pricing.textInput +
    (outTokens   / 1_000_000) * pricing.output
  );
}

export interface CallGeminiResult {
  text: string;
  costUsd: number;
  latencyMs: number;
  model: string;
  thinkingLevel: string;
  usage: GeminiUsageMetadata | null;
}

/**
 * Call Gemini with a single inline media blob and return the text output.
 * Throws on HTTP/API errors. Returns a safety placeholder string if Gemini
 * blocks the response — that way callers get something parseable rather
 * than crashing on missing text.
 */
export async function callGeminiDetailed(opts: GeminiCallOptions): Promise<CallGeminiResult> {
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

  const t0 = Date.now();
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
  const latencyMs = Date.now() - t0;
  const usage = data.usageMetadata ?? null;
  const costUsd = estimateGeminiCost(model, data.usageMetadata);

  const candidate = data.candidates?.[0];
  let text: string;
  if (!candidate) {
    text = "[Gemini: אין תגובה]";
  } else if (candidate.finishReason === "SAFETY") {
    text = '[Gemini: תוכן נחסם ע"י מסנני בטיחות]';
  } else if (candidate.finishReason === "RECITATION") {
    text = "[Gemini: נחסם בגלל ציטוט ידוע]";
  } else {
    const joined = candidate.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("\n");
    text = joined ?? "[Gemini החזיר תגובה ריקה]";
  }

  return { text, costUsd, latencyMs, model, thinkingLevel, usage };
}

/** Backwards-compat string wrapper for callers that just want the text. */
export async function callGemini(opts: GeminiCallOptions): Promise<string> {
  return (await callGeminiDetailed(opts)).text;
}

/**
 * Transcribe a WhatsApp voice/audio message. Prompt is identical to the
 * Apps Script that's been running in production — multi-language detection,
 * speaker labels, no hallucination on unclear audio.
 */
const TRANSCRIPTION_PROMPT =
  "תמלל במדויק את הקובץ הקולי. כללים:\n" +
  "1. זהה את השפה המקורית (עברית/אנגלית/יידיש/אחר) ותמלל באותה שפה\n" +
  "2. שמור על סימני פיסוק ופסקאות טבעיות\n" +
  '3. אם יש כמה דוברים - סמן אותם כ"דובר 1", "דובר 2" וכו\'\n' +
  "4. אם יש רקע לא ברור - ציין [לא ברור] ולא תמציא\n" +
  "5. החזר רק את התמלול עצמו, ללא הקדמות או הערות מטא";

export async function transcribeAudio(base64Data: string, mimeType: string): Promise<string> {
  return callGemini({ prompt: TRANSCRIPTION_PROMPT, base64Data, mimeType: mimeType || "audio/ogg" });
}

/** Same prompt as transcribeAudio, but caller picks model/thinking and gets cost+latency back. */
export async function transcribeAudioDetailed(
  base64Data: string,
  mimeType: string,
  override: { model?: string; thinkingLevel?: string },
): Promise<CallGeminiResult> {
  return callGeminiDetailed({
    prompt: TRANSCRIPTION_PROMPT,
    base64Data,
    mimeType: mimeType || "audio/ogg",
    model: override.model,
    thinkingLevel: override.thinkingLevel,
  });
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
