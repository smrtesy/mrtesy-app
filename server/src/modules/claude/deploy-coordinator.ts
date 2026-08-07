/**
 * Deploy coordinator — phase 3 of docs/claude-console/deploy-queue-plan.md.
 *
 * A background loop (like recover.ts, off the request path) that drains
 * claude_deploy_queue: when the batch of server/** fixes is all 'ready', has
 * settled, and no console run is mid-turn (or the MAX_WAIT_MS hard cap elapses), it
 * merges every ready branch into `main`, builds once, and pushes ONCE — so N
 * parallel server fixes cause ONE redeploy instead of N that kill each other, and
 * that one redeploy lands in a quiet window instead of killing a live run.
 *
 * DELIBERATELY DETERMINISTIC, not an LLM "deploy-run": merging + building +
 * pushing is mechanical, so a server-side git routine is cheaper, faster and more
 * predictable than spawning a Claude turn for it. This still honours decision A
 * ("a dedicated deployer, separate from the fix runs") — the deployer is just code,
 * not a model.
 *
 * SAFE BY DEFAULT: the whole loop is a no-op unless DEPLOY_QUEUE_ENABLED=1. Until
 * that flag is flipped, shipping this module changes nothing — the push-gate
 * (phase 2) that feeds the queue is also flag-gated, so nothing ever lands in the
 * queue while the flag is off.
 *
 * SELF-KILL RESILIENCE: the `git push origin main` this routine performs triggers
 * the very Railway redeploy that kills this process. Push is the LAST step; rows
 * are marked 'deploying' before it and reconciled after a restart — a 'deploying'
 * row whose branch is already in origin/main is marked done, otherwise it returns
 * to 'ready' and is retried. So a mid-push death never loses or double-shships work.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "../../db";
import { notify } from "../../lib/platform/notify";
import { ensureClone, getGitHubToken, gitEnvForRun, redact } from "./github";
import { markThreadShipped } from "./ship-status";
import { executeRun } from "./runner";

/** How many times the coordinator hands a merge conflict back to its own session for
 *  autonomous resolution before giving up and asking the human. A conflict usually
 *  clears on the first rebase-and-reship; the cap stops an unresolvable one looping. */
const MAX_CONFLICT_RETRIES = 2;

/** Master switch. The coordinator AND the push-gate are both gated on this, so
 *  with it unset the entire feature is inert (nothing queues, nothing deploys). */
function enabled(): boolean {
  return process.env.DEPLOY_QUEUE_ENABLED === "1";
}

/** Deploy when the batch has been quiet this long (no server fix entered/updated
 *  the queue) — the user's wave has stopped. */
const SETTLE_MS = 3 * 60_000;
/** The SINGLE hard cap: never hold the batch longer than this from the earliest
 *  queued fix, no matter what is still holding it (settle not yet reached, or a
 *  console run still active). Past it the batch deploys regardless (recover.ts
 *  replays whatever the restart interrupts) — so a never-quiet console can't strand
 *  a server fix forever. Exported so the threads list can show each queued thread
 *  its "will merge by" deadline (created_at + MAX_WAIT_MS) without duplicating the
 *  magic number. */
export const MAX_WAIT_MS = 45 * 60_000;
/** A 'conflict' row whose self-resolve turn hasn't re-shipped (flipping it back to
 *  'ready') within this long is escalated to the human — the safety net for a resolve
 *  turn that gave up, failed its build, or stalled, so a conflict is never silently
 *  stranded. Generous: a real rebase-resolve-build-reship completes well under it. */
const STALE_CONFLICT_MS = 30 * 60_000;
/** The batch's push redeploys Railway, which SIGTERMs every live console run
 *  mid-turn — the real reason console runs "fall" (diagnosed 2026-08-06: it's
 *  deploy restarts, NOT OOM). So hold the batch until no run is actively working:
 *  status running/queued AND a heartbeat (claude_runs.updated_at, bumped every 20s
 *  by the runner) fresher than this. A staler run is dead or sleeping (e.g. parked
 *  on a usage limit) and must NOT hold the deploy. Quiet windows are frequent —
 *  ~69% of 5-min samples had zero active runs — so a gap is found in minutes. */
const RUN_HEARTBEAT_FRESH_MS = 2 * 60_000;
/** How often the coordinator evaluates the queue. */
const SCAN_INTERVAL_MS = 30_000;
/** Give the server a moment to settle before the first evaluation. */
const BOOT_DELAY_MS = 20_000;

