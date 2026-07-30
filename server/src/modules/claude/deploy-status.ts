/**
 * Deploy status for the two production surfaces — Vercel (frontend) and Railway
 * (backend) — read through their official APIs.
 *
 * WHY THIS EXISTS. The autonomy gate lets the in-app Claude merge to main; after it
 * does, it needs to know whether the deploy actually shipped. `/api/deploy-info`
 * already answers "what commit is LIVE" for the frontend, but not "is a build still
 * running / did it ERROR", and it says nothing about the backend. These clients add
 * the in-flight build state for both surfaces, so a run can wait for READY / SUCCESS
 * or report a build failure instead of polling a commit that will never flip.
 *
 * CONTRACTS ARE VERIFIED, NOT GUESSED (the repo's iron rule for external APIs):
 *  - Vercel  GET /v7/deployments — fields `readyState`/`state`, `sha`, `target`,
 *    `teamId` confirmed against the REST reference (2026-07-30).
 *  - Railway POST /graphql/v2 — `deployments(input:{projectId,serviceId,
 *    environmentId}, first)` → edges[].node{ id,status,createdAt,url,staticUrl };
 *    status enum SUCCESS/FAILED/BUILDING/DEPLOYING/CRASHED/REMOVED/… confirmed
 *    against the public-API docs (2026-07-30).
 *
 * TOKENS are read at call time from app_secrets (getAppSecret, env-var fallback),
 * exactly like every other console secret, so nothing here holds a credential and an
 * unconfigured token degrades to `{ configured: false }` with a hint pointing at the
 * exact secret to set — never a thrown error.
 */

import { getAppSecret } from "../../db";

const TOKEN_APP_SLUG = "smrttask";
const SECRET_LOCATION = "/admin/apps/smrttask/secrets";
/** A network call to a deploy provider should never hang a request that is only
 *  asking "is it ready yet" — bounded so a slow provider fails fast and readably. */
const FETCH_TIMEOUT_MS = 10_000;

type ProviderState = "building" | "ready" | "error" | "unknown";

export interface DeployStatus {
  provider: "vercel" | "railway";
  configured: boolean;
  /** Normalized across providers so a caller (and the screen) reads one vocabulary. */
  state?: ProviderState;
  /** The provider's own raw status string, kept so nothing is lost in normalization. */
  rawState?: string;
  commitSha?: string | null;
  url?: string | null;
  inspectorUrl?: string | null;
  createdAt?: string | null;
  /** When not configured (or misconfigured): which secret to set and where. */
  hint?: string;
  /** A provider/network error, surfaced rather than swallowed. */
  error?: string;
}

async function secret(key: string): Promise<string | null> {
  return (await getAppSecret(TOKEN_APP_SLUG, key, key))?.trim() || null;
}

/** Fetch with a hard timeout, so a wedged provider can't hold the request open. */
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

// ── Vercel ────────────────────────────────────────────────────────────────────

/** Vercel's readyState → our three-state vocabulary. Anything not terminal/known
 *  reads as "building" (in flight) except the explicit failure states. */
function vercelState(readyState: string): ProviderState {
  switch (readyState) {
    case "READY":
      return "ready";
    case "ERROR":
    case "CANCELED":
    case "BLOCKED":
    case "DELETED":
      return "error";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "building";
    default:
      return "unknown";
  }
}

/**
 * Latest PRODUCTION deployment on Vercel. Needs only VERCEL_TOKEN — the project is
 * inferred from `target=production` when VERCEL_PROJECT_ID is unset, which is correct
 * for a single-project account and narrowable with the id when it isn't. A commit sha
 * can be passed to check the specific deployment for a push rather than the latest.
 */
