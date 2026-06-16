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
 * Live dispatch: email via SES (creds in app_secrets, slug "smrtreach") and
 * WhatsApp via smrtBot's send-service (shared secret). "send" resolves the
 * audience, queues recipients and processes a first batch; the rest is drained
 * by the cron route.
 */

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { emitEvent, notifyError } from "../../lib/platform";

import { resolveAudience } from "./audience-service";
import type { AudienceRef, Channel } from "./audience-service";
import { enqueueCampaignEmail, processEmailQueue } from "./send-service";
import { enqueueCampaignWhatsapp, processWhatsappQueue } from "./wa-send-service";
import { sendTestMessage, sendGmassInboxTest, GMASS_SEEDS, GMASS_RESULTS_BASE } from "./test-send";

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
    db.from("smrtreach_campaign_email").select("*").eq("org_id", orgId).eq("campaign_id", req.params.id).maybeSingle(),
    db.from("smrtreach_campaign_whatsapp").select("*").eq("org_id", orgId).eq("campaign_id", req.params.id).maybeSingle(),
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
    country_filter?: string | null;
    test_batch_size?: number | null;
  };

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name?.trim();
  if (body.audience !== undefined) patch.audience = body.audience ?? {};
  if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.country_filter !== undefined) patch.country_filter = body.country_filter;
  if (body.test_batch_size !== undefined) patch.test_batch_size = body.test_batch_size;
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
  "subject", "preview", "sender", "reply_to", "html_body", "language", "provider",
  "priority", "send_hours", "exclude_shabbat", "rate_limit", "cooldown_seconds", "sto_enabled",
] as const;
const WHATSAPP_COLS = [
  "bot_ref", "template", "template_lang", "template_params", "recipient_cap",
  "body_text", "send_hours", "exclude_shabbat", "tz_hour",
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
// PER-CAMPAIGN SENDER ALLOCATION
// ============================================================
// For an email campaign: which senders (from the master list) to send from,
// and how many from each. Supersedes the single campaign_email.sender when set.

router.get("/reach/campaigns/:id/senders", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  if (!(await ownsCampaign(orgId, req.params.id))) {
    return res.status(404).json({ error: "campaign not found" });
  }
  const { data, error } = await db
    .from("smrtreach_campaign_senders")
    .select("sender_id, send_count")
    .eq("org_id", orgId)
    .eq("campaign_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ allocations: data ?? [] });
});

// Replace the whole allocation for a campaign. Body: { allocations: [{ sender_id, send_count }] }.
// Each sender must belong to the org; send_count must be a positive int and is
// clamped to the sender's fixed daily_cap (the per-address ceiling set in settings).
router.put("/reach/campaigns/:id/senders", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const campaignId = req.params.id;
  if (!(await ownsCampaign(orgId, campaignId))) {
    return res.status(404).json({ error: "campaign not found" });
  }
  const input = Array.isArray(req.body?.allocations) ? req.body.allocations : [];

  // Validate sender ids against this org's master list (also gives us daily_cap).
  const { data: senders, error: sErr } = await db
    .from("smrtreach_senders")
    .select("id, daily_cap")
    .eq("org_id", orgId);
  if (sErr) return res.status(500).json({ error: sErr.message });
  const capById = new Map((senders ?? []).map((s) => [s.id as string, (s.daily_cap as number | null) ?? null]));

  const rows: { campaign_id: string; org_id: string; sender_id: string; send_count: number }[] = [];
  const seen = new Set<string>();
  for (const a of input) {
    const senderId = typeof a?.sender_id === "string" ? a.sender_id : "";
    if (!senderId || !capById.has(senderId) || seen.has(senderId)) continue;
    let count = Number(a?.send_count);
    if (!Number.isFinite(count) || count <= 0) continue;
    count = Math.floor(count);
    const cap = capById.get(senderId);
    if (cap != null) count = Math.min(count, cap);
    seen.add(senderId);
    rows.push({ campaign_id: campaignId, org_id: orgId, sender_id: senderId, send_count: count });
  }

  // Replace: clear then insert the validated set (empty = use fallback sender).
  const { error: delErr } = await db
    .from("smrtreach_campaign_senders")
    .delete()
    .eq("org_id", orgId)
    .eq("campaign_id", campaignId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  if (rows.length > 0) {
    const { error: insErr } = await db.from("smrtreach_campaign_senders").insert(rows);
    if (insErr) {
      await notifyError(orgId, "smrtreach", { title: "Failed to save sender allocation", body: insErr.message });
      return res.status(500).json({ error: insErr.message });
    }
  }
  res.json({ ok: true, allocations: rows.map((r) => ({ sender_id: r.sender_id, send_count: r.send_count })) });
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

/** Parse a positive-int daily cap from the body. Returns undefined if absent. */
function parseDailyCap(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined; // ignore invalid
  return Math.floor(n);
}

// SES sender addresses are added here. Gmail inboxes are added via the OAuth
// flow (POST'ing one here would create a dangling sender with no token), so
// this route always creates provider='ses'.
router.post("/reach/senders", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "a valid email is required" });
  }
  const cap = parseDailyCap(req.body?.daily_cap);
  const { data, error } = await db
    .from("smrtreach_senders")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      email,
      provider: "ses",
      label: req.body?.label?.trim() || null,
      reply_to: req.body?.reply_to?.trim()?.toLowerCase() || null,
      daily_cap: cap === undefined ? null : cap,
    })
    .select("*")
    .single();
  if (error) {
    await notifyError(orgId, "smrtreach", { title: "Failed to add sender", body: error.message });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ sender: data });
});

