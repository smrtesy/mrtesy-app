"use client";

import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, UserPlus, Trash2, Crown, Shield, User, Loader2, AlertTriangle } from "lucide-react";
import { useActiveOrg } from "@/lib/api/use-active-org";
import { useOrgMembers, type OrgMember } from "@/lib/api/use-org-members";
import { api } from "@/lib/api/client";
import { toast } from "sonner";


const ROLE_ICONS: Record<OrgMember["role"], typeof User> = {
  owner: Crown,
  admin: Shield,
  member: User,
};

const ROLE_COLORS: Record<OrgMember["role"], string> = {
  owner: "text-status-warn bg-status-warn-bg",
  admin: "text-primary bg-accent",
  member: "text-muted-foreground bg-muted",
};

// All user-facing strings go through useTranslations now, so the component
// no longer needs locale as a prop. The page wrapper used to pass it; that
// arg has been dropped from the wrapper too.
export function OrgSettingsClient() {
  const tOrg = useTranslations("orgSettings");
  const locale = useLocale();
  const { active, refresh: refreshOrgs } = useActiveOrg();
  const { members, loading, refresh: refreshMembers } = useOrgMembers();

  const [orgName, setOrgName] = useState("");
  const [orgNameHe, setOrgNameHe] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [errorHandlerUserId, setErrorHandlerUserId] = useState<string | null>(null);
  const [savingErrorHandler, setSavingErrorHandler] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgMember["role"]>("member");
  const [inviting, setInviting] = useState(false);

  // Populate inputs when active org loads or switches
  useEffect(() => {
    if (!active) return;
    setOrgName(active.name);
    setOrgNameHe(active.name_he ?? "");

    api<{ org: { error_handler_user_id: string | null } }>("/api/org")
      .then(({ org }) => setErrorHandlerUserId(org.error_handler_user_id))
      .catch(() => { /* non-critical, dropdown defaults to null = owner */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Role comes from the active org (the hook returns my role per org).
  const myRoleFromOrgs = active?.role;
  const canManage = myRoleFromOrgs === "owner" || myRoleFromOrgs === "admin";
  const isOwner = myRoleFromOrgs === "owner";

  async function handleRenameOrg() {
    if (!orgName.trim()) { toast.error(tOrg("nameRequired")); return; }
    setSavingOrg(true);
    try {
      await api("/api/org", {
        method: "PATCH",
        body: { name: orgName.trim(), name_he: orgNameHe.trim() || null },
      });
      toast.success(tOrg("organizationUpdated"));
      refreshOrgs();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingOrg(false);
    }
  }

  async function handleInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const result = await api<{ invited?: boolean; warning?: string }>("/api/org/members", {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole, locale },
      });
      if (result.invited && result.warning) {
        // Invite row was created but the email failed to send — don't claim it was sent.
        toast.warning(tOrg("inviteCreatedEmailFailed"));
      } else {
        toast.success(result.invited ? tOrg("inviteSent") : tOrg("memberAdded"));
      }
      setInviteEmail("");
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleChangeRole(userId: string, role: OrgMember["role"]) {
    try {
      await api(`/api/org/members/${userId}/role`, { method: "PATCH", body: { role } });
      toast.success(tOrg("roleUpdated"));
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSaveErrorHandler() {
    setSavingErrorHandler(true);
    try {
      await api("/api/org", {
        method: "PATCH",
        body: { error_handler_user_id: errorHandlerUserId },
      });
      toast.success(tOrg("errorHandlerSaved"));
      refreshOrgs();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingErrorHandler(false);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm(tOrg("removeMemberConfirm"))) return;
    try {
      await api(`/api/org/members/${userId}`, { method: "DELETE" });
      toast.success(tOrg("memberRemoved"));
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!active) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Building2 className="h-6 w-6" />
        {tOrg("title")}
      </h1>

      {/* Org info */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base">{tOrg("orgInfo")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4 md:px-6 md:pb-6">
          <div>
            <label className="text-xs font-medium">{tOrg("name")}</label>
            <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} disabled={!canManage} dir="auto" />
          </div>
          <div>
            <label className="text-xs font-medium">{tOrg("nameHebrew")}</label>
            <Input value={orgNameHe} onChange={(e) => setOrgNameHe(e.target.value)} disabled={!canManage} dir="rtl" />
          </div>
          <div className="text-xs text-muted-foreground">
            slug: <span className="font-mono">{active.slug}</span>
          </div>
          {canManage && (
            <Button onClick={handleRenameOrg} disabled={savingOrg} className="gap-2">
              {savingOrg && <Loader2 className="h-4 w-4 animate-spin" />}
              {tOrg("save")}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>{tOrg("members")} ({members.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
          {/* Invite form */}
          {canManage && (
            <div className="flex flex-col gap-2 mb-4 sm:flex-row sm:flex-wrap">
              <Input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={tOrg("emailToInvite")}
                className="w-full sm:flex-1"
                dir="auto"
              />
              <div className="flex gap-2">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgMember["role"])}
                  className="flex-1 rounded border px-2 py-1.5 text-sm bg-background"
                >
                  <option value="member">{tOrg("roleMember")}</option>
                  <option value="admin">{tOrg("roleAdmin")}</option>
                  {isOwner && <option value="owner">{tOrg("roleOwner")}</option>}
                </select>
                <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} className="gap-2 shrink-0">
                  {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  {tOrg("invite")}
                </Button>
              </div>
            </div>
          )}

          {/* Members list */}
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <div className="space-y-2">
              {members.map((m) => {
                const Icon = ROLE_ICONS[m.role];
                const colorClass = ROLE_COLORS[m.role];
                return (
                  <div key={m.user_id} className="flex items-center gap-2 rounded-lg border p-2.5 min-w-0">
                    <div className={`shrink-0 rounded-full p-1.5 ${colorClass}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.email || m.name || "—"}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                        {m.name && m.email && <span className="truncate">{m.name}</span>}
                        {m.name && m.email && <span>·</span>}
                        <code className="font-mono text-[10px] opacity-60 shrink-0">{m.user_id.slice(0, 8)}</code>
                      </div>
                    </div>
                    {canManage && isOwner ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleChangeRole(m.user_id, e.target.value as OrgMember["role"])}
                        className="shrink-0 rounded border px-1.5 py-1 text-xs bg-background max-w-[80px]"
                      >
                        <option value="member">{tOrg("roleMember")}</option>
                        <option value="admin">{tOrg("roleAdmin")}</option>
                        <option value="owner">{tOrg("roleOwner")}</option>
                      </select>
                    ) : (
                      <Badge variant="outline" className="text-[10px] uppercase shrink-0">{m.role}</Badge>
                    )}
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 h-8 w-8 text-destructive hover:bg-destructive/10"
                        onClick={() => handleRemove(m.user_id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      {/* Error handler */}
      {canManage && (
        <Card>
          <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-status-warn" />
              {tOrg("errorHandlerTitle")}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{tOrg("errorHandlerDesc")}</p>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 md:px-6 md:pb-6">
            <select
              value={errorHandlerUserId ?? ""}
              onChange={(e) => setErrorHandlerUserId(e.target.value || null)}
              className="w-full rounded border px-3 py-2 text-sm bg-background"
            >
              <option value="">{tOrg("errorHandlerOwnerDefault")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email || m.name || m.user_id.slice(0, 8)}
                  {m.role === "owner" ? ` (${tOrg("roleOwner")})` : ""}
                </option>
              ))}
            </select>
            <Button
              onClick={handleSaveErrorHandler}
              disabled={savingErrorHandler}
              className="gap-2"
            >
              {savingErrorHandler && <Loader2 className="h-4 w-4 animate-spin" />}
              {tOrg("save")}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
