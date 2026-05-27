import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Returns the current user IFF they are a super-admin, else null.
 *
 * Mirrors the gate in the /admin layout: a row in `super_admins` (the
 * self-read RLS policy lets the user see their own row) OR an email listed
 * in the ADMIN_EMAIL env fallback. Use this to guard standalone admin API
 * routes that don't sit under the /admin layout.
 */
export async function getSuperAdminUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: row } = await supabase
    .from("super_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const ok = !!row || adminEmails.includes(user.email?.toLowerCase() || "");
  return ok ? user : null;
}
