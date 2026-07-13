/**
 * smrtVault — Express routes (authenticated).
 *
 * Every route requires: requireAuth → requireOrg → requireApp("smrtvault").
 *
 * A personal credential vault. The password plaintext is stored ONLY in
 * Supabase Vault (encrypted at rest); the smrtvault_credentials row keeps
 * the Vault secret id plus non-secret metadata. All queries are scoped by
 * BOTH org_id and user_id, so a credential is private to its owner even in
 * a shared org.
 *
 * The password leaves the server only via GET /vault/credentials/:id/reveal
 * (consumed by the browser extension to autofill), and every reveal is
 * recorded in smrtvault_access_log. The list/create/update routes never
 * return a plaintext password.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { notifyError } from "../../lib/platform";

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrtvault"));

// The columns safe to return to the browser — everything EXCEPT the Vault
// pointer and the password plaintext (which is never on the row anyway).
const PUBLIC_COLUMNS = "id, label, username, url, notes, created_at, updated_at";

const MAX_FIELD_LEN = 4096;
const MAX_IMPORT_ROWS = 2000;

/**
 * Create a fresh Vault secret and return its id. Vault secret names must be
 * unique, so we mint a random one; the human-readable label is stored as the
 * description for admin readability. Returns { id, error }.
 */
async function createVaultSecret(
  value: string,
  label: string,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await db.rpc("vault_create_secret", {
    new_secret: value,
    new_name: `smrtvault:${randomUUID()}`,
    new_description: `smrtVault credential: ${label}`.slice(0, 500),
  });
  if (error) return { id: null, error: `vault create: ${error.message}` };
  return { id: (data as string | null) ?? null, error: null };
}

/** Overwrite an existing Vault secret in place. Returns an error string or null. */
async function updateVaultSecret(secretId: string, value: string): Promise<string | null> {
  const { error } = await db.rpc("vault_update_secret", {
    secret_id: secretId,
    new_secret: value,
  });
  return error ? `vault update: ${error.message}` : null;
}

/** Trim + length-guard a free-text field. Returns null for empty input. */
function cleanField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_FIELD_LEN);
}

// ============================================================
// LIST
// ============================================================

/** GET /vault/credentials — the caller's own credentials (metadata only). */
router.get("/vault/credentials", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvault_credentials")
    .select(PUBLIC_COLUMNS)
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .order("label", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ credentials: data ?? [] });
});

// ============================================================
// CREATE
// ============================================================

/**
 * POST /vault/credentials
 * Body: { label, username?, url?, notes?, password }
 * Stores the password in Vault and inserts the metadata row.
 */
router.post("/vault/credentials", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label = cleanField(body.label);
  const password = typeof body.password === "string" ? body.password : "";
  if (!label) return res.status(400).json({ error: "label is required" });
  if (!password) return res.status(400).json({ error: "password is required" });

  const { id: secretId, error: vaultErr } = await createVaultSecret(password, label);
  if (vaultErr || !secretId) {
    await notifyError(req.org!.id, "smrtvault", {
      title: "Failed to store credential secret",
      body: vaultErr ?? "no secret id",
    });
    return res.status(500).json({ error: vaultErr ?? "vault error" });
  }

  const { data, error } = await db
    .from("smrtvault_credentials")
    .insert({
      org_id: req.org!.id,
      user_id: req.user!.id,
      label,
      username: cleanField(body.username),
      url: cleanField(body.url),
      notes: cleanField(body.notes),
      password_secret_id: secretId,
    })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) {
    // Best-effort: neutralize the orphaned secret we just created.
    await updateVaultSecret(secretId, "");
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ credential: data });
});

// ============================================================
// UPDATE
// ============================================================

/**
 * PATCH /vault/credentials/:id
 * Body: { label?, username?, url?, notes?, password? }
 * Updates metadata; if a non-empty `password` is supplied, rotates the
 * Vault secret in place.
 */
