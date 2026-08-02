/**
 * Railway provider connector for managed secrets — READ (live mirror) and WRITE
 * (propagate a value). Phase 1 of docs/managed-secrets-plan.md.
 *
 * CONTRACT VERIFIED, NOT GUESSED (repo iron rule for external APIs), against
 * https://docs.railway.com/integrations/api/manage-variables (2026-08-02):
 *   - READ   query  variables(projectId!, environmentId!, serviceId?) → { name: value }
 *   - WRITE  mutation variableUpsert(input: VariableUpsertInput!) : Boolean
 *            input { projectId!, environmentId!, name!, value!, serviceId?, skipDeploys? }
 *            Omitting skipDeploys lets Railway auto-redeploy the service on change —
 *            which is exactly what we want (the new value goes live without a manual
 *            redeploy).
 *
 * TOKENS + project id are read at call time from app_secrets under the smrttask slug
 * (RAILWAY_TOKEN, RAILWAY_PROJECT_ID, optional RAILWAY_SERVICE_ID /
 * RAILWAY_ENVIRONMENT_ID / RAILWAY_TOKEN_KIND) — the same source deploy-status.ts
 * uses, so nothing here holds a credential and an unconfigured token degrades to
 * { configured:false } with a hint pointing at the exact secret to set.
 *
 * The read path fetches values (Railway returns them) ONLY to compute a one-way
 * fingerprint per variable; the raw values are dropped and never stored, logged, or
 * returned. That honors the plan's "never display the value" rule while still giving
 * real value-drift detection.
 */

import { getAppSecret } from "../../../db";
import { fingerprint } from "./fingerprint";
import type { InventoryResult, InventoryVar } from "./provider-util";

const TOKEN_APP_SLUG = "smrttask";
const SECRET_LOCATION = "/admin/apps/smrttask/secrets";
const FETCH_TIMEOUT_MS = 10_000;

async function secret(key: string): Promise<string | null> {
  return (await getAppSecret(TOKEN_APP_SLUG, key, key))?.trim() || null;
}

