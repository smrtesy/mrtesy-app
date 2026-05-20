/**
 * smrtTask module — task management app.
 * Self-contained: routes, AI pipeline, helpers.
 * To extract to a separate repo, copy this directory + `server/src/apps/smrttask/`.
 */

import { Router } from "express";
import tasksRouter from "./tasks/routes";
import projectsRouter from "./projects/routes";
import remindersRouter from "./reminders/routes";
import actionsRouter from "./routes/actions";
import syncRouter from "./routes/sync";
import whatsappViewRouter from "./routes/whatsapp-view";

const router = Router();

// WhatsApp ingestion webhook moved to Vercel:
// src/app/api/webhooks/whatsapp/route.ts (Next.js Route Handler). Express
// no longer receives Meta POSTs — DualHook points to the Vercel URL.

router.use(tasksRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use("/actions", actionsRouter);
router.use("/sync", syncRouter);
// Authenticated read API powering /[locale]/whatsapp (threads, messages, send,
// media). Still on Express because moving it would require porting the
// requireAuth/requireOrg/requireApp middleware chain — read-API downtime
// doesn't drop data, unlike the webhook which moved for that exact reason.
router.use(whatsappViewRouter);

export default router;
