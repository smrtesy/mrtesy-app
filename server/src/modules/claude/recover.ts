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
 *   - resume_attempts caps the loop, but only counts the run's OWN failures: a run
 *     that keeps dying while the server stays up (reliably OOMs the box, say) is
 *     resumed at most MAX_RESUME_ATTEMPTS times, then failed with a clear "resend"
 *     message. A restart-orphan — a run killed because the whole process restarted
 *     (deploy / box restart), detected by a last heartbeat that predates
 *     PROCESS_BOOT_MS — does NOT count against that budget; penalizing a run for an
 *     external restart made long turns give up though they never failed. An absolute
 *     ORPHAN_MAX_AGE_MS bound still terminates a run that forever coincides with
 *     restarts, so even an uncounted orphan can never spin.
 *   - Single-instance assumption: isRunLive is in-memory, so "not live here" equals
 *     "no process" only while one backend instance runs this module — the same
 *     assumption the cancel path documents. If this backend is ever scaled
 *     horizontally, RESUME_STALE_MS must rise above RUN_TIMEOUT_MS + a margin (a
 *     live run on another instance is SIGKILLed by its own timeout, so a run stale
 *     past that is dead on every instance), or a cross-instance liveness signal is
 *     needed. Documented here so that change isn't made silently.
 */

import { db } from "../../db";
import {
  executeRun,
  isRunLive,
  RUN_TIMEOUT_MS,
  USAGE_LIMIT_SENTINEL,
  USAGE_UNTIL_RE,
  DEPLOY_WAIT_SENTINEL,
} from "./runner";
import { deployInFlight } from "./deploy-coordinator";
import { dispatchNextWaiting } from "./threads";

/** A run untouched this long with no in-process child is treated as orphaned. Well
 *  above the runner's 20s heartbeat (so a healthy run never trips it) and above a
 *  slow repo clone (so a run still setting up is never grabbed), yet small enough
 *  that a turn resumes within a couple of minutes of a restart. */
const RESUME_STALE_MS = 90_000;
/** Give up (fail, don't resume) after this many auto-continuations that were the
 *  RUN'S OWN fault (it crashed while the server stayed up — e.g. it reliably OOMs
 *  the box). Restart-orphans (external deploy/box restart) do NOT count against
 *  this — see PROCESS_BOOT_MS. Was 2; raised to 3 because a long turn (a build,
 *  an install) legitimately spans more than two deploys, and the old budget made
 *  it give up though it had never actually failed. */
const MAX_RESUME_ATTEMPTS = 3;
/** When THIS server process started (module-load time ≈ boot). A run whose last
 *  heartbeat predates it was orphaned by the restart that birthed this process —
 *  an EXTERNAL death (deploy / box restart), NOT the run crashing on its own. Such
 *  a death must not burn a resume attempt, or a turn that merely spans a couple of
 *  deploys exhausts the budget and gives up though it never failed. (Relies on the
 *  same single-instance assumption as isRunLive.) */
const PROCESS_BOOT_MS = Date.now();
/** Absolute bound on the orphan path — the ONLY thing that bounds a run which
 *  restarts the box on every attempt (a reliable-OOM run): its self-caused restart
 *  is indistinguishable by timing from a deploy, so it always reads as a
 *  restart-orphan and evades the per-attempt cap. 6h is far above any legitimate
 *  console turn (RUN_TIMEOUT_MS is 45 min PER attempt; a turn that hasn't completed
 *  a single uninterrupted window in 6h is stuck, not merely unlucky) yet bounds
 *  such a run's restart-thrash to hours, not a day. */
const ORPHAN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How often to scan for orphaned runs. */
const SCAN_INTERVAL_MS = 60_000;
/** Let the server settle before the first scan (routes mounted, DB reachable). */
const BOOT_DELAY_MS = 15_000;
/** Cap per scan — a pathological backlog is worked across ticks, not all at once. */
const SCAN_BATCH = 20;

const GAVE_UP_MESSAGE =
  "ההרצה נקטעה שוב ושוב (כנראה שרת ה-Claude עלה מחדש באמצע התור יותר מפעם אחת). " +
  "ניסינו להמשיך אותה אוטומטית ולא הצלחנו — שלח את ההודעה שוב.";

/** The blind retry cadence, used ONLY when the CLI's message did not name the
 *  reset moment (no `until=` in the sentinel). When it did, the retry is
 *  scheduled for that exact moment instead — the CLI usually says when the
 *  window resets, and waiting for it beats probing. */
const USAGE_RETRY_MS = 15 * 60 * 1000;
/** A blind-parked run (no known reset time) is given up after a day — a window
 *  that hasn't reset within one is not a window problem. */
const USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A run whose KNOWN reset time passed this long ago and still keeps failing is
 *  given up — the parse was wrong or something else is broken. */
const USAGE_UNTIL_GRACE_MS = 6 * 60 * 60 * 1000;
const USAGE_GAVE_UP_MESSAGE =
  "חלון השימוש במנוי לא התאפס במשך יממה, ולכן ההרצה לא הושלמה. שלח את ההודעה שוב.";

/**
 * Appended to a re-executed run's stored prompt (once — the includes() guard) so
 * the replayed turn KNOWS it is a replay. A re-execution runs the same prompt
 * from the top, and side effects the dead attempt already completed (a git push,
 * an applied migration, a board write) would otherwise be repeated blindly. A
 * prompt line is a mitigation, not a guarantee — but it costs nothing and points
 * the model at the code-checkable evidence (git log, DB state) before it acts.
 * Appended, not prepended: the runner's seed/history idempotency guards key off
 * the prompt's PREFIX (runner.ts startsWith checks), which must stay intact.
 */
const REPLAY_NOTE_HEADER = "# הערת המשך אוטומטי: ההרצה הקודמת נקטעה באמצע";
const REPLAY_NOTE =
  `\n\n---\n\n${REPLAY_NOTE_HEADER}\n\n` +
  "ייתכן שחלק מהפעולות כבר בוצעו לפני הקטיעה. לפני כל פעולה בעלת תופעות-לוואי " +
  "(דחיפה ל-git, החלת מיגרציה, כתיבה ל-DB או ללוח) בדוק קודם מה כבר קיים — " +
  "`git log`/`git status`, מצב הנתונים — ואל תחזור על פעולה שכבר הושלמה.";

/** Append the replay note to the run's stored prompt, once. Best-effort: a
 *  failure here must not block the resume itself. */
async function markReplayed(runId: string, prompt: string | null): Promise<void> {
  if (!prompt || prompt.includes(REPLAY_NOTE_HEADER)) return;
  const { error } = await db
    .from("claude_runs")
    .update({ prompt: `${prompt}${REPLAY_NOTE}` })
    .eq("id", runId);
  if (error) console.error("[claude/recover] replay note failed:", error.message);
}

export interface OrphanResumeDecision {
  /** Fail the run (stop retrying) instead of resuming. */
  giveUp: boolean;
  /** The death was an external restart (last heartbeat predates this process), not
   *  the run crashing on its own. */
  restartOrphan: boolean;
  /** What resume_attempts becomes on the next claim — unchanged for a restart-orphan,
   *  +1 for a self-inflicted crash. */
  nextAttempts: number;
}

/**
 * Decide what to do with an orphaned run from timing facts alone — pure, so the
 * branchy give-up/counting logic is unit-tested (recover.test.ts) instead of
 * only exercised in production.
 *
 * `lastBeatMs`/`createdMs` are the run's last-heartbeat and creation epochs (0 when
 * unparseable — treated as "unknown", never as 1970); `bootMs` = PROCESS_BOOT_MS.
 *
 *  - restartOrphan: last heartbeat predates this process → killed by a whole-server
 *    restart (deploy / box), not a crash in a living server.
 *  - giveUp: past the absolute age bound, OR a self-inflicted crash that has burned
 *    the attempt budget. A restart-orphan is NEVER given up on the budget — only on
 *    age — so an external restart can't doom a turn that never actually failed.
 *  - nextAttempts: unchanged for a restart-orphan (didn't earn a strike), else +1.
 */
export function classifyOrphanResume(args: {
  attempts: number;
  lastBeatMs: number;
  createdMs: number;
  nowMs: number;
  bootMs: number;
  maxAttempts?: number;
  maxAgeMs?: number;
}): OrphanResumeDecision {
  const maxAttempts = args.maxAttempts ?? MAX_RESUME_ATTEMPTS;
  const maxAgeMs = args.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const restartOrphan = args.lastBeatMs > 0 && args.lastBeatMs < args.bootMs;
  // Fail closed: an unknown creation time (0 / unparseable) must NOT disable the
  // absolute bound — otherwise a perpetual restart-orphan with a bad created_at
  // would never give up. Treat unknown age as "past the bound".
  const tooOld = args.createdMs <= 0 || args.nowMs - args.createdMs > maxAgeMs;
  const giveUp = tooOld || (!restartOrphan && args.attempts >= maxAttempts);
  const nextAttempts = restartOrphan ? args.attempts : args.attempts + 1;
  return { giveUp, restartOrphan, nextAttempts };
}

