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

import { db, getAppSecret } from "../../db";

const TOKEN_APP_SLUG = "smrttask";
const SECRET_LOCATION = "/admin/apps/smrttask/secrets";
/** A network call to a deploy provider should never hang a request that is only
 *  asking "is it ready yet" — bounded so a slow provider fails fast and readably. */
const FETCH_TIMEOUT_MS = 10_000;

// warn = amber "a problem is approaching" — distinct from `building`. Used by the DB
// dot when the project is up but the hourly db_health_watchdog reported pressure.
type ProviderState = "building" | "ready" | "warn" | "error" | "unknown";

export interface DeployStatus {
  provider: "vercel" | "railway" | "supabase";
  configured: boolean;
  /** Normalized across providers so a caller (and the screen) reads one vocabulary. */
  state?: ProviderState;
  /** The provider's own raw status string, kept so nothing is lost in normalization. */
  rawState?: string;
  commitSha?: string | null;
  url?: string | null;
  inspectorUrl?: string | null;
  createdAt?: string | null;
  /** For the DB dot: the latest db_health_watchdog warning text + when it fired. */
  warning?: string | null;
  warnedAt?: string | null;
  /** For the DB dot: a live one-liner from the metrics endpoint (e.g. "זיכרון 34% · דיסק 21%"),
   *  shown even when healthy so hovering proves the live read is working. */
  note?: string | null;
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
        edges { node { id status createdAt url staticUrl meta } }
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
    // Railway's deployment `meta` is a JSON blob from the git provider; the commit is
    // under one of these depending on provider/age. First 7 chars = the version tag.
    const meta = (node.meta ?? {}) as Record<string, unknown>;
    const commitSha =
      (typeof meta.commitHash === "string" && meta.commitHash) ||
      (typeof meta.commitSHA === "string" && meta.commitSHA) ||
      (typeof meta.commit === "string" && meta.commit) ||
      null;
    return {
      provider: "railway",
      configured: true,
      state: railwayState(rawStatus),
      rawState: rawStatus,
      commitSha,
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

// ── Supabase (database / project health) ────────────────────────────────────────

/** Supabase project lifecycle status → our vocabulary. Unlike Vercel/Railway this is
 *  NOT about a build — it's whether the database project itself is up and healthy. */
function supabaseState(status: string): ProviderState {
  switch (status) {
    case "ACTIVE_HEALTHY":
      return "ready";
    case "COMING_UP":
    case "RESTARTING":
    case "UPGRADING":
    case "RESTORING":
    case "PAUSING":
    case "INIT_READ_REPLICA":
      return "building"; // transitional — amber
    case "ACTIVE_UNHEALTHY":
    case "INACTIVE":
    case "PAUSED":
    case "GOING_DOWN":
    case "INIT_FAILED":
    case "REMOVED":
      return "error";
    default:
      return "unknown";
  }
}

/** The project ref, taken from SUPABASE_URL (`https://<ref>.supabase.co`). */
function supabaseRef(): string | null {
  const url = process.env.SUPABASE_URL || "";
  return /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url)?.[1] ?? null;
}

/**
 * Database health for our own Supabase project — the third dot (DB).
 *
 * Two levels, best-to-cheapest:
 *  1. If a Management API token (SUPABASE_ACCESS_TOKEN, `sbp_…`) is configured, ask the
 *     Management API for the project's real lifecycle status — this catches PAUSED /
 *     UPGRADING / UNHEALTHY even when the DB briefly can't be queried.
 *  2. Otherwise fall back to a live reachability ping through the service-role client:
 *     one trivial indexed read. Success → healthy; an error (project paused, network,
 *     auth) → error. Needs no extra secret, so the DB dot is always meaningful.
 */
/** Window we look back for a db_health warning. The watchdog re-writes hourly while a
 *  problem persists, so a window comfortably longer than the 60-min cron means a live
 *  problem always shows amber, and a resolved one clears within ~this long. */
const DB_WARN_WINDOW_MS = 90 * 60 * 1000;

// ── live resource metrics (Supabase Prometheus endpoint) ─────────────────────────
//
// GET https://<ref>.supabase.co/customer/v1/privileged/metrics — Basic auth, username
// "service_role", password = the service key the backend already holds. Returns
// Prometheus text (node-exporter among ~200 series). We read memory% and disk% from
// the STANDARD node-exporter names (stable across every deployment), so no metric name
// is guessed. Everything degrades to null on any failure — a wrong key / unreachable
// endpoint / absent metric simply means "no live overlay", never a broken dot.

/** Amber when memory or disk crosses this — "a problem is approaching". */
const MEM_WARN_PCT = 90;
const DISK_WARN_PCT = 90;
/** Cache the (relatively expensive) metrics scrape so many admin polls don't each hit
 *  Supabase — one fetch per minute is plenty for a 30s-poll dot. */
const METRICS_TTL_MS = 60_000;
let metricsCache: { at: number; parsed: { memPct: number | null; diskPct: number | null } } | null = null;

/** Last numeric value of a single (optionally-labelled) Prometheus gauge line. */
function promGauge(text: string, name: string): number | null {
  const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9eE+.\\-]+)`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

/** All samples of a labelled Prometheus series as {labels, value}. */
function promSeries(text: string, name: string): Array<{ labels: Record<string, string>; value: number }> {
  const out: Array<{ labels: Record<string, string>; value: number }> = [];
  const re = new RegExp(`^${name}\\{([^}]*)\\}\\s+([0-9eE+.\\-]+)`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const labels: Record<string, string> = {};
    for (const pair of m[1].matchAll(/(\w+)="([^"]*)"/g)) labels[pair[1]] = pair[2];
    out.push({ labels, value: Number(m[2]) });
  }
  return out;
}

function parseMetrics(text: string): { memPct: number | null; diskPct: number | null } {
  // Memory: used = 1 - available/total.
  const memTotal = promGauge(text, "node_memory_MemTotal_bytes");
  const memAvail = promGauge(text, "node_memory_MemAvailable_bytes");
  const memPct =
    memTotal && memTotal > 0 && memAvail != null ? round1(100 * (1 - memAvail / memTotal)) : null;

  // Disk: the busiest REAL filesystem (skip tmpfs/overlay/etc), used = 1 - avail/size.
  const avail = promSeries(text, "node_filesystem_avail_bytes");
  const size = promSeries(text, "node_filesystem_size_bytes");
  const sizeByMount = new Map<string, number>();
  for (const s of size) if (isRealFs(s.labels)) sizeByMount.set(s.labels.mountpoint, s.value);
  let diskPct: number | null = null;
  for (const a of avail) {
    if (!isRealFs(a.labels)) continue;
    const sz = sizeByMount.get(a.labels.mountpoint);
    if (!sz || sz <= 0) continue;
    const used = round1(100 * (1 - a.value / sz));
    if (diskPct == null || used > diskPct) diskPct = used;
  }
  return { memPct, diskPct };
}

function isRealFs(labels: Record<string, string>): boolean {
  const fs = labels.fstype ?? "";
  return !["tmpfs", "overlay", "squashfs", "ramfs", "devtmpfs", "iso9660"].includes(fs);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

async function liveMetrics(): Promise<{ memPct: number | null; diskPct: number | null } | null> {
  if (metricsCache && Date.now() - metricsCache.at < METRICS_TTL_MS) return metricsCache.parsed;
  const ref = supabaseRef();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!ref || !key) return null;
  try {
    const auth = Buffer.from(`service_role:${key}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let text = "";
    try {
      const res = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseMetrics(text);
    metricsCache = { at: Date.now(), parsed };
    return parsed;
  } catch {
    return null; // unreachable / auth / parse — no overlay, never a broken dot.
  }
}

