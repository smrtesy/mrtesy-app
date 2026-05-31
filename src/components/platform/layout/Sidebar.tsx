"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CheckSquare,
  Bell,
  Settings,
  FolderOpen,
  Shield,
  MessageCircle,
  FlaskConical,
  PanelRightClose,
  PanelRightOpen,
  Mic,
  Users,
  MoreHorizontal,
  Sparkles,
  ListPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";
import { ManualTaskInput } from "@/components/smrttask/tasks/ManualTaskInput";
import { UserAvatarLink } from "@/components/platform/account/UserAvatarLink";
import { AppSectionHeader } from "@/components/platform/sidebar/AppSectionHeader";
import { APPS } from "@/lib/apps/registry";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";

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
  { key: "projects",      href: "/projects", icon: FolderOpen    },
] as const;

const smrtVoiceItems = [
  { key: "voiceProjects",   href: "/voice",            icon: Mic    },
  { key: "voiceCharacters", href: "/voice/characters", icon: Users  },
] as const;

type MobileNavItem = { key: string; href: string; icon: React.ElementType };

export function Sidebar({ locale, isAdmin, enabledApps = [] }: { locale: string; isAdmin?: boolean; enabledApps?: string[] }) {
  const hasSmrtTask = enabledApps.includes("smrttask");
  const hasSmrtVoice = enabledApps.includes("smrtvoice");
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [taskInputOpen, setTaskInputOpen] = useState(false);
  const [manualTaskOpen, setManualTaskOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [openTasksCount, setOpenTasksCount] = useState(0);
  const supabase = createClient();

  // Mobile bottom-tab primary items.
  // Spec: keep תיבה (inbox), משימות (tasks), פרויקטי קול (voice projects) /
  // WhatsApp fallback when no voice, הגדרות (settings), and "עוד" (more).
  const activeMobileItems: MobileNavItem[] =
    !hasSmrtTask && !hasSmrtVoice
      ? [
          { key: "inbox",    href: "/inbox",    icon: Bell     },
          { key: "settings", href: "/settings", icon: Settings },
        ]
      : hasSmrtTask && hasSmrtVoice
      ? [
          { key: "inbox",         href: "/inbox",    icon: Bell           },
          { key: "tasks",         href: "/tasks",    icon: CheckSquare    },
          { key: "voiceProjects", href: "/voice",    icon: Mic            },
          { key: "settings",      href: "/settings", icon: Settings       },
          { key: "more",          href: "",          icon: MoreHorizontal },
        ]
      : hasSmrtTask
      ? [
          { key: "inbox",    href: "/inbox",    icon: Bell           },
          { key: "tasks",    href: "/tasks",    icon: CheckSquare    },
          { key: "whatsapp", href: "/whatsapp", icon: MessageCircle  },
          { key: "settings", href: "/settings", icon: Settings       },
          { key: "more",     href: "",          icon: MoreHorizontal },
        ]
      : /* smrtVoice only */
        [
          { key: "inbox",           href: "/inbox",            icon: Bell           },
          { key: "voiceProjects",   href: "/voice",            icon: Mic            },
          { key: "voiceCharacters", href: "/voice/characters", icon: Users          },
          { key: "settings",        href: "/settings",         icon: Settings       },
          { key: "more",            href: "",                  icon: MoreHorizontal },
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
    if (href === "/voice") {
      if (pathname === `${basePath}/voice`) return true;
      const voiceNamedSections = [`${basePath}/voice/characters`, `${basePath}/voice/settings`, `${basePath}/voice/guide`];
      if (voiceNamedSections.some((p) => pathname.startsWith(p))) return false;
      return pathname.startsWith(`${basePath}/voice/`);
    }
    return pathname.startsWith(fullPath);
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

  // Items shown in the "More" bottom sheet, grouped by app.
  // Each group is rendered with an AppSectionHeader (name → guide, icon → settings).
  // Log moved into smrtTask settings; transcription experiment moved to
  // management; both are no longer per-app sidebar items.
  const smrtTaskMoreItems: MobileNavItem[] = hasSmrtTask ? [
    { key: "projects", href: "/projects", icon: FolderOpen    },
    { key: "whatsapp", href: "/whatsapp", icon: MessageCircle },
  ] : [];
  const smrtVoiceMoreItems: MobileNavItem[] = hasSmrtVoice ? [
    { key: "voiceCharacters", href: "/voice/characters", icon: Users },
  ] : [];
  const managementMoreItems: MobileNavItem[] = [
    ...(hasSmrtTask ? [{ key: "transcriptionExperiment", href: "/transcription-experiment", icon: FlaskConical }] : []),
    ...(isAdmin ? [{ key: "platformAdmin", href: "/admin", icon: Shield }] : []),
  ];

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
      <div className="md:hidden fixed top-2 end-2 z-40">
        <UserAvatarLink size="sm" />
      </div>

      {/* Desktop Sidebar */}
      <aside data-sidebar className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 border-e bg-background z-30">
        <div className="relative flex h-16 items-center justify-between border-b px-4">
          <Link href={basePath} className="text-xl font-bold text-[#1E4D8C]">
            smrtesy
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
            <>
              <AppSectionHeader app={APPS.smrttask} />
              {smrtTaskItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </>
          )}

          {hasSmrtVoice && (
            <>
              <AppSectionHeader app={APPS.smrtvoice} />
              {smrtVoiceItems.map((item) => (
                <NavItem key={item.key} itemKey={item.key} href={item.href} icon={item.icon}
                  basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
              ))}
            </>
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
          {hasSmrtTask && (
            <NavItem itemKey="transcriptionExperiment" href="/transcription-experiment" icon={FlaskConical}
              basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} />
          )}
          {isAdmin && (
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
              {t("platformAdmin")}
            </Link>
          )}
        </nav>

        {hasSmrtTask && (
          <div className="p-3 border-t space-y-2">
            <Button onClick={() => setManualTaskOpen(true)} variant="outline" className="w-full gap-2">
              <ListPlus className="h-4 w-4" />
              {t("newTask")}
            </Button>
            <Button onClick={() => setTaskInputOpen(true)} className="w-full gap-2">
              <Sparkles className="h-4 w-4" />
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

      {/* FABs — bumped up so they don't sit on top of "More" in the tab bar.
          Manual "new task" sits above the AI "update" FAB. */}
      {hasSmrtTask && (
        <>
          <Button
            size="icon"
            variant="secondary"
            aria-label={t("newTask")}
            className="fixed bottom-40 end-4 z-50 h-14 w-14 rounded-full shadow-lg md:hidden"
            onClick={() => setManualTaskOpen(true)}
          >
            <ListPlus className="h-6 w-6" />
          </Button>
          <Button
            size="icon"
            aria-label={t("update")}
            className="fixed bottom-24 end-4 z-50 h-14 w-14 rounded-full shadow-lg md:hidden"
            onClick={() => setTaskInputOpen(true)}
          >
            <Sparkles className="h-6 w-6" />
          </Button>
        </>
      )}

      {/* More sheet — organized by app, with AppSectionHeader on top of each group. */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[70vh] rounded-t-xl pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-start">{t("more")}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4 pb-2">
            {hasSmrtTask && smrtTaskMoreItems.length > 0 && (
              <section>
                <AppSectionHeader app={APPS.smrttask} className="!pt-0" />
                <MoreGrid items={smrtTaskMoreItems} basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} onPick={() => setMoreOpen(false)} />
              </section>
            )}
            {hasSmrtVoice && smrtVoiceMoreItems.length > 0 && (
              <section>
                <AppSectionHeader app={APPS.smrtvoice} className="!pt-0" />
                <MoreGrid items={smrtVoiceMoreItems} basePath={basePath} t={t} isActive={isActive} badgeFor={badgeFor} onPick={() => setMoreOpen(false)} />
              </section>
            )}
            {managementMoreItems.length > 0 && (
              <section>
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {t("sectionManagement")}
                </p>
                <MoreGrid
                  items={managementMoreItems}
                  basePath={basePath}
                  t={t}
                  isActive={isActive}
                  badgeFor={badgeFor}
                  onPick={() => setMoreOpen(false)}
                />
              </section>
            )}
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

function MoreGrid({
  items,
  basePath,
  t,
  isActive,
  badgeFor,
  onPick,
}: {
  items: MobileNavItem[];
  basePath: string;
  t: ReturnType<typeof useTranslations>;
  isActive: (href: string) => boolean;
  badgeFor: (key: string) => { count: number; tone: "red" | "blue" } | null;
  onPick: () => void;
}) {
  return (
    <nav className="grid grid-cols-4 gap-1">
      {items.map((item) => {
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
  );
}
