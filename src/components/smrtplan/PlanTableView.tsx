"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Undo2, Redo2, Plus, ExternalLink, Link2, AlertTriangle } from "lucide-react";
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
  plan_title_he: string | null;
  plan_title_en: string | null;
  linked_drive_docs?: { url?: string; name?: string; title?: string }[] | null;
  task_materials?: { url?: string; title?: string }[] | null;
  source_messages?: { source_url: string | null; serial_display: string | null } | null;
  needs: TaskNeed[];
}
interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
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

/** All link URLs attached to a task — kept verbatim (deep links, not domains). */
function taskLinks(t: TableTask, sourceLabel: string): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  if (t.source_messages?.source_url) out.push({ label: t.source_messages.serial_display || sourceLabel, url: t.source_messages.source_url });
  for (const d of t.linked_drive_docs ?? []) if (d.url) out.push({ label: d.name || d.title || "Drive", url: d.url });
  for (const m of t.task_materials ?? []) if (m.url) out.push({ label: m.title || "link", url: m.url });
  return out;
}

export function PlanTableView({ locale, canEdit, onChanged }: { locale: string; canEdit: boolean; onChanged?: () => void }) {
  const t = useTranslations("smrtPlan");
  const te = useTranslations("smrtPlan.edit");
  const [tasks, setTasks] = useState<TableTask[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cellRef = useRef<HTMLElement | null>(null);
  const rtl = locale !== "en";

  const history = useHistory();
  const { run: histRun, undo: histUndo, redo: histRedo } = history;

  const refetch = useCallback(async () => {
    const [{ tasks }, { plans }] = await Promise.all([
      api<{ tasks: TableTask[] }>("/api/plan/all-tasks"),
      api<{ plans: Plan[] }>("/api/plans"),
    ]);
    setTasks(tasks ?? []);
    setPlans(plans ?? []);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ tasks }, { plans }, mem] = await Promise.all([
          api<{ tasks: TableTask[] }>("/api/plan/all-tasks"),
          api<{ plans: Plan[] }>("/api/plans"),
          api<{ members: Member[] }>("/api/org/members").catch(() => ({ members: [] as Member[] })),
        ]);
        if (!alive) return;
        setTasks(tasks ?? []);
        setPlans(plans ?? []);
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

  // Group tasks under their plan, in the plans' board order; plans with no tasks
  // still show (so you can add the first task). `flat` is the keyboard-nav order.
  const groups = useMemo(() => {
    const byPlan = new Map<string, TableTask[]>();
    for (const tk of tasks) {
      if (!byPlan.has(tk.plan_id)) byPlan.set(tk.plan_id, []);
      byPlan.get(tk.plan_id)!.push(tk);
    }
    const ordered = [...plans].sort((a, b) => (a.group_label || "").localeCompare(b.group_label || ""));
    const seen = new Set(ordered.map((p) => p.id));
    const out: { plan: Plan; rows: TableTask[] }[] = ordered.map((p) => ({ plan: p, rows: byPlan.get(p.id) ?? [] }));
    // any tasks whose plan wasn't in the list (defensive)
    for (const [pid, rows] of byPlan) if (!seen.has(pid)) out.push({ plan: { id: pid, title_he: rows[0]?.plan_title_he ?? "—" } as Plan, rows });
    return out.filter((g) => g.rows.length > 0 || canEdit);
  }, [tasks, plans, canEdit]);

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

  async function addTask(planId: string) {
    try {
      await api(`/api/plans/${planId}/tasks`, { method: "POST", body: { title_he: te("newRowTitle"), status: "inbox" } });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
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
            {groups.map(({ plan, rows }) => (
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
                onEditPlanTitle={editPlanTitle}
                onAddTask={addTask}
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
  onAddTask: (planId: string) => void;
}) {
  const { plan, rows, locale, canEdit, memberMap, members, statusLabel, te, t } = props;
  const [editTitle, setEditTitle] = useState(false);
  const planTitle = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;

  return (
    <>
      <tr className="bg-secondary/40">
        <td colSpan={7} className="border-b px-2 py-1.5">
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
          <span className="ms-2 text-[10.5px] font-normal text-muted-foreground">{rows.length}</span>
        </td>
      </tr>
      {rows.map((task) => {
        const r = props.getFlatIndex(task.id);
        const links = taskLinks(task, t("table.source"));
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
              <span className="flex flex-wrap gap-1">
                {links.length === 0 && <span className="text-[11px] text-muted-foreground/40">—</span>}
                {links.map((l, i) => (
                  <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex max-w-[120px] items-center gap-0.5 truncate rounded-full border bg-secondary/60 px-1.5 py-px text-[10.5px] hover:bg-accent">
                    <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" /> <span className="truncate">{l.label}</span>
                  </a>
                ))}
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
      })}
      {canEdit && (
        <tr>
          <td colSpan={7} className="border-b px-2 py-1">
            <button onClick={() => props.onAddTask(plan.id)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
              <Plus className="h-3 w-3" /> {te("addTask")}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
