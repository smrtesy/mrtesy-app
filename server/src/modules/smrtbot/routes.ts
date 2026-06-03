import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";

const router = Router();

/**
 * Phase-0 scaffolding route. Proves the auth → org → app chain resolves for
 * smrtBot before the real resources (bots, menu, game, …) are wired in.
 * Returns 403 unless the org has smrtBot enabled via app_memberships.
 */
router.get(
  "/bot/health",
  requireAuth,
  requireOrg,
  requireApp("smrtbot"),
  (req: Request, res: Response) => {
    res.json({ ok: true, app: "smrtbot", org_id: req.org!.id });
  },
);

export default router;
