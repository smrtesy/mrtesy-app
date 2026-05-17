/**
 * Admin: organizations routes. All require requireSuperAdmin.
 *
 *   GET    /admin/orgs                          list every org + counts
 *   GET    /admin/orgs/:id                      full detail (members, apps, stats)
 *   PATCH  /admin/orgs/:id                      rename / update org
 *   DELETE /admin/orgs/:id                      hard-delete org (CASCADE — careful)
 *
 *   POST   /admin/orgs/:id/apps/:slug           enable an app for the org
 *   DELETE /admin/orgs/:id/apps/:slug           disable an app for the org
 *
 *   POST   /admin/orgs/:id/members              force-add a member  body: { user_id, role }
 *   PATCH  /admin/orgs/:id/members/:userId      change role  body: { role }
 *   DELETE /admin/orgs/:id/members/:userId      force-remove a member
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin, type Role } from "../../../middleware";
import invitesRouter from "./invites";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// Invite sub-router mounted under /admin/orgs/:id/invites
router.use("/admin/orgs/:id/invites", invitesRouter);

const ROLES: Role[] = ["owner", "admin", "member"];

// ── routes ─────────────────────────────────────────────────────────────────

/** GET /admin/orgs — list everything with quick counts for the table view */
router.get("/admin/orgs", async (_req: Request, res: Response) => {
  const [{ data: orgs }, { data: members }, { data: appMems }, { data: apps }] = await Promise.all([
    db.from("organizations").select("*").order("created_at", { ascending: false }),
    db.from("org_members").select("org_id, user_id, role"),
    db.from("app_memberships").select("org_id, app_id"),
    db.from("apps").select("id, slug"),
  ]);

  // Build lookup maps
  const memberCount = new Map<string, number>();
  const ownerByOrg  = new Map<string, string>();
  for (const m of members ?? []) {
    memberCount.set(m.org_id, (memberCount.get(m.org_id) ?? 0) + 1);
    if (m.role === "owner" && !ownerByOrg.has(m.org_id)) ownerByOrg.set(m.org_id, m.user_id);
  }

  const slugById = new Map((apps ?? []).map((a) => [a.id, a.slug]));
  const appsByOrg = new Map<string, string[]>();
  for (const am of appMems ?? []) {
    const slug = slugById.get(am.app_id);
    if (!slug) continue;
    const list = appsByOrg.get(am.org_id) ?? [];
    list.push(slug);
    appsByOrg.set(am.org_id, list);
  }

  // Enrich owners with email
  const ownerIds = Array.from(new Set(ownerByOrg.values()));
  const { data: ownerUsers } = ownerIds.length
    ? await db.auth.admin.listUsers({ perPage: 1000 })
    : { data: { users: [] as Array<{ id: string; email?: string | null }> } };
  const ownerEmail = new Map((ownerUsers?.users ?? []).map((u) => [u.id, u.email ?? null]));

  const result = (orgs ?? []).map((o) => ({
    ...o,
    member_count: memberCount.get(o.id) ?? 0,
    apps_enabled: appsByOrg.get(o.id) ?? [],
    owner_user_id: ownerByOrg.get(o.id) ?? null,
    owner_email: ownerEmail.get(ownerByOrg.get(o.id) ?? "") ?? null,
  }));

  res.json({ orgs: result });
});

