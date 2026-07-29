import { redirect } from "next/navigation";
import { getEnabledAppsForActiveOrg } from "@/lib/apps/server";
import { getLandingHref } from "@/lib/apps/registry";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // App-aware landing. smrtTask users (and anyone we can't resolve — logged-out
  // or no org membership) land on /tasks, the daily working surface, exactly as
  // before; the (app) layout then handles auth + onboarding. A member WITHOUT
  // smrtTask (e.g. a smrtVoice-only employee) has no /tasks access, so we send
  // them to their first enabled app's home instead of bouncing them off the
  // smrtTask-gated screen. (The previous "admins → /admin" carve-out was dropped
  // so an admin opening the app on their phone lands on their work, not an ops
  // dashboard; /admin stays one tap away via the sidebar.)
  const enabledApps = await getEnabledAppsForActiveOrg();
  redirect(`/${locale}${getLandingHref(enabledApps)}`);
}
