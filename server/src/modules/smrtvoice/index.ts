/**
 * smrtVoice module.
 *
 * Self-contained: routes + webhook handler + voice-engine client.
 * To extract to a separate repo later, copy this directory plus
 * `server/src/apps/smrtvoice/`.
 *
 * Mount order in server/src/index.ts is CRITICAL:
 *   1. webhookRouter (unauthenticated, HMAC-verified)
 *   2. router (authenticated)
 */

import { Router } from "express";
import smrtvoiceRoutes from "./routes";

const router = Router();
router.use(smrtvoiceRoutes);

export default router;
export { default as webhookRouter } from "./webhook-handler";