// Edit a sender's label / reply_to / fixed daily cap (works for SES + Gmail).
router.patch("/reach/senders/:id", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const patch: Record<string, unknown> = {};
  if (req.body?.label !== undefined) patch.label = req.body.label?.trim() || null;
  if (req.body?.reply_to !== undefined) patch.reply_to = req.body.reply_to?.trim()?.toLowerCase() || null;
  const cap = parseDailyCap(req.body?.daily_cap);
  if (cap !== undefined) patch.daily_cap = cap;
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no updatable fields provided" });
  }
  const { data, error } = await db
    .from("smrtreach_senders")
    .update(patch)
    .eq("org_id", orgId)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "sender not found" });
  res.json({ sender: data });
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

// Independent Gmail inboxes connected for sending (status for the settings UI).
// The OAuth material lives in smrtreach_gmail_accounts (service-role only); we
// expose only the safe fields, keyed by sender_id so the UI can merge with the
// senders list.
router.get("/reach/gmail-accounts", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtreach_gmail_accounts")
    .select("sender_id, email, disabled, last_error, created_at")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data ?? [] });
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
// If the campaign has a test_batch_size, only that many are sent now and the
// campaign is parked in 'paused' awaiting an explicit /resume (botsite "מנה ראשונה").
router.post("/reach/campaigns/:id/send", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: campaign } = await db
    .from("smrtreach_campaigns").select("channel, test_batch_size").eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: "campaign not found" });
  const channel = campaign.channel as Channel;
  const testBatch = (campaign.test_batch_size as number | null) ?? 0;
  const firstBatch = testBatch && testBatch > 0 ? testBatch : 50;

  // mode "now" (default — the "שלח עכשיו" button) sends immediately, ignoring
  // send-hours / Shabbat / schedule / rate. mode "scheduled" honors them and,
  // when the client passes scheduled_at, persists it so the send uses exactly
  // the time the user sees (not a stale value).
  const mode = req.body?.mode === "scheduled" ? "scheduled" : "now";
  if (mode === "now") {
    await db.from("smrtreach_campaigns")
      .update({ ignore_send_window: true, scheduled_at: null })
      .eq("org_id", orgId).eq("id", req.params.id);
  } else {
    const patch: Record<string, unknown> = { ignore_send_window: false };
    if (req.body?.scheduled_at !== undefined) {
      patch.scheduled_at = typeof req.body.scheduled_at === "string" ? req.body.scheduled_at : null;
    }
    await db.from("smrtreach_campaigns").update(patch).eq("org_id", orgId).eq("id", req.params.id);
  }

  try {
    let queued = 0;
    const totals = { sent: 0, failed: 0 };
    if (channel === "email" || channel === "both") {
      const q = await enqueueCampaignEmail(orgId, req.params.id);
      queued += q;
      if (q > 0) { const r = await processEmailQueue(orgId, firstBatch); totals.sent += r.sent; totals.failed += r.failed; }
    }
    if (channel === "whatsapp" || channel === "both") {
      const q = await enqueueCampaignWhatsapp(orgId, req.params.id);
      queued += q;
      if (q > 0) { const r = await processWhatsappQueue(orgId, firstBatch); totals.sent += r.sent; totals.failed += r.failed; }
    }
    // Test batch: pause after the first batch so the user can review before the
    // rest goes out. The processor only sends 'sending' campaigns, so 'paused'
    // holds the remaining queued rows until /resume.
    let paused = false;
    if (testBatch && testBatch > 0 && queued > testBatch) {
      await db.from("smrtreach_campaigns").update({ status: "paused" }).eq("org_id", orgId).eq("id", req.params.id);
      paused = true;
    }
    res.json({ queued, ...totals, paused });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Failed to send campaign", body: msg });
    res.status(400).json({ error: msg });
  }
});

