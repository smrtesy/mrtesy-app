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

export default router;
