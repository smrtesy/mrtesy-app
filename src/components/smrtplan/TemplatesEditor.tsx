"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface TItem {
  id: string;
  template_id: string;
  title_he: string;
  title_en: string | null;
  role_id: string | null;
  default_duration_days: number | null;
  sequence: number;
}
interface TDep {
  id: string;
  template_id: string;
  from_item_id: string;
  to_item_id: string;
  lag_days: number;
}
interface Template {
  id: string;
  name_he: string;
  name_en: string | null;
  description: string | null;
  items: TItem[];
  deps: TDep[];
}
interface Role {
  id: string;
  name_he: string;
}

const fieldCls =
  "rounded-md border border-input bg-background px-2 py-1 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TemplatesEditor({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const t = useTranslations("smrtPlan.templates");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState("");

  async function refetch() {
    const { templates } = await api<{ templates: Template[] }>("/api/plan/templates");
    setTemplates(templates ?? []);
    onChanged?.();
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const [{ templates }, { roles }] = await Promise.all([
          api<{ templates: Template[] }>("/api/plan/templates"),
          api<{ roles: Role[] }>("/api/plan/roles"),
        ]);
        setTemplates(templates ?? []);
        setRoles(roles ?? []);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const roleName = (id: string | null) => (id ? roles.find((r) => r.id === id)?.name_he ?? "" : "");

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

  function addTemplate() {
    if (!draftName.trim()) return;
    run(async () => {
      await api("/api/plan/templates", { method: "POST", body: { name_he: draftName.trim() } });
      setDraftName("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">{t("hint")}</p>

        {loading ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
        ) : (
          <div className="space-y-3">
            {templates.length === 0 && <p className="p-4 text-center italic text-muted-foreground">{t("empty")}</p>}
            {templates.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} roles={roles} roleName={roleName} busy={busy} run={run} t={t} />
            ))}
          </div>
        )}

        {/* add template */}
        <div className="mt-2 flex items-center gap-2 rounded-lg border bg-secondary/40 p-2">
          <Input placeholder={t("name")} value={draftName} onChange={(e) => setDraftName(e.target.value)} className="h-9 flex-1" dir="rtl" />
          <Button onClick={addTemplate} disabled={busy || !draftName.trim()} className="gap-1">
            <Plus className="h-4 w-4" /> {t("add")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({
  tpl,
  roles,
  roleName,
  busy,
  run,
  t,
}: {
  tpl: Template;
  roles: Role[];
  roleName: (id: string | null) => string;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [title, setTitle] = useState("");
  const [roleId, setRoleId] = useState("");
  const [dur, setDur] = useState("");

  function addItem() {
    if (!title.trim()) return;
    run(async () => {
      await api(`/api/plan/templates/${tpl.id}/items`, {
        method: "POST",
        body: { title_he: title.trim(), role_id: roleId || null, default_duration_days: dur ? Number(dur) : null, sequence: tpl.items.length + 1 },
      });
      setTitle("");
      setRoleId("");
      setDur("");
    });
  }

  const itemTitle = (id: string) => tpl.items.find((i) => i.id === id)?.title_he ?? "—";

  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-[13.5px] font-bold">{tpl.name_he}</span>
        <button
          onClick={() => run(() => api(`/api/plan/templates/${tpl.id}`, { method: "DELETE" }))}
          disabled={busy}
          className="rounded p-1 text-muted-foreground hover:bg-status-late/10 hover:text-status-late"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* items */}
      <div className="space-y-1.5">
        {tpl.items.length === 0 && <p className="text-[11.5px] italic text-muted-foreground">{t("noItems")}</p>}
        {tpl.items.map((it) => {
          const needs = tpl.deps.filter((d) => d.from_item_id === it.id);
          const candidates = tpl.items.filter((o) => o.id !== it.id && !needs.some((n) => n.to_item_id === o.id));
          return (
            <div key={it.id} className="rounded-md border bg-secondary/30 p-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[12.5px] font-medium">{it.title_he}</span>
                {it.role_id && (
                  <span className="rounded bg-accent px-1.5 py-px text-[10px] text-accent-foreground">{roleName(it.role_id)}</span>
                )}
                {it.default_duration_days != null && (
                  <span className="rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
                    {it.default_duration_days} {t("daysUnit")}
                  </span>
                )}
                <button
                  onClick={() => run(() => api(`/api/plan/template-items/${it.id}`, { method: "DELETE" }))}
                  disabled={busy}
                  className="rounded p-0.5 text-muted-foreground hover:bg-status-late/10 hover:text-status-late"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              {/* dependencies (this item needs …) */}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {needs.map((d) => (
                  <span key={d.id} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-px text-[10.5px]">
                    {t("needs")}: {itemTitle(d.to_item_id)}
                    <button
                      onClick={() => run(() => api(`/api/plan/template-deps/${d.id}`, { method: "DELETE" }))}
                      disabled={busy}
                      className="rounded text-muted-foreground hover:text-status-late"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {candidates.length > 0 && (
                  <select
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const to = e.target.value;
                      if (!to) return;
                      run(() => api("/api/plan/template-deps", { method: "POST", body: { template_id: tpl.id, from_item_id: it.id, to_item_id: to, lag_days: 0 } }));
                    }}
                    className={`${fieldCls} h-6 py-0 text-[10.5px] text-muted-foreground`}
                  >
                    <option value="">+ {t("dependsOn")}</option>
                    {candidates.map((o) => (
                      <option key={o.id} value={o.id}>{o.title_he}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* add item */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={`${fieldCls} flex-1`} placeholder={t("itemTitle")} value={title} onChange={(e) => setTitle(e.target.value)} dir="rtl" />
        <select className={fieldCls} value={roleId} onChange={(e) => setRoleId(e.target.value)} title={t("role")}>
          <option value="">{t("noRole")}</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name_he}</option>
          ))}
        </select>
        <input type="number" min={0} step={0.5} className={`${fieldCls} w-24`} placeholder={t("daysUnit")} value={dur} onChange={(e) => setDur(e.target.value)} title={t("duration")} />
        <button onClick={addItem} disabled={busy || !title.trim()} className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> {t("addItem")}
        </button>
      </div>
    </div>
  );
}
