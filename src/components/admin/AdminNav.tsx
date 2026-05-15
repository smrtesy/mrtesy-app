"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Building2,
  Layers,
  Crown,
  FileText,
} from "lucide-react";

// Platform-level only. Per-app concerns (services, prompts) now live
// under /admin/apps/[slug]/*. User-scoped concerns (rules, sync) moved
// to /settings/* — see CLAUDE.md for the conceptual split.
const items = [
  { key: "dashboard",    href: "",               label: "Dashboard",    icon: LayoutDashboard },
  { key: "users",        href: "users",          label: "Users",        icon: Users },
  { key: "orgs",         href: "orgs",           label: "Organizations", icon: Building2 },
  { key: "apps",         href: "apps",           label: "Apps",         icon: Layers },
  { key: "super-admins", href: "super-admins",   label: "Super Admins", icon: Crown },
  { key: "logs",         href: "logs",           label: "Logs",         icon: FileText },
];

export function AdminNav() {
  const pathname = usePathname();
  const { locale } = useParams() as { locale: string };
  const base = `/${locale}/admin`;

  function isActive(href: string) {
    const full = href ? `${base}/${href}` : base;
    if (href === "") return pathname === base || pathname === `${base}/`;
    return pathname.startsWith(full);
  }

  return (
    <div className="border-b -mx-4 md:-mx-6 px-4 md:px-6 mb-4 overflow-x-auto">
      <nav className="flex gap-1 min-w-max pb-1">
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.key}
              href={item.href ? `${base}/${item.href}` : base}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-md whitespace-nowrap border-b-2 transition-colors",
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