const REPO =
  process.env.RAILWAY_GIT_REPO_OWNER && process.env.RAILWAY_GIT_REPO_NAME
    ? `${process.env.RAILWAY_GIT_REPO_OWNER}/${process.env.RAILWAY_GIT_REPO_NAME}`
    : "smrtesy/mrtesy-app";

/** A dedicated checkout the coordinator owns — kept on the workspace volume so the
 *  node_modules layer survives restarts and the build stays fast. Never a thread's
 *  workspace. */
const DEPLOY_DIR = path.join(
  process.env.CLAUDE_WORKSPACE_ROOT || os.tmpdir(),
  "_deploy-coordinator",
);

const GIT_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 6 * 60_000;

/** In-process reentrancy guard for the WHOLE tick — set synchronously before any
 *  await, so the boot-delay tick and the interval tick can never run concurrently
 *  against the single shared DEPLOY_DIR checkout. */
let ticking = false;

interface QueueRow {
  id: string;
  org_id: string;
  thread_id: string;
  run_id: string | null;
  branch: string | null;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  conflict_attempts: number;
}

/** Run a command, capturing exit code + stdout + stderr (github.ts's own runner
 *  discards stdout; the deploy needs it for diagnostics). */
function exec(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
      if (stdout.length > 8000) stdout = stdout.slice(-8000);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The user to notify about a row — the run's owner, else the org owner. */
async function ownerOf(row: QueueRow): Promise<string | null> {
  if (row.run_id) {
    const { data } = await db.from("claude_runs").select("created_by").eq("id", row.run_id).maybeSingle();
    if (data?.created_by) return data.created_by;
  }
  const { data: org } = await db.from("organizations").select("created_by").eq("id", row.org_id).maybeSingle();
  return org?.created_by ?? null;
}

type NotifKind = "success" | "warning" | "action_required";
async function tellOwner(
  row: QueueRow,
  kind: NotifKind,
  title: string,
  body: string,
): Promise<void> {
  const userId = await ownerOf(row);
  if (!userId) return;
  await notify(row.org_id, userId, {
    app_slug: "smrttask",
    type: kind,
    title,
    body,
    link: `/claude?thread=${row.thread_id}`,
  }).catch((e) => console.error("[deploy-coord] notify failed:", e instanceof Error ? e.message : e));
}

/**
 * Hand a merge conflict back to the thread that produced it, as a new autonomous turn.
 * The session (a Claude agent with full shell) rebases its own branch on the current
 * main, resolves the conflict, rebuilds and re-ships — so the fix appears as a real
 * turn IN the conversation (not a silent server-side park) and needs no human. Runs on
 * the subscription, zero paid tokens. Returns true when the turn was enqueued.
 *
 * Mirrors the essential half of the /messages route: next turn_index, a follow-up
 * prompt (the thread's session already holds the standing instructions), and
 * executeRun when nothing else is live. Best-effort — a failure just leaves the row
 * for the human-notification fallback.
 */
async function enqueueResolveTurn(row: QueueRow, message: string): Promise<boolean> {
  const { data: thread, error: tErr } = await db
    .from("claude_threads")
    .select("id, org_id, created_by, session_id, model, effort, repo, git_branch, claude_account, playbook_id")
    .eq("id", row.thread_id)
    .maybeSingle();
  if (tErr || !thread) {
    console.error("[deploy-coord] resolve-turn: thread load failed:", tErr?.message);
    return false;
  }

  const { data: last } = await db
    .from("claude_runs")
    .select("turn_index")
    .eq("thread_id", thread.id)
    .order("turn_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const turnIndex = (last?.turn_index ?? 0) + 1;

  // Is a turn already executing/queued for this thread? Then queue BEHIND it as
  // 'waiting' (the dispatcher promotes it) rather than starting a second engine
  // process in the one workspace.
  const { data: liveRuns } = await db
    .from("claude_runs")
    .select("id")
    .eq("thread_id", thread.id)
    .in("status", ["running", "queued", "waiting"])
    .limit(1);
  const hasLive = (liveRuns?.length ?? 0) > 0;

  const { data: run, error: iErr } = await db
    .from("claude_runs")
    .insert({
      org_id: thread.org_id,
      created_by: thread.created_by,
      thread_id: thread.id,
      turn_index: turnIndex,
      title: "פתרון קונפליקט מיזוג",
      prompt: message,
      user_prompt: message,
      playbook_id: null, // a follow-up turn — the resumed session already holds the setup
      model: thread.model,
      effort: thread.effort,
      repo: thread.repo,
      git_branch: thread.git_branch,
      claude_account: thread.claude_account,
      status: hasLive ? "waiting" : "queued",
    })
    .select("id")
    .single();
  if (iErr || !run) {
    console.error("[deploy-coord] resolve-turn: insert failed:", iErr?.message);
    return false;
  }
  if (!hasLive) {
    void executeRun(run.id).catch((e) =>
      console.error("[deploy-coord] resolve-turn executeRun threw:", e instanceof Error ? e.message : e),
    );
  }
  return true;
}

async function setState(id: string, state: string, error?: string | null): Promise<void> {
  const { error: e } = await db
    .from("claude_deploy_queue")
    .update({ state, error: error ?? null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (e) console.error("[deploy-coord] setState failed:", e.message);
}

async function removeRow(id: string): Promise<void> {
  const { error } = await db.from("claude_deploy_queue").delete().eq("id", id);
  if (error) console.error("[deploy-coord] delete failed:", error.message);
}

/** Read the current main tip in DEPLOY_DIR (post-merge/post-push HEAD) so the ship
 *  watcher has a SHA to confirm the Railway build against. Best-effort — a failure
 *  just means the dot settles by timeout instead of by SHA match. */
async function currentMainSha(env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "HEAD"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Is `branch` already contained in origin/main? (i.e. its deploy already landed) */
async function branchInMain(branch: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await exec(
    "git",
    ["merge-base", "--is-ancestor", `origin/${branch}`, "origin/main"],
    { cwd: DEPLOY_DIR, timeoutMs: 30_000, env },
  );
  return r.code === 0;
}

/** Prepare the coordinator's checkout: clone once, then hard-sync to origin/main. */
async function prepWorkspace(token: string): Promise<boolean> {
  const env = gitEnvForRun(token);
  try {
    await ensureClone(DEPLOY_DIR, REPO, "main", token);
  } catch (e) {
    console.error("[deploy-coord] clone failed:", e instanceof Error ? e.message : e);
    return false;
  }
  if (!existsSync(path.join(DEPLOY_DIR, ".git"))) return false;

  // ensureClone is --depth 1. A shallow `main` shares no visible ancestor with the
  // feature branches, so BOTH `git merge --no-ff` (→ "refusing to merge unrelated
  // histories") and `git merge-base --is-ancestor` (the reconcile check) fail.
  // Deepen to full history once; a fresh branch fetch then finds a real merge-base.
  const shallow = await exec("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: DEPLOY_DIR,
    timeoutMs: 30_000,
    env,
  });
  if (shallow.stdout.trim() === "true") {
    const un = await exec("git", ["fetch", "--unshallow", "origin"], {
      cwd: DEPLOY_DIR,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    if (un.code !== 0) {
      console.error("[deploy-coord] unshallow failed:", redact(un.stderr, token).slice(0, 400));
      return false;
    }
  }

  // Scrub any leftover state from a prior tick that died or aborted mid-merge BEFORE
  // touching main — a lingering in-progress merge or a stray untracked file makes the
  // next `merge --no-ff` conflict even for a clean fast-forward branch (the dirty
  // DEPLOY_DIR bug that parked a lone, mathematically un-conflictable row four times).
  // Each is a no-op on an already-clean checkout, so a non-zero exit here is expected
  // and NOT fatal — the fetch/checkout/reset below is the real guarantee. `clean -fd`
  // spares gitignored build artifacts (node_modules/dist), so the build stays fast.
  await exec("git", ["merge", "--abort"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env });
  await exec("git", ["reset", "--hard"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env });
  await exec("git", ["clean", "-fd"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env });

  const steps: string[][] = [
    ["fetch", "origin", "main", "--prune"],
    ["checkout", "main"],
    ["reset", "--hard", "origin/main"],
  ];
  for (const args of steps) {
    const r = await exec("git", args, { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env });
    if (r.code !== 0) {
      console.error(`[deploy-coord] git ${args[0]} failed:`, redact(r.stderr, token).slice(0, 400));
      return false;
    }
  }
  return true;
}

/**
 * Reconcile rows left 'deploying' by a previous process that died mid/after push:
 * if the branch is already in origin/main the deploy landed → done; otherwise it
 * never pushed → back to 'ready' for a retry.
 */
async function reconcileDeploying(rows: QueueRow[], env: NodeJS.ProcessEnv): Promise<void> {
  // Refresh the local origin/main ref: a death between the remote ack and the local
  // ref update would otherwise leave the ancestry check reading a stale main.
  await exec("git", ["fetch", "origin", "main", "--prune"], {
    cwd: DEPLOY_DIR,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  }).catch(() => undefined);
  for (const row of rows) {
    if (!row.branch) {
      await setState(row.id, "ready");
      continue;
    }
    // Explicit refspec: DEPLOY_DIR was cloned `--depth 1 --branch main`, so its
    // configured fetch refspec is single-branch (`+refs/heads/main:…`). A plain
    // `git fetch origin <branch>` would land the tip in FETCH_HEAD WITHOUT creating
    // `refs/remotes/origin/<branch>`, so `branchInMain`'s `origin/<branch>` below
    // would not resolve and every reconcile would read the deploy as "not landed".
    await exec("git", ["fetch", "origin", `+${row.branch}:refs/remotes/origin/${row.branch}`], {
      cwd: DEPLOY_DIR,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    }).catch(() => undefined);
    if (await branchInMain(row.branch, env)) {
      // Already landed on main (this or a prior process pushed it) — arm the ship
      // watcher so the rail dot goes green when the Railway build confirms live.
      await markThreadShipped(row.thread_id, {
        state: "main_building",
        sha: await currentMainSha(env),
        surface: "railway",
        branch: row.branch,
      });
      await removeRow(row.id);
    } else {
      await setState(row.id, "ready"); // push never happened — retry in the next batch
    }
  }
}

/**
 * Safety net for self-heal: a 'conflict' row whose autonomous resolve turn never came
 * back (it gave up, its build failed so ship.sh never re-marked it, or it stalled) sits
 * 'conflict' forever — the coordinator only rescans building/ready, so nothing would
 * ever surface it. Age it out to the human: red dot + notification, once (state→failed,
 * which the scan also skips, so it can't re-fire). A late resolve re-ship still recovers
 * it (mark-ready flips failed→ready). Its updated_at is bumped on every real attempt, so
 * this only fires when the resolve genuinely didn't return within STALE_CONFLICT_MS.
 */
async function escalateStaleConflicts(): Promise<void> {
  const { data: rows, error } = await db.from("claude_deploy_queue").select("*").eq("state", "conflict");
  if (error) {
    console.error("[deploy-coord] stale-conflict scan failed:", error.message);
    return;
  }
  const staleBefore = Date.now() - STALE_CONFLICT_MS;
  for (const row of (rows ?? []) as QueueRow[]) {
    if (Date.parse(row.updated_at ?? "") >= staleBefore) continue; // still inside the resolve window
    await setState(row.id, "failed", `${row.branch ?? "?"}: self-resolve did not return`);
    await markThreadShipped(row.thread_id, {
      state: "failed",
      branch: row.branch,
      detail: "קונפליקט מיזוג — הפתרון האוטומטי לא הושלם",
    });
    await tellOwner(
      row,
      "action_required",
      "קונפליקט מיזוג — צריך את עזרתך",
      `הענף \`${row.branch}\` נשאר בקונפליקט — הפתרון האוטומטי לא חזר. פתור ידנית ושַלֵּח שוב.`,
    );
    console.log(`[deploy-coord] stale conflict on ${row.branch} escalated to human`);
  }
}

/**
 * Is any console run actively working right now? A run counts as active only if its
 * status is running/queued AND its heartbeat is fresher than RUN_HEARTBEAT_FRESH_MS
 * — a stale-heartbeat run is dead or sleeping (e.g. parked on a usage limit) and does
 * not deserve to hold the deploy. Used as the pre-deploy quiet-window gate so the
 * batch's Railway restart lands when it won't kill mid-turn work.
 */
async function activeRunsExist(): Promise<boolean> {
  const freshAfter = new Date(Date.now() - RUN_HEARTBEAT_FRESH_MS).toISOString();
  const { data, error } = await db
    .from("claude_runs")
    .select("id")
    .in("status", ["running", "queued"])
    .gte("updated_at", freshAfter)
    .limit(1);
  if (error) {
    // Fail SAFE: if we can't tell whether runs are live, assume they are and wait.
    // Never redeploy blind into what might be a busy window — the MAX_WAIT_MS hard
    // cap still guarantees the batch eventually ships even if this keeps erroring.
    console.error("[deploy-coord] active-run check failed (holding batch):", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

/** A 'deploying' row older than this is a stuck/abandoned batch — it must NOT keep
 *  holding new runs forever. Normally a 'deploying' row lives only minutes: the
 *  coordinator sets it, builds, pushes, and the restart's reconcile clears it within
 *  ~40s of the fresh boot. This bound is the backstop for a batch that never lands. */
const DEPLOY_STALE_MS = 15 * 60_000;

/**
 * Is a batch deploy in flight right now? True iff a fresh 'deploying' row exists —
 * i.e. the coordinator has claimed a batch and is merging/building/pushing, so the
 * Railway backend is about to restart. The runner uses this to PARK a newly-arriving
 * run instead of spawning a child that the imminent restart would just SIGTERM
 * mid-turn (the run then resumes on the healthy process — see recover.ts's
 * deploy-wait branch). Fails OPEN (returns false): a DB error must not stall the
 * whole console by parking every new run — a missed hold risks at most one
 * restart-kill, which recovery already handles.
 */
export async function deployInFlight(): Promise<boolean> {
  const freshAfter = new Date(Date.now() - DEPLOY_STALE_MS).toISOString();
  const { data, error } = await db
    .from("claude_deploy_queue")
    .select("id")
    .eq("state", "deploying")
    .gte("updated_at", freshAfter)
    .limit(1);
  if (error) {
    console.error("[deploy-coord] deployInFlight check failed (not holding):", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * The batch deploy: merge every ready branch into main, build once, push once.
 * Rows are already 'deploying'. A genuine conflict is handed back to its own session
 * for autonomous resolution (enqueueResolveTurn), capped by conflict_attempts, then
 * escalated to the human — the coordinator itself never edits conflicted code.
 */
async function runBatchDeploy(rows: QueueRow[], token: string, pastCap: boolean): Promise<void> {
  const env = gitEnvForRun(token);
  if (!(await prepWorkspace(token))) {
    for (const r of rows) await setState(r.id, "ready"); // couldn't even prep — retry later
    return;
  }

  // Snapshot the main we're building this batch on. A merge conflict below is only
  // GENUINE if main is still at this SHA when it happens; if main advanced under us
  // the conflict is transient (a branch cut from a newer main) and the batch just
  // needs to retry on that newer main — see the conflict handler.
  const baseMain = (
    await exec("git", ["rev-parse", "origin/main"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env })
  ).stdout.trim();

  const merged: QueueRow[] = [];
  // Rows already given a TERMINAL state this pass (a real fetch failure) — the
  // transient-conflict reset below must not resurrect them back to 'ready', which
  // would re-fire their failure notification and re-churn a legitimately-dead fix.
  const settled = new Set<string>();
  for (const row of rows) {
    if (!row.branch) {
      await setState(row.id, "failed", "no branch recorded");
      await markThreadShipped(row.thread_id, { state: "failed", branch: row.branch, detail: "אין ענף רשום" });
      settled.add(row.id);
      continue;
    }
    // Explicit refspec — see reconcileDeploying: the single-branch clone means a
    // plain `git fetch origin <branch>` never creates `refs/remotes/origin/<branch>`,
    // so the `git merge --no-ff origin/<branch>` below could not resolve the ref and
    // exited non-zero. That non-zero exit was then misread as a merge CONFLICT, which
    // is why a clean, alone-in-queue, fast-forward branch was parked `conflict` every
    // time. Writing the tracking ref makes `origin/<branch>` resolve and the merge run.
    const f = await exec("git", ["fetch", "origin", `+${row.branch}:refs/remotes/origin/${row.branch}`], {
      cwd: DEPLOY_DIR,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    if (f.code !== 0) {
      await setState(row.id, "failed", redact(f.stderr, token).slice(0, 300));
      await markThreadShipped(row.thread_id, { state: "failed", branch: row.branch, detail: "כשל בהבאת הענף" });
      await tellOwner(row, "action_required", "פריסה נכשלה", `לא הצלחתי להביא את הענף \`${row.branch}\`.`);
      settled.add(row.id);
      continue;
    }
    const m = await exec(
      "git",
      ["merge", "--no-ff", `origin/${row.branch}`, "-m", `Deploy-batch merge ${row.branch}`],
      { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env },
    );
    if (m.code !== 0) {
      // Capture which files conflict BEFORE aborting (the abort clears the index) —
      // so the resolve turn (and the operator) get the actual file list, not "batch".
      const conflictFiles = (
        await exec("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: DEPLOY_DIR,
          timeoutMs: 30_000,
          env,
        })
      ).stdout.trim();
      await exec("git", ["merge", "--abort"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env });

      // Transient vs. genuine conflict. If origin/main moved since we snapshotted it,
      // this batch was cut against a stale main: reset the WHOLE claimed batch back to
      // 'ready' and bail, so the next tick re-preps on the newer main and retries —
      // the same retry philosophy as the non-fast-forward push failure below. Only a
      // conflict against an UNCHANGED main is real and gets parked. Past the 30-min cap
      // we stop deferring and park it, so a genuinely stuck row can't spin forever.
      if (!pastCap) {
        await exec("git", ["fetch", "origin", "main", "--prune"], {
          cwd: DEPLOY_DIR,
          timeoutMs: GIT_TIMEOUT_MS,
          env,
        });
        const freshMain = (
          await exec("git", ["rev-parse", "origin/main"], { cwd: DEPLOY_DIR, timeoutMs: 30_000, env })
        ).stdout.trim();
        if (freshMain && baseMain && freshMain !== baseMain) {
          // Retry the whole batch on the newer main — except rows already terminal
          // this pass (a fetch failure), which stay failed.
          for (const r of rows) if (!settled.has(r.id)) await setState(r.id, "ready");
          await exec("git", ["reset", "--hard", "origin/main"], {
            cwd: DEPLOY_DIR,
            timeoutMs: GIT_TIMEOUT_MS,
            env,
          });
          console.log(
            `[deploy-coord] transient conflict on ${row.branch}: origin/main moved ` +
              `${baseMain.slice(0, 7)}→${freshMain.slice(0, 7)} mid-batch — batch reset to ready, will retry`,
          );
          return;
        }
      }

      const filesLabel = conflictFiles || "(לא זוהו קבצים ספציפיים)";
      // SELF-HEALING: hand the conflict back to the session that wrote the branch as an
      // autonomous turn — it rebases on current main, resolves, rebuilds and re-ships.
      // The row stays 'conflict' (the coordinator skips it) until that re-ship flips it
      // back to 'ready' via mark-ready. Capped by conflict_attempts so an unresolvable
      // conflict falls back to the human instead of looping forever.
      if (row.conflict_attempts < MAX_CONFLICT_RETRIES) {
        const enqueued = await enqueueResolveTurn(
          row,
          `⚠️ הפריסה של הענף \`${row.branch}\` נכשלה במיזוג ל-main — **קונפליקט מיזוג** בקבצים:\n` +
            `${filesLabel}\n\n` +
            `ענף אחר שנפרס לפניך נגע באותן שורות. פתור בעצמך, בלי לשאול אותי:\n` +
            `1. ודא שאתה על הענף \`${row.branch}\` (אם לא: \`git fetch origin ${row.branch} && git checkout ${row.branch}\`).\n` +
            `2. \`git fetch origin main\`, ומזג \`origin/main\` לתוך הענף — פתור את הקונפליקטים בקבצים שלמעלה — שמור על שני הצדדים כשצריך, אל תדרוס עיוור.\n` +
            `3. הרץ את פרוטוקול לפני-הדחיפה (build) ותקן כל שגיאה.\n` +
            `4. שַלֵּח שוב עם \`scripts/ship.sh ${row.branch}\`.\n\n` +
            `(שאר הצרור כבר נפרס ל-main; רק הענף שלך נשאר.)`,
        );
        if (enqueued) {
          // State + counter in ONE checked write. If it fails, the counter wouldn't
          // advance (risking an unbounded loop), so fall through to the human path.
          const { error: incErr } = await db
            .from("claude_deploy_queue")
            .update({
              state: "conflict",
              error: `merge conflict in: ${filesLabel} — self-resolving (attempt ${row.conflict_attempts + 1})`,
              conflict_attempts: row.conflict_attempts + 1,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          if (!incErr) {
            // No red dot / no notification: the enqueued turn makes the thread live, so
            // the rail shows it working — that IS the "here's what's happening" reference.
            // A resolve turn that never re-ships is caught by escalateStaleConflicts().
            console.log(`[deploy-coord] conflict on ${row.branch} handed back to its session (attempt ${row.conflict_attempts + 1})`);
            continue;
          }
          console.error("[deploy-coord] conflict_attempts increment failed:", incErr.message);
        }
        // enqueue (or the counter write) failed → fall through to the human notification.
      }

      // Cap reached (or couldn't enqueue): stop auto-resolving, ask the human.
      await setState(row.id, "conflict", `merge conflict in: ${filesLabel}`);
      await markThreadShipped(row.thread_id, { state: "failed", branch: row.branch, detail: `קונפליקט מיזוג: ${filesLabel}` });
      await tellOwner(
        row,
        "action_required",
        "קונפליקט מיזוג — צריך את עזרתך",
        `הענף \`${row.branch}\` מתנגש עם הצרור בקבצים: ${filesLabel}. ניסיונות הפתרון האוטומטיים מוצו — פתור ידנית ושַלֵּח שוב.`,
      );
      continue;
    }
    merged.push(row);
  }

  if (merged.length === 0) {
    await exec("git", ["reset", "--hard", "origin/main"], { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env });
    return;
  }

  // Build once on the merged result — the integration gate (each fix already
  // passed the full pre-push protocol on its own branch). Server build: this is
  // what decides whether Railway boots after the deploy.
  // `--include=dev` is REQUIRED: the coordinator runs with NODE_ENV=production
  // (Railway sets it), under which npm omits devDependencies — but the build below
  // is `tsc`, and both `typescript` and every `@types/*` package are devDeps. A
  // plain `npm install` here leaves them out, so `npm run build` fails with
  // "Could not find a declaration file for module 'express'" and a perfectly good
  // merged batch is parked `failed`. `--include=dev` overrides the production omit.
  const install = await exec("npm", ["install", "--no-audit", "--no-fund", "--include=dev"], {
    cwd: path.join(DEPLOY_DIR, "server"),
    timeoutMs: BUILD_TIMEOUT_MS,
    env,
  });
  // An install failure is almost always transient (a registry/network flake), NOT
  // the merged code being broken — so it is RETRYABLE (back to 'ready'), never a
  // terminal 'failed' that makes the user resend a perfectly good fix. Only a real
  // BUILD failure below is the code's fault.
  if (install.code !== 0) {
    for (const row of merged) await setState(row.id, "ready");
    await exec("git", ["reset", "--hard", "origin/main"], { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env });
    console.error("[deploy-coord] npm install failed (will retry):", redact(install.stderr, token).slice(-400));
    return;
  }
  const build = await exec("npm", ["run", "build"], {
    cwd: path.join(DEPLOY_DIR, "server"),
    timeoutMs: BUILD_TIMEOUT_MS,
    env,
  });
  if (build.code !== 0) {
    const tail = redact(`${build.stdout}\n${build.stderr}`, token).slice(-800);
    for (const row of merged) {
      await setState(row.id, "failed", tail);
      await markThreadShipped(row.thread_id, { state: "failed", branch: row.branch, detail: "בניית-הצרור נכשלה" });
      await tellOwner(row, "action_required", "בניית-הצרור נכשלה — לא נפרס", `הבנייה על הצרור הממוזג נכשלה, לא דחפתי ל-main.\n\n${tail}`);
    }
    await exec("git", ["reset", "--hard", "origin/main"], { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env });
    return;
  }

  // Push once. This is the last act: it triggers the redeploy that kills this
  // process, so rows are reconciled on restart if we die before marking them done.
  const push = await exec("git", ["push", "origin", "main"], {
    cwd: DEPLOY_DIR,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (push.code !== 0) {
    // A non-fast-forward means origin/main moved under us — reset to ready and the
    // next tick re-merges onto the newer main.
    for (const row of merged) await setState(row.id, "ready");
    console.error("[deploy-coord] push failed:", redact(push.stderr, token).slice(0, 400));
    return;
  }
  // The main tip we just pushed — the SHA the ship watcher confirms the Railway
  // build against, flipping each thread's rail dot to green when it goes live.
  const mainSha = await currentMainSha(env);
  for (const row of merged) {
    await markThreadShipped(row.thread_id, {
      state: "main_building",
      sha: mainSha,
      surface: "railway",
      branch: row.branch,
    });
    await removeRow(row.id);
  }
  console.log(`[deploy-coord] deployed batch of ${merged.length} branch(es)`);
}

/** One evaluation of the queue. Non-reentrant (the `ticking` flag is set before any
 *  await) and wrapped so a thrown error logs once instead of firing an unhandled
 *  rejection every 30s. */
async function coordinatorTick(): Promise<void> {
  if (!enabled() || ticking) return;
  ticking = true;
  try {
    const token = await getGitHubToken();
    if (!token) return; // no push credential → can't deploy; leave the queue as-is
    const env = gitEnvForRun(token);

    // Reconcile deploys a previous (killed) process left mid-flight. Only touch git
    // when 'deploying' rows exist, and (re-)prepare the checkout first — a redeploy
    // onto a non-persistent volume wipes DEPLOY_DIR, so gating reconcile on an
    // existing checkout would strand those rows forever.
    const { data: deployingRows } = await db
      .from("claude_deploy_queue")
      .select("*")
      .eq("state", "deploying");
    if (deployingRows && deployingRows.length > 0 && (await prepWorkspace(token))) {
      await reconcileDeploying(deployingRows as QueueRow[], env);
    }

    await escalateStaleConflicts();

    const { data: rows, error } = await db
      .from("claude_deploy_queue")
      .select("*")
      .eq("state", "ready")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[deploy-coord] scan failed:", error.message);
      return;
    }
    const ready = (rows ?? []) as QueueRow[];
    if (ready.length === 0) return; // nothing shippable yet

    // The single hard cap: once the earliest queued fix has waited MAX_WAIT_MS, the
    // batch deploys no matter what is still holding it (settle or an active run).
    const earliest = Math.min(...ready.map((r) => Date.parse(r.created_at) || Date.now()));
    const pastCap = Date.now() - earliest > MAX_WAIT_MS;

    // Settle: no server change entered/updated the queue recently — unless past cap.
    const lastActivity = Math.max(...ready.map((r) => Date.parse(r.updated_at) || 0));
    if (Date.now() - lastActivity < SETTLE_MS && !pastCap) return;

    // Quiet-window gate: the push below redeploys Railway and SIGTERMs every live
    // console run mid-turn — the actual cause of runs "falling". Hold the batch
    // until no run is actively working, so the restart lands in a gap. The same
    // MAX_WAIT_MS cap forces past it, so a never-quiet console can't strand a fix.
    if (!pastCap && (await activeRunsExist())) {
      console.log("[deploy-coord] active console run(s) — holding batch for a quiet window");
      return;
    }

    // Claim the ready rows atomically (ready → deploying) so a second tick can't
    // grab them; then deploy.
    const claimed: QueueRow[] = [];
    for (const row of ready) {
      const { data, error: cErr } = await db
        .from("claude_deploy_queue")
        .update({ state: "deploying", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("state", "ready")
        .select("id")
        .maybeSingle();
      if (!cErr && data) claimed.push({ ...row, state: "deploying" });
    }
    if (claimed.length > 0) await runBatchDeploy(claimed, token, pastCap);
  } catch (e) {
    console.error("[deploy-coord] tick error:", e instanceof Error ? e.message : e);
  } finally {
    ticking = false;
  }
}

/**
 * Start the coordinator loop. A no-op scan when the flag is off (or the queue is
 * empty) is a single indexed query, so the idle cost is negligible. Started once
 * from server/src/index.ts after listen, like the run recoverer.
 */
export function startDeployCoordinator(): void {
  console.log(
    `[deploy-coord] ${enabled() ? "armed" : "inert (DEPLOY_QUEUE_ENABLED unset)"} — ` +
      `settle ${SETTLE_MS / 60000}m, hard cap ${MAX_WAIT_MS / 60000}m`,
  );
  const boot = setTimeout(() => void coordinatorTick(), BOOT_DELAY_MS);
  if (typeof boot.unref === "function") boot.unref();
  const loop = setInterval(() => void coordinatorTick(), SCAN_INTERVAL_MS);
  if (typeof loop.unref === "function") loop.unref();
}
