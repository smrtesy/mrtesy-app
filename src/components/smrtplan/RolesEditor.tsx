"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useOrgMembers, type OrgMember } from "@/hooks/useOrgMembers";

interface RoleMember {
  id: string;
  user_id: string;
  is_primary: boolean;
}
interface Role {
  id: string;
  name_he: string;
  name_en: string | null;
  color: string | null;
  members: RoleMember[];
}
type Member = OrgMember;

const COLORS = ["#534AB7", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#6B7280"];

function memberName(m: Member | undefined, userId: string): string {
  if (!m) return userId.slice(0, 6);
  return personLabel(m);
}

/** Org roles + staffing — rendered inside the plan-settings hub. Loads on mount. */
export function RolesSection() {
  const t = useTranslations("smrtPlan.roles");
  const [roles, setRoles] = useState<Role[]>([]);
  const { members, loading: membersLoading } = useOrgMembers();
  const [rolesLoading, setRolesLoading] = useState(true);
  const loading = rolesLoading || membersLoading;
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState<string>(COLORS[0]);

  async function refetch() {
    const { roles } = await api<{ roles: Role[] }>("/api/plan/roles");
    setRoles(roles ?? []);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { roles } = await api<{ roles: Role[] }>("/api/plan/roles");
        if (alive) setRoles(roles ?? []);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setRolesLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const memberById = new Map(members.map((m) => [m.user_id, m]));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  function addRole() {
    if (!draftName.trim()) return;
    run(async () => {
      await api("/api/plan/roles", { method: "POST", body: { name_he: draftName.trim(), color: draftColor } });
      setDraftName("");
      setDraftColor(COLORS[0]);
    });
  }

  function saveEdit(id: string) {
    if (!editName.trim()) return;
    run(async () => {
      await api(`/api/plan/roles/${id}`, { method: "PATCH", body: { name_he: editName.trim() } });
      setEditingId(null);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground">{t("hint")}</p>

      {loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="space-y-2">
          {roles.length === 0 && (
            <p className="p-4 text-center italic text-muted-foreground">{t("empty")}</p>
          )}
          {roles.map((role) => {
            const inRole = new Set(role.members.map((m) => m.user_id));
            const available = members.filter((m) => !inRole.has(m.user_id));
            return (
              <div key={role.id} className="rounded-lg border bg-card p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: role.color || "#6B7280" }} />
                  {editingId === role.id ? (
                    <>
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8 flex-1" dir="rtl" />
                      <button onClick={() => saveEdit(role.id)} disabled={busy} className="rounded p-1 text-status-ok hover:bg-status-ok/10"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setEditingId(null)} disabled={busy} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-[13.5px] font-bold">{role.name_he}</span>
                      <button onClick={() => { setEditingId(role.id); setEditName(role.name_he); }}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => run(() => api(`/api/plan/roles/${role.id}`, { method: "DELETE" }))} disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-status-late/10 hover:text-status-late"><Trash2 className="h-3.5 w-3.5" /></button>
                    </>
                  )}
                </div>

                {/* members */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {role.members.length === 0 && (
                    <span className="text-[11.5px] italic text-muted-foreground">{t("noMembers")}</span>
                  )}
                  {role.members.map((rm) => (
                    <span key={rm.id} className={cn(
                      "inline-flex items-center gap-1 rounded-full border py-0.5 ps-2 pe-1 text-[11.5px]",
                      rm.is_primary ? "border-primary/50 bg-primary/10 font-semibold" : "bg-secondary/50",
                    )}>
                      <button
                        onClick={() => run(() => api(`/api/plan/role-members/${rm.id}`, { method: "PATCH", body: { is_primary: !rm.is_primary } }))}
                        disabled={busy}
                        title={t("makePrimary")}
                        className={cn("rounded p-0.5 hover:bg-primary/20", rm.is_primary ? "text-primary" : "text-muted-foreground")}
                      >
                        <Star className={cn("h-3 w-3", rm.is_primary && "fill-current")} />
                      </button>
                      {memberName(memberById.get(rm.user_id), rm.user_id)}
                      {rm.is_primary && <span className="text-[9px] text-primary">· {t("primary")}</span>}
                      <button onClick={() => run(() => api(`/api/plan/role-members/${rm.id}`, { method: "DELETE" }))} disabled={busy}
                        className="rounded p-0.5 text-muted-foreground hover:bg-status-late/10 hover:text-status-late"><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                  {available.length > 0 && (
                    <select
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const uid = e.target.value;
                        if (!uid) return;
                        const makePrimary = role.members.length === 0; // first member becomes the default
                        run(() => api(`/api/plan/roles/${role.id}/members`, { method: "POST", body: { user_id: uid, is_primary: makePrimary } }));
                      }}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[11.5px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">+ {t("addMember")}</option>
                      {available.map((m) => (
                        <option key={m.user_id} value={m.user_id}>{memberName(m, m.user_id)}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* add role */}
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
        <Input placeholder={t("name")} value={draftName} onChange={(e) => setDraftName(e.target.value)} className="h-9 flex-1" dir="rtl" />
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setDraftColor(c)}
              title={t("color")}
              className={cn("h-5 w-5 rounded-full border-2", draftColor === c ? "border-foreground" : "border-transparent")}
              style={{ background: c }}
            />
          ))}
        </div>
        <Button onClick={addRole} disabled={busy || !draftName.trim()} className="gap-1"><Plus className="h-4 w-4" /> {t("add")}</Button>
      </div>
    </div>
  );
}
