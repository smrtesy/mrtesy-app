/**
 * Middleware barrel — import from here for clean route definitions:
 *
 *   import { requireAuth, requireOrg, requireRole, requireApp } from "../middleware";
 *
 * Standard chain order on protected routes:
 *   requireAuth → requireOrg → [requireRole(...)] → [requireApp("slug")] → handler
 */

export { requireAuth } from "./auth";
export { requireOrg } from "./org-context";
export { requireRole, denyDeveloper, rankOf, canManageRank, canAssignRank, type Role } from "./require-role";
export { requireApp, requireAnyApp } from "./require-app";
export { requireResource } from "./require-resource";
export { requireSuperAdmin, isSuperAdmin } from "./require-super-admin";
export { rateLimit } from "./rate-limit";
