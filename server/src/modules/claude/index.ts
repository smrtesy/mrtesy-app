/**
 * claude module — Claude as an engine inside smrtesy (docs/claude-console/plan.md).
 *
 * Slice 1: launch a run from the app, and record its full event stream in our own
 * database. Authenticated routes only; there is no machine-to-machine surface
 * here yet (the runner writes through the service-role client in-process).
 *
 * Mount in server/src/index.ts: app.use("/api", claudeRouter)
 */
import { Router } from "express";
import claudeRoutes from "./routes";

const router = Router();
router.use(claudeRoutes);

export default router;
export { executeRun } from "./runner";
