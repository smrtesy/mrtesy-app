"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useOptionalPaneNav } from "@/lib/panes/nav";
import { Timer, X, Check, ClipboardList, CheckCircle2, ExternalLink, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DecisionDialog } from "./DecisionDialog";
import { DebriefDialog, type DebriefPayload } from "./DebriefDialog";

/** A plan task in the focus browser (from GET /plan/:id/focus-tasks). */
interface FocusTask {
  id: string;
  title: string;
  title_he: string | null;
  description?: string | null;
  status: string;
  blocked: boolean;
  blockers: string[];
  is_current: boolean;
  is_decision?: boolean | null;
  requires_debrief?: boolean | null;
}

/** Render one line of task-body markdown: **bold**, `code`, [text](url), and
 *  bare URLs. `code` is the key piece — English/config snippets (FAL_KEY=…,
 *  "Add key", env-var names) render as a left-to-right monospace chip, so a
 *  Hebrew (RTL) line no longer flips them (the "…=FAL_KEY" reversal). Deep links
 *  stay verbatim (product rule: never strip a URL to its domain). */
function renderInline(text: string): ReactNode[] {
  const TOKEN = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s]+)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > last) out.push(<span key={k++}>{text.slice(last, start)}</span>);
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={k++} className="font-semibold text-foreground">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={k++}
          dir="ltr"
          className="mx-0.5 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      const md = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const href = md ? md[2] : tok;
      const label = md ? md[1] : tok;
      out.push(
        <a key={k++} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 break-all">
          {label}
        </a>,
      );
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>);
  return out;
}

/** The primary "open this task in Claude Code" link, if the body carries one. */
function claudeLinkOf(description: string | null | undefined): string | null {
  return description?.match(/https?:\/\/claude\.ai\/code[^\s]*/)?.[0] ?? null;
}

/** The slash-command to type inside the Claude Code app, parsed from the link's
 *  prompt param (e.g. prompt=run%20%2Fprices → "/prices"). The browser prefills
 *  the box from the URL automatically, but the mobile app ignores query params,
 *  so we surface the command for the user to type there. */
function appCommandOf(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/[?&]prompt=([^&]+)/);
  if (!m) return null;
  const cmd = decodeURIComponent(m[1]).match(/\/[a-z][a-z-]*/);
  return cmd ? cmd[0] : null;
}

/** Render the task body as readable, scannable blocks: blank lines become
 *  spacing (via the container's space-y), a line that is only a Claude Code deep
 *  link is dropped (the prominent button already covers it), a short line ending
 *  with ':' becomes a sub-heading, and every other line is a paragraph with its
 *  URLs linkified. Keeps long text comfortable instead of one dense blob. */
