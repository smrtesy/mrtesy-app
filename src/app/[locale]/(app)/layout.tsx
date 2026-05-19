import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/platform/layout/Sidebar";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const devBypass =
    process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "true" &&
    process.env.NODE_ENV === "development";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && !devBypass) {
    redirect(`/${locale}/login`);
  }

  // Compute super-admin status BEFORE the onboarding gate: super-admins manage
  // the platform itself and must be able to reach /admin even if they haven't
  // gone through (or care about) the smrtesy onboarding flow.
  let isAdmin = devBypass;
  if (!isAdmin && user) {
    const { data: row } = await supabase
      .from("super_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (row) isAdmin = true;
  }
  if (!isAdmin) {
    const adminEmails = (process.env.ADMIN_EMAIL || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    isAdmin = adminEmails.includes(user?.email?.toLowerCase() || "");
  }

  // Onboarding gate — skipped for super-admins (platform operators) and in
  // dev bypass. Regular users get pushed through onboarding once.
  if (user && !devBypass && !isAdmin) {
    const { data: settings } = await supabase
      .from("user_settings")
      .select("onboarding_completed")
      .eq("user_id", user.id)
      .single();

    if (!settings?.onboarding_completed) {
      redirect(`/${locale}/onboarding`);
    }
  }

  // Check which apps the active org has enabled
  let enabledApps: string[] = [];
  if (user) {
    const cookieStore = await cookies();
    const activeOrgId = cookieStore.get("smrt_org_id")?.value;

    async function fetchEnabledApps(orgId: string): Promise<string[]> {
      const { data } = await supabase
        .from("app_memberships")
        .select("apps(slug)")
        .eq("org_id", orgId);
      return (data ?? []).map((r) => {
        const app = Array.isArray(r.apps) ? r.apps[0] : r.apps;
        return (app as { slug?: string } | null)?.slug ?? "";
      }).filter(Boolean);
    }

    if (activeOrgId) {
      enabledApps = await fetchEnabledApps(activeOrgId);
    } else {
      // No active org (e.g. super-admin on app.smrtesy.com) — check first org
      const { data: memberships } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1);
      const firstOrgId = memberships?.[0]?.org_id;
      if (firstOrgId) {
        enabledApps = await fetchEnabledApps(firstOrgId);
      }
    }
  }

  return (
    <div className="flex min-h-screen w-full overflow-x-hidden">
      {/* Desktop Sidebar */}
      <Sidebar locale={locale} isAdmin={isAdmin} enabledApps={enabledApps} />
      {/* Main content */}
      <main className="flex-1 min-w-0 pb-20 md:pb-0 md:ms-64">
        <div className="w-full max-w-4xl mx-auto p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
