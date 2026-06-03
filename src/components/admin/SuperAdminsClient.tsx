"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Crown, Trash2, Search, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

interface SuperAdmin {
  user_id: string;
  granted_by: string | null;
  granted_at: string;
  note: string | null;
  email: string | null;
  name: string | null;
}

interface AdminUser {
  id: string;
  email: string | null;
  name: string | null;
  is_super_admin: boolean;
}

export function SuperAdminsClient() {
  const t = useTranslations("admin");
  const [admins, setAdmins] = useState<SuperAdmin[]>([]);
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [granting, setGranting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const [{ super_admins }, { users }] = await Promise.all([
        api<{ super_admins: SuperAdmin[] }>("/api/admin/super-admins", { noOrg: true }),
        api<{ users: AdminUser[] }>("/api/admin/users", { noOrg: true }),
      ]);
      setAdmins(super_admins ?? []);
      setAllUsers(users ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  async function handleGrant(user: AdminUser) {
    setGranting(user.id);
    try {
      await api(`/api/admin/users/${user.id}/super-admin`, { method: "POST", body: {}, noOrg: true });
      toast.success(t("isNowSuperAdmin", { email: user.email ?? user.id.slice(0, 8) }));
      fetchData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGranting(null);
    }
  }

  async function handleRevoke(admin: SuperAdmin) {
    if (!confirm(t("revokeSuperAdminConfirm", { email: admin.email ?? admin.user_id.slice(0, 8) }))) return;
    setRevoking(admin.user_id);
    try {
      await api(`/api/admin/users/${admin.user_id}/super-admin`, { method: "DELETE", noOrg: true });
      toast.success(t("revoked"));
      fetchData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  const adminIds = new Set(admins.map((a) => a.user_id));
  const searchLower = search.trim().toLowerCase();
  const candidates = searchLower.length >= 2
    ? allUsers.filter((u) =>
        !adminIds.has(u.id)
        && ((u.email?.toLowerCase() ?? "").includes(searchLower)
          || (u.name?.toLowerCase() ?? "").includes(searchLower)))
        .slice(0, 8)
    : [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Crown className="h-6 w-6 text-status-warn" />
        {t("superAdminsTitle")} <span className="text-muted-foreground text-base">({admins.length})</span>
      </h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("grantSuperAdmin")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchByEmailOrName")}
              className="ps-9"
            />
          </div>
          {candidates.length > 0 && (
            <div className="space-y-1 mt-1">
              {candidates.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{u.email || u.name || "—"}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      {u.name && u.email && <span className="truncate">{u.name}</span>}
                      {u.name && u.email && <span>·</span>}
                      <code className="font-mono text-[10px] opacity-60">{u.id.slice(0, 8)}</code>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleGrant(u)}
                    disabled={granting === u.id}
                    className="gap-1.5"
                  >
                    {granting === u.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crown className="h-3 w-3" />}
                    {t("grant")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {searchLower.length >= 2 && candidates.length === 0 && (
            <p className="text-xs text-muted-foreground italic">{t("noMatchingUsers")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("currentSuperAdmins")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : admins.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t("noSuperAdmins")}</p>
          ) : admins.map((a) => (
            <div key={a.user_id} className="flex items-center gap-3 rounded-lg border p-2.5">
              <Crown className="h-4 w-4 text-status-warn shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{a.email || a.name || "—"}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  {a.name && a.email && <span className="truncate">{a.name}</span>}
                  {a.name && a.email && <span>·</span>}
                  <code className="font-mono text-[10px] opacity-60">{a.user_id.slice(0, 8)}</code>
                </div>
                {a.note && <div className="text-[10px] text-muted-foreground italic mt-0.5">{a.note}</div>}
              </div>
              <div className="text-[10px] text-muted-foreground text-end shrink-0">
                {t("granted")} {new Date(a.granted_at).toLocaleDateString()}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-destructive hover:bg-destructive/10"
                disabled={revoking === a.user_id}
                onClick={() => handleRevoke(a)}
              >
                {revoking === a.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
