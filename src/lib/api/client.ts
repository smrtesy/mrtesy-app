/**
 * Express backend API client.
 *
 * Every call automatically attaches:
 *   • Authorization: Bearer <supabase-jwt>
 *   • X-Org-Id:      <active org id, from localStorage or first /api/orgs/me result>
 *
 * Usage:
 *   const { tasks } = await api<{ tasks: Task[] }>("/api/tasks?status=inbox");
 *   const { task }  = await api<{ task: Task }>("/api/tasks", {
 *     method: "POST",
 *     body: { title: "...", priority: "high" },
 *   });
 */

import { createClient } from "@/lib/supabase/client";
import { navigateTop } from "@/lib/navigate";
import { reportApiError, REPORTED_FLAG } from "@/lib/error-capture";

/** Tag an error so the window-level catcher won't re-report it if it bubbles up
 *  as an unhandled rejection (a bare `await api()`). */
function markReported(err: unknown) {
  if (err && typeof err === "object") (err as Record<string, unknown>)[REPORTED_FLAG] = true;
}

const supabase = createClient();
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

const ACTIVE_ORG_KEY = "smrtesy.active_org_id";

// ── active org resolution ───────────────────────────────────────────────────

let activeOrgId: string | null = null;
let resolving: Promise<string | null> | null = null;

export function getStoredActiveOrgId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_ORG_KEY);
}

export function setActiveOrgId(id: string) {
  activeOrgId = id;
  if (typeof window !== "undefined") localStorage.setItem(ACTIVE_ORG_KEY, id);
}

/**
 * Forget the stored active org. Used to self-heal a stale value that points at
 * an org the user isn't a member of — which otherwise makes requireOrg 403
 * EVERY call with no recovery. Clears the in-memory value, the localStorage
 * key, the in-flight resolver, AND the JS-readable subdomain cookie (middleware
 * re-sets it per hostname), so the next getActiveOrgId() falls through to
 * /api/orgs/me and picks a real membership.
 */
export function resetActiveOrg() {
  activeOrgId = null;
  resolving = null;
  if (typeof window !== "undefined") {
    localStorage.removeItem(ACTIVE_ORG_KEY);
    document.cookie = "smrt_org_id=; path=/; max-age=0";
  }
}

/**
 * Read the org ID set by middleware for the current subdomain.
 * Cookie name: smrt_org_id — written by src/middleware.ts.
 * Takes precedence over localStorage so the subdomain always wins.
 */
