/**
 * Reading the AI cost ledger without silently truncating it.
 *
 * PostgREST caps every response at the project's `db-max-rows` (1000 here), and
 * it applies that cap AFTER the filters, with no error and no flag on the
 * response. So the obvious `.select("cost_usd").gte("created_at", since)` —
 * even with `.limit(100000)` — returns at most 1000 rows and a caller summing
 * them produces a number that looks like a total but is a sample. That is what
 * made /admin/usage show $7.78 for a 30-day window that actually held $62.19,
 * and what made the 7-day and 30-day figures identical (both windows exceed
 * 1000 rows, so both returned the same first 1000 rows).
 *
 * Correct path: `ai_usage_summary()` aggregates in Postgres, so one small
 * grouped result crosses the wire and truncation cannot happen.
 *
 * Fallback path: if that function isn't in the database yet (migration
 * 20260727161500 not applied), page through the raw rows in explicit
 * `.range()` windows and aggregate here. Slower, but still exact — a cost
 * dashboard that is quietly wrong is worse than one that is slow, so there is
 * no code path here that returns a partial sum without saying so.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** One (provider, component, model) group. */
export interface AiUsageGroup {
  provider: string;
  component: string;
  model: string;
  calls: number;
  /** Distinct ref_id values — messages/tasks/files touched, not API calls. */
  items: number;
  cost: number;
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheWriteTok: number;
  /**
   * Rows in this group with no cost recorded at all. Non-zero means the group's
   * cost is a floor, not a total — fal runs are logged by the video-lab harness
   * and a third of them currently arrive without a cost. Summing those as zero
   * and printing a clean figure would misrepresent it, so the count travels with
   * the data and the page says so.
   */
  missingCost: number;
}

export interface AiUsageSummary {
  groups: AiUsageGroup[];
  totalCost: number;
  totalCalls: number;
  /** How the numbers were obtained — surfaced in the UI so a degraded read is never mistaken for a clean one. */
  source: "rpc" | "paginated";
  /** Non-fatal problem worth showing the admin; null when the read was clean. */
  warning: string | null;
  error: string | null;
}

const PAGE_SIZE = 1000;
/**
 * Hard stop for the fallback loop: 200k rows. Reaching it means the ledger has
 * outgrown client-side aggregation entirely, and the summary says so rather
 * than quietly reporting a partial total.
 */
const MAX_FALLBACK_ROWS = 200_000;

const EMPTY: Omit<AiUsageSummary, "source" | "warning" | "error"> = {
  groups: [],
  totalCost: 0,
  totalCalls: 0,
};

interface RpcRow {
  provider: string;
  component: string;
  model: string;
  calls: number | string;
  items: number | string;
  cost_usd: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  missing_cost: number | string | null;
}

// Postgres bigint/numeric arrive as strings over PostgREST — Number() them, or
// `+` concatenates and every total silently becomes nonsense.
const n = (v: number | string | null | undefined): number => Number(v ?? 0) || 0;

/**
 * Grouped spend for `[since, until)`. `until` omitted means "up to now".
 * Never throws: a failed read comes back as `error` with zeroed totals.
 */
export async function fetchAiUsageSummary(
  db: SupabaseClient,
  since: Date,
  until?: Date,
): Promise<AiUsageSummary> {
  const rpc = await db.rpc("ai_usage_summary", {
    p_since: since.toISOString(),
    p_until: until ? until.toISOString() : null,
    p_user_id: null,
    p_component_prefix: null,
  });

  if (!rpc.error) {
    const groups: AiUsageGroup[] = ((rpc.data ?? []) as RpcRow[]).map((r) => ({
      provider: r.provider,
      component: r.component,
      model: r.model,
      calls: n(r.calls),
      items: n(r.items),
      cost: n(r.cost_usd),
      inTok: n(r.input_tokens),
      outTok: n(r.output_tokens),
      cacheReadTok: n(r.cache_read_tokens),
      cacheWriteTok: n(r.cache_write_tokens),
      missingCost: n(r.missing_cost),
    }));
    return {
      groups,
      totalCost: groups.reduce((s, g) => s + g.cost, 0),
      totalCalls: groups.reduce((s, g) => s + g.calls, 0),
      source: "rpc",
      warning: null,
      error: null,
    };
  }

  // PGRST202 = "function not found in schema cache", i.e. the migration hasn't
  // been applied. Any other error is a genuine failure and is reported as one
  // instead of being papered over by a slow second attempt.
  const missingFunction =
    rpc.error.code === "PGRST202" || /ai_usage_summary/i.test(rpc.error.message ?? "");
  if (!missingFunction) {
    return { ...EMPTY, source: "rpc", warning: null, error: rpc.error.message };
  }

  return paginatedSummary(db, since, until);
}

type GroupWithRefs = AiUsageGroup & { _refs?: Set<string> };

/**
 * Read every row of a table in the window, in explicit 1000-row pages.
 * Returns `truncated: true` if the safety ceiling was hit, so the caller can
 * say the total is partial instead of presenting it as complete.
 */
