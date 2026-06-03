/**
 * smrtReach module.
 *
 * Self-contained: routes (authenticated) + audience service + the public
 * unsubscribe handler (unauthenticated, mounted before the auth guards).
 * To extract to a separate repo later, copy this directory plus
 * `server/src/apps/smrtreach/`.
 *
 * Mount order in server/src/index.ts:
 *   1. unsubscribeRouter (unauthenticated, public link)
 *   2. router (authenticated)
 */

import { Router } from "express";
import smrtreachRoutes from "./routes";

const router = Router();
router.use(smrtreachRoutes);

export default router;
export { default as unsubscribeRouter } from "./unsubscribe-handler";
