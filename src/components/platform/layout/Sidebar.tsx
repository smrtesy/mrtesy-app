"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CheckSquare,
  Bell,
  FileText,
  Settings,
  FolderOpen,
  Plus,
  Shield,
  BookOpen,
  MessageCircle,
  FlaskConical,
  PanelRightClose,
  PanelRightOpen,
  Mic,
  Users,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";
import { OrgSwitcher } from "@/components/platform/layout/OrgSwitcher";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";

// Sidebar gates the whole smrtTask section via hasSmrtTask below — no per-item appSlug needed.
//
// Two sub-groups inside smrtTask:
//   "active" — Inbox sits at the top with the unread-suggestions badge
//              (it's the user's main entry point), then Tasks with an
//              open-tasks-count badge, then Projects, then Guide. When
//              smrtTask is active we don't ALSO show Inbox in the
//              management section — it's not duplicated.
//   "views"  — read-only data feeds. WhatsApp messages and the system run log
//              are pure inspection surfaces — they don't drive any action.
const smrtTaskItems = [
  { key: "inboxIncoming", href: "/inbox",       icon: Bell        },
  { key: "tasks",         href: "/tasks",       icon: CheckSquare },
  { key: "projects",      href: "/projects",    icon: FolderOpen  },
  { key: "guide",         href: "/tasks/guide", icon: BookOpen    },
] as const;

const smrtTaskViewItems = [
  { key: "whatsapp",                href: "/whatsapp",                 icon: MessageCircle },
  { key: "transcriptionExperiment", href: "/transcription-experiment", icon: FlaskConical  },
  { key: "log",                     href: "/log",                      icon: FileText      },
] as const;

// smrtVoice section — shown when the active org has smrtvoice enabled.
const smrtVoiceItems = [
  { key: "voiceProjects",   href: "/voice",            icon: Mic       },
  { key: "voiceCharacters", href: "/voice/characters", icon: Users     },
  { key: "voiceSettings",   href: "/voice/settings",   icon: Settings  },
  { key: "voiceGuide",      href: "/voice/guide",      icon: BookOpen  },
] as const;

// When smrtTask is enabled the inbox moves into the smrtTask section
// (as "נכנס") so we don't duplicate it here. Without smrtTask we still
// surface it under Management.
const managementItemsWithoutInbox = [
  { key: "settings", href: "/settings", icon: Settings },
] as const;
const managementItemsWithInbox = [
  { key: "inbox",    href: "/inbox",    icon: Bell     },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

type MobileNavItem = { key: string; href: string; icon: React.ElementType };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {children}
    </p>
  );
}

