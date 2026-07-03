import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/platform/layout/Sidebar";
import { getEnabledAppsForUserInOrg } from "@/lib/apps/server";
import { WhatsAppPanelProvider } from "@/contexts/WhatsAppPanelContext";
import { WhatsAppPanel } from "@/components/smrttask/whatsapp/WhatsAppPanel";
import { WhatsAppPanelFab } from "@/components/smrttask/whatsapp/WhatsAppPanelFab";
import { TabsWorkspaceProvider } from "@/contexts/TabsWorkspaceContext";
import { TabsArea } from "@/components/platform/layout/TabsArea";
import { EmbedFlag } from "@/components/platform/layout/EmbedFlag";

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

  // Fetch super-admin status and onboarding flag in parallel to avoid two
  // sequential round-trips on every page load. super-admins bypass onboarding.
  const [superAdminResult, settingsResult] = await Promise.all([
    user
      ? supabase.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    user && !devBypass
      ? supabase.from("user_settings").select("onboarding_completed").eq("user_id", user.id).single()
      : Promise.resolve({ data: null }),
  ]);

  let isAdmin = devBypass || !!superAdminResult.data;
  if (!isAdmin) {
    const adminEmails = (process.env.ADMIN_EMAIL || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    isAdmin = adminEmails.includes(user?.email?.toLowerCase() || "");
  }

  // Onboarding gate — skipped for super-admins (platform operators) and in
  // dev bypass. Regular users get pushed through onboarding once.
  if (user && !devBypass && !isAdmin) {
    if (!settingsResult.data?.onboarding_completed) {
      redirect(`/${locale}/onboarding`);
    }
  }

  // Which apps to show in the sidebar. Owners/admins/super-admins see every app
  // the org has enabled; regular members see only the apps granted to them.
  let enabledApps: string[] = [];
  if (user) {
    const cookieStore = await cookies();
    let orgId = cookieStore.get("smrt_org_id")?.value;
    if (!orgId) {
      // No active org (e.g. super-admin on app.smrtesy.com) — fall back to first org
      const { data: memberships } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1);
      orgId = memberships?.[0]?.org_id;
    }
    if (orgId) {
      enabledApps = await getEnabledAppsForUserInOrg(supabase, user.id, orgId, isAdmin);
    }
  }

  const hasSmrtTask = enabledApps.includes("smrttask");

  return (
    <div className="flex min-h-screen w-full overflow-x-hidden">
      {/* When this page is loaded inside a tabs-workspace pane, flag it before
          paint so globals.css strips the chrome (sidebar, floating panels) and
          only the page content fills the pane. We key off "am I framed?" — a
          structural signal that survives in-pane reloads/navigations that drop
          the `?embed=1` query — and keep the query as a first-paint fallback. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "try{if(window.self!==window.top||new URLSearchParams(window.location.search).get('embed')==='1'){document.documentElement.setAttribute('data-embed','1')}}catch(e){try{if(window.self!==window.top)document.documentElement.setAttribute('data-embed','1')}catch(_){}}",
        }}
      />
      {/* Reliable fallback for the inline script above (which doesn't always
          execute in the App Router). */}
      <EmbedFlag />
      <TabsWorkspaceProvider>
        {/* Desktop Sidebar */}
        <Sidebar locale={locale} isAdmin={isAdmin} enabledApps={enabledApps} />
        {/* WhatsApp side-panel: lets the operator keep a conversation open
            alongside the task lists. Provider wraps the content so entry points
            (SourceLink / QuickAction / log) can open it; the docked panel + FAB
            render only for smrtTask users. */}
        <WhatsAppPanelProvider>
          {/* Main content — data-sidebar-main lets globals.css drop the inline-start
              margin when the user collapses the sidebar from Sidebar.tsx. TabsArea
              swaps the centered page for side-by-side panes when tabs are open. */}
          <main data-sidebar-main className="flex-1 min-w-0 pb-20 md:pb-0 md:ms-52">
            <TabsArea>{children}</TabsArea>
          </main>
          {hasSmrtTask && (
            <>
              <WhatsAppPanel />
              <WhatsAppPanelFab />
            </>
          )}
        </WhatsAppPanelProvider>
      </TabsWorkspaceProvider>
    </div>
  );
}
