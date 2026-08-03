/**
 * Permission management routes (all require X-Org-Id).
 *
 * The "open-by-default, restrict-specific-things" layer on top of app
 * entitlements — see docs/permissions-management-plan.md. Management is
 * owner/admin-only; a super-admin acting in an org is an admin there (or was
 * blocked by requireOrg). Reads for the signed-in user's own restricted set are
 * open to any member.
 *
 *   GET    /org/permissions/catalog          — registry + org's restriction state   (owner/admin)
 *   PUT    /org/permissions/restrictions      — set a resource restricted on/off      (owner/admin)
 *   GET    /org/permissions/users/:userId     — one user's effective access           (owner/admin)
 *   POST   /org/permissions/grants            — grant a user an exception             (owner/admin)
 *   DELETE /org/permissions/grants            — revoke a user's exception             (owner/admin)
 *   GET    /org/permissions/audit             — recent permission changes            (owner/admin)
 *   GET    /org/permissions/me                — the caller's own restricted set        (any member)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole } from "../../../middleware";
import {
  RESTRICTABLE_RESOURCES,
  isValidResourceKey,
} from "../../../lib/permissions/registry";
import {
  computeRestrictedSet,
  invalidatePermissions,
  isRestrictedForOrg,
  type OrgRole,
} from "../../../lib/permissions/resolve";

const router = Router();

type AuditAction =
  | "restrict"
  | "unrestrict"
  | "grant"
  | "revoke"
  | "request"
  | "approve"
  | "deny";

/** Append a permission-change row. Best-effort — never fails the request. */
async function writeAudit(params: {
  orgId: string;
  actorUserId: string;
  action: AuditAction;
  targetUserId?: string | null;
  resourceKey?: string | null;
  details?: Record<string, unknown>;
  note?: string | null;
}): Promise<void> {
  const { error } = await db.from("permission_audit_log").insert({
    org_id: params.orgId,
    actor_user_id: params.actorUserId,
    action: params.action,
    target_user_id: params.targetUserId ?? null,
    resource_key: params.resourceKey ?? null,
    details: params.details ?? {},
    note: params.note ?? null,
  });
  if (error) console.error("[permissions] audit write failed:", error.message);
}

/** Load the org's explicit restriction rows into a Map<key, restricted>. */
async function loadOrgRestrictionMap(orgId: string): Promise<Map<string, boolean>> {
  const { data, error } = await db
    .from("org_restrictions")
    .select("resource_key, restricted")
    .eq("org_id", orgId);
  if (error) throw new Error(error.message);
  const map = new Map<string, boolean>();
  for (const row of data ?? []) map.set(row.resource_key as string, row.restricted as boolean);
  return map;
}

/**
 * GET /org/permissions/catalog — the full registry plus this org's effective
 * restriction state for each resource (so the admin UI renders one row per
 * resource with a correct toggle).
 */
