/**
 * smrtReach — email send service.
 *
 * Two phases, so a long broadcast never blocks a request and the pg_cron
 * processor (build plan §H) can drive sending later:
 *   1. enqueueCampaignEmail — resolves recipients (from smrtCRM, deliverability
 *      filtered), validates the sender against the org's managed list, and
 *      writes one smrtreach_queue row per recipient.
 *   2. processEmailQueue   — sends a bounded batch of pending rows via SES,
 *      writing per-recipient logs and flipping campaign status when drained.
 *
 * Region is resolved per content language (en → us-east-1, he → il-central-1
 * by default), editable per org in smrtreach_settings. Nothing is locked to one
 * address or region — both are app-managed.
 */

import { db } from "../../db";
import { emitEvent } from "../../lib/platform";
import { resolveAudience } from "./audience-service";
import type { AudienceRef } from "./audience-service";
import { sendEmail, SesNotConfiguredError } from "./ses-client";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

const MAX_SEND_ATTEMPTS = 3;

/**
 * Reset rows orphaned in 'sending' (process crashed/timed out after claiming but
 * before the terminal status write) back to 'pending' so the next pass retries —
 * incrementing attempts, and failing rows that have exhausted the cap so a
 * poison row can never loop forever.
 * @returns the number of rows requeued.
 */
export async function reapStuckSending(orgId: string, olderThanMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  // NULL claimed_at (pre-migration rows) is skipped by `lt` — safe default.
  const { data: stuck, error } = await db
    .from("smrtreach_queue")
    .select("id, attempts")
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "sending")
    .lt("claimed_at", cutoff);
  if (error) {
    console.error("[smrtreach.reap]", orgId, error.message);
    return 0;
  }
  if (!stuck || stuck.length === 0) return 0;

  let requeued = 0;
  for (const row of stuck) {
    const attempts = (row.attempts as number) ?? 0;
    if (attempts + 1 >= MAX_SEND_ATTEMPTS) {
      await db.from("smrtreach_queue")
        .update({ status: "failed", error: "exceeded max send attempts", attempts: attempts + 1 })
        .eq("id", row.id);
    } else {
      await db.from("smrtreach_queue")
        .update({ status: "pending", claimed_at: null, attempts: attempts + 1 })
        .eq("id", row.id);
      requeued++;
    }
  }
  return requeued;
}

/** Resolve the SES region for a content language from the org's settings. */
export async function resolveRegion(orgId: string, language: string): Promise<string> {
  const { data } = await db
    .from("smrtreach_settings")
    .select("default_region, region_by_language")
    .eq("org_id", orgId)
    .maybeSingle();

  const map = (data?.region_by_language as Record<string, string> | undefined) ?? {
    en: "us-east-1",
    he: "il-central-1",
  };
  return map[language] ?? data?.default_region ?? "us-east-1";
}

/** Minimal {{var}} substitution for the supported contact fields. */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? "");
}

function unsubscribeFooter(orgId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return "";
  const url = `${PUBLIC_BASE_URL}/api/reach/unsubscribe?c=${encodeURIComponent(contactId)}&o=${encodeURIComponent(orgId)}`;
  return `<hr><p style="font-size:12px;color:#888;text-align:center">` +
    `<a href="${url}">להסרה מרשימת התפוצה</a></p>`;
}

/** 1x1 open-tracking pixel (Reach-3: open tracking is built-in). */
function openPixel(campaignId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return "";
  const url = `${PUBLIC_BASE_URL}/api/reach/track/open?c=${encodeURIComponent(campaignId)}&u=${encodeURIComponent(contactId)}`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:none">`;
}

/**
 * Rewrite http(s) links to route through the click tracker, which 302-redirects
 * to the ORIGINAL deep URL (preserved verbatim as the `url` param) — honoring
 * the platform's "preserve deep links" rule while recording the click.
 */
function wrapLinks(html: string, campaignId: string, contactId: string): string {
  if (!PUBLIC_BASE_URL) return html;
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, target: string) => {
    const tracked = `${PUBLIC_BASE_URL}/api/reach/track/click?c=${encodeURIComponent(campaignId)}` +
      `&u=${encodeURIComponent(contactId)}&url=${encodeURIComponent(target)}`;
    return `href="${tracked}"`;
  });
}

