/**
 * A thread's working directory — stable across turns, on purpose.
 *
 * THE REASON THIS EXISTS: the engine stores a session per PROJECT DIRECTORY. Give
 * turn 2 a different directory and `claude --resume <session_id>` cannot find the
 * session it was handed, so the turn either fails or silently starts a fresh
 * conversation — with the screen still showing one continuous chat. A per-run temp
 * directory (the first implementation) had exactly that bug.
 *
 * Keeping it also means the conversation keeps its work: a file turn 1 edited is
 * still there in turn 2, which is what people expect from a chat about a codebase.
 *
 * LIFETIME. Deleted when the thread is deleted, and swept by age (a container that
 * restarts loses the directory anyway — the engine session goes with it, and the
 * next turn starts a new one, which is recoverable and visible).
 *
 * The GitHub token is NEVER written inside: github.ts authenticates through a
 * credential helper reading the process environment, so nothing durable on disk
 * carries it (see gitAuthEnv).
 */

import { mkdir, readdir, rm, stat, statfs, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../../db";

/**
 * Where thread workspaces live. Default: under the OS temp dir, never inside the
 * deployed app directory. `CLAUDE_WORKSPACE_ROOT` overrides it so the operator
 * can point this at a Railway Volume mount (e.g. /data/claude-threads) — then a
 * redeploy (every push to main) no longer wipes every live conversation's
 * checkout and working files. Without the volume, temp-dir behavior is unchanged.
 */
const ROOT =
  process.env.CLAUDE_WORKSPACE_ROOT?.trim() || path.join(os.tmpdir(), "smrtesy-claude-threads");

/** Thread ids are uuids from our own DB, but this is a path segment, so it is
 *  validated rather than trusted. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directories older than this are swept. Long enough that a conversation resumed
 *  the next morning still has its files. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Create (or reuse) the directory this thread's turns run in. Also the disk
 *  pressure-valve call site: every turn passes here, so headroom is checked
 *  (one statfs — microseconds) and reclaimed BEFORE the turn needs space for a
 *  clone or an npm install. */
export async function threadWorkspace(threadId: string): Promise<string> {
  if (!UUID_RE.test(threadId)) throw new Error(`invalid thread id: ${threadId}`);
  const dir = path.join(ROOT, threadId);
  await mkdir(dir, { recursive: true });
  // Touch the dir so its mtime means "last turn start". A directory's mtime
  // otherwise only changes when a DIRECT child is created/removed (the clone),
  // so an actively-used workspace could look days idle to the pressure valve.
  await utimes(dir, new Date(), new Date()).catch(() => {});
  await ensureDiskHeadroom(threadId);
  return dir;
}

/**
 * Workspace directories the pressure valve must NOT touch, from the DB — the
 * source of truth mtime cannot be (see the touch above; and a QUEUED turn, e.g.
 * one parked on the usage limit for hours, has no FS activity at all):
 *   live            dirs of every thread with a non-terminal run (its own dir,
 *                   or the parent dir it borrows via workspace_thread_id) —
 *                   protected from BOTH artifact pruning and deletion.
 *   borrowedOwners  dirs some fork-child still borrows — protected from WHOLE
 *                   deletion (the child's engine session lives there; same rule
 *                   the thread-delete route applies), artifacts still prunable.
 *
 * Returns null on ANY DB error — the caller must then skip destructive work
 * entirely (fail closed: better a full disk than a deleted live workspace).
 */
async function protectedDirs(): Promise<{ live: Set<string>; borrowedOwners: Set<string> } | null> {
  try {
    const { data: liveRuns, error: e1 } = await db
      .from("claude_runs")
      .select("thread_id")
      .in("status", ["queued", "running", "waiting"]);
    if (e1) return null;
    const liveThreads = Array.from(
      new Set((liveRuns ?? []).map((r) => r.thread_id).filter((v): v is string => !!v)),
    );
    const live = new Set<string>(liveThreads);
    if (liveThreads.length > 0) {
      const { data: owners, error: e2 } = await db
        .from("claude_threads")
        .select("id, workspace_thread_id")
        .in("id", liveThreads);
      if (e2) return null;
      for (const t of owners ?? []) if (t.workspace_thread_id) live.add(t.workspace_thread_id);
    }
    const { data: borrows, error: e3 } = await db
      .from("claude_threads")
      .select("workspace_thread_id")
      .not("workspace_thread_id", "is", null);
    if (e3) return null;
    const borrowedOwners = new Set<string>(
      (borrows ?? []).map((b) => b.workspace_thread_id as string),
    );
    return { live, borrowedOwners };
  } catch {
    return null;
  }
}

// ── disk pressure ───────────────────────────────────────────────────────────
//
// WHY: a repo thread that runs the pre-push protocol leaves node_modules +
// .next (~1-1.5 GB) in its workspace. On the ephemeral temp dir a redeploy
// wiped them as a side effect; on a persistent volume (CLAUDE_WORKSPACE_ROOT)
// nothing does — a handful of build-running threads fill a 5 GB volume and the
// next turn dies with "npm install: no space left on device". These thresholds
// reclaim space in re-creatability order: build artifacts first (an npm install
// re-makes them), whole oldest workspaces only under real pressure (that costs
// the thread its engine session — the DB context-rebuild covers the loss).

/** Below this the next build likely fails — reclaim synchronously. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** Below this start pruning artifacts, before it becomes critical. */
const LOW_FREE_BYTES = 4 * 1024 ** 3;
/** Re-creatable build artifacts — safe to delete from any idle checkout. */
const HEAVY_DIRS = ["node_modules", ".next", "dist", ".turbo"];
/** Never prune artifacts from a workspace touched this recently (mid-turn). */
const ARTIFACT_MIN_IDLE_MS = 60 * 60 * 1000;
/** Never delete a whole workspace touched this recently. */
const WORKSPACE_MIN_IDLE_MS = 30 * 60 * 1000;

async function freeBytes(): Promise<number | null> {
  try {
    const s = await statfs(ROOT);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // ROOT missing / statfs unsupported — pressure logic disabled
  }
}

/** Delete HEAVY_DIRS inside every checkout of every workspace idle longer than
 *  minIdleMs, except `skip`ped dirs (live threads — see protectedDirs) and
 *  `excludeThreadId`'s. Best-effort throughout. */
export async function pruneHeavyArtifacts(
  minIdleMs: number,
  skip: Set<string>,
  excludeThreadId?: string,
): Promise<number> {
  let removed = 0;
  try {
    const threads = await readdir(ROOT, { withFileTypes: true });
    for (const t of threads) {
      if (!t.isDirectory() || !UUID_RE.test(t.name)) continue;
      if (excludeThreadId && t.name === excludeThreadId) continue;
      if (skip.has(t.name)) continue;
      const tdir = path.join(ROOT, t.name);
      try {
        if (Date.now() - (await stat(tdir)).mtimeMs < minIdleMs) continue;
      } catch {
        continue;
      }
      const entries = await readdir(tdir, { withFileTypes: true }).catch(
        () => [] as import("node:fs").Dirent[],
      );
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        for (const h of HEAVY_DIRS) {
          const target = path.join(tdir, e.name, h);
          try {
            await stat(target);
          } catch {
            continue; // not present
          }
          await rm(target, { recursive: true, force: true }).catch(() => {});
          removed += 1;
        }
      }
    }
  } catch {
    // ROOT does not exist yet — nothing to prune.
  }
  return removed;
}

