/**
 * smrtVault module — a personal credential vault.
 *
 * Self-contained: authenticated routes only (no public/cron surface).
 * Mounted under /api in server/src/index.ts after the auth-guarded routers.
 */

import { Router } from "express";
import smrtvaultRoutes from "./routes";

const router = Router();
router.use(smrtvaultRoutes);

export default router;
