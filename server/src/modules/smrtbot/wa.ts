/**
 * smrtBot — WhatsApp transport (Meta Cloud API).
 *
 * Owns the outbound send stack: credential resolution per env, a per-number
 * throttle, and retry on rate-limit / 5xx. This is the seam smrtReach calls
 * for broadcast campaigns (see send-service.ts) — no other module talks to
 * Meta directly.
 *
 * Ported from botsite/src/modules/wa.js.
 */
import { metaErrorSummary } from "./meta-errors";

const META_API_VERSION = "v23.0";
const MIN_GAP_MS = 500; // minimum gap between messages on the same number
const MAX_RETRIES = 3;

// Meta error codes that are transient / rate-limit related and worth a backoff
// retry. Crucially these are delivered as HTTP 400 (not 429), so the plain
// status check below would never retry them. We deliberately exclude permanent
// 400s — bad payload (#100/#131009), re-engagement/#131047 (24h window closed),
// undeliverable/#131026 — since retrying those just burns attempts.
// Ref: Cloud API error codes (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
const RETRYABLE_META_CODES = new Set<number>([
  131056, // (pair rate limit) too many messages to this recipient too fast
  80007, //  rate limit hit
  131048, // spam rate limit hit
]);

/** True when Meta's JSON error body carries a transient/rate-limit code that a
 *  short backoff can plausibly clear. Meta puts the actionable code in
 *  `error.code`, occasionally in `error.error_subcode` — check both. */
function retryableMetaError(detail: string): boolean {
  try {
    const j = JSON.parse(detail) as { error?: { code?: number; error_subcode?: number } };
    const code = j.error?.code;
    const sub = j.error?.error_subcode;
    return (code != null && RETRYABLE_META_CODES.has(code)) ||
      (sub != null && RETRYABLE_META_CODES.has(sub));
  } catch {
    return false;
  }
}

export type BotEnv = "test" | "live";

/** Minimal shape of a smrtbot_bots row needed to send. */
export interface BotCreds {
  test_wa_phone_number_id?: string | null;
  test_wa_access_token?: string | null;
  live_wa_phone_number_id?: string | null;
  live_wa_access_token?: string | null;
  wa_phone_number_id?: string | null;
  wa_access_token?: string | null;
}

export interface ResolvedCreds {
  phoneNumberId: string;
  accessToken: string;
}

/** Resolve the phone_number_id + access_token for a bot in a given env,
 *  falling back to the legacy single-env credentials. */
export function resolveCreds(bot: BotCreds, env: BotEnv): ResolvedCreds | null {
  const phoneNumberId =
    (env === "live" ? bot.live_wa_phone_number_id : bot.test_wa_phone_number_id) ||
    bot.wa_phone_number_id ||
    null;
  const accessToken =
    (env === "live" ? bot.live_wa_access_token : bot.test_wa_access_token) ||
    bot.wa_access_token ||
    null;
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}

/** A Meta message template, flattened for the smrtReach picker. */
export interface WaTemplate {
  name: string;
  language: string;
  status: string;      // APPROVED | PENDING | REJECTED | ...
  category: string;    // MARKETING | UTILITY | AUTHENTICATION
  body: string;        // BODY component text (with {{1}} placeholders)
  paramCount: number;  // number of {{n}} placeholders in the body
}

/**
 * List the WhatsApp message templates for a WABA from Meta. Read-only; used by
 * the smrtReach campaign editor to pick an approved template. Needs the WABA id
 * (whatsapp_business_account) and an access token with whatsapp_business_management.
 */
export async function listTemplates(wabaId: string, accessToken: string): Promise<WaTemplate[]> {
  const url =
    `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/message_templates` +
    `?fields=name,language,status,category,components&limit=200&access_token=${encodeURIComponent(accessToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new WhatsAppSendError(metaErrorSummary(resp.status, detail), resp.status, detail);
  }
  const json = (await resp.json()) as {
    data?: { name: string; language: string; status: string; category: string; components?: { type: string; text?: string }[] }[];
  };
  return (json.data ?? []).map((tpl) => {
    const body = tpl.components?.find((c) => c.type === "BODY")?.text ?? "";
    const paramCount = (body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
    return {
      name: tpl.name,
      language: tpl.language,
      status: tpl.status,
      category: tpl.category,
      body,
      paramCount,
    };
  });
}

// Per-number throttle: timestamp of the last send keyed by phone_number_id.
const lastSentAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class WhatsAppSendError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

/** Low-level send of a fully-formed Meta message payload (without `to`). */
async function send(
  creds: ResolvedCreds,
  to: string,
  message: Record<string, unknown>,
): Promise<{ wa_message_id: string | null }> {
  // Throttle per number.
  const prev = lastSentAt.get(creds.phoneNumberId) ?? 0;
  const wait = MIN_GAP_MS - (Date.now() - prev);
  if (wait > 0) await sleep(wait);
  lastSentAt.set(creds.phoneNumberId, Date.now());

  const url = `https://graph.facebook.com/${META_API_VERSION}/${creds.phoneNumberId}/messages`;
  const body = JSON.stringify({ messaging_product: "whatsapp", to, ...message });

  let lastErr: WhatsAppSendError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (resp.ok) {
      const json = (await resp.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
      };
      return { wa_message_id: json.messages?.[0]?.id ?? null };
    }

    const status = resp.status;
    const detail = await resp.text().catch(() => "");
    lastErr = new WhatsAppSendError(metaErrorSummary(status, detail), status, detail);

    // Retry on rate-limit (429), transient server errors (5xx), and the
    // transient Meta rate-limit codes that arrive as HTTP 400 (e.g. #131056
    // pair rate limit) — those would otherwise fail on the first attempt.
    const retryable = status === 429 || status >= 500 || (status === 400 && retryableMetaError(detail));
    if (!retryable || attempt === MAX_RETRIES) break;
    await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
  }
  throw lastErr ?? new WhatsAppSendError("Unknown send failure", 0);
}

export function sendText(creds: ResolvedCreds, to: string, text: string) {
  return send(creds, to, { type: "text", text: { body: text, preview_url: true } });
}

export interface ReplyButton {
  id: string;
  title: string;
}

export function sendButtons(
  creds: ResolvedCreds,
  to: string,
  bodyText: string,
  buttons: ReplyButton[],
) {
  return send(creds, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export function sendList(
  creds: ResolvedCreds,
  to: string,
  bodyText: string,
  buttonLabel: string,
  rows: ListRow[],
  sectionTitle = "",
) {
  return send(creds, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [
          {
            title: sectionTitle.slice(0, 24),
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

export function sendImage(
  creds: ResolvedCreds,
  to: string,
  imageUrl: string,
  caption?: string,
) {
  return send(creds, to, {
    type: "image",
    image: { link: imageUrl, ...(caption ? { caption } : {}) },
  });
}

/** Send an approved Meta template (used by smrtReach broadcasts). */
export function sendTemplate(
  creds: ResolvedCreds,
  to: string,
  templateName: string,
  languageCode: string,
  components?: unknown[],
) {
  return send(creds, to, {
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
}
