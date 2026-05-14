/**
 * Organization routes
 *   POST   /orgs           — create a new org (caller becomes owner)
 *   GET    /orgs/me        — list orgs the caller is a member of
 *   GET    /org            — details of the active org (X-Org-Id)
 *   PATCH  /org            — update active org (owner/admin)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole } from "../../../middleware";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

// ── routes ─────────────────────────────────────────────────────────────────

/** POST /orgs — create a new organization. Caller becomes owner. */
router.post("/orgs", requireAuth, async (req: Request, res: Response) => {
  const { name, name_he, slug } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const finalSlug = (typeof slug === "string" && slug.trim()) ? slug.trim() : slugify(name);

  // Create org
  const { data: org, error: orgErr } = await db
    .from("organizations")
    .insert({
      slug: finalSlug,
      name: name.trim(),
      name_he: name_he?.trim() || null,
      created_by: req.user!.id,
    })
    .select("*")
    .single();

  if (orgErr) {
    if (orgErr.code === "23505") return res.status(409).json({ error: "slug already taken" });
    return res.status(500).json({ error: orgErr.message });
  }

  // Add creator as owner
  const { error: mErr } = await db.from("org_members").insert({
    org_id: org.id,
    user_id: req.user!.id,
    role: "owner",
    invited_by: req.user!.id,
  });

  if (mErr) {
    // Roll back org so we don't leave an orphaned record
    await db.from("organizations").delete().eq("id", org.id);
    return res.status(500).json({ error: `failed to add creator as owner: ${mErr.message}` });
  }

  res.status(201).json({ org });
});

/** GET /orgs/me — list orgs the caller belongs to, with their role in each. */
router.get("/orgs/me", requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("org_members")
    .select("role, joined_at, organizations(id, slug, name, name_he, created_at)")
    .eq("user_id", req.user!.id)
    .order("joined_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Supabase types this as array but it's really 1:1 — normalise.
  const orgs = (data ?? []).map((m) => {
    const orgField = m.organizations as Record<string, unknown> | Record<string, unknown>[] | null;
    const org = Array.isArray(orgField) ? orgField[0] : orgField;
    return { ...(org ?? {}), role: m.role, joined_at: m.joined_at };
  });

  res.json({ orgs });
});

/** GET /org — details of the active org (X-Org-Id header). */
router.get("/org", requireAuth, requireOrg, async (req: Request, res: Response) => {
  // requireOrg already loaded basic fields. Load full row for richer details.
  const { data, error } = await db
    .from("organizations")
    .select("*")
    .eq("id", req.org!.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ org: data, my_role: req.member!.role });
});

/** PATCH /org — update active org. Owner/admin only. */
router.patch("/org",
  requireAuth, requireOrg, requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { name, name_he } = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (typeof name === "string" && name.trim()) updates.name = name.trim();
    if (typeof name_he === "string") updates.name_he = name_he.trim() || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "nothing to update" });
    }

    const { data, error } = await db
      .from("organizations")
      .update(updates)
      .eq("id", req.org!.id)
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ org: data });
  },
);

export default router;
