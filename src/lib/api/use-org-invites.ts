"use client";

import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "./client";

export interface OrgInvite {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  app_slugs: string[];
  expires_at: string;
  created_at: string;
}

/**
 * useOrgInvites — fetches pending (not-yet-accepted) invites for the active org.
 * Owner/admin only; returns an empty list for regular members (403 swallowed).
 * Refreshes when the user switches org.
 */
export function useOrgInvites() {
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { invites } = await api<{ invites: OrgInvite[] }>("/api/org/invites");
      setInvites(invites ?? []);
    } catch (e) {
      // 403 (not an admin) / 401 → just show nothing.
      if (!(e instanceof ApiError)) throw e;
      setInvites([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("smrtesy:active-org-changed", handler);
    return () => window.removeEventListener("smrtesy:active-org-changed", handler);
  }, [refresh]);

  return { invites, loading, refresh };
}
