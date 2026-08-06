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
// Path-scoped to "/admin" ON PURPOSE. This router is mounted with
// app.use("/api", adminRouter), so a BARE router.use() here runs for EVERY
// /api request that falls through to it — which 403'd every non-super-admin
// on routers mounted after it (smrtTask, studio, inbox, …).
router.use("/admin", requireAuth, requireSuperAdmin);

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

/**
 * POST /admin/impersonate/:userId — super-admin cross-org impersonation preview
 * (§7 step 8). Unlike the org owner/admin preview-link (which is scoped to the
 * caller's own org), a super-admin can preview ANY user platform-wide, so this
 * lives under the requireSuperAdmin-gated /admin router.
 *
 * We reuse the exact same one-time-token machinery as /org/members/:id/preview-link:
 * insert a member_preview_tokens row and return a /api/preview?token=… URL that,
 * opened in a clean/incognito window, mints a real session as the target once.
 * member_preview_tokens.org_id is NOT NULL, so we resolve the target's PRIMARY
 * (earliest-joined) org for the token's org_id — a user with no org membership
 * has no app view to preview and is rejected.
 */
router.post("/admin/impersonate/:userId", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const locale = req.body?.locale === "en" ? "en" : "he";

  // Target must exist.
  const { data: authUser } = await db.auth.admin.getUserById(userId);
  if (!authUser?.user) return res.status(404).json({ error: "user not found" });

  // Defense-in-depth, same guard as the org preview-link path: never mint a
  // session AS another super-admin. Here the actor is already a super-admin, so
  // this is not an escalation, but previewing as a specific peer super-admin
  // carries no product value and every impersonation must stay accountable, so
  // block it. FAIL CLOSED — a query error means we can't prove the target isn't
  // a super-admin, so refuse rather than mint.
  const { data: sa, error: saErr } = await db
    .from("super_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (saErr) return res.status(500).json({ error: "could not verify user" });
  if (sa) return res.status(403).json({ error: "cannot impersonate a super-admin" });

  // Resolve the target's primary org (earliest membership) for the token's
  // NOT NULL org_id. No membership → nothing to preview. Distinguish a real DB
  // error (500) from a genuinely membership-less user (409).
  const { data: membership, error: mErr } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (mErr) return res.status(500).json({ error: "could not resolve org membership" });
  if (!membership) {
    return res.status(409).json({ error: "user has no org membership to preview" });
  }
  const orgId = membership.org_id as string;

  const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes
  const { data: tok, error } = await db
    .from("member_preview_tokens")
    .insert({
      org_id: orgId,
      target_user_id: userId,
      created_by: req.user!.id,
      expires_at,
    })
    .select("token")
    .single();
  if (error || !tok) return res.status(500).json({ error: error?.message ?? "failed to create preview token" });

  // §7 step 8: mandatory audit — one append-only row per minted impersonation.
  const { error: logErr } = await db.from("impersonation_log").insert({
    actor_user_id: req.user!.id,
    target_user_id: userId,
    org_id: orgId,
    via: "super_admin",
    ip: (req.headers["x-forwarded-for"] as string | undefined) ?? req.ip ?? null,
    token: tok.token,
  });
  if (logErr) console.error("[admin/impersonate] impersonation_log write failed:", logErr.message);

  // FRONTEND_URL may be a comma-separated CORS list — the first entry is the
  // canonical app origin, where the /api/preview route lives.
  const appUrl = (process.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0].trim();
  const url = `${appUrl}/api/preview?token=${tok.token}&locale=${locale}`;
  res.json({ url, expires_at });
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
