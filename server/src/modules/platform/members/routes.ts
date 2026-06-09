/**
 * Org member routes (all require X-Org-Id)
 *   GET     /org/members                — list members (with each member's granted apps)
 *   POST    /org/members                — add an existing user, or invite an unregistered one by email
 *   PATCH   /org/members/:userId/role   — change member's role            (owner only)
 *   PATCH   /org/members/:userId/apps   — set which apps a member can use  (owner/admin)
 *   DELETE  /org/members/:userId        — remove a member                 (owner/admin, or self-leave)
 *   GET     /org/invites                — list pending invites            (owner/admin)
 *   DELETE  /org/invites/:id            — revoke a pending invite         (owner/admin)
 *   POST    /org/invites/:id/resend     — re-send a pending invite email  (owner/admin)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole, type Role } from "../../../middleware";
import { sendInviteEmail } from "../../../lib/email";

const router = Router();

const ROLES: Role[] = ["owner", "admin", "member"];
/** Synthetic email domain for "no-email" placeholder employees. The org admin
 *  can later set a real email so they can sign in and see their assignments. */
const PLACEHOLDER_DOMAIN = "no-email.smrtesy.local";
const isPlaceholderEmail = (email: string | null | undefined) => !!email && email.endsWith(`@${PLACEHOLDER_DOMAIN}`);

/**
 * Resolve a list of app slugs to {id, slug} rows, keeping only apps that both
 * exist AND are currently enabled for the given org. This prevents granting a
 * user an app the org doesn't actually have.
 */
async function resolveOrgApps(orgId: string, slugs: unknown): Promise<{ id: string; slug: string }[]> {
  if (!Array.isArray(slugs) || slugs.length === 0) return [];
  const wanted = slugs.filter((s): s is string => typeof s === "string");
  if (wanted.length === 0) return [];

  const { data: apps } = await db.from("apps").select("id, slug").in("slug", wanted);
  const appList = apps ?? [];
  if (appList.length === 0) return [];

  const { data: orgApps } = await db
    .from("app_memberships").select("app_id").eq("org_id", orgId);
  const enabled = new Set((orgApps ?? []).map((m) => m.app_id as string));

  return appList
    .filter((a) => enabled.has(a.id as string))
    .map((a) => ({ id: a.id as string, slug: a.slug as string }));
}

/** GET /org/members — list members of active org (with each member's granted apps) */
router.get("/org/members", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("org_members")
    .select("user_id, role, joined_at, invited_by, display_name")
    .eq("org_id", req.org!.id)
    .order("joined_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Enrich with auth.users info (email, full_name) via admin API.
  // Doing one bulk listUsers() and joining locally is fine for org-sized teams.
  // For very large orgs this would need a different approach (RPC join or denormalised column).
  const { data: userPage } = await db.auth.admin.listUsers({ perPage: 1000 });
  const userMap = new Map(
    (userPage?.users ?? []).map((u) => [u.id, { email: u.email ?? null, name: u.user_metadata?.full_name ?? null }]),
  );

  // Per-user app grants for this org, as slugs grouped by user.
  const [{ data: grants }, { data: appsRows }] = await Promise.all([
    db.from("user_app_access").select("user_id, app_id").eq("org_id", req.org!.id),
    db.from("apps").select("id, slug"),
  ]);
  const slugById = new Map((appsRows ?? []).map((a) => [a.id as string, a.slug as string]));
  const slugsByUser = new Map<string, string[]>();
  for (const g of grants ?? []) {
    const slug = slugById.get(g.app_id as string);
    if (!slug) continue;
    const arr = slugsByUser.get(g.user_id as string) ?? [];
    arr.push(slug);
    slugsByUser.set(g.user_id as string, arr);
  }

  const members = (data ?? []).map((m) => {
    const rawEmail = userMap.get(m.user_id)?.email ?? null;
    const placeholder = isPlaceholderEmail(rawEmail);
    return {
      user_id: m.user_id,
      role: m.role,
      joined_at: m.joined_at,
      invited_by: m.invited_by,
      email: placeholder ? null : rawEmail,
      name: userMap.get(m.user_id)?.name ?? null,
      display_name: (m.display_name as string | null) ?? null,
      is_placeholder: placeholder,
      app_slugs: slugsByUser.get(m.user_id as string) ?? [],
    };
  });

  res.json({ members });
});

