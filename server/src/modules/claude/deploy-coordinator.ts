/**
 * Deploy coordinator — phase 3 of docs/claude-console/deploy-queue-plan.md.
 *
 * A background loop (like recover.ts, off the request path) that drains
 * claude_deploy_queue: when the batch of server/** fixes is all 'ready' and has
 * settled (or a 30-min cap elapses), it merges every ready branch into `main`,
 * builds once, and pushes ONCE — so N parallel server fixes cause ONE redeploy
 * instead of N that kill each other.
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

/** Master switch. The coordinator AND the push-gate are both gated on this, so
 *  with it unset the entire feature is inert (nothing queues, nothing deploys). */
function enabled(): boolean {
  return process.env.DEPLOY_QUEUE_ENABLED === "1";
}

/** Deploy when the batch has been quiet this long (no server fix entered/updated
 *  the queue) — the user's wave has stopped. */
const SETTLE_MS = 3 * 60_000;
/** …or when the earliest queued fix has waited this long, no matter what. */
const MAX_WAIT_MS = 30 * 60_000;
/** A 'building' row whose run stopped heartbeating this long ago is an abandoned
 *  fix — dropped so it can't hold the batch forever. */
const STALE_BUILDING_MS = 5 * 60_000;
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
    await exec("git", ["fetch", "origin", row.branch], { cwd: DEPLOY_DIR, timeoutMs: GIT_TIMEOUT_MS, env }).catch(
      () => undefined,
    );
    if (await branchInMain(row.branch, env)) {
      await tellOwner(row, "success", "התיקון נפרס ✅", `הענף \`${row.branch}\` מוזג ל-main ונפרס.`);
      await removeRow(row.id);
    } else {
      await setState(row.id, "ready"); // push never happened — retry in the next batch
    }
  }
}

/** Drop 'building' rows whose run is no longer alive (abandoned fix). */
async function dropStaleBuilding(): Promise<void> {
  const { data: rows } = await db
    .from("claude_deploy_queue")
    .select("*")
    .eq("state", "building");
  const staleBefore = Date.now() - STALE_BUILDING_MS;
  for (const row of (rows ?? []) as QueueRow[]) {
    let alive = false;
    if (row.run_id) {
      const { data: run } = await db
        .from("claude_runs")
        .select("status, updated_at")
        .eq("id", row.run_id)
        .maybeSingle();
      if (run && ["running", "queued"].includes(run.status)) {
        const beat = Date.parse(run.updated_at ?? "") || 0;
        alive = beat > staleBefore;
      }
    }
    // No run reference at all → can't prove it's alive; treat an old row as stale.
    if (!alive && Date.parse(row.updated_at ?? "") < staleBefore) {
      await removeRow(row.id);
    }
  }
}

/**
 * The batch deploy: merge every ready branch into main, build once, push once.
 * Rows are already 'deploying'. Never auto-resolves a conflict — it surfaces it.
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
      settled.add(row.id);
      continue;
    }
    const f = await exec("git", ["fetch", "origin", row.branch], {
      cwd: DEPLOY_DIR,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    if (f.code !== 0) {
      await setState(row.id, "failed", redact(f.stderr, token).slice(0, 300));
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

      await setState(row.id, "conflict", "merge conflict with the batch");
      await tellOwner(
        row,
        "action_required",
        "קונפליקט מיזוג — צריך את עזרתך",
        `הענף \`${row.branch}\` מתנגש עם הצרור. שאר הצרור נפרס; פתור את הקונפליקט ודחוף שוב.`,
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
  const install = await exec("npm", ["install", "--no-audit", "--no-fund"], {
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
  for (const row of merged) {
    await tellOwner(row, "success", "התיקון נפרס ✅", `הענף \`${row.branch}\` נכלל בפריסת-הצרור ל-main.`);
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

    await dropStaleBuilding();

    const { data: rows, error } = await db
      .from("claude_deploy_queue")
      .select("*")
      .in("state", ["building", "ready"])
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[deploy-coord] scan failed:", error.message);
      return;
    }
    const all = (rows ?? []) as QueueRow[];
    if (all.length === 0) return;

    const earliest = Math.min(...all.map((r) => Date.parse(r.created_at) || Date.now()));
    const pastCap = Date.now() - earliest > MAX_WAIT_MS;

    const building = all.filter((r) => r.state === "building");
    const ready = all.filter((r) => r.state === "ready");

    if (ready.length === 0) return; // nothing shippable yet
    // A fix still building holds the batch — unless we've hit the absolute cap.
    if (building.length > 0 && !pastCap) return;

    // Settle: no server change entered/updated the queue recently — unless past cap.
    const lastActivity = Math.max(...all.map((r) => Date.parse(r.updated_at) || 0));
    if (Date.now() - lastActivity < SETTLE_MS && !pastCap) return;

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
      `settle ${SETTLE_MS / 60000}m, cap ${MAX_WAIT_MS / 60000}m`,
  );
  const boot = setTimeout(() => void coordinatorTick(), BOOT_DELAY_MS);
  if (typeof boot.unref === "function") boot.unref();
  const loop = setInterval(() => void coordinatorTick(), SCAN_INTERVAL_MS);
  if (typeof loop.unref === "function") loop.unref();
}
