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
import { requireAuth, requireOrg, requireSuperAdmin } from "../../middleware";
import claudeRoutes from "./routes";
import playbookRoutes from "./playbooks";
import threadRoutes from "./threads";

const router = Router();

// The auth chain lives here, once, so every route file in this module is gated by
// construction. Declaring it per-file meant a second file either repeated it (and
// verified the token twice per request) or inherited it by accident of mount order
// — neither is a property to leave to chance on a router that can spawn processes.
//
// SCOPED TO "/claude" ON PURPOSE. This module is mounted as app.use("/api", …),
// so an unscoped router.use(mw) runs for EVERY /api request that reaches it —
// including ones meant for the routers mounted after it (/api/quick-action,
// /api/inbox, /api/messages), which a non-super-admin would then get a 403 from.
// That was true of the equivalent chain in routes.ts before this moved; scoping it
// to the module's own path prefix fixes it.
router.use("/claude", requireAuth, requireOrg, requireSuperAdmin);
router.use(claudeRoutes);
router.use(playbookRoutes);
router.use(threadRoutes);

export default router;
export { executeRun } from "./runner";