/**
 * Resolve recipients for a campaign's email channel and enqueue them.
 * @returns the number of rows queued.
 */
export async function enqueueCampaignEmail(orgId: string, campaignId: string): Promise<number> {
  const { data: campaign, error: cErr } = await db
    .from("smrtreach_campaigns")
    .select("audience, channel, status")
    .eq("org_id", orgId)
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) throw new Error("campaign not found");
  if (campaign.channel !== "email" && campaign.channel !== "both") {
    throw new Error("campaign channel is not email");
  }
  // Guard against re-enqueuing a campaign that's already in flight or finished,
  // which would re-send to everyone (the queue has no per-recipient uniqueness).
  if (campaign.status === "sending" || campaign.status === "done") {
    throw new Error(`campaign already ${campaign.status} — cannot send again`);
  }

  const { data: detail, error: dErr } = await db
    .from("smrtreach_campaign_email")
    .select("sender")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (dErr) throw new Error(dErr.message);
  if (!detail?.sender) throw new Error("campaign has no sender set");

  // The sender must be one of the org's managed verified senders.
  const { data: sender } = await db
    .from("smrtreach_senders")
    .select("email")
    .eq("org_id", orgId)
    .eq("email", detail.sender)
    .maybeSingle();
  if (!sender) throw new Error(`sender "${detail.sender}" is not a verified sender for this org`);

  const recipients = await resolveAudience(orgId, (campaign.audience ?? {}) as AudienceRef, "email");
  if (recipients.length === 0) return 0;

  const rows = recipients
    .filter((r) => r.email)
    .map((r) => ({
      org_id: orgId,
      campaign_id: campaignId,
      channel: "email",
      contact_id: r.contact_id,
      to_address: r.email as string,
      status: "pending",
    }));

  // Insert in batches. The "already sending/done" guard above is what prevents
  // duplicate enqueues (the queue table has no per-recipient unique index).
  let queued = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("smrtreach_queue").insert(chunk);
    if (error) throw new Error(`enqueue: ${error.message}`);
    queued += chunk.length;
  }

  await db.from("smrtreach_campaigns").update({ status: "sending" }).eq("org_id", orgId).eq("id", campaignId);
  await emitEvent(orgId, "smrtreach", "campaign.sending", "campaign", campaignId, { queued });
  return queued;
}

interface ProcessResult {
  sent: number;
  failed: number;
  remaining: number;
}

/**
 * Send a bounded batch of pending email-queue rows via SES. Safe to call
 * repeatedly (pg_cron will). Per-campaign detail/region are cached within the
 * call. When a campaign's queue is fully drained, its status flips to done.
 *
 * Concurrency-safe: rows are claimed via a conditional UPDATE (status pending →
 * sending) and only the claimed rows are sent, so overlapping runs (e.g. the
 * /send immediate batch racing a cron tick) never double-send.
 */
