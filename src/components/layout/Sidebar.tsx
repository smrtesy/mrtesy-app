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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SmartTaskInput } from "@/components/tasks/SmartTaskInput";
import { OrgSwitcher } from "@/components/layout/OrgSwitcher";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";

const navItems = [
  { key: "tasks", href: "/tasks", icon: CheckSquare },
  { key: "suggestions", href: "/suggestions", icon: Bell },
  { key: "log", href: "/log", icon: FileText },
  { key: "calendar", href: "/calendar", icon: Calendar },
  { key: "projects", href: "/projects", icon: FolderOpen },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

export function Sidebar({ locale, isAdmin }: { locale: string; isAdmin?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [taskInputOpen, setTaskInputOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    let mounted = true;

    async function fetchCount() {
      try {
        const { count } = await api<{ count: number }>(
          "/api/tasks/count?status=inbox&verified=false&has_source=true",
        );
        if (mounted) setPendingCount(count);
      } catch (e) {
        // 401 right after login is expected; anything else log silently
        if (mounted && !(e instanceof ApiError && e.status === 401)) {
          console.error("badge count:", e);
        }
      }
    }

    fetchCount();

    // Realtime stays on Supabase — fires whenever the tasks table changes,
    // then we re-fetch through the API to respect org scoping.
    const channel = supabase
      .channel("sidebar-suggestions-count")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, fetchCount)
      .subscribe();

    // Also refresh when the user switches org
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
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={`${basePath}${item.href}`}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive(item.href)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <div className="relative">
                <item.icon className="h-5 w-5" />
                {item.key === "suggestions" && pendingCount > 0 && (
                  <span className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </div>
              {t(item.key)}
            </Link>
          ))}
          {isAdmin && (
            <Link
              href={`${basePath}/admin`}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors mt-4 border-t pt-4",
                pathname.startsWith(`${basePath}/admin`)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Shield className="h-5 w-5" />
              {t("admin")}
            </Link>
          )}
        </nav>
        {/* Desktop new task button */}
        <div className="p-3 border-t">
          <Button onClick={() => setTaskInputOpen(true)} className="w-full gap-2">
            <Plus className="h-4 w-4" />
            {t("tasks")}
          </Button>
        </div>
      </aside>

      {/* Mobile Bottom Tab Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-50 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex items-center justify-around px-1 py-1">
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={`${basePath}${item.href}`}
              className={cn(
                "flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px]",
                isActive(item.href)
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
            >
              <div className="relative">
                <item.icon className="h-5 w-5 shrink-0" />
                {item.key === "suggestions" && pendingCount > 0 && (
                  <span className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </div>
              <span className="truncate max-w-full">{t(item.key)}</span>
            </Link>
          ))}
        </div>
      </nav>

      {/* FAB — Mobile only */}
      <Button
        size="icon"
        className="fixed bottom-20 end-4 z-50 h-14 w-14 rounded-full shadow-lg md:hidden"
        onClick={() => setTaskInputOpen(true)}
      >
        <Plus className="h-6 w-6" />
      </Button>

      {/* Smart Task Input */}
      <SmartTaskInput
        open={taskInputOpen}
        onClose={() => setTaskInputOpen(false)}
        onCreated={() => {
          // Trigger page refresh — TaskList will re-fetch
          window.location.reload();
        }}
      />
    </>
  );
}
