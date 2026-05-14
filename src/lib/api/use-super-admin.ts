"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "./client";

/**
 * Checks once per page load whether the current user is a super-admin
 * (either via the super_admins table or the ADMIN_EMAIL env fallback).
 *
 * Use to gate UI:
 *   const { isSuperAdmin, loading } = useSuperAdmin();
 *   if (!loading && !isSuperAdmin) return null;
 *
 * Note: the SERVER is still the authoritative gate via requireSuperAdmin
 * middleware. This hook is for hiding/showing UI only.
 */

// Module-level cache so multiple components share one request per page load.
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function fetchSuperAdmin(): Promise<boolean> {
  if (cached !== null) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { is_super_admin } = await api<{ is_super_admin: boolean }>(
        "/api/me/super-admin",
        { noOrg: true },
      );
      cached = !!is_super_admin;
      return cached;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false;
      console.error("useSuperAdmin:", e);
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useSuperAdmin() {
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(cached ?? false);
  const [loading, setLoading] = useState<boolean>(cached === null);

  useEffect(() => {
    let mounted = true;
    fetchSuperAdmin().then((ok) => {
      if (mounted) {
        setIsSuperAdmin(ok);
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, []);

  return { isSuperAdmin, loading };
}
