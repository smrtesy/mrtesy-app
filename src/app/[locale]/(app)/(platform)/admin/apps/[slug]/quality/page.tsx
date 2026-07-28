export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

/**
 * Classifier quality trend (review §6.4). Reads one RPC —
 * classifier_quality_metrics() — which aggregates log_entries /
 * task_corrections / ai_usage in Postgres. No AI call, no new writes.
 *
 * Aggregating in the DB is not a nicety here: PostgREST silently caps any
 * response at db-max-rows (1000 on this project) AFTER filtering, which is how
 * /admin/usage once under-reported spend ~8x. A grouped result set can't hit
 * that cap.
 */

const WEEKS = 10;

interface WeekRow {
  week_start: string;
  classified_messages: number;
  ai_calls: number;
  corrections: number;
  correction_rate_pct: number | null;
  low_confidence_pct: number | null;
  escalations: number;
  parse_failures: number;
  cross_party_flags: number;
  cost_usd: number;
  cost_per_message_usd: number | null;
  cache_read_share_pct: number | null;
}

/** Weeks are ISO Monday-start dates; show them in the user's zone-free form. */
const weekFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function pct(n: number | null): string {
  return n === null || n === undefined ? "—" : `${Number(n).toFixed(2)}%`;
}

function pct1(n: number | null): string {
  return n === null || n === undefined ? "—" : `${Number(n).toFixed(1)}%`;
}

function usd(n: number | null, digits = 2): string {
  return n === null || n === undefined ? "—" : `$${Number(n).toFixed(digits)}`;
}

function num(n: number): string {
  return Number(n).toLocaleString();
}

/**
 * A count that should always be zero. Rendering a non-zero one in the normal
 * body colour is how the dupe_match truncation stayed invisible for a month —
 * the number was there, it just didn't look like anything.
 */
function ZeroExpected({ value }: { value: number }) {
  if (!value) return <span className="text-muted-foreground">0</span>;
  return <span className="font-semibold text-status-late">{num(value)}</span>;
}