export async function vercelProductionStatus(sha?: string): Promise<DeployStatus> {
  const token = await secret("VERCEL_TOKEN");
  if (!token) {
    return {
      provider: "vercel",
      configured: false,
      hint: `Set VERCEL_TOKEN under ${SECRET_LOCATION} (create it at https://vercel.com/account/tokens).`,
    };
  }
  const projectId = await secret("VERCEL_PROJECT_ID");
  const teamId = await secret("VERCEL_TEAM_ID");

  const params = new URLSearchParams({ target: "production", limit: "1" });
  if (projectId) params.set("projectId", projectId);
  if (teamId) params.set("teamId", teamId);
  if (sha) params.set("sha", sha);

  try {
    const { ok, status, body } = await fetchJson(
      `https://api.vercel.com/v7/deployments?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message;
      return { provider: "vercel", configured: true, error: `Vercel API ${status}${msg ? `: ${msg}` : ""}` };
    }
    const dep = (body as { deployments?: Array<Record<string, unknown>> })?.deployments?.[0];
    if (!dep) {
      // No matching deployment — for a sha filter this means the push hasn't been
      // picked up yet, which is information, not an error.
      return { provider: "vercel", configured: true, state: "unknown", rawState: null as unknown as string,
        error: sha ? `no production deployment found for sha ${sha} yet` : "no production deployment found" };
    }
    const readyState = String(dep.readyState ?? dep.state ?? "");
    const meta = (dep.meta ?? {}) as Record<string, unknown>;
    const commitSha =
      (typeof meta.githubCommitSha === "string" && meta.githubCommitSha) ||
      (typeof meta.gitlabCommitSha === "string" && meta.gitlabCommitSha) ||
      (typeof meta.bitbucketCommitSha === "string" && meta.bitbucketCommitSha) ||
      null;
    return {
      provider: "vercel",
      configured: true,
      state: vercelState(readyState),
      rawState: readyState,
      commitSha,
      url: typeof dep.url === "string" ? `https://${dep.url}` : null,
      inspectorUrl: typeof dep.inspectorUrl === "string" ? dep.inspectorUrl : null,
      createdAt:
        typeof dep.createdAt === "number" ? new Date(dep.createdAt).toISOString() : null,
    };
  } catch (e) {
    return { provider: "vercel", configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Railway ─────────────────────────────────────────────────────────────────────

/** Railway status → our vocabulary. */
function railwayState(status: string): ProviderState {
  switch (status) {
    case "SUCCESS":
      return "ready";
    case "FAILED":
    case "CRASHED":
      return "error";
    case "BUILDING":
    case "DEPLOYING":
    case "WAITING":
    case "QUEUED":
    case "INITIALIZING":
      return "building";
    default:
      // REMOVED / SLEEPING / SKIPPED and anything unknown: not a live-build signal.
      return "unknown";
  }
}

async function railwayGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown; errors?: unknown }> {
  // A project token uses a different header than an account/workspace token. We accept
  // either: the header is chosen by the RAILWAY_TOKEN_KIND secret ('project' → the
  // project-token header), defaulting to the Bearer form that account/workspace tokens
  // use, since that is what a generic "account token" (the recommended one) needs.
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

/**
 * Latest deployment for the backend service on Railway. Needs RAILWAY_TOKEN and
 * RAILWAY_PROJECT_ID. The service and environment ids are optional: when unset, the
 * project is queried and — if it has exactly one service and one environment (or an
 * environment literally named "production") — those are used, so the common
 * single-service backend needs only the project id. When it is ambiguous the response
 * lists the ids to set rather than guessing.
 */
export async function railwayLatestStatus(): Promise<DeployStatus> {
  const token = await secret("RAILWAY_TOKEN");
  if (!token) {
    return {
      provider: "railway",
      configured: false,
      hint: `Set RAILWAY_TOKEN under ${SECRET_LOCATION} (create it at https://railway.com/account/tokens).`,
    };
  }
  const projectId = await secret("RAILWAY_PROJECT_ID");
  if (!projectId) {
    return {
      provider: "railway",
      configured: false,
      hint: `Set RAILWAY_PROJECT_ID under ${SECRET_LOCATION} (in Railway press Cmd/Ctrl+K → Copy Project ID).`,
    };
  }
  let serviceId = await secret("RAILWAY_SERVICE_ID");
  let environmentId = await secret("RAILWAY_ENVIRONMENT_ID");

  try {
    // Resolve service/environment from the project when not pinned explicitly.
    if (!serviceId || !environmentId) {
      const projQuery = `query project($id: String!) {
        project(id: $id) {
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        }
      }`;
      const { ok, status, data, errors } = await railwayGraphql(token, projQuery, { id: projectId });
      if (!ok || errors) {
        const msg = Array.isArray(errors) && errors[0] && typeof errors[0] === "object"
          ? (errors[0] as { message?: string }).message
          : undefined;
        return { provider: "railway", configured: true, error: `Railway API ${status}${msg ? `: ${msg}` : ""}` };
      }
      const project = (data as { project?: unknown })?.project as
        | { services?: { edges?: Array<{ node?: { id: string; name: string } }> };
            environments?: { edges?: Array<{ node?: { id: string; name: string } }> } }
        | undefined;
      const services = (project?.services?.edges ?? []).map((e) => e.node).filter(Boolean) as {
        id: string; name: string;
      }[];
      const envs = (project?.environments?.edges ?? []).map((e) => e.node).filter(Boolean) as {
        id: string; name: string;
      }[];
      if (!serviceId) {
        if (services.length === 1) serviceId = services[0].id;
        else
          return {
            provider: "railway",
            configured: false,
            hint:
              `RAILWAY_SERVICE_ID is not set and the project has ${services.length} services ` +
              `(${services.map((s) => `${s.name}=${s.id}`).join(", ")}). Set RAILWAY_SERVICE_ID under ${SECRET_LOCATION}.`,
          };
      }
      if (!environmentId) {
        const prod = envs.find((e) => e.name.toLowerCase() === "production");
        if (prod) environmentId = prod.id;
        else if (envs.length === 1) environmentId = envs[0].id;
        else
          return {
            provider: "railway",
            configured: false,
            hint:
              `RAILWAY_ENVIRONMENT_ID is not set and no environment is named "production" ` +
              `(${envs.map((e) => `${e.name}=${e.id}`).join(", ")}). Set RAILWAY_ENVIRONMENT_ID under ${SECRET_LOCATION}.`,
          };
      }
    }

    const query = `query deployments($input: DeploymentListInput!, $first: Int) {
      deployments(input: $input, first: $first) {
        edges { node { id status createdAt url staticUrl } }
      }
    }`;
    const { ok, status, data, errors } = await railwayGraphql(token, query, {
      input: { projectId, serviceId, environmentId },
      first: 1,
    });
    if (!ok || errors) {
      const msg = Array.isArray(errors) && errors[0] && typeof errors[0] === "object"
        ? (errors[0] as { message?: string }).message
        : undefined;
      return { provider: "railway", configured: true, error: `Railway API ${status}${msg ? `: ${msg}` : ""}` };
    }
    const node = (
      data as { deployments?: { edges?: Array<{ node?: Record<string, unknown> }> } }
    )?.deployments?.edges?.[0]?.node;
    if (!node) {
      return { provider: "railway", configured: true, state: "unknown", error: "no deployment found" };
    }
    const rawStatus = String(node.status ?? "");
    return {
      provider: "railway",
      configured: true,
      state: railwayState(rawStatus),
      rawState: rawStatus,
      url:
        (typeof node.staticUrl === "string" && node.staticUrl) ||
        (typeof node.url === "string" && node.url) ||
        null,
      createdAt: typeof node.createdAt === "string" ? node.createdAt : null,
    };
  } catch (e) {
    return { provider: "railway", configured: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Both surfaces at once — what the screen and the run's verify step read. */
export async function deployStatus(sha?: string): Promise<{ vercel: DeployStatus; railway: DeployStatus }> {
  const [vercel, railway] = await Promise.all([vercelProductionStatus(sha), railwayLatestStatus()]);
  return { vercel, railway };
}