async function recoverOrphanedRuns(): Promise<void> {
  const cutoffMs = Date.now() - RESUME_STALE_MS;
  const cutoff = new Date(cutoffMs).toISOString();

  const { data: candidates, error } = await db
    .from("claude_runs")
    .select("id, resume_attempts, thread_id, org_id, error, prompt, created_at, updated_at")
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

    // A run parked because a batch deploy was in flight when it arrived (runner.ts
    // parks it 'queued' with DEPLOY_WAIT_SENTINEL, so it never spawns into a process
    // that's about to be SIGTERM-killed by the redeploy). Wait — WITHOUT burning a
    // resume attempt — until the deploy has landed, then resume it on the healthy
    // process. deployInFlight() self-bounds (a 'deploying' row stale >15m stops
    // counting), so a deploy that never lands can't strand the run forever.
    if ((run.error ?? "") === DEPLOY_WAIT_SENTINEL) {
      if (await deployInFlight()) continue; // still deploying — keep waiting
      // Deploy landed: atomically clear the sentinel (only one scan wins) and resume.
      const { data: claimed, error: cErr } = await db
        .from("claude_runs")
        .update({ error: null, updated_at: new Date().toISOString() })
        .eq("id", run.id)
        .eq("status", "queued")
        .eq("error", DEPLOY_WAIT_SENTINEL)
        .select("id")
        .maybeSingle();
      if (cErr || !claimed) continue; // another scan took it, or it changed under us
      // Clear any events defensively (a park usually has none) so a resume's seq 1..N
      // can't collide on UNIQUE(run_id, seq) — same as the usage path. On failure,
      // restore the sentinel so the row stays a deploy-wait park, never an orphan
      // (which would burn a resume attempt).
      const { error: dErr } = await db.from("claude_run_events").delete().eq("run_id", run.id);
      if (dErr) {
        console.error("[claude/recover] could not clear deploy-parked events:", dErr.message);
        const { error: rsErr } = await db
          .from("claude_runs")
          .update({ error: DEPLOY_WAIT_SENTINEL, updated_at: new Date().toISOString() })
          .eq("id", run.id)
          .eq("status", "queued");
        if (rsErr) console.error("[claude/recover] deploy sentinel restore failed:", rsErr.message);
        continue;
      }
      // NB: no markReplayed here — a deploy-park is set BEFORE the child spawns, so the
      // run never ran and there is nothing to replay-guard. (In the rare case it was
      // parked AFTER a prior partial attempt, the orphan recovery that led here already
      // added the note — adding it again would just stack it.)
      console.warn(`[claude/recover] resuming deploy-parked run ${run.id}`);
      void executeRun(run.id)
        .then(() => (run.thread_id ? dispatchNextWaiting(run.thread_id, run.org_id) : undefined))
        .catch((e) =>
          console.error("[claude/recover] deploy resume threw:", e instanceof Error ? e.message : e),
        );
      continue;
    }

    // A run parked on the subscription usage limit (runner.ts parks it 'queued'
    // with the sentinel on `error`). Its own slow-cadence retry loop, SEPARATE
    // from the orphan path below: retries do not consume resume_attempts (a
    // window that resets in three hours needs a dozen tries), and the loop is
    // bounded by AGE instead.
    if ((run.error ?? "").startsWith(USAGE_LIMIT_SENTINEL)) {
      // The reset moment the runner parsed out of the CLI's message, if any.
      const untilMatch = (run.error ?? "").match(USAGE_UNTIL_RE);
      const untilMs = untilMatch ? Date.parse(untilMatch[1]) : NaN;
      const hasUntil = Number.isFinite(untilMs);

      // Not yet time: a known reset moment still ahead means SLEEP, not probe —
      // this is the whole point of parsing it. (+60s so the window has actually
      // opened when the retry spawns.)
      if (hasUntil && Date.now() < untilMs + 60_000) continue;

      // Give up: a known reset that passed hours ago and the run is still
      // parked (each failed retry re-parks it), or a blind park older than a
      // day. Either way this is no longer a wait-for-the-window situation.
      // The absolute 3-day cap holds EVEN with a known reset time: each failed
      // retry re-parks with a fresh FUTURE until (the next window), so without
      // an age bound a persistently-exhausted account would wait-retry-repark
      // forever while the screen promises a resume.
      const createdMs = Date.parse(run.created_at ?? "") || 0;
      const pastAbsoluteCap = Date.now() - createdMs > 3 * USAGE_MAX_AGE_MS;
      const gaveUp =
        pastAbsoluteCap ||
        (hasUntil
          ? Date.now() - untilMs > USAGE_UNTIL_GRACE_MS
          : Date.now() - createdMs > USAGE_MAX_AGE_MS);
      if (gaveUp) {
        const { error: gErr } = await db
          .from("claude_runs")
          .update({
            status: "failed",
            error: USAGE_GAVE_UP_MESSAGE,
            ended_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", run.id)
          .eq("status", "queued");
        if (gErr) console.error("[claude/recover] usage give-up failed:", gErr.message);
        continue;
      }

      // Atomic claim: clear the sentinel so the runner sees a normal queued row;
      // only one scan can take it. resume_attempts deliberately untouched.
      // Guards differ by mode: with a known reset time the timing gate already
      // passed above, so matching the exact sentinel text is the atomicity (only
      // one UPDATE can flip error→null); without one, the updated_at gate is
      // what enforces the 15-minute cadence.
      let claimQ = db
        .from("claude_runs")
        .update({ error: null, updated_at: new Date().toISOString() })
        .eq("id", run.id)
        .eq("status", "queued")
        .eq("error", run.error ?? "");
      if (!hasUntil) {
        claimQ = claimQ.lt("updated_at", new Date(Date.now() - USAGE_RETRY_MS).toISOString());
      }
      const { data: claimed, error: cErr } = await claimQ.select("id").maybeSingle();
      if (cErr || !claimed) continue; // not yet time, or another scan took it
      // The parked attempt's events would collide with the retry's seq 1..N on
      // UNIQUE(run_id, seq) — clear them, exactly like the orphan path.
      const { error: dErr } = await db.from("claude_run_events").delete().eq("run_id", run.id);
      if (dErr) {
        console.error("[claude/recover] could not clear usage-parked events:", dErr.message);
        // Restore the sentinel the claim just cleared. Without it the row would
        // look like an ordinary orphan on the next scan and be routed to the
        // branch below — consuming resume_attempts (or failing outright at the
        // cap), which the usage path promises never to do.
        const { error: rsErr } = await db
          .from("claude_runs")
          .update({ error: run.error, updated_at: new Date().toISOString() })
          .eq("id", run.id)
          .eq("status", "queued");
        if (rsErr) console.error("[claude/recover] sentinel restore failed:", rsErr.message);
        continue; // retried on the next pass once the retry delay passes again
      }
      await markReplayed(run.id, run.prompt);
      console.warn(`[claude/recover] retrying usage-limited run ${run.id}`);
      void executeRun(run.id)
        .then(() => (run.thread_id ? dispatchNextWaiting(run.thread_id, run.org_id) : undefined))
        .catch((e) =>
          console.error("[claude/recover] usage retry threw:", e instanceof Error ? e.message : e),
        );
      continue;
    }

    const attempts = run.resume_attempts ?? 0;

    // Was this death the run's own fault or an external restart? The decision is pure
    // (classifyOrphanResume) so it can be unit-tested; see its doc. Restart-orphans
    // don't consume the attempt budget — the run never got a fair chance to finish.
    const { giveUp, restartOrphan, nextAttempts } = classifyOrphanResume({
      attempts,
      lastBeatMs: Date.parse(run.updated_at ?? "") || 0,
      createdMs: Date.parse(run.created_at ?? "") || 0,
      nowMs: Date.now(),
      bootMs: PROCESS_BOOT_MS,
    });

    if (giveUp) {
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
        resume_attempts: nextAttempts,
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
    if (dErr) {
      // Don't re-execute over a surviving partial stream: the re-run's seq 1..N would
      // collide with it on UNIQUE(run_id, seq) and the whole event batch would be
      // dropped. The run is already back to 'queued' with a fresh updated_at, so the
      // next scan retries the delete once it goes stale again (bounded by the attempt
      // cap). A transient delete error thus costs a cycle, not the turn.
      console.error("[claude/recover] could not clear stale events, skipping re-exec:", dErr.message);
      continue;
    }

    // The replayed turn should know it is a replay before it repeats a side
    // effect the dead attempt already performed.
    await markReplayed(run.id, run.prompt);

    console.warn(
      `[claude/recover] resuming orphaned run ${run.id} ` +
        (restartOrphan
          ? `(restart-orphan — attempt ${nextAttempts}/${MAX_RESUME_ATTEMPTS}, not counted)`
          : `(attempt ${nextAttempts}/${MAX_RESUME_ATTEMPTS})`),
    );
    // Fire-and-forget: executeRun owns the row's terminal state and never throws at
    // the caller. Chain the same waiting-queue dispatch the normal launch path uses
    // (threads.ts) so a turn queued behind this orphaned one runs when it finishes,
    // instead of waiting for someone to reopen the thread (the GET self-heal).
    void executeRun(run.id)
      .then(() => (run.thread_id ? dispatchNextWaiting(run.thread_id, run.org_id) : undefined))
      .catch((e) =>
        console.error("[claude/recover] resume/dispatch threw:", e instanceof Error ? e.message : e),
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
