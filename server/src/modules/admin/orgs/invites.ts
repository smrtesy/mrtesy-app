/**
 * Admin: invite routes for organizations.
 * All require requireAuth + requireSuperAdmin (registered in routes.ts).
 *
 *   GET    /admin/orgs/:id/invites          list pending invites
 *   POST   /admin/orgs/:id/invites          create + send invite email
 *   DELETE /admin/orgs/:id/invites/:iid     revoke a pending invite
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { sendInviteEmail } from "../../../lib/email";

const router = Router({ mergeParams: true });

const VALID_ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof VALID_ROLES)[number];

/** GET /admin/orgs/:id/invites — list all pending (not accepted) invites */
router.get("/", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("org_invites")
    .select("id, email, role, expires_at, accepted_at, created_at, invited_by")
    .eq("org_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ invites: data ?? [] });
});

/** POST /admin/orgs/:id/invites — create invite and send email */
router.post("/", async (req: Request, res: Response) => {
  const { email, role = "member", locale = "he" } = req.body ?? {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required" });
  }
  if (!VALID_ROLES.includes(role as Role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
  }

  // Verify the org exists
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .eq("id", req.params.id)
    .maybeSingle();
  if (!org) return res.status(404).json({ error: "org not found" });

  // Check for an existing non-expired, non-accepted invite for this email+org
  const { data: existing } = await db
    .from("org_invites")
    .select("id")
    .eq("org_id", req.params.id)
    .eq("email", email.trim().toLowerCase())
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ error: "An active invite already exists for this email" });
  }

  // Create the invite row
  const { data: invite, error: insertErr } = await db
    .from("org_invites")
    .insert({
      email: email.trim().toLowerCase(),
      org_id: req.params.id,
      role,
      invited_by: req.user!.id,
    })
    .select("token")
    .single();

  if (insertErr) return res.status(500).json({ error: insertErr.message });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const inviteUrl = `${appUrl}/${locale}/invite/${invite.token}`;

  try {
    await sendInviteEmail({
      to: email.trim(),
      orgName: org.name,
      inviteUrl,
      locale,
    });
  } catch (emailErr) {
    // Don't fail the whole request if email sending fails — the invite was created
    console.error("[invites] email send failed:", emailErr);
    return res.status(201).json({ ok: true, warning: "Invite created but email failed to send", inviteUrl });
  }

  res.status(201).json({ ok: true, inviteUrl });
});

/** DELETE /admin/orgs/:id/invites/:iid — revoke */
router.delete("/:iid", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("org_invites")
    .delete({ count: "exact" })
    .eq("id", req.params.iid)
    .eq("org_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "invite not found" });
  res.json({ ok: true });
});

export default router;
