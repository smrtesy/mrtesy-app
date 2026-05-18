/**
 * App entitlement routes
 *   GET     /org/apps             — list apps + which are enabled for active org
 *   POST    /org/apps/:slug       — enable an app  (owner only)
 *   DELETE  /org/apps/:slug       — disable an app (owner only)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole } from "../../../middleware";

const router = Router();

/** GET /org/apps — full registry with `enabled` flag per row for this org */
router.get("/org/apps", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const [{ data: apps }, { data: memberships }] = await Promise.all([
    db.from("apps").select("id, slug, name, description"),
    db.from("app_memberships").select("app_id, enabled_at").eq("org_id", req.org!.id),
  ]);

  const enabledMap = new Map((memberships ?? []).map((m) => [m.app_id, m.enabled_at]));

  const result = (apps ?? []).map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    enabled: enabledMap.has(a.id),
    enabled_at: enabledMap.get(a.id) ?? null,
  }));

  res.json({ apps: result });
});

/** POST /org/apps/:slug — enable an app for the active org (owner only) */
router.post("/org/apps/:slug",
  requireAuth, requireOrg, requireRole("owner"),
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const { data: app } = await db.from("apps").select("id").eq("slug", slug).maybeSingle();
    if (!app) return res.status(404).json({ error: `unknown app: ${slug}` });

    const { error } = await db.from("app_memberships").insert({
      org_id: req.org!.id,
      app_id: app.id,
      enabled_by: req.user!.id,
    });

    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "app already enabled" });
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json({ ok: true, slug });
  },
);

/** DELETE /org/apps/:slug — disable an app (owner only) */
router.delete("/org/apps/:slug",
  requireAuth, requireOrg, requireRole("owner"),
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const { data: app } = await db.from("apps").select("id").eq("slug", slug).maybeSingle();
    if (!app) return res.status(404).json({ error: `unknown app: ${slug}` });

    const { error } = await db
      .from("app_memberships")
      .delete()
      .eq("org_id", req.org!.id)
      .eq("app_id", app.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, slug });
  },
);

export default router;
