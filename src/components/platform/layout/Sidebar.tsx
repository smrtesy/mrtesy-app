"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CheckSquare,
  Bell,
  FileText,
  Calendar,
  Settings,
  FolderOpen,
  Plus,
  Shield,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SmartTaskInput } from "@/components/smrttask/tasks/SmartTaskInput";
import { OrgSwitcher } from "@/components/platform/layout/OrgSwitcher";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";

const smrtTaskItems = [
  { key: "tasks",    href: "/tasks",       icon: CheckSquare },
  { key: "projects", href: "/projects",    icon: FolderOpen  },
  { key: "calendar", href: "/calendar",    icon: Calendar    },
  { key: "log",      href: "/log",         icon: FileText    },
  { key: "guide",    href: "/tasks/guide", icon: BookOpen    },
] as const;

const managementItems = [
  { key: "inbox",    href: "/inbox",    icon: Bell     },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

// Mobile shows a flat list of the most-used items
const mobileItems = [
  { key: "tasks",    href: "/tasks",    icon: CheckSquare },
  { key: "projects", href: "/projects", icon: FolderOpen  },
  { key: "inbox",    href: "/inbox",    icon: Bell        },
  { key: "calendar", href: "/calendar", icon: Calendar    },
  { key: "settings", href: "/settings", icon: Settings    },
] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {children}
    </p>
  );
}

export function Sidebar({ locale, isAdmin, enabledApps = [] }: { locale: string; isAdmin?: boolean; enabledApps?: string[] }) {
  const hasSmrtTask = enabledApps.includes("smrtesy");
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [taskInputOpen, setTaskInputOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    let mounted = true;

    async function fetchCount() {
      try {
        const { count } = await api<{ count: number }>("/api/inbox/count");
        if (mounted) setPendingCount(count);
      } catch (e) {
        if (mounted && !(e instanceof ApiError && e.status === 401)) {
          console.error("badge count:", e);
        }
      }
    }

    fetchCount();

    const channel = supabase
      .channel("sidebar-inbox-count")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" },         fetchCount)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, fetchCount)
      .subscribe();

    const handleOrgChange = () => fetchCount();
    window.addEventListener("smrtesy:active-org-changed", handleOrgChange);

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
      window.removeEventListener("smrtesy:active-org-changed", handleOrgChange);
    };
  }, [supabase]);

  const basePath = `/${locale}`;

  function isActive(href: string) {
    const fullPath = `${basePath}${href}`;
    if (href === "/tasks") return pathname === basePath || pathname === `${basePath}/` || pathname.startsWith(`${basePath}/tasks`);
    return pathname.startsWith(fullPath);
  }

  function NavItem({
    itemKey,
    href,
    icon: Icon,
  }: {
    itemKey: string;
    href: string;
    icon: React.ElementType;
  }) {
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
          {itemKey === "inbox" && pendingCount > 0 && (
            <span className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
              {pendingCount > 99 ? "99+" : pendingCount}
            </span>
          )}
        </div>
        {t(itemKey as Parameters<typeof t>[0])}
      </Link>
    );
  }

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 border-e bg-background z-30">
        <div className="flex h-16 items-center justify-center border-b">
          <Link href={basePath} className="text-xl font-bold text-[#1E4D8C]">
            smrtesy
          </Link>
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
            </>
          )}

          {/* Management section */}
          <SectionLabel>{t("sectionManagement")}</SectionLabel>
          {managementItems.map((item) => (
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
              {t("newTask")}
            </Button>
          </div>
        )}
      </aside>

      {/* Mobile Bottom Tab Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-50 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex items-center justify-around px-1 py-1">
          {(hasSmrtTask ? mobileItems : mobileItems.filter((i) => i.key === "inbox" || i.key === "settings")).map((item) => (
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
                {item.key === "inbox" && pendingCount > 0 && (
                  <span className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </div>
              <span className="truncate max-w-full">{t(item.key as Parameters<typeof t>[0])}</span>
            </Link>
          ))}
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

      <SmartTaskInput
        open={taskInputOpen}
        onClose={() => setTaskInputOpen(false)}
        onCreated={() => {
          window.location.reload();
        }}
      />
    </>
  );
}
