/**
 * Admin: users routes. All require requireSuperAdmin.
 *
 *   GET    /admin/users                      list all users + counts
 *   GET    /admin/users/:id                  single user detail
 *   GET    /admin/users/:id/memberships      orgs the user belongs to + per-org role
 *   POST   /admin/users/:id/super-admin      grant super-admin   body: { note? }
 *   DELETE /admin/users/:id/super-admin      revoke
 *   GET    /admin/super-admins               list everyone with super-admin
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// ── helpers ────────────────────────────────────────────────────────────────

interface AuthUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  created_at?: string;
}

/** Load all auth.users into a map. Used to enrich admin views with email+name. */
async function loadAllAuthUsers(): Promise<Map<string, AuthUser>> {
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  const map = new Map<string, AuthUser>();
  for (const u of data?.users ?? []) map.set(u.id, u as AuthUser);
  return map;
}

function nameOf(u: AuthUser | undefined): string | null {
  if (!u) return null;
  return (u.user_metadata?.full_name as string | undefined)
    ?? (u.user_metadata?.name as string | undefined)
    ?? null;
}

// ── routes ─────────────────────────────────────────────────────────────────

/** GET /admin/users/by-email?email=… — look up a single user by email */
router.get("/admin/users/by-email", async (req: Request, res: Response) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) return res.status(400).json({ error: "email is required" });

  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  const match = (data?.users ?? []).find((u) => u.email?.toLowerCase() === email);
  if (!match) return res.status(404).json({ error: "user not found" });

  res.json({ user: { id: match.id, email: match.email ?? null, name: nameOf(match as AuthUser) } });
});

/** GET /admin/users — list all users with email, name, org count, super-admin flag */
router.get("/admin/users", async (_req: Request, res: Response) => {
  const [userMap, memberRows, superAdminRows, settingsRows] = await Promise.all([
    loadAllAuthUsers(),
    db.from("org_members").select("user_id"),
    db.from("super_admins").select("user_id"),
    db.from("user_settings").select("user_id, onboarding_completed, preferred_language"),
  ]);

  const orgCounts = new Map<string, number>();
  for (const r of memberRows.data ?? []) {
    orgCounts.set(r.user_id, (orgCounts.get(r.user_id) ?? 0) + 1);
  }
  const superIds  = new Set((superAdminRows.data ?? []).map((r) => r.user_id));
  const settings  = new Map((settingsRows.data ?? []).map((s) => [s.user_id, s]));

  const users = Array.from(userMap.values()).map((u) => ({
    id: u.id,
    email: u.email ?? null,
    name: nameOf(u),
    created_at: u.created_at ?? null,
    org_count: orgCounts.get(u.id) ?? 0,
    is_super_admin: superIds.has(u.id),
    onboarding_completed: settings.get(u.id)?.onboarding_completed ?? false,
    preferred_language: settings.get(u.id)?.preferred_language ?? null,
  }));

  // newest first
  users.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  res.json({ users });
});

/** GET /admin/users/:id — single user detail */
router.get("/admin/users/:id", async (req: Request, res: Response) => {
  const { data: authUser } = await db.auth.admin.getUserById(req.params.id);
  if (!authUser?.user) return res.status(404).json({ error: "user not found" });

  const [{ data: settings }, { data: superAdmin }] = await Promise.all([
    db.from("user_settings").select("*").eq("user_id", req.params.id).maybeSingle(),
    db.from("super_admins").select("*").eq("user_id", req.params.id).maybeSingle(),
  ]);

  res.json({
    user: {
      id: authUser.user.id,
      email: authUser.user.email ?? null,
      name: nameOf(authUser.user as AuthUser),
      created_at: authUser.user.created_at ?? null,
      last_sign_in_at: authUser.user.last_sign_in_at ?? null,
    },
    settings,
    super_admin: superAdmin,  // null if not a super-admin
  });
});

/**
 * GET /admin/users/:id/memberships
 * For each org the user is in: their role + the apps enabled for that org.
 * Also returns `effective_apps` — the union of apps across all orgs (what the
 * user can actually access).
 */
router.get("/admin/users/:id/memberships", async (req: Request, res: Response) => {
  const { data: rows, error } = await db
    .from("org_members")
    .select("role, joined_at, organizations(id, slug, name, name_he, created_at)")
    .eq("user_id", req.params.id)
    .order("joined_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!rows || rows.length === 0) {
    return res.json({ memberships: [], effective_apps: [] });
  }

  // Normalise the joined `organizations` (Supabase types it as array)
  const normalised = rows.map((m) => {
    const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
    return { role: m.role, joined_at: m.joined_at, org };
  }).filter((m) => m.org);

  const orgIds = normalised.map((m) => (m.org as { id: string }).id);

  // Pull every app_membership for these orgs + the app registry
  const [{ data: mems }, { data: apps }] = await Promise.all([
    db.from("app_memberships").select("org_id, app_id, enabled_at").in("org_id", orgIds),
    db.from("apps").select("id, slug, name"),
  ]);

  const appById = new Map((apps ?? []).map((a) => [a.id, a]));
  const appsByOrg = new Map<string, Array<{ slug: string; name: string; enabled_at: string }>>();
  for (const m of mems ?? []) {
    const app = appById.get(m.app_id);
    if (!app) continue;
    const list = appsByOrg.get(m.org_id) ?? [];
    list.push({ slug: app.slug as string, name: app.name as string, enabled_at: m.enabled_at as string });
    appsByOrg.set(m.org_id, list);
  }

  const memberships = normalised.map((m) => ({
    role: m.role,
    joined_at: m.joined_at,
    org: m.org,
    apps: appsByOrg.get((m.org as { id: string }).id) ?? [],
  }));

  // Effective access: distinct slugs across all orgs
  const effectiveSlugs = new Set<string>();
  for (const list of appsByOrg.values()) {
    for (const a of list) effectiveSlugs.add(a.slug);
  }

  res.json({ memberships, effective_apps: Array.from(effectiveSlugs) });
});

/** POST /admin/users/:id/super-admin  body: { note?: string } */
router.post("/admin/users/:id/super-admin", async (req: Request, res: Response) => {
  const targetUserId = req.params.id;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;

  const { error } = await db.from("super_admins").insert({
    user_id: targetUserId,
    granted_by: req.user!.id,
    note,
  });

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "user is already a super-admin" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ ok: true });
});

/** DELETE /admin/users/:id/super-admin — revoke */
router.delete("/admin/users/:id/super-admin", async (req: Request, res: Response) => {
  // Safety: don't let the LAST super-admin remove themselves (lockout risk)
  if (req.params.id === req.user!.id) {
    const { data: others } = await db
      .from("super_admins")
      .select("user_id")
      .neq("user_id", req.user!.id);
    if (!others || others.length === 0) {
      return res.status(409).json({
        error: "cannot revoke your own super-admin — you are the last one. Add another super-admin first.",
      });
    }
  }

  const { error, count } = await db
    .from("super_admins")
    .delete({ count: "exact" })
    .eq("user_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "user was not a super-admin" });
  res.json({ ok: true });
});

/** GET /admin/super-admins — list everyone with the role */
router.get("/admin/super-admins", async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from("super_admins")
    .select("*")
    .order("granted_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Enrich with email + name for each
  const userMap = await loadAllAuthUsers();
  const enriched = (data ?? []).map((r) => {
    const u = userMap.get(r.user_id);
    return { ...r, email: u?.email ?? null, name: nameOf(u) };
  });

  res.json({ super_admins: enriched });
});

export default router;
