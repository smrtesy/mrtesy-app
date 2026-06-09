"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Undo2, Redo2, Plus, ExternalLink, Link2, AlertTriangle, X, Trash2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/plan";
import type { TaskNeed } from "@/types/task";
import { parseISO, gregShort, hebDate } from "@/lib/smrtplan/dates";
import { useHistory, type HistoryCmd } from "@/lib/smrtplan/useHistory";

interface TableTask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  assigned_to_user_id: string | null;
  due_date: string | null;
  latest_finish: string | null;
  is_critical: boolean | null;
  duration_days: number | null;
  duration_manual: boolean | null;
  plan_id: string;
  stage_id: string | null;
  plan_title_he: string | null;
  plan_title_en: string | null;
  linked_drive_docs?: { url?: string; name?: string; title?: string }[] | null;
  task_materials?: { id: string; type: string; title?: string; url?: string }[] | null;
  source_messages?: { source_url: string | null; serial_display: string | null } | null;
  needs: TaskNeed[];
}
interface TableStage {
  id: string;
  plan_id: string;
  name_he: string;
  name_en: string | null;
  sequence: number;
  start_date: string | null;
  end_date: string | null;
}
interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
}
function newKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `tmp-${Date.now()}-${Math.random()}`;
}
function memberName(m: Member): string {
  return m.name || m.email || m.user_id.slice(0, 6);
}

/** The keyboard-navigable, inline-editable columns (in display order). */
type NavCol = "title" | "assignee" | "status" | "due" | "duration";
const NAV_COLS: NavCol[] = ["title", "assignee", "status", "due", "duration"];
const DONE = new Set(["completed", "archived", "dismissed"]);
const STATUS_OPTS = ["inbox", "in_progress", "archived"] as const;

const cellBase =
  "w-full truncate rounded px-1.5 py-1 text-start text-[12.5px] outline-none focus:ring-2 focus:ring-ring";
const editBase =
  "w-full rounded border border-input bg-background px-1.5 py-1 text-[12.5px] outline-none focus:ring-2 focus:ring-ring";

