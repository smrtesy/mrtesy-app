export const dynamic = "force-dynamic";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { fetchAiUsageSummary, type AiUsageGroup } from "@/lib/ai-usage/summary";

/**
 * How many calendar months to offer, counting the current one back. The
 * provider invoices are cut by CALENDAR month, so these are the only ranges
 * that can be compared against a console figure line-for-line; the rolling
 * windows are for "what is it doing right now".
 */
const MONTHS_OFFERED = 6;

interface RangeDef {
  key: string;
  /** Text on the button. */
  label: string;
  /** Longer form for the total card, e.g. "Jun 2026 (UTC)". */
  title: string;
  since: Date;
  /** Exclusive upper bound; undefined means "up to now". */
  until?: Date;
  /** Rolling windows and calendar months are shown as two separate groups. */
  kind: "rolling" | "month";
}

/**
 * Month labels are formatted in UTC, matching the boundaries the window itself
 * uses. This screen is the one deliberate exception to the app-wide
 * America/New_York display rule (see CLAUDE.md): the providers bill on UTC month
 * boundaries, so cutting a month at New York midnight would move 4–5 hours of
 * spend into the neighbouring month and reintroduce exactly the mismatch this
 * page exists to resolve. Every month label therefore carries "(UTC)".
 */
const monthFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Build the range list for this request. `now` is passed in so it is evaluated once. */
function buildRanges(now: Date): RangeDef[] {
  const rolling: RangeDef[] = [
    { key: "24h", label: "24h", title: "last 24h", since: new Date(now.getTime() - 24 * 3600_000), kind: "rolling" },
    { key: "7d", label: "7 days", title: "last 7 days", since: new Date(now.getTime() - 7 * 24 * 3600_000), kind: "rolling" },
    { key: "30d", label: "30 days", title: "last 30 days", since: new Date(now.getTime() - 30 * 24 * 3600_000), kind: "rolling" },
  ];

  // `m0` is the current month, `m1` the previous one, and so on. Keys are
  // relative rather than absolute (e.g. "2026-06") so a bookmarked link keeps
  // meaning "last month" instead of freezing on one specific month.
  const months: RangeDef[] = Array.from({ length: MONTHS_OFFERED }, (_, i) => {
    // Date.UTC normalises a negative month index into the previous year, so
    // going back past January needs no special case.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const label = monthFmt.format(since);
    return { key: `m${i}`, label, title: `${label} (UTC)`, since, until, kind: "month" as const };
  });

  return [...rolling, ...months];
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  google: "Google (Gemini)",
  resemble: "Resemble (TTS)",
  voyage: "Voyage AI (Embeddings)",
  fal: "fal.ai (image/video)",
};

const PROVIDER_URL: Record<string, string> = {
  anthropic: "https://platform.claude.com/workspaces/default/cost",
  google:    "https://aistudio.google.com/app/apikey",
  resemble:  "https://app.resemble.ai/billing",
  voyage:    "https://dash.voyageai.com/",
  fal:       "https://fal.ai/dashboard/usage",
};

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function tok(n: number): string {
  return n === 0 ? "—" : n.toLocaleString();
}

