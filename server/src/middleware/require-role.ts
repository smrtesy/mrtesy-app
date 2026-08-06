/**
 * requireRole — factory that returns middleware enforcing a minimum role.
 *
 * Usage:
 *   router.post("/orgs/:id/members", requireAuth, requireOrg, requireRole("owner", "admin"), handler);
 *
 * Must run AFTER requireOrg (which populates req.member).
 * Returns 403 if the user's role isn't in the allowed list.
 */

import type { Request, Response, NextFunction } from "express";

export type Role = "owner" | "admin" | "member";

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.member) {
      return res.status(500).json({ error: "requireRole used without requireOrg" });
    }
    if (!allowed.includes(req.member.role)) {
      return res.status(403).json({
        error: `Requires role: ${allowed.join(" or ")}. Your role: ${req.member.role}`,
      });
    }
    next();
  };
}

/**
 * Security plan §5.3 — the org rank ladder. Numeric so managers can be compared
 * by strength: owner > admin > member. This is the ONE place the ordering lives;
 * canManageRank / canAssignRank derive from it.
 */
export function rankOf(role: Role): number {
  return role === "owner" ? 3 : role === "admin" ? 2 : 1;
}

/**
 * Can an actor at `actorRole` manage (change/remove) a target CURRENTLY at
 * `targetRole`? Plan §5.3: "רק מי שבדרגתו או מתחתיו" — a manager may act on
 * anyone at their own rank or below, never on someone above them.
 */
export function canManageRank(actorRole: Role, targetRole: Role): boolean {
  return rankOf(actorRole) >= rankOf(targetRole);
}

/**
 * Can an actor at `actorRole` assign `newRole` to someone? Plan §5.3:
 * "לקדם עד דרגתו-שלו" — you can grant a rank up to and including your own
 * (an owner may appoint another owner; an admin may promote only up to admin).
 */
export function canAssignRank(actorRole: Role, newRole: Role): boolean {
  return rankOf(actorRole) >= rankOf(newRole);
}

/**
 * denyDeveloper — hard-block the developer axis from sensitive capabilities.
 *
 * Plan §5.2/§5.3/§9.7: is_developer grants full feature VISIBILITY (to build)
 * but is explicitly excluded from user management, key exposure and
 * impersonation — regardless of any org rank the same person also holds. This
 * is a subtractive override on those specific routes, not a rank check, so it
 * must be mounted IN ADDITION to requireRole/requireManager. Runs after
 * requireOrg (needs req.member).
 */
export function denyDeveloper(req: Request, res: Response, next: NextFunction) {
  if (!req.member) {
    return res.status(500).json({ error: "denyDeveloper used without requireOrg" });
  }
  if (req.member.is_developer) {
    return res.status(403).json({ error: "developers are excluded from this action" });
  }
  next();
}
