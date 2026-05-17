"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, ArrowLeft, Trash2, Crown, Shield, User, Power, PowerOff, Loader2, Mail, X } from "lucide-react";
import { api, ApiError, setActiveOrgId } from "@/lib/api/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface AdminOrgDetail {
  org: { id: string; slug: string; name: string; name_he: string | null; created_at: string };
  members: Array<{
    user_id: string;
    role: "owner" | "admin" | "member";
    joined_at: string;
    invited_by: string | null;
    email: string | null;
    name: string | null;
  }>;
  apps: Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    enabled: boolean;
    enabled_by: string | null;
    enabled_at: string | null;
  }>;
  stats: { task_count: number; project_count: number };
}

interface OrgInvite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

const ROLE_ICONS = { owner: Crown, admin: Shield, member: User };

export function OrgDetailClient({ locale, orgId }: { locale: string; orgId: string }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [data, setData] = useState<AdminOrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);

  const fetchOrg = useCallback(async () => {
    try {
      const res = await api<AdminOrgDetail>(`/api/admin/orgs/${orgId}`, { noOrg: true });
      setData(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast.error(t("orgNotFound"));
        router.push(`/${locale}/admin/orgs`);
      } else if (!(e instanceof ApiError && e.status === 401)) {
        toast.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, locale, router, t]);

  const fetchInvites = useCallback(async () => {
    try {
      const res = await api<{ invites: OrgInvite[] }>(`/api/admin/orgs/${orgId}/invites`, { noOrg: true });
      setInvites(res.invites ?? []);
    } catch {
      // Non-critical: silently ignore invite fetch failures
    }
  }, [orgId]);

  useEffect(() => {
    fetchOrg();
    fetchInvites();
  }, [fetchOrg, fetchInvites]);

  async function toggleApp(slug: string, currentlyEnabled: boolean) {
    setToggling(slug);
    try {
      if (currentlyEnabled) {
        await api(`/api/admin/orgs/${orgId}/apps/${slug}`, { method: "DELETE", noOrg: true });
        toast.success(t("appToggledOff", { slug }));
      } else {
        await api(`/api/admin/orgs/${orgId}/apps/${slug}`, { method: "POST", noOrg: true });
        toast.success(t("appToggledOn", { slug }));
      }
      fetchOrg();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToggling(null);
    }
  }

  async function handleOpenAsThisOrg() {
    setActiveOrgId(orgId);
    router.push(`/${locale}/tasks`);
  }

  async function handleRemoveMember(userId: string) {
    if (!confirm(t("removeMemberConfirm"))) return;
    try {
      await api(`/api/admin/orgs/${orgId}/members/${userId}`, { method: "DELETE", noOrg: true });
      toast.success(t("memberRemoved"));
      fetchOrg();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleChangeRole(userId: string, role: string) {
    try {
      await api(`/api/admin/orgs/${orgId}/members/${userId}`, {
        method: "PATCH",
        body: { role },
        noOrg: true,
      });
      toast.success(t("roleUpdated"));
      fetchOrg();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDeleteOrg() {
    if (!confirm(t("deleteOrgConfirm", { name: data?.org.name ?? "" }))) return;
    if (!confirm(t("deleteOrgConfirm2", { tasks: data?.stats.task_count ?? 0, projects: data?.stats.project_count ?? 0 }))) return;
    try {
      await api(`/api/admin/orgs/${orgId}`, { method: "DELETE", noOrg: true });
      toast.success(t("orgDeleted"));
      router.push(`/${locale}/admin/orgs`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSendInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      await api(`/api/admin/orgs/${orgId}/invites`, {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole, locale },
        noOrg: true,
      });
      toast.success(t("inviteSent", { email: inviteEmail.trim() }));
      setInviteEmail("");
      fetchInvites();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    try {
      await api(`/api/admin/orgs/${orgId}/invites/${inviteId}`, { method: "DELETE", noOrg: true });
      toast.success(t("inviteRevoked"));
      fetchInvites();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!data) return null;

  const pendingInvites = invites.filter((i) => !i.accepted_at && new Date(i.expires_at) > new Date());

  return (
    <div className="space-y-4">
      <Link
        href={`/${locale}/admin/orgs`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {t("backToOrgs")}
      </Link>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2 min-w-0">
          <Building2 className="h-6 w-6 shrink-0" />
          <span className="truncate" dir="auto">{data.org.name}</span>
          <span className="text-sm font-mono text-muted-foreground">{data.org.slug}</span>
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleOpenAsThisOrg}>
            {t("openAsOrg")}
          </Button>
          <Button variant="outline" size="sm" className="text-red-500 gap-1" onClick={handleDeleteOrg}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("deleteOrg")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.members.length}</div>
          <div className="text-xs text-muted-foreground">{t("membersSection")}</div>
        </CardContent></Card>
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.stats.task_count}</div>
          <div className="text-xs text-muted-foreground">{t("tasksCount")}</div>
        </CardContent></Card>
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.stats.project_count}</div>
          <div className="text-xs text-muted-foreground">{t("projectsCount")}</div>
        </CardContent></Card>
      </div>

      {/* Invite section */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            {t("inviteSection")}
            {pendingInvites.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">{pendingInvites.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder={t("inviteEmailPlaceholder")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendInvite()}
              className="flex-1"
              dir="auto"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="rounded border px-2 py-1 text-sm bg-background"
            >
              <option value="member">{t("roleMember")}</option>
              <option value="admin">{t("roleAdmin")}</option>
              <option value="owner">{t("roleOwner")}</option>
            </select>
            <Button size="sm" onClick={handleSendInvite} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("inviteSendBtn")}
            </Button>
          </div>

          {pendingInvites.length > 0 && (
            <div className="space-y-1.5">
              {pendingInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between rounded border p-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm">{inv.email}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">{t(`role${inv.role.charAt(0).toUpperCase() + inv.role.slice(1)}` as "roleMember" | "roleAdmin" | "roleOwner")}</Badge>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {t("inviteExpires", { date: new Date(inv.expires_at).toLocaleDateString() })}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-red-500"
                      onClick={() => handleRevokeInvite(inv.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("appsSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.apps.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t("noAppsInRegistry")}</p>
          ) : data.apps.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-lg border p-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{a.name}</div>
                {a.enabled && a.enabled_at && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t("enabledAt", { date: new Date(a.enabled_at).toLocaleString() })}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant={a.enabled ? "default" : "outline"}
                className="gap-1.5 min-w-[110px]"
                disabled={toggling === a.slug}
                onClick={() => toggleApp(a.slug, a.enabled)}
              >
                {toggling === a.slug ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : a.enabled ? (
                  <><Power className="h-3.5 w-3.5" /> {t("enabledStatus")}</>
                ) : (
                  <><PowerOff className="h-3.5 w-3.5" /> {t("disabledStatus")}</>
                )}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("membersSection")} ({data.members.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.members.map((m) => {
            const Icon = ROLE_ICONS[m.role];
            return (
              <div key={m.user_id} className="flex items-center gap-3 rounded-lg border p-2.5">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{m.email || m.name || "—"}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    {m.name && m.email && <span className="truncate">{m.name}</span>}
                    {m.name && m.email && <span>·</span>}
                    <code className="font-mono text-[10px] opacity-60">{m.user_id.slice(0, 8)}</code>
                  </div>
                </div>
                <select
                  value={m.role}
                  onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                  className="rounded border px-2 py-1 text-xs bg-background"
                >
                  <option value="member">{t("roleMember")}</option>
                  <option value="admin">{t("roleAdmin")}</option>
                  <option value="owner">{t("roleOwner")}</option>
                </select>
                <Badge variant="outline" className="text-[10px]">{t(`role${m.role.charAt(0).toUpperCase() + m.role.slice(1)}` as "roleMember" | "roleAdmin" | "roleOwner")}</Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-500"
                  onClick={() => handleRemoveMember(m.user_id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
