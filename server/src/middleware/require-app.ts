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
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";

const appIdCache = new Map<string, string>();

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

    const { data, error } = await db
      .from("app_memberships")
      .select("org_id")
      .eq("org_id", req.org.id)
      .eq("app_id", appId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: `app entitlement check failed: ${error.message}` });
    }
    if (!data) {
      return res.status(403).json({ error: `App "${slug}" is not enabled for this organization` });
    }

    // Members need a per-user grant; owners/admins (and the no-member edge case)
    // are unrestricted once the org has the app.
    if (req.member?.role === "member") {
      const { data: grant, error: grantErr } = await db
        .from("user_app_access")
        .select("app_id")
        .eq("org_id", req.org.id)
        .eq("user_id", req.user!.id)
        .eq("app_id", appId)
        .maybeSingle();

      if (grantErr) {
        return res.status(500).json({ error: `app access check failed: ${grantErr.message}` });
      }
      if (!grant) {
        return res.status(403).json({ error: `App "${slug}" is not enabled for your user` });
      }
    }

    next();
  };
}

