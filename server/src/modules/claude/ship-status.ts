/**
 * Ship-status watcher — the engine behind the threads-rail deploy dot.
 *
 * THE PROBLEM IT FIXES. A console turn ends when the turn ends. When a session
 * said "אני מנטר את הפריסה, אעדכן כשזה יעלה" it was making a promise the runner
 * cannot keep: nothing runs after the turn, so the deploy is never watched and
 * never reported. This is that watcher, as plain code (zero LLM, zero paid
 * tokens), decoupled from the turn — exactly like the deploy coordinator.
 *
 * It only ever advances a thread that is `main_building` (pushed to main, build in
 * flight): it reads the real production build state for the thread's SHA from the
 * provider (Vercel for a frontend push, Railway for a backend one, via
 * deploy-status.ts) and flips the dot to:
 *   main_live → green  (the build for that SHA is confirmed READY/SUCCESS)
 *   failed    → red    (the build for that SHA is ERROR/FAILED)
 * A build still running stays `main_building` (yellow). If it can't be confirmed
 * within TIMEOUT_MS (tokens unset, or the SHA already superseded by a newer push),
 * it settles to `main_live` labelled "not verified" rather than spinning forever —
 * "pushed to main" is itself the user's definition of green.
 *
 * markThreadShipped() is the WRITE side, called by whoever actually pushes to main:
 * ship.sh's direct path (frontend) via the mark-shipped endpoint, and the deploy
 * coordinator (backend) after its batch push. Setting `main_building` here is what
 * arms the watcher.
 */

import { db } from "../../db";
import { notify } from "../../lib/platform/notify";
import { vercelProductionStatus, railwayLatestStatus } from "./deploy-status";

export type ShipState = "pushed_branch" | "main_building" | "main_live" | "failed";
export type ShipSurface = "vercel" | "railway";

/** How often the watcher re-checks the in-flight deploys. */
const SCAN_INTERVAL_MS = 60_000;
/** Let the server settle before the first scan. */
const BOOT_DELAY_MS = 25_000;
/** A `main_building` row older than this is settled to `main_live` (unverified)
 *  instead of polling forever — see the module header. Comfortably longer than a
 *  Vercel/Railway production build. */
const TIMEOUT_MS = 20 * 60_000;

/** In-process reentrancy guard so a slow provider scan can't overlap the next tick. */
let ticking = false;

interface ThreadShipRow {
  id: string;
  org_id: string;
  created_by: string | null;
  ship_sha: string | null;
  ship_surface: string | null;
  ship_branch: string | null;
  ship_updated_at: string | null;
}

/** Prefix match — providers report full 40-char SHAs, ship.sh may pass a short
 *  one. One is a valid short/long form of the other iff either is a prefix of the
 *  other (min 7 chars, so a stray empty/1-char value can't match everything). */
function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Record that a thread's change reached (or is reaching) production. Idempotent and
 * best-effort: a failure here only costs the dot, never the deploy. `main_building`
 * arms the watcher; `pushed_branch` is the resting yellow for a branch/queue push
 * that has not merged to main yet.
 *
 * The one guard against a stale downgrade — a mark-ready re-fire of the SAME branch
 * whose deploy already advanced — lives in the mark-ready caller (deploy-queue.ts),
 * which compares the incoming branch to the thread's current one; a genuinely new
 * branch must re-arm the dot even over green. This writer is unconditional.
 */