export async function processEmailQueue(orgId: string, limit = 100): Promise<ProcessResult> {
  // 1. Pick candidate ids, then atomically CLAIM them: the conditional update
  //    only flips rows still 'pending', so two concurrent processors never
  //    claim the same row (whoever commits first wins; the other's
  //    .eq('status','pending') no longer matches). We send only claimed rows.
  const { data: candidates, error: candErr } = await db
    .from("smrtreach_queue")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (candErr) throw new Error(candErr.message);
  if (!candidates || candidates.length === 0) return { sent: 0, failed: 0, remaining: 0 };

  const candidateIds = candidates.map((r) => r.id as string);
  // Claim sets status + claimed_at only — attempts is owned by the reaper, which
  // increments it on each requeue and fails the row past a cap (no infinite loop).
  const { data: pending, error } = await db
    .from("smrtreach_queue")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("status", "pending")
    .in("id", candidateIds)
    .select("id, campaign_id, contact_id, to_address");
  if (error) throw new Error(error.message);
  if (!pending || pending.length === 0) return { sent: 0, failed: 0, remaining: 0 };

  // Per-campaign caches.
  const detailCache = new Map<string, { subject: string; html: string; from: string; replyTo: string | null; region: string } | null>();
  const touchedCampaigns = new Set<string>();

  async function getDetail(campaignId: string) {
    if (detailCache.has(campaignId)) return detailCache.get(campaignId)!;
    const { data } = await db
      .from("smrtreach_campaign_email")
      .select("subject, html_body, sender, reply_to, language")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (!data) { detailCache.set(campaignId, null); return null; }
    const region = await resolveRegion(orgId, (data.language as string) ?? "he");
    const detail = {
      subject: (data.subject as string) ?? "",
      html: (data.html_body as string) ?? "",
      from: data.sender as string,
      replyTo: (data.reply_to as string | null) ?? null,
      region,
    };
    detailCache.set(campaignId, detail);
    return detail;
  }

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    touchedCampaigns.add(row.campaign_id as string);
    const detail = await getDetail(row.campaign_id as string);
    if (!detail || !detail.from) {
      await db.from("smrtreach_queue").update({ status: "failed", error: "missing email detail/sender" }).eq("id", row.id);
      failed++;
      continue;
    }

    // Fetch contact fields for variable substitution.
    const { data: contact } = row.contact_id
      ? await db.from("smrtcrm_contacts").select("first_name, last_name, phone, email").eq("org_id", orgId).eq("id", row.contact_id).maybeSingle()
      : { data: null };
    const vars: Record<string, string> = {
      first_name: (contact?.first_name as string) ?? "",
      last_name: (contact?.last_name as string) ?? "",
      email: (contact?.email as string) ?? row.to_address,
      phone: (contact?.phone as string) ?? "",
    };

    const campaignId = row.campaign_id as string;
    const contactId = (row.contact_id as string) ?? "";
    const subject = render(detail.subject, vars);
    const html =
      wrapLinks(render(detail.html, vars), campaignId, contactId) +
      unsubscribeFooter(orgId, contactId) +
      openPixel(campaignId, contactId);

    try {
      const { messageId } = await sendEmail({
        region: detail.region,
        from: detail.from,
        to: row.to_address as string,
        subject,
        html,
        replyTo: detail.replyTo,
      });
      // Check the terminal status write: if it silently failed the row would
      // stick at 'sending' and wedge the campaign's drain check.
      const { error: markErr } = await db
        .from("smrtreach_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (markErr) console.error("[smrtreach.queue] mark sent failed:", row.id, markErr.message);
      await db.from("smrtreach_logs").insert({
        org_id: orgId,
        campaign_id: row.campaign_id,
        contact_id: row.contact_id,
        channel: "email",
        status: "sent",
        wa_message_id: messageId || null,
        sent_at: new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const { error: markErr } = await db
        .from("smrtreach_queue")
        .update({ status: "failed", error: msg })
        .eq("id", row.id);
      if (markErr) console.error("[smrtreach.queue] mark failed failed:", row.id, markErr.message);
      await db.from("smrtreach_logs").insert({
        org_id: orgId,
        campaign_id: row.campaign_id,
        contact_id: row.contact_id,
        channel: "email",
        status: "failed",
        error: msg,
      });
      failed++;
      // Stop early on a config error — every row would fail the same way.
      if (e instanceof SesNotConfiguredError) break;
    }
  }

  // Flip campaigns whose queue is now drained.
  for (const campaignId of touchedCampaigns) {
    const { count } = await db
      .from("smrtreach_queue")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("campaign_id", campaignId)
      .in("status", ["pending", "sending"]);
    if ((count ?? 0) === 0) {
      await db.from("smrtreach_campaigns").update({ status: "done" }).eq("org_id", orgId).eq("id", campaignId);
      const { data: c } = await db.from("smrtreach_campaigns").select("name").eq("id", campaignId).maybeSingle();
      const { count: sentCount } = await db
        .from("smrtreach_logs")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("status", "sent");
      await emitEvent(orgId, "smrtreach", "campaign.done", "campaign", campaignId, {
        name: c?.name ?? "",
        sent: sentCount ?? 0,
      });
    }
  }

  const { count: remaining } = await db
    .from("smrtreach_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("channel", "email")
    .eq("status", "pending");

  return { sent, failed, remaining: remaining ?? 0 };
}
