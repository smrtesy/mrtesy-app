/**
 * smrtReach — public (unauthenticated) endpoints, mounted before the auth guards.
 *
 *   GET  /reach/track/open    — 1x1 open pixel (records a tracking 'open')
 *   GET  /reach/track/click   — records a 'click' and 302-redirects to the
 *                               original deep URL (preserved verbatim)
 *   POST /reach/ses/notifications — Amazon SNS bounce/complaint feed (Reach-3:
 *                               deliverability events come from SES)
 *   POST /reach/cron/process-queue — drains the email queue for all orgs; guarded
 *                               by the shared x-cron-secret (pg_cron target, §H)
 *
 * None of these require a JWT: recipients clicking links and SNS/cron callers
 * are not logged-in users. They are org-scoped by resolving the org from the
 * referenced campaign / log row.
 */

import { Router, text } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { processEmailQueue } from "./send-service";

const router = Router();

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function orgForCampaign(campaignId: string): Promise<string | null> {
  const { data } = await db
    .from("smrtreach_campaigns")
    .select("org_id")
    .eq("id", campaignId)
    .maybeSingle();
  return (data?.org_id as string) ?? null;
}

async function recordTracking(
  campaignId: string,
  contactId: string | null,
  event: "open" | "click" | "bounce" | "complaint",
  url?: string,
) {
  const orgId = await orgForCampaign(campaignId);
  if (!orgId) return;
  await db.from("smrtreach_tracking").insert({
    org_id: orgId,
    campaign_id: campaignId,
    contact_id: contactId || null,
    event,
    url: url ?? null,
  });
}

// ── open pixel ───────────────────────────────────────────────
router.get("/reach/track/open", async (req: Request, res: Response) => {
  const c = req.query.c as string | undefined;
  const u = (req.query.u as string | undefined) ?? null;
  if (c) {
    try { await recordTracking(c, u, "open"); } catch { /* tracking must never break delivery view */ }
  }
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.end(PIXEL);
});

// ── click redirect ───────────────────────────────────────────
router.get("/reach/track/click", async (req: Request, res: Response) => {
  const c = req.query.c as string | undefined;
  const u = (req.query.u as string | undefined) ?? null;
  const target = req.query.url as string | undefined;

  // Only redirect to http(s) — never an arbitrary scheme (open-redirect guard).
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("invalid url");
  }
  if (c) {
    try { await recordTracking(c, u, "click", target); } catch { /* don't block the redirect */ }
  }
  res.redirect(302, target);
});

// ── SES bounce / complaint (Amazon SNS) ──────────────────────
// SNS posts text/plain JSON, so parse the raw body here. Correlates back to the
// org/campaign/contact via the SES messageId we stored in smrtreach_logs.
// NOTE: SNS signature verification is recommended before production exposure.
router.post("/reach/ses/notifications", text({ type: "*/*" }), async (req: Request, res: Response) => {
  let body: Record<string, unknown>;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
  } catch {
    return res.status(400).json({ error: "invalid json" });
  }

  // Confirm the subscription on first wire-up.
  if (body.Type === "SubscriptionConfirmation" && typeof body.SubscribeURL === "string") {
    try { await fetch(body.SubscribeURL); } catch { /* best effort */ }
    return res.json({ ok: true, confirmed: true });
  }

  if (body.Type === "Notification" && typeof body.Message === "string") {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(body.Message); } catch { return res.json({ ok: true }); }

    const notificationType = msg.notificationType as string | undefined;
    const mail = msg.mail as { messageId?: string } | undefined;
    const messageId = mail?.messageId;
    if (!messageId) return res.json({ ok: true });

    // Find the recipient/campaign from the messageId we recorded at send time.
    const { data: log } = await db
      .from("smrtreach_logs")
      .select("org_id, campaign_id, contact_id")
      .eq("wa_message_id", messageId)
      .maybeSingle();
    if (!log) return res.json({ ok: true });

    const isComplaint = notificationType === "Complaint";
    const isPermanentBounce =
      notificationType === "Bounce" &&
      (msg.bounce as { bounceType?: string } | undefined)?.bounceType === "Permanent";

    if (isComplaint || isPermanentBounce) {
      // Wrap side-effects so a transient DB error returns 200 to SNS (a 500
      // would trigger retries → duplicate tracking rows + unsubscribe events).
      try {
        await db.from("smrtreach_tracking").insert({
          org_id: log.org_id,
          campaign_id: log.campaign_id,
          contact_id: log.contact_id,
          event: isComplaint ? "complaint" : "bounce",
        });
        // Suppress future sends: the truth lives in smrtCRM, so emit the event
        // its handler already consumes (no cross-app write).
        if (log.contact_id) {
          await emitEvent(log.org_id as string, "smrtreach", "contact.unsubscribed", "contact", log.contact_id as string, {
            reason: isComplaint ? "complaint" : "bounce",
          });
        }
      } catch (e) {
        console.error("[smrtreach.ses] failed to record", messageId, e instanceof Error ? e.message : e);
      }
    }
  }

  res.json({ ok: true });
});

// ── cron: drain the email queue across all orgs ──────────────
router.post("/reach/cron/process-queue", async (req: Request, res: Response) => {
  // Fail closed: if the secret isn't configured, deny rather than allow
  // (an unset env must never become an open endpoint).
  if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Orgs with pending email rows. (Distinct-by-scan: queue volume per tick is
  // bounded; for very large fan-out a dedicated RPC would be tighter.)
  const { data: rows, error } = await db
    .from("smrtreach_queue")
    .select("org_id")
    .eq("channel", "email")
    .eq("status", "pending")
    .limit(5000);
  if (error) return res.status(500).json({ error: error.message });

  const orgIds = [...new Set((rows ?? []).map((r) => r.org_id as string))];
  let sent = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const r = await processEmailQueue(orgId, 200);
      sent += r.sent;
      failed += r.failed;
    } catch (e) {
      console.error("[smrtreach.cron] org", orgId, e instanceof Error ? e.message : e);
    }
  }
  res.json({ orgs: orgIds.length, sent, failed });
});

export default router;
