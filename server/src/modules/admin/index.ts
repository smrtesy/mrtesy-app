/**
 * Admin module — every route is gated by requireAuth + requireSuperAdmin.
 * Mounted under /api in server/src/index.ts.
 */

import { Router } from "express";
import usersRouter from "./users/routes";
import orgsRouter from "./orgs/routes";
import appsRouter from "./apps/routes";

const router = Router();
router.use(usersRouter);
router.use(orgsRouter);
router.use(appsRouter);

export default router;
