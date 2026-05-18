/**
 * Platform module — core endpoints shared across every app.
 * Contains orgs, members, app registry, per-user routes, and platform messaging.
 * App-specific routes live under their own module (e.g. `modules/smrttask/`).
 *
 * Mounted under /api in server/src/index.ts.
 */

import { Router } from "express";
import organizationsRouter from "./organizations/routes";
import membersRouter from "./members/routes";
import appsRouter from "./apps/routes";
import meRouter from "./me/routes";
import messagingRouter from "./messaging/routes";

const router = Router();

router.use(organizationsRouter);
router.use(membersRouter);
router.use(appsRouter);
router.use(meRouter);
router.use(messagingRouter);

export default router;
