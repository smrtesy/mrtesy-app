// System-wide logs for the admin Logs tab.
//
// log_entries has RLS `user_id = auth.uid()`, so the browser client only ever
// sees the admin's OWN rows — which made the Logs page look empty/broken. This
// route re-checks super-admin from the session and reads the table with the
// service-role client (RLS bypassed) so the admin sees platform-wide logs.

export const dynamic = "force-dynamic";

import { getSuperAdminUser } from "@/lib/supabase/admin-guard";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

const LEVELS = new Set(["info", "warning", "error"]);

export async function GET(req: Request) {
  const user = await getSuperAdminUser();
  if (!user) return Response.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  if (!admin) return Response.json({ error: "service_role_missing" }, { status: 500 });

  const url = new URL(req.url);
  const level = url.searchParams.get("level");
  const range = url.searchParams.get("range") ?? "today";

  let query = admin
    .from("log_entries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (level && LEVELS.has(level)) query = query.eq("level", level);

  const now = Date.now();
  let since: string | null = null;
  if (range === "today") {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    since = start.toISOString();
  } else if (range === "7d") {
    since = new Date(now - 7 * 86400000).toISOString();
  } else if (range === "30d") {
    since = new Date(now - 30 * 86400000).toISOString();
  }
  if (since) query = query.gte("created_at", since);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ logs: data ?? [] });
}
