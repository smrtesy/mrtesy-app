/**
 * smrtBot — public playback-token verification (integration seam for the
 * external video site, e.g. rebbek.org).
 *
 * The bot sends subscribers links of the form  https://<site>/<video>?t=<token>.
 * The site's page (which already plays the video) calls this endpoint
 * server-to-server to learn whether the token is valid and, if so, for which
 * video / email — so it can grant direct playback without a login.
 *
 * Shared-secret guarded (app_secrets slug "smrtbot", key VIDEO_VERIFY_SECRET):
 * unset → the endpoint is disabled (401), so it can't leak which email a token
 * was minted for until the operator wires the integration. Mounted BEFORE the
 * auth guards in index.ts (no user JWT — the caller is another server).
 *
 * Token staleness is bounded by the token TTL (see playback-token.ts); the
 * token is only ever minted for a verified subscriber, fail-closed.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db, getAppSecret } from "../../db";
import { verifyPlaybackToken } from "./playback-token";

const router = Router();

async function authorized(req: Request): Promise<boolean> {
  const secret = await getAppSecret("smrtbot", "VIDEO_VERIFY_SECRET", "VIDEO_VERIFY_SECRET");
  if (!secret) return false; // disabled until configured
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const alt = req.get("x-video-verify-secret") || "";
  return bearer === secret || alt === secret;
}

async function handleVerify(req: Request, res: Response): Promise<void> {
  if (!(await authorized(req))) {
    res.status(401).json({ valid: false, error: "unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as { token?: unknown };
  const token = String(body.token ?? req.query?.t ?? "").trim();
  if (!token) {
    res.status(400).json({ valid: false, error: "token required" });
    return;
  }

  const claims = await verifyPlaybackToken(token);
  if (!claims) {
    res.json({ valid: false });
    return;
  }

  // Per-link use limit (anti-forwarding). Each page-load verify counts once;
  // HLS segment requests hit the CDN, not here. fail-open on a DB hiccup — the
  // subscription gate already passed, so this is anti-abuse, not access control.
  if (claims.j) {
    const max = parseInt((await getAppSecret("smrtbot", "VIDEO_MAX_USES", "VIDEO_MAX_USES")) || "2", 10) || 2;
    const { data: allowed, error } = await db.rpc("smrtbot_playback_consume", {
      p_jti: claims.j,
      p_video: claims.v,
      p_email: claims.e,
      p_max: max,
    });
    if (error) {
      console.error("[smrtbot/playback] consume failed", error.message);
    } else if (allowed === false) {
      res.json({ valid: false, reason: "use_limit_exceeded" });
      return;
    }
  }

  res.json({
    valid: true,
    video: claims.v,
    email: claims.e,
    customer_id: claims.c,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
}

router.post("/api/smrtbot/playback/verify", handleVerify);
router.get("/api/smrtbot/playback/verify", handleVerify);

export default router;