function renderBody(description: string) {
  return description.split("\n").map((raw, i) => {
    const line = raw.trim();
    if (!line) return null;
    // The Claude Code deep link is covered by the button above — drop the line.
    if (/https?:\/\/claude\.ai\/code/.test(line)) return null;
    // Sub-items (indented in the source) get an extra hanging indent, like the doc.
    const indented = (raw.match(/^\s*/)?.[0].length ?? 0) >= 3;
    const pad = indented ? "ps-5" : "";
    // A line whose content is a single `code` span (e.g. `FAL_KEY=…`) is a
    // config value: force it left-to-right and left-aligned, like the GitHub
    // doc — otherwise the RTL layout parks it on the right.
    const codeOnly = (s: string) => /^`[^`]+`$/.test(s.trim());
    const bullet = line.match(/^[-•]\s+(.*)$/);
    if (bullet) {
      const ltr = codeOnly(bullet[1]);
      return (
        <div key={i} dir={ltr ? "ltr" : undefined} className={`flex gap-2 ${pad} ${ltr ? "text-left" : ""}`}>
          <span className="select-none text-muted-foreground">•</span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{renderInline(bullet[1])}</span>
        </div>
      );
    }
    const num = line.match(/^(\d+)\.\s+(.*)$/);
    if (num) {
      return (
        <div key={i} className={`flex gap-2 ${pad}`}>
          <span className="select-none font-medium text-foreground">{num[1]}.</span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{renderInline(num[2])}</span>
        </div>
      );
    }
    if (codeOnly(line)) {
      return <p key={i} dir="ltr" className={`text-left [overflow-wrap:anywhere] ${pad}`}>{renderInline(line)}</p>;
    }
    return <p key={i} className={`[overflow-wrap:anywhere] ${pad}`}>{renderInline(line)}</p>;
  });
}

function fmtClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.abs(totalSeconds);
  const m = Math.floor(s / 60);
  return `${sign}${m}:${String(s % 60).padStart(2, "0")}`;
}

/** A short two-tone chime via the Web Audio API — the marathon has no sound, so
 *  this is self-contained (no asset). Best-effort: silently no-ops if the
 *  browser blocks audio (e.g. no prior user gesture). */
function playChime() {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    [880, 1174].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    /* audio unavailable — the blocking overlay still shows */
  }
}

/**
 * Daily focus session over a smrtPlan plan (docs/day-tools-plan.md §8.5).
 * A fork of MarathonMode's full-screen shell, but single-plan and counting
 * DOWN from the daily commitment: it shows the current stage (first ready
 * task), lets you tick it off (which releases its dependents via the engine),
 * and at 0:00 plays a chime + a blocking overlay (done today / +5 min /
 * completed). The run is logged to focus_sessions.
 */
export function FocusSession({
  planId,
  planTitle,
  dailyMinutes,
  locale,
  onExit,
}: {
  planId: string;
  planTitle: string;
  dailyMinutes: number;
  locale: string;
  /** Close the session screen and refresh the desk. */
  onExit: () => void;
}) {
  // Inside a tabs-workspace pane the run must stay INSIDE the pane (the
  // user keeps other tabs usable beside it); full-page keeps the old
  // fullscreen takeover. The pane body div is position:relative.
  const overlayFrame = useOptionalPaneNav() ? "absolute inset-0" : "wa-panel-pushed fixed inset-0";
  const t = useTranslations("focusSession");
  const [targetSeconds, setTargetSeconds] = useState(dailyMinutes * 60);
  const [elapsed, setElapsed] = useState(0);
  const [tasks, setTasks] = useState<FocusTask[]>([]);
  const [idx, setIdx] = useState(0);
  const placedRef = useRef(false); // land on the current task once, on first load
  const [tasksCompleted, setTasksCompleted] = useState(0);
  const [blocking, setBlocking] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [debriefOpen, setDebriefOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  // The in-flight create, so an exit BEFORE it resolves can still await the id
  // and close the row (otherwise it'd be orphaned with ended_at=null).
  const createRef = useRef<Promise<string | null> | null>(null);
  const closedRef = useRef(false);
  const firedRef = useRef(false); // the 0:00 chime/overlay fires exactly once
  const startRef = useRef<number>(0); // wall-clock start, so the timer keeps

  // Open the session record + start the clock. Elapsed is derived from the wall
  // clock (not a per-second counter) so backgrounded-tab timer throttling can't
  // make it drift — when the tab returns, the next tick shows the true elapsed.
  useEffect(() => {
    if (!startRef.current) startRef.current = Date.now();
    createRef.current = api<{ session: { id: string } }>("/api/focus-sessions", {
      method: "POST",
      body: { plan_id: planId, planned_minutes: dailyMinutes },
    })
      .then((res) => { sessionIdRef.current = res.session.id; return res.session.id; })
      .catch(() => null); // the session still runs locally; only the log is lost
    const tick = () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    tick();
    const iv = setInterval(tick, 1000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [planId, dailyMinutes]);

  /** Load every task (plan order). On the FIRST load, land on the current
   *  (first-ready) task; later reloads keep the user where they are. */
  const loadTasks = useCallback(async (landOnCurrent = false) => {
    try {
      const { tasks: rows, currentId } = await api<{ tasks: FocusTask[]; currentId: string | null }>(
        `/api/plan/${planId}/focus-tasks`,
      );
      const list = rows ?? [];
      setTasks(list);
      if (landOnCurrent || !placedRef.current) {
        const at = currentId ? list.findIndex((x) => x.id === currentId) : -1;
        setIdx(at >= 0 ? at : 0);
        placedRef.current = true;
      } else {
        setIdx((i) => Math.min(i, Math.max(0, list.length - 1)));
      }
    } catch { /* keep the last list on a transient error */ }
  }, [planId]);
  useEffect(() => { void loadTasks(); }, [loadTasks]);

  const remaining = targetSeconds - elapsed;

  // At 0:00 — chime once + raise the blocking overlay.
  useEffect(() => {
    if (remaining <= 0 && !firedRef.current) {
      firedRef.current = true;
      playChime();
      setBlocking(true);
    }
  }, [remaining]);

  /** Close the focus_sessions row with the outcome, then leave. */
  const finish = useCallback(async (completedFull: boolean) => {
    if (closedRef.current) { onExit(); return; }
    closedRef.current = true;
    // If the open POST hasn't resolved yet, wait for it so the row is closed
    // rather than left orphaned (ended_at=null) — but don't hang forever.
    const id = sessionIdRef.current ?? (createRef.current ? await createRef.current : null);
    if (id) {
      try {
        await api(`/api/focus-sessions/${id}`, {
          method: "PATCH",
          body: {
            actual_minutes: Math.round(elapsed / 60),
            tasks_completed: tasksCompleted,
            completed_full: completedFull,
          },
        });
      } catch { /* non-fatal — the run happened, only the log update failed */ }
    }
    onExit();
  }, [elapsed, tasksCompleted, onExit]);

  const selected: FocusTask | null = tasks[idx] ?? null;

  /** Tick the selected task done → the engine releases its dependents → the
   *  next ready task surfaces. A decision task first asks for its outcome. */
  async function completeStage() {
    if (!selected || busy) return;
    if (selected.requires_debrief) { setDebriefOpen(true); return; }
    if (selected.is_decision) { setDecisionOpen(true); return; }
    await doCompleteStage();
  }

  async function doCompleteStage(decision?: string, debrief?: DebriefPayload) {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api(`/api/plan-tasks/${selected.id}/done`, {
        method: "PATCH",
        body: { done: true, ...(decision ? { decision } : {}), ...(debrief ? { debrief } : {}) },
      });
      setTasksCompleted((n) => n + 1);
      await loadTasks(true); // advance to the new current task
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const extend = () => {
    // "+5 minutes": push the target out and let the clock keep running. The
    // extension re-arms the 0:00 trigger so the chime fires again at the new end.
    setTargetSeconds((s) => s + 5 * 60);
    firedRef.current = false;
    setBlocking(false);
  };

  const doneCount = tasks.filter((tk) => tk.status === "completed" || tk.status === "archived").length;
  const selTitle = selected ? (locale === "he" && selected.title_he ? selected.title_he : selected.title) : null;
  const isDone = selected?.status === "completed" || selected?.status === "archived";
  const actionable = !!selected && !isDone && !selected.blocked;
  const claudeLink = actionable ? claudeLinkOf(selected?.description) : null;
  const appCommand = appCommandOf(claudeLink);
  const overtime = remaining < 0;

  /** The status chip for a task: done / blocked / today's / in-progress / upcoming. */
  function statusBadge(tk: FocusTask): { label: string; cls: string } {
    if (tk.status === "completed" || tk.status === "archived")
      return { label: t("statusDone"), cls: "bg-status-ok-bg text-status-ok" };
    if (tk.blocked)
      return { label: t("statusBlocked"), cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" };
    if (tk.is_current)
      return { label: t("statusCurrent"), cls: "bg-primary text-primary-foreground" };
    if (tk.status === "in_progress")
      return { label: t("statusInProgress"), cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" };
    return { label: t("statusUpcoming"), cls: "bg-muted text-muted-foreground" };
  }

  return (
    <div className={`${overlayFrame} z-50 flex flex-col bg-background`} dir={locale === "he" ? "rtl" : "ltr"}>
      {/* Header: count-down + plan + stages ticked + exit */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span
          className={cn("flex items-center gap-1.5 font-mono text-lg font-bold tabular-nums", overtime && "text-status-warn")}
          dir="ltr"
        >
          <Timer className="h-5 w-5" /> {fmtClock(remaining)}
        </span>
        <span className="truncate rounded-full bg-secondary px-2.5 py-0.5 text-sm font-medium text-muted-foreground" dir="auto">
          {planTitle}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t("progressDone", { done: doneCount, total: tasks.length })}
        </span>
        <Button variant="ghost" size="icon" className="ms-auto" onClick={() => void finish(false)} aria-label={t("exit")}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Browse row: prev/next arrows + position. RTL — "previous" sits right. */}
      {tasks.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            disabled={idx <= 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            aria-label={t("prevTask")}
          >
            <ChevronRight className="h-4 w-4" /> {t("prevTask")}
          </Button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" dir="ltr">
            {idx + 1} / {tasks.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            disabled={idx >= tasks.length - 1}
            onClick={() => setIdx((i) => Math.min(tasks.length - 1, i + 1))}
            aria-label={t("nextTask")}
          >
            {t("nextTask")} <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* The selected task — the WHOLE task: status + title + body + deep links. */}
      <div className="flex flex-1 flex-col items-center gap-5 overflow-y-auto px-6 py-8 text-center">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <ClipboardList className="h-6 w-6 text-primary" />
        </span>
        {selected && selTitle ? (
          <>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadge(selected).cls}`}>
              {statusBadge(selected).label}
            </span>
            <h2 className="max-w-xl text-2xl font-bold leading-snug" dir="auto">{selTitle}</h2>
            {selected.description ? (
              <div
                className="w-full max-w-2xl space-y-2 rounded-xl border bg-card p-5 text-start text-[15px] leading-7 text-foreground"
                dir="auto"
              >
                {renderBody(selected.description)}
              </div>
            ) : null}
            {selected.blocked && selected.blockers.length > 0 ? (
              <p className="flex max-w-xl items-center gap-1.5 text-[13px] text-muted-foreground" dir="auto">
                <Lock className="h-4 w-4 shrink-0" />
                {t("blockedBy")}: {selected.blockers.join(" · ")}
              </p>
            ) : null}
            {actionable ? (
              <>
                <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center">
                  {claudeLink ? (
                    <a
                      href={claudeLink}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-14 min-w-40 items-center justify-center gap-2 rounded-md border border-primary bg-primary/10 px-5 text-lg font-medium text-primary transition hover:bg-primary/20"
                    >
                      <ExternalLink className="h-5 w-5" /> {t("openInClaude")}
                    </a>
                  ) : null}
                  <Button
                    size="lg"
                    className="h-14 min-w-40 gap-2 bg-status-ok text-white hover:bg-status-ok/90 text-lg"
                    onClick={completeStage}
                    disabled={busy}
                  >
                    <Check className="h-5 w-5" /> {t("stageDone")}
                  </Button>
                </div>
                {appCommand ? (
                  <p className="text-[12px] text-muted-foreground" dir="auto">
                    {t("appHintPrefix")}
                    <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{appCommand}</code>
                    {t("appHintSuffix")}
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <p className="max-w-md text-lg text-muted-foreground" dir="auto">{t("noStage")}</p>
        )}
      </div>

      {/* 0:00 — blocking overlay + the three choices */}
      {blocking && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-background/95 px-6 text-center backdrop-blur">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-status-ok-bg">
            <CheckCircle2 className="h-8 w-8 text-status-ok" />
          </span>
          <h2 className="text-2xl font-bold" dir="auto">{t("timeUpTitle", { minutes: dailyMinutes })}</h2>
          <div className="flex flex-col items-stretch gap-2.5 sm:flex-row">
            <Button size="lg" className="min-w-40" onClick={() => void finish(false)}>{t("doneToday")}</Button>
            <Button size="lg" variant="outline" className="min-w-40" onClick={extend}>{t("fiveMore")}</Button>
            <Button size="lg" variant="ghost" className="min-w-40 text-status-ok" onClick={() => void finish(true)}>
              {t("completed")}
            </Button>
          </div>
        </div>
      )}

      <DecisionDialog
        open={decisionOpen}
        taskTitle={selTitle ?? ""}
        onClose={() => setDecisionOpen(false)}
        onConfirm={(decision) => { setDecisionOpen(false); void doCompleteStage(decision); }}
      />
      <DebriefDialog
        open={debriefOpen}
        taskTitle={selTitle ?? ""}
        onClose={() => setDebriefOpen(false)}
        onConfirm={(debrief) => { setDebriefOpen(false); void doCompleteStage(undefined, debrief); }}
      />
    </div>
  );
}
