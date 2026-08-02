/**
 * Supabase Vault helpers for managed secrets — the exact same RPC surface the
 * app_secrets editor uses (vault_create_secret / vault_update_secret /
 * vault_read_secret), extracted so the managed-secrets routes never open-code the
 * vault branch. There is deliberately no delete: Supabase exposes no vault_delete,
 * so a value is retired by rotating it to a new value in place.
 */

import { db } from "../../../db";

/** Decrypt a Vault secret. Throws on error so a caller never proceeds with a
 *  half-read value (fail closed). */
export async function vaultRead(secretId: string): Promise<string | null> {
  const { data, error } = await db.rpc("vault_read_secret", { secret_id: secretId });
  if (error) throw new Error(`vault read: ${error.message}`);
  return typeof data === "string" ? data : null;
}

/**
 * Rotate-in-place-or-create. When an id exists we update that vault entry (friendlier
 * on the audit log than minting a second entry and orphaning the first); otherwise we
 * create a named entry and return its new id.
 */
export async function vaultWrite(
  existingId: string | null,
  value: string,
  name: string,
  description: string,
): Promise<string> {
  if (existingId) {
    const { error } = await db.rpc("vault_update_secret", {
      secret_id: existingId,
      new_secret: value,
    });
    if (error) throw new Error(`vault update: ${error.message}`);
    return existingId;
  }
  const { data, error } = await db.rpc("vault_create_secret", {
    new_secret: value,
    new_name: name,
    new_description: description,
  });
  if (error) throw new Error(`vault create: ${error.message}`);
  const id = (data as string | null) ?? null;
  if (!id) throw new Error("vault create returned no id");
  return id;
}
