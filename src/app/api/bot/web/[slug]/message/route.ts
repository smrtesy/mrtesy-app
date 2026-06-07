/**
 * smrtBot web-chat — public message endpoint.
 *
 * A visitor turn (free text or a tapped button id). Forwarded to the Railway
 * engine, which replies over Realtime. CORS-enabled.
 */
import { NextRequest } from "next/server";
import {
  loadWebBot,
  originAllowed,
  jsonWithCors,
  handleOptions,
  forwardToEngine,
} from "@/lib/smrtbot/web-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function OPTIONS(request: NextRequest, { params }: Params): Promise<Response> {
  const { slug } = await params;
  return handleOptions(request, slug);
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const origin = request.headers.get("origin");

  const bot = await loadWebBot(slug);
  if (!bot || !bot.web_enabled) {
    return jsonWithCors({ error: "bot not found" }, 404, origin, false);
  }
  const allowed = originAllowed(bot, origin);
  if (!allowed) {
    return jsonWithCors({ error: "origin not allowed" }, 403, origin, false);
  }

  const body = (await request.json().catch(() => ({}))) as {
    session_token?: string;
    text?: string;
    buttonId?: string;
  };
  if (!body.session_token || (!body.text && !body.buttonId)) {
    return jsonWithCors({ error: "session_token and text or buttonId are required" }, 400, origin, allowed);
  }

  const { status, body: result } = await forwardToEngine("web-message", {
    session_token: body.session_token,
    text: body.text,
    buttonId: body.buttonId,
  });
  return jsonWithCors(result, status, origin, allowed);
}
