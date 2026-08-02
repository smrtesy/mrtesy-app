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

/** The project ref, taken from SUPABASE_URL (`https://<ref>.supabase.co`). */
function supabaseRef(): string | null {
  const url = process.env.SUPABASE_URL || "";
  return /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url)?.[1] ?? null;
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
