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
import whatsappWebhookRouter from "./routes/whatsapp-webhook";
import whatsappViewRouter from "./routes/whatsapp-view";

const router = Router();

router.use(tasksRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use("/actions", actionsRouter);
router.use("/sync", syncRouter);
// Public webhook (Meta → us via DualHook Webhook Override). No auth middleware:
// the verify token + HMAC signature are the auth.
router.use(whatsappWebhookRouter);
// Authenticated read API powering /[locale]/whatsapp.
router.use(whatsappViewRouter);

export default router;

// Re-export AI pipeline parts so the cron scheduler can call them.
// PART 2 (WhatsApp) is intentionally absent: WhatsApp ingestion is now
// event-driven via the webhook above, not cron-pulled from a Sheet.
export { runPart1 } from "./parts/part1-collector";
export { runPart3 } from "./parts/part3-classifier";
