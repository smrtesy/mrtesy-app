/**
 * smrtBot — external subscription system adapter.
 *
 * Identity is by EMAIL. The bot maps a WhatsApp phone → a verified email
 * (see identity.ts); entitlement always comes from the external system, never
 * decided locally. Two endpoints, configured per operator in app_secrets
 * (slug "smrtbot"): SUBSCRIPTION_API_BASE_URL + SUBSCRIPTION_API_SECRET.
 *
 *   POST {base}/api/subscription/check     { email }                → status
 *   POST {base}/api/subscription/register  { email, phone, name... } → created
 *
 * fail-closed: any error / timeout / unconfigured response → NOT a subscriber,
 * so a caller never grants direct playback on doubt.
 */
import { getBotConfig } from "./config";

const TIMEOUT_MS = 5000;

export interface SubscriptionStatus {
  subscriber: boolean;
  /** "active" | "expired" | "cancelled" | "trial" | "not_found" | "error" | null */
  status: string | null;
  plan: string | null;
  expiresAt: string | null;
  customerId: string | null;
  name: string | null;
  /** false when the external API isn't configured yet. */
  configured: boolean;
}

export interface RegisterResult {
  ok: boolean;
  alreadyExisted: boolean;
  customerId: string | null;
  status: string | null;
}

interface ApiConfig {
  base: string;
  secret: string;
}

async function apiConfig(botId: string): Promise<ApiConfig | null> {
  const baseRaw = await getBotConfig(botId, "SUBSCRIPTION_API_BASE_URL", "SUBSCRIPTION_API_BASE_URL");
  const secret = await getBotConfig(botId, "SUBSCRIPTION_API_SECRET", "SUBSCRIPTION_API_SECRET");
  const base = (baseRaw ?? "").replace(/\/+$/, "");
  if (!base || !secret) return null;
  return { base, secret };
}

export async function isSubscriptionConfigured(botId: string): Promise<boolean> {
  return (await apiConfig(botId)) !== null;
}

interface PostResult {
  status: number;
  json: Record<string, unknown> | null;
}

async function post(botId: string, path: string, body: unknown): Promise<PostResult | null> {
  const cfg = await apiConfig(botId);
  if (!cfg) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${cfg.base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const parsed = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: resp.status, json: parsed };
  } catch (e) {
    console.error("[smrtbot/subscription] request failed", path, e instanceof Error ? e.message : e);
    return { status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Check entitlement for an email. fail-closed on any non-200 / error. */
export async function checkSubscription(botId: string, email: string): Promise<SubscriptionStatus> {
  const notSub = (status: string | null, configured: boolean): SubscriptionStatus => ({
    subscriber: false,
    status,
    plan: null,
    expiresAt: null,
    customerId: null,
    name: null,
    configured,
  });

  const res = await post(botId, "/api/subscription/check", { email, context: "whatsapp_link_request" });
  if (!res) return notSub(null, false); // not configured
  // 404 = email unknown to the external system → treated as "not a subscriber".
  if (res.status === 404) return notSub("not_found", true);
  if (res.status !== 200 || !res.json) return notSub("error", true);

  const j = res.json;
  const customer = (j.customer as Record<string, unknown> | undefined) ?? undefined;
  let subscriber = j.subscriber === true;
  const expiresAt = str(j.expires_at);
  // Honor an explicit expiry even if the API said subscriber:true.
  if (subscriber && expiresAt) {
    const exp = Date.parse(expiresAt);
    if (Number.isFinite(exp) && exp < Date.now()) subscriber = false;
  }
  return {
    subscriber,
    status: str(j.status),
    plan: str(j.plan),
    expiresAt,
    customerId: str(customer?.id),
    name: str(customer?.name),
    configured: true,
  };
}

/** Push a self-registration back to the external system. fail-closed. */
export async function registerSubscriber(
  botId: string,
  p: {
    email: string;
    phone: string;
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<RegisterResult> {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  const res = await post(botId, "/api/subscription/register", {
    email: p.email,
    phone: p.phone,
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    name: name || null,
    source: "whatsapp_bot",
    registered_at: new Date().toISOString(),
  });
  if (!res || (res.status !== 200 && res.status !== 201) || !res.json) {
    return { ok: false, alreadyExisted: false, customerId: null, status: null };
  }
  const j = res.json;
  const customer = (j.customer as Record<string, unknown> | undefined) ?? undefined;
  return {
    ok: j.ok === true || res.status === 201,
    alreadyExisted: j.already_existed === true,
    customerId: str(j.customer_id) ?? str(customer?.id),
    status: str(j.status),
  };
}
