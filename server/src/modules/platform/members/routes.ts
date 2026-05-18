/**
 * Org member routes (all require X-Org-Id)
 *   GET     /org/members                — list members of active org
 *   POST    /org/members                — invite by email (must already have an account)
 *   PATCH   /org/members/:userId/role   — change member's role  (owner only)
 *   DELETE  /org/members/:userId        — remove a member       (owner/admin, or self-leave)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole, type Role } from "../../../middleware";

const router = Router();

const ROLES: Role[] = ["owner", "admin", "member"];

/** GET /org/members — list members of active org */
router.get("/org/members", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("org_members")
    .select("user_id, role, joined_at, invited_by")
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

  const members = (data ?? []).map((m) => ({
    user_id: m.user_id,
    role: m.role,
    joined_at: m.joined_at,
    invited_by: m.invited_by,
    email: userMap.get(m.user_id)?.email ?? null,
    name: userMap.get(m.user_id)?.name ?? null,
  }));

  res.json({ members });
});

/** POST /org/members — invite by email. User must already have a Supabase account. */
router.post("/org/members",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { email, role = "member" } = req.body ?? {};
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

    // Find user by email (Supabase admin API)
    // listUsers does pagination by default; for now we read first page (1000 users).
    // If the customer scales past that, this needs to be a server-side RPC.
    const { data: userPage } = await db.auth.admin.listUsers({ perPage: 1000 });
    const user = (userPage?.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase().trim());

    if (!user) {
      return res.status(404).json({
        error: `No user account found for ${email}. Ask them to sign up first, then re-invite.`,
      });
    }

    // Insert membership
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

    res.status(201).json({
      member: { user_id: user.id, email: user.email, role },
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
    res.json({ ok: true });
  },
);

export default router;
