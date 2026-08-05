"use client";

/**
 * The composer's usage meter — a small filling-circle icon (like claude.ai's
 * "usage limits" indicator) that opens a popover with the 5-hour + weekly figures.
 *
 * This is an ESTIMATE of the subscription account's consumption (our own runs'
 * cost-equivalent vs a calibrated cap), NOT Anthropic's real remaining quota,
 * which is not exposed on a Team plan. The weekly figure is display-only until a
 * weekly limit-hit calibrates it (backend returns pct:null then). Compact-UI rule:
 * icon-only by default, detail on click; fetch only while the popover is open, no
 * continuous poll.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface AccountUsage {
  account: string;
  session:
    | { pct: number; pct_raw: number; cost_used: number; cap: number; window_end: string }
    | null;
  weekly: { pct: number | null; cost_used: number; cap: number | null; window_end?: string | null };
  disclaimer: string;
}

/**
 * Claude coral < 70% → amber ≥ 70% → red ≥ 90%. currentColor drives the SVG
 * stroke and the bar fill. The resting/normal color is Anthropic's brand coral
 * (#D97757) to match claude.ai's own usage indicator, not a neutral gray — only
 * the near-limit warning tiers escalate to amber/red. `null` (no reading yet)
 * stays muted so an unresolved meter reads as "unknown", not "empty".
 */
function meterColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground/50";
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-[#D97757]";
}

/** A 16px progress ring filled clockwise to `pct` (0–100). */
function Ring({ pct, className }: { pct: number; className?: string }) {
  const r = 7;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" className={className} aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-current opacity-20" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-current"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - filled)}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

/**
 * "resets in Xh Ym (around HH:MM NY)". Units live in the i18n message (a separate
 * variant when there are no whole hours), never hardcoded here — the label reads
 * correctly in both locales. The absolute time is the reset instant in New York
 * (repo rule: user-facing times are always NY).
 */
function resetsInLabel(
  windowEnd: string,
  locale: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const ms = new Date(windowEnd).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const at = new Date(windowEnd).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return h > 0 ? t("resetsIn", { h, m, at }) : t("resetsInMins", { m, at });
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full bg-current transition-[width]", color)}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

export function UsageMeter({ account }: { account: string }) {
  const t = useTranslations("claudeChat.meter");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<AccountUsage>(
        `/api/claude/account-usage?account=${encodeURIComponent(account)}`,
      );
      setData(res);
    } catch {
      // A read that fails leaves the last snapshot (or the empty icon) — the meter
      // is an aid, never a blocker for the composer, so it swallows its own errors.
    } finally {
      setLoading(false);
    }
  }, [account]);

  // One fetch on mount / account change so the resting icon reflects the real fill
  // (not a permanent empty ring) — a single call, not a poll.
  useEffect(() => {
    void load();
  }, [load]);

  // While the popover is open, refresh every 60s so an open panel stays current.
  // Closed → no polling (compact/economical: the icon is the passive indicator).
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [open, load]);

  const sessionPct = data?.session?.pct ?? 0;
  const iconColor = meterColor(data?.session ? sessionPct : null);
  const tooltip = data?.session
    ? t("tooltip", {
        pct: data.session.pct_raw,
        cost: data.session.cost_used.toFixed(2),
        cap: data.session.cap.toFixed(0),
      })
    : t("empty");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          aria-label={tooltip}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted focus:outline-none focus:ring-0",
            iconColor,
          )}
        >
          <Ring pct={sessionPct} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3 p-3.5 text-xs">
        {/* 5-hour window */}
        <div className="space-y-1">
          <div className="flex items-center justify-between font-medium">
            <span>{t("title5h")}</span>
            <span dir="ltr" className={meterColor(data?.session ? sessionPct : null)}>
              {data?.session ? `${data.session.pct}%` : "—"}
            </span>
          </div>
          <Bar pct={sessionPct} color={meterColor(data?.session ? sessionPct : null)} />
          {data?.session?.window_end && (
            <div className="text-[10px] text-muted-foreground">
              {resetsInLabel(data.session.window_end, locale, t)}
            </div>
          )}
        </div>

        {/* Weekly */}
        <div className="space-y-1">
          <div className="flex items-center justify-between font-medium">
            <span>{t("titleWeekly")}</span>
            <span dir="ltr" className={meterColor(data?.weekly?.pct)}>
              {data?.weekly?.pct != null ? `${data.weekly.pct}%` : ""}
            </span>
          </div>
          {data?.weekly?.pct != null ? (
            <>
              <Bar pct={data.weekly.pct} color={meterColor(data.weekly.pct)} />
              {data.weekly.window_end && (
                <div className="text-[10px] text-muted-foreground">
                  {resetsInLabel(data.weekly.window_end, locale, t)}
                </div>
              )}
            </>
          ) : (
            <div className="text-[10px] text-muted-foreground">{t("noCalibration")}</div>
          )}
        </div>

        <div className="border-t pt-2 text-[10px] leading-snug text-muted-foreground">
          {loading && !data ? t("loading") : t("estimateDisclaimer")}
        </div>
      </PopoverContent>
    </Popover>
  );
}
