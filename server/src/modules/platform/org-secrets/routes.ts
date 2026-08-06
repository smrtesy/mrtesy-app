/**
 * Per-org secrets (security plan §7 step 6 / §5.4).
 *
 *   GET    /org/secrets          — list this org's secrets (metadata only)
 *   POST   /org/secrets          — add or rotate a secret  { key, value, is_secret?, notes? }
 *   DELETE /org/secrets/:key     — remove a secret row
 *
 * These are secrets an ORG brings itself (its own WhatsApp/OpenAI/SMTP/… keys),
 * NOT the platform-wide app_secrets (which stay super-admin-only). Every route
 * is owner-only, developer-excluded, and scoped to the request's org
 * (req.org.id from X-Org-Id) — an owner of org A can never see org B's secrets,
 * even though the same person may own several orgs (§5.4 decision א).
 *
 * The value is encrypted through Supabase Vault when secret; the row keeps only
 * value_secret_id. The plaintext is NEVER returned to the client — the list
 * reports is_set + a last-4 hint (owner's own key), nothing more.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireRole, denyDeveloper } from "../../../middleware";

const router = Router();

/** Free-form but safe: a key someone will paste into env/config later. Letters,
 *  digits, underscore, dot, dash; 1–64 chars. Rejects spaces/quotes that would
 *  make the key un-lookupable or unsafe to interpolate. */
const KEY_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Write one org secret, encrypting through Vault when it is secret. Mirrors
 * writeAppSecret but keyed by (org_id, key). Rotates in place when the key
 * already exists (friendlier on the vault audit log than orphaning + recreating).
 * Returns an error message on failure, or null on success. Never throws.
 */
async function writeOrgSecret(
  orgId: string, key: string, value: string, isSecret: boolean,
  notes: string | null, createdBy: string,
): Promise<string | null> {
  // created_by records who last set this key (on rotate it reflects the latest
  // writer — org secrets are owner-managed, so this is a light who-touched-it
  // audit, not a strict "original creator").
  if (!isSecret) {
    const { error } = await db
      .from("org_secrets")
      .upsert(
        { org_id: orgId, key, is_secret: false, value_text: value, value_secret_id: null, notes, created_by: createdBy, updated_at: new Date().toISOString() },
        { onConflict: "org_id,key" },
      );
    return error ? error.message : null;
  }

  // FAIL CLOSED on a read error: treating a failed lookup as "no existing
  // secret" would mint a second vault entry and orphan the working one.
  const { data: existing, error: lookupErr } = await db
    .from("org_secrets")
    .select("value_secret_id")
    .eq("org_id", orgId)
    .eq("key", key)
    .maybeSingle();
  if (lookupErr) return `could not read the existing secret: ${lookupErr.message}`;

  const existingId = (existing?.value_secret_id as string | null | undefined) ?? null;
  let secretId: string | null = existingId;

  if (existingId) {
    const { error } = await db.rpc("vault_update_secret", { secret_id: existingId, new_secret: value });
    if (error) return `vault update: ${error.message}`;
  } else {
    const { data: created, error } = await db.rpc("vault_create_secret", {
      new_secret: value,
      new_name: `org_secret:${orgId}:${key}`,
      new_description: `Org secret ${key} for ${orgId}`,
    });
    if (error) return `vault create: ${error.message}`;
    secretId = (created as string | null) ?? null;
  }

  const { error: upsertErr } = await db
    .from("org_secrets")
    .upsert(
      { org_id: orgId, key, is_secret: true, value_secret_id: secretId, value_text: null, notes, created_by: createdBy, updated_at: new Date().toISOString() },
      { onConflict: "org_id,key" },
    );
  return upsertErr ? upsertErr.message : null;
}

/** GET /org/secrets — metadata for the active org's secrets. Never the value:
 *  secret → { is_set, last4 } (last4 read best-effort from Vault); plain config
 *  → value_text. Owner-only, developer-excluded, scoped to req.org.id. */
router.get("/org/secrets",
  requireAuth, requireOrg, requireRole("owner"), denyDeveloper,
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("org_secrets")
      .select("key, is_secret, value_text, value_secret_id, notes, updated_at")
      .eq("org_id", req.org!.id)
      .order("key", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const secrets = await Promise.all((data ?? []).map(async (r) => {
      const isSecret = r.is_secret === true;
      let last4: string | null = null;
      const secretId = r.value_secret_id as string | null;
      if (isSecret && secretId) {
        // Best-effort last-4 hint so the owner can tell which value is stored.
        const { data: plain } = await db.rpc("vault_read_secret", { secret_id: secretId });
        if (typeof plain === "string" && plain.length > 0) last4 = plain.slice(-4);
      }
      return {
        key: r.key as string,
        is_secret: isSecret,
        is_set: isSecret ? !!secretId : (r.value_text != null && r.value_text !== ""),
        last4,
        value_text: isSecret ? null : ((r.value_text as string | null) ?? null),
        notes: (r.notes as string | null) ?? null,
        updated_at: r.updated_at as string,
      };
    }));
    res.json({ secrets });
  },
);

/** POST /org/secrets — add or rotate a secret for the active org. */
router.post("/org/secrets",
  requireAuth, requireOrg, requireRole("owner"), denyDeveloper,
  async (req: Request, res: Response) => {
    const { key, value, is_secret, notes } = (req.body ?? {}) as {
      key?: unknown; value?: unknown; is_secret?: unknown; notes?: unknown;
    };
    if (typeof key !== "string" || !KEY_RE.test(key.trim())) {
      return res.status(400).json({ error: "key must be 1–64 chars: letters, digits, _ . -" });
    }
    if (typeof value !== "string" || value.length === 0) {
      return res.status(400).json({ error: "value is required" });
    }
    const isSecret = is_secret === undefined ? true : is_secret === true;
    const noteStr = typeof notes === "string" && notes.trim() ? notes.trim() : null;

    const err = await writeOrgSecret(req.org!.id, key.trim(), value, isSecret, noteStr, req.user!.id);
    if (err) return res.status(500).json({ error: err });
    res.status(201).json({ ok: true, key: key.trim(), is_secret: isSecret });
  },
);

/** DELETE /org/secrets/:key — remove a secret row for the active org.
 *  NOTE: Supabase Vault exposes no delete RPC, so the encrypted value is
 *  orphaned in the vault (unreferenced, unreadable without its id) — the same
 *  limitation app_secrets has. The row (the only pointer) is gone. */
router.delete("/org/secrets/:key",
  requireAuth, requireOrg, requireRole("owner"), denyDeveloper,
  async (req: Request, res: Response) => {
    const { error, count } = await db
      .from("org_secrets")
      .delete({ count: "exact" })
      .eq("org_id", req.org!.id)
      .eq("key", req.params.key);
    if (error) return res.status(500).json({ error: error.message });
    if (count === 0) return res.status(404).json({ error: "secret not found" });
    res.json({ ok: true });
  },
);

export default router;
