/**
 * smrtBot web-chat — public history endpoint.
 *
 * Lets the widget rebuild the thread after a reload/reconnect (it keeps the
 * session token in localStorage). CORS-enabled.
 */
import { NextRequest } from "next/server";
import {
  loadWebBot,
  originAllowed,
  jsonWithCors,
  handleOptions,
  fetchHistory,
} from "@/lib/smrtbot/web-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

export async function OPTIONS(request: NextRequest, { params }: Params): Promise<Response> {
  const { key } = await params;
  return handleOptions(request, key);
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { key } = await params;
  const origin = request.headers.get("origin");

  const bot = await loadWebBot(key);
  if (!bot || !bot.web_enabled) {
    return jsonWithCors({ error: "bot not found" }, 404, origin, false);
  }
  const allowed = originAllowed(bot, origin);
  if (!allowed) {
    return jsonWithCors({ error: "origin not allowed" }, 403, origin, false);
  }

  const url = new URL(request.url);
  const sessionToken = url.searchParams.get("session_token");
  const since = url.searchParams.get("since");
  if (!sessionToken) {
    return jsonWithCors({ error: "session_token is required" }, 400, origin, allowed);
  }

  const { status, body: result } = await fetchHistory(sessionToken, since);
  return jsonWithCors(result, status, origin, allowed);
}
