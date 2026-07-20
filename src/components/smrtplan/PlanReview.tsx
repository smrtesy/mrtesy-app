"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, ChevronDown, MessageSquarePlus, Pencil } from "lucide-react";
import { api } from "@/lib/api/client";
import type { Plan } from "@/types/plan";
import { parseISO, gregShort } from "@/lib/smrtplan/dates";

interface ChecklistItem { id?: string; title?: string; done?: boolean }
interface ReviewTask {
  id: string;
  title: string | null;
  title_he: string | null;
  assignee_name: string | null;
  due_date: string | null;
  is_decision: boolean;
  description: string | null;
  checklist: ChecklistItem[] | null;
  definition_of_done: string | null;
  note: string;
}

/** Does the text contain Hebrew letters? Drives per-card direction so Levi's
 *  English cards read LTR and Chanoch's Hebrew cards read RTL — same as the task
 *  card itself in the app. */
function hasHebrew(s: string | null | undefined): boolean {
  return !!s && /[֐-׿]/.test(s);
}
function displayTitle(t: ReviewTask): string {
  return t.title_he || t.title || "";
}
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** In-app "review pass" (docs/smrtplan-simulation-plan §5): a row per task; open one
 *  to read its FULL text (description, checklist, done-when) and write a shared
 *  "what to change" note. The top button exports every note to CSV for batch apply. */
export function PlanReview({
  plan,
  locale,
  canEdit,
}: {
  plan: Plan;
  locale: string;
  canEdit?: boolean;
}) {
  const t = useTranslations("smrtPlan.review");
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<{ tasks: ReviewTask[] }>(`/api/plans/${plan.id}/review`)
      .then((d) => { if (alive) setTasks(d.tasks ?? []); })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "Error"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [plan.id]);

  const noteCount = useMemo(() => tasks.filter((t) => t.note.trim()).length, [tasks]);
  const planTitle = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;

  function startEdit(task: ReviewTask) {
    setEditId(task.id);
    setDraft(task.note ?? "");
  }

  async function saveNote(taskId: string) {
    setSaving(true);
    try {
      const note = draft.trim();
      await api(`/api/plans/${plan.id}/review-notes/${taskId}`, { method: "PUT", body: { note } });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, note } : t)));
      setEditId(null);
      toast.success(t("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  function downloadCsv() {
    const header = [t("csvNum"), t("csvTask"), t("csvAssignee"), t("csvDue"), t("csvNote"), "task_id"];
    const rows = tasks.map((task, i) => [
      String(i + 1),
      displayTitle(task),
      task.assignee_name ?? "",
      task.due_date ? gregShort(parseISO(task.due_date)) : "",
      task.note ?? "",
      task.id,
    ]);
    const csv = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t("fileName")}-${planTitle || plan.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="py-8 text-center text-[12.5px] text-muted-foreground">…</div>;

  return (
    <div className="space-y-3">
      {/* ── header: count + export ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-bold">{t("title")}</h3>
          <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {t("noteCount", { done: noteCount, total: tasks.length })}
          </span>
        </div>
        <button
          onClick={downloadCsv}
          disabled={noteCount === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-card"
          title={t("downloadHint")}
        >
          <Download className="h-3.5 w-3.5" />
          {t("download")}
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed py-8 text-center text-[12.5px] text-muted-foreground">
          {t("noTasks")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {tasks.map((task, i) => {
            const open = openId === task.id;
            const he = hasHebrew(task.description) || hasHebrew(displayTitle(task));
            const dirCls = he ? "text-right" : "text-left";
            const dir = he ? "rtl" : "ltr";
            const editing = editId === task.id;
            return (
              <div key={task.id} className="overflow-hidden rounded-lg border bg-card">
                {/* ── row (click to open) ── */}
                <button
                  onClick={() => { setOpenId(open ? null : task.id); setEditId(null); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start transition-colors hover:bg-accent/50"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-secondary text-[10.5px] font-bold text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-[12.5px] font-medium">{displayTitle(task)}</span>
                  {task.note.trim() && (
                    <span className="whitespace-nowrap rounded bg-status-warn-bg px-1.5 py-px text-[10px] font-bold text-status-warn">
                      {t("hasNote")}
                    </span>
                  )}
                  {task.is_decision && (
                    <span className="whitespace-nowrap rounded bg-status-late-bg px-1.5 py-px text-[10px] font-bold text-status-late">
                      {t("decision")}
                    </span>
                  )}
                  {task.assignee_name && (
                    <span className="hidden whitespace-nowrap text-[10.5px] text-muted-foreground sm:inline">{task.assignee_name}</span>
                  )}
                  {task.due_date && (
                    <span className="whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">{gregShort(parseISO(task.due_date))}</span>
                  )}
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                </button>

                {/* ── expanded: full text + note ── */}
                {open && (
                  <div className="border-t px-3 py-3" dir={dir}>
                    {task.description && (
                      <p className={`whitespace-pre-wrap text-[12.5px] leading-relaxed ${dirCls}`}>{task.description}</p>
                    )}

                    {Array.isArray(task.checklist) && task.checklist.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {task.checklist.map((c, ci) => (
                          <li key={c.id ?? ci} className={`flex items-start gap-2 text-[12px] ${dirCls}`}>
                            <span className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[4px] border text-[9px] ${c.done ? "border-status-ok bg-status-ok text-white" : "border-border"}`}>
                              {c.done ? "✓" : ""}
                            </span>
                            <span className={c.done ? "text-muted-foreground line-through" : ""}>{c.title}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {task.definition_of_done && (
                      <div className="mt-3 rounded-md bg-status-ok-bg px-2.5 py-2 text-[11.5px] leading-relaxed">
                        <span className="font-bold text-status-ok">{t("doneWhen")}: </span>
                        {task.definition_of_done}
                      </div>
                    )}

                    {/* ── note editor ── */}
                    <div className="mt-4 border-t pt-3" dir="rtl">
                      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{t("noteLabel")}</div>
                      {editing ? (
                        <div className="space-y-2">
                          <textarea
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            rows={3}
                            placeholder={t("notePlaceholder")}
                            className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-primary"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveNote(task.id)}
                              disabled={saving}
                              className="rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                            >
                              {t("save")}
                            </button>
                            <button
                              onClick={() => setEditId(null)}
                              className="rounded-md border px-3 py-1 text-[12px] font-medium text-muted-foreground hover:bg-accent"
                            >
                              {t("cancel")}
                            </button>
                          </div>
                        </div>
                      ) : task.note.trim() ? (
                        <div className="rounded-md border bg-status-warn-bg/40 px-2.5 py-2">
                          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{task.note}</p>
                          {canEdit && (
                            <button
                              onClick={() => startEdit(task)}
                              className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline"
                            >
                              <Pencil className="h-3 w-3" />
                              {t("editNote")}
                            </button>
                          )}
                        </div>
                      ) : canEdit ? (
                        <button
                          onClick={() => startEdit(task)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-accent"
                        >
                          <MessageSquarePlus className="h-3.5 w-3.5" />
                          {t("addNote")}
                        </button>
                      ) : (
                        <p className="text-[12px] text-muted-foreground">{t("noNote")}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