/** PATCH /org/members/:userId/display-name — org owner/admin sets a member's
 *  per-org display name (blank clears it → falls back to first name / email). */
router.patch("/org/members/:userId/display-name",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const raw = (req.body ?? {}).display_name;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "display_name must be a string or null" });
    }
    const display_name = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    const { data, error } = await db
      .from("org_members")
      .update({ display_name })
      .eq("org_id", req.org!.id)
      .eq("user_id", req.params.userId)
      .select("user_id, display_name")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "member not found" });
    res.json({ member: data });
  });

/**
 * POST /org/members/placeholder — add an employee WITHOUT an email. Creates a
 * placeholder auth user (synthetic, no real inbox; no invite sent) so they can
 * be assigned tasks/roles right away. Later, PATCH .../email gives them a real
 * address to sign in with — same user id, so all their assignments are waiting.
 */
router.post("/org/members/placeholder",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { name, role = "member", app_slugs } = req.body ?? {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    if (role === "owner" && req.member!.role !== "owner") {
      return res.status(403).json({ error: "only owners can grant the owner role" });
    }
    const apps = await resolveOrgApps(req.org!.id, app_slugs);

    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: `placeholder.${randomUUID()}@${PLACEHOLDER_DOMAIN}`,
      email_confirm: true,
      user_metadata: { full_name: name.trim(), placeholder: true },
    });
    if (createErr || !created?.user) {
      return res.status(500).json({ error: createErr?.message ?? "failed to create placeholder user" });
    }
    const uid = created.user.id;

    const { error } = await db.from("org_members").insert({
      org_id: req.org!.id,
      user_id: uid,
      role,
      invited_by: req.user!.id,
      display_name: name.trim(),
    });
    if (error) return res.status(500).json({ error: error.message });

    let warning: string | undefined;
    if (apps.length > 0) {
      const rows = apps.map((a) => ({ org_id: req.org!.id, user_id: uid, app_id: a.id, granted_by: req.user!.id }));
      const { error: grantErr } = await db.from("user_app_access").insert(rows);
      if (grantErr) warning = "member added but app access failed to save";
    }
    res.status(201).json({ member: { user_id: uid, role, display_name: name.trim(), is_placeholder: true }, ...(warning ? { warning } : {}) });
  });

/**
 * PATCH /org/members/:userId/email — set/replace a member's login email (used to
 * give a no-email placeholder a real address). The person can then sign in with
 * it and find everything already assigned to them.
 */
router.patch("/org/members/:userId/email",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const raw = (req.body ?? {}).email;
    if (!raw || typeof raw !== "string" || !raw.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    const email = raw.toLowerCase().trim();
    // Target must be a member of THIS org.
    const { data: m } = await db
      .from("org_members").select("user_id").eq("org_id", req.org!.id).eq("user_id", req.params.userId).maybeSingle();
    if (!m) return res.status(404).json({ error: "member not found" });
    const { data: userPage } = await db.auth.admin.listUsers({ perPage: 1000 });
    const target = (userPage?.users ?? []).find((u) => u.id === req.params.userId);
    // SECURITY: only a no-email placeholder may be given an email here. A real
    // account is global (could belong to other orgs) — an org admin must never
    // be able to rewrite a real user's login email and hijack it.
    if (!target || !isPlaceholderEmail(target.email)) {
      return res.status(403).json({ error: "can only set an email for a no-email employee" });
    }
    // Reject if the email already belongs to someone else.
    const clash = (userPage?.users ?? []).find((u) => u.email?.toLowerCase() === email && u.id !== req.params.userId);
    if (clash) return res.status(409).json({ error: "that email is already in use" });

    const { error } = await db.auth.admin.updateUserById(req.params.userId, { email, email_confirm: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, email });
  });

/**
 * POST /org/members — add a member by email, optionally with a set of apps.
 *
 * `app_slugs` (string[]) — which apps to enable for this user. Only meaningful
 * for role='member' (owners/admins are unrestricted); slugs are filtered to
 * apps the org actually has enabled.
 *
 * If the email already has a Supabase account we add them to `org_members`
 * directly (available immediately) and grant the chosen apps. If no account
 * exists yet we create a pending `org_invites` row carrying the chosen apps and
 * email them a token link; on first sign-in `accept_my_invites()` joins them to
 * the org and applies those app grants.
 */
