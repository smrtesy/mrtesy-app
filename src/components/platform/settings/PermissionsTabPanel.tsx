"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Lock, Loader2, DollarSign } from "lucide-react";
import { api } from "@/lib/api/client";
import { useOrgMembers } from "@/lib/api/use-org-members";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type CatalogResource = {
  key: string;
  appSlug: string;
  kind: "screen" | "subscreen" | "action";
  labelKey: string;
  descriptionKey: string | null;
  defaultRestricted: boolean;
  costly: boolean;
  restricted: boolean;
  explicit: boolean;
};

type UserResource = {
  key: string;
  appSlug: string;
  kind: string;
  labelKey: string;
  restricted: boolean;
  granted: boolean;
  allowed: boolean;
};

/**
 * Org-admin permissions management — the "open-by-default, restrict-specific"
 * layer. Two sections: (1) which catalog resources this org restricts, and
 * (2) per-user exceptions for restricted resources. See
 * docs/permissions-management-plan.md.
 */
export function PermissionsTabPanel() {
  const t = useTranslations();
  const { members } = useOrgMembers();

  const [catalog, setCatalog] = useState<CatalogResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [selectedUser, setSelectedUser] = useState<string>("");
  const [userResources, setUserResources] = useState<UserResource[] | null>(null);
  const [userBypasses, setUserBypasses] = useState(false);
  const [userLoading, setUserLoading] = useState(false);
  const [grantBusy, setGrantBusy] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const { resources } = await api<{ resources: CatalogResource[] }>(
        "/api/org/permissions/catalog",
      );
      setCatalog(resources ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const loadUser = useCallback(async (userId: string) => {
    if (!userId) {
      setUserResources(null);
      return;
    }
    setUserLoading(true);
    try {
      const data = await api<{ bypasses: boolean; resources: UserResource[] }>(
        `/api/org/permissions/users/${userId}`,
      );
      setUserBypasses(data.bypasses);
      setUserResources(data.resources ?? []);
    } catch (e) {
      toast.error((e as Error).message);
      setUserResources(null);
    } finally {
      setUserLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser(selectedUser);
  }, [selectedUser, loadUser]);

  async function toggleRestriction(r: CatalogResource, next: boolean) {
    setBusyKey(r.key);
    try {
      await api("/api/org/permissions/restrictions", {
        method: "PUT",
        body: { resource_key: r.key, restricted: next },
      });
      setCatalog((prev) =>
        prev.map((x) => (x.key === r.key ? { ...x, restricted: next, explicit: true } : x)),
      );
      // A restriction change can flip the selected user's effective access.
      if (selectedUser) loadUser(selectedUser);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleGrant(res: UserResource, grant: boolean) {
    if (!selectedUser) return;
    setGrantBusy(res.key);
    try {
      await api("/api/org/permissions/grants", {
        method: grant ? "POST" : "DELETE",
        body: { user_id: selectedUser, resource_key: res.key },
      });
      setUserResources((prev) =>
        (prev ?? []).map((x) =>
          x.key === res.key ? { ...x, granted: grant, allowed: !x.restricted || grant } : x,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGrantBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Section 1 — what is restricted in this org */}
      <section className="space-y-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Lock className="h-4 w-4" />
            {t("permissions.orgSection.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("permissions.orgSection.subtitle")}</p>
        </div>

        <div className="divide-y rounded-lg border">
          {catalog.map((r) => (
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
                {r.descriptionKey && (
                  <div className="text-xs text-muted-foreground">{t(r.descriptionKey)}</div>
                )}
                <div className="mt-0.5 text-[11px] text-muted-foreground" dir="ltr">
                  {r.appSlug} · {r.key}
                </div>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {r.restricted ? t("permissions.restricted") : t("permissions.open")}
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={r.restricted}
                  disabled={busyKey === r.key}
                  onChange={(e) => toggleRestriction(r, e.target.checked)}
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      {/* Section 2 — per-user exceptions */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t("permissions.userSection.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("permissions.userSection.subtitle")}</p>
        </div>

        <select
          className="w-full max-w-sm rounded-md border bg-background px-3 py-2 text-sm"
          value={selectedUser}
          onChange={(e) => setSelectedUser(e.target.value)}
        >
          <option value="">{t("permissions.userSection.pick")}</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.display_name || m.name || m.email || m.user_id}
              {m.role !== "member" ? ` (${m.role})` : ""}
            </option>
          ))}
        </select>

        {userLoading && (
          <div className="flex py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {!userLoading && userResources && userBypasses && (
          <p className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            {t("permissions.userSection.bypasses")}
          </p>
        )}

        {!userLoading && userResources && !userBypasses && (
          <div className="divide-y rounded-lg border">
            {userResources.map((res) => {
              // Only restricted resources are actionable — an open resource is
              // already available to everyone, so there's nothing to grant.
              const actionable = res.restricted;
              return (
                <div key={res.key} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t(res.labelKey)}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {res.restricted
                        ? res.allowed
                          ? t("permissions.userSection.grantedTag")
                          : t("permissions.userSection.blockedTag")
                        : t("permissions.open")}
                    </div>
                  </div>
                  {actionable ? (
                    <button
                      type="button"
                      disabled={grantBusy === res.key}
                      onClick={() => toggleGrant(res, !res.granted)}
                      className={cn(
                        "shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                        res.granted
                          ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                          : "border-primary/40 text-primary hover:bg-primary/10",
                      )}
                    >
                      {res.granted
                        ? t("permissions.userSection.revoke")
                        : t("permissions.userSection.grant")}
                    </button>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("permissions.open")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
