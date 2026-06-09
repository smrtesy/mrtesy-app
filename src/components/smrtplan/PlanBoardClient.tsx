"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Plus, Pencil, Flag, UserCog, Check, ChevronDown, ChevronLeft, AlertTriangle, Pin, X, LayoutTemplate, Undo2, Redo2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan, PlanAccessLevel, PlanMilestone, PlanStatus } from "@/types/plan";
import { parseISO, isoOf, gregShort, hebDate, hebDay, hebMonth, gregMonthLabel, daysBetween, countdownText } from "@/lib/smrtplan/dates";
import { useTimeline, COL_PX as COL_BASE } from "@/lib/smrtplan/timeline";
import { useGanttDrag, spanWidth } from "@/lib/smrtplan/useGanttDrag";
import { useHistory, type HistoryCmd } from "@/lib/smrtplan/useHistory";
import { PlanMatrix } from "./PlanMatrix";
import { PlanEffortDetail } from "./PlanEffortDetail";
import { PlanTaskGantt } from "./PlanTaskGantt";
import { PlanTableView } from "./PlanTableView";
import { PlanEditDialog } from "./PlanEditDialog";
import { MilestoneEditor } from "./MilestoneEditor";
import { RolesEditor } from "./RolesEditor";
import { TemplatesEditor } from "./TemplatesEditor";

const DAY_MS = 86_400_000;

/** Day-of-week letter, indexed by getDay(): Hebrew (יום א׳…שבת) or English. */
const HE_DOW = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
const EN_DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function dowLetter(d: Date, locale: string): string {
  return (locale === "en" ? EN_DOW : HE_DOW)[d.getDay()];
}

type Health = "waiting" | "on_track" | "at_risk" | "late" | "stream";

function planTitle(p: Plan, locale: string): string {
  return locale === "en" ? p.title_en || p.title_he : p.title_he;
}

/** Interim health fallback when the engine hasn't filled plan.health yet. */
function fallbackHealth(p: Plan, today: Date): Health {
  if (p.start_date && today < parseISO(p.start_date)) return "waiting";
  if (p.kind === "stream") return "stream";
  if (!p.start_date || !p.end_date) return "on_track";
  const s = parseISO(p.start_date);
  const e = parseISO(p.end_date);
  const total = Math.max(1, daysBetween(s, e));
  const elapsed = daysBetween(s, today);
  const expected = Math.min(1, Math.max(0, elapsed / total));
  const diff = (p.effective_progress ?? p.progress ?? 0) - expected;
  if (diff >= -0.05) return "on_track";
  if (diff > -0.2) return "at_risk";
  return "late";
}

/** Engine-based health from the backend, falling back to the interim rule. */
function healthOf(p: Plan, today: Date): Health {
  return (p.health as Health | undefined) ?? fallbackHealth(p, today);
}

const healthColor: Record<Health, string> = {
  waiting: "hsl(var(--muted-foreground))",
  on_track: "hsl(var(--status-ok))",
  at_risk: "hsl(var(--status-warn))",
  late: "hsl(var(--status-late))",
  stream: "hsl(var(--primary))",
};

