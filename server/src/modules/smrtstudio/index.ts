/**
 * smrtStudio module — the production-management layer over the AI-video program.
 *
 * Read-only today: it composes the management spine (studio_*) with the
 * production tables that already hold the real work (experiment_runs,
 * experiment_scores, smrtvoice_*). Writes stay in the modules that own the
 * data — scoring goes through smrtPlan's experiments router, voice through
 * smrtVoice — so there is exactly one writer per table.
 *
 * Mounted authenticated in server/src/index.ts. The jobs router is separate
 * and mounted BEFORE the auth chain — a cron has no session to authenticate
 * with, so it carries a shared secret instead.
 */
import { Router } from "express";
import smrtstudioRoutes from "./routes";
import smrtstudioJobs from "./jobs";

const router = Router();
router.use(smrtstudioRoutes);

export { smrtstudioJobs as jobsRouter };
export default router;
