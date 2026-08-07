"use client";

/**
 * A general system-status strip for the sidebar — NOT tied to Claude.
 *
 * One quiet row of three labelled dots: F (frontend / Vercel), B (backend / Railway),
 * DB (database / Supabase). Each dot's colour is the surface's current state — green
 * ready, amber building/transitional, red error, grey unknown/not-configured.
 *
 * Clicking a dot opens a compact popover with (a) the surface's current detail,
 * (b) a HISTORY view over the last 24h / 7d / 14d, and (c) links straight to that
 * surface's own dashboard and public status page. The history is the backend's own
 * passive telemetry (server_health_samples, sampled every ~30s) — for the backend
 * (B) it shows event-loop lag p99 + in-flight Claude-run count (the two that explain
 * the intermittent 502s the browser mislabels as CORS); for every surface it shows a
 * state-over-time bar, so a past F/DB outage is visible too.
 *
 * Data: GET /api/claude/deploy-status (live states + links) and
 * GET /api/claude/health-history (the recorded series). Both are super-admin gated,
 * so this strip is only mounted for admins. Polls the live state slowly; the history
 * is fetched lazily the first time a popover opens (and on a range change), cached.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface ProviderStatus {
  configured: boolean;
  state?: "building" | "ready" | "warn" | "error" | "unknown";
  rawState?: string;
  commitSha?: string | null;
  createdAt?: string | null;
  hint?: string;
  error?: string;
  /** DB dot: the db_health_watchdog's "approaching problem" message + when it fired. */
  warning?: string | null;
  warnedAt?: string | null;
  /** DB dot: live metric summary (memory/disk %), shown even when healthy. */
  note?: string | null;
  /** Deep link to this surface's own dashboard for this project. */
  dashboardUrl?: string | null;
  /** The provider's public status page. */
  statusUrl?: string | null;
}

/** Deploy time in New York (CLAUDE.md: all user-facing times are America/New_York). */
function nyTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

interface SystemStatus {
  vercel: ProviderStatus;
  railway: ProviderStatus;
  supabase: ProviderStatus;
}

/** One downsampled point of history from GET /api/claude/health-history. */
interface HistoryBucket {
  t: string;
  lagP50: number | null;
  lagP99: number | null;
  runs: number | null;
  rssMb: number | null;
  vercel: string | null;
  railway: string | null;
  supabase: string | null;
}
interface HistoryResponse {
  rangeHours: number;
  bucketSec: number;
  buckets: HistoryBucket[];
}

/** Which provider key in the history each dot maps to. */
type ProviderKey = "vercel" | "railway" | "supabase";

const POLL_MS = 30_000;

const DOT: Record<string, string> = {
  ready: "bg-status-ok",
  building: "bg-status-warn",
  warn: "bg-status-warn", // amber — a problem is approaching (DB watchdog)
  error: "bg-destructive",
  unknown: "bg-muted-foreground/50",
};

/** The dot's state key + the human-readable detail line, shared by the hover
 * title (desktop) and the popover so both read identically. */
function providerInfo(s: ProviderStatus | undefined): { state: string; detail: string } {
  const state = s?.configured === false ? "unknown" : s?.state ?? "unknown";
  const when = nyTime(s?.createdAt);
  const detail = s?.error
    ? s.error
    : s?.warning
      ? [s.warning, nyTime(s?.warnedAt) ? `${nyTime(s?.warnedAt)} NY` : null].filter(Boolean).join(" · ")
      : s?.configured === false
        ? s?.hint ?? "—"
        : [
            state,
            s?.commitSha ? `v ${s.commitSha.slice(0, 7)}` : null,
            when ? `${when} NY` : null,
            s?.note ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
  return { state, detail };
}

// ── tiny inline charts (no charting lib — keep the bundle lean) ──────────────

/** A compact sparkline. Skips null gaps (a gap = the sampler wasn't running,
 *  e.g. a restart — itself meaningful, so we don't paper over it). */
function Sparkline({ values, colorClass }: { values: (number | null)[]; colorClass: string }) {
  const W = 240;
  const H = 40;
  const PAD = 3;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => PAD + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD));
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD);
  // Break the line on nulls into separate polylines.
  const segments: string[][] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else {
      cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    }
  });
  if (cur.length) segments.push(cur);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block">
      {segments.map((seg, i) => (
        <polyline
          key={i}
          points={seg.join(" ")}
          fill="none"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className={colorClass}
        />
      ))}
    </svg>
  );
}

/** A state-over-time bar: one thin colored cell per bucket. */
function StateTimeline({ states }: { states: (string | null)[] }) {
  if (states.length === 0) return null;
  // dir="ltr": oldest→newest reads left→right, matching the SVG sparklines below
  // (which use absolute x-coords and ignore the app's RTL). Without this the state
  // bar and the lag/runs lines would run in opposite time directions in one popover.
  return (
    <div dir="ltr" className="flex h-3 w-full overflow-hidden rounded">
      {states.map((s, i) => (
        <div key={i} className={cn("min-w-px flex-1", DOT[s ?? "unknown"] ?? DOT.unknown)} />
      ))}
    </div>
  );
}

