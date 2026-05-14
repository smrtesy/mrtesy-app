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
