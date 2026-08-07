/**
 * Passive backend health sampler.
 *
 * Records the health of THIS process into `server_health_samples` every ~30s:
 * event-loop lag (the direct "am I choking" signal), the number of in-flight
 * Claude console runs (the main thing that starves the shared process), RSS, and
 * uptime — plus each surface's deploy state so the history shows F/DB outages too.
 *
 * Why it exists: the browser-side "CORS" errors are really intermittent Railway
 * 502s, and client telemetry can't capture them (the report POST rides the same
 * failing backend). This is the server's own measurement — zero paid tokens, one
 * tiny INSERT per sample. See the migration header for the full rationale.
 *
 * Cadence: lag/runs/rss/uptime every SAMPLE_MS (cheap, local). Provider states are
 * refreshed on a slower PROVIDER_REFRESH_MS cadence (they hit external APIs) and the
 * last-known values are stamped onto every 30s row. Single-instance, like the other
 * background workers in index.ts.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { db } from "../db";
import { activeRunCount } from "../modules/claude/runner";
import { deployStatus } from "../modules/claude/deploy-status";

const SAMPLE_MS = 30_000;
const PROVIDER_REFRESH_MS = 5 * 60_000; // external APIs — don't hit them every 30s
const RETENTION_DAYS = 14;
const PRUNE_EVERY = 120; // ~once an hour at 30s cadence

let started = false;

type ProviderState = string | null;
interface ProviderStates {
  vercel: ProviderState;
  railway: ProviderState;
  supabase: ProviderState;
}

function stateOf(p: { configured?: boolean; state?: string }): ProviderState {
  if (p?.configured === false) return null;
  return p?.state ?? null;
}

export function startHealthSampler(): void {
  if (started) return;
  started = true;

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  let providers: ProviderStates = { vercel: null, railway: null, supabase: null };
  let lastProviderRefresh = 0;
  let ticks = 0;

  const refreshProviders = async () => {
    try {
      const s = await deployStatus();
      providers = {
        vercel: stateOf(s.vercel),
        railway: stateOf(s.railway),
        supabase: stateOf(s.supabase),
      };
    } catch {
      // Keep the last-known states — a transient provider-API blip must not blank
      // the history, and it is itself a signal we don't want to lose.
    }
  };

  const tick = async () => {
    try {
      // ns → ms; reset so each row reflects only the last window, not cumulative.
      const p50 = h.percentile(50) / 1e6;
      const p99 = h.percentile(99) / 1e6;
      h.reset();

      const now = Date.now();
      if (now - lastProviderRefresh >= PROVIDER_REFRESH_MS) {
        lastProviderRefresh = now;
        await refreshProviders();
      }

      const rssMb = process.memoryUsage().rss / 1_048_576;

      const { error } = await db.from("server_health_samples").insert({
        loop_lag_p50_ms: Math.round(p50 * 100) / 100,
        loop_lag_p99_ms: Math.round(p99 * 100) / 100,
        active_runs: activeRunCount(),
        rss_mb: Math.round(rssMb * 10) / 10,
        uptime_s: Math.floor(process.uptime()),
        replica_id: process.env.RAILWAY_REPLICA_ID ?? null,
        vercel_state: providers.vercel,
        railway_state: providers.railway,
        supabase_state: providers.supabase,
      });
      if (error) console.error("[health-sampler] insert failed:", error.message);

      if (++ticks % PRUNE_EVERY === 0) {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
        const { error: delErr } = await db
          .from("server_health_samples")
          .delete()
          .lt("captured_at", cutoff);
        if (delErr) console.error("[health-sampler] prune failed:", delErr.message);
      }
    } catch (e) {
      // Never let a sample throw uncaught — the interval must keep firing.
      console.error("[health-sampler] tick failed:", e instanceof Error ? e.message : e);
    }
  };

  // Prime provider states so the very first rows aren't blank, then sample on interval.
  void refreshProviders().finally(() => {
    lastProviderRefresh = Date.now();
  });
  const timer = setInterval(() => void tick(), SAMPLE_MS);
  timer.unref?.(); // never keep the process alive on its own
  console.log("[health-sampler] started — sampling every", SAMPLE_MS / 1000, "s");
}
