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

/** Normalize app_memberships rows (apps join may come back object or array). */
function mapOrgApps(
  orgApps: { app_id: unknown; apps: unknown }[] | null,
): { app_id: string; slug: string }[] {
  return (orgApps ?? []).map((r) => {
    const app = Array.isArray(r.apps) ? r.apps[0] : r.apps;
    return { app_id: r.app_id as string, slug: (app as { slug?: string } | null)?.slug ?? "" };
  }).filter((a) => a.slug);
}

/**
 * Fire the three queries that decide app visibility. They depend only on
 * userId + orgId — NOT on the super-admin flag — so callers that don't yet
 * know that flag (e.g. (app)/layout.tsx, which checks super_admins in the
 * same round-trip) can start them early and pass the flag to
 * `resolveEnabledApps` afterwards.
 *
 * PostgrestBuilders are lazy thenables (nothing hits the network until
 * `.then()`), so each one is wrapped in `Promise.resolve()` to force it to
 * start executing immediately. All three run in a single parallel round-trip.
 */
export function startEnabledAppsQueries(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgId: string,
) {
  return {
    // Apps the org has enabled.
    orgApps: Promise.resolve(
      supabase.from("app_memberships").select("app_id, apps(slug)").eq("org_id", orgId),
    ),
    // The caller's role in the org (read only for non-super-admins).
    roleRow: Promise.resolve(
      supabase.from("org_members").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle(),
    ),
    // Per-user grants (read only for role='member').
    grants: Promise.resolve(
      supabase.from("user_app_access").select("app_id").eq("org_id", orgId).eq("user_id", userId),
    ),
  };
}

/**
 * Apply the visibility rules to the results of `startEnabledAppsQueries`.
 * Same decision tree as before the parallelization: super-admin → all org
 * apps; owner/admin → all org apps; member → granted ∩ enabled.
 */
export async function resolveEnabledApps(
  queries: ReturnType<typeof startEnabledAppsQueries>,
  isSuperAdmin: boolean,
): Promise<string[]> {
  const { data: orgApps } = await queries.orgApps;
  const all = mapOrgApps(orgApps);

  if (isSuperAdmin) return all.map((a) => a.slug);

  // Owners/admins are unrestricted within their org.
  const { data: roleRow } = await queries.roleRow;
  if (roleRow?.role === "owner" || roleRow?.role === "admin") {
    return all.map((a) => a.slug);
  }

  // Regular members: only apps explicitly granted to them.
  const { data: grants } = await queries.grants;
  const granted = new Set((grants ?? []).map((g) => g.app_id as string));
  return all.filter((a) => granted.has(a.app_id)).map((a) => a.slug);
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
  if (isSuperAdmin) {
    // Super-admins only ever read the org-apps list — don't fire the
    // role/grants queries they'd never look at.
    const { data: orgApps } = await supabase
      .from("app_memberships").select("app_id, apps(slug)").eq("org_id", orgId);
    return mapOrgApps(orgApps).map((a) => a.slug);
  }
  // Non-super-admins: run all three queries in one parallel round-trip
  // instead of the old orgApps → role → grants serial chain. (For
  // owners/admins the grants result goes unread — one cheap indexed select
  // traded for a full round-trip saved on every member navigation.)
  return resolveEnabledApps(startEnabledAppsQueries(supabase, userId, orgId), false);
}
