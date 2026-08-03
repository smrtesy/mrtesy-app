"use client";

import { useResourceAccess } from "@/lib/permissions/useResourceAccess";
import { LockedResource } from "./LockedResource";

/**
 * Wrap a screen (or any subtree) that maps to a restrictable resource. Renders
 * the children when the user is allowed, or the LockedResource card when the
 * org restricts it and the user has no exception.
 *
 * The guard itself calls exactly one hook, so wrapping is safe even though the
 * wrapped screen has its own hooks — when locked, the screen isn't mounted at
 * all, so its hooks never run (no rules-of-hooks violation from an early return
 * inside the screen).
 *
 * Visibility only — the backend `requireResource` on the screen's API routes is
 * the real gate.
 */
export function ResourceGuard({
  resourceKey,
  labelKey,
  children,
}: {
  resourceKey: string;
  labelKey?: string;
  children: React.ReactNode;
}) {
  const { allowed } = useResourceAccess(resourceKey);
  if (!allowed) return <LockedResource resourceKey={resourceKey} labelKey={labelKey} />;
  return <>{children}</>;
}
