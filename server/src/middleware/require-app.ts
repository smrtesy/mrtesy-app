/**
 * requireApp — factory that returns middleware enforcing an app entitlement.
 *
 * Usage:
 *   router.post("/sync/part3", requireAuth, requireOrg, requireApp("smrttask"), handler);
 *
 * Two-level check:
 *   1. The active org must have the app enabled (`app_memberships`).
 *   2. For role='member', the user must additionally have a per-user grant
 *      (`user_app_access`). Owners/admins are unrestricted — having the app at
 *      the org level is enough for them.
 *
 * Returns 403 if either check fails. Must run AFTER requireOrg (needs req.member).
 * Caches the app id lookup per slug in process memory (apps rarely change).
 *
 * The two checks run in parallel (they were sequential — one wasted round-trip
 * per member request), and positive outcomes are cached for 60s. Denials are
 * never cached, so newly-granted access applies immediately; revoked access
 * lingers at most 60s.
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { TtlCache } from "../lib/ttl-cache";

const appIdCache = new Map<string, string>();

// key `${orgId}:${appId}` → org has the app enabled (positive only)
const orgAppCache = new TtlCache<true>(60 * 1000);
// key `${orgId}:${appId}:${userId}` → member has a per-user grant (positive only)
const grantCache = new TtlCache<true>(60 * 1000);

async function getAppIdBySlug(slug: string): Promise<string | null> {
  const cached = appIdCache.get(slug);
  if (cached) return cached;

  const { data } = await db.from("apps").select("id").eq("slug", slug).maybeSingle();
  if (!data) return null;
  appIdCache.set(slug, data.id as string);
  return data.id as string;
}

export function requireApp(slug: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.org) {
      return res.status(500).json({ error: "requireApp used without requireOrg" });
    }

    const appId = await getAppIdBySlug(slug);
    if (!appId) {
      return res.status(500).json({ error: `App not registered: ${slug}` });
    }

    const needsGrant = req.member?.role === "member";
    const orgKey = `${req.org.id}:${appId}`;
    const grantKey = `${orgKey}:${req.user!.id}`;

    const orgCached = orgAppCache.get(orgKey) === true;
    const grantCached = !needsGrant || grantCache.get(grantKey) === true;
    if (orgCached && grantCached) {
      return next();
    }

    const [membership, grant] = await Promise.all([
      orgCached
        ? Promise.resolve(null)
        : db
            .from("app_memberships")
            .select("org_id")
            .eq("org_id", req.org.id)
            .eq("app_id", appId)
            .maybeSingle(),
      needsGrant && !grantCached
        ? db
            .from("user_app_access")
            .select("app_id")
            .eq("org_id", req.org.id)
            .eq("user_id", req.user!.id)
            .eq("app_id", appId)
            .maybeSingle()
        : Promise.resolve(null),
    ]);

    if (membership) {
      if (membership.error) {
        return res.status(500).json({ error: `app entitlement check failed: ${membership.error.message}` });
      }
      if (!membership.data) {
        return res.status(403).json({ error: `App "${slug}" is not enabled for this organization` });
      }
      orgAppCache.set(orgKey, true);
    }

    if (needsGrant && !grantCached) {
      if (grant?.error) {
        return res.status(500).json({ error: `app access check failed: ${grant.error.message}` });
      }
      if (!grant?.data) {
        return res.status(403).json({ error: `App "${slug}" is not enabled for your user` });
      }
      grantCache.set(grantKey, true);
    }

    next();
  };
}
