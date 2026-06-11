"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";

interface OrgMe {
  user_id: string;
  role: string;
  is_manager: boolean;
}

// Session-level cache — the user's role in the active org changes ~never
// within a session, and several components ask at once.
let cached: OrgMe | null = null;
let inflight: Promise<OrgMe | null> | null = null;

async function fetchOrgMe(): Promise<OrgMe | null> {
  if (cached) return cached;
  if (!inflight) {
    inflight = api<OrgMe>("/api/org/me")
      .then((res) => { cached = res; return res; })
      .catch(() => { inflight = null; return null; });
  }
  return inflight;
}

/**
 * The current user's role in the active org. `isManager` is true for org
 * owners/admins — used to gate manager-only affordances (assigning tasks).
 */
export function useOrgRole(): { role: string | null; isManager: boolean; userId: string | null } {
  const [me, setMe] = useState<OrgMe | null>(cached);
  useEffect(() => {
    let alive = true;
    fetchOrgMe().then((res) => { if (alive) setMe(res); });
    return () => { alive = false; };
  }, []);
  return { role: me?.role ?? null, isManager: !!me?.is_manager, userId: me?.user_id ?? null };
}
