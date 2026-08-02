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
