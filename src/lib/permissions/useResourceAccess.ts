"use client";

import { useAppAccess } from "@/contexts/AppAccessContext";

/**
 * Client-side gate for a single restrictable resource.
 *
 *   const { allowed, restricted } = useResourceAccess("smrttask.screen.knowledge");
 *   if (!allowed) return <LockedResource resourceKey="smrttask.screen.knowledge" />;
 *
 * `restricted` is true when this resource is in the user's blocked set; `allowed`
 * is its inverse. Owners/admins/super-admins always get `allowed: true` because
 * their `restrictedResources` set is empty (resolved in (app)/layout.tsx). This
 * is a VISIBILITY gate only — the backend `requireResource` is the real
 * enforcement, so a resource whose data is loaded via the API is still 403'd
 * server-side even if this hook were bypassed.
 */
export function useResourceAccess(resourceKey: string): {
  allowed: boolean;
  restricted: boolean;
} {
  const { restrictedResources } = useAppAccess();
  const restricted = restrictedResources.includes(resourceKey);
  return { allowed: !restricted, restricted };
}
