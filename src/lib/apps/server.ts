import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side helper to compute the list of app slugs the caller may use in
 * their active org. Used by (app)/layout.tsx (sidebar) and the /settings pages
 * so app visibility is decided in exactly one place.
 *
 * Rules:
 *   • Super-admins and org owners/admins see every app the org has enabled.
 *   • role='member' sees only the apps explicitly granted to them
 *     (`user_app_access`), intersected with what the org has enabled.
 */
export async function getEnabledAppsForActiveOrg(): Promise<string[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  // Super-admins are unrestricted.
  const { data: superAdmin } = await supabase
    .from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isSuperAdmin = !!superAdmin || adminEmails.includes(user.email?.toLowerCase() || "");

  const cookieStore = await cookies();
  let orgId = cookieStore.get("smrt_org_id")?.value;
  if (!orgId) {
    const { data: memberships } = await supabase
      .from("org_members").select("org_id").eq("user_id", user.id).limit(1);
    orgId = memberships?.[0]?.org_id;
  }
  if (!orgId) return [];

  return getEnabledAppsForUserInOrg(supabase, user.id, orgId, isSuperAdmin);
}

/**
 * Core resolution shared by the helper above and (app)/layout.tsx (which has
 * already loaded the user + org + super-admin flag, so it passes them in to
 * avoid re-fetching).
 */
export async function getEnabledAppsForUserInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgId: string,
  isSuperAdmin: boolean,
): Promise<string[]> {
  // Apps the org has enabled.
  const { data: orgApps } = await supabase
    .from("app_memberships")
    .select("app_id, apps(slug)")
    .eq("org_id", orgId);
  const all = (orgApps ?? []).map((r) => {
    const app = Array.isArray(r.apps) ? r.apps[0] : r.apps;
    return { app_id: r.app_id as string, slug: (app as { slug?: string } | null)?.slug ?? "" };
  }).filter((a) => a.slug);

  if (isSuperAdmin) return all.map((a) => a.slug);

  // Owners/admins are unrestricted within their org.
  const { data: roleRow } = await supabase
    .from("org_members").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (roleRow?.role === "owner" || roleRow?.role === "admin") {
    return all.map((a) => a.slug);
  }

  // Regular members: only apps explicitly granted to them.
  const { data: grants } = await supabase
    .from("user_app_access").select("app_id").eq("org_id", orgId).eq("user_id", userId);
  const granted = new Set((grants ?? []).map((g) => g.app_id as string));
  return all.filter((a) => granted.has(a.app_id)).map((a) => a.slug);
}
