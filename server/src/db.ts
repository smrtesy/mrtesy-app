import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// ESM hoists imports — `db.ts` is imported by `index.ts` BEFORE its body runs,
// so dotenv.config() in index.ts is too late. Loading here, in this file,
// ensures env vars exist by the time we read them three lines down.
// `override: true` makes the .env file win over any shell-set empties.
dotenv.config({ override: true });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

export const db = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ── Helper: load active rules for a user ─────────────────────────────────────
export async function loadRules(userId: string) {
  const { data, error } = await db
    .from("rules_memory")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) throw new Error(`loadRules: ${error.message}`);
  return data ?? [];
}

// ── Helper: create a run session ─────────────────────────────────────────────
export async function createRunSession(
  userId: string,
  part: string,
  runType: string,
  modelUsed?: string,
) {
  const title = `${part.toUpperCase()} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const { data, error } = await db
    .from("run_sessions")
    .insert({
      user_id: userId,
      run_title: title,
      run_type: runType,
      part,
      status: "running",
      model_used: modelUsed ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`createRunSession: ${error.message}`);
  return data.id as string;
}

// ── Helper: close a run session ───────────────────────────────────────────────
export async function closeRunSession(
  sessionId: string,
  status: "completed" | "partial" | "failed",
  counts: {
    items_processed?: number;
    items_skipped?: number;
    tasks_created?: number;
    tasks_updated?: number;
    actionable_count?: number;
    informational_count?: number;
    rules_added?: number;
    errors_count?: number;
  },
  summary?: string,
  errorsLog?: unknown[],
) {
  const startedAt = await db
    .from("run_sessions")
    .select("started_at")
    .eq("id", sessionId)
    .single()
    .then((r) => r.data?.started_at);

  const endedAt = new Date().toISOString();
  const durationSeconds = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)
    : null;

  await db
    .from("run_sessions")
    .update({
      status,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      summary,
      errors_log: errorsLog ?? [],
      ...counts,
    })
    .eq("id", sessionId);
}

// ── Helper: upsert sync_state checkpoint ─────────────────────────────────────
export async function updateSyncState(
  userId: string,
  source: string,
  checkpoint: string | null,
  extra?: { last_error?: string; consecutive_failures?: number },
) {
  await db.from("sync_state").upsert(
    {
      user_id: userId,
      source,
      checkpoint,
      last_synced_at: new Date().toISOString(),
      ...extra,
    },
    { onConflict: "user_id,source" },
  );
}

// ── Helper: read a platform-wide app secret/config value ────────────────────
//
// Reads from `app_secrets` (the operator-managed table edited via the
// admin UI). Decrypts via Vault when the row is marked is_secret. Falls
// back to the named env var when the row isn't there yet — handy during
// the transition from env-driven to UI-driven secrets, and a safety net
// for anything the operator hasn't bothered to set.
//
// Lightweight in-memory cache (10s TTL) so a busy webhook doesn't
// round-trip Supabase per message.

interface AppSecretCacheEntry {
  value: string | null;
  expires: number;
}
const APP_SECRET_TTL_MS = 10_000;
const appSecretCache = new Map<string, AppSecretCacheEntry>();

export async function getAppSecret(
  appSlug: string,
  key: string,
  envFallback?: string,
): Promise<string | null> {
  const cacheKey = `${appSlug}:${key}`;
  const cached = appSecretCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const { data: app } = await db.from("apps").select("id").eq("slug", appSlug).maybeSingle();
  if (!app) {
    const fallback = envFallback ? process.env[envFallback] ?? null : null;
    appSecretCache.set(cacheKey, { value: fallback, expires: Date.now() + APP_SECRET_TTL_MS });
    return fallback;
  }

  const { data: row } = await db
    .from("app_secrets")
    .select("is_secret, value_text, value_secret_id")
    .eq("app_id", app.id)
    .eq("key", key)
    .maybeSingle();

  let value: string | null = null;
  if (row) {
    if (row.is_secret && row.value_secret_id) {
      const { data: plaintext } = await db.rpc("vault_read_secret", {
        secret_id: row.value_secret_id,
      });
      value = typeof plaintext === "string" ? plaintext : null;
    } else if (!row.is_secret) {
      value = (row.value_text as string | null) ?? null;
    }
  }

  if (value === null && envFallback) {
    value = process.env[envFallback] ?? null;
  }

  appSecretCache.set(cacheKey, { value, expires: Date.now() + APP_SECRET_TTL_MS });
  return value;
}

/** Clear the app-secret cache. Call after a write so the next read sees fresh data. */
export function invalidateAppSecretCache(appSlug: string, key?: string): void {
  if (key) {
    appSecretCache.delete(`${appSlug}:${key}`);
  } else {
    for (const k of [...appSecretCache.keys()]) {
      if (k.startsWith(`${appSlug}:`)) appSecretCache.delete(k);
    }
  }
}

// ── Helper: get OAuth credentials for a user ─────────────────────────────────
export async function getCredentials(userId: string, service: string) {
  const { data, error } = await db
    .from("user_credentials")
    .select("*")
    .eq("user_id", userId)
    .eq("service", service)
    .single();

  if (error) return null;
  return data;
}
