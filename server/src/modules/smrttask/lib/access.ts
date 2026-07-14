/**
 * smrtTask access-level resolution — "full" vs "lite" (project-only worker).
 *
 * A "lite" user is an org member who uses smrtTask ONLY for tasks assigned to
 * them (from a smrtPlan plan or by another user/manager). They have no source
 * connections, no inbox, no projects, no sync. The level is stored in the
 * shared `app_user_access` table (the same mechanism smrtPlan uses).
 *
 * DEFAULT BEHAVIOUR (backwards-compatible): with no explicit `app_user_access`
 * row, EVERY role resolves to "full" — including plain members. smrtTask has
 * always granted the full app to anyone holding the `smrttask` grant, so "lite"
 * is strictly opt-in (an explicit row), never a silent downgrade. (This is the
 * opposite default from smrtPlan, where a member defaults to "lite".)
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../../../db";

let smrttaskAppId: string | null = null;
async function getSmrttaskAppId(): Promise<string | null> {
  if (smrttaskAppId) return smrttaskAppId;
  const { data } = await db.from("apps").select("id").eq("slug", "smrttask").maybeSingle();
  smrttaskAppId = (data?.id as string) ?? null;
  return smrttaskAppId;
}

/** Resolve the caller's smrtTask access level in the active org. */
export async function resolveTaskAccessLevel(req: Request): Promise<"full" | "lite"> {
  const appId = await getSmrttaskAppId();
  if (appId) {
    const { data } = await db
      .from("app_user_access")
      .select("access_level")
      .eq("org_id", req.org!.id)
      .eq("app_id", appId)
      .eq("user_id", req.user!.id)
      .maybeSingle();
    if (data?.access_level) return data.access_level as "full" | "lite";
  }
  // No explicit row → full for everyone (preserve historical behaviour).
  return "full";
}

/**
 * Middleware: attach `req.taskAccess` for downstream handlers (list filtering,
 * per-task ownership checks). Cheap: a single indexed lookup, and only for
 * routes that opt in by using it.
 */
export async function attachTaskAccess(req: Request, res: Response, next: NextFunction) {
  try {
    req.taskAccess = await resolveTaskAccessLevel(req);
    next();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Middleware: block "lite" (project-only) users from a full-app surface. Use on
 * routers/routes a lean worker should never reach (sync, projects, router,
 * marathon, knowledge, inbox, calendar, actions, whatsapp, sms, …).
 * Self-contained — resolves the level itself, so it can be dropped into any
 * router's guard chain without needing `attachTaskAccess` first.
 */
export async function requireFullTask(req: Request, res: Response, next: NextFunction) {
  try {
    const level = req.taskAccess ?? (await resolveTaskAccessLevel(req));
    req.taskAccess = level;
    if (level !== "full") {
      return res.status(403).json({ error: "smrtTask: this area is not available for a project-only worker" });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
