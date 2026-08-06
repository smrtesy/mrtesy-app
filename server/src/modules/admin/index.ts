/**
 * Admin module — every route is gated by requireAuth + requireSuperAdmin.
 * Mounted under /api in server/src/index.ts.
 */

import { Router } from "express";
import usersRouter from "./users/routes";
import orgsRouter from "./orgs/routes";
import appsRouter from "./apps/routes";
import logsRouter from "./logs/routes";
import domainTrackerRouter from "./domain-tracker";
import priceTrackerRouter from "./price-tracker";
import secretsRouter from "./secrets/routes";
import claudeAccountsRouter from "./claude-accounts";
import docsRouter from "./docs/routes";

const router = Router();
router.use(usersRouter);
router.use(orgsRouter);
router.use(appsRouter);
router.use(logsRouter);
router.use(domainTrackerRouter);
router.use(priceTrackerRouter);
router.use(secretsRouter);
router.use(claudeAccountsRouter);
router.use(docsRouter);

export default router;
