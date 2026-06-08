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

import { getAppSecret, db } from "./db";

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

/**
 * Build the per-call thinkingConfig in the shape the target model accepts.
 *
 * Gemini 3 (preview) uses `thinkingLevel: "low"|"medium"|"high"`.
 * Gemini 2.5 uses `thinkingBudget: <int tokens>` — -1 = dynamic (model picks),
 * 0 = off, positive = hard cap.
 *
 * We accept a single string knob ("low"/"medium"/"high") from the operator
 * and translate it per family so the same `GEMINI_THINKING_LEVEL` config
 * works regardless of which model is selected.
 */
function buildThinkingConfig(model: string, level: string): Record<string, unknown> {
  // Gemini 3 line — the API accepts the string directly.
  if (/^gemini-3/.test(model)) {
    return { thinkingLevel: level };
  }
  // Gemini 2.5 line — translate the level to a token budget.
  if (/^gemini-2\.5/.test(model)) {
    const budgets: Record<string, number> = {
      off:     0,
      none:    0,
      low:     1024,
      medium:  4096,
      high:    16384,
      dynamic: -1,
    };
    const budget = budgets[level.toLowerCase()] ?? -1;
    return { thinkingBudget: budget };
  }
  // Unknown family — omit thinkingConfig entirely so we don't trip an
  // INVALID_ARGUMENT error from a parameter the model doesn't recognize.
  return {};
}

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
      thinkingConfig: buildThinkingConfig(model, thinkingLevel),
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

  // Unified cost ledger (best-effort; never blocks the caller).
  try {
    await db.from("ai_usage").insert({
      provider: "google",
      component: "gemini.pdf",
      model,
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
      cost_usd: costUsd,
    });
  } catch { /* ledger insert must not break the caller */ }

  return { text, costUsd, latencyMs, model, thinkingLevel, usage };
}

/** Backwards-compat string wrapper for callers that just want the text. */
export async function callGemini(opts: GeminiCallOptions): Promise<string> {
  return (await callGeminiDetailed(opts)).text;
}

/** Text-only generation (no media) — used by smrtBot's optional AI answering.
 *  Mirrors callGeminiDetailed but sends a single text part. Key + model come
 *  from the platform's app_secrets (GEMINI_API_KEY / GEMINI_MODEL). */
