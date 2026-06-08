/**
 * smrtBot — subscriber identity: email collection, OTP ownership verification,
 * self-registration, and the subscriber-aware video link builder.
 *
 * Flow (all in WhatsApp chat, all config-gated — see subscription.ts / the
 * VIDEO_* app_secrets). The phone is the WhatsApp number itself; we only ask
 * for email + first/last name:
 *
 *   connect_email action  → expectedInput=EMAIL
 *   EMAIL        → validate, e-mail a 6-digit OTP, expectedInput=EMAIL_OTP
 *   EMAIL_OTP    → verify code → link phone↔email → checkSubscription:
 *                    known customer  → done (subscriber? inform)
 *                    not_found       → REG_FIRST_NAME
 *   REG_FIRST_NAME → expectedInput=REG_LAST_NAME
 *   REG_LAST_NAME  → registerSubscriber() pushes back to the external API → done
 *
 * Entitlement is NEVER decided here — checkSubscription() (external) is the
 * sole authority. fail-closed: on any doubt the user is treated as a
 * non-subscriber and gets the plain link, never a direct-playback token.
 */
import crypto from "crypto";

import { db } from "../../db";
import { getBotConfig } from "./config";
import { resolveCreds, sendText, sendButtons, type BotEnv } from "./wa";
import { checkSubscription, registerSubscriber, isSubscriptionConfigured } from "./subscription";
import { signPlaybackToken } from "./playback-token";
import type { BotRow } from "./engine";

type State = Record<string, unknown>;

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MS = 15 * 60 * 1000; // issuance rate-limit window
const OTP_MAX_PER_WINDOW = 5; // max codes issued per phone per window

// ── small helpers ────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

async function msg(bot: BotRow, env: BotEnv, key: string, fallback: string): Promise<string> {
  const { data } = await db
    .from("smrtbot_messages")
    .select("text")
    .eq("org_id", bot.org_id)
    .eq("bot_id", bot.id)
    .eq("env", env)
    .eq("msg_key", key)
    .maybeSingle();
  return (data?.text as string) || fallback;
}

async function getState(botId: string, phone: string): Promise<State> {
  const { data } = await db
    .from("smrtbot_wa_users")
    .select("state_json")
    .eq("bot_id", botId)
    .eq("phone", phone)
    .maybeSingle();
  return (data?.state_json as State) ?? {};
}

async function setState(bot: BotRow, phone: string, patch: State): Promise<void> {
  const current = await getState(bot.id, phone);
  const merged = { ...current, ...patch };
  const { error } = await db.from("smrtbot_wa_users").upsert(
    {
      org_id: bot.org_id,
      bot_id: bot.id,
      phone,
      state_json: merged,
      last_interaction_at: new Date().toISOString(),
    },
    { onConflict: "bot_id,phone" },
  );
  if (error) console.error("[smrtbot/identity] setState", error.message);
}

interface WaUserIdentity {
  email: string | null;
  emailVerifiedAt: string | null;
  firstName: string | null;
  lastName: string | null;
  externalCustomerId: string | null;
}

async function getIdentity(bot: BotRow, phone: string): Promise<WaUserIdentity> {
  const { data } = await db
    .from("smrtbot_wa_users")
    .select("email, email_verified_at, first_name, last_name, external_customer_id")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .maybeSingle();
  return {
    email: (data?.email as string | null) ?? null,
    emailVerifiedAt: (data?.email_verified_at as string | null) ?? null,
    firstName: (data?.first_name as string | null) ?? null,
    lastName: (data?.last_name as string | null) ?? null,
    externalCustomerId: (data?.external_customer_id as string | null) ?? null,
  };
}

// ── OTP ──────────────────────────────────────────────────────────────────────
function hashCode(code: string, phone: string): string {
  return crypto.createHash("sha256").update(`${code}:${phone}`).digest("hex");
}

type OtpSendResult = "sent" | "rate_limited" | "failed";

/** Generate, persist, and e-mail a 6-digit OTP. Rate-limited per phone so the
 *  per-code attempt cap can't be bypassed by re-requesting fresh codes. */