/**
 * Reclaim disk before a turn if the workspace filesystem is under pressure.
 * Two stages, in re-creatability order; the ACTIVE thread is never touched.
 * No-op (one statfs) when free space is healthy — the normal case.
 */
async function ensureDiskHeadroom(activeThreadId: string): Promise<void> {
  let free = await freeBytes();
  if (free === null || free >= LOW_FREE_BYTES) return;

  // The DB is the authority on which dirs are in use (a parallel turn, a
  // usage-parked queued turn, a fork-child borrower) — mtime cannot be. A DB
  // failure disables ALL destructive work this round: better a full disk than
  // a live workspace deleted under a running turn.
  const prot = await protectedDirs();
  if (!prot) {
    console.warn("[claude/workspace] low disk but protection lookup failed — skipping cleanup");
    return;
  }

  console.warn(
    `[claude/workspace] low disk (${Math.round(free / 1024 ** 2)} MB free) — pruning build artifacts`,
  );
  await pruneHeavyArtifacts(ARTIFACT_MIN_IDLE_MS, prot.live, activeThreadId);
  free = await freeBytes();
  if (free === null || free >= MIN_FREE_BYTES) return;

  // Still critical: drop whole OLDEST idle workspaces until there is headroom.
  // Never a live thread's dir, and never a dir a fork-child still borrows —
  // the same rule the thread-delete route applies (threads.ts).
  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    const dirs: { name: string; full: string; mtime: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !UUID_RE.test(e.name) || e.name === activeThreadId) continue;
      if (prot.live.has(e.name) || prot.borrowedOwners.has(e.name)) continue;
      const full = path.join(ROOT, e.name);
      try {
        dirs.push({ name: e.name, full, mtime: (await stat(full)).mtimeMs });
      } catch {
        // vanished mid-scan
      }
    }
    dirs.sort((a, b) => a.mtime - b.mtime);
    for (const d of dirs) {
      if ((free ?? 0) >= MIN_FREE_BYTES) break;
      if (Date.now() - d.mtime < WORKSPACE_MIN_IDLE_MS) continue;
      console.warn(`[claude/workspace] critical disk — removing oldest workspace ${d.name}`);
      await rm(d.full, { recursive: true, force: true }).catch(() => {});
      free = await freeBytes();
    }
  } catch {
    // best-effort
  }
}

/** Remove a thread's directory — called when the thread itself is deleted, so a
 *  deleted conversation leaves nothing of its files behind. */
export async function removeThreadWorkspace(threadId: string): Promise<void> {
  if (!UUID_RE.test(threadId)) return;
  await rm(path.join(ROOT, threadId), { recursive: true, force: true }).catch(() => {});
}

/**
 * Delete workspaces not touched in MAX_AGE_MS.
 *
 * Best-effort and never throws: this is housekeeping, and a sweep that fails must
 * not take a request or a turn down with it.
 */
export async function sweepWorkspaces(): Promise<number> {
  let removed = 0;
  // Ride the hourly sweep to prune day-old build artifacts too, so a volume
  // drains steadily instead of only under pressure. Best-effort; skipped
  // entirely when the protection lookup fails (fail closed).
  const prot = await protectedDirs();
  if (prot) await pruneHeavyArtifacts(24 * 60 * 60 * 1000, prot.live).catch(() => {});
  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const full = path.join(ROOT, entry.name);
      try {
        const info = await stat(full);
        if (Date.now() - info.mtimeMs > MAX_AGE_MS) {
          await rm(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // A directory that vanished mid-sweep is exactly the outcome wanted.
      }
    }
  } catch {
    // ROOT does not exist yet — nothing to sweep.
  }
  return removed;
}