router.post("/org/members",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { email, role = "member", locale: rawLocale = "he", app_slugs } = req.body ?? {};
    // Only he/en are valid locale segments; never trust client input in the email link path.
    const locale = rawLocale === "en" ? "en" : "he";
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    // Only owners can add new owners
    if (role === "owner" && req.member!.role !== "owner") {
      return res.status(403).json({ error: "only owners can grant the owner role" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate the requested apps against what the org actually has enabled.
    const apps = await resolveOrgApps(req.org!.id, app_slugs);
    const validSlugs = apps.map((a) => a.slug);

    // Find user by email (Supabase admin API)
    // listUsers does pagination by default; for now we read first page (1000 users).
    // If the customer scales past that, this needs to be a server-side RPC.
    const { data: userPage } = await db.auth.admin.listUsers({ perPage: 1000 });
    const user = (userPage?.users ?? []).find((u) => u.email?.toLowerCase() === normalizedEmail);

    // ── Unregistered email → create a pending invite and email a token link ──
    if (!user) {
      // Don't stack duplicate active invites for the same email+org
      const { data: existing } = await db
        .from("org_invites")
        .select("id")
        .eq("org_id", req.org!.id)
        .eq("email", normalizedEmail)
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (existing) {
        return res.status(409).json({ error: "an active invite already exists for this email" });
      }

      const { data: invite, error: inviteErr } = await db
        .from("org_invites")
        .insert({
          email: normalizedEmail,
          org_id: req.org!.id,
          role,
          invited_by: req.user!.id,
          app_slugs: validSlugs,
        })
        .select("token")
        .single();

      if (inviteErr) return res.status(500).json({ error: inviteErr.message });

      // FRONTEND_URL may be comma-separated (CORS list) — take the first entry as the canonical app URL
      const appUrl = (process.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0].trim();
      const inviteUrl = `${appUrl}/${locale}/invite/${invite.token}`;

      try {
        await sendInviteEmail({ to: email.trim(), orgName: req.org!.name, inviteUrl, locale });
      } catch (emailErr) {
        // The invite row exists; surface a soft warning rather than failing the request.
        console.error("[org/members] invite email send failed:", emailErr);
        return res.status(201).json({ invited: true, warning: "Invite created but email failed to send" });
      }

      return res.status(201).json({ invited: true });
    }

    // ── Existing user → add to org directly ──
    const { error } = await db.from("org_members").insert({
      org_id: req.org!.id,
      user_id: user.id,
      role,
      invited_by: req.user!.id,
    });

    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "user is already a member" });
      return res.status(500).json({ error: error.message });
    }

    // Grant the chosen apps to the new member.
    let warning: string | undefined;
    if (apps.length > 0) {
      const rows = apps.map((a) => ({
        org_id: req.org!.id, user_id: user.id, app_id: a.id, granted_by: req.user!.id,
      }));
      const { error: grantErr } = await db.from("user_app_access").insert(rows);
      if (grantErr) {
        // The member was added; surface a warning so the caller knows the app
        // grant didn't stick (they can re-toggle the apps on the member row).
        console.error("[org/members] app grant failed:", grantErr.message);
        warning = "member added but app access failed to save";
      }
    }

    res.status(201).json({
      member: { user_id: user.id, email: user.email, role, app_slugs: warning ? [] : validSlugs },
      invited: false,
      ...(warning ? { warning } : {}),
    });
  },
);

/** PATCH /org/members/:userId/role — owner only */
router.patch("/org/members/:userId/role",
  requireAuth, requireOrg, requireRole("owner"),
  async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { role } = req.body ?? {};
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    // Prevent demoting the last owner
    if (role !== "owner") {
      const { data: owners } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", req.org!.id)
        .eq("role", "owner");
      const ownerIds = (owners ?? []).map((o) => o.user_id);
      if (ownerIds.length === 1 && ownerIds[0] === userId) {
        return res.status(409).json({ error: "cannot demote the last owner" });
      }
    }

    const { data, error } = await db
      .from("org_members")
      .update({ role })
      .eq("org_id", req.org!.id)
      .eq("user_id", userId)
      .select("user_id, role")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: "member not found" });
    res.json({ member: data });
  },
);

