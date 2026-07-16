/**
 * smrtInfo module — the information center.
 *
 * Self-contained authenticated routes (facts CRUD, ask, extract, context
 * profile, secret suggestions). Mounted under /api in server/src/index.ts
 * after the auth-guarded routers.
 */

import { Router } from "express";
import smrtinfoRoutes from "./routes";
import smrtinfoCronRoutes from "./cron-routes";

const router = Router();
router.use(smrtinfoRoutes);

export default router;

/**
 * Machine-to-machine batch extraction (x-cron-secret gated). Mounted BEFORE the
 * auth-guarded routers in server/src/index.ts.
 */
export const cronRouter = smrtinfoCronRoutes;
