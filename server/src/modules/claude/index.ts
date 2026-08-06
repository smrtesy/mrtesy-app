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
import actionRoutes from "./actions-routes";

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
// The approvals screen — the human side of the autonomy gate. Under the same
// super-admin chain as the rest of the module.
router.use(actionRoutes);

export default router;
export { executeRun } from "./runner";
// The orphaned-run recoverer — started once from server/src/index.ts after listen.
// Continues turns whose in-process child died with a restarted container.
export { startClaudeRunRecovery } from "./recover";
// The machine-to-machine surface (the in-app Claude requesting a destructive-migration
// gate) is exported separately so server/src/index.ts can mount it OUTSIDE the
// super-admin chain — a CLI child has no JWT, only the shared internal secret.
export { claudeActionM2MRouter } from "./actions-routes";
// The coalescing deploy queue's machine surface (register-building / mark-ready),
// x-cron-secret gated — mounted OUTSIDE the super-admin chain like claudeActionM2MRouter,
// because the caller is a console run's hook / push step with the shared secret, not a JWT.
export { default as claudeDeployQueueRouter } from "./deploy-queue";
// The coalescing deploy coordinator — started once from server/src/index.ts after
// listen. Inert unless DEPLOY_QUEUE_ENABLED=1. docs/claude-console/deploy-queue-plan.md.
export { startDeployCoordinator } from "./deploy-coordinator";
// Ship-status watcher — polls each thread's main-deploy build state and drives the
// rail's deploy dot (green live / red failed). Runs always; zero paid tokens.
export { startShipWatcher } from "./ship-status";