export function PlanTableView({ locale, canEdit, onChanged }: { locale: string; canEdit: boolean; onChanged?: () => void }) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [tasks, setTasks] = useState<TableTask[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [stages, setStages] = useState<TableStage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cellRef = useRef<HTMLElement | null>(null);
  const rtl = locale !== "en";

  const history = useHistory();
  const { run: histRun, undo: histUndo, redo: histRedo, reset: histReset, resolve: histResolve, keyOf: histKeyOf, bind: histBind } = history;

  const refetch = useCallback(async () => {
    const [{ tasks }, { plans }, { stages }] = await Promise.all([
      api<{ tasks: TableTask[] }>("/api/plan/all-tasks"),
      api<{ plans: Plan[] }>("/api/plans"),
      api<{ stages: TableStage[] }>("/api/plans/board-stages").catch(() => ({ stages: [] })),
    ]);
    setTasks(tasks ?? []);
    setPlans(plans ?? []);
    setStages(stages ?? []);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ tasks }, { plans }, { stages }, mem] = await Promise.all([
          api<{ tasks: TableTask[] }>("/api/plan/all-tasks"),
          api<{ plans: Plan[] }>("/api/plans"),
          api<{ stages: TableStage[] }>("/api/plans/board-stages").catch(() => ({ stages: [] })),
          api<{ members: Member[] }>("/api/org/members").catch(() => ({ members: [] as Member[] })),
        ]);
        if (!alive) return;
        setTasks(tasks ?? []);
        setPlans(plans ?? []);
        setStages(stages ?? []);
        setMembers(mem.members ?? []);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const memberMap = useMemo(() => new Map(members.map((m) => [m.user_id, memberName(m)])), [members]);

  const stagesByPlan = useMemo(() => {
    const m = new Map<string, TableStage[]>();
    for (const s of stages) {
      if (!m.has(s.plan_id)) m.set(s.plan_id, []);
      m.get(s.plan_id)!.push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.sequence - b.sequence);
    return m;
  }, [stages]);

  // Group tasks under their plan (board order), and WITHIN a plan order them by
  // their stage (banner) so they render grouped under each stage. `flat` is the
  // keyboard-nav order and must match that render order.
  const groups = useMemo(() => {
    const byPlan = new Map<string, TableTask[]>();
    for (const tk of tasks) {
      if (!byPlan.has(tk.plan_id)) byPlan.set(tk.plan_id, []);
      byPlan.get(tk.plan_id)!.push(tk);
    }
    const orderByStage = (rows: TableTask[], sts: TableStage[]): TableTask[] => {
      const seq = new Map(sts.map((s, i) => [s.id, i]));
      return [...rows].sort((a, b) => {
        const ai = a.stage_id != null && seq.has(a.stage_id) ? seq.get(a.stage_id)! : Number.MAX_SAFE_INTEGER;
        const bi = b.stage_id != null && seq.has(b.stage_id) ? seq.get(b.stage_id)! : Number.MAX_SAFE_INTEGER;
        return ai - bi; // stable sort keeps original order within a stage
      });
    };
    const ordered = [...plans].sort((a, b) => (a.group_label || "").localeCompare(b.group_label || ""));
    const seen = new Set(ordered.map((p) => p.id));
    const out: { plan: Plan; rows: TableTask[]; stages: TableStage[] }[] = ordered.map((p) => {
      const sts = stagesByPlan.get(p.id) ?? [];
      return { plan: p, rows: orderByStage(byPlan.get(p.id) ?? [], sts), stages: sts };
    });
    for (const [pid, rows] of byPlan) {
      if (!seen.has(pid)) out.push({ plan: { id: pid, title_he: rows[0]?.plan_title_he ?? "—" } as Plan, rows, stages: stagesByPlan.get(pid) ?? [] });
    }
    return out.filter((g) => g.rows.length > 0 || canEdit);
  }, [tasks, plans, canEdit, stagesByPlan]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const flatIndexById = useMemo(() => {
    const m = new Map<string, number>();
    flat.forEach((tk, i) => m.set(tk.id, i));
    return m;
  }, [flat]);

  const runCmd = useCallback(
    (cmd: HistoryCmd) => histRun(cmd).catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await refetch(); }),
    [histRun, refetch],
  );
  const doUndo = useCallback(() => histUndo().catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await refetch(); }), [histUndo, refetch]);
  const doRedo = useCallback(() => histRedo().catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await refetch(); }), [histRedo, refetch]);

  // Keep the active cell in range if the row set shrinks (add/delete/undo).
  useEffect(() => {
    setActive((a) => (a && a.r < flat.length ? a : null));
  }, [flat.length]);

  // Focus the active cell (its editor when editing, else its display button).
  useEffect(() => { cellRef.current?.focus(); }, [active, editing, flat.length]);

  // Edit a single task field, recorded for undo (old → new, both via PATCH).
  // `reschedules` (due/duration) pulls fresh engine dates; other edits trust the
  // optimistic update and skip the round-trip — that's the snappy path.
  const editField = useCallback(
    (taskId: string, body: Record<string, unknown>, undoBody: Record<string, unknown>, patch: Partial<TableTask>, undoPatch: Partial<TableTask>, label: string, reschedules: boolean) => {
      const apply = async (b: Record<string, unknown>, p: Partial<TableTask>) => {
        setTasks((ts) => ts.map((tk) => (tk.id === taskId ? { ...tk, ...p } : tk)));
        await api(`/api/plan-tasks/${taskId}`, { method: "PATCH", body: b });
        if (reschedules) await refetch();
      };
      runCmd({ label, redo: () => apply(body, patch), undo: () => apply(undoBody, undoPatch) });
    },
    [runCmd, refetch],
  );

  const editPlanTitle = useCallback(
    (planId: string, oldTitle: string, newTitle: string) => {
      const v = newTitle.trim();
      if (!v || v === oldTitle) return;
      const apply = async (val: string) => {
        setPlans((ps) => ps.map((p) => (p.id === planId ? { ...p, title_he: val } : p)));
        setTasks((ts) => ts.map((tk) => (tk.plan_id === planId ? { ...tk, plan_title_he: val } : tk)));
        await api(`/api/plans/${planId}`, { method: "PATCH", body: { title_he: val } });
        await refetch();
      };
      runCmd({ label: te("actRename"), redo: () => apply(v), undo: () => apply(oldTitle) });
    },
    [runCmd, refetch, te],
  );

  /** Commit the in-progress text/number/date edit of the active cell. */
  const commitDraft = useCallback(
    (task: TableTask, col: NavCol) => {
      if (col === "title") {
        const v = draft.trim();
        if (v && v !== (task.title_he || task.title)) {
          editField(task.id, { title_he: v, title: v }, { title_he: task.title_he, title: task.title }, { title_he: v, title: v }, { title_he: task.title_he, title: task.title }, te("actRename"), false);
        }
      } else if (col === "due") {
        const v = draft || null;
        if (v !== task.due_date) editField(task.id, { due_date: v }, { due_date: task.due_date }, { due_date: v }, { due_date: task.due_date }, t("table.colDue"), true);
      } else if (col === "duration") {
        const v = draft === "" ? null : Number(draft);
        if (v !== task.duration_days) {
          editField(task.id, { duration_days: v, duration_manual: v != null }, { duration_days: task.duration_days, duration_manual: task.duration_manual }, { duration_days: v, duration_manual: v != null }, { duration_days: task.duration_days, duration_manual: task.duration_manual }, t("table.colDuration"), true);
        }
      }
    },
    [draft, editField, t, te],
  );

  // Selects (assignee/status) commit immediately on change.
  const commitSelect = useCallback(
    (task: TableTask, col: NavCol, value: string) => {
      if (col === "assignee") {
        const v = value || null;
        // reschedules=true: an estimated-hours task's duration depends on the
        // assignee's capacity, so reassigning can shift dates — refetch.
        if (v !== task.assigned_to_user_id) editField(task.id, { assigned_to_user_id: v }, { assigned_to_user_id: task.assigned_to_user_id }, { assigned_to_user_id: v }, { assigned_to_user_id: task.assigned_to_user_id }, t("table.colWorker"), true);
      } else if (col === "status") {
        if (value !== task.status) editField(task.id, { status: value }, { status: task.status }, { status: value }, { status: task.status }, t("table.colStatus"), false);
      }
    },
    [editField, t],
  );

  const enterEdit = useCallback(
    (r: number, c: number) => {
      const task = flat[r];
      if (!task || !canEdit) return;
      const col = NAV_COLS[c];
      setActive({ r, c });
      if (col === "title") setDraft(task.title_he || task.title);
      else if (col === "due") setDraft(task.due_date ?? "");
      else if (col === "duration") setDraft(task.duration_days != null ? String(task.duration_days) : "");
      setEditing(true);
    },
    [flat, canEdit],
  );

  // Grid navigation (arrows + Enter to edit) — only when not in a cell editor.
  const onGridKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing || !active) return;
      let { r, c } = active;
      const last = NAV_COLS.length - 1;
      if (e.key === "ArrowDown") r = Math.min(r + 1, flat.length - 1);
      else if (e.key === "ArrowUp") r = Math.max(r - 1, 0);
      else if (e.key === "ArrowRight") c = rtl ? Math.max(c - 1, 0) : Math.min(c + 1, last);
      else if (e.key === "ArrowLeft") c = rtl ? Math.min(c + 1, last) : Math.max(c - 1, 0);
      else if (e.key === "Enter" || e.key === "F2") { enterEdit(r, c); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      setActive({ r, c });
    },
    [editing, active, flat.length, rtl, enterEdit],
  );

  // After committing a cell editor, move the active cell (Enter ↓, Tab →).
  const moveAfterCommit = useCallback(
    (dir: "down" | "next") => {
      setEditing(false);
      setActive((a) => {
        if (!a) return a;
        if (dir === "down") return { r: Math.min(a.r + 1, flat.length - 1), c: a.c };
        const last = NAV_COLS.length - 1;
        if (a.c < last) return { r: a.r, c: a.c + 1 };
        return { r: Math.min(a.r + 1, flat.length - 1), c: 0 };
      });
    },
    [flat.length],
  );

  // ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z (not while editing a cell).
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const el = e.target as HTMLElement | null;
      if (editing && el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      e.preventDefault();
      if (k === "y" || (k === "z" && e.shiftKey)) doRedo();
      else doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, editing, doUndo, doRedo]);

  async function addTask(planId: string, stageId?: string | null) {
    try {
      await api(`/api/plans/${planId}/tasks`, { method: "POST", body: { title_he: te("newRowTitle"), status: "inbox", stage_id: stageId ?? null } });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  // Add a project (draft effort plan) — optimistic empty group, swap in real id.
  function addPlan() {
    const key = newKey();
    const start = new Date();
    const end = new Date(start.getTime() + 14 * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const planObj = (id: string) =>
      ({ id, title_he: te("newPlan"), title_en: null, group_label: null, kind: "effort", start_date: iso(start), end_date: iso(end) } as unknown as Plan);
    const create = async () => {
      setPlans((ps) => [...ps.filter((p) => p.id !== histResolve(key) && p.id !== key), planObj(key)]);
      const { plan } = await api<{ plan: { id: string } }>("/api/plans", {
        method: "POST",
        body: { title_he: te("newPlan"), kind: "effort", status: "draft", start_date: iso(start), end_date: iso(end) },
      });
      if (plan?.id) { histBind(key, plan.id); setPlans((ps) => ps.map((p) => (p.id === key ? { ...p, id: plan.id } : p))); }
    };
    const remove = async () => {
      const live = histResolve(key);
      setPlans((ps) => ps.filter((p) => p.id !== live && p.id !== key));
      await api(`/api/plans/${live}?cascade=tasks`, { method: "DELETE" });
    };
    runCmd({ label: t("table.addProject"), redo: create, undo: remove });
  }

  // Delete a project + all its tasks (cascade). Destructive + confirmed → not
  // undoable; the history is reset so a stale redo can't replay against it.
  async function deletePlan(planId: string) {
    if (!window.confirm(t("table.confirmDeleteProject"))) return;
    const before = { plans, tasks, stages };
    setPlans((ps) => ps.filter((p) => p.id !== planId));
    setTasks((ts) => ts.filter((x) => x.plan_id !== planId));
    setStages((ss) => ss.filter((s) => s.plan_id !== planId));
    histReset();
    try {
      await api(`/api/plans/${planId}?cascade=tasks`, { method: "DELETE" });
    } catch (e) {
      setPlans(before.plans);
      setTasks(before.tasks);
      setStages(before.stages);
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  function addStage(planId: string) {
    const name = window.prompt(te("name"));
    if (!name || !name.trim()) return;
    const nm = name.trim();
    const seq = (stagesByPlan.get(planId) ?? []).length + 1;
    const key = newKey();
    const create = async () => {
      setStages((ss) => [...ss.filter((s) => s.id !== histResolve(key) && s.id !== key), { id: key, plan_id: planId, name_he: nm, name_en: null, sequence: seq, start_date: null, end_date: null }]);
      const { stage } = await api<{ stage: { id: string } }>(`/api/plans/${planId}/stages`, { method: "POST", body: { name_he: nm, sequence: seq } });
      if (stage?.id) { histBind(key, stage.id); setStages((ss) => ss.map((s) => (s.id === key ? { ...s, id: stage.id } : s))); }
    };
    const remove = async () => {
      const live = histResolve(key);
      setStages((ss) => ss.filter((s) => s.id !== live && s.id !== key));
      await api(`/api/plan-stages/${live}`, { method: "DELETE" });
    };
    runCmd({ label: te("actStageAdd"), redo: create, undo: remove });
  }

  function deleteStage(st: TableStage) {
    const key = histKeyOf(st.id);
    const remove = async () => {
      const live = histResolve(key);
      setStages((ss) => ss.filter((s) => s.id !== live));
      await api(`/api/plan-stages/${live}`, { method: "DELETE" });
    };
    const recreate = async () => {
      setStages((ss) => [...ss.filter((s) => s.id !== st.id), st]);
      const { stage } = await api<{ stage: { id: string } }>(`/api/plans/${st.plan_id}/stages`, { method: "POST", body: { name_he: st.name_he, name_en: st.name_en, sequence: st.sequence, start_date: st.start_date, end_date: st.end_date } });
      if (stage?.id) { histBind(key, stage.id); setStages((ss) => ss.map((s) => (s.id === st.id ? { ...s, id: stage.id } : s))); }
    };
    runCmd({ label: te("actStageDel"), redo: remove, undo: recreate });
  }

  // Assign a task to a stage (banner) within its plan — moves it under that
  // banner. Not a scheduling field, so optimistic with no refetch.
  function setTaskStage(task: TableTask, stageId: string | null) {
    const v = stageId || null;
    if (v === (task.stage_id ?? null)) return;
    editField(task.id, { stage_id: v }, { stage_id: task.stage_id ?? null }, { stage_id: v }, { stage_id: task.stage_id ?? null }, t("table.stage"), false);
  }

  function renameStage(st: TableStage) {
    const name = window.prompt(te("name"), st.name_he);
    if (name == null) return;
    const v = name.trim();
    if (!v || v === st.name_he) return;
    const key = histKeyOf(st.id);
    const apply = async (val: string) => {
      const live = histResolve(key);
      setStages((ss) => ss.map((s) => (s.id === live ? { ...s, name_he: val } : s)));
      await api(`/api/plan-stages/${live}`, { method: "PATCH", body: { name_he: val } });
    };
    runCmd({ label: te("actRename"), redo: () => apply(v), undo: () => apply(st.name_he) });
  }

  // Links: stored as task_materials of type "link". Add/remove inline; not a
  // scheduling field, so optimistic with no refetch.
  function addLink(task: TableTask) {
    const url = window.prompt(t("table.linkUrl"));
    if (!url || !url.trim()) return;
    const label = (window.prompt(t("table.linkLabel"), url.trim()) ?? url.trim()).trim() || url.trim();
    const old = task.task_materials ?? [];
    const next = [...old, { id: newKey(), type: "link", title: label, url: url.trim() }];
    editField(task.id, { task_materials: next }, { task_materials: old }, { task_materials: next }, { task_materials: old }, t("table.colLinks"), false);
  }
  function removeLink(task: TableTask, matId: string) {
    const old = task.task_materials ?? [];
    const next = old.filter((m) => m.id !== matId);
    editField(task.id, { task_materials: next }, { task_materials: old }, { task_materials: next }, { task_materials: old }, t("table.colLinks"), false);
  }

  const statusLabel = (s: string) =>
    s === "in_progress" ? te("statusInProgress") : DONE.has(s) ? te("statusDone") : te("statusInbox");

  if (loading) return <div className="h-40 animate-pulse rounded-lg bg-muted" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted-foreground">{t("table.lead")}</p>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button onClick={addPlan}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
              <Plus className="h-3.5 w-3.5" /> {t("table.addProject")}
            </button>
            <button onClick={doUndo} disabled={!history.canUndo} title={history.nextUndoLabel ? `${te("undo")}: ${history.nextUndoLabel}` : te("undo")}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent disabled:opacity-50">
              <Undo2 className="h-3.5 w-3.5" /> {te("undo")}
            </button>
            <button onClick={doRedo} disabled={!history.canRedo} title={history.nextRedoLabel ? `${te("redo")}: ${history.nextRedoLabel}` : te("redo")}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent disabled:opacity-50">
              <Redo2 className="h-3.5 w-3.5" /> {te("redo")}
            </button>
          </div>
        )}
      </div>
      {canEdit && <p className="text-[11px] text-muted-foreground">{t("table.keyboardHint")}</p>}

      <div className="overflow-x-auto rounded-xl border" onKeyDown={onGridKey}>
        <table className="w-full min-w-[920px] border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-[2] bg-secondary/70 text-[11px] font-bold text-muted-foreground">
            <tr>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "26%" }}>{t("table.colTask")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "12%" }}>{t("table.colWorker")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "10%" }}>{t("table.colStatus")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "14%" }}>{t("table.colDue")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "8%" }}>{t("table.colDuration")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "18%" }}>{t("table.colLinks")}</th>
              <th className="border-b px-2 py-1.5 text-start" style={{ width: "12%" }}>{t("table.colDeps")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ plan, rows, stages: planStages }) => (
              <PlanGroup
                key={plan.id}
                plan={plan}
                rows={rows}
                locale={locale}
                canEdit={canEdit}
                memberMap={memberMap}
                members={members}
                statusLabel={statusLabel}
                te={te}
                t={t}
                stages={planStages}
                onEditPlanTitle={editPlanTitle}
                onAddTask={addTask}
                onAddStage={addStage}
                onDeleteStage={deleteStage}
                onRenameStage={renameStage}
                onSetTaskStage={setTaskStage}
                onDeletePlan={deletePlan}
                onAddLink={addLink}
                onRemoveLink={removeLink}
                getFlatIndex={(taskId) => flatIndexById.get(taskId) ?? -1}
                active={active}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                cellRef={cellRef}
                onActivate={(r, c) => { setEditing(false); setActive({ r, c }); }}
                onEnterEdit={enterEdit}
                onCommitDraft={commitDraft}
                onCommitSelect={commitSelect}
                onMove={moveAfterCommit}
                onCancel={() => setEditing(false)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {groups.length === 0 && <p className="py-8 text-center text-[12.5px] italic text-muted-foreground">{t("table.empty")}</p>}
    </div>
  );
}

