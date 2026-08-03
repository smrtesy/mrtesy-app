/**
 * Permission resolution — the shared decision logic behind `requireResource`
 * and the /org/permissions endpoints.
 *
 * Model (docs/permissions-management-plan.md): a resource is restricted for a
 * user when the org has marked it restricted (org_restrictions, falling back to
 * the registry default) AND the user has no active exception
 * (user_resource_grants). Owners/admins/super-admins bypass everything.
 *
 * Caching mirrors requireApp: positive+negative maps with a 60s TTL, plus an
 * explicit `invalidatePermissions` the write endpoints call so a change on THIS
 * instance applies immediately (60s is the cross-instance backstop).
 */

import { db } from "../../db";
import { TtlCache } from "../ttl-cache";
import { RESTRICTABLE_RESOURCES, getResource } from "./registry";

export type OrgRole = "owner" | "admin" | "member";

// org_id → Map<resource_key, restricted>
const orgRestrictionsCache = new TtlCache<Map<string, boolean>>(60 * 1000);
// `${org_id}:${user_id}` → Set<resource_key> of ACTIVE grants
const userGrantsCache = new TtlCache<Set<string>>(60 * 1000);

async function loadOrgRestrictions(orgId: string): Promise<Map<string, boolean>> {
  const cached = orgRestrictionsCache.get(orgId);
  if (cached) return cached;

  const { data, error } = await db
    .from("org_restrictions")
    .select("resource_key, restricted")
    .eq("org_id", orgId);
  if (error) throw new Error(`org_restrictions load failed: ${error.message}`);

  const map = new Map<string, boolean>();
  for (const row of data ?? []) {
    map.set(row.resource_key as string, row.restricted as boolean);
  }
  orgRestrictionsCache.set(orgId, map);
  return map;
}

async function loadUserGrants(orgId: string, userId: string): Promise<Set<string>> {
  const key = `${orgId}:${userId}`;
  const cached = userGrantsCache.get(key);
  if (cached) return cached;

  const { data, error } = await db
    .from("user_resource_grants")
    .select("resource_key")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`user_resource_grants load failed: ${error.message}`);

  const set = new Set<string>((data ?? []).map((r) => r.resource_key as string));
  userGrantsCache.set(key, set);
  return set;
}

/** Whether a resource is restricted for THIS org (independent of any user). */
export function isRestrictedForOrg(
  orgRestrictions: Map<string, boolean>,
  resourceKey: string,
): boolean {
  const explicit = orgRestrictions.get(resourceKey);
  if (explicit !== undefined) return explicit;
  return getResource(resourceKey)?.defaultRestricted ?? false;
}

/**
 * The core check. Owners/admins bypass everything (they manage the org). A
 * super-admin acting inside an org is a member with an elevated role or isn't a
 * member at all (then requireOrg already blocked them), so role is sufficient
 * here — no separate super-admin lookup needed.
 */
export async function isResourceAllowed(
  orgId: string,
  userId: string,
  role: OrgRole,
  resourceKey: string,
): Promise<boolean> {
  if (role === "owner" || role === "admin") return true;

  const orgRestrictions = await loadOrgRestrictions(orgId);
  if (!isRestrictedForOrg(orgRestrictions, resourceKey)) return true;

  const grants = await loadUserGrants(orgId, userId);
  return grants.has(resourceKey);
}

/**
 * Every registry resource key the user is currently BLOCKED on (restricted and
 * not granted). Empty for owners/admins. Used to publish the frontend's
 * `restrictedResources` set.
 */
export async function computeRestrictedSet(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<string[]> {
  if (role === "owner" || role === "admin") return [];

  const [orgRestrictions, grants] = await Promise.all([
    loadOrgRestrictions(orgId),
    loadUserGrants(orgId, userId),
  ]);

  return RESTRICTABLE_RESOURCES.filter(
    (r) => isRestrictedForOrg(orgRestrictions, r.key) && !grants.has(r.key),
  ).map((r) => r.key);
}

/**
 * Drop cached permission state after a write. Call with just orgId when the
 * org's restrictions changed (affects every member), or with userId too when
 * only one user's grants changed.
 */
export function invalidatePermissions(orgId: string, userId?: string): void {
  if (userId) {
    userGrantsCache.delete(`${orgId}:${userId}`);
  } else {
    orgRestrictionsCache.delete(orgId);
    // A restriction change can flip any member's set — clear all user-grant
    // entries for this org. TtlCache has no prefix scan, so clear the lot; it
    // simply repopulates on next request.
    userGrantsCache.clear();
  }
}