// Pause a sending campaign (holds the queued rows; the processor skips non-'sending').
router.post("/reach/campaigns/:id/pause", async (req: Request, res: Response) => {
  const { error } = await db.from("smrtreach_campaigns")
    .update({ status: "paused" }).eq("org_id", req.org!.id).eq("id", req.params.id).eq("status", "sending");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Resume a paused campaign and process a batch immediately; cron drains the rest.
router.post("/reach/campaigns/:id/resume", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { data: campaign } = await db
    .from("smrtreach_campaigns").select("channel, status").eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: "campaign not found" });
  if (campaign.status !== "paused") return res.status(400).json({ error: "campaign is not paused" });
  await db.from("smrtreach_campaigns").update({ status: "sending" }).eq("org_id", orgId).eq("id", req.params.id);
  try {
    const totals = { sent: 0, failed: 0 };
    const channel = campaign.channel as Channel;
    if (channel === "email" || channel === "both") { const r = await processEmailQueue(orgId, 50); totals.sent += r.sent; totals.failed += r.failed; }
    if (channel === "whatsapp" || channel === "both") { const r = await processWhatsappQueue(orgId, 50); totals.sent += r.sent; totals.failed += r.failed; }
    res.json({ ok: true, ...totals });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Failed to resume campaign", body: msg });
    res.status(400).json({ error: msg });
  }
});

// One-off test send to a single address (does NOT touch the queue or status).
router.post("/reach/campaigns/:id/test", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  if (!email && !phone) return res.status(400).json({ error: "email or phone is required" });
  try {
    const result = await sendTestMessage(orgId, req.params.id, { email: email || null, phone: phone || null });
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

// GMass seed list + results-page base (for the inbox-placement test UI).
router.get("/reach/gmass/seeds", (_req: Request, res: Response) => {
  res.json({ seeds: GMASS_SEEDS, resultsBase: GMASS_RESULTS_BASE });
});

// Send the campaign to the GMass seeds and return the results URL.
router.post("/reach/campaigns/:id/inbox-test", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  try {
    const result = await sendGmassInboxTest(orgId, req.params.id);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "GMass inbox test failed", body: msg });
    res.status(400).json({ error: msg });
  }
});

// Drain a bounded batch of the pending queue, both channels (cron target).
router.post("/reach/queue/process", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const limit = Math.min(Number(req.body?.limit) || 100, 500);
  try {
    const email = await processEmailQueue(orgId, limit);
    const whatsapp = await processWhatsappQueue(orgId, limit);
    res.json({ email, whatsapp });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtreach", { title: "Queue processing failed", body: msg });
    res.status(500).json({ error: msg });
  }
});

