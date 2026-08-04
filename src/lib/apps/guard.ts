import { redirect } from "next/navigation";
import { getEnabledAppsForActiveOrg } from "./server";
import { getLandingHref } from "./registry";

/**
 * Server-side guard for an app's route group: a user who was never granted the
 * app must not land on its screens.
 *
 * Why this exists: the locale root (`[locale]/page.tsx`) already picks a landing
 * screen from the user's entitlements, but ANY other way in bypassed it — a
 * bookmark, a shared link, or (the case that bit us) the installed PWA, whose
 * service worker replays a cached `/tasks` shell on launch. The screen then
 * mounted for a user without smrtTask and fired its API calls, which the backend
 * correctly refused: the user saw a working-looking task desk plastered with
 * `App "smrttask" is not enabled for your user`.
 *
 * Redirects to whatever the user CAN open instead of showing a broken screen.
 *
 * Not a security boundary — the backend's `requireApp` is. This only keeps the
 * UI honest, so entitlement is expressed as "you don't have this app" rather
 * than a screen that half-renders and then errors.
 */
export async function requireAppAccess(slug: string, locale: string): Promise<void> {
  const enabledApps = await getEnabledAppsForActiveOrg();

  // Empty means we could not resolve entitlements at all (logged out, no org
  // yet, or a transient read failure). Redirecting on that would fight the
  // (app) layout's own auth/onboarding redirects and could loop, so defer to it.
  if (enabledApps.length === 0) return;

  if (!enabledApps.includes(slug)) {
    redirect(`/${locale}${getLandingHref(enabledApps)}`);
  }
}
