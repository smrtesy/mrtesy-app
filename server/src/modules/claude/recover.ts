/**
 * Auto-resume of orphaned Claude console runs.
 *
 * THE PROBLEM. A console turn runs as an in-process `claude -p` child on the
 * Railway backend, with its claude_runs row marked `running`. Railway containers
 * are ephemeral: a redeploy (every push to main) or a crash kills the child
 * mid-turn. The registry that could cancel it and the runner's own try/catch both
 * live in that process and die with it, so NOTHING flips the row out of `running`.
 * The row sits live forever — the screen polls it forever ("חושב…" that never
 * moves) — and, crucially, the turn never continues on its own, even though the
 * whole conversation is reconstructable from our own DB (transcript.ts rebuilds it,
 * and runner.ts already retries a vanished engine session as a fresh one seeded
 * with that history). The reconstruction only fires when a NEW turn is sent; the
 * dead turn has no trigger to pick itself back up.
 *
 * THE FIX. This recoverer is that trigger. On a cadence (and shortly after boot,
 * to catch whatever the restart just orphaned) it finds runs stuck `running`/
 * `queued` with no live process and RE-EXECUTES them, so a turn interrupted by a
 * restart continues by itself. Recovery runs on the Claude subscription (zero paid
 * API tokens), exactly like a manual resend — it automates the resend the user
 * would otherwise do by hand.
 *
 * HOW "ORPHANED" IS DECIDED — two independent signals, both required:
 *   1. Not live in THIS process (isRunLive). A run this process is executing —
 *      even mid-clone, before the child spawns — is never touched.
 *   2. Stale: updated_at older than RESUME_STALE_MS. The runner pings updated_at
 *      every ~20s while a child runs (runner.ts HEARTBEAT_MS), so a healthy run is
 *      never stale; a run whose process died stops pinging and goes stale.
 *
 * SAFETY.
 *   - The claim is atomic: a single guarded UPDATE (still running/queued AND still
 *     stale → queued) is what lets exactly one scan take a run. Only after the claim
 *     succeeds are the dead run's partial events cleared — so a run that turned out
 *     live (lost the claim race) keeps its transcript intact.
 *   - resume_attempts caps the loop: a run that keeps dying (reliably OOMs the box,
 *     say) is resumed at most MAX_RESUME_ATTEMPTS times, then failed with a clear
 *     "resend" message rather than looped forever. Even an orphaned run can never
 *     spin.
 *   - Single-instance assumption: isRunLive is in-memory, so "not live here" equals
 *     "no process" only while one backend instance runs this module — the same
 *     assumption the cancel path documents. If this backend is ever scaled
 *     horizontally, RESUME_STALE_MS must rise above RUN_TIMEOUT_MS + a margin (a
 *     live run on another instance is SIGKILLed by its own timeout, so a run stale
 *     past that is dead on every instance), or a cross-instance liveness signal is
 *     needed. Documented here so that change isn't made silently.
 */

import { db } from "../../db";
import { executeRun, isRunLive, RUN_TIMEOUT_MS } from "./runner";

/** A run untouched this long with no in-process child is treated as orphaned. Well
 *  above the runner's 20s heartbeat (so a healthy run never trips it) and above a
 *  slow repo clone (so a run still setting up is never grabbed), yet small enough
 *  that a turn resumes within a couple of minutes of a restart. */
const RESUME_STALE_MS = 90_000;
/** Give up (fail, don't resume) after this many auto-continuations of one run. */
const MAX_RESUME_ATTEMPTS = 2;
/** How often to scan for orphaned runs. */
const SCAN_INTERVAL_MS = 60_000;
/** Let the server settle before the first scan (routes mounted, DB reachable). */
const BOOT_DELAY_MS = 15_000;
/** Cap per scan — a pathological backlog is worked across ticks, not all at once. */
const SCAN_BATCH = 20;

const GAVE_UP_MESSAGE =
  "ההרצה נקטעה שוב ושוב (כנראה שרת ה-Claude עלה מחדש באמצע התור יותר מפעם אחת). " +
  "ניסינו להמשיך אותה אוטומטית ולא הצלחנו — שלח את ההודעה שוב.";

