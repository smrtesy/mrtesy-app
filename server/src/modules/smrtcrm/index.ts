/**
 * smrtCRM module.
 *
 * Self-contained: routes + contacts service (normalization + dedup/upsert).
 * To extract to a separate repo later, copy this directory plus
 * `server/src/apps/smrtcrm/`.
 */

import { Router } from "express";
import smrtcrmRoutes from "./routes";

const router = Router();
router.use(smrtcrmRoutes);

export default router;
