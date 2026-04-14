"use client";

import { useState } from "react";
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
              <item.icon className="h-5 w-5" />
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
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="flex items-center justify-around px-2 py-1">
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={`${basePath}${item.href}`}
              className={cn(
                "flex min-h-[48px] min-w-[48px] flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-xs",
                isActive(item.href)
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              <span>{t(item.key)}</span>
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
