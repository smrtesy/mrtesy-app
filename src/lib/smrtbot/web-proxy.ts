/**
 * smrtBot web-chat — public proxy helpers (Vercel ↔ Railway).
 *
 * The embeddable widget runs on arbitrary customer sites, so these routes are
 * public + CORS-enabled. They never expose the internal secret: each request is
 * validated (bot exists, web_enabled, origin allowlist) and forwarded to the
 * Railway engine's shared-secret /api/bot/internal/web-* endpoints.
 */
import { NextRequest } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export interface WebBotConfig {
  id: string;
  org_id: string;
  web_enabled: boolean | null;
  web_allowed_origins: string[] | null;
}

/** Resolve a bot from its public, globally-unique web embed key. The slug is
 *  only unique per org, so it can't identify a bot from an anonymous request. */
export async function loadWebBot(webKey: string): Promise<WebBotConfig | null> {
  const db = createAdminSupabaseClient();
  if (!db || !webKey) return null;
  const { data } = await db
    .from("smrtbot_bots")
    .select("id, org_id, web_enabled, web_allowed_origins")
    .eq("web_key", webKey)
    .maybeSingle();
  return (data as WebBotConfig | null) ?? null;
}

/** Whether an Origin may embed this bot. Empty allowlist = any origin (handy
 *  while testing); configure the customer's site origins for production. */
export function originAllowed(bot: WebBotConfig, origin: string | null): boolean {
  const list = bot.web_allowed_origins ?? [];
  if (list.length === 0) return true;
  if (!origin) return false;
  return list.includes(origin);
}

/** CORS headers that echo the caller's origin when allowed. The widget sends
 *  simple JSON (no credentials), so we don't set Allow-Credentials. */
export function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowed && origin ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function jsonWithCors(
  body: unknown,
  status: number,
  origin: string | null,
  allowed: boolean,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, allowed) },
  });
}

/** Preflight handler shared by every web-chat route. */
export async function handleOptions(
  request: NextRequest,
  webKey: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const bot = await loadWebBot(webKey);
  const allowed = bot ? originAllowed(bot, origin) : false;
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
}

/** Forward a validated request to the Railway engine's internal web endpoint. */
export async function forwardToEngine(
  path: "web-start" | "web-message",
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL;
  const secret = process.env.SMRTBOT_INTERNAL_SECRET ?? process.env.CRON_SECRET;
  if (!backend || !secret) {
    return { status: 500, body: { error: "backend not configured" } };
  }
  try {
    const resp = await fetch(`${backend}/api/bot/internal/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-smrtbot-secret": secret },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    return { status: resp.status, body };
  } catch (e) {
    return { status: 502, body: { error: e instanceof Error ? e.message : "engine unreachable" } };
  }
}

export async function fetchHistory(
  sessionToken: string,
  since: string | null,
): Promise<{ status: number; body: unknown }> {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL;
  const secret = process.env.SMRTBOT_INTERNAL_SECRET ?? process.env.CRON_SECRET;
  if (!backend || !secret) {
    return { status: 500, body: { error: "backend not configured" } };
  }
  const url = new URL(`${backend}/api/bot/internal/web-history`);
  url.searchParams.set("session_token", sessionToken);
  if (since) url.searchParams.set("since", since);
  try {
    const resp = await fetch(url.toString(), { headers: { "x-smrtbot-secret": secret } });
    const body = await resp.json().catch(() => ({}));
    return { status: resp.status, body };
  } catch (e) {
    return { status: 502, body: { error: e instanceof Error ? e.message : "engine unreachable" } };
  }
}
