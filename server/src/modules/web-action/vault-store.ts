/**
 * web-action — store an extracted API key / password in smrtVault.
 *
 * Mirrors the smrtVault create path (server/src/modules/smrtvault/routes.ts):
 * the secret goes into Supabase Vault (encrypted at rest) and only the Vault
 * pointer + non-secret metadata (label/url/username/notes) lands on
 * smrtvault_credentials, scoped by org_id + user_id. The secret is NEVER logged
 * or returned. This is how a signup the agent completes hands its API key back
 * to the user's own vault.
 */

import { randomUUID } from "crypto";
import { db } from "../../db";

export interface StoredCredential {
  id: string;
  label: string;
  url: string | null;
  username: string | null;
}

const MAX = 4096;
const clip = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, MAX) : null;
};

export async function storeSecret(params: {
  userId: string;
  orgId: string;
  label: string;
  secret: string;
  url?: string | null;
  username?: string | null;
  notes?: string | null;
}): Promise<StoredCredential> {
  const label = clip(params.label);
  if (!label) throw new Error("label is required");
  if (!params.secret) throw new Error("secret is required");

  const { data: secretId, error: vErr } = await db.rpc("vault_create_secret", {
    new_secret: params.secret,
    new_name: `smrtvault:${randomUUID()}`,
    new_description: `smrtVault credential: ${label}`.slice(0, 500),
  });
  if (vErr || !secretId) throw new Error(`vault create: ${vErr?.message ?? "no secret id"}`);

  const { data, error } = await db
    .from("smrtvault_credentials")
    .insert({
      org_id: params.orgId,
      user_id: params.userId,
      label,
      username: clip(params.username),
      url: clip(params.url),
      notes: clip(params.notes),
      password_secret_id: secretId as string,
    })
    .select("id, label, url, username")
    .single();
  if (error) {
    // Best-effort: neutralize the orphaned Vault secret we just created.
    await db.rpc("vault_update_secret", { secret_id: secretId, new_secret: "" }).then(
      () => {},
      () => {},
    );
    throw new Error(error.message);
  }
  return data as StoredCredential;
}