/**
 * The latest early-warning from the hourly `db_health_watchdog()` (migration
 * 20260730203000): a `log_entries` row with `category='db_health'` inside the window.
 * The watchdog writes ONLY on pressure (connections/stuck-query/cache-hit/dead-tuples),
 * so its presence IS the "a problem is approaching" signal. Absence → nothing to warn.
 */
async function recentDbHealthWarning(): Promise<{ message: string; at: string } | null> {
  try {
    const since = new Date(Date.now() - DB_WARN_WINDOW_MS).toISOString();
    const { data, error } = await db
      .from("log_entries")
      .select("error_message, created_at")
      .eq("category", "db_health")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const row = data[0] as { error_message: string | null; created_at: string };
    return { message: row.error_message ?? "אזהרת בריאות DB", at: row.created_at };
  } catch {
    return null;
  }
}

export async function supabaseStatus(): Promise<DeployStatus> {
  const ref = supabaseRef();
  const token = await secret("SUPABASE_ACCESS_TOKEN");

  // ── base state: is the project up? ──
  let base: DeployStatus | null = null;

  // Level 1 — Management API (real project lifecycle state).
  if (token && ref) {
    try {
      const { ok, body } = await fetchJson(`https://api.supabase.com/v1/projects/${ref}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ok) {
        const raw = String((body as { status?: unknown })?.status ?? "");
        base = { provider: "supabase", configured: true, state: supabaseState(raw), rawState: raw };
      }
      // A 401/403 means the token is wrong — fall through to the ping rather than
      // reporting the project down when it's really an auth problem with the token.
    } catch {
      // network/timeout — fall through to the ping.
    }
  }

  // Level 2 — reachability ping (always available, no token).
  if (!base) {
    try {
      const { error } = await db.from("apps").select("id").limit(1);
      base = error
        ? { provider: "supabase", configured: true, state: "error", rawState: "unreachable", error: error.message }
        : { provider: "supabase", configured: true, state: "ready", rawState: "reachable" };
    } catch (e) {
      base = { provider: "supabase", configured: true, state: "error", rawState: "unreachable", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── early-warning overlay ──
  // A hard down/unhealthy state already dominates — leave it red. Only when the project
  // is otherwise up do we surface the watchdog's "approaching problem" as amber, so the
  // dot escalates green → amber (pressure) → red (down).
  if (base.state === "ready") {
    const [metrics, warn] = await Promise.all([liveMetrics(), recentDbHealthWarning()]);

    // Live metric summary — shown in the tooltip even when healthy, so hovering the DB
    // dot proves the live read is working (and lets you watch memory/disk trend).
    const note =
      (metrics &&
        [
          metrics.memPct != null ? `זיכרון ${metrics.memPct}%` : null,
          metrics.diskPct != null ? `דיסק ${metrics.diskPct}%` : null,
        ]
          .filter(Boolean)
          .join(" · ")) ||
      null;

    // Amber triggers: a real-time metric over threshold (≤30s to show), OR the hourly
    // in-DB watchdog. Either one is "a problem is approaching".
    const metricIssues: string[] = [];
    if (metrics?.memPct != null && metrics.memPct >= MEM_WARN_PCT)
      metricIssues.push(`זיכרון ${metrics.memPct}%`);
    if (metrics?.diskPct != null && metrics.diskPct >= DISK_WARN_PCT)
      metricIssues.push(`דיסק ${metrics.diskPct}%`);

    if (metricIssues.length > 0 || warn) {
      const warning = [
        metricIssues.length ? `לחץ משאבים: ${metricIssues.join(", ")}` : null,
        warn?.message ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        ...base,
        state: "warn",
        rawState: "pressure",
        warning,
        warnedAt: warn?.at ?? new Date().toISOString(),
        note,
      };
    }
    return { ...base, note };
  }
  return base;
}

/** All three surfaces at once — frontend (Vercel), backend (Railway), database
 *  (Supabase). What the sidebar's system-status strip and the run's verify step read. */
export async function deployStatus(
  sha?: string,
): Promise<{ vercel: DeployStatus; railway: DeployStatus; supabase: DeployStatus }> {
  const [vercel, railway, supabase] = await Promise.all([
    vercelProductionStatus(sha),
    railwayLatestStatus(),
    supabaseStatus(),
  ]);
  return { vercel, railway, supabase };
}
