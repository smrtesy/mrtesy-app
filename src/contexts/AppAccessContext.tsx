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
};

const FALLBACK: AppAccess = { enabledApps: [], isAdmin: false, taskAccess: "full" };

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
 * a unit test — there is no provider, and the fallback shows nothing rather
 * than over-promising screens the caller may not be able to open.
 */
export function useAppAccess(): AppAccess {
  return useContext(AppAccessContext) ?? FALLBACK;
}
