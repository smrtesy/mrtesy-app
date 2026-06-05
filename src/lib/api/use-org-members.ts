"use client";

import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "./client";

export interface OrgMember {
  user_id: string;
  role: "owner" | "admin" | "member";
  joined_at: string;
  invited_by: string | null;
  email: string | null;
  name: string | null;
  /** App slugs explicitly granted to this user (only enforced for role='member'). */
  app_slugs: string[];
}

/**
 * useOrgMembers — fetches members of the active org.
 * Refreshes when the user switches org.
 */
export function useOrgMembers() {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { members } = await api<{ members: OrgMember[] }>("/api/org/members");
      setMembers(members ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) setError(e.message);
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

  return { members, loading, error, refresh };
}