export function Sidebar({ locale, isAdmin, enabledApps = [] }: { locale: string; isAdmin?: boolean; enabledApps?: string[] }) {
  const hasSmrtTask = enabledApps.includes("smrttask");
  const hasSmrtVoice = enabledApps.includes("smrtvoice");
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [taskInputOpen, setTaskInputOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [openTasksCount, setOpenTasksCount] = useState(0);
  const supabase = createClient();

  // Mobile bottom-tab primary items — 5 slots, last one is "More" (opens sheet)
  // except when neither app is active (only inbox + settings, no overflow).
  const activeMobileItems: MobileNavItem[] =
    !hasSmrtTask && !hasSmrtVoice
      ? [
          { key: "inbox",    href: "/inbox",    icon: Bell     },
          { key: "settings", href: "/settings", icon: Settings },
        ]
      : hasSmrtTask && hasSmrtVoice
      ? [
          { key: "tasks",         href: "/tasks",    icon: CheckSquare    },
          { key: "projects",      href: "/projects", icon: FolderOpen     },
          { key: "voiceProjects", href: "/voice",    icon: Mic            },
          { key: "inbox",         href: "/inbox",    icon: Bell           },
          { key: "more",          href: "",          icon: MoreHorizontal },
        ]
      : hasSmrtTask
      ? [
          { key: "tasks",    href: "/tasks",    icon: CheckSquare    },
          { key: "projects", href: "/projects", icon: FolderOpen     },
          { key: "whatsapp", href: "/whatsapp", icon: MessageCircle  },
          { key: "inbox",    href: "/inbox",    icon: Bell           },
          { key: "more",     href: "",          icon: MoreHorizontal },
        ]
      : /* smrtVoice only */
        [
          { key: "voiceProjects",   href: "/voice",            icon: Mic            },
          { key: "voiceCharacters", href: "/voice/characters", icon: Users          },
          { key: "voiceSettings",   href: "/voice/settings",   icon: Settings       },
          { key: "inbox",           href: "/inbox",            icon: Bell           },
          { key: "more",            href: "",                  icon: MoreHorizontal },
        ];

  // Restore + sync the desktop sidebar collapse state via a body attribute that
  // globals.css uses to hide the aside, drop the main margin and unhide the
  // floating "open" handle.
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

    // Push the current session token into the Realtime client BEFORE subscribing.
    // createBrowserClient hydrates the session from cookies asynchronously, and
    // the postgres_changes subscription can race that — without an auth token,
    // RLS-checked tables ('tasks', 'notifications') silently drop events.
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
          // Diagnostic only — CHANNEL_ERROR / TIMED_OUT means the polling
          // fallback below is doing the actual work and we should investigate.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.warn("[sidebar] realtime status:", status);
          }
        });
    });

    // Token refresh: re-push the new access_token to realtime so the channel
    // doesn't go stale after a few hours. Supabase rotates tokens roughly
    // hourly; without this the realtime channel keeps the old JWT and starts
    // failing silently.
    const { data: authSub } = supabase.auth.onAuthStateChange((event: string, session: { access_token?: string } | null) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") {
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token);
        }
      }
    });

    // Local event — pages that mutate tasks (approve, dismiss, snooze,
    // complete) dispatch this after a successful action so the badge
    // refreshes instantly, without waiting for the Realtime round-trip.
    const handleBadgeRefresh = () => fetchCount();
    window.addEventListener("smrtesy:badge-refresh", handleBadgeRefresh);

    const handleOrgChange = () => fetchCount();
    window.addEventListener("smrtesy:active-org-changed", handleOrgChange);

    // Polling fallback. If realtime is healthy this is mostly idle work; if
    // it's broken (cold network, expired JWT, publication misconfig) the
    // sidebar still catches up within 30 s. Keep it generous on interval —
    // the local event handler covers the user's own actions instantly.
    pollTimer = setInterval(fetchCount, 30_000);

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
      authSub.subscription.unsubscribe();
      window.removeEventListener("smrtesy:active-org-changed", handleOrgChange);
      window.removeEventListener("smrtesy:badge-refresh", handleBadgeRefresh);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [supabase]);

  const basePath = `/${locale}`;

  function isActive(href: string) {
    const fullPath = `${basePath}${href}`;
    if (href === "/tasks") return pathname === basePath || pathname === `${basePath}/` || pathname.startsWith(`${basePath}/tasks`);
    // /voice should only be active for the projects list and individual project pages,
    // not for the named sub-sections (/voice/characters, /voice/settings, /voice/guide).
    if (href === "/voice") {
      if (pathname === `${basePath}/voice`) return true;
      const voiceNamedSections = [`${basePath}/voice/characters`, `${basePath}/voice/settings`, `${basePath}/voice/guide`];
      if (voiceNamedSections.some((p) => pathname.startsWith(p))) return false;
      return pathname.startsWith(`${basePath}/voice/`);
    }
    return pathname.startsWith(fullPath);
  }

  // Per-nav-item badge: inbox + inboxIncoming both surface the live
  // unread suggestions count (red); the tasks link gets a separate badge
  // for the open-tasks count (muted blue) so the user can see at a
  // glance how much real work is pending without opening the page.
  function badgeFor(itemKey: string): { count: number; tone: "red" | "blue" } | null {
    if ((itemKey === "inbox" || itemKey === "inboxIncoming") && pendingCount > 0) {
      return { count: pendingCount, tone: "red" };
    }
    if (itemKey === "tasks" && openTasksCount > 0) {
      return { count: openTasksCount, tone: "blue" };
    }
    return null;
  }

  // Items shown in the "More" bottom sheet — everything not in the primary tab bar.
  const moreSheetItems: MobileNavItem[] = [
    { key: "settings", href: "/settings", icon: Settings },
    ...(hasSmrtTask ? [
      { key: "guide",                   href: "/tasks/guide",              icon: BookOpen     },
      { key: "log",                     href: "/log",                      icon: FileText     },
      { key: "transcriptionExperiment", href: "/transcription-experiment", icon: FlaskConical },
    ] : []),
    ...(hasSmrtTask && hasSmrtVoice ? [
      { key: "whatsapp",        href: "/whatsapp",         icon: MessageCircle },
      { key: "voiceCharacters", href: "/voice/characters", icon: Users         },
      { key: "voiceSettings",   href: "/voice/settings",   icon: Settings      },
      { key: "voiceGuide",      href: "/voice/guide",      icon: BookOpen      },
    ] : []),
    ...(!hasSmrtTask && hasSmrtVoice ? [
      { key: "voiceGuide", href: "/voice/guide", icon: BookOpen },
    ] : []),
    ...(isAdmin ? [
      { key: "admin", href: "/admin", icon: Shield },
    ] : []),
  ];

  const isMoreActive = moreSheetItems.some((item) => item.href && isActive(item.href));

  function NavItem({
    itemKey,
    href,
    icon: Icon,
  }: {
    itemKey: string;
    href: string;
    icon: React.ElementType;
  }) {
    const badge = badgeFor(itemKey);
    return (
      <Link
        href={`${basePath}${href}`}
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
                badge.tone === "red" ? "bg-red-500" : "bg-blue-500",
              )}
            >
              {badge.count > 99 ? "99+" : badge.count}
            </span>
          )}
        </div>
        {t(itemKey as Parameters<typeof t>[0])}
      </Link>
    );
  }

  return (
    <>
      {/* Floating "open" handle — only visible (via globals.css) while the
          sidebar is collapsed on desktop. */}
      <button
        type="button"
        data-sidebar-open-handle
        onClick={toggleCollapse}
        aria-label="Open sidebar"
        className="fixed top-3 start-3 z-40 hidden md:flex items-center justify-center h-9 w-9 rounded-md border bg-background shadow-sm hover:bg-accent"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>

      {/* Desktop Sidebar */}
      <aside data-sidebar className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 border-e bg-background z-30">
        <div className="relative flex h-16 items-center justify-center border-b">
          <Link href={basePath} className="text-xl font-bold text-[#1E4D8C]">
            smrtesy
          </Link>
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Collapse sidebar"
            className="absolute end-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Collapse sidebar"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
        <div className="px-3 pt-3">
          <OrgSwitcher locale={locale} />
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {/* smrtTask section — only shown when the active org has smrtTask enabled */}
          {hasSmrtTask && (
            <>
              <SectionLabel>smrtTask</SectionLabel>
              {smrtTaskItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon} />
              ))}

              <SectionLabel>{t("sectionViews")}</SectionLabel>
              {smrtTaskViewItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon} />
              ))}
            </>
          )}

          {/* smrtVoice section — shown when the active org has smrtvoice enabled. */}
          {hasSmrtVoice && (
            <>
              <SectionLabel>{t("sectionVoice")}</SectionLabel>
              {smrtVoiceItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon} />
              ))}
            </>
          )}

          {/* Management section. Inbox only lives here when smrtTask is OFF —
              otherwise it's already at the top of the smrtTask section. */}
          <SectionLabel>{t("sectionManagement")}</SectionLabel>
          {(hasSmrtTask ? managementItemsWithoutInbox : managementItemsWithInbox).map((item) => (
            <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon} />
          ))}

          {/* Platform section — super-admins only */}
          {isAdmin && (
            <>
              <SectionLabel>{t("sectionPlatform")}</SectionLabel>
              <Link
                href={`${basePath}/admin`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  pathname.startsWith(`${basePath}/admin`)
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Shield className="h-5 w-5" />
                {t("admin")}
              </Link>
            </>
          )}
        </nav>

        {hasSmrtTask && (
          <div className="p-3 border-t">
            <Button onClick={() => setTaskInputOpen(true)} className="w-full gap-2">
              <Plus className="h-4 w-4" />
              {t("update")}
            </Button>
          </div>
        )}
      </aside>

      {/* Mobile Bottom Tab Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-50 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex items-center justify-around px-1 py-1">
          {activeMobileItems.map((item) => {
            if (item.key === "more") {
              return (
                <button
                  key="more"
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  className={cn(
                    "flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px]",
                    isMoreActive ? "text-primary" : "text-muted-foreground",
                  )}
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
                        badge.tone === "red" ? "bg-red-500" : "bg-blue-500",
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

      {/* FAB — Mobile only, smrtTask only */}
      {hasSmrtTask && (
        <Button
          size="icon"
          className="fixed bottom-20 end-4 z-50 h-14 w-14 rounded-full shadow-lg md:hidden"
          onClick={() => setTaskInputOpen(true)}
        >
          <Plus className="h-6 w-6" />
        </Button>
      )}

      {/* More sheet — all overflow items */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[70vh] rounded-t-xl pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-start">{t("more")}</SheetTitle>
          </SheetHeader>
          <nav className="mt-4 grid grid-cols-4 gap-1 pb-2">
            {moreSheetItems.map((item) => {
              const badge = badgeFor(item.key);
              return (
                <Link
                  key={item.key}
                  href={`${basePath}${item.href}`}
                  onClick={() => setMoreOpen(false)}
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
                          badge.tone === "red" ? "bg-red-500" : "bg-blue-500",
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
        </SheetContent>
      </Sheet>

      <UpdateInput
        open={taskInputOpen}
        onClose={() => setTaskInputOpen(false)}
        onApplied={() => {
          window.location.reload();
        }}
      />
    </>
  );
}