export async function markThreadShipped(
  threadId: string,
  fields: {
    state: ShipState;
    sha?: string | null;
    surface?: ShipSurface | null;
    branch?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  const { error } = await db
    .from("claude_threads")
    .update({
      ship_state: fields.state,
      ship_ref: fields.state === "pushed_branch" ? "branch" : "main",
      ship_sha: fields.sha ?? null,
      ship_surface: fields.surface ?? null,
      ship_branch: fields.branch ?? null,
      ship_detail: fields.detail ?? null,
      ship_updated_at: new Date().toISOString(),
    })
    .eq("id", threadId);
  if (error) console.error("[ship-status] markThreadShipped failed:", error.message);
}

/**
 * Move a thread out of `main_building` to its final dot. `verified` distinguishes a
 * CONFIRMED verdict (the provider actually reported ready/error for this SHA) from an
 * UNVERIFIED settle (timeout, or no deploy token) — the two get different, honest
 * notification wording, so we never tell the user "live in production ✅" about a
 * deploy we could not actually confirm.
 *
 * Two guards on the update keep it from clobbering a state that changed under us
 * mid-scan: it must still be `main_building` AND still carry the same
 * `ship_updated_at` we read — a second push that re-armed the thread bumps that
 * timestamp, so this stale verdict then matches nothing.
 */
async function settle(
  row: ThreadShipRow,
  state: "main_live" | "failed",
  detail: string,
  verified: boolean,
): Promise<void> {
  const { data, error } = await db
    .from("claude_threads")
    .update({ ship_state: state, ship_detail: detail, ship_updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("ship_state", "main_building")
    .eq("ship_updated_at", row.ship_updated_at ?? "")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[ship-status] settle failed:", error.message);
    return;
  }
  if (!data) return; // re-armed or already settled under us — don't notify on a no-op
  const userId = row.created_by;
  if (!userId) return;

  const title =
    state === "failed" ? "הפריסה נכשלה" : verified ? "עלה לאוויר ✅" : "נדחף ל-main";
  const body =
    state === "failed"
      ? `הפריסה ל-main נכשלה בבנייה.${detail ? `\n${detail}` : ""}`
      : verified
        ? `הפריסה ל-main הושלמה וחיה בפרודקשן.${detail ? `\n${detail}` : ""}`
        : `השינוי נדחף ל-main, אך לא הצלחתי לאמת שהפריסה חיה.${detail ? `\n${detail}` : ""}`;
  await notify(row.org_id, userId, {
    app_slug: "smrttask",
    type: state === "main_live" ? "success" : "action_required",
    title,
    body,
    link: `/claude?thread=${row.id}`,
  }).catch((e) => console.error("[ship-status] notify failed:", e instanceof Error ? e.message : e));
}

/** Resolve a single in-flight thread against its provider. */
async function checkOne(row: ThreadShipRow): Promise<void> {
  const timedOut = Date.now() - (Date.parse(row.ship_updated_at ?? "") || 0) > TIMEOUT_MS;
  const surface: ShipSurface = row.ship_surface === "railway" ? "railway" : "vercel";

  const status =
    surface === "railway" ? await railwayLatestStatus() : await vercelProductionStatus(row.ship_sha ?? undefined);

  // Provider not configured (no token): we can NEVER verify this thread, so don't
  // spin for 20 minutes — settle right away to live-UNVERIFIED. "pushed to main" is
  // itself the user's definition of green; the notification says it wasn't confirmed.
  if (status.configured === false) {
    await settle(row, "main_live", "נדחף ל-main (לא אומת חי — טוקן הפריסה לא מוגדר)", false);
    return;
  }

  // Railway returns the LATEST deployment (not filtered by SHA). It's our deploy only
  // when its commit matches; a newer commit means ours already shipped and got
  // superseded — also "live". For Vercel we passed the SHA, so the row already is ours.
  const isOurs = surface === "vercel" || shaMatches(status.commitSha, row.ship_sha);

  if (status.state === "ready" && isOurs) {
    await settle(row, "main_live", surface === "railway" ? "Railway: הבנייה הצליחה" : "Vercel: הבנייה הצליחה", true);
    return;
  }
  if (status.state === "error" && isOurs) {
    await settle(row, "failed", `${surface}: ${status.rawState ?? "ERROR"}`, true);
    return;
  }
  // Still building / not yet our SHA — leave it yellow, unless we've waited too long,
  // in which case settle to live-UNVERIFIED (we never saw a confirmed ready/error).
  if (timedOut) await settle(row, "main_live", "נדחף ל-main (לא אומת חי — פג הזמן)", false);
}

async function watcherTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { data, error } = await db
      .from("claude_threads")
      .select("id, org_id, created_by, ship_sha, ship_surface, ship_branch, ship_updated_at")
      .eq("ship_state", "main_building")
      .limit(50);
    if (error) {
      console.error("[ship-status] scan failed:", error.message);
      return;
    }
    for (const row of (data ?? []) as ThreadShipRow[]) {
      await checkOne(row).catch((e) =>
        console.error("[ship-status] checkOne error:", e instanceof Error ? e.message : e),
      );
    }
  } catch (e) {
    console.error("[ship-status] tick error:", e instanceof Error ? e.message : e);
  } finally {
    ticking = false;
  }
}

/**
 * Start the ship-status watcher. Runs ALWAYS (unlike the deploy coordinator, which
 * is queue-flag gated) — a frontend push straight to main happens regardless of the
 * queue, and it is exactly the case that used to be left unmonitored. An idle scan is
 * one indexed query over a near-empty partial index, so the cost is negligible.
 */
export function startShipWatcher(): void {
  const boot = setTimeout(() => void watcherTick(), BOOT_DELAY_MS);
  if (typeof boot.unref === "function") boot.unref();
  const loop = setInterval(() => void watcherTick(), SCAN_INTERVAL_MS);
  if (typeof loop.unref === "function") loop.unref();
  console.log("[ship-status] watcher armed — polls threads confirming a main deploy");
}
