"use client";

import { useState, useEffect } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Building2, Shield, Layers } from "lucide-react";
import { OrgSettingsClient } from "@/components/platform/org/OrgSettingsClient";
import { AppsTabPanel } from "@/components/platform/settings/AppsTabPanel";
import { PlatformTabPanel } from "@/components/platform/settings/PlatformTabPanel";
import { useActiveOrg } from "@/lib/api/use-active-org";

type TabKey = "apps" | "org" | "platform";

interface Props {
  enabledApps: string[];
  /** Optional: render a specific app's settings (used by /settings/apps/[slug] routes). */
  appSlug?: string;
}

export function SettingsTabs({ enabledApps, appSlug }: Props) {
  const t = useTranslations("settingsTabs");
  const { locale } = useParams() as { locale: string };
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const supabase = createClient();
  const { active } = useActiveOrg();

  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      // Server-side gates the actual admin pages. Here we just toggle the
      // tab visibility — both DB membership and the ADMIN_EMAIL fallback
      // count as authoritative.
      const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "")
        .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (adminEmails.includes(user.email?.toLowerCase() || "")) {
        if (!cancelled) setIsAdmin(true);
        return;
      }
      const { data: row } = await supabase
        .from("super_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!cancelled) setIsAdmin(!!row);
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const canManageOrg = active?.role === "owner" || active?.role === "admin";

  // Initial tab: explicit URL > query param > app context (if on /settings/apps/*) > apps default
  const urlTab: TabKey | null =
    pathname.includes("/settings/org") ? "org" :
    pathname.includes("/settings/platform") ? "platform" :
    pathname.includes("/settings/apps") ? "apps" :
    null;
  const queryTab = sp.get("tab") as TabKey | null;
  const initialTab: TabKey = urlTab ?? queryTab ?? "apps";
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);

  function selectTab(tab: TabKey) {
    setActiveTab(tab);
    // Update URL without full nav so deep-links work and refresh keeps the tab
    if (tab === "apps") router.replace(`/${locale}/settings`);
    else if (tab === "org") router.replace(`/${locale}/settings/org`);
    else if (tab === "platform") router.replace(`/${locale}/settings/platform`);
  }

  const tabs: Array<{ key: TabKey; label: string; icon: React.ElementType; show: boolean }> = [
    { key: "apps",     label: t("apps"),     icon: Layers,    show: true },
    { key: "org",      label: t("org"),      icon: Building2, show: !!canManageOrg },
    { key: "platform", label: t("platform"), icon: Shield,    show: isAdmin },
  ];

  return (
    <div className="space-y-4">
      <div className="border-b -mx-4 md:-mx-6 px-4 md:px-6 overflow-x-auto">
        <nav className="flex gap-1 min-w-max pb-1">
          {tabs.filter((tab) => tab.show).map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => selectTab(tab.key)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-md whitespace-nowrap border-b-2 transition-colors",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {activeTab === "apps" && (
          <AppsTabPanel enabledApps={enabledApps} appSlug={appSlug} />
        )}
        {activeTab === "org" && canManageOrg && <OrgSettingsClient />}
        {activeTab === "platform" && isAdmin && <PlatformTabPanel />}
      </div>

    </div>
  );
}
