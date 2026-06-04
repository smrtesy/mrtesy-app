/**
 * smrtTask module — task management app.
 * Self-contained: routes, AI pipeline, helpers.
 * To extract to a separate repo, copy this directory + `server/src/apps/smrttask/`.
 */

import { Router } from "express";
import tasksRouter from "./tasks/routes";
import tasksMergeRouter from "./tasks/merge";
import projectsRouter from "./projects/routes";
import remindersRouter from "./reminders/routes";
import correctionsRouter from "./corrections/routes";
import actionsRouter from "./routes/actions";
import knowledgeRouter from "./routes/knowledge";
import syncRouter from "./routes/sync";
import whatsappViewRouter from "./routes/whatsapp-view";
import routerRouter from "./routes/router";
import transcriptionExperimentRouter from "./routes/transcription-experiment";

const router = Router();

// NOTE: the WhatsApp inbound webhook moved to the Vercel Next.js route
// (src/app/api/webhooks/whatsapp/route.ts). Meta delivers there directly, so
// it is no longer mounted in this Express module.

router.use(tasksRouter);
router.use(tasksMergeRouter);
router.use(routerRouter);
router.use(transcriptionExperimentRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use(correctionsRouter);
router.use("/actions", actionsRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/sync", syncRouter);
// Authenticated read API powering /[locale]/whatsapp.
router.use(whatsappViewRouter);

export default router;

// Re-export AI pipeline parts so the cron scheduler can call them.
// PART 2 (WhatsApp) is intentionally absent: WhatsApp ingestion is now
// event-driven via the webhook above, not cron-pulled from a Sheet.
// PART 3 (classifier) is intentionally absent: classification is handled
// by the ai-process edge function running every minute via pg_cron.
export { runPart1 } from "./parts/part1-collector";