// Campaign stats: counts + derived rates + bounce/complaint/unsub + top links.
router.get("/reach/campaigns/:id/stats", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const id = req.params.id;
  const tlog = (status: string) =>
    db.from("smrtreach_logs").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", id).eq("status", status);
  const ttrk = (event: string) =>
    db.from("smrtreach_tracking").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("campaign_id", id).eq("event", event);

  const [
    { count: sent }, { count: failed },
    { count: opens }, { count: clicks }, { count: bounces }, { count: complaints },
    { data: clickRows },
  ] = await Promise.all([
    tlog("sent"),
    tlog("failed"),
    ttrk("open"), ttrk("click"), ttrk("bounce"), ttrk("complaint"),
    // Top clicked links (bounded fetch, aggregated in code).
    db.from("smrtreach_tracking").select("url").eq("org_id", orgId).eq("campaign_id", id).eq("event", "click").not("url", "is", null).limit(5000),
  ]);

  const sentN = sent ?? 0;
  const pct = (n: number) => (sentN > 0 ? Math.round((n / sentN) * 1000) / 10 : 0);

  const linkCounts = new Map<string, number>();
  for (const r of clickRows ?? []) {
    const url = r.url as string;
    linkCounts.set(url, (linkCounts.get(url) ?? 0) + 1);
  }
  const topLinks = [...linkCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, count }));

  res.json({
    sent: sentN,
    failed: failed ?? 0,
    opens: opens ?? 0,
    clicks: clicks ?? 0,
    bounces: bounces ?? 0,
    complaints: complaints ?? 0,
    open_rate: pct(opens ?? 0),
    click_rate: pct(clicks ?? 0),
    bounce_rate: pct(bounces ?? 0),
    top_links: topLinks,
  });
});

// Per-recipient send log (paginated), for the campaign detail recipients table.
router.get("/reach/campaigns/:id/log", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { data, error, count } = await db
    .from("smrtreach_logs")
    .select("contact_id, channel, status, error, sent_at", { count: "exact" })
    .eq("org_id", orgId)
    .eq("campaign_id", req.params.id)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rows: data ?? [], total: count ?? 0 });
});

// Cross-campaign deliverability dashboard — the most recent campaigns with
// their sent/open/click/bounce aggregates and rates.
router.get("/reach/deliverability", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const { data: campaigns, error } = await db
    .from("smrtreach_campaigns")
    .select("id, name, channel, status, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  if (!campaigns || campaigns.length === 0) return res.json({ rows: [] });

  const count = (table: string, field: string, value: string, campaignId: string) =>
    db.from(table).select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("campaign_id", campaignId).eq(field, value);

  const rows = await Promise.all(
    campaigns.map(async (c) => {
      const id = c.id as string;
      const [{ count: sent }, { count: failed }, { count: opens }, { count: clicks }, { count: bounces }, { count: complaints }] =
        await Promise.all([
          count("smrtreach_logs", "status", "sent", id),
          count("smrtreach_logs", "status", "failed", id),
          count("smrtreach_tracking", "event", "open", id),
          count("smrtreach_tracking", "event", "click", id),
          count("smrtreach_tracking", "event", "bounce", id),
          count("smrtreach_tracking", "event", "complaint", id),
        ]);
      const s = sent ?? 0;
      const pct = (n: number) => (s > 0 ? Math.round((n / s) * 1000) / 10 : 0);
      return {
        id, name: c.name, channel: c.channel, status: c.status, created_at: c.created_at,
        sent: s, failed: failed ?? 0, opens: opens ?? 0, clicks: clicks ?? 0,
        bounces: bounces ?? 0, complaints: complaints ?? 0,
        open_rate: pct(opens ?? 0), click_rate: pct(clicks ?? 0), bounce_rate: pct(bounces ?? 0),
      };
    }),
  );
  res.json({ rows });
});

export default router;
