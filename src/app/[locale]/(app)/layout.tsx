import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/platform/layout/Sidebar";
import {
  getEnabledAppsForUserInOrg,
  resolveEnabledApps,
  startEnabledAppsQueries,
} from "@/lib/apps/server";
import { getRestrictedResourcesForUser } from "@/lib/permissions/server";
import { WhatsAppPanelProvider } from "@/contexts/WhatsAppPanelContext";
import { WhatsAppPanel } from "@/components/smrttask/whatsapp/WhatsAppPanel";
import { TabsWorkspaceProvider } from "@/contexts/TabsWorkspaceContext";
import { AppAccessProvider } from "@/contexts/AppAccessContext";
import { QueryProvider } from "@/components/platform/providers/QueryProvider";
import { TabsArea } from "@/components/platform/layout/TabsArea";
import { EmbedFlag } from "@/components/platform/layout/EmbedFlag";
import { WorkClockBar } from "@/components/smrttask/workclock/WorkClockBar";
import { PullToRefresh } from "@/components/platform/pwa/PullToRefresh";
import { ClaudeInspector } from "@/components/claude/ClaudeInspector";
import { ClaudeDrawer } from "@/components/claude/ClaudeDrawer";
import { ClaudeDrawerProvider } from "@/contexts/ClaudeDrawerContext";
import { SystemMessagesRecorder } from "@/components/platform/layout/SystemMessagesRecorder";
import { ClientErrorCatcher } from "@/components/platform/layout/ClientErrorCatcher";
import { FeatureReportButton } from "@/components/platform/features/FeatureReportButton";

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
    ? supabase.from("user_settings").select("onboarding_completed, release_channel").eq("user_id", user.id).single()
    : Promise.resolve({ data: null });
  const orgFallbackPromise = user && !cookieOrgId
    ? Promise.resolve(
        supabase.from("org_members").select("org_id").eq("user_id", user.id).limit(1),
      )
    : null;
  const appsQueries = user && cookieOrgId
    ? startEnabledAppsQueries(supabase, user.id, cookieOrgId)
    : null;
  // Feature-channels STATE table (docs/feature-channels-plan.md §4.4). Its rows
  // depend on neither user nor org, so start it NOW — wrapped in Promise.resolve
  // to force the lazy PostgrestBuilder to execute — so it runs concurrently with
  // everything above. The per-channel view is built from it once the channel is
  // resolved below.
  const featureChannelsPromise = user && !devBypass
    ? Promise.resolve(
        supabase
          .from("feature_channels")
          .select("feature_id, stable_enabled, beta_enabled, stable_version, beta_version"),
      )
    : Promise.resolve({ data: null });

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
  let resolvedOrgId: string | undefined = cookieOrgId;
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
        resolvedOrgId = orgId;
        enabledApps = await getEnabledAppsForUserInOrg(supabase, user.id, orgId, isAdmin);
      }
    }
  }

  const hasSmrtTask = enabledApps.includes("smrttask");

  // smrtTask access level — "lite" means a project-only worker: the sidebar
  // then shows only their task list (no inbox/projects/sources/etc.). Admins
  // are always full, so we only pay for this lookup for a plain member who has
  // smrtTask. An explicit app_user_access row wins; absence means "full".
  let taskAccess: "full" | "lite" = "full";
  if (user && hasSmrtTask && !isAdmin && resolvedOrgId) {
    const { data: levelRow } = await supabase
      .from("app_user_access")
      .select("access_level, apps!inner(slug)")
      .eq("org_id", resolvedOrgId)
      .eq("user_id", user.id)
      .eq("apps.slug", "smrttask")
      .maybeSingle();
    if ((levelRow as { access_level?: string } | null)?.access_level === "lite") {
      taskAccess = "lite";
    }
  }

  // Restrictable-resource layer (open-by-default within an app). Only members
  // can be blocked — admins/super-admins bypass, so we skip the lookups for
  // them entirely. For a plain member we read their role once, then intersect
  // the org's restrictions with the user's exceptions.
  let restrictedResources: string[] = [];
  if (user && !isAdmin && resolvedOrgId) {
    const { data: roleRow } = await supabase
      .from("org_members")
      .select("role")
      .eq("org_id", resolvedOrgId)
      .eq("user_id", user.id)
      .maybeSingle();
    const role = (roleRow?.role as "owner" | "admin" | "member" | undefined) ?? null;
    restrictedResources = await getRestrictedResourcesForUser(
      supabase,
      user.id,
      resolvedOrgId,
      role,
      isAdmin,
    );
  }

  // Feature-channels (docs/feature-channels-plan.md). Resolve the maturity
  // channel — a user override (user_settings.release_channel) wins over the org
  // default (organizations.release_channel); absent both, "stable" so a new
  // customer never sees beta until explicitly assigned. Then project the
  // feature_channels STATE (read concurrently above) into the per-channel view
  // the client gates on.
  const userRelease = (settingsResult.data as { release_channel?: string } | null)?.release_channel;
  let orgRelease: string | undefined;
  if (user && resolvedOrgId) {
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("release_channel")
      .eq("id", resolvedOrgId)
      .maybeSingle();
    orgRelease = (orgRow as { release_channel?: string } | null)?.release_channel;
  }
  const channel: "stable" | "beta" =
    (userRelease ?? orgRelease ?? "stable") === "beta" ? "beta" : "stable";

  const featureChannelsResult = await featureChannelsPromise;
  const features: Record<string, { visible: boolean; version: string }> = {};
  for (const row of (featureChannelsResult.data ?? []) as Array<{
    feature_id: string;
    stable_enabled: boolean;
    beta_enabled: boolean;
    stable_version: string;
    beta_version: string;
  }>) {
    features[row.feature_id] = {
      visible: channel === "beta" ? row.beta_enabled : row.stable_enabled,
      version: channel === "beta" ? row.beta_version : row.stable_version,
    };
  }

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
      {/* Pull-to-refresh for the installed PWA (standalone), where the browser
          provides no native gesture. Inert in a normal tab, in panes, and in the
          native app. */}
      <PullToRefresh />
      <QueryProvider>
      {/* Publishes the access facts the sidebar is built from (enabled apps,
          super-admin, smrtTask level) so client screens — including the ones
          rendered as component panes below — filter on exactly the same set. */}
      <AppAccessProvider value={{ enabledApps, isAdmin, taskAccess, restrictedResources, channel, features }}>
      <TabsWorkspaceProvider>
      {/* Shared open/close state for the Claude side-drawer — wraps both the
          Sidebar (whose Claude button opens it) and the ClaudeDrawer below. */}
      <ClaudeDrawerProvider>
        {/* Desktop Sidebar. showMusicPlayer: the 24Six music player is
            temporarily gated to Chanoch only (his request, 2026-08-06) —
            matched by user id so it never renders for anyone else. Broaden or
            remove this gate when rolling the player out more widely. */}
        <Sidebar locale={locale} isAdmin={isAdmin} enabledApps={enabledApps} taskAccess={taskAccess} showMusicPlayer={user?.id === "9cb6086a-2deb-44c1-93b6-93408f4d273c"} />
        {/* WhatsApp side-panel: lets the operator keep a conversation open
            alongside the task lists. Provider wraps the content so entry points
            (SourceLink / QuickAction / log) can open it; the docked panel
            renders only for smrtTask users. WhatsApp is also reachable from the
            sidebar and the mobile bottom nav, so there is no floating toggle. */}
        <WhatsAppPanelProvider>
          {/* Main content — data-sidebar-main lets globals.css drop the inline-start
              margin when the user collapses the sidebar from Sidebar.tsx. TabsArea
              swaps the centered page for side-by-side panes when tabs are open. */}
          <main data-sidebar-main className="flex-1 min-w-0 pb-20 md:pb-0 md:ms-52">
            {/* Workclock day-tool bar — a thin strip at the top of the workspace,
                shown only while a clock session is active/offered. smrtTask only. */}
            {hasSmrtTask && <WorkClockBar />}
            <TabsArea>{children}</TabsArea>
          </main>
          {hasSmrtTask && <WhatsAppPanel />}
          {/* Inspect mode for the Claude chat ("סמן מקום באפליקציה") — renders
              nothing until armed, so it is zero chrome and zero cost while idle.
              Admin-only, matching the /claude routes' requireSuperAdmin gate: for
              anyone else the capture would land on a screen whose every call 403s. */}
          {isAdmin && <ClaudeInspector />}
          {/* Floating, collapsible Claude console — a side chat launched from a
              corner button, hosting the /claude screen in an embed iframe. Admin
              only, matching the /claude routes' super-admin gate. Renders nothing
              inside its own iframe (recursion guard in the component + the
              data-embed CSS rule), so it never nests. */}
          {isAdmin && <ClaudeDrawer locale={locale} />}
          {/* Archives every toast shown into the sidebar bell (SystemMessagesBell).
              Lives INSIDE TabsWorkspaceProvider so it can attribute each message
              to the active tab's screen (panes never change the top URL). */}
          <SystemMessagesRecorder />
          {/* Global client-error catcher: records failed API calls, uncaught JS
              errors and unhandled rejections to the bell + backend log_entries
              (→ super-admin alert + daily health report). isAdmin gates only the
              "debug in Claude" action on an uncaught-error toast — logging is for
              everyone. Renders nothing. */}
          <ClientErrorCatcher isAdmin={!!isAdmin} />
          {/* Proactive "report a problem" — a discreet floating button visible to
              EVERY user (beta and stable). Opens a preview-before-send dialog and
              writes a category='feature_report' row to the same log sink. Source 2
              of the feature log (docs/feature-channels-plan.md §8). */}
          <FeatureReportButton />
        </WhatsAppPanelProvider>
      </ClaudeDrawerProvider>
      </TabsWorkspaceProvider>
      </AppAccessProvider>
      </QueryProvider>
    </div>
  );
}
