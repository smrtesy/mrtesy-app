"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Building2,
  Layers,
  Crown,
  FileText,
  BookOpen,
  DollarSign,
  Globe,
  ShoppingCart,
  KeyRound,
  Bot,
  Lock,
  FlaskConical,
} from "lucide-react";

// Platform-level only. Per-app concerns (services, prompts) now live
// under /admin/apps/[slug]/*. User-scoped concerns (rules, sync) moved
// to /settings/* — see CLAUDE.md for the conceptual split. Labels resolve
// to i18n keys at render time so the tab strip respects the active locale.
const items = [
  { key: "dashboard",    href: "",               labelKey: "dashboard",    icon: LayoutDashboard },
  { key: "users",        href: "users",          labelKey: "users",        icon: Users },
  { key: "orgs",         href: "orgs",           labelKey: "orgs",         icon: Building2 },
  { key: "apps",         href: "apps",           labelKey: "apps",         icon: Layers },
  { key: "super-admins", href: "super-admins",   labelKey: "superAdmins",  icon: Crown },
  { key: "permissions",  href: "permissions",    labelKey: "permissions",  icon: Lock },
  { key: "logs",         href: "logs",           labelKey: "logs",         icon: FileText },
  { key: "usage",        href: "usage",          labelKey: "usage",        icon: DollarSign },
  { key: "docs",         href: "docs",           labelKey: "docs",         icon: BookOpen },
  { key: "domain-tracker", href: "domain-tracker", labelKey: "domainTracker", icon: Globe },
  { key: "price-tracker",  href: "price-tracker",  labelKey: "priceTracker",  icon: ShoppingCart },
  // Managed secrets — one place to add a key, live mirror + propagate to
  // Railway/Vercel/Supabase. Super-admin only, like the rest of /admin.
  { key: "secrets",        href: "secrets",        labelKey: "secrets",       icon: KeyRound },
  // Claude runs launched from inside the app (docs/claude-console/plan.md). Lives
  // here rather than in the app sidebar because it is platform-level and gated by
  // the same super-admin check as the rest of /admin, matching the Express
  // requireSuperAdmin on its routes.
  { key: "claude",         href: "claude",         labelKey: "claude",        icon: Bot },
  // Feature channels — beta vs stable maturity per feature (docs/feature-channels-plan.md).
  { key: "features",       href: "features",       labelKey: "features",      icon: FlaskConical },
];

export function AdminNav() {
  const pathname = usePathname();
  const { locale } = useParams() as { locale: string };
  const t = useTranslations("adminNav");
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
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
