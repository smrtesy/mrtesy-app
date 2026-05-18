/**
 * Admin: apps registry routes. All require requireSuperAdmin.
 *
 *   GET    /admin/apps                    list all apps + #orgs + stage from app_status
 *   POST   /admin/apps                    register a new app  body: { slug, name, description? }
 *   GET    /admin/apps/:slug              single app + list of orgs that have it enabled
 *   PATCH  /admin/apps/:slug             update name/description  body: { name?, description? }
 *   DELETE /admin/apps/:slug             unregister (CASCADE drops all app_memberships rows)
 *   GET    /admin/apps/:slug/status       get dev status
 *   PATCH  /admin/apps/:slug/status       update dev status  body: { stage?, summary?, next_steps?, blockers? }
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
  const [{ data: apps, error }, { data: mems }, { data: statuses }] = await Promise.all([
    db.from("apps").select("*").order("created_at", { ascending: true }),
    db.from("app_memberships").select("app_id"),
    db.from("app_status").select("app_slug, stage"),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const orgCount  = new Map<string, number>();
  for (const m of mems ?? []) orgCount.set(m.app_id, (orgCount.get(m.app_id) ?? 0) + 1);

  const stageMap = new Map<string, string>();
  for (const s of statuses ?? []) stageMap.set(s.app_slug, s.stage);

  const result = (apps ?? []).map((a) => ({
    ...a,
    org_count: orgCount.get(a.id) ?? 0,
    stage:     stageMap.get(a.slug)  ?? null,
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

const VALID_STAGES = ["רעיון", "בניה", "טסט", "מאור", "לקוחות"] as const;

/** GET /admin/apps/:slug/status */
router.get("/admin/apps/:slug/status", async (req: Request, res: Response) => {
  const { data } = await db
    .from("app_status")
    .select("*")
    .eq("app_slug", req.params.slug)
    .maybeSingle();
  res.json({ status: data ?? { app_slug: req.params.slug, stage: "רעיון", summary: null, next_steps: [], blockers: [], updated_at: null } });
});

/** PATCH /admin/apps/:slug/status  body: { stage?, summary?, next_steps?, blockers? } */
router.patch("/admin/apps/:slug/status", async (req: Request, res: Response) => {
  const { stage, summary, next_steps, blockers } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (stage !== undefined) {
    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(", ")}` });
    }
    updates.stage = stage;
  }
  if (summary !== undefined)     updates.summary     = typeof summary === "string" ? summary.trim() || null : null;
  if (next_steps !== undefined)  updates.next_steps  = Array.isArray(next_steps)  ? next_steps.map(String).filter(Boolean)  : [];
  if (blockers   !== undefined)  updates.blockers    = Array.isArray(blockers)    ? blockers.map(String).filter(Boolean)    : [];

  const { data, error } = await db
    .from("app_status")
    .upsert({ app_slug: req.params.slug, ...updates }, { onConflict: "app_slug" })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: data });
});

export default router;
