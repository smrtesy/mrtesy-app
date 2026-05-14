"use client";

/**
 * useActiveOrg — React hook for the active org switcher UI.
 *
 * Reads from the same localStorage key the api() client uses
 * (`smrtesy.active_org_id`) so all reads/writes stay in sync.
 * Listens for the custom "smrtesy:active-org-changed" event so multiple
 * components on the page update together when the user switches orgs.
 */

import { useEffect, useState, useCallback } from "react";
import { api, getActiveOrgId, setActiveOrgId, ApiError } from "./client";

export interface OrgWithRole {
  id: string;
  slug: string;
  name: string;
  name_he: string | null;
  role: "owner" | "admin" | "member";
}

const CHANGE_EVENT = "smrtesy:active-org-changed";

export function useActiveOrg() {
  const [orgs, setOrgs] = useState<OrgWithRole[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { orgs } = await api<{ orgs: OrgWithRole[] }>("/api/orgs/me", { noOrg: true });
      setOrgs(orgs ?? []);
      const current = await getActiveOrgId();
      setActiveId(current);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error("useActiveOrg:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [refresh]);

  const switchOrg = useCallback((id: string) => {
    setActiveOrgId(id);
    setActiveId(id);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const active = orgs.find((o) => o.id === activeId) ?? null;

  return { orgs, active, activeId, loading, switchOrg, refresh };
}
