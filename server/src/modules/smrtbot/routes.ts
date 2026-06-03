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

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrtbot"));

// Health/ping — proves the chain resolves for smrtBot.
router.get("/bot/health", (req: Request, res: Response) => {
  res.json({ ok: true, app: "smrtbot", org_id: req.org!.id });
});

router.use(botsRouter);
router.use(contentRouter);

export default router;
