/**
 * smrtReach — Express routes (authenticated).
 *
 * Every route requires: requireAuth → requireOrg → requireApp("smrtreach").
 *
 * Permissions (Reach-5): access to the app is gated by app-membership (only
 * people responsible for outreach are added). Inside the app everything is
 * currently equal — including sending. The two-role structure is ready to
 * restrict later without a migration.
 *
 * Live dispatch (SES email + WhatsApp via smrtBot send-service) is a pending
 * integration: SES secrets go in app_secrets (slug "smrtreach") and the
 * WhatsApp contract closes when smrtBot is built. Until then "send" builds the
 * queue and marks the campaign, but no external dispatch happens.
 */

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { emitEvent, notifyError } from "../../lib/platform";

import { resolveAudience } from "./audience-service";
import type { AudienceRef, Channel } from "./audience-service";
import { enqueueCampaignEmail, processEmailQueue } from "./send-service";

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrtreach"));

// ============================================================
// CAMPAIGNS
// ============================================================

router.get("/reach/campaigns", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtreach_campaigns")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ campaigns: data ?? [] });
});

router.get("/reach/campaigns/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: campaign, error } = await db
    .from("smrtreach_campaigns")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!campaign) return res.status(404).json({ error: "campaign not found" });

  const [{ data: email }, { data: whatsapp }] = await Promise.all([
    db.from("smrtreach_campaign_email").select("*").eq("campaign_id", req.params.id).maybeSingle(),
    db.from("smrtreach_campaign_whatsapp").select("*").eq("campaign_id", req.params.id).maybeSingle(),
  ]);

  res.json({ campaign, email: email ?? null, whatsapp: whatsapp ?? null });
});

router.post("/reach/campaigns", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { name, channel, audience } = (req.body ?? {}) as {
    name?: string;
    channel?: Channel;
    audience?: AudienceRef;
  };

  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (!channel || !["whatsapp", "email", "both"].includes(channel)) {
    return res.status(400).json({ error: "channel must be one of whatsapp|email|both" });
  }

  const { data, error } = await db
    .from("smrtreach_campaigns")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      name: name.trim(),
      channel,
      audience: audience ?? {},
    })
    .select("*")
    .single();

  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to create campaign", body: error.message });
    return res.status(500).json({ error: error.message });
  }

  await emitEvent(orgId, "smrtreach", "campaign.created", "campaign", data.id, { name: data.name });
  res.status(201).json({ campaign: data });
});

router.patch("/reach/campaigns/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = (req.body ?? {}) as {
    name?: string;
    audience?: AudienceRef;
    status?: string;
    scheduled_at?: string | null;
    timezone?: string | null;
  };

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name?.trim();
  if (body.audience !== undefined) patch.audience = body.audience ?? {};
  if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.status !== undefined) {
    const allowed = ["draft", "approved", "ready", "sending", "paused", "done", "failed"];
    if (!allowed.includes(body.status)) {
      return res.status(400).json({ error: `invalid status: ${body.status}` });
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no updatable fields provided" });
  }

  const { data, error } = await db
    .from("smrtreach_campaigns")
    .update(patch)
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to update campaign", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "campaign not found" });
  res.json({ campaign: data });
});

/** Confirm the campaign exists AND belongs to this org before writing detail. */
async function ownsCampaign(orgId: string, campaignId: string): Promise<boolean> {
  const { data } = await db
    .from("smrtreach_campaigns")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", campaignId)
    .maybeSingle();
  return !!data;
}

/** Pick only the allowed keys from an arbitrary body (drops unknowns + injected org_id/campaign_id). */
function pick<T extends Record<string, unknown>>(body: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

const EMAIL_COLS = [
  "subject", "preview", "sender", "reply_to", "html_body",
  "priority", "send_hours", "exclude_shabbat", "rate_limit", "cooldown_seconds",
] as const;
const WHATSAPP_COLS = [
  "bot_ref", "template", "template_lang", "template_params", "recipient_cap",
] as const;

// Upsert per-channel detail (email/whatsapp).
router.put("/reach/campaigns/:id/email", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!(await ownsCampaign(orgId, req.params.id))) {
    return res.status(404).json({ error: "campaign not found" });
  }
  // Whitelist columns and set ids LAST so the body can't override them.
  const row = { ...pick((req.body ?? {}) as Record<string, unknown>, EMAIL_COLS), campaign_id: req.params.id, org_id: orgId };
  const { error } = await db
    .from("smrtreach_campaign_email")
    .upsert(row, { onConflict: "campaign_id" });
  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to save email details", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

router.put("/reach/campaigns/:id/whatsapp", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!(await ownsCampaign(orgId, req.params.id))) {
    return res.status(404).json({ error: "campaign not found" });
  }
  const row = { ...pick((req.body ?? {}) as Record<string, unknown>, WHATSAPP_COLS), campaign_id: req.params.id, org_id: orgId };
  const { error } = await db
    .from("smrtreach_campaign_whatsapp")
    .upsert(row, { onConflict: "campaign_id" });
  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to save WhatsApp details", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

router.delete("/reach/campaigns/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtreach_campaigns")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Preview the resolved recipients for a campaign's audience + channel.
router.get("/reach/campaigns/:id/recipients", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: campaign, error } = await db
    .from("smrtreach_campaigns")
    .select("audience, channel")
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!campaign) return res.status(404).json({ error: "campaign not found" });

  try {
    const recipients = await resolveAudience(
      orgId,
      (campaign.audience ?? {}) as AudienceRef,
      campaign.channel as Channel,
    );
    res.json({ recipients, total: recipients.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Failed to resolve recipients", body: msg });
    res.status(500).json({ error: msg });
  }
});

