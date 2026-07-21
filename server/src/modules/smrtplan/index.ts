/**
 * smrtPlan module — the planning layer over smrtTask.
 *
 * Self-contained: CRUD/board routes + the scheduling engine + cron job routes.
 * Dependency release (computation ב) runs through the platform event bus on
 * task.completed — see server/src/apps/smrtplan/on-task-completed.ts.
 *
 * Mount order in server/src/index.ts:
 *   1. jobsRouter (shared-secret, unauthenticated — pg_cron calls it)
 *   2. router    (authenticated)
 */
import { Router } from "express";
import smrtplanRoutes from "./routes";

const router = Router();
router.use(smrtplanRoutes);

export default router;
export { default as jobsRouter } from "./jobs";
export { default as sessionReportRouter } from "./session-report";
