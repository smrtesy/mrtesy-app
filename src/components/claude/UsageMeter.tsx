"use client";

/**
 * The composer's usage meter — a small filling-circle icon (like claude.ai's
 * "usage limits" indicator) that opens a popover with the 5-hour + weekly figures.
 *
 * This is an ESTIMATE of the subscription account's consumption (our own runs'
 * cost-equivalent vs a calibrated cap), NOT Anthropic's real remaining quota,
 * which is not exposed on a Team plan. The weekly figure is display-only until a
 * weekly limit-hit calibrates it (backend returns pct:null then). Compact-UI rule:
 * icon-only by default, detail on click.
 *
 * The reading is kept LIVE, not frozen at mount: the account's 5-hour window is
 * SHARED across every thread on that account, so the meter must move when OTHER
 * chats (or background runs) consume it, even while nothing runs here. So it polls
 * lightly in the background (every 30s), and also refreshes the instant a turn in
 * this chat starts or ends. The poll is a dry-run estimator read — zero paid
 * tokens. Every fetch is guarded to the CURRENT account: a reply for an account
 * that is no longer selected is dropped, so the figure is always this account's.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface AccountUsage {
  account: string;
  session:
    | {
        pct: number;
        pct_raw: number;
        cost_used: number;
        cap: number;
        window_end: string;
        // 'anthropic' when the reset time / percent came from the CLI's own
        // rate_limit_event (ground truth); 'estimate' when reconstructed from cost.
        source?: "anthropic" | "estimate";
        pct_source?: "anthropic" | "estimate";
      }
    | null;
  weekly: {
    pct: number | null;
    cost_used: number;
    cap: number | null;
    window_end?: string | null;
    source?: "anthropic" | "estimate";
    pct_source?: "anthropic" | "estimate";
  };
  // Both windows resolved from a live rate_limit_event — reset times are exact.
  live?: boolean;
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

/**
 * A tiny green dot marking one figure as Anthropic's OWN datum (captured from a
 * live rate_limit_event), not our cost estimate. Rendered ONLY next to a value
 * that really came from Anthropic — so its presence is itself the "this is exact"
 * signal, and its absence means the neighbouring figure is still an estimate. Per
 * figure, because Anthropic gives the reset time on every run but the percent only
 * near the limit, and the weekly window only occasionally — so a single blanket
 * "real" label would misstate whichever part isn't.
 */
function RealBadge() {
  const t = useTranslations("claudeChat.meter");
  return (
    <span
      title={t("realTooltip")}
      aria-label={t("realTooltip")}
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
    />
  );
}

export function UsageMeter({ account, running }: { account: string; running?: boolean }) {
  const t = useTranslations("claudeChat.meter");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(false);
  // The account this meter must reflect RIGHT NOW. A fetch started for an older
  // account (a mid-flight switch, or an overlapping poll) is dropped on return so
  // it can never paint another account's figure onto the current one — the meter
  // is always this account's reading. Compared against the endpoint's echoed
  // `account`, so the match is exact.
  const accountRef = useRef(account);
  accountRef.current = account;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<AccountUsage>(
        `/api/claude/account-usage?account=${encodeURIComponent(account)}`,
      );
      if (res.account === accountRef.current) setData(res);
    } catch {
      // A read that fails leaves the last snapshot (or the empty icon) — the meter
      // is an aid, never a blocker for the composer, so it swallows its own errors.
    } finally {
      setLoading(false);
    }
  }, [account]);

  // On account change, drop the previous account's reading at once so the ring
  // shows "unknown" (muted) for the brief moment until the new fetch lands, never
  // another account's fill. Keyed on `account` alone, so an ordinary same-account
  // poll never blanks the icon.
  useEffect(() => {
    setData(null);
  }, [account]);

  // One fetch on mount / account change so the resting icon reflects the real fill
  // (not a permanent empty ring) — for the account this thread runs on.
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the RESTING icon current in the background, not only while the popover is
  // open. The 5-hour window is SHARED across every thread on this account, so
  // consumption from OTHER chats moves the meter even when nothing runs here — a
  // light GET every 30s (dry-run estimator, zero paid tokens) tracks that. The open
  // popover refreshes on the same tick, so its figures stay live too.
  useEffect(() => {
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  // A turn boundary in THIS chat (start or end) is the moment its own cost has just
  // landed in the DB — refresh at once instead of waiting for the next background
  // tick, so the meter reacts immediately to work done here. Guarded on a real
  // change so it never double-fires with the mount fetch above.
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current !== running) {
      prevRunning.current = running;
      void load();
    }
  }, [running, load]);

  const sessionPct = data?.session?.pct ?? 0;
  const iconColor = meterColor(data?.session ? sessionPct : null);
  // Any figure on the card sourced from Anthropic's own rate_limit_event → the
  // footer explains the green dot; otherwise it's the plain "estimate" note.
  const anyReal =
    data?.session?.source === "anthropic" ||
    data?.session?.pct_source === "anthropic" ||
    data?.weekly?.source === "anthropic" ||
    data?.weekly?.pct_source === "anthropic";
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
            <span
              dir="ltr"
              className={cn(
                "flex items-center gap-1",
                meterColor(data?.session ? sessionPct : null),
              )}
            >
              {data?.session?.pct_source === "anthropic" && <RealBadge />}
              {data?.session ? `${data.session.pct}%` : "—"}
            </span>
          </div>
          <Bar pct={sessionPct} color={meterColor(data?.session ? sessionPct : null)} />
          {data?.session?.window_end && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {data.session.source === "anthropic" && <RealBadge />}
              <span>{resetsInLabel(data.session.window_end, locale, t)}</span>
            </div>
          )}
        </div>

        {/* Weekly */}
        <div className="space-y-1">
          <div className="flex items-center justify-between font-medium">
            <span>{t("titleWeekly")}</span>
            <span
              dir="ltr"
              className={cn("flex items-center gap-1", meterColor(data?.weekly?.pct))}
            >
              {data?.weekly?.pct_source === "anthropic" && <RealBadge />}
              {data?.weekly?.pct != null ? `${data.weekly.pct}%` : ""}
            </span>
          </div>
          {data?.weekly?.pct != null ? (
            <>
              <Bar pct={data.weekly.pct} color={meterColor(data.weekly.pct)} />
              {data.weekly.window_end && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  {data.weekly.source === "anthropic" && <RealBadge />}
                  <span>{resetsInLabel(data.weekly.window_end, locale, t)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-0.5 text-[10px] text-muted-foreground">
              {/* Even without a calibrated percent we may hold Anthropic's exact
                  weekly reset time (from a live rate_limit_event) — show it, marked. */}
              {data?.weekly?.window_end && (
                <div className="flex items-center gap-1">
                  {data.weekly.source === "anthropic" && <RealBadge />}
                  <span>{resetsInLabel(data.weekly.window_end, locale, t)}</span>
                </div>
              )}
              <div>{t("noCalibration")}</div>
            </div>
          )}
        </div>

        <div className="border-t pt-2 text-[10px] leading-snug text-muted-foreground">
          {loading && !data
            ? t("loading")
            : anyReal
              ? t("realLegend")
              : t("estimateDisclaimer")}
        </div>
      </PopoverContent>
    </Popover>
  );
}