router.patch("/vault/credentials/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Fetch the row (scoped) so we own the secret id before touching Vault.
  const { data: row, error: fetchErr } = await db
    .from("smrtvault_credentials")
    .select("id, password_secret_id")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "credential not found" });

  // Rotate the password first (if provided) — a Vault failure must not leave
  // metadata claiming a change that didn't happen.
  if (typeof body.password === "string" && body.password.length > 0) {
    const vaultErr = await updateVaultSecret(row.password_secret_id, body.password);
    if (vaultErr) {
      await notifyError(req.org!.id, "smrtvault", {
        title: "Failed to rotate credential secret",
        body: vaultErr,
      });
      return res.status(500).json({ error: vaultErr });
    }
  }

  const patch: Record<string, unknown> = {};
  if ("label" in body) {
    const label = cleanField(body.label);
    if (!label) return res.status(400).json({ error: "label cannot be empty" });
    patch.label = label;
  }
  if ("username" in body) patch.username = cleanField(body.username);
  if ("url" in body) patch.url = cleanField(body.url);
  if ("notes" in body) patch.notes = cleanField(body.notes);

  if (Object.keys(patch).length === 0) {
    return res.json({ ok: true });
  }

  const { data, error } = await db
    .from("smrtvault_credentials")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ credential: data });
});

// ============================================================
// DELETE
// ============================================================

/**
 * DELETE /vault/credentials/:id
 * Neutralizes the Vault secret (overwrite with empty), then deletes the row.
 */
router.delete("/vault/credentials/:id", async (req: Request, res: Response) => {
  const { data: row, error: fetchErr } = await db
    .from("smrtvault_credentials")
    .select("id, password_secret_id")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "credential not found" });

  // Leave no readable plaintext behind (Vault has no delete RPC here). If the
  // overwrite fails we must NOT delete the row — it's the only pointer to the
  // secret, and dropping it would orphan a secret that still holds the
  // original plaintext, breaking the "no readable plaintext" guarantee.
  const neutralizeErr = await updateVaultSecret(row.password_secret_id, "");
  if (neutralizeErr) {
    await notifyError(req.org!.id, "smrtvault", {
      title: "Failed to neutralize credential secret on delete",
      body: neutralizeErr,
    });
    return res.status(500).json({ error: neutralizeErr });
  }

  const { error } = await db
    .from("smrtvault_credentials")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// REVEAL  (consumed by the browser extension to autofill)
// ============================================================

/**
 * GET /vault/credentials/:id/reveal
 * Returns { username, password } for a single credential and records the
 * access in smrtvault_access_log. This is the ONLY route that returns a
 * plaintext password.
 */
router.get("/vault/credentials/:id/reveal", async (req: Request, res: Response) => {
  const { data: row, error: fetchErr } = await db
    .from("smrtvault_credentials")
    .select("id, username, password_secret_id")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "credential not found" });

  const { data: secret, error: vaultErr } = await db.rpc("vault_read_secret", {
    secret_id: row.password_secret_id,
  });
  if (vaultErr) {
    await notifyError(req.org!.id, "smrtvault", {
      title: "Failed to reveal credential",
      body: vaultErr.message,
    });
    return res.status(500).json({ error: vaultErr.message });
  }

  // Audit the reveal (best-effort — never block the reveal on a log failure).
  const { error: logErr } = await db.from("smrtvault_access_log").insert({
    org_id: req.org!.id,
    user_id: req.user!.id,
    credential_id: row.id,
    action: "reveal",
  });
  if (logErr) console.error("smrtvault access log:", logErr.message);

  res.json({ username: row.username, password: (secret as string | null) ?? "" });
});

// ============================================================
// IMPORT  (bulk — e.g. a Chrome password CSV export)
// ============================================================

/**
 * POST /vault/credentials/import
 * Body: { rows: Array<{ label, username?, url?, password, notes? }> }
 * Creates a Vault secret + metadata row per entry. Rows missing a label or
 * password are skipped. Returns { imported, skipped }.
 */
router.post("/vault/credentials/import", async (req: Request, res: Response) => {
  const rows = (req.body as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows must be an array" });
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ error: `too many rows (max ${MAX_IMPORT_ROWS})` });
  }

  let imported = 0;
  let skipped = 0;
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const label = cleanField(r.label) ?? cleanField(r.url);
    const password = typeof r.password === "string" ? r.password : "";
    if (!label || !password) {
      skipped++;
      continue;
    }

    const { id: secretId, error: vaultErr } = await createVaultSecret(password, label);
    if (vaultErr || !secretId) {
      skipped++;
      continue;
    }

    const { error } = await db.from("smrtvault_credentials").insert({
      org_id: req.org!.id,
      user_id: req.user!.id,
      label,
      username: cleanField(r.username),
      url: cleanField(r.url),
      notes: cleanField(r.notes),
      password_secret_id: secretId,
    });
    if (error) {
      await updateVaultSecret(secretId, "");
      skipped++;
      continue;
    }
    imported++;
  }

  res.json({ imported, skipped });
});

export default router;
