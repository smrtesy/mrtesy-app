"use client";

import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "./client";

export interface OrgApp {
  slug: string;
  name: string;
  enabled: boolean;
}

/**
 * useOrgApps — the app registry with each app's enabled-for-this-org flag.
 * `enabledApps` is the convenience subset (slug+name) the org actually has on,
 * used to populate the per-user app picker in org settings.
 */
export function useOrgApps() {
  const [apps, setApps] = useState<OrgApp[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { apps } = await api<{ apps: OrgApp[] }>("/api/org/apps");
      setApps(apps ?? []);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      setApps([]);
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

  const enabledApps = apps.filter((a) => a.enabled);
  return { apps, enabledApps, loading, refresh };
}