// ============================================================
// TEMPLATES
// ============================================================

router.get("/reach/templates", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtreach_templates")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ templates: data ?? [] });
});

router.post("/reach/templates", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { name, channel, subject, body, variables } = (req.body ?? {}) as {
    name?: string;
    channel?: string;
    subject?: string;
    body?: string;
    variables?: unknown[];
  };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (!channel || !["whatsapp", "email"].includes(channel)) {
    return res.status(400).json({ error: "channel must be whatsapp or email" });
  }

  const { data, error } = await db
    .from("smrtreach_templates")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      name: name.trim(),
      channel,
      subject: subject ?? null,
      body: body ?? null,
      variables: variables ?? [],
    })
    .select("*")
    .single();

  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to create template", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ template: data });
});

router.delete("/reach/templates/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtreach_templates")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// SENDERS (managed verified sender addresses — Reach email is not locked to one)
// ============================================================

router.get("/reach/senders", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtreach_senders")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ senders: data ?? [] });
});

router.post("/reach/senders", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "a valid email is required" });
  }
  const { data, error } = await db
    .from("smrtreach_senders")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      email,
      label: req.body?.label?.trim() || null,
      reply_to: req.body?.reply_to?.trim()?.toLowerCase() || null,
    })
    .select("*")
    .single();
  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to add sender", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ sender: data });
});

router.delete("/reach/senders/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtreach_senders")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// SETTINGS (region-by-language map — app-managed)
// ============================================================

router.get("/reach/settings", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data, error } = await db
    .from("smrtreach_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  // Surface defaults even before a row exists, so the UI always has something.
  res.json({
    settings: data ?? {
      org_id: orgId,
      default_region: "us-east-1",
      region_by_language: { en: "us-east-1", he: "il-central-1" },
    },
  });
});

router.put("/reach/settings", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const row: Record<string, unknown> = { org_id: orgId };
  if (req.body?.default_region !== undefined) row.default_region = String(req.body.default_region);
  if (req.body?.region_by_language !== undefined) row.region_by_language = req.body.region_by_language;
  const { data, error } = await db
    .from("smrtreach_settings")
    .upsert(row, { onConflict: "org_id" })
    .select("*")
    .single();
  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to save settings", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.json({ settings: data });
});

// ============================================================
// SEND / QUEUE
// ============================================================

// Resolve recipients, enqueue them, and process a first batch immediately so
// the user sees sending start. The rest of the queue is drained by repeated
// calls to /reach/queue/process (pg_cron will call it; see build plan §H).
router.post("/reach/campaigns/:id/send", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  try {
    const queued = await enqueueCampaignEmail(orgId, req.params.id);
    if (queued === 0) return res.json({ queued: 0, sent: 0, failed: 0, remaining: 0 });
    const result = await processEmailQueue(orgId, 50);
    res.json({ queued, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Failed to send campaign", body: msg });
    res.status(400).json({ error: msg });
  }
});

// Drain a bounded batch of the pending email queue (cron target).
router.post("/reach/queue/process", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const limit = Math.min(Number(req.body?.limit) || 100, 500);
  try {
    const result = await processEmailQueue(orgId, limit);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Queue processing failed", body: msg });
    res.status(500).json({ error: msg });
  }
});

// Campaign stats (sent/failed/open/click counts).
router.get("/reach/campaigns/:id/stats", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const [{ count: sent }, { count: failed }, { count: opens }, { count: clicks }] = await Promise.all([
    db.from("smrtreach_logs").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", req.params.id).eq("status", "sent"),
    db.from("smrtreach_logs").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", req.params.id).eq("status", "failed"),
    db.from("smrtreach_tracking").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", req.params.id).eq("event", "open"),
    db.from("smrtreach_tracking").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", req.params.id).eq("event", "click"),
  ]);
  res.json({ sent: sent ?? 0, failed: failed ?? 0, opens: opens ?? 0, clicks: clicks ?? 0 });
});

export default router;
