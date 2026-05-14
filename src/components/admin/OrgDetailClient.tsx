"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, ArrowLeft, Trash2, Crown, Shield, User, Power, PowerOff, Loader2 } from "lucide-react";
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

const ROLE_ICONS = { owner: Crown, admin: Shield, member: User };

export function OrgDetailClient({ locale, orgId }: { locale: string; orgId: string }) {
  const router = useRouter();
  const [data, setData] = useState<AdminOrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchOrg = useCallback(async () => {
    try {
      const res = await api<AdminOrgDetail>(`/api/admin/orgs/${orgId}`, { noOrg: true });
      setData(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast.error("Organization not found");
        router.push(`/${locale}/admin/orgs`);
      } else if (!(e instanceof ApiError && e.status === 401)) {
        toast.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, locale, router]);

  useEffect(() => { fetchOrg(); }, [fetchOrg]);

  async function toggleApp(slug: string, currentlyEnabled: boolean) {
    setToggling(slug);
    try {
      if (currentlyEnabled) {
        await api(`/api/admin/orgs/${orgId}/apps/${slug}`, { method: "DELETE", noOrg: true });
        toast.success(`${slug} disabled`);
      } else {
        await api(`/api/admin/orgs/${orgId}/apps/${slug}`, { method: "POST", noOrg: true });
        toast.success(`${slug} enabled`);
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
    if (!confirm("Remove this member from the org?")) return;
    try {
      await api(`/api/admin/orgs/${orgId}/members/${userId}`, { method: "DELETE", noOrg: true });
      toast.success("Member removed");
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
      toast.success("Role updated");
      fetchOrg();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDeleteOrg() {
    if (!confirm(`PERMANENTLY delete "${data?.org.name}" and ALL its tasks/projects/members? This cannot be undone.`)) return;
    if (!confirm("Are you absolutely sure? Type-check: this org has " + (data?.stats.task_count ?? 0) + " tasks and " + (data?.stats.project_count ?? 0) + " projects.")) return;
    try {
      await api(`/api/admin/orgs/${orgId}`, { method: "DELETE", noOrg: true });
      toast.success("Organization deleted");
      router.push(`/${locale}/admin/orgs`);
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

  return (
    <div className="space-y-4">
      <Link
        href={`/${locale}/admin/orgs`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to orgs
      </Link>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2 min-w-0">
          <Building2 className="h-6 w-6 shrink-0" />
          <span className="truncate" dir="auto">{data.org.name}</span>
          <span className="text-sm font-mono text-muted-foreground">{data.org.slug}</span>
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleOpenAsThisOrg}>
            Open as this org
          </Button>
          <Button variant="outline" size="sm" className="text-red-500 gap-1" onClick={handleDeleteOrg}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete org
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.members.length}</div>
          <div className="text-xs text-muted-foreground">Members</div>
        </CardContent></Card>
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.stats.task_count}</div>
          <div className="text-xs text-muted-foreground">Tasks</div>
        </CardContent></Card>
        <Card><CardContent className="py-3 text-center">
          <div className="text-2xl font-bold">{data.stats.project_count}</div>
          <div className="text-xs text-muted-foreground">Projects</div>
        </CardContent></Card>
      </div>

      {/* Apps */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Apps</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.apps.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No apps in the registry yet.</p>
          ) : data.apps.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-lg border p-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  {a.name}
                  <span className="text-[10px] font-mono text-muted-foreground">{a.slug}</span>
                </div>
                {a.description && <div className="text-xs text-muted-foreground truncate">{a.description}</div>}
                {a.enabled && a.enabled_at && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    enabled {new Date(a.enabled_at).toLocaleString()}
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
                  <><Power className="h-3.5 w-3.5" /> Enabled</>
                ) : (
                  <><PowerOff className="h-3.5 w-3.5" /> Disabled</>
                )}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Members ({data.members.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.members.map((m) => {
            const Icon = ROLE_ICONS[m.role];
            return (
              <div key={m.user_id} className="flex items-center gap-3 rounded-lg border p-2.5">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{m.name || m.email || m.user_id.slice(0, 8)}</div>
                  {m.email && m.name && <div className="text-xs text-muted-foreground truncate">{m.email}</div>}
                </div>
                <select
                  value={m.role}
                  onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                  className="rounded border px-2 py-1 text-xs bg-background"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
                <Badge variant="outline" className="text-[10px]">{m.role}</Badge>
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