function RangeButton({ range, activeKey }: { range: RangeDef; activeKey: string }) {
  const isActive = range.key === activeKey;
  return (
    <Link
      href={`?range=${range.key}`}
      aria-current={isActive ? "page" : undefined}
      className={`px-3 py-1.5 text-xs font-medium rounded-md border whitespace-nowrap ${
        isActive
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {range.label}
    </Link>
  );
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const ranges = buildRanges(new Date());
  // Unknown / absent key falls back to the 7-day window rather than erroring.
  const active = ranges.find((r) => r.key === rangeParam) ?? ranges.find((r) => r.key === "7d")!;
  const { since, until } = active;

  // ai_usage RLS only lets a super_admins-table row read it; service-role keeps
  // this consistent with the rest of /admin (e.g. an ADMIN_EMAIL-only admin).
  const admin = createAdminSupabaseClient();
  const summary = admin
    ? await fetchAiUsageSummary(admin, since, until)
    : {
        groups: [] as AiUsageGroup[],
        totalCost: 0,
        totalCalls: 0,
        source: "rpc" as const,
        warning: null,
        error: "Service-role key not configured",
      };

  // Roll the (provider, component, model) groups up two ways. Both are derived
  // from the same server-side aggregate, so the cards and the table can never
  // disagree — they used to be two independent passes over a truncated sample.
  const byProvider = new Map<string, { cost: number; calls: number }>();
  for (const g of summary.groups) {
    const p = byProvider.get(g.provider) ?? { cost: 0, calls: 0 };
    p.cost += g.cost;
    p.calls += g.calls;
    byProvider.set(g.provider, p);
  }
  const providerRows = [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const componentRows = [...summary.groups].sort((a, b) => b.cost - a.cost);

  // Rows that carry no cost at all make the total a FLOOR, not a total. Saying
  // so is the difference between an estimate and a number that can be trusted;
  // fal runs in particular reach experiment_runs without a cost about a third of
  // the time, and silently treating those as $0 is how a total starts lying.
  const missingCost = summary.groups.reduce((s, g) => s + g.missingCost, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">AI Usage &amp; Cost</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every paid AI call across the edge functions, server, voice-engine and smrtStudio.
            To reconcile against the Anthropic / Google / Resemble / fal consoles, pick a{" "}
            <span className="font-medium">month</span> — the providers bill by calendar month
            (UTC), so a rolling window will never match an invoice.
          </p>
          {/* Says what is NOT here, on the screen that claims to hold everything.
              Without this line the omission reads as a gap to be closed — which is
              how fal got folded in (correctly), and how claude_runs would get folded
              in (incorrectly: subscription runs appear on no invoice, so adding them
              breaks the reconciliation this page exists for). See migration
              20260729210000_ai_usage_summary_excludes_claude_runs.sql. */}
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-medium">Invoiced spend only.</span> Claude Code console runs
            are a <span className="font-medium">separate account</span> and are deliberately
            excluded: they execute on the Claude subscription, are not billed per token, and
            their cost figure is an equivalent-value estimate rather than an amount owed.
            They are reported on the Claude runs screen instead.
          </p>
        </div>
        {/* Two groups: rolling windows, then the calendar months to reconcile
            against. The divider is what tells them apart at a glance — without
            it "30 days" and "Jul 2026" read as the same kind of thing, and
            picking the wrong one is how the numbers stop matching the invoice. */}
        <div className="flex items-center gap-1 flex-wrap">
          {ranges
            .filter((r) => r.kind === "rolling")
            .map((r) => (
              <RangeButton key={r.key} range={r} activeKey={active.key} />
            ))}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {ranges
            .filter((r) => r.kind === "month")
            .map((r) => (
              <RangeButton key={r.key} range={r} activeKey={active.key} />
            ))}
        </div>
      </div>

      {summary.error && (
        <div className="rounded-lg border border-status-late bg-status-late-bg p-3 text-sm text-status-late">
          Failed to load usage: {summary.error}
        </div>
      )}

      {summary.warning && (
        <div className="rounded-lg border border-status-warn bg-status-warn-bg p-3 text-sm text-status-warn">
          {summary.warning}
        </div>
      )}

      {missingCost > 0 && (
        <div className="rounded-lg border border-status-warn bg-status-warn-bg p-3 text-sm text-status-warn">
          {missingCost.toLocaleString()} run{missingCost === 1 ? "" : "s"} in this window recorded
          no cost, so the totals below are a <span className="font-medium">lower bound</span>. See
          the &ldquo;no cost&rdquo; column for which components.
        </div>
      )}

      {/* Grand total + per-provider summary */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total ({active.title})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{usd(summary.totalCost)}</div>
            <p className="text-xs text-muted-foreground">
              {summary.totalCalls.toLocaleString()} calls
            </p>
          </CardContent>
        </Card>
        {providerRows.map(([provider, agg]) => {
          const providerUrl = PROVIDER_URL[provider];
          const label = PROVIDER_LABEL[provider] ?? provider;
          return (
            <Card key={provider}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {providerUrl ? (
                    <a
                      href={providerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline hover:text-foreground transition-colors"
                    >
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{usd(agg.cost)}</div>
                <p className="text-xs text-muted-foreground">
                  {agg.calls.toLocaleString()} calls
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Per-component breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Breakdown by component</CardTitle>
        </CardHeader>
        <CardContent>
          {componentRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI usage recorded in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Component</th>
                    <th className="py-2 pr-4 font-medium">Model</th>
                    <th className="py-2 pr-4 font-medium text-right">Calls</th>
                    <th className="py-2 pr-4 font-medium text-right">Items</th>
                    <th className="py-2 pr-4 font-medium text-right">In tok</th>
                    <th className="py-2 pr-4 font-medium text-right">Out tok</th>
                    {/* Cached tokens bill at 0.1x (read) and 1.25-2x (write) of the
                        input rate. Without them on screen the cost column looks
                        unreconcilable against the token counts next to it. */}
                    <th className="py-2 pr-4 font-medium text-right">Cache r/w</th>
                    <th className="py-2 pr-4 font-medium text-right">No cost</th>
                    <th className="py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {componentRows.map((c) => (
                    <tr key={`${c.provider}|${c.component}|${c.model}`} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{c.component}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="text-[10px]">
                          {c.model}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {c.calls.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{c.items || "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{tok(c.inTok)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{tok(c.outTok)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-xs text-muted-foreground">
                        {c.cacheReadTok === 0 && c.cacheWriteTok === 0
                          ? "—"
                          : `${tok(c.cacheReadTok)} / ${tok(c.cacheWriteTok)}`}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {c.missingCost > 0 ? (
                          <span className="text-status-warn font-medium">{c.missingCost}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums font-medium">{usd(c.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* Stating the exclusions is load-bearing, not boilerplate. The page's
              number is only trustworthy if what it does NOT cover is explicit —
              a total that silently omits a provider is how this screen lost
              credibility in the first place. */}
          <div className="text-xs text-muted-foreground mt-4 leading-relaxed space-y-1">
            <p>
              Cost is computed from the token counts the API returned, at list prices
              (Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Opus 4.7–5 $5/$25 per 1M; cache read 0.1×
              input, cache write 1.25× at 5m TTL / 2× at 1h). Expect small deltas against an
              invoice from rounding and from the provider&apos;s own billing cut-off.
            </p>
            <p>
              fal.ai rows come from <code className="font-mono">experiment_runs</code> (the
              video-lab harness records cost per run there, not through an API-token ledger), so
              they carry no token counts. Their model names are withheld to keep smrtStudio&apos;s
              blind scoring intact — cost does not depend on knowing which model produced a run.
            </p>
            <p>
              <span className="font-medium">Not included here:</span> Claude Code agent runs,
              which bill to the Claude subscription rather than to an API key (see /claude).
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