export default async function AdminAppQualityPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  // The metrics read the classifier's own tables, so this surface only means
  // anything for smrtTask (registry gates the card the same way).
  if (slug !== "smrttask") notFound();

  const t = await getTranslations("admin");
  const admin = createAdminSupabaseClient();

  let rows: WeekRow[] = [];
  let error: string | null = null;
  if (!admin) {
    error = "Service-role key not configured";
  } else {
    const { data, error: rpcError } = await admin.rpc("classifier_quality_metrics", {
      p_weeks: WEEKS,
    });
    if (rpcError) {
      // A missing function (PGRST202) means the migration hasn't been applied —
      // say so precisely instead of showing an empty table that reads as "no
      // problems this quarter".
      error =
        rpcError.code === "PGRST202"
          ? "classifier_quality_metrics() is missing — apply migration 20260728030000_classifier_quality_metrics.sql"
          : rpcError.message;
    } else {
      rows = (data ?? []) as WeekRow[];
    }
  }

  const latest = rows[0];
  const previous = rows[1];
  // Compare against the previous FULL week, not the running one: the current
  // week is partial, so a same-week delta always reads as an improvement.
  const baseline = previous ?? null;
  const totalParseFailures = rows.reduce((s, r) => s + (r.parse_failures ?? 0), 0);
  const totalCrossParty = rows.reduce((s, r) => s + (r.cross_party_flags ?? 0), 0);

  function delta(current: number | null, before: number | null): string | null {
    if (current === null || before === null || before === undefined || current === undefined) return null;
    const d = Number(current) - Number(before);
    if (Math.abs(d) < 0.005) return "±0.00";
    return `${d > 0 ? "+" : ""}${d.toFixed(2)}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("appQualityTitle")}
        </Link>
        <h1 className="text-2xl font-bold mt-2">{t("appQualityTitle")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          Weekly trend for the message classifier, from data the pipeline already
          writes — no AI call and no extra cost. The headline is the correction
          rate: the share of classified messages that had to be fixed by hand.
          Judge every prompt or model change against it, and compare{" "}
          <span className="font-medium">cost per message</span> rather than token
          counts (a model change can move token counts ~30% for identical text).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-status-late bg-status-late-bg p-3 text-sm text-status-late">
          Failed to load metrics: {error}
        </div>
      )}

      {(totalParseFailures > 0 || totalCrossParty > 0) && (
        <div className="rounded-lg border border-status-warn bg-status-warn-bg p-3 text-sm text-status-warn space-y-1">
          {totalParseFailures > 0 && (
            <div>
              {num(totalParseFailures)} unparseable AI repl
              {totalParseFailures === 1 ? "y" : "ies"} in the last {WEEKS} weeks — each one is a
              duplicate check that silently found nothing. If they cluster, raise the
              dupe_match <code>max_tokens</code> ceiling.
            </div>
          )}
          {totalCrossParty > 0 && (
            <div>
              {num(totalCrossParty)} cross-party merge flag
              {totalCrossParty === 1 ? "" : "s"} — a task carried an update from a different
              person&rsquo;s chat. The identity veto should make this impossible; investigate
              before it repeats.
            </div>
          )}
        </div>
      )}

      {latest && (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Correction rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pct(latest.correction_rate_pct)}</div>
              <p className="text-xs text-muted-foreground">
                {num(latest.corrections)} of {num(latest.classified_messages)} this week
                {baseline && delta(latest.correction_rate_pct, baseline.correction_rate_pct)
                  ? ` · ${delta(latest.correction_rate_pct, baseline.correction_rate_pct)} pp vs last week`
                  : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Cost per message
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{usd(latest.cost_per_message_usd, 4)}</div>
              <p className="text-xs text-muted-foreground">
                {usd(latest.cost_usd)} over {num(latest.ai_calls)} calls
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Low confidence
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pct(latest.low_confidence_pct)}</div>
              <p className="text-xs text-muted-foreground">
                {num(latest.escalations)} escalated to a second model
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Prompt cache
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pct1(latest.cache_read_share_pct)}</div>
              <p className="text-xs text-muted-foreground">of prompt tokens served from cache</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Last {WEEKS} weeks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* Wide table scrolls inside its own container — the page body must
              never scroll horizontally. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-start font-medium px-4 py-2">Week of</th>
                  <th className="text-end font-medium px-4 py-2">Classified</th>
                  <th className="text-end font-medium px-4 py-2">Corrections</th>
                  <th className="text-end font-medium px-4 py-2">Rate</th>
                  <th className="text-end font-medium px-4 py-2">Low conf.</th>
                  <th className="text-end font-medium px-4 py-2">Escalations</th>
                  <th className="text-end font-medium px-4 py-2">Parse fails</th>
                  <th className="text-end font-medium px-4 py-2">Cross-party</th>
                  <th className="text-end font-medium px-4 py-2">Cost</th>
                  <th className="text-end font-medium px-4 py-2">Per msg</th>
                  <th className="text-end font-medium px-4 py-2">Cache</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.week_start} className="border-b last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {weekFmt.format(new Date(`${r.week_start}T00:00:00Z`))}
                    </td>
                    <td className="px-4 py-2 text-end">{num(r.classified_messages)}</td>
                    <td className="px-4 py-2 text-end">{num(r.corrections)}</td>
                    <td className="px-4 py-2 text-end font-medium">{pct(r.correction_rate_pct)}</td>
                    <td className="px-4 py-2 text-end">{pct(r.low_confidence_pct)}</td>
                    <td className="px-4 py-2 text-end text-muted-foreground">{num(r.escalations)}</td>
                    <td className="px-4 py-2 text-end">
                      <ZeroExpected value={r.parse_failures} />
                    </td>
                    <td className="px-4 py-2 text-end">
                      <ZeroExpected value={r.cross_party_flags} />
                    </td>
                    <td className="px-4 py-2 text-end">{usd(r.cost_usd)}</td>
                    <td className="px-4 py-2 text-end">{usd(r.cost_per_message_usd, 4)}</td>
                    <td className="px-4 py-2 text-end text-muted-foreground">
                      {pct1(r.cache_read_share_pct)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={11} className="px-4 py-6 text-center text-muted-foreground">
                      No classifier activity recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
