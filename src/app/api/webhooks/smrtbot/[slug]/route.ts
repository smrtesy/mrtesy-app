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

/** Best-effort diagnostic log of each webhook hit + outcome (smrtbot_webhook_debug).
 *  Visible from the bot's "Webhook log" tab so connection issues are debuggable.
 *  Never throws — diagnostics must not affect the 200 ack. */
async function logHit(
  orgId: string | null,
  botId: string | null,
  slug: string,
  outcome: string,
  detail?: string,
): Promise<void> {
  try {
    const db = createAdminSupabaseClient();
    if (db) await db.from("smrtbot_webhook_debug").insert({ org_id: orgId, bot_id: botId, slug, outcome, detail: detail ?? null });
  } catch {
    /* diagnostic only */
  }
}

interface BotRow {
  id: string;
  org_id: string;
  transport: string;
  app_secret: string | null;
  live_app_secret_id: string | null;
  test_app_secret_id: string | null;
  verify_token: string | null;
  test_verify_token: string | null;
  live_verify_token: string | null;
  test_wa_phone_number_id: string | null;
  live_wa_phone_number_id: string | null;
  wa_phone_number_id: string | null;
}

const BOT_FIELDS =
  "id, org_id, transport, app_secret, live_app_secret_id, test_app_secret_id, verify_token, test_verify_token, live_verify_token, test_wa_phone_number_id, live_wa_phone_number_id, wa_phone_number_id";

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
 *  never throws — the webhook must still ack 200 to Meta. Returns the outcome so
 *  the diagnostic log can show exactly why a forward didn't reach the engine. */
async function forwardToEngine(
  botId: string,
  env: "test" | "live",
  message: InboundForward,
): Promise<{ ok: boolean; detail: string }> {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL;
  const secret = process.env.SMRTBOT_INTERNAL_SECRET ?? process.env.CRON_SECRET;
  if (!backend) return { ok: false, detail: "no BACKEND_URL env" };
  if (!secret) return { ok: false, detail: "no SMRTBOT_INTERNAL_SECRET env" };
  try {
    const res = await fetch(`${backend}/api/bot/internal/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-smrtbot-secret": secret },
      body: JSON.stringify({ bot_id: botId, env, message }),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `fetch error: ${e instanceof Error ? e.message : String(e)}` };
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
    if (!bot) {
      await logHit(null, null, slug, "bot_not_found");
      return new Response("ok", { status: 200 });
    }

    // This is the Meta Cloud API callback. Only official ('meta'-transport)
    // bots use it; unofficial ('baileys') bots receive messages over their own
    // WhatsApp-Web socket on the backend, never here. So any POST to this
    // endpoint for a non-meta bot is misrouted or forged — drop it (acking 200
    // so a forged caller gets no signal), which also closes the forged-payload
    // injection vector for unofficial bots.
    if (bot.transport !== "meta") {
      await logHit(bot.org_id, bot.id, slug, "not_meta", bot.transport);
      return new Response("ok", { status: 200 });
    }

    // Read the RAW body once — HMAC must run over the exact bytes Meta signed.
    const raw = await request.text();

    // Optional Meta HMAC verification. Meta signs each POST with
    // X-Hub-Signature-256 = HMAC-SHA256(rawBody, app_secret). We verify ONLY
    // when an App Secret is configured for the bot — if none is set the message
    // is processed unverified (like the legacy Apps-Script bot, which did no
    // signature check). Less secure: anyone who knows the callback URL could
    // POST forged events; set an App Secret to enforce.
    // NOTE: the table has a single app_secret, while a bot's live/test phone
    // numbers may belong to different Meta apps with different secrets — so
    // verification can only ever match one env. Leaving it empty (unverified)
    // is the simplest way to support both; per-env secrets are a future option.
    // Gather candidate App Secrets: the per-env Vault secrets (live + test, since
    // a bot's two phone numbers can be different Meta apps), the legacy plaintext
    // column, and the platform env. A signature is valid if it matches ANY — so
    // both environments are verified without needing to know the env yet.
    const candidates: string[] = [];
    const sdb = createAdminSupabaseClient();
    if (sdb) {
      for (const sid of [bot.live_app_secret_id, bot.test_app_secret_id]) {
        if (!sid) continue;
        const { data, error } = await sdb.rpc("vault_read_secret", { secret_id: sid });
        if (error) await logHit(bot.org_id, bot.id, slug, "vault_read_error", `${sid}: ${error.message}`);
        else if (typeof data === "string" && data.trim()) candidates.push(data);
      }
    }
    if (bot.app_secret?.trim()) candidates.push(bot.app_secret);
    if (process.env.META_APP_SECRET) candidates.push(process.env.META_APP_SECRET);

    const sig = request.headers.get("x-hub-signature-256") ?? "";
    await logHit(bot.org_id, bot.id, slug, "received", sig ? "signed" : "unsigned");
    if (candidates.length > 0) {
      const valid =
        !!sig &&
        candidates.some((s) => timingSafeEqualStr(sig, "sha256=" + crypto.createHmac("sha256", s).update(raw).digest("hex")));
      if (!valid) {
        console.warn(`[smrtbot-webhook] invalid signature for ${slug} — rejecting`);
        await logHit(bot.org_id, bot.id, slug, "bad_signature", sig ? "sig_present" : "sig_absent");
        // Ack 200 (so Meta/forged callers get no retry signal) but do not process.
        return new Response("ok", { status: 200 });
      }
    } else {
      await logHit(bot.org_id, bot.id, slug, "unverified", "no app secret — signature not checked");
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
          // inbound log + runs the conversation flow + sends the reply), and
          // record the forward OUTCOME so a stuck hop is visible in the log.
          const r = await forwardToEngine(bot.id, env, {
            from: m.from,
            type: m.type ?? "text",
            text,
            buttonId,
          });
          await logHit(bot.org_id, bot.id, slug, r.ok ? "forwarded_ok" : "forward_failed", `${m.from}|env=${env}|${r.detail}`);
        }
      }
    }
  } catch (e) {
    console.error("[smrtbot-webhook] error", e instanceof Error ? e.message : String(e));
  }
  return new Response("ok", { status: 200 });
}
