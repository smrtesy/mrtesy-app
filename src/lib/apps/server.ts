import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side helper to compute the list of app slugs enabled for the
 * caller's active org. Mirrors the logic in (app)/layout.tsx so individual
 * pages (e.g. /settings) can gate their UI without duplicating the query.
 */
export async function getEnabledAppsForActiveOrg(): Promise<string[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get("smrt_org_id")?.value;

  async function fetchFor(orgId: string): Promise<string[]> {
    const { data } = await supabase
      .from("app_memberships")
      .select("apps(slug)")
      .eq("org_id", orgId);
    return (data ?? []).map((r) => {
      const app = Array.isArray(r.apps) ? r.apps[0] : r.apps;
      return (app as { slug?: string } | null)?.slug ?? "";
    }).filter(Boolean);
  }

  if (activeOrgId) return fetchFor(activeOrgId);

  const { data: memberships } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1);
  const firstOrgId = memberships?.[0]?.org_id;
  return firstOrgId ? fetchFor(firstOrgId) : [];
}
