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

/**
 * POST /internal/push/notify — the single Web Push fan-out path.
 *
 * Fired by the `notifications` AFTER INSERT trigger (via pg_net) for EVERY
 * notification row, no matter who created it — Express `notify()` OR a Supabase
 * edge function (gmail-sync, ai-process, …). Before this, sendPush only ran
 * inside Express notify(), so the edge-function notifications that make up
 * almost all real alerts (Gmail disconnect, sync errors, new-inbox digests)
 * never reached the user's phone. Centralizing here means every notification
 * pushes uniformly.
 *
 * Not user-facing: secret-gated by x-cron-secret like the other pg_net targets
 * (see modules/smrtreach/public-handlers.ts). No requireAuth — the DB is the
 * caller, not a logged-in user.
 */
router.post("/internal/push/notify", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["x-cron-secret"] !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const b = req.body ?? {};
  if (typeof b.user_id !== "string" || typeof b.title !== "string") {
    return res.status(400).json({ error: "user_id and title required" });
  }

  await sendPush(b.user_id, {
    title:    b.title,
    body:     typeof b.body === "string" ? b.body : null,
    link:     typeof b.link === "string" ? b.link : null,
    type:     typeof b.type === "string" ? b.type : undefined,
    app_slug: typeof b.app_slug === "string" ? b.app_slug : undefined,
    // entity_id (uuid, or null) doubles as the push tag to collapse repeats.
    tag:      typeof b.tag === "string" ? b.tag : undefined,
  });
  res.json({ ok: true });
});

export default router;
