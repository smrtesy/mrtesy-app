/**
 * Platform event handler: smrtTask `task.completed` → smrtPlan dependency release.
 *
 * Invoked by server/src/lib/platform/emit.ts (dynamic import + default export)
 * whenever a task completes. This is computation ב from smrtplan-engine.md:
 *   1. mark every dependency the completed task satisfies,
 *   2. flip any matrix cell pointing at it to done + open the next stage,
 *   3. for each now-fully-unblocked consumer, emit task.unblocked so the UI can
 *      move it from "blocked" to "ready" and notify its owner.
 *
 * The handler is intentionally tolerant: a smrtTask completion must never fail
 * because the planning layer had a hiccup, so it logs and returns rather than
 * throwing back into the emit loop.
 */
import { releaseDependents } from "../../modules/smrtplan/engine";
import { emitEvent } from "../../lib/platform";

interface PlatformEvent {
  id: string;
  orgId: string;
  sourceApp: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export default async function onTaskCompleted(event: PlatformEvent): Promise<void> {
  const { orgId, entityId } = event;
  if (!orgId || !entityId) return;

  try {
    const result = await releaseDependents(orgId, entityId);
    for (const taskId of result.unblocked) {
      await emitEvent(orgId, "smrtplan", "task.unblocked", "task", taskId, {
        released_by: entityId,
      });
    }
    if (result.satisfied || result.cellsClosed || result.unblocked.length) {
      console.log(
        `[smrtplan] task ${entityId} completed → satisfied=${result.satisfied} ` +
          `cells=${result.cellsClosed} unblocked=${result.unblocked.length}`,
      );
    }
  } catch (e) {
    console.error("[smrtplan] on-task-completed failed:", e);
  }
}
