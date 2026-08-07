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

// Choke alert: an event-loop p99 above this (ms) in a 30s window means the
// process was blocked long enough to time requests out — i.e. a 502 window.
// When it crosses, write ONE level='error' log_entries row (category
// 'server_choke', user_id null — a system alert like db_health), which the
// daily health-check report surfaces the next morning. Cooldown so a sustained
// choke logs once, not every 30s.
const CHOKE_LAG_MS = Number(process.env.HEALTH_CHOKE_LAG_MS) || 500;
const ALERT_COOLDOWN_MS = Number(process.env.HEALTH_CHOKE_COOLDOWN_MS) || 15 * 60_000;

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
  let lastAlertAt = 0;
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
      const runs = activeRunCount();
      const lagP99 = Math.round(p99 * 100) / 100;

      const { error } = await db.from("server_health_samples").insert({
        loop_lag_p50_ms: Math.round(p50 * 100) / 100,
        loop_lag_p99_ms: lagP99,
        active_runs: runs,
        rss_mb: Math.round(rssMb * 10) / 10,
        uptime_s: Math.floor(process.uptime()),
        replica_id: process.env.RAILWAY_REPLICA_ID ?? null,
        vercel_state: providers.vercel,
        railway_state: providers.railway,
        supabase_state: providers.supabase,
      });
      if (error) console.error("[health-sampler] insert failed:", error.message);

      // Choke alert — a p99 above the threshold means requests were being timed
      // out (a 502 window). One system error row per cooldown, surfaced by the
      // daily health-check report. Mirrors the db_health watchdog (user_id null).
      if (lagP99 > CHOKE_LAG_MS && now - lastAlertAt >= ALERT_COOLDOWN_MS) {
        lastAlertAt = now;
        const { error: alertErr } = await db.from("log_entries").insert({
          level: "error",
          category: "server_choke",
          status: "failed",
          source_type: "server",
          error_message:
            `שרת נחנק: השהיית event-loop p99 ${lagP99}ms (מעל ${CHOKE_LAG_MS}ms) — ` +
            `חלון 502 סביר; ${runs} ריצות-קונסולה פעילות. RSS ${Math.round(rssMb)}MB.`,
          details: { loop_lag_p99_ms: lagP99, active_runs: runs, rss_mb: Math.round(rssMb), threshold_ms: CHOKE_LAG_MS },
        });
        if (alertErr) console.error("[health-sampler] choke alert insert failed:", alertErr.message);
        else console.warn(`[health-sampler] CHOKE p99=${lagP99}ms runs=${runs} — logged server_choke`);
      }

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
