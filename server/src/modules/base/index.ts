/**
 * Base module — core platform endpoints that every org/app inherits.
 * Mounted under /api in server/src/index.ts.
 */

import { Router } from "express";
import organizationsRouter from "./organizations/routes";
import membersRouter from "./members/routes";
import appsRouter from "./apps/routes";
import tasksRouter from "./tasks/routes";
import projectsRouter from "./projects/routes";
import remindersRouter from "./reminders/routes";
import meRouter from "./me/routes";
import messagingRouter from "./messaging/routes";

const router = Router();

// Each sub-router defines its own paths (e.g. /orgs, /org/members)
router.use(organizationsRouter);
router.use(membersRouter);
router.use(appsRouter);
router.use(tasksRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use(meRouter);
router.use(messagingRouter);

export default router;