/** GET /admin/orgs/:id — full detail */
router.get("/admin/orgs/:id", async (req: Request, res: Response) => {
  const { data: org } = await db
    .from("organizations")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (!org) return res.status(404).json({ error: "org not found" });

  const [
    { data: members },
    { data: appMems },
    { data: apps },
    { count: taskCount },
    { count: projectCount },
  ] = await Promise.all([
    db.from("org_members").select("user_id, role, joined_at, invited_by").eq("org_id", org.id),
    db.from("app_memberships").select("app_id, enabled_by, enabled_at").eq("org_id", org.id),
    db.from("apps").select("id, slug, name, description"),
    db.from("tasks").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
    db.from("projects").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
  ]);

  // Enrich members with auth user info
  const { data: userPage } = await db.auth.admin.listUsers({ perPage: 1000 });
  const userMap = new Map(
    (userPage?.users ?? []).map((u) => [u.id, { email: u.email ?? null, name: (u.user_metadata?.full_name as string) ?? null }]),
  );

  const enrichedMembers = (members ?? []).map((m) => ({
    ...m,
    email: userMap.get(m.user_id)?.email ?? null,
    name: userMap.get(m.user_id)?.name ?? null,
  }));

  // Build app entitlement view: every app from the registry + whether this org has it
  const enabledMap = new Map((appMems ?? []).map((m) => [m.app_id, m]));
  const appsView = (apps ?? []).map((a) => {
    const m = enabledMap.get(a.id);
    return {
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description,
      enabled: !!m,
      enabled_by: m?.enabled_by ?? null,
      enabled_at: m?.enabled_at ?? null,
    };
  });

  res.json({
    org,
    members: enrichedMembers,
    apps: appsView,
    stats: {
      task_count: taskCount ?? 0,
      project_count: projectCount ?? 0,
    },
  });
});

/** PATCH /admin/orgs/:id — rename or change slug */
router.patch("/admin/orgs/:id", async (req: Request, res: Response) => {
  const allowed = new Set(["name", "name_he", "slug"]);
  const updates: Record<string, unknown> = {};
  for (const k of Object.keys(req.body ?? {})) {
    if (allowed.has(k)) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("organizations")
    .update(updates)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "slug already taken" });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "org not found" });
  res.json({ org: data });
});

/** DELETE /admin/orgs/:id — full delete (CASCADE) */
router.delete("/admin/orgs/:id", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("organizations")
    .delete({ count: "exact" })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "org not found" });
  res.json({ ok: true });
});

// ── App entitlement toggles ────────────────────────────────────────────────

/** POST /admin/orgs/:id/apps/:slug — enable */
router.post("/admin/orgs/:id/apps/:slug", async (req: Request, res: Response) => {
  const { data: app } = await db.from("apps").select("id").eq("slug", req.params.slug).maybeSingle();
  if (!app) return res.status(404).json({ error: `unknown app: ${req.params.slug}` });

  const { error } = await db.from("app_memberships").insert({
    org_id: req.params.id,
    app_id: app.id,
    enabled_by: req.user!.id,
  });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "app already enabled" });
    if (error.code === "23503") return res.status(404).json({ error: "org not found" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ ok: true });
});

/** DELETE /admin/orgs/:id/apps/:slug — disable */
router.delete("/admin/orgs/:id/apps/:slug", async (req: Request, res: Response) => {
  const { data: app } = await db.from("apps").select("id").eq("slug", req.params.slug).maybeSingle();
  if (!app) return res.status(404).json({ error: `unknown app: ${req.params.slug}` });

  const { error, count } = await db
    .from("app_memberships")
    .delete({ count: "exact" })
    .eq("org_id", req.params.id)
    .eq("app_id", app.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "app was not enabled for this org" });
  res.json({ ok: true });
});

// ── Member management (super-admin override of role checks) ────────────────

/** POST /admin/orgs/:id/members  body: { user_id, role } */
router.post("/admin/orgs/:id/members", async (req: Request, res: Response) => {
  const { user_id, role = "member" } = req.body ?? {};
  if (!user_id) return res.status(400).json({ error: "user_id is required" });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });

  const { error } = await db.from("org_members").insert({
    org_id: req.params.id,
    user_id,
    role,
    invited_by: req.user!.id,
  });
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "user is already a member" });
    if (error.code === "23503") return res.status(404).json({ error: "org or user not found" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ ok: true });
});

/** PATCH /admin/orgs/:id/members/:userId  body: { role } */
router.patch("/admin/orgs/:id/members/:userId", async (req: Request, res: Response) => {
  const { role } = req.body ?? {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });

  const { data, error } = await db
    .from("org_members")
    .update({ role })
    .eq("org_id", req.params.id)
    .eq("user_id", req.params.userId)
    .select("*")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "member not found" });
  res.json({ member: data });
});

/** DELETE /admin/orgs/:id/members/:userId */
router.delete("/admin/orgs/:id/members/:userId", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("org_members")
    .delete({ count: "exact" })
    .eq("org_id", req.params.id)
    .eq("user_id", req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "member not found" });
  res.json({ ok: true });
});

export default router;
