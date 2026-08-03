/**
 * requireResource — factory enforcing a per-resource restriction, layered on
 * top of the app entitlement.
 *
 * Usage (AFTER requireApp so app entitlement is already guaranteed):
 *   router.get("/knowledge/...",
 *     requireAuth, requireOrg, requireApp("smrttask"),
 *     requireResource("smrttask.screen.knowledge"), handler);
 *
 * A restricted resource with no active user grant returns a STRUCTURED 403 that
 * carries the resource key, so the frontend can offer "request access" (phase
 * 2) instead of a bare error:
 *   { error: "restricted", resource_key, request_kind: "access" }
 *
 * Owners/admins bypass (they manage the org). Must run after requireOrg
 * (needs req.member.role). See resolve.ts for the decision + caching.
 */

import type { Request, Response, NextFunction } from "express";
import { isResourceAllowed, type OrgRole } from "../lib/permissions/resolve";
import { isValidResourceKey } from "../lib/permissions/registry";

export function requireResource(resourceKey: string) {
  // Fail fast at wire-up time if a route names a key that isn't in the catalog.
  if (!isValidResourceKey(resourceKey)) {
    throw new Error(`requireResource: unknown resource key "${resourceKey}"`);
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.org || !req.member) {
      return res.status(500).json({ error: "requireResource used without requireOrg" });
    }
    try {
      const allowed = await isResourceAllowed(
        req.org.id,
        req.user!.id,
        req.member.role as OrgRole,
        resourceKey,
      );
      if (allowed) return next();
      return res.status(403).json({
        error: "restricted",
        resource_key: resourceKey,
        request_kind: "access",
      });
    } catch (err) {
      // An infra failure must never be read as a denial — surface it as a 500.
      return res.status(500).json({
        error: `permission check failed: ${(err as Error).message}`,
      });
    }
  };
}
