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
 * Resolve the active org id.
 * Order: in-memory → localStorage → fetch /api/orgs/me and pick the first one.
 */
export async function getActiveOrgId(): Promise<string | null> {
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
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
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

  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }

  if (!res.ok) {
    const errMsg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, errMsg, json);
  }

  return json as T;
}
