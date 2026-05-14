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
export { requireRole, type Role } from "./require-role";
export { requireApp } from "./require-app";
export { requireSuperAdmin, isSuperAdmin } from "./require-super-admin";
