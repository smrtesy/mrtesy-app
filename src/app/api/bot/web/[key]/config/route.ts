/**
 * smrtBot web-chat — public launcher config.
 *
 * The embed loader (smrtbot-widget.js) fetches this to render the floating
 * launcher: accent, icon, position, size, and the bot's ROOT MENU buttons so
 * hovering the icon fans them out. Clicking one opens the chat pre-filled with
 * that option. Read-only, anonymous, CORS-enabled — keyed by the public
 * web_key, so the embed snippet only ever carries the key.
 */
import { NextRequest } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { originAllowed, jsonWithCors, handleOptions } from "@/lib/smrtbot/web-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

interface BotConfigRow {
  id: string;
  org_id: string;
  web_enabled: boolean | null;
  web_allowed_origins: string[] | null;
  web_env: string | null;
  web_accent_color: string | null;
  web_icon_url: string | null;
  web_position: string | null;
  web_size: string | null;
}

interface MenuNodeRow {
  node_key: string;
  parent_key: string | null;
  buttons: { id?: string; title?: string; label?: string; value?: string }[] | null;
}

/** Mirror engine.ts findRootNode: the welcome/root menu node. */
function findRoot(nodes: MenuNodeRow[]): MenuNodeRow | null {
  const byKey = (k: string) => nodes.find((n) => n.node_key === k);
  return (
    byKey("main") ||
    byKey("main_welcome") ||
    byKey("main_menu") ||
    nodes.find((n) => !n.parent_key && (n.buttons?.length ?? 0) > 0) ||
    nodes[0] ||
    null
  );
}

export async function OPTIONS(request: NextRequest, { params }: Params): Promise<Response> {
  const { key } = await params;
  return handleOptions(request, key);
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { key } = await params;
  const origin = request.headers.get("origin");

  const db = createAdminSupabaseClient();
  if (!db || !key) return jsonWithCors({ error: "bot not found" }, 404, origin, false);

  const { data: bot } = await db
    .from("smrtbot_bots")
    .select(
      "id, org_id, web_enabled, web_allowed_origins, web_env, web_accent_color, web_icon_url, web_position, web_size",
    )
    .eq("web_key", key)
    .maybeSingle();
  const cfg = bot as BotConfigRow | null;
  if (!cfg || !cfg.web_enabled) {
    return jsonWithCors({ error: "bot not found" }, 404, origin, false);
  }
  const allowed = originAllowed(cfg, origin);
  if (!allowed) return jsonWithCors({ error: "origin not allowed" }, 403, origin, false);

  // Root-menu buttons for the hover fan (same env the chat uses).
  const env = cfg.web_env === "test" ? "test" : "live";
  const { data: nodeData } = await db
    .from("smrtbot_menu_nodes")
    .select("node_key, parent_key, buttons")
    .eq("org_id", cfg.org_id)
    .eq("bot_id", cfg.id)
    .eq("env", env)
    .eq("active", true)
    .order("sort_order");
  const root = findRoot((nodeData as MenuNodeRow[]) ?? []);
  const menu = (root?.buttons ?? [])
    .map((b) => ({ id: b.id ?? b.value, title: b.title ?? b.label }))
    .filter((b): b is { id: string; title: string } => !!b.id && !!b.title)
    .slice(0, 6);

  return jsonWithCors(
    {
      accent: cfg.web_accent_color ?? "#2563eb",
      icon_url: cfg.web_icon_url ?? null,
      position: cfg.web_position === "left" ? "left" : "right",
      size: cfg.web_size ?? "standard",
      menu,
    },
    200,
    origin,
    allowed,
  );
}
