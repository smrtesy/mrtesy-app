import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/platform/layout/Sidebar";
import {
  getEnabledAppsForUserInOrg,
  resolveEnabledApps,
  startEnabledAppsQueries,
} from "@/lib/apps/server";
import { WhatsAppPanelProvider } from "@/contexts/WhatsAppPanelContext";
import { WhatsAppPanel } from "@/components/smrttask/whatsapp/WhatsAppPanel";
import { WhatsAppPanelFab } from "@/components/smrttask/whatsapp/WhatsAppPanelFab";
import { TabsWorkspaceProvider } from "@/contexts/TabsWorkspaceContext";
import { QueryProvider } from "@/components/platform/providers/QueryProvider";
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
  // getClaims() verifies the JWT's signature (locally, via cached JWKS, when
  // the project uses asymmetric signing keys; via the auth server otherwise)
  // — so this stays a real auth check but usually skips the network
  // round-trip the old getUser() paid on every navigation. Note the
  // middleware matcher skips dotted paths, so this layout cannot assume the
  // middleware already validated the request.
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  const user = claims?.sub
    ? { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null }
    : null;

  if (!user && !devBypass) {
    redirect(`/${locale}/login`);
  }

  // The active-org cookie is part of the incoming request — reading it costs
  // no network round-trip, so resolve it up front to unlock the apps queries.
  const cookieStore = await cookies();
  const cookieOrgId = user ? cookieStore.get("smrt_org_id")?.value : undefined;

  // After getUser() every remaining query depends only on user.id (+ the
  // cookie org id), so fire them all concurrently — one round-trip instead of
  // three/four sequential ones on every navigation:
  //   • super_admins  → isAdmin
  //   • user_settings → onboarding gate
  //   • org_members fallback (only when there is no org cookie) → orgId
  //   • the enabled-apps queries (only when the cookie names the org) — they
  //     don't need isAdmin to *run*; resolveEnabledApps applies the flag to
  //     the results afterwards. `Promise.resolve()` forces the lazy
  //     PostgrestBuilder to start executing now instead of at `await`.
  const superAdminPromise = user
    ? supabase.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle()
    : Promise.resolve({ data: null });
  const settingsPromise = user && !devBypass
    ? supabase.from("user_settings").select("onboarding_completed").eq("user_id", user.id).single()
    : Promise.resolve({ data: null });
  const orgFallbackPromise = user && !cookieOrgId
    ? Promise.resolve(
        supabase.from("org_members").select("org_id").eq("user_id", user.id).limit(1),
      )
    : null;
  const appsQueries = user && cookieOrgId
    ? startEnabledAppsQueries(supabase, user.id, cookieOrgId)
    : null;

  const [superAdminResult, settingsResult] = await Promise.all([
    superAdminPromise,
    settingsPromise,
  ]);

  let isAdmin = devBypass || !!superAdminResult.data;
  if (!isAdmin) {
    const adminEmails = (process.env.ADMIN_EMAIL || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    isAdmin = adminEmails.includes(user?.email?.toLowerCase() || "");
  }

  // Onboarding gate — skipped for super-admins (platform operators) and in
  // dev bypass. Regular users get pushed through onboarding once. (Any apps
  // queries already in flight are simply abandoned on redirect — supabase-js
  // resolves errors into `{ error }` rather than rejecting, so nothing leaks.)
  if (user && !devBypass && !isAdmin) {
    if (!settingsResult.data?.onboarding_completed) {
      redirect(`/${locale}/onboarding`);
    }
  }

  // Which apps to show in the sidebar. Owners/admins/super-admins see every app
  // the org has enabled; regular members see only the apps granted to them.
  let enabledApps: string[] = [];
  if (user) {
    if (appsQueries) {
      // Org known from the cookie — the queries have been running since before
      // the super-admin check; just apply the (now known) isAdmin flag.
      enabledApps = await resolveEnabledApps(appsQueries, isAdmin);
    } else if (orgFallbackPromise) {
      // No active org (e.g. super-admin on app.smrtesy.com) — fall back to the
      // first org. The membership lookup ran concurrently with the queries
      // above; the apps fetch itself genuinely can't start until the org id
      // is known, so this branch keeps one extra round-trip.
      const { data: memberships } = await orgFallbackPromise;
      const orgId = memberships?.[0]?.org_id;
      if (orgId) {
        enabledApps = await getEnabledAppsForUserInOrg(supabase, user.id, orgId, isAdmin);
      }
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
      <QueryProvider>
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
      </QueryProvider>
    </div>
  );
}
