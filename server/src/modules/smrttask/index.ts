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

// PUBLIC webhook FIRST — tasks/projects/reminders below register
// `router.use(requireAuth, requireOrg, requireApp("smrttask"))` at their
// top, and because they mount at root (no path), Express runs that auth
// middleware for ANY path that enters smrttaskRouter — including
// /webhooks/whatsapp. Meta's GET handshake carries no Authorization, so
// it would get a 401 from the *wrong* router before reaching ours.
// Putting the unauthenticated webhook first means the request is matched
// and 200'd before the auth-guarded routers ever see it.
router.use(whatsappWebhookRouter);

router.use(tasksRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use("/actions", actionsRouter);
router.use("/sync", syncRouter);
// Authenticated read API powering /[locale]/whatsapp.
router.use(whatsappViewRouter);

export default router;

// Re-export the AI pipeline parts the cron scheduler still uses. PART 2
// (WhatsApp) is event-driven via the webhook above. PART 3 was deleted —
// classification is now owned by the Supabase Edge Function `ai-process`,
// which the new /sync/part3 endpoint kicks off on demand.
export { runPart1 } from "./parts/part1-collector";