async function fetchJson(
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

async function railwayGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown; errors?: unknown }> {
  // A project token uses a different header than an account/workspace token — same
  // choice deploy-status.ts makes. Default to the Bearer form (account/workspace).
  const kind = (await secret("RAILWAY_TOKEN_KIND"))?.toLowerCase();
  const headers: Record<string, string> =
    kind === "project"
      ? { "content-type": "application/json", "Project-Access-Token": token }
      : { "content-type": "application/json", Authorization: `Bearer ${token}` };
  const { ok, status, body } = await fetchJson("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const b = (body ?? {}) as { data?: unknown; errors?: unknown };
  return { ok, status, data: b.data, errors: b.errors };
}

function gqlError(errors: unknown, status: number): string {
  const msg =
    Array.isArray(errors) && errors[0] && typeof errors[0] === "object"
      ? (errors[0] as { message?: string }).message
      : undefined;
  return `Railway API ${status}${msg ? `: ${msg}` : ""}`;
}

/** What a target row supplies; the rest (token, projectId) is platform-level. */
export interface RailwayTargetSpec {
  /** target.target_ref — Railway service id. Null → auto-resolve (single service or
   *  RAILWAY_SERVICE_ID). */
  serviceRef: string | null;
  /** target.environment — resolved to an environment id by name (or the single env /
   *  RAILWAY_ENVIRONMENT_ID). */
  environment: string;
}

interface RailwayContext {
  token: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
}

export interface RailwayResolve {
  ok: boolean;
  configured: boolean;
  ctx?: RailwayContext;
  /** Set when configured:false — which secret to set and where. */
  hint?: string;
  /** Set on a provider/network error. */
  error?: string;
}

/**
 * Resolve token + project + service + environment for a target. serviceRef and the
 * environment name are resolved against the project when not pinned — mirroring
 * deploy-status.ts so the common single-service backend needs only RAILWAY_TOKEN +
 * RAILWAY_PROJECT_ID.
 */
export async function resolveRailwayContext(spec: RailwayTargetSpec): Promise<RailwayResolve> {
  const token = await secret("RAILWAY_TOKEN");
  if (!token) {
    return {
      ok: false,
      configured: false,
      hint: `Set RAILWAY_TOKEN under ${SECRET_LOCATION} (create it at https://railway.com/account/tokens).`,
    };
  }
  const projectId = await secret("RAILWAY_PROJECT_ID");
  if (!projectId) {
    return {
      ok: false,
      configured: false,
      hint: `Set RAILWAY_PROJECT_ID under ${SECRET_LOCATION} (in Railway press Cmd/Ctrl+K → Copy Project ID).`,
    };
  }

  let serviceId = spec.serviceRef || (await secret("RAILWAY_SERVICE_ID"));
  let environmentId: string | null = null;
  const pinnedEnvId = await secret("RAILWAY_ENVIRONMENT_ID");
  const wantEnvName = (spec.environment || "production").toLowerCase();

  if (!serviceId || !pinnedEnvId) {
    const projQuery = `query project($id: String!) {
      project(id: $id) {
        services { edges { node { id name } } }
        environments { edges { node { id name } } }
      }
    }`;
    const { ok, status, data, errors } = await railwayGraphql(token, projQuery, { id: projectId });
    if (!ok || errors) return { ok: false, configured: true, error: gqlError(errors, status) };

    const project = (data as { project?: unknown })?.project as
      | {
          services?: { edges?: Array<{ node?: { id: string; name: string } }> };
          environments?: { edges?: Array<{ node?: { id: string; name: string } }> };
        }
      | undefined;
    const services = (project?.services?.edges ?? [])
      .map((e) => e.node)
      .filter(Boolean) as { id: string; name: string }[];
    const envs = (project?.environments?.edges ?? [])
      .map((e) => e.node)
      .filter(Boolean) as { id: string; name: string }[];

    if (!serviceId) {
      if (services.length === 1) serviceId = services[0].id;
      else
        return {
          ok: false,
          configured: false,
          hint:
            `Set the target's service id (or RAILWAY_SERVICE_ID under ${SECRET_LOCATION}); the project has ` +
            `${services.length} services (${services.map((s) => `${s.name}=${s.id}`).join(", ")}).`,
        };
    }

    // Prefer an environment whose name matches the target's `environment`; else the
    // pinned id; else the single environment.
    const byName = envs.find((e) => e.name.toLowerCase() === wantEnvName);
    environmentId = pinnedEnvId || byName?.id || (envs.length === 1 ? envs[0].id : null);
    if (!environmentId)
      return {
        ok: false,
        configured: false,
        hint:
          `Could not resolve the "${spec.environment}" environment id; set RAILWAY_ENVIRONMENT_ID under ${SECRET_LOCATION} ` +
          `(environments: ${envs.map((e) => `${e.name}=${e.id}`).join(", ")}).`,
      };
  } else {
    environmentId = pinnedEnvId;
  }

  return { ok: true, configured: true, ctx: { token, projectId, serviceId, environmentId } };
}

export interface RailwayReadResult {
  configured: boolean;
  hint?: string;
  error?: string;
  /** var name → fingerprint of its value. Raw values are dropped, never returned. */
  fingerprints?: Record<string, string>;
}

/** Read all variable NAMES for a target's service/environment, returning a fingerprint
 *  per name (never a value). Used to build the live mirror. */
export async function railwayReadVariables(spec: RailwayTargetSpec): Promise<RailwayReadResult> {
  const r = await resolveRailwayContext(spec);
  if (!r.ok || !r.ctx) return { configured: r.configured, hint: r.hint, error: r.error };
  const { token, projectId, serviceId, environmentId } = r.ctx;

  const query = `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }`;
  const { ok, status, data, errors } = await railwayGraphql(token, query, {
    projectId,
    environmentId,
    serviceId,
  });
  if (!ok || errors) return { configured: true, error: gqlError(errors, status) };

  const map = ((data as { variables?: unknown })?.variables ?? {}) as Record<string, unknown>;
  const fingerprints: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    if (typeof value === "string") fingerprints[name] = fingerprint(value);
  }
  return { configured: true, fingerprints };
}

export interface RailwayWriteResult {
  ok: boolean;
  configured: boolean;
  hint?: string;
  error?: string;
}

/** Create-or-update one variable on a target's service/environment. Railway
 *  auto-redeploys the service on change (skipDeploys omitted). */
export async function railwayUpsertVariable(
  spec: RailwayTargetSpec,
  name: string,
  value: string,
): Promise<RailwayWriteResult> {
  const r = await resolveRailwayContext(spec);
  if (!r.ok || !r.ctx) return { ok: false, configured: r.configured, hint: r.hint, error: r.error };
  const { token, projectId, serviceId, environmentId } = r.ctx;

  const mutation = `mutation variableUpsert($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
  }`;
  const { ok, status, errors } = await railwayGraphql(token, mutation, {
    input: { projectId, environmentId, serviceId, name, value },
  });
  if (!ok || errors) return { ok: false, configured: true, error: gqlError(errors, status) };
  return { ok: true, configured: true };
}

/**
 * Inventory: every variable NAME on the default backend service/environment
 * (auto-resolved, production) — for the "what exists in each service" panel. Values
 * are never returned (only names, via the fingerprint read path).
 */
export async function railwayInventory(): Promise<InventoryResult> {
  // Wrap like the Vercel/Supabase connectors: a network error or the fetch timeout
  // (AbortError) must degrade to an error result, never throw — otherwise it would
  // propagate through the inventory route and take the other providers down with it.
  try {
    const read = await railwayReadVariables({ serviceRef: null, environment: "production" });
    if (!read.fingerprints) {
      return { provider: "railway", configured: read.configured, hint: read.hint, error: read.error, vars: [] };
    }
    const vars: InventoryVar[] = Object.keys(read.fingerprints)
      .sort()
      .map((name) => ({ name, environment: "production" }));
    return { provider: "railway", configured: true, vars };
  } catch (e) {
    return { provider: "railway", configured: true, error: e instanceof Error ? e.message : String(e), vars: [] };
  }
}