async function readAllRows(
  db: SupabaseClient,
  table: string,
  columns: string,
  since: Date,
  until?: Date,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; error: string | null }> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_FALLBACK_ROWS; from += PAGE_SIZE) {
    let q = db.from(table).select(columns).gte("created_at", since.toISOString());
    if (until) q = q.lt("created_at", until.toISOString());
    // A stable total order is required: without it PostgREST may repeat or skip
    // rows across pages, so the "exact" fallback would not be exact. created_at
    // alone is not unique enough under concurrent inserts — id breaks the tie.
    const { data, error } = await q
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { rows: out, truncated: false, error: error.message };
    // Double cast: `table` is a runtime string, so the client cannot resolve it
    // against the generated schema types and infers GenericStringError[]. The
    // rows are read defensively field-by-field below, so an untyped shape here
    // costs nothing.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return { rows: out, truncated: false, error: null };
  }
  return { rows: out, truncated: true, error: null };
}

/**
 * Exact but chatty fallback for when ai_usage_summary() is missing. Covers the
 * SAME sources the function does — ai_usage plus fal from experiment_runs —
 * because a fallback that quietly drops a provider would reintroduce the exact
 * defect this module exists to prevent.
 */
async function paginatedSummary(
  db: SupabaseClient,
  since: Date,
  until?: Date,
): Promise<AiUsageSummary> {
  const byKey = new Map<string, GroupWithRefs>();
  let totalCost = 0;
  let totalCalls = 0;

  const group = (provider: string, component: string, model: string): GroupWithRefs => {
    const key = `${provider}|${component}|${model}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        provider, component, model,
        calls: 0, items: 0, cost: 0,
        inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0,
        missingCost: 0,
      };
      byKey.set(key, g);
    }
    return g;
  };

  const api = await readAllRows(
    db,
    "ai_usage",
    "provider, component, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ref_id",
    since,
    until,
  );
  if (api.error) return { ...EMPTY, source: "paginated", warning: null, error: api.error };

  for (const r of api.rows) {
    const g = group(
      String(r.provider ?? "unknown"),
      String(r.component ?? "unknown"),
      (r.model as string | null) ?? "—",
    );
    const cost = n(r.cost_usd as number | string | null);
    g.calls += 1;
    g.cost += cost;
    g.inTok += n(r.input_tokens as number | string | null);
    g.outTok += n(r.output_tokens as number | string | null);
    g.cacheReadTok += n(r.cache_read_tokens as number | string | null);
    g.cacheWriteTok += n(r.cache_write_tokens as number | string | null);
    if (r.cost_usd === null || r.cost_usd === undefined) g.missingCost += 1;
    totalCost += cost;
    totalCalls += 1;
    if (r.ref_id) {
      g._refs ??= new Set();
      g._refs.add(String(r.ref_id));
    }
  }

  // fal.ai generation lives in experiment_runs, not ai_usage. Model names are
  // withheld ("—") to preserve blind scoring, matching what the RPC does.
  const fal = await readAllRows(
    db,
    "experiment_runs",
    "stage, code, cost_usd",
    since,
    until,
  );
  if (fal.error) return { ...EMPTY, source: "paginated", warning: null, error: fal.error };

  for (const r of fal.rows) {
    const g = group("fal", `fal.${(r.stage as string | null) ?? "other"}`, "—");
    const cost = n(r.cost_usd as number | string | null);
    g.calls += 1;
    g.cost += cost;
    if (r.cost_usd === null || r.cost_usd === undefined) g.missingCost += 1;
    totalCost += cost;
    totalCalls += 1;
    if (r.code) {
      g._refs ??= new Set();
      g._refs.add(String(r.code));
    }
  }

  const groups: AiUsageGroup[] = [...byKey.values()]
    .map((g) => {
      const items = g._refs?.size ?? 0;
      delete g._refs;
      return { ...g, items };
    })
    .sort((a, b) => b.cost - a.cost);

  const truncated = api.truncated || fal.truncated;
  return {
    groups,
    totalCost,
    totalCalls,
    source: "paginated",
    warning: truncated
      ? `Read the ${MAX_FALLBACK_ROWS.toLocaleString()}-row ceiling — this total is INCOMPLETE. Apply migration 20260727170000_ai_usage_summary_include_fal.sql.`
      : "Aggregated client-side because ai_usage_summary() is missing. Totals are exact but the page is slow — apply migration 20260727170000_ai_usage_summary_include_fal.sql.",
    error: null,
  };
}

/** Just the total, for callers that only show one number (the admin overview). */
export async function fetchAiUsageTotal(
  db: SupabaseClient,
  since: Date,
  until?: Date,
): Promise<{ cost: number; calls: number; error: string | null }> {
  const s = await fetchAiUsageSummary(db, since, until);
  return { cost: s.totalCost, calls: s.totalCalls, error: s.error };
}
