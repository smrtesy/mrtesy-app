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

// Re-export the AI pipeline parts the cron scheduler still uses. PART 2
// (WhatsApp) is event-driven via the webhook above. PART 3 was deleted —
// classification is now owned by the Supabase Edge Function `ai-process`,
// which the new /sync/part3 endpoint kicks off on demand.
export { runPart1 } from "./parts/part1-collector";
