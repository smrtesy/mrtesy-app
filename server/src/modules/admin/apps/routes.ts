/**
 * Admin: apps registry routes. All require requireSuperAdmin.
 *
 *   GET    /admin/apps              list all apps + #orgs that have each enabled
 *   POST   /admin/apps              register a new app  body: { slug, name, description? }
 *   GET    /admin/apps/:slug        single app + list of orgs that have it enabled
 *   PATCH  /admin/apps/:slug        update name/description  body: { name?, description? }
 *   DELETE /admin/apps/:slug        unregister (CASCADE drops all app_memberships rows)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

/** Strict slug shape: lowercase letters, numbers, dashes. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

// ── routes ─────────────────────────────────────────────────────────────────

/** GET /admin/apps */
router.get("/admin/apps", async (_req: Request, res: Response) => {
  const [{ data: apps, error }, { data: mems }] = await Promise.all([
    db.from("apps").select("*").order("created_at", { ascending: true }),
    db.from("app_memberships").select("app_id"),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const orgCount = new Map<string, number>();
  for (const m of mems ?? []) {
    orgCount.set(m.app_id, (orgCount.get(m.app_id) ?? 0) + 1);
  }

  const result = (apps ?? []).map((a) => ({
    ...a,
    org_count: orgCount.get(a.id) ?? 0,
  }));
  res.json({ apps: result });
});

/** POST /admin/apps  body: { slug, name, description? } */
router.post("/admin/apps", async (req: Request, res: Response) => {
  const { slug, name, description } = req.body ?? {};
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return res.status(400).json({
      error: "slug must be lowercase letters, numbers and dashes; 2–40 chars; must start with a letter",
    });
  }
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const { data, error } = await db
    .from("apps")
    .insert({
      slug,
      name: name.trim(),
      description: typeof description === "string" ? description.trim() || null : null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "slug already taken" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ app: data });
});

/** GET /admin/apps/:slug — single app + which orgs have it enabled */
router.get("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { data: app } = await db.from("apps").select("*").eq("slug", req.params.slug).maybeSingle();
  if (!app) return res.status(404).json({ error: "app not found" });

  const { data: mems } = await db
    .from("app_memberships")
    .select("org_id, enabled_at, enabled_by, organizations(id, slug, name)")
    .eq("app_id", app.id);

  const enabledFor = (mems ?? []).map((m) => {
    const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
    return {
      enabled_at: m.enabled_at,
      enabled_by: m.enabled_by,
      org: org ?? { id: m.org_id, slug: null, name: null },
    };
  });

  res.json({ app, enabled_for: enabledFor });
});

/** PATCH /admin/apps/:slug  body: { name?, description? } */
router.patch("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { name, description } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof description === "string")           updates.description = description.trim() || null;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("apps")
    .update(updates)
    .eq("slug", req.params.slug)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "app not found" });
  res.json({ app: data });
});

/** DELETE /admin/apps/:slug — full unregister (CASCADE drops all app_memberships) */
router.delete("/admin/apps/:slug", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("apps")
    .delete({ count: "exact" })
    .eq("slug", req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "app not found" });
  res.json({ ok: true });
});

export default router;
