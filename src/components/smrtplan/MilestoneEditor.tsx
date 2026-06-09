"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Plan, PlanMilestone } from "@/types/plan";

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
}
const memberName = (m: Member) => personLabel(m);

const fieldCls =
  "rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const EMPTY_DRAFT = { milestone_date: "", label_he: "", color: "#534AB7", plan_id: "", constrains_user_id: "" };

export function MilestoneEditor({
  milestones,
  plans,
  locale,
  open,
  onClose,
  onChanged,
}: {
  milestones: PlanMilestone[];
  plans: Plan[];
  locale: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const te = useTranslations("smrtPlan.edit");
  const [members, setMembers] = useState<Member[]>([]);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ ...EMPTY_DRAFT });

  useEffect(() => {
    if (!open) return;
    api<{ members: Member[] }>("/api/org/members")
      .then((r) => setMembers(r.members ?? []))
      .catch(() => setMembers([]));
  }, [open]);

  function startEdit(m: PlanMilestone) {
    setEditingId(m.id);
    setEdit({
      milestone_date: m.milestone_date,
      label_he: m.label_he,
      color: m.color || "#534AB7",
      plan_id: m.plan_id || "",
      constrains_user_id: m.constrains_user_id || "",
    });
  }

  async function saveEdit(id: string) {
    if (!edit.milestone_date || !edit.label_he.trim()) return;
    setBusy(true);
    try {
      await api(`/api/plan-milestones/${id}`, {
        method: "PATCH",
        body: {
          milestone_date: edit.milestone_date,
          label_he: edit.label_he.trim(),
          color: edit.color,
          plan_id: edit.plan_id || null,
          constrains_user_id: edit.constrains_user_id || null,
        },
      });
      setEditingId(null);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const planName = (id: string | null) => {
    if (!id) return te("mGlobal");
    const p = plans.find((x) => x.id === id);
    return p ? (locale === "en" ? p.title_en || p.title_he : p.title_he) : id;
  };

  async function add() {
    if (!draft.milestone_date || !draft.label_he.trim()) return;
    setBusy(true);
    try {
      await api("/api/plans/milestones", {
        method: "POST",
        body: {
          milestone_date: draft.milestone_date,
          label_he: draft.label_he.trim(),
          color: draft.color,
          plan_id: draft.plan_id || null,
          constrains_user_id: draft.constrains_user_id || null,
        },
      });
      setDraft({ ...EMPTY_DRAFT });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api(`/api/plan-milestones/${id}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{te("editMilestones")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5">
          {milestones.map((m) =>
            editingId === m.id ? (
              <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 px-2 py-1.5">
                <input type="color" className="h-8 w-9 cursor-pointer rounded-md border border-input bg-background"
                  value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
                <input type="date" className={fieldCls} value={edit.milestone_date}
                  onChange={(e) => setEdit({ ...edit, milestone_date: e.target.value })} />
                <Input value={edit.label_he} onChange={(e) => setEdit({ ...edit, label_he: e.target.value })}
                  className="h-8 flex-1" dir="rtl" />
                <select className={fieldCls} value={edit.plan_id}
                  onChange={(e) => setEdit({ ...edit, plan_id: e.target.value })}>
                  <option value="">{te("mGlobal")}</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>{locale === "en" ? p.title_en || p.title_he : p.title_he}</option>
                  ))}
                </select>
                <select className={fieldCls} value={edit.constrains_user_id}
                  onChange={(e) => setEdit({ ...edit, constrains_user_id: e.target.value })} title={te("capsWorker")}>
                  <option value="">{te("capsWorker")}</option>
                  {members.map((mm) => (
                    <option key={mm.user_id} value={mm.user_id}>{memberName(mm)}</option>
                  ))}
                </select>
                <button onClick={() => saveEdit(m.id)} disabled={busy}
                  className="rounded p-1 text-status-ok hover:bg-status-ok/10"><Check className="h-4 w-4" /></button>
                <button onClick={() => setEditingId(null)} disabled={busy}
                  className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
              </div>
            ) : (
              <div key={m.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px]">
                <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ background: m.color || "#534AB7" }} />
                <span className="w-16 flex-shrink-0 tabular-nums text-muted-foreground">{m.milestone_date}</span>
                <span className="flex-1 truncate">{locale === "en" ? m.label_en || m.label_he : m.label_he}</span>
                <span className="flex-shrink-0 text-[11px] text-muted-foreground">{planName(m.plan_id)}</span>
                <button onClick={() => startEdit(m)} disabled={busy}
                  className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => remove(m.id)} disabled={busy}
                  className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-status-late/10 hover:text-status-late">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ),
          )}
        </div>

        {/* add row */}
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-2 rounded-lg border bg-secondary/40 p-2">
          <input type="date" className={fieldCls} value={draft.milestone_date}
            onChange={(e) => setDraft({ ...draft, milestone_date: e.target.value })} />
          <Input placeholder={te("mLabel")} value={draft.label_he}
            onChange={(e) => setDraft({ ...draft, label_he: e.target.value })} className="h-9" dir="rtl" />
          <input type="color" className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background"
            value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          <div className="flex flex-wrap gap-2">
            <select className={`${fieldCls} flex-1`} value={draft.plan_id}
              onChange={(e) => setDraft({ ...draft, plan_id: e.target.value })}>
              <option value="">{te("mGlobal")}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{locale === "en" ? p.title_en || p.title_he : p.title_he}</option>
              ))}
            </select>
            <select className={`${fieldCls} flex-1`} value={draft.constrains_user_id}
              onChange={(e) => setDraft({ ...draft, constrains_user_id: e.target.value })} title={te("capsWorker")}>
              <option value="">{te("capsWorker")}</option>
              {members.map((mm) => (
                <option key={mm.user_id} value={mm.user_id}>{memberName(mm)}</option>
              ))}
            </select>
            <Button onClick={add} disabled={busy || !draft.milestone_date || !draft.label_he.trim()} className="gap-1">
              <Plus className="h-4 w-4" /> {te("addMilestone")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
