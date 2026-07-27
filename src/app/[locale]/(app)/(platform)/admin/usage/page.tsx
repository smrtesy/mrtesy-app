export const dynamic = "force-dynamic";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { fetchAiUsageSummary, type AiUsageGroup } from "@/lib/ai-usage/summary";

type Range = "24h" | "7d" | "30d" | "mtd" | "lastmonth";

const RANGES: { key: Range; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  // The provider invoices are cut by CALENDAR month in UTC. A rolling 30-day
  // window can never equal the console's month-to-date figure, which is the
  // single most common reason a ledger "doesn't match the bill" even when every
  // row in it is right. These two ranges are the ones to reconcile against.
  { key: "mtd", label: "This month" },
  { key: "lastmonth", label: "Last month" },
];

const RANGE_LABEL: Record<Range, string> = {
  "24h": "last 24h",
  "7d": "last 7 days",
  "30d": "last 30 days",
  mtd: "this calendar month (UTC)",
  lastmonth: "last calendar month (UTC)",
};

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  google: "Google (Gemini)",
  resemble: "Resemble (TTS)",
  voyage: "Voyage AI (Embeddings)",
};

const PROVIDER_URL: Record<string, string> = {
  anthropic: "https://platform.claude.com/workspaces/default/cost",
  google:    "https://aistudio.google.com/app/apikey",
  resemble:  "https://app.resemble.ai/billing",
  voyage:    "https://dash.voyageai.com/",
};

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function tok(n: number): string {
  return n === 0 ? "—" : n.toLocaleString();
}

/**
 * Resolve a range key to a half-open [since, until) window.
 *
 * The calendar ranges are built in UTC on purpose. Everything the user reads in
 * this app is New York time (see CLAUDE.md), but this screen exists to be
 * compared against the Anthropic/Google consoles, and those bill on UTC month
 * boundaries — cutting the month at New York midnight would shift 4–5 hours of
 * spend into the wrong month and reintroduce the very mismatch being fixed. The
 * range labels say "UTC" so the choice is visible rather than surprising.
 */
function windowFor(range: Range): { since: Date; until?: Date } {
  const now = new Date();
  switch (range) {
    case "24h":
      return { since: new Date(now.getTime() - 24 * 3600_000) };
    case "7d":
      return { since: new Date(now.getTime() - 7 * 24 * 3600_000) };
    case "30d":
      return { since: new Date(now.getTime() - 30 * 24 * 3600_000) };
    case "mtd":
      return { since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
    case "lastmonth":
      return {
        since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
        until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      };
  }
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range: Range = RANGES.some((r) => r.key === rangeParam)
    ? (rangeParam as Range)
    : "7d";
  const { since, until } = windowFor(range);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">AI Usage &amp; Cost</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Unified ledger of every paid AI call across all services (edge functions, server,
            voice-engine). Reconcile against the Anthropic / Google / Resemble consoles using{" "}
            <span className="font-medium">This month</span> — the providers bill by calendar
            month (UTC), so a rolling window will never match the invoice.
          </p>
        </div>
        <div className="flex gap-1 flex-wrap">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`?range=${r.key}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                r.key === range
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </Link>
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

      {/* Grand total + per-provider summary */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total ({RANGE_LABEL[range]})
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
                      <td className="py-2 text-right tabular-nums font-medium">{usd(c.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
            Cost is computed from the token counts the API returned, at list prices
            (Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Opus 4.7–5 $5/$25 per 1M; cache read 0.1×
            input, cache write 1.25× at 5m TTL / 2× at 1h). It excludes anything not billed
            through these API keys — Claude Code agent runs, which bill to the Claude
            subscription, are tracked separately under /claude.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
