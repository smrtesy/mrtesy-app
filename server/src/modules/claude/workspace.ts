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

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Under the OS temp dir, never inside the deployed app directory. */
const ROOT = path.join(os.tmpdir(), "smrtesy-claude-threads");

/** Thread ids are uuids from our own DB, but this is a path segment, so it is
 *  validated rather than trusted. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directories older than this are swept. Long enough that a conversation resumed
 *  the next morning still has its files. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Create (or reuse) the directory this thread's turns run in. */
export async function threadWorkspace(threadId: string): Promise<string> {
  if (!UUID_RE.test(threadId)) throw new Error(`invalid thread id: ${threadId}`);
  const dir = path.join(ROOT, threadId);
  await mkdir(dir, { recursive: true });
  return dir;
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
