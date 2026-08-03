"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bot, Check, ChevronDown, ChevronUp, X, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { cn } from "@/lib/utils";

/**
 * The Claude activity bar — "מול העיניים" completion notices on the tasks desk.
 *
 * The user works in /tasks while Claude console runs execute elsewhere; this
 * strip surfaces every finished run (done AND failed — the user asked for every
 * completion, not a curated subset) right on the desk, so nothing waits to be
 * discovered in the console rail or the phone push.
 *
 * Compact-by-default (CLAUDE.md): the bar renders NOTHING when there is nothing
 * unseen — zero permanent chrome. When unseen completions exist it is a single
 * slim row: the newest completion + a count, expandable to the recent list, and
 * an X that marks everything seen (a localStorage watermark — per browser, which
 * matches what "I saw it" means).
 *
 * DATA: reads GET /api/claude/runs?order=ended (the console's own list, sorted
 * by completion time; carries thread_id for the deep link). Deliberately NOT a
 * new notifications feed: every completion already exists as a claude_runs row,
 * so the bar needs no new writes and no migration, and it is independent of the
 * push gate (pushes only fire for runs ≥2 min; this lists every terminal run in
 * the window it fetches — the newest 30 by end time, so only a backlog deeper
 * than that since the last dismiss scrolls out). The route is super-admin gated
 * like the whole console — a 401/403 renders nothing, so the bar is invisible
 * to anyone who can't open the console anyway.
 */

const POLL_MS = 45_000;
const SEEN_KEY = "smrtesy-claude-activity-seen";
const LIST_MAX = 8;

interface RunRow {
  id: string;
  thread_id: string | null;
  title: string;
  status: string;
  ended_at: string | null;
}

const TERMINAL = new Set(["done", "failed", "canceled"]);

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function ClaudeActivityBar() {
  const t = useTranslations("claudeActivity");
  const locale = useLocale();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [seenTs, setSeenTs] = useState<number>(0);
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    setSeenTs(readSeen());
  }, []);

  const load = useCallback(async () => {
    try {
      const { runs: list } = await api<{ runs: RunRow[] }>("/api/claude/runs?limit=30&order=ended");
      setRuns((list ?? []).filter((r) => TERMINAL.has(r.status) && r.ended_at));
    } catch (e) {
      // Not a console operator (403/401) or a blip — the bar simply stays out
      // of the way. It must never toast on a desk the user is working at.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (!available) return;
    void load();
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load, available]);

  const unseen = runs.filter((r) => Date.parse(r.ended_at!) > seenTs);
  if (!available || unseen.length === 0) return null;

  const newest = unseen[0];
  const timeFmt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "he-IL", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
  });

  const markSeen = () => {
    // Watermark = the newest SERVER end-time on screen, not the client clock:
    // clock skew would otherwise re-show (or swallow) runs around a dismiss.
    const mark = Math.max(...runs.map((r) => Date.parse(r.ended_at!)));
    try {
      localStorage.setItem(SEEN_KEY, String(mark));
    } catch {
      // Private mode — the bar just reappears next visit; harmless.
    }
    setSeenTs(mark);
    setOpen(false);
  };

  const rowFor = (r: RunRow) => (
    <div key={r.id} className="flex items-center gap-2 min-w-0" dir="auto">
      {r.status === "done" ? (
        <Check className="size-3.5 shrink-0 text-emerald-600" />
      ) : (
        <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
      )}
      <span className="truncate text-xs">
        {r.status === "done" ? t("finished") : r.status === "failed" ? t("failed") : t("canceled")}
        {": "}
        {r.title}
      </span>
      <span dir="ltr" className="text-[11px] tabular-nums text-muted-foreground shrink-0">
        {timeFmt.format(new Date(r.ended_at!))}
      </span>
      {r.thread_id && (
        <OpenTabLink
          href={`/${locale}/claude?thread=${r.thread_id}`}
          label={t("tabLabel")}
          className="text-xs underline underline-offset-2 shrink-0 hover:text-foreground"
        >
          {t("open")}
        </OpenTabLink>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5",
        "flex flex-col gap-1",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Bot className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">{rowFor(newest)}</div>
        {unseen.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
          >
            {t("more", { n: unseen.length - 1 })}
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={markSeen}
          aria-label={t("dismiss")}
          title={t("dismiss")}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {open && unseen.length > 1 && (
        <div className="flex flex-col gap-1 ps-6">
          {unseen.slice(1, LIST_MAX).map(rowFor)}
        </div>
      )}
    </div>
  );
}
