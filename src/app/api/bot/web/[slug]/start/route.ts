/**
 * smrtBot web-chat — public session-start endpoint.
 *
 * Called by the embeddable widget when a visitor submits the lead form. Opens
 * a session on the Railway engine (which sends the welcome) and returns the
 * session token + the initial messages the widget renders. CORS-enabled.
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
    lead?: { name?: string; email?: string; phone?: string };
  };
  const email = (body.lead?.email ?? "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonWithCors({ error: "a valid email is required" }, 400, origin, allowed);
  }

  const { status, body: result } = await forwardToEngine("web-start", {
    slug,
    lead: { name: body.lead?.name, email, phone: body.lead?.phone },
    origin: origin ?? undefined,
    user_agent: request.headers.get("user-agent") ?? undefined,
  });
  return jsonWithCors(result, status, origin, allowed);
}
