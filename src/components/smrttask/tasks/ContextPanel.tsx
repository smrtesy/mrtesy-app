"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Sparkles, ClipboardList, ExternalLink, CheckCircle2, Clock, ArrowLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import type { Task, TaskNeed, TaskHandoff } from "@/types/task";

/**
 * The single "where did you come from" button of a task row/card:
 *   ✨ for AI-created tasks  → serial, source, classification, reasoning
 *   📋 for plan tasks        → plan/stage, chain position, schedule, board link
 *   (manual tasks get neither — there is nothing to explain)
 *
 * All identity metadata (serial number, source, size reasoning) lives HERE,
 * not as chips on the card — one button, one panel, everything inside.
 */

interface TrailResponse {
  source: {
    serial_display: string | null;
    source_type: string | null;
    source_url: string | null;
    sender: string | null;
    sender_email: string | null;
    subject: string | null;
    received_at: string | null;
    ai_classification: string | null;
  } | null;
  log: {
    classification_reason: string | null;
    ai_classification: string | null;
  } | null;
}

interface PlanDetailResponse {
  task: Task & {
    plan_title_he?: string | null;
    plan_title_en?: string | null;
    stage_name_he?: string | null;
    stage_name_en?: string | null;
    needs?: TaskNeed[];
    handoff?: TaskHandoff[];
  };
}

export type ContextKind = "ai" | "plan" | null;

export function contextKindOf(task: Pick<Task, "source_message_id" | "plan_id">): ContextKind {
  if (task.plan_id) return "plan";
  if (task.source_message_id) return "ai";
  return null;
}

export function ContextButton({
  task,
  locale,
  /** Optional extra action rendered at the panel footer (e.g. "dismiss & learn"). */
  footer,
  className,
}: {
  task: Task;
  locale: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("contextPanel");
  const kind = contextKindOf(task);
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<TrailResponse | null>(null);
  const [plan, setPlan] = useState<PlanDetailResponse["task"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (!next || trail || plan || loading) return;
    setLoading(true);
    setError(null);
    try {
      if (kind === "ai") {
        setTrail(await api<TrailResponse>(`/api/tasks/${task.id}/trail`));
      } else if (kind === "plan") {
        const res = await api<PlanDetailResponse>(`/api/plan-tasks/${task.id}/detail`);
        setPlan(res.task);
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, trail, plan, loading, kind, task.id]);

  if (!kind) return null;

  const Icon = kind === "ai" ? Sparkles : ClipboardList;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        title={kind === "ai" ? t("aiTitle") : t("planTitle")}
        aria-expanded={open}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
          open && "bg-accent text-foreground",
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          className="w-full basis-full rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1.5"
          dir="auto"
          onClick={(e) => e.stopPropagation()}
        >
          {loading && <p className="text-muted-foreground">{t("loading")}</p>}
          {error && <p className="text-status-late">{error}</p>}

          {kind === "ai" && trail && (
            <AIPanelBody trail={trail} task={task} locale={locale} t={t} />
          )}
          {kind === "plan" && plan && (
            <PlanPanelBody plan={plan} locale={locale} t={t} />
          )}

          {footer && <div className="pt-1 border-t border-border/40">{footer}</div>}
        </div>
      )}
    </>
  );
}

function AIPanelBody({
  trail, task, locale, t,
}: {
  trail: TrailResponse;
  task: Task;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const source = trail.source;
  const log = trail.log;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        {task.serial_display && <span className="font-mono">{task.serial_display}</span>}
        {source?.source_type && <span>· {source.source_type}</span>}
        {source?.received_at && <span>· {new Date(source.received_at).toLocaleString(locale === "he" ? "he-IL" : "en-US")}</span>}
        <SourceLink source={task.source_messages ?? null} stopPropagation />
      </div>
      {source?.subject && (
        <div><span className="text-muted-foreground/70">{t("subject")}: </span>{source.subject}</div>
      )}
      {(source?.sender || source?.sender_email) && (
        <div>
          <span className="text-muted-foreground/70">{t("from")}: </span>
          {source.sender || source.sender_email}
        </div>
      )}
      {log?.ai_classification && (
        <div><span className="text-muted-foreground/70">{t("classification")}: </span><span className="font-medium">{log.ai_classification}</span></div>
      )}
      <div>
        <span className="text-muted-foreground/70">{t("size")}: </span>
        {task.size === "quick" ? t("sizeQuick") : t("sizeRegular")}
      </div>
      {log?.classification_reason && (
        <div>
          <span className="text-muted-foreground/70">{t("reason")}: </span>
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{log.classification_reason}</p>
        </div>
      )}
    </>
  );
}

function PlanPanelBody({
  plan, locale, t,
}: {
  plan: PlanDetailResponse["task"];
  locale: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const planTitle = locale === "en"
    ? plan.plan_title_en || plan.plan_title_he
    : plan.plan_title_he || plan.plan_title_en;
  const stageName = locale === "en"
    ? plan.stage_name_en || plan.stage_name_he
    : plan.stage_name_he || plan.stage_name_en;
  const needs = plan.needs ?? [];
  const handoff = plan.handoff ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{[planTitle, stageName].filter(Boolean).join(" / ")}</span>
        {plan.is_critical && (
          <span className="rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
            {t("critical")}
          </span>
        )}
        {plan.duration_days != null && (
          <span className="text-muted-foreground">· {t("duration", { days: plan.duration_days })}</span>
        )}
      </div>

      {(needs.length > 0 || handoff.length > 0) && (
        <div className="space-y-1">
          <div className="text-[11px] font-bold text-muted-foreground">{t("chain")}</div>
          {needs.map((n) => (
            <div key={n.dependency_id} className="flex items-center gap-1.5">
              {n.satisfied
                ? <CheckCircle2 className="h-3 w-3 text-status-ok shrink-0" />
                : <Clock className="h-3 w-3 text-status-warn shrink-0" />}
              <span className={cn(!n.satisfied && "text-status-warn")}>{n.title}</span>
              <span className="ms-auto text-[10px] text-muted-foreground">
                {n.satisfied ? t("chainArrived") : t("chainWaiting")}
              </span>
            </div>
          ))}
          {handoff.length > 0 && (
            <div className="flex items-center gap-1.5 text-foreground/80">
              <ArrowLeft className="h-3 w-3 text-status-ok shrink-0 rtl:rotate-180" />
              <span className="text-[11px] font-bold text-muted-foreground">{t("handoff")}:</span>
              <span>{handoff.map((h) => h.title).join(" · ")}</span>
            </div>
          )}
        </div>
      )}

      {(plan.latest_start || plan.latest_finish) && (
        <div className="text-muted-foreground">
          {plan.latest_start && <span>{t("startBy")}: {formatDateOnly(plan.latest_start, locale)} </span>}
          {plan.latest_finish && <span>· {t("finishBy")}: {formatDateOnly(plan.latest_finish, locale)}</span>}
        </div>
      )}

      <Link
        href={`/${locale}/plan`}
        className="inline-flex items-center gap-1 text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {t("openBoard")}
        <ExternalLink className="h-3 w-3" />
      </Link>
    </>
  );
}
