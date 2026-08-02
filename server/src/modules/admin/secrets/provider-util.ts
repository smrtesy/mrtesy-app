/**
 * Shared helpers for the managed-secrets provider connectors: read a platform-level
 * provider token from app_secrets (smrttask slug, env-var fallback), and a
 * timeout-bounded JSON fetch. Same source and shape deploy-status.ts uses.
 */

import { getAppSecret } from "../../../db";

const TOKEN_APP_SLUG = "smrttask";
export const SECRET_LOCATION = "/admin/apps/smrttask/secrets";
export const FETCH_TIMEOUT_MS = 10_000;

export async function providerSecret(key: string): Promise<string | null> {
  return (await getAppSecret(TOKEN_APP_SLUG, key, key))?.trim() || null;
}

export async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** One variable that exists on a provider — NAME + metadata only, NEVER a value. */
export interface InventoryVar {
  name: string;
  /** Which environment(s)/target the var applies to (provider-specific label). */
  environment?: string | null;
  /** For Vercel multi-project accounts: the project the var lives in. */
  group?: string | null;
  /** ISO timestamp of the var's last update, when the provider reports it. */
  updated_at?: string | null;
}

/** What each provider's read path returns for the inventory panel. */
export interface InventoryResult {
  provider: "railway" | "vercel" | "supabase";
  configured: boolean;
  /** Set when configured:false — which secret to set and where. */
  hint?: string;
  /** Set on a provider/network error. */
  error?: string;
  vars: InventoryVar[];
}