async function recoverOrphanedRuns(): Promise<void> {
  const cutoffMs = Date.now() - RESUME_STALE_MS;
  const cutoff = new Date(cutoffMs).toISOString();

  const { data: candidates, error } = await db
    .from("claude_runs")
    .select("id, resume_attempts")
    .in("status", ["running", "queued"])
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(SCAN_BATCH);
  if (error) {
    console.error("[claude/recover] scan failed:", error.message);
    return;
  }

  for (const run of candidates ?? []) {
    // Owned by this process (including the pre-spawn clone window) — not orphaned.
    if (isRunLive(run.id)) continue;

    const attempts = run.resume_attempts ?? 0;

    if (attempts >= MAX_RESUME_ATTEMPTS) {
      // Terminal: stop the screen polling and tell the user to resend. Guarded on the
      // live states + still-stale so a run that recovered on its own is left alone.
      const { error: fErr } = await db
        .from("claude_runs")
        .update({
          status: "failed",
          error: GAVE_UP_MESSAGE,
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .in("status", ["running", "queued"])
        .lt("updated_at", cutoff);
      if (fErr) console.error("[claude/recover] give-up update failed:", fErr.message);
      continue;
    }

    // Atomically claim the run: only one scan (and only while it is STILL orphaned)
    // can flip it back to 'queued'. Winning this is the license to re-execute; losing
    // it means the run advanced under us and must be left untouched.
    const { data: claimed, error: cErr } = await db
      .from("claude_runs")
      .update({
        status: "queued",
        resume_attempts: attempts + 1,
        // A fresh attempt starts clean — the dead attempt's error/summary/timing must
        // not bleed into it.
        error: null,
        result_summary: null,
        started_at: null,
        ended_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .in("status", ["running", "queued"])
      .lt("updated_at", cutoff)
      .select("id")
      .maybeSingle();
    if (cErr) {
      console.error("[claude/recover] claim failed:", cErr.message);
      continue;
    }
    if (!claimed) continue; // lost the race — the run advanced or another scan took it

    // The dead attempt's events carry seq 1..N; a re-execution's nextSeq also starts
    // at 1, and (run_id, seq) is unique — so the old stream would collide and the new
    // one would be dropped. Clear it. The continuation rebuilds context from the DB
    // (the runner's resume-miss path), not from these rows, so nothing is lost.
    const { error: dErr } = await db.from("claude_run_events").delete().eq("run_id", run.id);
    if (dErr) console.error("[claude/recover] could not clear stale events:", dErr.message);

    console.warn(
      `[claude/recover] resuming orphaned run ${run.id} (attempt ${attempts + 1}/${MAX_RESUME_ATTEMPTS})`,
    );
    // Fire-and-forget: executeRun owns the row's terminal state and never throws at
    // the caller. A throw here would only be the launch itself failing.
    void executeRun(run.id).catch((e) =>
      console.error("[claude/recover] executeRun threw:", e instanceof Error ? e.message : e),
    );
  }
}

/**
 * Start the recovery loop: once shortly after boot (to catch what the restart just
 * orphaned), then on a fixed cadence. A no-op scan (nothing orphaned — the normal
 * case) is a single indexed query, so the idle cost is negligible. Set
 * CLAUDE_RUN_RECOVERY=off to disable.
 */
export function startClaudeRunRecovery(): void {
  if (process.env.CLAUDE_RUN_RECOVERY === "off") {
    console.log("[claude/recover] disabled via CLAUDE_RUN_RECOVERY=off");
    return;
  }
  console.log(
    `[claude/recover] armed — scanning every ${Math.round(SCAN_INTERVAL_MS / 1000)}s ` +
      `for runs orphaned >${Math.round(RESUME_STALE_MS / 1000)}s (run timeout ${Math.round(
        RUN_TIMEOUT_MS / 1000,
      )}s)`,
  );
  const boot = setTimeout(() => {
    void recoverOrphanedRuns();
  }, BOOT_DELAY_MS);
  if (typeof boot.unref === "function") boot.unref();
  const loop = setInterval(() => {
    void recoverOrphanedRuns();
  }, SCAN_INTERVAL_MS);
  if (typeof loop.unref === "function") loop.unref();
}
