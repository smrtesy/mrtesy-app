"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, UserPlus, Trash2, Crown, Shield, User, Loader2 } from "lucide-react";
import { useActiveOrg } from "@/lib/api/use-active-org";
import { useOrgMembers, type OrgMember } from "@/lib/api/use-org-members";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface Props { locale: string }

const ROLE_ICONS: Record<OrgMember["role"], typeof User> = {
  owner: Crown,
  admin: Shield,
  member: User,
};

const ROLE_COLORS: Record<OrgMember["role"], string> = {
  owner: "text-amber-600 bg-amber-50",
  admin: "text-blue-600 bg-blue-50",
  member: "text-gray-600 bg-gray-50",
};

export function OrgSettingsClient({ locale }: Props) {
  const isHe = locale === "he";
  const { active, refresh: refreshOrgs } = useActiveOrg();
  const { members, loading, refresh: refreshMembers } = useOrgMembers();

  const [orgName, setOrgName] = useState("");
  const [orgNameHe, setOrgNameHe] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgMember["role"]>("member");
  const [inviting, setInviting] = useState(false);

  // Populate the rename inputs once active is loaded
  if (active && orgName === "" && orgNameHe === "") {
    setOrgName(active.name);
    setOrgNameHe(active.name_he ?? "");
  }

  // Role comes from the active org (the hook returns my role per org).
  const myRoleFromOrgs = active?.role;
  const canManage = myRoleFromOrgs === "owner" || myRoleFromOrgs === "admin";
  const isOwner = myRoleFromOrgs === "owner";

  async function handleRenameOrg() {
    if (!orgName.trim()) { toast.error(isHe ? "שם נדרש" : "Name required"); return; }
    setSavingOrg(true);
    try {
      await api("/api/org", {
        method: "PATCH",
        body: { name: orgName.trim(), name_he: orgNameHe.trim() || null },
      });
      toast.success(isHe ? "הארגון עודכן" : "Organization updated");
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
      await api("/api/org/members", {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole },
      });
      toast.success(isHe ? "המוזמן צורף" : "Member added");
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
      toast.success(isHe ? "התפקיד עודכן" : "Role updated");
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm(isHe ? "להסיר חבר זה?" : "Remove this member?")) return;
    try {
      await api(`/api/org/members/${userId}`, { method: "DELETE" });
      toast.success(isHe ? "החבר הוסר" : "Member removed");
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
        {isHe ? "הגדרות ארגון" : "Organization Settings"}
      </h1>

      {/* Org info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{isHe ? "פרטי ארגון" : "Organization Info"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs font-medium">{isHe ? "שם" : "Name"}</label>
            <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} disabled={!canManage} dir="auto" />
          </div>
          <div>
            <label className="text-xs font-medium">{isHe ? "שם (עברית)" : "Name (Hebrew)"}</label>
            <Input value={orgNameHe} onChange={(e) => setOrgNameHe(e.target.value)} disabled={!canManage} dir="rtl" />
          </div>
          <div className="text-xs text-muted-foreground">
            slug: <span className="font-mono">{active.slug}</span>
          </div>
          {canManage && (
            <Button onClick={handleRenameOrg} disabled={savingOrg} className="gap-2">
              {savingOrg && <Loader2 className="h-4 w-4 animate-spin" />}
              {isHe ? "שמור" : "Save"}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>{isHe ? "חברים" : "Members"} ({members.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Invite form */}
          {canManage && (
            <div className="flex gap-2 mb-4 flex-wrap">
              <Input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={isHe ? "אימייל לצירוף" : "Email to invite"}
                className="flex-1 min-w-[200px]"
                dir="auto"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgMember["role"])}
                className="rounded border px-2 py-1.5 text-sm bg-background"
              >
                <option value="member">{isHe ? "חבר" : "Member"}</option>
                <option value="admin">{isHe ? "מנהל" : "Admin"}</option>
                {isOwner && <option value="owner">{isHe ? "בעלים" : "Owner"}</option>}
              </select>
              <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} className="gap-2">
                {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                {isHe ? "צרף" : "Invite"}
              </Button>
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
                  <div key={m.user_id} className="flex items-center gap-3 rounded-lg border p-2.5">
                    <div className={`rounded-full p-1.5 ${colorClass}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.email || m.name || "—"}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        {m.name && m.email && <span className="truncate">{m.name}</span>}
                        {m.name && m.email && <span>·</span>}
                        <code className="font-mono text-[10px] opacity-60">{m.user_id.slice(0, 8)}</code>
                      </div>
                    </div>
                    {canManage && isOwner ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleChangeRole(m.user_id, e.target.value as OrgMember["role"])}
                        className="rounded border px-2 py-1 text-xs bg-background"
                      >
                        <option value="member">{isHe ? "חבר" : "Member"}</option>
                        <option value="admin">{isHe ? "מנהל" : "Admin"}</option>
                        <option value="owner">{isHe ? "בעלים" : "Owner"}</option>
                      </select>
                    ) : (
                      <Badge variant="outline" className="text-[10px] uppercase">{m.role}</Badge>
                    )}
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-red-500"
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
    </div>
  );
}
