"use client";

import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, UserPlus, Trash2, Crown, Shield, User, Loader2, AlertTriangle, Mail, RefreshCw, X, LogIn, Copy, Code2 } from "lucide-react";
import { useActiveOrg } from "@/lib/api/use-active-org";
import { useOrgMembers, type OrgMember } from "@/lib/api/use-org-members";
import { personLabel } from "@/lib/smrtplan/people";
import { useOrgInvites } from "@/lib/api/use-org-invites";
import { useOrgApps } from "@/lib/api/use-org-apps";
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
  const { invites, refresh: refreshInvites } = useOrgInvites();
  const { enabledApps: orgApps } = useOrgApps();

  const [orgName, setOrgName] = useState("");
  const [orgNameHe, setOrgNameHe] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [errorHandlerUserId, setErrorHandlerUserId] = useState<string | null>(null);
  const [savingErrorHandler, setSavingErrorHandler] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [noEmail, setNoEmail] = useState(false);
  const [inviteRole, setInviteRole] = useState<OrgMember["role"]>("member");
  const [inviteApps, setInviteApps] = useState<string[]>([]);
  // Project-only ("lean") worker: uses smrtTask only for tasks assigned to them
  // (from a plan or another user) — no sources, inbox, projects or initial scan.
  const [inviteProjectOnly, setInviteProjectOnly] = useState(false);
  const [inviting, setInviting] = useState(false);
  // App bundle a project-only worker gets: task list + read-only plan context.
  const PROJECT_ONLY_APPS = ["smrttask", "smrtplan"];
  const [editingAppsFor, setEditingAppsFor] = useState<string | null>(null);
  // "Sign in as employee" preview: a one-time link the manager opens in an
  // incognito window to see exactly what a member (esp. a no-email employee)
  // will see, before connecting them.
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  // My own user id in the active org — so the developer toggle is hidden on my
  // own row (the backend forbids self-flagging to avoid a management lockout).
  const [myUserId, setMyUserId] = useState<string | null>(null);

  // Populate inputs when active org loads or switches
  useEffect(() => {
    if (!active) return;
    setOrgName(active.name);
    setOrgNameHe(active.name_he ?? "");

    api<{ org: { error_handler_user_id: string | null } }>("/api/org")
      .then(({ org }) => setErrorHandlerUserId(org.error_handler_user_id))
      .catch(() => { /* non-critical, dropdown defaults to null = owner */ });

    api<{ user_id: string }>("/api/org/me")
      .then(({ user_id }) => setMyUserId(user_id))
      .catch(() => { /* non-critical; self-row toggle just stays visible */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Role comes from the active org (the hook returns my role per org).
  const myRoleFromOrgs = active?.role;
  const canManage = myRoleFromOrgs === "owner" || myRoleFromOrgs === "admin";
  const isOwner = myRoleFromOrgs === "owner";

  const appName = (slug: string) => orgApps.find((a) => a.slug === slug)?.name ?? slug;

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

  function toggleInviteApp(slug: string) {
    setInviteApps((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  }

  async function handleInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      // Project-only worker → forced member, fixed lean app bundle, lite level.
      // Otherwise apps only matter for regular members (owners/admins see all).
      const projectOnly = inviteRole === "member" && inviteProjectOnly;
      const app_slugs = projectOnly ? PROJECT_ONLY_APPS : inviteRole === "member" ? inviteApps : [];
      const access_level = projectOnly ? "lite" : "full";
      const result = await api<{ invited?: boolean; warning?: string }>("/api/org/members", {
        method: "POST",
        body: { email: inviteEmail.trim(), role: inviteRole, locale, app_slugs, access_level },
      });
      if (result.warning) {
        // Either the invite email failed to send, or (existing user) the app
        // grant didn't save — don't report a clean success.
        toast.warning(result.invited ? tOrg("inviteCreatedEmailFailed") : tOrg("memberAppsSaveFailed"));
      } else {
        toast.success(result.invited ? tOrg("inviteSent") : tOrg("memberAdded"));
      }
      setInviteEmail("");
      setInviteApps([]);
      setInviteProjectOnly(false);
      refreshMembers();
      refreshInvites();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleAddPlaceholder() {
    if (!inviteName.trim()) return;
    setInviting(true);
    try {
      const projectOnly = inviteRole === "member" && inviteProjectOnly;
      const app_slugs = projectOnly ? PROJECT_ONLY_APPS : inviteRole === "member" ? inviteApps : [];
      const access_level = projectOnly ? "lite" : "full";
      const result = await api<{ warning?: string }>("/api/org/members/placeholder", {
        method: "POST",
        body: { name: inviteName.trim(), role: inviteRole, app_slugs, access_level },
      });
      if (result.warning) toast.warning(tOrg("memberAppsSaveFailed"));
      else toast.success(tOrg("memberAdded"));
      setInviteName("");
      setInviteApps([]);
      setInviteProjectOnly(false);
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleSetEmail(userId: string, email: string) {
    try {
      await api(`/api/org/members/${userId}/email`, { method: "PATCH", body: { email: email.trim() } });
      toast.success(tOrg("emailSet"));
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleResendInvite(id: string) {
    try {
      const r = await api<{ warning?: string }>(`/api/org/invites/${id}/resend`, {
        method: "POST", body: { locale },
      });
      if (r.warning) toast.warning(tOrg("inviteCreatedEmailFailed"));
      else toast.success(tOrg("inviteResent"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleRevokeInvite(id: string) {
    if (!confirm(tOrg("revokeInviteConfirm"))) return;
    try {
      await api(`/api/org/invites/${id}`, { method: "DELETE" });
      toast.success(tOrg("inviteRevoked"));
      refreshInvites();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleToggleMemberApp(m: OrgMember, slug: string) {
    const next = m.app_slugs.includes(slug)
      ? m.app_slugs.filter((s) => s !== slug)
      : [...m.app_slugs, slug];
    setEditingAppsFor(m.user_id);
    try {
      await api(`/api/org/members/${m.user_id}/apps`, { method: "PATCH", body: { app_slugs: next } });
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEditingAppsFor(null);
    }
  }

  // Flip an existing member between project-only (smrtTask lite) and full,
  // preserving their app grants — only the access level changes.
  async function handleToggleProjectOnly(m: OrgMember) {
    const next = m.access_level === "lite" ? "full" : "lite";
    setEditingAppsFor(m.user_id);
    try {
      await api(`/api/org/members/${m.user_id}/apps`, {
        method: "PATCH",
        body: { app_slugs: m.app_slugs, access_level: next },
      });
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEditingAppsFor(null);
    }
  }

  async function handleSaveDisplayName(userId: string, value: string) {
    try {
      await api(`/api/org/members/${userId}/display-name`, { method: "PATCH", body: { display_name: value.trim() || null } });
      refreshMembers();
    } catch (e) {
      toast.error((e as Error).message);
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

  async function handleToggleDeveloper(userId: string, next: boolean) {
    try {
      await api(`/api/org/members/${userId}/developer`, { method: "PATCH", body: { is_developer: next } });
      toast.success(next ? tOrg("developerOn") : tOrg("developerOff"));
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

  async function handlePreview(userId: string) {
    setPreviewFor(userId);
    setPreviewUrl(null);
    setPreviewCopied(false);
    setPreviewLoading(true);
    try {
      const { url } = await api<{ url: string }>(`/api/org/members/${userId}/preview-link`, {
        method: "POST",
        body: { locale },
      });
      setPreviewUrl(url);
    } catch (e) {
      toast.error((e as Error).message || tOrg("previewFailed"));
      setPreviewFor(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCopyPreview() {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
      setPreviewCopied(true);
      toast.success(tOrg("previewCopied"));
    } catch {
      /* clipboard blocked — the input stays selectable as a fallback */
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
            <div className="mb-4 space-y-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={noEmail} onChange={(e) => { setNoEmail(e.target.checked); setInviteEmail(""); setInviteName(""); }} />
                {tOrg("noEmailToggle")}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Input
                  value={noEmail ? inviteName : inviteEmail}
                  onChange={(e) => (noEmail ? setInviteName(e.target.value) : setInviteEmail(e.target.value))}
                  placeholder={noEmail ? tOrg("employeeName") : tOrg("emailToInvite")}
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
                  {noEmail ? (
                    <Button onClick={handleAddPlaceholder} disabled={inviting || !inviteName.trim()} className="gap-2 shrink-0">
                      {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                      {tOrg("addEmployee")}
                    </Button>
                  ) : (
                    <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} className="gap-2 shrink-0">
                      {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                      {tOrg("invite")}
                    </Button>
                  )}
                </div>
              </div>

              {/* Project-only ("lean") worker toggle — members only. When on,
                  the worker gets smrtTask (tasks assigned to them) + a read-only
                  plan view, and skips the whole source-connection + scan flow. */}
              {inviteRole === "member" && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={inviteProjectOnly}
                    onChange={(e) => setInviteProjectOnly(e.target.checked)}
                  />
                  <span>
                    {tOrg("projectOnlyToggle")}
                    <span className="block text-xs text-muted-foreground">{tOrg("projectOnlyHint")}</span>
                  </span>
                </label>
              )}

              {/* Per-user app selection (members only; owners/admins see every
                  app). Hidden for a project-only worker — their app bundle is fixed. */}
              {inviteRole === "member" && !inviteProjectOnly && orgApps.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">{tOrg("selectApps")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {orgApps.map((a) => {
                      const on = inviteApps.includes(a.slug);
                      return (
                        <button
                          key={a.slug}
                          type="button"
                          onClick={() => toggleInviteApp(a.slug)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            on
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
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
                const unrestricted = m.role === "owner" || m.role === "admin";
                return (
                  <div key={m.user_id} className="rounded-lg border p-2.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`shrink-0 rounded-full p-1.5 ${colorClass}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm font-medium truncate">{m.email || personLabel(m)}</span>
                          {m.is_placeholder && (
                            <Badge variant="outline" className="shrink-0 text-[9px]">{tOrg("noEmailBadge")}</Badge>
                          )}
                          {!unrestricted && m.access_level === "lite" && (
                            <Badge variant="secondary" className="shrink-0 text-[9px]">{tOrg("projectOnlyBadge")}</Badge>
                          )}
                          {m.is_developer && (
                            <Badge variant="outline" className="shrink-0 text-[9px] gap-0.5">
                              <Code2 className="h-2.5 w-2.5" />{tOrg("developerBadge")}
                            </Badge>
                          )}
                        </div>
                        {m.is_placeholder && canManage && (
                          <input
                            type="email"
                            placeholder={tOrg("setEmailPlaceholder")}
                            dir="auto"
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) => { if (e.target.value.trim()) { handleSetEmail(m.user_id, e.target.value); e.target.value = ""; } }}
                            className="mt-1 h-6 w-44 rounded border bg-background px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        )}
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
                          {m.name && <span className="truncate max-w-[100px]">{m.name}</span>}
                          {canManage ? (
                            <input
                              defaultValue={m.display_name ?? ""}
                              placeholder={personLabel(m)}
                              dir="rtl"
                              title={tOrg("displayName")}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              onBlur={(e) => { if ((e.target.value.trim() || null) !== (m.display_name ?? null)) handleSaveDisplayName(m.user_id, e.target.value); }}
                              className="h-6 w-24 shrink-0 rounded border bg-background px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          ) : (
                            <span className="truncate font-medium text-foreground/80">{personLabel(m)}</span>
                          )}
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
                      {/* Developer axis (§5.2): owner-only toggle. Full feature
                          visibility, but hard-excluded from user management, key
                          exposure and impersonation (backend enforces). Not on self. */}
                      {isOwner && m.user_id !== myUserId && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={`shrink-0 h-8 w-8 ${m.is_developer ? "text-primary bg-accent" : "text-muted-foreground"}`}
                          title={m.is_developer ? tOrg("developerOn") : tOrg("developerToggle")}
                          onClick={() => handleToggleDeveloper(m.user_id, !m.is_developer)}
                        >
                          <Code2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {/* Preview-as: regular members only. Never for owner/admin —
                          minting a session as them would be privilege escalation
                          (the backend enforces this too). */}
                      {canManage && !unrestricted && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="shrink-0 h-8 w-8"
                          title={tOrg("previewAs")}
                          disabled={previewLoading && previewFor === m.user_id}
                          onClick={() => handlePreview(m.user_id)}
                        >
                          {previewLoading && previewFor === m.user_id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <LogIn className="h-3.5 w-3.5" />}
                        </Button>
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

                    {/* Preview-as-employee link (one-time, open in incognito) */}
                    {canManage && previewFor === m.user_id && previewUrl && (
                      <div className="mt-2 rounded-md border bg-muted/40 p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium flex items-center gap-1">
                            <LogIn className="h-3 w-3" />
                            {tOrg("previewTitle")}
                          </span>
                          <button
                            type="button"
                            title={tOrg("previewClose")}
                            onClick={() => { setPreviewFor(null); setPreviewUrl(null); }}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{tOrg("previewInstructions")}</p>
                        <div className="flex items-center gap-1.5">
                          <input
                            readOnly
                            value={previewUrl}
                            dir="ltr"
                            onFocus={(e) => e.currentTarget.select()}
                            className="flex-1 min-w-0 rounded border bg-background px-1.5 py-1 text-[11px] font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 h-7 gap-1 text-[11px]"
                            onClick={handleCopyPreview}
                          >
                            <Copy className="h-3 w-3" />
                            {previewCopied ? tOrg("previewCopied") : tOrg("previewCopy")}
                          </Button>
                        </div>
                        <p className="text-[10px] text-muted-foreground">{tOrg("previewExpires")}</p>
                      </div>
                    )}

                    {/* Per-user app access (managers only) */}
                    {canManage && (
                      <div className="mt-2 ps-9 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-muted-foreground me-1">{tOrg("appsLabel")}:</span>
                        {unrestricted ? (
                          <span className="text-[11px] text-muted-foreground">{tOrg("allApps")}</span>
                        ) : orgApps.length === 0 ? (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        ) : (
                          <>
                            {orgApps.map((a) => {
                              const on = m.app_slugs.includes(a.slug);
                              return (
                                <button
                                  key={a.slug}
                                  type="button"
                                  disabled={editingAppsFor === m.user_id}
                                  onClick={() => handleToggleMemberApp(m, a.slug)}
                                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                                    on
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-background text-muted-foreground hover:bg-muted"
                                  }`}
                                >
                                  {a.name}
                                </button>
                              );
                            })}
                            {editingAppsFor === m.user_id && <Loader2 className="h-3 w-3 animate-spin" />}
                          </>
                        )}
                      </div>
                    )}

                    {/* Project-only (lean) toggle — members only. */}
                    {canManage && !unrestricted && (
                      <label className="mt-1.5 ps-9 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          disabled={editingAppsFor === m.user_id}
                          checked={m.access_level === "lite"}
                          onChange={() => handleToggleProjectOnly(m)}
                        />
                        {tOrg("projectOnlyToggle")}
                      </label>
                    )}
                  </div>
                );
              })}

              {/* Pending invites */}
              {canManage && invites.length > 0 && (
                <div className="pt-2 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tOrg("pendingInvites")} ({invites.length})
                  </div>
                  {invites.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-2 rounded-lg border border-dashed p-2.5 min-w-0">
                      <div className="shrink-0 rounded-full p-1.5 bg-muted text-muted-foreground">
                        <Mail className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{inv.email}</div>
                        <div className="flex items-center gap-1 flex-wrap mt-0.5">
                          <Badge variant="secondary" className="text-[10px]">{tOrg("invitePending")}</Badge>
                          {inv.app_slugs.map((s) => (
                            <Badge key={s} variant="outline" className="text-[10px]">{appName(s)}</Badge>
                          ))}
                        </div>
                      </div>
                      <Badge variant="outline" className="text-[10px] uppercase shrink-0">{inv.role}</Badge>
                      <Button
                        size="icon" variant="ghost" className="shrink-0 h-8 w-8"
                        title={tOrg("resend")} onClick={() => handleResendInvite(inv.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        className="shrink-0 h-8 w-8 text-destructive hover:bg-destructive/10"
                        title={tOrg("revoke")} onClick={() => handleRevokeInvite(inv.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
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