router.get(
  "/org/permissions/catalog",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    try {
      const orgMap = await loadOrgRestrictionMap(req.org!.id);
      const resources = RESTRICTABLE_RESOURCES.map((r) => ({
        key: r.key,
        appSlug: r.appSlug,
        kind: r.kind,
        labelKey: r.labelKey,
        descriptionKey: r.descriptionKey ?? null,
        defaultRestricted: r.defaultRestricted,
        costly: !!r.costly,
        restricted: isRestrictedForOrg(orgMap, r.key),
        explicit: orgMap.has(r.key),
      }));
      res.json({ resources });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * PUT /org/permissions/restrictions — set one resource restricted on/off for
 * the org. Body: { resource_key: string, restricted: boolean }.
 */
router.put(
  "/org/permissions/restrictions",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { resource_key, restricted } = req.body ?? {};
    if (typeof resource_key !== "string" || !isValidResourceKey(resource_key)) {
      return res.status(400).json({ error: "unknown resource_key" });
    }
    if (typeof restricted !== "boolean") {
      return res.status(400).json({ error: "restricted must be a boolean" });
    }

    const { error } = await db
      .from("org_restrictions")
      .upsert(
        {
          org_id: req.org!.id,
          resource_key,
          restricted,
          updated_by: req.user!.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_id,resource_key" },
      );
    if (error) return res.status(500).json({ error: error.message });

    invalidatePermissions(req.org!.id);
    await writeAudit({
      orgId: req.org!.id,
      actorUserId: req.user!.id,
      action: restricted ? "restrict" : "unrestrict",
      resourceKey: resource_key,
    });
    res.json({ ok: true, resource_key, restricted });
  },
);

/**
 * GET /org/permissions/users/:userId — one member's effective access: for every
 * catalog resource, whether the org restricts it and whether the user has an
 * active exception. Owners/admins are shown as unrestricted (they bypass).
 */
router.get(
  "/org/permissions/users/:userId",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { userId } = req.params;
    try {
      const { data: target } = await db
        .from("org_members")
        .select("role")
        .eq("org_id", req.org!.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!target) return res.status(404).json({ error: "member not found" });
      const role = target.role as OrgRole;
      const bypasses = role === "owner" || role === "admin";

      const [orgMap, grantsRes] = await Promise.all([
        loadOrgRestrictionMap(req.org!.id),
        db
          .from("user_resource_grants")
          .select("resource_key")
          .eq("org_id", req.org!.id)
          .eq("user_id", userId)
          .is("revoked_at", null),
      ]);
      if (grantsRes.error) return res.status(500).json({ error: grantsRes.error.message });
      const granted = new Set((grantsRes.data ?? []).map((g) => g.resource_key as string));

      const resources = RESTRICTABLE_RESOURCES.map((r) => {
        const restricted = isRestrictedForOrg(orgMap, r.key);
        const hasGrant = granted.has(r.key);
        return {
          key: r.key,
          appSlug: r.appSlug,
          kind: r.kind,
          labelKey: r.labelKey,
          restricted,
          granted: hasGrant,
          // What the user actually gets: admins bypass; otherwise open unless
          // restricted-and-not-granted.
          allowed: bypasses || !restricted || hasGrant,
        };
      });

      res.json({ role, bypasses, resources });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * POST /org/permissions/grants — grant a member an exception (a pass through a
 * restriction). Body: { user_id, resource_key }. Idempotent: re-granting an
 * already-active exception is a no-op success.
 */
router.post(
  "/org/permissions/grants",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { user_id, resource_key } = req.body ?? {};
    if (typeof user_id !== "string") {
      return res.status(400).json({ error: "user_id is required" });
    }
    if (typeof resource_key !== "string" || !isValidResourceKey(resource_key)) {
      return res.status(400).json({ error: "unknown resource_key" });
    }

    const { data: target } = await db
      .from("org_members")
      .select("user_id")
      .eq("org_id", req.org!.id)
      .eq("user_id", user_id)
      .maybeSingle();
    if (!target) return res.status(404).json({ error: "member not found" });

    // Already an active grant? Nothing to do (unique partial index would reject
    // a duplicate anyway).
    const { data: existing } = await db
      .from("user_resource_grants")
      .select("id")
      .eq("org_id", req.org!.id)
      .eq("user_id", user_id)
      .eq("resource_key", resource_key)
      .is("revoked_at", null)
      .maybeSingle();
    if (existing) return res.json({ ok: true, already: true });

    const { error } = await db.from("user_resource_grants").insert({
      org_id: req.org!.id,
      user_id,
      resource_key,
      source: "admin",
      granted_by: req.user!.id,
    });
    if (error) return res.status(500).json({ error: error.message });

    invalidatePermissions(req.org!.id, user_id);
    await writeAudit({
      orgId: req.org!.id,
      actorUserId: req.user!.id,
      action: "grant",
      targetUserId: user_id,
      resourceKey: resource_key,
    });
    res.json({ ok: true });
  },
);

/**
 * DELETE /org/permissions/grants — revoke a member's active exception (soft:
 * sets revoked_at, keeping the row for the audit trail).
 * Body: { user_id, resource_key }.
 */
router.delete(
  "/org/permissions/grants",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { user_id, resource_key } = req.body ?? {};
    if (typeof user_id !== "string" || typeof resource_key !== "string") {
      return res.status(400).json({ error: "user_id and resource_key are required" });
    }

    const { data: updated, error } = await db
      .from("user_resource_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("org_id", req.org!.id)
      .eq("user_id", user_id)
      .eq("resource_key", resource_key)
      .is("revoked_at", null)
      .select("id");
    if (error) return res.status(500).json({ error: error.message });

    invalidatePermissions(req.org!.id, user_id);
    if ((updated ?? []).length > 0) {
      await writeAudit({
        orgId: req.org!.id,
        actorUserId: req.user!.id,
        action: "revoke",
        targetUserId: user_id,
        resourceKey: resource_key,
      });
    }
    res.json({ ok: true, revoked: (updated ?? []).length });
  },
);

/** GET /org/permissions/audit — recent permission changes (newest first). */
router.get(
  "/org/permissions/audit",
  requireAuth,
  requireOrg,
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("permission_audit_log")
      .select("id, actor_user_id, action, target_user_id, resource_key, details, note, created_at")
      .eq("org_id", req.org!.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ entries: data ?? [] });
  },
);

/**
 * GET /org/permissions/me — the caller's own restricted resource keys. The
 * layout resolves this server-side for first paint; this endpoint backs client
 * refreshes (e.g. after an admin grants access in another tab).
 */
router.get(
  "/org/permissions/me",
  requireAuth,
  requireOrg,
  async (req: Request, res: Response) => {
    try {
      const restricted = await computeRestrictedSet(
        req.org!.id,
        req.user!.id,
        req.member!.role as OrgRole,
      );
      res.json({ restricted_resources: restricted });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
