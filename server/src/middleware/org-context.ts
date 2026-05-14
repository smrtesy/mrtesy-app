/**
 * requireOrg — resolves the active organization from the `X-Org-Id` header,
 * verifies the authenticated user is a member of it, and attaches:
 *   • req.org    = { id, slug, name }
 *   • req.member = { org_id, user_id, role }
 *
 * Must run AFTER requireAuth. Returns 400 if header missing, 403 if not a member.
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";

export async function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(500).json({ error: "requireOrg used without requireAuth" });
  }

  const orgId = req.headers["x-org-id"];
  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "X-Org-Id header is required" });
  }

  // Single query: verify membership AND load org details
  // Service-role client bypasses RLS — that's intentional here.
  const { data: member, error: mErr } = await db
    .from("org_members")
    .select("org_id, user_id, role")
    .eq("org_id", orgId)
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (mErr) {
    return res.status(500).json({ error: `org lookup failed: ${mErr.message}` });
  }
  if (!member) {
    return res.status(403).json({ error: "You are not a member of this organization" });
  }

  const { data: org, error: oErr } = await db
    .from("organizations")
    .select("id, slug, name")
    .eq("id", orgId)
    .single();

  if (oErr || !org) {
    return res.status(404).json({ error: "Organization not found" });
  }

  req.org = { id: org.id as string, slug: org.slug as string, name: org.name as string };
  req.member = {
    org_id: member.org_id as string,
    user_id: member.user_id as string,
    role: member.role as "owner" | "admin" | "member",
  };

  next();
}