async function sendOtp(bot: BotRow, env: BotEnv, phone: string, email: string): Promise<OtpSendResult> {
  const fromEmail = await getBotConfig(bot.id, "VIDEO_OTP_FROM_EMAIL", "VIDEO_OTP_FROM_EMAIL");
  if (!fromEmail) {
    console.error("[smrtbot/identity] VIDEO_OTP_FROM_EMAIL not configured — cannot send OTP");
    return "failed";
  }

  // Throttle issuance: too many codes for this phone in the window → refuse.
  const since = new Date(Date.now() - OTP_WINDOW_MS).toISOString();
  const { count } = await db
    .from("smrtbot_email_otps")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .gte("created_at", since);
  if ((count ?? 0) >= OTP_MAX_PER_WINDOW) return "rate_limited";

  const region = (await getBotConfig(bot.id, "VIDEO_OTP_SES_REGION", "VIDEO_OTP_SES_REGION")) || "us-east-1";
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

  const { error } = await db.from("smrtbot_email_otps").insert({
    org_id: bot.org_id,
    bot_id: bot.id,
    phone,
    email,
    code_hash: hashCode(code, phone),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  if (error) {
    console.error("[smrtbot/identity] otp insert", error.message);
    return "failed";
  }

  const subject = await msg(bot, env, "otp_email_subject", "קוד האימות שלך");
  const bodyTpl = await msg(
    bot,
    env,
    "otp_email_body",
    "קוד האימות שלך הוא: {code}\nהקוד תקף ל-10 דקות.",
  );
  const text = bodyTpl.replace("{code}", code);
  const html =
    `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6">` +
    text
      .split("\n")
      .map((l) => `<p>${l.replace("{code}", code)}</p>`)
      .join("") +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p></div>`;

  try {
    const { sendEmail } = await import("../smrtreach/ses-client");
    await sendEmail({ region, from: fromEmail, to: email, subject, html });
    return "sent";
  } catch (e) {
    console.error("[smrtbot/identity] sendEmail failed", e instanceof Error ? e.message : e);
    return "failed";
  }
}

interface OtpVerifyResult {
  ok: boolean;
  email: string | null;
  reason: "ok" | "none" | "expired" | "locked" | "mismatch";
}

async function verifyOtp(bot: BotRow, phone: string, code: string, email: string): Promise<OtpVerifyResult> {
  const { data } = await db
    .from("smrtbot_email_otps")
    .select("id, email, code_hash, attempts, expires_at, consumed_at")
    .eq("bot_id", bot.id)
    .eq("phone", phone)
    .eq("email", email)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { ok: false, email: null, reason: "none" };
  if (new Date(data.expires_at as string).getTime() < Date.now()) {
    return { ok: false, email: null, reason: "expired" };
  }
  if ((data.attempts as number) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, email: null, reason: "locked" };
  }

  const matches = hashCode(code.trim(), phone) === (data.code_hash as string);
  if (!matches) {
    await db
      .from("smrtbot_email_otps")
      .update({ attempts: (data.attempts as number) + 1 })
      .eq("id", data.id as string);
    return { ok: false, email: null, reason: "mismatch" };
  }

  await db
    .from("smrtbot_email_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", data.id as string);
  return { ok: true, email: data.email as string, reason: "ok" };
}

// ── feature gate ──────────────────────────────────────────────────────────────
/** Identity onboarding is usable only when the subscription API and an OTP
 *  sender are both configured. Otherwise the bot behaves exactly as before. */
export async function isIdentityEnabled(bot: BotRow): Promise<boolean> {
  if (!(await isSubscriptionConfigured(bot.id))) return false;
  const from = await getBotConfig(bot.id, "VIDEO_OTP_FROM_EMAIL", "VIDEO_OTP_FROM_EMAIL");
  return !!from;
}

// ── state machine ──────────────────────────────────────────────────────────────
/**
 * Handle a mid-flow text input for an identity state. Returns true if it
 * consumed the message (so the engine should stop), false otherwise.
 */
export async function handleIdentityInput(
  bot: BotRow,
  env: BotEnv,
  phone: string,
  text: string,
  state: State,
): Promise<boolean> {
  const expected = String(state.expectedInput || "");
  if (!["EMAIL", "EMAIL_OTP", "REG_FIRST_NAME", "REG_LAST_NAME"].includes(expected)) {
    return false;
  }
  const creds = resolveCreds(bot, env);
  if (!creds) return false;

  switch (expected) {
    case "EMAIL": {
      const email = normalizeEmail(text);
      if (!EMAIL_RE.test(email)) {
        await sendText(creds, phone, await msg(bot, env, "email_invalid", "כתובת האימייל לא תקינה. נסו שוב:"));
        return true; // keep waiting for a valid email
      }
      const sent = await sendOtp(bot, env, phone, email);
      if (sent === "rate_limited") {
        await setState(bot, phone, { expectedInput: "", pendingEmail: "" });
        await sendText(
          creds,
          phone,
          await msg(bot, env, "otp_rate_limited", "נשלחו יותר מדי קודים. נסו שוב בעוד כמה דקות."),
        );
        return true;
      }
      if (sent === "failed") {
        await setState(bot, phone, { expectedInput: "", pendingEmail: "" });
        await sendText(
          creds,
          phone,
          await msg(bot, env, "email_send_failed", "לא הצלחנו לשלוח את קוד האימות כרגע. נסו שוב מאוחר יותר."),
        );
        return true;
      }
      await setState(bot, phone, { expectedInput: "EMAIL_OTP", pendingEmail: email });
      await sendText(
        creds,
        phone,
        (await msg(bot, env, "otp_sent", "שלחנו קוד אימות בן 6 ספרות ל-{email}. הקלידו אותו כאן:")).replace(
          "{email}",
          email,
        ),
      );
      return true;
    }

    case "EMAIL_OTP": {
      const pendingEmail = String(state.pendingEmail || "");
      if (!pendingEmail) {
        await setState(bot, phone, { expectedInput: "" });
        await sendText(creds, phone, await msg(bot, env, "otp_expired", "הקוד פג או נחסם. כתבו 'אימייל' כדי להתחיל מחדש."));
        return true;
      }
      const res = await verifyOtp(bot, phone, text, pendingEmail);
      if (!res.ok) {
        if (res.reason === "locked" || res.reason === "none" || res.reason === "expired") {
          await setState(bot, phone, { expectedInput: "" });
          await sendText(
            creds,
            phone,
            await msg(bot, env, "otp_expired", "הקוד פג או נחסם. כתבו 'אימייל' כדי להתחיל מחדש."),
          );
        } else {
          await sendText(creds, phone, await msg(bot, env, "otp_wrong", "הקוד שגוי. נסו שוב:"));
        }
        return true;
      }

      const email = res.email as string;
      const { error: linkErr } = await db
        .from("smrtbot_wa_users")
        .update({ email, email_verified_at: new Date().toISOString() })
        .eq("bot_id", bot.id)
        .eq("phone", phone);
      if (linkErr) {
        // Don't claim success if we couldn't persist the link — keep the user
        // in the OTP step so a retry can re-verify rather than be stuck unlinked.
        console.error("[smrtbot/identity] link email failed", linkErr.message);
        await sendText(creds, phone, await msg(bot, env, "otp_wrong", "הקוד שגוי. נסו שוב:"));
        return true;
      }

      const sub = await checkSubscription(bot.id, email);
      const { error: cacheErr } = await db
        .from("smrtbot_wa_users")
        .update({
          subscriber_status: sub.status,
          external_customer_id: sub.customerId,
          subscription_checked_at: new Date().toISOString(),
        })
        .eq("bot_id", bot.id)
        .eq("phone", phone);
      if (cacheErr) console.error("[smrtbot/identity] cache subscription status failed", cacheErr.message);

      // Unknown email in the external system → collect name + self-register.
      if (sub.status === "not_found") {
        await setState(bot, phone, { expectedInput: "REG_FIRST_NAME", pendingEmail: email });
        await sendText(
          creds,
          phone,
          await msg(bot, env, "reg_first_name", "האימייל אומת! 🎉 כדי להשלים הרשמה — מה השם הפרטי שלכם?"),
        );
        return true;
      }

      await setState(bot, phone, { expectedInput: "" });
      await sendText(
        creds,
        phone,
        sub.subscriber
          ? await msg(bot, env, "verified_subscriber", "האימייל אומת! ✅ הסרטונים ייפתחו אצלכם ישירות.")
          : await msg(bot, env, "verified_not_subscriber", "האימייל אומת! ✅ נראה שאין מנוי פעיל — חדשו כדי לצפות ישירות."),
      );
      return true;
    }

    case "REG_FIRST_NAME": {
      const first = text.trim();
      await setState(bot, phone, { expectedInput: "REG_LAST_NAME", regFirstName: first });
      await sendText(creds, phone, await msg(bot, env, "reg_last_name", "מצוין! ומה שם המשפחה?"));
      return true;
    }

    case "REG_LAST_NAME": {
      const last = text.trim();
      const ident = await getIdentity(bot, phone);
      const email = ident.email || String(state.pendingEmail || "");
      const first = String(state.regFirstName || "");

      const { error: nameErr } = await db
        .from("smrtbot_wa_users")
        .update({ first_name: first, last_name: last })
        .eq("bot_id", bot.id)
        .eq("phone", phone);
      if (nameErr) console.error("[smrtbot/identity] save name failed", nameErr.message);

      const reg = await registerSubscriber(bot.id, { email, phone, firstName: first, lastName: last });
      if (reg.customerId) {
        const { error: custErr } = await db
          .from("smrtbot_wa_users")
          .update({ external_customer_id: reg.customerId })
          .eq("bot_id", bot.id)
          .eq("phone", phone);
        if (custErr) console.error("[smrtbot/identity] save customer id failed", custErr.message);
      }

      await setState(bot, phone, { expectedInput: "", regFirstName: "" });
      await sendText(
        creds,
        phone,
        reg.ok
          ? await msg(bot, env, "reg_done", "נרשמתם בהצלחה! 🎉 מעכשיו הסרטונים ייפתחו אצלכם ישירות.")
          : await msg(bot, env, "reg_failed", "ההרשמה נשמרה אצלנו אך טרם אושרה במערכת. ננסה שוב בהמשך."),
      );
      return true;
    }

    default:
      return false;
  }
}

/** Handle identity-related button/text actions. Returns true if handled. */
export async function handleIdentityAction(bot: BotRow, env: BotEnv, phone: string, action: string): Promise<boolean> {
  if (action !== "connect_email" && action !== "my_account") return false;
  const creds = resolveCreds(bot, env);
  if (!creds) return false;

  if (!(await isIdentityEnabled(bot))) {
    // Feature not configured — do not hijack the conversation.
    return false;
  }

  if (action === "my_account") {
    const ident = await getIdentity(bot, phone);
    if (ident.email && ident.emailVerifiedAt) {
      const sub = await checkSubscription(bot.id, ident.email);
      const tmpl = sub.subscriber
        ? await msg(bot, env, "account_subscriber", "האימייל המקושר: {email}\nמנוי פעיל ✅")
        : await msg(bot, env, "account_not_subscriber", "האימייל המקושר: {email}\nאין מנוי פעיל.");
      await sendText(creds, phone, tmpl.replace("{email}", ident.email));
      return true;
    }
    // fall through to connect when no verified email yet.
  }

  await setState(bot, phone, { expectedInput: "EMAIL", pendingEmail: "" });
  await sendText(
    creds,
    phone,
    await msg(bot, env, "email_prompt", "כדי לצפות בסרטונים ישירות, הזינו את כתובת האימייל שלכם:"),
  );
  return true;
}

// ── subscriber-aware link builder ────────────────────────────────────────────
export interface SubscriberContext {
  /** true when VIDEO_WATCH_BASE_URL is set — links route through the domain. */
  configured: boolean;
  watchBase: string;
  subscriber: boolean;
  email: string | null;
  customerId: string | null;
  orgId: string;
  botId: string | null;
}

/** Resolve the playback context for a phone once per send (one external check). */
export async function getSubscriberContext(bot: BotRow, phone: string): Promise<SubscriberContext> {
  const watchBaseRaw = await getBotConfig(bot.id, "VIDEO_WATCH_BASE_URL", "VIDEO_WATCH_BASE_URL");
  const watchBase = (watchBaseRaw ?? "").replace(/\/+$/, "");
  if (!watchBase) {
    return { configured: false, watchBase: "", subscriber: false, email: null, customerId: null, orgId: bot.org_id, botId: bot.id };
  }

  const ident = await getIdentity(bot, phone);
  const email = ident.emailVerifiedAt ? ident.email : null;
  let subscriber = false;
  let customerId = ident.externalCustomerId;
  if (email) {
    const sub = await checkSubscription(bot.id, email);
    subscriber = sub.subscriber;
    if (sub.customerId) customerId = sub.customerId;
  }
  return { configured: true, watchBase, subscriber, email, customerId, orgId: bot.org_id, botId: bot.id };
}

export interface VideoLinkFields {
  vd_id: string | null;
  video_number: string | null;
  video_link: string | null;
  full_url: string | null;
  display_link: string | null;
}

function rawLinkOf(v: VideoLinkFields): string {
  const raw = String(v.display_link || v.video_link || v.full_url || "").trim();
  return (
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("http")) || raw
  );
}

/**
 * The link to send for a video. When the watch base isn't configured, returns
 * the original raw link (behaviour unchanged). When configured, routes through
 * the domain (domain + video number); a verified subscriber additionally gets
 * a signed playback token so the video opens directly.
 */
export async function watchLinkFor(video: VideoLinkFields, ctx: SubscriberContext): Promise<string> {
  const raw = rawLinkOf(video);
  if (!ctx.configured) return raw;

  const num = String(video.video_number || video.vd_id || "").trim();
  if (!num) return raw;

  let url = `${ctx.watchBase}/${encodeURIComponent(num)}`;
  if (ctx.subscriber && ctx.email) {
    const token = await signPlaybackToken({ v: num, e: ctx.email, c: ctx.customerId, o: ctx.orgId, b: ctx.botId });
    if (token) url += `?t=${token}`;
  }
  return url;
}
