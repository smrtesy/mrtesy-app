"use client";

import { createContext, useContext } from "react";

/**
 * The signed-in user's access facts, resolved ONCE server-side in
 * (app)/layout.tsx and published to the whole client tree.
 *
 * Why a context and not an API call: the layout already computes all three
 * (`resolveEnabledApps` + the super_admins lookup + the app_user_access level)
 * to build the sidebar, and there is no backend endpoint that returns the
 * PER-USER app list — `GET /org/apps` is org-level, so a plain member with
 * partial grants would see apps they can't open. The tabs workspace (TabsArea →
 * TabsWorkspace) renders INSIDE this layout, so component panes read the same
 * provider as the routed page and cannot disagree with the sidebar.
 */
export type AppAccess = {
  /** App slugs this user can actually open (per-user grants applied). */
  enabledApps: string[];
  /** Super-admin (or ADMIN_EMAIL) — the gate on /admin and /claude. */
  isAdmin: boolean;
  /** smrtTask access level; "lite" = project-only worker (task list only). */
  taskAccess: "full" | "lite";
  /**
   * Restrictable-resource keys this user is currently BLOCKED on (restricted by
   * the org and not granted an exception). Empty for owners/admins/super-admins.
   * Screens/actions check membership via `useResourceAccess(key)`. See
   * docs/permissions-management-plan.md.
   */
  restrictedResources: string[];
};

const FALLBACK: AppAccess = {
  enabledApps: [],
  isAdmin: false,
  taskAccess: "full",
  restrictedResources: [],
};

const AppAccessContext = createContext<AppAccess | null>(null);

export function AppAccessProvider({
  value,
  children,
}: {
  value: AppAccess;
  children: React.ReactNode;
}) {
  return <AppAccessContext.Provider value={value}>{children}</AppAccessContext.Provider>;
}

/**
 * Read the access facts. Outside the (app) layout — a login/onboarding screen,
 * a unit test — there is no provider and FALLBACK applies: no apps and no admin
 * rights, so an app-gated or admin-gated surface renders nothing. It is not a
 * blanket "show nothing": anything gated on neither still renders, which is
 * correct (those screens need only an authenticated session).
 */
export function useAppAccess(): AppAccess {
  return useContext(AppAccessContext) ?? FALLBACK;
}
