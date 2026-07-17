/**
 * Module augmentation: attach our auth/tenancy fields to Express's Request.
 * Populated by middleware/auth.ts, middleware/org-context.ts.
 */

import "express";

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string | null;
    }

    interface OrgContext {
      id: string;
      slug: string;
      name: string;
    }

    interface OrgMembership {
      org_id: string;
      user_id: string;
      role: "owner" | "admin" | "member";
    }

    interface Request {
      user?: AuthUser;
      org?: OrgContext;
      member?: OrgMembership;
      /** smrtTask access level in the active org — set by attachTaskAccess /
       *  requireFullTask (see modules/smrttask/lib/access.ts). "lite" = a
       *  project-only worker restricted to tasks assigned to them. */
      taskAccess?: "full" | "lite";
    }
  }
}

export {};
