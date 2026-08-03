/**
 * smrtBot — route aggregator.
 *
 * The standard chain (requireAuth → requireOrg → requireApp("smrtbot")) is
 * applied once here; sub-routers add requireRole / requireBotAccess as needed.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";

import botsRouter from "./routes/bots";
import contentRouter from "./routes/content";
import statsRouter from "./routes/stats";
import qaRouter from "./routes/qa";
import publishRouter from "./routes/publish";
import webAdminRouter from "./routes/web-admin";
import waRouter from "./routes/wa";

const router = Router();

// Path-scoped ON PURPOSE. This router is mounted with app.use("/api", …),
// so a BARE router.use() runs for EVERY /api request that falls through to
// it — which 403'd every user without this app on all routers mounted after
// it. Keep this list in sync with the prefixes below.
router.use("/bot", requireAuth, requireOrg, requireApp("smrtbot"));

// Health/ping — proves the chain resolves for smrtBot.
router.get("/bot/health", (req: Request, res: Response) => {
  res.json({ ok: true, app: "smrtbot", org_id: req.org!.id });
});

router.use(botsRouter);
router.use(contentRouter);
router.use(statsRouter);
router.use(qaRouter);
router.use(publishRouter);
router.use(webAdminRouter);
router.use(waRouter);

export default router;
