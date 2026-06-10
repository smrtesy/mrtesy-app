"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { Plan, PlanKind, PlanStage, PlanStatus } from "@/types/plan";

const COLORS = [
  "#534AB7", "#7F77DD", "#185FA5", "#378ADD", "#0F6E56", "#1D9E75",
  "#15805F", "#B86E08", "#D85A30", "#BA7517", "#8A8780",
];

const fieldCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PlanEditDialog({
  plan,
  open,
  onClose,
  onSaved,
}: {
  /** null → create a new plan. */
  plan: Plan | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [members, setMembers] = useState<Array<{ user_id: string; email: string | null; name: string | null; display_name: string | null }>>([]);
  const [form, setForm] = useState({
    title_he: "",
    title_en: "",
    goal: "",
    group_label: "",
    color: COLORS[0],
    kind: "effort" as PlanKind,
    stage: "active" as PlanStage,
    status: "active" as PlanStatus,
    is_capability: false,
    start_date: "",
    end_date: "",
    owner_user_id: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      title_he: plan?.title_he ?? "",
      title_en: plan?.title_en ?? "",
      goal: plan?.goal ?? "",
      group_label: plan?.group_label ?? "",
      color: plan?.color ?? COLORS[0],
      kind: plan?.kind ?? "effort",
      stage: plan?.stage ?? "active",
      status: plan?.status ?? "active",
      is_capability: plan?.is_capability ?? false,
      start_date: plan?.start_date ?? "",
      end_date: plan?.end_date ?? "",
      owner_user_id: plan?.owner_user_id ?? "",
    });
    api<{ members: typeof members }>("/api/org/members")
      .then((r) => setMembers(r.members ?? []))
      .catch(() => setMembers([]));
  }, [open, plan]);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.title_he.trim()) {
      toast.error(te("titleHe"));
      return;
    }
    setSaving(true);
    const body = {
      title_he: form.title_he.trim(),
      title_en: form.title_en.trim() || null,
      goal: form.goal.trim() || null,
      group_label: form.group_label.trim() || null,
      color: form.color,
      kind: form.kind,
      stage: form.stage,
      status: form.status,
      is_capability: form.is_capability,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      owner_user_id: form.owner_user_id || null,
    };
    try {
      if (plan?.id) {
        await api(`/api/plans/${plan.id}`, { method: "PATCH", body });
      } else {
        await api("/api/plans", { method: "POST", body });
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!plan?.id || !confirm(te("confirmDelete"))) return;
    setSaving(true);
    try {
      await api(`/api/plans/${plan.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plan?.id ? te("editPlan") : te("newPlan")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Creating: the kind decides the whole structure, so pick it first —
              as self-explanatory cards, not a bare dropdown. */}
          {!plan?.id && (
            <Field label={te("kind")}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["effort", "stream", "roster"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set("kind", k)}
                    className={cn(
                      "rounded-lg border p-2.5 text-start transition-colors",
                      form.kind === k
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-input bg-background hover:bg-accent",
                    )}
                  >
                    <span className="block text-[13px] font-bold">{t(`kind.${k}`)}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                      {t(`kindCards.${k}.desc`)}
                    </span>
                    <span className="mt-1 block text-[10.5px] italic text-muted-foreground/80">
                      {t(`kindCards.${k}.example`)}
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label={te("titleHe")}>
            <Input value={form.title_he} onChange={(e) => set("title_he", e.target.value)} dir="rtl" />
          </Field>
          <Field label={te("titleEn")}>
            <Input value={form.title_en} onChange={(e) => set("title_en", e.target.value)} dir="ltr" />
          </Field>
          <Field label={te("goal")}>
            <Textarea value={form.goal} onChange={(e) => set("goal", e.target.value)} rows={2} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("group")}>
              <Input value={form.group_label} onChange={(e) => set("group_label", e.target.value)} />
            </Field>
            {plan?.id ? (
              <Field label={te("kind")}>
                <select className={fieldCls} value={form.kind} onChange={(e) => set("kind", e.target.value as PlanKind)}>
                  <option value="effort">{t("kind.effort")}</option>
                  <option value="stream">{t("kind.stream")}</option>
                  <option value="roster">{t("kind.roster")}</option>
                </select>
              </Field>
            ) : (
              <span />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("start")}>
              <input type="date" className={fieldCls} value={form.start_date}
                onChange={(e) => set("start_date", e.target.value)} />
            </Field>
            <Field label={te("end")}>
              <input type="date" className={fieldCls} value={form.end_date}
                onChange={(e) => set("end_date", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("stageField")}>
              <select className={fieldCls} value={form.stage} onChange={(e) => set("stage", e.target.value as PlanStage)}>
                <option value="idea">{t("repository.stage.idea")}</option>
                <option value="shaping">{t("repository.stage.shaping")}</option>
                <option value="active">{t("repository.stage.active")}</option>
              </select>
            </Field>
            <Field label={t("status.label")}>
              <select className={fieldCls} value={form.status} onChange={(e) => set("status", e.target.value as PlanStatus)}>
                <option value="draft">{t("status.draft")}</option>
                <option value="active">{t("status.active")}</option>
                <option value="done">{t("status.done")}</option>
                <option value="archived">{t("status.archived")}</option>
              </select>
            </Field>
          </div>

          <Field label={te("owner")}>
            <select className={fieldCls} value={form.owner_user_id} onChange={(e) => set("owner_user_id", e.target.value)}>
              <option value="">{te("unassigned")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>{personLabel(m)}</option>
              ))}
            </select>
          </Field>

          <Field label={te("color")}>
            <div className="flex flex-wrap items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("color", c)}
                  className={cn(
                    "h-6 w-6 rounded-full border-2",
                    form.color === c ? "border-foreground" : "border-transparent",
                  )}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
              <Input value={form.color} onChange={(e) => set("color", e.target.value)} className="h-7 w-24" dir="ltr" />
            </div>
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_capability} onChange={(e) => set("is_capability", e.target.checked)} className="h-4 w-4" />
            {t("capability.field")}
          </label>
        </div>

        <DialogFooter className="mt-2 flex items-center justify-between gap-2 sm:justify-between">
          {plan?.id ? (
            <Button variant="ghost" onClick={remove} disabled={saving}
              className="text-status-late hover:bg-status-late/10 hover:text-status-late">
              <Trash2 className="h-4 w-4" /> {te("delete")}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>{te("cancel")}</Button>
            <Button onClick={save} disabled={saving}>{te("save")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