function PlanGroup(props: {
  plan: Plan;
  rows: TableTask[];
  locale: string;
  canEdit: boolean;
  memberMap: Map<string, string>;
  members: Member[];
  statusLabel: (s: string) => string;
  te: ReturnType<typeof useTranslations>;
  t: ReturnType<typeof useTranslations>;
  onEditPlanTitle: (planId: string, oldTitle: string, newTitle: string) => void;
  stages: TableStage[];
  onAddStage: (planId: string) => void;
  onDeleteStage: (stage: TableStage) => void;
  onRenameStage: (stage: TableStage) => void;
  onSetTaskStage: (task: TableTask, stageId: string | null) => void;
  onDeletePlan: (planId: string) => void;
  onAddLink: (task: TableTask) => void;
  onRemoveLink: (task: TableTask, matId: string) => void;
  getFlatIndex: (taskId: string) => number;
  active: { r: number; c: number } | null;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  cellRef: React.MutableRefObject<HTMLElement | null>;
  onActivate: (r: number, c: number) => void;
  onEnterEdit: (r: number, c: number) => void;
  onCommitDraft: (task: TableTask, col: NavCol) => void;
  onCommitSelect: (task: TableTask, col: NavCol, value: string) => void;
  onMove: (dir: "down" | "next") => void;
  onCancel: () => void;
  onAddTask: (planId: string, stageId?: string | null) => void;
}) {
  const { plan, rows, locale, canEdit, memberMap, members, statusLabel, te, t, stages } = props;
  const [editTitle, setEditTitle] = useState(false);
  const planTitle = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;
  const stageName = (s: TableStage) => (locale === "en" ? s.name_en || s.name_he : s.name_he);
  const stageIds = new Set(stages.map((s) => s.id));
  const noStageRows = rows.filter((tk) => !tk.stage_id || !stageIds.has(tk.stage_id));

  // One banner row introducing a stage (or the "no stage" group): name (rename),
  // delete, and "+ task" that creates a task already in that stage.
  const bannerRow = (s: TableStage | null) => (
    <tr key={s ? `b-${s.id}` : "b-none"} className="bg-secondary/20">
      <td colSpan={7} className="border-b px-2 py-1">
        <span className="flex items-center gap-2">
          <span
            className={cn("text-[11.5px] font-bold", s ? "text-foreground/80" : "italic text-muted-foreground", canEdit && s && "cursor-text rounded px-0.5 hover:bg-accent")}
            onClick={canEdit && s ? () => props.onRenameStage(s) : undefined}
            title={canEdit && s ? te("edit") : undefined}
          >
            {s ? stageName(s) : t("table.noStage")}
          </span>
          {canEdit && s && (
            <button onClick={() => props.onDeleteStage(s)} className="rounded text-muted-foreground hover:text-status-late" title={te("delete")}>
              <X className="h-3 w-3" />
            </button>
          )}
          {canEdit && (
            <button onClick={() => props.onAddTask(plan.id, s?.id ?? null)}
              className="inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
              <Plus className="h-2.5 w-2.5" /> {te("addTask")}
            </button>
          )}
        </span>
      </td>
    </tr>
  );

  return (
    <>
      <tr className="bg-secondary/40">
        <td colSpan={7} className="border-b px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {canEdit && editTitle ? (
              <input
                autoFocus
                defaultValue={plan.title_he}
                dir="rtl"
                onBlur={(e) => { setEditTitle(false); props.onEditPlanTitle(plan.id, plan.title_he, e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditTitle(false); }}
                className="rounded border border-input bg-background px-1.5 py-0.5 text-[13px] font-bold outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <span
                className={cn("text-[13px] font-bold", canEdit && "cursor-text rounded px-0.5 hover:bg-accent")}
                onClick={canEdit ? () => setEditTitle(true) : undefined}
              >
                {planTitle}
              </span>
            )}
            <span className="text-[10.5px] font-normal text-muted-foreground">{rows.length}</span>
            {canEdit && (
              <button onClick={() => props.onAddStage(plan.id)}
                className="inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground" title={te("addStage")}>
                <Plus className="h-2.5 w-2.5" /> {te("stageShort")}
              </button>
            )}
            {canEdit && (
              <button onClick={() => props.onDeletePlan(plan.id)}
                className="ms-auto inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] font-normal text-muted-foreground hover:bg-status-late/10 hover:text-status-late" title={t("table.deleteProject")}>
                <Trash2 className="h-3 w-3" /> {t("table.deleteProject")}
              </button>
            )}
          </div>
        </td>
      </tr>
      {/* tasks grouped under their stage banner; "no stage" group last */}
      {stages.map((s) => (
        <Fragment key={s.id}>
          {bannerRow(s)}
          {rows.filter((tk) => tk.stage_id === s.id).map(renderRow)}
        </Fragment>
      ))}
      {(stages.length > 0 ? (noStageRows.length > 0 || canEdit) : true) && (
        <Fragment>
          {stages.length > 0 && bannerRow(null)}
          {noStageRows.map(renderRow)}
          {stages.length === 0 && canEdit && (
            <tr>
              <td colSpan={7} className="border-b px-2 py-1">
                <button onClick={() => props.onAddTask(plan.id, null)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Plus className="h-3 w-3" /> {te("addTask")}
                </button>
              </td>
            </tr>
          )}
        </Fragment>
      )}
    </>
  );

  function renderRow(task: TableTask) {
        const r = props.getFlatIndex(task.id);
        const done = DONE.has(task.status);
        const isActive = (c: number) => props.active?.r === r && props.active?.c === c;
        const isEdit = (c: number) => isActive(c) && props.editing;

        const textCell = (c: number, col: NavCol, display: string, kind: "text" | "date" | "number") => {
          if (isEdit(c)) {
            return (
              <input
                ref={(el) => { if (el) props.cellRef.current = el; }}
                type={kind === "date" ? "date" : kind === "number" ? "number" : "text"}
                {...(kind === "number" ? { min: 0, step: 0.5 } : {})}
                dir={kind === "text" ? "rtl" : undefined}
                value={props.draft}
                onChange={(e) => props.setDraft(e.target.value)}
                onBlur={() => props.onCommitDraft(task, col)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { props.onCommitDraft(task, col); props.onMove("down"); e.preventDefault(); }
                  else if (e.key === "Tab") { props.onCommitDraft(task, col); props.onMove("next"); e.preventDefault(); }
                  else if (e.key === "Escape") { props.onCancel(); e.preventDefault(); }
                }}
                className={editBase}
              />
            );
          }
          return (
            <button
              ref={isActive(c) ? (el) => { props.cellRef.current = el; } : undefined}
              tabIndex={isActive(c) ? 0 : -1}
              onFocus={() => props.onActivate(r, c)}
              onClick={() => (canEdit ? props.onEnterEdit(r, c) : props.onActivate(r, c))}
              className={cn(cellBase, isActive(c) && "bg-accent/60", !display && "text-muted-foreground/50")}
            >
              {display || "—"}
            </button>
          );
        };

        const selectCell = (c: number, col: NavCol, display: React.ReactNode, options: { value: string; label: string }[]) => {
          if (isEdit(c)) {
            return (
              <select
                ref={(el) => { if (el) props.cellRef.current = el; }}
                defaultValue={col === "assignee" ? (task.assigned_to_user_id ?? "") : task.status}
                onChange={(e) => { props.onCommitSelect(task, col, e.target.value); props.onMove("next"); }}
                onBlur={() => props.onCancel()}
                onKeyDown={(e) => { if (e.key === "Escape") { props.onCancel(); e.preventDefault(); } }}
                className={editBase}
              >
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          }
          return (
            <button
              ref={isActive(c) ? (el) => { props.cellRef.current = el; } : undefined}
              tabIndex={isActive(c) ? 0 : -1}
              onFocus={() => props.onActivate(r, c)}
              onClick={() => (canEdit ? props.onEnterEdit(r, c) : props.onActivate(r, c))}
              className={cn(cellBase, isActive(c) && "bg-accent/60")}
            >
              {display}
            </button>
          );
        };

        return (
          <tr key={task.id} className={cn("hover:bg-accent/20", done && "text-muted-foreground")}>
            <td className="border-b px-1 py-0.5">
              <span className="flex items-center gap-1">
                {task.is_critical && <AlertTriangle className="h-3 w-3 flex-shrink-0 text-status-late" />}
                {canEdit && stages.length > 0 && (
                  <select
                    value={task.stage_id ?? ""}
                    onChange={(e) => props.onSetTaskStage(task, e.target.value || null)}
                    title={t("table.stage")}
                    className="max-w-[70px] flex-shrink-0 rounded border border-input bg-background px-0.5 text-[9.5px] text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">—</option>
                    {stages.map((s) => <option key={s.id} value={s.id}>{stageName(s)}</option>)}
                  </select>
                )}
                {textCell(0, "title", task.title_he || task.title, "text")}
              </span>
            </td>
            <td className="border-b px-1 py-0.5">
              {selectCell(1, "assignee", task.assigned_to_user_id ? memberMap.get(task.assigned_to_user_id) ?? "—" : <span className="text-muted-foreground/50">{te("unassigned")}</span>,
                [{ value: "", label: te("unassigned") }, ...members.map((m) => ({ value: m.user_id, label: memberName(m) }))])}
            </td>
            <td className="border-b px-1 py-0.5">
              {selectCell(2, "status", statusLabel(task.status), STATUS_OPTS.map((s) => ({ value: s, label: statusLabel(s) })))}
            </td>
            <td className="border-b px-1 py-0.5">
              {textCell(3, "due", task.due_date ? `${gregShort(parseISO(task.due_date))} · ${hebDate(parseISO(task.due_date))}` : "", "date")}
            </td>
            <td className="border-b px-1 py-0.5">
              {textCell(4, "duration", task.duration_days != null ? `${task.duration_days} ${te("daysUnit")}` : "", "number")}
            </td>
            <td className="border-b px-2 py-1">
              <span className="flex flex-wrap items-center gap-1">
                {/* read-only: the origin deep-link + synced Drive docs */}
                {task.source_messages?.source_url && (
                  <a href={task.source_messages.source_url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex max-w-[120px] items-center gap-0.5 truncate rounded-full border bg-secondary/60 px-1.5 py-px text-[10.5px] hover:bg-accent">
                    <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" /> <span className="truncate">{task.source_messages.serial_display || t("table.source")}</span>
                  </a>
                )}
                {(task.linked_drive_docs ?? []).filter((d) => d.url).map((d, i) => (
                  <a key={`d${i}`} href={d.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex max-w-[120px] items-center gap-0.5 truncate rounded-full border bg-secondary/60 px-1.5 py-px text-[10.5px] hover:bg-accent">
                    <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" /> <span className="truncate">{d.name || d.title || "Drive"}</span>
                  </a>
                ))}
                {/* editable: links stored as task_materials */}
                {(task.task_materials ?? []).filter((m) => m.url).map((m) => (
                  <span key={m.id} className="inline-flex max-w-[150px] items-center gap-0.5 rounded-full border bg-card px-1.5 py-px text-[10.5px]">
                    <a href={m.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 truncate hover:underline">
                      <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" /> <span className="truncate">{m.title || m.url}</span>
                    </a>
                    {canEdit && (
                      <button onClick={() => props.onRemoveLink(task, m.id)} className="rounded text-muted-foreground hover:text-status-late" title={te("delete")}>
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </span>
                ))}
                {canEdit && (
                  <button onClick={() => props.onAddLink(task)}
                    className="inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground" title={t("table.addLink")}>
                    <Plus className="h-2.5 w-2.5" /> {t("table.addLink")}
                  </button>
                )}
              </span>
            </td>
            <td className="border-b px-2 py-1">
              <span className="flex flex-wrap gap-1">
                {(task.needs ?? []).length === 0 && <span className="text-[11px] text-muted-foreground/40">—</span>}
                {(task.needs ?? []).map((n) => (
                  <span key={n.dependency_id}
                    className={cn("inline-flex max-w-[120px] items-center gap-0.5 truncate rounded-full border px-1.5 py-px text-[10.5px]",
                      n.satisfied ? "bg-status-ok-bg text-status-ok" : "bg-secondary/60")}>
                    <Link2 className="h-2.5 w-2.5 flex-shrink-0" /> <span className="truncate">{n.title}</span>
                  </span>
                ))}
              </span>
            </td>
          </tr>
        );
  }
}
