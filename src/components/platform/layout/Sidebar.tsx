"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Bot,
  CheckSquare,
  Bell,
  Settings,
  FolderOpen,
  Shield,
  MessageCircle,
  MessageSquare,
  FlaskConical,
  Clapperboard,
  Film,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Users,
  MoreHorizontal,
  BookOpen,
  Sparkles,
  Search,
  ListPlus,
  CalendarRange,
  Archive,
  Send,
  KeyRound,
  Info,
  Palette,
  Map as MapIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";
import { ManualTaskInput } from "@/components/smrttask/tasks/ManualTaskInput";
import { UserAvatarLink } from "@/components/platform/account/UserAvatarLink";
import { BrandWordmark } from "@/components/platform/branding/BrandWordmark";
import { SystemStatusStrip } from "@/components/platform/layout/SystemStatusStrip";
import { SystemMessagesBell } from "@/components/platform/layout/SystemMessagesBell";
import { AppSectionHeader } from "@/components/platform/sidebar/AppSectionHeader";
import { APPS, type AppDef } from "@/lib/apps/registry";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { useTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { useClaudeDrawer } from "@/contexts/ClaudeDrawerContext";
import { isEmbeddedPane } from "@/lib/navigate";

// Per-app items shown below each app section header. Guides moved out —
// they're reached by clicking the app NAME in AppSectionHeader. Settings
// moved out too — clicking the app ICON in AppSectionHeader opens them.
//
// Log went into smrtTask's settings panel (it's an app-internal view, not
// a top-level nav target). WhatsApp lives under smrtTask itself — the only
// app that consumes it today.
const smrtTaskItems = [
  { key: "inboxIncoming", href: "/inbox",    icon: Bell          },
  { key: "tasks",         href: "/tasks",    icon: CheckSquare   },
  { key: "whatsapp",      href: "/whatsapp", icon: MessageCircle },
  // whatsappAutoreply moved out of the main nav — it's now reached from
  // smrtTask settings ("כללים ואוטומציה"), not a top-level menu item.
  { key: "sms",           href: "/sms",      icon: MessageSquare },
  { key: "projects",      href: "/projects", icon: FolderOpen    },
  { key: "knowledge",     href: "/knowledge", icon: BookOpen     },
] as const;

const smrtCrmItems = [
  { key: "crm", href: "/crm", icon: Users },
] as const;

const smrtReachItems = [
  { key: "reach", href: "/reach", icon: Send },
] as const;

const smrtBotItems = [
  { key: "bots", href: "/bots", icon: MessageCircle },
] as const;

const smrtPlanItems = [
  { key: "planBoard",      href: "/plan",            icon: CalendarRange },
  { key: "planMy",         href: "/plan/my",         icon: CheckSquare   },
  { key: "planTeam",       href: "/plan/team",       icon: Users         },
  // No planScore entry: the scoring screen belongs to a plan and is opened from
  // the button beside the plan tabs (PlanBoardClient), not from the main nav.
  { key: "planRepository", href: "/plan/repository", icon: Archive       },
] as const;

const smrtVaultItems = [
  { key: "vault", href: "/vault", icon: KeyRound },
] as const;

const smrtInfoItems = [
  { key: "info", href: "/info", icon: Info },
] as const;

const smrtStudioItems = [
  { key: "studio",           href: "/studio",          icon: Clapperboard },
  { key: "studioProduction", href: "/studio/projects", icon: Film         },
  { key: "studioModels",     href: "/studio/models",   icon: Layers       },
  { key: "studioResearch",   href: "/studio/research", icon: FlaskConical },
] as const;

const smrtDesignItems = [
  { key: "design", href: "/design", icon: Palette },
] as const;

type MobileNavItem = { key: string; href: string; icon: React.ElementType };

// Every nav href across all apps + the management group. Used by isActive() to
// decide, for a parent route like /whatsapp or /plan, whether a more-specific
// sibling (/whatsapp/autoreply, /plan/my) actually owns the current page — so
// the parent doesn't also light up when you're on a child screen.
const ALL_NAV_HREFS: readonly string[] = [
  ...smrtTaskItems,
  ...smrtCrmItems,
  ...smrtReachItems,
  ...smrtBotItems,
  ...smrtPlanItems,
  ...smrtVaultItems,
  ...smrtInfoItems,
  ...smrtStudioItems,
]
  .map((i): string => i.href)
  .concat(["/inbox", "/settings", "/map", "/transcription-experiment", "/admin"]);

export function Sidebar({ locale, isAdmin, enabledApps = [], taskAccess = "full" }: { locale: string; isAdmin?: boolean; enabledApps?: string[]; taskAccess?: "full" | "lite" }) {
  const hasSmrtTask = enabledApps.includes("smrttask");
  // Project-only ("lite") worker: smrtTask collapses to just the task list — no
  // inbox, projects, whatsapp/sms, knowledge, task-creation FABs or experiments.
  const isLiteTask = hasSmrtTask && taskAccess === "lite";
  const visibleSmrtTaskItems = isLiteTask
    ? smrtTaskItems.filter((i) => i.key === "tasks")
    : smrtTaskItems;
  const showTaskExtras = hasSmrtTask && !isLiteTask;
  const hasSmrtCrm = enabledApps.includes("smrtcrm");
  const hasSmrtReach = enabledApps.includes("smrtreach");
  const hasSmrtBot = enabledApps.includes("smrtbot");
  const hasSmrtPlan = enabledApps.includes("smrtplan");
  const hasSmrtVault = enabledApps.includes("smrtvault");
  const hasSmrtInfo = enabledApps.includes("smrtinfo");
  const hasSmrtStudio = enabledApps.includes("smrtstudio");
  const hasSmrtDesign = enabledApps.includes("smrtdesign");
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [taskInputOpen, setTaskInputOpen] = useState(false);
  const [manualTaskOpen, setManualTaskOpen] = useState(false);
  // Compact global-search entry point: collapsed to a magnifying-glass icon
  // beside the Claude button; clicking expands a one-line input that opens the
  // results as a tab. Same collapsed-until-needed pattern as the WhatsApp search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [openTasksCount, setOpenTasksCount] = useState(0);
  const supabase = createClient();
  const { openTab } = useTabsWorkspace();
  const { toggleDrawer } = useClaudeDrawer();
  // True when this sidebar is rendered inside a tabs-workspace pane (?embed=1).
  // Set after mount (not a lazy initializer) so the first client render matches
  // the server HTML — then we drop the whole sidebar, so none of its chrome
  // (mobile avatar, FABs, bottom nav) leaks into the pane.
  const [isEmbedded, setIsEmbedded] = useState(false);
  useEffect(() => {
    if (isEmbeddedPane()) {
      setIsEmbedded(true);
    }
  }, []);

  // Mobile bottom-tab primary items.
  // Spec: keep תיבה (inbox), משימות (tasks), WhatsApp, הגדרות (settings), and
  // "עוד" (more) — a fixed set of five; every other enabled app is reached
  // from the "עוד" sheet.
  const activeMobileItems: MobileNavItem[] =
    isLiteTask
      ? [
          { key: "tasks",    href: "/tasks",    icon: CheckSquare },
          { key: "settings", href: "/settings", icon: Settings    },
        ]
      : !hasSmrtTask
      ? [
          { key: "inbox",    href: "/inbox",    icon: Bell           },
          { key: "settings", href: "/settings", icon: Settings       },
          { key: "more",     href: "",          icon: MoreHorizontal },
        ]
      : [
          // הגדרות ירדו מכאן ל"עוד"; במקומן כפתור קלוד — הדרך המהירה לפתוח
          // צ'אט חדש בלי ה-FAB שהיה מכסה תוכן. משתמש שאינו אדמין פותח במקום
          // זה את תיבת "עדכון" המהירה (מסך /claude דורש super-admin → 401).
          { key: "inbox",    href: "/inbox",    icon: Bell           },
          { key: "tasks",    href: "/tasks",    icon: CheckSquare    },
          { key: "whatsapp", href: "/whatsapp", icon: MessageCircle  },
          { key: "claude",   href: "",          icon: Bot            },
          { key: "more",     href: "",          icon: MoreHorizontal },
        ];

  useEffect(() => {
    const stored = typeof window !== "undefined"
      ? window.localStorage.getItem("smrtesy.sidebar-collapsed")
      : null;
    document.body.setAttribute("data-sidebar-collapsed", stored === "true" ? "true" : "false");
  }, []);

  function toggleCollapse() {
    const next = document.body.getAttribute("data-sidebar-collapsed") !== "true";
    document.body.setAttribute("data-sidebar-collapsed", next ? "true" : "false");
    if (typeof window !== "undefined") {
      window.localStorage.setItem("smrtesy.sidebar-collapsed", next ? "true" : "false");
    }
  }

  useEffect(() => {
    // Skip the realtime/polling work entirely inside an embedded pane.
    if (isEmbeddedPane()) {
      return;
    }
    let mounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function fetchCount() {
      try {
        const { count, open_tasks } = await api<{ count: number; open_tasks: number }>("/api/inbox/count");
        if (!mounted) return;
        setPendingCount(count);
        setOpenTasksCount(open_tasks ?? 0);
      } catch (e) {
        if (mounted && !(e instanceof ApiError && e.status === 401)) {
          console.error("badge count:", e);
        }
      }
    }

    async function setupRealtimeAuth() {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    }

    fetchCount();

    let channel: ReturnType<typeof supabase.channel> | null = null;
    setupRealtimeAuth().then(() => {
      if (!mounted) return;
      channel = supabase
        .channel("sidebar-inbox-count")
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks" },         fetchCount)
        .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, fetchCount)
        .subscribe((status: string) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.warn("[sidebar] realtime status:", status);
          }
        });
    });

    const { data: authSub } = supabase.auth.onAuthStateChange((event: string, session: { access_token?: string } | null) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") {
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token);
        }
      }
    });

    const handleBadgeRefresh = () => fetchCount();
    window.addEventListener("smrtesy:badge-refresh", handleBadgeRefresh);

    const handleOrgChange = () => fetchCount();
    window.addEventListener("smrtesy:active-org-changed", handleOrgChange);

    // Realtime above is the primary update path; this poll is only a
    // fallback, so it runs rarely and never while the tab is hidden —
    // an idle background tab otherwise polls around the clock.
    const handleVisibility = () => { if (!document.hidden) fetchCount(); };
    document.addEventListener("visibilitychange", handleVisibility);
    pollTimer = setInterval(() => { if (!document.hidden) fetchCount(); }, 180_000);

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("smrtesy:active-org-changed", handleOrgChange);
      window.removeEventListener("smrtesy:badge-refresh", handleBadgeRefresh);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [supabase]);

  const basePath = `/${locale}`;

  function isActive(href: string) {
    const fullPath = `${basePath}${href}`;
    if (href === "/tasks") return pathname === basePath || pathname === `${basePath}/` || pathname.startsWith(`${basePath}/tasks`);
    // Exact match on this screen — always the active item.
    if (pathname === fullPath) return true;
    // Descendant screen (e.g. /whatsapp when on /whatsapp/autoreply): only claim
    // it as active if no more-specific sibling nav item owns that screen. This is
    // what stops a parent item from lighting up alongside its own child.
    if (pathname.startsWith(`${fullPath}/`)) {
      const ownedByMoreSpecific = ALL_NAV_HREFS.some((other) => {
        if (other.length <= href.length || !other.startsWith(`${href}/`)) return false;
        const otherFull = `${basePath}${other}`;
        return pathname === otherFull || pathname.startsWith(`${otherFull}/`);
      });
      return !ownedByMoreSpecific;
    }
    return false;
  }

  function badgeFor(itemKey: string): { count: number; tone: "red" | "blue" } | null {
    if ((itemKey === "inbox" || itemKey === "inboxIncoming") && pendingCount > 0) {
      return { count: pendingCount, tone: "red" };
    }
    if (itemKey === "tasks" && openTasksCount > 0) {
      return { count: openTasksCount, tone: "blue" };
    }
    return null;
  }

  // "More" bottom sheet — mirrors the FULL desktop nav: every enabled app with
  // its complete item set, then a management group. Each section gets the app
  // title above and a divider line between sections (when there's more than one).
  const moreSections: Array<{ app?: AppDef; titleKey?: string; items: MobileNavItem[] }> = [];
  // Same order as the desktop nav: smrtTask → smrtPlan → smrtStudio
  // → the rest.
  if (hasSmrtTask) {
    // "משימה חדשה" (פעולה שפותחת חלון, לא ניווט) עבר לכאן מה-FAB שהוסר.
    const smrtTaskMoreItems: MobileNavItem[] = [...visibleSmrtTaskItems];
    if (showTaskExtras) smrtTaskMoreItems.push({ key: "newTask", href: "", icon: ListPlus });
    moreSections.push({ app: APPS.smrttask, items: smrtTaskMoreItems });
  }
  if (hasSmrtPlan) moreSections.push({ app: APPS.smrtplan, items: [...smrtPlanItems] });
  if (hasSmrtStudio) moreSections.push({ app: APPS.smrtstudio, items: [...smrtStudioItems] });
  if (hasSmrtDesign) moreSections.push({ app: APPS.smrtdesign, items: [...smrtDesignItems] });
  if (hasSmrtCrm) moreSections.push({ app: APPS.smrtcrm, items: [...smrtCrmItems] });
  if (hasSmrtReach) moreSections.push({ app: APPS.smrtreach, items: [...smrtReachItems] });
  if (hasSmrtBot) moreSections.push({ app: APPS.smrtbot, items: [...smrtBotItems] });
  if (hasSmrtVault) moreSections.push({ app: APPS.smrtvault, items: [...smrtVaultItems] });
  if (hasSmrtInfo) moreSections.push({ app: APPS.smrtinfo, items: [...smrtInfoItems] });
  const managementMoreItems: MobileNavItem[] = [
    ...(!hasSmrtTask ? [{ key: "inbox", href: "/inbox", icon: Bell }] : []),
    { key: "settings", href: "/settings", icon: Settings },
    { key: "siteMap", href: "/map", icon: MapIcon },
    ...(showTaskExtras ? [{ key: "transcriptionExperiment", href: "/transcription-experiment", icon: FlaskConical }] : []),
    ...(isAdmin ? [{ key: "platformAdmin", href: "/admin", icon: Shield }] : []),
  ];
  if (managementMoreItems.length > 0) moreSections.push({ titleKey: "sectionManagement", items: managementMoreItems });

  // Inside an embedded pane the page has no use for the app chrome — render
  // nothing so the avatar, FABs and bottom nav never appear in a split pane.
  if (isEmbedded) return null;

  return (
    <>
      <button
        type="button"
        data-sidebar-open-handle
        onClick={toggleCollapse}
        aria-label="Open sidebar"
        className="fixed top-3 start-3 z-40 hidden md:flex items-center justify-center h-9 w-9 rounded-md border bg-background shadow-sm hover:bg-accent"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>

      {/* Floating account avatar on mobile — sits in the top-end corner of
          the viewport and overlays the page area without consuming a
          dedicated header row. */}
      <div data-mobile-avatar className="md:hidden fixed top-2 end-2 z-40">
        <UserAvatarLink size="sm" />
      </div>

      {/* Desktop Sidebar */}
      <aside data-sidebar className="hidden md:flex md:w-52 md:flex-col md:fixed md:inset-y-0 border-e bg-background z-30">
        <div className="relative flex h-16 items-center justify-between border-b px-4">
          <Link
            href={basePath}
            onClick={(e) => {
              e.preventDefault();
              openTab(basePath, "smrtesy");
            }}
            className="text-xl font-bold text-primary"
          >
            <BrandWordmark
              taglineStyle={{
                fontSize: "0.54em",
                letterSpacing: "0.05em",
                paddingInlineEnd: "1.2em",
                marginTop: "0.12em",
              }}
            />
          </Link>
          <div className="flex items-center gap-1">
            <UserAvatarLink />
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label="Collapse sidebar"
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Collapse sidebar"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {hasSmrtTask && (
            <AppNavGroup app={APPS.smrttask}>
              {visibleSmrtTaskItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtPlan && (
            <AppNavGroup app={APPS.smrtplan}>
              {smrtPlanItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtStudio && (
            <AppNavGroup app={APPS.smrtstudio}>
              {smrtStudioItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtDesign && (
            <AppNavGroup app={APPS.smrtdesign}>
              {smrtDesignItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtCrm && (
            <AppNavGroup app={APPS.smrtcrm}>
              {smrtCrmItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtReach && (
            <AppNavGroup app={APPS.smrtreach}>
              {smrtReachItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtBot && (
            <AppNavGroup app={APPS.smrtbot}>
              {smrtBotItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtVault && (
            <AppNavGroup app={APPS.smrtvault}>
              {smrtVaultItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          {hasSmrtInfo && (
            <AppNavGroup app={APPS.smrtinfo}>
              {smrtInfoItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </AppNavGroup>
          )}

          <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("sectionManagement")}
          </p>
          {!hasSmrtTask && (
            <NavItem itemKey="inbox" href="/inbox" icon={Bell}
              basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
          )}
          <NavItem itemKey="settings" href="/settings" icon={Settings}
            basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
          {/* Site map — every screen the user can open, each click opening it as
              its own pane. Sits in "ניהול" because it is cross-app chrome, not
              an app screen. */}
          <NavItem itemKey="siteMap" href="/map" icon={MapIcon}
            basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
          {showTaskExtras && (
            <NavItem itemKey="transcriptionExperiment" href="/transcription-experiment" icon={FlaskConical}
              basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
          )}
          {isAdmin && (
            <Link
              href={`${basePath}/admin`}
              onClick={(e) => {
                e.preventDefault();
                openTab(`${basePath}/admin`, t("platformAdmin"));
              }}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                pathname.startsWith(`${basePath}/admin`)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Shield className="h-5 w-5" />
              {t("platformAdmin")}
            </Link>
          )}
        </nav>

        {showTaskExtras && (
          <div className="p-3 border-t space-y-2">
            <Button onClick={() => setManualTaskOpen(true)} variant="outline" className="w-full gap-2">
              <ListPlus className="h-4 w-4" />
              {t("newTask")}
            </Button>
            {/* This slot used to open the free-text task router ("עדכון"). It now
                opens the Claude screen, which is the primary way into work — and
                the router itself moved onto that screen, so nothing was lost.
                Gated on isAdmin because /claude's Express routes require a
                super-admin; a non-admin keeps the router here rather than getting
                a button that leads to a 401. */}
            {/* Primary action (Claude / update) + the compact search split: the
                big button keeps its role; the small magnifying glass beside it
                opens a one-line global search whose results open as a tab. */}
            <div className="flex gap-2">
              {isAdmin ? (
                // Opens the floating Claude side-drawer (ClaudeDrawerContext) —
                // the compact console over the current screen. Full screen is one
                // click away via the drawer's expand button. Reusing this button
                // is why the drawer has no launcher of its own.
                <Button
                  type="button"
                  onClick={() => toggleDrawer()}
                  className="flex-1 gap-2"
                >
                  <Bot className="h-4 w-4" />
                  {t("claude")}
                </Button>
              ) : (
                <Button onClick={() => setTaskInputOpen(true)} className="flex-1 gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t("update")}
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label={t("search")}
                title={t("search")}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
            {searchOpen && (
              <input
                autoFocus
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchQ.trim()) {
                    openTab(
                      `${basePath}/search?q=${encodeURIComponent(searchQ.trim())}`,
                      t("search"),
                    );
                    setSearchOpen(false);
                    setSearchQ("");
                  } else if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQ("");
                  }
                }}
                placeholder={t("searchPlaceholder")}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              />
            )}
            {/* General system status (frontend / backend / database) — one quiet row
                under the Claude button. Admin-only: it reads a super-admin endpoint.
                Next to it: the system-messages bell (everyone — it reads a local,
                client-side archive; only its send-to-Claude action is admin-gated). */}
            <div className="flex items-center justify-center gap-2">
              {isAdmin && <SystemStatusStrip />}
              <SystemMessagesBell isAdmin={!!isAdmin} />
            </div>
          </div>
        )}
      </aside>

      {/* Mobile Bottom Tab Bar */}
      <nav data-mobile-nav className="fixed bottom-0 inset-x-0 z-50 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex items-center justify-around px-1 py-1">
          {activeMobileItems.map((item) => {
            if (item.key === "claude") {
              // אדמין → מסך קלוד המלא (לא המגירה הצפה — חלון קטן הוא הצורה הלא
              // נכונה בנייד). אחרת → תיבת "עדכון" המהירה.
              const ClaudeIcon = isAdmin ? Bot : Sparkles;
              const claudeLabel = isAdmin ? t("claude") : t("update");
              const mobileClaudeClass =
                "flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground";
              return isAdmin ? (
                <Link key="claude" href={`${basePath}/claude`} className={mobileClaudeClass}>
                  <ClaudeIcon className="h-5 w-5 shrink-0" />
                  <span className="truncate max-w-full">{claudeLabel}</span>
                </Link>
              ) : (
                <button
                  key="claude"
                  type="button"
                  onClick={() => setTaskInputOpen(true)}
                  className={mobileClaudeClass}
                >
                  <ClaudeIcon className="h-5 w-5 shrink-0" />
                  <span className="truncate max-w-full">{claudeLabel}</span>
                </button>
              );
            }
            if (item.key === "more") {
              return (
                <button
                  key="more"
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground"
                >
                  <MoreHorizontal className="h-5 w-5 shrink-0" />
                  <span className="truncate max-w-full">{t("more")}</span>
                </button>
              );
            }
            const badge = badgeFor(item.key);
            return (
              <Link
                key={item.key}
                href={`${basePath}${item.href}`}
                className={cn(
                  "flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px]",
                  isActive(item.href) ? "text-primary" : "text-muted-foreground",
                )}
              >
                <div className="relative">
                  <item.icon className="h-5 w-5 shrink-0" />
                  {badge && (
                    <span
                      className={cn(
                        "absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white leading-none",
                        badge.tone === "red" ? "bg-status-late" : "bg-primary",
                      )}
                    >
                      {badge.count > 99 ? "99+" : badge.count}
                    </span>
                  )}
                </div>
                <span className="truncate max-w-full">{t(item.key as Parameters<typeof t>[0])}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* ה-FABs (קלוד + משימה חדשה) הוסרו מהצד — הם כיסו תוכן. קלוד עבר
          לסרגל הניווט התחתון; "משימה חדשה" עבר לגיליון "עוד" תחת smrtTask. */}

      {/* More sheet — organized by app, with AppSectionHeader on top of each group. */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="flex max-h-[85vh] flex-col rounded-t-xl pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className="shrink-0">
            <SheetTitle className="text-start">{t("more")}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto pb-2">
            {moreSections.map((section, i) => (
              <section
                key={section.app?.slug ?? section.titleKey}
                className={cn(i > 0 && "border-t pt-1")}
              >
                {section.app ? (
                  <AppSectionHeader app={section.app} className="!pt-2" />
                ) : (
                  <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {t(section.titleKey as Parameters<typeof t>[0])}
                  </p>
                )}
                <MoreGrid items={section.items} basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} onPick={() => setMoreOpen(false)} onNewTask={() => setManualTaskOpen(true)} />
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <UpdateInput
        open={taskInputOpen}
        onClose={() => setTaskInputOpen(false)}
        onApplied={() => {
          window.location.reload();
        }}
      />

      <ManualTaskInput
        open={manualTaskOpen}
        onClose={() => setManualTaskOpen(false)}
        onCreated={() => {
          window.location.reload();
        }}
      />
    </>
  );
}

/** Wraps one app's section (header + its nav items) with a continuous thin
 *  accent rail down the inline-start edge, tinted with the app's color. The
 *  rail runs the full height of the group so every item reads as part of the
 *  category; the inter-section gap is a `mt-4` margin OUTSIDE the rail so
 *  adjacent categories stay visually separate. `first:mt-0` drops the gap on
 *  whichever group renders first. */
function AppNavGroup({ app, children }: { app: AppDef; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-s-2 ps-1 first:mt-0" style={{ borderColor: app.color }}>
      <AppSectionHeader app={app} className="!pt-1" />
      {children}
    </div>
  );
}

function NavItem({
  itemKey,
  href,
  icon: Icon,
  basePath,
  t,
  isActive,
  badgeFor,
}: {
  itemKey: string;
  href: string;
  icon: React.ElementType;
  basePath: string;
  t: ReturnType<typeof useTranslations>;
  isActive: (href: string) => boolean;
  badgeFor: (key: string) => { count: number; tone: "red" | "blue" } | null;
}) {
  const badge = badgeFor(itemKey);
  const { openTab } = useTabsWorkspace();
  const label = t(itemKey as Parameters<typeof t>[0]);
  return (
    <Link
      href={`${basePath}${href}`}
      onClick={(e) => {
        e.preventDefault();
        openTab(`${basePath}${href}`, label);
      }}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        isActive(href)
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <div className="relative">
        <Icon className="h-5 w-5" />
        {badge && (
          <span
            className={cn(
              "absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white leading-none",
              badge.tone === "red" ? "bg-status-late" : "bg-primary",
            )}
          >
            {badge.count > 99 ? "99+" : badge.count}
          </span>
        )}
      </div>
      {label}
    </Link>
  );
}

function MoreGrid({
  items,
  basePath,
  t,
  isActive,
  badgeFor,
  onPick,
  onNewTask,
}: {
  items: MobileNavItem[];
  basePath: string;
  t: ReturnType<typeof useTranslations>;
  isActive: (href: string) => boolean;
  badgeFor: (key: string) => { count: number; tone: "red" | "blue" } | null;
  onPick: () => void;
  onNewTask?: () => void;
}) {
  return (
    <nav className="grid grid-cols-4 gap-1">
      {items.map((item) => {
        if (item.key === "newTask") {
          // פעולה שפותחת חלון יצירת משימה — כפתור, לא קישור.
          return (
            <button
              key="newTask"
              type="button"
              onClick={() => { onNewTask?.(); onPick(); }}
              className="flex flex-col items-center gap-1.5 rounded-xl p-3 text-center text-[11px] text-muted-foreground hover:bg-accent"
            >
              <div className="relative">
                <item.icon className="h-6 w-6" />
              </div>
              <span className="leading-tight">{t("newTask")}</span>
            </button>
          );
        }
        const badge = badgeFor(item.key);
        return (
          <Link
            key={item.key}
            href={`${basePath}${item.href}`}
            onClick={onPick}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-xl p-3 text-center text-[11px]",
              isActive(item.href)
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <div className="relative">
              <item.icon className="h-6 w-6" />
              {badge && (
                <span
                  className={cn(
                    "absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white leading-none",
                    badge.tone === "red" ? "bg-status-late" : "bg-primary",
                  )}
                >
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              )}
            </div>
            <span className="leading-tight">{t(item.key as Parameters<typeof t>[0])}</span>
          </Link>
        );
      })}
    </nav>
  );
}
