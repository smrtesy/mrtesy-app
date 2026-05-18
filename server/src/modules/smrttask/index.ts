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

const router = Router();

router.use(tasksRouter);
router.use(projectsRouter);
router.use(remindersRouter);
router.use("/actions", actionsRouter);
router.use("/sync", syncRouter);

export default router;

// Re-export AI pipeline parts so cron scheduler can call them
export { runPart1 } from "./parts/part1-collector";
export { runPart2 } from "./parts/part2-whatsapp";
export { runPart3 } from "./parts/part3-classifier";
