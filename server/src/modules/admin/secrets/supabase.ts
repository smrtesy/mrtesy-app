/**
 * Supabase read connector for the managed-secrets inventory (phase 3, read side) —
 * the edge-function secrets managed through the Supabase Management API.
 *
 * CONTRACT VERIFIED against the Supabase Management API reference (2026-08-02):
 *   - list secrets: GET /v1/projects/{ref}/secrets → an array of { name, value }.
 *     The `value` is the real secret, so we read ONLY `name` and drop the rest —
 *     nothing sensitive is stored, logged, or returned.
 *
 * Token from app_secrets (smrttask slug): SUPABASE_ACCESS_TOKEN (`sbp_…`). The
 * project ref is taken from SUPABASE_URL (`https://<ref>.supabase.co`).
 */

import {
  providerSecret,
  fetchJson,
  SECRET_LOCATION,
  type InventoryResult,
  type InventoryVar,
} from "./provider-util";
import { fingerprint } from "./fingerprint";

/** The project ref, taken from SUPABASE_URL (`https://<ref>.supabase.co`). */
function supabaseRef(): string | null {
  const url = process.env.SUPABASE_URL || "";
  return /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url)?.[1] ?? null;
}

// ── Per-target read (for the live mirror) ───────────────────────────────────────

export interface SupabaseReadResult {
  configured: boolean;
  hint?: string;
  error?: string;
  /** secret name → fingerprint of its value. The API returns values; we fingerprint
   *  and drop them, so presence AND value-drift work without exposing a value. */
  fingerprints?: Record<string, string>;
}

export async function supabaseSecretFingerprints(): Promise<SupabaseReadResult> {
  const token = await providerSecret("SUPABASE_ACCESS_TOKEN");
  if (!token) return { configured: false, hint: `Set SUPABASE_ACCESS_TOKEN under ${SECRET_LOCATION}.` };
  const ref = supabaseRef();
  if (!ref) return { configured: false, hint: "Could not derive the project ref from SUPABASE_URL." };
  try {
    const { ok, status, body } = await fetchJson(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      const msg = (body as { message?: string })?.message;
      return { configured: true, error: `Supabase API ${status}${msg ? `: ${msg}` : ""}` };
    }
    const list = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    const fingerprints: Record<string, string> = {};
    for (const s of list) {
      if (typeof s.name === "string" && typeof s.value === "string") {
        fingerprints[s.name] = fingerprint(s.value); // value fingerprinted then dropped
      }
    }
    return { configured: true, fingerprints };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Write (propagate a value) ───────────────────────────────────────────────────

export interface SupabaseWriteResult {
  ok: boolean;
  configured: boolean;
  hint?: string;
  error?: string;
}

/**
 * Create-or-update ONE edge-function secret. CONTRACT VERIFIED (2026-08-02):
 * POST /v1/projects/{ref}/secrets with a body array [{ name, value }] — a name that
 * already exists is overwritten (upsert by name). Edge functions pick up the new
 * value on the next invocation, so no redeploy step is needed.
 */
export async function supabaseUpsertSecret(name: string, value: string): Promise<SupabaseWriteResult> {
  const token = await providerSecret("SUPABASE_ACCESS_TOKEN");
  if (!token) return { ok: false, configured: false, hint: `Set SUPABASE_ACCESS_TOKEN under ${SECRET_LOCATION}.` };
  const ref = supabaseRef();
  if (!ref) return { ok: false, configured: false, hint: "Could not derive the project ref from SUPABASE_URL." };
  try {
    const { ok, status, body } = await fetchJson(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([{ name, value }]),
    });
    if (!ok) {
      const msg = (body as { message?: string })?.message;
      return { ok: false, configured: true, error: `Supabase API ${status}${msg ? `: ${msg}` : ""}` };
    }
    return { ok: true, configured: true };
  } catch (e) {
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function supabaseInventory(): Promise<InventoryResult> {
  const token = await providerSecret("SUPABASE_ACCESS_TOKEN");
  if (!token) {
    return {
      provider: "supabase",
      configured: false,
      hint: `Set SUPABASE_ACCESS_TOKEN under ${SECRET_LOCATION} (create it at https://supabase.com/dashboard/account/tokens).`,
      vars: [],
    };
  }
  const ref = supabaseRef();
  if (!ref) {
    return {
      provider: "supabase",
      configured: false,
      hint: "Could not derive the project ref from SUPABASE_URL.",
      vars: [],
    };
  }

  try {
    const { ok, status, body } = await fetchJson(
      `https://api.supabase.com/v1/projects/${ref}/secrets`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!ok) {
      const msg = (body as { message?: string })?.message;
      return { provider: "supabase", configured: true, error: `Supabase API ${status}${msg ? `: ${msg}` : ""}`, vars: [] };
    }
    const list = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    // Read ONLY the name — the response also carries the value, which we drop.
    const vars: InventoryVar[] = list
      .map((s) => ({ name: typeof s.name === "string" ? s.name : "" }))
      .filter((v) => v.name);
    return { provider: "supabase", configured: true, vars };
  } catch (e) {
    return { provider: "supabase", configured: true, error: e instanceof Error ? e.message : String(e), vars: [] };
  }
}