export function PlanBoardClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [milestones, setMilestones] = useState<PlanMilestone[]>([]);
  const [holidays, setHolidays] = useState<{ blocked_date: string; reason: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [access, setAccess] = useState<PlanAccessLevel>("lite");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorPlan, setEditorPlan] = useState<Plan | null>(null);
  const [milestonesOpen, setMilestonesOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name_he: string }[]>([]);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [mobileTimeline, setMobileTimeline] = useState(false);
  // Free-planning (edit) mode: drag bars, drag milestones, add rows inline.
  const [editMode, setEditMode] = useState(false);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<"list" | "gantt">("list");
  const [pageView, setPageView] = useState<"board" | "table">("board");
  const [zoom, setZoom] = useState(1); // board timeline column-width multiplier
  const canEdit = access === "full";
  const trackRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const [{ plans }, { access_level }, { milestones }, { holidays }, { templates }] = await Promise.all([
      api<{ plans: Plan[] }>("/api/plans/board"),
      api<{ access_level: PlanAccessLevel }>("/api/plans/access"),
      api<{ milestones: PlanMilestone[] }>("/api/plans/milestones"),
      api<{ holidays: { blocked_date: string; reason: string | null }[] }>("/api/plans/holidays"),
      api<{ templates: { id: string; name_he: string }[] }>("/api/plan/templates").catch(() => ({ templates: [] })),
    ]);
    setPlans(plans ?? []);
    setAccess(access_level ?? "lite");
    setMilestones(milestones ?? []);
    setHolidays(holidays ?? []);
    setTemplates(templates ?? []);
    if (plans?.length) setSelectedId((cur) => cur ?? plans[0].id);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load();
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // Let the board use the full main width (and grow with the window) instead of
  // the global 896px reading cap — see globals.css [data-content-wide].
  useEffect(() => {
    document.body.setAttribute("data-content-wide", "true");
    return () => document.body.removeAttribute("data-content-wide");
  }, []);

  async function recompute() {
    setRecomputing(true);
    try {
      await api("/api/plans/recompute", { method: "POST" });
      await load();
      toast.success(t("recomputed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setRecomputing(false);
    }
  }

  async function setStatus(id: string, status: PlanStatus) {
    try {
      await api(`/api/plans/${id}`, { method: "PATCH", body: { status } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function setAvailable(id: string, is_available: boolean) {
    try {
      await api(`/api/plans/${id}`, { method: "PATCH", body: { is_available } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  // Done capabilities leave the active board and live on the "available" shelf;
  // everything else (incl. done deliverables/events) stays on the timeline.
  const shelfPlans = useMemo(() => plans.filter((p) => p.is_capability && p.status === "done"), [plans]);
  const boardPlans = useMemo(() => plans.filter((p) => !(p.is_capability && p.status === "done")), [plans]);

  // Timeline bounds from the data (fallback: today .. +90d).
  const { t0, totalDays } = useMemo(() => {
    const starts = boardPlans.map((p) => p.start_date).filter(Boolean) as string[];
    const ends = boardPlans.map((p) => p.end_date).filter(Boolean) as string[];
    if (!starts.length) {
      const now = new Date();
      return { t0: now, totalDays: 90 };
    }
    const minS = starts.reduce((a, b) => (a < b ? a : b));
    const maxE = (ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : minS);
    const start = parseISO(minS);
    const end = parseISO(maxE);
    return { t0: start, totalDays: Math.max(14, daysBetween(start, end) + 7) };
  }, [boardPlans]);

  const colPx = Math.round(COL_BASE * zoom);
  const tl = useTimeline(t0, totalDays, colPx);
  const { cols, dateAt, offsetOf, xOf, trackWidth } = tl;
  /** Percentage position (for the responsive mobile sparkline that fits its container). */
  const pctOf = (off: number) => `${Math.min(100, Math.max(0, (off / totalDays) * 100))}%`;
  // "Today" is the real today (the projection slider was removed — health comes
  // from the engine's latest dates, not from sliding a frozen-progress clock).
  const today = useMemo(() => new Date(), []);
  const todayOff = daysBetween(t0, today);
  const todayInView = todayOff >= 0 && todayOff <= totalDays;
  // translateX is PHYSICAL (doesn't mirror in RTL), so center a date-anchored
  // element direction-aware: shift left in LTR, right in RTL, to sit over its x.
  const centerTx = locale === "he" ? "translateX(50%)" : "translateX(-50%)";
  const editing = editMode && canEdit;

  // ── edit-mode mutations ────────────────────────────────────────────────────

  // Undo/redo for every edit-mode action. Each mutation is recorded as a command
  // (redo = the action, undo = its inverse); the first run goes through the same
  // path as redo. histKeyOf/histResolve keep references stable across a
  // create→undo→redo (which assigns a fresh server id).
  const history = useHistory();
  const { run: histRun, undo: histUndo, redo: histRedo, reset: histReset, resolve: histResolve, keyOf: histKeyOf, bind: histBind } = history;

  const runCmd = useCallback(
    (cmd: HistoryCmd) => histRun(cmd).catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await load(); }),
    [histRun, load],
  );
  const doUndo = useCallback(
    () => histUndo().catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await load(); }),
    [histUndo, load],
  );
  const doRedo = useCallback(
    () => histRedo().catch(async (e) => { toast.error(e instanceof Error ? e.message : "Error"); await load(); }),
    [histRedo, load],
  );

  // Keyboard: ⌘/Ctrl+Z = undo, ⌘/Ctrl+Shift+Z or Ctrl+Y = redo (edit mode only,
  // and never while typing in a field).
  useEffect(() => {
    if (!(editMode && canEdit)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      if (k === "y" || (k === "z" && e.shiftKey)) doRedo();
      else doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, canEdit, doUndo, doRedo]);

  // Drag/resize a plan window → pin its start_date/end_date. The engine reruns
  // on the PATCH (autoRecompute) and fills everything we didn't touch.
  const commitPlanDates = useCallback(
    async (id: string, startOff: number, endOff: number) => {
      const cur = plans.find((p) => p.id === id);
      if (!cur) return;
      const oldStart = cur.start_date;
      const oldEnd = cur.end_date;
      const start_date = isoOf(dateAt(startOff));
      const end_date = isoOf(dateAt(Math.max(startOff, endOff)));
      if (start_date === oldStart && end_date === oldEnd) return;
      const key = histKeyOf(id);
      const setDates = async (s: string | null, e: string | null) => {
        const live = histResolve(key);
        setPlans((ps) => ps.map((p) => (p.id === live ? { ...p, start_date: s, end_date: e } : p)));
        await api(`/api/plans/${live}`, { method: "PATCH", body: { start_date: s, end_date: e } });
        await load();
      };
      await runCmd({ label: t("edit.actDates"), redo: () => setDates(start_date, end_date), undo: () => setDates(oldStart, oldEnd) });
    },
    [plans, dateAt, load, histKeyOf, histResolve, runCmd, t],
  );

  const commitMilestoneDate = useCallback(
    async (id: string, startOff: number) => {
      const cur = milestones.find((m) => m.id === id);
      if (!cur) return;
      const oldDate = cur.milestone_date;
      const milestone_date = isoOf(dateAt(startOff));
      if (milestone_date === oldDate) return;
      const key = histKeyOf(id);
      const setDate = async (d: string) => {
        const live = histResolve(key);
        setMilestones((ms) => ms.map((m) => (m.id === live ? { ...m, milestone_date: d } : m)));
        await api(`/api/plan-milestones/${live}`, { method: "PATCH", body: { milestone_date: d } });
        await load();
      };
      await runCmd({ label: t("edit.actMilestoneMove"), redo: () => setDate(milestone_date), undo: () => setDate(oldDate) });
    },
    [milestones, dateAt, load, histKeyOf, histResolve, runCmd, t],
  );

  const planDrag = useGanttDrag(tl, locale, trackRef, commitPlanDates);
  const msDrag = useGanttDrag(tl, locale, trackRef, (id, startOff) => commitMilestoneDate(id, startOff));

  function saveTitle(id: string, title: string) {
    const trimmed = title.trim();
    setEditingTitleId(null);
    const cur = plans.find((p) => p.id === id);
    if (!trimmed || !cur || trimmed === cur.title_he) return;
    const oldTitle = cur.title_he;
    const key = histKeyOf(id);
    const setTitle = async (val: string) => {
      const live = histResolve(key);
      setPlans((ps) => ps.map((p) => (p.id === live ? { ...p, title_he: val } : p)));
      await api(`/api/plans/${live}`, { method: "PATCH", body: { title_he: val } });
      await load();
    };
    runCmd({ label: t("edit.actRename"), redo: () => setTitle(trimmed), undo: () => setTitle(oldTitle) });
  }

  function newKey() {
    return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `tmp-${Date.now()}-${Math.random()}`;
  }

  function addMilestoneAt(planId: string | null, off: number) {
    const label = window.prompt(t("edit.mLabel"));
    if (!label || !label.trim()) return;
    const milestone_date = isoOf(dateAt(off));
    const label_he = label.trim();
    const key = newKey();
    const create = async () => {
      // Optimistic: show the pin immediately (keyed by the stable key), then swap
      // in the real id when the POST returns — no full board reload.
      setMilestones((ms) => [
        ...ms.filter((m) => m.id !== histResolve(key) && m.id !== key),
        { id: key, plan_id: planId, milestone_date, label_he, label_en: null, color: null, constrains_user_id: null },
      ]);
      const { milestone } = await api<{ milestone: { id: string } }>("/api/plans/milestones", {
        method: "POST",
        body: { milestone_date, label_he, plan_id: planId },
      });
      if (milestone?.id) {
        histBind(key, milestone.id);
        setMilestones((ms) => ms.map((m) => (m.id === key ? { ...m, id: milestone.id } : m)));
      }
    };
    const remove = async () => {
      const live = histResolve(key);
      setMilestones((ms) => ms.filter((m) => m.id !== live && m.id !== key));
      await api(`/api/plan-milestones/${live}`, { method: "DELETE" });
    };
    runCmd({ label: t("edit.actMilestoneAdd"), redo: create, undo: remove });
  }

  function deleteMilestone(id: string) {
    const m = milestones.find((x) => x.id === id);
    if (!m) return;
    const key = histKeyOf(id);
    const remove = async () => {
      const live = histResolve(key);
      setMilestones((ms) => ms.filter((x) => x.id !== live));
      await api(`/api/plan-milestones/${live}`, { method: "DELETE" });
      if (m.constrains_user_id) await load(); // a worker-constraint relaxes the schedule
    };
    const recreate = async () => {
      setMilestones((ms) => [...ms.filter((x) => x.id !== m.id), m]);
      const { milestone } = await api<{ milestone: { id: string } }>("/api/plans/milestones", {
        method: "POST",
        body: {
          milestone_date: m.milestone_date,
          label_he: m.label_he,
          label_en: m.label_en,
          color: m.color,
          plan_id: m.plan_id,
          constrains_user_id: m.constrains_user_id ?? null,
        },
      });
      if (milestone?.id) {
        histBind(key, milestone.id);
        setMilestones((ms) => ms.map((x) => (x.id === m.id ? { ...x, id: milestone.id } : x)));
      }
      if (m.constrains_user_id) await load();
    };
    runCmd({ label: t("edit.actMilestoneDel"), redo: remove, undo: recreate });
  }

  function quickAddPlan(kind: "effort" | "stream", is_capability: boolean) {
    setAddRowOpen(false);
    const start = today;
    const end = new Date(today.getTime() + 14 * DAY_MS);
    const key = newKey();
    const create = async () => {
      const { plan } = await api<{ plan: Plan }>("/api/plans", {
        method: "POST",
        body: {
          title_he: t("edit.newRowTitle"),
          kind,
          is_capability,
          status: "draft",
          start_date: isoOf(start),
          end_date: isoOf(end),
        },
      });
      if (plan?.id) {
        histBind(key, plan.id);
        setSelectedId(plan.id);
        setEditingTitleId(plan.id);
      }
      await load();
    };
    const remove = async () => {
      await api(`/api/plans/${histResolve(key)}`, { method: "DELETE" });
      await load();
    };
    runCmd({ label: t("edit.actAddRow"), redo: create, undo: remove });
  }

  async function quickApplyTemplate(templateId: string) {
    setAddRowOpen(false);
    try {
      const { plan } = await api<{ plan: Plan }>(`/api/plan/templates/${templateId}/apply`, {
        method: "POST",
        body: { start_date: isoOf(today) },
      });
      await load();
      // Applying a template isn't itself undoable; drop any stale redo history so
      // a later Redo can't replay against the now-changed board.
      histReset();
      if (plan?.id) setSelectedId(plan.id);
      toast.success(t("templates.applied"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  // Top edge of the day-strip = below the milestone lane (h-8=32px, only when
  // present) + month band (h-5=20px). Column washes (today, holidays) start here
  // so they don't rise into the header.
  const laneTop = (milestones.length > 0 ? 32 : 0) + 20;

  // Month band segments — a new segment starts whenever the Gregorian OR the
  // Hebrew month changes, so both calendars are tracked on one slim row.
  const monthSegments = useMemo(() => {
    const segs: { start: number; end: number; label: string }[] = [];
    cols.forEach((o, i) => {
      const d = new Date(t0.getTime() + o * DAY_MS);
      const label = `${gregMonthLabel(d, locale)} · ${hebMonth(d)}`;
      const last = segs[segs.length - 1];
      if (last && last.label === label) last.end = i + 1;
      else segs.push({ start: i, end: i + 1, label });
    });
    return segs;
  }, [cols, t0, locale]);

  // Holiday (no-work) markers. The weekend is already hidden; these are the
  // calendar holidays (Israeli yom tov + org rows) that fall on a Mon–Fri.
  const holidayByDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of holidays) m.set(h.blocked_date, h.reason || t("holiday"));
    return m;
  }, [holidays, t]);

  // Contiguous holiday columns merged into one span (so a multi-day chag shows
  // its hatch as one block and its name once).
  const holidaySpans = useMemo(() => {
    const spans: { start: number; end: number; label: string }[] = [];
    cols.forEach((o, i) => {
      const label = holidayByDate.get(isoOf(dateAt(o)));
      if (!label) return;
      const last = spans[spans.length - 1];
      if (last && last.end === i && last.label === label) last.end = i + 1;
      else spans.push({ start: i, end: i + 1, label });
    });
    return spans;
  }, [cols, holidayByDate, dateAt]);

  // Milestones split into global (cross every row) and per-plan.
  const { globalMilestones, milestonesByPlan } = useMemo(() => {
    const globalMilestones: PlanMilestone[] = [];
    const milestonesByPlan = new Map<string, PlanMilestone[]>();
    for (const m of milestones) {
      if (!m.plan_id) globalMilestones.push(m);
      else {
        if (!milestonesByPlan.has(m.plan_id)) milestonesByPlan.set(m.plan_id, []);
        milestonesByPlan.get(m.plan_id)!.push(m);
      }
    }
    return { globalMilestones, milestonesByPlan };
  }, [milestones]);
  const lineColor = (m: PlanMilestone) => m.color || "hsl(var(--muted-foreground))";
  const mLabel = (m: PlanMilestone) => (locale === "en" ? m.label_en || m.label_he : m.label_he);

  // Group plans by group_label, preserving first-seen order.
  const groups = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of boardPlans) {
      const key = p.group_label || "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()];
  }, [boardPlans]);

  const selected = plans.find((p) => p.id === selectedId) ?? null;

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{t("title")}</h1>
          <p className="text-[12.5px] text-muted-foreground">{t("lead")}</p>
        </div>
        <div className="flex gap-1 rounded-lg border bg-card p-1">
          {(["board", "table"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setPageView(v)}
              className={cn(
                "rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors",
                pageView === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {t(`pageView.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {pageView === "table" ? (
        <PlanTableView locale={locale} canEdit={canEdit} onChanged={load} />
      ) : (
      <>
      {access === "lite" && (
        <div className="rounded-lg border bg-secondary px-3 py-2 text-[12px] text-muted-foreground">
          {t("liteNotice")}
        </div>
      )}

      {/* controls */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-3">
        <span className="whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-[13px] font-bold text-accent-foreground">
          {t("today")}: {gregShort(today)} · {hebDate(today)}
        </span>
        <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
          <LegendDot color="hsl(var(--muted-foreground))" label={t("legend.waiting")} />
          <LegendDot color="hsl(var(--status-ok))" label={t("legend.onTrack")} />
          <LegendDot color="hsl(var(--status-warn))" label={t("legend.atRisk")} />
          <LegendDot color="hsl(var(--status-late))" label={t("legend.late")} />
        </div>
        {/* zoom — available in both view and edit modes */}
        <div className="flex items-center gap-1">
          <ControlButton onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} disabled={zoom <= 0.5} title={t("zoomOut")}>
            <ZoomOut className="h-3.5 w-3.5" />
          </ControlButton>
          <span className="w-9 text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <ControlButton onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.25).toFixed(2)))} disabled={zoom >= 2.5} title={t("zoomIn")}>
            <ZoomIn className="h-3.5 w-3.5" />
          </ControlButton>
        </div>
        {canEdit && (
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {editing && (
              <ControlButton
                onClick={doUndo}
                disabled={!history.canUndo}
                title={history.nextUndoLabel ? `${t("edit.undo")}: ${history.nextUndoLabel}` : t("edit.undo")}
              >
                <Undo2 className="h-3.5 w-3.5" /> {t("edit.undo")}
              </ControlButton>
            )}
            {editing && (
              <ControlButton
                onClick={doRedo}
                disabled={!history.canRedo}
                title={history.nextRedoLabel ? `${t("edit.redo")}: ${history.nextRedoLabel}` : t("edit.redo")}
              >
                <Redo2 className="h-3.5 w-3.5" /> {t("edit.redo")}
              </ControlButton>
            )}
            {editing && (
              <div className="relative">
                <ControlButton onClick={() => setAddRowOpen((o) => !o)}>
                  <Plus className="h-3.5 w-3.5" /> {t("edit.addRow")}
                </ControlButton>
                {addRowOpen && (
                  <div className="absolute end-0 z-20 mt-1 w-44 rounded-lg border bg-card p-1 shadow-lg">
                    <p className="px-2 py-1 text-[11px] font-bold text-muted-foreground">{t("edit.pickKind")}</p>
                    <RowKindButton onClick={() => quickAddPlan("effort", false)}>{t("kind.effort")}</RowKindButton>
                    <RowKindButton onClick={() => quickAddPlan("stream", false)}>{t("kind.stream")}</RowKindButton>
                    <RowKindButton onClick={() => quickAddPlan("effort", true)}>{t("capability.field")}</RowKindButton>
                    {templates.length > 0 && (
                      <>
                        <p className="mt-1 border-t px-2 pb-1 pt-1.5 text-[11px] font-bold text-muted-foreground">{t("templates.fromTemplate")}</p>
                        {templates.map((tpl) => (
                          <RowKindButton key={tpl.id} onClick={() => quickApplyTemplate(tpl.id)}>{tpl.name_he}</RowKindButton>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            <ControlButton onClick={() => { setEditorPlan(null); setEditorOpen(true); }}>
              <Plus className="h-3.5 w-3.5" /> {t("edit.newPlan")}
            </ControlButton>
            <ControlButton onClick={() => setMilestonesOpen(true)}>
              <Flag className="h-3.5 w-3.5" /> {t("edit.editMilestones")}
            </ControlButton>
            <ControlButton onClick={() => setRolesOpen(true)}>
              <UserCog className="h-3.5 w-3.5" /> {t("roles.button")}
            </ControlButton>
            <ControlButton onClick={() => setTemplatesOpen(true)}>
              <LayoutTemplate className="h-3.5 w-3.5" /> {t("templates.button")}
            </ControlButton>
            <ControlButton onClick={recompute} disabled={recomputing}>
              <RefreshCw className={cn("h-3.5 w-3.5", recomputing && "animate-spin")} />
              {recomputing ? t("recomputing") : t("recompute")}
            </ControlButton>
            <button
              onClick={() => { setEditMode((v) => !v); setAddRowOpen(false); setEditingTitleId(null); histReset(); }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                editing ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-accent",
              )}
            >
              <Pencil className="h-3.5 w-3.5" /> {editing ? t("edit.exitEdit") : t("edit.editMode")}
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
          {t("edit.editHint")}
        </div>
      )}

      {/* available-capabilities shelf — done one-time tools, off the timeline */}
      {shelfPlans.length > 0 && (
        <div className="rounded-xl border bg-card">
          <button
            onClick={() => setShelfOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] font-medium text-muted-foreground"
          >
            {shelfOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {t("capability.shelf")} ({shelfPlans.length})
          </button>
          {shelfOpen && (
            <div className="flex flex-wrap gap-2 border-t p-3">
              {shelfPlans.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                    p.is_available
                      ? "border-status-ok/40 bg-status-ok/10 text-status-ok"
                      : "border-status-late/40 bg-status-late/10 text-status-late",
                    selectedId === p.id && "ring-2 ring-primary/40",
                  )}
                >
                  {p.is_available ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                  {planTitle(p, locale)}
                  {!p.is_available && <span className="text-[10px]">· {t("capability.unavailable")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {boardPlans.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center">
          <p className="text-sm font-medium">{t("board.empty")}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{t("board.emptyHint")}</p>
        </div>
      ) : (
        <>
        {/* mobile view toggle — list (default) vs the scrollable timeline */}
        <div className="flex gap-1 rounded-lg border bg-card p-1 md:hidden">
          {([["list", false], ["timeline", true]] as const).map(([key, on]) => (
            <button
              key={key}
              onClick={() => setMobileTimeline(on)}
              className={cn(
                "flex-1 rounded-md py-1.5 text-[12.5px] font-medium transition-colors",
                mobileTimeline === on ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {t(`view.${key}`)}
            </button>
          ))}
        </div>

        {/* mobile card list — comfortable on a phone, no horizontal scroll */}
        {!mobileTimeline && (
          <div className="space-y-4 md:hidden">
            {groups.map(([label, rows]) => (
              <div key={label}>
                <p className="mb-1.5 px-1 text-[12px] font-bold text-foreground/80">{label}</p>
                <div className="space-y-2">
                  {rows.map((p) => {
                    const h = healthOf(p, today);
                    const s = p.start_date ? offsetOf(p.start_date) : 0;
                    const e = p.end_date ? offsetOf(p.end_date) : s + 7;
                    const span = Math.max(1, e - s);
                    const progress = p.effective_progress ?? p.progress ?? 0;
                    const due = p.end_date;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "block w-full rounded-xl border bg-card p-3 text-start",
                          selectedId === p.id && "ring-2 ring-primary/40",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: healthColor[h] }} />
                          <span className="flex-1 truncate text-[14px] font-bold">{planTitle(p, locale)}</span>
                          {p.is_critical && (
                            <span className="rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                              {t("tags.critical")}
                            </span>
                          )}
                          <StatusBadge status={p.status} t={t} />
                          <span className="whitespace-nowrap text-[10.5px] font-medium" style={{ color: healthColor[h] }}>
                            {t(`health.${h}`)}
                          </span>
                        </div>
                        {p.kind !== "stream" && (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-secondary">
                            <div className="h-full rounded" style={{ width: `${progress * 100}%`, background: p.color || "#534AB7" }} />
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
                          <span className="truncate">{p.goal}</span>
                          {due && (
                            <span className="whitespace-nowrap">
                              {countdownText(due, t, today)} · {gregShort(parseISO(due))} · {hebDate(parseISO(due))}
                            </span>
                          )}
                        </div>
                        {/* mini timeline sparkline: plan span + milestone ticks + today */}
                        <div className="relative mt-2 h-2 w-full overflow-hidden rounded bg-secondary/60">
                          <div
                            className="absolute inset-y-0 rounded"
                            style={{ insetInlineStart: pctOf(s), width: pctOf(span), background: (p.color || "#534AB7") + "88" }}
                          />
                          {[...globalMilestones, ...(milestonesByPlan.get(p.id) ?? [])].map((m) => (
                            <div
                              key={m.id}
                              className="absolute inset-y-0 w-0.5"
                              style={{ insetInlineStart: pctOf(offsetOf(m.milestone_date)), background: m.color || "hsl(var(--muted-foreground))" }}
                              title={locale === "en" ? m.label_en || m.label_he : m.label_he}
                            />
                          ))}
                          {todayInView && (
                            <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ insetInlineStart: pctOf(todayOff) }} />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          className={cn(
            mobileTimeline ? "flex" : "hidden",
            "overflow-hidden rounded-xl border bg-card md:flex",
          )}
        >
          {/* fixed label column (stays while the timeline scrolls) */}
          <div className="w-[168px] flex-shrink-0 border-e">
            {milestones.length > 0 && (
              <div className="flex h-8 items-center border-b bg-secondary/40 px-3 text-[11px] font-medium text-muted-foreground">
                {t("board.milestones")}
              </div>
            )}
            <div className="h-5 border-b bg-secondary/40" />
            <div className="flex h-12 items-center border-b bg-secondary/60 px-3 text-[12px] font-bold text-muted-foreground">
              {t("title")}
            </div>
            {groups.map(([label, rows]) => (
              <div key={label}>
                <div className="flex h-[30px] items-center bg-secondary px-3 text-[12px] font-bold text-foreground/80">
                  {label}
                </div>
                {rows.map((p) => {
                  const h = healthOf(p, today);
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "flex h-[52px] w-full flex-col justify-center gap-1 overflow-hidden border-b px-3 text-start transition-colors",
                        !editing && "cursor-pointer hover:bg-accent/40",
                        selectedId === p.id && "bg-accent/60",
                      )}
                      onClick={() => { if (editingTitleId !== p.id) setSelectedId(p.id); }}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-bold" title={planTitle(p, locale)}>
                        {editing && editingTitleId === p.id ? (
                          <input
                            autoFocus
                            defaultValue={p.title_he}
                            dir="rtl"
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => saveTitle(p.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              if (e.key === "Escape") setEditingTitleId(null);
                            }}
                            className="w-full rounded border border-input bg-background px-1 py-0.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        ) : (
                          <span
                            className={cn("truncate", editing && "cursor-text rounded px-0.5 hover:bg-accent")}
                            onClick={editing ? (e) => { e.stopPropagation(); setEditingTitleId(p.id); } : undefined}
                          >
                            {planTitle(p, locale)}
                          </span>
                        )}
                        {p.is_critical && (
                          <span className="shrink-0 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                            {t("tags.critical")}
                          </span>
                        )}
                        <StatusBadge status={p.status} t={t} />
                      </span>
                      <span
                        className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] font-medium"
                        style={{ color: healthColor[h] }}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: healthColor[h] }} />
                        {t(`health.${h}`)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* scrollable timeline */}
          <div className="flex-1 overflow-x-auto">
            <div ref={trackRef} className="relative" style={{ width: trackWidth }}>
              {/* holiday (no-work) marker — only on the date cell itself (the
                  day strip), not down the whole column. Name shown on hover. */}
              {holidaySpans.map((h) => (
                <div
                  key={`hol-${h.start}`}
                  className="pointer-events-none absolute z-[6]"
                  style={{
                    insetInlineStart: h.start * colPx,
                    width: (h.end - h.start) * colPx,
                    top: laneTop,
                    height: 48, // the h-12 day-strip cell only
                    backgroundImage:
                      "repeating-linear-gradient(45deg, hsl(var(--primary) / 0.18) 0 3px, transparent 3px 7px)",
                  }}
                  title={h.label}
                />
              ))}
              {/* today column — a translucent grey wash over the whole day,
                  transparent enough to read the bars and labels underneath. */}
              {todayInView && (
                <div
                  className="pointer-events-none absolute bottom-0 z-[7]"
                  style={{
                    insetInlineStart: xOf(todayOff),
                    width: colPx,
                    top: laneTop,
                    background: "rgba(115,115,115,0.15)",
                  }}
                />
              )}
              {/* milestone label lane — pills centered on their date, each on a
                  short stem so it's clear exactly when it happens (no stacking). */}
              {milestones.length > 0 && (
                <div className="relative h-8 border-b bg-secondary/40">
                  {milestones.map((m) => {
                    const pcol = msDrag.preview?.id === m.id ? msDrag.preview.startCol * colPx : xOf(offsetOf(m.milestone_date));
                    return (
                      <div key={m.id}>
                        <div
                          className={cn(
                            "group absolute top-1 z-[8] inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold",
                            editing && "cursor-grab active:cursor-grabbing",
                          )}
                          style={{
                            insetInlineStart: pcol,
                            transform: centerTx,
                            color: lineColor(m),
                            background: "hsl(var(--card))",
                            border: `1px solid ${lineColor(m)}`,
                          }}
                          title={mLabel(m)}
                          onPointerDown={editing ? (e) => msDrag.onPointerDown(e, m.id, offsetOf(m.milestone_date), offsetOf(m.milestone_date), "move") : undefined}
                        >
                          {mLabel(m)}
                          {editing && (
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteMilestone(m.id); }}
                              onPointerDown={(e) => e.stopPropagation()}
                              className="rounded text-muted-foreground hover:text-status-late"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        {/* stem anchoring the pill to the exact date */}
                        <div
                          className="absolute bottom-0 h-2 w-0"
                          style={{ insetInlineStart: pcol, borderInlineStart: `2px solid ${lineColor(m)}` }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              {/* month band — Gregorian + Hebrew month; a new segment (with a
                  divider) marks every point where either month changes. */}
              <div className="relative h-5 border-b bg-secondary/40">
                {monthSegments.map((seg) => {
                  const width = (seg.end - seg.start) * colPx;
                  return (
                    <div
                      key={seg.start}
                      className="absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[10px] font-semibold text-muted-foreground"
                      style={{
                        insetInlineStart: seg.start * colPx,
                        width,
                        borderInlineStart: seg.start !== 0 ? "2px solid hsl(var(--foreground) / 0.3)" : undefined,
                      }}
                    >
                      {width >= 52 ? seg.label : ""}
                    </div>
                  );
                })}
              </div>
              {/* day strip — one column per working day; Hebrew date on top,
                  Gregorian (day only) below. Thin line between days, a stronger
                  separator before each new week (Monday). */}
              <div className="relative h-12 border-b bg-secondary/60">
                {cols.map((o, i) => {
                  const d = dateAt(o);
                  const weekStart = d.getDay() === 1; // Monday — first working day of the week
                  return (
                    <div
                      key={o}
                      className="absolute top-0 flex h-full flex-col items-center justify-center gap-0.5 border-e"
                      style={{
                        insetInlineStart: i * colPx,
                        width: colPx,
                        // Thicker, darker divider before each new week (Monday).
                        ...(weekStart && i !== 0
                          ? { borderInlineStartWidth: 3, borderInlineStartStyle: "solid", borderInlineStartColor: "hsl(var(--foreground) / 0.22)" }
                          : {}),
                      }}
                    >
                      <span className="whitespace-nowrap text-[10.5px] font-medium">{hebDay(d)}</span>
                      <span className="whitespace-nowrap text-[9.5px] text-muted-foreground">{d.getDate()}</span>
                      <span className="whitespace-nowrap text-[9px] font-medium text-primary/55">{dowLetter(d, locale)}</span>
                    </div>
                  );
                })}
                {/* milestone date markers — a solid colored bar pinpointing the date.
                    Anchored by borderInlineStart at x (same as the stem & row lines)
                    so the whole column lines up exactly in both RTL and LTR. */}
                {milestones.map((m) => (
                  <div
                    key={m.id}
                    className="absolute inset-y-0 z-[3] w-0 opacity-70"
                    style={{ insetInlineStart: (msDrag.preview?.id === m.id ? msDrag.preview.startCol * colPx : xOf(offsetOf(m.milestone_date))), borderInlineStart: `2px solid ${lineColor(m)}` }}
                  />
                ))}
              </div>

              {groups.map(([label, rows]) => (
                <div key={label}>
                  <div className="h-[30px] border-b bg-secondary" />
                  {rows.map((p) => {
                    const pv = planDrag.preview?.id === p.id ? planDrag.preview : null;
                    const s = p.start_date ? offsetOf(p.start_date) : 0;
                    const e = p.end_date ? offsetOf(p.end_date) : s + 7;
                    const barStart = pv ? pv.startCol * colPx : xOf(s);
                    const barWidth = pv ? spanWidth(pv.startCol, pv.endCol, colPx) : Math.max(colPx, xOf(e) - xOf(s));
                    const progress = p.effective_progress ?? p.progress ?? 0;
                    const isStream = p.kind === "stream";
                    return (
                      <div
                        key={p.id}
                        onClick={(ev) => {
                          if (planDrag.didMove()) return;
                          if (editing) {
                            // Click on empty timeline space (not a bar) → add a milestone here.
                            const rect = trackRef.current?.getBoundingClientRect();
                            if (rect) addMilestoneAt(p.id, tl.offsetAtCol(tl.colUnderX(ev.clientX, rect, locale)));
                          } else {
                            setSelectedId(p.id);
                          }
                        }}
                        className={cn(
                          "relative block h-[52px] w-full border-b transition-colors",
                          editing ? "cursor-copy" : "cursor-pointer hover:bg-accent/30",
                          selectedId === p.id && "bg-accent/40",
                        )}
                      >
                        {/* one bar per project (effort + stream) */}
                        <div
                          className={cn(
                            "absolute top-2.5 h-8 overflow-hidden rounded-md border",
                            isStream && "border-dashed",
                            editing && "cursor-grab active:cursor-grabbing ring-1 ring-primary/40",
                          )}
                          style={{
                            insetInlineStart: barStart,
                            width: barWidth,
                            background: (p.color || "#534AB7") + "1f",
                            borderColor: (p.color || "#534AB7") + (isStream ? "99" : "55"),
                          }}
                          onClick={(ev) => { ev.stopPropagation(); if (!planDrag.didMove()) setSelectedId(p.id); }}
                          onPointerDown={editing ? (ev) => planDrag.onPointerDown(ev, p.id, s, e, "move") : undefined}
                        >
                          {!isStream && (
                            <div
                              className="pointer-events-none absolute inset-y-0 start-0 h-full"
                              style={{ width: `${progress * 100}%`, background: (p.color || "#534AB7") + "44" }}
                            />
                          )}
                          {editing && (
                            <>
                              <span
                                className="absolute inset-y-0 start-0 z-[2] w-1.5 cursor-ew-resize bg-primary/50"
                                onPointerDown={(ev) => planDrag.onPointerDown(ev, p.id, s, e, "resize-start")}
                              />
                              <span
                                className="absolute inset-y-0 end-0 z-[2] w-1.5 cursor-ew-resize bg-primary/50"
                                onPointerDown={(ev) => planDrag.onPointerDown(ev, p.id, s, e, "resize-end")}
                              />
                            </>
                          )}
                        </div>
                        <div
                          className="pointer-events-none absolute top-[22px] flex h-[18px] items-center whitespace-nowrap px-2 text-[11px] font-medium"
                          style={{ insetInlineStart: barStart, color: p.color || "#534AB7" }}
                        >
                          {isStream
                            ? p.goal || ""
                            : `${p.goal || ""}${p.goal ? "  ·  " : ""}${Math.round(progress * 100)}%`}
                        </div>
                        {/* milestone lines: global + this row's own */}
                        {[...globalMilestones, ...(milestonesByPlan.get(p.id) ?? [])].map((m) => (
                          <div
                            key={m.id}
                            className="pointer-events-none absolute inset-y-0 z-[4] w-0 opacity-40"
                            style={{
                              insetInlineStart: (msDrag.preview?.id === m.id ? msDrag.preview.startCol * colPx : xOf(offsetOf(m.milestone_date))),
                              borderInlineStart: `2px dashed ${lineColor(m)}`,
                            }}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
        </>
      )}

      {/* detail */}
      {selected && (
        <div className="rounded-xl border bg-card p-4">
          {canEdit && (
            <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
              {selected.status === "draft" && (
                <ControlButton onClick={() => setStatus(selected.id, "active")}>
                  <Check className="h-3.5 w-3.5" /> {t("status.approve")}
                </ControlButton>
              )}
              {selected.status === "active" && (
                <ControlButton onClick={() => setStatus(selected.id, "draft")}>
                  <Pencil className="h-3.5 w-3.5" /> {t("status.toDraft")}
                </ControlButton>
              )}
              {selected.is_capability && (
                <>
                  {/* where it lives: on the timeline (active) vs done/on the shelf */}
                  {selected.status === "active" && (
                    <ControlButton onClick={() => setStatus(selected.id, "done")}>
                      <Check className="h-3.5 w-3.5" /> {t("capability.markDone")}
                    </ControlButton>
                  )}
                  {selected.status === "done" && (
                    <ControlButton onClick={() => setStatus(selected.id, "active")}>
                      <RefreshCw className="h-3.5 w-3.5" /> {t("capability.returnToTimeline")}
                    </ControlButton>
                  )}
                  {/* availability is a SEPARATE switch — usable now or temporarily down */}
                  <ControlButton onClick={() => setAvailable(selected.id, !selected.is_available)}>
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {selected.is_available ? t("capability.markUnavailable") : t("capability.markAvailableAgain")}
                  </ControlButton>
                </>
              )}
              <ControlButton onClick={() => { setEditorPlan(selected); setEditorOpen(true); }}>
                <Pencil className="h-3.5 w-3.5" /> {t("edit.editPlan")}
              </ControlButton>
            </div>
          )}
          {selected.kind === "stream" ? (
            <PlanMatrix plan={selected} locale={locale} canEdit={canEdit} today={today} onChanged={load} />
          ) : (
            <>
              {/* list (rows + needs) vs gantt (bars + dependency arrows) */}
              <div className="mb-3 flex w-fit gap-1 rounded-lg border bg-card p-1">
                {([["list", "effort.viewList"], ["gantt", "effort.viewGantt"]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setDetailView(key)}
                    className={cn(
                      "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                      detailView === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              {detailView === "gantt" ? (
                <PlanTaskGantt key={selected.id} plan={selected} locale={locale} canEdit={canEdit} onChanged={load} />
              ) : (
                <PlanEffortDetail plan={selected} locale={locale} today={today} canEdit={canEdit} onChanged={load} />
              )}
            </>
          )}
        </div>
      )}

      <PlanEditDialog plan={editorPlan} open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={load} />
      <MilestoneEditor
        milestones={milestones}
        plans={plans}
        locale={locale}
        open={milestonesOpen}
        onClose={() => setMilestonesOpen(false)}
        onChanged={load}
      />
      <RolesEditor open={rolesOpen} onClose={() => setRolesOpen(false)} />
      <TemplatesEditor open={templatesOpen} onClose={() => setTemplatesOpen(false)} onChanged={load} />
      </>
      )}
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function RowKindButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12.5px] font-medium hover:bg-accent"
    >
      <Pin className="h-3.5 w-3.5 text-muted-foreground" />
      {children}
    </button>
  );
}

const STATUS_CHIP: Record<string, string> = {
  draft: "bg-amber-500/15 text-amber-600",
  done: "bg-status-ok/15 text-status-ok",
  archived: "bg-muted text-muted-foreground",
};

/** A small chip for a non-active plan status (draft / done / archived) only.
 *  Anything else — "active", undefined (e.g. an older API response that predates
 *  the status field), or an unknown value — renders nothing. */
function StatusBadge({ status, t }: { status: PlanStatus | undefined; t: (key: string) => string }) {
  if (!status || !STATUS_CHIP[status]) return null;
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-px text-[9px] font-bold", STATUS_CHIP[status])}>
      {t(`status.${status}`)}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
