/**
 * smrtInfo module — the information center.
 *
 * Self-contained authenticated routes (facts CRUD, ask, extract, context
 * profile, secret suggestions). Mounted under /api in server/src/index.ts
 * after the auth-guarded routers.
 */

import { Router } from "express";
import smrtinfoRoutes from "./routes";

const router = Router();
router.use(smrtinfoRoutes);

export default router;