/** DELETE /org/members/:userId — owner/admin can remove others; any member can self-leave */
router.delete("/org/members/:userId",
  requireAuth, requireOrg,
  async (req: Request, res: Response) => {
    const { userId } = req.params;
    const isSelf = userId === req.user!.id;
    const isAdmin = req.member!.role === "owner" || req.member!.role === "admin";

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: "only owners/admins can remove other members" });
    }

    // Prevent removing the last owner
    const { data: owners } = await db
      .from("org_members")
      .select("user_id")
      .eq("org_id", req.org!.id)
      .eq("role", "owner");
    const ownerIds = (owners ?? []).map((o) => o.user_id);
    if (ownerIds.length === 1 && ownerIds[0] === userId) {
      return res.status(409).json({ error: "cannot remove the last owner — transfer ownership first" });
    }

    // Admins can't remove owners (only owners can)
    const { data: target } = await db
      .from("org_members")
      .select("role")
      .eq("org_id", req.org!.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (target?.role === "owner" && req.member!.role !== "owner" && !isSelf) {
      return res.status(403).json({ error: "only owners can remove an owner" });
    }

    const { error } = await db
      .from("org_members")
      .delete()
      .eq("org_id", req.org!.id)
      .eq("user_id", userId);

    if (error) return res.status(500).json({ error: error.message });

    // Remove their per-user app grants for this org (no FK cascade from org_members).
    const { error: grantErr } = await db
      .from("user_app_access")
      .delete()
      .eq("org_id", req.org!.id)
      .eq("user_id", userId);
    if (grantErr) console.error("[org/members] app-grant cleanup failed:", grantErr.message);

    res.json({ ok: true });
  },
);

/**
 * PATCH /org/members/:userId/apps — replace which apps a member can use.
 * Body: { app_slugs: string[] }. Slugs are filtered to apps the org has enabled.
 * Owner/admin only. (Editing an owner/admin's grants is harmless — they're
 * unrestricted — but the UI only exposes this for role='member'.)
 */
router.patch("/org/members/:userId/apps",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { app_slugs } = req.body ?? {};
    if (!Array.isArray(app_slugs)) {
      return res.status(400).json({ error: "app_slugs must be an array" });
    }

    // Target must be a member of this org.
    const { data: target } = await db
      .from("org_members").select("user_id")
      .eq("org_id", req.org!.id).eq("user_id", userId).maybeSingle();
    if (!target) return res.status(404).json({ error: "member not found" });

    const apps = await resolveOrgApps(req.org!.id, app_slugs);

    // Replace the full set: clear existing grants, then insert the new ones.
    const { error: delErr } = await db
      .from("user_app_access").delete()
      .eq("org_id", req.org!.id).eq("user_id", userId);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (apps.length > 0) {
      const rows = apps.map((a) => ({
        org_id: req.org!.id, user_id: userId, app_id: a.id, granted_by: req.user!.id,
      }));
      const { error: insErr } = await db.from("user_app_access").insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }

    res.json({ ok: true, app_slugs: apps.map((a) => a.slug) });
  },
);

/** GET /org/invites — pending (not-yet-accepted) invites for the active org */
router.get("/org/invites",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("org_invites")
      .select("id, email, role, app_slugs, expires_at, created_at")
      .eq("org_id", req.org!.id)
      .is("accepted_at", null)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ invites: data ?? [] });
  },
);

/** DELETE /org/invites/:id — revoke a pending invite */
router.delete("/org/invites/:id",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { error, count } = await db
      .from("org_invites")
      .delete({ count: "exact" })
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .is("accepted_at", null);

    if (error) return res.status(500).json({ error: error.message });
    if (count === 0) return res.status(404).json({ error: "invite not found" });
    res.json({ ok: true });
  },
);

/** POST /org/invites/:id/resend — extend expiry by 7 days and re-send the email */
router.post("/org/invites/:id/resend",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const locale = (req.body?.locale === "en" ? "en" : "he") as "he" | "en";
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await db
      .from("org_invites")
      .update({ expires_at: newExpiry })
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .is("accepted_at", null)
      .select("token, email")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!invite) return res.status(404).json({ error: "invite not found" });

    const appUrl = (process.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0].trim();
    const inviteUrl = `${appUrl}/${locale}/invite/${invite.token}`;

    try {
      await sendInviteEmail({ to: invite.email, orgName: req.org!.name, inviteUrl, locale });
    } catch (emailErr) {
      console.error("[org/invites] resend email failed:", emailErr);
      return res.status(201).json({ ok: true, warning: "email failed to send" });
    }

    res.json({ ok: true });
  },
);

export default router;
