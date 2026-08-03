import { createClient } from "@/lib/supabase/server";
import { RESTRICTABLE_RESOURCES, getResource } from "./registry";

/**
 * Compute the resource keys the signed-in user is BLOCKED on in their active
 * org — the frontend twin of the backend's `computeRestrictedSet`. Resolved
 * once in (app)/layout.tsx and published via AppAccessContext so screens and
 * panes gate on exactly the same set the backend enforces.
 *
 * A resource is blocked when the org marks it restricted (org_restrictions,
 * falling back to the registry default) AND the user has no active exception
 * (user_resource_grants). Owners/admins/super-admins bypass everything → [].
 *
 * Reads run under the caller's RLS-bound session: org_restrictions is readable
 * by any org member, user_resource_grants by its owner — both covered by the
 * phase-1 migration's SELECT policies.
 */
export async function getRestrictedResourcesForUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgId: string,
  role: "owner" | "admin" | "member" | null,
  isSuperAdmin: boolean,
): Promise<string[]> {
  if (isSuperAdmin || role === "owner" || role === "admin") return [];

  const [restrictionsRes, grantsRes] = await Promise.all([
    supabase.from("org_restrictions").select("resource_key, restricted").eq("org_id", orgId),
    supabase
      .from("user_resource_grants")
      .select("resource_key")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .is("revoked_at", null),
  ]);

  // Fail CLOSED: if we can't read the org's restrictions or the user's grants,
  // don't silently treat the user as unrestricted (that would leak a restricted
  // screen). Block every enforced resource until the next successful read; the
  // backend requireResource is the real gate, so this only affects visibility.
  if (restrictionsRes.error || grantsRes.error) {
    return RESTRICTABLE_RESOURCES.filter((r) => r.enforced !== false).map((r) => r.key);
  }

  const orgMap = new Map<string, boolean>();
  for (const row of restrictionsRes.data ?? []) {
    orgMap.set(row.resource_key as string, row.restricted as boolean);
  }
  const granted = new Set((grantsRes.data ?? []).map((g) => g.resource_key as string));

  return RESTRICTABLE_RESOURCES.filter((r) => {
    const restricted = orgMap.get(r.key) ?? getResource(r.key)?.defaultRestricted ?? false;
    return restricted && !granted.has(r.key);
  }).map((r) => r.key);
}
