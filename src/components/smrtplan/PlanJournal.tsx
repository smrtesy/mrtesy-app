"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import type { Plan } from "@/types/plan";
import { parseISO, gregShort, hebDate } from "@/lib/smrtplan/dates";

type Answers = Record<string, string | boolean> | null;

interface Decision {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  definition_of_done: string | null;
  affected_count: number;
  decided: boolean;
  decided_at: string | null;
  outcome: Answers;
}
interface SessionReport {
  session_url: string | null;
  summary: string;
  status: string; // "in_progress" | "blocked" | "done"
  updated_at: string;
}
interface Entry {
  task_id: string;
  title: string | null;
  title_he: string | null;
  date: string;
  conducted_in: string | null;
  answers: Answers;
  decision_id: string | null;
  session_report?: SessionReport | null;
}

function decTitle(d: { title: string; title_he: string | null }, locale: string) {
  return locale === "en" ? d.title : d.title_he || d.title;
}

/** Read-only "plan journal": a decision board on top, then the recorded test
 *  debriefs (results Claude logged + the doer's report) toggleable by day or by
 *  the decision each test feeds. All data comes from GET /plans/:id/journal. */
export function PlanJournal({ plan, locale }: { plan: Plan; locale: string; canEdit?: boolean; onChanged?: () => void }) {
  const t = useTranslations("smrtPlan.journal");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"day" | "decision">("decision");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<{ decisions: Decision[]; entries: Entry[] }>(`/api/plans/${plan.id}/journal`)
      .then((d) => {
        if (!alive) return;
        setDecisions(d.decisions ?? []);
        setEntries(d.entries ?? []);
      })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "Error"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [plan.id]);

  const decidedCount = decisions.filter((d) => d.decided).length;
  const decLabel = useMemo(() => new Map(decisions.map((d) => [d.id, decTitle(d, locale)])), [decisions, locale]);

  // Group entries either by ISO day or by the decision they feed.
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; entries: Entry[] }>();
    for (const e of entries) {
      const key = view === "day" ? e.date.slice(0, 10) : e.decision_id ?? "__none__";
      const label =
        view === "day"
          ? `${gregShort(parseISO(e.date))} · ${hebDate(parseISO(e.date))}`
          : e.decision_id
            ? decLabel.get(e.decision_id) ?? t("ungrouped")
            : t("ungrouped");
      const g = m.get(key) ?? { label, entries: [] };
      g.entries.push(e);
      m.set(key, g);
    }
    // day view newest-first; decision view keeps decision order
    return [...m.values()];
  }, [entries, view, decLabel, t]);

  const stateLabel = (d: Decision) =>
    d.decided ? t("decided") : d.status === "in_progress" ? t("researching") : t("notStarted");
  const stateCls = (d: Decision) =>
    d.decided
      ? "bg-status-ok-bg text-status-ok"
      : d.status === "in_progress"
        ? "bg-status-warn-bg text-status-warn"
        : "bg-secondary text-muted-foreground";

  if (loading) return <div className="py-8 text-center text-[12.5px] text-muted-foreground">…</div>;

  return (
    <div className="space-y-4">
      {/* ── decision board ── */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-bold">{t("decisionsBoard")}</h3>
          <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {t("decidedCount", { done: decidedCount, total: decisions.length })}
          </span>
        </div>
        {decisions.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t("noDecisions")}</p>
        ) : (
          <div className="space-y-1.5">
            {decisions.map((d) => (
              <div key={d.id} className="rounded-md border bg-background px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-px text-[10px] font-bold ${stateCls(d)}`}>{stateLabel(d)}</span>
                  <span className="flex-1 text-[12.5px] font-medium">{decTitle(d, locale)}</span>
                  {d.affected_count > 0 && (
                    <span className="whitespace-nowrap text-[10.5px] text-muted-foreground">
                      {t("affects", { n: d.affected_count })}
                    </span>
                  )}
                </div>
                {d.definition_of_done && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{d.definition_of_done}</p>
                )}
                {d.decided && d.outcome?.q_worked_best && (
                  <p className="mt-1 text-[11.5px] leading-relaxed">
                    <span className="font-bold text-status-ok">{t("outcome")}: </span>
                    {String(d.outcome.q_worked_best)}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── view toggle ── */}
      <div className="flex w-fit gap-1 rounded-lg border bg-card p-1">
        {(["decision", "day"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
              view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {v === "decision" ? t("byDecision") : t("byDay")}
          </button>
        ))}
      </div>

      {/* ── entries ── */}
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed py-8 text-center text-[12.5px] text-muted-foreground">
          {t("noEntries")}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g, i) => (
            <div key={i}>
              <div className="mb-1.5 text-[12px] font-bold text-muted-foreground">{g.label}</div>
              <div className="space-y-2">
                {g.entries.map((e) => (
                  <EntryCard key={e.task_id + e.date} e={e} locale={locale} t={t} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const sessionStatusCls: Record<string, string> = {
  in_progress: "bg-status-warn-bg text-status-warn",
  blocked: "bg-status-late-bg text-status-late",
  done: "bg-status-ok-bg text-status-ok",
};

function EntryCard({ e, locale, t }: { e: Entry; locale: string; t: ReturnType<typeof useTranslations> }) {
  const title = locale === "en" ? e.title : e.title_he || e.title;

  if (e.session_report) {
    const sr = e.session_report;
    const statusLabel: Record<string, string> =
      { in_progress: t("statusInProgress"), blocked: t("statusBlocked"), done: t("statusDone") };
    return (
      <div className="rounded-md border bg-card px-2.5 py-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-[12.5px] font-medium">{title}</span>
          <span className="whitespace-nowrap rounded bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground">
            {t("sessionUpdate")}
          </span>
          <span className={`whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold ${sessionStatusCls[sr.status] ?? "bg-secondary text-muted-foreground"}`}>
            {statusLabel[sr.status] ?? sr.status}
          </span>
          <span className="whitespace-nowrap text-[10.5px] text-muted-foreground">{gregShort(parseISO(e.date))}</span>
        </div>
        <div className="space-y-0.5">
          <p className="text-[11.5px] leading-relaxed">{sr.summary}</p>
          {sr.session_url && (
            <a
              href={sr.session_url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-[11.5px] font-medium text-primary hover:underline"
            >
              {t("sessionLink")} ↗
            </a>
          )}
        </div>
      </div>
    );
  }

  const a = e.answers ?? {};
  const conductedLabel: Record<string, string> = {
    claude: t("ranClaude"),
    external: t("ranExternal"),
    both: t("ranBoth"),
    no_experiment: t("ranNone"),
  };
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const row = (label: string, val: string) =>
    val ? (
      <p className="text-[11.5px] leading-relaxed">
        <span className="font-bold text-muted-foreground">{label}: </span>
        {val}
      </p>
    ) : null;

  return (
    <div className="rounded-md border bg-card px-2.5 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-[12.5px] font-medium">{title}</span>
        {e.conducted_in && (
          <span className="whitespace-nowrap rounded bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground">
            {conductedLabel[e.conducted_in] ?? e.conducted_in}
          </span>
        )}
        <span className="whitespace-nowrap text-[10.5px] text-muted-foreground">{gregShort(parseISO(e.date))}</span>
      </div>
      <div className="space-y-0.5">
        {row(t("workedBest"), str("q_worked_best"))}
        {row(t("trick"), str("q_trick"))}
        {row(t("surprise"), str("q_surprise"))}
        {row(t("tool"), str("external_tool"))}
        {row(t("steps"), str("external_steps"))}
        {row(t("results"), str("external_results"))}
        {row(t("scores"), str("external_scores") || str("claude_scores"))}
        {row(t("reason"), str("no_experiment_reason"))}
        {str("claude_session_link") && (
          <a
            href={str("claude_session_link")}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-[11.5px] font-medium text-primary hover:underline"
          >
            {t("sessionLink")} ↗
          </a>
        )}
      </div>
    </div>
  );
}
