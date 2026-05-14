/**
 * requireSuperAdmin — gates platform-wide admin routes.
 *
 * Membership is determined by EITHER:
 *   1. A row in super_admins for req.user.id   (canonical, managed via API)
 *   2. req.user.email in ADMIN_EMAIL env var   (permanent safety-net fallback)
 *
 * Either check passing → next(). Both failing → 403.
 *
 * Use AFTER requireAuth. Does NOT require requireOrg (super-admins operate
 * across all orgs, not within one).
 *
 *   router.get("/api/admin/orgs", requireAuth, requireSuperAdmin, handler);
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";

/** Parse ADMIN_EMAIL env into a Set of lowercased emails. Cached per process. */
let envAdminEmails: Set<string> | null = null;
function getEnvAdminEmails(): Set<string> {
  if (envAdminEmails) return envAdminEmails;
  envAdminEmails = new Set(
    (process.env.ADMIN_EMAIL ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return envAdminEmails;
}

/** Small in-memory cache so repeated requests in a session don't re-query. */
const dbCache = new Map<string, { result: boolean; expires: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

async function isInSuperAdminsTable(userId: string): Promise<boolean> {
  const cached = dbCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.result;

  const { data } = await db
    .from("super_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  const result = !!data;
  dbCache.set(userId, { result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Stand-alone check, also exported for use in non-middleware contexts
 * (e.g. the GET /api/me/super-admin endpoint).
 */
export async function isSuperAdmin(user: { id: string; email: string | null }): Promise<boolean> {
  // 1. DB row (canonical)
  if (await isInSuperAdminsTable(user.id)) return true;

  // 2. Env-var fallback (lockout safety)
  if (user.email && getEnvAdminEmails().has(user.email.toLowerCase())) return true;

  return false;
}

export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(500).json({ error: "requireSuperAdmin used without requireAuth" });
  }

  if (await isSuperAdmin(req.user)) return next();

  return res.status(403).json({ error: "Super-admin access required" });
}