const RANGES = [
  { hours: 24, key: "range24h" as const },
  { hours: 24 * 7, key: "range7d" as const },
  { hours: 24 * 14, key: "range14d" as const },
];

function Dot({ label, full, s, providerKey }: {
  label: string;
  full: string;
  s: ProviderStatus | undefined;
  providerKey: ProviderKey;
}) {
  const t = useTranslations("claudeChat");
  const { state, detail } = providerInfo(s);
  const [hours, setHours] = useState(24);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);
  const reqIdRef = useRef(0);

  const loadHistory = useCallback(async (h: number) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const res = await api<HistoryResponse>(`/api/claude/health-history?hours=${h}`);
      // Ignore a response that a newer range switch has superseded (out-of-order resolve).
      if (reqId === reqIdRef.current) setHistory(res);
    } catch {
      if (reqId === reqIdRef.current) setHistory(null);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // Fetch the first time the popover opens, and whenever the range changes while open.
  useEffect(() => {
    if (opened) void loadHistory(hours);
  }, [opened, hours, loadHistory]);

  const buckets = history?.buckets ?? [];
  const states = buckets.map((b) => b[providerKey]);
  const hasHistory = buckets.length > 0;
  const lagMax = Math.max(0, ...buckets.map((b) => b.lagP99 ?? 0));
  const runsMax = Math.max(0, ...buckets.map((b) => b.runs ?? 0));

  return (
    <Popover onOpenChange={(o) => o && setOpened(true)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${full}: ${detail}`}
          aria-label={full}
          className="inline-flex items-center gap-1 rounded"
        >
          <span className={cn("size-2.5 rounded-full", DOT[state] ?? DOT.unknown)} />
          <span className="font-medium tabular-nums">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs">
        {/* Header: current state + detail */}
        <div className="flex items-start gap-2">
          <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", DOT[state] ?? DOT.unknown)} />
          <span className="min-w-0">
            <span className="font-medium">{full}</span>
            <span className="block break-words text-muted-foreground">{detail}</span>
          </span>
        </div>

        {/* Range toggle */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">{t("deploy.history")}:</span>
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              onClick={() => setHours(r.hours)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                hours === r.hours ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {t(`deploy.${r.key}`)}
            </button>
          ))}
        </div>

        {/* History */}
        {loading && !hasHistory ? (
          <div className="text-[10px] text-muted-foreground">{t("deploy.loadingHistory")}</div>
        ) : !hasHistory ? (
          <div className="text-[10px] text-muted-foreground">{t("deploy.noHistory")}</div>
        ) : (
          <div className="space-y-2">
            <div>
              <div className="mb-0.5 text-[10px] text-muted-foreground">{t("deploy.stateOverTime")}</div>
              <StateTimeline states={states} />
            </div>
            {providerKey === "railway" && (
              <>
                <div>
                  <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                    <span>{t("deploy.lagP99")}</span>
                    <span className="tabular-nums">{t("deploy.max")} {lagMax.toFixed(0)} ms</span>
                  </div>
                  <Sparkline values={buckets.map((b) => b.lagP99)} colorClass="stroke-amber-500" />
                </div>
                <div>
                  <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                    <span>{t("deploy.activeRuns")}</span>
                    <span className="tabular-nums">{t("deploy.max")} {runsMax}</span>
                  </div>
                  <Sparkline values={buckets.map((b) => b.runs)} colorClass="stroke-sky-500" />
                </div>
              </>
            )}
          </div>
        )}

        {/* Links */}
        {(s?.dashboardUrl || s?.statusUrl) && (
          <div className="flex items-center justify-between border-t pt-2">
            {s?.dashboardUrl ? (
              <a
                href={s.dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground"
              >
                {t("deploy.openDashboard")}
              </a>
            ) : (
              <span />
            )}
            {s?.statusUrl && (
              <a
                href={s.statusUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground underline"
              >
                {t("deploy.statusPage")}
              </a>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function SystemStatusStrip() {
  const t = useTranslations("claudeChat");
  const [data, setData] = useState<SystemStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<SystemStatus>("/api/claude/deploy-status"));
    } catch {
      // Silent — ambient status chrome, not an action the user awaits.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!data) return null;

  return (
    <div
      className="flex items-center justify-center gap-3 px-1 pt-0.5 text-[10px] text-muted-foreground"
      aria-label={t("deploy.label")}
    >
      <Dot label="F" full={t("deploy.frontend")} s={data.vercel} providerKey="vercel" />
      <Dot label="B" full={t("deploy.backend")} s={data.railway} providerKey="railway" />
      <Dot label="DB" full={t("deploy.database")} s={data.supabase} providerKey="supabase" />
    </div>
  );
}