export async function generateText(
  prompt: string,
  opts?: { model?: string; maxOutputTokens?: number },
): Promise<string> {
  const apiKey = await getAppSecret("smrttask", "GEMINI_API_KEY", "GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const model =
    opts?.model ?? (await getAppSecret("smrttask", "GEMINI_MODEL", "GEMINI_MODEL")) ?? "gemini-3-flash-preview";

  const url = `${GEMINI_API_BASE}/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: opts?.maxOutputTokens ?? 1024 },
  };

  const fetchOnce = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  // Gemini routinely returns 503 ("high demand") — one short backoff usually clears it.
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
  const text = candidate?.content?.parts?.filter((p) => p.text).map((p) => p.text).join("\n") ?? "";

  try {
    await db.from("ai_usage").insert({
      provider: "google",
      component: "smrtbot.ai-answer",
      model,
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      cost_usd: estimateGeminiCost(model, data.usageMetadata),
    });
  } catch { /* ledger insert must not break the caller */ }

  return text;
}

/**
 * Transcribe a WhatsApp voice/audio message. Prompt is identical to the
 * Apps Script that's been running in production — multi-language detection,
 * speaker labels, no hallucination on unclear audio.
 */
const TRANSCRIPTION_PROMPT =
  "החזר אך ורק את תוכן הדיבור עצמו, מילה במילה. אסור להוסיף ולו מילה אחת משלך.\n" +
  "• המילה הראשונה והמילה האחרונה בפלט חייבות להיות מתוך הדיבור עצמו.\n" +
  "• בלי שום משפט פתיחה (\"הנה התמלול\", \"בטח, הנה...\", \"להלן התמלול:\") ובלי שום משפט סיום (\"מקווה שעזרתי\", \"זהו\", \"בהצלחה\").\n" +
  "• בלי כותרות, בלי סוגריים מטא, ובלי markdown fences (```).\n" +
  "\n" +
  "חוקי תמלול:\n" +
  "• זהה את שפת הדיבור (עברית/אנגלית/יידיש/אחר) ותמלל באותה שפה — אל תתרגם.\n" +
  "• שמור על סימני פיסוק ופסקאות טבעיות.\n" +
  '• אם יש כמה דוברים — סמן "דובר 1:", "דובר 2:" וכו\'.\n' +
  "• אם יש קטע לא ברור — כתוב [לא ברור]. אסור להמציא.\n" +
  "\n" +
  "הפלט שלך נכנס ישירות לצ'אט של המשתמש כאילו הוא הקליד אותו בעצמו.";

const OCR_PROMPT =
  "חלץ טקסט מהתמונה. חוקים מחייבים:\n" +
  "• אם יש טקסט — חלץ אותו במלואו ובדיוק, שמור על מבנה השורות והפסקאות.\n" +
  "• אם יש כמה שפות — כל אחת בשפתה המקורית, אל תתרגם.\n" +
  "• אם אין טקסט או שהוא מינימלי — תן תיאור תמציתי (משפט אחד) של התמונה.\n" +
  "\n" +
  "פלט: אך ורק התוצאה. בלי הקדמות (\"הנה הטקסט\", \"זהו OCR של התמונה\"),\n" +
  "בלי כותרות, בלי סוגריים מטא, בלי markdown fences. הפלט הולך ישירות ל-UI.";

/**
 * Strip the common preamble patterns Gemini still emits despite instructions:
 * leading "Sure, here's the transcript:", trailing "Hope this helps!",
 * stray ```code fences```, and stray meta-bracket annotations on the first
 * line. Conservative — only kills very high-confidence noise so legitimate
 * transcripts aren't trimmed.
 */
function sanitizeModelOutput(text: string): string {
  let out = text.trim();

  // Strip markdown fences (with or without language tag) wrapping the body.
  if (/^```/.test(out)) {
    out = out.replace(/^```[a-zA-Z0-9]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  // Drop one-line preamble if present. We're CONSERVATIVE — only strip
  // lines that explicitly reference the transcription/OCR meta-task. A
  // user-typed line like "הנה מה שצריך לעשות מחר:" must NOT match, even
  // though it starts with "הנה" and ends in ":".
  //
  // Heuristic: the preamble must (a) start with a preamble verb AND
  // (b) contain a meta-noun (transcript/OCR/text/etc.) AND (c) end with
  // a colon. All three conditions together are very unlikely to appear
  // in legitimate spoken-content transcripts.
  const HE_META  = "תמלול|תרגום|טקסט|פלט|תוצאה|תיאור|פיענוח";
  const EN_META  = "transcript(?:ion)?|ocr|text|output|result|translation|description";
  const preamblePatterns: RegExp[] = [
    new RegExp(`^(?:הנה|להלן|בטח[,!:]?\\s*הנה)[^\\n]{0,80}(?:${HE_META})[^\\n]{0,40}:\\s*\\n+`, "iu"),
    new RegExp(`^(?:here(?:'s| is| are|\\s+you\\s+go)|sure[,!:]?\\s*here|below(?:\\s+is)?)[^\\n]{0,80}(?:${EN_META})[^\\n]{0,40}:\\s*\\n+`, "i"),
    new RegExp(`^the\\s+(?:${EN_META})\\s+(?:is|reads|follows)[^\\n]{0,40}:?\\s*\\n+`, "i"),
    /^\*\*[^\n*]{1,80}\*\*\s*\n+/,                                           // "**Transcription:**"
    new RegExp(`^(?:${HE_META}|${EN_META})\\s*[:：]\\s*\\n+`, "i"),         // bare "תמלול:" or "Transcript:"
  ];
  for (const re of preamblePatterns) {
    const next = out.replace(re, "");
    if (next.length < out.length) { out = next; break; }
  }

  // Drop common closing pleasantries on their own line.
  out = out.replace(/\n+(hope this helps[!.]?|let me know if[^\n]*|מקווה שעזרתי[!.]?|בהצלחה[!.]?)\s*$/i, "");

  return out.trim();
}

export async function transcribeAudio(base64Data: string, mimeType: string): Promise<string> {
  const raw = await callGemini({ prompt: TRANSCRIPTION_PROMPT, base64Data, mimeType: mimeType || "audio/ogg" });
  return sanitizeModelOutput(raw);
}

/** Same prompt as transcribeAudio, but caller picks model/thinking and gets cost+latency back. */
export async function transcribeAudioDetailed(
  base64Data: string,
  mimeType: string,
  override: { model?: string; thinkingLevel?: string },
): Promise<CallGeminiResult> {
  const res = await callGeminiDetailed({
    prompt: TRANSCRIPTION_PROMPT,
    base64Data,
    mimeType: mimeType || "audio/ogg",
    model: override.model,
    thinkingLevel: override.thinkingLevel,
  });
  return { ...res, text: sanitizeModelOutput(res.text) };
}

/**
 * OCR + description for an inbound image. Extracts text verbatim when
 * present, falls back to a one-sentence visual description otherwise.
 */
export async function performImageOcr(base64Data: string, mimeType: string): Promise<string> {
  const raw = await callGemini({ prompt: OCR_PROMPT, base64Data, mimeType: mimeType || "image/jpeg" });
  return sanitizeModelOutput(raw);
}

const DOCUMENT_EXTRACTION_PROMPT =
  "חלץ את הטקסט מהמסמך. חוקים מחייבים:\n" +
  "• חלץ את כל הטקסט במלואו ובדיוק, שמור על סדר הכותרות, הפסקאות והרשימות.\n" +
  "• אם יש כמה שפות — כל אחת בשפתה המקורית, אל תתרגם.\n" +
  "• אם המסמך סרוק/תמונה — בצע OCR. אם אין טקסט קריא — תן תיאור תמציתי (משפט אחד) של תוכן המסמך.\n" +
  "\n" +
  "פלט: אך ורק תוכן המסמך. בלי הקדמות (\"הנה הטקסט\", \"להלן תוכן המסמך\"),\n" +
  "בלי כותרות-על משלך, בלי סוגריים מטא, ובלי markdown fences. הפלט הולך ישירות ל-UI.";

/**
 * Extract text from an inbound document (PDF, etc.) via Gemini. Mirrors
 * performImageOcr but tuned for multi-page text documents.
 */
export async function extractDocumentText(base64Data: string, mimeType: string): Promise<string> {
  const raw = await callGemini({
    prompt: DOCUMENT_EXTRACTION_PROMPT,
    base64Data,
    mimeType: mimeType || "application/pdf",
  });
  return sanitizeModelOutput(raw);
}
