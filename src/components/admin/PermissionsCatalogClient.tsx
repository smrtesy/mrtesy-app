"use client";

import { useTranslations } from "next-intl";
import { Lock, DollarSign } from "lucide-react";
import { RESTRICTABLE_RESOURCES } from "@/lib/permissions/registry";

/**
 * Super-admin view of the platform-wide restrictable-resource CATALOG (the code
 * registry — the single source of truth for what CAN be restricted). Read-only
 * in phase 1: the actual per-org restriction toggles and per-user exceptions are
 * managed inside each org's own /settings/permissions surface (which a
 * super-admin can also reach when acting in that org). Cross-org management from
 * here is a later addition. See docs/permissions-management-plan.md.
 */
export function PermissionsCatalogClient() {
  const t = useTranslations();

  // Group by app for a readable catalog.
  const byApp = new Map<string, typeof RESTRICTABLE_RESOURCES>();
  for (const r of RESTRICTABLE_RESOURCES) {
    const list = byApp.get(r.appSlug) ?? [];
    list.push(r);
    byApp.set(r.appSlug, list);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Lock className="h-5 w-5" />
          {t("permissions.admin.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("permissions.admin.subtitle")}</p>
      </div>

      <div className="space-y-5">
        {[...byApp.entries()].map(([appSlug, resources]) => (
          <section key={appSlug} className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground" dir="ltr">
              {appSlug}
            </h2>
            <div className="divide-y rounded-lg border">
              {resources.map((r) => (
                <div key={r.key} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {t(r.labelKey)}
                      {r.costly && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                          <DollarSign className="h-3 w-3" />
                          {t("permissions.costly")}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground" dir="ltr">
                      {r.kind} · {r.key}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.defaultRestricted
                      ? t("permissions.admin.defaultRestricted")
                      : t("permissions.admin.defaultOpen")}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
