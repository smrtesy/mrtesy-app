"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
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
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { Plan, PlanKind, PlanStage, PlanStatus } from "@/types/plan";
import { useOrgMembers } from "@/hooks/useOrgMembers";

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
  const { members } = useOrgMembers();
  const [form, setForm] = useState({
    title_he: "",
    title_en: "",
    goal: "",
    goal_en: "",
    group_label: "",
    group_label_en: "",
    color: COLORS[0],
    kind: "effort" as PlanKind,
    stage: "active" as PlanStage,
    status: "active" as PlanStatus,
    is_capability: false,
    start_date: "",
    end_date: "",
    owner_user_id: "",
    manager_user_id: "",
    cost_approval_threshold_usd: "",
  });
  const [saving, setSaving] = useState(false);
  // Idempotency key for CREATE. A "Failed to fetch" is a transient Railway blip
  // (the request never reached the server, or its response was lost) — the create
  // POST may now be retried safely because it carries this stable token, which the
  // server dedupes on. It stays fixed while the dialog is open (so a manual
  // re-click after a blip reuses it) and is minted fresh each time the dialog
  // opens for a NEW plan, below.
  const createTokenRef = useRef<string | null>(null);
  // Snapshot of the form as it was loaded, so an edit PATCHes only the fields the
  // user actually touched. Sending the whole record would let a dialog left open
  // for hours write back stale values — e.g. re-writing status 'draft' after
  // someone else approved the plan, which re-hides every task from the team.
  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  // Single-performer plan: hand every open task to one person on save, and point
  // the minutes/workdays commitment below at THAT person instead of the editor.
  // Blank = leave per-task assignees alone (a mixed-team plan).
  const [assignAllTo, setAssignAllTo] = useState("");
  // My daily-minutes commitment to this plan (the focus tool, §6). Blank = no
  // commitment; entering a value upserts smrtplan_focus on save. Only meaningful
  // for an existing plan (a new plan has no id to attach the commitment to yet).
  const [dailyMinutes, setDailyMinutes] = useState("");
  // Personal work week for the daily commitment (0=Sun..6=Sat). Default Mon–Fri.
  const DEFAULT_WORKDAYS = useMemo(() => [1, 2, 3, 4, 5], []);
  const [workdays, setWorkdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const locale = useLocale();
  // Short weekday names in the active locale, without any locale ternary.
  const dayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2024-01-07 is a Sunday → index i lands on day-of-week i (0=Sun..6=Sat).
    return [0, 1, 2, 3, 4, 5, 6].map((i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + i))));
  }, [locale]);

  useEffect(() => {
    if (!open) return;
    const loaded = {
      title_he: plan?.title_he ?? "",
      title_en: plan?.title_en ?? "",
      goal: plan?.goal ?? "",
      goal_en: plan?.goal_en ?? "",
      group_label: plan?.group_label ?? "",
      group_label_en: plan?.group_label_en ?? "",
      color: plan?.color ?? COLORS[0],
      kind: plan?.kind ?? "effort",
      stage: plan?.stage ?? "active",
      status: plan?.status ?? "active",
      is_capability: plan?.is_capability ?? false,
      start_date: plan?.start_date ?? "",
      end_date: plan?.end_date ?? "",
      owner_user_id: plan?.owner_user_id ?? "",
      manager_user_id: plan?.manager_user_id ?? "",
      cost_approval_threshold_usd:
        plan?.cost_approval_threshold_usd != null ? String(plan.cost_approval_threshold_usd) : "",
    };
    setForm(loaded);
    setInitial(loaded);
    setAssignAllTo("");
    // A fresh idempotency key per opening of the CREATE dialog. Re-clicking "Add"
    // after a transient failure reuses it (no duplicate); a new plan gets a new one.
    if (!plan?.id) createTokenRef.current = crypto.randomUUID();
  }, [open, plan]);

  // Prefill the daily-minutes commitment when editing an existing plan. When a
  // single performer is chosen we read THEIR commitment, so the minutes/workdays
  // shown are the ones actually being edited (and not silently the editor's).
  // Prefill on open only. Switching the performer does NOT clear what was typed —
  // that value is exactly what should be written for the newly chosen person; it
  // is only replaced when that person already has a commitment of their own.
  useEffect(() => {
    if (!open || !plan?.id) return;
    setDailyMinutes("");
    setWorkdays(DEFAULT_WORKDAYS);
  }, [open, plan?.id, DEFAULT_WORKDAYS]);

  useEffect(() => {
    if (!open || !plan?.id) return;
    let alive = true;
    const q = assignAllTo ? `?user_id=${encodeURIComponent(assignAllTo)}` : "";
    api<{ focus: { daily_minutes: number; workdays: number[] | null } | null }>(
      `/api/plan/${plan.id}/focus${q}`,
    )
      .then((d) => {
        if (!alive || !d.focus) return;
        setDailyMinutes(String(d.focus.daily_minutes));
        setWorkdays(d.focus.workdays && d.focus.workdays.length ? d.focus.workdays : DEFAULT_WORKDAYS);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, plan?.id, assignAllTo, DEFAULT_WORKDAYS]);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.title_he.trim()) {
      toast.error(te("titleHe"));
      return;
    }
    // A threshold is money — reject a non-numeric/negative entry rather than
    // silently sending NaN and storing nothing.
    const threshold = form.cost_approval_threshold_usd.trim();
    let thresholdValue: number | null = null;
    if (threshold) {
      const n = Number(threshold);
      if (!Number.isFinite(n) || n < 0) {
        toast.error(te("costThresholdInvalid"));
        return;
      }
      thresholdValue = n;
    }
    setSaving(true);
    const full: Record<string, unknown> = {
      title_he: form.title_he.trim(),
      title_en: form.title_en.trim() || null,
      goal: form.goal.trim() || null,
      goal_en: form.goal_en.trim() || null,
      group_label: form.group_label.trim() || null,
      group_label_en: form.group_label_en.trim() || null,
      color: form.color,
      kind: form.kind,
      stage: form.stage,
      status: form.status,
      is_capability: form.is_capability,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      owner_user_id: form.owner_user_id || null,
      manager_user_id: form.manager_user_id || null,
      cost_approval_threshold_usd: thresholdValue,
    };
    // Editing: PATCH only what changed in THIS dialog, so a value someone else
    // updated meanwhile (notably status draft→active) is never overwritten.
    const changed: Record<string, unknown> = {};
    if (initial) {
      for (const [k, v] of Object.entries(full)) {
        if (form[k as keyof typeof form] !== initial[k]) changed[k] = v;
      }
    }
    try {
      if (plan?.id) {
        if (Object.keys(changed).length) {
          // PATCH/assign-all/PUT-focus write ABSOLUTE values (not increments), so
          // replaying one is a no-op — safe to ride out a transient blip via retry.
          await api(`/api/plans/${plan.id}`, { method: "PATCH", body: changed, idempotent: true });
        }
        // Single-performer plan: hand every still-open task to that person. Runs
        // before the commitment upsert so the minutes land on someone who now
        // actually holds the tasks.
        if (assignAllTo) {
          const { assigned } = await api<{ assigned: number }>(`/api/plans/${plan.id}/assign-all`, {
            method: "POST",
            body: { assignee_user_id: assignAllTo },
            idempotent: true,
          });
          toast.success(te("assignedAll", { n: assigned }));
        }
        // Upsert the daily-focus commitment alongside the plan edit. A positive
        // value sets/updates it; blank leaves any existing commitment untouched
        // (deactivating is done from the focus tool, not by clearing this field).
        // With a single performer chosen, the commitment is THEIRS.
        const mins = parseInt(dailyMinutes, 10);
        if (Number.isInteger(mins) && mins > 0) {
          const sorted = [...workdays].sort((a, b) => a - b);
          await api(`/api/plan/${plan.id}/focus`, {
            method: "PUT",
            body: {
              daily_minutes: mins,
              active: true,
              workdays: sorted.length ? sorted : null,
              ...(assignAllTo ? { user_id: assignAllTo } : {}),
            },
            idempotent: true,
          });
        }
      } else {
        // Create carries a client_token so a retry (or a re-click after a blip)
        // returns the same plan instead of creating a duplicate — which makes the
        // POST safe to retry via idempotent:true. Guard the token so idempotent:true
        // is never sent without one (which would let a retry duplicate).
        const token = createTokenRef.current ?? crypto.randomUUID();
        createTokenRef.current = token;
        await api("/api/plans", {
          method: "POST",
          body: { ...full, client_token: token },
          idempotent: true,
        });
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
          <Field label={te("goalEn")}>
            <Textarea value={form.goal_en} onChange={(e) => set("goal_en", e.target.value)} rows={2} dir="ltr" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("group")}>
              <Input value={form.group_label} onChange={(e) => set("group_label", e.target.value)} />
            </Field>
            <Field label={te("groupEn")}>
              <Input value={form.group_label_en} onChange={(e) => set("group_label_en", e.target.value)} dir="ltr" />
            </Field>
          </div>
          {plan?.id && (
            <Field label={te("kind")}>
              <select className={fieldCls} value={form.kind} onChange={(e) => set("kind", e.target.value as PlanKind)}>
                <option value="effort">{t("kind.effort")}</option>
                <option value="stream">{t("kind.stream")}</option>
                <option value="roster">{t("kind.roster")}</option>
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("start")}>
              <DatePicker className="h-9 w-auto px-2 py-1 text-sm" value={form.start_date}
                onChange={(v) => set("start_date", v)} />
            </Field>
            <Field label={te("end")}>
              <DatePicker className="h-9 w-auto px-2 py-1 text-sm" value={form.end_date}
                onChange={(v) => set("end_date", v)} />
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

          {/* One person does the whole plan — the common case. Picking someone
              hands them every open task on save, and points the minutes/workdays
              below at them instead of at whoever is editing. */}
          {plan?.id && (
            <Field label={te("assignAll")}>
              <select className={fieldCls} value={assignAllTo} onChange={(e) => setAssignAllTo(e.target.value)}>
                <option value="">{te("assignAllNone")}</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{personLabel(m)}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">{te("assignAllHint")}</p>
            </Field>
          )}

          {plan?.id && (
            <Field label={assignAllTo ? te("dailyMinutesFor") : te("dailyMinutes")}>
              <Input type="number" min={1} step={5} value={dailyMinutes}
                onChange={(e) => setDailyMinutes(e.target.value)} dir="ltr" placeholder={te("dailyMinutesHint")} />
            </Field>
          )}

          {plan?.id && (
            <Field label={te("workdays")}>
              <div className="flex flex-wrap gap-1">
                {dayLabels.map((label, dow) => {
                  const on = workdays.includes(dow);
                  return (
                    <button
                      key={dow}
                      type="button"
                      onClick={() => setWorkdays((w) => (on ? w.filter((d) => d !== dow) : [...w, dow]))}
                      className={cn(
                        "min-w-9 rounded-md border px-2 py-1 text-[11.5px] font-medium",
                        on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{te("workdaysHint")}</p>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={te("owner")}>
              <select className={fieldCls} value={form.owner_user_id} onChange={(e) => set("owner_user_id", e.target.value)}>
                <option value="">{te("unassigned")}</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{personLabel(m)}</option>
                ))}
              </select>
            </Field>
            {/* Who approves deliverables and gets progress reports. */}
            <Field label={te("manager")}>
              <select className={fieldCls} value={form.manager_user_id} onChange={(e) => set("manager_user_id", e.target.value)}>
                <option value="">{te("unassigned")}</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{personLabel(m)}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Money ceiling: recorded on the plan as the agreed limit. No approval
              task is opened automatically yet — the hint says so plainly. */}
          <Field label={te("costThreshold")}>
            <Input type="number" min={0} step={10} value={form.cost_approval_threshold_usd}
              onChange={(e) => set("cost_approval_threshold_usd", e.target.value)} dir="ltr" />
            <p className="mt-1 text-[11px] text-muted-foreground">{te("costThresholdHint")}</p>
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
