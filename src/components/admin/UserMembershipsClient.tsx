"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2, Crown, Shield, User, Layers, Trash2, Loader2, ExternalLink, Plus,
} from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

interface Membership {
  role: "owner" | "admin" | "member";
  joined_at: string;
  org: { id: string; slug: string; name: string; name_he: string | null; created_at: string };
  apps: Array<{ slug: string; name: string; enabled_at: string }>;
}

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  member_count: number;
  apps_enabled: string[];
}

const ROLE_ICONS = { owner: Crown, admin: Shield, member: User };

export function UserMembershipsClient({ userId, locale }: { userId: string; locale: string }) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [effectiveApps, setEffectiveApps] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [allOrgs, setAllOrgs] = useState<OrgRow[]>([]);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const fetchMemberships = useCallback(async () => {
    setLoading(true);
    try {
      const { memberships, effective_apps } = await api<{
        memberships: Membership[];
        effective_apps: string[];
      }>(`/api/admin/users/${userId}/memberships`, { noOrg: true });
      setMemberships(memberships ?? []);
      setEffectiveApps(effective_apps ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Lazy-load all orgs once for the "add to org" picker
  async function loadAllOrgsIfNeeded() {
    if (allOrgs.length > 0) return;
    try {
      const { orgs } = await api<{ orgs: OrgRow[] }>("/api/admin/orgs", { noOrg: true });
      setAllOrgs(orgs ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  useEffect(() => { fetchMemberships(); }, [fetchMemberships]);

  async function handleAddToOrg(orgId: string, role: "owner" | "admin" | "member") {
    setAdding(orgId);
    try {
      await api(`/api/admin/orgs/${orgId}/members`, {
        method: "POST",
        body: { user_id: userId, role },
        noOrg: true,
      });
      toast.success("Added to org");
      setSearch("");
      fetchMemberships();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(null);
    }
  }

  async function handleRemoveFromOrg(orgId: string, orgName: string) {
    if (!confirm(`Remove this user from "${orgName}"?`)) return;
    setRemoving(orgId);
    try {
      await api(`/api/admin/orgs/${orgId}/members/${userId}`, { method: "DELETE", noOrg: true });
      toast.success("Removed");
      fetchMemberships();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  async function handleChangeRole(orgId: string, role: string) {
    try {
      await api(`/api/admin/orgs/${orgId}/members/${userId}`, {
        method: "PATCH",
        body: { role },
        noOrg: true,
      });
      toast.success("Role updated");
      fetchMemberships();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const memberOrgIds = new Set(memberships.map((m) => m.org.id));
  const searchLower = search.trim().toLowerCase();
  const candidates = searchLower.length >= 1
    ? allOrgs
        .filter((o) => !memberOrgIds.has(o.id))
        .filter((o) =>
          o.name.toLowerCase().includes(searchLower)
          || o.slug.toLowerCase().includes(searchLower))
        .slice(0, 8)
    : [];

  return (
    <div className="space-y-4">
      {/* Effective app access (header card) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Effective App Access
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-6 w-48" />
          ) : effectiveApps.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No apps — user has no org memberships or no orgs have apps enabled.</p>
          ) : (
            <div className="flex gap-1.5 flex-wrap">
              {effectiveApps.map((slug) => (
                <Badge key={slug} variant="default" className="text-xs">{slug}</Badge>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Apps are granted at the organization level. To change a user&apos;s access, toggle the app on/off for one of their orgs below — or add them to an org that already has the app.
          </p>
        </CardContent>
      </Card>

      {/* Memberships */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Organizations ({memberships.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
          ) : memberships.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">User is not a member of any organization.</p>
          ) : memberships.map((m) => {
            const Icon = ROLE_ICONS[m.role];
            return (
              <div key={m.org.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Link
                    href={`/${locale}/admin/orgs/${m.org.id}`}
                    className="font-medium hover:underline flex items-center gap-1"
                    dir="auto"
                  >
                    {m.org.name}
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </Link>
                  <span className="text-[10px] font-mono text-muted-foreground">{m.org.slug}</span>
                  <select
                    value={m.role}
                    onChange={(e) => handleChangeRole(m.org.id, e.target.value)}
                    className="rounded border px-2 py-0.5 text-xs bg-background ms-auto"
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-red-500"
                    disabled={removing === m.org.id}
                    onClick={() => handleRemoveFromOrg(m.org.id, m.org.name)}
                  >
                    {removing === m.org.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap text-xs">
                  <Layers className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">apps:</span>
                  {m.apps.length === 0 ? (
                    <span className="text-muted-foreground italic">none</span>
                  ) : m.apps.map((a) => (
                    <Badge key={a.slug} variant="outline" className="text-[10px]">{a.slug}</Badge>
                  ))}
                  <Link
                    href={`/${locale}/admin/orgs/${m.org.id}`}
                    className="ms-auto text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Manage apps →
                  </Link>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Add to org */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add user to an organization
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={loadAllOrgsIfNeeded}
            placeholder="Search orgs by name or slug…"
          />
          {candidates.length > 0 && (
            <div className="space-y-1 mt-1">
              {candidates.map((o) => (
                <div key={o.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate" dir="auto">{o.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{o.slug}</div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {o.apps_enabled.map((slug) => (
                      <Badge key={slug} variant="outline" className="text-[10px]">{slug}</Badge>
                    ))}
                  </div>
                  <select
                    defaultValue="member"
                    id={`role-${o.id}`}
                    className="rounded border px-2 py-1 text-xs bg-background"
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <Button
                    size="sm"
                    disabled={adding === o.id}
                    onClick={() => {
                      const sel = document.getElementById(`role-${o.id}`) as HTMLSelectElement;
                      const role = (sel?.value ?? "member") as "owner" | "admin" | "member";
                      handleAddToOrg(o.id, role);
                    }}
                  >
                    {adding === o.id && <Loader2 className="h-3 w-3 animate-spin me-1" />}
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
          {searchLower.length >= 1 && allOrgs.length > 0 && candidates.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No matching orgs (or user is already a member).</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
