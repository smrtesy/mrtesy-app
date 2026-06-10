"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Estimate {
  id: string;
  name: string;
  description: string | null;
  hours: number;
}

const numCls =
  "w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The org's task-type → hours catalog — rendered inside the plan-settings
 *  hub. Loads on mount. */
export function EstimatesSection() {
  const t = useTranslations("smrtPlan.estimates");
  const [items, setItems] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", description: "", hours: 0 });
  const [draft, setDraft] = useState({ name: "", description: "", hours: "" });

  async function refetch() {
    const { estimates } = await api<{ estimates: Estimate[] }>("/api/plan/estimates");
    setItems(estimates ?? []);
  }

  useEffect(() => {
    refetch()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  }, []);

  async function add() {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await api("/api/plan/estimates", {
        method: "POST",
        body: { name: draft.name.trim(), description: draft.description.trim() || null, hours: Number(draft.hours) || 0 },
      });
      setDraft({ name: "", description: "", hours: "" });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    if (!edit.name.trim()) return;
    setBusy(true);
    try {
      await api(`/api/plan/estimates/${id}`, {
        method: "PATCH",
        body: { name: edit.name.trim(), description: edit.description.trim() || null, hours: Number(edit.hours) || 0 },
      });
      setEditingId(null);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api(`/api/plan/estimates/${id}`, { method: "DELETE" });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground">{t("hint")}</p>

      {loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-start text-[11px] font-bold text-muted-foreground">
                <th className="border-b p-1.5 text-start">{t("name")}</th>
                <th className="border-b p-1.5 text-start">{t("description")}</th>
                <th className="border-b p-1.5 text-end">{t("hours")}</th>
                <th className="border-b p-1.5" />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center italic text-muted-foreground">{t("empty")}</td></tr>
              )}
              {items.map((e) =>
                editingId === e.id ? (
                  <tr key={e.id} className="border-b">
                    <td className="p-1"><Input value={edit.name} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} className="h-8" dir="rtl" /></td>
                    <td className="p-1"><Input value={edit.description} onChange={(ev) => setEdit({ ...edit, description: ev.target.value })} className="h-8" dir="rtl" /></td>
                    <td className="p-1"><input type="number" min={0} step={0.5} value={edit.hours} onChange={(ev) => setEdit({ ...edit, hours: Number(ev.target.value) })} className={numCls} /></td>
                    <td className="whitespace-nowrap p-1">
                      <button onClick={() => saveEdit(e.id)} disabled={busy} className="rounded p-1 text-status-ok hover:bg-status-ok/10"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setEditingId(null)} disabled={busy} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
                    </td>
                  </tr>
                ) : (
                  <tr key={e.id} className="border-b">
                    <td className="p-1.5 font-medium">{e.name}</td>
                    <td className="p-1.5 text-muted-foreground">{e.description}</td>
                    <td className="p-1.5 text-end tabular-nums">{e.hours}</td>
                    <td className="whitespace-nowrap p-1.5">
                      <button onClick={() => { setEditingId(e.id); setEdit({ name: e.name, description: e.description ?? "", hours: e.hours }); }}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => remove(e.id)} disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-status-late/10 hover:text-status-late"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* add row */}
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/40 p-2">
        <Input placeholder={t("name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-9 flex-1" dir="rtl" />
        <Input placeholder={t("description")} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="h-9 flex-1" dir="rtl" />
        <input type="number" min={0} step={0.5} placeholder={t("hours")} value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} className={numCls} />
        <Button onClick={add} disabled={busy || !draft.name.trim()} className="gap-1"><Plus className="h-4 w-4" /> {t("add")}</Button>
      </div>
    </div>
  );
}
