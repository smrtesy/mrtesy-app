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
  /**
   * The maturity channel this user resolves to (user override wins over the org
   * default; new users default to "stable"). Orthogonal to permissions — it
   * picks WHICH maturity of the product they see, not what they're allowed.
   * See docs/feature-channels-plan.md.
   */
  channel: "stable" | "beta";
  /**
   * Per-feature channel STATE for this user's channel, keyed by feature_id from
   * src/lib/feature-registry.ts: `visible` = show it, `version` = which version
   * to render. Resolved once server-side from the `feature_channels` table.
   * Screens gate via `useFeature(featureId)` / `<FeatureGate>`. See
   * docs/feature-channels-plan.md.
   */
  features: Record<string, { visible: boolean; version: string }>;
};

const FALLBACK: AppAccess = {
  enabledApps: [],
  isAdmin: false,
  taskAccess: "full",
  restrictedResources: [],
  channel: "stable",
  features: {},
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