function getSubdomainOrgId(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)smrt_org_id=([^;]+)(?:;|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Resolve the active org id.
 * Priority: subdomain cookie → in-memory → localStorage → fetch /api/orgs/me.
 */
export async function getActiveOrgId(): Promise<string | null> {
  // Subdomain org always wins — set by middleware from the hostname
  const subdomainOrg = getSubdomainOrgId();
  if (subdomainOrg) return subdomainOrg;

  if (activeOrgId) return activeOrgId;

  const stored = getStoredActiveOrgId();
  if (stored) {
    activeOrgId = stored;
    return stored;
  }

  // Avoid duplicate concurrent fetches
  if (resolving) return resolving;

  resolving = (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const res = await fetch(`${BACKEND}/api/orgs/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;

    const json = await res.json() as { orgs?: { id: string }[] };
    const first = json.orgs?.[0]?.id;
    if (first) {
      setActiveOrgId(first);
      return first;
    }
    return null;
  })();

  const result = await resolving;
  resolving = null;
  return result;
}

// ── fetch wrapper ───────────────────────────────────────────────────────────

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Override the X-Org-Id header (rare; e.g. for /api/orgs which is org-less) */
  orgId?: string | null;
  /** Skip X-Org-Id (e.g. for /api/orgs collection endpoints) */
  noOrg?: boolean;
  /** Retry this non-GET the way GETs are retried. Only for endpoints the caller
   *  has made idempotent (e.g. a POST carrying a client_token the server dedupes
   *  on) — otherwise a retried write could act twice. Lets a POST ride out the
   *  transient Railway edge blip that drops a response for a request the server
   *  already processed, instead of surfacing a false "Failed to fetch". */
  idempotent?: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // With the service worker's shell-first navigations (public/sw.js v7), an
    // expired session can paint a cached page whose fetches would all die
    // here — dead screen. Wipe the cached shells (they belong to the expired
    // account) and route to login (top window, so a workspace pane doesn't
    // show a nested login). The pathname guard prevents loops. When OFFLINE,
    // stay put — the painted page in read-only mode beats an offline.html
    // bounce; the next online api() call will do the redirect.
    if (
      typeof window !== "undefined" &&
      navigator.onLine !== false &&
      !window.location.pathname.includes("/login")
    ) {
      navigator.serviceWorker?.controller?.postMessage("CLEAR_CACHE");
      const seg = window.location.pathname.split("/")[1];
      navigateTop(`/${seg === "en" ? "en" : "he"}/login`);
    }
    throw new ApiError(401, "Not authenticated");
  }

  // Headers are rebuilt on an org self-heal (below), so the org id is resolved
  // inside a closure rather than once up front.
  const buildHeaders = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
      ...(opts.headers as Record<string, string> | undefined),
    };
    if (!opts.noOrg) {
      const orgId = opts.orgId ?? await getActiveOrgId();
      if (!orgId) throw new ApiError(400, "No active organization");
      h["X-Org-Id"] = orgId;
    }
    return h;
  };
  let headers = await buildHeaders();

  // Transparent retry for transient backend blips. The Railway edge proxy
  // occasionally returns a connection reset / 502-504 with no CORS headers
  // when the dyno is momentarily busy or restarting — the browser surfaces
  // that as a `TypeError: Failed to fetch` (net::ERR_FAILED) or a gateway
  // status. Retrying a SAFE request a couple of times rides out the blip so
  // it never reaches the UI. Only GETs are retried (idempotent); a real HTTP
  // error response (4xx, or 5xx that isn't a gateway) is thrown immediately.
  const method = (opts.method ?? "GET").toUpperCase();
  const isIdempotent = method === "GET" || opts.idempotent === true;
  const maxAttempts = isIdempotent ? 3 : 1;
  const GATEWAY = new Set([502, 503, 504]);

  // Self-heal a stale active org. A `smrtesy.active_org_id` (or subdomain
  // cookie) that points at an org the user isn't a member of makes requireOrg
  // 403 EVERY call, with no recovery — the client trusts the stored value and
  // never refetches. On exactly that 403, forget the org, re-resolve from
  // /api/orgs/me, and retry ONCE. Only when we auto-resolved the org (an
  // explicit opts.orgId / opts.noOrg is left untouched).
  let orgHealed = false;

  orgHeal: for (let orgTry = 0; orgTry < 2; orgTry++) {
    let lastNetworkErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BACKEND}${path}`, {
          ...opts,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        // Network-level failure (DNS, connection reset, CORS-blocked response).
        lastNetworkErr = e;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 400));
          continue;
        }
        // Retries exhausted on a network-level failure. Report as status 0, but
        // not while OFFLINE — an offline device fails every call and the report
        // POST would fail too; the reconnect makes the next real call succeed.
        if (typeof navigator === "undefined" || navigator.onLine !== false) {
          reportApiError({ message: (e as Error)?.message ?? "Network error", method, url: path, status: 0 });
          markReported(e);
        }
        throw e;
      }

      if (GATEWAY.has(res.status) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 400));
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }

      if (!res.ok) {
        const errMsg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
        if (
          res.status === 403 &&
          !orgHealed &&
          !opts.noOrg &&
          !opts.orgId &&
          /not a member of this organization/i.test(errMsg)
        ) {
          orgHealed = true;
          resetActiveOrg();
          headers = await buildHeaders(); // re-resolves via /api/orgs/me
          continue orgHeal; // retry the whole request with the corrected org
        }
        // Report the failure to the global error catcher (bell + backend log_entries)
        // BEFORE throwing, so the detail is stashed before the call site's toast.error
        // fires and the recorder can attach it. Skip the benign/self-healing statuses:
        // 401 routes to login, and the org-membership 403 self-heals above.
        const apiErr = new ApiError(res.status, errMsg, json);
        // 304 Not Modified is a success semantic (the browser's cached copy is
        // still valid), never a failure — don't page a super-admin for it. The
        // server disables ETags so this shouldn't surface, but a proxy/CDN could
        // still emit one; either way it must not be logged as a client_error.
        if (res.status !== 401 && res.status !== 304 && !/not a member of this organization/i.test(errMsg)) {
          reportApiError({
            message: errMsg,
            method,
            url: path,
            status: res.status,
            responseBody: typeof json === "string" ? json : json != null ? JSON.stringify(json) : undefined,
          });
          markReported(apiErr);
        }
        throw apiErr;
      }

      return json as T;
    }

    // Exhausted retries on repeated network failures.
    throw lastNetworkErr ?? new ApiError(0, "Network error");
  }

  // Both org attempts exhausted — the heal didn't recover a valid org.
  throw new ApiError(403, "You are not a member of this organization");
}

/**
 * Like `api()`, but returns the raw streaming `Response` instead of parsing the
 * body — for endpoints that stream progress (NDJSON) rather than a single JSON
 * payload. Attaches the same Authorization / X-Org-Id headers. The caller reads
 * `res.body` itself; a non-OK status is thrown as an ApiError (with the parsed
 * error body) before any streaming begins. Not retried (used for POSTs).
 */
export async function apiStream(path: string, opts: ApiOptions = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${session.access_token}`,
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (!opts.noOrg) {
    const orgId = opts.orgId ?? await getActiveOrgId();
    if (!orgId) throw new ApiError(400, "No active organization");
    headers["X-Org-Id"] = orgId;
  }

  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const errMsg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    const streamErr = new ApiError(res.status, errMsg, json);
    // 304 is not a failure (see api() above) — never log it as a client_error.
    if (res.status !== 401 && res.status !== 304 && !/not a member of this organization/i.test(errMsg)) {
      reportApiError({
        message: errMsg,
        method: (opts.method ?? "GET").toUpperCase(),
        url: path,
        status: res.status,
        responseBody: typeof json === "string" ? json : json != null ? JSON.stringify(json) : undefined,
      });
      markReported(streamErr);
    }
    throw streamErr;
  }
  return res;
}
