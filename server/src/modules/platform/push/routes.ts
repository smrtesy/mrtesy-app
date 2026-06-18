/**
 * Web Push subscription management — all per-user (no org context), mirroring
 * /me/settings. The whole notification experience is managed from inside
 * smrtesy via these endpoints:
 *
 *   GET  /me/push/public-key   the VAPID public key the client subscribes with
 *   POST /me/push/subscribe    register a browser PushSubscription
 *   POST /me/push/unsubscribe  remove a subscription by endpoint
 *   POST /me/push/test         send a test push to the caller's own devices
 */
import { Router, type Request, type Response } from "express";
import { db } from "../../../db";
import { requireAuth, rateLimit } from "../../../middleware";
import { getVapidPublicKey, sendPush } from "../../../lib/platform/push";

const router = Router();

// Cap the self-targeted test push so it can't be spammed.
const testPushLimit = rateLimit({ windowMs: 60_000, max: 5 });

/** GET /me/push/public-key */
router.get("/me/push/public-key", requireAuth, (_req: Request, res: Response) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) return res.status(503).json({ error: "push_not_configured" });
  res.json({ publicKey });
});

/** POST /me/push/subscribe — body is a browser PushSubscription JSON. */
router.post("/me/push/subscribe", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const sub = req.body?.subscription ?? req.body;
  const endpoint: unknown = sub?.endpoint;
  const p256dh: unknown = sub?.keys?.p256dh;
  const auth: unknown = sub?.keys?.auth;

  if (
    typeof endpoint !== "string" ||
    typeof p256dh !== "string" ||
    typeof auth !== "string"
  ) {
    return res.status(400).json({ error: "invalid subscription" });
  }

  const ua = req.headers["user-agent"];
  const { error } = await db.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      user_agent: typeof ua === "string" ? ua.slice(0, 500) : null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** POST /me/push/unsubscribe { endpoint } */
router.post("/me/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const endpoint: unknown = req.body?.endpoint;
  if (typeof endpoint !== "string") {
    return res.status(400).json({ error: "endpoint required" });
  }
  const { error } = await db
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** POST /me/push/test — fan a test notification to the caller's own devices. */
router.post("/me/push/test", requireAuth, testPushLimit, async (req: Request, res: Response) => {
  const message = typeof req.body?.message === "string" ? req.body.message : undefined;
  await sendPush(req.user!.id, {
    title: "smrtesy",
    body: message || "🔔 Test notification",
    link: "/",
    type: "info",
  });
  res.json({ ok: true });
});

export default router;
