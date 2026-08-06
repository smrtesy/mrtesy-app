// Security plan §5.1 step 2b — read a user_credentials OAuth token from Supabase
// Vault, falling back to the plaintext column during the transition.
//
// The BEFORE INSERT/UPDATE trigger `trg_user_credentials_vault_sync` mirrors every
// plaintext token written to user_credentials into Vault and records the id in the
// matching *_secret_id column. Both stay in sync until step 2c blanks the plaintext
// at rest. So during 2b a reader should PREFER the Vault value but must degrade to
// the plaintext (or a Vault-read error) to exactly today's behaviour — never break
// a live Google integration over a decryption hiccup.
//
// Edge functions call this with their service-role client, which PostgREST runs as
// role `service_role` — the only role `vault_read_secret` permits.

// deno-lint-ignore no-explicit-any
type SupabaseLike = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };

export async function resolveToken(
  supabase: SupabaseLike,
  secretId: string | null | undefined,
  plaintext: string | null | undefined,
): Promise<string | null> {
  if (secretId) {
    const { data, error } = await supabase.rpc("vault_read_secret", { secret_id: secretId });
    if (!error && data) return data as string;
  }
  return plaintext ?? null;
}
