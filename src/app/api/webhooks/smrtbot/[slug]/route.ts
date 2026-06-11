/**
 * smrtBot inbound WhatsApp webhook — per-bot, Vercel Route Handler.
 *
 * Each bot is its own Meta app, so each points its callback at
 *   /api/webhooks/smrtbot/<org_slug>_<bot_slug>   (preferred, globally unique)
 *   /api/webhooks/smrtbot/<bot_slug>              (legacy, still accepted)
 * and verifies against that bot's own verify_token. Runs on Vercel (not the
 * Railway server) so a dyno restart never drops inbound messages — same
 * reasoning as the smrtTask webhook.
 *
 * GET  — Meta verify handshake (hub.challenge) against the bot's verify_token.
 * POST — receive messages: resolve bot by slug, detect env by phone_number_id,
 *        log inbound to smrtbot_bot_logs, ack 200. The conversation engine
 *        (menu/game/FAQ reply) is dispatched from here once ported; until then
 *        inbound is recorded and acknowledged so Meta does not retry.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Constant-time string compare; false (not a throw) on length mismatch. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

type Params = { params: Promise<{ slug: string }> };

interface BotRow {
  id: string;
  org_id: string;
  transport: string;
  app_secret: string | null;
  verify_token: string | null;
  test_verify_token: string | null;
  live_verify_token: string | null;
  test_wa_phone_number_id: string | null;
  live_wa_phone_number_id: string | null;
  wa_phone_number_id: string | null;
}

const BOT_FIELDS =
  "id, org_id, transport, app_secret, verify_token, test_verify_token, live_verify_token, test_wa_phone_number_id, live_wa_phone_number_id, wa_phone_number_id";

/** Resolve a bot from the callback path segment.
 *
 *  The bot `slug` is only unique per org, so the preferred form is the
 *  globally-unique "<org_slug>_<bot_slug>" (org slug is unique, and neither
 *  slug can contain '_', so the first '_' splits unambiguously). The legacy
 *  "<bot_slug>" form is still accepted — a legacy slug can never contain '_',
 *  so the two formats never collide — letting existing Meta callbacks keep
 *  working until they're switched over. */
async function loadBot(ref: string): Promise<BotRow | null> {
  const db = createAdminSupabaseClient();
  if (!db) return null;

  const sep = ref.indexOf("_");
  if (sep > 0) {
    const orgSlug = ref.slice(0, sep);
    const botSlug = ref.slice(sep + 1);
    const { data: org } = await db
      .from("organizations")
      .select("id")
      .eq("slug", orgSlug)
      .maybeSingle();
    if (!org) return null;
    const { data } = await db
      .from("smrtbot_bots")
      .select(BOT_FIELDS)
      .eq("org_id", org.id)
      .eq("slug", botSlug)
      .maybeSingle();
    return (data as BotRow | null) ?? null;
  }

  const { data } = await db.from("smrtbot_bots").select(BOT_FIELDS).eq("slug", ref).maybeSingle();
  return (data as BotRow | null) ?? null;
}

interface InboundForward {
  from: string;
  type: string;
  text?: string;
  buttonId?: string;
}

/** Forward an inbound message to the engine on the Railway server. Resilient:
 *  never throws — the webhook must still ack 200 to Meta. */
