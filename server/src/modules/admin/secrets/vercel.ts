/**
 * Vercel read connector for the managed-secrets inventory (phase 2, read side).
 *
 * CONTRACT VERIFIED against the Vercel REST reference (2026-08-02):
 *   - list projects: GET /v9/projects  → { projects: [{ id, name }], pagination }
 *   - list env vars: GET /v10/projects/{idOrName}/env → { envs: [{ key, type,
 *     target, updatedAt, value }], pagination }. The plaintext `value` is returned
 *     ONLY when `decrypt=true`; we never pass it and read ONLY `key`/`target`/
 *     `updatedAt`, so no value is ever handled.
 *
 * Tokens from app_secrets (smrttask slug): VERCEL_TOKEN (required), VERCEL_TEAM_ID
 * (optional), VERCEL_PROJECT_ID (optional — when unset we enumerate the account's
 * projects and label each var with its project).
 */

import {
  providerSecret,
  fetchJson,
  SECRET_LOCATION,
  type InventoryResult,
  type InventoryVar,
} from "./provider-util";

const API = "https://api.vercel.com";

function targetLabel(target: unknown): string | null {
  if (Array.isArray(target)) return target.join(", ") || null;
  if (typeof target === "string") return target;
  return null;
}

async function listEnvForProject(
  token: string,
  projectId: string,
  projectName: string | null,
  teamQ: string,
): Promise<{ vars: InventoryVar[]; error?: string }> {
  const { ok, status, body } = await fetchJson(
    `${API}/v10/projects/${encodeURIComponent(projectId)}/env${teamQ}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message;
    return { vars: [], error: `Vercel API ${status}${msg ? `: ${msg}` : ""}` };
  }
  const envs = ((body as { envs?: Array<Record<string, unknown>> })?.envs ?? []).filter(Boolean);
  const vars: InventoryVar[] = envs.map((e) => ({
    name: String(e.key ?? ""),
    environment: targetLabel(e.target),
    group: projectName,
    updated_at: typeof e.updatedAt === "number" ? new Date(e.updatedAt).toISOString() : null,
  }));
  return { vars };
}

// ── Per-target read (for the live mirror) ───────────────────────────────────────

export interface VercelReadResult {
  configured: boolean;
  hint?: string;
  error?: string;
  /** The env-var NAMES that exist on the project (any target). Never values —
   *  Vercel returns ciphertext for encrypted vars, so we do presence only. */
  names?: string[];
}

/** Read the env-var names of ONE Vercel project — for per-target presence in the
 *  managed-secrets mirror. Vercel values are encrypted, so this is presence-only
 *  (no value fingerprint / match). */
export async function vercelProjectEnvNames(projectId: string): Promise<VercelReadResult> {
  const token = await providerSecret("VERCEL_TOKEN");
  if (!token) {
    return { configured: false, hint: `Set VERCEL_TOKEN under ${SECRET_LOCATION}.` };
  }
  const teamId = await providerSecret("VERCEL_TEAM_ID");
  const teamQ = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  try {
    const { ok, status, body } = await fetchJson(
      `${API}/v10/projects/${encodeURIComponent(projectId)}/env${teamQ}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message;
      return { configured: true, error: `Vercel API ${status}${msg ? `: ${msg}` : ""}` };
    }
    const envs = ((body as { envs?: Array<Record<string, unknown>> })?.envs ?? []).filter(Boolean);
    return { configured: true, names: envs.map((e) => String(e.key ?? "")).filter(Boolean) };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Write (propagate a value) ───────────────────────────────────────────────────

export interface VercelWriteResult {
  ok: boolean;
  configured: boolean;
  hint?: string;
  error?: string;
  /** Whether a production redeploy was triggered so the new value goes live. */
  redeployed?: boolean;
  /** Human-readable note (e.g. redeploy skipped/failed) — never a value. */
  note?: string;
}

/**
 * Create-or-update ONE env var on a Vercel project, then trigger a production
 * redeploy so the new value takes effect (a Vercel env change needs a redeploy).
 *
 * CONTRACT VERIFIED (2026-08-02):
 *   - upsert: POST /v10/projects/{id}/env?upsert=true  body { key, value, type,
 *     target[] } → with upsert=true an existing key's value is updated in place.
 *   - redeploy: GET /v6/deployments?projectId&target=production&limit=1 → latest
 *     { uid, name }; POST /v13/deployments?forceNew=1 body { name, deploymentId,
 *     target } inherits all settings and rebuilds with the new env.
 */
export async function vercelUpsertEnv(
  projectId: string | null,
  envVarName: string,
  value: string,
  environment: string,
): Promise<VercelWriteResult> {
  const token = await providerSecret("VERCEL_TOKEN");
  if (!token) {
    return { ok: false, configured: false, hint: `Set VERCEL_TOKEN under ${SECRET_LOCATION}.` };
  }
  if (!projectId) {
    return {
      ok: false,
      configured: false,
      hint: "This Vercel target needs the project id (set it as the target's service id).",
    };
  }
  const teamId = await providerSecret("VERCEL_TEAM_ID");
  const teamParam = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
  // Vercel's env targets are development/preview/production; our default is production.
  const target = [environment === "preview" ? "preview" : environment === "development" ? "development" : "production"];

  try {
    const { ok, status, body } = await fetchJson(
      `${API}/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true${teamParam}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ key: envVarName, value, type: "encrypted", target }),
      },
    );
    if (!ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message;
      return { ok: false, configured: true, error: `Vercel API ${status}${msg ? `: ${msg}` : ""}` };
    }
    // Env is set. Trigger a production redeploy so it goes live (best-effort — the
    // write itself already succeeded, so a redeploy hiccup is a note, not a failure).
    const redeploy = await vercelRedeploy(projectId, token, teamParam);
    return {
      ok: true,
      configured: true,
      redeployed: redeploy.ok,
      note: redeploy.ok ? undefined : `env set; redeploy not triggered: ${redeploy.error ?? "unknown"}`,
    };
  } catch (e) {
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Redeploy a project's latest production deployment so a changed env goes live. */
async function vercelRedeploy(
  projectId: string,
  token: string,
  teamParam: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { ok, status, body } = await fetchJson(
      `${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!ok) return { ok: false, error: `list deployments ${status}` };
    const dep = (body as { deployments?: Array<Record<string, unknown>> })?.deployments?.[0];
    const deploymentId = (dep?.uid ?? dep?.id) as string | undefined;
    const name = dep?.name as string | undefined;
    if (!deploymentId || !name) return { ok: false, error: "no production deployment to redeploy" };

    const teamQ = teamParam ? `&${teamParam.slice(1)}` : "";
    const { ok: rok, status: rstatus, body: rbody } = await fetchJson(
      `${API}/v13/deployments?forceNew=1${teamQ}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, deploymentId, target: "production" }),
      },
    );
    if (!rok) {
      const msg = (rbody as { error?: { message?: string } })?.error?.message;
      return { ok: false, error: `redeploy ${rstatus}${msg ? `: ${msg}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function vercelInventory(): Promise<InventoryResult> {
  const token = await providerSecret("VERCEL_TOKEN");
  if (!token) {
    return {
      provider: "vercel",
      configured: false,
      hint: `Set VERCEL_TOKEN under ${SECRET_LOCATION} (create it at https://vercel.com/account/tokens).`,
      vars: [],
    };
  }
  const teamId = await providerSecret("VERCEL_TEAM_ID");
  const teamQ = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";

  try {
    // A single pinned project when set; otherwise enumerate the account's projects
    // so the inventory covers every one (each var labelled with its project).
    const pinned = await providerSecret("VERCEL_PROJECT_ID");
    let projects: Array<{ id: string; name: string | null }> = [];
    if (pinned) {
      projects = [{ id: pinned, name: null }];
    } else {
      const { ok, status, body } = await fetchJson(`${API}/v9/projects${teamQ}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!ok) {
        const msg = (body as { error?: { message?: string } })?.error?.message;
        return { provider: "vercel", configured: true, error: `Vercel API ${status}${msg ? `: ${msg}` : ""}`, vars: [] };
      }
      projects = ((body as { projects?: Array<{ id: string; name?: string }> })?.projects ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? null,
      }));
    }

    const all: InventoryVar[] = [];
    let firstError: string | undefined;
    for (const p of projects) {
      const { vars, error } = await listEnvForProject(token, p.id, p.name, teamQ);
      if (error && !firstError) firstError = error;
      all.push(...vars);
    }
    // Surface an error only if we got nothing at all — a partial read (one project
    // failing among several) still returns what we could see.
    if (all.length === 0 && firstError) {
      return { provider: "vercel", configured: true, error: firstError, vars: [] };
    }
    return { provider: "vercel", configured: true, vars: all };
  } catch (e) {
    return { provider: "vercel", configured: true, error: e instanceof Error ? e.message : String(e), vars: [] };
  }
}
