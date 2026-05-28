export const dynamic = "force-dynamic";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

type Range = "24h" | "7d" | "30d";
const RANGES: { key: Range; label: string; ms: number }[] = [
  { key: "24h", label: "24h", ms: 24 * 3600_000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 3600_000 },
  { key: "30d", label: "30 days", ms: 30 * 24 * 3600_000 },
];

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

interface Row {
  provider: string;
  component: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ref_id: string | null;
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range: Range = (["24h", "7d", "30d"] as const).includes(rangeParam as Range)
    ? (rangeParam as Range)
    : "7d";
  const since = new Date(Date.now() - RANGES.find((r) => r.key === range)!.ms).toISOString();

  // ai_usage RLS only lets a super_admins-table row read it; service-role keeps
  // this consistent with the rest of /admin (e.g. an ADMIN_EMAIL-only admin).
  const admin = createAdminSupabaseClient();
  let data: Row[] | null = null;
  let error: { message: string } | null = null;
  if (admin) {
    const r = await admin
      .from("ai_usage")
      .select("provider, component, cost_usd, input_tokens, output_tokens, ref_id")
      .gte("created_at", since)
      .limit(100000);
    data = (r.data ?? null) as Row[] | null;
    error = r.error;
  } else {
    error = { message: "Service-role key not configured" };
  }

  const rows = (data || []) as Row[];

  // Aggregate by provider and by component.
  const byProvider = new Map<string, { cost: number; calls: number }>();
  const byComponent = new Map<
    string,
    { provider: string; cost: number; calls: number; inTok: number; outTok: number; refs: Set<string> }
  >();
  let grandCost = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0;
    grandCost += cost;

    const p = byProvider.get(r.provider) || { cost: 0, calls: 0 };
    p.cost += cost;
    p.calls += 1;
    byProvider.set(r.provider, p);

    const c = byComponent.get(r.component) || {
      provider: r.provider,
      cost: 0,
      calls: 0,
      inTok: 0,
      outTok: 0,
      refs: new Set<string>(),
    };
    c.cost += cost;
    c.calls += 1;
    c.inTok += Number(r.input_tokens) || 0;
    c.outTok += Number(r.output_tokens) || 0;
    if (r.ref_id) c.refs.add(r.ref_id);
    byComponent.set(r.component, c);
  }

  const providerRows = [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const componentRows = [...byComponent.entries()].sort((a, b) => b[1].cost - a[1].cost);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">AI Usage &amp; Cost</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Unified ledger of every paid AI call across all services (edge functions, server,
            voice-engine). Reconcile against the Anthropic / Google / Resemble consoles.
          </p>
        </div>
        <div className="flex gap-1">
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

      {error && (
        <div className="rounded-lg border border-red-500 bg-red-50 p-3 text-sm text-red-700">
          Failed to load usage: {error.message}
        </div>
      )}

      {/* Grand total + per-provider summary */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total ({range})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{usd(grandCost)}</div>
            <p className="text-xs text-muted-foreground">{rows.length} calls</p>
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
                <p className="text-xs text-muted-foreground">{agg.calls} calls</p>
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
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 pr-4 font-medium text-right">Calls</th>
                    <th className="py-2 pr-4 font-medium text-right">Items</th>
                    <th className="py-2 pr-4 font-medium text-right">In tok</th>
                    <th className="py-2 pr-4 font-medium text-right">Out tok</th>
                    <th className="py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {componentRows.map(([component, c]) => (
                    <tr key={component} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{component}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline" className="text-[10px]">
                          {c.provider}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{c.calls}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {c.refs.size || "—"}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {c.inTok.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {c.outTok.toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums font-medium">{usd(c.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