async function forwardToEngine(
  botId: string,
  env: "test" | "live",
  message: InboundForward,
): Promise<void> {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL;
  const secret = process.env.SMRTBOT_INTERNAL_SECRET ?? process.env.CRON_SECRET;
  if (!backend || !secret) {
    console.error("[smrtbot-webhook] missing BACKEND_URL / internal secret — cannot forward");
    return;
  }
  try {
    await fetch(`${backend}/api/bot/internal/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-smrtbot-secret": secret },
      body: JSON.stringify({ bot_id: botId, env, message }),
    });
  } catch (e) {
    console.error("[smrtbot-webhook] forward failed", e instanceof Error ? e.message : String(e));
  }
}

// ── GET: Meta verify handshake ───────────────────────────────
export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode !== "subscribe" || !token) {
    return new Response("forbidden", { status: 403 });
  }

  const bot = await loadBot(slug);
  if (!bot) return new Response("not found", { status: 404 });

  const candidates = [bot.verify_token, bot.test_verify_token, bot.live_verify_token].filter(
    (t): t is string => !!t,
  );
  const valid = candidates.some((c) => timingSafeEqualStr(token, c));

  if (valid) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

// ── POST: receive messages ───────────────────────────────────
interface MetaValue {
  metadata?: { phone_number_id?: string };
  messages?: {
    from?: string;
    type?: string;
    text?: { body?: string };
    interactive?: {
      button_reply?: { id?: string; title?: string };
      list_reply?: { id?: string; title?: string };
    };
  }[];
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { slug } = await params;
  // Always ack 200 — Meta retries for days otherwise. Errors are logged.
  try {
    const bot = await loadBot(slug);
    if (!bot) return new Response("ok", { status: 200 });

    // This is the Meta Cloud API callback. Only official ('meta'-transport)
    // bots use it; unofficial ('baileys') bots receive messages over their own
    // WhatsApp-Web socket on the backend, never here. So any POST to this
    // endpoint for a non-meta bot is misrouted or forged — drop it (acking 200
    // so a forged caller gets no signal), which also closes the forged-payload
    // injection vector for unofficial bots.
    if (bot.transport !== "meta") {
      return new Response("ok", { status: 200 });
    }

    // Read the RAW body once — HMAC must run over the exact bytes Meta signed.
    const raw = await request.text();

    // Authenticate the official bot: Meta signs every POST with
    // X-Hub-Signature-256 = HMAC-SHA256(rawBody, app_secret). Each bot is its
    // own Meta app, so resolve the bot's own app_secret first, then the platform
    // META_APP_SECRET env. An official bot CANNOT function without its secret, so
    // require a valid signature: a missing secret (misconfigured / not yet live)
    // or a bad/absent signature ⇒ drop. This is safe — no working official bot
    // operates without its secret — and it actually closes the injection hole
    // rather than relying on the secret being set.
    // NOTE: app_secret is stored plaintext to match this table's existing
    // wa_access_token/verify_token columns; moving smrtbot secrets to Vault
    // (as whatsapp_connections does) is a worthwhile future hardening.
    const appSecret = bot.app_secret ?? process.env.META_APP_SECRET ?? null;
    const sig = request.headers.get("x-hub-signature-256") ?? "";
    const expected = appSecret
      ? "sha256=" + crypto.createHmac("sha256", appSecret).update(raw).digest("hex")
      : null;
    if (!expected || !sig || !timingSafeEqualStr(sig, expected)) {
      console.warn(`[smrtbot-webhook] missing/invalid signature for ${slug} — rejecting`);
      // Ack 200 (so Meta/forged callers get no retry signal) but do not process.
      return new Response("ok", { status: 200 });
    }

    const payload = (() => {
      try {
        return JSON.parse(raw) as { entry?: { changes?: { value?: MetaValue }[] }[] };
      } catch {
        return null;
      }
    })();
    if (!payload?.entry) return new Response("ok", { status: 200 });

    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id ?? "";
        const env =
          phoneNumberId && phoneNumberId === bot.live_wa_phone_number_id
            ? "live"
            : phoneNumberId && phoneNumberId === bot.test_wa_phone_number_id
              ? "test"
              : "live";

        for (const m of value?.messages ?? []) {
          if (!m.from) continue;
          const buttonId =
            m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? undefined;
          const text = m.text?.body ?? undefined;
          // Forward to the engine on the Railway server (it persists the
          // inbound log + runs the conversation flow + sends the reply).
          await forwardToEngine(bot.id, env, {
            from: m.from,
            type: m.type ?? "text",
            text,
            buttonId,
          });
        }
      }
    }
  } catch (e) {
    console.error("[smrtbot-webhook] error", e instanceof Error ? e.message : String(e));
  }
  return new Response("ok", { status: 200 });
}
